/*
 * The Needs You answer channel. A tap resolves the takeover on the glass
 * immediately (agent_monitor marks it answered), then hands the verdict here;
 * a worker task signs it and POSTs it so the UI never waits on the network.
 * Compiled out entirely without a device key: the screens stay display-only.
 */
#include "esp_log.h"

#include "needs_you_net.h"
#include "secrets.h"

static const char *TAG = "needs-you-net";

#ifdef TK_VIBEPULSE_DEVICE_KEY

#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_http_client.h"

#include "agent_monitor.h"
#include "agent_status.h"
#include "needs_you_send_policy.h"
#include "interaction_relay_policy.h"

/* The verdict a tap produced, captured on the UI thread and drained by the
 * sender. The complete decision binding is copied before the UI suppresses
 * the visible item. */
typedef struct {
  bool panic;
  tk_needs_you_verdict verdict;
  uint64_t ts;
  tk_ir_decision_context context;
} verdict_item;

static QueueHandle_t s_queue;
/* Logged once, after the first send: the 6 KiB task budget becomes a
 * measured number instead of a guess. */
static bool s_stack_logged;

/* Returns true only when the item is actually sitting in the sender's queue.
 * The monitor uses that answer to decide whether the glass may say ON IT;
 * a dropped verdict must leave the takeover up so the terminal stays the
 * honest fallback. */
static bool enqueue(const verdict_item *item) {
  if (!s_queue) return false;
  /* Non-blocking on purpose: if the sender is wedged on a stalled network, a
   * dropped verdict still falls back to the terminal via the bridge timeout.
   * Better a lost answer than a frozen UI thread. */
  if (xQueueSend(s_queue, item, 0) != pdTRUE) {
    ESP_LOGW(TAG, "verdict-kön full — hoppar över, terminalen tar över");
    return false;
  }
  return true;
}

static bool needs_you_send_cb(tk_needs_you_verdict verdict,
                              const tk_ir_decision_context *context) {
  const char *name = tk_needs_you_verdict_name(verdict);
  if (!name || !context || !context->request_id[0]) return false;
  if (context->provider != TK_AGENT_PROVIDER_CLAUDE &&
      context->provider != TK_AGENT_PROVIDER_CODEX) {
    return false;
  }
  /* Codex must never fall through to the legacy signature. The parser already
   * enforces this, and this second gate keeps malformed internal calls safe. */
  if (context->provider == TK_AGENT_PROVIDER_CODEX &&
      !context->has_view_sha256) {
    ESP_LOGE(TAG, "Codex-svar saknar vybindning — skickar inte");
    return false;
  }
  if (context->has_view_sha256 &&
      context->view_sha256[TK_PENDING_VIEW_SHA256_CAP - 1] != '\0') {
    return false;
  }
  verdict_item item = {
    .panic = false,
    .verdict = verdict,
    .ts = (uint64_t)time(NULL),
  };
  item.context = *context;
  return enqueue(&item);
}

void tk_needs_you_send_panic(void) {
  verdict_item item = {
    .panic = true, .verdict = TK_NEEDS_YOU_VERDICT_DENY,
    .ts = (uint64_t)time(NULL),
  };
  memcpy(item.context.request_id, "panic", sizeof "panic");
  (void)enqueue(&item);
}

__attribute__((weak)) bool tk_interaction_relay_queue_verdict(
    tk_needs_you_verdict verdict, const tk_ir_decision_context *context) {
  (void)verdict;
  (void)context;
  return false;
}

