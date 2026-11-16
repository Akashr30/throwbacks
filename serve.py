#!/usr/bin/env python3
"""Throwbacks local server — stdlib only, zero dependencies.

Run:  python3 serve.py
Then open the printed http://127.0.0.1:<port>/ URL.

Binds to 127.0.0.1 by DEFAULT — unreachable from other devices; a
private logbook. `python3 serve.py --lan` explicitly opts in to LAN
access (binds 0.0.0.0) so colleagues on your network can open the app.
Even then, the server only ships the app's static files: every visitor
loads their own data into their own browser tab; nothing of yours is
served. Stopping the server stops all access.
"""

import concurrent.futures
import contextlib
import glob
import gzip
import hashlib
import http.server
import json
import math
import mmap
import os
import plistlib
import queue
import re
import shlex
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
import webbrowser
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, unquote, urlparse

LAN = "--lan" in sys.argv
BIND = "0.0.0.0" if LAN else "127.0.0.1"  # local-only unless explicitly opted in

# Optional local AI summarizer bridge (opt-in): `--claude` exposes
# POST /api/claude-summarize, which pipes text to the Claude Code CLI on
# THIS machine (your `claude` login / subscription — no API key). The
# endpoint answers loopback clients only, even in --lan mode, so nobody
# else can spend your quota. The same switch lets the usage meter ask that
# CLI for your plan's limits (POST /api/usage/refresh), and the other tools'
# own apps too (Copilot CLI, Codex, agy) when they're turned on. Configure with:
#   --claude               enable the bridge
#   --claude-model <id>    default model for the CLI (else the CLI's default)
#   CLAUDE_BIN=<path>      CLI binary (default: "claude" on PATH)
CLAUDE = "--claude" in sys.argv
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_MODEL = None
if "--claude-model" in sys.argv:
    _i = sys.argv.index("--claude-model")
    if _i + 1 < len(sys.argv):
        CLAUDE_MODEL = sys.argv[_i + 1]
CLAUDE_TIMEOUT_S = 240

# Summary history on disk (like ~/.claude, but our OWN folder — never
# squat another tool's directory). One <id>.json + <id>.md per summary,
# dir 0700 / files 0600. Loopback + Origin-checked; LAN visitors can't
# touch it. Disable with --no-store (the app then falls back to browser
# localStorage).
STORE = "--no-store" not in sys.argv
STORE_DIR = os.path.join(os.path.expanduser("~"), ".throwbacks", "summaries")
# The Daily log's AI column: one small JSON file per day, per week, per month
# and per period (a range of days), next to the summary history (--no-store
# turns these off too).
LOG_DIRS = {
    "day": os.path.join(os.path.expanduser("~"), ".throwbacks", "daily"),
    "week": os.path.join(os.path.expanduser("~"), ".throwbacks", "weekly"),
    "month": os.path.join(os.path.expanduser("~"), ".throwbacks", "monthly"),
    "period": os.path.join(os.path.expanduser("~"), ".throwbacks", "periods"),
}
# Where each kind goes in GET /api/log-summaries' answer.
LOG_BUCKETS = {"day": "days", "week": "weeks", "month": "months", "period": "periods"}
LOG_KEY = re.compile(r"^\d{4}-\d{2}-\d{2}$")  # a date (a week by its Monday) — never a path
# Each kind's file name (fullmatch, ASCII digits only — never a path): a day
# and a week (by its Monday) YYYY-MM-DD, a month YYYY-MM, a period
# YYYY-MM-DD_YYYY-MM-DD; log_key_ok() also wants real dates, start ≤ end.
_LOG_DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
LOG_KEYS = {
    "day": re.compile(_LOG_DATE),
    "week": re.compile(_LOG_DATE),
    "month": re.compile(r"[0-9]{4}-(?:0[1-9]|1[0-2])"),
    "period": re.compile(f"{_LOG_DATE}_{_LOG_DATE}"),
}
LOG_KEY_HELP = ("kind (day|week|month|period) and its key (a day or week YYYY-MM-DD, "
                "a month YYYY-MM, a period YYYY-MM-DD_YYYY-MM-DD)")
# The usage meter: statusline.py (Claude Code's status line) saves your
# plan's 5-hour and weekly usage here; the app only reads it.
USAGE_FILE = os.path.join(os.path.expanduser("~"), ".throwbacks", "usage.json")
# Which tools the usage meter may ask (Settings → Usage meter), kept here so
# the server itself never runs a tool you turned off, whichever browser asks.
USAGE_ASK_FILE = os.path.join(os.path.expanduser("~"), ".throwbacks", "usage-ask.json")
ASK_DEFAULTS = {"claude": True, "copilot": True, "chatgpt": False, "google": False}  # Codex and agy start off: turned on in Settings
# Sessions → Still going: what you pinned and archived — chat IDs and times
# only, Throwbacks' own (the apps' chats are never touched). --no-store: the
# app keeps them in the browser instead.
MARKS_FILE = os.path.join(os.path.expanduser("~"), ".throwbacks", "marks.json")
MARKS_MAX = 1000  # pins, and archives, kept (the oldest go first) — as plans.js
MARKS_BODY_MAX = 4096
# …and, with --claude, the live reading: the app asks for it when you open
# it, and the server asks this machine's Claude Code for its /usage numbers
# (every limit, per-model ones included) — at most once a minute.
USAGE_LIVE_GAP_S = 60
USAGE_LIVE_TIMEOUT_S = 30
# Claude Code's optional traffic off, switch by switch: its all-in-one
# "essential traffic only" mode (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
# refuses the usage request too.
USAGE_LIVE_ENV = {
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_AUTOUPDATER": "1",
    "ENABLE_CLAUDEAI_MCP_SERVERS": "false",  # don't fetch the claude.ai connectors list
}
# The other tools' command-line apps, asked the same way (with --claude, when
# the app asks): Copilot CLI's quota, Codex's app-server, Google's agy. A
# name on PATH or a path; the usual install places are tried too.
COPILOT_BIN = os.environ.get("COPILOT_BIN", "copilot")
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
AGY_BIN = os.environ.get("AGY_BIN") or os.environ.get("ANTIGRAVITY_CLI_PATH") or "agy"
LOG_MAX_BYTES = 512 * 1024
SAFE_ID = re.compile(r"[^A-Za-z0-9._-]")

# Import GitHub Copilot (VS Code) and Cursor chats straight from this
# machine's app-data folders — read-only, loopback-only, and only when the
# app asks (the user clicks Import). The server just locates the files and
# strips bulky payloads (tool output, diffs, attachments); interpreting the
# chats is js/parse.js's job. Disable with --no-import.
IMPORT = "--no-import" not in sys.argv
IMPORT_MAX_FILE = 256 * 1024 * 1024  # skip pathological session files
# A Claude Code transcript is trimmed a line at a time and keeps a few percent
# (168 MB → 6 MB in 0.6 s here), so a long-running chat is read up to far more:
# at 256 MB it would vanish from Throwbacks just for having gone on.
CLAUDE_CODE_MAX_FILE = 4 * 1024 * 1024 * 1024
VSCODE_APPS = ("Code", "Code - Insiders")

BASE_PORT = 8770
PORT_TRIES = 6  # base port + next 5

# Serve from the script's own directory so launch location doesn't matter.
ROOT = os.path.dirname(os.path.abspath(__file__))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


# ---- IDE chat import: locate + shrink (interpretation lives in parse.js) --

def app_user_dir(app):
    """The VS Code-family 'User' settings folder of `app` on this OS."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    elif os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(base, app, "User")


def uri_to_path(uri):
    try:
        path = unquote(urlparse(uri).path or "")
    except ValueError:
        return None
    if re.match(r"^/[A-Za-z]:", path):  # file:///c:/… on Windows
        path = path[1:]
    return path or None


def workspace_folder(ws_dir):
    """Root folder of a workspaceStorage/<id>/ entry (via workspace.json)."""
    try:
        with open(os.path.join(ws_dir, "workspace.json"), encoding="utf-8") as f:
            w = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(w, dict):
        return None
    if isinstance(w.get("folder"), str):
        return uri_to_path(w["folder"])
    if isinstance(w.get("workspace"), str):
        # A (multi-root) .code-workspace file: its first folder names the
        # project. If it's gone (an untitled workspace VS Code deleted) or
        # unreadable, the honest answer is "no folder", not a guess.
        wf = uri_to_path(w["workspace"])
        if not wf:
            return None
        try:
            with open(wf, encoding="utf-8") as f:
                text = f.read()
            text = re.sub(r"^\s*//.*$", "", text, flags=re.M)   # JSONC comments
            text = re.sub(r",(\s*[}\]])", r"\1", text)           # trailing commas
            first = (json.loads(text).get("folders") or [])[0]
            if isinstance(first.get("uri"), str):
                return uri_to_path(first["uri"])
            if isinstance(first.get("path"), str):
                return os.path.normpath(os.path.join(os.path.dirname(wf), first["path"]))
        except (OSError, ValueError, IndexError, AttributeError, TypeError):
            pass
    return None


# Copilot sessions: .json snapshots and .jsonl op logs (kind 0 = initial
# state, 1 = set at path, 2 = push at path — with `i`, truncate to i first,
# 3 = delete). Pruning must not change what replay produces for the kept
# fields: ops on dropped fields are dropped whole, and values shrink in
# place — array items are never removed, because later ops index them.
CP_SESSION_KEYS = ("version", "sessionId", "creationDate", "lastMessageDate", "customTitle",
                   "requesterUsername", "responderUsername", "initialLocation", "requests")
CP_REQUEST_KEYS = ("requestId", "timestamp", "message", "response", "result",
                   "modelId", "isCanceled", "elapsedMs")


def _strs(d, keys):
    return {k: d[k] for k in keys if isinstance(d.get(k), str)} if isinstance(d, dict) else {}


def cp_item(it):
    """A response item's text survives; anything else shrinks to {kind}."""
    if not isinstance(it, dict):
        return it
    kind = it.get("kind")
    if kind is None:
        return {"value": it["value"]} if isinstance(it.get("value"), str) else {}
    if kind == "markdownContent":
        return {"kind": kind, "content": _strs(it.get("content"), ("value",))}
    if kind == "inlineReference":
        ref = it.get("inlineReference")
        slim = _strs(ref, ("name", "path", "fsPath"))
        if isinstance(ref, dict):
            for sub in ("uri", "location"):
                s = ref.get(sub)
                if isinstance(s, dict):
                    slim[sub] = _strs(s, ("path", "fsPath"))
                    if isinstance(s.get("uri"), dict):
                        slim[sub]["uri"] = _strs(s["uri"], ("path", "fsPath"))
        out = {"kind": kind, "inlineReference": slim}
        if isinstance(it.get("name"), str):
            out["name"] = it["name"]
        return out
    return {"kind": kind}


def cp_result(res):
    if not isinstance(res, dict):
        return res
    out = {}
    if isinstance(res.get("timings"), dict):
        out["timings"] = {k: v for k, v in res["timings"].items() if isinstance(v, (int, float))}
    err = res.get("errorDetails")
    if isinstance(err, dict) and isinstance(err.get("message"), str):
        out["errorDetails"] = {"message": err["message"][:500]}
    return out


def cp_request(r):
    if not isinstance(r, dict):
        return r
    out = {k: r[k] for k in CP_REQUEST_KEYS if k in r}
    if isinstance(out.get("message"), dict):
        out["message"] = _strs(out["message"], ("text",))
    if isinstance(out.get("response"), list):
        out["response"] = [cp_item(i) for i in out["response"]]
    if "result" in out:
        out["result"] = cp_result(out["result"])
    return out


def cp_session(s):
    if not isinstance(s, dict):
        return s
    out = {k: s[k] for k in CP_SESSION_KEYS if k in s}
    if isinstance(out.get("requests"), list):
        out["requests"] = [cp_request(r) for r in out["requests"]]
    return out


def cp_op(op):
    if not isinstance(op, dict):
        return None
    kind, k, v = op.get("kind"), op.get("k"), op.get("v")
    if kind == 0:
        return {"kind": 0, "v": cp_session(v)}
    if not isinstance(k, list) or not k:
        return op
    if k[0] not in CP_SESSION_KEYS:
        return None                      # inputState, hasPendingEdits, …
    if k[0] != "requests":
        return op                        # small session fields (customTitle, …)
    new = dict(op)
    if len(k) == 1:                      # the requests array itself
        if isinstance(v, list):
            new["v"] = [cp_request(r) for r in v]
        return new
    if len(k) == 2:                      # one whole request
        if isinstance(v, dict):
            new["v"] = cp_request(v)
        return new
    field = k[2]
    if field not in CP_REQUEST_KEYS:
        return None
    if field == "response":
        if len(k) == 3 and isinstance(v, list):
            new["v"] = [cp_item(i) for i in v]
        elif len(k) == 4 and isinstance(v, dict):
            new["v"] = cp_item(v)
        elif len(k) >= 5 and k[-1] not in ("value", "kind"):
            return None                  # heavy detail inside one item
    elif field == "result":
        if len(k) == 3:
            new["v"] = cp_result(v)
        elif k[3] not in ("timings", "errorDetails"):
            return None
    elif field == "message":
        if len(k) == 3 and isinstance(v, dict):
            new["v"] = _strs(v, ("text",))
        elif len(k) >= 4 and k[3] != "text":
            return None
    return new


def copilot_chat_files():
    """(path, workspace folder or None) for every Copilot chat session."""
    out = []
    for app in VSCODE_APPS:
        user = app_user_dir(app)
        ws_root = os.path.join(user, "workspaceStorage")
        try:
            hashes = sorted(os.listdir(ws_root))
        except OSError:
            hashes = []
        for h in hashes:
            chat_dir = os.path.join(ws_root, h, "chatSessions")
            if not os.path.isdir(chat_dir):
                continue
            folder = workspace_folder(os.path.join(ws_root, h))
            for name in sorted(os.listdir(chat_dir)):
                if name.endswith((".json", ".jsonl")):
                    out.append((os.path.join(chat_dir, name), folder))
        empty = os.path.join(user, "globalStorage", "emptyWindowChatSessions")
        try:
            names = sorted(os.listdir(empty))
        except OSError:
            names = []
        out += [(os.path.join(empty, n), None) for n in names if n.endswith((".json", ".jsonl"))]
    return out


def prune_copilot_file(path):
    """One session file, pruned, in the SAME format it was read in."""
    if path.endswith(".jsonl"):
        lines = []
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    op = cp_op(json.loads(line))
                except ValueError:
                    continue                 # malformed line: parse.js skips it too
                if op is not None:
                    lines.append(json.dumps(op, ensure_ascii=False, separators=(",", ":")))
        return "\n".join(lines)
    with open(path, encoding="utf-8", errors="replace") as f:
        return json.dumps(cp_session(json.load(f)), ensure_ascii=False, separators=(",", ":"))


def collect_copilot():
    files, skipped = [], 0
    for path, folder in copilot_chat_files():
        try:
            if os.path.getsize(path) > IMPORT_MAX_FILE:
                skipped += 1
                continue
            files.append({"name": os.path.basename(path), "workspace": folder,
                          "text": prune_copilot_file(path)})
        except (OSError, ValueError):
            skipped += 1
    return {"files": files, "skipped": skipped}


# Cursor keeps chats in SQLite (state.vscdb): cursorDiskKV rows
# 'composerData:<id>' (title, dates, bubble order) and
# 'bubbleId:<composer>:<bubble>' (one message each). Only the fields
# parse.js reads are forwarded.
CU_COMPOSER_KEYS = ("composerId", "name", "createdAt", "lastUpdatedAt",
                    "fullConversationHeadersOnly", "conversation")
CU_BUBBLE_KEYS = ("bubbleId", "type", "text", "createdAt", "timingInfo")


def cu_bubble(b):
    if not isinstance(b, dict):
        return None
    out = {k: b[k] for k in CU_BUBBLE_KEYS if k in b}
    if isinstance(out.get("timingInfo"), dict):
        out["timingInfo"] = {k: v for k, v in out["timingInfo"].items()
                             if isinstance(v, (int, float))}
    return out


def cu_composer(c):
    if not isinstance(c, dict):
        return None
    out = {k: c[k] for k in CU_COMPOSER_KEYS if k in c}
    if isinstance(out.get("fullConversationHeadersOnly"), list):
        out["fullConversationHeadersOnly"] = [
            {k: h[k] for k in ("bubbleId", "type") if k in h}
            for h in out["fullConversationHeadersOnly"] if isinstance(h, dict)]
    if isinstance(out.get("conversation"), list):
        out["conversation"] = [x for x in map(cu_bubble, out["conversation"]) if x]
    return out


@contextlib.contextmanager
def sqlite_readonly(path):
    """Another app's SQLite DB, opened read-only in one consistent snapshot.
    If the live file can't be opened that way (e.g. unreadable WAL
    side-files), a private temporary copy is read instead."""
    conn, tmp = None, None
    try:
        try:
            conn = sqlite3.connect("file:" + quote(os.path.abspath(path)) + "?mode=ro",
                                   uri=True, timeout=3)
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        except sqlite3.Error:
            if conn:
                conn.close()
            tmp = tempfile.mkdtemp(prefix="throwbacks-")
            for suffix in ("", "-wal", "-shm"):
                if os.path.exists(path + suffix):
                    shutil.copy2(path + suffix, os.path.join(tmp, "db" + suffix))
            conn = sqlite3.connect(os.path.join(tmp, "db"))
        conn.execute("BEGIN")
        yield conn
    finally:
        if conn:
            conn.close()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def _rows(conn, sql):
    try:
        return conn.execute(sql)
    except sqlite3.Error:
        return []                            # table absent in this Cursor version


def _jsonval(v):
    try:
        return json.loads(v.decode("utf-8", "replace") if isinstance(v, bytes) else v)
    except (TypeError, ValueError):
        return None


def _key(k):
    return k.decode("utf-8", "replace") if isinstance(k, bytes) else str(k)


def collect_cursor():
    user = app_user_dir("Cursor")
    out = {"composers": [], "bubbles": {}, "workspaceOf": {}}
    ws_root = os.path.join(user, "workspaceStorage")
    folder_of = {}
    try:
        ws_ids = sorted(os.listdir(ws_root))
    except OSError:
        ws_ids = []
    for wid in ws_ids:
        folder = workspace_folder(os.path.join(ws_root, wid))
        folder_of[wid] = folder
        db = os.path.join(ws_root, wid, "state.vscdb")
        if not folder or not os.path.isfile(db):
            continue
        try:
            with sqlite_readonly(db) as conn:
                sql = "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
                for (v,) in _rows(conn, sql):
                    for c in (_jsonval(v) or {}).get("allComposers") or []:
                        if isinstance(c, dict) and isinstance(c.get("composerId"), str):
                            out["workspaceOf"][c["composerId"]] = folder
        except (sqlite3.Error, OSError, AttributeError):
            continue
    gdb = os.path.join(user, "globalStorage", "state.vscdb")
    if not os.path.isfile(gdb):
        return out
    with sqlite_readonly(gdb) as conn:
        sql = "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'"
        for (v,) in _rows(conn, sql):
            headers = _jsonval(v)
            for h in (headers.get("allComposers") if isinstance(headers, dict) else None) or []:
                wsi = h.get("workspaceIdentifier") if isinstance(h, dict) else None
                folder = folder_of.get(wsi.get("id")) if isinstance(wsi, dict) else None
                cid = h.get("composerId") if isinstance(h, dict) else None
                if folder and isinstance(cid, str):
                    out["workspaceOf"].setdefault(cid, folder)
        sql = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
        for k, v in _rows(conn, sql):
            c = cu_composer(_jsonval(v))
            if c and (c.get("fullConversationHeadersOnly") or c.get("conversation")):
                c.setdefault("composerId", _key(k).split(":", 1)[1])
                out["composers"].append(c)
        sql = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
        for k, v in _rows(conn, sql):
            b = cu_bubble(_jsonval(v))
            if b and (str(b.get("text") or "").strip() or b.get("createdAt") or b.get("timingInfo")):
                out["bubbles"][_key(k)[len("bubbleId:"):]] = b
    return out


# GitHub Copilot CLI: ~/.copilot/session-state/<id>/ holds workspace.yaml
# (name, cwd) and events.jsonl (every event timestamped: user.message and
# assistant.message carry the text; tool runs are activity). Sessions with
# no event log fall back to session-store.db's `turns` table.
CLI_TEXT_EVENTS = ("user.message", "assistant.message")


def copilot_cli_dir():
    return os.path.join(os.path.expanduser("~"), ".copilot")


def simple_yaml(path):
    """Top-level `key: value` pairs of a small YAML file (no nesting needed)."""
    out = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*?)\s*$", line)
                if m:
                    v = m.group(2)
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                        v = v[1:-1]
                    out[m.group(1)] = v
    except OSError:
        pass
    return out


