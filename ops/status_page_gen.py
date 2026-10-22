#!/usr/bin/env python3
"""状态页生成器（M2 最小形态，2026-10-22）。

## 这个脚本解决什么问题

把"流水记忆"压成"这件事现在怎么样了"的可检索答案。**不建独立信念层**，
产物就是普通记忆（kind=experience + metadata.kindOfSnapshot=weekly-status），
复用已有检索链（含 E4.2 的 section 3-gram boost + E4.3 的 aliases 支持）。

## 为什么标题必须是「问题式」

2026-10-22 机制实验（副本库，两轮）：
- 陈述式标题（"备份链路当前状态"）对查询「昨天备份有没有成功」→ **0/3 命中第 1**
- 同一内容只改标题为「备份有没有成功」→ **3/3 命中第 1**（0.885/1.097/1.076），零代码改动

⇒ 结论层的价值不在"归纳"，而在"以检索语言组织结论"。
所以本脚本强制 question 为疑问句，并要求 2~3 个 aliases 覆盖不同问法。

## 演化纪律（不重写旧内容）

同一 topic 出新一代 → 旧一代标 `status=superseded` + `supersededBy`（preserveUpdatedAt=true）。
复用 E1/E5 已建机制，**绝不改写旧状态页正文**（A-MEM 式"不断重写旧记忆"是破坏性的，禁用）。

## 用法

    # 只看会生成什么（默认，不写库）
    python3 scripts/status_page_gen.py --since 7

    # 真正写入
    python3 scripts/status_page_gen.py --since 7 --apply

    # 指定输出样本到文件
    python3 scripts/status_page_gen.py --since 7 --out runs/status-pages-20261022.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
# 允许用 LEAFMEM_DB 指向副本库：便于**只读**验证演化/回填的判定逻辑
DEFAULT_DB = os.path.join(HOME, ".leafmem", "memory.sqlite")
DB = os.environ.get("LEAFMEM_DB") or DEFAULT_DB
# DB 被覆盖成别的库 ⇒ 后续**一律禁止写入**（见 guard_write）
ALT_DB = os.path.abspath(DB) != os.path.abspath(DEFAULT_DB)
SERVICE_CFG = os.path.join(HOME, ".leafmem", "agent-service.json")
SF_KEY_PATH = os.path.join(HOME, ".workbuddy", "secrets", "SILICONFLOW_API_KEY")
SCOPE = "agent:workbuddy"

# 输入压缩：每条记忆只送前 N 字，避免 7 天 100+ 条把上下文撑爆
BODY_CHARS = 320
MAX_INPUT_ITEMS = 120
# 状态页同时最多生成几条（不硬凑：LLM 若认为无可归纳主题可返回空）
MAX_PAGES = 8
MIN_PAGES = 3

# 结论词：状态页必须能看出"当前是什么状态"，否则它提供不了 process 查询要的答案
VERDICT_WORDS = ("正常", "已完成", "完成", "进行中", "失败", "待定", "无异常",
                 "无需处理", "已收口", "绿", "红", "阻塞", "待修", "已修复")


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def guard_write(action: str) -> None:
    """🔴 写入门禁：`LEAFMEM_DB` 指向非默认库时，拒绝任何写入。

    为什么必须拦：本脚本**读取**用 `LEAFMEM_DB`，但**写入走服务端 HTTP API**
    （目标库由服务进程的 `LEAFMEM_STORAGE_PATH` 决定，与 `LEAFMEM_DB` 无关）。
    两者不一致时，"算出来的"和"实际改的"不是同一批记录 ——
    2026-10-22 实测：用副本库跑 `--evolve-only` 验证演化，结果**把生产库一条状态页误标成 superseded**
    （靠 `supersededAt` 时间戳比对才发现，随后按 metadata 恢复）。

    正确做法：对副本库只跑**只读计算**（脚本会打印"保留 N / 待标 M"用于验证），
    要真写入就指向默认库，或起一个独立服务实例。
    """
    if ALT_DB:
        fail(
            f"LEAFMEM_DB 指向非默认库（{DB}），拒绝{action}。\n"
            f"  原因：写入走服务端 API，与 LEAFMEM_DB 指向的库不是同一个 ⇒ 会「算副本、改生产」。\n"
            f"  要做只读验证：去掉 --apply 或只用 --evolve-only 看判定结果即可（写操作会被拦下）。\n"
            f"  要真写入：不要设 LEAFMEM_DB（默认库），或起独立服务实例指向目标库。"
        )


def load_key() -> str:
    if not os.path.exists(SF_KEY_PATH):
        fail(f"缺少 API Key：{SF_KEY_PATH}（状态页生成需要一次 LLM 调用）")
    key = open(SF_KEY_PATH, encoding="utf-8").read().strip()
    if not key:
        fail(f"API Key 为空：{SF_KEY_PATH}")
    return key


def fetch_recent(since_days: int) -> list[dict]:
    """取窗口内新增/更新的记忆（排除状态页自身，避免自我归纳递归）。"""
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - since_days * 86400))
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    rows = con.execute(
        """SELECT id, kind, content, metadata_json, updated_at
           FROM memory_items
           WHERE updated_at >= ?
             AND coalesce(json_extract(metadata_json,'$.status'),'active') NOT IN ('superseded','archived')
             AND coalesce(json_extract(metadata_json,'$.kindOfSnapshot'),'') = ''
           ORDER BY updated_at DESC""",
        (cutoff,),
    ).fetchall()
    con.close()
    items = []
    for rid, kind, content, meta_json, updated in rows:
        try:
            meta = json.loads(meta_json or "{}")
        except Exception:
            meta = {}
        items.append({
            "id": rid,
            "kind": kind,
            "section": meta.get("section") or "",
            "eventTime": meta.get("eventTime") or "",
            "updated": updated,
            "body": (content or "")[:BODY_CHARS],
        })
    return items[:MAX_INPUT_ITEMS]


PROMPT = """你在为「个人工作记忆库」生成**状态页**。

