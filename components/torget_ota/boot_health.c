#include "boot_health.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "boot-health";

/* Policyn pollas varannan halvsekund: tätt nog att domen faller nära sina
 * åtta/femton sekunder, glest nog att inte störa boot-lasten. */
#define POLL_MS 500

/* Minnesbeviset speglar den uppmätta verkligheten 2026-08-06: panelflushen
 * dog i NO_MEM med 81 kB fritt internt men bara 31 kB största block. En
 * avbild som bootar med mindre än 32 kB fritt internminne eller utan ett
 * 12 kB sammanhängande DMA-block kommer att svälta ritpipen — det är ohälsa
 * även om skärmen råkar lysa just nu. */
#define MIN_INTERNAL_FREE_BYTES (32 * 1024)
#define MIN_DMA_BLOCK_BYTES     (12 * 1024)

/* NVS-bevisets adress. Namnrymden delas med rollbackbeviset så att hela
 * gatens spår i NVS bor på ett ställe. Nycklar under NVS taket på 15 tecken. */
#define HEALTH_NAMESPACE "torget_health"
#define PROBE_KEY        "boot_probe"
#define ROLLBACK_KEY     "rollback_from"

/* Bevisbitarna skrivs av flera taskar (app_main, LVGL-tasken, den här
 * pollartasken) — atomär OR, inga lås, inget beroende på UI-mutexen. */
static _Atomic uint32_t s_passed;
static int64_t s_started_at_us;

void torget_boot_health_mark(uint32_t bit) {
  uint32_t before = atomic_fetch_or(&s_passed, bit);
  if (!(before & bit)) ESP_LOGI(TAG, "bevis 0x%02x på plats", (unsigned)bit);
}

/* Ett NVS-varv bevisar att lagret både läser och skriver: proben läses om
 * den finns, annars skrivs den. Misslyckas varvet sätts biten aldrig och
 * deadline-rollbacken tar hand om resten. */
static void probe_nvs(void) {
  nvs_handle_t handle;
  if (nvs_open(HEALTH_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
    ESP_LOGW(TAG, "NVS-proben kunde inte öppna %s", HEALTH_NAMESPACE);
    return;
  }
  uint8_t probe = 0;
  esp_err_t err = nvs_get_u8(handle, PROBE_KEY, &probe);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    err = nvs_set_u8(handle, PROBE_KEY, 1);
    if (err == ESP_OK) err = nvs_commit(handle);
  }
  nvs_close(handle);
  if (err == ESP_OK) torget_boot_health_mark(TG_HEALTH_NVS);
  else ESP_LOGW(TAG, "NVS-proben föll: %s", esp_err_to_name(err));
}

/* Minnesbeviset är sticky: har budgeten en gång hållit under boot räknas
 * den som bevisad — policyns ackumulerade bitmask backar aldrig. */
static void probe_memory(void) {
  if (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) == 0) return;
  if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) < MIN_INTERNAL_FREE_BYTES)
    return;
  if (heap_caps_get_largest_free_block(MALLOC_CAP_DMA) < MIN_DMA_BLOCK_BYTES)
    return;
  torget_boot_health_mark(TG_HEALTH_PSRAM);
}

/* Rollbackbeviset är avgränsat: versionssträngen ur appbeskrivningen (max
 * 31 tecken + NUL), aldrig IP, token eller något som kan växa. */
static void store_rollback_from(const char *version) {
  char bounded[sizeof ((esp_app_desc_t *)0)->version];
  snprintf(bounded, sizeof bounded, "%s", version);
  nvs_handle_t handle;
  if (nvs_open(HEALTH_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) return;
  if (nvs_set_str(handle, ROLLBACK_KEY, bounded) == ESP_OK)
    nvs_commit(handle);
  nvs_close(handle);
}

/* Stabil boot: bootloadern kan själv ha rullat tillbaka en avbild som
 * kraschade före vår gate (tillståndet ABORTED i grannluckan). Bevisen ska
 * uppdateras även då — men grannens avbild godkänns ALDRIG härifrån, den
 * är avvisad och får förbli det. */
static void record_neighbor_abort(const esp_partition_t *running) {
  const esp_partition_t *other = esp_ota_get_next_update_partition(running);
  if (!other) return;
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(other, &state) != ESP_OK) return;
  if (state != ESP_OTA_IMG_ABORTED) return;
  esp_app_desc_t desc;
  if (esp_ota_get_partition_description(other, &desc) == ESP_OK) {
    ESP_LOGW(TAG, "bootloadern rullade tillbaka %s (version %s)",
             other->label, desc.version);
    store_rollback_from(desc.version);
  } else {
    /* Oläsbar lucka: logga händelsen men hitta aldrig på en version. */
    ESP_LOGW(TAG, "bootloadern rullade tillbaka %s (version oläsbar)",
             other->label);
  }
}

