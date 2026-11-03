#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LeafMem 周维护量化扫描（只读，零 LLM 依赖）

用途：为 leafmem-maintenance 步骤 4/5/6 提供**可复核**的候选清单，替代人工抽样目视。
输出五类信号：
  1) 真重复      —— 全文规范化 SHA256（技能 NEVER 规则：禁用前缀聚类）
  2) 碎片簇候选  —— (日期, 主tag) 聚类 n>=3，并给出**簇内 3-gram 凝聚度 maxJac**
                    判定：maxJac >= 0.55 才算「真碎片簇」；否则为同日同tag但主题各异的独立记忆
  3) 跨日近重复  —— 3-gram 倒排索引（对 1800+ 条为秒级；朴素 O(n^2) 集合交集不可用）
  4) 超长/畸形   —— content > 4000 字符，并标记 content==summary 畸形体
  5) 蒸馏候选    —— 近 30 天 lesson 按 tag 聚类 >=3；附 principle 覆盖清单与 supports 断链检查

用法：
  python3 scripts/weekly_scan.py                # 人类可读报告
  python3 scripts/weekly_scan.py --json         # 机器可读（便于自动化比对）
  python3 scripts/weekly_scan.py --days 30      # 蒸馏候选的回看天数（默认 30）

只读：绝不写入/删除任何记忆。删除动作一律回到 SKILL.md 步骤 4/5 经 MCP 执行。
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from itertools import combinations

DB = os.path.expanduser("~/.leafmem/memory.sqlite")
COHESION_THRESHOLD = 0.55   # 簇内凝聚度阈值：>= 判真碎片簇
NEAR_DUP_THRESHOLD = 0.72   # 跨日近重复阈值
GRAM_N = 3
LONG_CHARS = 4000


def norm(s):
    return re.sub(r"\s+", "", s or "").strip()


def sha16(s):
    return hashlib.sha256(norm(s).encode("utf-8")).hexdigest()[:16]


def grams(s, n=GRAM_N):
    s = norm(s)
    return {s[i:i + n] for i in range(max(0, len(s) - n + 1))}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / len(a | b) if inter else 0.0


def load(con):
    rows = [dict(r) for r in con.execute(
        "SELECT id, kind, content, summary, importance, created_at, updated_at, "
        "tags_json, metadata_json, source FROM memory_items "
        "WHERE scope_type='agent' AND scope_id='workbuddy'")]
    for r in rows:
        for key, src in (("tags", "tags_json"), ("meta", "metadata_json")):
            try:
                v = json.loads(r[src]) if r[src] else ([] if key == "tags" else {})
            except Exception:
                v = [] if key == "tags" else {}
            r[key] = v if isinstance(v, (list, dict)) else ([] if key == "tags" else {})
    return rows


def scan_exact_dups(rows):
    groups = defaultdict(list)
    for r in rows:
        groups[sha16(r["content"])].append(r)
    return [v for v in groups.values() if len(v) > 1]


# 🔴 面包屑剥离（与 ops/ingest-daily-logs.py 的 BREADCRUMB_RE 同口径）：
# 两个回流执行器（语义层 13k1c / 哨兵 ops）给同一段正文加的面包屑格式不同——
# legacy 写 `[日期·标题] 正文`、v3 写 `[日期·标题·序号/总] 正文`。故「全文 SHA256」
# 永远判它们不同（这是「周整清了 90 条、次日又长出来」的机制性原因）。
# 剥壳后再比，才看得见「同一段正文」。
_BREADCRUMB_RE = re.compile(r"^\[(?:[^\[\]]|\[[^\]]*\]){0,200}\]\s*")


def _bare(s):
    """剥面包屑 + 去全部空白 → 正文指纹的材料（与 ingest 侧 normalize 同义）。"""
    return re.sub(r"\s+", "", _BREADCRUMB_RE.sub("", s or ""))


