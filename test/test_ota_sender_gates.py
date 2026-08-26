#!/usr/bin/env python3
"""Regression guard: the OTA pusher's sender gates must never erode.

Läxorna 2026-08-14: en hårdkodad byggkatalog och ett filval vid skriptstart
sköt en arkiverad frysbinär till glaset; -dirty-byggen och byggen utan grön
CI ska aldrig kunna levereras av misstag. Enheten bevisar att en avbild är
GILTIG — skriptet bevisar att den är RÄTT."""

import hashlib
import hmac
import shutil
import subprocess
from pathlib import Path


root = Path(__file__).resolve().parents[1]
script = (root / "tools" / "ota-flash.sh").read_text(encoding="utf-8")

wait_idx = script.index('"maintenance_open":true')
pick_idx = script.index("ls -t build*/torget.bin")
assert pick_idx > wait_idx, (
    "binärvalet ska ske EFTER fönsterväntan (uppladdningsögonblicket) — "
    "ett val vid skriptstart valde spökbinären medan bygget skrev sin fil"
)

# --- The upload proof (2026-08-26) ------------------------------------------
# The token never leaves the Mac. The script sends
# X-VibePulse-Auth = hex(HMAC-SHA256(key = token, msg = sha256 hex of image))
# next to the digest; the device recomputes it and holds the streamed body
# to the same digest. A captured proof can only re-send the same image.
assert "Authorization: Bearer" not in script, (
    "the token must never be sent on the wire, not even to the panel"
)
assert '-H "X-VibePulse-Auth: $PROOF"' in script and '-H "X-VibePulse-SHA256: $SHA"' in script
proof_line = 'PROOF=$(printf \'%s\' "$SHA" | openssl dgst -sha256 -hmac "$TOKEN" | awk \'{print $NF}\')'
assert proof_line in script, "the proof must be computed exactly as documented"
assert "grep -Eq '^[0-9a-f]{64}$'" in script, (
    "a malformed proof (no openssl, odd output format) must stop the upload"
)
# The exact vector the script's comment quotes, reproduced from Python's
# hmac so the comment can never drift from the truth ...
KEY = b"b" * 64
MSG = b"a" * 64
VECTOR = "b9e5ca0b1bb0216bd222b79cdf8d037b8d74e679bcc70968a47117165e2e6357"
assert hmac.new(KEY, MSG, hashlib.sha256).hexdigest() == VECTOR
assert VECTOR in script, "the script must quote the verified HMAC vector"
# ... and run through the real openssl pipeline wherever one exists.
if shutil.which("openssl"):
    digest = subprocess.run(
        ["openssl", "dgst", "-sha256", "-hmac", KEY.decode()],
        input=MSG, capture_output=True, check=True,
    ).stdout.decode().split()[-1]
    assert digest == VECTOR, f"openssl -hmac disagrees with Python hmac: {digest}"

# --- The chained update ------------------------------------------------------
# IDF refuses esp_ota_begin while the running slot is PENDING_VERIFY; the
# device answers 409 and publishes pending_verify on /api/ota/status. The
# script waits for pending_verify=false and treats anything but 202 as a
# refusal with a non-zero exit (it used to print the success line over a
# 500).
assert "'\"pending_verify\":false'" in script and "'\"pending_verify\":true'" in script, (
    "the wait loop must hold until the previous image has been verified"
)
assert script.index("'\"pending_verify\":false'") < pick_idx
assert "-w '%{http_code} %{time_total}'" in script and '-o "$REPLY"' in script
assert 'if [ "$CODE" != "202" ]; then' in script and "exit 1" in script.split(
    'if [ "$CODE" != "202" ]; then', 1)[1], (
    "anything but 202 must exit non-zero and print the device's error body"
)
assert "409)" in script and "401)" in script and "403)" in script
assert 'BIN_VERSION=$(dd if="$BIN" bs=1 skip=48 count=32' in script, (
    "versionen ska läsas ur avbildens egen appbeskrivning och deklareras"
)
assert "TG_OTA_ALLOW_DIRTY" in script and "*-dirty*" in script, (
    "-dirty-byggen ska vägras utan uttrycklig TG_OTA_ALLOW_DIRTY=1"
)
assert "TG_OTA_ALLOW_NO_CI" in script and "gh run list --commit" in script, (
    "CI-bryggan: byggen utan grön CI för sin commit ska vägras, med "
    "TG_OTA_ALLOW_NO_CI=1 som enda nödventil"
)

ci = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
assert "branches: ['**']" in ci, (
    "CI ska köra på alla brancher — annars kan bryggan aldrig se grönt "
    "för branchbyggen och blockerar det dagliga flödet"
)

print("OK: avsändargrindarna står — rätt fil, deklarerad version, ren build, grön CI")
