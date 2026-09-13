# VibePulse Codex Local Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-off Codex permission and recommended-question support to the existing local VibePulse Needs You loop, with provider-aware signed verdicts and the approved Claude-aligned Codex UI.

**Architecture:** Keep `InteractionStore` as the one concurrency/expiry authority, but make its result provider-neutral. Claude HTTP hooks, the Codex `PermissionRequest` command hook, and the Codex question MCP server become thin adapters around that store. Extend the existing single LVGL Needs You tree with provider state, native Codex assets, and a non-overlapping Wi-Fi signal slot; never build a second hidden screen tree.

**Tech Stack:** Python 3.11 stdlib, Codex plugin hooks and stdio MCP, C11, ESP-IDF 5.5, LVGL 9.5, cJSON, Pillow 12.3, unittest, host C tests, SDL simulator.

---

## Delivery boundaries

This plan produces a fully testable LAN/local implementation. It does not add
the Cloudflare activity mailbox; that is the separate encrypted-relay plan.
It does add the provider and view-digest fields the relay will reuse.

It never touches or flashes `ota_0`. Physical verification, when explicitly
authorized, writes only the `ota_1` application slot.

Execute this plan in a new git worktree created from commit `6359dcf`. The
current checkout contains unrelated user edits, including throwaway simulator
probes, and must remain untouched. Before every commit, compare the staged diff
against that task's file list and reject any staged `--utf8-test`,
`--wedge-repro`, `sdkconfig`, secret, `.wrangler`, or swipe-navigation change.

## File structure

### Host service and adapters

- Create `tools/tokenserver/interaction_types.py`: provider/result enums and
  immutable normalized result types.
- Create `tools/tokenserver/codex_interactions.py`: strict Codex question and
  permission normalization plus Codex response formatting.
- Create `tools/tokenserver/vibepulse_config.py`: default-off saved feature
  configuration under the existing platform state directory.
- Modify `tools/tokenserver/interactions.py`: provider-aware pending entries,
  exact view digest, provider-neutral await result, direct verdict v2, and
  Claude compatibility adapter.
- Modify `tools/tokenserver/tokenserver.py`: independent provider switches and
  loopback-only Codex routes.
- Modify `tools/tokenserver/test_interactions.py`: preserve every Claude
  behavior and test provider isolation/direct v2.
- Create `tools/tokenserver/test_codex_interactions.py`: Codex schema,
  response, HTTP, and fallback tests.
- Modify `test/test_agent_status_body_capacity.py`: include provider/digest in
  the worst-case optional pending budget.

### Opt-in Codex package and setup

- Create `.agents/plugins/marketplace.json`: repo-local `torget` marketplace.
- Create `.agents/plugins/plugins/vibepulse/.codex-plugin/plugin.json`: plugin
  metadata; hooks use default discovery and are not declared in the manifest.
- Create `.agents/plugins/plugins/vibepulse/hooks/hooks.json`: trusted
  `SessionStart` and `PermissionRequest` command hooks.
- Create `.agents/plugins/plugins/vibepulse/scripts/session_start.py`: bounded
  developer context describing safe question-tool use and computer fallback.
- Create `.agents/plugins/plugins/vibepulse/scripts/permission_hook.py`: stdin
  JSON to loopback Codex permission route, stdout decision or empty fallback.
- Create `.agents/plugins/plugins/vibepulse/scripts/mcp_server.py`: minimal
  stdio MCP server exposing one `ask` tool.
- Create `.agents/plugins/plugins/vibepulse/skills/vibepulse/SKILL.md`: user-
  visible capability and privacy description.
- Create `tools/vibepulse_setup.py`: install/status/doctor/disable/uninstall,
  using Codex CLI commands rather than hand-editing Codex config.
- Create `test/test_vibepulse_codex_plugin.py`: manifest, hook, MCP transcript,
  installer command, and uninstall preservation tests.

### Firmware contract and UI

- Modify `components/app_tokens/agent_status.h`: provider and view digest in
  `tk_pending_interaction`.
- Modify `components/app_tokens/agent_status_parse.c`: soft provider/digest
  parsing with legacy missing-provider treated as Claude only.
- Modify `components/app_tokens/needs_you_send_policy.h/.c`: direct verdict v2
  canonical bytes and JSON.
- Modify `components/app_tokens/needs_you_net.c`: queue and sign the displayed
  provider/digest.
- Modify `components/app_tokens/agent_monitor.c`: providerize the one Needs You
  tree, exact Codex strings/colors/assets, and Wi-Fi signal object.
- Modify `platform/torget.h`, `main/main.c`, and `sim/main.c`: non-LVGL Wi-Fi
  state sampling exposed to the LVGL task.
- Modify `tools/agent_assets/build-agent-images.py`, generated
  `components/app_tokens/agent_assets.h/.c`, and
  `tools/agent_assets/test_build_agent_images.py`: native transparent
  `tk_img_codex_64`.
- Create Codex Needs You fixtures under `sim-fixtures/` and extend host/parser,
  simulator, and raster tests.

## Task 1: Provider-neutral interaction types

**Files:**
- Create: `tools/tokenserver/interaction_types.py`
- Test: `tools/tokenserver/test_codex_interactions.py`

- [ ] **Step 1: Write the failing type-contract test**

