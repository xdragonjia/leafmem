#!/usr/bin/env python3
"""stale_task_sweep.py — LeafMem 残留任务闭环清扫扫描器（只读，零 LLM 依赖）

背景（2026-10-02 实证）：任务上下文的闭环依赖会话收尾时显式
task_append(status=completed)；会话中断/超时/收尾被跳过 → 任务永久滞留
active。另曾混入非法状态值 "done"（handler 仅类型断言无运行时校验，
0.3.22+ 已修复拒绝非法值）。本脚本列出超龄未闭环任务供人工/宿主闭环。

用法：
  python3 stale_task_sweep.py [--hours 24] [--json]

退出码：0 = 无超龄未闭环任务；2 = 发现超龄未闭环任务（需闭环处置）；1 = 错误。
只读 sqlite（mode=ro），绝不写库；闭环动作由调用方经 leafmem-cli
task-append 执行（status=completed + 闭环版 rollingSummary）。
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DB = os.path.expanduser("~/.leafmem/memory.sqlite")
VALID_STATUSES = ("active", "paused", "completed", "archived")


def parse_ts(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None  # legacy epoch-ms 等异构格式，按未知处理


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24.0, help="超龄阈值（小时），默认 24")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(DB):
        print(f"ERROR: {DB} 不存在", file=sys.stderr)
        return 1

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    now = datetime.now(timezone.utc)

    # 全量状态分布（含非法值检测——合法枚举见 VALID_STATUSES）
    dist = dict(db.execute("SELECT status, COUNT(*) FROM task_context GROUP BY status").fetchall())
    invalid = {s: n for s, n in dist.items() if s not in VALID_STATUSES}

    rows = db.execute(
        """
        SELECT t.task_id, t.title, t.status, t.updated_at,
               (SELECT content FROM task_context_entries e
                 WHERE e.task_id = t.task_id
                 ORDER BY e.sequence DESC LIMIT 1) AS last_entry
        FROM task_context t
        WHERE t.status != 'completed' AND t.status != 'archived'
        ORDER BY t.updated_at ASC
        """
    ).fetchall()

    stale, fresh = [], []
    for task_id, title, status, updated_at, last_entry in rows:
        ts = parse_ts(updated_at)
        age_h = (now - ts).total_seconds() / 3600 if ts else None
        item = {
            "task_id": task_id,
            "title": title,
            "status": status,
            "updated_at": updated_at,
            "age_hours": round(age_h, 1) if age_h is not None else None,
            "last_entry": (last_entry or "")[:160],
        }
        if age_h is None or age_h >= args.hours:
            stale.append(item)
        else:
            fresh.append(item)

    report = {
        "scanned_total": sum(dist.values()),
        "status_distribution": dist,
        "invalid_statuses": invalid,
        "threshold_hours": args.hours,
        "stale": stale,
        "fresh_non_completed": fresh,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"任务总数 {report['scanned_total']} | 状态分布 {dist}")
        if invalid:
            print(f"!! 非法状态值（合法枚举 {VALID_STATUSES}）: {invalid}")
        print(f"超龄未闭环（>={args.hours}h）: {len(stale)} 条；阈值内未闭环: {len(fresh)} 条")
        for it in stale:
            age = f"{it['age_hours']}h" if it["age_hours"] is not None else "未知龄期"
            print(f"- [{it['status']}] {age} | {it['task_id']} | {it['title']}")
            if it["last_entry"]:
                print(f"    末条: {it['last_entry']}")

    return 2 if (stale or invalid) else 0


if __name__ == "__main__":
    sys.exit(main())