def scan_executor_dups(rows):
    """🔴 双执行器同文重复（2026-11-03 立，事故驱动）。

    判据：**同 source_file + 同 section + 剥壳后正文相同** ⇒ 同一段 daily 内容被两个
    执行器各入一次。限定 section 是为了不误伤「不同节引用同一段话」的合法情形
    （实测全库 39 组剥壳重复里，7 组属此类，不该删）。

    为什么单列一段：`scan_exact_dups`（全文 SHA256）抓不到它，`scan_near_dups`
    （3-gram Jaccard≥0.72）抓得到但**只是"近重复"，SKILL 步骤 4 的删除动作不消费该段**——
    报告了却没人处置，故复发不止。本段把「可删」与「仅提示」分开：返回的组即为
    可机械判定的真重复（择一保留），并要求调用方核对 v3/legacy 构成再动手。
    """
    groups = defaultdict(list)
    for r in rows:
        meta = r.get("meta") or {}
        sf = meta.get("source_file")
        sec = meta.get("section")
        if not sf or not sec:
            continue  # 非 daily 回流条目，不属本判据范围
        # （续N）后缀归一：同一节的两个增量块在 legacy/v3 下后缀写法一致，但保险起见剥掉
        sec_key = re.sub(r"（续\d+）$", "", sec)[:40]
        bare = _bare(r["content"])
        if not bare:
            continue
        groups[(os.path.basename(sf), sec_key,
                hashlib.md5(bare.encode()).hexdigest()[:16])].append(r)
    out = []
    for (sf, sec, fp), v in groups.items():
        if len(v) < 2:
            continue
        # 标注版本构成，供人工/自动择一：v3 带 chunk.span（可溯源）优于 legacy
        for r in v:
            r["_has_span"] = bool((r.get("meta") or {}).get("chunk", {}).get("span"))
        keep = next((r for r in v if r["_has_span"]), v[0])
        out.append({
            "source_file": sf, "section": sec, "fp": fp, "n": len(v),
            "has_span": sum(1 for r in v if r["_has_span"]),
            "keep_id": keep["id"],
            "drop_ids": [r["id"] for r in v if r["id"] != keep["id"]],
            "members": [{"id": r["id"], "kind": r["kind"], "date": (r["created_at"] or "")[:10],
                         "span": r["_has_span"]} for r in v],
        })
    return out


def scan_fragments(rows):
    clusters = defaultdict(list)
    for r in rows:
        tl = r["tags"] if isinstance(r["tags"], list) else []
        clusters[((r["created_at"] or "")[:10], tl[0] if tl else "(no-tag)")].append(r)
    out = []
    for (d, main), v in clusters.items():
        if len(v) < 3:
            continue
        gs = [(r, grams(r["content"])) for r in v]
        jacs = [jaccard(ga, gb) for (_, ga), (_, gb) in combinations(gs, 2) if ga and gb]
        if not jacs:
            jacs = [0.0]
        mx = max(jacs)
        out.append({
            "date": d, "tag": main, "n": len(v),
            "avg_len": int(sum(len(r["content"]) for r in v) / len(v)),
            "max_jac": round(mx, 3),
            "avg_jac": round(sum(jacs) / len(jacs), 3),
            "high_pairs": sum(1 for j in jacs if j >= COHESION_THRESHOLD),
            "is_fragment": mx >= COHESION_THRESHOLD,
            "ids": [r["id"] for r in v],
        })
    return sorted(out, key=lambda x: -x["max_jac"])


def scan_near_dups(rows):
    recs = []
    for r in rows:
        g = grams(r["content"])
        if len(norm(r["content"])) > 80 and g:
            recs.append((r, g))
    inv = defaultdict(list)
    for idx, (_, g) in enumerate(recs):
        for gr in g:
            inv[gr].append(idx)
    counter = defaultdict(int)
    for gr, idxs in inv.items():
        if len(idxs) > 600 or len(idxs) < 2:   # 高频 gram 跳过：噪声大且开销高
            continue
        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                counter[(idxs[a], idxs[b])] += 1
    out = []
    for (i, j), common in counter.items():
        ri, gi = recs[i]
        rj, gj = recs[j]
        if common < 0.5 * min(len(gi), len(gj)):
            continue
        jac = common / (len(gi) + len(gj) - common)
        if jac >= NEAR_DUP_THRESHOLD:
            out.append({
                "jac": round(jac, 3), "common": common,
                "a": {"id": ri["id"], "kind": ri["kind"], "date": ri["created_at"][:10],
                      "head": norm(ri["content"])[:110]},
                "b": {"id": rj["id"], "kind": rj["kind"], "date": rj["created_at"][:10],
                      "head": norm(rj["content"])[:110]},
            })
    return sorted(out, key=lambda x: -x["jac"])


def scan_long(rows):
    out = []
    for r in rows:
        if len(r["content"] or "") > LONG_CHARS:
            out.append({
                "id": r["id"], "kind": r["kind"], "len": len(r["content"]),
                "content_eq_summary": norm(r["content"]) == norm(r["summary"]),
                "head": norm(r["content"])[:60],
            })
    return out