任务：阅读下面这段时间的记忆流水，归纳出 3~{max_pages} 条「这件事现在怎么样了」的状态页。
不要总结流水，只输出**当前状态**——读者问"X 现在什么情况"时应该能直接读到答案。

## 铁律
1. **question 必须是疑问句**（含「吗/是否/几/哪/怎么样/什么情况/到哪/跑了没/绿了吗」等），
   用**提问者会用的口语问法**，不要写成陈述式标题（如"备份链路当前状态"是错的，
   "备份有没有成功"是对的——实测陈述式对检索命中率 0/3，问题式 3/3）。
2. **aliases 写 3 个不同「措辞粒度」的问法**，不要只做同义改写：
   - ① 正式书面（"安装器修复完成了吗"）
   - ② **口语/大白话**（"装包那个修好没"、"那个东西搞定没"）← 最关键，真实提问最常这样
   - ③ 领域词/简称/拼音外文（"installer 那个问题解决了吗"、"npm 审核过了没"）
   🔴 实测教训：只写"同义改写"（"修好了吗"→"修复完成了吗"）对检索毫无增益——
   3 个未预见口语问法（"装包那个东西修好没"）命中 0/3。别名必须真的换词，不是换语序。
3. **answer 结论先行**：第一句直接给状态词（正常/已完成/进行中/失败/待定/阻塞/无异常…），
   随后给 1~3 个关键数字或事实，最后一句给"要不要处理"。长度 120~350 字。
4. **supports 只能填下面列表里出现过的 id**，不许编造；每条状态页至少 1 个。
5. **不许编数字**。列表里没有的数字一律不写；不确定就不写。
6. 只输出**有状态可归纳**的主题。宁可少（3 条）也不要凑数；无主题则输出空数组。

## 输出格式（严格 JSON，不要 markdown 代码块）
{{"pages":[{{"topic":"简短主题名（6~14字，陈述式，用于去重演化）",
  "question":"问题式主标题",
  "aliases":["问法2","问法3"],
  "answer":"结论先行的正文",
  "supports":["id1","id2"]}}]}}

