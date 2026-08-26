#!/usr/bin/env python3
"""Target/simulator wiring and lifecycle guard for agent status polling."""

from pathlib import Path
import re


root = Path(__file__).resolve().parent.parent
agent_net_path = root / "components/app_tokens/agent_net.c"
assert agent_net_path.exists(), "agent_net.c must exist in the target component"

source = agent_net_path.read_text(encoding="utf-8")
app = (root / "components/app_tokens/app.c").read_text(encoding="utf-8")
target_cmake = (root / "components/app_tokens/CMakeLists.txt").read_text(
    encoding="utf-8"
)
sim_cmake = (root / "sim/CMakeLists.txt").read_text(encoding="utf-8")
needs_you_net = (root / "components/app_tokens/needs_you_net.c").read_text(
    encoding="utf-8"
)
agent_monitor = (root / "components/app_tokens/agent_monitor.c").read_text(
    encoding="utf-8"
)
agent_monitor_header = (
    root / "components/app_tokens/agent_monitor.h"
).read_text(encoding="utf-8")
usage_screen = (
    root / "components/app_tokens/usage_screen.c"
).read_text(encoding="utf-8")
kconfig = (root / "main/Kconfig.projbuild").read_text(encoding="utf-8")
source_policy = root / "components/app_tokens/agent_status_source_policy.c"

assert '"agent_net.c"' in target_cmake, "target must compile agent_net.c"
assert source_policy.exists(), "agent-status source policy must be portable C"
assert 'config TK_VIBEPULSE_AGENT_STATUS_RELAY' in kconfig
assert re.search(
    r'config TK_VIBEPULSE_AGENT_STATUS_RELAY.*?default n',
    kconfig, re.DOTALL), "live status relay must remain default off"
assert re.search(
    r'if\(CONFIG_TK_VIBEPULSE_INTERACTION_RELAY OR '
    r'CONFIG_TK_VIBEPULSE_AGENT_STATUS_RELAY\)', target_cmake), (
    "relay crypto/net sources must compile when either feature is selected"
)
assert "../components/app_tokens/agent_net.c" not in sim_cmake, (
    "simulator must never compile agent_net.c"
)
assert re.search(
    r"PRIV_REQUIRES[^)]*\btorget_net\b[^)]*\besp_http_client\b",
    target_cmake,
    re.DOTALL,
), "target component must privately require torget_net and esp_http_client"

assert app.count("tokens_agent_net_start();") == 1, (
    "tk_create must start the agent network task exactly once"
)
assert re.search(
    r"tokens_net_start\(\);\s*tokens_agent_net_start\(\);", app
), "agent task start must sit next to the existing VibePulse task start"

required_config = (
    ".url = TK_AGENT_STATUS_URL",
    ".timeout_ms = 2500",
    ".event_handler = status_http_event",
    ".user_data = &response",
)
for line in required_config:
    assert line in source, f"missing required client config: {line}"
# The bounded fetch closes the socket after every poll, so TCP keep-alive
# fields would be inert configuration that reads like a policy. Keep the
# client reused, keep the socket per-poll, keep the config honest.
assert ".keep_alive" not in source, (
    "keep_alive_* is dead configuration while fetch_bounded closes per poll"
)

assert source.count("esp_http_client_init(") == 1, (
    "agent polling must create exactly one HTTP client"
)
assert "esp_http_client_perform(" not in source, (
    "bounded polling must not rely on the unabortable perform callback path"
)
for operation in (
    "esp_http_client_open(",
    "esp_http_client_fetch_headers(",
    "esp_http_client_read(",
    "esp_http_client_close(",
):
    assert operation in source, f"bounded adapter must use {operation}"
assert "esp_http_client_cleanup(" not in source, (
    "the long-lived polling task must not destroy its client per poll"
)
assert re.search(
    r"tk_agent_source_note_lan\([^;]+;\s*"
    r"usage_screen_apply_agent\(snapshot, now_us\);", app, re.DOTALL
), "a valid direct LAN snapshot must establish precedence before applying"

