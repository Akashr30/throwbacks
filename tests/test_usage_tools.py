"""Tests for the usage meter's other tools in serve.py — Copilot CLI's quota,
Codex (its session files and its app-server), Google's agy CLI, and Cursor's
plan name — each against a made-up stand-in that speaks the tool's protocol,
so no real tool, login or network is ever used. Made-up numbers only.

    python3 -m unittest discover -s tests -p "test_*.py"
"""

import http.client
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_argv, sys.argv = sys.argv, ["serve.py"]
import serve  # noqa: E402
sys.argv = _argv

RESET_5H = 1893492000      # 2030-01-01T10:00:00Z
RESET_WEEK = 1893664800    # 2030-01-03T10:00:00Z

COMMON = r'''
import json, os, sys
here = os.environ["FAKE_TOOL_DIR"]
with open(os.path.join(here, "mode")) as f:
    mode = f.read().strip()
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(),
                        "node_options": os.environ.get("NODE_OPTIONS")}) + "\n")
'''

FAKE_COPILOT = COMMON + r'''
if mode == "exit":
    sys.exit(3)
inp, out = sys.stdin.buffer, sys.stdout.buffer
def read():
    head = b""
    while not head.endswith(b"\r\n\r\n"):
        c = inp.read(1)
        if not c:
            return None
        head += c
    size = int([l for l in head.split(b"\r\n") if l.lower().startswith(b"content-length")][0].split(b":")[1])
    return json.loads(inp.read(size))
def send(obj, split=False):
    data = json.dumps(obj).encode()
    frame = b"Content-Length: %d\r\n\r\n" % len(data) + data
    if split:  # one message across two writes
        out.write(frame[:9]); out.flush(); out.write(frame[9:])
    else:
        out.write(frame)
    out.flush()
QUOTAS = {
    "requests": {
        "premium_interactions": {"entitlementRequests": 300, "usedRequests": 124, "remainingPercentage": 58.67,
                                 "overage": 0, "overageAllowedWithExhaustedQuota": False, "resetDate": "2026-10-07T07:03:11Z"},
        "chat": {"entitlementRequests": -1, "usedRequests": 0, "remainingPercentage": 100},
        "completions": {"entitlementRequests": 0, "usedRequests": 0, "remainingPercentage": 100},
    },
    "credits": {
        "premium_interactions": {"entitlementRequests": 3000, "usedRequests": 3000, "remainingPercentage": 0, "overage": 739.5,
                                 "tokenBasedBilling": True, "isUnlimitedEntitlement": False, "hasQuota": False},
    },
    "pooled": {
        "premium_interactions": {"entitlementRequests": 0, "usedRequests": 0, "remainingPercentage": 100, "tokenBasedBilling": True},
        "chat": {"isUnlimitedEntitlement": True, "entitlementRequests": 0},
    },
}
while True:
    m = read()
    if m is None:
        break
    if mode == "hang":
        continue
    rid, method = m.get("id"), m.get("method")
    send({"jsonrpc": "2.0", "method": "session.log", "params": {"note": "a notification first"}})
    if method == "ping":
        send({"jsonrpc": "2.0", "id": rid, "result": {"message": "pong", "timestamp": 1, "protocolVersion": 1 if mode == "oldproto" else 3}}, split=True)
    elif method == "account.getQuota":
        if mode == "noauth":
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "Request account.getQuota failed with message: Not authenticated. Please authenticate first."}})
        elif mode == "nomethod":
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Unhandled method account.getQuota"}})
        else:
            send({"jsonrpc": "2.0", "id": rid, "result": {"quotaSnapshots": QUOTAS[mode]}})
'''

