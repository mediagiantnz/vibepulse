#include "ota_policy.h"

#include <string.h>

/* Ordningen är en del av kontraktet: stängt fönster och autentisering
 * avgörs före all metadata, så ett oautentiserat anrop aldrig kan sondera
 * vilket projekt, chip eller vilken storlek enheten skulle acceptera. */
tg_ota_decision tg_ota_request_check(const tg_ota_request *r) {
  if (!r || !r->maintenance_open) return TG_OTA_REJECT_CLOSED;
  if (!r->authorized) return TG_OTA_REJECT_AUTH;
  /* After auth, before metadata: an authorised sender learns first that the
   * device cannot take an image yet (409 in the adapter, and the same fact
   * is public on /api/ota/status as pending_verify), while an unauthorised
   * caller still sees nothing past 401. */
  if (r->running_pending_verify) return TG_OTA_REJECT_PENDING_VERIFY;
  if (!r->project || strcmp(r->project, "torget") != 0)
    return TG_OTA_REJECT_PROJECT;
  if (!r->chip || strcmp(r->chip, "esp32s3") != 0)
    return TG_OTA_REJECT_CHIP;
  if (r->content_length == 0 || r->content_length > TG_OTA_MAX_IMAGE_BYTES ||
      r->content_length > r->slot_size)
    return TG_OTA_REJECT_SIZE;
  return TG_OTA_ACCEPT;
}

/* 100 lovar att hela kroppen är mottagen — en delvis mottagen bild
 * trunkeras därför nedåt och kan aldrig avrundas upp till löftet. */
unsigned tg_ota_progress_percent(size_t received, size_t total) {
  if (!total) return 0;
  if (received >= total) return 100;
  return (unsigned)((received * 100U) / total);
}

bool tg_ota_ct_equal(const uint8_t *a, size_t a_len, const uint8_t *b,
                     size_t b_len) {
  if (!a || !b || a_len != b_len) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a_len; i++) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

tg_ota_image_verdict tg_ota_image_check(
    const uint8_t streamed_sha[TG_OTA_DIGEST_BYTES],
    const uint8_t claimed_sha[TG_OTA_DIGEST_BYTES],
    const uint8_t expected_proof[TG_OTA_DIGEST_BYTES],
    const uint8_t presented_proof[TG_OTA_DIGEST_BYTES]) {
  /* Evaluate both before deciding: the response time must not tell a sender
   * which of the two gates it failed. */
  bool digest_ok = tg_ota_ct_equal(streamed_sha, TG_OTA_DIGEST_BYTES,
                                   claimed_sha, TG_OTA_DIGEST_BYTES);
  bool proof_ok = tg_ota_ct_equal(expected_proof, TG_OTA_DIGEST_BYTES,
                                  presented_proof, TG_OTA_DIGEST_BYTES);
  if (!digest_ok) return TG_OTA_IMAGE_REJECT_DIGEST;
  if (!proof_ok) return TG_OTA_IMAGE_REJECT_PROOF;
  return TG_OTA_IMAGE_ACCEPT;
}