static void boot_health_task(void *arg) {
  (void)arg;
  probe_nvs();

  /* Felinjektionen är en byggtidsflagga och mappas till forced_failure
   * enbart här — den här tasken existerar bara för en väntande avbild, så
   * en stabil boot kan aldrig fällas av en kvarglömd flagga. */
#ifdef CONFIG_TORGET_BOOT_HEALTH_FORCE_FAIL
  const bool forced_failure = true;
  ESP_LOGW(TAG, "TORGET_BOOT_HEALTH_FORCE_FAIL är satt: avbilden kommer fällas");
#else
  const bool forced_failure = false;
#endif

  for (;;) {
    probe_memory();
    tg_boot_health health = {
        .passed = atomic_load(&s_passed),
        .started_at_us = s_started_at_us,
        .pending_verify = true,
        .forced_failure = forced_failure,
    };
    tg_health_decision decision =
        tg_boot_health_decide(&health, esp_timer_get_time());
    if (decision == TG_HEALTH_ACCEPT) {
      /* Godkännande sker ENDAST via den officiella rollback-API:n — allt
       * annat lämnar otadata i ett läge bootloadern inte förstår. Ett
       * misslyckat skrivförsök får inte abortera en frisk enhet: logga och
       * försök igen nästa poll, otadata kan vara upptaget en stund. */
      esp_err_t marked = esp_ota_mark_app_valid_cancel_rollback();
      if (marked != ESP_OK) {
        ESP_LOGE(TAG, "kunde inte godkänna avbilden (%s) — nytt försök",
                 esp_err_to_name(marked));
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
        continue;
      }
      ESP_LOGI(TAG, "avbilden godkänd: alla lokala bevis på plats");
      break;
    }
    if (decision == TG_HEALTH_ROLLBACK) {
      uint32_t missing = TG_HEALTH_REQUIRED & ~health.passed;
      const esp_app_desc_t *desc = esp_app_get_description();
      if (esp_ota_check_rollback_is_possible() != true) {
        /* Ingen giltig granne att falla tillbaka till (ota_1 aldrig
         * skriven, typiskt efter en USB-flash). Att fälla avbilden nu
         * vore att beordra bootloadern in i en tom slot, obootbart, och
         * enheten kan bara räddas över USB. En haltande app på glaset slår
         * en död bräda: godkänn UNDER PROTEST och säg varför i loggen
         * (WARN: enheten är i drift, men i ett läge docs/ota.md ber en att
         * lämna genom en avsiktlig andra OTA så båda luckorna fylls). */
        ESP_LOGW(TAG, "hälsogrinden fällde avbilden (saknade bevis 0x%02x, "
                      "version %s) men godkänner UNDER PROTEST: "
                      "esp_ota_check_rollback_is_possible() == false, "
                      "grannluckan saknar giltig avbild (USB-flash?) och en "
                      "rollback vore obootbar. Kör en avsiktlig andra OTA "
                      "så båda luckorna fylls (docs/ota.md)",
                 (unsigned)missing, desc->version);
        esp_ota_mark_app_valid_cancel_rollback();
        break;
      }
      ESP_LOGE(TAG, "avbilden fälls: saknade bevis 0x%02x, version %s",
               (unsigned)missing, desc->version);
      store_rollback_from(desc->version);
      esp_ota_mark_app_invalid_rollback_and_reboot();
      /* Nås aldrig — anropet ovan bootar om. Faller det ändå igenom får
       * watchdogen ta oss; att fortsätta som frisk vore en lögn. */
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(POLL_MS));
  }
  vTaskDelete(NULL);
}

void torget_boot_health_start(void) {
  /* Flanken då mätningen började — all policytid är relativ den här,
   * aldrig epok noll (samma regel som knappolicyn). */
  s_started_at_us = esp_timer_get_time();

  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) {
    /* Utan läsbart otadata finns inget rollbackbeslut att fatta (fabriks-
     * flashad avbild). Gaten stänger av sig i stället för att gissa. */
    ESP_LOGW(TAG, "otadata oläsbart: hälsogrinden vilar denna boot");
    return;
  }
  if (state != ESP_OTA_IMG_PENDING_VERIFY) {
    /* Policyn aktiveras BARA för en väntande avbild; esp_ota_mark_* får
     * inte anropas för en redan stabil boot. Logga tillståndet numeriskt:
     * en esptool-flashad avbild vilar här som UNDEFINED (0x3/0xffffffff),
     * en riktig OTA går vidare — skillnaden ska synas i bootloggen, inte
     * gissas fram i efterhand (obduktionen 2026-08-14). */
    ESP_LOGI(TAG, "hälsogrinden vilar: %s i tillstånd 0x%x (ej väntande)",
             running->label, (unsigned)state);
    record_neighbor_abort(running);
    return;
  }

  ESP_LOGI(TAG, "första boot på %s: hälsogrinden aktiv (%d s minimum, %d s deadline)",
           running->label, (int)(TG_HEALTH_MIN_UPTIME_US / 1000000),
           (int)(TG_HEALTH_DEADLINE_US / 1000000));
  if (xTaskCreate(boot_health_task, "boot-health", 4096, NULL, 4, NULL) !=
      pdPASS) {
    /* Utan vakt blir avbilden aldrig godkänd och bootloadern fäller den
     * vid nästa omstart — det får inte ske tyst. */
    ESP_LOGE(TAG, "boot-health-tasken kunde inte skapas — avbilden förblir "
                  "väntande och riskerar rollback vid nästa boot");
  }
}