FAKE_CODEX = COMMON + r'''
if mode == "exit":
    sys.exit(3)
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
window = lambda pct, mins, reset: {"usedPercent": pct, "windowDurationMins": mins, "resetsAt": reset}
MAIN = {"limitId": "codex", "limitName": None, "primary": window(12, 300, 1893492000), "secondary": window(48, 10080, 1893664800),
        "credits": {"hasCredits": False, "unlimited": False, "balance": None}, "planType": "plus"}
SPARK = {"limitId": "codex_bengalfox", "limitName": "GPT-5.3-Codex-Spark", "primary": window(5, 300, 1893492000), "secondary": None}
inited = initialized = False
for line in sys.stdin:
    m = json.loads(line)
    rid, method = m.get("id"), m.get("method")
    if method == "initialize":
        inited = True
        send({"id": rid, "result": {"userAgent": "codex/0.162", "codexHome": "/x", "platformFamily": "unix", "platformOS": "macos"}})
        continue
    if method == "initialized":
        initialized = True
        send({"method": "account/updated", "params": {}})
        continue
    if not (inited and initialized):
        send({"id": rid, "error": {"code": -32600, "message": "Not initialized"}})
        continue
    if method == "account/rateLimits/read":
        if mode == "nomethod":
            send({"id": rid, "error": {"code": -32601, "message": "Method not found: account/rateLimits/read"}})
        elif mode == "apikey":
            send({"id": rid, "result": {"rateLimits": None, "rateLimitsByLimitId": None}})
        elif mode == "old":
            send({"id": rid, "result": {"rateLimits": {"primary": window(30, 300, 1893492000), "secondary": window(60, 10080, 1893664800)}}})
        else:
            send({"id": rid, "result": {"ordinaryUsageAllowed": True, "accountId": "acct-made-up", "rateLimitUpsell": {"x": 1},
                                         "rateLimits": MAIN, "rateLimitsByLimitId": {"codex": MAIN, "codex_bengalfox": SPARK}}})
'''

FAKE_AGY = COMMON + r'''
if "--version" in sys.argv:
    print({"old": "agy 1.1.10", "nover": "agy dev build"}.get(mode, "agy 1.3.1"))
    sys.exit(0)
ROWS = ("Gemini Models\tWeekly Limit Remaining\t60%\t2030-01-03T10:00:00Z\n"
        "Gemini Models\t5h Limit Remaining\t90%\t2030-01-01T10:00:00Z\n"
        "Claude and GPT models\tWeekly Limit Remaining\t100%\t2030-01-03T10:00:00Z\n"
        "Claude and GPT models\t5h Limit Remaining\t75.5%\t2030-01-01T10:00:00Z\n"
        "not a row")
if sys.argv[1:] == ["-p", "/usage"]:
    if mode == "model":
        print("Here is a summary of your usage: you have plenty left this week.")
    elif mode == "signedout":
        sys.stderr.write("Error: not signed in — run agy and sign in\n")
        sys.exit(1)
    elif mode == "empty":
        pass
    else:
        print(ROWS)
'''


def private_claude(test, folder):
    """Point the usage meter's Claude files at `folder` for one test: Claude Code's config
    (~/.claude.json, settings.json), Claude desktop's folder, the status line's and the
    switches' files — never the real ones on this Mac."""
    saved = {k: getattr(serve, k) for k in ("claude_desktop_dir", "USAGE_FILE", "USAGE_ASK_FILE")}
    conf = os.environ.get("CLAUDE_CONFIG_DIR")
    os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(folder, "claude")
    serve.claude_desktop_dir = lambda: os.path.join(folder, "claude-desktop")
    serve.USAGE_FILE = os.path.join(folder, "usage.json")
    serve.USAGE_ASK_FILE = os.path.join(folder, "usage-ask.json")

    def restore():
        for k, v in saved.items():
            setattr(serve, k, v)
        if conf is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = conf
    test.addCleanup(restore)


