"""Audit DSH session storage on disk.

Walks every workspace bucket under ``<DSH_HOME>/sessions`` and cross-checks the
projection cache entries under ``<DSH_HOME>/storages/session_projcache/sessions``,
so the sidebar can be compared against the true on-disk state. Reports:

* every stored session with its title and whether its log file is present;
* stale cache entries (a cache record with no session directory);
* session directories with no cache entry.

Read-only: this script never modifies anything.

Usage:
    python3 tests/list-dsh-sessions.py
    DSH_HOME=/path/to/home python3 tests/list-dsh-sessions.py
"""

import json
import os
import sys

DSH_HOME = os.path.expanduser(os.environ.get("DSH_HOME") or "~/.dsh")
SESSIONS_ROOT = os.path.join(DSH_HOME, "sessions")
CACHE_DIR = os.path.join(DSH_HOME, "storages", "session_projcache", "sessions")
LOG_SUFFIX = ".jsonl.zstd"


def cache_title(path):
    """Best-effort title from one projection-cache record."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001 - a corrupt record must not stop the audit
        return f"<unreadable: {exc}>"
    rows = (data.get("record") or {}).get("rows") or {}
    return str((rows.get("title") or {}).get("val") or "")


def log_filename(session_dir):
    """The session's log file name, whichever format generation it uses."""
    try:
        names = os.listdir(session_dir)
    except OSError:
        return None
    candidates = sorted(name for name in names if name.endswith(LOG_SUFFIX))
    return candidates[-1] if candidates else None


def main():
    if not os.path.isdir(SESSIONS_ROOT):
        print(f"no session storage at {SESSIONS_ROOT}")
        return 0

    session_ids = set()
    printed = 0
    for workspace in sorted(os.listdir(SESSIONS_ROOT)):
        bucket = os.path.join(SESSIONS_ROOT, workspace)
        if not os.path.isdir(bucket):
            continue
        for sid in sorted(os.listdir(bucket)):
            session_dir = os.path.join(bucket, sid)
            if not os.path.isdir(session_dir):
                continue
            session_ids.add(sid)
            if printed == 0:
                print(f"sessions root: {SESSIONS_ROOT}")
            log = log_filename(session_dir)
            cache = os.path.join(CACHE_DIR, sid + ".json")
            has_cache = os.path.exists(cache)
            title = cache_title(cache) if has_cache else "-"
            print(
                f"  {sid}  "
                f"{('log:' + log) if log else 'log:MISSING':34} "
                f"{'cache:ok' if has_cache else 'cache:MISSING':14} "
                f"{title[:46]}"
            )
            printed += 1

    print(f"\n{printed} session(s) on disk")

    cache_ids = set()
    if os.path.isdir(CACHE_DIR):
        for name in os.listdir(CACHE_DIR):
            if name.endswith(".json"):
                cache_ids.add(name[: -len(".json")])

    stale = sorted(cache_ids - session_ids)
    if stale:
        print(f"\nstale cache entries (no session dir): {len(stale)}")
        for sid in stale:
            print(f"  {sid}")

    missing_cache = sorted(session_ids - cache_ids)
    if missing_cache:
        print(f"\nsessions without a cache entry: {len(missing_cache)}")
        for sid in missing_cache:
            print(f"  {sid}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