```python
from tools.tokenserver.interaction_types import (
    InteractionProvider, InteractionResult,
)


class InteractionTypeTests(unittest.TestCase):
    def test_result_is_provider_neutral_and_immutable(self):
        result = InteractionResult(verdict="approve", option_index=1)
        self.assertEqual(result.verdict, "approve")
        self.assertEqual(result.option_index, 1)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.verdict = "deny"

    def test_provider_wire_values_are_stable(self):
        self.assertEqual(InteractionProvider.CLAUDE.value, "claude")
        self.assertEqual(InteractionProvider.CODEX.value, "codex")
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `python3 -m unittest tools.tokenserver.test_codex_interactions.InteractionTypeTests -v`

Expected: `ModuleNotFoundError` naming `interaction_types`.

- [ ] **Step 3: Add the complete immutable types**

```python
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class InteractionProvider(str, Enum):
    CLAUDE = "claude"
    CODEX = "codex"


@dataclass(frozen=True)
class InteractionResult:
    verdict: str
    option_index: Optional[int] = None

    def __post_init__(self) -> None:
        if self.verdict not in ("approve", "deny", "leave_it"):
            raise ValueError("unsupported verdict")
        if self.option_index is not None and self.option_index < 0:
            raise ValueError("negative option index")
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `python3 -m unittest tools.tokenserver.test_codex_interactions.InteractionTypeTests -v`

Expected: both tests `ok`.

- [ ] **Step 5: Commit the type boundary**

```bash
git add tools/tokenserver/interaction_types.py tools/tokenserver/test_codex_interactions.py
git commit -m "refactor: define provider-neutral interactions"
```

## Task 2: Codex normalization and recommendation contract

**Files:**
- Create: `tools/tokenserver/codex_interactions.py`
- Modify: `tools/tokenserver/test_codex_interactions.py`

- [ ] **Step 1: Write failing tests for explicit recommendations and safe approvals**

```python
from tools.tokenserver.codex_interactions import (
    codex_permission_response, normalize_codex_permission,
    normalize_codex_question,
)


class CodexNormalizationTests(unittest.TestCase):
    def test_question_requires_one_explicit_recommendation_for_approve(self):
        event = normalize_codex_question({
            "question": "How should Codex handle approvals?",
            "header": "Approvals",
            "options": [
                {"label": "Use the trusted hook",
                 "description": "Desktop + CLI, one setup",
                 "recommended": True},
                {"label": "Keep computer only",
                 "description": "No panel decisions"},
            ],
        }, cwd="/tmp/Torget", session_id="s", turn_id="t")
        self.assertEqual(event["provider"], "codex")
        self.assertEqual(event["recommended_index"], 0)
        self.assertTrue(event["view"]["can_approve"])
        self.assertEqual(event["view"]["title"], "Use the trusted hook")

    def test_unmarked_question_is_computer_only(self):
        event = normalize_codex_question({
            "question": "Pick one",
            "options": [{"label": "A"}, {"label": "B"}],
        }, cwd="/tmp/Torget", session_id="s", turn_id="t")
        self.assertIsNone(event["recommended_index"])
        self.assertFalse(event["view"]["can_approve"])

    def test_permission_allow_uses_documented_shape(self):
        self.assertEqual(codex_permission_response("approve"), {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"},
            }
        })

    def test_file_change_is_never_remotely_approvable(self):
        event = normalize_codex_permission({
            "session_id": "s", "turn_id": "t", "cwd": "/tmp/Torget",
            "hook_event_name": "PermissionRequest",
            "tool_name": "apply_patch",
            "tool_input": {"command": "*** Begin Patch"},
        }, reveal=True)
        self.assertFalse(event["view"]["can_approve"])
```

- [ ] **Step 2: Run and verify the imports fail**

Run: `python3 -m unittest tools.tokenserver.test_codex_interactions.CodexNormalizationTests -v`

Expected: import failure for `codex_interactions`.

- [ ] **Step 3: Add strict Codex normalizers and response formatting**

Implement `normalize_codex_question()` with the existing 96/64/64 display
bounds, exactly 2–3 options, one optional boolean `recommended`, no control
characters, and no truncation-based approval. Implement
`normalize_codex_permission()` by reusing `approval_view()` and
`approvable_tool()` from `interactions.py`; require
`hook_event_name == "PermissionRequest"` and string session/turn/tool fields.
Use these exact response functions:

```python
def codex_permission_response(verdict: str):
    if verdict == "leave_it":
        return None
    decision = ({"behavior": "allow"} if verdict == "approve" else {
        "behavior": "deny", "message": "Denied from VibePulse",
    })
    return {"hookSpecificOutput": {
        "hookEventName": "PermissionRequest", "decision": decision,
    }}


def codex_question_result(verdict: str, normalized: dict) -> dict:
    index = normalized.get("recommended_index")
    if verdict != "approve" or index is None:
        return {"status": "computer", "reason": verdict}
    option = normalized["options"][index]
    return {"status": "answered", "option_index": index,
            "answer": option["label"]}
```

- [ ] **Step 4: Run all Codex normalization tests**

Run: `python3 -m unittest tools.tokenserver.test_codex_interactions.CodexNormalizationTests -v`

Expected: all tests pass, including duplicate recommendations, long labels,
control characters, multi-question shapes, shell chaining, and missing
descriptions.

- [ ] **Step 5: Commit the Codex adapter**

```bash
git add tools/tokenserver/codex_interactions.py tools/tokenserver/test_codex_interactions.py
git commit -m "feat: normalize Codex panel interactions"
```

## Task 3: Provider-aware store and signed direct verdict v2

**Files:**
- Modify: `tools/tokenserver/interactions.py`
- Modify: `tools/tokenserver/test_interactions.py`
- Modify: `tools/tokenserver/test_codex_interactions.py`
- Modify: `test/test_agent_status_body_capacity.py`

- [ ] **Step 1: Add failing tests for provider isolation, exact view digest, and legacy limits**

