#!/usr/bin/env python3
"""daily_chunker.py — daily md 的「结构感知 + 无损」分块器（ingest-daily-logs 的分块内核）

设计依据（2026-10-22 调研，见 CHANGELOG）：
  1. 结构感知优先：Markdown 标题 / 段落 / 列表 / 表格 / 代码块是天然边界
     （"start with section-based chunking when you have headings" 是 2025-2026 业界默认）。
     表格行、fenced code 视为**原子单元**，绝不从中间切开——切表头与数据分离最伤召回。
  2. 不做 embedding 语义分块：NAACL 2025《Is Semantic Chunking Worth the Computational Cost?》
     结论是额外算力换不来稳定收益；某 50 篇论文 benchmark 中语义分块因过碎（均值 43 tokens）
     仅 54%，低于递归 512 tokens 的 69%。语义连续性用「段落/句边界 + 短块合并」保证即可。
  3. 面包屑标题前缀（contextual header）写进**正文**而非只放 metadata：混合检索（向量 + 词法）
     两侧都能看到标题词，零 LLM 成本。Anthropic contextual retrieval 报告可降 top-20 失败率 35%~49%。
  4. 父块锚点：每块带 (source_file, section, index/n, span)，命中小块后可回读整节或原文区间
     —— 即 small-to-big / parent-document 检索的最小实现。

无损不变量（本模块最关键的一条）：
  分块用**原文偏移切片**构建，不重新拼接生成；校验时所有块正文按序拼接与原文各自
  去掉全部空白后必须**逐字符相等**（无丢字、无改写、无重复）。`selftest()` 对真实 daily md 全量断言。
"""
from __future__ import annotations

import re

# 中文语料区间参考 300–800 字，结构感知可取 600–1000；此处取上限侧以兼顾记忆密度与召回精度
CHUNK_TARGET = 900
CHUNK_MIN = 350          # 低于此值尝试与相邻块合并（过碎是语义分块翻车的主因）
CHUNK_MAX = 5200         # 单条正文字数硬上限（LeafMem 单条 6000，留面包屑/summary 余量）
BREADCRUMB_TITLE = 40

_FENCE = re.compile(r"^\s*(```|~~~)")
_TABLE_ROW = re.compile(r"^\s*\|")
_LIST_ITEM = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+")
_SENT_END = re.compile(r"(?<=[。！？；!?;])")
_WS = re.compile(r"\s+")


# ---------------------------------------------------------------- 结构解析
def sections(text: str):
    """按 `## ` 切节；无标题头部归「（文件头）」；空壳头（≤80 字且单行）丢弃。"""
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


_DECOR = re.compile(r"^[-*_]{3,}$")