class Stand_in(unittest.TestCase):
    """A made-up tool on disk, its mode switchable, and its calls recorded."""

    script = ""
    attr = ""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.dir, ignore_errors=True))
        private_claude(self, self.dir)
        script = os.path.join(self.dir, "fake.py")
        with open(script, "w") as f:
            f.write(self.script)
        cli = os.path.join(self.dir, "tool")
        with open(cli, "w") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        os.chmod(cli, 0o755)
        self.cli = cli
        saved = {k: getattr(serve, k) for k in ("CLAUDE", "COPILOT_BIN", "CODEX_BIN", "AGY_BIN", "USAGE_ASK_FILE")}
        saved_ask = dict(serve._ASK)
        serve.USAGE_ASK_FILE = os.path.join(self.dir, "usage-ask.json")
        serve._ASK.clear()
        saved_live = {k: dict(v) for k, v in serve._LIVE.items()}
        saved_refused = dict(serve._AGY_REFUSED)
        if self.attr:
            setattr(serve, self.attr, cli)
        for slot in serve._LIVE.values():
            slot.update(reading=None, ran=0.0)
        serve._AGY_REFUSED["why"] = None

        def restore():
            for k, v in saved.items():
                setattr(serve, k, v)
            for k, v in saved_live.items():
                serve._LIVE[k].update(v)
            serve._AGY_REFUSED.update(saved_refused)
            serve._ASK.clear()
            serve._ASK.update(saved_ask)
        self.addCleanup(restore)
        old = os.environ.get("FAKE_TOOL_DIR")
        os.environ["FAKE_TOOL_DIR"] = self.dir
        self.addCleanup(lambda: os.environ.pop("FAKE_TOOL_DIR") if old is None else os.environ.__setitem__("FAKE_TOOL_DIR", old))
        self.mode("ok")

    def mode(self, m):
        with open(os.path.join(self.dir, "mode"), "w") as f:
            f.write(m)

    def calls(self):
        try:
            with open(os.path.join(self.dir, "calls.jsonl")) as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []


class CopilotProblemTests(unittest.TestCase):
    def test_a_403_is_no_copilot_not_no_login(self):
        problem = lambda message: serve._copilot_problem(serve.RpcError({"message": message}))["error"]
        self.assertEqual(problem("Failed to fetch Copilot user info: 403 Forbidden"), "no_access",
                         "logged in, but the account has no Copilot: logging in again wouldn't help")
        for message in ("Not authenticated. Please authenticate first.", "No authentication token available.", "HTTP 401 Bad credentials"):
            self.assertEqual(problem(message), "no_login", message)


class CopilotTests(Stand_in):
    script, attr = FAKE_COPILOT, "COPILOT_BIN"

    def test_the_monthly_allowance_and_only_numbers(self):
        self.mode("requests")
        now = int(time.time())
        got = serve.copilot_usage_ask()
        self.assertEqual(set(got), {"at", "windows", "pooled", "unlimited"})
        (w,) = got["windows"]
        self.assertEqual({k: w[k] for k in ("kind", "pct", "limit", "used")}, {"kind": "premium", "pct": 41.33, "limit": 300.0, "used": 124.0})
        self.assertNotIn("unit", w, "this CLI doesn't say whether it counts requests or credits")
        self.assertEqual(w["resets_at"], serve._next_month_utc(now), "the reset is 00:00 UTC on the 1st, not the CLI's resetDate")
        self.assertEqual(got["unlimited"], ["chat"])
        self.assertFalse(got["pooled"])

    def test_ai_credits_over_the_allowance(self):
        self.mode("credits")
        (w,) = serve.copilot_usage_ask()["windows"]
        self.assertEqual((w["pct"], w["unit"], w["overage"]), (100.0, "credits", 739.5))

    def test_a_pooled_allowance_has_no_per_person_number(self):
        self.mode("pooled")
        got = serve.copilot_usage_ask()
        self.assertEqual((got["windows"], got["pooled"], got["unlimited"]), ([], True, ["chat"]))

    def test_runs_locked_down(self):
        os.environ["NODE_OPTIONS"] = "--inspect"
        self.addCleanup(os.environ.pop, "NODE_OPTIONS", None)
        self.mode("requests")
        serve.copilot_usage_ask()
        (call,) = self.calls()
        argv = call["argv"]
        self.assertEqual(argv[:3], ["--headless", "--stdio", "--no-auto-update"])
        self.assertEqual(argv[argv.index("--log-level") + 1], "error")
        log_dir = argv[argv.index("--log-dir") + 1]
        self.assertTrue(os.path.realpath(log_dir).startswith(os.path.realpath(call["cwd"])),
                        "its log goes in its own temp folder, not ~/.copilot/logs")
        self.assertTrue(os.path.basename(call["cwd"]).startswith("throwbacks-copilot-"))
        self.assertFalse(os.path.exists(call["cwd"]), "and that folder is removed afterwards")
        self.assertIsNone(call["node_options"], "Node's debug switches would write into the JSON-RPC channel")

    def test_what_goes_wrong_is_named(self):
        for mode, error in (("noauth", "no_login"), ("nomethod", "unsupported"), ("oldproto", "unsupported"), ("exit", "no_answer")):
            self.mode(mode)
            got = serve.copilot_usage_ask(timeout=10)
            self.assertEqual(got.get("error"), error, mode)
            self.assertNotIn("windows", got)
        self.mode("hang")
        self.assertEqual(serve.copilot_usage_ask(timeout=1)["error"], "timeout")
        serve.COPILOT_BIN = os.path.join(self.dir, "missing")
        saved, serve.COPILOT_PATHS = serve.COPILOT_PATHS, ()
        self.addCleanup(setattr, serve, "COPILOT_PATHS", saved)
        self.assertEqual(serve.copilot_usage_ask()["error"], "no_cli")


