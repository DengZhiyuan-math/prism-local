#!/usr/bin/env python3
"""Prism launcher: open a LaTeX project in prism-local with one click.

    pythonw launcher/prism_launcher.pyw PROJECT_DIR [--browser app|default|none] [--port N]

1. If prism-local already runs for PROJECT_DIR, open another page on it and exit.
2. Otherwise start prism-local with --exit-when-idle, wait until it answers,
   and open the page (by default as an Edge/Chrome app window).
3. Wait for the server. It exits by itself shortly after its last page is
   closed; the launcher then exits too.

Run it with pythonw on Windows so no console window appears. The server's
output goes to a log file under %LOCALAPPDATA%\\prism-local\\logs. Only the
Python standard library is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "prism_local" / "server.py"
WIN = os.name == "nt"
NO_WINDOW = subprocess.CREATE_NO_WINDOW if WIN else 0
READY_TIMEOUT = 30.0
PORT_BASE, PORT_SPAN, PORT_TRIES = 8800, 1000, 20

# Never send requests for 127.0.0.1 through a system proxy.
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
QUIET = False


# ---------------------------------------------------------------- helpers

def state_dir() -> Path:
    if os.environ.get("PRISM_STATE_DIR"):
        return Path(os.environ["PRISM_STATE_DIR"])
    if WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "prism-local"


def project_key(project: Path) -> str:
    norm = os.path.normcase(str(project))
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in project.name) or "project"
    return f"{safe}-{hashlib.sha1(norm.encode('utf-8')).hexdigest()[:10]}"


def preferred_port(project: Path) -> int:
    """A stable port per project, so the browser keeps its per-origin state (tabs, chat)."""
    return PORT_BASE + zlib.crc32(os.path.normcase(str(project)).encode("utf-8")) % PORT_SPAN


def message(text: str, error: bool = True) -> None:
    if WIN and not QUIET:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, "Prism", 0x10 if error else 0x40)
    elif sys.stderr is not None:
        print(f"prism-launcher: {text}", file=sys.stderr, flush=True)


def tail(path: Path, lines: int = 15) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def pid_alive(pid: int) -> bool:
    if WIN:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                             capture_output=True, text=True, creationflags=NO_WINDOW).stdout
        return f'"{pid}"' in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class FileLock:
    """Exclusive lock, so two quick clicks do not start two servers."""

    def __init__(self, path: Path, timeout: float = 60.0):
        self.path, self.timeout, self.fh = path, timeout, None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(self.path, "a+")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self._lock(True)
                return self
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"another launcher holds {self.path}")
                time.sleep(0.2)

    def __exit__(self, *exc):
        try:
            self._lock(False)
        finally:
            self.fh.close()

    def _lock(self, on: bool) -> None:
        if WIN:
            import msvcrt
            self.fh.seek(0)
            msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK if on else msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.fh, (fcntl.LOCK_EX | fcntl.LOCK_NB) if on else fcntl.LOCK_UN)


# ---------------------------------------------------------------- server

def ping(url: str, project: Path) -> dict | None:
    """The server's /api/ping answer, if a prism-local for `project` answers at `url`."""
    try:
        with HTTP.open(url + "api/ping", timeout=2) as r:
            info = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    same = os.path.normcase(info.get("root", "")) == os.path.normcase(str(project))
    return info if info.get("app") == "prism-local" and same else None


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def running_instance(inst: Path, project: Path) -> dict | None:
    info = read_json(inst)
    if info and info.get("url") and ping(info["url"], project):
        return info
    if inst.exists():
        inst.unlink()               # left behind by a server that did not exit cleanly
    return None


