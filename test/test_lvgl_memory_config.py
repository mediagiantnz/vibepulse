#!/usr/bin/env python3
"""Regression tests for Torget's configure-time LVGL pool floor."""

from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "cmake" / "torget_lvgl_memory_guard.cmake"
ROOT_CMAKE = ROOT / "CMakeLists.txt"
SDKCONFIG_DEFAULTS = ROOT / "sdkconfig.defaults"


def run_guard(actual_kib: int) -> subprocess.CompletedProcess[str]:
    return run_cmake(f"torget_require_lvgl_pool({actual_kib})\n")


def run_effective(
    mem_size_bytes: str, mem_size_kib: str
) -> subprocess.CompletedProcess[str]:
    """Resolve the effective pool like the root build does, then guard it."""
    return run_cmake(
        f'torget_lvgl_effective_pool_kib(kib "{mem_size_bytes}" '
        f'"{mem_size_kib}")\n'
        'torget_require_lvgl_pool("${kib}")\n'
    )


def run_cmake(body: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "check.cmake"
        script.write_text(
            f'include("{GUARD.as_posix()}")\n' + body,
            encoding="utf-8",
        )
        return subprocess.run(
            ["cmake", "-P", str(script)],
            capture_output=True,
            check=False,
            text=True,
        )


class LvglMemoryConfigTests(unittest.TestCase):
    def test_stale_96_kib_generated_config_is_rejected(self) -> None:
        result = run_guard(96)
        self.assertNotEqual(result.returncode, 0)
        diagnostic = result.stdout + result.stderr
        self.assertIn("LVGL pool is 96 KiB", diagnostic)
        self.assertIn("at least 256 KiB", diagnostic)
        self.assertIn("sdkconfig is stale", diagnostic)
        self.assertIn("CONFIG_LV_MEM_SIZE=262144", diagnostic)
        self.assertIn("CONFIG_LV_MEM_SIZE_KILOBYTES=256", diagnostic)
        self.assertIn("idf.py reconfigure && idf.py build", diagnostic)

    def test_intended_256_kib_config_is_accepted(self) -> None:
        result = run_guard(256)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_lvgl_9_6_byte_default_is_rejected_despite_kib_256(self) -> None:
        # 2026-11-12: lvgl 9.6 ignores the deprecated KiB option, so a
        # sdkconfig with KILOBYTES=256 but LV_MEM_SIZE=65536 built a 64 KiB
        # pool and the panel booted to a black screen.
        result = run_effective("65536", "256")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("LVGL pool is 64 KiB", result.stdout + result.stderr)

    def test_lvgl_9_6_byte_size_256_kib_is_accepted(self) -> None:
        result = run_effective("262144", "256")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_pre_9_6_kib_only_config_still_works(self) -> None:
        self.assertEqual(run_effective("", "256").returncode, 0)
        self.assertNotEqual(run_effective("", "96").returncode, 0)

    def test_root_build_invokes_the_guard(self) -> None:
        root_cmake = ROOT_CMAKE.read_text(encoding="utf-8")
        self.assertIn(
            'include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/'
            'torget_lvgl_memory_guard.cmake")',
            root_cmake,
        )
        self.assertIn('"${CONFIG_LV_MEM_SIZE}"', root_cmake)
        self.assertIn(
            'torget_require_lvgl_pool("${torget_lvgl_pool_kib}")',
            root_cmake,
        )

    def test_checked_in_default_matches_the_guard_floor(self) -> None:
        defaults = SDKCONFIG_DEFAULTS.read_text(encoding="utf-8").splitlines()
        self.assertIn("CONFIG_LV_MEM_SIZE=262144", defaults)
        self.assertIn("CONFIG_LV_MEM_SIZE_KILOBYTES=256", defaults)


if __name__ == "__main__":
    unittest.main(verbosity=2)
