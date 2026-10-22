#!/usr/bin/env python3
"""ingest-daily-logs.py — 把每日记忆 md 回流进 LeafMem（episodic 层），v3 结构分块版

为什么需要它：agent 每天产出的工作日志（daily md）本身就是"已蒸馏"的高密度事件/教训层，
不回流就等于一次性丢弃。回流后 recall / 图谱 / 周维整都能复用。

用法：
  python3 ops/ingest-daily-logs.py                    # 默认源，增量入库
  python3 ops/ingest-daily-logs.py --dry-run          # 只打印将入库内容（不写库）
  python3 ops/ingest-daily-logs.py --selftest         # 对源全量跑「分块 + 无损校验」
  python3 ops/ingest-daily-logs.py --rebuild-state    # 从记忆库反推 state（自愈）
  python3 ops/ingest-daily-logs.py --state /tmp/x.json --source work=~/notes/daily

机制要点（踩过的坑都写在这里）：
  1. 按 `## ` 切节；只有 `YYYY-MM-DD.md` 参与（防 DETAIL/缓存文件污染）。
  2. **分块用 ops/daily_chunker.py**：结构感知（段落/列表/表格/代码块为边界，表格与代码块原子）
     + 句边界二次细分 + 目标 900 字 / 下限 350 / 硬上限 5200，**不做 embedding 语义分块**
     （NAACL 2025 实证：成本换不来收益，且易过碎）。
  3. **面包屑标题前缀写进正文**（`[日期·节标题·k/n]`）：混合检索（向量 + 词法）两侧都看得到
     标题词，零 LLM 成本（Anthropic contextual retrieval 同族做法）。
  4. **父块锚点**：metadata 带 source_file / section / chunk{index,of,chars,span}，
     命中小块后可回读整节或原文区间（small-to-big）。
  5. **增量按字符偏移续写**（state.secs[key].offset）：节尾追加只入新增区间，块边界不再
     重算——避免 v2「整节重切 + 『续N』按行硬切」导致的重复与丢字。
  6. **写入传 dedupe=false**：分块器已按块做精确幂等，服务端 0.85 模糊合并会把同节兄弟块
     （实测相邻块相似度均值 0.647、极值 0.917）覆盖成一条 = 丢知识。
  7. state 只在**发送成功后**记账；失败条目下轮自动重试。`--rebuild-state` 可从库内
     metadata 反推 offset，彻底避免"state 丢了就整批重导"（2026-10-21 事故根因）。
  8. 只读源文件，绝不改写。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from daily_chunker import (  # noqa: E402
    CHUNK_MAX,
    sections,
    split_section,
    verify_lossless,
    squeeze,
    normalize,
)

DATE_FILE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\.md$")
GROW_THRESHOLD = 40          # 节尾追加小于此值视为无变化
STATE_VERSION = 3
SCHEMA_TAG = "v3-structural"


def api_key(cli_key: str | None) -> str:
    if cli_key:
        return cli_key
    env = os.environ.get("LEAFMEM_API_KEY")
    if env:
        return env
    cfg = Path.home() / ".leafmem" / "agent-service.json"
    if cfg.exists():
        return json.loads(cfg.read_text()).get("apiKey", "")
    return ""


def post_batch(api: str, key: str, items: list) -> None:
    req = urllib.request.Request(
        f"{api}/v1/memories/batch",
        data=json.dumps({"memories": items}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        r.read()


def parse_sources(specs: list[str]):
    srcs = []
    for spec in specs:
        if "=" not in spec:
            spec = f"src={spec}"
        tag, path = spec.split("=", 1)
        srcs.append((tag.strip(), Path(os.path.expanduser(path.strip()))))
    return srcs


def align_boundary(body: str, off: int, back: int = 300) -> int:
    """把增量起点对齐到干净的语义边界（换行/句末标点），最多回退 back 字。

    块尾天然落在结构或句边界上，正常情况下不触发；若上游 offset 漂移或节被硬切，
    回退产生的重复由块指纹（state.seen）吸收，不会真的重复入库。
    """
    if off <= 0 or off >= len(body):
        return off
    if body[off - 1] in "\n。！？；!?;":
        return off
    for i in range(off, max(0, off - back) - 1, -1):
        if i > 0 and body[i - 1] in "\n。！？；!?;":
            return i
    return off


def sec_key(file_key: str, title: str) -> str:
    return f"{file_key}:{hashlib.md5(title.encode()).hexdigest()[:10]}"


def rebuild_state(db_path: str, state_path: str) -> int:
    """从记忆库 metadata 反推每节已入偏移 → 重建 state（自愈，防整批重导）。"""
    db = Path(os.path.expanduser(db_path))
    if not db.exists():
        print(f"❌ 库不存在：{db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=20)
    rows = con.execute(
        "select metadata_json from memory_items where metadata_json like ?", (f"%{SCHEMA_TAG}%",)
    ).fetchall()
    con.close()
    secs: dict[str, dict] = {}
    for (mj,) in rows:
        try:
            m = json.loads(mj)
        except Exception:
            continue
        sf, sec = m.get("source_file"), m.get("section")
        ch = m.get("chunk") or {}
        if not sf or not sec or "span" not in ch:
            continue
        k = sec_key(Path(sf).name, sec)
        cur = secs.setdefault(k, {"offset": 0, "n": 0})
        cur["offset"] = max(cur["offset"], int(ch["span"][1]))
        cur["n"] = max(cur["n"], int(ch.get("index_total") or 0))
    state = {"version": STATE_VERSION, "secs": secs, "seen": {}}
    Path(state_path).parent.mkdir(parents=True, exist_ok=True)
    Path(state_path).write_text(json.dumps(state, ensure_ascii=False))
    print(f"=== state 已重建：{len(secs)} 节（{len(rows)} 条 v3 记录）→ {state_path} ===")
    return 0


def run_selftest(specs: list[str] | None) -> int:
    from daily_chunker import selftest
    dirs = [str(Path.home() / ".workbuddy" / "memory")]
    if specs:
        dirs = [str(p) for _, p in parse_sources(specs)]
    return selftest(dirs)


def main() -> int:
    ap = argparse.ArgumentParser(description="回流 daily md 到 LeafMem（结构分块 · 增量 · 无损）")
    ap.add_argument("--source", action="append", default=None,
                    help="tag=path，可重复；默认 user-daily=~/.workbuddy/memory")
    ap.add_argument("--api", default=os.environ.get("LEAFMEM_API", "http://127.0.0.1:3377"))
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--state", default=str(Path.home() / ".leafmem" / "daily-ingest-state.json"))
    ap.add_argument("--scope", default="agent:workbuddy",
                    help="写入 scope（不传会落 project scope 导致跨宿主召回不到）")
    ap.add_argument("--max-len", type=int, default=CHUNK_MAX)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="只跑分块无损自检，不写库")
    ap.add_argument("--rebuild-state", action="store_true", help="从库内 metadata 反推 state")
    ap.add_argument("--db", default=str(Path.home() / ".leafmem" / "memory.sqlite"),
                    help="--rebuild-state 读取的库路径（只读）")
    ap.add_argument("--dedupe", action="store_true",
                    help="保留服务端模糊去重（默认关闭：分块摄入已做精确幂等，模糊合并会丢块）")
    ap.add_argument("--force-fresh", action="store_true",
                    help="确认这是一次全新导入。state 文件缺失时必须显式加此参数")
    args = ap.parse_args()

    if args.selftest:
        return run_selftest(args.source)
    if args.rebuild_state:
        return rebuild_state(args.db, args.state)

    # 🔴 fail-safe（2026-10-22）：去重靠 state 的 offset 记账，state 缺失时整批历史 daily md
    # 会被当作全新导入重复入库（2026-10-21 首跑后 state 未留存，实测重跑 = 2698 节）。
    # 缺失时一律拦下；可先用 --rebuild-state 自愈，确属首次导入再加 --force-fresh。
    if not Path(args.state).exists() and not args.force_fresh:
        print(
            f"❌ state 文件不存在：{args.state}\n"
            "   增量记账依赖该文件；缺失状态下运行会把全部历史 daily 节当新内容重复入库。\n"
            "   → 先跑 --rebuild-state 从库内 metadata 自愈，或确认首次导入后加 --force-fresh。",
            file=sys.stderr,
        )
        return 3

    specs = args.source or [f"user-daily={Path.home() / '.workbuddy' / 'memory'}"]
    sources = parse_sources(specs)
    existing = [(t, d) for t, d in sources if d.exists()]
    if not existing:
        print(f"❌ 所有源目录都不存在: {[str(d) for _, d in sources]}", file=sys.stderr)
        return 2
    for t, d in sources:
        if not d.exists():
            print(f"⚠️  跳过不存在的源: {d}（{t}）")

    state_path = Path(args.state)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state.get("version") != STATE_VERSION:
        state = {"version": STATE_VERSION, "secs": {}}
    secs: dict[str, dict] = state.setdefault("secs", {})
    seen: dict[str, int] = state.setdefault("seen", {})
    key = api_key(args.api_key)

    batch: list[dict] = []
    n_sec_new = n_skip = 0
    loss_bad = 0
    for tag, d in existing:
        for f in sorted(d.glob("*.md")):
            if not DATE_FILE_RE.search(f.name):
                continue
            date = f.stem
            text = f.read_text(encoding="utf-8", errors="replace")
            for title, body in sections(text):
                body_n = normalize(body)
                if len(body_n) < 30:                       # 纯指针型短节无知识量
                    n_skip += 1
                    continue
                k = sec_key(f.name, title)
                st = secs.setdefault(k, {"offset": 0, "n": 0})
                off = align_boundary(body_n, int(st.get("offset", 0)))
                if len(body_n) - off <= GROW_THRESHOLD:
                    continue
                delta = body_n[off:]
                cont = off > 0
                title_for_crumb = f"{title}（续）" if cont else title
                chunks = split_section(delta, date, title_for_crumb,
                                       max_chars=args.max_len, normalized=True,
                                       continued=cont, seq_base=int(st.get("n", 0)))
                if not chunks:
                    continue
                ok, why = verify_lossless(delta, chunks, normalized=True)
                if not ok:
                    loss_bad += 1
                    print(f"❌ 无损校验失败（跳过该节，不写库）{f.name} :: {title[:30]} → {why}",
                          file=sys.stderr)
                    continue
                base_chunk_no = int(st.get("n", 0))
                emitted = 0
                for c in chunks:
                    s, e = c["span"]
                    fp = hashlib.md5((k + c["bare"]).encode()).hexdigest()[:16]
                    if fp in seen:          # 已入过（回退重叠 / 内容未变）
                        continue
                    emitted += 1
                    batch.append({
                        "content": c["text"][:6000],
                        "kind": "experience",
                        "scope": args.scope,
                        "tags": ["daily-log", tag, date],
                        "dedupe": bool(args.dedupe),
                        "metadata": {
                            "source_file": str(f),
                            "section": title[:80],
                            "doc_date": date,
                            "chunk": {
                                "index": c["index"],              # 本段内序号
                                "segment_total": c["of"],         # 本次入库段块数
                                "seq": base_chunk_no + c["index"],  # 全局块号（跨增量）
                                "chars": c["chars"],
                                "span": [off + s, off + e],       # 规范化 body 中的绝对区间
                                "continued": cont,
                            },
                            "schema": SCHEMA_TAG,
                            "ingested_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
                        },
                        "_fk": f.name, "_sec": k,
                        "_fp": fp,
                        "_end": off + max(cc["span"][1] for cc in chunks),
                        "_n": base_chunk_no + len(chunks),
                    })
                if emitted == 0:            # 整节已入，仅推进 offset 免得每轮重算
                    st["offset"] = max(int(st.get("offset", 0)),
                                       off + max(cc["span"][1] for cc in chunks))
                    continue
                n_sec_new += 1

    if not batch:
        print("=== 无新增（全部已入） ===")
        return 0

    if args.dry_run:
        for it in batch[:12]:
            ch = it["metadata"]["chunk"]
            label = f"续块{ch['seq']}" if ch["continued"] else \
                    f"块{ch['index']}/{ch['segment_total']}"
            print(f"[dry-run] {it['tags'][2]} · {it['metadata']['section'][:34]} · {label} "
                  f"· {len(it['content'])} 字")
        if len(batch) > 12:
            print(f"[dry-run] …… 共 {len(batch)} 块 / {n_sec_new} 节")
        print(f"=== dry-run：将入库 {len(batch)} 块 ===")
        return 0

    ok = fail = 0
    for i in range(0, len(batch), 40):
        chunk = batch[i:i + 40]
        payload = [{k2: v for k2, v in it.items() if not k2.startswith("_")} for it in chunk]
        try:
            post_batch(args.api, key, payload)
            ok += len(chunk)
            for it in chunk:
                st = secs.setdefault(it["_sec"], {"offset": 0, "n": 0})
                st["offset"] = max(int(st.get("offset", 0)), it["_end"])
                st["n"] = max(int(st.get("n", 0)), it["_n"])
                seen[it["_fp"]] = 1
        except Exception:
            for it in chunk:                               # 降级逐条，坏条目不拖累整批
                try:
                    post_batch(args.api, key,
                               [{k2: v for k2, v in it.items() if not k2.startswith("_")}])
                    ok += 1
                    st = secs.setdefault(it["_sec"], {"offset": 0, "n": 0})
                    st["offset"] = max(int(st.get("offset", 0)), it["_end"])
                    st["n"] = max(int(st.get("n", 0)), it["_n"])
                    seen[it["_fp"]] = 1
                except Exception:
                    fail += 1
    state_path.parent.mkdir(parents=True, exist_ok=True)
    if len(seen) > 50000:
        seen = dict(list(seen.items())[-50000:])
    state_path.write_text(json.dumps({"version": STATE_VERSION, "secs": secs, "seen": seen},
                                     ensure_ascii=False))
    print(f"=== 回流完成：入库 {ok} 块 / 失败 {fail}（失败项下轮自动重试）"
          f"｜跳过短节 {n_skip}｜无损校验失败 {loss_bad} ===")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
