#!/usr/bin/env python3
"""Test helper: runs serve.py's own readers and prints the result as JSON,
so the Node tests can check that what the server sends parses exactly like
the raw files would. Nothing is written anywhere.

    python3 tests/bridge.py <command> [path]

Commands that read THIS machine's AI-app data (used only by live.test.mjs):
claude-code, claude-code-files, copilot, copilot-files, copilot-cli,
copilot-cli-turns, cowork, cursor, status. Commands that only touch the
given file (used by roundtrip.test.mjs): prune-claude-code, prune-copilot.
"""

import json
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to serve.py
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
args = sys.argv[1:]
sys.argv = ["serve.py"]  # serve.py reads its flags from argv at import
import serve  # noqa: E402


def copilot_cli_turns():
    db = os.path.join(serve.copilot_cli_dir(), "session-store.db")
    if not os.path.isfile(db):
        return []
    with serve.sqlite_readonly(db) as conn:
        return [{"session_id": sid, "user_message": msg}
                for sid, msg in serve._rows(conn, "SELECT session_id, user_message FROM turns")]


COMMANDS = {
    "status": lambda: serve.import_status(),
    "claude-code": lambda: serve.collect_claude_code(),
    "claude-code-files": lambda: [{"path": p, "name": os.path.basename(p),
                                   "project": os.path.basename(os.path.dirname(p))}
                                  for p in serve.claude_code_files()],
    "copilot": lambda: serve.collect_copilot(),
    "copilot-files": lambda: [{"path": p, "workspace": w} for p, w in serve.copilot_chat_files()],
    "copilot-cli": lambda: serve.collect_copilot_cli(),
    "copilot-cli-turns": copilot_cli_turns,
    "cowork": lambda: serve.collect_cowork(),
    "cursor": lambda: serve.collect_cursor(),
    "prune-claude-code": lambda: {"text": serve.prune_claude_code_file(args[1])},
    "prune-copilot": lambda: {"text": serve.prune_copilot_file(args[1])},
}

if __name__ == "__main__":
    if not args or args[0] not in COMMANDS:
        sys.exit(f"usage: bridge.py <{'|'.join(COMMANDS)}> [path]")
    sys.stdout.buffer.write(json.dumps(COMMANDS[args[0]](), ensure_ascii=False).encode("utf-8", "replace"))
