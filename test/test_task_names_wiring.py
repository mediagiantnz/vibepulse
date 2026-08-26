#!/usr/bin/env python3
"""Every FreeRTOS task name stays under CONFIG_FREERTOS_MAX_TASK_NAME_LEN.

Born 2026-08-27: "interaction-relay" (17 characters) was created truncated,
then the heap probe's xTaskGetHandle("interaction-relay") tripped
FreeRTOS's assert (strlen < 16) ten seconds after every boot. The boot-health
gate had already blessed the image, so the panel sat in a VALID boot loop
until a USB rescue. This test pins both halves: names given to xTaskCreate
and names the heap probe looks up must fit, and the probe must truncate
before asking.
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ("main", "platform", "components")


def task_name_cap() -> int:
    for candidate in (ROOT / "sdkconfig.defaults", ROOT / "sdkconfig"):
        if candidate.exists():
            match = re.search(r"^CONFIG_FREERTOS_MAX_TASK_NAME_LEN=(\d+)",
                              candidate.read_text(encoding="utf-8"),
                              re.MULTILINE)
            if match:
                return int(match.group(1))
    return 16  # ESP-IDF default


def created_task_names():
    pattern = re.compile(
        r'xTaskCreate(?:PinnedToCore)?\s*\(\s*[^,]+,\s*"([^"]+)"')
    for directory in SOURCE_DIRS:
        for path in (ROOT / directory).rglob("*.c"):
            for match in pattern.finditer(path.read_text(encoding="utf-8")):
                yield path.relative_to(ROOT).as_posix(), match.group(1)


class TaskNameTests(unittest.TestCase):
    def test_every_created_task_name_fits_the_freertos_cap(self):
        cap = task_name_cap()
        names = list(created_task_names())
        self.assertGreater(len(names), 5, "task-name scan found nothing")
        too_long = [(path, name) for path, name in names
                    if len(name) >= cap]
        self.assertEqual(
            too_long, [],
            f"task names must be shorter than {cap} characters "
            "(FreeRTOS truncates them and xTaskGetHandle asserts)")

    def test_heap_probe_truncates_before_xTaskGetHandle(self):
        main = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
        self.assertIn("char query[CONFIG_FREERTOS_MAX_TASK_NAME_LEN];", main)
        self.assertIn('snprintf(query, sizeof query, "%s", probed_tasks[i]);',
                      main)
        self.assertIn("xTaskGetHandle(query)", main)
        self.assertNotIn("xTaskGetHandle(probed_tasks[i])", main)

    def test_probed_task_names_fit_and_match_created_names(self):
        cap = task_name_cap()
        main = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
        block = re.search(r"probed_tasks\[\]\s*=\s*\{(.*?)\};", main, re.S)
        self.assertIsNotNone(block, "probed_tasks[] not found")
        probed = re.findall(r'"([^"]+)"', block.group(1))
        created = {name for _, name in created_task_names()} | {"lvgl"}
        for name in probed:
            with self.subTest(name=name):
                self.assertLess(len(name), cap)
                self.assertIn(name, created,
                              "probe asks for a task nobody creates")

    def test_first_probe_runs_inside_the_boot_health_minimum(self):
        main = (ROOT / "main" / "main.c").read_text(encoding="utf-8")
        match = re.search(r"static int heap_probe = (\d+);", main)
        self.assertIsNotNone(match, "heap_probe must start pre-advanced")
        first_probe_s = (100 - int(match.group(1))) / 10.0
        self.assertLess(first_probe_s, 8.0,
                        "the first heap probe must fire before the gate's "
                        "8 s minimum uptime so a crashing probe rolls back")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=0).result
    if result.wasSuccessful():
        print("OK: every task name fits FreeRTOS, and the heap probe cannot assert")
    sys.exit(0 if result.wasSuccessful() else 1)
