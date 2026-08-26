/* The device's answer bytes must equal the bridge's. These vectors are the
 * exact output of tools/tokenserver interactions.sign_answer, plus RFC 4231
 * HMAC-SHA256 cases so the portable crypto is proven on its own terms. */
#include <stdio.h>
#include <string.h>

#include "../components/app_tokens/needs_you_net.h"
#include "../components/app_tokens/needs_you_send_policy.h"

static int failures;

static void check(const char *what, int condition) {
  if (!condition) {
    printf("FAIL %s\n", what);
    failures++;
  }
}

static void expect(const char *what, const char *got, const char *want) {
  if (strcmp(got, want) != 0) {
    printf("FAIL %s\n  got:  %s\n  want: %s\n", what, got, want);
    failures++;
  }
}

int main(void) {
  char message[TK_NEEDS_YOU_MESSAGE_CAP];
  char mac[TK_NEEDS_YOU_HMAC_HEX_CAP];
  char body[TK_NEEDS_YOU_BODY_CAP];

  char key64[65];
  memset(key64, 'a', 64);
  key64[64] = '\0';

  /* The wall-clock gate: an unsynced ESP32 counts from 1970 and is never
   * <= 0, so the only honest test is the floor. Nothing below it may be
   * stamped into a direct LAN verdict or used to evaluate a relay expiry. */
  check("zero is unsynced", !tk_wall_clock_synced(0));
  check("a negative clock is unsynced", !tk_wall_clock_synced(-1));
  check("boot-plus-uptime in 1970 is unsynced", !tk_wall_clock_synced(86400));
  check("one second under the floor is unsynced",
        !tk_wall_clock_synced(TK_WALL_CLOCK_SYNC_FLOOR_S - 1));
  check("the floor itself counts as synced",
        tk_wall_clock_synced(TK_WALL_CLOCK_SYNC_FLOOR_S));
  check("a real 2026 timestamp is synced", tk_wall_clock_synced(1787097720LL));
  check("the floor predates this firmware's first release",
        TK_WALL_CLOCK_SYNC_FLOOR_S < 1786000000LL);

  /* Verdict wire names, and nothing sent for an unknown one. */
  expect("approve name",
         tk_needs_you_verdict_name(TK_NEEDS_YOU_VERDICT_APPROVE), "approve");
  expect("deny name", tk_needs_you_verdict_name(TK_NEEDS_YOU_VERDICT_DENY),
         "deny");
  expect("leave_it name",
         tk_needs_you_verdict_name(TK_NEEDS_YOU_VERDICT_LEAVE_IT), "leave_it");
  check("unknown verdict has no wire name",
        tk_needs_you_verdict_name((tk_needs_you_verdict)99) == NULL);

  /* The canonical message is exactly what the bridge signs. */
  check("message length",
        tk_needs_you_canonical_message(message, sizeof message, "abc",
                                       "approve", 1000) == 16);
  expect("message bytes", message, "abc|approve|1000");

  check("v2 canonical bytes",
        tk_needs_you_canonical_message_v2(
            message, sizeof message, "codex", "ABEiM0RVZneImaq7zN3u_w",
            "df55d0b8c9bcccae1eab3d28b985f696b27422f368358169248a4b797991a38d",
            "approve", 1787097720ULL) > 0);
  expect("v2 canonical exact", message,
         "v2|codex|ABEiM0RVZneImaq7zN3u_w|"
         "df55d0b8c9bcccae1eab3d28b985f696b27422f368358169248a4b797991a38d|"
         "approve|1787097720");
  tk_needs_you_hmac_hex(mac, key64, message);
  expect("v2 Python cross-vector", mac,
         "49357b233c81c9979606a52b94aaab578c18fc95c16d0037949b1018c298bbbf");
  check("v2 body length",
        tk_needs_you_answer_body_v2(
            body, sizeof body, "codex",
            "df55d0b8c9bcccae1eab3d28b985f696b27422f368358169248a4b797991a38d",
            "approve", 1787097720ULL, mac) > 0);
  expect("v2 body exact", body,
         "{\"provider\":\"codex\",\"view_sha256\":"
         "\"df55d0b8c9bcccae1eab3d28b985f696b27422f368358169248a4b797991a38d\","
         "\"verdict\":\"approve\",\"ts\":1787097720,\"hmac\":"
         "\"49357b233c81c9979606a52b94aaab578c18fc95c16d0037949b1018c298bbbf\"}");

  /* HMAC vectors — byte-for-byte with interactions.sign_answer("a"*64, ...). */
  tk_needs_you_hmac_hex(mac, key64, "abc|approve|1000");
  expect("sign_answer abc/approve/1000", mac,
         "ef9f2c37d8cc1897c781135d95586654a559cbe9bd22b09b8801fd52a20ca865");

  tk_needs_you_canonical_message(message, sizeof message,
                                 "6750af25a1f5ab4161fc7698c3f84d60", "approve",
                                 1786000000);
  tk_needs_you_hmac_hex(mac, key64, message);
  expect("sign_answer real-id/approve", mac,
         "ae1c7d5ceec2c0a20fd0f9c681486eb1eb3c9914911b4c808baa97b7e9b8a85b");

  tk_needs_you_hmac_hex(mac, key64, "panic|deny|1786000000");
  expect("sign_answer panic/deny", mac,
         "b6d78378fa768ae5379919eefe5db4730c261efa8db2b4aa413b68bb60ed265d");

  tk_needs_you_hmac_hex(mac, key64, "1111111111111111111111111111beef|deny|42");
  expect("sign_answer deny/42", mac,
         "2a52f90ddb50a12cb0395a5d583212517c1d327085ad55cf0bf4031194514451");

  /* RFC 4231 case 1: key 0x0b*20, "Hi There". */
  {
    char key20[21];
    memset(key20, 0x0b, 20);
    key20[20] = '\0';
    tk_needs_you_hmac_hex(mac, key20, "Hi There");
    expect("RFC4231-1", mac,
           "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  }

  /* RFC 4231 case 6: a 131-byte key exercises the key-longer-than-block path. */
  {
    char key131[132];
    memset(key131, (char)0xaa, 131);
    key131[131] = '\0';
    tk_needs_you_hmac_hex(
        mac, key131,
        "Test Using Larger Than Block-Size Key - Hash Key First");
    expect("RFC4231-6 (long key)", mac,
           "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  }

  /* JSON bodies, exactly as fake-panel.py posts them. */
  check("answer body length",
        tk_needs_you_answer_body(body, sizeof body, "approve", 1000,
                                 "deadbeef") > 0);
  expect("answer body bytes", body,
         "{\"verdict\":\"approve\",\"ts\":1000,\"hmac\":\"deadbeef\"}");
  check("panic body length",
        tk_needs_you_panic_body(body, sizeof body, 42, "cafe") > 0);
  expect("panic body bytes", body, "{\"ts\":42,\"hmac\":\"cafe\"}");

  /* Overflow is refused, never a truncated (forgeable) message or body. */
  check("message overflow refused",
        tk_needs_you_canonical_message(message, 4, "abc", "approve", 1000) ==
            -1);
  check("v2 message overflow refused",
        tk_needs_you_canonical_message_v2(
            message, 8, "codex", "ABEiM0RVZneImaq7zN3u_w",
            "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a",
            "approve", 1787097720ULL) == -1);
  check("v2 body overflow refused",
        tk_needs_you_answer_body_v2(
            body, 8, "codex",
            "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a",
            "approve", 1787097720ULL, mac) == -1);
  check("v2 provider är exakt lowercase",
        tk_needs_you_canonical_message_v2(
            message, sizeof message, "CODEX", "ABEiM0RVZneImaq7zN3u_w",
            "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a",
            "approve", 1787097720ULL) == -1);
  check("v2 digest är exakt lowercase hex",
        tk_needs_you_canonical_message_v2(
            message, sizeof message, "codex", "ABEiM0RVZneImaq7zN3u_w",
            "9F4F6EC7A3519DF610BE969B66100FC0FEFBE53A54CC59A82FB49DC70BA6E22A",
            "approve", 1787097720ULL) == -1);
  check("v2 id kan inte injicera kanoniska fält",
        tk_needs_you_canonical_message_v2(
            message, sizeof message, "codex", "abc|claude",
            "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a",
            "approve", 1787097720ULL) == -1);
  check("body overflow refused",
        tk_needs_you_answer_body(body, 8, "approve", 1000, "x") == -1);
  check("null args refused",
        tk_needs_you_canonical_message(message, sizeof message, NULL, "approve",
                                       1000) == -1);

  /* No client-side retry, ever. */
  check("never auto-retries",
        !tk_needs_you_send_should_retry(200) &&
        !tk_needs_you_send_should_retry(409) &&
        !tk_needs_you_send_should_retry(500) &&
        !tk_needs_you_send_should_retry(0));

  if (failures == 0) {
    printf("OK: alla needs-you-send-policytester gröna\n");
    return 0;
  }
  printf("%d test föll\n", failures);
  return 1;
}