class CodexLiveTests(Stand_in):
    script, attr = FAKE_CODEX, "CODEX_BIN"

    def test_every_limit_after_the_handshake(self):
        got = serve.codex_usage_ask()
        self.assertEqual(set(got), {"at", "plan", "windows"}, "no account id, email or upsell")
        self.assertEqual(got["plan"], "plus")
        self.assertEqual([(w["kind"], w.get("name"), w["pct"], w["resets_at"]) for w in got["windows"]], [
            ("session", None, 12.0, RESET_5H), ("weekly_all", None, 48.0, RESET_WEEK),
            ("session_scoped", "GPT-5.3-Codex-Spark", 5.0, RESET_5H)])
        (call,) = self.calls()
        self.assertEqual(call["argv"], ["app-server"])
        self.assertFalse(os.path.exists(call["cwd"]))

    def test_an_older_app_server(self):
        self.mode("old")
        self.assertEqual([(w["kind"], w["pct"]) for w in serve.codex_usage_ask()["windows"]], [("session", 30.0), ("weekly_all", 60.0)])

    def test_what_goes_wrong_is_named(self):
        for mode, error in (("apikey", "no_plan"), ("nomethod", "unsupported"), ("exit", "no_answer")):
            self.mode(mode)
            self.assertEqual(serve.codex_usage_ask(timeout=10).get("error"), error, mode)


