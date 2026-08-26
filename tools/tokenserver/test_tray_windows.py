import ast
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.tokenserver import tray_windows


class FormatResetTests(unittest.TestCase):
    def test_minutes_hours_and_days(self):
        self.assertEqual(tray_windows.format_reset(0), "0m")
        self.assertEqual(tray_windows.format_reset(59), "59m")
        self.assertEqual(tray_windows.format_reset(60), "1h 00m")
        self.assertEqual(tray_windows.format_reset(492), "8h 12m")
        self.assertEqual(tray_windows.format_reset(8689), "6d 0h")

    def test_unknown_reset_is_not_rendered_as_now(self):
        """None is not zero: "0m" reads as "resets right now", which is the
        opposite of "we do not know yet"."""
        for value in (None, "", "later", float("nan"), -1):
            self.assertEqual(tray_windows.format_reset(value), "-", value)


class HeadlineTests(unittest.TestCase):
    def test_icon_shows_the_quota_closest_to_biting(self):
        status = {"claudeWeekPct": 42.0, "claudeSessionPct": 3.0,
                  "codexWeekPct": 61.0, "codexSessionPct": 1.0}
        self.assertEqual(tray_windows.headline(status), ("Codex week", 61.0))

    def test_a_dead_server_is_not_a_confident_zero(self):
        self.assertEqual(tray_windows.headline({}), (None, None))

    def test_unreadable_values_are_skipped_not_coerced(self):
        status = {"claudeWeekPct": None, "claudeSessionPct": "n/a",
                  "codexWeekPct": 7.0}
        self.assertEqual(tray_windows.headline(status), ("Codex week", 7.0))


class ColourTests(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(tray_windows.colour_for(0), tray_windows._GREEN)
        self.assertEqual(tray_windows.colour_for(49.9), tray_windows._GREEN)
        self.assertEqual(tray_windows.colour_for(50), tray_windows._AMBER)
        self.assertEqual(tray_windows.colour_for(79.9), tray_windows._AMBER)
        self.assertEqual(tray_windows.colour_for(80), tray_windows._RED)
        self.assertEqual(tray_windows.colour_for(100), tray_windows._RED)

    def test_unknown_is_grey_never_green(self):
        """Grey means "we do not know". A server that is down rendering as a
        calm green is the one failure this icon must not have."""
        self.assertEqual(tray_windows.colour_for(None), tray_windows._GREY)
        self.assertEqual(tray_windows.colour_for(5, healthy=False),
                         tray_windows._GREY)


class IconTextTests(unittest.TestCase):
    def test_full_quota_never_truncates_to_double_zero(self):
        """int(100) printed in two digits is "00" - a full week reading as
        empty. 99+ is the honest overflow."""
        self.assertEqual(tray_windows.icon_text(100), "99+")
        self.assertEqual(tray_windows.icon_text(137.5), "99+")

    def test_ordinary_values(self):
        self.assertEqual(tray_windows.icon_text(0), "0")
        self.assertEqual(tray_windows.icon_text(62.7), "62")
        self.assertEqual(tray_windows.icon_text(99.9), "99")
        self.assertEqual(tray_windows.icon_text(None), "?")


class RenderIconTests(unittest.TestCase):
    def test_renders_a_square_image_for_every_state(self):
        for pct in (None, 0, 62, 100):
            image = tray_windows.render_icon(pct, healthy=pct is not None)
            self.assertEqual(image.size, (64, 64))
            self.assertEqual(image.mode, "RGBA")


class TooltipAndMenuTests(unittest.TestCase):
    STATUS = {
        "claudeWeekPct": 42.0, "claudeWeekResetMin": 3524,
        "claudeSessionPct": 3.0, "claudeSessionResetMin": 234,
        "codexWeekPct": 1.0, "codexWeekResetMin": 8689,
        "codexSessionPct": 1.0, "codexSessionResetMin": 260,
    }

    def test_menu_names_every_number(self):
        lines = tray_windows.menu_lines(self.STATUS)
        self.assertEqual(len(lines), 4)
        self.assertIn("Claude week  42%", lines[0])
        self.assertIn("2d 10h", lines[0])

    def test_stale_is_shown_not_hidden(self):
        status = dict(self.STATUS, claudeWeekStale=True)
        self.assertIn("(stale)", tray_windows.menu_lines(status)[0])

    def test_unreachable_server_says_so(self):
        self.assertEqual(tray_windows.menu_lines({}, healthy=False),
                         ["Server unreachable"])
        self.assertIn("unreachable",
                      tray_windows.tooltip({}, healthy=False, error="boom"))

    def test_tooltip_lists_all_four(self):
        text = tray_windows.tooltip(self.STATUS)
        for label in ("Claude week", "Claude session",
                      "Codex week", "Codex session"):
            self.assertIn(label, text)


class ReadStatusTests(unittest.TestCase):
    def test_parses_json(self):
        class Response:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *_a):
                return False

            @staticmethod
            def read():
                return b'{"claudeWeekPct": 42}'

        status, error = tray_windows.read_status(
            "http://x:1", opener=lambda *_a, **_k: Response())
        self.assertEqual(status, {"claudeWeekPct": 42})
        self.assertIsNone(error)

    def test_a_down_server_is_an_error_not_an_empty_success(self):
        def boom(*_a, **_k):
            raise OSError("refused")

        status, error = tray_windows.read_status("http://x:1", opener=boom)
        self.assertEqual(status, {})
        self.assertIn("refused", error)


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode

    def die(self, code=1):
        self.returncode = code


