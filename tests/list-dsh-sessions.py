"""List DSH sessions actually present on disk (log + projection cache), so the
sidebar can be compared against the true on-disk state."""
import glob
import json
import os
import sys

DSH = os.path.expanduser("~/.dsh")
WS = "--Users-mac166-Documents-deepseek-harness-default-workspace--"
SESS_DIR = os.path.join(DSH, "sessions", WS)
CACHE_DIR = os.path.join(DSH, "storages", "session_projcache", "sessions")


def cache_title(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return f"<unreadable: {exc}>"
    rows = (data.get("record") or {}).get("rows") or {}
    return str((rows.get("title") or {}).get("val") or "")


def main():
    dirs = sorted(
        name for name in os.listdir(SESS_DIR)
        if os.path.isdir(os.path.join(SESS_DIR, name))
    )
    print(f"session dirs on disk: {len(dirs)}")
    for sid in dirs:
        log = os.path.join(SESS_DIR, sid, "session.v4.jsonl.zstd")
        cache = os.path.join(CACHE_DIR, sid + ".json")
        state = "log:ok" if os.path.exists(log) else "log:MISSING"
        cache_state = "cache:ok" if os.path.exists(cache) else "cache:MISSING"
        title = cache_title(cache) if os.path.exists(cache) else "-"
        print(f"  {sid}  {state:12} {cache_state:14} {title[:46]}")
    orphans = [
        os.path.basename(p)[:-5]
        for p in glob.glob(os.path.join(CACHE_DIR, "*.json"))
        if not os.path.isdir(os.path.join(SESS_DIR, os.path.basename(p)[:-5]))
    ]
    if orphans:
        print("cache entries without a session dir (stale):", orphans)
    return 0


if __name__ == "__main__":
    sys.exit(main())
