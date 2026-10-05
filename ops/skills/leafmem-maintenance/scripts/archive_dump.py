#!/usr/bin/env python3
"""LeafMem 全量存档导出（只读 memory.sqlite，绝无写入）。

用法: python3 leafmem_archive_dump.py [输出路径]
默认: ~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-YYYYMMDD.json
"""
import json
import os
import sqlite3
import sys
from datetime import datetime

DB = os.path.expanduser("~/.leafmem/memory.sqlite")
SCOPE = ("agent", "workbuddy")


def main():
    today = datetime.now().strftime("%Y%m%d")
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        f"~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-{today}.json"
    )
    os.makedirs(os.path.dirname(out), exist_ok=True)

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT * FROM memory_items WHERE scope_type=? AND scope_id=?",
        SCOPE,
    ).fetchall()
    fts = con.execute("SELECT COUNT(*) FROM memory_items_fts").fetchone()[0]
    total = con.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0]

    def conv(r):
        d = dict(r)
        for k in ("tags_json", "metadata_json"):
            if d.get(k):
                try:
                    d[k.replace("_json", "")] = json.loads(d[k])
                except Exception:
                    pass
        return d

    items = [conv(r) for r in rows]
    payload = {
        "exported_at": datetime.now().isoformat(),
        "scope": {"type": SCOPE[0], "id": SCOPE[1]},
        "db_path": DB,
        "counts": {"scoped": len(items), "all": total, "fts": fts},
        "items": items,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    con.close()

    # 回读校验
    with open(out, encoding="utf-8") as f:
        back = json.load(f)
    size = os.path.getsize(out)
    ok = len(back["items"]) == len(items)
    print(f"ARCHIVE={out}")
    print(f"ITEMS={len(items)} ALL={total} FTS={fts} SIZE={size/1048576:.2f}MB")
    print(f"VERIFY={'OK' if ok else 'FAIL'}")


if __name__ == "__main__":
    main()
