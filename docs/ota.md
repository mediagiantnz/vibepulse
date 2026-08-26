# Over-the-air updates — how the whole loop works

This is the complete story of how a build on your Mac becomes firmware on
the shelf, and why each step looks the way it does. The README has the
short version; this is the reference.

## The loop at a glance

```
 Mac                                   screen
┌──────────────────────────┐          ┌─────────────────────────────┐
│ idf.py build             │          │                             │
│  └─ torget.bin           │          │  polls /api/tokens every    │
│ tokenserver announces    │ ───────► │  30 s, compares versions    │
│  otaAvailableVersion     │          │  └─ mismatch: UPDATE READY  │
│                          │          │     takeover on the glass   │
│ tools/ota-flash.sh waits │          │                             │
│  for the window...       │          │  YOU consent:               │
│                          │          │   · tap UPDATE pill, or     │
│                          │          │   · hold KEY3 ~3 s          │
│  └─ POST firmware ─────────────────►│  window open 10 min         │
│  (SHA-256 + HMAC proof)  │          │  RECEIVING → VERIFYING →    │
│                          │          │  RESTARTING → reboot into   │
│                          │          │  the other slot, health     │
│                          │          │  gate approves or rolls back│
└──────────────────────────┘          └─────────────────────────────┘
```

## The consent model (why a button/tap at all)

Nothing can write firmware to the screen without three independent factors:

1. **Physical presence** — the maintenance window opens only from the
   device itself: a ~3 s KEY3 hold, or a tap on the UPDATE pill when the
   UPDATE READY takeover is showing. A script, a LAN neighbour, or a
   compromised Mac cannot open it remotely. On the takeover, the UPDATE
   pill is the *only* yes — a tap anywhere else (including LATER)
   snoozes, so an accidental touch always lands on the safe side.

   Since the WiFi setup window landed (`docs/wifi.md`), the hold opens
   *the window that can actually help*: **with an IP** it opens this OTA
   window, exactly as always; **without an IP** it opens the WiFi setup
   window instead, because an OTA window with no network can never
   receive an upload. A **second full 3 s hold** while this window is
   open switches to the WiFi setup window (hold–hold: update window,
   then network window); any release before three seconds still just
   closes. The consent model is unchanged — both windows open only from
   the device.
2. **Knowledge** - the upload must prove it holds `TG_OTA_TOKEN` (64
   lowercase hex in `secrets.h`, never committed) without ever sending it.
   The sender computes the image's SHA-256 and puts two headers on the
   POST: `X-VibePulse-SHA256: <sha256 hex>` and
   `X-VibePulse-Auth: hex(HMAC-SHA256(key = token, msg = sha256 hex))`.
   The device recomputes the HMAC over the *claimed* digest before it
   accepts a single byte (a wrong proof is a 401), then after the stream
   checks that the bytes it actually received have exactly that digest and
   that the proof still covers it, both in constant time, before
   `esp_ota_end` may run. The token never crosses the LAN, and a captured
   proof is bound to one image: replaying it can only deliver the same
   build again, never a different one. A post-stream mismatch is a 403 with
   no detail; the reason (digest or proof) is in the serial log only.
   `tools/ota-flash.sh` computes the proof with
   `openssl dgst -sha256 -hmac` (checked against Python's `hmac` on a
   known vector, see the comment in the script and
   `test/test_ota_sender_gates.py`). The script and the firmware ship as a
   pair: a device on older firmware cannot accept the new script (401), and
   the new script refuses a device whose status has no `pending_verify`;
   bring such a device up over USB once.
3. **Time** — the window closes itself after ten minutes; a short KEY3
   press closes it early. While it is closed the HTTP server does not
   even exist in memory (the lazy-surface rule from the 2026-08-14
   freeze lesson).

## What the device verifies before booting anything