static tk_ir_direct_result post_direct_verdict(const verdict_item *item) {
  char message[TK_NEEDS_YOU_MESSAGE_CAP];
  char hmac_hex[TK_NEEDS_YOU_HMAC_HEX_CAP];
  char body[TK_NEEDS_YOU_BODY_CAP];
  char url[128];
  const char *verdict_name = tk_needs_you_verdict_name(item->verdict);
  if (!verdict_name) return TK_IR_DIRECT_HARD_REJECT;

  /* The direct LAN answer carries a wall-clock ts that the tokenserver
   * holds inside a replay window. An unsynced clock would feed that window
   * a 1970 timestamp; refuse to send rather than teach the bridge to see
   * bogus times. UNCERTAIN (not a hard reject) so a relay-bound request
   * can still travel the encrypted path, which is challenge-bound and
   * needs no wall clock. */
  if (!tk_wall_clock_synced((int64_t)item->ts)) {
    ESP_LOGW(TAG, "klockan är inte synkad, %s skickas inte direkt",
             item->panic ? "paniken" : verdict_name);
    return TK_IR_DIRECT_UNCERTAIN;
  }

  if (item->panic) {
    if (tk_needs_you_canonical_message(message, sizeof message,
                                       item->context.request_id, verdict_name,
                                       item->ts) < 0) {
      return TK_IR_DIRECT_HARD_REJECT;
    }
    tk_needs_you_hmac_hex(hmac_hex, TK_VIBEPULSE_DEVICE_KEY, message);
    if (tk_needs_you_panic_body(body, sizeof body, item->ts, hmac_hex) < 0)
      return TK_IR_DIRECT_HARD_REJECT;
    int written = snprintf(url, sizeof url, "%s/api/panic",
                           TK_VIBEPULSE_BASE_URL);
    if (written < 0 || (size_t)written >= sizeof url)
      return TK_IR_DIRECT_HARD_REJECT;
  } else {
    const char *provider = item->context.provider == TK_AGENT_PROVIDER_CODEX
                               ? "codex"
                               : "claude";
    if (item->context.has_view_sha256) {
      if (tk_needs_you_canonical_message_v2(
              message, sizeof message, provider, item->context.request_id,
              item->context.view_sha256, verdict_name, item->ts) < 0) {
        return TK_IR_DIRECT_HARD_REJECT;
      }
      tk_needs_you_hmac_hex(hmac_hex, TK_VIBEPULSE_DEVICE_KEY, message);
      if (tk_needs_you_answer_body_v2(
              body, sizeof body, provider, item->context.view_sha256,
              verdict_name, item->ts, hmac_hex) < 0) {
        return TK_IR_DIRECT_HARD_REJECT;
      }
    } else {
      if (item->context.provider != TK_AGENT_PROVIDER_CLAUDE)
        return TK_IR_DIRECT_HARD_REJECT;
      if (tk_needs_you_canonical_message(message, sizeof message,
                                         item->context.request_id,
                                         verdict_name, item->ts) < 0) {
        return TK_IR_DIRECT_HARD_REJECT;
      }
      tk_needs_you_hmac_hex(hmac_hex, TK_VIBEPULSE_DEVICE_KEY, message);
      if (tk_needs_you_answer_body(body, sizeof body, verdict_name,
                                   item->ts, hmac_hex) < 0) {
        return TK_IR_DIRECT_HARD_REJECT;
      }
    }
    int written = snprintf(url, sizeof url, "%s/api/interaction/%s",
                           TK_VIBEPULSE_BASE_URL, item->context.request_id);
    if (written < 0 || (size_t)written >= sizeof url)
      return TK_IR_DIRECT_HARD_REJECT;
  }

  esp_http_client_config_t cfg = {
    .url = url,
    .method = HTTP_METHOD_POST,
    .timeout_ms = 2500,
  };
  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (!client) return TK_IR_DIRECT_UNCERTAIN;
  esp_http_client_set_header(client, "Content-Type", "application/json");
  esp_http_client_set_post_field(client, body, strlen(body));
  esp_err_t err = esp_http_client_perform(client);
  int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
  esp_http_client_cleanup(client);

  /* Nothing clever on failure: the takeover already left the glass, the bridge
   * deletes on resolve (so a repeat tap is safe) and refuses a stale one, and
   * an unanswered interaction falls back to the terminal on timeout. */
  if (err != ESP_OK || status != 200) {
    ESP_LOGW(TAG, "%s misslyckades (%s, HTTP %d) — terminalen tar beslutet",
             item->panic ? "panik" : verdict_name,
             esp_err_to_name(err), status);
    (void)tk_needs_you_send_should_retry(status); /* documented: never */
  } else {
    ESP_LOGI(TAG, "skickade %s", verdict_name);
  }
  if (!s_stack_logged) {
    s_stack_logged = true;
    ESP_LOGI(TAG, "needs-you-net stack: minst %u byte fria efter första sändningen",
             (unsigned)uxTaskGetStackHighWaterMark(NULL));
  }
  return tk_ir_direct_result_from_http(err == ESP_OK, status);
}

static void needs_you_net_task(void *arg) {
  (void)arg;
  verdict_item item;
  for (;;) {
    if (xQueueReceive(s_queue, &item, portMAX_DELAY) != pdTRUE) continue;
    if (item.panic) {
      (void)post_direct_verdict(&item);
      continue;
    }
    tk_ir_delivery delivery = tk_ir_delivery_initial(&item.context);
    if (delivery == TK_IR_DELIVER_DIRECT) {
      delivery = tk_ir_delivery_after_direct(
          &item.context, post_direct_verdict(&item));
    }
    if (delivery == TK_IR_DELIVER_RELAY &&
        !tk_interaction_relay_queue_verdict(item.verdict, &item.context)) {
      ESP_LOGW(TAG, "krypterat reläsvar kunde inte köas — terminalen tar över");
    }
  }
}

void tokens_needs_you_net_start(void) {
  s_queue = xQueueCreate(4, sizeof(verdict_item));
  if (!s_queue) {
    ESP_LOGE(TAG, "kunde inte skapa verdict-kön — Needs You blir display-only");
    return;
  }
  tk_agent_monitor_set_needs_you_cb(needs_you_send_cb);
  xTaskCreate(needs_you_net_task, "needs-you-net", 6144, NULL, 5, NULL);
  ESP_LOGI(TAG, "Needs You-svarskanalen igång (enhetsnyckel finns)");
}

#else /* no device key: the screens answer no one */

void tokens_needs_you_net_start(void) {
  ESP_LOGW(TAG, "TK_VIBEPULSE_DEVICE_KEY saknas — Needs You är display-only");
}

void tk_needs_you_send_panic(void) {}

bool tk_interaction_relay_queue_verdict(
    tk_needs_you_verdict verdict, const tk_ir_decision_context *context) {
  (void)verdict;
  (void)context;
  return false;
}

#endif
