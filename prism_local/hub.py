#!/usr/bin/env python3
"""prism-local Home: one page to manage all your LaTeX projects.

    python3 prism_local/hub.py [--port 8790] [--no-browser] [--exit-when-idle]
                               [--port-tries N] [--ready-file F]

Lists the projects in the shared project list (registry.py), with title, PDF
thumbnail, git state and whether an editor is running. From here you can add an
existing folder, create a new project from a template, and open a project: each
project still runs in its own prism-local server (server.py), started through
the launcher, so it keeps its stable port and per-project browser state.

Like server.py it listens on 127.0.0.1 only, requires X-Prism-Local: 1 on every
state-changing request, and uses the Python standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import registry  # noqa: E402
from presence import Presence  # noqa: E402
from server import (EDITABLE_SUFFIXES, MIME, SKIP_DIRS, STATIC, Server,  # noqa: E402
                    log, remove_ready_file, write_ready_file)
from agent import NO_WINDOW  # noqa: E402

PRESENCE = Presence()
MAX_SCAN = 3000
BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# ---------------------------------------------------------------- project facts

def read_prism_json(root: Path) -> dict:
    try:
        data = json.loads((root / "prism.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def guess_main(root: Path) -> str | None:
    if (root / "main.tex").is_file():
        return "main.tex"
    for p in sorted(root.glob("*.tex")):
        try:
            if not p.name.startswith("._") and \
                    "\\documentclass" in p.read_text(encoding="utf-8", errors="replace")[:5000]:
                return p.name
        except OSError:
            pass
    return None


def balanced(text: str, i: int) -> str | None:
    """The contents of the {...} group whose '{' is at text[i]."""
    depth = 0
    for j in range(i, len(text)):
        c = text[j]
        if c == "\\":
            continue
        if c == "{" and (j == 0 or text[j - 1] != "\\"):
            depth += 1
        elif c == "}" and text[j - 1] != "\\":
            depth -= 1
            if depth == 0:
                return text[i + 1:j]
    return None


def drop_command(text: str, name: str) -> str:
    """Remove every \\name{...} (with its argument) from text."""
    while True:
        m = re.search(r"\\" + name + r"\s*\{", text)
        if not m:
            return text
        arg = balanced(text, m.end() - 1)
        text = text[:m.start()] + (text[m.end() + len(arg) + 1:] if arg is not None else "")


def tex_title(path: Path) -> str | None:
    """The \\title{...} of a LaTeX file as plain text, roughly."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:40000]
    except OSError:
        return None
    text = "\n".join(re.sub(r"(?<!\\)%.*", "", ln) for ln in text.splitlines())
    m = re.search(r"\\title\s*(?:\[[^\]]*\])?\s*\{", text)
    if not m:
        return None
    t = balanced(text, m.end() - 1)
    if t is None:
        return None
    for cmd in ("thanks", "footnote", "label"):
        t = drop_command(t, cmd)
    t = re.sub(r"\\\\(\[[^\]]*\])?|~|\\ ", " ", t)
    t = re.sub(r"\\[A-Za-z]+\*?\s*", "", t)
    t = re.sub(r"[{}]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:240] or None


def scan_sources(root: Path, outdir: str) -> tuple[int, float | None]:
    """How many editable source files the project has, and the newest mtime."""
    count, newest = 0, None
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).relative_to(root).as_posix()
        rel = "" if rel == "." else rel + "/"
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS
                       and rel + d != outdir]
        for f in filenames:
            if Path(f).suffix in EDITABLE_SUFFIXES and not f.startswith("._"):
                count += 1
                try:
                    t = os.stat(os.path.join(dirpath, f)).st_mtime
                    newest = t if newest is None or t > newest else newest
                except OSError:
                    pass
        if count > MAX_SCAN:
            break
    return count, newest


def pdf_path(root: Path) -> tuple[Path | None, str | None, str]:
    cfg = read_prism_json(root)
    main = cfg.get("main") or guess_main(root)
    outdir = str(cfg.get("outdir") or "build").strip("/") or "build"
    if not main:
        return None, None, outdir
    return root / outdir / f"{Path(main).stem}.pdf", main, outdir


