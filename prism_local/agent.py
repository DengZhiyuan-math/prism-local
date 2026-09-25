"""Claude Code agent sessions for prism-local.

Each chat turn runs the local Claude Code CLI headlessly in the repository:

    claude -p <prompt> --output-format stream-json --verbose
           --include-partial-messages --permission-mode <mode> [--resume <id>]

so the agent loads the project's CLAUDE.md, skills and .claude/settings.json
permissions exactly as it would in the terminal. In "edit" mode file edits are accepted
automatically; Bash is limited to the project's allowlist (non-interactive
runs cannot approve anything else). "ask" mode uses plan mode (read-only).

Before a turn, the editable files are snapshotted; afterwards the server
reports per-file diffs and can undo the turn.
"""
from __future__ import annotations

import difflib
import itertools
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

MODES = {"edit": "acceptEdits", "ask": "plan"}

# When the server runs without a console (started by the launcher), every console
# program it starts (git, tectonic, claude) would otherwise flash its own window.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def kill_tree(proc: subprocess.Popen) -> None:
    """Stop a process and its children (on Windows `claude` may be a .cmd shim around node)."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                       capture_output=True, timeout=15, **NO_WINDOW)
    else:
        proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()

SYSTEM_APPEND = """\
You are being driven from prism-local, a local LaTeX web editor, not the
terminal. The author sees your text in a chat panel next to the LaTeX source
and the compiled PDF.
- The message may begin with an [Editor context] block giving the file open in
  the editor, the cursor line and the selected text. Treat it as the author's
  pointer to what they mean by "this", "here", "the selection".
- The author reviews every turn's file changes as a diff with an undo button,
  so make focused, minimal edits and say which files you changed.
