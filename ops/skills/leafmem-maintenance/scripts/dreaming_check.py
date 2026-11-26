#!/usr/bin/env python3
"""dreaming_check — R1 记忆离线校验候选生成器（B98，2026-11-26，Personal Agent 调研吸收 Anthropic Dreaming）。

方向门禁：适用对象=LeafMem 高重要性记忆的真值保鲜；北极星=同向（错记忆是错误决策的放大器，
09-20 privacy 事故实证「记忆是隐蔽污染源」）。

职责边界（🔴 只读，禁写库）：
  从 agent:workbuddy 的 lesson/principle/decision（importance>=0.85）中确定性抽 N 条，
  提取正文中的**本机绝对路径**，核对存在性；缺失路径＝「漂移候选」而非「记忆错误」——
  文件可能合法改名/归档。裁决由宿主模型对照证据源（日志/文件现状/DB）逐条做，
  确认漂移走 memory_govern(update/supersede)，本脚本永不直接改记忆。

抽样确定性：seed=ISO周号 → 同周复跑同批（可复核），跨周轮换（覆盖全库）。
守卫：高重要性人群 < GUARD_MIN(50) → exit 2（防「删空/断链后 0 漂移假绿」）。
负例自测：--self-test 在临时目录构造真/假路径样本，断言判据能红能绿，零生产副作用。

用法：
  python3 dreaming_check.py [--sample 20] [--json] [--out PATH] [--self-test]
输出：stdout 摘要 + JSON（默认 runs/dreaming_check_<date>.json，技能目录下）。
exit：0=正常（含 0 候选的可信零）；2=人群守卫失败/自测失败。
"""
import argparse
import datetime
import json
import pathlib
import random
import re
import sqlite3
import sys
import tempfile

DB = pathlib.Path.home() / ".leafmem/memory.sqlite"
GUARD_MIN = 50
KINDS = ("lesson", "principle", "decision")
# 本机绝对路径。🔴 只认 /Users/... 绝对形态：~ 形态会被「反引号紧贴+字符类排除反引号」
# 静默吞掉（11-26 自测抓出）；记忆写作纪律本就要求绝对路径，~ 形态属罕见遗留不追。
PATH_RE = re.compile(r"/Users/[^\s`'\"，。；：）)】\]>]+")


def fetch_candidates(db_path: pathlib.Path):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT id, kind, importance, summary, content, updated_at FROM memory_items "
        "WHERE scope_type='agent' AND scope_id='workbuddy' AND kind IN (?,?,?) AND importance>=0.85",
        KINDS,
    ).fetchall()
    con.close()
    return rows


def extract_paths(text: str):
    out = []
    for m in PATH_RE.findall(text):
        p = m.rstrip(".,;:!?")
        # 🔴 模板/占位/示意路径不是真实引用（11-26 全量复验抓出：{id}/YYYYMMDD/.../xxx
        # 等占位形态被当断链误报）——含占位符或省略号的路径跳过，不产生候选。
        if re.search(r"\{[^}]*\}|YYYY|MMDD|\.\.\.|/xxx\b|（", p):
            continue
        # 🔴 中文顿号/全角逗号是并列分隔不是路径字符（「/Users/、~/、references/」被整串
        # 当路径）；截到首个顿号/全角逗号前，截后不足 3 段＝非真实路径引用，跳过。
        p = re.split(r"[、，]", p)[0]
        if p.count("/") < 3 or "*" in p or "<" in p:
            continue
        if p not in out:
            out.append(p)
    return out


def check_paths(paths):
    missing = []
    for p in paths:
        # 路径尾常粘 md 标点/星号；逐层回退剥尾部装饰再判
        cand = p
        exists = pathlib.Path(cand).exists()
        if not exists:
            cand = re.sub(r"[*_)\]}>]+$", "", cand)
            exists = pathlib.Path(cand).exists()
        if not exists:
            missing.append(p)
    return missing


def run(sample_n: int, db_path: pathlib.Path = DB):
    rows = fetch_candidates(db_path)
    if len(rows) < GUARD_MIN:
        print(f"[FAIL] 人群守卫：高重要性记忆 {len(rows)} < {GUARD_MIN}，疑似库空/口径错，禁报绿")
        return 2, None
    iso = datetime.date.today().isocalendar()
    seed = f"{iso.year}-W{iso.week}"
    rng = random.Random(seed)
    picked = rng.sample(rows, min(sample_n, len(rows)))
    results = []
    for rid, kind, imp, summary, content, updated in picked:
        # 🔴 判据修复（11-26 复验抓出）：已带「dreaming 校验订正」块的记忆＝裁决完成态，
        # 其正文**有意保留**失效旧路径作历史（禁删纪律）——再报候选＝每周重复报已裁决项，
        # 属「存在性断言冒充有效性」同族。订正块之后的正文不参与路径核对。
        body = content or ""
        adjudicated = "dreaming 校验订正" in body
        if adjudicated:
            # 只核对订正块中的**现行路径**。🔴 订正块叙事本身会引用失效旧路径作反例
            # （「X 目录已不存在」），故只取「现行＝/现行路径＝/已换为/升级为」等
            # 现行指向短语后的路径；无现行指向短语＝订正块无可核路径（合法，如纯口径订正）。
            head = body.split("\n---\n", 1)[0]
            paths = []
            for m in re.finditer(r"(?:现行＝|现行路径＝|已换为[^/]*|升级为[^/]*|迁移至|新位置＝)\s*`?(/Users/[^\s`'\"，。；：）)】\]>]+)", head):
                p = m.group(1).rstrip(".,;:!?")
                if p not in paths:
                    paths.append(p)
        else:
            paths = extract_paths(body)
        missing = check_paths(paths)
        results.append({
            "id": rid, "kind": kind, "importance": imp,
            "summary": (summary or "")[:120], "updated_at": updated,
            "paths_total": len(paths), "paths_missing": missing,
            "drift_candidate": bool(missing), "adjudicated": adjudicated,
        })
    drift = [r for r in results if r["drift_candidate"]]
    report = {
        "date": datetime.date.today().isoformat(), "seed": seed,
        "population": len(rows), "sampled": len(results),
        "with_paths": sum(1 for r in results if r["paths_total"]),
        "drift_candidates": len(drift), "details": results,
        "note": "missing path ≠ 记忆错误；宿主须对照证据源裁决后才 govern(update/supersede)",
    }
    print(f"DREAMING population={len(rows)} sampled={len(results)} with_paths={report['with_paths']} drift_candidates={len(drift)} seed={seed}")
    for r in drift:
        print(f"  [候选] {r['id'][:8]} {r['summary'][:60]} missing={r['paths_missing']}")
    return 0, report


