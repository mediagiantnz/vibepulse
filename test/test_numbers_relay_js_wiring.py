#!/usr/bin/env python3
"""Repository-gate contract for the numbers relay JavaScript suites."""

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


class NumbersRelayJsWiringTests(unittest.TestCase):
    """GitHub Actions does not run for this fork, so ./test/run.sh is the
    only gate: every relay suite and the dry build must live in it, once."""

    def setUp(self) -> None:
        self.runner = read("test/run.sh")
        self.node_branch = self.runner.split(
            "elif command -v node >/dev/null 2>&1 && "
            "command -v npm >/dev/null 2>&1; then",
            1,
        )[1].split("\nelse\n", 1)[0]

    def test_full_runner_runs_each_numbers_relay_suite_once(self) -> None:
        merge_command = "node --test tools/relay/test.mjs"
        runtime_command = "(cd tools/relay && npm ci && npm test)"
        dry_build_command = "(cd tools/relay && npm run build:dry)"

        for command in (merge_command, runtime_command, dry_build_command):
            self.assertEqual(self.runner.count(command), 1, command)
            self.assertIn(command, self.node_branch)
        self.assertEqual(
            self.runner.count(
                '"$PYTHON_BIN" test_numbers_relay_js_wiring.py'
            ),
            1,
        )
        self.assertIn('if [ "$SKIP_JS" = 1 ]; then', self.runner)

    def test_skipped_node_lane_never_writes_a_gate_stamp(self) -> None:
        js_block = self.runner.split('if [ "$SKIP_JS" = 1 ]; then', 1)[1]
        js_block = js_block.split("\nfi\n", 1)[0]
        skip_branch, rest = js_block.split("elif command -v node", 1)
        self.assertIn("GATE_SKIPPED=1", skip_branch)
        self.assertIn("GATE_SKIPPED=1", rest.split("\nelse\n", 1)[1])

    def test_npm_runtime_suite_does_not_repeat_merge_suite(self) -> None:
        package = json.loads(read("tools/relay/package.json"))

        self.assertEqual(
            package["scripts"]["test"],
            "vitest run --config vitest.config.mjs && "
            "node --test deploy.test.mjs",
        )
        self.assertEqual(
            package["scripts"]["test:merge"],
            "node --test test.mjs",
        )
        self.assertEqual(package["scripts"]["build:dry"],
                         "node deploy.mjs ci-dry")
        self.assertEqual(package["scripts"]["deploy:dry"],
                         "node deploy.mjs dry-run")
        self.assertEqual(package["scripts"]["deploy"],
                         "node deploy.mjs deploy")


if __name__ == "__main__":
    unittest.main()
