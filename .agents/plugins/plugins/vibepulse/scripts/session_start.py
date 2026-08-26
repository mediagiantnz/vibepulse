#!/usr/bin/env python3
"""Provide the narrow, fail-safe VibePulse question guidance to Codex."""

from __future__ import annotations

import json
import sys

from loopback import strict_json_loads


MAX_INPUT_BYTES = 64 * 1024
CONTEXT = (
    "For short, non-secret, single-choice 2–3 option questions or "
    "recommendations, use mcp__vibepulse__ask. Mark at most one option "
    "recommended only when you genuinely recommend it. Use built-in "
    "request_user_input for free-form text, secrets, multiple questions, "
    "multi-select, or anything the tool cannot represent exactly. If the "
    "VibePulse tool is unavailable, times out, or reports computer fallback, "
    "use built-in request_user_input immediately. Never treat silence, panel "
    "absence, or fallback as approval. Permission decisions remain subject "
    "to Codex policy."
)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            return 0
        event = strict_json_loads(raw.decode("utf-8", errors="strict"))
        if not isinstance(event, dict):
            return 0
        result = {"hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": CONTEXT,
        }}
        if len(CONTEXT) > 1400:
            return 0
        # Bytes, not text: a piped stdout on Windows is cp1252, which would
        # turn the en dash in CONTEXT into 0x96 and hand Codex invalid UTF-8.
        sys.stdout.buffer.write((json.dumps(
            result, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8"))
        sys.stdout.buffer.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