```python
class ProviderStoreTests(unittest.TestCase):
    def test_public_view_binds_provider_and_digest(self):
        entry = self.store.park("approval", approval_event(), 60)
        public = self.store.pending_public()
        self.assertEqual(public["provider"], "claude")
        expected = interactions.view_digest(public)
        self.assertEqual(public["view_sha256"], expected)

    def test_v1_signature_cannot_resolve_codex(self):
        entry = self.store.park_normalized(codex_permission_normalized(), 60)
        stamp = int(self.wall())
        old = sign_answer(SECRET, entry.request_id, "approve", stamp)
        ok, reason = self.store.resolve(entry.request_id, "approve", stamp,
                                        old, provider=None,
                                        view_sha256=None)
        self.assertFalse(ok)
        self.assertEqual(reason, "v2 verdict required")

    def test_v2_signature_binds_provider_and_view(self):
        entry = self.store.park_normalized(codex_permission_normalized(), 60)
        stamp = int(self.wall())
        mac = sign_answer_v2(SECRET, "codex", entry.request_id,
                             entry.view_sha256, "approve", stamp)
        self.assertTrue(self.store.resolve(
            entry.request_id, "approve", stamp, mac,
            provider="codex", view_sha256=entry.view_sha256)[0])
```

Define `codex_permission_normalized()` in the test module as a call to
`normalize_codex_permission(codex_permission_event(), reveal=True)`. Keep the
existing `park(kind, event, hold_s)` signature as the Claude compatibility
entry point; add `park_normalized(normalized, hold_s)` for provider-neutral
adapters.

- [ ] **Step 2: Run the focused store tests and verify signature/API failures**

Run: `python3 -m unittest tools.tokenserver.test_interactions.ProviderStoreTests -v`

Expected: failures for missing provider-aware methods and fields.

- [ ] **Step 3: Refactor the store without changing Claude responses**

Change `_Pending` to carry `provider`, normalized `view`, optional
`recommended_index`, and `view_sha256`. Add:

```python
def view_bytes(view: dict) -> bytes:
    base = {k: v for k, v in view.items() if k != "view_sha256"}
    return json.dumps(base, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def view_digest(view: dict) -> str:
    return hashlib.sha256(view_bytes(view)).hexdigest()


def sign_answer_v2(secret: str, provider: str, request_id: str,
                   digest: str, verdict: str, ts: int) -> str:
    message = (f"v2|{provider}|{request_id}|{digest}|{verdict}|{int(ts)}"
               .encode("utf-8"))
    return hmac.new(secret.encode("utf-8"), message,
                    hashlib.sha256).hexdigest()
```

Make `await_result(entry)` return `InteractionResult` or `None`. Keep
`await_verdict()` as a Claude-only compatibility wrapper that converts the
internal result through the existing `hook_response()`. Accept v1 signatures
only when the live entry provider is `claude`; require exact provider and
digest for Codex. Mint the existing random 128-bit request ID as canonical
unpadded base64url (22 characters) so the later encrypted-relay protocol can
bind the same live ID without a second identifier; keep the firmware capacity
at 33 bytes for legacy 32-hex compatibility.

- [ ] **Step 4: Run store, body-capacity, and Claude regression tests**

Run:

```bash
python3 -m unittest tools.tokenserver.test_interactions \
  tools.tokenserver.test_codex_interactions -v
python3 test/test_agent_status_body_capacity.py
```

Expected: all pass; the worst-case `/api/agent-status` body remains below
4096 bytes and the optional pending view remains below 640 bytes.

- [ ] **Step 5: Commit the provider-aware core**

```bash
git add tools/tokenserver/interactions.py \
  tools/tokenserver/test_interactions.py \
  tools/tokenserver/test_codex_interactions.py \
  test/test_agent_status_body_capacity.py
git commit -m "feat: bind interactions to provider and view"
```

## Task 4: Independent saved feature switches and tokenserver routes

**Files:**
- Create: `tools/tokenserver/vibepulse_config.py`
- Create: `tools/tokenserver/test_vibepulse_config.py`
- Modify: `tools/tokenserver/tokenserver.py`
- Modify: `tools/tokenserver/test_codex_interactions.py`
- Modify: `tools/tokenserver/test_tokenserver.py`
- Modify: `test/run.sh`

- [ ] **Step 1: Write failing configuration and loopback-route tests**

```python
class SavedConfigTests(unittest.TestCase):
    def test_missing_file_is_fully_off(self):
        cfg = load_config(Path(self.tmp.name) / "missing.json")
        self.assertFalse(cfg.claude_interactions)
        self.assertFalse(cfg.codex_interactions)
        self.assertFalse(cfg.interaction_detail)

    def test_unknown_or_non_boolean_fields_fail_closed(self):
        path = Path(self.tmp.name) / "config.json"
        path.write_text('{"codex_interactions":"yes"}', encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(path)


class CodexRouteTests(HttpEndToEndTests):
    def test_codex_permission_is_loopback_only(self):
        status, _ = self.request("POST", "/api/codex/permission",
                                 codex_permission_event())
        self.assertEqual(status, 200)

    def test_codex_question_returns_structured_answer(self):
        result = {}

        def post_question():
            result["status"], result["raw"] = self.request(
                "POST", "/api/codex/question", codex_question_event())

        thread = threading.Thread(target=post_question, daemon=True)
        thread.start()
        shown = self.wait_for_pending()
        stamp = int(time.time())
        mac = sign_answer_v2(
            SECRET, "codex", shown["request_id"], shown["view_sha256"],
            "approve", stamp)
        status, raw = self.request(
            "POST", f"/api/interaction/{shown['request_id']}", {
                "provider": "codex",
                "view_sha256": shown["view_sha256"],
                "verdict": "approve", "ts": stamp, "hmac": mac,
            })
        self.assertEqual(status, 200, raw)
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["status"], 200)
        self.assertEqual(json.loads(result["raw"]), {
            "status": "answered", "option_index": 0,
            "answer": "Use the trusted hook",
        })
```

