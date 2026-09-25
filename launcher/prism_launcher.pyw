#!/usr/bin/env python3
"""Prism launcher: open a LaTeX project, or the Home page, with one click.

    pythonw launcher/prism_launcher.pyw PROJECT_DIR [--browser window|app|default|none] [--port N]
    pythonw launcher/prism_launcher.pyw --home      [--browser window|app|default|none]

1. If prism-local already runs for PROJECT_DIR, open another page on it and exit.
2. Otherwise start prism-local with --exit-when-idle, wait until it answers,
   and open the page (by default in a new Chrome/Edge window of its own, where
   the pop-out PDF opens as a second tab).
3. Wait for the server. It exits by itself shortly after its last page is
   closed; the launcher then exits too.

--home (or no PROJECT_DIR) does the same for the Home page (prism_local/hub.py),
which lists your projects and opens each one in its own prism-local server.

Run it with pythonw on Windows so no console window appears. The server's
output goes to a log file under %LOCALAPPDATA%\\prism-local\\logs. Only the
Python standard library is used.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent / "prism_local"
SERVER = PKG / "server.py"
HUB = PKG / "hub.py"
sys.path.insert(0, str(PKG))
from registry import (HOME_KEY, HOME_PORT, HOME_PORT_TRIES, PORT_TRIES, WIN,  # noqa: E402,F401
                      FileLock, instance_file, log_file, preferred_port, project_key,
                      read_json, running_instance, state_dir)

NO_WINDOW = subprocess.CREATE_NO_WINDOW if WIN else 0
READY_TIMEOUT = 30.0
QUIET = False


# ---------------------------------------------------------------- helpers

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


# ---------------------------------------------------------------- server

def server_python() -> str:
    """python.exe rather than pythonw.exe: the server then has a (hidden) console that
    its build and git subprocesses share, and a real stdout for the log."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and exe.with_name("python.exe").exists():
        return str(exe.with_name("python.exe"))
    return sys.executable


def start_server(script: Path, target: list[str], cwd: Path, port: int, tries: int,
                 inst: Path, log: Path, extra: list[str]):
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists():
        os.replace(log, log.with_name(log.name + ".1"))
    logf = open(log, "w", encoding="utf-8")
    cmd = [server_python(), "-u", str(script), *target, "--port", str(port),
           "--port-tries", str(tries), "--no-browser", "--exit-when-idle",
           "--ready-file", str(inst), *extra]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=logf,
                            stderr=subprocess.STDOUT, env=env, creationflags=NO_WINDOW)
    logf.close()                    # the child keeps its own handle
    return proc


def wait_ready(proc, inst: Path, app: str, root: Path | None) -> dict | None:
    deadline = time.monotonic() + READY_TIMEOUT
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return None
        info = running_instance(inst, app, root, cleanup=False)
        if info and info.get("pid") == proc.pid:
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


def chromium_browser() -> str | None:
    """Edge or Chrome, whichever is the default browser; Edge first otherwise."""
    if not WIN:
        return next((b for b in (shutil.which(n) for n in
                                 ("google-chrome", "chromium", "chromium-browser",
                                  "microsoft-edge")) if b), None)
    progid = default_browser_progid().lower()
    if "firefox" in progid:
        return None                 # use the ordinary default browser
    edge, chrome = [], []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            edge.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
            chrome.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    order = chrome + edge if "chrome" in progid else edge + chrome
    return next((str(p) for p in order if p.exists()), None)


def browser_command(url: str, mode: str, exe: str | None) -> list[str] | None:
    """How to start Chrome/Edge for `mode`, or None for the default browser.

    window: a new ordinary window with a tab strip, holding only Prism; the pop-out
            PDF (window.open) then opens as a tab in that same window.
    app:    an app window without tabs or address bar; the pop-out PDF gets its own
            app window.
    """
    if not exe or mode not in ("window", "app"):
        return None
    return [exe, "--new-window", url] if mode == "window" else [exe, f"--app={url}"]


def open_page(url: str, mode: str) -> None:
    if mode == "none":
        return
    cmd = browser_command(url, mode, chromium_browser())
    if cmd:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True)
        return
    if WIN:
        os.startfile(url)
    else:
        webbrowser.open(url)


# ---------------------------------------------------------------- main

def main() -> int:
    global QUIET
    ap = argparse.ArgumentParser(description="Open a LaTeX project, or the Home page, in prism-local.")
    ap.add_argument("project", type=Path, nargs="?",
                    help="LaTeX project directory (omit it, or pass --home, for the Home page)")
    ap.add_argument("--home", action="store_true", help="open the Home page with your projects")
    ap.add_argument("--browser", choices=("window", "app", "default", "none"), default="window",
                    help="window: new Chrome/Edge window of its own (default); app: app window "
                         "without tabs; default: a tab in the default browser")
    ap.add_argument("--port", type=int, help="preferred port (default: stable per project)")
    ap.add_argument("--quiet", action="store_true", help=argparse.SUPPRESS)  # no dialogs (tests)
    ap.add_argument("--idle-timings", help=argparse.SUPPRESS)                # passed to server
    a = ap.parse_args()
    QUIET = a.quiet
    extra = ["--idle-timings", a.idle_timings] if a.idle_timings else []

    if a.home or a.project is None:
        if not HUB.is_file():
            message(f"prism-local Home page not found:\n{HUB}")
            return 2
        what, app, root, key = "the Home page", "prism-home", None, HOME_KEY
        script, target, cwd = HUB, [], Path.home()
        port, tries = a.port or HOME_PORT, HOME_PORT_TRIES
    else:
        project = a.project.expanduser().resolve()
        if not project.is_dir():
            message(f"Project folder not found:\n{project}")
            return 2
        if not SERVER.is_file():
            message(f"prism-local server not found:\n{SERVER}")
            return 2
        what, app, root, key = str(project), "prism-local", project, project_key(project)
        script, target, cwd = SERVER, [str(project)], project
        port, tries = a.port or preferred_port(project), PORT_TRIES
    inst, log = instance_file(key), log_file(key)

    try:
        with FileLock(inst.with_suffix(".lock")):
            info = running_instance(inst, app, root)
            if info:
                open_page(info["url"], a.browser)
                return 0
            proc = start_server(script, target, cwd, port, tries, inst, log, extra)
            info = wait_ready(proc, inst, app, root)
            if not info:
                if proc.poll() is None:
                    proc.kill()
                message(f"prism-local did not start for\n{what}\n\n{tail(log)}\n\nLog: {log}")
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