def prune_cli_events(path):
    """Keep each event's type + timestamp; keep text only for messages."""
    lines = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if not isinstance(e, dict) or not e.get("timestamp"):
                continue
            slim = {"type": e.get("type"), "timestamp": e["timestamp"]}
            d = e.get("data")
            if e.get("type") in CLI_TEXT_EVENTS and isinstance(d, dict):
                slim["data"] = {k: d[k] for k in ("content", "source") if isinstance(d.get(k), str)}
            lines.append(json.dumps(slim, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines)


def collect_copilot_cli():
    base = copilot_cli_dir()
    out = {"sessions": []}
    seen = set()
    state_dir = os.path.join(base, "session-state")
    try:
        ids = sorted(os.listdir(state_dir))
    except OSError:
        ids = []
    for sid in ids:
        d = os.path.join(state_dir, sid)
        events = os.path.join(d, "events.jsonl")
        if not os.path.isfile(events) or os.path.getsize(events) > IMPORT_MAX_FILE:
            continue
        meta = simple_yaml(os.path.join(d, "workspace.yaml"))
        sid = meta.get("id") or sid
        seen.add(sid)
        out["sessions"].append({"id": sid, "name": meta.get("name"), "cwd": meta.get("cwd"),
                                "events": prune_cli_events(events)})
    db = os.path.join(base, "session-store.db")
    if os.path.isfile(db):
        with sqlite_readonly(db) as conn:
            for sid, cwd, summary in _rows(conn, "SELECT id, cwd, summary FROM sessions"):
                if sid in seen:
                    continue
                try:
                    turns = [{"user_message": u, "assistant_response": a, "timestamp": t}
                             for u, a, t in conn.execute(
                                 "SELECT user_message, assistant_response, timestamp FROM turns "
                                 "WHERE session_id = ? ORDER BY turn_index", (sid,))]
                except sqlite3.Error:
                    turns = []
                out["sessions"].append({"id": sid, "name": summary, "cwd": cwd, "turns": turns})
    return out


# Claude desktop's Cowork (local agent mode): each session is a Claude Code
# transcript under local-agent-mode-sessions/<acct>/<org>/local_<id>/.claude/
# projects/*/<cli-session>.jsonl, next to a local_<id>.json with its title.
# Only the title is forwarded from that metadata (it also holds account
# details and the system prompt, which never leave this function).
def claude_desktop_dir():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Claude")
    if os.name == "nt":
        return os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"), "Claude")
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "Claude")


def collect_cowork():
    root = os.path.join(claude_desktop_dir(), "local-agent-mode-sessions")
    out = {"sessions": []}
    found = []  # (transcript, title): the newest copy of each file name is read
    for meta_path in sorted(glob.glob(os.path.join(root, "*", "*", "local_*.json"))):
        try:
            with open(meta_path, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        cli = meta.get("cliSessionId")
        title = meta.get("title") if isinstance(meta.get("title"), str) else None
        transcripts = glob.glob(os.path.join(meta_path[:-len(".json")], ".claude", "projects", "*", "*.jsonl"))
        for path in sorted(transcripts):  # top level only: subagents/ live deeper
            found.append((path, title if os.path.basename(path) == f"{cli}.jsonl" else None))
    keep = set(newest_by_name([p for p, _ in found]))
    for path, title in found:
        if path not in keep:
            continue
        try:
            if os.path.getsize(path) > IMPORT_MAX_FILE:
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        out["sessions"].append({"name": os.path.basename(path), "text": text, "title": title})
    return out


# ---- Claude Code: ~/.claude/projects, one click like the others ---------
#
# One <session>.jsonl per session under projects/<project>/; subagent
# transcripts live deeper (<session>/subagents/) and are never sessions —
# only their token usage is handed over with their session's, as the
# browser folder reader does. The history is mostly tool output, so each
# line is cut down to what js/parse.js reads — type, timestamp, the first
# cwd, titles, token usage and the text parts of the message (typically
# ~8% of the bytes). Trimmed files are cached by (mtime, size), so Refresh
# only re-reads sessions that changed.

CC_LINE_KEYS = ("type", "timestamp", "customTitle", "aiTitle", "summary")
CC_USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "output_tokens",
                 "cache_read_input_tokens")
_cc_cache = {}


def claude_code_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects")


def claude_code_files():
    return sorted(glob.glob(os.path.join(claude_code_dir(), "*", "*.jsonl")))


def newest_by_name(paths):
    """One path per file name: the newest copy when a session's file sits in two
    folders — the one the page shows, Copy path names and Show in Finder opens."""
    best = {}
    for p in paths:
        try:
            key = (os.path.getmtime(p), p)
        except OSError:
            continue
        name = os.path.basename(p)
        if name not in best or key > best[name][0]:
            best[name] = (key, p)
    return sorted(p for _, p in best.values())


def cc_line(line, want_cwd):
    out = {k: line[k] for k in CC_LINE_KEYS if k in line}
    if line.get("isSidechain") is True:
        out["isSidechain"] = True
    for flag in ("isMeta", "isCompactSummary"):  # Claude Code's own "user" lines (parse.js hides them)
        if line.get(flag) is True:
            out[flag] = True
    if isinstance(line.get("agentId"), str):
        out["agentId"] = line["agentId"]
    if want_cwd and isinstance(line.get("cwd"), str) and line["cwd"]:
        out["cwd"] = line["cwd"]
    msg = line.get("message")
    if isinstance(msg, dict):
        m = {}
        usage = msg.get("usage")
        if isinstance(usage, dict):
            u = {k: usage[k] for k in CC_USAGE_KEYS if isinstance(usage.get(k), (int, float))}
            if u:
                m["usage"] = u
                # One reply is several lines, each repeating its usage: parse.js counts it once by these.
                if isinstance(msg.get("id"), str):
                    m["id"] = msg["id"][:120]
                if isinstance(line.get("requestId"), str):
                    out["requestId"] = line["requestId"][:120]
        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                m["content"] = content
        elif isinstance(content, list):
            texts = [{"type": "text", "text": c["text"]} for c in content
                     if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)]
            if texts:
                m["content"] = texts
        if m:
            out["message"] = m
    return out