Import `HttpEndToEndTests`, `SECRET`, `sign_answer_v2`, `threading`, `time`,
and `json`; define `codex_question_event()` in the test module with the exact
two-option payload from Task 2. In `setUp`, enable only the Codex route on the
handler and restore the prior provider flags in `tearDown`.

- [ ] **Step 2: Run and verify missing config/routes**

Run: `python3 -m unittest tools.tokenserver.test_vibepulse_config tools.tokenserver.test_codex_interactions.CodexRouteTests -v`

Expected: missing module and 404 route failures.

- [ ] **Step 3: Implement strict saved config and provider routes**

Use this immutable config shape:

```python
@dataclass(frozen=True)
class VibePulseConfig:
    claude_interactions: bool = False
    codex_interactions: bool = False
    interaction_detail: bool = False
```

Store it as `config.json` inside `_state_dir()`, written atomically with mode
`0600` where supported. In `tokenserver.py`, add explicit
`--claude-interactions`, `--codex-interactions`, and existing
`--interactions` as a deprecated Claude-only alias. Create the store when
either provider is enabled. Gate these loopback-only routes independently:

```text
POST /api/hook/question       Claude only, legacy
POST /api/hook/permission     Claude only, legacy
POST /api/codex/question      Codex MCP only
POST /api/codex/permission    Codex hook only
```

`/api/codex/question` returns a structured Codex result; the permission route
returns documented hook JSON or an empty body. Add root diagnostics:

```json
"interactions": {
  "claude": false,
  "codex": true,
  "detail": true,
  "transport": "lan"
}
```

- [ ] **Step 4: Run config, HTTP, and full tokenserver tests**

Run:

```bash
python3 -m unittest tools.tokenserver.test_vibepulse_config \
  tools.tokenserver.test_codex_interactions \
  tools.tokenserver.test_interactions \
  tools.tokenserver.test_tokenserver -v
```

Expected: all pass; old `--interactions` tests show Claude enabled and Codex
disabled.

- [ ] **Step 5: Wire the new module into the repository suite and commit**

Add `tools.tokenserver.test_vibepulse_config` to the unittest list in
`test/run.sh`, then run `./test/run.sh` through the Python section.

```bash
git add tools/tokenserver/vibepulse_config.py \
  tools/tokenserver/test_vibepulse_config.py \
  tools/tokenserver/tokenserver.py \
  tools/tokenserver/test_codex_interactions.py \
  tools/tokenserver/test_tokenserver.py test/run.sh
git commit -m "feat: add independent interaction switches"
```

## Task 5: Codex permission hook and question MCP protocol

**Files:**
- Create: `.agents/plugins/plugins/vibepulse/scripts/loopback.py`
- Create: `.agents/plugins/plugins/vibepulse/scripts/permission_hook.py`
- Create: `.agents/plugins/plugins/vibepulse/scripts/session_start.py`
- Create: `.agents/plugins/plugins/vibepulse/scripts/mcp_server.py`
- Modify: `test/test_vibepulse_codex_plugin.py`

- [ ] **Step 1: Write failing subprocess tests for every fail-safe path**

Test all four scripts with a temporary HTTP server and piped stdin/stdout:

```python
def test_permission_hook_prints_allow_body_verbatim(self):
    completed = self.run_script("permission_hook.py", CODEX_PERMISSION_JSON,
                                response=(200, ALLOW_JSON))
    self.assertEqual(json.loads(completed.stdout), json.loads(ALLOW_JSON))

def test_permission_hook_connection_refused_is_empty_success(self):
    completed = self.run_script("permission_hook.py", CODEX_PERMISSION_JSON,
                                port=self.closed_port)
    self.assertEqual(completed.returncode, 0)
    self.assertEqual(completed.stdout, "")

def test_session_start_context_is_bounded_and_requires_fallback(self):
    completed = self.run_script("session_start.py", SESSION_START_JSON)
    body = json.loads(completed.stdout)
    text = body["hookSpecificOutput"]["additionalContext"]
    self.assertLessEqual(len(text), 1400)
    self.assertIn("mcp__vibepulse__ask", text)
    self.assertIn("request_user_input", text)
    self.assertIn("never treat silence", text.lower())
```

Drive `mcp_server.py` with newline-delimited JSON-RPC for `initialize`,
`notifications/initialized`, `tools/list`, and `tools/call`. Assert one tool
named `ask`, the exact bounded schema, a structured answered result, and a
computer-fallback result on timeout.

- [ ] **Step 2: Run and verify the scripts are missing**

Run: `python3 test/test_vibepulse_codex_plugin.py -v`

Expected: failures naming the four missing scripts.

- [ ] **Step 3: Implement the loopback helper and permission hook**

`loopback.py` must reject non-loopback URLs, cap request and response bodies at
4096 bytes, use `urllib.request`, set `Content-Type: application/json`, use a
0.75 s connect timeout and the server's 125 s held-read timeout, and return
`None` for connection/timeout/invalid-JSON failures.

`permission_hook.py` reads at most 64 KiB from stdin, validates a JSON object,
POSTs to `http://127.0.0.1:${VIBEPULSE_PORT:-8737}/api/codex/permission`, and
prints compact JSON only for a valid decision object. Every other path exits
zero with no stdout.

- [ ] **Step 4: Implement SessionStart context and the stdio MCP server**

The MCP server implements these methods and no others:

