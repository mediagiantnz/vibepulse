# Changelog

Notable changes to VibePulse. Release notes for tagged versions are published
on the [releases page](https://github.com/niclasvestlund-YT/vibepulse/releases).

## Unreleased

A whole-project review (2026-08-26) and the fixes that came out of it: one
fresh-clone display bug, a batch of security hardening and a number of
honesty fixes. One new feature, the Windows tray icon, plus the console-flash
fix it was built alongside. Operators who deployed either relay before this
change should redeploy with the new config and rotate the relay secret and
both interaction tokens (see "Changed", relays).

### Added

- **Ikon vid klockan på Windows (`tools/tokenserver/tray_windows.py`).** The
  service had no presence on the machine that runs it; the tray app shows the
  highest of the four live quota percentages next to the clock, colour-coded,
  with every number in the tooltip and menu. It owns the server rather than
  watching one - launching `tokenserver.py` as its child, restarting it with
  backoff, stopping it on Quit - so `install-windows-task.ps1 -Tray` retires
  the plain service task and the two cannot race for port 8737.

### Fixed

- **The Codex plugin's hooks failed on every Windows session (2026-09-14).**
  Codex runs hook commands through PowerShell on Windows, not `cmd.exe`, so
  the `%PLUGIN_ROOT%` in both `commandWindows` entries was never expanded and
  `py -3` was handed a literal `%PLUGIN_ROOT%\scripts\...` path. Codex itself
  substitutes `${PLUGIN_ROOT}` into the command text before it runs, so the
  hooks now use that form, which works under PowerShell and `cmd.exe` alike.
  Note that Codex copies a local-marketplace plugin into
  `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and runs the
  copy, so a hooks.json edit only takes effect after the cache is refreshed,
  and the changed handler needs re-trusting in Codex.
- **A console window stole focus once a minute on Windows (2026-08-27).** The
  Codex quota poll spawns `codex app-server` every 60 s; the service runs
  under `pythonw.exe`, which owns no console, so every console child got a
  new one allocated - and `codex` resolves to the npm shim `codex.CMD`,
  making the real spawn `cmd.exe /c codex.CMD`. A cmd window flashed up and
  took keyboard focus all day. `_no_window_kwargs()` now carries
  `CREATE_NO_WINDOW` on every spawn in the service, and a test walks the
  module's AST so a new one without the flags fails the suite.
- **Boot loop from the stack probe (2026-08-27, never released).** The
  ten-second stack-high-water probe asked `xTaskGetHandle` for
  "interaction-relay", a name longer than FreeRTOS's 15-character cap, and
  the assert rebooted a panel the boot-health gate had already blessed. The
  task is now "interact-relay", the probe truncates every name before the
  lookup, its first run happens inside the gate's 8 s minimum so a crashing
  probe rolls back instead of sticking, and a wiring test pins all task
  names under the cap.
- **The Value page in a fresh clone.** With the GitHub page off (the default)
  the Value tile was created one column past the end of the tile array, so
  the panel showed an empty black column before it and the pager never
  highlighted it. Value is now the fixed sixth page and the optional GitHub
  page is always the last one; a compile-time assert keeps the order honest.
- **"RUNS OUT SUN 14:30" was UTC.** The panel has no timezone, so the
  exhaustion clock printed UTC as if it were local time. The tokenserver now
  sends `tzOffsetMin` (the host's UTC offset in minutes) and the panel renders
  host-local time; when the offset is unknown it shows a relative time
  ("RUNS OUT IN 1D 3H"), never a wrong clock.
- **"ON IT" only when the answer actually left.** A Needs You verdict that
  could not be queued (no device key, full send queue, capture failure) used
  to dismiss the takeover and play the payoff anyway. The takeover now stays
  up with "NOT SENT · ANSWER AT YOUR DESK" and only LEAVE IT; a build with no
  send channel offers LEAVE IT only.
- **Max Tracker and GitHub pages go stale on their own feed** instead of
  showing LIVE forever when only their endpoint dies (OBS-09, partial: the
  agent feed's copy is still pending an AMOLED review).
- **A forgotten network after a marginal join.** A 4-way-handshake timeout
  on a weak link was treated as WRONG PASSWORD even when the trial then got
  an IP, so the network was never saved. An IP on the applied trial now
  counts as proof whatever reason code arrived first.
- **Unsynced clock on the panel.** `time(NULL) <= 0` never fires on an
  ESP32 before SNTP, so relay expiry was inert and direct verdicts could
  carry a bogus timestamp. Both paths now gate on a plausible wall clock.
- **Tokenserver: one malformed transcript row froze the month's totals.**
  Hostile or truncated rows in `~/.claude/projects` are skipped instead of
  aborting the whole recompute.
- **Tokenserver: idle connections could exhaust the worker pool.** A 15 s
  socket timeout on request reads plus TCP keepalive; 32 silent peers no
  longer turn every poll into a 503.
- **Tokenserver: DST-safe month and day boundaries** (the first hour of an
  April month was dropped on NZ hosts), a bounded 15-minute freshness window
  for the Codex rollout fallback (older observations are served `stale:true`
  and history samples are stamped at observation time), `max-tracker.json`
  saved only when something changed, stale inode watermarks pruned, and a
  clean shutdown with a final flush on SIGTERM/SIGBREAK.
- **Windows setup.** `tools/vibepulse_setup.py doctor/install` now verifies
  Codex ownership correctly on Windows (CRLF probe output, `\\?\` paths,
  root-only marketplace rows) and retains up to 1 MiB of
  `codex plugin list --json` instead of 16 KiB; the Codex hook scripts emit
  UTF-8 on Windows instead of cp1252. VibePulse Studio runs on Windows.
- **Relay merge** clamps publisher clocks to receipt time and copies a
  pool's winner as a whole, so a fast clock or an older tokenserver can no
  longer mix fields from two machines.

### Changed

- **OTA upload proof.** The sender no longer sends the OTA token over the
  LAN. It sends the image's SHA-256 and `X-VibePulse-Auth`, an HMAC-SHA256 of
  that digest keyed with the token; the device checks the proof before
  accepting bytes and re-checks the streamed digest against it before
  activating, both in constant time. Script and firmware are a matched pair:
  update the panel over USB (or with the previous `ota-flash.sh`) once. While
  the running image is still unverified the device answers 409 and
  `ota-flash.sh` waits for `pending_verify:false`; the script now exits
  non-zero on anything but 202. `openssl` is required on the Mac.
- **Setup-AP password.** Only a window opened with the KEY3 hold uses the
  token-derived password; a window that opens by itself after 90 s without an
  IP gets a fresh random password shown only on the glass, so a deauth flood
  can no longer be turned into a known-password setup window. `docs/wifi.md`
  now states the guarantee honestly.
- **Relays: platform invocation logs are off.** Cloudflare Workers Logs were
  retaining request URLs and headers for seven days, which for the numbers
  relay is the secret URL and for the interaction relay both bearer tokens.
  Both configs and the deploy guard now require `invocation_logs: false`.
  Redeploy and rotate `RELAY_SECRET` and both interaction tokens. The numbers
  relay also compares the secret in constant time, sends
  `Cache-Control: no-store`, measures bodies in bytes and refuses documents
  that are not the numbers shape; a ninth publisher evicts the quietest name
  instead of being refused forever. The interaction relay's `npm run deploy`
  is now a guard that refuses the placeholder mailbox id.
- **Tokenserver GET host guard.** `GET` requests whose `Host` is not an IP
  literal, `localhost` or a `.local` name get 421, closing DNS-rebinding
  reads of agent status from a browser on the LAN. The panel's compiled-in
  Bonjour name is unaffected.
- **Parsers reject deep JSON.** cJSON on the panel is compiled with a
  nesting limit of 16 (a 20-deep body used to recurse on a 6 KB stack);
  the tokenserver bounds request bodies to 32 levels.
- `/api/tokens` body budget on the panel raised from 2048 to 3072 bytes; the
  real worst-case payload (1571 B) had crossed the 75 % margin unnoticed,
  and the capacity gate now diffs the live snapshot's key set.
- CI runs the Codex plugin and setup-script suite on Windows and macOS as
  well as Ubuntu; studio browser-contract tests run under Node where JXA is
  absent and fail rather than skip on CI.

### Removed

- Dead firmware code kept alive only by its tests (the removed monitor
  view's policy helpers, `agent_usage.c`, unused presenter builders) and the
  inert keep-alive fields on the agent-status client.

## v0.7.0 — 2026-08-23

Codex joins the answerable Needs You flow, the panel gains phone-first Wi-Fi
onboarding, and the host service becomes portable across macOS and Windows.
Optional encrypted interaction and live-status relays keep the panel useful
when it and the computer are on unrelated ordinary internet Wi-Fi. Illustrated
notes: [Codex and any Wi-Fi](docs/releases/2026-08-23-codex-and-any-wifi.md).

### Added

- **Codex interactions on the panel.** The optional plugin bridges supported
  questions and a narrow safe-command approval tier into the shared Needs You
  UI. Provider/view-bound verdicts, bounded text, fail-closed setup, and strict
  allowlists keep unknown, mutating, secret-bearing, or ambiguous requests on
  the computer.
- **Encrypted Needs You across unrelated Wi-Fi.** A user-owned Cloudflare
  Durable Object mailbox carries fixed-size end-to-end encrypted request and
  verdict frames. It is separate from the numbers relay, uses outbound HTTPS
  only, and stays off until a provider, bounded detail, and the relay are each
  explicitly enabled.
- **Encrypted live agent status across unrelated Wi-Fi.** A third independent
  transport carries only minimized Claude/Codex rows, never the pending
  decision. Direct LAN wins; stale relay rows clear honestly.
- **Phone-first Wi-Fi setup.** The panel shows a scannable QR, serves a local
  network picker, tests credentials before saving them, and keeps every old
  recovery network after a failed trial. The top-right Wi-Fi mark now appears
  consistently across the launcher, apps, Needs You, OTA, and setup.

- **The panel travels.** It remembers six places in NVS and joins the one
  that worked most recently; arriving somewhere new no longer means editing
  `secrets.h`, rebuilding and flashing over USB — which OTA could never fix,
  since OTA needs the network the panel cannot reach. Two ways to teach it a
  place: `tools/wifi-here.sh` on the Mac hands over the network it is
  already on (reading the password from the keychain, one prompt, nothing
  typed), or the panel raises `VibePulse-setup` with a phone-first QR; the
  temporary password stays behind the Manual Setup fallback. Its captive
  portal lists what the panel's *own* radio can see.
  The window opens by itself after 90 s without an IP, or on a 3 s KEY3
  hold, and closes after ten minutes — the access point, HTTP server and DNS
  responder do not exist outside it (the lazy-surface rule from the
  2026-08-14 freeze). The `secrets.h` networks stay as an immutable floor
  underneath, so no entry can ever cost a USB rescue, and the setup window
  can never write firmware. Full reference: `docs/wifi.md`.
- The **relay**, end to end: the panel can now get its numbers from
  anywhere with internet, instead of only from the same LAN as the
  service. Born the same evening as the travel work: a guest network's
  client isolation kept the panel from reaching the Mac while internet
  worked fine, and no code on the panel could fix that. Three parts, one
  boundary:
  - *Panel*: fetches try the LAN first and fall back to the mailbox
    (`TK_VIBEPULSE_RELAY_URL` in `secrets.h` — commented out by default;
    without it nothing changes).
  - *Service*: `--publish <url>` POSTs the same three payloads the LAN
    endpoints serve — send-on-change plus a 5-minute heartbeat, staying
    inside Cloudflare KV's 1 000 free writes/day by design. Several
    machines may publish to one mailbox; every send names its publisher.
  - *Mailbox*: a ~150-line Cloudflare Worker (`tools/relay/`) that merges
    freshest-per-pool on read using the observation stamps the staleness
    logic already carries — Claude from whichever machine asked Anthropic
    last, Codex from whichever machine ran Codex last.
  The numbers-only boundary is enforced from three directions
  (`test/test_relay_boundary.py`, `test_publisher.py`, the Worker's path
  allowlist): the relay carries *numbers* (quota, burn rate, Max Tracker,
  GitHub), never *activity*. The separately enabled encrypted interaction and
  live-status relays use a different Worker, credentials, protocol, and
  privacy boundary. Full designs: `docs/relay.md` and
  `docs/interaction-relay.md`.
- **Windows autostart** for the tokenserver
  (`tools/tokenserver/install-windows-task.ps1`): a scheduled task running
  as the logged-in user (never SYSTEM — the credential file lives in the
  user profile), restarting on failure, with state in
  `%LOCALAPPDATA%\VibePulse\`. The current background task does not persist
  stdout/stderr; use the root health endpoint or run manually for diagnostic
  logs. Closes the gap in issue #3.
- **Hold KEY3 twice to reach WiFi setup on a connected panel.** The setup
  window used to open only when the panel had no network — you could not
  pre-load the phone hotspot at home before a trip. Now a second full 3 s
  hold while the update window is open switches to WIFI SETUP. Any release
  before three seconds still just closes (the 2026-08-16 escape hatch is
  untouched); the port-80 handover between the two windows' HTTP servers is
  owned by the setup guard, so they never collide.

  **Hardware status, honestly:** the first physical exercise of this path
  wedged the panel twice (2026-08-17; rolled back to the previous release
  over USB). Suspected DMA starvation by the access point — the exact
  2026-08-16 freeze anatomy — pending the incident's serial log.
  `window_open()` is now bracketed by two host-tested DMA gates (refuse below 3x
  the flush's contiguous block — calibrated against v0.5.0's measured
  40-47 kB healthy baseline, so a healthy panel is never refused — abort
  below 2x after the APSTA switch) with per-stage DMA logging. The gates are defensive, not a
  verification: the setup window stays unproven on hardware until a
  supervised run passes.
- The glass explains a missing network instead of showing dashes. After 60 s
  without an IP it names the network being hunted and translates the radio's
  own disconnect reason — "NOT SEEN - 2.4 GHZ ONLY", "WRONG PASSWORD". The
  reason codes were already in the serial log; a shelf gadget nobody has a
  cable to could not show them.

### Changed

- **CI now runs the whole host gate**, not a subset (OBS-24). A `host-gate`
  job executes the same `./test/run.sh` as the bench on every push — the C
  test binaries, wiring and capacity tests, the Mbed TLS crypto vectors
  (against a sparse clone of the IDF-pinned sources) and the SDL landmark
  captures under `xvfb-run`. Only the JS suites are skipped (`--skip-js`);
  their own jobs still run them — the Worker suite npm-cached in the
  interaction-relay job, the relay mailbox test in the tokenserver job.
  The tokenserver module list
  moved to `test/tokenserver-suite.txt` — one list shared by `run.sh` and
  CI, with a completeness guard so a new test module cannot silently stay
  outside the gate (the PR #11 lesson, made structural). Two
  `test_vibepulse_codex_plugin.py` cases learned Linux along the way: the
  doctor-probe expectation now resolves `/bin/sh` (a dash symlink on
  Debian-family runners), and the descendant-kill assertion accepts a
  SIGKILLed orphan that pid 1 has not reaped yet.

### Fixed

- Open networks were refused in silence. Every network was applied with
  `threshold.authmode = WIFI_AUTH_WPA2_PSK`, so an open café or airport
  network — the common case on the road — was rejected before it was tried,
  with nothing in the log pointing at the threshold. The authmode now
  follows each network: open where the password is blank.

- The panel names all three GPT-5.6 variants. `gpt-5.6-sol` had a typeset
  screen label while its siblings `terra` and `luna` fell through to their
  raw lowercase ids — the price table knew all three, the screen knew one,
  so the agent tile read `gpt-5.6-terra` next to a properly set `OPUS 5`. A
  test now also holds every label inside `TK_AGENT_MODEL_CAP`, reading the
  cap from the firmware header rather than restating it. Spotted on Erik
  Elfström's T-Display-S3 fork. The wider fallthrough — ~110 priced models,
  six named ones, and dated ids that truncate mid-string — is written up as
  OBS-30 rather than fixed here.
- CI's tokenserver job runs the same eleven test modules as `test/run.sh`.
  The lists had drifted four suites apart — `test_value_meter`,
  `test_update_prices`, `test_codex_usage` and `test_interactions` ran only
  in the local gate — which is exactly how a green CI hid a runtime
  `NameError` in the rebased Windows branch (PR #11): the missing
  `test_interactions` catches it immediately.

### Desktop support

- The tokenserver reads Claude's OAuth token on Windows. Claude Code has no
  keychain integration there, so `claude login` writes the same
  `{"claudeAiOauth": {...}}` record the macOS keychain holds to a plain file,
  `%USERPROFILE%\.claude\.credentials.json`; the probe now reads it when
  running on Windows and skips the two macOS-only sources (`security`,
  `pgrep` for Claude Desktop's injected token) that cannot exist there. macOS
  behaviour is untouched.

  Two things had to give way for that read to be reachable at all: `fcntl`
  is not importable on Windows, so the module could not even load, and the
  machine-wide single-probe lock was built on `flock`. The import is now
  guarded and the lock takes `msvcrt.locking` where `flock` is missing —
  same non-blocking gate, different syscall — so the 429 guard survives the
  port instead of quietly disappearing with it.

  The Codex half works there too. Its quota read spawns `codex app-server`
  and polled stdout with `select.select`, which on Windows accepts sockets
  and never pipes; it now reads through a queue fed by a daemon thread, the
  same code on every platform. That path had no test at all — every existing
  test mocked the reader out and exercised only the parser — so it now has
  three, driving a real subprocess through the real pipe for the reply,
  timeout and immediate-death cases. Writing them turned up a leak worth
  fixing on its own: the pipes were never closed, leaving three descriptors
  per poll to the garbage collector in a service that polls every 30 s and
  never restarts.

  State and logs moved off the hardcoded `~/Library` paths to a per-platform
  directory — `%LOCALAPPDATA%\VibePulse\` on Windows, unchanged on macOS.
  The old paths worked literally on Windows but planted a `Library` tree in
  the user profile that nothing else on the machine recognises.

  Native Task Scheduler autostart, immediate start, restart-on-failure, and
  saved interaction-provider choices complete the Windows host path in this
  release. Reported by Erik Elfström, who found the original gaps while
  porting a fork to a LilyGO T-Display-S3.
- Renewed Claude credentials are detected and published promptly. A stale
  Claude Desktop process token can no longer leave a valid new login hidden
  behind cached `401` data until the next long probe interval.

## v0.6.0 — 2026-08-16

- **Needs You becomes an input device for Claude Code.** A held question or
  supported permission takes over the panel; a tap reveals the bounded view
  and APPROVE / DENY / LEAVE IT returns a signed verdict to the same live
  session. Walking away always falls back to the terminal.
- The shared LVGL takeover was rebuilt around the approved
  attract → decision → payoff flow, including long-text fit guards and a
  private fallback state.
- The LVGL pool moved to PSRAM to restore the internal DMA headroom the AMOLED
  flush needs, fixing a physical panel freeze.

## v0.5.0 — 2026-08-15

- Added the **value multiple** page: priced month-to-date Claude/Codex token
  usage divided by the plan cost the user explicitly declares. Unknown prices
  degrade to a dash instead of being guessed.
- Added the optional **GitHub project pulse**: stars/forks page plus a named
  new-star takeover, with screen, notification, and future sound as separate
  default-off switches.
- Fixed Codex resume/fork replay overcounting by grouping rollouts by session
  and using the most complete copy. Illustrated notes:
  [value and GitHub](docs/releases/2026-08-15-value-and-github.md).

## v0.4.0 — 2026-08-14

- Added the consent-gated A/B OTA platform: physical KEY3/touch consent,
  authenticated inactive-slot upload, image verification, a 15-second boot
  health gate, and automatic rollback.
- Added UPDATE READY, the OTA progress ring, and a boot screen driven by real
  Wi-Fi/time/data signals.
- Hardened the tokenserver against rejected tokens, concurrent probing, 429
  penalties, and stale build delivery. Illustrated notes:
  [OTA platform](docs/releases/2026-08-14-ota-platform.md).

## v0.3.0 — 2026-08-14

- Added the observability map, transition logs, smoke-test contract, backlog,
  and lessons log so a stale or foreign tokenserver is visible instead of
  looking healthy.
- The completion alert gained its first measured pulse and physical motion
  review; text and provider marks remain solid for readability.

## v0.2.1 — 2026-08-13

Server fixes verified live on a real installation the same evening; the
firmware alert fix reaches a device on its next flash.

### Fixed

- Repeated probe failures now slow the probe down (120 → 240 → 480 s cap), so
  a dead token can never again hammer the API every two minutes for hours —
  the pattern that earned tonight's 429 penalty. A successful probe restores
  the normal pace. The root endpoint also reports `rev` and `startedAt`, so a
  stale running process (wrong directory, old code) is visible in one curl.
- The Claude probe backs off on HTTP 429: it stops the cycle immediately (no
  second token source, no header probe — extra traffic only extends the
  penalty) and rests for at least ten minutes, honouring a longer
  `Retry-After` when the API sends one. `claudeProbe` shows
  `usage_http_429 + backoff_until_HH:MM` while resting.
- The Claude probe no longer requires an active 5-hour session window to
  count as successful. Between windows the usage API reports the session row
  with a lapsed reset, and the probe used to discard the still-valid weekly
  numbers, fall back to the header probe, and report its 401 instead — so the
  screen lost all Claude data for the gap after every window ended. Weekly
  and per-model figures now go through on their own; the session field shows
  a dash until the next window opens. The header-probe fallback also appends
  its outcome (`; fallback_http_…`) instead of overwriting the usage status,
  so `claudeProbe` keeps the evidence.
- The tokenserver's Claude probe no longer trusts a stale token frozen into a
  long-lived Claude Desktop child process. `ps eww` reports the environment as
  of process launch, so a Desktop child that outlives its token kept serving
  an expired value that outranked a fresh `/login` in the keychain — the
  screen sat on `http_401` until Claude Desktop was quit. The probe now tries
  each token source in order and falls back on 401/403.
- Firmware: full-screen alerts (NEEDS YOU, DONE, ERROR) now require the state
  change to be fresher than 2 minutes after boot too, not only on the first
  snapshot. Waiting states that are hours old — rediscovered after a
  tokenserver outage or restart — no longer take over the screen; they appear
  in the header only. Reaches a device on its next flash.

### Known

- The alert's pulse phase has no visual effect yet: the 4.8 s PULSE phase and
  the STATIC phase render identical frames, so the alert appears without any
  attention-drawing motion. An actual pulse is motion work gated behind the
  AMOLED review protocol (simulator frames, static physical review, measured
  motion on the panel).

## v0.2.0 — 2026-08-13

One app: VibePulse is the only app in the repository and the screen boots
into it. Corrected README claims (the six real pages, the privacy scope of
what the screen receives and what a lost screen carries). `secrets.h.example`
ships its URLs active with a `DIN-MAC` placeholder instead of commented out.
New `docs/agent-setup.md` runbook for coding agents. Companion apps resolve
during ESP-IDF early expansion; the host test gate runs headless on Linux.

## v0.1.0 — 2026-08-13

First public release. Its tag predates the history cleanup and no longer
builds from a fresh clone; superseded by v0.2.0.
