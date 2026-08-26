#!/usr/bin/env python3
"""VibePulse in the Windows notification area, next to the clock.

The service is deliberately invisible: pythonw.exe, no console, started by a
scheduled task. That is right for a background job and wrong for a usage
meter - the numbers it computes are the whole point, and until now the only
way to read them on the machine itself was to curl a port.

This is the tray front end. It OWNS the server rather than merely watching
one: it launches tokenserver.py as a child, restarts it if it dies, and
stops it on Quit. One thing starts at logon, one thing to quit, and the
Restart item actually restarts something. Install it with
``install-windows-task.ps1 -Tray``, which retires the plain server task so
the two cannot both claim port 8737.

The icon is redrawn with the highest of the four live percentages, because
the number you want at a glance is whichever one is closest to biting. The
menu names which one it is, so a red icon is never ambiguous.

Every spawn here passes CREATE_NO_WINDOW for the reason recorded in
docs/lessons.md: this process has no console of its own, so a console child
would allocate a new one and flash a window - the exact bug the tray is
supposed to make less likely, not more.
"""

import argparse
import json
import logging
import logging.handlers
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

log = logging.getLogger("vibepulse.tray")

DEFAULT_ENDPOINT = "http://127.0.0.1:8737"
DEFAULT_POLL_S = 20.0

# Same flags, same reason, as tokenserver._no_window_kwargs(). Duplicated
# rather than imported so the tray keeps working if it is ever run from a
# copy that cannot import the service module.
_CREATE_NO_WINDOW = 0x08000000
_IS_WINDOWS = sys.platform == "win32"

# Percentage thresholds for the icon colour. Amber is deliberately early:
# the useful moment to see the meter is while there is still room to change
# what you are doing, not once the week is already spent.
_OK_BELOW = 50.0
_WARN_BELOW = 80.0

_GREEN = (64, 192, 112, 255)
_AMBER = (232, 168, 48, 255)
_RED = (224, 84, 76, 255)
_GREY = (150, 150, 150, 255)

# The four numbers the service tracks, in menu order. The label is what the
# menu and the tooltip call each one.
_TRACKED = (
    ("Claude week", "claudeWeekPct", "claudeWeekResetMin", "claudeWeekStale"),
    ("Claude session", "claudeSessionPct", "claudeSessionResetMin", None),
    ("Codex week", "codexWeekPct", "codexWeekResetMin", "codexWeekStale"),
    ("Codex session", "codexSessionPct", "codexSessionResetMin", None),
)


def _no_window_kwargs():
    """Spawn flags so a child never flashes a console window. See lessons."""
    return {"creationflags": _CREATE_NO_WINDOW} if _IS_WINDOWS else {}


def state_dir():
    """Where the service keeps its lock, cache and history."""
    if _IS_WINDOWS:
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = (Path(local_app_data) if local_app_data
                else Path.home() / "AppData" / "Local")
        return base / "VibePulse"
    return Path.home() / "Library" / "Application Support" / "VibePulse"


# ---------------------------------------------------------------- formatting