```python
METHODS = {"initialize", "notifications/initialized",
           "ping", "tools/list", "tools/call"}
TOOL_NAME = "ask"
```

Its `tools/list` schema requires `question` and `options`, caps options with
`minItems: 2`, `maxItems: 3`, and exposes `recommended` as a boolean. A call
POSTs the arguments plus `cwd`, `session_id`, and `turn_id` when supplied by
the client environment to `/api/codex/question`. Return both a text content
item containing compact JSON and the same `structuredContent`. Unknown
methods return JSON-RPC `-32601`; malformed requests return `-32600`; tool
validation failures return `isError: true` without calling the tokenserver.

- [ ] **Step 5: Run the complete plugin-script transcript suite**

Run: `python3 test/test_vibepulse_codex_plugin.py -v`

Expected: all hook, protocol, fallback, body-cap, and no-secret-output tests
pass.

- [ ] **Step 6: Commit the tested local adapters**

```bash
git add .agents/plugins/plugins/vibepulse/scripts \
  test/test_vibepulse_codex_plugin.py
git commit -m "feat: bridge Codex hooks and questions"
```

## Task 6: Package, marketplace, setup, doctor, and uninstall

**Files:**
- Create: `.agents/plugins/marketplace.json`
- Create: `.agents/plugins/plugins/vibepulse/.codex-plugin/plugin.json`
- Create: `.agents/plugins/plugins/vibepulse/hooks/hooks.json`
- Create: `.agents/plugins/plugins/vibepulse/skills/vibepulse/SKILL.md`
- Create: `tools/vibepulse_setup.py`
- Modify: `test/test_vibepulse_codex_plugin.py`

- [ ] **Step 1: Write failing package and command-planning tests**

Assert the marketplace entry has `AVAILABLE`, `ON_INSTALL`, category
`Developer Tools`, and source `./plugins/vibepulse`. Assert the manifest is
strict semver, names `vibepulse`, contains real author/license/interface data,
and omits unsupported `hooks` and absent `apps` fields. Assert default hook
discovery finds `hooks/hooks.json`.

Test setup command planning without changing the real Codex home:

```python
commands = plan_codex_install(
    repo_root=Path("/repo"), python=Path("/python"),
    codex=Path("/codex"), marketplace_name="torget")
self.assertEqual(commands, [
    ["/codex", "plugin", "marketplace", "add", "/repo/.agents/plugins"],
    ["/codex", "plugin", "add", "vibepulse@torget"],
    ["/codex", "mcp", "remove", "vibepulse"],
    ["/codex", "mcp", "add", "vibepulse", "--", "/python",
     "/repo/.agents/plugins/plugins/vibepulse/scripts/mcp_server.py"],
])
```

The remove command is allowed to report “not configured”; setup treats that
single case as idempotent and rejects every other command failure.

- [ ] **Step 2: Run tests and verify missing package/setup failures**

Run: `python3 test/test_vibepulse_codex_plugin.py -v`

Expected: manifest, marketplace, hooks, skill, and setup imports fail.

- [ ] **Step 3: Add the exact package metadata and hooks**

Use a `0.1.0` manifest with MIT license, repository URL for Torget, Codex blue
`#6F78FF`, `Interactive` capability, and no app/MCP manifest fields. Use
default `hooks/hooks.json` discovery with:

```json
{
  "description": "Optional VibePulse Codex interactions",
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "python3 \"$PLUGIN_ROOT/scripts/session_start.py\"",
        "commandWindows": "py -3 \"${PLUGIN_ROOT}\\scripts\\session_start.py\"",
        "timeout": 3,
        "additionalContextLimit": 1800
      }]
    }],
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "python3 \"$PLUGIN_ROOT/scripts/permission_hook.py\"",
        "commandWindows": "py -3 \"${PLUGIN_ROOT}\\scripts\\permission_hook.py\"",
        "timeout": 125,
        "statusMessage": "Waiting for VibePulse or this computer"
      }]
    }]
  }
}
```

The skill describes opt-in behavior and routes free-form/secrets to native
computer questions. It must not claim the relay is enabled by the plugin.

- [ ] **Step 4: Implement the setup state machine**

`tools/vibepulse_setup.py` uses subcommands `install`, `status`, `doctor`,
`disable`, and `uninstall`. `install` shows four explicit provider choices,
writes `VibePulseConfig` atomically, runs the exact Codex CLI commands from
the test, and ends with the `/hooks` review instruction. `disable codex`
sets only `codex_interactions=false`. `uninstall codex` runs:

```text
codex mcp remove vibepulse
codex plugin remove vibepulse@torget
codex plugin marketplace remove torget
```

It does not delete the device key, Claude setting, relay setting, GitHub
setting, repo, or any unrelated Codex config. `doctor` checks executable
discovery, plugin listing, MCP listing, loopback tokenserver diagnostics, and
prints `PASS`, `FIX`, or `OFF` per item without printing secrets.

- [ ] **Step 5: Validate the plugin and run isolated setup tests**

Run:

```bash
python3 /Users/niclasvestlund/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  .agents/plugins/plugins/vibepulse
python3 test/test_vibepulse_codex_plugin.py -v
```

Expected: validator passes; temp-home tests prove install is idempotent and
uninstall preserves unrelated config.

- [ ] **Step 6: Commit the opt-in package**

```bash
git add .agents/plugins/marketplace.json \
  .agents/plugins/plugins/vibepulse \
  tools/vibepulse_setup.py test/test_vibepulse_codex_plugin.py
git commit -m "feat: package optional VibePulse Codex support"
```

## Task 7: Firmware provider and direct-verdict v2 contract