class SupervisorTests(unittest.TestCase):
    def _supervisor(self, spawn=None):
        self.now = 0.0
        self.spawned = []

        def default_spawn(_command):
            process = FakeProcess()
            self.spawned.append(process)
            return process

        return tray_windows.ServerSupervisor(
            ["pythonw", "tokenserver.py"], min_backoff_s=2.0,
            max_backoff_s=16.0, spawn=spawn or default_spawn,
            clock=lambda: self.now)

    def test_starts_once_and_not_again_while_alive(self):
        sup = self._supervisor()
        self.assertTrue(sup.start())
        self.assertFalse(sup.start())
        self.assertEqual(len(self.spawned), 1)
        self.assertTrue(sup.is_running())

    def test_a_dead_child_is_restarted(self):
        sup = self._supervisor()
        sup.start()
        self.spawned[0].die()
        self.assertFalse(sup.is_running())
        sup.note_exit()
        self.now += 10
        self.assertTrue(sup.start())
        self.assertEqual(len(self.spawned), 2)

    def test_a_server_that_cannot_start_backs_off_instead_of_spinning(self):
        """A busy port would otherwise respawn in a tight loop for as long as
        the user stays logged in."""
        def refuse(_command):
            raise OSError("port busy")

        sup = self._supervisor(spawn=refuse)
        delays = []
        for _ in range(5):
            self.assertFalse(sup.start())
            delays.append(sup._next_attempt_at - self.now)
            self.now = sup._next_attempt_at
        self.assertEqual(delays, [2.0, 4.0, 8.0, 16.0, 16.0])
        self.assertIn("port busy", sup.last_error)

    def test_backoff_only_clears_once_a_start_has_held(self):
        sup = self._supervisor()
        sup._backoff_s = 16.0
        sup.start()
        sup.settle()
        self.assertEqual(sup._backoff_s, 2.0)

    def test_restart_is_immediate_and_ignores_the_backoff(self):
        sup = self._supervisor()
        sup.start()
        sup._backoff_s = 16.0
        sup._next_attempt_at = self.now + 999
        sup.restart()
        self.assertEqual(len(self.spawned), 2)
        self.assertTrue(self.spawned[0].terminated)
        self.assertTrue(sup.is_running())

    def test_stop_escalates_to_kill(self):
        class Stubborn(FakeProcess):
            def terminate(self):
                self.terminated = True  # ignores it

            def wait(self, timeout=None):
                if self.returncode is None:
                    raise subprocess.TimeoutExpired("x", timeout)
                return self.returncode

        stubborn = Stubborn()
        sup = self._supervisor(spawn=lambda _c: stubborn)
        sup.start()
        sup.stop()
        self.assertTrue(stubborn.killed)

    def test_stop_is_safe_when_nothing_is_running(self):
        sup = self._supervisor()
        sup.stop()  # must not raise
        self.assertFalse(sup.is_running())


