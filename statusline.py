#!/usr/bin/env python3
"""Throwbacks' usage meter, as a Claude Code status line.

Claude Code runs this after each reply and hands it the session's status
JSON on stdin. Its `rate_limits` hold your plan's usage: the 5-hour session
and the 7-day window, each as `used_percentage` and `resets_at` (Unix
seconds) — the same numbers /usage shows. This keeps ONLY those numbers
(plus when it saw them), saves them to ~/.throwbacks/usage.json for the
Throwbacks app to read, and prints one line for the terminal:

    Session 42% · resets 19:05   Week 31% · resets Mon 09:00

It reads nothing else, sends nothing anywhere, never touches your login and
uses no tokens. Turn it on with this in ~/.claude/settings.json:

    "statusLine": {"type": "command", "command": "python3 /path/to/statusline.py"}

Several Claude Code windows can run it at once: an idle window passes on
the numbers from its own last reply, so within one window (same reset time)
usage only ever goes up — the higher reading wins — and a later reset time
means a new window. Writes are atomic and serialized with a lock.
"""

import contextlib
import json
import os
import sys
import tempfile
import time

WINDOWS = (("five_hour", "Session"), ("seven_day", "Week"))
SAME_WINDOW_S = 15 * 60      # reset times this close are the same window
NOTE_EVERY_S = 10 * 60       # "seen" / "missing" notes are refreshed at most this often


def home():
    return os.environ.get("THROWBACKS_HOME") or os.path.join(os.path.expanduser("~"), ".throwbacks")


def usage_path():
    return os.path.join(home(), "usage.json")


def _window(obj):
    """A valid {used_percentage, resets_at} pair, or None."""
    if not isinstance(obj, dict):
        return None
    pct, reset = obj.get("used_percentage"), obj.get("resets_at")
    if isinstance(pct, bool) or isinstance(reset, bool):
        return None
    if not isinstance(pct, (int, float)) or not isinstance(reset, (int, float)):
        return None
    if not 0 <= pct <= 1000 or reset <= 0:
        return None
    return {"used_percentage": round(float(pct), 2), "resets_at": int(reset)}


def read_saved(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def merge(saved, payload, now):
    """The new saved reading from the old one and a status payload."""
    out = {"v": 1}
    for key in ("at", "seen_at", "missing_at"):
        if isinstance(saved.get(key), (int, float)) and not isinstance(saved.get(key), bool):
            out[key] = int(saved[key])
    limits = payload.get("rate_limits") if isinstance(payload, dict) else None
    limits = limits if isinstance(limits, dict) else {}
    changed = False
    for key, _ in WINDOWS:
        old, new = _window(saved.get(key)), _window(limits.get(key))
        keep = old
        if new and (old is None or new["resets_at"] > old["resets_at"] + SAME_WINDOW_S):
            keep = new                       # a first reading, or a new window
        elif new and abs(new["resets_at"] - old["resets_at"]) <= SAME_WINDOW_S \
                and new["used_percentage"] > old["used_percentage"]:
            keep = {**new, "resets_at": max(new["resets_at"], old["resets_at"])}
        # (a lower number in the same window, or an older window: stale — ignored)
        if keep != old:
            changed = True
        out[key] = keep
    if changed:
        out["at"] = int(now)
    if now - out.get("seen_at", 0) >= NOTE_EVERY_S:
        out["seen_at"] = int(now)
    # Claude Code answered but reported no plan usage: an API-key login, or
    # a plan whose numbers it doesn't pass on.
    cost = payload.get("cost") if isinstance(payload, dict) else None
    replied = isinstance(cost, dict) and (cost.get("total_api_duration_ms") or 0) > 0
    if replied and not any(_window(limits.get(k)) for k, _ in WINDOWS) \
            and now - out.get("missing_at", 0) >= NOTE_EVERY_S:
        out["missing_at"] = int(now)
    return out


def write_atomic(path, data):
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".usage-", suffix=".tmp", dir=folder)  # created 0600
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def update(payload, now):
    """Fold one payload into the saved reading (under a lock); return it."""
    path = usage_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    lock = os.fdopen(os.open(os.path.join(os.path.dirname(path), ".usage.lock"), os.O_CREAT | os.O_RDWR, 0o600), "r+")
    try:
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        saved = read_saved(path)
        merged = merge(saved, payload, now)
        if merged != {**saved, "v": 1}:
            write_atomic(path, merged)
        return merged
    finally:
        lock.close()


def _clock(ts, now):
    t = time.localtime(ts)
    if time.strftime("%Y-%m-%d", t) == time.strftime("%Y-%m-%d", time.localtime(now)):
        return time.strftime("%H:%M", t)
    if ts - now < 6 * 86400:
        return time.strftime("%a %H:%M", t)
    return time.strftime("%d %b", t).lstrip("0")


def line(reading, now, color=True):
    """The terminal's status line: each window still running, else ''."""
    parts = []
    for key, label in WINDOWS:
        w = _window(reading.get(key))
        if not w or w["resets_at"] <= now:
            continue
        pct = w["used_percentage"]
        text = f"{label} {round(pct)}% · resets {_clock(w['resets_at'], now)}"
        if color and pct >= 80:
            text = f"\033[{'31' if pct >= 95 else '33'}m{text}\033[0m"
        parts.append(text)
    return "   ".join(parts)


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except (OSError, ValueError):
        payload = {}
    now = int(os.environ.get("THROWBACKS_NOW") or time.time())
    try:
        reading = update(payload, now)
    except OSError:
        reading = merge({}, payload, now)
    text = line(reading, now)
    if text:
        print(text)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # a status line must never break Claude Code's footer
        pass