**Files:**
- Modify: `components/app_tokens/agent_status.h`
- Modify: `components/app_tokens/agent_status_parse.c`
- Modify: `components/app_tokens/needs_you_send_policy.h`
- Modify: `components/app_tokens/needs_you_send_policy.c`
- Modify: `components/app_tokens/needs_you_net.c`
- Modify: `test/test_agent_status.c`
- Modify: `test/test_needs_you_send_policy.c`
- Modify: `test/run.sh`
- Create: `sim-fixtures/agent-status-needs-you-codex-question.json`
- Create: `sim-fixtures/agent-status-needs-you-codex-approval.json`

- [ ] **Step 1: Add failing parser and canonical-byte tests**

Add a Codex fixture containing:

```json
"pending": {
  "provider": "codex",
  "request_id": "ABEiM0RVZneImaq7zN3u_w",
  "view_sha256": "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a",
  "kind": "question",
  "project": "Torget",
  "expires_in_ms": 118000,
  "hold_ms": 120000,
  "options_total": 2,
  "marked": true,
  "prompt": "How should Codex handle approvals?",
  "title": "Use the trusted hook",
  "subtitle": "Desktop + CLI, one setup",
  "can_approve": true
}
```

Assert the parser returns `TK_AGENT_PROVIDER_CODEX` and exact digest. Add
soft-failure cases for unknown provider, malformed digest, and a Codex item
without provider. Assert a missing provider still parses as legacy Claude.

Pin canonical v2 bytes:

```c
check("v2 canonical bytes",
      tk_needs_you_canonical_message_v2(
          message, sizeof message, "codex", REQUEST_ID, DIGEST,
          "approve", 1787097720ULL) > 0 &&
      strcmp(message,
          "v2|codex|ABEiM0RVZneImaq7zN3u_w|"
          "9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a|"
          "approve|1787097720") == 0);
```

- [ ] **Step 2: Run C tests and verify missing fields/functions**

Run: `./test/run.sh`

Expected: compile failures naming provider/digest and v2 functions.

- [ ] **Step 3: Extend the soft parser and send policy**

Add `tk_agent_provider provider`, `char view_sha256[65]`, and
`bool has_view_sha256` to `tk_pending_interaction`. For a present provider,
accept only `claude`/`codex`; require provider and 64 lowercase hex digest for
Codex. For missing provider, set Claude and leave digest absent.

Add v2 canonical/body functions whose JSON is exactly:

```json
{"provider":"codex","view_sha256":"9f4f6ec7a3519df610be969b66100fc0fefbe53a54cc59a82fb49dc70ba6e22a","verdict":"approve","ts":1787097720,"hmac":"eeaae64073b070863e3833a1483e24bd41e2da5aa1849ef8663798c32401c6a8"}
```

Update `needs_you_net.c` to copy provider/digest into the queue item before
the UI drops the pending snapshot, sign v2, and POST to the unchanged direct
LAN route. Panic remains its existing deny-only signature.

- [ ] **Step 4: Run parser/send tests and Python cross-vector**

Run:

```bash
./test/run.sh
python3 -m unittest tools.tokenserver.test_interactions.ProviderStoreTests -v
```

Expected: C/Python v2 HMAC hex matches exactly; legacy Claude tests remain
green.

- [ ] **Step 5: Commit the wire contract**

```bash
git add components/app_tokens/agent_status.h \
  components/app_tokens/agent_status_parse.c \
  components/app_tokens/needs_you_send_policy.h \
  components/app_tokens/needs_you_send_policy.c \
  components/app_tokens/needs_you_net.c \
  test/test_agent_status.c test/test_needs_you_send_policy.c test/run.sh \
  sim-fixtures/agent-status-needs-you-codex-question.json \
  sim-fixtures/agent-status-needs-you-codex-approval.json
git commit -m "feat: bind panel verdicts to interaction provider"
```

## Task 8: Native 64 px Codex asset

**Files:**
- Modify: `tools/agent_assets/build-agent-images.py`
- Modify: `tools/agent_assets/test_build_agent_images.py`
- Regenerate: `components/app_tokens/agent_assets.h`
- Regenerate: `components/app_tokens/agent_assets.c`

- [ ] **Step 1: Add the failing native-asset test**

```python
def test_codex_needs_you_asset_is_native_transparent_64(self):
    data = build.build_codex(64)
    palette, indices = decode_i4(data, 64)
    self.assertEqual(len(data), 16 * 4 + 64 * 64 // 2)
    self.assertEqual(palette[0], (0, 0, 0, 0))
    self.assertEqual(sum(color == (255, 255, 255, 255)
                         for color in palette), 1)
    self.assertTrue(all(indices[i] == 0 for i in (0, 63, 4032, 4095)))
    header, source = build.render_generated_sources()
    self.assertIn("tk_img_codex_64", header)
    self.assertIn(".w = 64", source)
    self.assertIn(".stride = 32", source)
```

- [ ] **Step 2: Run and verify the descriptor is missing**

Run: `python3 -m unittest tools.agent_assets.test_build_agent_images.AgentAssetTests.test_codex_needs_you_asset_is_native_transparent_64 -v`

Expected: failure because `tk_img_codex_64` is absent.

- [ ] **Step 3: Generate and declare the 64 px asset**

In `render_generated_sources()`, call `build_codex(64)`, emit
`tk_img_codex_64_data`, declare `tk_img_codex_64`, and use
`LV_COLOR_FORMAT_I4`, stride `32`, canvas `64`. Do not recolor or scale it in
LVGL.

- [ ] **Step 4: Regenerate and run asset tests**

Run:

```bash
python3 tools/agent_assets/build-agent-images.py
python3 -m unittest tools.agent_assets.test_build_agent_images -v
```

