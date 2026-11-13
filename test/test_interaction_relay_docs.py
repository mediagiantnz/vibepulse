#!/usr/bin/env python3
"""Open-source setup and privacy documentation contract."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


readme = read("README.md")
relay = read("docs/relay.md")
interaction = read("docs/interaction-relay.md")
worker = read("tools/interaction-relay/README.md")
tokenserver = read("tools/tokenserver/README.md")
setup = read("docs/agent-setup.md")
secrets_example = read("secrets.h.example")
runner = read("test/run.sh")
all_guides = "\n".join((readme, interaction, worker, tokenserver, setup))
interaction_words = " ".join(interaction.split()).lower()

for switch in (
    "Claude interactions", "Codex interactions", "Numbers relay",
    "Interaction relay", "GitHub",
):
    assert switch in readme, f"missing independent switch {switch}"
assert readme.count("| Off |") >= 5
assert "Installing the Codex plugin does not enable Codex interactions" in readme
assert "does not enable the encrypted interaction relay" in all_guides

for fact in (
    "computer must be awake", "tokenserver must be running",
    "ordinary internet Wi-Fi", "no router reconfiguration",
    "no inbound port", "no public Mac", "no VPN", "same LAN",
    "captive portal", "offline", "blocked Worker domains",
):
    assert fact.lower() in interaction_words, f"missing network fact: {fact}"

for line in (
    "Claude/Codex ↔ tokenserver → encrypt → user's Worker → decrypt → panel",
    "Claude/Codex ← tokenserver ← verify  ← user's Worker ← encrypt ← tap",
):
    assert line in interaction

for visible in (
    "IP address", "timing", "mailbox identifier", "request ID",
    "message direction", "fixed padded size",
):
    assert visible.lower() in interaction_words, (
        f"Cloudflare-visible metadata omitted: {visible}"
    )
for private in (
    "question text", "command text", "project name", "verdict",
):
    assert private.lower() in interaction_words
assert "Cloudflare never receives those fields in plaintext" in interaction

for value in (
    "provider", "request_id", "kind", "can_approve", "hold_ms", "project",
    "prompt", "marked", "options_total", "tool", "title", "subtitle",
    "2,048-byte request", "1,024-byte verdict", "120 seconds",
):
    assert value in interaction, f"missing exact bounded-content fact: {value}"

for command in (
    "python3 tools/vibepulse_setup.py install",
    "python3 tools/vibepulse_setup.py relay install",
    "python3 tools/vibepulse_setup.py relay status",
    "python3 tools/vibepulse_setup.py relay doctor",
    "python3 tools/vibepulse_setup.py relay disable",
    "python3 tools/vibepulse_setup.py relay uninstall --keep-worker",
    "python3 tools/vibepulse_setup.py relay uninstall --delete-worker",
):
    assert command in all_guides, f"missing lifecycle command: {command}"
for topic in (
    "Rotate", "Revoke", "Update", "Cloudflare pricing",
    "Cloudflare Workers limits", "self-host",
):
    assert topic.lower() in interaction.lower(), f"missing topic: {topic}"

assert "numbers transport never carries activity" in relay
assert "docs/interaction-relay.md" in relay
assert "--publish" in tokenserver and "numbers-only" in tokenserver
assert "--interaction-relay" in tokenserver and "E2E ciphertext" in tokenserver
assert "tools/vibepulse_setup.py relay install" in secrets_example
assert "tools/vibepulse_setup.py relay setup" not in secrets_example
assert "separata krypterade interaktionsreläet" in secrets_example

for test_name in (
    "test_interaction_relay_boundary.py", "test_interaction_relay_docs.py",
):
    assert test_name in runner
assert "tools/interaction-relay" in runner
assert "npm ci" in runner and "npm test" in runner and "npm run typecheck" in runner
# GitHub Actions does not run for this fork: test/run.sh is the only gate,
# so it must check the relay dependency, run the Codex plugin suite and
# consume the shared tokenserver module list.
assert "requirements-interaction-relay.txt" in runner
assert "test_vibepulse_codex_plugin.py" in runner
assert "test/tokenserver-suite.txt" in runner, (
    "the gate must consume the shared suite list"
)
suite = read("test/tokenserver-suite.txt")
for module in (
    "test_vibepulse_config", "test_codex_interactions",
    "test_interaction_relay", "test_interaction_relay_integration",
    "test_interaction_relay_crypto",
):
    assert f"tools.tokenserver.{module}" in suite, (
        f"the tokenserver suite is missing {module} from the host contract"
    )

print("OK: encrypted interaction relay setup and privacy are documented")