relay_net = (
    root / "components/app_tokens/interaction_relay_net.c"
).read_text(encoding="utf-8")
for required in (
    "tk_ir_decode_status(",
    "tk_agent_status_parse_relay(",
    "tokens_apply_agent_status_relay(",
    "tokens_clear_agent_status_relay(",
):
    assert required in relay_net, f"missing encrypted status path: {required}"
assert "#include \"lvgl.h\"" not in relay_net
assert "lv_" not in relay_net, "network task must not call LVGL"
status_monitor = agent_monitor[
    agent_monitor.index("void tk_agent_monitor_apply_status_relay"):
    agent_monitor.index("void tk_agent_monitor_apply_relay")
]
for assignment in (
        "mon.snapshot.seq = snapshot->seq;",
        "mon.snapshot.claude = snapshot->claude;",
        "mon.snapshot.codex = snapshot->codex;"):
    assert assignment in status_monitor
assert "mon.snapshot.pending =" not in status_monitor
assert "mon.snapshot = *snapshot" not in status_monitor
status_screen = usage_screen[
    usage_screen.index("void usage_screen_apply_agent_status_relay"):
    usage_screen.index("void usage_screen_tick")
]
assert "ui.agent_snapshot.pending =" not in status_screen
assert "ui.agent_snapshot = *snapshot" not in status_screen
assert re.search(r"static\s+tk_agent_http_response\s+response\s*;", source), (
    "the 1536-byte response state must live in static .bss"
)
assert re.search(
    r'#define\s+AGENT_TASK_STACK_BYTES\s+\(10\s*\*\s*1024\)', source
), (
    "agent-status needs 10 KiB: strict v2 pending-view canonicalization "
    "overflowed the original 6 KiB stack on the panel"
)
assert re.search(
    r'xTaskCreate\(agent_net_task,\s*"agent-status",\s*'
    r'AGENT_TASK_STACK_BYTES,\s*NULL,\s*5,\s*NULL\)',
    source,
    re.DOTALL,
), "agent-status must use the guarded v2 interaction stack budget"
assert re.search(
    r"torget_ui_lock\(\);\s*tokens_apply_agent_status\(&snapshot\);\s*"
    r"torget_ui_unlock\(\);",
    source,
), "a valid snapshot must be applied under the UI lock"

# The callback gets one copied source-aware decision while the exact item is
# still visible. The UI callback only copies it into the bounded sender queue;
# direct/relay routing happens on that worker.
assert "const tk_ir_decision_context *context" in agent_monitor_header
assert "mon.tk_needs_you_cb(verdict, &context);" in agent_monitor
for binding_copy in (
    "item.context = *context;",
    "tk_ir_delivery_initial(&item.context)",
    "tk_ir_delivery_after_direct(",
    "tk_interaction_relay_queue_verdict(item.verdict, &item.context)",
):
    assert binding_copy in needs_you_net, f"missing queued binding: {binding_copy}"
assert "tk_needs_you_canonical_message_v2(" in needs_you_net
assert "tk_needs_you_answer_body_v2(" in needs_you_net
assert re.search(
    r"context->provider\s*==\s*TK_AGENT_PROVIDER_CODEX\s*&&\s*"
    r"!context->has_view_sha256",
    needs_you_net,
), "Codex must be dropped, never downgraded, when its view binding is absent"

# The callback's word is the honesty gate: bool, true only when queued.
assert "static bool needs_you_send_cb" in needs_you_net
assert "return enqueue(&item);" in needs_you_net
ui_callback = needs_you_net[
    needs_you_net.index("static bool needs_you_send_cb"):
    needs_you_net.index("void tk_needs_you_send_panic")
]
for forbidden in ("esp_http", "mbedtls", "tk_ir_encode", "torget_cloud_io"):
    assert forbidden not in ui_callback, (
        f"the LVGL callback must only copy to a queue, found {forbidden}"
    )

print("OK: agentnätets targetkoppling och klientlivscykel är inkopplade")
