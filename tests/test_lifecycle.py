"""Integration tests: the real server exits after its last page, and the launcher
reuses a running server. Uses short timings via the hidden --idle-timings option."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SERVER = REPO / "prism_local" / "server.py"
LAUNCHER = REPO / "launcher" / "prism_launcher.pyw"
PROJECT = REPO / "examples" / "minimal"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def request(url, path, data=None, headers=None):
    req = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers or {})
    try:
        with HTTP.open(req, timeout=5) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        with e:
            return e.code, json.loads(e.read() or b"{}")


def beat(url, cid):
    return request(url, "/api/presence", json.dumps({"client": cid}).encode(),
                   {"Content-Type": "application/json", "X-Prism-Local": "1"})


def bye(url, cid, origin=None):
    host = url.split("//")[1].rstrip("/")
    return request(url, "/api/bye", cid.encode(),
                   {"Content-Type": "text/plain;charset=UTF-8",
                    "Origin": origin or f"http://{host}"})


def stop(proc):
    if proc.poll() is None:
        proc.kill()
    proc.wait(10)


def wait_file(path, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            time.sleep(0.1)
    raise AssertionError(f"{path} did not appear")


class ServerLifecycle(unittest.TestCase):
    def start(self, timings, *extra):
        self.tmp = Path(tempfile.mkdtemp())
        self.ready = self.tmp / "ready.json"
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), str(PROJECT), "--port", "0", "--no-browser",
             "--exit-when-idle", "--idle-timings", timings, "--ready-file", str(self.ready),
             *extra], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
            env={**os.environ, "PRISM_STATE_DIR": str(self.tmp / "state")})
        self.addCleanup(self.proc.stdout.close)
        self.addCleanup(stop, self.proc)
        return wait_file(self.ready)["url"]

    def assertExitsWithin(self, lo, hi, t0):
        self.proc.wait(hi + 5)
        took = time.monotonic() - t0
        self.assertEqual(self.proc.returncode, 0)
        self.assertGreaterEqual(took, lo)
        self.assertLessEqual(took, hi)
        self.assertFalse(self.ready.exists(), "ready file should be removed on exit")

    def test_exits_when_no_page_ever_connects(self):
        self.start("2,1,5")
        t0 = time.monotonic()
        self.assertExitsWithin(0.5, 4, t0)

    def test_exits_after_last_goodbye(self):
        url = self.start("30,1.5,30")
        self.assertEqual(beat(url, "editor-page-1")[0], 200)
        self.assertEqual(beat(url, "pdf-page-0001")[0], 200)
        self.assertEqual(request(url, "/api/ping")[1]["pages"], 2)
        self.assertEqual(bye(url, "editor-page-1"), (200, {"ok": True}))
        time.sleep(3)               # one page is still open
        self.assertIsNone(self.proc.poll())
        self.assertEqual(bye(url, "pdf-page-0001"), (200, {"ok": True}))
        t0 = time.monotonic()
        self.assertExitsWithin(1, 4, t0)

    def test_reload_does_not_exit(self):
        url = self.start("30,2,30")
        beat(url, "page-before-reload")
        bye(url, "page-before-reload")
        time.sleep(0.5)
        beat(url, "page-after-reload")
        time.sleep(3)
        self.assertIsNone(self.proc.poll())

    def test_silent_page_goes_stale(self):
        url = self.start("30,1,2")
        beat(url, "page-that-crashes")
        t0 = time.monotonic()
        self.assertExitsWithin(2, 6, t0)

    def test_goodbye_is_guarded(self):
        url = self.start("30,1,30")
        beat(url, "real-page-0001")
        self.assertEqual(bye(url, "real-page-0001", origin="https://evil.example")[0], 403)
        self.assertEqual(bye(url, "guessed-id-000"), (200, {"ok": False}))
        status, _ = request(url, "/api/presence", b'{"client": "no-header-page"}',
                            {"Content-Type": "application/json"})
        self.assertEqual(status, 403)
        self.assertEqual(request(url, "/api/ping")[1]["pages"], 1)

    def test_port_in_use_moves_up(self):
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        self.addCleanup(blocker.close)
        port = blocker.getsockname()[1]
        self.start("30,1,30", "--port", str(port), "--port-tries", "5")
        info = wait_file(self.ready)
        self.assertNotEqual(info["port"], port)
        self.assertTrue(port < info["port"] <= port + 4)


class LauncherLifecycle(unittest.TestCase):
    def test_single_instance_and_exit(self):
        state = Path(tempfile.mkdtemp())
        env = {**os.environ, "PRISM_STATE_DIR": str(state)}
        cmd = [sys.executable, str(LAUNCHER), str(PROJECT), "--browser", "none", "--quiet",
               "--idle-timings", "30,1,30"]
        first = subprocess.Popen(cmd, env=env, creationflags=NO_WINDOW)
        self.addCleanup(stop, first)
        inst = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not inst:
            found = list((state / "instances").glob("*.json")) if (state / "instances").exists() else []
            inst = found[0] if found else None
            time.sleep(0.1)
        self.assertIsNotNone(inst, "launcher did not start a server")
        info = wait_file(inst)
        url = info["url"]
        self.assertEqual(beat(url, "launched-page-1")[0], 200)

        # A second click reuses the running server and exits at once.
        t0 = time.monotonic()
        second = subprocess.run(cmd, env=env, timeout=20, creationflags=NO_WINDOW)
        self.assertEqual(second.returncode, 0)
        self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(request(url, "/api/ping")[1]["pid"], info["pid"])
        self.assertEqual(len(list((state / "instances").glob("*.json"))), 1)

        # Closing the last page stops the server, then the launcher.
        bye(url, "launched-page-1")
        self.assertEqual(first.wait(15), 0)
        self.assertFalse(inst.exists())
        self.assertTrue(list((state / "logs").glob("*.log")))


if __name__ == "__main__":
    unittest.main()
