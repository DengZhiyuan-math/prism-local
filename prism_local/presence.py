"""Which browser pages are open, for `--exit-when-idle`.

Every editor or PDF page sends a heartbeat with a random page id and says
goodbye (navigator.sendBeacon) when it is closed. The server is idle when
no page is left:

- before the first page has connected, after `first_wait` seconds
  (a cold browser start can be slow);
- after the last page said goodbye or went silent, after `grace` seconds
  (a reload says goodbye and then connects again right away);
- a page that sends no heartbeat for `stale` seconds counts as closed.
  Browsers throttle timers in hidden tabs to about once a minute, so this
  must be well above 60 seconds.
"""
from __future__ import annotations

import threading
import time
from typing import Callable


class Presence:
    def __init__(self, first_wait: float = 60.0, grace: float = 10.0, stale: float = 120.0,
                 clock: Callable[[], float] = time.monotonic):
        self.first_wait, self.grace, self.stale, self.clock = first_wait, grace, stale, clock
        self.lock = threading.Lock()
        self.clients: dict[str, float] = {}     # page id -> last heartbeat
        self.seen_any = False
        self.empty_since: float | None = clock()

    def beat(self, cid: str) -> None:
        with self.lock:
            self.clients[cid] = self.clock()
            self.seen_any = True
            self.empty_since = None

    def bye(self, cid: str) -> bool:
        """Forget a page. Only ids that sent a heartbeat are accepted."""
        with self.lock:
            if cid not in self.clients:
                return False
            del self.clients[cid]
            if not self.clients:
                self.empty_since = self.clock()
            return True

    def _prune(self, now: float) -> None:
        dead = [c for c, t in self.clients.items() if now - t > self.stale]
        for c in dead:
            del self.clients[c]
        if dead and not self.clients:
            self.empty_since = now

    def count(self) -> int:
        with self.lock:
            self._prune(self.clock())
            return len(self.clients)

    def idle(self) -> bool:
        with self.lock:
            now = self.clock()
            self._prune(now)
            if self.clients:
                return False
            wait = self.grace if self.seen_any else self.first_wait
            return now - (self.empty_since if self.empty_since is not None else now) >= wait

    def resume(self) -> None:
        """The machine was asleep: give every page a fresh window before judging it."""
        with self.lock:
            now = self.clock()
            self.clients = {c: now for c in self.clients}
            if self.empty_since is not None:
                self.empty_since = now
