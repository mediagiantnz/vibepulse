"""Contract test: the ESP token body buffer holds a worst-case payload.

The VibePulse fetch task rejects the whole /api/tokens body when it
overflows BODY_MAX (components/app_tokens/net.c via torget_http_get's
all-or-nothing contract), so the buffer needs agreed headroom above the
largest payload the tokenserver can serialize — including the contract v2
stale booleans (claudeWeekStale, claudeModelWeekStale, codexWeekStale).

Standalone: not yet registered in test/run.sh; run with
    python3 test/test_token_body_capacity.py
(the stdlib `test` package shadows this directory for -m unittest).
"""

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
NET_C = REPO_ROOT / "components" / "app_tokens" / "net.c"

sys.path.insert(0, str(REPO_ROOT / "tools" / "tokenserver"))

import codex_usage  # noqa: E402
import tokenserver  # noqa: E402
from quota_cache import QuotaCache  # noqa: E402
from usage_history import UsageHistory  # noqa: E402

# esp_app_desc_t.version is char[32] including the terminator, so the
# longest version string the OTA announcement can ever carry is 31 chars.
OTA_VERSION_MAX_CHARS = 31

# Agreed margin: the serialized worst case may use at most 75 % of the
# buffer, leaving the rest for growth and the buffer's terminator byte.
REQUIRED_MARGIN = 0.75
LEGACY_BODY_MAX = 1024


def read_body_max() -> int:
    source = NET_C.read_text(encoding="utf-8")
    matches = re.findall(r"^#define\s+BODY_MAX\s+(\d+)\s*$",
                         source, flags=re.MULTILINE)
    if len(matches) != 1:
        raise AssertionError(
            f"expected exactly one BODY_MAX define in {NET_C}, "
            f"found {len(matches)}")
    return int(matches[0])


def worst_case_payload() -> dict:
    """Field-wise maxima for every key get_snapshot can emit, plus the
    three v2 stale booleans. Values are per-field upper bounds (a superset
    of any single reachable payload), so the byte count is a true ceiling.
    """
    payload = {
        # _compute base
        "v": 2,
        "dayTokens": 999_999_999_999,
        "dayTokensPerHour": 999_999_999_999,
        "daySessions": 9999,
        "monthTokens": 9_999_999_999_999,
        "at": "2026-12-31T23:59:59+00:00",
        # limits (floats as the server publishes them)
        "claudeSessionPct": 100.0,
        "claudeSessionResetMin": 999_999,
        "claudeWeekPct": 100.0,
        "claudeWeekResetMin": 999_999,
        # Observation epochs (relay merge-by-time, 100be8f): ten digits
        # until 2286.
        "claudeWeekObservedAt": 9_999_999_999,
        "claudeModelWeekPct": 100.0,
        "claudeModelWeekResetMin": 999_999,
        "claudeModelWeekObservedAt": 9_999_999_999,
        # 14 UTF-8 bytes, inside the ESP's 17-byte label cap; json.dumps
        # (ensure_ascii default, as the server sends it) escapes the
        # middle dot to · which widens it further on the wire.
        "claudeModelWeekLabel": "SONNET · WEEK",
        "codexSessionPct": 100.0,
        "codexSessionResetMin": 999_999,
        "codexWeekPct": 100.0,
        "codexWeekResetMin": 999_999,
        "codexWeekObservedAt": 9_999_999_999,
        # deltas
        "claudeWeekTodayDeltaPct": 100.0,
        "claudeModelWeekTodayDeltaPct": 100.0,
        "claudeSessionHourDeltaPct": 100.0,
        "codexWeekTodayDeltaPct": 100.0,
        # contract v2 provenance (false is the widest serialization)
        "claudeWeekStale": False,
        "claudeModelWeekStale": False,
        "codexWeekStale": False,
        # Host UTC offset in minutes; the widest serialisation is a
        # negative three-digit offset (UTC-12:00).
        "tzOffsetMin": -720,
        # OTA announcement: the newest build's app-descriptor version.
        "otaAvailableVersion": "v" + "9" * (OTA_VERSION_MAX_CHARS - 1),
    }
    for prefix in ("claude", "codex"):
        payload[f"{prefix}ForecastState"] = "unavailable"
        payload[f"{prefix}ForecastPctAtReset"] = 100
        payload[f"{prefix}ForecastPaceFactor"] = 9999.9
        payload[f"{prefix}ForecastAt"] = 9_999_999_999
        payload[f"{prefix}ForecastOffsetMin"] = -999_999
    # Value multiple (value_meter.build_payload). Field-wise maxima: the
    # longest string per key and the widest number serialization.
    payload["value"] = {
        "value_usd": 999_999.99,
        "plan_usd": 9999.0,
        "cost_source": "configured",     # längre än "default"/"unknown"
        "basis": "list API prices",
        "prices_as_of": "2026-12-31",
        "unpriced_token_share": 0.9999,  # fyra decimaler, som round(x, 4)
        # Per-provider breakdown: both providers present is the widest case.
        "claude_usd": 999_999.99,
        "claude_plan_usd": 9999.0,
        "codex_usd": 999_999.99,
        "codex_plan_usd": 9999.0,
        "state": "no_plan_cost",         # längre än "ok"/"partial"
        "multiple": 9999.99,
    }
    return payload