def format_reset(minutes):
    """Minutes until a quota window resets, as something readable.

    ``None`` is not zero: a missing reset time must not render as "0m", which
    reads as "resets right now" - the opposite of "we do not know yet".
    """
    if minutes is None:
        return "-"
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return "-"
    if minutes < 0:
        return "-"
    if minutes < 60:
        return f"{minutes}m"
    hours, mins = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {mins:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h"


def _as_pct(value):
    try:
        pct = float(value)
    except (TypeError, ValueError):
        return None
    if pct != pct:  # NaN never equals itself
        return None
    return pct


def tracked_rows(status):
    """The four quota lines as ``(label, pct, reset_text, stale)`` tuples."""
    rows = []
    for label, pct_key, reset_key, stale_key in _TRACKED:
        rows.append((
            label,
            _as_pct(status.get(pct_key)),
            format_reset(status.get(reset_key)),
            bool(status.get(stale_key)) if stale_key else False,
        ))
    return rows


def headline(status):
    """The number the icon shows: whichever quota is closest to biting.

    Returns ``(label, pct)``, or ``(None, None)`` when nothing is readable -
    a server that is down must not render as a confident 0%.
    """
    best_label, best_pct = None, None
    for label, pct, _reset, _stale in tracked_rows(status):
        if pct is None:
            continue
        if best_pct is None or pct > best_pct:
            best_label, best_pct = label, pct
    return best_label, best_pct


def colour_for(pct, healthy=True):
    """Icon colour. Grey means "we do not know", never "fine"."""
    if not healthy or pct is None:
        return _GREY
    if pct < _OK_BELOW:
        return _GREEN
    if pct < _WARN_BELOW:
        return _AMBER
    return _RED


def icon_text(pct):
    """What to print in a 16 px tray icon.

    Three digits do not fit legibly, so 100 becomes "99+": overstating a
    full quota as "00" (the truncation you get for free) would be the single
    most misleading thing this icon could do.
    """
    if pct is None:
        return "?"
    pct = max(0.0, float(pct))
    if pct >= 100:
        return "99+"
    return str(int(pct))


def tooltip(status, healthy=True, error=None):
    """Hover text: every number, so the icon never has to be interpreted."""
    if not healthy:
        return f"VibePulse - server unreachable\n{error or ''}".strip()
    lines = ["VibePulse"]
    for label, pct, reset, stale in tracked_rows(status):
        shown = "-" if pct is None else f"{pct:g}%"
        suffix = "  (stale)" if stale else ""
        lines.append(f"{label}: {shown}   resets in {reset}{suffix}")
    return "\n".join(lines)


def menu_lines(status, healthy=True):
    """The greyed-out header lines at the top of the right-click menu."""
    if not healthy:
        return ["Server unreachable"]
    lines = []
    for label, pct, reset, stale in tracked_rows(status):
        shown = "-" if pct is None else f"{pct:g}%"
        suffix = " (stale)" if stale else ""
        lines.append(f"{label}  {shown}  -  {reset}{suffix}")
    return lines


def render_icon(pct, healthy=True, size=64):
    """Draw the tray image: the percentage, in the colour for that level."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    colour = colour_for(pct, healthy)

    # A filled rounded square reads at 16 px where a thin glyph does not;
    # the number sits on top of it in the tray's own contrast.
    draw.rounded_rectangle((2, 2, size - 3, size - 3),
                           radius=int(size * 0.28), fill=colour)

    text = icon_text(pct)
    font = None
    for name in ("segoeuib.ttf", "arialbd.ttf", "seguisb.ttf"):
        try:
            font = ImageFont.truetype(name, int(size * (0.5 if len(text) > 2
                                                        else 0.62)))
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()

    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(((size - (right - left)) / 2 - left,
               (size - (bottom - top)) / 2 - top),
              text, font=font, fill=(255, 255, 255, 255))
    return image


# ------------------------------------------------------------------- server


class ServerSupervisor:
    """Owns the tokenserver child: start it, restart it, stop it.

    Restarts are backed off. A server that cannot start - a busy port, a
    syntax error - would otherwise be respawned in a tight loop for as long
    as the user stays logged in, which is how a helper turns into the
    problem it was added to solve.
    """

    def __init__(self, command, min_backoff_s=2.0, max_backoff_s=60.0,
                 spawn=None, clock=None):
        self.command = list(command)
        self.min_backoff_s = min_backoff_s
        self.max_backoff_s = max_backoff_s
        self._spawn = spawn or self._spawn_real
        self._clock = clock or time.monotonic
        self._process = None
        self._backoff_s = min_backoff_s
        self._next_attempt_at = 0.0
        self._lock = threading.Lock()
        self.last_error = None

    def _spawn_real(self, command):
        # The child's stderr goes to the tray log rather than DEVNULL. A
        # server that refuses to start - busy port, bad argument - would
        # otherwise fail in complete silence behind an icon that just says
        # "unreachable", which is the least useful thing either could do.
        return subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=self._child_log_handle(),
                                **_no_window_kwargs())

    def _child_log_handle(self):
        try:
            folder = state_dir()
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / "tray-server.log"
            rotate_if_large(path)
            return open(path, "a", encoding="utf-8", errors="replace")
        except OSError:
            return subprocess.DEVNULL

    def is_running(self):
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def start(self):
        """Start the child if it is not running and the backoff has elapsed.

        Returns True if a process was spawned by this call.
        """
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return False
            now = self._clock()
            if now < self._next_attempt_at:
                return False
            try:
                self._process = self._spawn(self.command)
                self.last_error = None
                log.info("server startad: pid %s",
                         getattr(self._process, "pid", "?"))
            except OSError as exc:
                self._process = None
                self.last_error = str(exc)
                log.error("server startade inte: %s (kommando: %s)",
                          exc, self.command)
                self._penalise(now)
                return False
            # The backoff only resets once a start has actually held; see
            # settle().
            self._next_attempt_at = now + self.min_backoff_s
            return True

    def _penalise(self, now):
        self._next_attempt_at = now + self._backoff_s
        self._backoff_s = min(self._backoff_s * 2, self.max_backoff_s)

    def note_exit(self):
        """Called when the child is found dead: schedule the next attempt."""
        with self._lock:
            if self._process is not None:
                log.warning("server dog (exit %s); nästa försök om %.0f s",
                            self._process.poll(), self._backoff_s)
            self._process = None
            self._penalise(self._clock())

    def settle(self):
        """A child that has stayed up clears the penalty."""
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self._backoff_s = self.min_backoff_s

    def restart(self):
        self.stop()
        with self._lock:
            self._backoff_s = self.min_backoff_s
            self._next_attempt_at = 0.0
        self.start()

    def stop(self):
        with self._lock:
            process, self._process = self._process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


def read_status(endpoint, timeout_s=8.0, opener=None):
    """GET /api/tokens. Returns ``(status_dict, error_or_None)``."""
    url = endpoint.rstrip("/") + "/api/tokens"
    opener = opener or urllib.request.urlopen
    try:
        with opener(url, timeout=timeout_s) as response:
            return json.loads(response.read().decode("utf-8")), None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        return {}, str(exc)


# --------------------------------------------------------------------- app


_CHILD_LOG_MAX_BYTES = 2_000_000


def rotate_if_large(path, max_bytes=_CHILD_LOG_MAX_BYTES):
    """Keep the child's log from growing without a ceiling.

    The handle is a plain redirect, so RotatingFileHandler cannot help: the
    server writes to the file descriptor directly. Rotation therefore happens
    at the only moment it safely can - just before a spawn, when nothing
    holds the file. The tail is kept in ``.old``, the same shape the service
    uses for its own log.
    """
    try:
        if path.exists() and path.stat().st_size > max_bytes:
            backup = path.with_suffix(path.suffix + ".old")
            backup.unlink(missing_ok=True)
            path.rename(backup)
            return True
    except OSError:
        pass
    return False


def setup_logging(path=None):
    """A small rotating log beside the service's own state.

    Under pythonw there is nowhere for a traceback to go, and under Task
    Scheduler there is no terminal to have started from. Without this, a
    tray that comes up and quietly never starts its server looks identical
    to one that is working - which is exactly how this file's first
    scheduled-task run behaved.
    """
    if log.handlers:
        return
    path = Path(path) if path else state_dir() / "tray.log"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=512_000, backupCount=1, encoding="utf-8")
    except OSError:
        handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)


def server_command(python_exe, server_path, extra_args):
    """The command the supervisor runs. pythonw so the service stays silent."""
    return [str(python_exe), str(server_path), *extra_args]


def _pythonw():
    """pythonw.exe beside the running interpreter, if there is one."""
    exe = Path(sys.executable)
    if _IS_WINDOWS:
        candidate = exe.with_name("pythonw.exe")
        if candidate.exists():
            return candidate
    return exe


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="VibePulse tray app for Windows. Unrecognised arguments "
                    "are forwarded to tokenserver.py.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_S)
    parser.add_argument("--no-supervise", action="store_true",
                        help="attach to a server that is already running "
                             "instead of starting one")
    args, server_args = parser.parse_known_args(argv)
    setup_logging()
    log.info("tray startar: %s", sys.executable)

    import pystray

    server_path = Path(__file__).with_name("tokenserver.py")
    supervisor = None
    if not args.no_supervise:
        supervisor = ServerSupervisor(
            server_command(_pythonw(), server_path, server_args))
        supervisor.start()

    state = {"status": {}, "healthy": False, "error": "starting"}

    def header(index):
        def text(_item):
            lines = menu_lines(state["status"], state["healthy"])
            return lines[index] if index < len(lines) else ""

        return pystray.MenuItem(text, None, enabled=False,
                                visible=lambda _i: bool(
                                    text(None)))

    def on_open_api(_icon, _item):
        webbrowser.open(args.endpoint.rstrip("/") + "/api/tokens")

    def on_open_state(_icon, _item):
        folder = state_dir()
        folder.mkdir(parents=True, exist_ok=True)
        if _IS_WINDOWS:
            os.startfile(folder)  # noqa: S606 - a folder, opened by the shell
        else:
            subprocess.Popen(["open", str(folder)], **_no_window_kwargs())

    def on_restart(_icon, _item):
        if supervisor is not None:
            supervisor.restart()

    def on_quit(icon, _item):
        if supervisor is not None:
            supervisor.stop()
        icon.stop()

    items = [header(i) for i in range(len(_TRACKED))]
    items.append(pystray.Menu.SEPARATOR)
    items.append(pystray.MenuItem("Open numbers in browser", on_open_api,
                                  default=True))
    if supervisor is not None:
        items.append(pystray.MenuItem("Restart server", on_restart))
    items.append(pystray.MenuItem("Open state folder", on_open_state))
    items.append(pystray.Menu.SEPARATOR)
    items.append(pystray.MenuItem("Quit", on_quit))

    icon = pystray.Icon("vibepulse", render_icon(None, healthy=False),
                        "VibePulse", pystray.Menu(*items))

    stop = threading.Event()

    def refresh():
        while not stop.is_set():
            if supervisor is not None:
                if supervisor.is_running():
                    supervisor.settle()
                else:
                    supervisor.note_exit()
                    supervisor.start()
            status, error = read_status(args.endpoint)
            healthy = error is None and bool(status)
            state.update(status=status, healthy=healthy, error=error)
            _label, pct = headline(status) if healthy else (None, None)
            try:
                icon.icon = render_icon(pct, healthy)
                icon.title = tooltip(status, healthy, error)
                icon.update_menu()
            except Exception:  # the tray can vanish on logoff; keep polling
                pass
            stop.wait(args.poll_seconds)

    threading.Thread(target=refresh, daemon=True,
                     name="vibepulse-tray-refresh").start()
    try:
        icon.run()
    finally:
        stop.set()
        if supervisor is not None:
            supervisor.stop()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        # Under pythonw a traceback has nowhere to go; without this the
        # process just disappears from the tray with no record at all.
        setup_logging()
        log.exception("tray kraschade")
        raise
