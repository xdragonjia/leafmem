#!/usr/bin/env python3
"""ingest-daily-logs.py — 把每日记忆 md 回流进 LeafMem（episodic 层）

为什么需要它：agent 每天产出的工作日志（daily md）本身就是"已蒸馏"的高密度事件/教训层，
不回流就等于一次性丢弃。回流后 recall / 图谱 / 周维整都能复用。

用法：
  python3 ops/ingest-daily-logs.py                       # 默认源，增量入库
  python3 ops/ingest-daily-logs.py --dry-run             # 只打印将入库内容
  python3 ops/ingest-daily-logs.py --source work=~/notes/daily --source team=/shared/memory
  python3 ops/ingest-daily-logs.py --api http://127.0.0.1:3377 --scope agent:workbuddy

机制要点（踩过的坑都写在这里）：
  1. 按 `## ` 节切分，每节一个语义单元；只收 `YYYY-MM-DD.md` 命名的文件（防 DETAIL/缓存文件污染）。
  2. 去重不看"开头指纹"，而是看**已入长度**（state['lens']）——daily md 是 append-only，
     只在节尾追加内容时开头 200 字 hash 不变，用指纹去重会把当天后半天永久丢掉（v0.3.23 修复）。
  3. 节增长 >40 字即把**新增部分**以「（续N）」入库，按行切 ≤4800 字/段（LeafMem 单条上限 6000）。
  4. state 只在发送成功后记账，失败条目下轮自动重试。
  5. 只读源文件，绝不改写。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

DATE_FILE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\.md$")
MAX_LEN_DEFAULT = 5600      # LeafMem 单条硬上限 6000，留前缀余量
CHUNK_TARGET = 4800         # 续写分段目标长度
GROW_THRESHOLD = 40         # 节增长小于此值视为无变化


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


def sections(text: str):
    """按 `## ` 切分；无标题的头部归 '（文件头）'，空壳头（≤80 字且单行）丢弃。"""
    parts = re.split(r"(?m)^## ", text)
    out = []
    for i, p in enumerate(parts):
        if not p.strip():
            continue
        if i == 0 and not text.lstrip().startswith("##"):
            title, body = "（文件头）", p.strip()
            if len(body) <= 80 or body.count("\n") == 0:
                continue
        else:
            nl = p.find("\n")
            title = p[:nl].strip() if nl > 0 else p.strip()[:60]
            body = p[nl:].strip() if nl > 0 else ""
        if body:
            out.append((title, body))
    return out


def chunk_text(delta: str, target: int = CHUNK_TARGET):
    """按行切；单行本身超 target 时硬切（否则整行成一块，最终被 MAX_LEN 截断丢字）。"""
    chunks, cur = [], ""
    for line in delta.split("\n"):
        while len(line) > target:
            if cur.strip():
                chunks.append(cur.strip())
                cur = ""
            chunks.append(line[:target])
            line = line[target:]
        if len(cur) + len(line) + 1 > target:
            if cur.strip():
                chunks.append(cur.strip())
            cur = line + "\n"
        else:
            cur += line + "\n"
    if cur.strip():
        chunks.append(cur.strip())
    return chunks


def post_batch(api: str, key: str, items: list) -> None:
    req = urllib.request.Request(
        f"{api}/v1/memories/batch",
        data=json.dumps({"memories": items}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        r.read()


def parse_sources(specs: list[str]):
    srcs = []
    for spec in specs:
        if "=" not in spec:
            spec = f"src={spec}"
        tag, path = spec.split("=", 1)
        srcs.append((tag.strip(), Path(os.path.expanduser(path.strip()))))
    return srcs


def main() -> int:
    ap = argparse.ArgumentParser(description="回流 daily md 到 LeafMem（增量，append-safe）")
    ap.add_argument("--source", action="append", default=None,
                    help="tag=path，可重复；默认 user-daily=~/.workbuddy/memory")
    ap.add_argument("--api", default=os.environ.get("LEAFMEM_API", "http://127.0.0.1:3377"))
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--state", default=str(Path.home() / ".leafmem" / "daily-ingest-state.json"))
    ap.add_argument("--scope", default="agent:workbuddy",
                    help="写入 scope（字符串；不传会落 project scope 导致跨宿主召回不到）")
    ap.add_argument("--max-len", type=int, default=MAX_LEN_DEFAULT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

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
    key = api_key(args.api_key)

    batch, new = [], 0
    for tag, d in existing:
        for f in sorted(d.glob("*.md")):
            if not DATE_FILE_RE.search(f.name):
                continue                            # 只收日期日志
            fk = f.name
            seen = state.get(fk, [])
            lens = state.setdefault("lens", {})
            for title, body in sections(f.read_text()):
                h = hashlib.md5((title + body[:200]).encode()).hexdigest()[:12]
                sec_key = f"{fk}:{hashlib.md5(title.encode()).hexdigest()[:10]}"
                prev_len = lens.get(sec_key)
                base_meta = {"source_file": str(f)}
                if h in seen:
                    if prev_len is None:
                        lens[sec_key] = len(body)   # 首次登记，不重入
                        continue
                    if len(body) <= prev_len + GROW_THRESHOLD:
                        continue
                    delta = body[prev_len:].strip()
                    chunks = chunk_text(delta)
                    for ci, ch in enumerate(chunks, 1):
                        new += 1
                        batch.append({
                            "_h": h, "_fk": fk, "_sec": sec_key, "_len": len(body),
                            "content": f"[{f.stem}·{title[:36]}·续{ci}/{len(chunks)}] {ch[:args.max_len]}",
                            "kind": "experience", "scope": args.scope,
                            "tags": ["daily-log", tag, f.stem],
                            "metadata": {**base_meta, "section": f"{title[:76]}（续{ci}）",
                                         "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                        })
                    continue
                new += 1
                # 🔴 lens 记「实际入库长度」而非全文长度：否则超长节首入只取 max_len，
                # 剩余部分因 lens 已到全文长度而永远不再入（T6 测试实证）
                batch.append({
                    "_h": h, "_fk": fk, "_sec": sec_key, "_len": min(len(body), args.max_len),
                    "content": f"[{f.stem}·{title[:40]}] {body[:args.max_len]}",
                    "kind": "experience", "scope": args.scope,
                    "tags": ["daily-log", tag, f.stem],
                    "metadata": {**base_meta, "section": title[:80],
                                 "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S")},
                })

    if not batch:
        print("=== 无新增（全部已入）===")
        return 0
    if args.dry_run:
        for it in batch:
            print(f"[dry-run] {it['tags'][2]} · {it['metadata']['section'][:40]} · {len(it['content'])} 字")
        print(f"=== dry-run：将入库 {len(batch)} 节 ===")
        return 0

    ok = fail = 0
    for i in range(0, len(batch), 50):
        chunk = batch[i:i + 50]
        payload = [{k: v for k, v in it.items() if not k.startswith("_")} for it in chunk]
        try:
            post_batch(args.api, key, payload)
            ok += len(chunk)
            for it in chunk:
                state.setdefault(it["_fk"], []).append(it["_h"])
                if it.get("_sec") and it.get("_len") is not None:
                    state.setdefault("lens", {})[it["_sec"]] = it["_len"]
        except Exception:
            for it in chunk:                        # 降级逐条，坏条目不拖累整批
                try:
                    post_batch(args.api, key, [{k: v for k, v in it.items() if not k.startswith("_")}])
                    ok += 1
                    state.setdefault(it["_fk"], []).append(it["_h"])
                    if it.get("_sec") and it.get("_len") is not None:
                        state.setdefault("lens", {})[it["_sec"]] = it["_len"]
                except Exception:
                    fail += 1
    for fk in list(state):
        if isinstance(state[fk], list):
            state[fk] = state[fk][-500:]
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False))
    print(f"=== 回流完成: 入库 {ok} 节 / 失败 {fail}（失败项下轮自动重试）===")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