def normalize(text: str) -> str:
    """统一换行、去行尾空白、剔除纯装饰分隔行（`---`/`***`/`___`）。

    分隔线只是排版符号、无任何知识内容，留作独立块只会产生 3 字的噪声记忆；
    剔除后「无损」判据仍严格成立（对规范化文本逐字符校验）。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    keep = []
    for ln in text.split("\n"):
        ln = ln.rstrip()
        if _DECOR.match(ln.strip()):
            continue
        keep.append(ln)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(keep)).strip()


def squeeze(text: str) -> str:
    """去全部空白，用于无损校验（空白属分隔符，允许在块边界被处理）。"""
    return _WS.sub("", text)


def _blocks(body: str) -> list[tuple[int, int]]:
    """切结构块区间（段落 / 列表组 / 表格 / 代码块），升序不重叠，空隙只含空白。"""
    lines = body.split("\n")
    offs, acc = [], 0
    for ln in lines:
        offs.append(acc)
        acc += len(ln) + 1
    n = len(lines)
    blocks: list[tuple[int, int]] = []
    i = 0
    while i < n:
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        start = offs[i]
        if _FENCE.match(ln):                      # fenced code：整段原子
            fence = _FENCE.match(ln).group(1)
            j = i + 1
            while j < n and not lines[j].strip().startswith(fence):
                j += 1
            j = min(j, n - 1)
            blocks.append((start, offs[j] + len(lines[j])))
            i = j + 1
            continue
        if _TABLE_ROW.match(ln):                  # 表格：连续表格行为原子
            j = i
            while j < n and _TABLE_ROW.match(lines[j]):
                j += 1
            blocks.append((start, offs[j - 1] + len(lines[j - 1])))
            i = j
            continue
        if _LIST_ITEM.match(ln):                  # 列表组（含缩进续行）
            j = i + 1
            while j < n:
                if _LIST_ITEM.match(lines[j]) or lines[j].startswith((" ", "\t")):
                    j += 1
                    continue
                break
            blocks.append((start, offs[j - 1] + len(lines[j - 1])))
            i = j
            continue
        j = i + 1                                 # 普通段落
        while j < n and lines[j].strip() and not _FENCE.match(lines[j]) \
                and not _TABLE_ROW.match(lines[j]) and not _LIST_ITEM.match(lines[j]):
            j += 1
        blocks.append((start, offs[j - 1] + len(lines[j - 1])))
        i = j
    return blocks


def _split_span(body: str, start: int, end: int, limit: int) -> list[tuple[int, int]]:
    """超长结构块二次细分：优先句末标点切，单句超限则硬切。保证每片 ≤ limit。"""
    seg = body[start:end]
    if len(seg) <= limit:
        return [(start, end)]
    cuts = [m.end() for m in _SENT_END.finditer(seg)]
    if not cuts or cuts[-1] != len(seg):
        cuts.append(len(seg))
    pieces: list[tuple[int, int]] = []
    cur = 0
    for c in cuts:
        while c - cur > limit:                    # 单句/单段超限：硬切
            pieces.append((cur, cur + limit))
            cur += limit
        if c > cur:
            pieces.append((cur, c))
            cur = c
    # 合并过短尾片
    merged: list[tuple[int, int]] = []
    for s, e in pieces:
        if merged and (e - s) < CHUNK_MIN // 2 and (e - merged[-1][0]) <= limit:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return [(start + s, start + e) for s, e in merged]


def _crumb(date: str, title: str, k: int, total: int,
           continued: bool = False, seq_base: int = 0) -> str:
    t = (title or "").strip().replace("\n", " ")
    if len(t) > BREADCRUMB_TITLE:
        t = t[:BREADCRUMB_TITLE].rstrip() + "…"
    head = f"[{date}·{t}" if date else f"[{t}"
    if continued:                       # 增量续写：用全局序号，避免「块2/1」这种自相矛盾
        return f"{head}·续{seq_base + k}]"
    return f"{head}·{k}/{total}]" if total > 1 else f"{head}]"


def _merge_small(spans: list[tuple[int, int]], min_chars: int, max_chars: int) -> list[tuple[int, int]]:
    """把过短的块并入相邻块（先试前块，前块已接近上限则并入后块），直到无可并。

    纯装饰行（`---`）与极短尾巴靠这一步吸收；不丢弃任何字符，合并只是放大 span。
    """
    spans = list(spans)
    i = 0
    while i < len(spans):
        s, e = spans[i]
        if e - s >= min_chars or len(spans) == 1:
            i += 1
            continue
        if i > 0 and (e - spans[i - 1][0]) <= max_chars:          # 并入前块
            spans[i - 1] = (spans[i - 1][0], e)
            del spans[i]
            continue
        if i + 1 < len(spans) and (spans[i + 1][1] - s) <= max_chars:  # 并入后块
            spans[i] = (s, spans[i + 1][1])
            del spans[i + 1]
            continue
        i += 1
    return spans


def split_section(body: str, date: str, title: str,
                  target: int = CHUNK_TARGET, min_chars: int = CHUNK_MIN,
                  max_chars: int = CHUNK_MAX, normalized: bool = False,
                  continued: bool = False, seq_base: int = 0) -> list[dict]:
    """切块。返回 [{text(含面包屑), bare, span, index, of, chars}]，span 为 body 偏移。

    normalized=True 时跳过 normalize（调用方已规范化，且需要 span 与原串严格对齐，
    增量续写场景必须如此——否则 normalize 的空白折叠会让偏移漂移）。
    """
    if not normalized:
        body = normalize(body)
    if not body:
        return []
    raw: list[tuple[int, int]] = []
    for s, e in _blocks(body):
        raw.extend(_split_span(body, s, e, max_chars) if e - s > max_chars else [(s, e)])

    packed: list[tuple[int, int]] = []            # greedy 累积到 target
    for s, e in raw:
        if packed and (e - packed[-1][0]) <= target:
            packed[-1] = (packed[-1][0], e)
        else:
            packed.append((s, e))

    merged = _merge_small(packed, min_chars, max_chars)

    total = len(merged)
    out = []
    for k, (s, e) in enumerate(merged, 1):
        bare = body[s:e].strip()
        lead = len(body[s:e]) - len(body[s:e].lstrip())
        out.append({
            "text": f"{_crumb(date, title, k, total, continued, seq_base)} {bare}",
            "bare": bare,
            "span": (s + lead, e - (len(body[s:e]) - len(body[s:e].rstrip()))),
            "index": k,
            "of": total,
            "chars": len(bare),
        })
    return out


def verify_lossless(body: str, chunks: list[dict], normalized: bool = False) -> tuple[bool, str]:
    """无损判据：块正文拼接去空白 == 原文去空白；span 严格升序不重叠不越界。

    normalized=True 表示 body 已是规范化串（增量续写场景），不可再 normalize——
    否则首尾空白被 strip 会让偏移基准与块 span 错位，产生假的「越界」告警。
    """
    body_n = body if normalized else normalize(body)
    joined = squeeze("".join(c["bare"] for c in chunks))
    want = squeeze(body_n)
    if joined != want:
        i = next((i for i in range(min(len(joined), len(want))) if joined[i] != want[i]),
                 min(len(joined), len(want)))
        return False, (f"字符不一致 @{i}（拼 {len(joined)} / 原 {len(want)}）"
                       f" 拼…{joined[max(0, i-20):i+20]!r} 原…{want[max(0, i-20):i+20]!r}")
    prev = -1
    for c in chunks:
        s, e = c["span"]
        if s < prev:
            return False, f"span 重叠/乱序：块{c['index']} ({s},{e}) prev_end={prev}"
        if s < 0 or e > len(body_n):
            return False, f"span 越界：块{c['index']} ({s},{e}) body={len(body_n)}"
        prev = e
    return True, "ok"


# ---------------------------------------------------------------- selftest
def selftest(dirs: list[str]) -> int:
    """对真实 daily md 全量跑分块 + 无损校验，并输出块长分布。"""
    import glob
    from pathlib import Path

    files: list[str] = []
    for d in dirs:
        files.extend(sorted(glob.glob(str(Path(d).expanduser() / "*.md"))))
    files = [f for f in files if re.search(r"\d{4}-\d{2}-\d{2}\.md$", f)]
    n_sec = n_chunk = bad = 0
    lens: list[int] = []
    over: list[str] = []
    for f in files:
        date = Path(f).stem
        for title, body in sections(Path(f).read_text(encoding="utf-8", errors="replace")):
            n_sec += 1
            chunks = split_section(body, date, title)
            n_chunk += len(chunks)
            lens.extend(c["chars"] for c in chunks)
            ok, why = verify_lossless(body, chunks)
            if not ok:
                bad += 1
                print(f"❌ {Path(f).name} :: {title[:40]} → {why}")
            if chunks and max(c["chars"] for c in chunks) > CHUNK_MAX + 200:
                over.append(f"{Path(f).name}::{title[:30]} max={max(c['chars'] for c in chunks)}")
    lens.sort()
    n = len(lens)
    q = lambda p: lens[min(n - 1, int(n * p))] if n else 0
    print(f"文件 {len(files)} / 节 {n_sec} / 块 {n_chunk} / 无损校验失败 {bad}")
    if n:
        print(f"块长 min={lens[0]} p50={q(.5)} p90={q(.9)} p99={q(.99)} max={lens[-1]} 均值={sum(lens)//n}")
        print(f"超 CHUNK_MAX({CHUNK_MAX}) 的块 {sum(1 for x in lens if x > CHUNK_MAX)} 个")
    for o in over[:5]:
        print("⚠️ ", o)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    import sys
    from pathlib import Path

    args = sys.argv[1:]
    if not args:
        home = Path.home()
        args = [str(home / "WorkBuddy/mission/.workbuddy/memory"),
                str(home / ".workbuddy/memory")]
    sys.exit(selftest(args))
