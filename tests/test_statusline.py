"""Tests for statusline.py, the usage meter as a Claude Code status line:
it keeps only the plan's usage numbers (never the session's folder, model
or anything else), never lets an idle window's older reading replace a
newer one, notes a login that reports no plan usage, writes privately and
atomically, prints one short line, and never fails. Made-up payloads only.

    python3 -m unittest discover -s tests -p "test_*.py"
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "statusline.py")
spec = importlib.util.spec_from_file_location("statusline", SCRIPT)
sl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sl)

NOW = 1_800_000_000
HOUR = 3600


def payload(five=None, week=None, api_ms=1500):
    """A status payload like Claude Code's, with the noise it carries too."""
    limits = {}
    if five:
        limits["five_hour"] = {"used_percentage": five[0], "resets_at": five[1]}
    if week:
        limits["seven_day"] = {"used_percentage": week[0], "resets_at": week[1]}
    p = {
        "session_id": "abc-123", "cwd": "/Users/someone/secret-project",
        "model": {"id": "claude-x", "display_name": "X"},
        "cost": {"total_cost_usd": 1.2, "total_api_duration_ms": api_ms},
        "workspace": {"current_dir": "/Users/someone/secret-project"},
    }
    if limits:
        p["rate_limits"] = limits
    return p


class MergeTests(unittest.TestCase):
    def test_first_reading_is_kept_with_its_time(self):
        out = sl.merge({}, payload((42.0, NOW + 2 * HOUR), (31.0, NOW + 100 * HOUR)), NOW)
        self.assertEqual(out["five_hour"], {"used_percentage": 42.0, "resets_at": NOW + 2 * HOUR})
        self.assertEqual(out["seven_day"]["used_percentage"], 31.0)
        self.assertEqual(out["at"], NOW)

    def test_only_the_numbers_are_kept(self):
        out = sl.merge({}, payload((42.0, NOW + HOUR)), NOW)
        self.assertLessEqual(set(out), {"v", "at", "seen_at", "missing_at", "five_hour", "seven_day"})
        self.assertNotIn("secret-project", json.dumps(out))
        self.assertNotIn("abc-123", json.dumps(out))

    def test_a_higher_reading_in_the_same_window_wins(self):
        saved = sl.merge({}, payload((40.0, NOW + 2 * HOUR)), NOW)
        out = sl.merge(saved, payload((47.5, NOW + 2 * HOUR + 30)), NOW + 600)
        self.assertEqual(out["five_hour"]["used_percentage"], 47.5)
        self.assertEqual(out["at"], NOW + 600)

    def test_an_idle_windows_older_lower_reading_is_ignored(self):
        saved = sl.merge({}, payload((47.5, NOW + 2 * HOUR)), NOW)
        out = sl.merge(saved, payload((40.0, NOW + 2 * HOUR)), NOW + 900)
        self.assertEqual(out["five_hour"]["used_percentage"], 47.5)
        self.assertEqual(out["at"], NOW, "an unchanged reading keeps the time it was really seen")

    def test_a_new_window_replaces_the_old_even_when_lower(self):
        saved = sl.merge({}, payload((88.0, NOW + HOUR)), NOW)
        out = sl.merge(saved, payload((3.0, NOW + 6 * HOUR)), NOW + 2 * HOUR)
        self.assertEqual(out["five_hour"], {"used_percentage": 3.0, "resets_at": NOW + 6 * HOUR})

    def test_an_older_window_is_ignored(self):
        saved = sl.merge({}, payload((5.0, NOW + 6 * HOUR)), NOW)
        out = sl.merge(saved, payload((90.0, NOW + HOUR)), NOW + 60)
        self.assertEqual(out["five_hour"]["used_percentage"], 5.0)

    def test_a_reply_without_numbers_is_noted_as_missing(self):
        out = sl.merge({}, payload(api_ms=2500), NOW)
        self.assertEqual(out.get("missing_at"), NOW)
        self.assertNotIn("at", out)

    def test_no_numbers_before_any_reply_is_not_missing(self):
        out = sl.merge({}, payload(api_ms=0), NOW)
        self.assertNotIn("missing_at", out)

    def test_bad_values_are_dropped(self):
        for bad in ({"used_percentage": "42", "resets_at": NOW}, {"used_percentage": True, "resets_at": NOW},
                    {"used_percentage": -1, "resets_at": NOW}, {"used_percentage": 40, "resets_at": "soon"}, "x", None):
            with self.subTest(bad=bad):
                out = sl.merge({}, {"rate_limits": {"five_hour": bad}}, NOW)
                self.assertIsNone(out["five_hour"])


class LineTests(unittest.TestCase):
    def test_both_windows(self):
        reading = sl.merge({}, payload((42.4, NOW + 2 * HOUR), (31.0, NOW + 30 * HOUR)), NOW)
        text = sl.line(reading, NOW, color=False)
        self.assertTrue(text.startswith("Session 42% · resets "), text)
        self.assertIn("Week 31% · resets ", text)

    def test_a_window_past_its_reset_is_left_out(self):
        reading = sl.merge({}, payload((42.0, NOW + HOUR), (31.0, NOW + 30 * HOUR)), NOW)
        self.assertNotIn("Session", sl.line(reading, NOW + 2 * HOUR, color=False))

    def test_close_to_the_limit_is_colored(self):
        reading = sl.merge({}, payload((96.0, NOW + HOUR)), NOW)
        self.assertIn("\033[31m", sl.line(reading, NOW))

    def test_nothing_known_prints_nothing(self):
        self.assertEqual(sl.line({}, NOW), "")


class ScriptTests(unittest.TestCase):
    def run_script(self, home, stdin):
        env = {**os.environ, "THROWBACKS_HOME": home, "THROWBACKS_NOW": str(NOW), "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.run([sys.executable, SCRIPT], input=stdin, capture_output=True, text=True, env=env, timeout=20)

    def test_saves_privately_and_prints_the_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, ".throwbacks")
            res = self.run_script(home, json.dumps(payload((42.0, NOW + 2 * HOUR))))
            self.assertEqual(res.returncode, 0)
            self.assertTrue(res.stdout.startswith("Session 42%"), res.stdout)
            path = os.path.join(home, "usage.json")
            with open(path) as f:
                saved = json.load(f)
            self.assertEqual(saved["five_hour"]["used_percentage"], 42.0)
            self.assertEqual(os.stat(home).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual([n for n in os.listdir(home) if n.endswith(".tmp")], [])

    def test_garbage_never_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            for junk in ("", "not json", "[1, 2]", '{"rate_limits": 5}'):
                with self.subTest(junk=junk):
                    res = self.run_script(os.path.join(tmp, ".throwbacks"), junk)
                    self.assertEqual(res.returncode, 0)
                    self.assertEqual(res.stdout, "")
                    self.assertEqual(res.stderr, "")


if __name__ == "__main__":
    unittest.main()
