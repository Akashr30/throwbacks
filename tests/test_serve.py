"""Tests for serve.py: the /api guard, static-file safety, the app-icon
route, the Daily log's summary store, and the Claude Code / icon helpers. Uses made-up files only (the
status route reads this machine's app folders, but only counts them).

    python3 -m unittest discover -s tests -p "test_*.py"
"""

import contextlib
import email.message
import gzip
import http.client
import json
import os
import struct
import sys
import tempfile
import threading
import time
import subprocess
import types
import unittest
import unittest.mock
from urllib.parse import quote

sys.dont_write_bytecode = True  # no __pycache__ next to serve.py
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_argv, sys.argv = sys.argv, ["serve.py"]  # serve.py reads its flags at import
import serve  # noqa: E402
sys.argv = _argv


class QuietHandler(serve.Handler):
    def log_message(self, fmt, *args):
        pass


class SourceTests(unittest.TestCase):
    """/api/source and /api/reveal: where a chat lives. The page names a chat —
    its app and its own ID — and the server finds the file itself under that
    app's folders (made-up ones here); Show in Finder runs `open -R` on that
    file and never on a path it's sent. Finder is stubbed: nothing opens."""

    ID = "7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47"
    GONE = "eeeeeeee-1111-4222-8333-444444444444"   # deleted by Claude Code, kept by Throwbacks
    CW = "a1b2c3d4-0000-4000-8000-000000000001"
    CP = "9f8e7d6c-1111-4222-8333-444455556666"
    CP2 = "9f8e7d6c-1111-4222-8333-777788889999"
    OLD = "11112222-3333-4444-8555-666677778888"     # an old Copilot CLI session: only in session-store.db
    CU = "3e1c2b7a-aaaa-4bbb-8ccc-ddddeeeeffff"

    @classmethod
    def setUpClass(cls):
        import sqlite3
        cls.tmp = tempfile.TemporaryDirectory()
        t = cls.tmp.name
        cls._saved = (os.environ.get("CLAUDE_CONFIG_DIR"), serve.KEEP_DIR, serve.claude_desktop_dir,
                      serve.app_user_dir, serve.copilot_cli_dir)

        def touch(path, text="{}", age=0):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
            if age:
                os.utime(path, (time.time() - age, time.time() - age))
            return path

        conf = os.path.join(t, "claude")
        cls.code = touch(os.path.join(conf, "projects", "-new", cls.ID + ".jsonl"))
        touch(os.path.join(conf, "projects", "-old", cls.ID + ".jsonl"), age=3600)  # the same id twice: the newest
        cls.kept = touch(os.path.join(t, "kept", cls.GONE + ".jsonl.gz"))
        lams = os.path.join(t, "desktop", "local-agent-mode-sessions", "acct", "org")
        touch(os.path.join(lams, "local_0.json"), json.dumps({"title": "Older copy", "cliSessionId": cls.CW}))
        touch(os.path.join(lams, "local_0", ".claude", "projects", "p", cls.CW + ".jsonl"), age=3600)  # the same chat, older
        touch(os.path.join(lams, "local_1.json"), json.dumps({"title": "Newer copy", "cliSessionId": cls.CW}))
        cls.cowork = touch(os.path.join(lams, "local_1", ".claude", "projects", "p", cls.CW + ".jsonl"))
        user = lambda app: os.path.join(t, "apps", app, "User")  # noqa: E731
        touch(os.path.join(user("Code"), "workspaceStorage", "h1", "chatSessions", cls.CP + ".json"))
        cls.copilot = touch(os.path.join(user("Code"), "workspaceStorage", "h1", "chatSessions", cls.CP + ".jsonl"), age=60)
        cls.copilot2 = touch(os.path.join(user("Code - Insiders"), "globalStorage", "emptyWindowChatSessions", cls.CP2 + ".json"))
        cls.cursor = os.path.join(user("Cursor"), "globalStorage", "state.vscdb")
        os.makedirs(os.path.dirname(cls.cursor))
        with contextlib.closing(sqlite3.connect(cls.cursor)) as db:  # one database for every chat
            db.execute("CREATE TABLE cursorDiskKV (key TEXT, value BLOB)")
            db.execute("INSERT INTO cursorDiskKV VALUES (?, '{}')", (f"composerData:{cls.CU}",))
            db.commit()
        cli = os.path.join(t, "copilot")
        cls.cli = touch(os.path.join(cli, "session-state", cls.ID, "events.jsonl"))
        cls.store = os.path.join(cli, "session-store.db")
        with contextlib.closing(sqlite3.connect(cls.store)) as db:
            db.execute("CREATE TABLE sessions (id TEXT, cwd TEXT, summary TEXT)")
            db.execute("INSERT INTO sessions VALUES (?, '/x', 'old')", (cls.OLD,))
            db.commit()
        os.environ["CLAUDE_CONFIG_DIR"] = conf
        serve.KEEP_DIR = os.path.join(t, "kept")
        serve.claude_desktop_dir = lambda: os.path.join(t, "desktop")
        serve.app_user_dir = user
        serve.copilot_cli_dir = lambda: cli
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        conf, serve.KEEP_DIR, serve.claude_desktop_dir, serve.app_user_dir, serve.copilot_cli_dir = cls._saved
        if conf is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = conf
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=json.dumps(body) if body is not None else None,
                         headers={"X-Throwbacks": "1", "Content-Type": "application/json"} if headers is None else headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def where(self, app, sid):
        return self.call("GET", f"/api/source?app={app}&id={sid}")

    def test_each_app_finds_its_chats_file(self):
        reveal = serve.can_reveal()
        cases = [
            ("code", self.ID, {"found": True, "kind": "file", "path": self.code}),  # the newest of two copies
            ("code", self.GONE, {"found": True, "kind": "file", "path": self.kept, "kept": True}),
            ("cowork", self.CW, {"found": True, "kind": "file", "path": self.cowork}),
            ("copilot", self.CP, {"found": True, "kind": "file", "path": self.copilot}),  # the log over the older snapshot
            ("copilot", self.CP2, {"found": True, "kind": "file", "path": self.copilot2}),  # Insiders, a window with no folder
            ("copilot-cli", self.ID, {"found": True, "kind": "file", "path": self.cli}),
            ("copilot-cli", self.OLD, {"found": True, "kind": "database", "path": self.store, "key": self.OLD}),
            ("cursor", self.CU, {"found": True, "kind": "database", "path": self.cursor, "key": f"composerData:{self.CU}"}),
        ]
        for app, sid, want in cases:
            with self.subTest(app=app, sid=sid):
                self.assertEqual(self.where(app, sid), (200, {**want, "reveal": reveal}))

    def test_the_page_and_the_file_line_agree_on_a_chat_stored_twice(self):
        # The importer reads the newest copy of a chat's file, as the file line does.
        code = [f["project"] for f in serve.collect_claude_code()["files"] if f["name"] == self.ID + ".jsonl"]
        self.assertEqual(code, ["-new"])
        self.assertEqual(os.path.basename(os.path.dirname(self.code)), "-new")
        cowork = [x["title"] for x in serve.collect_cowork()["sessions"] if x["name"] == self.CW + ".jsonl"]
        self.assertEqual(cowork, ["Newer copy"])  # local_1's copy: the one /api/source names

    def test_unknown_chat(self):
        for app in ("code", "cowork", "copilot", "copilot-cli", "cursor"):
            with self.subTest(app=app):
                self.assertEqual(self.where(app, "ffffffff-1111-4222-8333-444444444444")[1]["found"], False)

    def test_only_an_app_and_a_file_name_stem(self):
        for q in ("app=code&id=../../etc/passwd", "app=code&id=a/b", "app=code&id=*", "app=code&id=%2A",
                  "app=code&id=.hidden", f"app=code&id={self.ID}%0a", "app=code&id=", f"app=web&id={self.ID}",
                  f"app=bash&id={self.ID}", "app=code", f"id={self.ID}", "app=code&id=" + "a" * 201):
            with self.subTest(q=q):
                self.assertEqual(self.call("GET", "/api/source?" + q)[0], 400)

    def test_guarded_and_off_with_no_import(self):
        self.assertEqual(self.call("GET", f"/api/source?app=code&id={self.ID}", headers={})[0], 403)
        self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": self.ID}, headers={"Content-Type": "application/json"})[0], 403)
        old, serve.IMPORT = serve.IMPORT, False
        try:
            self.assertEqual(self.where("code", self.ID)[0], 404)
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": self.ID})[0], 404)
        finally:
            serve.IMPORT = old

    def test_show_in_finder_shows_the_chats_own_file_only(self):
        ran = []
        done = types.SimpleNamespace(returncode=0)
        with unittest.mock.patch.object(serve, "can_reveal", lambda: True), \
                unittest.mock.patch.object(serve.subprocess, "run", lambda args, **kw: ran.append(args) or done):
            # A path in the request is never used: the server finds the file itself.
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": self.ID, "path": "/etc/passwd"}),
                             (200, {"ok": True}))
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "cursor", "id": self.CU})[0], 200)
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": "ffffffff-1111-4222-8333-444444444444"})[0], 404)
            for bad in ({"app": "code", "id": "../x"}, {"app": "code"}, {"app": "web", "id": self.ID}, {"app": "code", "id": 5}, []):
                with self.subTest(bad=bad):
                    self.assertEqual(self.call("POST", "/api/reveal", bad)[0], 400)
        self.assertEqual(ran, [[serve.OPEN_BIN, "-R", self.code], [serve.OPEN_BIN, "-R", self.cursor]])

    def test_show_in_finder_on_a_mac_only(self):
        with unittest.mock.patch.object(serve, "can_reveal", lambda: False):
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": self.ID})[0], 501)
            self.assertEqual(self.where("code", self.ID)[1]["reveal"], False)

    def test_finder_failing_is_said(self):
        with unittest.mock.patch.object(serve, "can_reveal", lambda: True), \
                unittest.mock.patch.object(serve.subprocess, "run", lambda args, **kw: types.SimpleNamespace(returncode=1)):
            self.assertEqual(self.call("POST", "/api/reveal", {"app": "code", "id": self.ID})[0], 500)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", path, headers=headers or {})
            res = conn.getresponse()
            return res.status, res.getheader("Content-Type") or "", res.read()
        finally:
            conn.close()

    API = {"X-Throwbacks": "1"}

    def test_api_needs_the_app_header(self):
        self.assertEqual(self.get("/api/import/status")[0], 403)

    def test_api_answers_this_machines_tab(self):
        code, ctype, body = self.get("/api/import/status", self.API)
        self.assertEqual(code, 200)
        self.assertIn("application/json", ctype)
        status = json.loads(body)
        for key in ("enabled", "claudeCode", "copilot", "cursor", "copilotCli", "cowork", "later", "icons"):
            self.assertIn(key, status)

    def test_api_refuses_other_origins(self):
        for origin in ("http://evil.example", f"http://127.0.0.1:{self.port}.evil.example", "null"):
            with self.subTest(origin=origin):
                self.assertEqual(self.get("/api/import/status", {**self.API, "Origin": origin})[0], 403)

    def test_api_refuses_dns_rebinding(self):
        self.assertEqual(self.get("/api/import/status", {**self.API, "Host": f"evil.example:{self.port}"})[0], 403)

    def test_api_refuses_cross_site_fetches(self):
        self.assertEqual(self.get("/api/import/status", {**self.API, "Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_icon_route_only_serves_known_apps(self):
        for app in ("../../etc/passwd", "", "Claude.app", "vscode/../../x"):
            with self.subTest(app=app):
                self.assertEqual(self.get(f"/api/app-icon?app={app}", self.API)[0], 404)

    def test_icon_route_serves_png_only(self):
        code, ctype, body = self.get("/api/app-icon?app=claude", self.API)
        if code == 404:
            self.skipTest("Claude desktop isn't installed here")
        self.assertEqual((code, ctype), (200, "image/png"))
        self.assertTrue(body.startswith(serve.PNG_SIG))

    def test_unknown_api_route(self):
        self.assertEqual(self.get("/api/nope", self.API)[0], 404)

    def test_root_serves_the_app_even_with_a_query(self):
        for path in ("/", "/?r=1", "/#x"):
            with self.subTest(path=path):
                code, ctype, body = self.get(path)
                self.assertEqual(code, 200)
                self.assertIn("text/html", ctype)
                self.assertIn(b"<title>Throwbacks", body)

    def test_no_path_traversal(self):
        for path in ("/js/../serve.py", "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 403)

    def test_no_directory_listing(self):
        self.assertEqual(self.get("/js/")[0], 403)


class LogStoreTests(unittest.TestCase):
    """The Daily log's AI summaries: one JSON file per day / week, written
    only for this machine's tab, under date names only, private to the user."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._dirs, cls._store = serve.LOG_DIRS, serve.STORE
        serve.LOG_DIRS = {k: os.path.join(cls.tmp.name, k) for k in ("day", "week", "month", "period")}
        serve.STORE = True
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.LOG_DIRS, serve.STORE = cls._dirs, cls._store
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
            conn.request(method, path, body=data, headers={"X-Throwbacks": "1", **(headers or {})})
            res = conn.getresponse()
            raw = res.read()
            return res.status, (json.loads(raw) if raw[:1] == b"{" else raw)
        finally:
            conn.close()

    def test_needs_the_app_header(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/log-summaries")
        self.assertEqual(conn.getresponse().status, 403)
        conn.close()

    def test_round_trip(self):
        day = {"v": 1, "date": "2026-10-05", "chats": {"code:a": {"lines": ["Added retries"]}}}
        self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": "day", "key": "2026-10-05", "data": day})[0], 200)
        self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": "week", "key": "2026-09-28", "data": {"text": "A week"}})[0], 200)
        code, got = self.call("GET", "/api/log-summaries")
        self.assertEqual(code, 200)
        self.assertEqual(got["days"]["2026-10-05"], day)
        self.assertEqual(got["weeks"]["2026-09-28"], {"text": "A week"})
        self.assertEqual(self.call("DELETE", "/api/log-summaries?kind=day&key=2026-10-05")[0], 200)
        self.assertNotIn("2026-10-05", self.call("GET", "/api/log-summaries")[1]["days"])

    def test_files_are_private(self):
        for kind, key in (("day", "2026-10-04"), ("month", "2026-09"), ("period", "2026-08-03_2026-08-09")):
            with self.subTest(kind=kind):
                self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": kind, "key": key, "data": {"x": 1}})[0], 200)
                folder = serve.LOG_DIRS[kind]
                self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)
                self.assertEqual(os.stat(os.path.join(folder, key + ".json")).st_mode & 0o777, 0o600)
                self.assertEqual([n for n in os.listdir(folder) if n.endswith(".tmp")], [])
        self.call("DELETE", "/api/log-summaries?kind=month&key=2026-09")
        self.call("DELETE", "/api/log-summaries?kind=period&key=2026-08-03_2026-08-09")

    def test_month_and_period_round_trip(self):
        month = {"v": 1, "text": "A month of retries", "days": ["2026-10-05"]}
        period = {"v": 1, "text": "Two weeks", "from": "2026-10-01", "to": "2026-10-14"}
        self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": "month", "key": "2026-10", "data": month}),
                         (200, {"ok": True}))
        self.assertEqual(self.call("POST", "/api/log-summaries",
                                   {"kind": "period", "key": "2026-10-01_2026-10-14", "data": period}), (200, {"ok": True}))
        self.assertEqual(self.call("POST", "/api/log-summaries",
                                   {"kind": "period", "key": "2026-10-07_2026-10-07", "data": {"text": "One day"}})[0], 200)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, "month", "2026-10.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, "period", "2026-10-01_2026-10-14.json")))
        code, got = self.call("GET", "/api/log-summaries")
        self.assertEqual(code, 200)
        self.assertEqual(got["months"], {"2026-10": month})
        self.assertEqual(got["periods"], {"2026-10-01_2026-10-14": period, "2026-10-07_2026-10-07": {"text": "One day"}})
        self.assertNotIn("2026-10", got["days"])
        self.assertEqual(self.call("DELETE", "/api/log-summaries?kind=month&key=2026-10"), (200, {"ok": True}))
        self.assertEqual(self.call("DELETE", "/api/log-summaries?kind=period&key=2026-10-01_2026-10-14")[0], 200)
        self.assertEqual(self.call("DELETE", "/api/log-summaries?kind=period&key=2026-10-01_2026-10-14")[0], 200,
                         "deleting what's gone is fine")
        got = self.call("GET", "/api/log-summaries")[1]
        self.assertEqual(got["months"], {})
        self.assertEqual(got["periods"], {"2026-10-07_2026-10-07": {"text": "One day"}})
        self.call("DELETE", "/api/log-summaries?kind=period&key=2026-10-07_2026-10-07")

    def test_the_answer_always_has_four_buckets(self):
        empty = tempfile.mkdtemp(dir=self.tmp.name)
        saved = serve.LOG_DIRS
        serve.LOG_DIRS = {k: os.path.join(empty, k) for k in saved}  # none of the folders exists yet
        try:
            code, got = self.call("GET", "/api/log-summaries")
        finally:
            serve.LOG_DIRS = saved
        self.assertEqual(code, 200)
        self.assertEqual(set(got), {"days", "weeks", "months", "periods", "dir"})
        self.assertEqual({k: got[k] for k in ("days", "weeks", "months", "periods")},
                         {"days": {}, "weeks": {}, "months": {}, "periods": {}})

    def test_each_kind_has_its_own_key(self):
        bad = {
            "day": ["2026-02-30", "2026-13-01", "2026-10", "2026-10-05_2026-10-06", "2026-10-05\n", "٢٠٢٦-10-05"],
            "week": ["2026-10", "2026-02-29", "2026-W41"],
            "month": ["2026-13", "2026-00", "2026-1", "0000-01", "2026-10-05", "2026-10-01_2026-10-31", "../x",
                      "2026-10/../x", ".2026-10", "2026-10\n", "2026-10.json", "٢٠٢٦-10", ""],
            "period": ["2026-02-30_2026-03-01", "2026-10-14_2026-10-01", "2026-10-01", "2026-10", "2026-10-01-2026-10-14",
                       "2026-10-01_2026-10-14_2026-10-20", "2026-10-01_../x", "../2026-10-01_2026-10-14",
                       "2026-10-01_2026-13-01", "2026-10-01_2026-10-14\n", ""],
        }
        def files():
            return {k: sorted(os.listdir(d)) if os.path.isdir(d) else [] for k, d in serve.LOG_DIRS.items()}
        before = files(), sorted(os.listdir(self.tmp.name))
        for kind, keys in bad.items():
            for key in keys:
                with self.subTest(kind=kind, key=key):
                    code, got = self.call("POST", "/api/log-summaries", {"kind": kind, "key": key, "data": {}})
                    self.assertEqual(code, 400)
                    self.assertIn("day|week|month|period", got["error"])
                    code, got = self.call("DELETE", f"/api/log-summaries?kind={kind}&key={quote(key)}")
                    self.assertEqual(code, 400)
                    self.assertIn("day|week|month|period", got["error"])
        self.assertEqual((files(), sorted(os.listdir(self.tmp.name))), before, "nothing written anywhere")
        for kind, key in (("day", "2024-02-29"), ("week", "2026-10-05"), ("month", "2026-12"), ("month", "2026-01"),
                          ("period", "2025-12-29_2026-01-04")):
            with self.subTest(good=key):
                self.assertTrue(serve.log_key_ok(kind, key))
        self.assertFalse(serve.log_key_ok("year", "2026"))
        self.assertFalse(serve.log_key_ok(["month"], "2026-10"))
        self.assertFalse(serve.log_key_ok("month", 202610))

    def test_files_with_other_names_are_never_read(self):
        stray = {"month": ["2026-13", "2026-10-05", "notes"], "period": ["2026-10-14_2026-10-01", "2026-02-30_2026-03-01"]}
        for kind, keys in stray.items():
            os.makedirs(serve.LOG_DIRS[kind], mode=0o700, exist_ok=True)
            for key in keys:
                with open(os.path.join(serve.LOG_DIRS[kind], key + ".json"), "w") as f:
                    json.dump({"text": "stray"}, f)
        try:
            got = self.call("GET", "/api/log-summaries")[1]
            self.assertEqual((got["months"], got["periods"]), ({}, {}))
        finally:
            for kind, keys in stray.items():
                for key in keys:
                    os.remove(os.path.join(serve.LOG_DIRS[kind], key + ".json"))

    def test_only_dates_name_files(self):
        for kind, key in (("day", "../escape"), ("day", "2026-10-05/../../x"), ("day", "2026-1-5"),
                          ("day", ""), ("month", "2026-10-05"), ("day", ".2026-10-05")):
            with self.subTest(kind=kind, key=key):
                self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": kind, "key": key, "data": {}})[0], 400)
                self.assertEqual(self.call("DELETE", f"/api/log-summaries?kind={kind}&key={key}")[0], 400)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "escape.json")))

    def test_rejects_bad_bodies(self):
        self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": "day", "key": "2026-10-05", "data": [1]})[0], 400)
        self.assertEqual(self.call("POST", "/api/log-summaries", b"not json")[0], 400)
        # an oversized body is refused from its declared size, before it's read
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/api/log-summaries")
            conn.putheader("X-Throwbacks", "1")
            conn.putheader("Content-Length", str(serve.LOG_MAX_BYTES + 10))
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 413)
        finally:
            conn.close()

    def test_no_store_means_no_files(self):
        serve.STORE = False
        try:
            self.assertEqual(self.call("GET", "/api/log-summaries")[0], 404)
            for kind, key in (("day", "2026-10-03"), ("week", "2026-09-28"), ("month", "2026-07"),
                              ("period", "2026-07-01_2026-07-10")):
                with self.subTest(kind=kind):
                    self.assertEqual(self.call("POST", "/api/log-summaries", {"kind": kind, "key": key, "data": {}})[0], 403)
                    self.assertEqual(self.call("DELETE", f"/api/log-summaries?kind={kind}&key={key}")[0], 404)
                    self.assertFalse(os.path.exists(os.path.join(serve.LOG_DIRS[kind], key + ".json")))
        finally:
            serve.STORE = True


class MarksTests(unittest.TestCase):
    """Still going's pins and archives: one private file of chat IDs and times,
    changed one at a time under a lock, only for this machine's tab."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._file, cls._store = serve.MARKS_FILE, serve.STORE
        serve.MARKS_FILE = os.path.join(cls.tmp.name, "tb", "marks.json")  # never your real marks
        serve.STORE = True
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.MARKS_FILE, serve.STORE = cls._file, cls._store
        cls.tmp.cleanup()

    def setUp(self):
        with contextlib.suppress(FileNotFoundError):
            os.remove(serve.MARKS_FILE)

    call = LogStoreTests.call

    def test_needs_the_app_header(self):
        for method in ("GET", "POST"):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            conn.request(method, "/api/marks", body=b'{"id": "code:a", "pin": true}' if method == "POST" else None)
            self.assertEqual(conn.getresponse().status, 403)
            conn.close()
        self.assertFalse(os.path.exists(serve.MARKS_FILE))

    def test_pin_archive_restore(self):
        self.assertEqual(self.call("GET", "/api/marks"), (200, {"pinned": {}, "archived": {}}))
        code, got = self.call("POST", "/api/marks", {"id": "code:a.jsonl", "pin": True})
        self.assertEqual(code, 200)
        self.assertIn("code:a.jsonl", got["pinned"])
        pinned_at = got["pinned"]["code:a.jsonl"]
        code, got = self.call("POST", "/api/marks", {"id": "code:a.jsonl", "archive": {"last": 1700000000000}})
        self.assertEqual((code, got["pinned"]), (200, {}))  # archiving unpins…
        self.assertEqual(got["archived"]["code:a.jsonl"]["last"], 1700000000000)
        self.assertEqual(got["archived"]["code:a.jsonl"]["pin"], pinned_at)  # …and remembers the pin
        self.call("POST", "/api/marks", {"id": "cursor:b", "archive": {"last": 5}})
        code, got = self.call("POST", "/api/marks", {"id": "code:a.jsonl", "archive": None})
        self.assertEqual((code, got["pinned"]), (200, {"code:a.jsonl": pinned_at}))  # Restore pins it again
        code, got = self.call("POST", "/api/marks", {"id": "cursor:b", "archive": None})
        self.assertEqual((got["archived"], list(got["pinned"])), ({}, ["code:a.jsonl"]))  # never pinned: just restored
        self.assertEqual(self.call("GET", "/api/marks")[1], got)  # what was answered is what's saved

    def test_two_tabs_keep_each_others(self):
        errors = []

        def pin(i):
            if self.call("POST", "/api/marks", {"id": f"code:{i}", "pin": True})[0] != 200:
                errors.append(i)
        threads = [threading.Thread(target=pin, args=(i,)) for i in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.call("GET", "/api/marks")[1]["pinned"]), 12)

    def test_file_is_private(self):
        self.call("POST", "/api/marks", {"id": "code:a", "pin": True})
        folder = os.path.dirname(serve.MARKS_FILE)
        self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(serve.MARKS_FILE).st_mode & 0o777, 0o600)
        self.assertEqual([n for n in os.listdir(folder) if n.endswith(".tmp")], [])
        with open(serve.MARKS_FILE) as f:
            self.assertEqual(set(json.load(f)), {"pinned", "archived"})  # IDs and times, nothing else

    def test_rejects_bad_changes(self):
        for body in ({"id": "code:a"}, {"id": "", "pin": True}, {"id": "a\nb", "pin": True}, {"id": "x" * 401, "pin": True},
                     {"id": "code:a", "pin": "yes"}, {"id": "code:a", "archive": {"last": "no"}}, {"id": "code:a", "archive": True},
                     {"id": 5, "pin": True}, [1], "x"):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/api/marks", body)[0], 400)
        self.assertEqual(self.call("POST", "/api/marks", b"not json")[0], 400)
        self.assertFalse(os.path.exists(serve.MARKS_FILE))
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/api/marks")
            conn.putheader("X-Throwbacks", "1")
            conn.putheader("Content-Length", str(serve.MARKS_BODY_MAX + 1))
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 413)
        finally:
            conn.close()

    def test_a_damaged_file_reads_as_none(self):
        os.makedirs(os.path.dirname(serve.MARKS_FILE), mode=0o700, exist_ok=True)
        with open(serve.MARKS_FILE, "w") as f:
            f.write('{"pinned": {"code:a": 5, "bad": "x"}, "archived": [1]')
        self.assertEqual(self.call("GET", "/api/marks"), (200, {"pinned": {}, "archived": {}}))
        with open(serve.MARKS_FILE, "w") as f:
            json.dump({"pinned": {"code:a": 5, "bad": "x", "c\u0000": 1}, "archived": {"code:b": {"at": 1}}, "extra": 1}, f)
        self.assertEqual(self.call("GET", "/api/marks"), (200, {"pinned": {"code:a": 5}, "archived": {}}))

    def test_a_damaged_file_is_set_aside_not_written_over(self):
        self.call("POST", "/api/marks", {"id": "code:a", "pin": True})
        with open(serve.MARKS_FILE, "rb+") as f:
            f.truncate(os.path.getsize(serve.MARKS_FILE) - 1)  # cut off its last byte
        damaged = open(serve.MARKS_FILE, "rb").read()
        code, got = self.call("POST", "/api/marks", {"id": "code:b", "pin": True})
        self.assertEqual((code, list(got["pinned"])), (200, ["code:b"]))
        folder = os.path.dirname(serve.MARKS_FILE)
        aside = [n for n in os.listdir(folder) if n.startswith("marks.json.damaged-")]
        self.assertEqual(len(aside), 1)
        with open(os.path.join(folder, aside[0]), "rb") as f:
            self.assertEqual(f.read(), damaged)  # kept as it was, to mend by hand
        os.remove(os.path.join(folder, aside[0]))

    def test_keeps_at_most_marks_max(self):
        marks = None
        for i in range(serve.MARKS_MAX + 5):
            marks = serve.apply_mark(marks, {"id": f"c{i}", "pin": True}, i)
        self.assertEqual(len(marks["pinned"]), serve.MARKS_MAX)
        self.assertNotIn("c0", marks["pinned"])

    def test_no_store_means_no_file(self):
        serve.STORE = False
        try:
            self.assertEqual(self.call("GET", "/api/marks")[0], 404)
            self.assertEqual(self.call("POST", "/api/marks", {"id": "code:a", "pin": True})[0], 403)
            self.assertFalse(os.path.exists(serve.MARKS_FILE))
        finally:
            serve.STORE = True


class UsageTests(unittest.TestCase):
    """The usage meter, read-only: the numbers statusline.py saved (and
    only those), and whether Claude Code's status line runs our script.
    The server reads Claude Code's settings file and never writes to it."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._file = serve.USAGE_FILE
        cls._conf = os.environ.get("CLAUDE_CONFIG_DIR")
        serve.USAGE_FILE = os.path.join(cls.tmp.name, "usage.json")
        cls.conf = os.path.join(cls.tmp.name, "claude")
        os.makedirs(cls.conf)
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        cls._ask = serve.USAGE_ASK_FILE, dict(serve._ASK)
        serve.USAGE_ASK_FILE = os.path.join(cls.tmp.name, "usage-ask.json")  # never your real switches
        serve._ASK.clear()
        cls._desktop = serve.claude_desktop_dir
        cls.desktop = os.path.join(cls.tmp.name, "desktop")
        os.makedirs(cls.desktop)
        serve.claude_desktop_dir = lambda: cls.desktop  # never the real Claude desktop's files
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.USAGE_FILE = cls._file
        serve.claude_desktop_dir = cls._desktop
        serve.USAGE_ASK_FILE = cls._ask[0]
        serve._ASK.clear()
        serve._ASK.update(cls._ask[1])
        if cls._conf is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = cls._conf
        cls.tmp.cleanup()

    def tearDown(self):
        for path in (serve.USAGE_FILE, os.path.join(self.conf, "settings.json"), os.path.join(self.conf, ".claude.json"),
                     os.path.join(self.desktop, "plan-usage-history.json")):
            if os.path.exists(path):
                os.remove(path)

    def get(self, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/api/usage", headers={"X-Throwbacks": "1"} if headers is None else headers)
            res = conn.getresponse()
            raw = res.read()
            return res.status, (json.loads(raw) if raw[:1] == b"{" else raw)
        finally:
            conn.close()

    def write(self, path, obj):
        with open(path, "w") as f:
            json.dump(obj, f)

    def test_needs_the_app_header(self):
        self.assertEqual(self.get(headers={})[0], 403)

    def test_not_set_up(self):
        code, got = self.get()
        self.assertEqual(code, 200)
        self.assertIsNone(got["reading"])
        self.assertFalse(got["configured"])
        self.assertFalse(got["ours"])
        self.assertEqual(got["settingsFile"], os.path.join(self.conf, "settings.json"))
        cmd = got["snippet"]["statusLine"]["command"]
        self.assertTrue(cmd.startswith("python3 ") and cmd.endswith("statusline.py"), cmd)
        self.assertIn(ROOT, cmd)

    def test_only_numbers_come_back(self):
        self.write(serve.USAGE_FILE, {
            "v": 1, "at": 1800000000, "seen_at": 1800000100, "five_hour": {"used_percentage": 42.5, "resets_at": 1800007200},
            "seven_day": {"used_percentage": "lots", "resets_at": 1}, "cwd": "/secret", "extra": {"a": 1},
        })
        reading = self.get()[1]["reading"]
        self.assertEqual(reading["five_hour"], {"used_percentage": 42.5, "resets_at": 1800007200})
        self.assertIsNone(reading["seven_day"])
        self.assertEqual(set(reading), {"at", "seen_at", "five_hour", "seven_day"})

    def test_spots_our_status_line_and_another(self):
        settings = os.path.join(self.conf, "settings.json")
        ours = {"model": "x", "statusLine": {"type": "command", "command": f"python3 {os.path.join(ROOT, 'statusline.py')}"}}
        self.write(settings, ours)
        got = self.get()[1]
        self.assertTrue(got["configured"] and got["ours"])
        self.write(settings, {"statusLine": {"type": "command", "command": "~/bin/statusline.py"}})
        got = self.get()[1]
        self.assertTrue(got["configured"])
        self.assertFalse(got["ours"], "someone else's statusline.py is not ours")
        self.assertEqual(got["command"], "~/bin/statusline.py")

    def test_never_writes_claude_codes_settings(self):
        settings = os.path.join(self.conf, "settings.json")
        self.write(settings, {"cleanupPeriodDays": 365})
        def state():
            with open(settings) as f:
                return f.read(), os.stat(settings).st_mtime_ns
        before = state()
        for _ in range(3):
            self.get()
        self.assertEqual(state(), before)
        self.assertEqual(sorted(os.listdir(self.conf)), ["settings.json"])

    def test_the_claude_apps_saved_readings_numbers_only(self):
        """Claude Code's copy of its last usage check (one key of ~/.claude.json) and Claude
        desktop's record of its checks: numbers and times only — never the account, a key or an id."""
        code_file = os.path.join(self.conf, ".claude.json")
        self.write(code_file, {
            "oauthAccount": {"emailAddress": "me@example.com", "displayName": "Me", "organizationUuid": "org-1111"},
            "primaryApiKey": "sk-ant-secret", "projects": {"/Users/me/app": {"history": ["secret prompt"]}},
            "cachedUsageUtilization": {"fetchedAtMs": 1800000000123, "accountUuid": "acct-2222", "utilization": {
                "five_hour": {"utilization": 3, "resets_at": "2027-01-15T10:00:00Z"},
                "limits": [{"kind": "session", "group": "session", "percent": 12, "resets_at": "2027-01-15T10:00:00Z"},
                           {"kind": "weekly_scoped", "group": "weekly", "percent": 6, "resets_at": "2027-01-19T17:00:00Z",
                            "scope": {"model": {"display_name": "Fable"}}, "severity": "normal"}]}}})
        desk_file = os.path.join(self.desktop, "plan-usage-history.json")
        self.write(desk_file, {"version": 2, "samples": [
            {"t": 1800000000000, "org": "org-1111", "u": {"fh": 1, "sd": 20}},
            {"t": 1800000500000, "org": "org-1111", "u": {"fh": 7, "sd": "lots", "so": 3, "xu": 50}},
            {"t": "soon", "u": {"fh": 99}}, "junk"]})
        def state():
            out = []
            for p in (code_file, desk_file):
                with open(p) as f:
                    out.append((f.read(), os.stat(p).st_mtime_ns))
            return out
        before = state()
        code, raw = 0, b""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/api/usage", headers={"X-Throwbacks": "1"})
            res = conn.getresponse()
            code, raw = res.status, res.read()
        finally:
            conn.close()
        self.assertEqual(code, 200)
        saved = json.loads(raw)["saved"]
        self.assertEqual(saved["code"], {"at": 1800000000, "windows": [
            {"kind": "session", "group": "session", "pct": 12.0, "resets_at": serve._epoch("2027-01-15T10:00:00Z")},
            {"kind": "weekly_scoped", "group": "weekly", "name": "Fable", "pct": 6.0, "resets_at": serve._epoch("2027-01-19T17:00:00Z")}]},
            "Claude Code's last check: its own rows, Fable and reset times included")
        self.assertEqual(saved["desktop"], {"at": 1800000500, "windows": [
            {"kind": "session", "group": "session", "pct": 7.0, "resets_at": None},
            {"kind": "weekly_scoped", "group": "weekly", "pct": 3.0, "resets_at": None, "name": "Opus"}]},
            "Claude desktop's newest check, its known windows only, no reset times")
        for secret in (b"me@example.com", b"sk-ant-secret", b"acct-2222", b"org-1111", b"secret prompt", b'"Me"'):
            self.assertNotIn(secret, raw)
        self.assertEqual(state(), before, "read, never written")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/api/usage?apps=0", headers={"X-Throwbacks": "1"})
            self.assertEqual(json.loads(conn.getresponse().read())["saved"], {}, "the sample reads none of it")
        finally:
            conn.close()

    def test_saved_readings_are_this_accounts(self):
        """A check Claude Code made for another account is dropped (as Claude Code drops it), and
        desktop's numbers are those of the org Claude Code is logged in to, when it knows one."""
        code_file = os.path.join(self.conf, ".claude.json")
        desk_file = os.path.join(self.desktop, "plan-usage-history.json")
        cache = {"fetchedAtMs": 1800000000000, "accountUuid": "acct-old",
                 "utilization": {"limits": [{"kind": "session", "group": "session", "percent": 12}]}}
        self.write(code_file, {"oauthAccount": {"accountUuid": "acct-now", "organizationUuid": "org-A"}, "cachedUsageUtilization": cache})
        self.write(desk_file, {"samples": [{"t": 1800000000000, "org": "org-A", "u": {"fh": 4}},
                                           {"t": 1800000900000, "org": "org-B", "u": {"fh": 80}}]})
        saved = self.get()[1]["saved"]
        self.assertIsNone(saved["code"], "another account's check")
        self.assertEqual((saved["desktop"]["at"], saved["desktop"]["windows"][0]["pct"]), (1800000000, 4.0), "org A's, though B's is newer")
        self.write(desk_file, {"samples": [{"t": 1800000900000, "org": "org-B", "u": {"fh": 80}}]})
        self.assertIsNone(self.get()[1]["saved"]["desktop"], "only another org's: none")
        self.write(code_file, {"cachedUsageUtilization": {**cache, "accountUuid": "acct-now"}})
        saved = self.get()[1]["saved"]
        self.assertEqual((saved["code"]["windows"][0]["pct"], saved["desktop"]["windows"][0]["pct"]), (12.0, 80.0),
                         "no account known (a logout clears it): what's saved is shown")

    def test_no_saved_readings_beside_live_numbers(self):
        before = serve._LIVE["claude"]["reading"]
        self.write(os.path.join(self.desktop, "plan-usage-history.json"), {"samples": [{"t": 1800000000000, "u": {"fh": 4}}]})
        serve._LIVE["claude"]["reading"] = {"at": 1800000000, "windows": [{"kind": "session", "pct": 3.0, "resets_at": None}]}
        try:
            self.assertEqual(self.get()[1]["saved"], {}, "the live reading has numbers: the saved ones aren't read")
        finally:
            serve._LIVE["claude"]["reading"] = before

    def test_saved_readings_missing_or_odd_are_none(self):
        self.assertEqual(self.get()[1]["saved"], {"code": None, "desktop": None})
        self.write(os.path.join(self.conf, ".claude.json"), {"cachedUsageUtilization": {"fetchedAtMs": True, "utilization": {"limits": []}}})
        with open(os.path.join(self.desktop, "plan-usage-history.json"), "w") as f:
            f.write('{"samples": [{"t": 1800000000000, "u": {"fh": 5')  # half-written
        self.assertEqual(self.get()[1]["saved"], {"code": None, "desktop": None})

    def test_broken_files_are_just_empty(self):
        with open(serve.USAGE_FILE, "w") as f:
            f.write("{not json")
        with open(os.path.join(self.conf, "settings.json"), "w") as f:
            f.write("[1, 2")
        code, got = self.get()
        self.assertEqual(code, 200)
        self.assertIsNone(got["reading"])
        self.assertFalse(got["configured"])


FAKE_CLAUDE = r'''
import json, os, sys, time
here = os.environ["FAKE_CLAUDE_DIR"]
if "--help" in sys.argv:
    print("  --no-session-persistence   Disable session persistence")
    sys.exit(0)
with open(os.path.join(here, "mode")) as f:
    mode = f.read().strip()
if mode == "exit":
    sys.exit(3)
print(json.dumps({"type": "system", "subtype": "init", "cwd": os.getcwd()}), flush=True)
print("not json at all", flush=True)
line = sys.stdin.readline()
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "request": json.loads(line),
                        "env": {k: os.environ.get(k) for k in ("DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING",
                                "DISABLE_AUTOUPDATER", "ENABLE_CLAUDEAI_MCP_SERVERS",
                                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")}}) + "\n")
if mode == "hang":
    sys.stdin.read()  # never answers; ends when its input does
    sys.exit(0)
rid = json.loads(line)["request_id"]
limits = {
    "five_hour": {"utilization": 21, "resets_at": "2030-01-01T10:00:00.123456+00:00", "used_dollars": None},
    "seven_day": {"utilization": 57, "resets_at": "2030-01-03T10:00:00Z"},
    "model_scoped": [{"display_name": "Fable", "utilization": 33, "resets_at": "2030-01-03T10:00:00Z"}],
    "extra_usage": {"is_enabled": False},
}
if mode == "ok":
    limits["limits"] = [
        {"kind": "session", "group": "session", "percent": 21, "resets_at": "2030-01-01T10:00:00.123456+00:00", "scope": None},
        {"kind": "weekly_all", "group": "weekly", "percent": 57, "resets_at": "2030-01-03T10:00:00Z", "scope": None, "is_active": True},
        {"kind": "weekly_scoped", "group": "weekly", "percent": 33, "resets_at": "2030-01-03T10:00:00Z",
         "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None}},
        {"kind": "Not A Kind!", "percent": 50},
        {"kind": "session", "percent": "lots"},
    ]
body = {"session": {"total_cost_usd": 0}, "subscription_type": "team", "rate_limits_available": True,
        "rate_limits": limits, "behaviors": None}
if mode == "logged_out":
    body = {"session": {}, "subscription_type": None, "rate_limits_available": False, "rate_limits": None}
elif mode == "unavailable":
    body["rate_limits"] = None
if mode == "error":
    res = {"subtype": "error", "request_id": rid, "error": "Unsupported control request subtype: get_usage"}
else:
    res = {"subtype": "success", "request_id": rid, "response": body}
print(json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": "someone-else", "response": {}}}), flush=True)
print(json.dumps({"type": "control_response", "response": res}), flush=True)
sys.stdin.read()
'''


class LiveUsageTests(unittest.TestCase):
    """The live usage reading: the server asks Claude Code (a stand-in here)
    for its /usage numbers, locked down, and keeps only the numbers."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))
        script = os.path.join(self.dir, "fake_claude.py")
        with open(script, "w") as f:
            f.write(FAKE_CLAUDE)
        cli = os.path.join(self.dir, "claude")
        with open(cli, "w") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        os.chmod(cli, 0o755)
        saved = serve.CLAUDE_BIN, serve._NO_PERSIST, serve.CLAUDE, {k: dict(v) for k, v in serve._LIVE.items()}
        saved_ask = serve.USAGE_ASK_FILE, dict(serve._ASK)
        serve.USAGE_ASK_FILE = os.path.join(self.dir, "usage-ask.json")  # never your real switches
        serve._ASK.clear()
        serve.CLAUDE_BIN, serve._NO_PERSIST = cli, None
        for slot in serve._LIVE.values():
            slot.update(reading=None, ran=0.0)

        def restore():
            serve.CLAUDE_BIN, serve._NO_PERSIST, serve.CLAUDE = saved[:3]
            for k, v in saved[3].items():
                serve._LIVE[k].update(v)
            serve.USAGE_ASK_FILE = saved_ask[0]
            serve._ASK.clear()
            serve._ASK.update(saved_ask[1])
        self.addCleanup(restore)
        desktop, usage_file = serve.claude_desktop_dir, serve.USAGE_FILE
        serve.claude_desktop_dir = lambda: os.path.join(self.dir, "desktop")  # never the real Claude apps' saved usage
        serve.USAGE_FILE = os.path.join(self.dir, "usage.json")
        self.addCleanup(lambda: (setattr(serve, "claude_desktop_dir", desktop), setattr(serve, "USAGE_FILE", usage_file)))
        env = {"FAKE_CLAUDE_DIR": self.dir, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": None,
               "CLAUDE_CONFIG_DIR": os.path.join(self.dir, "conf")}
        for k, v in env.items():
            old = os.environ.get(k)
            self.addCleanup(lambda k=k, old=old: os.environ.pop(k, None) if old is None else os.environ.__setitem__(k, old))
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
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

    def test_every_limit_and_only_numbers(self):
        got = serve.claude_usage_ask()
        self.assertEqual(set(got), {"at", "plan", "windows"})
        self.assertEqual(got["plan"], "team")
        self.assertEqual(got["windows"], [
            {"kind": "session", "group": "session", "pct": 21.0, "resets_at": 1893492000},
            {"kind": "weekly_all", "group": "weekly", "pct": 57.0, "resets_at": 1893664800},
            {"kind": "weekly_scoped", "group": "weekly", "name": "Fable", "pct": 33.0, "resets_at": 1893664800},
        ])

    def test_a_seeded_answer_keeps_its_own_age(self):
        """A login Claude Code holds but can't use answers with its copy of its last check:
        those numbers are as old as that copy, not "just now"."""
        conf = os.environ["CLAUDE_CONFIG_DIR"]
        os.makedirs(conf, exist_ok=True)
        rows = [{"kind": "session", "group": "session", "percent": 21, "resets_at": "2030-01-01T10:00:00.123456+00:00"},
                {"kind": "weekly_all", "group": "weekly", "percent": 57, "resets_at": "2030-01-03T10:00:00Z"},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 33, "resets_at": "2030-01-03T10:00:00Z",
                 "scope": {"model": {"display_name": "Fable"}}}]
        then = int(time.time()) - 40 * 60
        with open(os.path.join(conf, ".claude.json"), "w") as f:
            json.dump({"cachedUsageUtilization": {"fetchedAtMs": then * 1000, "utilization": {"limits": rows}}}, f)
        self.assertEqual(serve.claude_usage_ask()["at"], then, "the same numbers as its 40-minute-old copy: that old")
        with open(os.path.join(conf, ".claude.json"), "w") as f:
            json.dump({"cachedUsageUtilization": {"fetchedAtMs": then * 1000, "utilization": {"limits": rows[:1]}}}, f)
        self.assertGreater(serve.claude_usage_ask()["at"], then, "different numbers: a fresh answer, now")

    def test_runs_locked_down(self):
        serve.claude_usage_ask()
        (call,) = self.calls()
        argv = call["argv"]
        self.assertIn("-p", argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "", "no tools")
        self.assertIn("--strict-mcp-config", argv)
        self.assertIn("--no-session-persistence", argv)
        self.assertEqual(call["request"]["request"], {"subtype": "get_usage", "skip_behaviors": True})
        self.assertEqual(call["env"], {"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1",
                                       "ENABLE_CLAUDEAI_MCP_SERVERS": "false",
                                       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": None})
        self.assertTrue(os.path.basename(call["cwd"]).startswith("throwbacks-claude-"))
        self.assertFalse(os.path.exists(call["cwd"]), "its empty working folder is removed afterwards")

    def test_an_older_answer_without_rows(self):
        self.mode("old")
        self.assertEqual([(w["kind"], w.get("name"), w["pct"]) for w in serve.claude_usage_ask()["windows"]],
                         [("session", None, 21.0), ("weekly_all", None, 57.0), ("weekly_scoped", "Fable", 33.0)])

    def test_what_goes_wrong_is_named(self):
        for mode, error in (("logged_out", "no_plan"), ("unavailable", "unavailable"), ("error", "unsupported"),
                            ("exit", "no_answer")):
            self.mode(mode)
            got = serve.claude_usage_ask(timeout=10)
            self.assertEqual(got.get("error"), error, mode)
            self.assertNotIn("windows", got)
        self.mode("hang")
        self.assertEqual(serve.claude_usage_ask(timeout=1)["error"], "timeout")
        self.mode("unavailable")
        os.environ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        self.assertEqual(serve.claude_usage_ask()["error"], "essential_only")
        serve.CLAUDE_BIN, serve._NO_PERSIST = os.path.join(self.dir, "missing"), None
        self.assertEqual(serve.claude_usage_ask()["error"], "no_cli")

    def test_at_most_once_a_minute(self):
        first = serve.usage_live()
        self.assertIs(serve.usage_live(), first)
        self.assertEqual(len(self.calls()), 1)
        serve._LIVE["claude"]["ran"] -= serve.USAGE_LIVE_GAP_S + 1
        serve.usage_live()
        self.assertEqual(len(self.calls()), 2)

    def test_the_refresh_route(self):
        server = serve.Server(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def call(method, path, headers={"X-Throwbacks": "1"}):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=20)
            try:
                conn.request(method, path, body=b"" if method == "POST" else None, headers=headers)
                res = conn.getresponse()
                return res.status, json.loads(res.read() or b"{}")
            finally:
                conn.close()

        self.assertEqual(call("POST", "/api/usage/refresh", headers={})[0], 403)
        serve.CLAUDE = False
        code, got = call("POST", "/api/usage/refresh")
        self.assertEqual((code, got["live"]), (200, {"enabled": False, "reading": None}))
        self.assertEqual(self.calls(), [], "without --claude, Claude Code is never run")
        serve.CLAUDE = True
        code, got = call("POST", "/api/usage/refresh")
        self.assertEqual(code, 200)
        self.assertTrue(got["live"]["enabled"])
        self.assertEqual([w["pct"] for w in got["live"]["reading"]["windows"]], [21.0, 57.0, 33.0])
        self.assertEqual(call("GET", "/api/usage")[1]["live"], got["live"], "GET hands over the last answer")
        self.assertEqual(len(self.calls()), 1, "…without running Claude Code again")


class ClaudeBridgeTests(unittest.TestCase):
    """The summarizer's own `claude -p` runs must never be saved as sessions."""

    def fake_cli(self, help_text):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        path = os.path.join(d, "claude")
        with open(path, "w") as f:
            f.write(f"#!/bin/sh\nprintf '%s\\n' '{help_text}'\n")
        os.chmod(path, 0o755)
        return path

    def flag_for(self, cli):
        saved = serve.CLAUDE_BIN, serve._NO_PERSIST
        serve.CLAUDE_BIN, serve._NO_PERSIST = cli, None
        try:
            return serve.claude_no_persist_flag()
        finally:
            serve.CLAUDE_BIN, serve._NO_PERSIST = saved

    def test_uses_the_flag_when_the_cli_has_it(self):
        cli = self.fake_cli("  --no-session-persistence   Disable session persistence")
        self.assertEqual(self.flag_for(cli), ["--no-session-persistence"])

    def test_leaves_it_out_for_an_older_cli(self):
        self.assertEqual(self.flag_for(self.fake_cli("  --print   Print response and exit")), [])

    def test_a_missing_cli_is_not_an_error(self):
        self.assertEqual(self.flag_for("/nonexistent/claude"), [])


# A stand-in for `claude -p … --output-format json`: what it prints is picked
# by the "mode" file; every run notes its arguments, folder and input.
FAKE_SUMMARIZER = r'''
import json, os, sys
here = os.environ["FAKE_CLAUDE_DIR"]
if "--help" in sys.argv:
    print("  --no-session-persistence   Disable session persistence")
    sys.exit(0)
with open(os.path.join(here, "mode")) as f:
    mode = f.read().strip()
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "stdin": sys.stdin.read(),
                        "env": {k: os.environ.get(k) for k in ("DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER",
                                                               "ENABLE_CLAUDEAI_MCP_SERVERS")}}) + "\n")

def result(text, is_error=False, subtype="success", **extra):
    out = {"type": "result", "subtype": subtype, "is_error": is_error, "duration_ms": 14013,
           "duration_api_ms": 4011, "num_turns": 1, "session_id": "s", "total_cost_usd": 0.0123}
    if text is not None:
        out["result"] = text
    out.update(extra)
    print(json.dumps(out))

USAGE = {"input_tokens": 1200, "output_tokens": 85, "cache_creation_input_tokens": 300,
         "cache_read_input_tokens": 3400.0, "server_tool_use": {"web_search_requests": 0}, "service_tier": "standard"}
if mode == "json":
    result("  - Added retries to the uploader\n", usage=USAGE,
           modelUsage={"claude-test-1": {"inputTokens": 1200, "outputTokens": 85, "costUSD": 0.0123}})
elif mode == "odd_usage":
    result("A summary", usage={"input_tokens": "1200", "output_tokens": True, "cache_creation_input_tokens": -4,
                               "cache_read_input_tokens": float("nan")},
           modelUsage={"claude-a": {}, "claude-b": {}})
elif mode == "some_usage":
    result("A summary", usage={"input_tokens": None, "output_tokens": 42, "cache_read_input_tokens": float("inf")},
           modelUsage={"claude-a": {}})
elif mode == "no_usage":
    result("A summary", usage="lots", modelUsage=[])
elif mode == "text":
    print("  Plain text summary\n  - second line  ")
elif mode == "models_json":
    print(json.dumps({"lines": ["a JSON reply from an older CLI"]}))
elif mode == "verbose":
    print(json.dumps([{"type": "system", "subtype": "init"}, {"type": "assistant"},
                      {"type": "result", "subtype": "success", "is_error": False, "result": "From the list",
                       "usage": {"output_tokens": 7}}]))
elif mode == "error":
    result("Prompt is too long", is_error=True)
    sys.exit(1)
elif mode == "max_turns":
    result(None, is_error=True, subtype="error_max_turns")
    sys.exit(1)
elif mode == "error_no_text":
    result(None, is_error=True)
elif mode == "auth":
    result('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}', is_error=True)
    sys.exit(1)
elif mode == "auth_stderr":
    result("Something went wrong", is_error=True)
    print("OAuth token has expired. Please Re-authenticate.", file=sys.stderr)
    sys.exit(1)
elif mode == "not_logged_in":
    result("Not logged in · Please run /login", is_error=True)
    sys.exit(1)
elif mode == "no_access":
    result("Your account does not have access to Claude. Please login again or contact your administrator.", is_error=True)
    sys.exit(1)
elif mode == "refresh_race":
    result("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. "
           "This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again",
           is_error=True)
    sys.exit(1)
elif mode == "crash_401":
    print("TypeError: x is undefined\n    at chunk-x.js:4013:22\n    at 0x4010ab", file=sys.stderr)
    sys.exit(1)
elif mode == "count_401":
    result("Prompt is too long: 214013 tokens > 200000 maximum", is_error=True)
    sys.exit(1)
elif mode == "summary_401":
    result("Fixed the 401 on token refresh. Failed to authenticate users now see a Re-authenticate prompt.",
           usage={"output_tokens": 20})
elif mode == "empty":
    result("   ")
elif mode == "text_auth":
    print("Failed to authenticate. API Error: 401")
elif mode == "crash":
    print("Segmentation fault", file=sys.stderr)
    sys.exit(139)
'''


class ClaudeSummarizeTests(unittest.TestCase):
    """POST /api/claude-summarize with a stand-in `claude`: it runs `claude -p
    --output-format json`, locked down as before, and answers with the text,
    the real token counts and the model — or falls back to plain text."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        script = os.path.join(cls.dir, "fake_claude.py")
        with open(script, "w") as f:
            f.write(FAKE_SUMMARIZER)
        cls.cli = os.path.join(cls.dir, "claude")
        with open(cls.cli, "w") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        os.chmod(cls.cli, 0o755)
        cls._saved = serve.CLAUDE_BIN, serve._NO_PERSIST, serve.CLAUDE, serve.CLAUDE_MODEL, os.environ.get("FAKE_CLAUDE_DIR")
        serve.CLAUDE_BIN, serve._NO_PERSIST, serve.CLAUDE, serve.CLAUDE_MODEL = cls.cli, None, True, None
        os.environ["FAKE_CLAUDE_DIR"] = cls.dir
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.CLAUDE_BIN, serve._NO_PERSIST, serve.CLAUDE, serve.CLAUDE_MODEL, fake_dir = cls._saved
        if fake_dir is None:
            os.environ.pop("FAKE_CLAUDE_DIR", None)
        else:
            os.environ["FAKE_CLAUDE_DIR"] = fake_dir
        __import__("shutil").rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(self.dir, "calls.jsonl"))

    def summarize(self, mode, body=None, headers=None):
        with open(os.path.join(self.dir, "mode"), "w") as f:
            f.write(mode)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request("POST", "/api/claude-summarize",
                         body=json.dumps(body or {"system": "Summarize.", "prompt": "Made-up chat text"}).encode(),
                         headers={"X-Throwbacks": "1"} if headers is None else headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def calls(self):
        try:
            with open(os.path.join(self.dir, "calls.jsonl")) as f:
                return [json.loads(line) for line in f]
        except FileNotFoundError:
            return []

    def test_text_usage_and_model(self):
        self.assertEqual(self.summarize("json"), (200, {
            "text": "- Added retries to the uploader",
            "usage": {"input": 1200, "output": 85, "cacheWrite": 300, "cacheRead": 3400},
            "model": "claude-test-1",
        }))

    def test_only_plain_numbers_are_kept(self):
        code, got = self.summarize("odd_usage")
        self.assertEqual((code, got), (200, {"text": "A summary", "model": None}), "no number read: no usage; two models: none")
        code, got = self.summarize("some_usage")
        self.assertEqual((code, got), (200, {"text": "A summary", "usage": {"output": 42}, "model": "claude-a"}))
        self.assertIs(type(got["usage"]["output"]), int)
        self.assertEqual(self.summarize("no_usage"), (200, {"text": "A summary", "model": None}))
        self.assertEqual(self.summarize("verbose"), (200, {"text": "From the list", "usage": {"output": 7}, "model": None}))

    def test_plain_text_falls_back(self):
        self.assertEqual(self.summarize("text"), (200, {"text": "Plain text summary\n  - second line"}))
        self.assertEqual(self.summarize("models_json"), (200, {"text": '{"lines": ["a JSON reply from an older CLI"]}'}),
                         "a JSON object that isn't Claude Code's result is the text itself")
        self.assertEqual(self.summarize("text_auth")[0], 401, "the older CLI's login failure is still spotted")
        self.assertEqual(self.summarize("crash"), (502, {"error": "Segmentation fault"}))

    def test_an_error_result_is_a_502_with_its_message(self):
        self.assertEqual(self.summarize("error"), (502, {"error": "Prompt is too long"}))
        self.assertEqual(self.summarize("max_turns"), (502, {"error": "error_max_turns"}))
        self.assertEqual(self.summarize("error_no_text"), (502, {"error": "Claude CLI reported an error"}))
        self.assertEqual(self.summarize("empty"), (502, {"error": "Claude CLI returned no output"}))

    def test_an_expired_login_is_a_401(self):
        for mode in ("auth", "auth_stderr", "not_logged_in", "no_access"):
            with self.subTest(mode=mode):
                code, got = self.summarize(mode)
                self.assertEqual(code, 401)
                self.assertIn("log in again", got["error"])
                self.assertIn("`claude auth login`", got["error"], "the one command that fixes it")
        code, got = self.summarize("summary_401")
        self.assertEqual((code, got["text"][:13]), (200, "Fixed the 401"),
                         "a summary that mentions a 401 (or a duration with 401 in it) is still a summary")
        self.assertEqual(self.summarize("count_401"), (502, {"error": "Prompt is too long: 214013 tokens > 200000 maximum"}),
                         "a failure with 401 in a number is that failure, not a login")
        code, got = self.summarize("refresh_race")
        self.assertEqual(code, 502, "another Claude Code process refreshing the login: try again, the login is fine")
        self.assertIn("usually transient", got["error"])
        self.assertEqual(self.summarize("crash_401")[0], 502, "a crash whose line numbers hold a 401 is a crash, not a login")

    def test_runs_locked_down_with_json_output(self):
        self.assertEqual(self.summarize("json", {"system": "Summarize.", "prompt": "Made-up chat", "model": "claude-x"})[0], 200)
        (call,) = self.calls()
        argv = call["argv"]
        with open(os.path.join(ROOT, "js", "parse.js"), encoding="utf-8") as f:
            bridge_prompt = __import__("re").search(r"const BRIDGE_PROMPT = '([^']+)'", f.read()).group(1)
        self.assertEqual(argv[0], "-p")
        self.assertEqual(argv[1], bridge_prompt, "parse.js still knows the bridge's runs")
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        self.assertEqual(argv.count("--output-format"), 1)
        self.assertNotIn("--verbose", argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "", "no tools")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--settings") + 1], '{"cleanupPeriodDays": 36500}', "never sweeps chats")
        self.assertIn("--no-session-persistence", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "claude-x")
        self.assertEqual(call["stdin"], "Summarize.\n\nMade-up chat", "the text goes in on stdin, never as an argument")
        self.assertTrue(os.path.basename(call["cwd"]).startswith("throwbacks-claude-"))
        self.assertFalse(os.path.exists(call["cwd"]), "its empty working folder is removed afterwards")
        self.assertEqual(call["env"], {"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1",
                                       "ENABLE_CLAUDEAI_MCP_SERVERS": "false"},
                         "its own telemetry, crash reports, updates and the claude.ai connectors off, as for the usage meter")
        self.summarize("json")
        self.assertNotIn("--model", self.calls()[-1]["argv"], "no model asked for: the CLI's own")

    def test_guarded_and_off_without_claude(self):
        self.assertEqual(self.summarize("json", headers={})[0], 403)
        serve.CLAUDE = False
        try:
            self.assertEqual(self.summarize("json")[0], 403)
        finally:
            serve.CLAUDE = True
        self.assertEqual(self.calls(), [], "neither ran Claude Code")
        self.assertEqual(self.summarize("json", {"system": "", "prompt": "  "}), (400, {"error": "Empty prompt"}))


class ResumeTests(unittest.TestCase):
    """/api/resume: what the page needs to build "Copy resume command" — the
    session's folder (its last /cd move, else where it started), whether
    that folder still exists, and whether the session is open right now. It
    takes only an app and a UUID, reads made-up files here, runs nothing."""

    ID = "7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47"
    OPEN = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e"
    REUSED = "aaaaaaaa-1111-4222-8333-444444444444"
    STARTED = "bbbbbbbb-1111-4222-8333-444444444444"
    BG = "cccccccc-1111-4222-8333-444444444444"
    PARKED = "dddddddd-1111-4222-8333-444444444444"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._conf = os.environ.get("CLAUDE_CONFIG_DIR")
        cls._copilot = serve.copilot_cli_dir
        cls.conf = os.path.join(cls.tmp.name, "claude")
        cls.work = os.path.join(cls.tmp.name, "work dir's")  # a space and a quote
        cls.moved = os.path.join(cls.tmp.name, "moved")
        os.makedirs(cls.work)
        os.makedirs(cls.moved)
        proj = os.path.join(cls.conf, "projects", "-tmp-work")
        os.makedirs(proj)

        def transcript(sid, lines):
            with open(os.path.join(proj, sid + ".jsonl"), "w") as f:
                f.write("\n".join(json.dumps(l) for l in lines) + "\nnot json\n")

        transcript(cls.ID, [{"type": "user", "cwd": cls.work, "entrypoint": "cli", "message": {"content": "hi"}}])
        transcript(cls.OPEN, [{"type": "user", "cwd": "/nowhere/gone", "entrypoint": "claude-desktop"},
                              {"type": "relocated", "relocatedCwd": "/first/move"},
                              {"type": "relocated", "relocatedCwd": cls.moved}])
        sessions = os.path.join(cls.conf, "sessions")
        os.makedirs(sessions)
        with open(os.path.join(sessions, f"{os.getpid()}.json"), "w") as f:  # this process: alive
            json.dump({"pid": os.getpid(), "sessionId": cls.OPEN, "entrypoint": "claude-desktop"}, f)
        with open(os.path.join(sessions, "999999999.json"), "w") as f:  # no such process
            json.dump({"pid": 999999999, "sessionId": cls.ID, "entrypoint": "cli"}, f)
        # The same live process, but a start time that isn't its own: a pid reused after a crash.
        with open(os.path.join(sessions, "1001.json"), "w") as f:
            json.dump({"pid": os.getpid(), "sessionId": cls.REUSED, "procStart": "Thu Jan  1 00:00:00 1970"}, f)
        # …and with its real start time (as Claude Code writes it: ps in UTC).
        started = subprocess.run(["ps", "-o", "lstart=", "-p", str(os.getpid())], capture_output=True, text=True,
                                 env={**os.environ, "LC_ALL": "C", "TZ": "UTC"}).stdout.strip()
        with open(os.path.join(sessions, "1002.json"), "w") as f:
            json.dump({"pid": os.getpid(), "sessionId": cls.STARTED, "procStart": started, "entrypoint": "cli"}, f)
        with open(os.path.join(sessions, "1003.json"), "w") as f:  # a pid no process can have
            json.dump({"pid": 2 ** 40, "sessionId": cls.ID}, f)
        with open(os.path.join(sessions, "1004.json"), "w") as f:  # running in the background
            json.dump({"pid": os.getpid(), "sessionId": cls.BG, "kind": "daemon-worker", "entrypoint": "cli"}, f)
        with open(os.path.join(sessions, "1005.json"), "w") as f:  # an interactive one parked in the background
            json.dump({"pid": os.getpid(), "sessionId": cls.PARKED, "kind": "interactive", "parkedJobId": "j1"}, f)
        with open(os.path.join(sessions, f"{os.getpid()}.abc.key"), "w") as f:
            f.write("{}")  # test_key_files_are_never_opened checks nothing opens it
        cls.copilot = os.path.join(cls.tmp.name, "copilot")
        os.makedirs(os.path.join(cls.copilot, "session-state", cls.ID))
        with open(os.path.join(cls.copilot, "session-state", cls.ID, "workspace.yaml"), "w") as f:
            f.write(f"id: {cls.ID}\ncwd: {cls.work}\n")
        # Another Copilot CLI session, held right now by a process (this one) — and a stale lock.
        held = os.path.join(cls.copilot, "session-state", cls.OPEN)
        os.makedirs(held)
        with open(os.path.join(held, "workspace.yaml"), "w") as f:
            f.write(f"id: {cls.OPEN}\ncwd: {cls.work}\nclient_name: vscode\n")
        for pid in (999999999, os.getpid()):
            open(os.path.join(held, f"inuse.{pid}.lock"), "w").close()
        open(os.path.join(cls.copilot, "session-state", cls.ID, "inuse.999999999.lock"), "w").close()
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        serve.copilot_cli_dir = lambda: cls.copilot
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.copilot_cli_dir = cls._copilot
        if cls._conf is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = cls._conf
        cls.tmp.cleanup()

    def get(self, query, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", "/api/resume?" + query, headers={"X-Throwbacks": "1"} if headers is None else headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def test_a_session_and_its_folder(self):
        code, body = self.get(f"app=claude&id={self.ID}")
        self.assertEqual(code, 200)
        self.assertEqual(body, {"found": True, "folder": self.work, "exists": True, "entrypoint": "cli", "live": None})

    def test_moved_folder_gone_start_and_open_right_now(self):
        _, body = self.get(f"app=claude&id={self.OPEN}")
        self.assertEqual(body["folder"], self.moved)  # the last /cd move, not where it started
        self.assertTrue(body["exists"])
        self.assertEqual(body["live"], {"where": "claude-desktop", "kind": None})  # its process is alive

    def test_a_dead_process_isnt_open(self):
        self.assertIsNone(self.get(f"app=claude&id={self.ID}")[1]["live"])

    def test_open_only_when_the_process_started_when_the_record_says(self):
        live = serve.claude_live_sessions()
        self.assertNotIn(self.REUSED, live)  # alive, but not that session's process
        self.assertEqual(live.get(self.STARTED), {"where": "cli", "kind": None})
        self.assertEqual(live.get(self.BG), {"where": "cli", "kind": "daemon-worker"})  # resuming attaches to it
        self.assertNotIn(self.PARKED, live)  # its background run speaks for it
        self.assertIn(self.OPEN, live)  # an older record without a start time: alive is enough
        self.assertNotIn(self.ID, live)  # neither a dead pid nor one out of range counts (or breaks it)

    def test_key_files_are_never_opened(self):
        seen = []
        real_open = open

        def spy(path, *a, **kw):
            seen.append(str(path))
            return real_open(path, *a, **kw)

        with unittest.mock.patch("builtins.open", spy):
            serve.claude_live_sessions()
        self.assertTrue([p for p in seen if p.endswith(".json")])
        self.assertEqual([p for p in seen if ".key" in p], [])

    def test_unknown_session(self):
        self.assertEqual(self.get("app=claude&id=11111111-2222-4333-8444-555555555555"), (200, {"found": False}))
        self.assertEqual(self.get("app=copilot&id=11111111-2222-4333-8444-555555555555"), (200, {"found": False}))

    def test_copilot_cli(self):
        # A stale lock (no such process) isn't "open"; a lock held by a live process is.
        self.assertEqual(self.get(f"app=copilot&id={self.ID}")[1], {"found": True, "folder": self.work, "exists": True, "live": None})
        self.assertEqual(self.get(f"app=copilot&id={self.OPEN}")[1]["live"], {"where": "vscode", "kind": "copilot"})

    def test_only_an_app_and_a_uuid(self):
        for q in ("app=claude&id=../../etc/passwd", "app=claude&id=*", f"app=bash&id={self.ID}", "app=claude", f"id={self.ID}",
                  "app=claude&id=7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47%0a"):
            with self.subTest(q=q):
                self.assertEqual(self.get(q)[0], 400)

    def test_guarded_like_every_route(self):
        self.assertEqual(self.get(f"app=claude&id={self.ID}", headers={})[0], 403)
        self.assertEqual(self.get(f"app=claude&id={self.ID}", headers={"X-Throwbacks": "1", "Origin": "http://evil.example"})[0], 403)

    def test_off_with_no_import(self):
        old, serve.IMPORT = serve.IMPORT, False
        try:
            self.assertEqual(self.get(f"app=claude&id={self.ID}")[0], 404)
        finally:
            serve.IMPORT = old


class CommitTests(unittest.TestCase):
    """/api/commits: your commits in the folders your sessions started in, read
    with git log only, each tagged you / Claude / probably Claude. Made-up
    repos and a made-up Claude Code transcript in a temp folder; a repo whose
    own config tries to run programs (pager, signature check, external diff,
    fsmonitor) must never get to."""

    ME, GLOBAL, OTHER = "me@work.example", "me@home.example", "someone@else.example"
    SID = "11111111-2222-4333-8444-555555555555"
    T = 1_791_000_000  # a fixed moment in 2026

    @classmethod
    def git(cls, cwd, *args, email=None, when=None, check=True):
        env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}
        if email:
            env.update(GIT_AUTHOR_NAME="X", GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME="X", GIT_COMMITTER_EMAIL=email)
        if when:
            env.update(GIT_AUTHOR_DATE=f"@{when} +0000", GIT_COMMITTER_DATE=f"@{when} +0000")
        r = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", cwd, *args],
                           capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30)
        if check and r.returncode:
            raise AssertionError(r.stderr)
        return r.stdout.strip()

    @classmethod
    def commit(cls, repo, msg, email, when):
        cls.git(repo, "commit", "-q", "--allow-empty", "-m", msg, email=email, when=when)
        return cls.git(repo, "rev-parse", "HEAD")

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = os.path.realpath(cls.tmp.name)
        cls._env = {k: os.environ.get(k) for k in ("CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")}
        gcfg = os.path.join(root, "gitconfig")
        with open(gcfg, "w") as f:
            f.write(f"[user]\n\temail = {cls.GLOBAL}\n\tname = X\n[init]\n\tdefaultBranch = main\n")
        os.environ.update(GIT_CONFIG_GLOBAL=gcfg, GIT_CONFIG_NOSYSTEM="1")
        T = cls.T
        cls.app = os.path.join(root, "app")
        os.makedirs(os.path.join(cls.app, "sub"))
        cls.git(cls.app, "init", "-q")
        cls.git(cls.app, "config", "user.email", cls.ME)
        cls.commit(cls.app, "before the history starts", cls.ME, T - 90 * 86400)
        cls.since_day = time.strftime("%Y-%m-%d", time.localtime(T - 86400))
        cls.early = cls.commit(cls.app, "just after midnight on the first day", cls.ME,
                               int(time.mktime(time.strptime(cls.since_day, "%Y-%m-%d"))) + 1800)
        cls.mine = cls.commit(cls.app, "by me in the terminal", cls.ME, T)
        cls.signed = cls.commit(cls.app, "Claude's, with its line\n\nCo-Authored-By: Claude <noreply@anthropic.com>", cls.ME, T + 100)
        cls.by_id = cls.commit(cls.app, "Claude's, its ID in the record", cls.ME, T + 200)
        cls.by_time = cls.commit(cls.app, "Claude's, by the time", cls.ME, T + 300)
        cls.global_one = cls.commit(cls.app, "mine, global email", cls.GLOBAL, T + 400)
        cls.commit(cls.app, "someone else's", cls.OTHER, T + 500)
        with open(os.path.join(cls.app, "f.txt"), "w") as f:
            f.write("work in progress\n")
        cls.git(cls.app, "add", "f.txt")
        cls.git(cls.app, "stash", "-q", email=cls.ME, when=T + 600)  # a stash is a commit too: never listed
        cls.push_failed = cls.commit(cls.app, "committed, then the push failed", cls.ME, T + 700)
        cls.two_a = cls.commit(cls.app, "first of two in one command", cls.ME, T + 800)
        cls.two_b = cls.commit(cls.app, "second of two in one command", cls.ME, T + 801)
        cls.by_sub = cls.commit(cls.app, "a subagent's", cls.ME, T + 900)
        cls.slow = cls.commit(cls.app, "after a slow pre-commit hook", cls.ME, T + 1290)
        cls.git(cls.app, "notes", "add", "-m", "a note", cls.mine, email=cls.ME, when=T + 1400)  # notes are commits: never listed
        with open(os.path.join(cls.app, ".mailmap"), "w") as f:  # would rename you to someone else
            f.write(f"Other <{cls.OTHER}> <{cls.ME}>\n")
        cls.lib = os.path.join(root, "lib")
        os.makedirs(os.path.join(cls.lib, "sub"))
        cls.git(cls.lib, "init", "-q")
        cls.lib_one = cls.commit(cls.lib, "lib work", cls.GLOBAL, T + 50)
        env = {**os.environ, "GIT_AUTHOR_NAME": "X", "GIT_AUTHOR_EMAIL": cls.GLOBAL, "GIT_AUTHOR_DATE": f"@{T + 50} +0000",
               "GIT_COMMITTER_NAME": "X", "GIT_COMMITTER_EMAIL": cls.GLOBAL, "GIT_COMMITTER_DATE": f"@{T + 5000} +0000"}
        tree = cls.git(cls.lib, "rev-parse", "HEAD^{tree}")
        copy = subprocess.run(["git", "-C", cls.lib, "commit-tree", tree, "-m", "lib work"], capture_output=True, text=True,
                              env=env, stdin=subprocess.DEVNULL, timeout=30).stdout.strip()
        cls.git(cls.lib, "update-ref", "refs/heads/rebased", copy)
        # A message that isn't UTF-8 (an old imported history)
        cls.latin = os.path.join(root, "latin")
        os.makedirs(cls.latin)
        cls.git(cls.latin, "init", "-q")
        ltree = subprocess.run(["git", "-C", cls.latin, "mktree"], input="", capture_output=True, text=True, timeout=30).stdout.strip()
        raw = (f"tree {ltree}\nauthor X <{cls.GLOBAL}> {T} +0000\ncommitter X <{cls.GLOBAL}> {T} +0000\n\n").encode() + b"caf\xe9 raw\n"
        lobj = subprocess.run(["git", "-C", cls.latin, "hash-object", "-t", "commit", "-w", "--stdin"], input=raw,
                              capture_output=True, timeout=30).stdout.decode().strip()
        cls.git(cls.latin, "update-ref", "refs/heads/main", lobj)
        # A partial-clone trap: a promisor remote that would run a program to fetch a missing object
        cls.lazy = os.path.join(root, "lazy")
        os.makedirs(cls.lazy)
        cls.git(cls.lazy, "init", "-q")
        cls.commit(cls.lazy, "lazy repo", cls.GLOBAL, T)
        cls.plain = os.path.join(root, "plain")
        os.makedirs(cls.plain)
        # A repo whose own config would run programs through git.
        cls.trap = os.path.join(root, "trap")
        os.makedirs(cls.trap)
        cls.git(cls.trap, "init", "-q")
        cls.mark = os.path.join(root, "RAN")
        script = os.path.join(root, "evil.sh")
        with open(script, "w") as f:
            f.write(f"#!/bin/sh\necho ran >> '{cls.mark}'\ncat >/dev/null\nexit 0\n")
        os.chmod(script, 0o755)
        base = cls.commit(cls.trap, "first", cls.GLOBAL, T)
        tree = cls.git(cls.trap, "rev-parse", "HEAD^{tree}")
        body = (f"tree {tree}\nparent {base}\nauthor X <{cls.GLOBAL}> {T + 10} +0000\ncommitter X <{cls.GLOBAL}> {T + 10} +0000\n"
                "gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n")
        obj = subprocess.run(["git", "-C", cls.trap, "hash-object", "-t", "commit", "-w", "--stdin"], input=body,
                             capture_output=True, text=True, timeout=30).stdout.strip()
        cls.git(cls.trap, "update-ref", "refs/heads/main", obj)
        for k, v in (("core.pager", script), ("gpg.program", script), ("log.showSignature", "true"),
                     ("diff.external", script), ("core.fsmonitor", script), ("pager.log", script)):
            cls.git(cls.trap, "config", k, v)  # last, so setting up never sets them off
        quick = os.path.join(root, "evil-now.sh")  # records that it ran, then fails at once
        with open(quick, "w") as f:
            f.write(f"#!/bin/sh\necho ran >> '{cls.mark}'\nexit 1\n")
        os.chmod(quick, 0o755)
        for k, v in (("remote.origin.promisor", "true"), ("remote.origin.url", os.path.join(root, "nowhere")),
                     ("remote.origin.uploadpack", quick)):
            cls.git(cls.lazy, "config", k, v)
        with open(os.path.join(cls.lazy, ".git", "refs", "heads", "ghost"), "w") as f:
            f.write("1234567890abcdef1234567890abcdef12345678\n")  # a commit that isn't there
        # Claude Code's record: one commit it ran with the ID in git's reply, one without.
        cls.conf = os.path.join(root, "claude")
        proj = os.path.join(cls.conf, "projects", "-app")
        os.makedirs(proj)
        iso = lambda t: datetime_iso(t)  # noqa: E731
        lines = [
            {"type": "user", "timestamp": iso(T), "cwd": cls.app, "message": {"content": "commit it"}},
            {"type": "assistant", "timestamp": iso(T + 203), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git add -A && git commit -m 'x'"}}]}},
            {"type": "user", "timestamp": iso(T + 204), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": f"[main {cls.by_id[:7]}] x\n 1 file changed"}]}},
            {"type": "assistant", "timestamp": iso(T + 330), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "git commit -q -m 'y'"}}]}},
            {"type": "user", "timestamp": iso(T + 331), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t2", "content": ""}]}},
            {"type": "assistant", "timestamp": iso(T + 10), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "git commit --dry-run"}}]}},
            {"type": "user", "timestamp": iso(T + 11), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t3", "content": "On branch main"}]}},
            # Mentions commit, but isn't one: must not make your commit at T+400 "probably Claude".
            {"type": "assistant", "timestamp": iso(T + 410), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t4", "name": "Bash", "input": {"command": "cat .git/hooks/pre-commit; grep -r \"git commit\" ."}}]}},
            {"type": "user", "timestamp": iso(T + 411), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t4", "content": "#!/bin/sh"}]}},
            # The commit worked, the push after it failed.
            {"type": "assistant", "timestamp": iso(T + 699), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t5", "name": "Bash", "input": {"command": "git commit -m z && git push"}}]}},
            {"type": "user", "timestamp": iso(T + 703), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t5", "is_error": True,
                 "content": f"Exit code 128\n[main {cls.push_failed[:7]}] z\nfatal: unable to access remote"}]}},
            # Two commits in one command.
            {"type": "assistant", "timestamp": iso(T + 799), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t6", "name": "Bash", "input": {"command": "git commit -m a && git commit -m b"}}]}},
            {"type": "user", "timestamp": iso(T + 802), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t6", "content": f"[main {cls.two_a[:7]}] a\n[main {cls.two_b[:7]}] b"}]}},
            # A slow hook: the commit lands 290 s after the run started, before it finished.
            {"type": "assistant", "timestamp": iso(T + 1000), "cwd": cls.app, "message": {"content": [
                {"type": "tool_use", "id": "t8", "name": "Bash", "input": {"command": "git commit -q -m slow"}}]}},
            {"type": "user", "timestamp": iso(T + 1300), "cwd": cls.app, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t8", "content": "hooks done"}]}},
        ]
        with open(os.path.join(proj, cls.SID + ".jsonl"), "w") as f:
            f.write("\n".join(json.dumps(l) for l in lines) + "\n")
        sub = os.path.join(proj, cls.SID, "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-1.jsonl"), "w") as f:  # credited to the session it belongs to
            f.write("\n".join(json.dumps(l) for l in [
                {"type": "assistant", "timestamp": iso(T + 900), "cwd": cls.app, "message": {"content": [
                    {"type": "tool_use", "id": "s1", "name": "Bash", "input": {"command": "git commit -m sub"}}]}},
                {"type": "user", "timestamp": iso(T + 901), "cwd": cls.app, "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "s1", "content": f"[main {cls.by_sub[:7]}] sub"}]}},
            ]) + "\n")
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        # The other AI tools' logs: made-up ones here, never this Mac's.
        cls.tools = os.path.join(root, "tools")
        os.makedirs(cls.tools)
        cls._saved = {k: getattr(serve, k) for k in ("copilot_chat_files", "copilot_cli_dir", "claude_desktop_dir", "KEEP_DIR")}
        cls.copilot_files = []
        serve.copilot_chat_files = lambda: list(cls.copilot_files)
        serve.copilot_cli_dir = lambda: os.path.join(cls.tools, "copilot-cli")
        serve.claude_desktop_dir = lambda: os.path.join(cls.tools, "claude-desktop")
        serve.KEEP_DIR = os.path.join(cls.tools, "kept")
        serve._repo_of_cache.clear(), serve._emails_cache.clear(), serve._repo_log_cache.clear()
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        for k, v in cls._saved.items():
            setattr(serve, k, v)
        for k, v in cls._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        serve._repo_of_cache.clear(), serve._emails_cache.clear(), serve._repo_log_cache.clear()
        cls.tmp.cleanup()

    def post(self, body, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            data = json.dumps(body).encode()
            conn.request("POST", "/api/commits", body=data, headers={"X-Throwbacks": "1", "Content-Type": "application/json"} if headers is None else headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def since(self):
        return self.since_day

    def test_your_commits_tagged(self):
        code, body = self.post({"folders": [self.app, os.path.join(self.lib, "sub"), self.plain], "since": self.since()})
        self.assertEqual(code, 200)
        self.assertEqual(body["folders"][self.plain], None)
        self.assertEqual(body["folders"][os.path.join(self.lib, "sub")], self.lib)  # a subfolder: its repo
        got = {c["id"]: (c["by"], c["session"]) for c in body["repos"][self.app]["commits"]}
        self.assertEqual(got, {
            self.early: ("you", None),              # the first day counts from midnight
            self.mine: ("you", None),
            self.signed: ("claude", None),
            self.by_id: ("claude", self.SID),       # its ID in git's reply to Claude's commit
            self.by_time: ("claude?", self.SID),    # within 2 minutes of a commit Claude ran
            self.global_one: ("you", None),         # your global email counts as yours; "pre-commit" isn't a commit
            self.push_failed: ("claude", self.SID), # the push failed, the commit didn't
            self.two_a: ("claude", self.SID),       # two commits in one command
            self.two_b: ("claude", self.SID),
            self.by_sub: ("claude", self.SID),      # a subagent's, credited to its session
            self.slow: ("claude?", self.SID),       # during a slow run, not only near its start
        })  # not: someone else's, the stash, the note, anything before `since` — and .mailmap renames nobody
        self.assertEqual(len(body["repos"][self.lib]["commits"]), 1)  # a rebased copy is listed once

    def test_one_odd_repo_never_hides_the_others(self):
        code, body = self.post({"folders": [self.latin, self.app], "since": "2000-01-01"})
        self.assertEqual(code, 200)
        self.assertEqual(len(body["repos"][self.latin]["commits"]), 1)  # read, with a replacement character
        self.assertTrue(body["repos"][self.app]["commits"])

    def test_a_missing_object_never_fetches(self):
        cfg = os.path.join(self.lazy, ".git", "config")
        with open(cfg, "rb") as f:
            before = f.read()
        # The trap is real: plain `git log --all` runs the remote's program to fetch, and writes the config.
        subprocess.run(["git", "-C", self.lazy, "log", "--all"], capture_output=True, stdin=subprocess.DEVNULL, timeout=60)
        self.assertTrue(os.path.exists(self.mark))
        os.remove(self.mark)
        with open(cfg, "wb") as f:
            f.write(before)
        serve._repo_log_cache.clear()
        code, body = self.post({"folders": [self.lazy], "since": "2000-01-01"})
        self.assertEqual(code, 200)
        self.assertFalse(os.path.exists(self.mark), "a promisor remote's program ran")
        with open(cfg, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_nothing_in_a_repo_changes(self):
        def snapshot(repo):
            out = []
            for dirpath, _, files in os.walk(os.path.join(repo, ".git")):
                for name in files:
                    st = os.stat(os.path.join(dirpath, name))
                    out.append((os.path.relpath(os.path.join(dirpath, name), repo), st.st_size, st.st_mtime_ns))
            return sorted(out)
        before = snapshot(self.app)
        serve._repo_log_cache.clear()
        self.post({"folders": [self.app], "since": self.since()})
        self.assertEqual(snapshot(self.app), before)

    def test_a_repo_cannot_make_git_run_a_program(self):
        # The trap is real: plain git with this repo's config runs it.
        subprocess.run(["git", "-C", self.trap, "log", "-1", "--show-signature"], capture_output=True,
                       stdin=subprocess.DEVNULL, timeout=30)
        self.assertTrue(os.path.exists(self.mark))
        os.remove(self.mark)
        serve._repo_log_cache.clear()
        code, body = self.post({"folders": [self.trap], "since": "2000-01-01"})
        self.assertEqual(code, 200)
        self.assertEqual(len(body["repos"][self.trap]["commits"]), 2)
        self.assertFalse(os.path.exists(self.mark), "a program configured by the repo ran")

    def test_only_absolute_existing_folders(self):
        code, body = self.post({"folders": ["relative/path", self.app + "\n", "/no/such/folder", 7, self.app], "since": self.since()})
        self.assertEqual(code, 200)
        self.assertEqual(list(body["folders"]), [self.app])
        for bad in ({"folders": self.app, "since": self.since()}, {"folders": [self.app], "since": "yesterday"}, {"since": self.since()}):
            with self.subTest(bad=bad):
                self.assertEqual(self.post(bad)[0], 400)

    def test_guarded_and_off_with_no_import(self):
        self.assertEqual(self.post({"folders": [self.app], "since": self.since()}, headers={"Content-Type": "application/json"})[0], 403)
        old, serve.IMPORT = serve.IMPORT, False
        try:
            self.assertEqual(self.post({"folders": [self.app], "since": self.since()})[0], 404)
        finally:
            serve.IMPORT = old


def datetime_iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


class CommitPlacesTests(unittest.TestCase):
    """Which shell commands make a commit, and where: quoted text is one word,
    `cd` and `git -C` are followed, a throwaway repo is marked, here-documents
    are text."""

    def places(self, cmd, cwd="/w/app"):
        return [(k, where, scratch, amend) for k, where, scratch, amend in serve.commit_places(cmd, cwd)]

    def test_commands(self):
        self.assertEqual(self.places("git add -A && git commit -q -m 'fix: git commit parsing'"), [("commit", "/w/app", False, False)])
        self.assertEqual(self.places("git commit -q -m a && git commit -q -m b"), [("commit", "/w/app", False, False)] * 2)
        self.assertEqual(self.places("cd ../lib && git commit -q -m x"), [("commit", "/w/lib", False, False)])
        self.assertEqual(self.places("git -C /w/other commit -m x"), [("commit", "/w/other", False, False)])
        self.assertEqual(self.places('cd "$REPO" && git commit -m x'), [("commit", None, False, False)])  # a variable: unknown
        self.assertEqual(self.places("git commit --amend --no-edit -q"), [("commit", "/w/app", False, True)])
        self.assertEqual(self.places("/usr/bin/git commit -m x"), [("commit", "/w/app", False, False)])
        self.assertEqual(self.places("bash -c 'cd sub && git commit -m x'"), [("commit", "/w/app/sub", False, False)])
        self.assertEqual(self.places("git merge feature && git revert HEAD"), [("merge", "/w/app", False, False), ("revert", "/w/app", False, False)])
        self.assertEqual(self.places("git commit -q -m x && git push --dry-run"), [("commit", "/w/app", False, False)])
        self.assertEqual(self.places("(cd ../lib && git commit -q -am lib) && git commit -q -am app"),  # a subshell's cd ends with it
                         [("commit", "/w/lib", False, False), ("commit", "/w/app", False, False)])
        self.assertEqual(self.places("pushd ../lib && git commit -q -m a && popd && git commit -q -m b"),
                         [("commit", "/w/lib", False, False), ("commit", "/w/app", False, False)])
        self.assertEqual(self.places("cd ../lib && git commit -q -m a && cd - && git commit -q -m b"),
                         [("commit", "/w/lib", False, False), ("commit", "/w/app", False, False)])
        for cmd in ("if cd ../lib; then git commit -q -m a; fi", "{ cd ../lib && git commit -q -m a; }"):
            self.assertEqual(self.places(cmd), [("commit", "/w/lib", False, False)])
        for cmd in ("bash -lc 'git commit -q -m x'", "sh -ec 'git commit -q -m x'"):
            self.assertEqual(self.places(cmd), [("commit", "/w/app", False, False)])
        self.assertEqual(len(self.places('git commit -m "a<<b"\ngit push\ngit commit -q -m second')), 2)  # not a here-document

    def test_not_commits(self):
        for cmd in ('grep -r "git commit" .', "cat .git/hooks/pre-commit", "git commit --dry-run", "git commit --help",
                    "git merge-base main HEAD", "git merge --squash x", "git revert -n HEAD", "git log --grep=commit",
                    "echo 'git commit -m x'", "git cherry-pick abc1234", "git rebase main"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.places(cmd), [])
                self.assertFalse(serve.is_commit_run(cmd))

    def test_throwaway_repos(self):
        self.assertTrue(all(p[2] for p in self.places('cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m s')))
        self.assertTrue(all(p[2] for p in self.places("cd $(mktemp -d) && git init -q && git commit -q -m s")))
        self.assertTrue(all(p[2] for p in self.places("cd /tmp/x && git init -q && git commit -q -m s")))
        self.assertEqual(self.places("git init -q && git add -A && git commit -q -m 'Initial commit'"),  # a new project, here
                         [("commit", "/w/app", False, False)])
        self.assertEqual(self.places("git -C /tmp/fx init -q && git commit -q -m real"), [("commit", "/w/app", False, False)])
        self.assertTrue(all(p[2] for p in self.places('cd "$TMPDIR/x" && git commit -q -m s')))
        self.assertEqual(self.places("cd /tmp/x && git commit -q -m s"), [("commit", "/tmp/x", False, False)])  # followed: not your repo
        self.assertEqual(self.places("git commit -q -m s", cwd="/tmp/my-chat"), [("commit", "/tmp/my-chat", False, False)])

    def test_here_documents_are_text(self):
        cmd = "git commit -q -F - <<'EOF'\nDon't break: cd /elsewhere && git commit\nEOF\ngit push"
        self.assertEqual(self.places(cmd), [("commit", "/w/app", False, False)])
        heredoc_in_quotes = 'git commit -m "$(cat <<\'EOF\'\nWon\'t break\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"'
        self.assertEqual(self.places(heredoc_in_quotes), [("commit", "/w/app", False, False)])

    def test_marks(self):
        none = ("X", "me@work.example")
        mark = lambda trailers, author=none, committer=none: serve.commit_mark(trailers, author, committer)  # noqa: E731
        self.assertEqual(mark([("Co-Authored-By", "Claude Opus 4.7 (1M context) <noreply@anthropic.com>")]), ("claude", None, "line"))
        self.assertEqual(mark([("Co-authored-by", "Copilot <223556219+Copilot@users.noreply.github.com>")]), ("copilot", "copilot-cli", "line"))
        self.assertEqual(mark([("Co-authored-by", "Copilot <copilot@github.com>")]), ("copilot", "copilot", "line"))
        self.assertEqual(mark([("Co-authored-by", "Cursor <cursoragent@cursor.com>")]), ("cursor", "cursor", "line"))
        self.assertEqual(mark([("Made-with", "Cursor")]), ("cursor", "cursor", "line"))
        self.assertEqual(mark([("Claude-Session", "https://claude.ai/code/session_1")]), ("claude", None, "line"))
        self.assertEqual(mark([("Co-authored-by", "aider (gpt-5) <aider@aider.chat>")]), ("aider", None, "line"))
        self.assertEqual(mark([("Co-authored-by", "Codex <noreply@openai.com>")]), ("codex", None, "line"))
        self.assertEqual(mark([("Co-authored-by", "Gemini CLI <gemini-cli@google.com>")]), ("gemini", None, "line"))
        self.assertEqual(mark([("Assisted-by", "SomeTool v2")]), ("ai", None, "line"))
        self.assertEqual(mark([("Co-authored-by", "Pat <pat@example.com>"), ("Signed-off-by", "X <me@work.example>")]), None)
        self.assertEqual(mark([], author=("copilot-swe-agent[bot]", "198982749+Copilot@users.noreply.github.com")), ("copilot", None, "author"))
        self.assertEqual(mark([], author=("Claude", "noreply@anthropic.com")), ("claude", None, "author"))
        self.assertEqual(mark([], committer=("X (aider)", "me@work.example")), ("aider", None, "author"))
        self.assertEqual(mark([("Co-authored-by", "Claude Dubois <claude.dubois@work.example>")]), None)  # a colleague
        self.assertEqual(mark([("Co-authored-by", "Devin Patel <devin.patel@work.example>")]), None)
        self.assertEqual(mark([("Generated-by", "release-script"), ("Co-authored-by", "Claude <noreply@anthropic.com>")]), ("claude", None, "line"))
        self.assertEqual(mark([("Assisted-by", "Claude:claude-opus coccinelle")]), ("claude", None, "line"))
        self.assertTrue(serve._names_you([("Co-authored-by", "X <me@work.example>")], ["me@work.example"], []))
        self.assertFalse(serve._names_you([("Co-authored-by", "Tim <tim.me@work.example>")], ["me@work.example"], []))


class CommitToolTests(unittest.TestCase):
    """Who made a commit, for every AI tool's own record and every commit mark:
    a quiet run that made three commits, an amend, a commit amended away since
    (its copy), a run that went into another repo, a throwaway repo, a failed
    push, a kept copy of a deleted chat, Copilot in VS Code's and Copilot CLI's
    logs, co-author lines, and a cloud agent's commit that names you. Made-up
    repos and logs in a temp folder only."""

    ME, GLOBAL = "me@work.example", "me@home.example"
    SID, KEPT = "aaaaaaaa-1111-4222-8333-444444444444", "bbbbbbbb-1111-4222-8333-444444444444"
    T = 1_791_100_000

    @classmethod
    def commit(cls, repo, msg, at, committed=None, email=None, name="X", committer_name="X", committer_email=None):
        env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email or cls.ME,
               "GIT_COMMITTER_NAME": committer_name, "GIT_COMMITTER_EMAIL": committer_email or email or cls.ME,
               "GIT_AUTHOR_DATE": f"@{at} +0000", "GIT_COMMITTER_DATE": f"@{committed or at} +0000"}
        r = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", repo, "commit", "-q",
                            "--allow-empty", "-m", msg], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30)
        if r.returncode:
            raise AssertionError(r.stderr)
        return CommitTests.git(repo, "rev-parse", "HEAD")

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = os.path.realpath(cls.tmp.name)
        cls._env = {k: os.environ.get(k) for k in ("CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")}
        cls._saved = {k: getattr(serve, k) for k in ("copilot_chat_files", "copilot_cli_dir", "claude_desktop_dir", "KEEP_DIR")}
        gcfg = os.path.join(root, "gitconfig")
        with open(gcfg, "w") as f:
            f.write(f"[user]\n\temail = {cls.GLOBAL}\n\tname = X\n[init]\n\tdefaultBranch = main\n")
        os.environ.update(GIT_CONFIG_GLOBAL=gcfg, GIT_CONFIG_NOSYSTEM="1")
        T, git = cls.T, CommitTests.git
        cls.w, cls.other = os.path.join(root, "w"), os.path.join(root, "other")
        for repo in (cls.w, cls.other):
            os.makedirs(repo)
            git(repo, "init", "-q")
            git(repo, "config", "user.email", cls.ME)
        c = {}
        c["q1"], c["q2"], c["q3"] = (cls.commit(cls.w, f"quiet {i}", T + 12 + 2 * i) for i in range(3))
        c["amended"] = cls.commit(cls.w, "amended by Claude", T - 5000, committed=T + 105)
        # A commit Claude printed, then amended away: only its copy (same message and author time) is on a branch.
        tree = git(cls.w, "rev-parse", "HEAD^{tree}")
        env = {**os.environ, "GIT_AUTHOR_NAME": "X", "GIT_AUTHOR_EMAIL": cls.ME, "GIT_COMMITTER_NAME": "X",
               "GIT_COMMITTER_EMAIL": cls.ME, "GIT_AUTHOR_DATE": f"@{T + 200} +0000", "GIT_COMMITTER_DATE": f"@{T + 200} +0000"}
        mk = lambda: subprocess.run(["git", "-C", cls.w, "commit-tree", tree, "-p", "HEAD", "-m", "rewritten one"],  # noqa: E731
                                    capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=30).stdout.strip()
        c["gone"] = mk()  # on no branch
        env["GIT_COMMITTER_DATE"] = f"@{T + 5000} +0000"
        c["copy"] = mk()
        git(cls.w, "update-ref", "refs/heads/main", c["copy"])
        c["in_other"] = cls.commit(cls.other, "Claude's, after cd ../other", T + 301)
        c["mine_meanwhile"] = cls.commit(cls.w, "mine, while Claude worked in the other repo", T + 301)
        c["mine_scratch"] = cls.commit(cls.w, "mine, while Claude played in a temp repo", T + 401)
        c["push_failed"] = cls.commit(cls.w, "quiet, then the push failed", T + 501)
        c["mine_after_fail"] = cls.commit(cls.w, "mine, a minute after a failed run", T + 650)
        c["kept"] = cls.commit(cls.w, "from a chat Claude Code deleted", T + 700)
        c["vscode"] = cls.commit(cls.w, "Copilot in VS Code's", T + 801)
        c["vscode_old"] = cls.commit(cls.w, "older Copilot Chat's", T + 910)
        c["cli"] = cls.commit(cls.w, "Copilot CLI's", T + 1000)
        c["mine_denied"] = cls.commit(cls.w, "mine, Copilot CLI was refused", T + 1100)
        for key, msg in (("t_cli", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"),
                         ("t_vscode", "Co-authored-by: Copilot <copilot@github.com>"), ("t_made", "Made-with: Cursor"),
                         ("t_aider", "Co-authored-by: aider (gpt-5) <aider@aider.chat>"), ("t_assist", "Assisted-by: SomeTool"),
                         ("t_codex", "Co-authored-by: Codex <noreply@openai.com>"), ("t_human", "Co-authored-by: Pat <pat@example.com>")):
            c[key] = cls.commit(cls.w, f"{key}\n\n{msg}", T + 2000 + len(c) * 300)
        c["t_aider_committer"] = cls.commit(cls.w, "aider's dirty-file commit", T + 9000, committer_name="X (aider)")
        c["bot_names_you"] = cls.commit(cls.w, f"cloud agent work\n\nCo-authored-by: X <{cls.ME}>", T + 9300,
                                        email="198982749+Copilot@users.noreply.github.com", name="copilot-swe-agent[bot]")
        cls.commit(cls.w, "cloud agent work for someone else\n\nCo-authored-by: Pat <pat@example.com>", T + 9600,
                   email="198982749+Copilot@users.noreply.github.com", name="copilot-swe-agent[bot]")
        cls.c = c
        cls.since_day = time.strftime("%Y-%m-%d", time.localtime(T - 86400))
        iso = datetime_iso

        def bash(tid, at, done, cmd, out, cwd=None, error=False):
            res = {"type": "tool_result", "tool_use_id": tid, "content": out}
            if error:
                res["is_error"] = True
            return [{"type": "assistant", "timestamp": iso(at), "cwd": cwd or cls.w, "message": {"content": [
                        {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd}}]}},
                    {"type": "user", "timestamp": iso(done), "cwd": cwd or cls.w, "message": {"content": [res]}}]
        lines = [{"type": "user", "timestamp": iso(T), "cwd": cls.w, "message": {"content": "commit it"}}]
        lines += bash("q", T + 10, T + 20, "for i in 0 1 2; do git commit -q --allow-empty -m \"quiet $i\"; done", "")
        lines += bash("a", T + 100, T + 110, "git commit --amend -q --no-edit", "")
        lines += bash("r", T + 199, T + 201, "git commit -m 'rewritten one'", f"[main {c['gone'][:7]}] rewritten one")
        lines += bash("o", T + 300, T + 302, "cd ../other && git commit -q -m o", "")
        lines += bash("s", T + 400, T + 402, 'cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m s', "")
        lines += bash("f", T + 500, T + 503, "git commit -q -m f && git push", "fatal: unable to access remote", error=True)
        lines += bash("n", T + 600, T + 601, "git commit -q -m nothing", "nothing to commit", error=True)
        cls.conf = os.path.join(root, "claude")
        proj = os.path.join(cls.conf, "projects", "-w")
        os.makedirs(proj)
        with open(os.path.join(proj, cls.SID + ".jsonl"), "w") as f:
            f.write("\n".join(json.dumps(l) for l in lines) + "\n")
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        tools = os.path.join(root, "tools")
        serve.KEEP_DIR = os.path.join(tools, "kept")
        os.makedirs(serve.KEEP_DIR)
        with gzip.open(os.path.join(serve.KEEP_DIR, cls.KEPT + ".jsonl.gz"), "wt") as f:
            f.write("\n".join(json.dumps(l) for l in bash("k", T + 699, T + 701, "git commit -m k", f"[main {c['kept'][:7]}] k")) + "\n")
        # Copilot in VS Code: an op log (a request pushed, with its terminal run), and an older chat's command-only run.
        chats = os.path.join(tools, "vscode", "chatSessions")
        os.makedirs(chats)
        run = {"kind": "toolInvocationSerialized", "toolId": "run_in_terminal", "toolCallId": "call-1", "toolSpecificData": {
            "kind": "terminal", "commandLine": {"original": "git commit -m cp"}, "cwd": {"scheme": "file", "fsPath": cls.w, "path": cls.w},
            "terminalCommandId": "term-1", "terminalCommandState": {"timestamp": (T + 800) * 1000, "duration": 2000, "exitCode": 0},
            "terminalCommandOutput": {"text": f"[main {c['vscode'][:7]}] cp\n 0 files changed"}}}
        ops = [{"kind": 0, "v": {"sessionId": "cp-1", "requests": []}},
               {"kind": 2, "k": ["requests"], "v": [{"requestId": "r1", "timestamp": (T + 799) * 1000, "response": []}]},
               {"kind": 2, "k": ["requests", 0, "response"], "v": [{"value": "Committing."}, run]}]
        with open(os.path.join(chats, "cp-1.jsonl"), "w") as f:
            f.write("\n".join(json.dumps(o) for o in ops) + "\n")
        old = {"sessionId": "cp-2", "requests": [{"requestId": "r", "timestamp": (T + 900) * 1000, "elapsedMs": 30000, "response": [
            {"kind": "toolInvocationSerialized", "toolId": "copilot_runInTerminal", "toolSpecificData": {"command": "git commit -q -m old"}}]}]}
        with open(os.path.join(chats, "cp-2.json"), "w") as f:
            json.dump(old, f)
        files = [(os.path.join(chats, "cp-1.jsonl"), cls.w), (os.path.join(chats, "cp-2.json"), cls.w)]
        serve.copilot_chat_files = lambda: list(files)
        # Copilot CLI: a run with its ID, and one you refused.
        cli = os.path.join(tools, "copilot", "session-state", "cli-1")
        os.makedirs(cli)
        with open(os.path.join(cli, "workspace.yaml"), "w") as f:
            f.write(f"id: cli-1\ncwd: {cls.w}\n")
        ev = lambda t, kind, data: {"type": kind, "timestamp": iso(t), "data": data}  # noqa: E731
        events = [ev(T + 990, "session.start", {"context": {"cwd": cls.w}}),
                  ev(T + 999, "tool.execution_start", {"toolName": "bash", "toolCallId": "c1", "arguments": {"command": "git commit -m cli"}}),
                  ev(T + 1001, "tool.execution_complete", {"toolCallId": "c1", "success": True,
                                                           "result": {"content": f"[main {c['cli'][:7]}] cli\n<exited with exit code 0>"}}),
                  ev(T + 1099, "tool.execution_start", {"toolName": "bash", "toolCallId": "c2", "arguments": {"command": "git commit -q -m nope"}}),
                  ev(T + 1101, "tool.execution_complete", {"toolCallId": "c2", "success": False, "error": {"code": "denied", "message": "no"}})]
        with open(os.path.join(cli, "events.jsonl"), "w") as f:
            f.write("\n".join(json.dumps(e) for e in events) + "\n")
        serve.copilot_cli_dir = lambda: os.path.join(tools, "copilot")
        serve.claude_desktop_dir = lambda: os.path.join(tools, "claude-desktop")
        serve._repo_of_cache.clear(), serve._emails_cache.clear(), serve._repo_log_cache.clear(), serve._runs_cache.clear()

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._saved.items():
            setattr(serve, k, v)
        for k, v in cls._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        serve._repo_of_cache.clear(), serve._emails_cache.clear(), serve._repo_log_cache.clear(), serve._runs_cache.clear()
        cls.tmp.cleanup()

    maxDiff = None

    def test_who_made_each(self):
        body = serve.your_commits([self.w, self.other], self.since_day)
        names = {v: k for k, v in self.c.items()}
        got = {names.get(x["id"], x["id"]): (x["by"], x["via"], x["app"], x["session"])
               for top in (self.w, self.other) for x in body["repos"][top]["commits"]}
        S = self.SID
        want = {
            "q1": ("claude?", "time", "code", S), "q2": ("claude?", "time", "code", S), "q3": ("claude?", "time", "code", S),
            "amended": ("claude?", "time", "code", S),                    # by when it was committed: an amend keeps its old author time
            "copy": ("claude", "copy", "code", S),                        # the commit Claude printed was amended away: its copy
            "in_other": ("claude?", "time", "code", S),                   # it went `cd ../other`
            "mine_meanwhile": ("you", None, None, None),                  # …so the session's own repo isn't Claude's then
            "mine_scratch": ("you", None, None, None),                    # a throwaway repo claims nothing
            "push_failed": ("claude?", "time", "code", S),                # committed quietly, then the push failed
            "mine_after_fail": ("you", None, None, None),                 # a failed run claims only what landed during it
            "kept": ("claude", "record", "code", self.KEPT),              # read from the copy Throwbacks kept
            "vscode": ("copilot", "record", "copilot", "cp-1"),           # Copilot in VS Code's own record
            "vscode_old": ("copilot?", "time", "copilot", "cp-2"),        # an older chat: only the command and its request's time
            "cli": ("copilot", "record", "copilot-cli", "cli-1"),         # Copilot CLI's own record
            "mine_denied": ("you", None, None, None),                     # a run you refused never ran
            "t_cli": ("copilot", "line", "copilot-cli", None), "t_vscode": ("copilot", "line", "copilot", None),
            "t_made": ("cursor", "line", "cursor", None), "t_aider": ("aider", "line", None, None),
            "t_assist": ("ai", "line", None, None), "t_codex": ("codex", "line", None, None),
            "t_human": ("you", None, None, None), "t_aider_committer": ("aider", "author", None, None),
            "bot_names_you": ("copilot", "author", None, None),           # a cloud agent's commit that names you
        }
        self.assertEqual({k: got.get(k) for k in want}, want)
        self.assertNotIn(self.c["gone"], got)                             # on no branch: never listed itself
        self.assertEqual(len(got), len(want))                             # not: the cloud agent's commit for someone else

    def test_reads_change_nothing(self):
        def snapshot(*roots):
            out = []
            for r in roots:
                for dirpath, _, files in os.walk(r):
                    for name in files:
                        st = os.stat(os.path.join(dirpath, name))
                        out.append((os.path.join(dirpath, name), st.st_size, st.st_mtime_ns))
            return sorted(out)
        roots = (os.path.join(self.w, ".git"), self.conf, serve.KEEP_DIR, serve.copilot_cli_dir())
        before = snapshot(*roots)
        serve._repo_log_cache.clear(), serve._runs_cache.clear()
        serve.your_commits([self.w, self.other], self.since_day)
        self.assertEqual(snapshot(*roots), before)


class CommitReviewTests(unittest.TestCase):
    """The cases the review of 2026-11-02 found: a long run doesn't take your commit made
    while it ran, the shorter of two overlapping runs wins, a line naming an app keeps it,
    a cloud agent's commit you committed is listed, a colleague called Claude is a
    colleague, a scaffold's first commit counts, an ID from a test's output doesn't hide
    the real commit, an amend after a rebase takes one commit, same-second commits stay
    apart, your commit Claude copied stays yours, a background run's later output counts,
    and odd log lines never break the answer. Made-up repos and logs only."""

    ME = CommitToolTests.ME
    SID = "cccccccc-1111-4222-8333-444444444444"
    T = 1_791_200_000
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = os.path.realpath(cls.tmp.name)
        cls._env = {k: os.environ.get(k) for k in ("CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM")}
        cls._saved = {k: getattr(serve, k) for k in ("copilot_chat_files", "copilot_cli_dir", "claude_desktop_dir", "KEEP_DIR")}
        gcfg = os.path.join(root, "gitconfig")
        with open(gcfg, "w") as f:
            f.write(f"[user]\n\temail = {CommitToolTests.GLOBAL}\n\tname = X\n[init]\n\tdefaultBranch = main\n")
        os.environ.update(GIT_CONFIG_GLOBAL=gcfg, GIT_CONFIG_NOSYSTEM="1")
        T, git, commit = cls.T, CommitTests.git, CommitToolTests.commit
        cls.w = os.path.join(root, "w")
        os.makedirs(cls.w)
        git(cls.w, "init", "-q")
        git(cls.w, "config", "user.email", cls.ME)
        bot = dict(email="198982749+Copilot@users.noreply.github.com", name="copilot-swe-agent[bot]")
        c = {}
        c["mine_during_long"] = commit(cls.w, "mine, while Claude's tests ran", T + 100)
        c["long"] = commit(cls.w, "Claude's, after six minutes of tests", T + 358)
        c["short"] = commit(cls.w, "Claude's short run, inside Copilot's long one", T + 1101)
        c["cc"] = commit(cls.w, "Copilot CLI's, at the end of its long run", T + 1299)
        c["cli_line"] = commit(cls.w, "cli line\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>", T + 2001)
        c["bot_committed_by_me"] = commit(cls.w, "cloud agent work I rebased", T + 3000, committer_email=cls.ME, **bot)
        c["colleague_claude"] = commit(cls.w, "pairing\n\nCo-authored-by: Claude Dubois <claude.dubois@work.example>", T + 3300)
        c["generated_then_claude"] = commit(cls.w, "release\n\nGenerated-by: release-script\nCo-authored-by: Claude <noreply@anthropic.com>", T + 3600)
        c["scaffold"] = commit(cls.w, "Initial commit", T + 4001)
        c["after_tests"] = commit(cls.w, "Claude's, after tests that print a fixture's commit", T + 5009)
        c["topic1"] = commit(cls.w, "topic one", T - 9000, committed=T + 6005)
        c["topic2"] = commit(cls.w, "topic two", T - 8000, committed=T + 6006)
        c["amended"] = commit(cls.w, "amended by Claude after the rebase", T - 7000, committed=T + 6008)
        c["loop1"], c["loop2"], c["loop3"] = (commit(cls.w, "chore: format", T + 7000) for _ in range(3))
        # Your commit on a branch; Claude cherry-picks it onto main and prints the copy's ID.
        tree = git(cls.w, "rev-parse", "HEAD^{tree}")
        def mk(committed, parent):  # noqa: E306
            env = {**os.environ, "GIT_AUTHOR_NAME": "X", "GIT_AUTHOR_EMAIL": cls.ME, "GIT_COMMITTER_NAME": "X", "GIT_COMMITTER_EMAIL": cls.ME,
                   "GIT_AUTHOR_DATE": f"@{T + 8000} +0000", "GIT_COMMITTER_DATE": f"@{committed} +0000"}
            return subprocess.run(["git", "-C", cls.w, "commit-tree", tree, "-p", parent, "-m", "my feature work"], capture_output=True,
                                  text=True, env=env, stdin=subprocess.DEVNULL, timeout=30).stdout.strip()
        head = git(cls.w, "rev-parse", "HEAD")
        c["feature_orig"] = mk(T + 8000, head)
        git(cls.w, "update-ref", "refs/heads/feature", c["feature_orig"])
        c["feature_copy"] = mk(T + 8100, head)
        git(cls.w, "update-ref", "refs/heads/main", c["feature_copy"])
        c["bg"] = commit(cls.w, "Claude's, in the background", T + 9020)
        commit(cls.w, "cloud agent work for Tim\n\nCo-authored-by: Tim <tim.me@work.example>", T + 9300, **bot)
        c["mine_after_odd_logs"] = commit(cls.w, "mine, read past odd log lines", T + 9600)
        cls.c = c
        cls.since_day = time.strftime("%Y-%m-%d", time.localtime(T - 86400))
        iso = datetime_iso

        def bash(tid, at, done, cmd, out, error=False, bg=False):
            res = {"type": "tool_result", "tool_use_id": tid, "content": out}
            if error:
                res["is_error"] = True
            use = {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": cmd, **({"run_in_background": True} if bg else {})}}
            return [{"type": "assistant", "timestamp": iso(at), "cwd": cls.w, "sessionId": cls.SID, "message": {"content": [use]}},
                    {"type": "user", "timestamp": iso(done), "cwd": cls.w, "sessionId": cls.SID, "message": {"content": [res]}}]
        lines = []
        lines += bash("long", T, T + 360, "npm test && git add -A && git commit -q -m long", "")
        lines += bash("short", T + 1100, T + 1102, "git commit -q -m short", "")
        lines += bash("init", T + 4000, T + 4002, "git init -q && git add -A && git commit -q -m 'Initial commit'", "")
        lines += bash("fx", T + 5000, T + 5010, "python -m pytest -q && git commit -q -am fix", "[master (root-commit) deadbee] fixture\n1 passed")
        lines += bash("amend", T + 6000, T + 6010, "git rebase -q main && git commit --amend -q --no-edit", "")
        lines += bash("pick", T + 8099, T + 8101, "git cherry-pick feature || (git add -A && git commit --no-edit)",
                      f"[main {c['feature_copy'][:7]}] my feature work")
        lines += bash("bg", T + 9000, T + 9001, "git commit -q -m bg", "Command running in background with ID: bash_7", bg=True)
        lines += [{"type": "assistant", "timestamp": iso(T + 9030), "cwd": cls.w, "message": {"content": [
                      {"type": "tool_use", "id": "out", "name": "BashOutput", "input": {"bash_id": "bash_7"}}]}},
                  {"type": "user", "timestamp": iso(T + 9031), "cwd": cls.w, "message": {"content": [
                      {"type": "tool_result", "tool_use_id": "out", "content": f"[main {c['bg'][:7]}] bg"}]}}]
        # Odd lines: a Bash input that's a string, a result that's null.
        lines += [{"type": "assistant", "timestamp": iso(T + 9500), "cwd": cls.w, "message": {"content": [
                      {"type": "tool_use", "id": "odd", "name": "Bash", "input": "git commit -q -m odd"}]}},
                  {"type": "user", "timestamp": iso(T + 9501), "cwd": cls.w, "message": {"content": [
                      {"type": "tool_result", "tool_use_id": "odd", "content": None}]}}]
        cls.conf = os.path.join(root, "claude")
        proj = os.path.join(cls.conf, "projects", "-w")
        os.makedirs(proj)
        with open(os.path.join(proj, cls.SID + ".jsonl"), "w") as f:
            f.write("\n".join(json.dumps(l) for l in lines) + "\n")
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        tools = os.path.join(root, "tools")
        serve.KEEP_DIR = os.path.join(tools, "kept")
        # Copilot in VS Code: a build that failed before its commit, while a Copilot CLI-lined commit landed.
        chats = os.path.join(tools, "vscode")
        os.makedirs(chats)
        run = {"kind": "toolInvocationSerialized", "toolId": "run_in_terminal", "toolSpecificData": {
            "kind": "terminal", "commandLine": {"original": "npm run build && git commit -q -m vs"}, "cwd": {"scheme": "file", "fsPath": cls.w},
            "terminalCommandId": "t-vs", "terminalCommandState": {"timestamp": (T + 2000) * 1000, "duration": 5000, "exitCode": 1},
            "terminalCommandOutput": {"text": "npm ERR! build failed"}}}
        with open(os.path.join(chats, "vs-1.json"), "w") as f:
            json.dump({"sessionId": "vs-1", "requests": [{"timestamp": (T + 1999) * 1000, "response": [run]}]}, f)
        serve.copilot_chat_files = lambda: [(os.path.join(chats, "vs-1.json"), cls.w), (os.path.join(chats, "missing.json"), cls.w)]
        # Copilot CLI: a long run that ends in a commit, and odd lines (a list as an ID, a line nested too deep).
        cli = os.path.join(tools, "copilot", "session-state", "cli-2")
        os.makedirs(cli)
        with open(os.path.join(cli, "workspace.yaml"), "w") as f:
            f.write(f"id: cli-2\ncwd: {cls.w}\n")
        ev = lambda t, kind, data: json.dumps({"type": kind, "timestamp": iso(t), "data": data})  # noqa: E731
        deep = "[" * 1200 + "]" * 1200
        with open(os.path.join(cli, "events.jsonl"), "w") as f:
            f.write("\n".join([
                ev(T + 999, "session.start", {"context": {"cwd": cls.w}}),
                ev(T + 1000, "tool.execution_start", {"toolName": "bash", "toolCallId": "c1", "arguments": {"command": "make check && git commit -q -m cc"}}),
                ev(T + 1300, "tool.execution_complete", {"toolCallId": "c1", "success": True, "result": {"content": "ok\n<exited with exit code 0>"}}),
                ev(T + 1400, "tool.execution_start", {"toolName": "bash", "toolCallId": ["x"], "arguments": {"command": "git commit -q -m odd"}}),
                '{"type": "tool.execution_complete", "timestamp": "%s", "data": {"toolCallId": "z", "result": %s}}' % (iso(T + 1401), deep),
            ]) + "\n")
        serve.copilot_cli_dir = lambda: os.path.join(tools, "copilot")
        serve.claude_desktop_dir = lambda: os.path.join(tools, "claude-desktop")
        serve._repo_of_cache.clear(), serve._emails_cache.clear(), serve._repo_log_cache.clear(), serve._runs_cache.clear()

    @classmethod
    def tearDownClass(cls):
        CommitToolTests.tearDownClass.__func__(cls)

    def test_review_cases(self):
        body = serve.your_commits([self.w], self.since_day)
        names = {v: k for k, v in self.c.items()}
        got = {}
        for x in body["repos"][self.w]["commits"]:
            got.setdefault(names.get(x["id"], x["id"]), []).append((x["by"], x["via"], x["app"], x["session"]))
        S, you = self.SID, [("you", None, None, None)]
        want = {
            "long": [("claude?", "time", "code", S)], "mine_during_long": you,      # one commit made, the one at its end
            "short": [("claude?", "time", "code", S)],                               # the shorter of two overlapping runs
            "cc": [("copilot?", "time", "copilot-cli", "cli-2")],
            "cli_line": [("copilot", "line", "copilot-cli", None)],                  # a failed VS Code run takes nothing
            "bot_committed_by_me": [("copilot", "author", None, None)],              # a cloud agent's, committed by you
            "colleague_claude": you,                                                  # a colleague called Claude
            "generated_then_claude": [("claude", "line", None, None)],
            "scaffold": [("claude?", "time", "code", S)],                            # `git init` here, then its first commit
            "after_tests": [("claude?", "time", "code", S)],                         # a fixture's ID in the output hides nothing
            "amended": [("claude?", "time", "code", S)], "topic1": you, "topic2": you,  # an amend takes one commit
            "loop1": you, "loop2": you, "loop3": you,                                # made in one second: three commits
            "bg": [("claude", "record", "code", S)],                                 # a background run's later output
            "mine_after_odd_logs": you,                                               # odd log lines are skipped
        }
        self.assertEqual({k: got.get(k) for k in want}, want)
        copies = got.get("feature_orig", []) + got.get("feature_copy", [])
        self.assertEqual(copies, you)                                                # your commit, copied by Claude, listed once: yours
        self.assertEqual(len(got), len(want) + 1)                                    # not: the cloud agent's for Tim


class KeepTests(unittest.TestCase):
    """Keeping a copy of a chat Claude Code will delete: /api/keep (GET the
    setting and the copies, POST to keep one, DELETE to remove a copy), and
    the import showing a kept chat after its original is gone. Made-up files
    in a temp folder; nothing in Claude Code's folder is ever written."""

    ID = "22222222-3333-4444-8555-666666666666"
    OTHER = "33333333-4444-4555-8666-777777777777"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = os.path.realpath(cls.tmp.name)
        cls._env, cls._keep, cls._store = os.environ.get("CLAUDE_CONFIG_DIR"), serve.KEEP_DIR, serve.STORE
        cls.conf = os.path.join(root, "claude")
        cls.proj = os.path.join(cls.conf, "projects", "-work-app")
        os.makedirs(cls.proj)
        with open(os.path.join(cls.conf, "settings.json"), "w") as f:
            json.dump({"cleanupPeriodDays": 45, "theme": "dark"}, f)
        cls.src = os.path.join(cls.proj, cls.ID + ".jsonl")
        cls.lines = [{"type": "user", "timestamp": "2026-10-01T10:00:00.000Z", "cwd": "/work/app", "message": {"content": "keep me"}},
                     {"type": "assistant", "timestamp": "2026-10-01T10:01:00.000Z", "message": {"content": [{"type": "text", "text": "kept"}]}}]
        with open(cls.src, "w") as f:
            f.write("\n".join(json.dumps(l) for l in cls.lines) + "\n")
        with open(os.path.join(cls.proj, cls.OTHER + ".jsonl"), "w") as f:
            f.write(json.dumps(cls.lines[0]) + "\n")
        os.environ["CLAUDE_CONFIG_DIR"] = cls.conf
        serve.KEEP_DIR = os.path.join(root, "throwbacks", "kept", "claude-code")
        serve.STORE = True
        cls.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        serve.KEEP_DIR, serve.STORE = cls._keep, cls._store
        if cls._env is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = cls._env
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            data = json.dumps(body).encode() if body is not None else None
            conn.request(method, path, body=data, headers={"X-Throwbacks": "1", "Content-Type": "application/json"} if headers is None else headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def snapshot(self):
        out = []
        for dirpath, _, files in os.walk(self.conf):
            for name in files:
                st = os.stat(os.path.join(dirpath, name))
                out.append((os.path.relpath(os.path.join(dirpath, name), self.conf), st.st_size, st.st_mtime_ns))
        return sorted(out)

    def test_1_keep_list_survive_remove(self):
        before = self.snapshot()
        code, body = self.call("GET", "/api/keep")
        self.assertEqual((code, body["retention"], body["kept"]), (200, {"days": 45, "set": True, "source": "user", "paused": False}, []))
        code, body = self.call("POST", "/api/keep", {"id": self.ID})
        self.assertEqual(code, 200)
        gz = os.path.join(serve.KEEP_DIR, self.ID + ".jsonl.gz")
        with open(self.src, "rb") as f, gzip.open(gz, "rb") as g:
            self.assertEqual(g.read(), f.read())  # the whole transcript, as it was
        self.assertEqual(stat_mode(gz), 0o600)
        self.assertEqual(stat_mode(serve.KEEP_DIR), 0o700)
        self.assertEqual(self.snapshot(), before)  # nothing in Claude Code's folder changed
        files = {f["name"]: f for f in serve.collect_claude_code()["files"]}
        self.assertTrue(files[self.ID + ".jsonl"]["kept"])
        self.assertFalse(files[self.OTHER + ".jsonl"]["kept"])
        self.assertIsInstance(files[self.ID + ".jsonl"]["mtime"], int)
        # Claude Code deletes the original (we do it for the test): the kept copy still shows.
        os.rename(self.src, self.src + ".away")
        try:
            files = {f["name"]: f for f in serve.collect_claude_code()["files"]}
            self.assertTrue(files[self.ID + ".jsonl"]["onlyKept"])
            self.assertIn("keep me", files[self.ID + ".jsonl"]["text"])
            self.assertEqual(self.call("GET", "/api/keep")[1]["kept"][0]["original"], False)
        finally:
            os.rename(self.src + ".away", self.src)
        # The original keeps changing: the copy follows it.
        with open(self.src, "a") as f:
            f.write(json.dumps({"type": "user", "timestamp": "2026-10-02T09:00:00.000Z", "message": {"content": "more"}}) + "\n")
        os.utime(self.src, (time.time() + 5, time.time() + 5))
        self.call("GET", "/api/keep")
        with gzip.open(gz, "rt") as g:
            self.assertIn('"more"', g.read())
        self.assertEqual(self.call("DELETE", f"/api/keep?id={self.ID}")[0], 200)
        self.assertFalse(os.path.exists(gz))
        self.assertEqual(self.call("GET", "/api/keep")[1]["kept"], [])
        self.assertTrue(os.path.exists(self.src))  # removing the copy never touches the original

    def test_a_long_chat_is_still_read_and_kept(self):
        # Claude Code's transcripts are trimmed a line at a time: the other apps' limit doesn't
        # apply to them (a long-running chat would vanish), only a far larger one does.
        size = os.path.getsize(self.src)
        saved = serve.IMPORT_MAX_FILE, serve.CLAUDE_CODE_MAX_FILE
        try:
            serve.IMPORT_MAX_FILE = 10
            self.assertIn(self.ID + ".jsonl", {f["name"] for f in serve.collect_claude_code()["files"]})
            self.assertEqual(self.call("POST", "/api/keep", {"id": self.ID})[0], 200)
            serve.CLAUDE_CODE_MAX_FILE = size - 1
            self.assertNotIn(self.ID + ".jsonl", {f["name"] for f in serve.collect_claude_code()["files"] if not f.get("onlyKept")})
            code, body = self.call("POST", "/api/keep", {"id": self.ID})
            self.assertNotEqual(code, 200)
        finally:
            serve.IMPORT_MAX_FILE, serve.CLAUDE_CODE_MAX_FILE = saved
            self.call("DELETE", f"/api/keep?id={self.ID}")

    def test_only_a_session_id(self):
        for body in ({"id": "../../etc/passwd"}, {"id": "*"}, {}, {"id": self.ID + "\n"}):
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/api/keep", body)[0], 400)
        self.assertEqual(self.call("POST", "/api/keep", {"id": "44444444-5555-4666-8777-888888888888"})[0], 404)  # no such session
        self.assertEqual(self.call("DELETE", "/api/keep?id=..%2F..%2Fx")[0], 400)

    def test_guarded_and_off_with_no_store(self):
        self.assertEqual(self.call("POST", "/api/keep", {"id": self.ID}, headers={"Content-Type": "application/json"})[0], 403)
        serve.STORE = False
        try:
            self.assertEqual(self.call("POST", "/api/keep", {"id": self.ID})[0], 404)
            self.assertFalse(any(f.get("kept") for f in serve.collect_claude_code()["files"]))
        finally:
            serve.STORE = True

    def test_default_setting(self):
        os.rename(os.path.join(self.conf, "settings.json"), os.path.join(self.conf, "s.bak"))
        try:
            self.assertEqual(serve.claude_retention(), {"days": 30, "set": False, "source": "default", "paused": False})
        finally:
            os.rename(os.path.join(self.conf, "s.bak"), os.path.join(self.conf, "settings.json"))

    def test_the_setting_claude_code_really_uses(self):
        user = os.path.join(self.conf, "settings.json")
        project = os.path.join("/work/app", ".claude", "settings.local.json")  # the session's folder (made up, not created)
        remote = os.path.join(self.conf, "remote-settings.json")
        with open(user) as f:
            original = f.read()
        try:
            # A project's shorter value: the sweep runs with it when Claude Code starts there, across every project.
            real_project = serve._project_settings
            pdir = os.path.join(self.tmp.name, "proj", ".claude")
            os.makedirs(pdir, exist_ok=True)
            with open(os.path.join(pdir, "settings.local.json"), "w") as f:
                json.dump({"cleanupPeriodDays": 7}, f)
            serve._project_settings = lambda: [os.path.join(pdir, "settings.local.json")]
            self.assertEqual(serve.claude_retention(), {"days": 7, "set": True, "source": "project", "paused": False})
            # Your organisation's (cached by Claude Code) wins over everything.
            with open(remote, "w") as f:
                json.dump({"cleanupPeriodDays": 60}, f)
            self.assertEqual(serve.claude_retention(), {"days": 60, "set": True, "source": "managed", "paused": False})
            os.remove(remote)
            serve._project_settings = lambda: []
            # 0, a fraction or an unreadable file: Claude Code pauses its sweep.
            for value in ('{"cleanupPeriodDays": 0}', '{"cleanupPeriodDays": 2.5}', '{"cleanupPeriodDays": "30"}', "{not json"):
                with self.subTest(value=value):
                    with open(user, "w") as f:
                        f.write(value)
                    self.assertEqual(serve.claude_retention(), {"days": None, "set": True, "source": "user", "paused": True})
        finally:
            serve._project_settings = real_project
            with contextlib.suppress(FileNotFoundError):
                os.remove(remote)
            with open(user, "w") as f:
                f.write(original)
        self.assertFalse(os.path.exists(project))

    def test_throwbacks_own_claude_runs_never_sweep_chats(self):
        self.assertEqual(serve.NO_SWEEP, ["--settings", '{"cleanupPeriodDays": 36500}'])
        with open(serve.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(src.count("*NO_SWEEP"), 2)  # the summarizer's run and the usage meter's

    def test_a_removed_copy_stays_removed(self):
        self.assertEqual(self.call("POST", "/api/keep", {"id": self.OTHER})[0], 200)
        other = os.path.join(self.proj, self.OTHER + ".jsonl")
        os.utime(other, (time.time() + 50, time.time() + 50))  # the original changed: a refresh would re-copy it
        self.assertEqual(self.call("DELETE", f"/api/keep?id={self.OTHER}")[0], 200)
        serve.keep_status()
        self.assertFalse(os.path.exists(os.path.join(serve.KEEP_DIR, self.OTHER + ".jsonl.gz")))
        self.assertFalse(os.path.exists(os.path.join(serve.KEEP_DIR, self.OTHER + ".json")))

    def test_a_failed_write_leaves_nothing_behind(self):
        target = os.path.join(self.tmp.name, "a-folder")
        os.makedirs(target, exist_ok=True)
        with self.assertRaises(OSError):
            serve._write_private(target, b"x")  # can't replace a folder with a file
        self.assertEqual([n for n in os.listdir(self.tmp.name) if n.endswith(".tmp")], [])


def stat_mode(path):
    return os.stat(path).st_mode & 0o777


class GuardUnitTests(unittest.TestCase):
    def handler(self, client="127.0.0.1", **headers):
        h = serve.Handler.__new__(serve.Handler)  # no socket needed
        h.client_address = (client, 50000)
        h.server = types.SimpleNamespace(server_address=("127.0.0.1", 8770))
        msg = email.message.Message()
        for k, v in {"Host": "127.0.0.1:8770", "X-Throwbacks": "1", **headers}.items():
            msg[k] = v
        h.headers = msg
        return h

    def test_loopback_with_header_passes(self):
        self.assertTrue(self.handler()._api_ok())
        self.assertTrue(self.handler(Origin="http://localhost:8770")._api_ok())

    def test_lan_clients_are_refused(self):
        self.assertFalse(self.handler(client="192.168.1.20")._api_ok())


def fake_png(width):
    ihdr = struct.pack(">II", width, width) + b"\x08\x06\x00\x00\x00"
    return serve.PNG_SIG + b"\x00\x00\x00\x0dIHDR" + ihdr + b"\x00\x00\x00\x00"


def fake_icns(*entries):
    body = b"".join(typ + struct.pack(">I", 8 + len(data)) + data for typ, data in entries)
    return b"icns" + struct.pack(">I", 8 + len(body)) + body


class IconTests(unittest.TestCase):
    def icns(self, data):
        f = tempfile.NamedTemporaryFile(suffix=".icns", delete=False)
        f.write(data)
        f.close()
        self.addCleanup(os.remove, f.name)
        return f.name

    def width(self, png):
        return struct.unpack(">I", png[16:20])[0]

    def test_picks_the_size_closest_to_128_preferring_larger(self):
        path = self.icns(fake_icns((b"ic12", fake_png(64)), (b"ic08", fake_png(256)), (b"ic07", fake_png(128)), (b"ic04", b"raw-argb")))
        self.assertEqual(self.width(serve.icns_png(path)), 128)
        path = self.icns(fake_icns((b"ic12", fake_png(64)), (b"ic08", fake_png(256))))
        self.assertEqual(self.width(serve.icns_png(path)), 256)
        path = self.icns(fake_icns((b"ic11", fake_png(32)), (b"ic12", fake_png(64))))
        self.assertEqual(self.width(serve.icns_png(path)), 64)

    def test_rejects_non_icns_and_png_less_files(self):
        self.assertIsNone(serve.icns_png(self.icns(b"not an icon")))
        self.assertIsNone(serve.icns_png(self.icns(fake_icns((b"ic04", b"raw-argb")))))

    def test_unknown_apps_have_no_icon(self):
        self.assertIsNone(serve.app_icon("nope"))
        self.assertIsNone(serve.app_bundle("nope"))


class SubagentTokenTests(unittest.TestCase):
    """A session's subagents and workflow agents (<session>/subagents/**) are never
    chats: only their token usage goes with their session's, cut to numbers and ids."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        conf = os.path.join(self.tmp.name, "claude")
        proj = os.path.join(conf, "projects", "-Users-me-app")
        self.sid = "11111111-2222-3333-4444-555555555555"
        sub = os.path.join(proj, self.sid, "subagents")
        os.makedirs(os.path.join(sub, "workflows", "wf_1"))
        line = lambda **kw: json.dumps(kw)
        with open(os.path.join(proj, self.sid + ".jsonl"), "w") as f:
            f.write(line(type="user", timestamp="2026-09-01T10:00:00Z", cwd="/Users/me/app", message={"content": "Go"}) + "\n")
        with open(os.path.join(proj, "99999999-2222-3333-4444-555555555555.jsonl"), "w") as f:
            f.write(line(type="user", timestamp="2026-09-01T11:00:00Z", message={"content": "Alone"}) + "\n")
        with open(os.path.join(sub, "agent-a.jsonl"), "w") as f:
            f.write("\n".join([
                line(type="user", timestamp="2026-09-01T10:01:00Z", isSidechain=True, message={"content": "secret task text"}),
                line(type="assistant", timestamp="2026-09-01T10:02:00Z", isSidechain=True, requestId="req_a",
                     message={"id": "msg_a", "model": "x", "content": [{"type": "text", "text": "secret reply"}],
                              "usage": {"input_tokens": 5, "output_tokens": 50, "service_tier": "standard"}}),
                "not json"]) + "\n")
        with open(os.path.join(sub, "workflows", "wf_1", "agent-b.jsonl"), "w") as f:
            f.write(line(type="assistant", timestamp="2026-09-01T10:03:00Z", message={"id": "msg_b", "usage": {"output_tokens": 7}}) + "\n")
        saved = os.environ.get("CLAUDE_CONFIG_DIR"), serve.KEEP_DIR
        os.environ["CLAUDE_CONFIG_DIR"] = conf
        serve.KEEP_DIR = os.path.join(self.tmp.name, "kept")  # never your kept copies
        self.addCleanup(lambda: (os.environ.pop("CLAUDE_CONFIG_DIR", None) if saved[0] is None
                                 else os.environ.__setitem__("CLAUDE_CONFIG_DIR", saved[0]), setattr(serve, "KEEP_DIR", saved[1])))

    def test_their_usage_goes_with_their_session_and_nothing_else(self):
        files = {f["name"]: f for f in serve.collect_claude_code()["files"]}
        self.assertEqual(sorted(files), sorted([self.sid + ".jsonl", "99999999-2222-3333-4444-555555555555.jsonl"]),
                         "subagent transcripts are never sessions")
        lines = [json.loads(x) for x in files[self.sid + ".jsonl"]["subTokens"].split("\n")]
        self.assertEqual(lines, [
            {"timestamp": "2026-09-01T10:02:00Z", "requestId": "req_a", "message": {"id": "msg_a", "usage": {"input_tokens": 5, "output_tokens": 50}}},
            {"timestamp": "2026-09-01T10:03:00Z", "message": {"id": "msg_b", "usage": {"output_tokens": 7}}},
        ])
        self.assertNotIn("secret", files[self.sid + ".jsonl"]["subTokens"] + files[self.sid + ".jsonl"]["text"])
        self.assertEqual(files["99999999-2222-3333-4444-555555555555.jsonl"]["subTokens"], "")

    def test_a_kept_copy_keeps_them(self):
        before = {f["name"]: f for f in serve.collect_claude_code()["files"]}[self.sid + ".jsonl"]["subTokens"]
        self.assertTrue(serve.keep_copy(self.sid))
        proj = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "projects", "-Users-me-app")
        os.remove(os.path.join(proj, self.sid + ".jsonl"))  # Claude Code's cleanup, played by the test
        __import__("shutil").rmtree(os.path.join(proj, self.sid))
        kept = {f["name"]: f for f in serve.collect_claude_code()["files"]}[self.sid + ".jsonl"]
        self.assertTrue(kept["onlyKept"])
        self.assertEqual(kept["subTokens"], before, "its subagents' tokens stay with the kept copy")
        serve.remove_copy(self.sid)
        self.assertEqual(os.listdir(serve.KEEP_DIR), [], "Remove copy removes them too")


class ClaudeCodeTrimTests(unittest.TestCase):
    def test_keeps_only_what_the_parser_reads(self):
        line = {
            "type": "assistant", "timestamp": "2026-09-01T10:00:00Z", "cwd": "/Users/me/app",
            "uuid": "u1", "isSidechain": False, "gitBranch": "main",
            "message": {"id": "m", "model": "claude", "content": [
                {"type": "thinking", "thinking": "x" * 1000},
                {"type": "text", "text": "Done."},
                {"type": "tool_use", "name": "Edit", "input": {"big": "y" * 1000}},
            ], "usage": {"input_tokens": 3, "output_tokens": 4, "service_tier": "standard"}},
        }
        self.assertEqual(serve.cc_line({**line, "requestId": "req_1"}, want_cwd=True), {
            "type": "assistant", "timestamp": "2026-09-01T10:00:00Z", "cwd": "/Users/me/app", "requestId": "req_1",
            "message": {"usage": {"input_tokens": 3, "output_tokens": 4}, "id": "m",
                        "content": [{"type": "text", "text": "Done."}]},
        }, "the reply's id and request id stay with its usage: one reply is several lines, counted once")
        no_usage = {**line, "requestId": "req_1", "message": {"id": "m", "content": "hi"}}
        self.assertEqual(serve.cc_line(no_usage, want_cwd=False), {"type": "assistant", "timestamp": "2026-09-01T10:00:00Z",
                                                                   "message": {"content": "hi"}}, "no usage: no ids")
        self.assertNotIn("cwd", serve.cc_line(line, want_cwd=False))
        self.assertEqual(serve.cc_line({"type": "x", "isSidechain": True, "agentId": "a1"}, False),
                         {"type": "x", "isSidechain": True, "agentId": "a1"})

    def test_trimmed_file_is_cached_until_it_changes(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: (os.remove(os.path.join(d, "s.jsonl")), os.rmdir(d)))
        path = os.path.join(d, "s.jsonl")
        line = lambda text: json.dumps({"type": "user", "timestamp": "2026-09-01T10:00:00Z", "message": {"content": text}})
        with open(path, "w") as f:
            f.write(line("first") + "\n" + json.dumps({"type": "file-history-snapshot", "snapshot": {}}) + "\n")
        first = serve.prune_claude_code_file(path)
        self.assertIn("first", first)
        self.assertNotIn("file-history-snapshot", first)  # a bare type carries nothing
        self.assertIs(serve.prune_claude_code_file(path), first)  # cached
        time.sleep(0.01)
        with open(path, "a") as f:
            f.write(line("second") + "\n")
        self.assertIn("second", serve.prune_claude_code_file(path))


if __name__ == "__main__":
    unittest.main()