def scan_distill(rows, days):
    cutoff = (__import__("datetime").date.today() -
              __import__("datetime").timedelta(days=days)).isoformat()
    lessons = [r for r in rows if r["kind"] == "lesson" and (r["created_at"] or "") >= cutoff]
    tagc = defaultdict(list)
    for r in lessons:
        for t in (r["tags"] if isinstance(r["tags"], list) else []):
            if t and not t.isdigit() and t not in ("lesson", "principle", "reflected"):
                tagc[t].append(r)
    candidates = [{"tag": k, "n": len(v),
                   "ids": [r["id"] for r in v],
                   "heads": [norm(r["content"])[:95] for r in v[:8]]}
                  for k, v in sorted(tagc.items(), key=lambda kv: -len(kv[1])) if len(v) >= 3]

    prin = [r for r in rows if r["kind"] == "principle"]
    allids = {r["id"] for r in rows}
    missing = []
    for p in prin:
        sup = (p["meta"] or {}).get("supports") or []
        if isinstance(sup, list):
            for s in sup:
                if s not in allids:
                    missing.append({"principle": p["id"], "support": s})
    return {"lessons": len(lessons), "candidates": candidates,
            "principles": len(prin), "supports_missing": missing}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--days", type=int, default=30, help="蒸馏候选回看天数")
    args = ap.parse_args()

    if not os.path.exists(DB):
        print(f"FATAL: 找不到 {DB}", file=sys.stderr)
        sys.exit(2)
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = load(con)

    result = {
        "total": len(rows),
        "kinds": dict(Counter(r["kind"] for r in rows)),
        "exact_dups": scan_exact_dups(rows),
        "fragment_clusters": scan_fragments(rows),
        "near_dups": scan_near_dups(rows),
        "long_items": scan_long(rows),
        "distill": scan_distill(rows, args.days),
        "executor_dups": scan_executor_dups(rows),
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return

    print(f"TOTAL={result['total']}")
    print(f"kind 分布: {result['kinds']}")

    print(f"\n=== 1. 真重复（全文 SHA256）: {len(result['exact_dups'])} 组 ===")
    for g in result["exact_dups"]:
        print(f"  n={len(g)} :: " + " | ".join(
            f"{r['id']} kind={r['kind']} imp={r['importance']} upd={r['updated_at'][:19]}" for r in g))

    ed = result.get("executor_dups", [])
    print(f"\n=== 1b. 双执行器同文重复（同 file+同 section+剥壳正文相同）: {len(ed)} 组，"
          f"可删 {sum(g['n'] - 1 for g in ed)} 条 ===")
    for g in ed[:20]:
        print(f"  {g['source_file']} | {g['section'][:28]} | n={g['n']} 带span={g['has_span']}"
              f" → 保留 {g['keep_id'][:8]}，删 {','.join(x[:8] for x in g['drop_ids'])}")
    if len(ed) > 20:
        print(f"  …… 共 {len(ed)} 组")
    if ed:
        print("  🔴 处置：保留带 span 的 v3 版；删前必须走 archive_and_purge（先归档再删）。")

    frags = [c for c in result["fragment_clusters"] if c["is_fragment"]]
    print(f"\n=== 2. 碎片簇: 候选 {len(result['fragment_clusters'])} 个，"
          f"其中真碎片簇 {len(frags)} 个（maxJac>={COHESION_THRESHOLD}） ===")
    for c in result["fragment_clusters"][:15]:
        mark = "🔴真碎片簇" if c["is_fragment"] else "独立记忆"
        print(f"  {c['date']} | {c['tag']:<22} n={c['n']:>3} 均长={c['avg_len']:>5} "
              f"maxJac={c['max_jac']:.3f} 均Jac={c['avg_jac']:.3f} 高相似对={c['high_pairs']:<3} {mark}")

    print(f"\n=== 3. 跨日近重复（Jaccard>={NEAR_DUP_THRESHOLD}）: {len(result['near_dups'])} 对 ===")
    for p in result["near_dups"][:20]:
        print(f"  jac={p['jac']:.3f} common={p['common']} | "
              f"{p['a']['id'][:8]}({p['a']['kind']},{p['a']['date']}) <-> "
              f"{p['b']['id'][:8]}({p['b']['kind']},{p['b']['date']})")
        print(f"     A: {p['a']['head']}")
        print(f"     B: {p['b']['head']}")

    print(f"\n=== 4. content>{LONG_CHARS} 字符: {len(result['long_items'])} 条 ===")
    for r in result["long_items"][:12]:
        flag = "⚠️畸形(content==summary)" if r["content_eq_summary"] else "合法长文"
        print(f"  {r['id'][:8]} len={r['len']} kind={r['kind']} {flag} :: {r['head']}")

    d = result["distill"]
    print(f"\n=== 5. 蒸馏候选（近 {args.days} 天 lesson={d['lessons']}）: "
          f"tag 候选 {len(d['candidates'])} 个 | 现有 principle {d['principles']} 条 ===")
    for c in d["candidates"][:15]:
        print(f"  ■ {c['tag']:<24} n={c['n']}")
        for h in c["heads"][:4]:
            print(f"       {h}")
    print(f"\n  supports 断链: {len(d['supports_missing'])}")
    for m in d["supports_missing"][:10]:
        print(f"     {m['principle'][:8]} -> {m['support']}")


if __name__ == "__main__":
    main()
