#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pattern_compliance.py — 存量 principle/lesson「模式三件套」完备率实测量尺 v1.0（2026-11-19）

为什么必须有本脚本（步骤 4d 判据实跑化）：步骤 4d 此前只有自然语言「全量扫→补写」，
无命令、无产物、无基线 ⇒ 属「纸面判据与代码脱节」同族（存量回补不可达第 2 例）。
本脚本把判据落成可执行命令：扫全库 principle/lesson，按三件套（命名模式／触发情境／
适用边界）逐项判定，产出完备率基线与「待提炼」清单。

判据（与 SKILL.md 步骤 4d／references/pattern-triad.md 同口径）：
  - pattern 命中：metadata.pattern 非空，或 summary 首句为「<2~8 字短语>：」形态
    （可迁移短语），或 content 含命名模式标记（「XX闭环」「XX形态」「XX唤起」「XX注入」
    等模式后缀词族）。
  - trigger_context 命中：metadata.trigger_context 非空。
  - applicability 命中：metadata.applicability 非空，或 content 含边界词
    （适用／不适用／边界／禁用于／仅当）。

用法：
    pattern_compliance.py                # 输出报告（stdout），不落盘
    pattern_compliance.py --out runs/pattern_compliance_<date>.json
    pattern_compliance.py --self-test    # 判据自检（正负例）
退出码：0 正常出报告（含完备率）｜3 自检失败
分母守卫：total=0 时 rate 标 'N/A'，禁写 100%。
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB = Path.home() / '.leafmem/memory.sqlite'
CST = timezone(timedelta(hours=8))

PATTERN_SUFFIX = re.compile(r'闭环|形态|唤起|注入|走查|脱节|归类|提炼|守卫|闸门|对账|闭环')
# 🔴 2026-11-19 自查修正：通用前缀（「原则：」「# 原则：」「🔴」「【发现·」等）
#   不算命名模式——35 条以「原则：」开头的条目若按旧正则会被误判为已命名。
#   命名模式须是**可迁移的具体短语**（如「QA 闭环」「判据形态」），
#   通用前缀剥离后才判「<短语>：」形态。
GENERIC_PREFIX = re.compile(r'^(?:[#\s]*原则[：:]|[#\s]*发现[·：:]|🔴+|【[^】]{0,20}】)\s*')
SUMMARY_NAMED = re.compile(r'^[^，。；：:]{2,10}[：:]')   # 「<短语>：」起首（剥前缀后）
BOUNDARY_WORD = re.compile(r'适用|不适用|边界|禁用于|仅当|限于|不适用于')


def classify(row: dict) -> dict:
    meta_raw = row.get('metadata_json') or '{}'
    try:
        meta = json.loads(meta_raw)
    except (json.JSONDecodeError, TypeError):
        meta = {}
    summary = row.get('summary') or ''
    content = row.get('content') or ''
    stripped = GENERIC_PREFIX.sub('', summary).lstrip('# \t')
    has_pattern = bool(meta.get('pattern')) or bool(SUMMARY_NAMED.match(stripped)) \
        or bool(PATTERN_SUFFIX.search(stripped))
    has_ctx = bool(meta.get('trigger_context'))
    has_bound = bool(meta.get('applicability')) or bool(BOUNDARY_WORD.search(content))
    return {'pattern': has_pattern, 'trigger_context': has_ctx, 'applicability': has_bound,
            'complete': has_pattern and has_ctx and has_bound}


def scan(db_path: Path = DB) -> dict:
    if not db_path.exists():
        return {'error': f'DB 不存在: {db_path}', 'total': 0, 'rate': 'N/A', 'items': []}
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "select id, kind, summary, content, metadata_json from memory_items "
        "where kind in ('principle','lesson')").fetchall()
    conn.close()
    items, complete = [], 0
    for r in rows:
        d = dict(r)
        c = classify(d)
        if c['complete']:
            complete += 1
        else:
            missing = [k for k in ('pattern', 'trigger_context', 'applicability') if not c[k]]
            items.append({'id': d['id'][:8], 'kind': d['kind'],
                          'summary': (d['summary'] or '')[:60], 'missing': missing})
    total = len(rows)
    rate = f'{complete / total * 100:.1f}%' if total else 'N/A'
    return {'total': total, 'complete': complete, 'rate': rate,
            'missing_named': sum(1 for r in rows if not classify(dict(r))['pattern']),
            'missing_context': sum(1 for r in rows if not classify(dict(r))['trigger_context']),
            'missing_boundary': sum(1 for r in rows if not classify(dict(r))['applicability']),
            'pending_items': items[:50],
            'generated_at': datetime.now(CST).isoformat(timespec='seconds')}


def self_test() -> int:
    cases = [
        ('正例1 三件套齐备', {'summary': 'QA闭环：管道必配', 'content': '',
         'metadata_json': json.dumps({'pattern': 'QA闭环', 'trigger_context': '采集→质量闸',
                                      'applicability': '确定性管道适用'})}, True),
        ('正例2 summary 命名＋content 边界', {'summary': '负例注入：判据须能变红',
         'content': '仅适用于判据类场景', 'metadata_json': json.dumps({'trigger_context': 'x'})}, True),
        ('负例1 裸 principle（实例描述无三件套）', {'summary': '11-19 索引修复',
         'content': '今天修了索引', 'metadata_json': '{}'}, False),
        ('负例2 有 pattern 缺情境', {'summary': 'QA闭环：管道必配',
         'content': '', 'metadata_json': json.dumps({'pattern': 'QA闭环'})}, False),
        ('负例3 实例名不算命名模式', {'summary': 'fail_tracker.py 机制上线',
         'content': '', 'metadata_json': '{}'}, False),
        ('负例4 通用前缀「原则：」不算命名模式', {'summary': '原则：聚合列表页门禁多层防御',
         'content': '', 'metadata_json': '{}'}, False),
        ('正例3 剥通用前缀后的真命名算', {'summary': '原则：QA 闭环：采集管道必配',
         'content': '', 'metadata_json': json.dumps({'trigger_context': 'x', 'applicability': 'y'})}, True),
    ]
    ok = 0
    for name, row, expect in cases:
        got = classify(row)['complete']
        good = got == expect
        ok += good
        print(f'  {"✅" if good else "🔴"} {name}: complete={got} 期望={expect}')
    print(f'自检 {ok}/{len(cases)}')
    return 0 if ok == len(cases) else 3


def main() -> int:
    ap = argparse.ArgumentParser(description='模式三件套完备率量尺')
    ap.add_argument('--out', default=None, help='报告落盘路径（可选）')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    r = scan()
    if 'error' in r:
        print('❌', r['error'])
        return 1
    print(f"模式三件套完备率: {r['rate']}（{r['complete']}/{r['total']}）")
    print(f"缺命名 {r['missing_named']}｜缺情境 {r['missing_context']}｜缺边界 {r['missing_boundary']}")
    print(f"待提炼 {len(r['pending_items'])} 条（前 5 条）:")
    for it in r['pending_items'][:5]:
        print(f"  {it['id']} [{it['kind']}] {it['summary']} 缺:{'/'.join(it['missing'])}")
    if a.out:
        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'报告已落盘 {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
