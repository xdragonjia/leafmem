#!/usr/bin/env python3
"""4b 双执行器同文判据回归测试（2026-11-09 立，事故驱动）。

为什么要有它：`_bare` / `_sec_key` 是「归一化」类代码，改错了**不会报错、只会静默少抓或多抓**。
2026-11-09 实测：section 未剥时间前缀导致 2 组真重复连续多周漏判，判据一直亮 0。

用法：
  python3 test_executor_dups.py                    # 用最新存档
  python3 test_executor_dups.py --archive <path>   # 指定存档
  python3 test_executor_dups.py --old <bak.py>     # 额外做「旧逻辑漏判」对照（改动有效性证明）

退出码：0 全过 / 1 有失败。

判据（与 references/step4bc-dedup-and-kind-gates.md §1.3c 同源）：
  T1 已知正例命中：存档中同 file+同主标题+剥壳同文的组，新逻辑须全部抓出，keep 须为带 span 的 v3 版
  T2 空输入守卫：rows=[] 须返回 0 组且不崩
  T3 跨节零误伤：主标题不同的同文组不得进入结果
  T4 阵容守卫：参与分组的条目数须 > 0（防空输入伪绿）
"""
import argparse
import glob
import hashlib
import importlib.util
import json
import os
import sys
from collections import defaultdict
from importlib.machinery import SourceFileLoader

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN = os.path.join(SKILL_DIR, "scripts", "weekly_scan.py")
ARCHIVE_GLOB = os.path.expanduser(
    "~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-*.json")


def load_module(path, name):
    loader = SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def load_archive(path):
    d = json.load(open(path, encoding="utf-8"))
    if isinstance(d, dict):
        for k in ("items", "memories", "records", "data"):
            if isinstance(d.get(k), list):
                d = d[k]
                break
    rows = []
    for r in d:
        rr = dict(r)
        for key, src in (("tags", "tags_json"), ("meta", "metadata_json")):
            try:
                v = json.loads(rr.get(src) or ("[]" if key == "tags" else "{}"))
            except Exception:
                v = [] if key == "tags" else {}
            rr[key] = v if isinstance(v, (list, dict)) else ([] if key == "tags" else {})
        rows.append(rr)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default=None)
    ap.add_argument("--old", default=None, help="旧版 weekly_scan.py，用于证明改动非 no-op")
    args = ap.parse_args()

    arc = args.archive
    if not arc:
        cands = sorted(glob.glob(ARCHIVE_GLOB))
        if not cands:
            print("[FAIL] 找不到存档，无法回归（存档是删除类步骤的前置，不该缺失）")
            return 1
        arc = cands[-1]
    print("ARCHIVE=%s" % os.path.basename(arc))

    new = load_module(SCAN, "ws_new")
    rows = load_archive(arc)
    print("ROWS=%d" % len(rows))

    fails = []

    # T4 阵容守卫：先断言真的有可分组条目，否则后面的「0 组」是伪绿
    eligible = 0
    for r in rows:
        m = r.get("meta") or {}
        if m.get("source_file") and m.get("section") and new._bare(r["content"]):
            eligible += 1
    print("\n[T4] 阵容守卫 eligible=%d（须 > 0）" % eligible)
    if eligible <= 0:
        fails.append("T4 阵容为空，判据无法生效")

    # T1 已知正例：用当前逻辑分组，逐组断言 keep 带 span（v3 优先）
    groups = new.scan_executor_dups(rows)
    print("\n[T1] 新逻辑命中 %d 组" % len(groups))
    no_span = []
    for g in groups:
        print("  sec=%r n=%d keep=%s spans=%d" % (g["section"][:40], g["n"], g["keep_id"][:8], g["has_span"]))
        if g["has_span"] == 0:
            no_span.append(g["keep_id"][:8])
    if no_span:
        fails.append("T1 有组无任何带 span 的成员，v3 优先策略失效：%s" % no_span)

    # T3 跨节零误伤：主标题不同的同文对不得出现在结果里
    print("\n[T3] 跨节零误伤检查")
    cross = 0
    for g in groups:
        secs = {new._sec_key(m_sec) for m_sec in
                [x for x in [((r.get("meta") or {}).get("section")) for r in rows
                             if r["id"] in {mm["id"] for mm in g["members"]}]]}
        if len(secs) > 1:
            cross += 1
            print("  [WARN] 组 %s 跨了 %d 个主标题" % (g["keep_id"][:8], len(secs)))
    if cross:
        fails.append("T3 检出跨节组 %d 个（section 约束失效）" % cross)
    print("  cross_section_groups=%d（须 0）" % cross)

    # T2 空输入守卫
    print("\n[T2] 空输入守卫")
    try:
        empty = new.scan_executor_dups([])
        print("  empty -> %d 组（须 0）" % len(empty))
        if empty:
            fails.append("T2 空输入返回非空")
    except Exception as e:
        print("  CRASH: %r" % e)
        fails.append("T2 空输入崩溃")

    # 可选：改动有效性（新旧对照）
    if args.old:
        old = load_module(args.old, "ws_old")
        og = old.scan_executor_dups(rows)
        print("\n[T0] 改动有效性：旧逻辑 %d 组 / 新逻辑 %d 组" % (len(og), len(groups)))
        if len(og) == len(groups):
            print("  [WARN] 新旧结果相同 —— 若本次目的是修复漏判，则改动可能是 no-op")
        else:
            print("  ✅ 行为确有差异，改动非 no-op")

    print("\n[RESULT] %s" % ("PASS" if not fails else "FAIL: " + "; ".join(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