def project_info(entry: dict) -> dict:
    root = Path(entry["path"])
    d = {"id": registry.project_key(root), "path": str(root),
         "name": entry.get("name") or root.name, "folder": root.name,
         "custom_name": bool(entry.get("name")), "pinned": bool(entry.get("pinned")),
         "opened": entry.get("opened"), "added": entry.get("added"),
         "exists": root.is_dir(), "running": None}
    if not d["exists"]:
        return d
    pdf, main, outdir = pdf_path(root)
    files, edited = scan_sources(root, outdir)
    d.update(main=main, title=tex_title(root / main) if main else None,
             files=files, edited=edited,
             pdf_mtime=pdf.stat().st_mtime if pdf and pdf.is_file() else None)
    inst = registry.running_instance(registry.instance_file(d["id"]), "prism-local", root,
                                     timeout=0.8)
    if inst:
        d["running"] = {"url": inst["url"], "pages": inst.get("pages", 0)}
    return d


def list_projects() -> dict:
    data = registry.load_projects()
    entries = data["projects"]
    with ThreadPoolExecutor(max_workers=8) as ex:
        projects = list(ex.map(project_info, entries))
    return {"projects": projects, "default_parent": default_parent(data),
            "home": str(Path.home())}


def default_parent(data: dict) -> str:
    if data.get("last_parent") and Path(data["last_parent"]).is_dir():
        return data["last_parent"]
    recent = sorted(data["projects"], key=lambda p: p.get("opened") or p.get("added") or 0,
                    reverse=True)
    for p in recent:
        parent = Path(p["path"]).parent
        if parent.is_dir():
            return str(parent)
    docs = Path.home() / "Documents"
    return str(docs if docs.is_dir() else Path.home())