def serialized_size() -> int:
    # Mirror Handler._send exactly: json.dumps defaults (spaces after
    # ':' and ',', ensure_ascii=True), UTF-8 encoded.
    return len(json.dumps(worst_case_payload()).encode())


def live_snapshot_keys():
    """The key set get_snapshot() really emits, with every upstream
    stubbed to its fullest shape and every side effect kept in a temp dir.
    """
    now_ts = 1_800_000_000
    claude = {
        "sessionPct": 21.0,
        "sessionResetAt": now_ts + 3600,
        "weekPct": 47.0,
        "weekResetAt": now_ts + 300 * 60,
        "weekObservedAt": now_ts,
        "weekIdentity": tokenserver._quota_identity(
            "claude", "general_weekly"),
        "modelPct": 73.0,
        "modelResetAt": now_ts + 300 * 60,
        "modelObservedAt": now_ts,
        "modelIdentity": tokenserver._quota_identity(
            "claude", "model_weekly"),
        "modelLabel": "SONNET · WEEK",
    }
    codex = {
        "codexSessionPct": 12.0,
        "codexSessionResetMin": 90,
        "codexSessionWindowMinutes": 300,
        "codexWeekPct": 35.0,
        "codexWeekResetAt": now_ts + 300 * 60,
        "codexWeekObservedAt": now_ts,
        "codexWeekIdentity": tokenserver._quota_identity(
            "codex", "general_weekly", "synthetic"),
        "codexWeekWindowMinutes": 10080,
    }
    with tempfile.TemporaryDirectory() as temp_dir, \
            mock.patch.object(tokenserver, "_persist_quota_records_async"), \
            mock.patch.object(tokenserver, "get_limits",
                              return_value=claude), \
            mock.patch.object(tokenserver, "_read_codex_limits",
                              return_value=codex), \
            mock.patch.object(tokenserver, "_ota_available_version",
                              return_value="v0.0.0"), \
            mock.patch.object(codex_usage, "month_value",
                              return_value=(0.0, 0, 0)), \
            mock.patch.object(tokenserver, "_file_cache", {}):
        root = Path(temp_dir)
        projects = root / "projects"
        projects.mkdir()
        tokenserver._last_result = None
        tokenserver._last_computed = 0.0
        snapshot = tokenserver.get_snapshot(
            projects, history=UsageHistory(root / "history.json"),
            now_ts=now_ts,
            quota_cache=QuotaCache(root / "quota.json",
                                   now=lambda: now_ts))
    return set(snapshot), set(snapshot["value"])


class TokenBodyCapacityTests(unittest.TestCase):
    def test_every_emitted_key_is_registered_in_the_gate(self):
        """A field added to get_snapshot without touching this gate is
        exactly how the 1 058-byte payload met the 1 024-byte cap (lessons.md,
        "One byte over budget froze the display")."""
        gate = worst_case_payload()
        top_keys, value_keys = live_snapshot_keys()
        self.assertEqual(
            top_keys - set(gate), set(),
            "get_snapshot emits keys the capacity gate does not model")
        self.assertEqual(
            set(gate) - top_keys, set(),
            "the capacity gate models keys get_snapshot no longer emits")
        self.assertEqual(
            value_keys - set(gate["value"]), set(),
            "value_meter emits keys the capacity gate does not model")

    def test_worst_case_payload_fits_body_max_with_agreed_margin(self):
        body_max = read_body_max()
        size = serialized_size()
        self.assertLessEqual(
            size, REQUIRED_MARGIN * body_max,
            f"worst-case /api/tokens payload is {size} B but BODY_MAX "
            f"{body_max} only affords {int(REQUIRED_MARGIN * body_max)} B "
            f"at the agreed {int(REQUIRED_MARGIN * 100)} % margin; "
            f"overflow rejects the whole body and freezes the display "
            f"stale")

    def test_legacy_1024_cap_lacked_the_agreed_margin(self):
        size = serialized_size()
        self.assertGreater(
            size, REQUIRED_MARGIN * LEGACY_BODY_MAX,
            "expected the worst-case payload to prove the old 1024-byte "
            "cap insufficient; if this fails the margin analysis must be "
            "redone")


if __name__ == "__main__":
    unittest.main()