class AgyTests(Stand_in):
    script, attr = FAKE_AGY, "AGY_BIN"

    def test_its_usage_panel(self):
        got = serve.agy_usage_ask()
        self.assertEqual(set(got), {"at", "windows"})
        self.assertEqual([(w["kind"], w["name"], w["pct"], w["resets_at"]) for w in got["windows"]], [
            ("weekly_scoped", "Gemini", 40.0, RESET_WEEK), ("session_scoped", "Gemini", 10.0, RESET_5H),
            ("weekly_scoped", "Claude & GPT", 0.0, RESET_WEEK), ("session_scoped", "Claude & GPT", 24.5, RESET_5H)])
        self.assertEqual([c["argv"] for c in self.calls()], [["--version"], ["-p", "/usage"]])

    def test_an_old_agy_is_never_asked(self):
        for mode in ("old", "nover"):
            self.mode(mode)
            self.assertEqual(serve.agy_usage_ask()["error"], "unsupported", mode)
        self.assertTrue(all(c["argv"] == ["--version"] for c in self.calls()), "/usage would go to the model and spend quota")

    def test_an_answer_that_isnt_usage_stops_all_asking(self):
        self.mode("model")
        self.assertEqual(serve.agy_usage_ask()["error"], "not_local")
        self.mode("ok")
        before = len(self.calls())
        self.assertEqual(serve.agy_usage_ask()["error"], "not_local")
        self.assertEqual(len(self.calls()), before, "not run again until the server restarts")

    def test_an_ordinary_failure_is_asked_again(self):
        self.mode("signedout")
        got = serve.agy_usage_ask()
        self.assertEqual(got["error"], "cli_error")
        self.assertIn("not signed in", got["detail"])
        self.mode("empty")
        self.assertEqual(serve.agy_usage_ask()["error"], "no_answer")
        self.assertIsNone(serve._AGY_REFUSED["why"], "a failure is not 'answered by the model'")
        self.mode("ok")
        self.assertIn("windows", serve.agy_usage_ask(), "asked again once it works")