- Never commit, push, or run git commands that modify the repository.
- Keep replies concise. If the project has a CLAUDE.md, follow it exactly.
- Do not claim an argument is correct, or a step proved, unless you checked it.
"""


def claude_bin() -> str | None:
    return os.environ.get("CLAUDE_BIN") or shutil.which("claude") \
        or next((p for p in ("/opt/homebrew/bin/claude", str(Path.home() / ".local/bin/claude"))
                 if Path(p).exists()), None)


def _summarize_tool(name: str, inp: dict, root: Path) -> str:
    def rel(p):
        try:
            return Path(p).resolve().relative_to(root).as_posix()
        except (ValueError, OSError, TypeError):
            return str(p)
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        return rel(inp.get("file_path") or inp.get("notebook_path") or "")
    if name == "Bash":
        return inp.get("command", "")[:200]
    if name in ("Grep", "Glob"):
        return (inp.get("pattern") or "") + (f"  in {rel(inp['path'])}" if inp.get("path") else "")
    if name == "Skill":
        return inp.get("skill", "")
    if name in ("Agent", "Task"):
        return inp.get("description", "")
    for v in inp.values():
        if isinstance(v, str):
            return v[:120]
    return ""


class Job:
    def __init__(self, jid: int):
        self.id = jid
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.proc: subprocess.Popen | None = None
        self.done = False
        self.before: dict[str, str | None] = {}
        self.after: dict[str, str | None] = {}

    def emit(self, ev: dict) -> None:
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def wait_events(self, after: int, timeout: float) -> tuple[list[dict], bool]:
        with self.cond:
            if len(self.events) <= after and not self.done:
                self.cond.wait(timeout)
            return self.events[after:], self.done


class AgentManager:
    def __init__(self, root_fn: Callable[[], Path], files_fn: Callable[[], list[str]]):
        self.root_fn = root_fn        # current repository root
        self.files_fn = files_fn      # editable files (repo-relative)
        self.jobs: dict[int, Job] = {}
        self.turns: dict[int, Job] = {}
        self.ids = itertools.count(1)
        self.lock = threading.Lock()
        self.active: Job | None = None
        self.rate: dict | None = None   # last rate_limit_info seen, plus "at"
        self.probe_lock = threading.Lock()

    # ------------------------------------------------------------ snapshots
    def _snapshot(self) -> dict[str, str | None]:
        root, snap = self.root_fn(), {}
        for rel in self.files_fn():
            try:
                snap[rel] = (root / rel).read_text(encoding="utf-8")
            except OSError:
                snap[rel] = None
        return snap

    @staticmethod
    def _diff(rel: str, a: str | None, b: str | None) -> str:
        return "".join(difflib.unified_diff(
            (a or "").splitlines(keepends=True), (b or "").splitlines(keepends=True),
            fromfile=f"a/{rel}" if a is not None else "/dev/null",
            tofile=f"b/{rel}" if b is not None else "/dev/null", n=2))

    # ------------------------------------------------------------ run
    def start(self, prompt: str, session_id: str | None, mode: str,
              model: str | None = None) -> dict:
        exe = claude_bin()
        if not exe:
            return {"error": "Claude Code CLI not found (set CLAUDE_BIN=/path/to/claude)."}
        with self.lock:
            if self.active and not self.active.done:
                return {"error": "Claude is still working on the previous message."}
            job = Job(next(self.ids))
            self.jobs[job.id] = job
            self.active = job
        cmd = [exe, "-p", "--output-format", "stream-json", "--verbose",
               "--include-partial-messages", "--permission-mode", MODES.get(mode, "plan"),
               "--append-system-prompt", SYSTEM_APPEND]
        if session_id:
            cmd += ["--resume", session_id]
        if model:
            cmd += ["--model", model]
        job.before = self._snapshot()
        threading.Thread(target=self._run, args=(job, cmd, prompt), daemon=True).start()
        return {"job": job.id}

    def _run(self, job: Job, cmd: list[str], prompt: str) -> None:
        root = self.root_fn()
        session_id, result = None, None
        stderr_lines: list[str] = []
        try:
            # The prompt goes through stdin so it can never be parsed as a flag.
            job.proc = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding="utf-8", errors="replace", bufsize=1,
                                        **NO_WINDOW)
            job.proc.stdin.write(prompt)
            job.proc.stdin.close()
            threading.Thread(target=lambda: stderr_lines.extend(job.proc.stderr), daemon=True).start()
            for line in job.proc.stdout:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                t = d.get("type")
                if t == "system" and d.get("subtype") == "init":
                    session_id = d.get("session_id")
                    job.emit({"t": "init", "session_id": session_id, "model": d.get("model")})
                elif t == "stream_event" and d.get("parent_tool_use_id") is None:
                    ev = d.get("event") or {}
                    if ev.get("type") == "content_block_delta" and \
                            (ev.get("delta") or {}).get("type") == "text_delta":
                        job.emit({"t": "delta", "text": ev["delta"]["text"]})
                    elif ev.get("type") == "message_start":
                        job.emit({"t": "message_start"})
                elif t == "assistant" and d.get("parent_tool_use_id") is None:
                    for block in (d.get("message") or {}).get("content", []):
                        if block.get("type") == "text" and block.get("text"):
                            job.emit({"t": "text", "text": block["text"]})
                        elif block.get("type") == "tool_use":
                            job.emit({"t": "tool", "id": block.get("id"), "name": block.get("name"),
                                      "summary": _summarize_tool(block.get("name", ""),
                                                                 block.get("input") or {}, root)})
                elif t == "user" and d.get("parent_tool_use_id") is None:
                    for block in (d.get("message") or {}).get("content", []):
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            content = block.get("content")
                            if isinstance(content, list):
                                content = " ".join(c.get("text", "") for c in content
                                                   if isinstance(c, dict))
                            job.emit({"t": "tool_result", "id": block.get("tool_use_id"),
                                      "error": bool(block.get("is_error")),
                                      "preview": str(content or "")[:300]})
                elif t == "rate_limit_event" and d.get("rate_limit_info"):
                    self.rate = {**d["rate_limit_info"], "at": time.time()}
                    job.emit({"t": "rate", "rate": self.rate})
                elif t == "result":
                    result = d
            job.proc.wait()
        except Exception as e:  # noqa: BLE001 — report anything to the UI
            job.emit({"t": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            time.sleep(0.2)
            job.after = self._snapshot()
            changed = []
            for rel in sorted(set(job.before) | set(job.after)):
                a, b = job.before.get(rel), job.after.get(rel)
                if a != b:
                    changed.append({"path": rel, "diff": self._diff(rel, a, b),
                                    "created": a is None, "deleted": b is None})
            self.turns[job.id] = job
            rc = job.proc.returncode if job.proc else None
            ev = {"t": "done", "turn": job.id, "changed": changed, "exit": rc,
                  "session_id": (result or {}).get("session_id") or session_id}
            if result:
                ev.update(cost=result.get("total_cost_usd"), duration=result.get("duration_ms"),
                          is_error=result.get("is_error"), subtype=result.get("subtype"),
                          denials=[p.get("tool_name") for p in result.get("permission_denials") or []])
            if rc not in (0, None) or (result or {}).get("is_error"):
                ev["stderr"] = "".join(stderr_lines)[-2000:]
            job.emit(ev)
            with job.cond:
                job.done = True
                job.cond.notify_all()

    def probe_rate(self) -> dict:
        """Refresh usage limits with the cheapest possible call.

        Haiku, no tools, no MCP, no skills, no session file, run outside the
        repository so CLAUDE.md is not loaded (about $0.001 at list price).
        """
        exe = claude_bin()
        if not exe:
            return {"error": "Claude Code CLI not found"}
        if not self.probe_lock.acquire(blocking=False):
            return {"rate": self.rate, "busy": True}
        try:
            cmd = [exe, "-p", "--model", "haiku", "--tools", "",
                   "--system-prompt", "Reply with the single word ok.",
                   "--no-session-persistence", "--strict-mcp-config",
                   "--disable-slash-commands", "--output-format", "stream-json", "--verbose"]
            try:
                out = subprocess.run(cmd, input="ok", capture_output=True, text=True,
                                     encoding="utf-8", errors="replace", timeout=90,
                                     cwd=tempfile.gettempdir(), **NO_WINDOW).stdout
            except subprocess.TimeoutExpired:
                return {"error": "usage check timed out", "rate": self.rate}
            for line in out.splitlines():
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "rate_limit_event" and d.get("rate_limit_info"):
                    self.rate = {**d["rate_limit_info"], "at": time.time()}
            return {"rate": self.rate}
        finally:
            self.probe_lock.release()

    def stop(self, jid: int) -> dict:
        job = self.jobs.get(jid)
        if job and job.proc and job.proc.poll() is None:
            kill_tree(job.proc)
            return {"ok": True}
        return {"ok": False}

    def busy(self) -> bool:
        job = self.active
        return bool(job and not job.done)

    def shutdown(self) -> None:
        """Stop a turn that is still running when the server exits."""
        job = self.active
        if job and job.proc and job.proc.poll() is None:
            kill_tree(job.proc)

    def undo(self, turn: int) -> dict:
        """Restore files changed in `turn`, only where they still match the turn's result."""
        job = self.turns.get(turn)
        if not job:
            return {"error": "unknown turn"}
        root, restored, skipped = self.root_fn(), [], []
        for rel in sorted(set(job.before) | set(job.after)):
            a, b = job.before.get(rel), job.after.get(rel)
            if a == b:
                continue
            p = root / rel
            try:
                cur = p.read_text(encoding="utf-8") if p.exists() else None
            except OSError:
                cur = None
            if cur != b:
                skipped.append(rel)      # edited again since; never clobber
                continue
            if a is None:
                p.unlink()
            else:
                tmp = p.with_name(p.name + ".prism-tmp")
                tmp.write_text(a, encoding="utf-8")
                os.replace(tmp, p)
            restored.append(rel)
        return {"restored": restored, "skipped": skipped}