Expected: all generated-source and transparency tests pass.

- [ ] **Step 5: Commit generated and generator sources together**

```bash
git add tools/agent_assets/build-agent-images.py \
  tools/agent_assets/test_build_agent_images.py \
  components/app_tokens/agent_assets.h components/app_tokens/agent_assets.c
git commit -m "feat: add native Codex Needs You asset"
```

## Task 9: Providerize the one LVGL tree and add bounded Wi-Fi state

**Files:**
- Modify: `platform/torget.h`
- Modify: `main/main.c`
- Modify: `sim/main.c`
- Modify: `components/app_tokens/agent_monitor.c`
- Modify: `components/app_tokens/agent_monitor.h`
- Modify: `test/test_vibepulse_visual_landmarks.py`
- Modify: `test/test_lvgl_layer_safety.py`

- [ ] **Step 1: Add failing source-structure and raster expectations**

Extend the LVGL safety test to require exactly one `needs_you_view` and reject
a second Codex root. Require `tk_img_codex_64`, `CODEX RECOMMENDS`,
question `APPROVE`, permission `ALLOW ONCE`, eyebrow `(148, 46, 260)`,
`LV_LABEL_LONG_DOT`, and Wi-Fi origin
`(418, 38)`. Add raster expectations for Codex blue `(111, 120, 255)`, no
white pixels in the icon's transparent corners, and no colored/text pixels in
the 10 px gap between eyebrow lane and Wi-Fi slot.

- [ ] **Step 2: Run safety/raster tests and verify Codex captures are missing**

Run:

```bash
python3 test/test_lvgl_layer_safety.py
python3 test/test_vibepulse_visual_landmarks.py
```

Expected: missing providerized objects/captures.

- [ ] **Step 3: Add lock-free Wi-Fi state sampling**

Declare in `platform/torget.h`:

```c
/* 0 disconnected, 1 weak, 2 medium, 3 strong. Never implies relay health. */
uint8_t torget_wifi_signal_bars(void);
```

In target `main/main.c`, keep an `atomic_uchar` initialized to zero. Clear it
on `WIFI_EVENT_STA_DISCONNECTED`, set at least one bar on `IP_EVENT_STA_GOT_IP`,
and update it from a low-priority 5-second task using
`esp_wifi_sta_get_ap_info()`: `rssi >= -55` → 3, `>= -70` → 2, otherwise 1.
That task never touches LVGL. In simulator `main.c`, provide the same function
over a static fixture value.

- [ ] **Step 4: Parameterize the existing Needs You object tree**

Add provider icon objects to the existing header/attract/private/payoff
groups, not a second screen. Store the approve button label so render can set
`APPROVE` for a question and `ALLOW ONCE` for a Codex permission request
(Claude permission keeps its existing text). Add three small Wi-Fi arcs
and one dot inside a single `28 × 28` group at `(418, 38)`; show 1/2/3 arcs
from `torget_wifi_signal_bars()`, and use muted disconnected styling for zero.

At render, derive:

```c
bool codex = p->provider == TK_AGENT_PROVIDER_CODEX;
lv_color_t accent = codex ? COL_CODEX : COL_CLAUDE;
const char *provider = codex ? "CODEX" : "CLAUDE";
```

Apply `accent` to frame, countdown indicators, recommendation label, filled
button, project text, and payoff sparks. Use the transparent native 64 px
Codex image at `(48, 48)` for the decision header. Keep question/card/button
vertical anchors unchanged. Set eyebrow width to 260 and long mode to dot on
both providers so no project can overlap Wi-Fi.

- [ ] **Step 5: Add deterministic Codex simulator captures**

Extend `capture_needs_you_v2()` to feed Codex question and approval fixtures,
set simulator Wi-Fi to strong, then dump:

```text
torget-vibepulse-needs-you-codex-question.bmp
torget-vibepulse-needs-you-codex-question-long.bmp
torget-vibepulse-needs-you-codex-approval.bmp
torget-vibepulse-needs-you-codex-private.bmp
torget-vibepulse-needs-you-codex-wifi-weak.bmp
torget-vibepulse-needs-you-codex-wifi-off.bmp
```

Use the same tap/press helpers as Claude. Never add the throwaway
`--utf8-test` or `--wedge-repro` probes to a commit.

- [ ] **Step 6: Build simulator and run exact visual gates**

Run:

```bash
cmake -S sim -B sim/build -G Ninja
ninja -C sim/build
./sim/build/torget-sim --vibepulse-needs-you-qa
python3 test/test_vibepulse_visual_landmarks.py
python3 test/test_lvgl_layer_safety.py
```

Expected: Codex captures match the approved coordinates; Claude baselines are
unchanged except the intentionally reserved top-right eyebrow width and shared
Wi-Fi icon.

- [ ] **Step 7: Commit the providerized screen**

```bash
git add platform/torget.h main/main.c \
  components/app_tokens/agent_monitor.c \
  components/app_tokens/agent_monitor.h \
  test/test_vibepulse_visual_landmarks.py test/test_lvgl_layer_safety.py \
  sim-fixtures/agent-status-needs-you-codex-question.json \
  sim-fixtures/agent-status-needs-you-codex-approval.json
git add sim/main.c
if git diff --cached -- sim/main.c | rg --quiet -- \
  '--utf8-test|--wedge-repro'; then exit 1; fi
git commit -m "feat: render Codex Needs You on the shared screen"
```

## Task 10: Documentation, setup UX, and full local verification

