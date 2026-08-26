#ifndef TORGET_OTA_POLICY_H
#define TORGET_OTA_POLICY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Ren accept/avslags-policy för OTA-uppladdningar. Ingen socket, ingen
 * ESP-IDF: HTTP-gränsen översätter sin begäran till tg_ota_request och
 * frågar här INNAN esp_ota_begin får röra flashen. Därmed kan varje
 * gräns värdestestas på värddatorn utan hårdvara.
 */

/* Hårt tak under 5 MiB-luckan: partitionstestet håller samma siffra, så
 * ett bygge som växer förbi taket stoppas i CI långt innan någon försöker
 * ladda upp det. Marginalen upp till luckan är avsiktlig växtmån. */
#define TG_OTA_MAX_IMAGE_BYTES (4U * 1024U * 1024U)

typedef struct {
  bool maintenance_open;
  bool authorized;
  /* The running slot is still PENDING_VERIFY (the boot-health gate has not
   * blessed it yet). esp_ota_begin refuses to touch the other slot in that
   * state, so the policy answers first instead of letting IDF fail late. */
  bool running_pending_verify;
  const char *project;
  const char *chip;
  size_t content_length;
  size_t slot_size;
} tg_ota_request;

typedef enum {
  TG_OTA_ACCEPT,
  TG_OTA_REJECT_CLOSED,
  TG_OTA_REJECT_AUTH,
  TG_OTA_REJECT_PENDING_VERIFY,
  TG_OTA_REJECT_PROJECT,
  TG_OTA_REJECT_CHIP,
  TG_OTA_REJECT_SIZE,
} tg_ota_decision;

tg_ota_decision tg_ota_request_check(const tg_ota_request *request);
unsigned tg_ota_progress_percent(size_t received, size_t total);

/*
 * The upload proof. The sender never presents the token itself; it presents
 * hex(HMAC-SHA256(key = the 64-character token, msg = the 64-character
 * lowercase SHA-256 hex of the image)) in X-VibePulse-Auth. The device
 * recomputes that HMAC over the CLAIMED digest before the stream (this is
 * the "authorized" input above), then after the stream proves the streamed
 * digest equals the claimed one and re-checks the proof, all in constant
 * time. A proof therefore authenticates one specific image: capturing it on
 * the LAN lets nobody upload a different image, and it never reveals the
 * token. The HMAC itself is computed by the adapter (mbedtls); this policy
 * owns the comparisons and their ordering so they can be host-tested.
 */
#define TG_OTA_DIGEST_BYTES 32u

/* Length-checked constant-time equality: different lengths are unequal, and
 * for equal lengths every byte is visited regardless of where the first
 * difference sits, so the answer time never leaks a prefix match. */
bool tg_ota_ct_equal(const uint8_t *a, size_t a_len, const uint8_t *b,
                     size_t b_len);

typedef enum {
  TG_OTA_IMAGE_ACCEPT,
  TG_OTA_IMAGE_REJECT_DIGEST, /* streamed SHA-256 differs from the claimed one */
  TG_OTA_IMAGE_REJECT_PROOF,  /* the proof does not cover the claimed digest */
} tg_ota_image_verdict;

/* Post-stream verdict. BOTH comparisons always run (no short circuit), the
 * digest gate is reported first when both fail, and the adapter must answer
 * every rejection identically (403, no detail) so the reason stays in the
 * serial log and never on the wire. */
tg_ota_image_verdict tg_ota_image_check(
    const uint8_t streamed_sha[TG_OTA_DIGEST_BYTES],
    const uint8_t claimed_sha[TG_OTA_DIGEST_BYTES],
    const uint8_t expected_proof[TG_OTA_DIGEST_BYTES],
    const uint8_t presented_proof[TG_OTA_DIGEST_BYTES]);

#endif
