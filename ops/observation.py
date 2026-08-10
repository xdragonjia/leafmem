#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LeafMem 观察记录脚本（2026-08-07，Phase 9 闭环）

用途：确定性采集 LeafMem 治理数据（不依赖 LLM、不调外部 API），追加到观测日志，
输出人读摘要与判定（ALERT/WARN/INFO），供自动化任务据此决定是否飞书提醒。

用法：
  python3 leafmem_observation.py [--mode daily|weekly]

  daily  —— 静默采集 + 追加日志；仅当出现 ALERT/WARN 时打印 [NEED_PUSH] 标记
  weekly —— 在 daily 基础上，额外生成周对比摘要（vs 上一次 weekly 记录）并总是打印 [NEED_PUSH]

数据源：直接读 SQLite（/Users/dragon/.leafmem/memory.sqlite），快速且无需服务在线。
"""
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

DB = os.path.expanduser("~/.leafmem/memory.sqlite")
LOG_DIR = "/Users/dragon/WorkBuddy/outputs/项目/leafmem-productization/runs/observation"
LOG = os.path.join(LOG_DIR, "leafmem-observation-log.jsonl")
SCOPE = "workbuddy"

DAY = 86400_000  # ms


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ms(iso):
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def collect(db, now_ms):
    m = {}
    m["ts"] = now_iso()
    m["total"] = db.execute("SELECT COUNT(*) FROM memory_items WHERE scope_id=?", (SCOPE,)).fetchone()[0]
    kinds = dict(db.execute(
        "SELECT kind, COUNT(*) FROM memory_items WHERE scope_id=? GROUP BY kind", (SCOPE,)).fetchall())
    m["kind_counts"] = kinds
    m["principle_count"] = kinds.get("principle", 0)

    # principles: supports integrity + freshness
    rows = db.execute(
        "SELECT id, metadata_json, updated_at FROM memory_items WHERE scope_id=? AND kind='principle'",
        (SCOPE,)).fetchall()
    supports_missing = 0
    newest_principle = None
    for pid, mj, upd in rows:
        meta = json.loads(mj or "{}")
        for sid in (meta.get("supports") or []):
            if not db.execute("SELECT 1 FROM memory_items WHERE id=?", (sid,)).fetchone():
                supports_missing += 1
        t = ms(upd)
        if t and (newest_principle is None or t > newest_principle):
            newest_principle = t
    m["principle_supports_missing"] = supports_missing
    m["newest_principle_at"] = datetime.fromtimestamp(newest_principle / 1000, timezone.utc).isoformat() if newest_principle else None

    # recall feedback loop health
    r = db.execute(
        "SELECT COALESCE(SUM(json_extract(metadata_json,'$.recallCount')),0), "
        "SUM(CASE WHEN json_extract(metadata_json,'$.recallCount')>0 THEN 1 ELSE 0 END) "
        "FROM memory_items WHERE scope_id=?", (SCOPE,)).fetchone()
    m["recall_total"] = int(r[0] or 0)
    m["records_with_recall"] = int(r[1] or 0)
    hot = db.execute(
        "SELECT json_extract(metadata_json,'$.recallCount') rc, substr(coalesce(summary,content),1,40) "
        "FROM memory_items WHERE scope_id=? AND rc > 0 ORDER BY rc DESC LIMIT 5",
        (SCOPE,)).fetchall()
    m["recall_hot_top5"] = [{"count": int(a), "head": b} for a, b in hot]

    # FTS consistency (regression watch: earlier bug left 145 stale rows)
    fts = db.execute("SELECT COUNT(*) FROM memory_items_fts").fetchone()[0]
    mem = db.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0]
    m["fts_rows"] = fts
    m["memory_rows"] = mem
    m["fts_stale"] = db.execute(
        "SELECT COUNT(*) FROM memory_items_fts WHERE id NOT IN (SELECT id FROM memory_items)").fetchone()[0]

    # entity graph
    m["entity_count"] = db.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
    m["entity_links"] = db.execute("SELECT COUNT(*) FROM entity_links").fetchone()[0]

    # profile + reflect markers (active_documents)
    prof = db.execute("SELECT content, updated_at FROM active_documents WHERE kind='profile' AND scope_id=?", (SCOPE,)).fetchone()
    m["profile_present"] = prof is not None
    m["profile_updated_at"] = prof[1] if prof else None
    m["profile_sections"] = prof[0].count("## ") if prof else 0
    ctx = db.execute("SELECT metadata_json FROM active_documents WHERE kind='context' AND scope_id=?", (SCOPE,)).fetchone()
    last_reflect = None
    if ctx:
        last_reflect = (json.loads(ctx[0] or "{}").get("lastReflectAt"))
    m["last_reflect_at"] = last_reflect

    # decay candidates (informational)
    cutoff = now_ms - 180 * DAY
    recent = now_ms - 90 * DAY
    m["decay_candidates"] = db.execute(
        "SELECT COUNT(*) FROM memory_items WHERE scope_id=? AND importance>0.3 AND updated_at < ? "
        "AND tags_json NOT LIKE '%pinned%' "
        "AND (json_extract(metadata_json,'$.lastRecalledAt') IS NULL OR json_extract(metadata_json,'$.lastRecalledAt') < ?)",
        (SCOPE, datetime.fromtimestamp(cutoff / 1000, timezone.utc).isoformat(),
         datetime.fromtimestamp(recent / 1000, timezone.utc).isoformat())).fetchone()[0]
    return m


def judge(cur, prev):
    findings = []  # (level, text)
    # ALERT: hard regressions of previously-fixed bugs
    if cur["fts_stale"] > 0:
        findings.append(("ALERT", f"FTS 陈旧行回归：{cur['fts_stale']} 条（已知 bug 复发，需清理+JOIN 检查）"))
    if cur["fts_rows"] != cur["memory_rows"]:
        findings.append(("ALERT", f"FTS 与记忆行数不一致：{cur['fts_rows']} vs {cur['memory_rows']}"))
    if cur["principle_supports_missing"] > 0:
        findings.append(("ALERT", f"principle 证据链断裂：{cur['principle_supports_missing']} 个 supports 指向不存在的记忆"))
    # WARN: feedback loop / maintenance liveness
    if prev:
        days = (ms(cur["ts"]) - ms(prev["ts"])) / DAY
        if days >= 2 and cur["recall_total"] == prev.get("recall_total", 0):
            findings.append(("WARN", f"recall 回流停滞：{days:.0f} 天 recall_total 无增长（{cur['recall_total']}），P0-2 反馈回路可能未生效"))
    if cur["last_reflect_at"] and (ms(cur["ts"]) - ms(cur["last_reflect_at"])) > 10 * DAY:
        findings.append(("WARN", f"reflect 超过 10 天未运行（last={cur['last_reflect_at'][:10]}），周检可能未挂接 reflect"))
    if cur["profile_present"] and cur["profile_updated_at"] and (ms(cur["ts"]) - ms(cur["profile_updated_at"])) > 14 * DAY:
        findings.append(("WARN", f"画像超过 14 天未刷新（updated={cur['profile_updated_at'][:10]}）"))
    # INFO: progress signals
    if prev:
        new_p = cur["principle_count"] - prev.get("principle_count", 0)
        if new_p > 0:
            findings.append(("INFO", f"新增 principle {new_p} 条（累计 {cur['principle_count']}）"))
        dr = cur["recall_total"] - prev.get("recall_total", 0)
        if dr > 0:
            findings.append(("INFO", f"recall 使用 +{dr}（累计 {cur['recall_total']}），用进废退回路运转中"))
    findings.append(("INFO", f"decay 候选 {cur['decay_candidates']} 条（>180天未召回，待 2-4 周后复查）"))
    return findings


def main():
    mode = "weekly" if "--mode" in sys.argv and sys.argv[sys.argv.index("--mode") + 1] == "weekly" else "daily"
    os.makedirs(LOG_DIR, exist_ok=True)

    prev = None
    prev_weekly = None
    if os.path.exists(LOG):
        lines = [json.loads(l) for l in open(LOG) if l.strip()]
        same = [l for l in lines if l.get("mode") == mode]
        if lines:
            prev = lines[-1]
        if same:
            prev_weekly = same[-1]

    db = sqlite3.connect(DB)
    cur = collect(db, int(time.time() * 1000))
    cur["mode"] = mode
    db.close()

    findings = judge(cur, prev if prev and prev.get("mode") == mode or (prev and mode == "daily") else prev)
    with open(LOG, "a") as f:
        f.write(json.dumps(cur, ensure_ascii=False) + "\n")

    # human summary
    print(f"=== LeafMem observation ({mode}) {cur['ts'][:19]} ===")
    print(f"memories={cur['total']} principles={cur['principle_count']} recall_total={cur['recall_total']} "
          f"(used_by={cur['records_with_recall']}) entities={cur['entity_count']}/{cur['entity_links']}")
    print(f"profile: present={cur['profile_present']} sections={cur['profile_sections']} "
          f"updated={str(cur['profile_updated_at'])[:10]} | reflect_last={str(cur['last_reflect_at'])[:10]}")
    print(f"fts={cur['fts_rows']}/{cur['memory_rows']} stale={cur['fts_stale']} | decay_candidates={cur['decay_candidates']}")
    for level, text in findings:
        print(f"  [{level}] {text}")

    if mode == "weekly" and prev_weekly:
        print("--- weekly delta vs last weekly ---")
        print(f"  principles {prev_weekly.get('principle_count')} -> {cur['principle_count']}; "
              f"recall {prev_weekly.get('recall_total')} -> {cur['recall_total']}; "
              f"total {prev_weekly.get('total')} -> {cur['total']}")

    actionable = [f for f in findings if f[0] in ("ALERT", "WARN")]
    if mode == "weekly" or actionable:
        print("[NEED_PUSH]")
        for level, text in actionable:
            print(f"PUSH-{level}: {text}")
        if mode == "weekly" and not actionable:
            print("PUSH-INFO: 周度观察一切正常，无告警")


if __name__ == "__main__":
    main()