def prune_claude_code_file(path):
    st = os.stat(path)
    key = (st.st_mtime_ns, st.st_size)
    hit = _cc_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    opener = (lambda: gzip.open(path, "rt", encoding="utf-8", errors="replace")) if path.endswith(".gz") \
        else (lambda: open(path, encoding="utf-8", errors="replace"))
    kept = []
    want_cwd = True
    with opener() as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(line, dict):
                continue
            out = cc_line(line, want_cwd)
            if "cwd" in out:
                want_cwd = False
            if any(k != "type" for k in out):  # a bare type carries nothing parse.js reads
                kept.append(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    text = "\n".join(kept)
    _cc_cache[path] = (key, text)
    return text


def cc_usage_line(line):
    """A subagent's line cut to its token usage: {"timestamp", "requestId"?,
    "message": {"id"?, "usage"}}, or None when it has none."""
    msg = line.get("message")
    usage = msg.get("usage") if isinstance(msg, dict) else None
    if not isinstance(usage, dict) or not isinstance(line.get("timestamp"), str):
        return None
    u = {k: usage[k] for k in CC_USAGE_KEYS if isinstance(usage.get(k), (int, float))}
    if not u:
        return None
    m = {"usage": u}
    if isinstance(msg.get("id"), str):
        m["id"] = msg["id"][:120]
    out = {"timestamp": line["timestamp"], "message": m}
    if isinstance(line.get("requestId"), str):
        out["requestId"] = line["requestId"][:120]
    return out


def prune_usage_file(path):
    """A subagent transcript's usage lines only, cached by (mtime, size) like the sessions."""
    st = os.stat(path)
    key = (st.st_mtime_ns, st.st_size)
    hit = _cc_cache.get(("usage", path))
    if hit and hit[0] == key:
        return hit[1]
    kept = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            if '"usage"' not in raw:  # most lines are tool output: skip them unparsed
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                continue
            out = cc_usage_line(line) if isinstance(line, dict) else None
            if out:
                kept.append(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    text = "\n".join(kept)
    _cc_cache[("usage", path)] = (key, text)
    return text


def subagent_tokens(session_path):
    """The token usage of a session's subagents and workflow agents
    (<session>/subagents/**.jsonl), as usage lines: parse.js adds them to the
    session's tokens — never to its messages or its time. "" when it has none."""
    folder = os.path.join(session_path[:-len(".jsonl")], "subagents")
    if not os.path.isdir(folder):
        return ""
    parts = []
    for p in sorted(glob.glob(os.path.join(folder, "**", "*.jsonl"), recursive=True)):
        try:
            if os.path.getsize(p) > CLAUDE_CODE_MAX_FILE:
                continue
            text = prune_usage_file(p)
        except OSError:
            continue
        if text:
            parts.append(text)
    return "\n".join(parts)


# ---- Picking a session up again (the "Copy resume command" button) -----
#
# The page sends only an app and a session id; everything else comes from
# this machine's own files: the session's folder (a Claude Code transcript's
# last relocatedCwd, else its first cwd), whether that folder still exists,
# and whether the session is open right now (~/.claude/sessions/<pid>.json
# with a live process — only those files' sessionId, pid and entrypoint are
# used; the .key files beside them are never opened). Nothing is run and
# nothing is written: the page builds the command for you to paste.

RESUME_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_resume_cache = {}


def claude_session_folder(path):
    """(folder, entrypoint) of one Claude Code transcript."""
    st = os.stat(path)
    key = (st.st_mtime_ns, st.st_size)
    hit = _resume_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    first = relocated = entry = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            if '"cwd"' not in raw and '"relocatedCwd"' not in raw and '"entrypoint"' not in raw:
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(line, dict):
                continue
            if first is None and isinstance(line.get("cwd"), str) and line["cwd"]:
                first = line["cwd"]
            if line.get("type") == "relocated" and isinstance(line.get("relocatedCwd"), str) and line["relocatedCwd"]:
                relocated = line["relocatedCwd"]  # moved with /cd: the last move wins
            if entry is None and isinstance(line.get("entrypoint"), str):
                entry = line["entrypoint"][:40]
    out = (relocated or first, entry)
    _resume_cache[path] = (key, out)
    return out


def _process_starts(pids):
    """{pid: start time} as `ps` prints it in UTC (Claude Code's procStart),
    or None when ps can't say. A pid missing from the answer has ended."""
    try:
        r = subprocess.run(["ps", "-o", "pid=", "-o", "lstart=", "-p", ",".join(str(p) for p in pids)],
                           capture_output=True, text=True, timeout=3,
                           env={**os.environ, "LC_ALL": "C", "TZ": "UTC"})
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode not in (0, 1):  # 1: some pid isn't running, which is an answer
        return None
    return {int(m[1]): m[2] for m in re.finditer(r"^\s*(\d+)\s+(\S.*\S)\s*$", r.stdout, re.M)}


def claude_live_sessions():
    """{sessionId: {where, kind}} of the Claude Code sessions open right now: a
    record whose process exists and started when the record says (a pid
    reused after a crash or a restart is someone else's process). kind is
    "interactive", or "bg"/"daemon"/"daemon-worker" for one running in the
    background (resuming that attaches to it); an interactive record parked
    in the background (parkedJobId) is left to its background one."""
    base = os.path.join(os.path.dirname(claude_code_dir()), "sessions")
    try:
        names = os.listdir(base)
    except OSError:
        return {}
    found = []
    for name in names:
        if not re.fullmatch(r"\d+\.json", name):  # never the .key files
            continue
        try:
            with open(os.path.join(base, name), encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        pid, sid = d.get("pid"), d.get("sessionId")
        if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid < 2 ** 31 or not isinstance(sid, str):
            continue
        try:
            os.kill(pid, 0)  # signal 0: only asks whether the process exists
        except PermissionError:
            pass
        except (OSError, OverflowError):
            continue
        kind = d.get("kind") if d.get("kind") in ("interactive", "bg", "daemon", "daemon-worker") else None
        if kind in (None, "interactive") and d.get("parkedJobId") is not None:
            continue
        start = d.get("procStartFt") or d.get("procStart")
        where = d.get("entrypoint") if isinstance(d.get("entrypoint"), str) else d.get("kind")
        found.append((pid, sid, {"where": str(where or "")[:40], "kind": kind},
                      start.strip() if isinstance(start, str) else None))
    starts = _process_starts([pid for pid, _, _, start in found if start]) if any(f[3] for f in found) else {}
    out = {}
    for pid, sid, where, start in found:
        if start and starts is not None and starts.get(pid) != start:
            continue  # ended, or the pid now belongs to another process
        out[sid] = where
    return out


def resume_info(app_id, sid):
    """What the page needs to build the resume command for one session."""
    if app_id == "claude":
        paths = glob.glob(os.path.join(claude_code_dir(), "*", sid + ".jsonl"))
        if not paths:
            return {"found": False}
        try:
            path = max(paths, key=os.path.getmtime)  # the same id in two projects: the newest
            folder, entry = claude_session_folder(path)
        except OSError:
            return {"found": False}
        live = claude_live_sessions().get(sid)
        return {"found": True, "folder": folder, "exists": bool(folder) and os.path.isdir(folder),
                "entrypoint": entry, "live": live}
    d = os.path.join(copilot_cli_dir(), "session-state", sid)
    if not os.path.isdir(d):  # Copilot CLI would start a new, empty session for an unknown id
        return {"found": False}
    meta = simple_yaml(os.path.join(d, "workspace.yaml"))
    folder = meta.get("cwd") or None
    return {"found": True, "folder": folder, "exists": bool(folder) and os.path.isdir(folder),
            "live": {"where": str(meta.get("client_name") or "copilot")[:40], "kind": "copilot"} if copilot_in_use(d) else None}


def copilot_in_use(d):
    """Whether a Copilot CLI process holds this session: an inuse.<pid>.lock
    beside it whose process exists (by name only; the locks are never opened)."""
    try:
        names = os.listdir(d)
    except OSError:
        return False
    for name in names:
        m = re.fullmatch(r"inuse\.(\d+)\.lock", name)
        if not m or not 0 < int(m[1]) < 2 ** 31:
            continue
        try:
            os.kill(int(m[1]), 0)
            return True
        except PermissionError:
            return True
        except (OSError, OverflowError):
            continue
    return False


# ---- Where a chat lives (its file in the conversation; Show in Finder) ----
#
# The page sends only the chat's app and its own ID; the server finds the file
# itself, under that app's own folders, so a path never comes from the page and
# Show in Finder can only ever point at a chat's own file. Nothing is opened or
# changed to answer — only those folders are listed (and, for an old Copilot
# CLI session, its row looked up in session-store.db, read-only). Show in
# Finder runs `open -R <file>`: Finder shows the file, selected; it never opens
# or runs it. Cursor keeps every chat in one
# database, so its answer is that file and the chat's key inside it.

SOURCE_APPS = ("code", "cowork", "copilot", "copilot-cli", "cursor")
SOURCE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")  # a file name's stem: no "/", no glob characters
OPEN_BIN = "/usr/bin/open"


def can_reveal():
    """Show in Finder: on a Mac only (macOS's own `open -R`)."""
    return sys.platform == "darwin" and os.path.isfile(OPEN_BIN)


def _newest(paths):
    try:
        return max(paths, key=os.path.getmtime) if paths else None
    except OSError:
        return None


def source_info(app, sid):
    """Where one chat lives: {found, kind: 'file' | 'database', path, key?, kept?}.
    `sid` has already matched SOURCE_ID; glob finds only that exact name."""
    path = kind = key = None
    kept = False
    if app == "code":  # newest copy: what the importer reads (newest_by_name)
        path = _newest(glob.glob(os.path.join(claude_code_dir(), "*", sid + ".jsonl")))
        if not path and KEEP_ID.fullmatch(sid):  # Claude Code deleted it: Throwbacks' kept copy
            copy = os.path.join(KEEP_DIR, sid + ".jsonl.gz")
            path, kept = (copy, True) if os.path.isfile(copy) else (None, False)
    elif app == "cowork":
        root = os.path.join(claude_desktop_dir(), "local-agent-mode-sessions")
        path = _newest(glob.glob(os.path.join(root, "*", "*", "local_*", ".claude", "projects", "*", sid + ".jsonl")))
    elif app == "copilot":
        found = []
        for vs in VSCODE_APPS:
            user = app_user_dir(vs)
            for ext in (".jsonl", ".json"):  # the operation log is the newer copy of a chat
                found += glob.glob(os.path.join(user, "workspaceStorage", "*", "chatSessions", sid + ext))
                found += glob.glob(os.path.join(user, "globalStorage", "emptyWindowChatSessions", sid + ext))
        logs = [p for p in found if p.endswith(".jsonl")]
        path = _newest(logs or found)
    elif app == "copilot-cli":
        events = os.path.join(copilot_cli_dir(), "session-state", sid, "events.jsonl")
        db = os.path.join(copilot_cli_dir(), "session-store.db")
        if os.path.isfile(events):
            path = events
        elif os.path.isfile(db):
            try:
                with sqlite_readonly(db) as conn:
                    if conn.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone():
                        path, kind, key = db, "database", sid
            except (sqlite3.Error, OSError):
                pass
    elif app == "cursor":  # one database for every chat: found only when this chat's row is in it
        db = os.path.join(app_user_dir("Cursor"), "globalStorage", "state.vscdb")
        if os.path.isfile(db):
            try:
                with sqlite_readonly(db) as conn:
                    if conn.execute("SELECT 1 FROM cursorDiskKV WHERE key = ?", (f"composerData:{sid}",)).fetchone():
                        path, kind, key = db, "database", f"composerData:{sid}"
            except (sqlite3.Error, OSError):
                pass
    if not path:
        return {"found": False}
    out = {"found": True, "kind": kind or "file", "path": path}
    if key:
        out["key"] = key
    if kept:
        out["kept"] = True
    return out


def reveal_source(app, sid):
    """Show one chat's own file in Finder (selected, never opened). True when Finder took it."""
    info = source_info(app, sid)
    if not info.get("found"):
        return None
    try:
        r = subprocess.run([OPEN_BIN, "-R", info["path"]], capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


# ---- Your commits (on each day, in Sessions → Folder and in Insights) ----
#
# The page sends the folders its sessions started in; for each one inside a
# git repo, this lists YOUR commits since the first day of history — by the
# repo's user.email or your global one, plus an AI tool's own commits that
# name you (a cloud agent: you as co-author or committer) — and tags who
# made each:
#   - an AI tool's own record says it ran that commit: the `git commit` (or
#     merge, revert) runs in Claude Code's transcripts (its subagents', the
#     copies Throwbacks kept of deleted chats, Cowork's), in Copilot in VS
#     Code's chat logs and in Copilot CLI's event logs. By the ID git printed
#     — or, when the commit was amended or rebased since, its copy (same
#     message, and same author time or same content). A run that printed no
#     ID (`git commit -q`) makes it "probably": every commit that landed
#     during it, in the repo it ran in (following `cd` and `git -C`; never
#     a throwaway repo), else the closest within 2 minutes;
#   - else the commit's own mark: a co-author line naming an AI tool (Claude,
#     Copilot, Cursor, Codex, Gemini, Antigravity, Aider, OpenCode, Devin),
#     Cursor's `Made-with`, Claude's `Claude-Session`, an `Assisted-by`, or
#     an AI tool as its author;
#   - else you.
# Only `git log`, `git rev-parse`, `git config --get`, `git for-each-ref` and
# `git worktree list` run — they never change a repo — with every way a
# repo's own config could run a program, reach the network or write switched
# off: no pager, signature checks, external diffs, text conversion,
# fsmonitor, hooks, mailmap, lazy fetching of missing objects (partial
# clones), optional locks, and no input. The AI tools' logs are only read.

GIT_SAFE = ["--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
            "-c", "core.pager=cat", "-c", "core.hooksPath=/dev/null", "-c", "log.mailmap=false",
            "-c", "i18n.logOutputEncoding=UTF-8"]
GIT_ENV = {"GIT_OPTIONAL_LOCKS": "0", "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0", "GIT_EDITOR": "true",
           "GIT_NO_LAZY_FETCH": "1"}
COMMITS_MAX_FOLDERS = 400
COMMITS_MAX_PER_REPO = 3000
COMMIT_NEAR_S = 120     # "probably": the closest commit within this of a run that printed no ID
COMMIT_ID_NEAR_S = 600  # an ID a run printed counts only near that run (short IDs can repeat across repos)
COMMIT_SPAN_SLACK_S = 2  # a run's own commits land during it (git's times are whole seconds)
_COMMIT_ID = re.compile(r"\[[^\]\n]*? ([0-9a-f]{7,40})\]")
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
_GIT_COMMIT = re.compile(r"(?:^|[\s;&|(`])git(?:\s+(?:-[cC]\s+\S+|--?[\w.-]+(?:=\S*)?))*\s+commit(?![\w.-])")
_SHELL_SEP = frozenset({"&&", "||", ";", "|", "&", "(", ")", ";;", "|&"})
_GIT_VALUE_OPTS = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"})
_MAKES_COMMITS = frozenset({"commit", "merge", "revert"})  # a fresh commit of this run's own (cherry-pick and rebase copy old ones)
_SHELLS = frozenset({"sh", "bash", "zsh", "dash"})
_runs_cache = {}


_HEREDOC = re.compile(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1(?=$|[\s);|&])")


def _drop_heredocs(cmd):
    """A command without its here-documents' text (a commit message written with
    `<<'EOF'`): their lines are text, not commands, and may hold a lone quote. A
    `<<` that never ends (inside a message, `a<<b`) drops nothing."""
    out, end, held = [], None, []
    for line in str(cmd or "").split("\n"):
        if end is not None:
            held.append(line)
            if line.strip() == end:
                end, held = None, []
            continue
        out.append(line)
        m = _HEREDOC.search(line)
        if m:
            end = m.group(2)
    return "\n".join(out + held)


def _shell_words(cmd):
    """A shell command as words, with `&&`, `;`, `|`, `(`… as their own words; None when it can't be read."""
    try:
        lex = shlex.shlex(_drop_heredocs(cmd).replace("\n", " ; "), posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        return list(lex)
    except ValueError:
        return None


def _resolve_dir(word, base):
    """A `cd` target or `git -C` folder as a full path, from `base`; None when a variable names it."""
    if word is None or any(ch in word for ch in "$`*?") or word == "-":
        return None
    path = os.path.expanduser(word)
    if not os.path.isabs(path):
        if base is None:
            return None
        path = os.path.join(base, path)
    return os.path.normpath(path)


_TEMP_WORD = re.compile(r"mktemp|tmp|\btemp\b|temp_?dir", re.I)


def _is_temp(path, word=""):
    """A folder a variable names that looks like a temp one (`$(mktemp -d)`, `$TMPDIR/x`).
    A real path needs no guess: followed, it's simply not your repo's folder."""
    return path is None and bool(_TEMP_WORD.search(word or ""))


_KEYWORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "{", "!", "time", "exec", "command", "builtin", "nohup"})
_SHELL_C = re.compile(r"-[A-Za-z]*c")


def commit_places(cmd, cwd):
    """Each commit a shell command makes: [(kind, folder, scratch, amend)]. kind: "commit",
    "merge" or "revert". The folder follows `cd` (and `cd -`, `pushd`/`popd`, a subshell's
    `( … )`) and `git -C` from `cwd` (None when a variable names it); scratch: a
    throwaway repo — a commit in the folder a `git init` made there, when a variable or
    a temp-looking name gives that folder (`$(mktemp -d)`, `/tmp/x`).
    Quoted text is one word, so `grep "git commit"` or a message saying it never counts;
    `sh -c '…'` (and `bash -lc`) is read inside."""
    words = _shell_words(cmd)
    if words is None:  # can't be read as words (a lone quote): the plain test, in the session's folder
        plain = _QUOTED.sub("Q", str(cmd or ""))
        if _GIT_COMMIT.search(plain) and "--dry-run" not in plain:
            return [("commit", cwd, False, "--amend" in plain)]
        return []
    out = []
    here, here_word = cwd, ""
    stack, previous, inits = [], (cwd, ""), set()

    def go(target):
        nonlocal here, here_word, previous
        if target == "-":
            (here, here_word), previous = previous, (here, here_word)
        else:
            previous = (here, here_word)
            here, here_word = _resolve_dir(target, here), target

    def segment(seg):
        nonlocal here, here_word
        while seg and (seg[0] in _KEYWORDS or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", seg[0])):  # if …; FOO=bar git commit
            seg = seg[1:]
        if not seg:
            return
        if seg[0] in ("cd", "pushd", "popd"):
            if seg[0] == "popd":
                if stack:
                    here, here_word = stack.pop()
                return
            if seg[0] == "pushd":
                stack.append((here, here_word))
            go(next((w for w in seg[1:] if w == "-" or not w.startswith("-")), "~"))
            return
        flag = next((i for i, w in enumerate(seg[1:-1], 1) if _SHELL_C.fullmatch(w)), None)
        if seg[0] in _SHELLS and flag is not None:
            for kind, where, scratch, amend in commit_places(seg[flag + 1], here):
                out.append((kind, where, scratch or (where is None and _is_temp(here, here_word)), amend))
            return
        at = next((i for i, w in enumerate(seg) if w == "git" or w.endswith("/git")), None)
        if at is None:
            return
        i, where, where_word = at + 1, here, here_word
        while i < len(seg) and seg[i].startswith("-"):
            if seg[i] in _GIT_VALUE_OPTS and i + 1 < len(seg):
                if seg[i] == "-C":
                    where, where_word = _resolve_dir(seg[i + 1], where), seg[i + 1]
                i += 2
            else:
                i += 1
        if i >= len(seg):
            return
        sub, rest = seg[i], seg[i + 1:]
        if sub == "init":
            target = next((w for w in rest if not w.startswith("-")), None)
            inits.add((_resolve_dir(target, where), target) if target else (where, where_word))
        elif sub in _MAKES_COMMITS and not ({"--dry-run", "-h", "--help", "--abort", "--quit"} & set(rest)) \
                and not (sub == "revert" and ({"-n", "--no-commit"} & set(rest))) \
                and not (sub == "merge" and ({"--squash", "--no-commit"} & set(rest))):
            # A throwaway repo: one a `git init` here made, in a folder a variable or a temp-looking name gives.
            made_here = any(f == where for f, _ in inits)
            scratch = _is_temp(where, where_word) or made_here and (where is None or bool(_TEMP_WORD.search(where_word or "")))
            out.append((sub, where, scratch, sub == "commit" and "--amend" in rest))

    seg = []
    for w in words + [";"]:
        if w in _SHELL_SEP:
            segment(seg)
            seg = []
            if w == "(":
                stack.append((here, here_word))
            elif w == ")" and stack:
                here, here_word = stack.pop()
        else:
            seg.append(w)
    return out


def is_commit_run(cmd):
    """Does this shell command make a commit (`git commit`, a merge, a revert — not a dry run)?
    Quoted text is one word, so `grep "git commit"`, `.git/hooks/pre-commit` or a
    `--grep=commit` don't count."""
    return bool(commit_places(cmd, None))


def _git(cwd, *args, timeout=20):
    """stdout of one read-only git command in `cwd` (as text, never failing on odd bytes), or None."""
    try:
        r = subprocess.run(["git", *GIT_SAFE, "-C", cwd, *args], capture_output=True,
                           timeout=timeout, env={**os.environ, **GIT_ENV}, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


_KEEP_S = 600  # how long a folder's repo and a repo's emails are remembered
_repo_of_cache = {}
_emails_cache = {}


def repo_of(folder, cache=None):
    """The repo's top folder for `folder`, or None (not a repo, gone, not yours)."""
    hit = _repo_of_cache.get(folder)
    if hit and time.time() - hit[0] < _KEEP_S:
        return hit[1]
    top = None
    if os.path.isdir(folder):
        out = _git(folder, "rev-parse", "--show-toplevel", timeout=5)
        top = out.strip() if out and out.strip() else None
    _repo_of_cache[folder] = (time.time(), top)
    return top


def _iso_seconds(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


_LOOPS = re.compile(r"(?:^|[\s;&|(])(?:for|while|until|xargs)\s")


def _run(key, app, tool, session, cwd, cmd, start, end, output, failed, unfinished=False, own=True):
    """One commit-making shell run an AI tool recorded, or None when it makes no commit.
    unfinished: it went on in the background, so its own result can't say when it ended;
    own: its log is the session's own (not a copy in a resumed or forked session's)."""
    places = commit_places(cmd, cwd)
    if not places or start is None:
        return None
    ids = tuple(dict.fromkeys(_COMMIT_ID.findall(output if isinstance(output, str) else "")))
    return {"key": f"{app}:{key}", "app": app, "tool": tool, "session": session, "cwd": cwd,
            "places": [(where, scratch) for _, where, scratch, _ in places],
            "amend": any(amend for *_, amend in places), "near": any(kind == "commit" for kind, *_ in places),
            "loops": bool(_LOOPS.search(_QUOTED.sub("Q", str(cmd)))),  # a loop may make any number of commits
            "start": start, "end": max(end or start, start), "ids": ids, "unfinished": bool(unfinished), "own": own,
            # A failure after the commit (`git commit -q && git push`, the push failing) may still have made one:
            # such a run claims only what landed during it.
            "failed": bool(failed) and not ids}


def _cached_runs(path, read):
    """A log's runs, remembered until the file changes."""
    st = os.stat(path)
    key = (st.st_mtime_ns, st.st_size)
    hit = _runs_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    runs = read()
    _runs_cache[path] = (key, runs)
    return runs


def _may_commit(path):
    """Could this transcript hold a commit run? A look at its bytes, mapped (not read into
    memory: a long session is hundreds of MB)."""
    if path.endswith(".gz"):
        return True
    with open(path, "rb") as f:
        try:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                return mm.find(b'"Bash"') >= 0 and _COMMITISH.search(mm) is not None
        except ValueError:  # an empty file
            return False


def _claude_runs_in(path, sid, app="code"):
    """The commits a Claude Code transcript ran (a session's, a subagent's, a kept
    copy's, a Cowork session's): Bash tool_use and its tool_result."""
    runs, pending, cwd, background = [], {}, None, {}
    if not _may_commit(path):
        return runs  # most transcripts never ran a commit
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:
        for raw in f:
            # Only what can matter is parsed (a long session is hundreds of MB): a Bash run that
            # mentions a commit, the result of one, and the first folder.
            if not (b'"Bash"' in raw and _COMMITISH.search(raw)
                    or pending and b'"tool_result"' in raw and any(pid in raw for pid in pending.keys())
                    or background and (b'"BashOutput"' in raw or b'"TaskOutput"' in raw)
                    or cwd is None and b'"cwd"' in raw):
                continue
            try:
                line = json.loads(raw)
            except (ValueError, RecursionError):  # a line nested too deep is skipped on its own
                continue
            if not isinstance(line, dict):
                continue
            if isinstance(line.get("cwd"), str) and line["cwd"]:
                cwd = line["cwd"]
            msg = line.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                args = part.get("input") if isinstance(part.get("input"), dict) else {}
                if part.get("type") == "tool_use" and part.get("name") == "Bash":
                    cmd = args.get("command", "")
                    if isinstance(cmd, str) and isinstance(part.get("id"), str) and is_commit_run(cmd):
                        pending[part["id"].encode()] = (_iso_seconds(line.get("timestamp")), cwd, cmd,
                                                        args.get("run_in_background") is True, line.get("sessionId") in (None, sid))
                elif part.get("type") == "tool_use" and part.get("name") in ("BashOutput", "TaskOutput") \
                        and isinstance(part.get("id"), str) and background:
                    shell = next((args[k] for k in ("bash_id", "task_id", "shell_id") if isinstance(args.get(k), str)), None)
                    pending[part["id"].encode()] = ("output", background.get(shell) or list(background.values())[-1])
                elif part.get("type") == "tool_result" and isinstance(part.get("tool_use_id"), str) \
                        and part["tool_use_id"].encode() in pending:
                    held = pending.pop(part["tool_use_id"].encode())
                    text = _result_text(part.get("content"))
                    when = _iso_seconds(line.get("timestamp"))
                    if held[0] == "output":  # a background run's later output: its commit IDs, and when it ended
                        _went_on(held[1], text, when)
                        continue
                    started, where, cmd, bg, own = held
                    r = _run(part.get("tool_use_id"), app, "claude", sid, where, cmd, started, when or started, text,
                             part.get("is_error"), unfinished=bg, own=own)
                    if r and where:
                        runs.append(r)
                        if bg:
                            m = re.search(r"with ID:?\s*([\w-]+)", text)
                            background[m.group(1) if m else r["key"]] = r
    return runs


def _result_text(out):
    """A tool result's text, whatever shape it came in."""
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        return " ".join(x["text"] for x in out if isinstance(x, dict) and isinstance(x.get("text"), str))
    return ""


def _went_on(run, text, when):
    """A background run's later output: the commit IDs it printed, and when it was seen ending."""
    ids = _COMMIT_ID.findall(text or "")
    if ids:
        run["ids"] = tuple(dict.fromkeys((*run["ids"], *ids)))
        run["failed"] = False
    if when and when > run["end"]:
        run["end"] = when


# Copilot in VS Code: a session's agent turns record each terminal command they
# ran (run_in_terminal): the command, its output, exit code, folder and times.
# Older Copilot Chat kept only the command (copilot_runInTerminal): then the
# request's time and the workspace's folder are all there is.
_TERMINAL_TOOLS = ("run_in_terminal", "copilot_runInTerminal")


def _cp_get(container, key):
    if isinstance(container, dict):
        return container.get(str(key))
    if isinstance(container, list):
        try:
            i = int(key)
        except (TypeError, ValueError):
            return None
        return container[i] if 0 <= i < len(container) else None
    return None


def copilot_session_state(path):
    """A Copilot chat session as VS Code last saved it: the .json snapshot, or the
    .jsonl op log replayed one line at a time (as parse.js replayCopilotLog does)."""
    if not path.endswith(".jsonl"):
        with open(path, encoding="utf-8", errors="replace") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else None
    with open(path, encoding="utf-8", errors="replace") as f:
        return _replay_ops(f)


def _replay_ops(lines):
    state = None
    for raw in lines:
        try:
            op = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        if not isinstance(op, dict):
            continue
        if op.get("kind") == 0:
            state = op.get("v") if isinstance(op.get("v"), dict) else None
            continue
        k = op.get("k")
        if state is None or not isinstance(k, list) or not k:
            continue
        parent = state
        for step in k[:-1]:
            parent = _cp_get(parent, step)
            if not isinstance(parent, (dict, list)):
                parent = None
                break
        if parent is None:
            continue
        last, kind = k[-1], op.get("kind")
        if kind == 1:
            if isinstance(parent, dict):
                parent[str(last)] = op.get("v")
            elif isinstance(parent, list) and isinstance(last, int) and 0 <= last < len(parent):
                parent[last] = op.get("v")
            elif isinstance(parent, list) and last == len(parent):
                parent.append(op.get("v"))
        elif kind == 2:
            arr = _cp_get(parent, last)
            if not isinstance(arr, list):
                arr = []
                if isinstance(parent, dict):
                    parent[str(last)] = arr
                else:
                    continue
            i = op.get("i")
            if isinstance(i, int) and 0 <= i < len(arr):
                del arr[i:]
            if isinstance(op.get("v"), list):
                arr.extend(op["v"])
        elif kind == 3:
            if isinstance(parent, list):
                try:
                    del parent[int(last)]
                except (ValueError, IndexError, TypeError):
                    pass
            elif isinstance(parent, dict):
                parent.pop(str(last), None)
    return state


def _uri_folder(value):
    if isinstance(value, str):
        return uri_to_path(value) if "://" in value else value
    if isinstance(value, dict) and value.get("scheme", "file") == "file":
        for k in ("fsPath", "path"):
            if isinstance(value.get(k), str) and value[k]:
                return value[k]
    return None


_COMMITISH = re.compile(rb"git[^\n]{0,160}?\b(?:commit|merge|revert)\b")


def _copilot_runs_in(path, folder):
    # Most chats never ran a git commit: a look at the bytes (mapped, not read into memory) spares
    # parsing them (216 MB here); a file the import would skip as too big is skipped here too.
    if os.path.getsize(path) > IMPORT_MAX_FILE:
        return []
    with open(path, "rb") as f:
        try:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                if (mm.find(b"run_in_terminal") < 0 and mm.find(b"copilot_runInTerminal") < 0) or not _COMMITISH.search(mm):
                    return []
        except ValueError:  # an empty file
            return []
    state = copilot_session_state(path)
    if not isinstance(state, dict) or not isinstance(state.get("requests"), list):
        return []
    sid = state.get("sessionId") if isinstance(state.get("sessionId"), str) else os.path.basename(path).rsplit(".", 1)[0]
    runs = []
    for ri, req in enumerate(state["requests"]):
        if not isinstance(req, dict) or not isinstance(req.get("response"), list):
            continue
        asked = req.get("timestamp") / 1000 if isinstance(req.get("timestamp"), (int, float)) else None
        timings = req["result"].get("timings") if isinstance(req.get("result"), dict) else None
        elapsed = timings.get("totalElapsed") if isinstance(timings, dict) else None  # as parse.js times a request
        elapsed = elapsed if isinstance(elapsed, (int, float)) else req.get("elapsedMs")
        took = elapsed / 1000 if isinstance(elapsed, (int, float)) else None
        for pi, part in enumerate(req["response"]):
            if not isinstance(part, dict) or part.get("kind") != "toolInvocationSerialized" \
                    or part.get("toolId") not in _TERMINAL_TOOLS:
                continue
            tsd = part.get("toolSpecificData") if isinstance(part.get("toolSpecificData"), dict) else {}
            line = tsd.get("commandLine") if isinstance(tsd.get("commandLine"), dict) else None
            if line:
                cmd = next((line[k] for k in ("userEdited", "toolEdited", "original") if isinstance(line.get(k), str) and line[k]), "")
                st = tsd.get("terminalCommandState") if isinstance(tsd.get("terminalCommandState"), dict) else {}
                start = st["timestamp"] / 1000 if isinstance(st.get("timestamp"), (int, float)) else asked
                end = start + st["duration"] / 1000 if start is not None and isinstance(st.get("duration"), (int, float)) \
                    else (asked + took if asked is not None and took is not None else start)
                out = (tsd.get("terminalCommandOutput") or {}).get("text") if isinstance(tsd.get("terminalCommandOutput"), dict) else ""
                code = st.get("exitCode")
                failed = (isinstance(code, int) and code != 0) or (code is None and not out)  # failed, or never ran
                where = _uri_folder(tsd.get("cwd")) or folder
            else:  # the older shape: only the command, timed by its request
                cmd = tsd.get("command") if isinstance(tsd.get("command"), str) else ""
                start, end = asked, (asked + took if asked is not None and took is not None else asked)
                out, failed, where = "", False, folder
            key = tsd.get("terminalCommandId") or part.get("toolCallId") or f"{sid}:{ri}:{pi}"
            r = _run(key, "copilot", "copilot", sid, where, cmd, start, end, out or "", failed)
            if r and where:
                runs.append(r)
    return runs


def _copilot_cli_runs_in(folder):
    """Copilot CLI's bash runs in one session's events.jsonl: start and complete events,
    linked by toolCallId. A run you refused (denied) never ran."""
    meta = simple_yaml(os.path.join(folder, "workspace.yaml"))
    sid = meta.get("id") or os.path.basename(folder)
    cwd = meta.get("cwd") or None
    runs, pending, shells = [], {}, {}
    with open(os.path.join(folder, "events.jsonl"), encoding="utf-8", errors="replace") as f:
        for raw in f:
            if "git" not in raw and "tool.execution_complete" not in raw and "session." not in raw and "read_bash" not in raw:
                continue
            try:
                e = json.loads(raw)
            except (ValueError, RecursionError):  # a line nested too deep is skipped on its own
                continue
            d = e.get("data") if isinstance(e, dict) and isinstance(e.get("data"), dict) else None
            if d is None:
                continue
            kind = e.get("type")
            if kind in ("session.start", "session.resume") and isinstance(d.get("context"), dict) \
                    and isinstance(d["context"].get("cwd"), str):
                cwd = d["context"]["cwd"]
            elif kind == "tool.execution_start" and isinstance(d.get("arguments"), dict) and isinstance(d.get("toolCallId"), str):
                args = d["arguments"]
                if d.get("toolName") in ("bash", "shell") and isinstance(args.get("command"), str) and is_commit_run(args["command"]):
                    pending[d["toolCallId"]] = (_iso_seconds(e.get("timestamp")), cwd, args["command"])
                elif d.get("toolName") == "read_bash" and shells:  # a background shell's later output
                    pending[d["toolCallId"]] = ("output", shells.get(str(args.get("shellId"))) or list(shells.values())[-1])
            elif kind == "tool.execution_complete" and isinstance(d.get("toolCallId"), str) and d["toolCallId"] in pending:
                held = pending.pop(d["toolCallId"])
                res = d.get("result") if isinstance(d.get("result"), dict) else {}
                out = " ".join(res[k] for k in ("content", "detailedContent") if isinstance(res.get(k), str))
                if held[0] == "output":
                    _went_on(held[1], out, _iso_seconds(e.get("timestamp")))
                    continue
                started, where, cmd = held
                err = d.get("error") if isinstance(d.get("error"), dict) else {}
                if err.get("code") == "denied":
                    continue
                # A shell that went on in the background returns before its command ends: no exit code yet.
                bg = d.get("success") is not False and out and "exit code" not in out
                r = _run(d["toolCallId"], "copilot-cli", "copilot", sid, where, cmd, started,
                         _iso_seconds(e.get("timestamp")), out, d.get("success") is False, unfinished=bg)
                if r and where:
                    runs.append(r)
                    if bg:
                        m = re.search(r"shellId\W{0,3}(\w+)", out)
                        shells[m.group(1) if m else r["key"]] = r
    return runs


def ai_commit_runs():
    """Every commit-making shell run an AI tool's own record holds: Claude Code's
    sessions, their subagents and workflow agents (credited to their session), the
    copies Throwbacks kept of chats Claude Code deleted, Cowork's sessions, Copilot
    in VS Code's chats and Copilot CLI's sessions. A run copied into a resumed
    session's transcript is counted once."""
    base = claude_code_dir()
    sources = [(p, os.path.basename(p)[:-len(".jsonl")], "code") for p in claude_code_files()]
    for p in glob.glob(os.path.join(base, "*", "*", "subagents", "**", "*.jsonl"), recursive=True):
        if os.path.basename(p) == "journal.jsonl":
            continue
        rel = os.path.relpath(p, base).split(os.sep)  # <project>/<session>/subagents/...
        if len(rel) >= 4 and rel[2] == "subagents":
            sources.append((p, rel[1], "code"))
    have = {sid for _, sid, _ in sources}
    for p in sorted(glob.glob(os.path.join(KEEP_DIR, "*.jsonl.gz"))):  # chats Claude Code has deleted
        sid = os.path.basename(p)[:-len(".jsonl.gz")]
        if KEEP_ID.fullmatch(sid) and sid not in have:
            sources.append((p, sid, "code"))
    cowork = os.path.join(claude_desktop_dir(), "local-agent-mode-sessions")
    for p in sorted(glob.glob(os.path.join(cowork, "*", "*", "local_*", ".claude", "projects", "*", "*.jsonl"))):
        sources.append((p, os.path.basename(p)[:-len(".jsonl")], "cowork"))
    runs, seen = [], {}

    def add(found):  # a run copied into a resumed or forked session counts once: its own session's copy
        for r in found:
            if r["key"] not in seen:
                seen[r["key"]] = len(runs)
                runs.append(r)
            elif r["own"] and not runs[seen[r["key"]]]["own"]:
                runs[seen[r["key"]]] = r
    # One odd file (a line nested too deep, a field of the wrong type) is skipped, never the whole answer.
    for path, sid, app in sources:
        try:
            add(_cached_runs(path, lambda path=path, sid=sid, app=app: _claude_runs_in(path, sid, app)))
        except Exception:
            continue
    try:
        chats = copilot_chat_files()
    except Exception:
        chats = []
    for path, folder in chats:
        try:
            add(_cached_runs(path, lambda path=path, folder=folder: _copilot_runs_in(path, folder)))
        except Exception:
            continue
    for events in sorted(glob.glob(os.path.join(copilot_cli_dir(), "session-state", "*", "events.jsonl"))):
        try:
            add(_cached_runs(events, lambda folder=os.path.dirname(events): _copilot_cli_runs_in(folder)))
        except Exception:
            continue
    return runs


def run_folders(run):
    """The folders a run's commits went to: where it `cd`'d (or the session's folder
    when a variable named it), never a throwaway repo."""
    out = []
    for where, scratch in run["places"]:
        if not scratch and (where or run["cwd"]):
            out.append(where or run["cwd"])
    return list(dict.fromkeys(out))


# A commit's own mark of the AI tool that made it: (tool, app, how it says so). Known by the
# tool's address — a colleague called Claude or Devin is a colleague; a tool's bare name
# counts only with a no-reply or bot address.
_NOREPLY = r"[^<]*<[^>]*(?:noreply|no-reply|\[bot\]|bot@)"
_COAUTHOR = (
    ("claude", None, re.compile(r"noreply@anthropic\.com|claude\[bot\]|^\s*claude\b" + _NOREPLY)),
    ("copilot", "copilot-cli", re.compile(r"223556219\+copilot@")),
    ("copilot", "copilot", re.compile(r"<copilot@github\.com>")),
    ("copilot", None, re.compile(r"\+copilot@users\.noreply\.github\.com|copilot-swe-agent|^\s*(github\s+)?copilot\b" + _NOREPLY)),
    ("cursor", "cursor", re.compile(r"cursoragent@cursor\.com|^\s*cursor\b" + _NOREPLY)),
    ("codex", None, re.compile(r"noreply@openai\.com|chatgpt-codex-connector|^\s*codex\b" + _NOREPLY)),
    ("antigravity", None, re.compile(r"^\s*antigravity\b[^<]*<[^>]*(?:noreply|\[bot\]|google|gemini)")),
    ("gemini", None, re.compile(r"gemini-cli@google\.com|gemini-code-assist|^\s*gemini\b" + _NOREPLY)),
    ("aider", None, re.compile(r"aider@aider\.chat|^\s*aider\b" + _NOREPLY)),
    ("opencode", None, re.compile(r"noreply@opencode\.ai|^\s*opencode\b" + _NOREPLY)),
    ("devin", None, re.compile(r"devin-ai-integration|^\s*devin\b" + _NOREPLY)),
)
# An Assisted-by or Generated-by line names a tool in words ("Claude:claude-opus", "Copilot").
_TOOL_WORD = re.compile(r"^\s*(claude|copilot|cursor|codex|gemini|antigravity|aider|opencode|devin)\b")
# Authors that are an AI tool itself (cloud agents, bots); git log is asked for these too.
_AI_AUTHORS = (
    ("claude", re.compile(r"noreply@anthropic\.com|claude\[bot\]"), ("noreply@anthropic.com", "claude[bot]")),
    ("copilot", re.compile(r"198982749\+copilot@|copilot-swe-agent"), ("198982749+copilot@", "copilot-swe-agent")),
    ("cursor", re.compile(r"cursoragent@cursor\.com"), ("cursoragent@cursor.com",)),
    ("codex", re.compile(r"chatgpt-codex-connector|noreply@openai\.com"), ("chatgpt-codex-connector", "noreply@openai.com")),
    ("devin", re.compile(r"devin-ai-integration"), ("devin-ai-integration",)),
)
AI_TOOLS = ("claude", "copilot", "cursor", "codex", "gemini", "antigravity", "aider", "opencode", "devin", "ai")
_RANK = {"record": 3, "copy": 3, "line": 2, "author": 2, "time": 1, None: 0}


def _tool_named(text):
    for tool, app, pat in _COAUTHOR:
        if pat.search(text):
            return tool, app
    return None


def commit_mark(trailers, author, committer):
    """The AI tool a commit names itself, or None: (tool, app or None, "line" | "author").
    trailers: [(key, value)]; author / committer: (name, email). An Assisted-by that names
    no tool known here says "an AI" — unless a later line is more precise."""
    unnamed = None
    for key, value in trailers:
        k, v = key.lower(), value.lower()
        if k == "co-authored-by":
            hit = _tool_named(v)
            if hit:
                return hit[0], hit[1], "line"
        elif k == "made-with" and v.startswith("cursor"):
            return "cursor", "cursor", "line"
        elif k == "claude-session":
            return "claude", None, "line"
        elif k in ("assisted-by", "generated-by"):
            m = _TOOL_WORD.match(v)
            if m:
                return m.group(1), None, "line"
            if k == "assisted-by":
                unnamed = unnamed or ("ai", None, "line")
    for name, email in (author, committer):
        who = f"{name} <{email}>".lower()
        for tool, pat, _ in _AI_AUTHORS:
            if pat.search(who):
                return tool, None, "author"
        if name.lower().rstrip().endswith("(aider)"):
            return "aider", None, "author"
    return unnamed


def your_identity(top, global_email="", global_name=""):
    """The emails your commits carry in this repo (its own user.email and your global
    one) and your names (to know you in a co-author line)."""
    hit = _emails_cache.get(top)
    if hit and time.time() - hit[0] < _KEEP_S:
        local, local_name = hit[1]
    else:
        local = (_git(top, "config", "--get", "user.email", timeout=5) or "").strip().lower()
        local_name = (_git(top, "config", "--get", "user.name", timeout=5) or "").strip().lower()
        _emails_cache[top] = (time.time(), (local, local_name))
    return sorted(e for e in {local, global_email} if e), sorted(n for n in {local_name, global_name} if n)


def your_emails(top, global_email=""):
    return your_identity(top, global_email)[0]


_repo_log_cache = {}
_object_cache = {}
# Fields with NUL between them (and between commits, -z): nothing in a message can fake one.
_LOG_FORMAT = ("%H%x00%h%x00%at%x00%ct%x00%an%x00%ae%x00%cn%x00%ce%x00%T%x00%S%x00"
               "%(trailers:only,unfold,separator=%x1d)%x00%s")
_LOG_FIELDS = 12


def _repo_log(top, emails, since, names=()):
    """git log's records of your commits (and AI tools' own) in one repo — remembered
    until the repo's branches, tags or any worktree's HEAD move (a commit, a pull),
    since a big shared repo takes seconds to walk."""
    refs = _git(top, "for-each-ref", "--format=%(objectname) %(refname)", timeout=10)
    heads = _git(top, "worktree", "list", "--porcelain", timeout=10)
    if refs is None:
        return None
    fingerprint = hashlib.sha256(f"{refs}\0{heads or ''}".encode("utf-8", "replace")).hexdigest()
    key = (top, tuple(emails), tuple(names), since)
    hit = _repo_log_cache.get(key)
    if hit and hit[0] == fingerprint:
        return hit[1]
    common = ["log", "-z", "--exclude=refs/stash", "--exclude=refs/notes/*", "--exclude=refs/original/*",
              "--exclude=refs/replace/*", "--all", "--no-use-mailmap", "--no-show-signature", "--no-ext-diff",
              "--no-textconv", "-F", "-i", f"--since={since} 00:00:00", f"--max-count={COMMITS_MAX_PER_REPO}",
              "--source", f"--format={_LOG_FORMAT}"]
    # Yours, and AI tools' own commits (cloud agents: repo_commits keeps those that name you as
    # co-author or that you committed), read side by side.
    bots = [p for _, _, patterns in _AI_AUTHORS for p in patterns]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        mine = pool.submit(_git, top, *common, *[f"--author=<{e}>" for e in emails], timeout=60)
        theirs = pool.submit(_git, top, *common, *[f"--author={b}" for b in bots], timeout=60)
        out = mine.result()
        if out is not None:
            out += theirs.result() or ""  # each record ends with a NUL, so the two join as one list
        _repo_log_cache[key] = (fingerprint, out)
    return out


def _commit_object(top, short):
    """A commit an AI tool printed that no branch holds any more (amended, rebased):
    (full ID, author time, committer time, tree, subject), or None — read-only, kept."""
    key = (top, short)
    if key not in _object_cache:
        out = _git(top, "log", "-1", "--no-walk", "-z", "--format=%H%x00%at%x00%ct%x00%T%x00%s", short, "--", timeout=10)
        got = None
        if out:
            f = out.strip("\0\n").split("\0")
            if len(f) == 5 and re.fullmatch(r"[0-9a-f]{40,64}", f[0]):
                try:
                    got = (f[0], int(f[1]), int(f[2]), f[3], f[4])
                except ValueError:
                    got = None
        _object_cache[key] = got
    return _object_cache[key]


def _names_you(trailers, emails, names):
    """Does a co-author line name you — by your address exactly, or your name?"""
    for key, value in trailers:
        if key.lower() != "co-authored-by":
            continue
        m = re.match(r"\s*(.*?)\s*<([^>]*)>", value.lower())
        if m and (m.group(2).strip() in emails or m.group(1) in names):
            return True
    return False


def repo_commits(top, since, id_runs, time_runs, copy_runs=(), global_email="", global_name=""):
    """Your commits in one repo since `since`, each tagged by who made it.
    id_runs: runs that printed commit IDs (any repo — a `cd` or `-C` elsewhere);
    time_runs: [(run, how many commits it makes in this repo)] for the runs here;
    copy_runs: this repo's runs whose printed commit may since have been amended or rebased."""
    emails, names = your_identity(top, global_email, global_name)
    if not emails:
        return {"name": os.path.basename(top), "commits": [], "why": "no user.email"}
    f = (_repo_log(top, emails, since, names) or "").split("\0")
    commits = []
    for i in range(0, len(f) - _LOG_FIELDS + 1, _LOG_FIELDS):
        full, short, at, ct, an, ae, cn, ce, tree, ref, trailers, subject = f[i:i + _LOG_FIELDS]
        full = full.lstrip("\n")
        if not re.fullmatch(r"[0-9a-f]{40,64}", full):
            continue
        try:
            when, committed = int(at), int(ct)
        except ValueError:
            continue
        pairs = [(k.strip(), v.strip()) for k, sep, v in (t.partition(":") for t in trailers.split("\x1d")) if sep and k.strip()]
        mark = commit_mark(pairs, (an, ae), (cn, ce))
        if ae.lower() not in emails:
            # An AI tool's own commit (a cloud agent's) is yours when it names you: as co-author, or you committed it.
            if not (mark and mark[2] == "author" and (ce.lower() in emails or _names_you(pairs, emails, names))):
                continue
        ref = re.sub(r"^refs/(heads|remotes|tags)/", "", ref or "")
        commits.append({"id": full, "short": short, "at": when * 1000, "committed": committed * 1000,
                        "subject": subject[:300], "ref": ref[:120], "tree": tree,
                        "tool": mark[0] if mark else None, "app": mark[1] if mark else None,
                        "via": mark[2] if mark else None, "session": None})

    matched = {}  # run key → commits its printed IDs account for here

    def claim(c, run, via):
        c.update(tool=run["tool"], app=run["app"], via=via, session=run["session"])
        if via in ("record", "copy"):
            matched[run["key"]] = matched.get(run["key"], 0) + 1

    # 1. A tool's own record by ID: the commit it printed, near when it ran (an amend keeps its old author time).
    printed = set()
    for run in id_runs:
        for x in run["ids"]:
            for c in commits:
                if c["id"].startswith(x) and any(run["start"] - COMMIT_ID_NEAR_S <= t / 1000 <= run["end"] + COMMIT_ID_NEAR_S
                                                 for t in (c["at"], c["committed"])):
                    if _RANK[c["via"]] < 3:
                        claim(c, run, "record")
                    printed.add(x)
    # 2. …or its copy, when that commit was amended or rebased since: same message, and same author time or same content.
    for run in copy_runs:
        for x in run["ids"]:
            if x in printed:
                continue
            obj = _commit_object(top, x)
            if not obj or any(c["id"] == obj[0] for c in commits):
                continue
            copies = [c for c in commits if c["subject"] == obj[4][:300] and (c["at"] // 1000 == obj[1] or c["tree"] == obj[3])
                      and c["committed"] // 1000 >= obj[2] and _RANK[c["via"]] < 3]
            if copies:
                claim(min(copies, key=lambda c: c["committed"]), run, "copy")
                printed.add(x)
    # 3. A rebased or cherry-picked copy keeps its author time and message (and gets a new commit time): list it once,
    #    made by whoever made the first one — a later copy only says who copied it. Commits a loop made in one second
    #    share both times: they stay apart.
    groups = {}
    for c in commits:
        groups.setdefault((c["at"], c["subject"]), []).append(c)
    commits = []
    for group in groups.values():
        if len(group) == 1 or len({c["committed"] for c in group}) < len(group):
            commits.extend(group)
            continue
        first, keep = min(group, key=lambda c: c["committed"]), group[0]
        if keep is not first:
            keep.update(tool=first["tool"], app=first["app"], via=first["via"], session=first["session"])
        commits.append(keep)

    # 4. A run whose printed IDs don't account for its commits here (`git commit -q`, a quiet merge, an ID that
    #    isn't this repo's): "probably" the ones that landed while it ran — as many as it makes (a loop: any
    #    number), the closest to its end; when two runs overlap, the shorter one's. A run with nothing during
    #    it, and no ID at all, takes the closest commit within 2 minutes.
    def free(c, run):  # yours, or the same app's by its line, with no chat linked yet
        return c["session"] is None and (c["tool"] is None or (
            c["tool"] == run["tool"] and c["via"] in ("line", "author") and c["app"] in (None, run["app"])))

    def tag_time(c, run):
        if c["tool"] is None:
            claim(c, run, "time")
        else:
            c.update(session=run["session"], app=run["app"])  # its line said so already: link the chat

    def when(c, run):
        return c["committed"] / 1000 if run["amend"] else c["at"] / 1000
    room, used = {}, {}
    for run, n in time_runs:
        if not run["unfinished"]:
            room[run["key"]] = float("inf") if run["loops"] else max(0, n - matched.get(run["key"], 0))
    pairs = []
    for run, _ in time_runs:
        if room.get(run["key"]):
            for c in commits:
                t = when(c, run)
                if run["start"] - COMMIT_SPAN_SLACK_S <= t <= run["end"] + COMMIT_SPAN_SLACK_S:
                    pairs.append((run["end"] - run["start"], abs(run["end"] - t), id(c), c, run))
    for *_, c, run in sorted(pairs, key=lambda p: p[:3]):
        if used.get(run["key"], 0) < room[run["key"]] and free(c, run):
            tag_time(c, run)
            used[run["key"]] = used.get(run["key"], 0) + 1
    near = []
    for run, _ in time_runs:
        if room.get(run["key"]) and not run["ids"] and run["near"] and not run["failed"] and not used.get(run["key"]):
            for c in commits:
                t = when(c, run)
                gap = min(abs(t - run["start"]), abs(t - run["end"]))
                if gap <= COMMIT_NEAR_S:
                    near.append((gap, id(c), c, run))
    for *_, c, run in sorted(near, key=lambda p: p[:2]):
        if not used.get(run["key"]) and free(c, run):
            tag_time(c, run)
            used[run["key"]] = 1
    out = []
    for c in commits:
        by = "you" if c["tool"] is None else c["tool"] + ("?" if c["via"] == "time" else "")
        out.append({"id": c["id"], "short": c["short"], "at": c["at"], "committed": c["committed"], "subject": c["subject"],
                    "ref": c["ref"], "by": by, "via": c["via"], "app": c["app"], "session": c["session"]})
    return {"name": os.path.basename(top), "commits": out}


def your_commits(folders, since):
    """{folders: folder → repo top | None, repos: top → {name, commits}} for the page."""
    runs = ai_commit_runs()
    home = os.path.expanduser("~")
    global_email = (_git(home, "config", "--global", "--get", "user.email", timeout=5) or "").strip().lower()
    global_name = (_git(home, "config", "--global", "--get", "user.name", timeout=5) or "").strip().lower()
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        where = sorted(set(folders) | {d for r in runs for d in run_folders(r)})
        tops_of = dict(zip(where, pool.map(repo_of, where)))
        mapping = {f: tops_of.get(f) for f in folders}
        # How many commits each run makes in each repo (its places there, never a throwaway repo's).
        made_in = {}
        for r in runs:
            counts = {}
            for where, scratch in r["places"]:
                top = None if scratch else tops_of.get(where or r["cwd"])
                if top:
                    counts[top] = counts.get(top, 0) + 1
            made_in[r["key"]] = counts
        id_runs = [r for r in runs if r["ids"]]
        tops = sorted({t for t in mapping.values() if t})

        def one(top):
            try:
                time_runs = [(r, made_in[r["key"]][top]) for r in runs if top in made_in[r["key"]]]
                copy_runs = [r for r in id_runs if top in made_in[r["key"]]]
                return repo_commits(top, since, id_runs, time_runs, copy_runs, global_email, global_name)
            except Exception:  # one unreadable repo never takes the others down
                return {"name": os.path.basename(top), "commits": [], "why": "unreadable"}
        found = dict(zip(tops, pool.map(one, tops)))
    return {"folders": mapping, "repos": found}


def collect_claude_code():
    """Every Claude Code session, trimmed — plus the copies Throwbacks kept of
    sessions Claude Code has since deleted. `mtime` (when Claude Code last
    wrote it) is what its cleanup goes by; `kept`: Throwbacks holds a copy."""
    kept = kept_copies() if STORE else {}
    files, seen = [], set()
    for path in newest_by_name(claude_code_files()):
        try:
            if os.path.getsize(path) > CLAUDE_CODE_MAX_FILE:
                continue
            text = prune_claude_code_file(path)
            mtime = int(os.path.getmtime(path) * 1000)
        except OSError:
            continue
        name = os.path.basename(path)
        seen.add(name[:-len(".jsonl")])
        try:
            entry = claude_session_folder(path)[1] or ""
        except OSError:
            entry = ""
        files.append({"name": name, "project": os.path.basename(os.path.dirname(path)),
                      "text": text, "mtime": mtime, "kept": name[:-len(".jsonl")] in kept,
                      "desktop": "desktop" in entry,  # Claude desktop's sessions aren't swept
                      "subTokens": subagent_tokens(path)})
    for sid, meta in kept.items():
        if sid in seen:
            continue
        try:
            text = prune_claude_code_file(os.path.join(KEEP_DIR, sid + ".jsonl.gz"))
        except (OSError, EOFError, gzip.BadGzipFile, zlib.error, ValueError):
            continue
        try:
            with gzip.open(os.path.join(KEEP_DIR, sid + ".subtokens.gz"), "rt", encoding="utf-8", errors="replace") as f:
                sub = f.read()
        except (OSError, EOFError, zlib.error, ValueError):
            sub = ""
        files.append({"name": sid + ".jsonl", "project": meta.get("project") or "", "text": text,
                      "mtime": meta.get("sourceMtime"), "kept": True, "onlyKept": True, "subTokens": sub})
    return {"files": files}


# ---- Keeping a copy of a chat Claude Code will delete --------------------
#
# Claude Code deletes a session's transcript once it hasn't been touched for
# cleanupPeriodDays (30 unless you set it). On your click, Throwbacks keeps a
# gzipped copy in ~/.throwbacks/kept/claude-code/ (folder 0700, files 0600,
# on this Mac only), shows it after the original is gone, and refreshes it
# while the original keeps changing. It only ever copies out of ~/.claude:
# nothing there is written, moved or deleted.

KEEP_DIR = os.path.join(os.path.expanduser("~"), ".throwbacks", "kept", "claude-code")
# A session's ID — or a transcript Claude Code set aside (<id>.orphaned-<when>-<suffix>), swept the same way.
KEEP_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\.orphaned-[A-Za-z0-9_-]{1,80})?")


# Throwbacks' own Claude Code runs (summaries, the usage meter) start Claude Code,
# whose start-up sweep deletes old chats: for these runs the period is a century,
# so they never delete one — the Expiring tab's "deleted today" stays yours to keep.
NO_SWEEP = ["--settings", '{"cleanupPeriodDays": 36500}']
_UNREADABLE = object()


def _retention_in(path):
    """cleanupPeriodDays in one settings file: a whole number of days, 0 (Claude Code
    then pauses its sweep), _UNREADABLE (a file it can't read: it pauses too), or None."""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return _UNREADABLE
    if not isinstance(d, dict) or "cleanupPeriodDays" not in d:
        return None
    v = d["cleanupPeriodDays"]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != int(v):
        return _UNREADABLE
    return int(v)


def _project_settings():
    """The project settings files Claude Code reads when started in a session's folder."""
    folders = set()
    for path in claude_code_files():
        try:
            folder = claude_session_folder(path)[0]
        except OSError:
            continue
        if folder:
            folders.add(folder)
    return [os.path.join(f, ".claude", n) for f in sorted(folders) for n in ("settings.json", "settings.local.json")]


def claude_retention():
    """{days, set, source, paused}: how long Claude Code keeps a chat after it was last
    used, as its own start-up sweep decides. A managed value (your organisation's,
    cached by Claude Code in remote-settings.json, or a managed-settings file) wins;
    otherwise the shortest of yours and any project's (the sweep covers every project,
    with the settings of the folder it was started in). 0 or an unreadable value: the
    sweep is paused (paused: true, days: None)."""
    base = os.path.dirname(claude_settings_file())
    managed = [os.path.join(base, "remote-settings.json"), "/Library/Application Support/ClaudeCode/managed-settings.json",
               *sorted(glob.glob("/Library/Application Support/ClaudeCode/managed-settings.d/*.json"))]
    for path in managed:
        v = _retention_in(path)
        if v is _UNREADABLE or v == 0:
            return {"days": None, "set": True, "source": "managed", "paused": True}
        if v:
            return {"days": v, "set": True, "source": "managed", "paused": False}
    found = []
    for source, path in [("user", claude_settings_file())] + [("project", p) for p in _project_settings()]:
        v = _retention_in(path)
        if v is not None:
            found.append((source, v))
    numbers = [(src, v) for src, v in found if v is not _UNREADABLE and v > 0]
    if numbers:
        src, v = min(numbers, key=lambda x: x[1])
        return {"days": v, "set": True, "source": src, "paused": False}
    if found:  # only 0s or unreadable values
        return {"days": None, "set": True, "source": found[0][0], "paused": True}
    return {"days": 30, "set": False, "source": "default", "paused": False}


def kept_copies():
    """{sessionId: meta} of the copies Throwbacks keeps."""
    out = {}
    try:
        names = os.listdir(KEEP_DIR)
    except OSError:
        return out
    for name in names:
        sid = name[:-len(".json")] if name.endswith(".json") else None
        if not sid or not KEEP_ID.fullmatch(sid) or not os.path.exists(os.path.join(KEEP_DIR, sid + ".jsonl.gz")):
            continue
        try:
            with open(os.path.join(KEEP_DIR, name), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict):
            out[sid] = meta
    return out


def _claude_transcript(sid):
    paths = glob.glob(os.path.join(claude_code_dir(), "*", sid + ".jsonl"))
    try:
        return max(paths, key=os.path.getmtime) if paths else None
    except OSError:
        return None


def _write_private(path, data):
    """`data` (bytes, or a function that writes to the file it's given) into `path`, 0600: written
    whole to a temp file, then renamed into place."""
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            if callable(data):
                data(f)
            else:
                f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(tmp)


_keep_lock = threading.Lock()


def keep_copy(sid):
    """Copy one Claude Code session into Throwbacks' own folder. Returns its meta, or None if it's gone."""
    with _keep_lock:
        return _keep_copy(sid)


def _keep_copy(sid):
    src = _claude_transcript(sid)
    if not src:
        return None
    st = os.stat(src)
    if st.st_size > CLAUDE_CODE_MAX_FILE:  # one the import would skip
        raise ValueError("That session is too big to keep a copy of.")
    os.makedirs(KEEP_DIR, mode=0o700, exist_ok=True)
    os.chmod(KEEP_DIR, 0o700)

    def gzipped(out):  # read and compressed a piece at a time, never the whole transcript in memory
        with open(src, "rb") as f, gzip.GzipFile(fileobj=out, mode="wb", compresslevel=6, mtime=0) as gz:
            shutil.copyfileobj(f, gz, 1024 * 1024)
    _write_private(os.path.join(KEEP_DIR, sid + ".jsonl.gz"), gzipped)
    sub = subagent_tokens(src)  # its subagents' token usage, so their tokens stay once the original goes
    if sub:
        _write_private(os.path.join(KEEP_DIR, sid + ".subtokens.gz"), gzip.compress(sub.encode("utf-8"), mtime=0))
    meta = {"id": sid, "project": os.path.basename(os.path.dirname(src)), "savedAt": int(time.time() * 1000),
            "sourceMtime": int(st.st_mtime * 1000), "size": st.st_size}
    old = kept_copies().get(sid)
    if old and old.get("firstSavedAt"):
        meta["firstSavedAt"] = old["firstSavedAt"]
    else:
        meta["firstSavedAt"] = meta["savedAt"]
    _write_private(os.path.join(KEEP_DIR, sid + ".json"), json.dumps(meta).encode())
    return meta


def remove_copy(sid):
    with _keep_lock:
        for ext in (".json", ".jsonl.gz", ".subtokens.gz"):  # the meta first: a copy without it is never listed
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(KEEP_DIR, sid + ext))


def keep_status():
    """The retention setting and the kept copies — refreshing any copy whose original changed since
    (never with --no-store: then nothing is kept or written)."""
    if not STORE:
        return {"retention": claude_retention(), "kept": [], "dir": KEEP_DIR}
    kept = kept_copies()
    for sid, meta in list(kept.items()):
        src = _claude_transcript(sid)
        try:
            if src and int(os.path.getmtime(src) * 1000) > int(meta.get("sourceMtime") or 0):
                with _keep_lock:  # still kept? (it may have been removed a moment ago)
                    if os.path.exists(os.path.join(KEEP_DIR, sid + ".json")):
                        kept[sid] = _keep_copy(sid) or meta
            kept[sid]["original"] = bool(src)
        except (OSError, ValueError):
            kept[sid]["original"] = bool(src)
    return {"retention": claude_retention(), "kept": list(kept.values()), "dir": KEEP_DIR}


# ---- App icons for the landing page's app tiles ------------------------
#
# Each tile shows the tool's own icon, read at request time from the app
# installed on this Mac — nothing is downloaded, stored or shipped. Only
# the fixed bundles below are opened, the icon file name from Info.plist is
# reduced to a bare name inside that bundle's Resources, and only PNG
# images (by signature) are ever returned.

APP_BUNDLES = {
    "claude": ("Claude.app",),
    "cursor": ("Cursor.app",),
    "vscode": ("Visual Studio Code.app", "Visual Studio Code - Insiders.app"),
    "antigravity": ("Antigravity.app",),
    "windsurf": ("Windsurf.app",),
    "zed": ("Zed.app", "Zed Preview.app"),
    "chatgpt": ("ChatGPT.app",),
}
# Copilot's icon ships with VS Code's built-in Copilot extension.
COPILOT_PNG = os.path.join("Contents", "Resources", "app", "extensions", "copilot", "assets", "copilot.png")
ICON_IDS = ("copilot", *APP_BUNDLES)
PNG_SIG = b"\x89PNG\r\n\x1a\n"
ICON_MAX = 4 * 1024 * 1024
_icon_cache = {}


def app_bundle(app_id):
    if sys.platform != "darwin":
        return None
    for base in ("/Applications", os.path.join(os.path.expanduser("~"), "Applications")):
        for name in APP_BUNDLES.get(app_id, ()):
            path = os.path.join(base, name)
            if os.path.isdir(path):
                return path
    return None


def icns_png(path, want=128):
    """The PNG image in an .icns closest to `want` px (at least that size
    when there is one), or None. Modern icons store their sizes as PNG."""
    with open(path, "rb") as f:
        data = f.read(ICON_MAX * 4)
    if data[:4] != b"icns":
        return None
    best = None
    off = 8
    while off + 8 <= len(data):
        _typ, length = struct.unpack(">4sI", data[off:off + 8])
        if length < 8:
            break
        body = data[off + 8:off + length]
        if body[:8] == PNG_SIG and len(body) >= 24:
            width = struct.unpack(">I", body[16:20])[0]
            score = (0 if width >= want else 1) * 10000 + abs(width - want)
            if best is None or score < best[0]:
                best = (score, body)
        off += length
    return best[1] if best and len(best[1]) <= ICON_MAX else None


def app_icon(app_id):
    if app_id in _icon_cache:
        return _icon_cache[app_id]
    png = None
    try:
        if app_id == "copilot":
            vs = app_bundle("vscode")
            path = os.path.join(vs, COPILOT_PNG) if vs else None
            if path and os.path.isfile(path) and os.path.getsize(path) <= ICON_MAX:
                with open(path, "rb") as f:
                    png = f.read()
        else:
            bundle = app_bundle(app_id)
            if bundle:
                with open(os.path.join(bundle, "Contents", "Info.plist"), "rb") as f:
                    info = plistlib.load(f)
                name = info.get("CFBundleIconFile")
                if isinstance(name, str) and name.strip():
                    name = os.path.basename(name.strip())
                    if not name.endswith(".icns"):
                        name += ".icns"
                    icns = os.path.join(bundle, "Contents", "Resources", name)
                    if os.path.isfile(icns):
                        png = icns_png(icns)
    except (OSError, ValueError, plistlib.InvalidFileException, struct.error):
        png = None
    if png is not None and png[:8] != PNG_SIG:
        png = None
    if png is not None:
        _icon_cache[app_id] = png  # a missing app is re-checked next time
    return png


# Tools with no reader yet: reported only as present / absent, so the
# landing page can say which of them are on this Mac.
LATER_TOOLS = {
    "antigravity": lambda: app_bundle("antigravity") or os.path.isdir(os.path.join(os.path.expanduser("~"), ".gemini", "antigravity")),
    "windsurf": lambda: app_bundle("windsurf") or os.path.isdir(os.path.join(os.path.expanduser("~"), ".codeium", "windsurf")),
    "chatgpt": lambda: app_bundle("chatgpt"),
    "gemini-cli": lambda: os.path.isdir(os.path.join(os.path.expanduser("~"), ".gemini", "tmp")),
    "codex": lambda: os.path.isdir(os.path.join(os.path.expanduser("~"), ".codex", "sessions")),
    "opencode": lambda: os.path.isdir(os.path.join(os.path.expanduser("~"), ".local", "share", "opencode")),
    "zed": lambda: app_bundle("zed"),
}


def import_status():
    cli = copilot_cli_dir()
    return {
        "enabled": True,
        "claudeCode": len(claude_code_files()),
        "copilot": len(copilot_chat_files()),
        "cursor": os.path.isfile(os.path.join(app_user_dir("Cursor"), "globalStorage", "state.vscdb")),
        "copilotCli": len(glob.glob(os.path.join(cli, "session-state", "*", "events.jsonl")))
                      or os.path.isfile(os.path.join(cli, "session-store.db")),
        "cowork": len(glob.glob(os.path.join(claude_desktop_dir(), "local-agent-mode-sessions",
                                             "*", "*", "local_*.json"))),
        "later": {tool: bool(found()) for tool, found in LATER_TOOLS.items()},
        "icons": [app_id for app_id in ICON_IDS if app_icon(app_id)],
    }


# ---- Daily log summaries (the AI column) --------------------------------

_NO_PERSIST = None


def claude_no_persist_flag():
    """["--no-session-persistence"] when this Claude CLI has the flag, so the
    summarizer's runs are never saved as sessions (they'd show up in your
    history and in Throwbacks); [] on an older CLI, which would refuse it."""
    global _NO_PERSIST
    if _NO_PERSIST is None:
        try:
            out = subprocess.run([CLAUDE_BIN, "--help"], capture_output=True, timeout=20).stdout
            _NO_PERSIST = ["--no-session-persistence"] if b"--no-session-persistence" in out else []
        except (OSError, subprocess.TimeoutExpired):
            _NO_PERSIST = []
    return _NO_PERSIST


# Claude Code's `--output-format json` usage fields → the bridge's names.
CLAUDE_USAGE_FIELDS = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_creation_input_tokens": "cacheWrite",
    "cache_read_input_tokens": "cacheRead",
}


def claude_login_expired(text):
    """The CLI's words for an expired or missing login (it may still exit 0) —
    an older CLI's plain text, where a "401" near the start is all there is (a
    401 on its own: never part of a longer number, a line:column or an address)."""
    return ("Failed to authenticate" in text or "Re-authenticate" in text
            or re.search(r"(?<![\w.:])401(?![\w:])", text[:200]) is not None)


# A failed JSON result's words for a login that's gone, expired or missing — in
# `claude -p` and interactive wording. Matched as phrases: a bare "401" could be
# part of a token count or a request id.
CLAUDE_LOGIN_GONE = re.compile(
    r"please (?:run /)?log ?in|log ?in again|sign in again|not logged in|authentication required"
    r"|authentication_error|failed to authenticate|re-authenticate|oauth (?:token|session) (?:revoked|expired)"
    r"|does not have access to claude|api error: 401\b", re.I)


# …but not another Claude Code process refreshing the same login at that moment: "usually
# transient; retry in a minute… or sign in again" — the login is fine.
CLAUDE_LOGIN_BUSY = re.compile(r"another Claude Code process|usually transient", re.I)


def claude_login_gone(text):
    """A failed JSON result says the login is gone (expired, revoked, missing)."""
    text = text or ""
    return bool(CLAUDE_LOGIN_GONE.search(text)) and not CLAUDE_LOGIN_BUSY.search(text)


def claude_json_result(out):
    """Claude Code's `-p --output-format json` answer — one result object —
    read defensively, or None when `out` isn't one (an older CLI that
    printed plain text). Returns {"text", "failed", "error", "usage",
    "model"}: the reply's text; whether the run says it failed (is_error, or
    a subtype other than success) and its message; the token counts that
    are plain non-negative numbers (None when there are none); the model
    when exactly one ran."""
    try:
        obj = json.loads(out)
    except (ValueError, RecursionError):
        return None
    if isinstance(obj, list):  # --verbose's shape: every message, the result last
        obj = next((m for m in reversed(obj) if isinstance(m, dict) and m.get("type") == "result"), None)
    if not isinstance(obj, dict) or obj.get("type") != "result":
        return None
    text = obj.get("result")
    text = text.strip() if isinstance(text, str) else ""
    subtype = obj.get("subtype")
    bad_subtype = subtype is not None and subtype != "success"
    failed = obj.get("is_error") is True or bad_subtype
    error = (text or (str(subtype)[:100] if bad_subtype else "")) if failed else ""
    usage = {}
    raw = obj.get("usage")
    if isinstance(raw, dict):
        for field, name in CLAUDE_USAGE_FIELDS.items():
            v = raw.get(field)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0:
                usage[name] = int(round(v))
    models = obj.get("modelUsage")
    model = None
    if isinstance(models, dict) and len(models) == 1:
        (name,) = models
        if isinstance(name, str) and 0 < len(name) <= 200 and name.isprintable():
            model = name
    return {"text": text, "failed": failed, "error": error, "usage": usage or None, "model": model}


def log_key_ok(kind, key):
    """True when `key` names a summary of `kind`: a real day (a week by its
    Monday), a real month, or a period of real days whose start is on or
    before its end. Only such keys ever become file names."""
    pattern = LOG_KEYS.get(kind) if isinstance(kind, str) else None
    if pattern is None or not isinstance(key, str) or not pattern.fullmatch(key):
        return False
    try:
        dates = [datetime.strptime(part + "-01" if kind == "month" else part, "%Y-%m-%d")
                 for part in key.split("_")]
    except ValueError:
        return False
    return dates == sorted(dates)


def read_log_summaries():
    """Every saved summary, by kind: {"days": {date: obj}, "weeks": {monday:
    obj}, "months": {"YYYY-MM": obj}, "periods": {"start_end": obj}} — every
    bucket present, empty when nothing is saved."""
    out = {bucket: {} for bucket in LOG_BUCKETS.values()}
    for kind, bucket_name in LOG_BUCKETS.items():
        folder = LOG_DIRS.get(kind)
        if not folder:
            continue
        bucket = out[bucket_name]
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            key, ext = os.path.splitext(name)
            if ext != ".json" or not log_key_ok(kind, key):
                continue
            try:
                with open(os.path.join(folder, name)) as f:
                    obj = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(obj, dict):
                bucket[key] = obj
    return out


def write_log_summary(kind, key, data):
    """Write one summary as <key>.json, private to this user: written to a
    temp file first and renamed into place, so a crash never leaves half a
    file."""
    if not log_key_ok(kind, key):  # the routes check first; never a path either way
        raise ValueError("bad summary key")
    folder = LOG_DIRS[kind]
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{key}-", suffix=".tmp", dir=folder)  # created 0600
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, os.path.join(folder, key + ".json"))
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def delete_log_summary(kind, key):
    if not log_key_ok(kind, key):
        raise ValueError("bad summary key")
    with contextlib.suppress(FileNotFoundError):
        os.remove(os.path.join(LOG_DIRS[kind], key + ".json"))


def claude_settings_file():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "settings.json")


def _usage_window(w):
    if not isinstance(w, dict):
        return None
    pct, reset = w.get("used_percentage"), w.get("resets_at")
    if isinstance(pct, bool) or isinstance(reset, bool):
        return None
    if not isinstance(pct, (int, float)) or not isinstance(reset, (int, float)):
        return None
    return {"used_percentage": float(pct), "resets_at": int(reset)}


def usage_status(read_apps=True):
    """The usage meter, read-only: the numbers statusline.py saved (and only
    those), the last live answers, the Claude apps' own saved numbers (only
    while there's no live Claude reading with numbers), and whether Claude
    Code's status line runs our script — the settings file is read, never
    written; adding the line is up to you.
    read_apps=False (the app's /?sample) reads no file and asks nothing: no
    usage of yours, not Claude Code's settings, not Codex's sessions, not
    Cursor's plan — the sample shows the meter as off."""
    reading = None
    try:
        if not read_apps:
            raise OSError("the sample shows no real numbers")
        with open(USAGE_FILE) as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            reading = {k: int(raw[k]) for k in ("at", "seen_at", "missing_at")
                       if isinstance(raw.get(k), (int, float)) and not isinstance(raw.get(k), bool)}
            for k in ("five_hour", "seven_day"):
                reading[k] = _usage_window(raw.get(k))
    except (OSError, ValueError):
        pass
    command = None
    try:
        if not read_apps:
            raise OSError("not reading other apps' files")
        with open(claude_settings_file()) as f:
            settings = json.load(f)
        line = settings.get("statusLine") if isinstance(settings, dict) else None
        if isinstance(line, dict) and isinstance(line.get("command"), str):
            command = line["command"][:500]
    except (OSError, ValueError):
        pass
    script = os.path.join(ROOT, "statusline.py")
    return {
        "reading": reading,
        "configured": command is not None,
        "ours": bool(command) and script in command,
        "command": command,
        "settingsFile": claude_settings_file(),
        "snippet": {"statusLine": {"type": "command", "command": f"python3 {shlex.quote(script)}"}},
        "live": {"enabled": CLAUDE and read_apps, "reading": _LIVE["claude"]["reading"] if read_apps else None},
        "saved": claude_saved_usage() if read_apps and not (_LIVE["claude"]["reading"] or {}).get("windows") else {},
        "plans": other_plans_status() if read_apps else {},
        "ask": usage_asks(),
        **({} if read_apps else {"sample": True}),
    }


# ---- The usage meter, saved: the numbers the Claude apps keep themselves --
#
# When Claude Code can't be asked (its login lapsed, say), the last numbers
# the Claude apps saved on this Mac stand in, with their age: Claude Code's
# own copy of its last usage check (`cachedUsageUtilization` in
# ~/.claude.json — every limit, Fable and reset times included; Claude Code
# clears it when you log out) and Claude desktop's record of its own checks
# (plan-usage-history.json: the 5-hour and weekly percent, no reset times).
# Read-only, numbers and times only: ~/.claude.json is parsed whole, and
# only that entry is kept — the rest (your account, and any API key Claude
# Code saved there) is never kept or sent. Each reading must be the
# account's (and org's) Claude Code knows, when it knows one.

DESKTOP_USAGE_KEYS = (("fh", "session", "session", None), ("sd", "weekly_all", "weekly", None),
                      ("so", "weekly_scoped", "weekly", "Opus"), ("sn", "weekly_scoped", "weekly", "Sonnet"))
_saved_usage = {}


def claude_global_config():
    """Claude Code's own state file: ~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(base or os.path.expanduser("~"), ".claude.json")


def _saved_reading(path, parse):
    """parse(the file's JSON), remembered until the file changes; None when there's nothing."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    hit = _saved_usage.get(path)
    if hit and hit[0] == key:
        return hit[1]
    try:
        with open(path, encoding="utf-8") as f:
            value = parse(json.load(f))
    except Exception:  # unreadable, half-written or a new shape: no reading, never a broken meter
        value = None
    _saved_usage[path] = (key, value)
    return value


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _ms(v):
    return int(v // 1000) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def _str(v):
    return v if isinstance(v, str) and v else None


def code_saved_usage(obj):
    """From ~/.claude.json: Claude Code's last usage check, {"at", "windows"} (as live_windows
    gives them) or None — and the org it's logged in to, only to match desktop's readings with
    (never sent). A check made for another account than the one Claude Code knows is dropped,
    as Claude Code itself drops it."""
    obj = obj if isinstance(obj, dict) else {}
    account = obj.get("oauthAccount") if isinstance(obj.get("oauthAccount"), dict) else {}
    cache = obj.get("cachedUsageUtilization") if isinstance(obj.get("cachedUsageUtilization"), dict) else {}
    at = _ms(cache.get("fetchedAtMs"))
    windows = live_windows(cache.get("utilization")) if at else []
    mine, theirs = _str(account.get("accountUuid")), _str(cache.get("accountUuid"))
    if mine and theirs and mine != theirs:
        windows = []
    return {"reading": {"at": at, "windows": windows} if windows else None, "org": _str(account.get("organizationUuid"))}


def desktop_samples(obj):
    """Claude desktop's usage checks: [(at, org, windows)], numbers only, no reset times."""
    out = []
    samples = obj.get("samples") if isinstance(obj, dict) else None
    for s in samples if isinstance(samples, list) else []:
        at = _ms(s.get("t")) if isinstance(s, dict) else None
        if not at or not isinstance(s.get("u"), dict):
            continue
        windows = []
        for key, kind, group, name in DESKTOP_USAGE_KEYS:
            pct = _pct(s["u"].get(key))
            if pct is not None:
                windows.append({"kind": kind, "group": group, "pct": pct, "resets_at": None, **({"name": name} if name else {})})
        if windows:
            out.append((at, _str(s.get("org")), windows))
    return out


def claude_saved_usage():
    """{"code", "desktop"}: each {"at", "windows"} or None. Desktop's newest check of the org
    Claude Code is logged in to — any org's when Claude Code knows none."""
    code = _saved_reading(claude_global_config(), code_saved_usage) or {}
    samples = _saved_reading(os.path.join(claude_desktop_dir(), "plan-usage-history.json"), desktop_samples) or []
    org = code.get("org")
    mine = [s for s in samples if not org or s[1] == org]
    best = max(mine, key=lambda s: s[0]) if mine else None
    return {"code": code.get("reading"), "desktop": {"at": best[0], "windows": best[2]} if best else None}


# ---- The usage meter, live: Claude Code's own /usage numbers --------------

USAGE_WORD = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
USAGE_REQUEST_ID = "throwbacks-usage"
# The last live answer per tool, and when it was asked (one run at a time).
LIVE_TOOLS = ("claude", "copilot", "chatgpt", "google")
_LIVE = {tool: {"reading": None, "ran": 0.0} for tool in LIVE_TOOLS}
_LIVE_LOCKS = {tool: threading.Lock() for tool in LIVE_TOOLS}


def _epoch(v):
    """Unix seconds from Unix seconds or an ISO 8601 time, else None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v) if v > 0 else None
    if not isinstance(v, str) or len(v) > 64:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$", v.strip())
    if not m:
        return None
    zone = "+00:00" if m.group(2) in (None, "Z") else m.group(2)
    try:
        return int(datetime.fromisoformat(m.group(1) + zone).timestamp())
    except ValueError:
        return None


def _pct(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1000:
        return None
    return round(float(v), 2)


def _name(v):
    return v.strip()[:40] if isinstance(v, str) and v.strip() else None


def live_windows(limits):
    """Your plan's limits from Claude Code's answer (its `rate_limits`), as
    [{"kind", "group", "name"?, "pct", "resets_at"}] — numbers and the
    server's short labels, nothing else. The server's own rows come first
    (`limits`: session, weekly_all, weekly_scoped for one model such as
    Fable…); an answer without them gives its fixed windows instead."""
    out = []
    if not isinstance(limits, dict):
        return out
    rows = limits.get("limits")
    for row in rows[:16] if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        kind, pct = row.get("kind"), _pct(row.get("percent"))
        if not (isinstance(kind, str) and USAGE_WORD.match(kind)) or pct is None:
            continue
        w = {"kind": kind, "pct": pct, "resets_at": _epoch(row.get("resets_at"))}
        if isinstance(row.get("group"), str) and USAGE_WORD.match(row["group"]):
            w["group"] = row["group"]
        scope = row.get("scope") if isinstance(row.get("scope"), dict) else {}
        for part in ("model", "surface"):
            name = _name(scope[part].get("display_name")) if isinstance(scope.get(part), dict) else None
            if name:
                w["name"] = name
                break
        out.append(w)
    if out:
        return out
    for key, kind, group in (("five_hour", "session", "session"), ("seven_day", "weekly_all", "weekly")):
        v = limits.get(key)
        pct = _pct(v.get("utilization")) if isinstance(v, dict) else None
        if pct is not None:
            out.append({"kind": kind, "group": group, "pct": pct, "resets_at": _epoch(v.get("resets_at"))})
    scoped = limits.get("model_scoped")
    for m in scoped[:8] if isinstance(scoped, list) else []:
        name, pct = (_name(m.get("display_name")), _pct(m.get("utilization"))) if isinstance(m, dict) else (None, None)
        if name and pct is not None:
            out.append({"kind": "weekly_scoped", "group": "weekly", "name": name, "pct": pct,
                        "resets_at": _epoch(m.get("resets_at"))})
    return out


def claude_usage_ask(timeout=USAGE_LIVE_TIMEOUT_S):
    """Ask this machine's Claude Code for the numbers /usage shows (its
    experimental `get_usage` request): {"at", "plan", "windows"}, or
    {"at", "error"} when there are none.

    Claude Code makes that one request to Anthropic itself, with its own
    login — Throwbacks never sees the login, sends no message to Claude (no
    AI request) and passes nothing from your chats. The run has no tools,
    no MCP servers, an empty working folder and its optional traffic off,
    isn't saved as a session, and skip_behaviors keeps it from scanning
    your transcripts for a breakdown."""
    now = int(time.time())
    cmd = [CLAUDE_BIN, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
           "--verbose", "--tools", "", "--strict-mcp-config", *NO_SWEEP] + claude_no_persist_flag()
    request = {"type": "control_request", "request_id": USAGE_REQUEST_ID,
               "request": {"subtype": "get_usage", "skip_behaviors": True}}
    workdir = tempfile.mkdtemp(prefix="throwbacks-claude-")
    answer, ended = None, False
    try:
        try:
            proc = subprocess.Popen(cmd, cwd=workdir, env={**os.environ, **USAGE_LIVE_ENV}, text=True,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
        except OSError:
            return {"at": now, "error": "no_cli"}
        lines = queue.Queue()

        def pump():
            try:
                for line in proc.stdout:
                    lines.put(line)
            except (OSError, ValueError):
                pass
            lines.put(None)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            deadline = time.monotonic() + timeout
            while answer is None and not ended:
                try:
                    line = lines.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if line is None:
                    ended = True
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                res = msg.get("response") if isinstance(msg, dict) and msg.get("type") == "control_response" else None
                if isinstance(res, dict) and res.get("request_id") == USAGE_REQUEST_ID:
                    answer = res
        except OSError:  # it closed before reading the request
            ended = True
        finally:
            with contextlib.suppress(OSError):
                proc.stdin.close()  # Claude Code exits when its input ends
            _stop(proc)
            reader.join(timeout=2)  # its output ends with it
            if not reader.is_alive():
                with contextlib.suppress(OSError):
                    proc.stdout.close()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    if answer is None:
        return {"at": now, "error": "no_answer" if ended else "timeout"}
    if answer.get("subtype") != "success":
        detail = str(answer.get("error") or "")[:200]
        kind = "unsupported" if re.search(r"unsupported|not supported|unknown", detail, re.I) else "cli_error"
        return {"at": now, "error": kind, "detail": detail}
    body = answer.get("response") if isinstance(answer.get("response"), dict) else {}
    plan = body.get("subscription_type")
    plan = plan if isinstance(plan, str) and re.match(r"^[a-z0-9_]{1,24}$", plan) else None
    windows = live_windows(body.get("rate_limits"))
    if windows:
        # A login Claude Code holds but can't use answers with its own copy of its last check (up
        # to an hour old): those numbers are as old as that copy, not "just now".
        cached = (code_saved_usage(_read_json(claude_global_config())) or {}).get("reading")
        at = cached["at"] if cached and cached["windows"] == windows and cached["at"] < now - 60 else now
        return {"at": at, "plan": plan, "windows": windows}
    if not body.get("rate_limits_available"):
        return {"at": now, "error": "no_plan", "plan": plan}  # logged out, or an API key: no plan limits
    if os.environ.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"):
        return {"at": now, "error": "essential_only", "plan": plan}
    return {"at": now, "error": "unavailable", "plan": plan}


ASKERS = {"claude": "claude_usage_ask", "copilot": "copilot_usage_ask",
          "chatgpt": "codex_usage_ask", "google": "agy_usage_ask"}


def usage_live(tool="claude"):
    """A tool's live reading, asking its command-line app at most once a
    minute however often the app asks; one run at a time per tool, and
    requests in between share its answer."""
    slot = _LIVE[tool]
    with _LIVE_LOCKS[tool]:
        if slot["reading"] is None or time.monotonic() - slot["ran"] >= USAGE_LIVE_GAP_S:
            slot["reading"] = globals()[ASKERS[tool]]()
            slot["ran"] = time.monotonic()
        return slot["reading"]


# ---- The other tools' usage: Copilot, Codex, Antigravity, Cursor ----------
#
# Each tool's own app does the asking, with its own login — Throwbacks never
# reads a sign-in, sends no message to a model and passes nothing from your
# chats. Copilot CLI and Codex run as short-lived JSON-RPC servers on their
# stdin/stdout; agy prints its /usage panel. Codex also leaves its numbers in
# its session files, read here with no network at all. Cursor shares no usage
# with other apps (every way to it means using Cursor's session token, which
# its terms forbid), so only its plan name is read, from one exact key.

COPILOT_PATHS = ("~/.nvm/versions/node/*/bin/copilot", "~/.local/bin/copilot",
                 "/opt/homebrew/bin/copilot", "/usr/local/bin/copilot")
CODEX_PATHS = ("~/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
               "~/.nvm/versions/node/*/bin/codex", "/Applications/Codex.app/Contents/Resources/codex",
               "/Applications/ChatGPT.app/Contents/Resources/codex")
AGY_PATHS = ("~/.local/bin/agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy")
AGY_MIN_VERSION = (1, 1, 11)  # older agy sends "/usage" to the model as a prompt — that would spend quota
AGY_TIMEOUT_S = 45
_AGY_REFUSED = {"why": None}  # set if agy ever answers through the model: never ask it again until a restart
LIMIT_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
RPC_MAX_BYTES = 4 * 1024 * 1024
CODEX_TAIL_BYTES = 4 * 1024 * 1024
CODEX_FILES = 8
_CODEX_CACHE = {}  # rollout path -> (mtime, size, {limit id: (time, snapshot)})
CURSOR_PLAN_KEY = "cursorAuth/stripeMembershipType"
CURSOR_EMAIL_KEY = "cursorAuth/cachedEmail"  # only its length is read


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def find_bin(configured, *places):
    """A tool's command: the configured name (on PATH) or path, else the
    first of the usual install places that exists."""
    found = shutil.which(os.path.expanduser(configured))
    if found:
        return found
    for pattern in places:
        for path in sorted(glob.glob(os.path.expanduser(pattern)), reverse=True):
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
    return None


def _tool_env(cli):
    """The environment for a tool's own app: yours, with its folder first on
    PATH (an nvm-installed CLI needs the node next to it) and without Node's
    debug switches, which would write into the JSON-RPC channel."""
    env = {k: v for k, v in os.environ.items() if k not in ("NODE_OPTIONS", "NODE_DEBUG")}
    env["PATH"] = os.path.dirname(cli) + os.pathsep + env.get("PATH", "")
    return env


def _stop(proc, wait=10):
    """End a tool's run: `wait` seconds after its input closed, then kill its
    whole process group — an npm or nvm launcher runs the real CLI as a child
    that shares our pipes, and killing only the launcher would leave it
    running. Every tool is started in its own session, so the group is
    just that run; anything of it still around afterwards goes too."""
    try:
        proc.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        pass
    with contextlib.suppress(OSError):
        os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)


def _run_tool(cmd, timeout, cwd=None, env=None):
    """Run a tool's app to the end: (exit code, stdout, stderr), or
    TimeoutError — after killing its whole process group (see _stop)."""
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop(proc, wait=0)
        with contextlib.suppress(subprocess.TimeoutExpired, OSError, ValueError):
            proc.communicate(timeout=5)
        raise TimeoutError from None
    _stop(proc, wait=0)
    return proc.returncode, out or b"", err or b""


class RpcError(Exception):
    def __init__(self, err):
        err = err if isinstance(err, dict) else {"message": str(err)}
        self.code = err.get("code") if isinstance(err.get("code"), int) else None
        self.message = str(err.get("message") or "")[:300]
        super().__init__(self.message)


class ToolRpc:
    """A tool's command-line app as a short-lived JSON-RPC server on its
    stdin/stdout. Framing "lsp": Content-Length headers (Copilot CLI);
    "lines": one JSON object per line (Codex's app-server). Messages it sends
    that aren't answers to ours (notifications, its own requests) are
    ignored. It ends when its input does."""

    def __init__(self, cmd, framing, cwd, env):
        self.framing = framing
        self.proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
        self.msgs = queue.Queue()
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()

    def _pump(self):
        out = self.proc.stdout
        try:
            if self.framing == "lines":
                total = 0
                for line in out:
                    total += len(line)
                    if total > RPC_MAX_BYTES:
                        break
                    with contextlib.suppress(ValueError):
                        self.msgs.put(json.loads(line))
            else:
                buf = b""
                while len(buf) <= RPC_MAX_BYTES:
                    chunk = out.read1(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        head, sep, rest = buf.partition(b"\r\n\r\n")
                        if not sep:
                            break
                        m = re.search(rb"(?im)^content-length:\s*(\d+)\s*$", head)
                        if not m:
                            buf = rest  # not a header block: skip it
                            continue
                        size = int(m.group(1))
                        if len(rest) < size:
                            break
                        body, buf = rest[:size], rest[size:]
                        with contextlib.suppress(ValueError):
                            self.msgs.put(json.loads(body))
        except (OSError, ValueError):
            pass
        self.msgs.put(None)

    def send(self, msg):
        data = json.dumps(msg).encode()
        frame = data + b"\n" if self.framing == "lines" else b"Content-Length: %d\r\n\r\n" % len(data) + data
        self.proc.stdin.write(frame)
        self.proc.stdin.flush()

    def request(self, rid, method, params, deadline):
        """Its answer to one request; RpcError for an error answer,
        TimeoutError, or EOFError when it ends without answering."""
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        while True:
            try:
                m = self.msgs.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError from None
            if m is None:
                raise EOFError
            if isinstance(m, dict) and m.get("id") == rid and "method" not in m:
                if m.get("error") is not None:
                    raise RpcError(m["error"])
                return m.get("result")

    def close(self):
        with contextlib.suppress(OSError):
            self.proc.stdin.close()
        _stop(self.proc)
        self.reader.join(timeout=2)
        if not self.reader.is_alive():  # closing it under a blocked read would wait on that read
            with contextlib.suppress(OSError):
                self.proc.stdout.close()


def _next_month_utc(now):
    t = datetime.fromtimestamp(now, timezone.utc)
    year, month = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
    return int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp())


# Copilot: the CLI's quota snapshots, keyed by type.
COPILOT_SNAPSHOTS = (("premium_interactions", "premium"), ("chat", "chat"), ("completions", "completions"))


def copilot_windows(quota, now):
    """Copilot's monthly allowances from account.getQuota: {"windows", "pooled",
    "unlimited"}. An allowance of 0 that isn't unlimited means the
    organisation pools its AI credits — GitHub gives no per-person number. The
    CLI's resetDate is the time it fetched, so the reset is the documented
    one: 00:00 UTC on the 1st."""
    snaps = quota.get("quotaSnapshots") if isinstance(quota, dict) else None
    snaps = snaps if isinstance(snaps, dict) else {}
    windows, pooled, unlimited = [], False, []
    for key, kind in COPILOT_SNAPSHOTS:
        s = snaps.get(key)
        if not isinstance(s, dict):
            continue
        limit, left, used = (_num(s.get(k)) for k in ("entitlementRequests", "remainingPercentage", "usedRequests"))
        if s.get("isUnlimitedEntitlement") is True or limit == -1:
            unlimited.append(kind)
            continue
        if not limit or limit < 0:
            pooled = pooled or kind == "premium"
            continue
        pct = 100 - left if left is not None else (used / limit * 100 if used is not None else None)
        if pct is None:
            continue
        w = {"kind": kind, "pct": round(max(0.0, min(100.0, float(pct))), 2),
             "resets_at": _next_month_utc(now), "limit": round(float(limit), 2)}
        if used is not None:
            w["used"] = round(float(used), 2)
        if isinstance(s.get("tokenBasedBilling"), bool):
            w["unit"] = "credits" if s["tokenBasedBilling"] else "requests"
        if _num(s.get("overage")):
            w["overage"] = round(float(s["overage"]), 2)
        windows.append(w)
    return {"windows": windows, "pooled": pooled, "unlimited": unlimited}


def _copilot_problem(e):
    text = e.message
    if re.search(r"not authenticated|no authentication|authenticate|\b401\b|bad credentials", text, re.I):
        return {"error": "no_login", "detail": text[:200]}
    if re.search(r"\b403\b|forbidden", text, re.I):  # logged in, but the account has no Copilot (a seat removed)
        return {"error": "no_access", "detail": text[:200]}
    if e.code == -32601 or re.search(r"method not found|unknown method|not implemented", text, re.I):
        return {"error": "unsupported", "detail": text[:200]}
    return {"error": "cli_error", "detail": text[:200]}


def copilot_usage_ask(timeout=USAGE_LIVE_TIMEOUT_S):
    """Ask Copilot CLI for your quota (its experimental account.getQuota,
    over its hidden headless JSON-RPC server): {"at", "windows", "pooled",
    "unlimited"}, or {"at", "error"}.

    The CLI fetches GitHub's numbers itself with its own stored login; no
    message goes to a model (no premium request is used). It runs in an empty
    temp folder with its log there too (not in ~/.copilot/logs), no update
    check, and is closed straight after. It does send GitHub its own startup
    telemetry event, which this version can't turn off."""
    now = int(time.time())
    cli = find_bin(COPILOT_BIN, *COPILOT_PATHS)
    if not cli:
        return {"at": now, "error": "no_cli"}
    workdir = tempfile.mkdtemp(prefix="throwbacks-copilot-")
    cmd = [cli, "--headless", "--stdio", "--no-auto-update", "--log-level", "error",
           "--log-dir", os.path.join(workdir, "logs")]
    deadline = time.monotonic() + timeout
    rpc = None
    try:
        try:
            rpc = ToolRpc(cmd, "lsp", cwd=workdir, env=_tool_env(cli))
        except OSError:
            return {"at": now, "error": "no_cli"}
        try:
            pong = rpc.request(1, "ping", {"message": "throwbacks"}, deadline)
            version = pong.get("protocolVersion") if isinstance(pong, dict) else None
            if not isinstance(version, int) or not 2 <= version <= 3:
                return {"at": now, "error": "unsupported", "detail": f"protocol version {version}"}
            quota = rpc.request(2, "account.getQuota", {}, deadline)
        except RpcError as e:
            return {"at": now, **_copilot_problem(e)}
        except TimeoutError:
            return {"at": now, "error": "timeout"}
        except (EOFError, OSError):
            return {"at": now, "error": "no_answer"}
    finally:
        if rpc:
            rpc.close()
        shutil.rmtree(workdir, ignore_errors=True)
    return {"at": now, **copilot_windows(quota, now)}


# Codex: rate-limit snapshots, from its session files or its app-server.

def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def codex_rollouts(limit=CODEX_FILES):
    """The rollout files Codex wrote to last, newest first:
    sessions/YYYY/MM/DD/rollout-*.jsonl — by when each file last changed,
    since a resumed session keeps writing to its first day's folder — and
    archived_sessions/. Compressed (.jsonl.zst) ones are cold and skipped."""
    home = codex_home()
    files = glob.glob(os.path.join(home, "sessions", "[0-9]*", "[0-9]*", "[0-9]*", "rollout-*.jsonl"))
    files += glob.glob(os.path.join(home, "archived_sessions", "rollout-*.jsonl"))

    def mtime(p):
        try:
            return os.path.getmtime(p)
        except OSError:
            return 0
    return sorted(files, key=mtime, reverse=True)[:limit]


def _codex_file_snapshots(path):
    """The newest rate-limit snapshot per limit id in one rollout file (its
    last few MB, read from the end): {limit id: (time, rate_limits)}."""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    hit = _CODEX_CACHE.get(path)
    if hit and hit[:2] == (st.st_mtime, st.st_size):
        return hit[2]
    found = {}
    try:
        with open(path, "rb") as f:
            start = max(0, st.st_size - CODEX_TAIL_BYTES)
            f.seek(start)
            lines = f.read().split(b"\n")
    except OSError:
        return {}
    for line in reversed(lines[1:] if start else lines):
        if b'"token_count"' not in line or b'"rate_limits"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        payload = row.get("payload") if isinstance(row, dict) else None
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        limits = payload.get("rate_limits")
        ts = _epoch(row.get("timestamp"))
        if not isinstance(limits, dict) or ts is None:
            continue
        lid = limits.get("limit_id") or "codex"
        if isinstance(lid, str) and LIMIT_ID.match(lid) and lid not in found:
            found[lid] = (ts, limits)
    _CODEX_CACHE[path] = (st.st_mtime, st.st_size, found)
    return found


def _codex_windows(limits, ts, name=None):
    """One snapshot's windows. A window is the 5-hour session or the week by
    its length (window_minutes 300 / 10080), never by primary/secondary: a
    plan with no 5-hour limit sends its week as primary. Every shape Codex
    has written: flat (≈0.40), resets_in_seconds (≈0.45), resets_at (≈0.50+),
    and the app-server's camelCase."""
    if not isinstance(limits, dict):
        return []
    parts = []
    if "primary_used_percent" in limits or "secondary_used_percent" in limits:  # ≈0.40, flat
        for p in ("primary", "secondary"):
            parts.append((p, limits.get(f"{p}_used_percent"), limits.get(f"{p}_window_minutes"), None))
    else:
        for p in ("primary", "secondary"):
            w = limits.get(p)
            if not isinstance(w, dict):
                continue
            reset = _epoch(w.get("resets_at", w.get("resetsAt")))
            rel = _num(w.get("resets_in_seconds"))
            if reset is None and rel is not None and ts:
                reset = int(ts + rel)
            parts.append((p, w.get("used_percent", w.get("usedPercent")),
                          w.get("window_minutes", w.get("windowDurationMins")), reset))
    out = []
    for part, pct, minutes, reset in parts:
        pct, minutes = _pct(pct), _num(minutes)
        if pct is None:
            continue
        weekly = minutes > 24 * 60 if minutes is not None else part == "secondary"
        kind = ("weekly" if weekly else "session") + ("_scoped" if name else "_all" if weekly else "")
        w = {"kind": kind, "group": "weekly" if weekly else "session", "pct": pct, "resets_at": reset}
        if name:
            w["name"] = name
        out.append(w)
    return out


def _codex_reading(snaps):
    """{limit id: (time, snapshot)} → {"at", "plan", "windows"}: the main
    "codex" limit first, then per-model pools (e.g. a Spark model) by name."""
    windows, at, plan = [], None, None
    main = snaps.get("codex")
    if main:
        at, windows = main[0], _codex_windows(main[1], main[0])
        plan = main[1].get("plan_type", main[1].get("planType"))
    for lid, (ts, limits) in sorted(snaps.items()):
        if lid == "codex":
            continue
        name = _name(limits.get("limit_name", limits.get("limitName"))) or lid.replace("_", " ")
        windows += _codex_windows(limits, ts, name)
        at = at if main else max(at or 0, ts)
    if not windows:
        return None
    plan = plan if isinstance(plan, str) and re.match(r"^[a-z0-9_]{1,40}$", plan) else None
    return {"at": at, "plan": plan, "windows": windows}


def codex_usage_local():
    """Codex's numbers as of its last reply anywhere on this Mac, from its own
    session files — no process, no network. None without any."""
    snaps = {}
    for path in codex_rollouts():
        for lid, (ts, limits) in _codex_file_snapshots(path).items():
            if lid not in snaps or ts > snaps[lid][0]:
                snaps[lid] = (ts, limits)
    return _codex_reading(snaps) if snaps else None


def _codex_problem(e):
    text = e.message
    if e.code == -32601 or re.search(r"method not found|unknown (variant|method)|not supported", text, re.I):
        return {"error": "unsupported", "detail": text[:200]}
    if re.search(r"auth|log ?in|unauthori[sz]ed|\b401\b|api key", text, re.I):
        return {"error": "no_plan", "detail": text[:200]}
    return {"error": "cli_error", "detail": text[:200]}


def codex_usage_ask(timeout=USAGE_LIVE_TIMEOUT_S):
    """Ask Codex's app-server for your plan's limits (initialize, initialized,
    account/rateLimits/read): {"at", "plan", "windows"}, or {"at", "error"}.
    Codex fetches them from ChatGPT with its own login; no model request is
    made. While it runs, Codex may update its own state (its login, its
    database) like any start of Codex — so this is off until you turn it on."""
    now = int(time.time())
    cli = find_bin(CODEX_BIN, *CODEX_PATHS)
    if not cli:
        return {"at": now, "error": "no_cli"}
    workdir = tempfile.mkdtemp(prefix="throwbacks-codex-")
    deadline = time.monotonic() + timeout
    rpc = None
    try:
        try:
            rpc = ToolRpc([cli, "app-server"], "lines", cwd=workdir, env=_tool_env(cli))
        except OSError:
            return {"at": now, "error": "no_cli"}
        try:
            rpc.request(0, "initialize", {"clientInfo": {"name": "throwbacks", "title": "Throwbacks", "version": "1"},
                                          "capabilities": {"experimentalApi": False}}, deadline)
            rpc.send({"method": "initialized", "params": {}})
            res = rpc.request(1, "account/rateLimits/read", None, deadline)
        except RpcError as e:
            return {"at": now, **_codex_problem(e)}
        except TimeoutError:
            return {"at": now, "error": "timeout"}
        except (EOFError, OSError):
            return {"at": now, "error": "no_answer"}
    finally:
        if rpc:
            rpc.close()
        shutil.rmtree(workdir, ignore_errors=True)
    res = res if isinstance(res, dict) else {}
    snaps = {}
    by_id = res.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and by_id:
        snaps = {lid: (now, v) for lid, v in by_id.items()
                 if isinstance(lid, str) and LIMIT_ID.match(lid) and isinstance(v, dict)}
    elif isinstance(res.get("rateLimits"), dict):
        lid = res["rateLimits"].get("limitId") or "codex"
        snaps = {lid if isinstance(lid, str) and LIMIT_ID.match(lid) else "codex": (now, res["rateLimits"])}
    reading = _codex_reading(snaps) if snaps else None
    if not reading:
        return {"at": now, "error": "no_plan"}  # an API-key login has no plan windows
    return {**reading, "at": now}


# Antigravity: Google's agy CLI, printing its /usage panel.

def _agy_group(group):
    low = group.lower()
    if "gemini" in low:
        return "Gemini"
    if "claude" in low or "gpt" in low:
        return "Claude & GPT"
    return _name(re.sub(r"\s*models?\s*$", "", group, flags=re.I))


def agy_windows(text):
    """agy's /usage rows — "<group>\\t<window>\\t<NN% remaining>\\t<reset, ISO
    UTC>" — as windows: each model group (Gemini; Claude & GPT) has a 5-hour
    and a weekly limit. The percent is what's LEFT."""
    out = []
    for line in (text.splitlines()[:60] if isinstance(text, str) else []):
        cols = [c.strip() for c in line.split("\t")]
        if len(cols) < 4:
            continue
        group, label, left, reset = cols[:4]
        m = re.match(r"^(\d+(?:\.\d+)?)\s*%$", left)
        name = _agy_group(group)
        low = label.lower()
        weekly = "week" in low
        if not m or not name or not (weekly or re.search(r"5\s*-?\s*h|hour|session", low)):
            continue
        out.append({"kind": "weekly_scoped" if weekly else "session_scoped", "group": "weekly" if weekly else "session",
                    "name": name, "pct": _pct(max(0.0, 100 - float(m.group(1)))), "resets_at": _epoch(reset)})
    return out


def agy_usage_ask(timeout=AGY_TIMEOUT_S):
    """Ask Google's agy CLI for your Antigravity quota (`agy -p /usage`, whose
    print mode writes one tab-separated row per limit): {"at", "windows"}, or
    {"at", "error"}. agy answers that slash command itself, from Google with
    its own login — from 1.1.11 on; older versions send it to the model as a
    prompt, so they are never asked. If agy ever exits normally with
    something other than usage rows (the model answering, or a format this
    can't read), it isn't asked again until the server restarts."""
    now = int(time.time())
    if _AGY_REFUSED["why"]:
        return {"at": now, "error": "not_local"}
    cli = find_bin(AGY_BIN, *AGY_PATHS)
    if not cli:
        return {"at": now, "error": "no_cli"}
    env = _tool_env(cli)
    try:
        _, out, _ = _run_tool([cli, "--version"], 15, env=env)
    except TimeoutError:
        return {"at": now, "error": "timeout"}
    except OSError:
        return {"at": now, "error": "no_cli"}
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", out.decode(errors="replace"))
    if not m or tuple(int(x) for x in m.groups()) < AGY_MIN_VERSION:
        return {"at": now, "error": "unsupported", "detail": f"agy {m.group(0) if m else 'version unknown'}"}
    workdir = tempfile.mkdtemp(prefix="throwbacks-agy-")
    try:
        code, out, err = _run_tool([cli, "-p", "/usage"], timeout, cwd=workdir, env=env)
    except TimeoutError:
        return {"at": now, "error": "timeout"}
    except OSError:
        return {"at": now, "error": "no_cli"}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    text = out[:1024 * 1024].decode(errors="replace")
    if code != 0:  # not signed in, a crash, no network: an ordinary failure, asked again later
        return {"at": now, "error": "cli_error", "detail": (err.decode(errors="replace").strip() or text.strip())[:200]}
    if not text.strip():
        return {"at": now, "error": "no_answer"}
    windows = agy_windows(text)
    if not windows:
        _AGY_REFUSED["why"] = "no usage rows"
        return {"at": now, "error": "not_local"}
    return {"at": now, "windows": windows}


# Cursor: its plan name only.

def cursor_plan_local():
    """Cursor's plan as Cursor last cached it — one key read by its exact
    name, so its sign-in rows are never read. Signing out writes "free", so
    whether Cursor is signed in is told by the LENGTH of its cached email
    (cleared on sign-out) — only the length comes out of the database, never
    the email. {"plan", "signedOut", "seenAt"}; None without Cursor."""
    path = os.path.join(app_user_dir("Cursor"), "globalStorage", "state.vscdb")
    if not os.path.isfile(path):
        return None
    plan, signed_out = None, False
    try:
        con = sqlite3.connect("file:" + quote(os.path.abspath(path)) + "?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute("SELECT value FROM ItemTable WHERE key = ?", (CURSOR_PLAN_KEY,)).fetchone()
            email_len = con.execute("SELECT length(value) FROM ItemTable WHERE key = ?", (CURSOR_EMAIL_KEY,)).fetchone()
        finally:
            con.close()
        value = row[0] if row else None
        value = (value.decode(errors="replace") if isinstance(value, bytes) else str(value or "")).strip().strip('"').lower()
        plan = value if re.match(r"^[a-z_]{1,24}$", value) else None
        signed_out = not (email_len and email_len[0])
        if signed_out:
            plan = None
    except sqlite3.Error:
        pass
    try:
        seen = int(os.path.getmtime(path))
    except OSError:
        seen = None
    return {"plan": plan, "signedOut": signed_out, "seenAt": seen}


def other_plans_status():
    """What /api/usage says about the tools beyond Claude: whether each is on
    this Mac ("found"; "cli" when its command is), whether Throwbacks may ask
    it ("enabled": with --claude and its command found), and the readings it
    has. Nothing here runs a tool."""
    copilot = find_bin(COPILOT_BIN, *COPILOT_PATHS)
    codex = find_bin(CODEX_BIN, *CODEX_PATHS)
    agy = find_bin(AGY_BIN, *AGY_PATHS)
    cursor = cursor_plan_local()
    return {
        "copilot": {"found": bool(copilot), "cli": bool(copilot), "enabled": CLAUDE and bool(copilot),
                    "reading": _LIVE["copilot"]["reading"]},
        "chatgpt": {"found": bool(codex) or os.path.isdir(os.path.join(codex_home(), "sessions")), "cli": bool(codex),
                    "enabled": CLAUDE and bool(codex), "reading": _LIVE["chatgpt"]["reading"], "local": codex_usage_local()},
        "google": {"found": bool(agy), "cli": bool(agy), "enabled": CLAUDE and bool(agy), "reading": _LIVE["google"]["reading"]},
        "cursor": {"found": cursor is not None, **(cursor or {"plan": None, "signedOut": False, "seenAt": None})},
    }


_ASK = {}
_ASK_LOCK = threading.Lock()


def usage_asks():
    """Which tools may be asked: your choices from Settings, else the defaults."""
    with _ASK_LOCK:
        if not _ASK:
            _ASK.update(ASK_DEFAULTS)
            if STORE:
                with contextlib.suppress(OSError, ValueError, AttributeError):
                    with open(USAGE_ASK_FILE) as f:
                        raw = json.load(f)
                    _ASK.update({k: raw[k] for k in ASK_DEFAULTS if isinstance(raw.get(k), bool)})
        return dict(_ASK)


def set_usage_ask(tool, on):
    """Turn asking a tool on or off. Off also forgets its last live answer,
    so nothing of it is shown as if still current. Saved (0600, written whole
    and renamed into place) unless --no-store."""
    usage_asks()
    with _ASK_LOCK:
        _ASK[tool] = bool(on)
        choices = dict(_ASK)
    if not on:
        with _LIVE_LOCKS[tool]:
            _LIVE[tool].update(reading=None, ran=0.0)
    if STORE:
        folder = os.path.dirname(USAGE_ASK_FILE)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".usage-ask-", suffix=".tmp", dir=folder)  # created 0600
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(choices, f)
            os.replace(tmp, USAGE_ASK_FILE)
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(tmp)
            raise


_MARKS_LOCK = threading.Lock()


def _mark_id(v):
    """A chat's ID as the app names it ("code:<uuid>.jsonl", "cursor:<id>"…): only ever a key here."""
    return isinstance(v, str) and 0 < len(v) <= 400 and not re.search(r"[\x00-\x1f\x7f]", v)


def _mark_time(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and 0 <= v < 1e15


def marks_of(raw):
    """Saved marks, checked (as plans.js marksOf): {"pinned": {id: ms}, "archived": {id: {"at", "last", "pin"?}}}
    ("pin": when it was pinned, so Restore pins it again)."""
    out = {"pinned": {}, "archived": {}}
    if not isinstance(raw, dict):
        return out
    pinned = raw.get("pinned") if isinstance(raw.get("pinned"), dict) else {}
    archived = raw.get("archived") if isinstance(raw.get("archived"), dict) else {}
    for k, at in pinned.items():
        if _mark_id(k) and _mark_time(at):
            out["pinned"][k] = at
    for k, a in archived.items():
        if _mark_id(k) and isinstance(a, dict) and _mark_time(a.get("at")) and _mark_time(a.get("last")) \
                and k not in out["pinned"]:
            out["archived"][k] = {"at": a["at"], "last": a["last"], **({"pin": a["pin"]} if _mark_time(a.get("pin")) else {})}
    return out


def read_marks(strict=False):
    """The saved marks; none when there's no file. `strict`: raise if the file is there
    but can't be read (damaged, not UTF-8, not ours to read) instead of answering none."""
    try:
        with open(MARKS_FILE, encoding="utf-8") as f:
            return marks_of(json.load(f))
    except FileNotFoundError:
        return marks_of(None)
    except (OSError, ValueError):
        if strict:
            raise
        return marks_of(None)


def apply_mark(marks, op, now):
    """One change, as plans.js applyMark: {id, pin: bool} or {id, archive: {last} | None}.
    Pinning restores an archived chat; archiving unpins it, and Restore pins it again if it
    was pinned. None for a bad change."""
    if not isinstance(op, dict) or not _mark_id(op.get("id")):
        return None
    m = marks_of(marks)
    cid = op["id"]
    if isinstance(op.get("pin"), bool):
        m["pinned"].pop(cid, None)
        if op["pin"]:
            m["pinned"][cid] = now
            m["archived"].pop(cid, None)
    elif "archive" in op and op["archive"] is None:
        was = m["archived"].pop(cid, None)
        if was and "pin" in was:
            m["pinned"][cid] = was["pin"]
    elif isinstance(op.get("archive"), dict) and _mark_time(op["archive"].get("last")):
        pin = m["pinned"].pop(cid, None)
        m["archived"][cid] = {"at": now, "last": op["archive"]["last"], **({"pin": pin} if pin is not None else {})}
    else:
        return None

    def newest(d, at):
        return dict(sorted(d.items(), key=lambda kv: at(kv[1]))[-MARKS_MAX:])
    return {"pinned": newest(m["pinned"], lambda v: v), "archived": newest(m["archived"], lambda v: v["at"])}


def change_mark(op):
    """Apply one change to ~/.throwbacks/marks.json under a lock (two tabs never lose each
    other's), written whole to a private temp file and renamed into place. Returns every mark."""
    with _MARKS_LOCK:
        try:
            cur = read_marks(strict=True)
        except (OSError, ValueError):
            # Damaged (a hand edit?) or unreadable: set it aside, never write over what couldn't be read.
            os.replace(MARKS_FILE, f"{MARKS_FILE}.damaged-{int(time.time() * 1000)}")
            cur = marks_of(None)
        nxt = apply_mark(cur, op, int(time.time() * 1000))
        if nxt is None:
            raise ValueError("id and pin (true/false), or id and archive ({last} or null), required")
        folder = os.path.dirname(MARKS_FILE)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".marks-", suffix=".tmp", dir=folder)  # created 0600
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(nxt, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, MARKS_FILE)
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(tmp)
            raise
        return nxt


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def send_head(self):
        # Map / -> throwbacks.html (a query string or fragment is kept)
        bare = self.path.split("?", 1)[0].split("#", 1)[0]
        if bare in ("/", ""):
            self.path = "/throwbacks.html" + self.path[len(bare):]

        # Path-traversal safety: reject any '..' segment outright (before
        # any normalization can hide it)…
        raw = self.path.split("?", 1)[0].split("#", 1)[0]
        if ".." in unquote(raw).split("/"):
            self.send_error(403, "Forbidden")
            return None

        # …and require the resolved target to stay inside ROOT.
        # (translate_path also normalizes; this is belt-and-braces.)
        resolved = os.path.realpath(self.translate_path(self.path))
        if resolved != ROOT and not resolved.startswith(ROOT + os.sep):
            self.send_error(403, "Forbidden")
            return None

        # Directory listing OFF.
        if os.path.isdir(resolved):
            self.send_error(403, "Directory listing disabled")
            return None

        return super().send_head()

    def end_headers(self):
        # Always revalidate: edits to the app files show up on plain reload.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write("  %s\n" % (fmt % args))

    # ---- /api/*: local bridges (Claude, summary store, IDE import) --------

    def _is_loopback(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _api_ok(self):
        """Every /api/* request must come from THIS machine's browser on THIS
        origin: a loopback client; a local Host header (defeats DNS
        rebinding, where a hostile domain re-points itself at 127.0.0.1);
        an exactly-matching Origin and same-origin fetch metadata when the
        browser sends them; and our custom header, which no <img>/<form>
        can send and which forces a CORS preflight — never granted — on any
        cross-origin caller."""
        if not self._is_loopback():
            return False
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if self.headers.get("Host") not in hosts:
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {f"http://{h}" for h in hosts}:
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            return False
        return self.headers.get("X-Throwbacks") == "1"

    def _send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_png(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        route = self.path.split("?")[0]
        if not route.startswith("/api/"):
            super().do_GET()
            return
        if not self._api_ok():
            self._send_json(403, {"enabled": False, "error": "Local-only API."})
            return
        if route.startswith("/api/import/"):
            if not IMPORT:
                self._send_json(404, {"enabled": False, "error": "Import disabled (--no-import)."})
                return
            try:
                if route == "/api/import/status":
                    self._send_json(200, import_status())
                elif route == "/api/import/claude-code":
                    self._send_json(200, collect_claude_code())
                elif route == "/api/import/copilot":
                    self._send_json(200, collect_copilot())
                elif route == "/api/import/cursor":
                    self._send_json(200, collect_cursor())
                elif route == "/api/import/copilot-cli":
                    self._send_json(200, collect_copilot_cli())
                elif route == "/api/import/cowork":
                    self._send_json(200, collect_cowork())
                else:
                    self._send_json(404, {"error": "Unknown import source"})
            except (OSError, sqlite3.Error, ValueError) as e:
                self._send_json(500, {"error": f"Import failed: {e}"[:300]})
            return
        if route == "/api/resume":
            if not IMPORT:
                self._send_json(404, {"enabled": False, "error": "Reading apps is off (--no-import)."})
                return
            q = parse_qs(urlparse(self.path).query)
            app_id, sid = (q.get("app") or [""])[0], (q.get("id") or [""])[0]
            if app_id not in ("claude", "copilot") or not RESUME_ID.fullmatch(sid):  # fullmatch: "$" alone lets a trailing newline through
                self._send_json(400, {"error": "app (claude|copilot) and a session id (a UUID) are required"})
                return
            self._send_json(200, resume_info(app_id, sid))
            return
        if route == "/api/source":
            if not IMPORT:
                self._send_json(404, {"enabled": False, "error": "Reading apps is off (--no-import)."})
                return
            q = parse_qs(urlparse(self.path).query)
            app_id, sid = (q.get("app") or [""])[0], (q.get("id") or [""])[0]
            if app_id not in SOURCE_APPS or not SOURCE_ID.fullmatch(sid):
                self._send_json(400, {"error": f"app ({'|'.join(SOURCE_APPS)}) and a chat's id are required"})
                return
            self._send_json(200, {**source_info(app_id, sid), "reveal": can_reveal()})
            return
        if route == "/api/keep":
            if not IMPORT:
                self._send_json(404, {"enabled": False, "error": "Reading your history is off (--no-import)."})
                return
            self._send_json(200, {**keep_status(), "enabled": STORE})
            return
        if route == "/api/app-icon":
            app_id = (parse_qs(urlparse(self.path).query).get("app") or [""])[0]
            png = app_icon(app_id) if app_id in ICON_IDS else None
            if png:
                self._send_png(png)
            else:
                self._send_json(404, {"error": "No icon for that app on this machine."})
            return
        if route == "/api/summaries":
            if not STORE:
                self._send_json(404, {"enabled": False})
                return
            entries = []
            try:
                if os.path.isdir(STORE_DIR):
                    for name in os.listdir(STORE_DIR):
                        if not name.endswith(".json"):
                            continue
                        try:
                            with open(os.path.join(STORE_DIR, name)) as f:
                                e = json.load(f)
                            if isinstance(e, dict):
                                entries.append(e)
                        except (OSError, json.JSONDecodeError):
                            pass
            except OSError:
                pass
            entries.sort(key=lambda e: e.get("at", 0), reverse=True)
            self._send_json(200, {"entries": entries[:200], "dir": STORE_DIR})
            return
        if route == "/api/log-summaries":
            if not STORE:
                self._send_json(404, {"enabled": False})
                return
            self._send_json(200, {**read_log_summaries(), "dir": os.path.dirname(STORE_DIR)})
            return
        if route == "/api/marks":
            if not STORE:
                self._send_json(404, {"enabled": False})
                return
            self._send_json(200, read_marks())
            return
        if route == "/api/usage":
            apps = (parse_qs(urlparse(self.path).query).get("apps") or ["1"])[0] != "0"
            self._send_json(200, usage_status(read_apps=apps))
            return
        if route == "/api/claude-status":
            if not CLAUDE:
                self._send_json(200, {"enabled": False})
                return
            found = shutil.which(CLAUDE_BIN)
            self._send_json(200, {
                "enabled": bool(found),
                "bin": found or CLAUDE_BIN,
                "model": CLAUDE_MODEL,
            })
            return
        self._send_json(404, {"error": "Unknown API route"})

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return None

    def _log_target(self, kind, key):
        """(kind, key) when both are valid, else None — each kind's key is
        its own kind of date (log_key_ok), never a path."""
        kind, key = str(kind or ""), str(key or "")
        return (kind, key) if kind in LOG_DIRS and log_key_ok(kind, key) else None

    def do_DELETE(self):
        path, _, query = self.path.partition("?")
        if path == "/api/keep" and self._api_ok():
            sid = (parse_qs(query).get("id") or [""])[0]
            if not STORE or not KEEP_ID.fullmatch(sid):
                self._send_json(400, {"error": "id (a Claude Code session ID) is required"})
                return
            try:
                remove_copy(sid)
            except OSError as e:
                self._send_json(500, {"error": str(e)[:200]})
                return
            self._send_json(200, {"ok": True})
            return
        if path == "/api/log-summaries" and STORE and self._api_ok():
            q = parse_qs(query)
            target = self._log_target((q.get("kind") or [""])[0], (q.get("key") or [""])[0])
            if not target:
                self._send_json(400, {"error": f"{LOG_KEY_HELP} required"})
                return
            try:
                delete_log_summary(*target)
            except OSError as e:
                self._send_json(500, {"error": str(e)[:200]})
                return
            self._send_json(200, {"ok": True})
            return
        if path != "/api/summaries" or not STORE or not self._api_ok():
            self.send_error(404)
            return
        q = parse_qs(query)
        try:
            if q.get("all"):
                if os.path.isdir(STORE_DIR):
                    for name in os.listdir(STORE_DIR):
                        if name.endswith((".json", ".md")):
                            os.remove(os.path.join(STORE_DIR, name))
                self._send_json(200, {"ok": True})
                return
            sid = SAFE_ID.sub("", (q.get("id") or [""])[0]).lstrip(".")[:80]
            if not sid:
                self._send_json(400, {"error": "id required"})
                return
            for ext in (".json", ".md"):
                p = os.path.join(STORE_DIR, sid + ext)
                if os.path.isfile(p):
                    os.remove(p)
            self._send_json(200, {"ok": True})
        except OSError as e:
            self._send_json(500, {"error": str(e)[:200]})

    def _post_summary(self):
        if not STORE:
            self._send_json(403, {"error": "Summary store disabled (--no-store)."})
            return
        body = self._read_json_body()
        if body is None:
            self._send_json(400, {"error": "Bad JSON body"})
            return
        entry = body.get("entry")
        if not isinstance(entry, dict):
            self._send_json(400, {"error": "Missing entry"})
            return
        # ids never become paths without sanitizing (no traversal, no
        # hidden dotfiles, ever)
        sid = SAFE_ID.sub("", str(entry.get("id", ""))).lstrip(".")[:80]
        if not sid:
            self._send_json(400, {"error": "Bad entry id"})
            return
        try:
            os.makedirs(STORE_DIR, mode=0o700, exist_ok=True)
            jpath = os.path.join(STORE_DIR, sid + ".json")
            with open(jpath, "w") as f:
                json.dump(entry, f, ensure_ascii=False, indent=1)
            os.chmod(jpath, 0o600)
            md = body.get("md")
            if isinstance(md, str) and md:
                mpath = os.path.join(STORE_DIR, sid + ".md")
                with open(mpath, "w") as f:
                    f.write(md)
                os.chmod(mpath, 0o600)
        except OSError as e:
            self._send_json(500, {"error": str(e)[:200]})
            return
        self._send_json(200, {"ok": True, "dir": STORE_DIR})

    def _post_log_summary(self):
        if not STORE:
            self._send_json(403, {"error": "Summary store disabled (--no-store)."})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > LOG_MAX_BYTES:
            self._send_json(413, {"error": "Summary too large"})
            return
        body = self._read_json_body()
        if not isinstance(body, dict):
            self._send_json(400, {"error": "Bad JSON body"})
            return
        target = self._log_target(body.get("kind"), body.get("key"))
        data = body.get("data")
        if not target or not isinstance(data, dict):
            self._send_json(400, {"error": f"{LOG_KEY_HELP} and a data object required"})
            return
        try:
            write_log_summary(*target, data)
        except OSError as e:
            self._send_json(500, {"error": str(e)[:200]})
            return
        self._send_json(200, {"ok": True})

    def _post_mark(self):
        """Pin, unpin, archive or restore one chat in Still going; answers with every mark."""
        if not STORE:
            self._send_json(403, {"error": "Saving is off (--no-store)."})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > MARKS_BODY_MAX:
            self._send_json(413, {"error": "Too large"})
            return
        try:
            marks = change_mark(self._read_json_body())
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        except OSError as e:
            self._send_json(500, {"error": str(e)[:200]})
            return
        self._send_json(200, marks)

    def _post_commits(self):
        """Your commits in the folders your sessions started in (read-only git)."""
        if not IMPORT:
            self._send_json(404, {"enabled": False, "error": "Reading your history is off (--no-import)."})
            return
        body = self._read_json_body()
        folders = body.get("folders") if isinstance(body, dict) else None
        since = body.get("since") if isinstance(body, dict) else None
        if not isinstance(folders, list) or not isinstance(since, str) or not LOG_KEY.match(since):
            self._send_json(400, {"error": "folders (a list) and since (YYYY-MM-DD) are required"})
            return
        ok = []
        for f in folders[:COMMITS_MAX_FOLDERS]:
            if isinstance(f, str) and os.path.isabs(f) and len(f) < 1024 and not re.search(r"[\x00-\x1f\x7f]", f) \
                    and os.path.isdir(f):
                ok.append(os.path.normpath(f))
        try:
            found = your_commits(sorted(set(ok)), since)
        except Exception:  # an answer, never a dropped connection (the page keeps what it showed)
            self._send_json(500, {"error": "Couldn't read your commits"})
            return
        self._send_json(200, found)

    def do_POST(self):
        route = self.path.split("?")[0]
        if not route.startswith("/api/"):
            self.send_error(404)
            return
        if not self._api_ok():
            self._send_json(403, {"error": "Local-only API."})
            return
        if route == "/api/commits":
            self._post_commits()
            return
        if route == "/api/reveal":
            # Show in Finder: the page names a chat (app + id); the server finds
            # its file itself and asks Finder to show it — never a path it's sent.
            body = self._read_json_body()
            app_id = body.get("app") if isinstance(body, dict) else None
            sid = body.get("id") if isinstance(body, dict) else None
            if not IMPORT:
                self._send_json(404, {"error": "Reading apps is off (--no-import)."})
                return
            if app_id not in SOURCE_APPS or not isinstance(sid, str) or not SOURCE_ID.fullmatch(sid):
                self._send_json(400, {"error": f"app ({'|'.join(SOURCE_APPS)}) and a chat's id are required"})
                return
            if not can_reveal():
                self._send_json(501, {"error": "Show in Finder works on a Mac only."})
                return
            ok = reveal_source(app_id, sid)
            if ok is None:
                self._send_json(404, {"error": "That chat's file isn't on this Mac any more."})
            elif not ok:
                self._send_json(500, {"error": "Finder couldn't show it."})
            else:
                self._send_json(200, {"ok": True})
            return
        if route == "/api/keep":
            body = self._read_json_body()
            sid = body.get("id") if isinstance(body, dict) else None
            if not IMPORT or not STORE:
                self._send_json(404, {"error": "Keeping copies is off here (--no-store or --no-import)."})
                return
            if not isinstance(sid, str) or not KEEP_ID.fullmatch(sid):
                self._send_json(400, {"error": "id (a Claude Code session ID) is required"})
                return
            try:
                meta = keep_copy(sid)
            except (OSError, ValueError) as e:
                self._send_json(500, {"error": str(e)[:200]})
                return
            if meta is None:
                self._send_json(404, {"error": "Claude Code no longer has that session."})
                return
            self._send_json(200, {"ok": True, "kept": meta})
            return
        if route == "/api/summaries":
            self._post_summary()
            return
        if route == "/api/log-summaries":
            self._post_log_summary()
            return
        if route == "/api/marks":
            self._post_mark()
            return
        if route == "/api/usage/refresh":
            # The app asks, one tool per request, when it opens or you come
            # back to it; only with --claude does the server run a tool's own
            # app (usage_live()), and only the tools you've turned on.
            body = self._read_json_body()
            tool = body.get("tool", "claude") if isinstance(body, dict) else "claude"
            if tool not in LIVE_TOOLS:
                self._send_json(400, {"error": f"tool must be one of {', '.join(LIVE_TOOLS)}"})
                return
            if CLAUDE and usage_asks().get(tool):
                usage_live(tool)
            self._send_json(200, usage_status())
            return
        if route == "/api/usage/ask":
            body = self._read_json_body()
            tool = body.get("tool") if isinstance(body, dict) else None
            on = body.get("on") if isinstance(body, dict) else None
            if tool not in LIVE_TOOLS or not isinstance(on, bool):
                self._send_json(400, {"error": f"tool ({', '.join(LIVE_TOOLS)}) and on (true/false) required"})
                return
            try:
                set_usage_ask(tool, on)
            except OSError as e:
                self._send_json(500, {"error": str(e)[:200]})
                return
            self._send_json(200, usage_status())
            return
        if route != "/api/claude-summarize":
            self.send_error(404)
            return
        if not CLAUDE:
            self._send_json(403, {"error": "Local Claude summarizer is disabled "
                                  "(start the server with --claude)."})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Bad JSON body"})
            return
        prompt = f"{body.get('system', '')}\n\n{body.get('prompt', '')}".strip()
        if not prompt:
            self._send_json(400, {"error": "Empty prompt"})
            return
        # parse.js knows this prompt (BRIDGE_PROMPT): old runs saved as sessions are skipped by it.
        cmd = [CLAUDE_BIN, "-p",
               "Follow the instructions in the piped input exactly. Output only the requested result.",
               # One JSON result: the reply's text and its real token counts.
               "--output-format", "json",
               # Summarizing is text in, text out: no built-in tools, no MCP
               # servers — so text inside a transcript can never make the
               # model act on this machine.
               "--tools", "", "--strict-mcp-config", *NO_SWEEP]
        cmd += claude_no_persist_flag()  # never saved as a session in your history
        model = body.get("model") or CLAUDE_MODEL
        if model:
            cmd += ["--model", str(model)]
        # An empty working directory, so no project CLAUDE.md is picked up.
        workdir = tempfile.mkdtemp(prefix="throwbacks-claude-")
        try:
            # Its own telemetry, crash reports, auto-update and claude.ai connectors off, as for
            # the usage meter's runs (never CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: see there).
            res = subprocess.run(cmd, input=prompt.encode(), cwd=workdir, env={**os.environ, **USAGE_LIVE_ENV},
                                 capture_output=True, timeout=CLAUDE_TIMEOUT_S)
        except FileNotFoundError:
            self._send_json(500, {"error": f"Claude CLI not found ({CLAUDE_BIN}). "
                                  "Install Claude Code or set CLAUDE_BIN."})
            return
        except subprocess.TimeoutExpired:
            self._send_json(504, {"error": f"Claude CLI timed out after {CLAUDE_TIMEOUT_S}s"})
            return
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        out = res.stdout.decode(errors="replace").strip()
        err = (res.stderr or b"").decode(errors="replace").strip()
        expired = {"error": "This Mac’s Claude Code login has expired — "
                            "run `claude auth login` in Terminal to log in again, then retry."}
        result = claude_json_result(out)
        if result is None:
            # Not a JSON result (an older CLI's plain text): as before, the
            # whole output is the text. The CLI reports auth failure on
            # stdout and may still exit 0 — sniff for it so it never
            # masquerades as a summary or a 502.
            if claude_login_expired(out + err):
                self._send_json(401, expired)
                return
            if res.returncode != 0:
                self._send_json(502, {"error": (err or out)[:500] or f"claude exited {res.returncode}"})
                return
            if not out:
                self._send_json(502, {"error": err[:500] or "Claude CLI returned no output"})
                return
            self._send_json(200, {"text": out})
            return
        text = result["text"]
        if result["failed"] or res.returncode != 0 or not text:
            # Only a failed run is sniffed for the login: a summary that
            # mentions a 401 is still a summary.
            if claude_login_gone(f"{result['error']}\n{err}"):
                self._send_json(401, expired)
                return
            if result["failed"] or res.returncode != 0:
                self._send_json(502, {"error": (result["error"] or err)[:500]
                                      or (f"claude exited {res.returncode}" if res.returncode
                                          else "Claude CLI reported an error")})
                return
            self._send_json(502, {"error": err[:500] or "Claude CLI returned no output"})
            return
        reply = {"text": text}
        if result["usage"]:
            reply["usage"] = result["usage"]
        reply["model"] = result["model"]
        self._send_json(200, reply)


class Server(http.server.ThreadingHTTPServer):
    # Threaded so a browser's idle speculative connection can't block
    # other requests; daemon threads die with the process on Ctrl-C.
    daemon_threads = True
    allow_reuse_address = True


def lan_ips():
    """Best-effort list of this machine's LAN IPv4 addresses."""
    ips = set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("192.0.2.1", 80))  # no packets sent; picks the route
            ips.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def main():
    httpd = None
    port = None
    for candidate in range(BASE_PORT, BASE_PORT + PORT_TRIES):
        try:
            httpd = Server((BIND, candidate), Handler)
            port = candidate
            break
        except OSError:
            print(f"Port {candidate} is taken, trying {candidate + 1}…", flush=True)
    if httpd is None:
        print(f"No free port in {BASE_PORT}–{BASE_PORT + PORT_TRIES - 1}. "
              "Stop whatever is using them and retry.")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}/"
    print(f"Throwbacks serving {ROOT}", flush=True)
    print(f"  → {url}", flush=True)
    if LAN:
        print("  ⚠ LAN mode: other devices on your network can open the app.", flush=True)
        print("    (They load THEIR data into THEIR browser — nothing of yours is served.)", flush=True)
        for ip in lan_ips():
            print(f"  → share: http://{ip}:{port}/", flush=True)
        print("    Note over LAN: browsers treat http://<ip> as insecure, so the live", flush=True)
        print("    folder picker falls back to a plain picker and Refresh is unavailable.", flush=True)
    else:
        print("  (local-only: bound to 127.0.0.1 — run with --lan to allow your network)", flush=True)
    if STORE:
        print(f"  🕘 Summaries stored in {os.path.dirname(STORE_DIR)} — history, daily log "
              "(--no-store to disable)", flush=True)
    if IMPORT:
        print("  ⇪ AI apps' chats (Claude Code, Cowork, Copilot, Copilot CLI, Cursor) readable, "
              "read-only (--no-import to disable)", flush=True)
    if CLAUDE:
        found = shutil.which(CLAUDE_BIN)
        state = f"CLI: {found}" if found else f"CLI '{CLAUDE_BIN}' NOT FOUND"
        print(f"  ✨ Local Claude summarizer bridge ON ({state}"
              + (f", model {CLAUDE_MODEL}" if CLAUDE_MODEL else "")
              + ") — loopback clients only.", flush=True)
        print("  ◔ Usage meter: asks your tools' own apps (Claude Code, Copilot CLI, Codex, agy — the ones "
              "turned on in Settings) for your plan's limits when the app opens (no AI request; "
              "at most once a minute each).", flush=True)
    print("  Ctrl-C to stop.", flush=True)
    try:
        webbrowser.open(url)
    except Exception:
        pass  # never fail to start just because auto-open failed

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nThrowbacks server stopped.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
