"""State shared by the launcher, the project servers and the Home page.

Everything lives under one state directory (PRISM_STATE_DIR, otherwise
%LOCALAPPDATA%\\prism-local or ~/.local/state/prism-local):

    projects.json          the project list shown on the Home page
    instances/<key>.json   {pid, port, url, root} of each running server
    instances/home.json    the same for the Home page server
    logs/<key>.log         server output of launcher-started servers

Only the Python standard library is used.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.request
import zlib
from pathlib import Path

WIN = os.name == "nt"
PORT_BASE, PORT_SPAN, PORT_TRIES = 8800, 1000, 20
HOME_PORT, HOME_PORT_TRIES = 8790, 10          # below the per-project range
HOME_KEY = "home"

# Never send requests for 127.0.0.1 through a system proxy.
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def state_dir() -> Path:
    if os.environ.get("PRISM_STATE_DIR"):
        return Path(os.environ["PRISM_STATE_DIR"])
    if WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "prism-local"


def norm(path) -> str:
    return os.path.normcase(str(path))


def project_key(project: Path) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in project.name) or "project"
    return f"{safe}-{hashlib.sha1(norm(project).encode('utf-8')).hexdigest()[:10]}"


def preferred_port(project: Path) -> int:
    """A stable port per project, so the browser keeps its per-origin state (tabs, chat)."""
    return PORT_BASE + zlib.crc32(norm(project).encode("utf-8")) % PORT_SPAN


def instance_file(key: str) -> Path:
    return state_dir() / "instances" / f"{key}.json"


def log_file(key: str) -> Path:
    return state_dir() / "logs" / f"{key}.log"


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


class FileLock:
    """Exclusive lock between processes (two quick clicks, launcher vs. Home page)."""

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
                    self.fh.close()
                    raise TimeoutError(f"another Prism process holds {self.path}")
                time.sleep(0.1)

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


# ---------------------------------------------------------------- running servers

def ping(url: str, app: str = "prism-local", root: Path | None = None,
         timeout: float = 2.0) -> dict | None:
    """The /api/ping answer of the server at `url`, if it is `app` (serving `root`)."""
    try:
        with HTTP.open(url + "api/ping", timeout=timeout) as r:
            info = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    if info.get("app") != app:
        return None
    if root is not None and norm(info.get("root", "")) != norm(root):
        return None
    return info


def running_instance(inst: Path, app: str = "prism-local", root: Path | None = None,
                     timeout: float = 2.0, cleanup: bool = True) -> dict | None:
    """The instance file's contents if that server still answers; otherwise remove
    the stale file (left behind by a server that did not exit cleanly)."""
    info = read_json(inst)
    if info and info.get("url"):
        live = ping(info["url"], app, root, timeout)
        if live:
            return {**info, "pages": live.get("pages", 0)}
    if cleanup and inst.exists():
        try:
            inst.unlink()
        except OSError:
            pass
    return None


# ---------------------------------------------------------------- project list

def _registry_path() -> Path:
    return state_dir() / "projects.json"


def load_projects() -> dict:
    data = read_json(_registry_path()) or {}
    data.setdefault("projects", [])
    return data


def update_projects(fn):
    """Run fn(data) on projects.json under a lock, save, and return fn's result."""
    path = _registry_path()
    with FileLock(path.with_suffix(".lock"), timeout=10):
        data = load_projects()
        result = fn(data)
        write_json(path, data)
    return result


def find(data: dict, project: Path) -> dict | None:
    n = norm(project)
    return next((p for p in data["projects"] if norm(p["path"]) == n), None)


def touch(project: Path, opened: bool = True) -> dict:
    """Add `project` to the list if needed and record that it was opened now."""
    project = Path(project).resolve()

    def fn(data):
        entry = find(data, project)
        if entry is None:
            entry = {"path": str(project), "added": time.time()}
            data["projects"].append(entry)
        if opened:
            entry["opened"] = time.time()
        return dict(entry)

    return update_projects(fn)


def safe_touch(project: Path) -> None:
    """touch(), for callers that must not fail because of the project list."""
    try:
        touch(project)
    except (OSError, TimeoutError, ValueError):
        pass


# ---------------------------------------------------------------- starting servers

LAUNCHER = Path(__file__).resolve().parent.parent / "launcher" / "prism_launcher.pyw"


def spawn_detached(cmd: list[str], cwd: Path | None = None) -> None:
    """Start a process that outlives its parent and opens no console window."""
    import subprocess
    kw = ({"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
          if WIN else {"start_new_session": True})
    subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True,
                     env={**os.environ, "PYTHONIOENCODING": "utf-8"}, **kw)


def launch(project: Path | None, timeout: float = 40.0) -> dict:
    """Make sure a server runs for `project` (None: the Home page) and return
    {"url": ...} or {"error": ...}. The launcher owns the server: it starts it with
    --exit-when-idle, so the server stops after its last page is closed. The caller
    must open a page within a minute, or the new server gives up and exits."""
    import sys
    if project is None:
        key, app, args = HOME_KEY, "prism-home", ["--home"]
    else:
        key, app, args = project_key(project), "prism-local", [str(project)]
    inst = instance_file(key)
    info = running_instance(inst, app, project)
    if info:
        return {"url": info["url"], "started": False}
    if not LAUNCHER.is_file():
        return {"error": f"launcher not found: {LAUNCHER}"}
    spawn_detached([sys.executable, str(LAUNCHER), *args, "--browser", "none"],
                   cwd=project or Path.home())
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.15)
        info = running_instance(inst, app, project, timeout=1.0, cleanup=False)
        if info:
            return {"url": info["url"], "started": True}
    log = log_file(key)
    try:
        last = "\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-12:])
    except OSError:
        last = ""
    return {"error": "the server did not start in time", "log": last, "logfile": str(log)}