## 记忆列表（近 {days} 天，共 {n} 条）
{items}
"""


def build_prompt(items: list[dict], days: int) -> str:
    lines = []
    for it in items:
        sec = f"｜section={it['section']}" if it["section"] else ""
        lines.append(f"- id={it['id']}｜kind={it['kind']}｜{it['updated'][:10]}{sec}\n  {it['body']}")
    return PROMPT.format(max_pages=MAX_PAGES, days=days, n=len(items), items="\n".join(lines))


def call_llm(prompt: str, key: str, model: str) -> dict:
    body = json.dumps({
        "model": model,
        "max_tokens": 4000,
        "temperature": 0.3,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.siliconflow.cn/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        payload = json.loads(resp.read())
    text = payload["choices"][0]["message"]["content"].strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    return json.loads(text)


QUESTION_MARKS = ("吗", "是否", "几", "哪", "怎么样", "什么情况", "什么", "如何", "多少", "有没有", "是不是")


def validate(pages: list[dict], valid_ids: set[str]) -> tuple[list[dict], list[str]]:
    """机械校验：不通过的条目剔除并列原因，绝不"差不多就行"。"""
    ok, rejected = [], []
    for p in pages:
        q = str(p.get("question", "")).strip()
        aliases = [str(a).strip() for a in (p.get("aliases") or []) if str(a).strip()]
        answer = str(p.get("answer", "")).strip()
        supports = [str(s) for s in (p.get("supports") or [])]
        why = []
        if not q:
            why.append("question 为空")
        elif not any(m in q for m in QUESTION_MARKS):
            why.append(f"question 不是疑问句：{q[:24]}")
        if len(aliases) < 2:
            why.append(f"aliases 不足 2 个（{len(aliases)}）")
        if len(answer) < 60:
            why.append(f"answer 过短（{len(answer)} 字）")
        if not any(w in answer for w in VERDICT_WORDS):
            why.append("answer 无明确状态词（读者看不出当前是什么状态）")
        bad_ids = [s for s in supports if s not in valid_ids]
        if bad_ids:
            why.append(f"supports 含编造 id：{bad_ids[:2]}")
        if not supports:
            why.append("supports 为空（无溯源）")
        if why:
            rejected.append(f"{q[:20] or '(无标题)'} → " + "；".join(why))
        else:
            ok.append({
                "topic": str(p.get("topic", "")).strip() or q[:12],
                "question": q,
                "aliases": aliases[:3],
                "answer": answer,
                "supports": supports,
            })
    return ok, rejected


def build_source_refs(supports: list[str]) -> list[dict]:
    """把 supports（记忆 id）转成与**知识系统晶体契约同构**的 source_refs。

    为什么要同构：知识系统注册表（7,073 条）的资产契约长这样——
        source_refs: [{"doc_id","title","modified_at","anchor"}]
    状态页用同一形状，将来"记忆也进注册表"时不需要再写一层转换；
    `bridge_leafmem.py`（LeafMem→Neo4j ONT_）也可直接消费。
    anchor 置 null：记忆没有文档内锚点，字段保留以对齐契约。
    """
    if not supports:
        return []
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    out = []
    for sid in supports:
        row = con.execute(
            "SELECT id, summary, metadata_json, updated_at FROM memory_items WHERE id = ?",
            (sid,),
        ).fetchone()
        if not row:
            continue
        rid, summary, meta_json, updated = row
        try:
            meta = json.loads(meta_json or "{}")
        except Exception:
            meta = {}
        out.append({
            "doc_id": rid,
            "title": (meta.get("section") or summary or rid)[:80],
            "modified_at": (meta.get("eventTime") or str(updated)[:10]),
            "anchor": None,
        })
    con.close()
    return out


def write_via_api(pages: list[dict], timeout: int = 90) -> list[dict]:
    """走 HTTP API 写入（与生产同一路径，不直写 sqlite）。"""
    guard_write("写入状态页")
    cfg = json.load(open(SERVICE_CFG, encoding="utf-8"))
    base, key = f"http://127.0.0.1:{cfg['port']}", cfg["apiKey"]

    def call(method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            base + path, method=method,
            data=json.dumps(body).encode() if body else None,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")

    today = time.strftime("%Y-%m-%d")
    written = []
    for p in pages:
        content = (
            f"【状态页 {today}】{p['answer']}\n\n"
            f"（本页由近 7 天记忆归纳，溯源 {len(p['supports'])} 条；"
            f"问法别名：{' / '.join(p['aliases'])}）"
        )
        body = {
            "kind": "experience",
            "content": content,
            "summary": f"[状态页]{p['question']}",
            "scope": SCOPE,
            # 🔴 dedupe:false —— 状态页必须独立成条，不能被 0.85 相似度合并进别的记录
            # （E5 事故：单条 POST 曾漏传 dedupe，写回同文记录被合并并返回他条 id，导致误删真实块）
            "dedupe": False,
            "tags": ["status-snapshot", f"status-{today}"],
            "metadata": {
                "kindOfSnapshot": "weekly-status",
                "topic": p["topic"],
                "section": p["question"],       # 主标题 = 问题式
                "aliases": p["aliases"],        # 同义问法参与 3-gram 匹配（E4.3）
                "supports": p["supports"],
                # 与晶体资产契约同构（上行协同接口），见 build_source_refs 注释
                "source_refs": build_source_refs(p["supports"]),
                "eventTime": today,
                "eventTimeSrc": "body",
                "schema": "v3-structural",
                "generatedBy": "status_page_gen.py",
            },
        }
        written.append({"topic": p["topic"], "id": call("POST", "/v1/memories", body)["id"]})
    return written


def _grams(text: str) -> set[str]:
    t = re.sub(r"\s+", "", text or "")
    return {t[i:i + 3] for i in range(len(t) - 2)}


def _gram_cov(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a)


# 同主题判据：question 的 3-gram 覆盖率阈值。
# 🔴 为什么不用 topic 字符串：LLM 每期生成的 topic 名不稳定（实测同一主题
# "LeafMem发版与npm发布完成" vs "LeafMem 0.3.23版本发布状态"），精确匹配会漏，
# 导致旧状态页残留 active 累积重复。而**问题式标题的措辞是稳定的**
# （两期都生成"LeafMem 0.3.23发版成功了吗？"），用它判同主题可靠得多。
SAME_TOPIC_COV = 0.6


def supersede_previous(new_pages: list[dict], exclude_ids: set[str]) -> list[str]:
    """同 topic 的旧状态页标 superseded（不重写内容）。

    🔴 exclude_ids 必须是**刚写入的这批 id**。首版漏了这个参数，导致
    「写入 6 条 → 立刻把这 6 条自己标成 superseded」（supersededAt 与写入同秒），
    结果状态页全部退出检索，等于白写。实测 2026-10-22 首跑即踩。
    """
    cfg = json.load(open(SERVICE_CFG, encoding="utf-8"))
    base, key = f"http://127.0.0.1:{cfg['port']}", cfg["apiKey"]

    def call(method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            base + path, method=method,
            data=json.dumps(body).encode() if body else None,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read() or b"{}")

    guard_write("演化（标 superseded）")
    want_topics = {p["topic"] for p in new_pages}
    want_questions = [(p["question"], _grams(p["question"])) for p in new_pages]
    out = []
    listing = call("GET", f"/v1/memories?limit=9000&scope={SCOPE}").get("memories", [])
    for m in listing:
        meta = m.get("metadata") or {}
        if meta.get("kindOfSnapshot") != "weekly-status":
            continue
        if meta.get("status") in ("superseded", "archived"):
            continue
        if m["id"] in exclude_ids:      # 不把刚写入的这批当成"旧版本"
            continue
        # 同主题判据（任一命中即可）：topic 精确相等 OR question 3-gram 覆盖率 ≥ 阈值
        same = meta.get("topic") in want_topics
        if not same:
            old_q = str(meta.get("section") or "")
            old_g = _grams(old_q)
            same = any(_gram_cov(g, old_g) >= SAME_TOPIC_COV for _, g in want_questions)
        if not same:
            continue
        merged = {**meta, "status": "superseded", "supersededAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        # 🔴 PATCH metadata 是整体替换语义（memory.ts:421），必须回填全量，否则抹掉 section/aliases/supports
        call("PATCH", f"/v1/memories/{m['id']}?scope={SCOPE}",
             {"metadata": merged, "preserveUpdatedAt": True})
        out.append(m["id"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=7, help="回看天数（默认 7）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认 dry-run）")
    ap.add_argument("--out", help="把生成结果写到 JSON 文件")
    ap.add_argument("--model", default="deepseek-ai/DeepSeek-V3.2")
    ap.add_argument("--backfill-refs", action="store_true",
                    help="给已存在的状态页补 metadata.source_refs（与晶体契约同构）")
    ap.add_argument("--evolve-only", action="store_true",
                    help="只按当前 active 状态页做一次同主题清理（不调 LLM、不生成）")
    args = ap.parse_args()

    if args.backfill_refs:
        guard_write("回填 source_refs")
        cfg = json.load(open(SERVICE_CFG, encoding="utf-8"))
        base, key = f"http://127.0.0.1:{cfg['port']}", cfg["apiKey"]

        def call(method: str, path: str, body: dict | None = None) -> dict:
            req = urllib.request.Request(
                base + path, method=method,
                data=json.dumps(body).encode() if body else None,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read() or b"{}")

        listing = call("GET", f"/v1/memories?limit=9000&scope={SCOPE}").get("memories", [])
        snaps = [m for m in listing if (m.get("metadata") or {}).get("kindOfSnapshot") == "weekly-status"]
        done = 0
        for m in snaps:
            meta = dict(m.get("metadata") or {})
            refs = build_source_refs([str(x) for x in (meta.get("supports") or [])])
            # 已经有且条数一致的跳过（幂等，可重复跑）
            if meta.get("source_refs") and len(meta["source_refs"]) == len(refs):
                continue
            meta["source_refs"] = refs
            # PATCH metadata 是整体替换语义，必须回填全量（含 section/aliases/supports）
            call("PATCH", f"/v1/memories/{m['id']}?scope={SCOPE}",
                 {"metadata": meta, "preserveUpdatedAt": True})
            done += 1
        print(f"状态页 {len(snaps)} 条，补 source_refs {done} 条")
        # 回验：字段名必须与晶体契约一致
        listing2 = call("GET", f"/v1/memories?limit=9000&scope={SCOPE}").get("memories", [])
        ok = 0
        for m in listing2:
            meta = m.get("metadata") or {}
            if meta.get("kindOfSnapshot") != "weekly-status":
                continue
            refs = meta.get("source_refs") or []
            if refs and all(set(r) == {"doc_id", "title", "modified_at", "anchor"} for r in refs):
                ok += 1
        print(f"回验：source_refs 契约字段完整的状态页 {ok} 条")
        return 0

    if args.evolve_only:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
        rows = con.execute(
            """SELECT id, metadata_json FROM memory_items
               WHERE json_extract(metadata_json,'$.kindOfSnapshot')='weekly-status'
                 AND coalesce(json_extract(metadata_json,'$.status'),'active')='active'
               ORDER BY created_at DESC""").fetchall()
        con.close()
        pages = []
        for rid, mj in rows:
            m = json.loads(mj or "{}")
            pages.append({"id": rid, "topic": m.get("topic") or "", "question": m.get("section") or ""})
        if not pages:
            print("无 active 状态页，无需清理。")
            return 0
        # 只保留每个同主题簇里最新的一条（rows 已按 created_at DESC）
        kept, dropped = [], []
        for p in pages:
            g = _grams(p["question"])
            if any(_gram_cov(g, _grams(k["question"])) >= SAME_TOPIC_COV for k in kept):
                dropped.append(p)
            else:
                kept.append(p)
        print(f"active {len(pages)} 条 → 保留 {len(kept)} 条，待标 superseded {len(dropped)} 条")
        for d in dropped:
            print(f"  - {d['question'][:32]}")
        if not dropped:
            return 0
        # 🔴 exclude_ids 必须是 **id 集合**。首版误传 question 字符串集合，导致
        # 一个 id 都对不上 → 把 10 条 active 全部标成 superseded（实测 2026-10-22 踩到）。
        old = supersede_previous(pages, {p["id"] for p in kept})
        print(f"已标 superseded {len(old)} 条（内容未改）")
        return 0

    items = fetch_recent(args.since)
    if len(items) < 5:
        print(f"窗口内仅 {len(items)} 条记忆，不足以归纳出状态页（阈值 5）。本轮跳过。")
        return 0
    print(f"输入：近 {args.since} 天 {len(items)} 条记忆（每条截前 {BODY_CHARS} 字）")

    key = load_key()
    t0 = time.time()
    try:
        raw = call_llm(build_prompt(items, args.since), key, args.model)
    except Exception as e:
        fail(f"LLM 调用失败：{type(e).__name__} {e}")
    print(f"LLM 返回 {round((time.time()-t0)/1000,1)}s，pages={len(raw.get('pages') or [])}")

    valid_ids = {it["id"] for it in items}
    pages, rejected = validate(raw.get("pages") or [], valid_ids)
    if rejected:
        print(f"\n剔除 {len(rejected)} 条（机械校验未过）：")
        for r in rejected:
            print(f"  ✗ {r}")
    print(f"\n通过校验 {len(pages)} 条：")
    for i, p in enumerate(pages, 1):
        print(f"\n[{i}] topic={p['topic']}")
        print(f"    问：{p['question']}")
        print(f"    别名：{' / '.join(p['aliases'])}")
        print(f"    答：{p['answer'][:220]}{'…' if len(p['answer'])>220 else ''}")
        print(f"    溯源：{len(p['supports'])} 条")

    payload = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "since_days": args.since, "input_items": len(items),
               "pages": pages, "rejected": rejected}
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n样本已写 {args.out}")

    if not args.apply:
        print("\n[dry-run] 未写入。确认样本后用 --apply 落地。")
        return 0
    if len(pages) < MIN_PAGES:
        print(f"\n通过校验仅 {len(pages)} 条（<{MIN_PAGES}），本轮不写入以免污染库。")
        return 1

    written = write_via_api(pages)
    print(f"\n已写入 {len(written)} 条：")
    for w in written:
        print(f"  + {w['topic']} → {w['id'][:8]}")
    old = supersede_previous(pages, {w["id"] for w in written})
    if old:
        print(f"演化：{len(old)} 条同 topic 旧状态页标 superseded（内容未改）")
    payload["written"] = written
    payload["superseded"] = old
    if args.out:
        json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