class ProcessGroupTests(unittest.TestCase):
    """A timed-out tool dies with whatever it launched: an npm or nvm launcher
    runs the real CLI as a child that shares our pipes."""

    def test_a_stuck_child_behind_a_launcher(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        child = os.path.join(d, "child.py")
        with open(child, "w") as f:
            f.write("import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n")
        launcher = os.path.join(d, "launcher")
        with open(launcher, "w") as f:
            f.write(f'#!/bin/sh\n"{sys.executable}" "{child}"\n')  # not exec: the CLI runs as a child
        os.chmod(launcher, 0o755)
        rpc = serve.ToolRpc([launcher], "lsp", cwd=d, env=dict(os.environ))
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            rpc.request(1, "ping", {}, time.monotonic() + 0.5)
        saved = serve._stop
        serve._stop = lambda proc, wait=10: saved(proc, wait=0.5)
        self.addCleanup(setattr, serve, "_stop", saved)
        rpc.close()
        self.assertLess(time.monotonic() - start, 15, "close() doesn't wait for the stuck child")
        self.assertFalse(rpc.reader.is_alive(), "its output ended with it")

    def test_run_tool_kills_the_group_on_timeout(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        launcher = os.path.join(d, "launcher")
        with open(launcher, "w") as f:
            f.write(f'#!/bin/sh\n"{sys.executable}" -c "import time; time.sleep(60)"\n')
        os.chmod(launcher, 0o755)
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            serve._run_tool([launcher], 0.5)
        self.assertLess(time.monotonic() - start, 15)


def rollout_line(ts, limits, kind="token_count"):
    return json.dumps({"timestamp": ts, "type": "event_msg",
                       "payload": {"type": kind, "info": {"total_token_usage": {"total_tokens": 9}}, "rate_limits": limits}})


class CodexSessionTests(unittest.TestCase):
    """Codex's numbers from its own session files: every shape it has
    written, the newest snapshot per limit, no network and nothing run."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.home, ignore_errors=True))
        private_claude(self, os.path.join(self.home, "elsewhere"))
        old = os.environ.get("CODEX_HOME")
        os.environ["CODEX_HOME"] = self.home
        self.addCleanup(lambda: os.environ.pop("CODEX_HOME") if old is None else os.environ.__setitem__("CODEX_HOME", old))
        serve._CODEX_CACHE.clear()

    def write(self, rel, lines, mtime=None):
        path = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        if mtime:
            os.utime(path, (mtime, mtime))
        return path

    def test_the_newest_snapshot_per_limit(self):
        main = {"limit_id": "codex", "limit_name": None, "plan_type": "plus",
                "primary": {"used_percent": 12.5, "window_minutes": 300, "resets_at": RESET_5H},
                "secondary": {"used_percent": 48.0, "window_minutes": 10080, "resets_at": RESET_WEEK}}
        spark = {"limit_id": "codex_bengalfox", "limit_name": "GPT-5.3-Codex-Spark",
                 "primary": {"used_percent": 3.0, "window_minutes": 300, "resets_at": RESET_5H}, "secondary": None}
        self.write("sessions/2026/10/05/rollout-2026-10-05T09-00-00-a.jsonl", [
            json.dumps({"timestamp": "2026-10-05T09:00:00Z", "type": "session_meta", "payload": {"id": "a", "cwd": "/x"}}),
            rollout_line("2026-10-05T09:01:00Z", {**main, "primary": {"used_percent": 99, "window_minutes": 300, "resets_at": RESET_5H}}),
        ], mtime=time.time() - 3600)
        self.write("sessions/2026/10/06/rollout-2026-10-06T09-00-00-b.jsonl", [
            rollout_line("2026-10-06T09:00:00Z", None),
            rollout_line("2026-10-06T09:05:00Z", main),
            rollout_line("2026-10-06T09:06:00Z", spark),
            json.dumps({"timestamp": "2026-10-06T09:07:00Z", "type": "response_item", "payload": {"type": "message"}}),
            "{not json",
        ])
        self.write("sessions/2026/10/06/rollout-2026-10-06T10-00-00-c.jsonl.zst", ["compressed bytes"])
        got = serve.codex_usage_local()
        self.assertEqual(got["at"], serve._epoch("2026-10-06T09:05:00Z"), "the main limit's own time")
        self.assertEqual(got["plan"], "plus")
        self.assertEqual([(w["kind"], w.get("name"), w["pct"]) for w in got["windows"]], [
            ("session", None, 12.5), ("weekly_all", None, 48.0), ("session_scoped", "GPT-5.3-Codex-Spark", 3.0)])

    def test_a_resumed_session_in_an_older_folder(self):
        """Codex keeps writing a resumed session into its first day's folder."""
        old_limits = {"limit_id": "codex", "primary": {"used_percent": 1, "window_minutes": 300, "resets_at": RESET_5H}}
        for n in range(serve.CODEX_FILES + 2):
            self.write(f"sessions/2026/10/06/rollout-2026-10-06T0{n % 10}-00-00-n{n}.jsonl",
                       [rollout_line("2026-10-06T09:00:00Z", old_limits)], mtime=time.time() - 7200 - n)
        self.write("sessions/2026/09/20/rollout-2026-09-20T08-00-00-resumed.jsonl", [
            rollout_line("2026-10-06T10:00:00Z", {"limit_id": "codex", "primary": {"used_percent": 77, "window_minutes": 300, "resets_at": RESET_5H}})])
        self.assertEqual(serve.codex_usage_local()["windows"][0]["pct"], 77.0)

    def test_every_shape_codex_has_written(self):
        flat = {"primary_used_percent": 20, "secondary_used_percent": 70, "primary_window_minutes": 300, "secondary_window_minutes": 10080}
        relative = {"primary": {"used_percent": 30, "window_minutes": 300, "resets_in_seconds": 600},
                    "secondary": {"used_percent": 40, "window_minutes": 10080, "resets_in_seconds": 86400}}
        pro = {"limit_id": "codex", "primary": {"used_percent": 51, "window_minutes": 10080, "resets_at": RESET_WEEK}, "secondary": None}
        ts = "2026-10-06T09:00:00Z"
        for limits, want in ((flat, [("session", 20.0, None), ("weekly_all", 70.0, None)]),
                             (relative, [("session", 30.0, serve._epoch(ts) + 600), ("weekly_all", 40.0, serve._epoch(ts) + 86400)]),
                             (pro, [("weekly_all", 51.0, RESET_WEEK)])):
            serve._CODEX_CACHE.clear()
            self.write("sessions/2026/10/06/rollout-2026-10-06T09-00-00-x.jsonl", [rollout_line(ts, limits)])
            got = serve.codex_usage_local()
            self.assertEqual([(w["kind"], w["pct"], w["resets_at"]) for w in got["windows"]], want, limits)

    def test_archived_sessions_count_and_a_change_is_seen(self):
        path = self.write("archived_sessions/rollout-2026-09-30T08-00-00-z.jsonl", [
            rollout_line("2026-09-30T08:00:00Z", {"limit_id": "codex", "primary": {"used_percent": 7, "window_minutes": 300, "resets_at": RESET_5H}})])
        self.assertEqual(serve.codex_usage_local()["windows"][0]["pct"], 7.0)
        with open(path, "a") as f:
            f.write(rollout_line("2026-09-30T08:10:00Z", {"limit_id": "codex", "primary": {"used_percent": 9, "window_minutes": 300, "resets_at": RESET_5H}}) + "\n")
        self.assertEqual(serve.codex_usage_local()["windows"][0]["pct"], 9.0)

    def test_the_sample_reads_no_app_files(self):
        self.write("sessions/2026/10/06/rollout-2026-10-06T09-00-00-s.jsonl", [
            rollout_line("2026-10-06T09:00:00Z", {"limit_id": "codex", "primary": {"used_percent": 7, "window_minutes": 300, "resets_at": RESET_5H}})])
        self.assertIsNotNone(serve.usage_status()["plans"]["chatgpt"]["local"])
        reads = []
        real_open = open
        def watched(path, *a, **k):
            reads.append(str(path))
            return real_open(path, *a, **k)
        import builtins
        builtins.open = watched
        try:
            got = serve.usage_status(read_apps=False)
        finally:
            builtins.open = real_open
        self.assertEqual((got["plans"], got["reading"], got["live"]["enabled"], got.get("sample")), ({}, None, False, True))
        self.assertFalse(got["configured"], "Claude Code's settings aren't read either")
        self.assertFalse([r for r in reads if r.startswith(self.home) or r.endswith("settings.json")
                          or r.endswith(".claude.json") or r.endswith("plan-usage-history.json")], reads)

    def test_nothing_there(self):
        self.assertIsNone(serve.codex_usage_local())
        self.write("sessions/2026/10/06/rollout-2026-10-06T09-00-00-y.jsonl", [rollout_line("2026-10-06T09:00:00Z", None)])
        self.assertIsNone(serve.codex_usage_local())


class CursorPlanTests(unittest.TestCase):
    """Cursor's plan name, read by one exact key — its sign-in rows never."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        saved = serve.app_user_dir
        serve.app_user_dir = lambda app: os.path.join(self.tmp, app, "User")
        self.addCleanup(setattr, serve, "app_user_dir", saved)
        self.db = os.path.join(self.tmp, "Cursor", "User", "globalStorage", "state.vscdb")

    def make(self, rows):
        os.makedirs(os.path.dirname(self.db), exist_ok=True)
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        con.executemany("INSERT INTO ItemTable VALUES (?, ?)", rows)
        con.commit()
        con.close()

    def test_the_plan_and_nothing_else(self):
        self.make([("cursorAuth/stripeMembershipType", "pro_plus"), ("cursorAuth/accessToken", "made-up-token"),
                   ("cursorAuth/cachedEmail", "someone@example.com")])
        statements = []
        real = sqlite3.connect

        def traced(*a, **k):
            con = real(*a, **k)
            con.set_trace_callback(statements.append)
            return con
        serve.sqlite3.connect = traced
        self.addCleanup(setattr, serve.sqlite3, "connect", real)
        got = serve.cursor_plan_local()
        self.assertEqual(set(got), {"plan", "signedOut", "seenAt"})
        self.assertEqual((got["plan"], got["signedOut"]), ("pro_plus", False))
        self.assertNotIn("example.com", json.dumps(got), "only the email's length is read")
        self.assertTrue(statements and all("accessToken" not in s and "LIKE" not in s.upper() for s in statements), statements)

    def test_signed_out_is_not_free(self):
        self.make([("cursorAuth/stripeMembershipType", "free"), ("cursorAuth/cachedEmail", "")])
        self.assertEqual({k: serve.cursor_plan_local()[k] for k in ("plan", "signedOut")}, {"plan": None, "signedOut": True})

    def test_no_cursor_and_odd_values(self):
        self.assertIsNone(serve.cursor_plan_local())
        self.make([("cursorAuth/stripeMembershipType", '"Pro"'), ("cursorAuth/cachedEmail", "x")])
        self.assertEqual(serve.cursor_plan_local()["plan"], "pro")
        os.remove(self.db)
        self.make([("cursorAuth/stripeMembershipType", "<script>"), ("cursorAuth/cachedEmail", "x")])
        self.assertIsNone(serve.cursor_plan_local()["plan"])


class QuietHandler(serve.Handler):
    def log_message(self, fmt, *args):
        pass


class RouteTests(Stand_in):
    """POST /api/usage/refresh asks one tool, and only with --claude."""
    script, attr = FAKE_COPILOT, "COPILOT_BIN"

    def setUp(self):
        super().setUp()
        self.mode("requests")
        self.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, body, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        try:
            data = json.dumps(body).encode()
            conn.request("POST", "/api/usage/refresh", body=data,
                         headers=headers if headers is not None else {"X-Throwbacks": "1", "Content-Type": "application/json"})
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def test_one_tool_at_a_time(self):
        self.assertEqual(self.post({"tool": "copilot"}, headers={})[0], 403)
        self.assertEqual(self.post({"tool": "nope"})[0], 400)
        serve.CLAUDE = False
        code, got = self.post({"tool": "copilot"})
        self.assertEqual((code, got["plans"]["copilot"]["reading"], got["plans"]["copilot"]["enabled"]), (200, None, False))
        self.assertEqual(self.calls(), [], "without --claude no tool is run")
        serve.CLAUDE = True
        code, got = self.post({"tool": "copilot"})
        self.assertEqual(code, 200)
        self.assertEqual(got["plans"]["copilot"]["reading"]["windows"][0]["pct"], 41.33)
        self.assertIsNone(got["live"]["reading"], "asking Copilot doesn't run Claude Code")
        self.assertEqual(len(self.calls()), 1)
        self.post({"tool": "copilot"})
        self.assertEqual(len(self.calls()), 1, "at most once a minute")


class AskSwitchTests(RouteTests):
    """The switches live on the server: a tool turned off is never run, and its old answer is forgotten."""

    def post_to(self, path, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=30)
        try:
            conn.request("POST", path, body=json.dumps(body).encode(), headers={"X-Throwbacks": "1", "Content-Type": "application/json"})
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def test_one_tool_at_a_time(self):
        pass  # covered by RouteTests

    def test_off_means_never_run(self):
        serve.CLAUDE = True
        self.assertEqual(self.post({"tool": "copilot"})[1]["plans"]["copilot"]["reading"]["windows"][0]["pct"], 41.33)
        self.assertEqual(self.post_to("/api/usage/ask", {"tool": "copilot", "on": "yes"})[0], 400)
        code, got = self.post_to("/api/usage/ask", {"tool": "copilot", "on": False})
        self.assertEqual((code, got["ask"]["copilot"], got["plans"]["copilot"]["reading"]), (200, False, None))
        serve._LIVE["copilot"]["ran"] = 0.0
        self.post({"tool": "copilot"})
        self.assertEqual(len(self.calls()), 1, "turned off: not run")
        with open(serve.USAGE_ASK_FILE) as f:
            self.assertFalse(json.load(f)["copilot"])
        self.assertEqual(os.stat(serve.USAGE_ASK_FILE).st_mode & 0o777, 0o600)
        serve._ASK.clear()  # as after a restart
        self.assertFalse(serve.usage_asks()["copilot"], "the choice survives a restart")
        self.post_to("/api/usage/ask", {"tool": "copilot", "on": True})
        self.post({"tool": "copilot"})
        self.assertEqual(len(self.calls()), 2)


if __name__ == "__main__":
    unittest.main()