def git_info(root: Path) -> dict | None:
    try:
        r = subprocess.run(["git", "status", "--porcelain", "-b", "--", "."], cwd=root,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8,
                           **NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    lines = r.stdout.splitlines()
    head = lines[0][3:] if lines and lines[0].startswith("## ") else ""
    head = re.sub(r"^(No commits yet on|Initial commit on) ", "", head)
    branch = re.split(r"\.\.\.| ", head)[0] if head else ""
    ahead = re.search(r"ahead (\d+)", head)
    behind = re.search(r"behind (\d+)", head)
    return {"branch": branch, "changes": len(lines) - 1,
            "ahead": int(ahead.group(1)) if ahead else 0,
            "behind": int(behind.group(1)) if behind else 0}


def entry_for(pid: str) -> dict:
    for e in registry.load_projects()["projects"]:
        if registry.project_key(Path(e["path"])) == pid:
            return e
    raise KeyError("unknown project")


# ---------------------------------------------------------------- actions

def add_project(path: str) -> dict:
    p = Path(os.path.expandvars(os.path.expanduser(path.strip().strip('"')))).resolve()
    if not p.is_dir():
        raise ValueError(f"not a folder: {p}")
    has_tex = any(p.glob("*.tex"))
    registry.update_projects(lambda data: _add(data, p))
    return {"id": registry.project_key(p), "path": str(p), "has_tex": has_tex}


def _add(data: dict, p: Path) -> None:
    if registry.find(data, p) is None:
        data["projects"].append({"path": str(p), "added": time.time()})


TEMPLATES = {
    "amsart": {
        "main.tex": r"""\documentclass[11pt]{amsart}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{hyperref}
\usepackage[capitalize]{cleveref}

\newtheorem{theorem}{Theorem}[section]
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{corollary}[theorem]{Corollary}
\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\theoremstyle{remark}
\newtheorem{remark}[theorem]{Remark}

\title{@TITLE@}
\author{@AUTHOR@}

\begin{document}

\begin{abstract}
\end{abstract}

\maketitle

\input{sections/intro}

% Uncomment once the paper has a \cite:
% \bibliographystyle{amsplain}
% \bibliography{refs}
\end{document}
""",
        "sections/intro.tex": "\\section{Introduction}\\label{sec:intro}\n\n",
        "refs.bib": "% BibTeX entries for this paper.\n",
    },
    "article": {
        "main.tex": r"""\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb}
\usepackage{hyperref}

\title{@TITLE@}
\author{@AUTHOR@}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}\label{sec:intro}

\end{document}
""",
    },
    "empty": {
        "main.tex": "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n",
    },
}
GITIGNORE = "build/\n*.prism-tmp\n.DS_Store\n"


def create_project(body: dict) -> dict:
    name = str(body.get("name", "")).strip()
    if not name or BAD_NAME.search(name) or name in (".", "..") or name.endswith((".", " ")):
        raise ValueError("choose a folder name without \\ / : * ? \" < > |")
    parent = Path(os.path.expanduser(str(body.get("parent", "")).strip().strip('"')))
    if not parent.is_absolute() or not parent.is_dir():
        raise ValueError(f"location is not a folder: {parent}")
    tpl = TEMPLATES.get(body.get("template", "amsart"))
    if tpl is None:
        raise ValueError("unknown template")
    root = (parent / name).resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError(f"{root} already exists and is not empty")
    title = str(body.get("title") or "").strip() or name
    author = str(body.get("author") or "").strip()
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in tpl.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text.replace("@TITLE@", title).replace("@AUTHOR@", author),
                     encoding="utf-8")
    (root / "prism.json").write_text(json.dumps({"main": "main.tex", "outdir": "build"},
                                                indent=2) + "\n", encoding="utf-8")
    git_note = None
    if body.get("git"):
        (root / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
        try:
            subprocess.run(["git", "init", "-q"], cwd=root, check=True, capture_output=True,
                           timeout=20, **NO_WINDOW)
        except (OSError, subprocess.SubprocessError) as e:
            git_note = f"git init failed: {e}"

    def fn(data):
        _add(data, root)
        data["last_parent"] = str(parent.resolve())
    registry.update_projects(fn)
    return {"id": registry.project_key(root), "path": str(root), "git_note": git_note}


def change_project(pid: str, body: dict) -> dict:
    def fn(data):
        for e in data["projects"]:
            if registry.project_key(Path(e["path"])) == pid:
                if "pinned" in body:
                    e["pinned"] = bool(body["pinned"])
                if "name" in body:
                    name = str(body["name"] or "").strip()[:120]
                    if name and name != Path(e["path"]).name:
                        e["name"] = name
                    else:
                        e.pop("name", None)
                return True
        return False
    if not registry.update_projects(fn):
        raise KeyError("unknown project")
    return {"ok": True}


def remove_project(pid: str) -> dict:
    """Forget a project. Its files are not touched."""
    def fn(data):
        before = len(data["projects"])
        data["projects"] = [e for e in data["projects"]
                            if registry.project_key(Path(e["path"])) != pid]
        return len(data["projects"]) < before
    if not registry.update_projects(fn):
        raise KeyError("unknown project")
    return {"ok": True}


def open_project(pid: str) -> dict:
    root = Path(entry_for(pid)["path"])
    if not root.is_dir():
        return {"error": f"folder not found: {root}"}
    r = registry.launch(root)
    if "url" in r:
        registry.safe_touch(root)
    return r


def reveal(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


PICK_FOLDER = r"""
import sys, tkinter, tkinter.filedialog
root = tkinter.Tk(); root.withdraw(); root.attributes("-topmost", True)
p = tkinter.filedialog.askdirectory(parent=root, initialdir=sys.argv[1] or None,
                                    title=sys.argv[2], mustexist=True)
sys.stdout.write(p or "")
"""


def pick_folder(start: str, title: str) -> dict:
    """A native folder dialog (tkinter, in a child process so it has its own main loop)."""
    try:
        r = subprocess.run([sys.executable, "-c", PICK_FOLDER, start or "", title or "Choose a folder"],
                           capture_output=True, timeout=900,
                           env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": f"folder dialog unavailable: {e}"}
    if r.returncode != 0:
        return {"error": "folder dialog unavailable (tkinter missing?)"}
    p = r.stdout.decode("utf-8", "replace").strip()
    return {"path": str(Path(p).resolve()) if p else None}


# ---------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    server_version = "prism-home/1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _static(self, rel):
        p = (STATIC / rel).resolve()
        if STATIC not in p.parents or not p.is_file():
            return self._err(404, "not found")
        self._send(200, p.read_bytes(), MIME.get(p.suffix, "application/octet-stream"))

    def do_GET(self):
        if not self._host_ok():
            return self._err(403, "bad host")
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path in ("/", "/index.html"):
                return self._static("home.html")
            if u.path.startswith("/static/"):
                return self._static(u.path[len("/static/"):])
            if u.path == "/api/ping":
                return self._json({"app": "prism-home", "pid": os.getpid(),
                                   "pages": PRESENCE.count()})
            if u.path == "/api/projects":
                return self._json(list_projects())
            if u.path == "/api/git":
                return self._json({"git": git_info(Path(entry_for(q["id"])["path"]))})
            if u.path == "/api/pdf":
                pdf, _, _ = pdf_path(Path(entry_for(q["id"])["path"]))
                if not pdf or not pdf.is_file():
                    return self._err(404, "no PDF yet")
                return self._send(200, pdf.read_bytes(), "application/pdf")
            return self._err(404, "not found")
        except KeyError as e:
            if e.args[0] == "unknown project":
                return self._err(404, "unknown project")
            return self._err(400, f"missing {e.args[0]}")
        except ValueError as e:
            return self._err(400, str(e))

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or urlparse(origin).netloc == self.headers.get("Host")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/bye":            # sendBeacon; see server.py
            if not self._host_ok() or not self._same_origin():
                return self._err(403, "forbidden")
            n = max(0, min(int(self.headers.get("Content-Length") or 0), 200))
            cid = self.rfile.read(n).decode("utf-8", "replace").strip()
            return self._json({"ok": PRESENCE.bye(cid)})
        if not self._host_ok() or self.headers.get("X-Prism-Local") != "1":
            return self._err(403, "forbidden")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if u.path == "/api/presence":
                cid = body["client"]
                if not isinstance(cid, str) or not 8 <= len(cid) <= 100:
                    raise ValueError("bad client id")
                PRESENCE.beat(cid)
                return self._json({"ok": True})
            if u.path == "/api/projects/add":
                return self._json(add_project(str(body["path"])))
            if u.path == "/api/projects/create":
                return self._json(create_project(body))
            if u.path == "/api/projects/update":
                return self._json(change_project(body["id"], body))
            if u.path == "/api/projects/remove":
                return self._json(remove_project(body["id"]))
            if u.path == "/api/projects/open":
                r = open_project(body["id"])
                return self._json(r, 502 if "error" in r else 200)
            if u.path == "/api/projects/reveal":
                p = Path(entry_for(body["id"])["path"])
                if not p.is_dir():
                    raise ValueError(f"folder not found: {p}")
                reveal(p)
                return self._json({"ok": True})
            if u.path == "/api/pick-folder":
                return self._json(pick_folder(str(body.get("start") or ""),
                                              str(body.get("title") or "")))
            return self._err(404, "not found")
        except KeyError as e:
            if e.args[0] == "unknown project":
                return self._err(404, "unknown project")
            return self._err(400, f"missing {e.args[0]}")
        except (ValueError, OSError, TimeoutError) as e:
            return self._err(400, str(e))


def idle_watchdog(srv) -> None:
    last = time.monotonic()
    while True:
        time.sleep(1.0)
        now = time.monotonic()
        if now - last > 20.0:
            log("resumed after sleep; waiting for pages to check in again")
            PRESENCE.resume()
        last = now
        if PRESENCE.idle():
            log("no open pages; shutting down")
            srv.shutdown()
            return


def main():
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = sys.stdout
    ap = argparse.ArgumentParser(description="prism-local Home: manage your LaTeX projects")
    ap.add_argument("--port", type=int, default=registry.HOME_PORT, help="port (0: any free port)")
    ap.add_argument("--port-tries", type=int, default=1,
                    help="if the port is taken, try this many ports upwards")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--exit-when-idle", action="store_true",
                    help="exit shortly after the last Home page is closed")
    ap.add_argument("--ready-file", type=Path,
                    help="once listening, write {pid, port, url} as JSON to this file")
    ap.add_argument("--idle-timings", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.idle_timings:
        f, g, st = (float(x) for x in a.idle_timings.split(","))
        PRESENCE.first_wait, PRESENCE.grace, PRESENCE.stale = f, g, st
    srv, err = None, None
    for port in range(a.port, a.port + max(1, a.port_tries)) if a.port else [0]:
        try:
            srv = Server(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            err = e
    if srv is None:
        sys.exit(f"prism-home: cannot listen on 127.0.0.1:{a.port}: {err}")
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"prism-local Home: {url}\n  projects: {registry.state_dir() / 'projects.json'}",
          flush=True)
    if a.ready_file:
        write_ready_file(a.ready_file, {"app": "prism-home", "pid": os.getpid(),
                                        "port": srv.server_address[1], "url": url})
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    if a.exit_when_idle:
        threading.Thread(target=idle_watchdog, args=(srv,), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        if a.ready_file:
            remove_ready_file(a.ready_file)
        log("stopped")


if __name__ == "__main__":
    sys.exit(main())