**Files:**
- Modify: `README.md`
- Modify: `docs/agent-setup.md`
- Modify: `docs/needs-you-investigation.md`
- Modify: `tools/tokenserver/README.md`
- Modify: `tools/tokenserver/se.torget.tokenserver.plist`
- Modify: `tools/tokenserver/install-windows-task.ps1`
- Modify: `test/test_relay_boundary.py`
- Modify: `test/run.sh`

- [ ] **Step 1: Add failing documentation/default-off assertions**

Extend `test/test_relay_boundary.py` and plugin tests to require:

- `--publish` remains numbers-only;
- installing the plugin does not enable Codex interactions;
- `--interactions` remains Claude-only;
- the README lists Claude, Codex, numbers relay, interaction relay, and GitHub
  as independent switches; and
- uninstall instructions preserve other providers and settings.

- [ ] **Step 2: Run the focused boundary tests and verify docs are stale**

Run:

```bash
python3 test/test_relay_boundary.py
python3 test/test_vibepulse_codex_plugin.py -v
```

Expected: failures naming missing independent-switch and setup text.

- [ ] **Step 3: Update user-facing documentation and service launchers**

Document the plain-English outcome, computer-on requirement, LAN limitation,
future encrypted-relay option, exact hook trust step, `install/status/doctor/
disable/uninstall`, safe approval tier, and computer fallback. Update macOS
and Windows launchers to start tokenserver with its saved config rather than
embedding provider choices in a command line. Do not place device keys,
mailbox tokens, or real URLs in tracked files.

- [ ] **Step 4: Run the complete host, Python, simulator, and ESP-IDF gates**

Run:

```bash
./test/run.sh
cmake -S sim -B sim/build -G Ninja
ninja -C sim/build
./sim/build/torget-sim --vibepulse-needs-you-qa
python3 test/test_vibepulse_visual_landmarks.py
. "$IDF_PATH/export.sh"
idf.py build
```

Expected: all tests pass; target build reports the guarded 256 KiB LVGL pool;
no generated `sdkconfig`, secret, `.wrangler`, BMP, or throwaway simulator
probe is staged.

- [ ] **Step 5: Review the complete diff for regressions and scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- tools/relay/worker.js tools/tokenserver/publisher.py sim/main.c
```

Expected: numbers Worker/publisher have no activity route; `sim/main.c` has
only committed Codex QA states and no `--utf8-test`/`--wedge-repro` additions;
all pre-existing unrelated worktree files remain unstaged.

- [ ] **Step 6: Commit local integration documentation**

```bash
git add README.md docs/agent-setup.md docs/needs-you-investigation.md \
  tools/tokenserver/README.md tools/tokenserver/se.torget.tokenserver.plist \
  tools/tokenserver/install-windows-task.ps1 test/test_relay_boundary.py \
  test/run.sh
git commit -m "docs: explain optional Codex panel interactions"
```

## Task 11: Live compatibility and panel acceptance

**Files:**
- Create after observation: `docs/superpowers/reviews/2026-08-19-vibepulse-codex-local-acceptance.md`

- [ ] **Step 1: Verify the package against the installed Codex version in a new task**

Run the setup against an isolated temporary Codex home first, validate the
plugin, install it in the real user profile only with the user's approval,
review/trust it through `/hooks`, and start a new Codex task so tools/hooks are
freshly loaded.

Expected: `codex plugin list` shows VibePulse, `codex mcp list` shows the
stdio server, and doctor reports hook review state without bypassing trust.

- [ ] **Step 2: Verify one real permission and one real recommendation**

Trigger a harmless approval (`python3 -c 'print(1)'` under an approval policy
that asks) and a short question through `mcp__vibepulse__ask`. Use the fake
panel first. Confirm allow/deny/leave and recommendation return exactly once;
timeout returns to the computer.

- [ ] **Step 3: Obtain explicit permission before flashing `ota_1`**

Confirm the USB port and running partition. Write only the new application to
`ota_1`; do not erase flash, repartition, write `ota_0`, or switch `ota_0`.

- [ ] **Step 4: Perform physical visual and stability checks**

On the panel verify Claude/Codex question and approval, long project ellipsis,
transparent Codex logo, strong/medium/weak/disconnected Wi-Fi icon, rotation,
data arrival, and OTA takeover. Run repeated interactions long enough to cover
the old ~45-second wedge window and confirm no LVGL allocation assert, lock
flood, task watchdog, DMA warning, or frozen display.

- [ ] **Step 5: Record observed evidence without overclaiming**

Write the review file with firmware commit, Codex version, panel/port,
partition, test matrix, simulator commands, hardware observations, and any
remaining caveats. Mark only what was actually observed.

- [ ] **Step 6: Commit the acceptance record**

```bash
git add docs/superpowers/reviews/2026-08-19-vibepulse-codex-local-acceptance.md
git commit -m "docs: record Codex panel acceptance"
```

## Final local acceptance checklist

- [ ] A fresh clone and existing user update keep Codex interactions off.
- [ ] Claude-only, Codex-only, both, and neither behave independently.
- [ ] Codex permission output matches the documented `PermissionRequest`
      schema and grants only once.
- [ ] Recommended questions come from one explicit Codex option; VibePulse
      never guesses.
- [ ] Free-form, secret, long, unmarked, malformed, and multi-question cases
      stay on the computer.
- [ ] Provider, request, verdict, timestamp, and exact view digest are signed;
      legacy v1 cannot resolve Codex.
- [ ] The approved Codex UI matches Claude's anchors, has no white logo tile,
      and never overlaps the top-right Wi-Fi signal.
- [ ] Only one LVGL Needs You tree exists and the 256 KiB pool guard remains.
- [ ] The existing numbers relay and publisher remain activity-free.
- [ ] `ota_0` remains byte-for-byte untouched.
