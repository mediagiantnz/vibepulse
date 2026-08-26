#!/usr/bin/env python3
"""Canonical setup, lifecycle, arithmetic, and lessons for the numbers relay."""

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def production_config(readme: str) -> dict:
    for body in re.findall(r"```json\n(.*?)\n```", readme, re.DOTALL):
        parsed = json.loads(body)
        if parsed.get("name") == "vibepulse-relay":
            return parsed
    raise AssertionError("missing strict production JSON config example")


def markdown_section(document: str, heading: str) -> str:
    marker = f"## {heading}\n"
    if document.count(marker) != 1:
        raise AssertionError(f"missing unique lesson heading: {heading}")
    return document.split(marker, 1)[1].split("\n## ", 1)[0]


class NumbersRelayDocumentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.readme = read("tools/relay/README.md")
        self.relay = read("docs/relay.md")
        self.lessons = read("docs/lessons.md")
        self.relay_words = " ".join(self.relay.split())
        self.lesson_words = " ".join(self.lessons.split())

    def test_readme_contains_the_complete_guarded_bootstrap_config(self) -> None:
        config = production_config(self.readme)
        self.assertEqual(set(config), {
            "name", "main", "compatibility_date", "compatibility_flags",
            "observability", "durable_objects", "exports",
            "kv_namespaces", "secrets",
        })
        self.assertEqual(config["name"], "vibepulse-relay")
        self.assertEqual(config["main"], "bootstrap.js")
        self.assertEqual(config["compatibility_date"], "2026-08-22")
        self.assertEqual(config["compatibility_flags"], ["nodejs_compat"])
        self.assertEqual(config["observability"], {
            "enabled": True,
            "logs": {"invocation_logs": False},
        })
        self.assertEqual(config["durable_objects"], {
            "bindings": [{
                "name": "NUMBERS_MAILBOX",
                "class_name": "NumbersMailbox",
            }],
        })
        self.assertEqual(config["exports"], {
            "NumbersMailbox": {
                "type": "durable-object",
                "storage": "sqlite",
                "state": "created",
            },
        })
        self.assertEqual(config["kv_namespaces"], [{
            "binding": "VIBEPULSE",
            "id": "REPLACE_WITH_EXISTING_32_HEX_KV_NAMESPACE_ID",
        }])
        self.assertEqual(config["secrets"], {"required": ["RELAY_SECRET"]})
        self.assertIn("Change only `main` from `bootstrap.js` to `worker.js`",
                      self.readme)

    def test_canonical_guide_describes_the_active_mailbox_and_privacy(self) -> None:
        for fact in (
            "public Worker", "SQLite-backed `NumbersMailbox` Durable Object",
            "`NUMBERS_MAILBOX`", "does not read or write KV",
            "bootstrap and rollback", "off by default", "numbers only",
            "This is an open-source, user-owned feature",
            "available on any ordinary internet Wi-Fi",
            "a publisher registry capped at eight names",
        ):
            self.assertIn(fact.lower(), self.relay_words.lower(), fact)
        self.assertNotIn("Cloudflare Worker + KV", self.relay_words)
        self.assertNotIn("mailbox is disposable", self.relay_words.lower())
        self.assertNotIn("KV's 1,000-write", self.relay_words)

    def test_guide_pins_cadences_requests_rows_and_recovery(self) -> None:
        for row in (
            "| `/api/tokens` | 5 minutes | 288 token publications |",
            "| `/api/max-tracker` | 30 minutes | "
            "48 Max Tracker publications |",
            "| `/api/github` | 30 minutes | 48 GitHub publications |",
        ):
            self.assertIn(row, self.relay, row)
        for exact in (
            "2,880 poll cycles", "8,640 panel GETs", "9,024",
            "9,408", "8,640 document rows", "17,280 document rows",
            "288 token publications", "48 Max Tracker publications",
            "48 GitHub publications", "384 publications",
            "768 publications", "primary-key index rows",
            "under 1,600 billed row writes", "under 3,100 billed row writes",
            "100,000-row daily free limit",
            "mailbox starts empty", "restart each active tokenserver",
            "all three endpoints", "usage_http_200 + ok",
            "one panel polling interval", "STALE",
        ):
            self.assertIn(exact, self.relay_words, exact)
        self.assertNotIn("five-minute heartbeat", self.relay_words.lower())

    def test_active_kv_boundary_and_one_two_publisher_math_stay_associated(
        self,
    ) -> None:
        for exact in (
            "The active `worker.js` request path does not read or write KV "
            "and never calls KV list.",
            "The existing `VIBEPULSE` binding and data are retained only "
            "for bootstrap and rollback.",
            "Two publishers can therefore make at most 768 publications "
            "per day.",
            "On the healthy-success path, one continuously changing "
            "publisher makes 9,024 public Worker requests and 9,024 Durable "
            "Object RPCs per day; two make 9,408 of each.",
            "A failed publication leaves its send time unchanged and can "
            "retry on the next 30-second publisher check, so failed-attempt "
            "traffic is not bounded by those healthy-success totals.",
            "return at most 8,640 document rows per day for one publisher "
            "or 17,280 document rows for two.",
            "These are conservative upper bounds, not exact billed-row "
            "counts.",
        ):
            self.assertIn(exact, self.relay_words, exact)
        self.assertNotIn("exact daily successful-request and row budget",
                         self.relay_words.lower())

    def test_guard_flags_snapshot_and_corrupt_state_recovery_are_scoped(
        self,
    ) -> None:
        readme_words = " ".join(self.readme.split())
        for exact in (
            "pinned Wrangler with `--strict --keep-vars`",
            "mode-0600 canonical snapshot outside the repository",
            "removes the snapshot after Wrangler exits",
            "The `--config` argument itself must be an absolute canonical "
            "path",
            "Handled `SIGINT` and `SIGTERM` are forwarded to Wrangler",
            "Status 130 or 143 is reported only after Wrangler confirms "
            "exit.",
            "If the child still does not report exit after forced "
            "termination, the wrapper removes the snapshot but fails with "
            "a deploy-guard error; it does not claim the child was reaped.",
            "`SIGKILL` cannot run cleanup",
        ):
            self.assertIn(exact, readme_words, exact)

        for exact in (
            "[Durable Objects Data Studio](https://developers.cloudflare.com/"
            "durable-objects/observability/data-studio/)",
            "Workers Platform Admin", "`numbers-mailbox-v1`",
            "A corrupt document normally self-heals on that publisher's "
            "next valid publication.",
            "repair only the confirmed corrupt row",
            "reviewed fresh mailbox-name rollout",
            "Do not delete the entire Durable Object or all mailbox rows.",
        ):
            self.assertIn(exact, self.relay_words, exact)

    def test_guide_pins_the_only_valid_lifecycle_rollback(self) -> None:
        for fact in (
            "deploy `bootstrap.js` first", "capture the bootstrap version",
            "switch to `worker.js`", "rollback only to the captured bootstrap",
            "never roll back directly to a pre-Durable-Object version",
        ):
            self.assertIn(fact.lower(), self.relay_words.lower(), fact)
        bootstrap = (
            "Deploy `bootstrap.js` first with the local `NUMBERS_MAILBOX` "
            "binding and sole SQLite `NumbersMailbox` export."
        )
        republish = (
            "The new Durable Object mailbox starts empty; restart each "
            "active tokenserver so its immediate first publish pass sends "
            "all three endpoints: `/api/tokens`, `/api/max-tracker`, and "
            "`/api/github`."
        )
        self.assertIn(bootstrap, self.relay_words)
        self.assertIn(republish, self.relay_words)
        self.assertNotIn("Never deploy `bootstrap.js` first",
                         self.relay_words)
        self.assertNotIn("do not restart each active tokenserver",
                         self.relay_words.lower())
        self.assertLess(self.relay_words.index(bootstrap),
                        self.relay_words.index("switch to `worker.js`"))

    def test_lessons_separate_list_quota_from_dynamic_index_consistency(self) -> None:
        list_lesson = markdown_section(
            self.lessons, "2026-08-22 · KV list requests have their own quota",
        )
        index_lesson = markdown_section(
            self.lessons,
            "2026-08-22 · An eventually consistent index is not coordination",
        )
        list_words = " ".join(list_lesson.split())
        index_words = " ".join(index_lesson.split())
        for fact in (
            "KV list-request quota", "code 10048", "every panel GET",
            "independent of KV read and write quotas",
        ):
            self.assertIn(fact.lower(), list_words.lower(), fact)
        for fact in (
            "eventually consistent", "read-modify-write", "lost update",
            "Durable Object",
        ):
            self.assertIn(fact.lower(), index_words.lower(), fact)

    def test_host_runner_owns_this_documentation_contract_once(self) -> None:
        runner = read("test/run.sh")
        self.assertEqual(runner.count(
            '"$PYTHON_BIN" test_numbers_relay_docs.py'
        ), 1)


if __name__ == "__main__":
    unittest.main()