class ChildLogRotationTests(unittest.TestCase):
    """The child's log is a raw redirect, so nothing rotates it for us."""

    def test_a_small_log_is_left_alone(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "tray-server.log"
            path.write_text("short", encoding="utf-8")
            self.assertFalse(tray_windows.rotate_if_large(path, max_bytes=100))
            self.assertEqual(path.read_text(encoding="utf-8"), "short")

    def test_a_large_log_keeps_its_tail_in_old(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "tray-server.log"
            path.write_text("x" * 500, encoding="utf-8")
            self.assertTrue(tray_windows.rotate_if_large(path, max_bytes=100))
            self.assertFalse(path.exists())
            self.assertEqual(
                (Path(temp_dir) / "tray-server.log.old")
                .read_text(encoding="utf-8"), "x" * 500)

    def test_rotating_twice_replaces_the_previous_old(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "tray-server.log"
            for text in ("first", "second"):
                path.write_text(text * 100, encoding="utf-8")
                tray_windows.rotate_if_large(path, max_bytes=100)
            self.assertEqual(
                (Path(temp_dir) / "tray-server.log.old")
                .read_text(encoding="utf-8"), "second" * 100)

    def test_a_missing_log_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertFalse(tray_windows.rotate_if_large(
                Path(temp_dir) / "absent.log", max_bytes=1))


class ServerCommandTests(unittest.TestCase):
    def test_extra_arguments_are_forwarded_to_the_service(self):
        command = tray_windows.server_command(
            "pythonw.exe", "tokenserver.py",
            ["--claude-plan", "max20x", "--codex-plan", "pro"])
        self.assertEqual(command, ["pythonw.exe", "tokenserver.py",
                                   "--claude-plan", "max20x",
                                   "--codex-plan", "pro"])


class SpawnWindowTests(unittest.TestCase):
    """The tray has no console either, so the same rule applies here.

    A tray app that flashed a console window while restarting the server
    would reintroduce the exact bug it was written alongside.
    """

    def test_supervisor_spawns_without_a_console_window(self):
        seen = {}

        def popen(_command, **kwargs):
            seen.update(kwargs)
            return FakeProcess()

        sup = tray_windows.ServerSupervisor(["pythonw"])
        with mock.patch.object(tray_windows, "_IS_WINDOWS", True), \
                mock.patch.object(tray_windows.subprocess, "Popen",
                                  side_effect=popen):
            sup._spawn_real(["pythonw"])
        self.assertEqual(seen.get("creationflags"), 0x08000000)

    def test_no_creationflags_off_windows(self):
        with mock.patch.object(tray_windows, "_IS_WINDOWS", False):
            self.assertEqual(tray_windows._no_window_kwargs(), {})

    def test_every_spawn_in_the_tray_passes_the_flags(self):
        tree = ast.parse(
            Path(tray_windows.__file__).read_text(encoding="utf-8"))
        missing = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute)
                    and func.attr in {"run", "Popen", "call",
                                      "check_output", "check_call"}
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "subprocess"):
                continue
            if not any(keyword.arg is None
                       and isinstance(keyword.value, ast.Call)
                       and isinstance(keyword.value.func, ast.Name)
                       and keyword.value.func.id == "_no_window_kwargs"
                       for keyword in node.keywords):
                missing.append(node.lineno)
        self.assertEqual(
            missing, [],
            f"subprocess spawned without **_no_window_kwargs() at {missing}")


if __name__ == "__main__":
    unittest.main()