- **Metadata gate** on the first kilobyte of the stream: ESP image magic,
  chip = esp32s3, project = "torget", a real app descriptor (its version
  string is shown on the glass during RECEIVING — you see *what* is
  arriving, read from the image itself, never from the uploader's claims).
- **SHA-256** over the whole body must match the `X-VibePulse-SHA256`
  header, and the `X-VibePulse-Auth` proof must cover that digest. Both are
  compared in constant time once the stream is complete; either failing
  aborts the update (403, no detail) before `esp_ota_end`.
- **Not while the last image is still on trial**: on the first boot after an
  OTA the running slot is `PENDING_VERIFY` and IDF refuses `esp_ota_begin`
  on the other slot until the boot-health gate has marked it VALID. The
  device answers such an upload with `409 {"error":"previous image not yet
  verified"}` and publishes `"pending_verify":true/false` on
  `/api/ota/status` so a sender can wait instead of guessing.
- **A/B slots**: the image lands in the *inactive* slot (`ota_0`/`ota_1`,
  5 MB each). Bootloader, partition table, NVS and the running slot are
  never written. USB-C remains the rescue path.
- **Boot-health gate**: on the first boot of a new image
  (`PENDING_VERIFY`), display, UI, scheduler, NVS and memory proofs must
  land within 15 s or the bootloader rolls back to the previous slot on
  the next reset. Only `esp_ota_mark_app_valid_cancel_rollback` blesses
  an image.

  One case is decided the other way, on purpose. If the gate fails an image
  but `esp_ota_check_rollback_is_possible()` reports that the other slot
  holds no valid image (the normal state right after a USB flash: only one
  slot is populated), the failing image is marked VALID **under protest**.
  The alternative would order the bootloader into an empty slot, which only
  USB can rescue; a limping app on the glass beats a dead board. The device
  says so at WARN level, naming the missing evidence bits, the version and
  the reason (`hälsogrinden fällde avbilden ... men godkänner UNDER
  PROTEST: esp_ota_check_rollback_is_possible() == false ...`). In that
  state there is no health gate at all, so treat it as a runbook item:

  **After every USB flash, do one deliberate OTA of the same build** so
  both slots are populated. From then on the gate always has somewhere to
  roll back to and the protest path cannot trigger.

## The UPDATE READY notice

The tokenserver reads the version out of the newest `build*/torget.bin`
app descriptor and publishes it as `otaAvailableVersion` on `/api/tokens`
— riding the quota poll the screen already does every 30 s. The screen
compares against its own running version:

- **Mismatch** → full-screen takeover: UPDATE / READY in the ring, the
  waiting version inside, LATER + UPDATE pills below.
- **UPDATE pill** (or a KEY3 hold) → opens the window; if
  `tools/ota-flash.sh` is waiting on the Mac, delivery is automatic.
- **LATER / any other tap** → snooze; the takeover returns every hour
  (`TG_NOTICE_NAG_US` in `notice_policy.h` — raise it when the platform
  calms down) until the update is installed.
- **Match** → silence. The notice can never nag about nothing.
- A busy device (open window, running transfer) is never taken over.

Two windows, one port: the OTA window and the WiFi setup window both
serve HTTP on port 80, so only one can exist at a time. If the setup
window needs to open while an OTA window is standing open, it closes the
OTA window first (an OTA window with no network could never receive an
upload anyway) — the log says so. On the glass the OTA overlay always
outranks the network screens: after an OTA reboot with no network, the
re-armed READY ring owns the display and the network-search screen waits
for the window to close.

The nag rhythm lives in `components/torget_ota/notice_policy.c`, a pure
host-tested module (`test/test_ota_notice_policy.c`).

## The sender gates

The device proves an image is *valid*; the pusher proves it is the
*right* one. Four gates run at the moment of upload, all born from the
2026-08-14 ghost incident:

1. **Newest binary at send time** — never a directory picked at script
   start while a build was mid-write.
2. **The embedded version is read from the image and announced** before
   anything is sent.
3. **`-dirty` builds are refused** (`TG_OTA_ALLOW_DIRTY=1` to override).
4. **CI bridge**: the commit in the version string must have a green CI
   run on GitHub (`TG_OTA_ALLOW_NO_CI=1` for offline emergencies). CI
   runs on every pushed branch for exactly this reason.

## Day-to-day developer workflow

```
idf.py build                        # or idf.py -B <dir> build
tools/ota-flash.sh                  # waits for consent, then uploads
```

The device IP is read from a git-ignored `.ota-device` file in the repo
root (write it once: `echo 192.168.1.x > .ota-device`), or pass it as the
first argument. For any agent session starting cold: the repo lives at
`~/Torget` on this machine (the GitHub name is `vibepulse` — the local
directory is not), the OTA work is on the `claude/ota-foundation` branch,
and this file plus `docs/agent-setup.md` are the runbooks.

Hold KEY3 (or answer the takeover with UPDATE) when you're ready. After
the OTA reboot the window re-arms itself once (PENDING_VERIFY boot), so
an iterate-flash-iterate session needs one consent, not one per build —
observed live 2026-08-14: with the pusher armed, a new build delivered
itself straight into the re-armed window with no touch at all. Chained
updates are the intended dev rhythm; a short KEY3 press ends the chain.

One wrinkle in that rhythm: on the PENDING_VERIFY boot IDF refuses
`esp_ota_begin` until the boot-health gate has blessed the running image
(about 15 s after boot). The device answers an upload in that gap with
`409 previous image not yet verified` and publishes `pending_verify` on
`/api/ota/status`; `tools/ota-flash.sh` waits for `"pending_verify":false`
before it posts, and treats anything but 202 as a refusal: non-zero exit,
the device's error body printed. (It used to print the success line over a
500 and exit 0 in exactly this case.)

Everything the transfer shows on the glass is honest device-owned data:
the ring fills clockwise with the received share, VERIFYING counts the
SHA, the version line names the incoming image.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| "This project has no OTA" | Reading a pre-OTA tree (factory-only `partitions.csv`) | `git branch --show-current`; read `partitions.csv` in *that* checkout |
| Upload gets 403 before any bytes (`maintenance window closed`) | Window not open | Hold KEY3; the glass must show the ring/UPDATES ON |
| Upload gets 403 after the whole transfer (`rejected`) | The streamed digest or the proof did not match | Serial log names which; rebuild and resend (the script always sends the newest binary and its own digest) |
| Upload gets 401 | Proof rejected: the sender's `TG_OTA_TOKEN` differs from the device's, or a header is malformed | `TG_OTA_TOKEN` in `secrets.h`: exactly 64 lowercase hex, identical on both sides; `openssl dgst -sha256 -hmac` must exist on the Mac |
| Upload gets 409 (`previous image not yet verified`) | Chained update posted before the boot-health gate blessed the running image | Wait ~15 s; the script does this itself when `pending_verify` is published |
| Script says `svarar utan pending_verify` | Device firmware predates the proof protocol | Flash once over USB (or with the previous script); the pair must match |
| Upload gets 400 "not a torget esp32s3 image" | Wrong file (bootloader? another project?) | Send `build*/torget.bin`, nothing else |
| 202 but the old version still runs after reboot | Health gate rolled the image back | The new build is broken on-device; check it on USB with the console |
| UPDATE READY never appears | Same version already running, or tokenserver older than the feature | `curl localhost:8737/api/tokens \| grep otaAvailable` |
| Takeover shows but UPDATE does nothing | No pusher waiting on the Mac | Start `tools/ota-flash.sh <ip>` — the tap opens the window; the Mac must deliver |
