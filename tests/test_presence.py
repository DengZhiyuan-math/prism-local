"""Unit tests for prism_local/presence.py with a fake clock."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "prism_local"))
from presence import Presence  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class PresenceTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.p = Presence(first_wait=60, grace=10, stale=120, clock=self.clock)

    def tick(self, s):
        self.clock.t += s

    def test_waits_for_first_page(self):
        self.tick(59)
        self.assertFalse(self.p.idle())
        self.tick(2)
        self.assertTrue(self.p.idle())

    def test_open_page_keeps_it_alive(self):
        self.p.beat("a")
        for _ in range(100):
            self.tick(5)
            self.p.beat("a")
            self.assertFalse(self.p.idle())

    def test_goodbye_then_grace(self):
        self.p.beat("a")
        self.assertTrue(self.p.bye("a"))
        self.tick(9)
        self.assertFalse(self.p.idle())
        self.tick(2)
        self.assertTrue(self.p.idle())

    def test_reload_within_grace(self):
        self.p.beat("a")
        self.p.bye("a")
        self.tick(1)
        self.p.beat("b")            # the reloaded page has a new id
        self.tick(30)
        self.p.beat("b")
        self.assertFalse(self.p.idle())

    def test_last_of_several_pages(self):
        self.p.beat("editor")
        self.p.beat("pdf")
        self.p.bye("editor")
        self.tick(30)
        self.p.beat("pdf")
        self.assertFalse(self.p.idle())
        self.p.bye("pdf")
        self.tick(11)
        self.assertTrue(self.p.idle())

    def test_silent_page_goes_stale(self):
        self.p.beat("a")
        self.tick(119)
        self.assertFalse(self.p.idle())
        self.assertEqual(self.p.count(), 1)
        self.tick(2)                # stale now: grace starts
        self.assertFalse(self.p.idle())
        self.assertEqual(self.p.count(), 0)
        self.tick(11)
        self.assertTrue(self.p.idle())

    def test_unknown_goodbye_is_ignored(self):
        self.p.beat("a")
        self.assertFalse(self.p.bye("someone-else"))
        self.tick(11)
        self.assertFalse(self.p.idle())

    def test_resume_after_sleep(self):
        self.p.beat("a")
        self.tick(3600)             # asleep for an hour
        self.p.resume()
        self.assertFalse(self.p.idle())
        self.tick(5)
        self.p.beat("a")
        self.assertFalse(self.p.idle())

    def test_resume_restarts_grace(self):
        self.p.beat("a")
        self.p.bye("a")
        self.tick(9)
        self.p.resume()
        self.tick(9)
        self.assertFalse(self.p.idle())

    def test_open_stream_never_goes_stale(self):
        self.p.hold("a")
        self.tick(3600)                      # hidden tab: no heartbeats at all
        self.assertEqual(self.p.count(), 1)
        self.assertFalse(self.p.idle())

    def test_closed_stream_means_gone(self):
        self.p.hold("a")
        self.tick(30)
        self.p.release("a")
        self.assertEqual(self.p.count(), 0)
        self.tick(9)
        self.assertFalse(self.p.idle())
        self.tick(2)
        self.assertTrue(self.p.idle())

    def test_second_stream_of_same_page(self):
        self.p.hold("a")
        self.p.hold("a")                     # EventSource reconnected before the old one closed
        self.p.release("a")
        self.assertEqual(self.p.count(), 1)
        self.p.release("a")
        self.assertEqual(self.p.count(), 0)


if __name__ == "__main__":
    unittest.main()