def server_python() -> str:
    """python.exe rather than pythonw.exe: the server then has a (hidden) console that
    its build and git subprocesses share, and a real stdout for the log."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and exe.with_name("python.exe").exists():
        return str(exe.with_name("python.exe"))
    return sys.executable


def start_server(project: Path, port: int, inst: Path, log: Path, extra: list[str]):
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists():
        os.replace(log, log.with_name(log.name + ".1"))
    logf = open(log, "w", encoding="utf-8")
    cmd = [server_python(), "-u", str(SERVER), str(project), "--port", str(port),
           "--port-tries", str(PORT_TRIES), "--no-browser", "--exit-when-idle",
           "--ready-file", str(inst), *extra]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(cmd, cwd=project, stdin=subprocess.DEVNULL, stdout=logf,
                            stderr=subprocess.STDOUT, env=env, creationflags=NO_WINDOW)
    logf.close()                    # the child keeps its own handle
    return proc


def wait_ready(proc, inst: Path, project: Path) -> dict | None:
    deadline = time.monotonic() + READY_TIMEOUT
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return None
        info = read_json(inst)
        if info and info.get("pid") == proc.pid and ping(info["url"], project):
            return info
        time.sleep(0.1)
    return None


# ---------------------------------------------------------------- browser

def default_browser_progid() -> str:
    try:
        import winreg
        key = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            return winreg.QueryValueEx(k, "ProgId")[0]
    except OSError:
        return ""


def app_browser() -> str | None:
    """Edge or Chrome, whichever is the default browser; Edge first otherwise."""
    if not WIN:
        return next((b for b in (shutil.which(n) for n in
                                 ("google-chrome", "chromium", "chromium-browser",
                                  "microsoft-edge")) if b), None)
    progid = default_browser_progid().lower()
    if "firefox" in progid:
        return None                 # no app windows; use the ordinary default browser
    edge, chrome = [], []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            edge.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
            chrome.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    order = chrome + edge if "chrome" in progid else edge + chrome
    return next((str(p) for p in order if p.exists()), None)


def open_page(url: str, mode: str) -> None:
    if mode == "none":
        return
    if mode == "app":
        exe = app_browser()
        if exe:
            subprocess.Popen([exe, f"--app={url}"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             close_fds=True)
            return
    if WIN:
        os.startfile(url)
    else:
        webbrowser.open(url)


# ---------------------------------------------------------------- main

def main() -> int:
    global QUIET
    ap = argparse.ArgumentParser(description="Open a LaTeX project in prism-local.")
    ap.add_argument("project", type=Path, help="LaTeX project directory")
    ap.add_argument("--browser", choices=("app", "default", "none"), default="app",
                    help="app: Edge/Chrome app window (default); default: default browser")
    ap.add_argument("--port", type=int, help="preferred port (default: stable per project)")
    ap.add_argument("--quiet", action="store_true", help=argparse.SUPPRESS)  # no dialogs (tests)
    ap.add_argument("--idle-timings", help=argparse.SUPPRESS)                # passed to server
    a = ap.parse_args()
    QUIET = a.quiet

    project = a.project.expanduser().resolve()
    if not project.is_dir():
        message(f"Project folder not found:\n{project}")
        return 2
    if not SERVER.is_file():
        message(f"prism-local server not found:\n{SERVER}")
        return 2
    key = project_key(project)
    inst = state_dir() / "instances" / f"{key}.json"
    log = state_dir() / "logs" / f"{key}.log"
    extra = ["--idle-timings", a.idle_timings] if a.idle_timings else []

    try:
        with FileLock(inst.with_suffix(".lock")):
            info = running_instance(inst, project)
            if info:
                open_page(info["url"], a.browser)
                return 0
            proc = start_server(project, a.port or preferred_port(project), inst, log, extra)
            info = wait_ready(proc, inst, project)
            if not info:
                if proc.poll() is None:
                    proc.kill()
                message(f"prism-local did not start for\n{project}\n\n{tail(log)}\n\nLog: {log}")
                return 1
    except TimeoutError as e:
        message(str(e))
        return 1

    open_page(info["url"], a.browser)
    rc = proc.wait()
    info = read_json(inst)
    if info and info.get("pid") == proc.pid:
        inst.unlink()
    if rc != 0:
        message(f"prism-local stopped with an error (exit code {rc}).\n\n{tail(log)}\n\nLog: {log}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
