"""Unit tests for how launcher/prism_launcher.pyw starts the browser."""
import importlib.util
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "launcher" / "prism_launcher.pyw"
loader = SourceFileLoader("prism_launcher", str(PATH))
spec = importlib.util.spec_from_loader("prism_launcher", loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)

URL = "http://127.0.0.1:9544/"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


class BrowserCommand(unittest.TestCase):
    def test_window_mode_opens_a_new_normal_window(self):
        self.assertEqual(launcher.browser_command(URL, "window", CHROME),
                         [CHROME, "--new-window", URL])

    def test_app_mode_opens_an_app_window(self):
        self.assertEqual(launcher.browser_command(URL, "app", CHROME), [CHROME, f"--app={URL}"])

    def test_default_mode_uses_the_default_browser(self):
        self.assertIsNone(launcher.browser_command(URL, "default", CHROME))

    def test_without_chrome_or_edge_falls_back(self):
        self.assertIsNone(launcher.browser_command(URL, "window", None))

    def test_window_is_the_default_mode(self):
        self.assertIn('default="window"', PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