def self_test():
    ok = True
    # 🔴 macOS tempfile 落 /var/folders，不匹配 /Users/ 前缀——负例目录必须自建在 /Users 下
    # （11-26 首版自测因此空提取假 FAIL；用后即清，零生产副作用）
    td_obj = tempfile.TemporaryDirectory(prefix="dreaming_selftest_", dir=str(pathlib.Path.home()))
    td = td_obj.name
    with td_obj:
        real = pathlib.Path(td) / "exists.md"
        real.write_text("x")
        fake = str(pathlib.Path(td) / "gone.md")
        # 正例：真实路径不报
        if check_paths([str(real)]):
            print("[SELF-TEST FAIL] 真实路径被误报缺失"); ok = False
        # 负例：不存在路径必报
        if not check_paths([fake]):
            print("[SELF-TEST FAIL] 缺失路径未被抓出（判据永真缺陷）"); ok = False
        # 提取器：中文标点边界
        got = extract_paths(f"证据见 `{real}`，以及 {td}/no_such_dir_xyz/a.md。")
        if str(real) not in got or not any("no_such_dir_xyz" in g for g in got):
            print(f"[SELF-TEST FAIL] 路径提取边界错误: {got}"); ok = False
        # 装饰尾剥离
        if check_paths([str(real) + "**"]):
            print("[SELF-TEST FAIL] md 星号尾未剥离致误报"); ok = False
        # 占位路径过滤（11-26 全量复验新增）：模板形态不得产生候选，真实缺失仍须报
        tpl = extract_paths("模板 /Users/dragon/WorkBuddy/automations/{id}/memory.md 与 /Users/dragon/x/card_YYYYMMDD.json 及 /Users/.../PROJECT.md")
        if tpl:
            print(f"[SELF-TEST FAIL] 占位路径未被过滤: {tpl}"); ok = False
        if not extract_paths(f"真实 {td}/gone_real.md"):
            print("[SELF-TEST FAIL] 占位过滤误伤真实路径"); ok = False
        # 🔴 已裁决记忆豁免（11-26 复验新增负例）：订正块含现行路径＋正文保留失效旧路径
        # → 只核订正块，旧路径不得再报候选；订正块自身断链仍须报（防守恒真）
        adj_ok = (f"🔴 2026-11-26 dreaming 校验订正：现行＝{real}；"
                  f"`{td}/gone.md` 目录已不存在（反例引用不得报）\n---\n旧路径 {td}/gone2.md 保留作历史")
        adj_bad = f"🔴 2026-11-26 dreaming 校验订正：现行＝{td}/also_gone.md\n---\n旧文"
        def _paths_of(body):
            if "dreaming 校验订正" in body:
                head = body.split("\n---\n", 1)[0]
                out = []
                for m in re.finditer(r"(?:现行＝|现行路径＝|已换为[^/]*|升级为[^/]*|迁移至|新位置＝)\s*`?(/Users/[^\s`'\"，。；：）)】\]>]+)", head):
                    p = m.group(1).rstrip(".,;:!?")
                    if p not in out:
                        out.append(p)
                return out
            return extract_paths(body)
        if check_paths(_paths_of(adj_ok)):
            print("[SELF-TEST FAIL] 已裁决记忆的旧路径/反例引用仍被报候选"); ok = False
        if not check_paths(_paths_of(adj_bad)):
            print("[SELF-TEST FAIL] 订正块现行路径断链未报（豁免过宽）"); ok = False
    print(f"SELF-TEST {'PASS 8/8' if ok else 'FAIL'}")
    return 0 if ok else 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    code, report = run(args.sample)
    if report is not None:
        out = pathlib.Path(args.out) if args.out else pathlib.Path(__file__).parent.parent / "runs" / f"dreaming_check_{report['date']}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
        print(f"REPORT={out}")
        if args.json:
            print(json.dumps(report, ensure_ascii=False))
    sys.exit(code)


if __name__ == "__main__":
    main()