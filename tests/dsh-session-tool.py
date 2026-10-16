#!/usr/bin/env python3
"""List and delete DSH conversations directly on disk.

The desktop GUI keeps its sidebar in the Host process's memory and only re-reads
session storage when the Host restarts, so deleting a conversation from disk
requires restarting DeepSeek Harness afterwards for the sidebar to update.

Usage:
    python3 dsh-session-tool.py list
    python3 dsh-session-tool.py delete <session-id> [<session-id> ...]
    python3 dsh-session-tool.py delete --index 2
    python3 dsh-session-tool.py delete --title 服务问题咨询 [--yes]

Deleting removes BOTH the session log directory and the projection-cache entry,
which is what makes the conversation disappear for good. Deletion is
irreversible; `--yes` skips the confirmation prompt.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

DSH_HOME = os.path.expanduser(os.environ.get("DSH_HOME", "~/.dsh"))
SESSIONS_ROOT = os.path.join(DSH_HOME, "sessions")
CACHE_ROOT = os.path.join(DSH_HOME, "storages", "session_projcache", "sessions")


def workspace_key(cwd: str) -> str:
    """Replicate the Host's workspace directory key: /a/b -> --a-b--"""
    return "--" + cwd.strip("/").replace("/", "-") + "--"


def workspaces() -> list[str]:
    if not os.path.isdir(SESSIONS_ROOT):
        return []
    return sorted(
        name
        for name in os.listdir(SESSIONS_ROOT)
        if os.path.isdir(os.path.join(SESSIONS_ROOT, name))
    )


def session_title(session_id: str) -> str:
    cache = os.path.join(CACHE_ROOT, session_id + ".json")
    if not os.path.exists(cache):
        return ""
    try:
        with open(cache, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:  # noqa: BLE001 - a corrupt cache must not break listing
        return "<unreadable cache>"
    rows = (data.get("record") or {}).get("rows") or {}
    return str((rows.get("title") or {}).get("val") or "")


def collect() -> list[dict]:
    """Every conversation on disk, grouped by workspace, ordered by title."""
    found: list[dict] = []
    for ws in workspaces():
        ws_dir = os.path.join(SESSIONS_ROOT, ws)
        for sid in sorted(os.listdir(ws_dir)):
            path = os.path.join(ws_dir, sid)
            if not os.path.isdir(path):
                continue
            found.append(
                {
                    "session_id": sid,
                    "workspace": ws,
                    "title": session_title(sid),
                    "has_log": os.path.exists(os.path.join(path, "session.v4.jsonl.zstd")),
                    "has_cache": os.path.exists(os.path.join(CACHE_ROOT, sid + ".json")),
                    "dir": path,
                }
            )
    return found


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("no conversations found on disk")
        return
    for index, row in enumerate(rows, start=1):
        log = "log" if row["has_log"] else "no-log"
        cache = "cache" if row["has_cache"] else "no-cache"
        print(f"[{index}] {row['session_id']}")
        print(f"    title: {row['title'] or '(untitled)'}")
        print(f"    files: {log}, {cache}   workspace: {row['workspace']}")


def resolve(rows: list[dict], args: argparse.Namespace) -> list[dict]:
    if args.index:
        selected = []
        for value in args.index:
            if not 1 <= value <= len(rows):
                sys.exit(f"index out of range: {value} (1..{len(rows)})")
            selected.append(rows[value - 1])
        return selected
    if args.title:
        matches = [r for r in rows if args.title in r["title"]]
        if not matches:
            sys.exit(f"no conversation title contains: {args.title}")
        if len(matches) > 1:
            print_table(matches)
            sys.exit("title matches several conversations; use an exact session id or --index")
        return matches
    if args.session_id:
        by_id = {r["session_id"]: r for r in rows}
        missing = [s for s in args.session_id if s not in by_id]
        if missing:
            sys.exit("unknown session id(s): " + ", ".join(missing))
        return [by_id[s] for s in args.session_id]
    sys.exit("nothing to delete: pass a session id, --index, or --title")


def delete(row: dict) -> None:
    # Guard: only ever remove a path that really is a session directory below
    # the sessions root.
    target = os.path.realpath(row["dir"])
    root = os.path.realpath(SESSIONS_ROOT) + os.sep
    if not target.startswith(root) or os.path.basename(target) != row["session_id"]:
        sys.exit(f"refusing to delete unexpected path: {target}")
    shutil.rmtree(target)
    print(f"deleted session log: {target}")
    cache = os.path.join(CACHE_ROOT, row["session_id"] + ".json")
    if os.path.exists(cache):
        os.remove(cache)
        print(f"deleted cache entry: {cache}")


def main() -> int:
    parser = argparse.ArgumentParser(description="List/delete DSH conversations on disk")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list conversations found on disk")

    deleter = sub.add_parser("delete", help="delete conversations by id/index/title")
    deleter.add_argument("session_id", nargs="*", help="exact session id(s)")
    deleter.add_argument("--index", type=int, nargs="+", help="1-based row number(s) from `list`")
    deleter.add_argument("--title", help="delete the single conversation whose title contains this text")
    deleter.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    args = parser.parse_args()
    rows = collect()

    if args.command == "list":
        print_table(rows)
        print(f"\n{len(rows)} conversation(s) on disk under {SESSIONS_ROOT}")
        print("note: the GUI sidebar only reflects this after DeepSeek Harness is restarted")
        return 0

    selected = resolve(rows, args)
    print_table(selected)
    if not args.yes:
        answer = input("delete the conversation(s) above? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            print("aborted")
            return 1
    for row in selected:
        delete(row)
    print("\ndone. restart DeepSeek Harness so the GUI sidebar drops the entry.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
