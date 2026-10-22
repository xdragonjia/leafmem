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

# 结论词：状态页必须能看出"当前是什么状态"，否则它提供不了 process 查询要的答案。
# 🔴 2026-10-22 第三次 dry-run 教训：原来只看全文包含、且词表手工枚举不全
# （缺「已解决/已发布/已排程/已上线」）⇒ 3 条完全正确的状态页被整条剔除。
# 两处修正：① 词表按实测语料补齐常见结论词；② 只在**前 24 字**内判（结论先行），
# 不允许"最后一句才说无需处理"的流水叙事蒙混过关。
# 🔴 词表刻意**不收**宽泛动词（进行/完成/通过/待办）——它们会命中"进行了三批修复"
# 这类流水叙事，把反例放过去（实测：加了"进行"后反例判据立即失效）。
VERDICT_WORDS = (
    "正常", "已完成", "进行中", "失败", "待定", "无异常", "无需处理",
    "已收口", "绿", "红", "阻塞", "待修", "已修复", "已解决", "已发布", "已上线",
    "已排程", "已关闭", "已归档", "已回滚", "已部署", "已合并", "已确认",
    "已恢复", "已补齐", "未开始", "无变化", "健康", "在线", "离线", "异常", "中断",
    "暂停", "告警", "达标", "未达", "待处理", "已结束",
)
VERDICT_HEAD_CHARS = 24
# 🔴 光靠词表子串匹配不行：中文状态词变体太多，第 5 轮 dry-run 又漏了「已成功发布」
# （词表有"已发布"，但"已成功发布"不含这个连续子串）。
# 故补两类**结构性**判据，不靠穷举：
#   ① 结论句以状态前缀起头（已/未/待/无/暂/正/当前…）——"已成功发布""已经解决"全覆盖
#   ② 前 12 字出现状态动词（完成/解决/发布/上线…）——覆盖"安装器已完成修复"这类主语开头
VERDICT_PREFIXES = ("已", "未", "待", "无", "暂", "正", "当前", "目前", "整体", "一切", "现在")
VERDICT_VERBS = ("完成", "解决", "发布", "上线", "排程", "关闭", "回滚", "恢复", "部署",
                 "合并", "确认", "达标", "失败", "异常", "中断", "暂停", "告警", "修复", "通过")
VERDICT_VERB_CHARS = 12


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

## 上一期已发布的状态页（增量模式基线）
{prev}

🔴 增量纪律（本期与上期的关系，必须遵守）：
- 上表中某主题若**本期没有新证据**（下面的记忆列表里看不到它的新进展）→ 输出
  `{{"reuse":"<上表 id>"}}`，**不要重写**。重写会把旧页标 superseded 却没有信息增量，
  等于每期白刷一遍版本、把库填满过期副本。
- 若本期确有新进展 → 输出该主题新版，并填 `"supersedes":"<上表 id>"`。
- 上表没有的主题 → 正常新增，`supersedes` 留空或省略。
- 上表为空（首期）→ 全部按新增处理。

## 输出格式（严格 JSON，不要 markdown 代码块）
{{"pages":[{{"topic":"简短主题名（6~14字，陈述式，用于去重演化）",
  "question":"问题式主标题",
  "aliases":["问法2","问法3"],
  "answer":"结论先行的正文",
  "supports":["id1","id2"],
  "supersedes":"上期同类页 id（无则省略）",
  "reuse":"上期 id（本期无变化时用，只填这一个字段）"}}]}}

## 记忆列表（近 {days} 天，共 {n} 条）
{items}
"""


def fetch_prev_pages() -> list[dict]:
    """取当前 active 状态页，作为本期「增量基线」喂给 LLM。

    🔴 为什么必须有：`--since 7` 是**滚动窗口**。第 2 期窗口（10-19 起）覆盖第 1 期的全部源记忆，
    若不告诉 LLM「这些主题已归纳过」，它会对同一批记忆再生成一遍同样 9 条
    ⇒ 旧版全被标 superseded、新版内容几乎相同 = 零信息增益 + 每期 9 条 superseded 累积。
    反过来，窗口滚过头（第 3 期起看不到 10-21 的记忆）时，基线清单能让 LLM 知道
    「这个主题存在但本期无新证据」→ 走 reuse，而不是当成新主题再造一条同义页。
    """
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    rows = con.execute(
        """SELECT id, content, metadata_json, updated_at FROM memory_items
           WHERE coalesce(json_extract(metadata_json,'$.kindOfSnapshot'),'') = 'weekly-status'
             AND coalesce(json_extract(metadata_json,'$.status'),'active') NOT IN ('superseded','archived')
           ORDER BY updated_at DESC LIMIT 40"""
    ).fetchall()
    con.close()
    out = []
    for rid, content, meta_json, updated in rows:
        try:
            meta = json.loads(meta_json or "{}")
        except Exception:
            meta = {}
        body = (content or "").split("\n", 1)
        ans = (body[1] if len(body) > 1 else body[0]).strip()
        out.append({
            "id": rid,
            "topic": meta.get("topic") or "",
            "question": meta.get("section") or "",
            "answer": ans[:120],
            "updated": str(updated)[:19],   # 完整时间：用于判定「上期生成之后是否有新证据」
        })
    return out


def drop_unchanged(pages: list[dict], items: list[dict], prev: list[dict],
                   reuses: list[str]) -> tuple[list[dict], list[str], list[str]]:
    """拦截「零增益重写」：新版 supports 里没有上期生成之后的新记忆 ⇒ 回落 reuse。

    🔴 为什么需要机械判定：实测第 2 期模拟（2026-10-22 18:48）LLM **同时**输出 6 条 reuse
    和 9 条重写，自相矛盾。若照单全收 `--apply`，会把 9 条旧页全标 superseded、
    再写 9 条内容几乎相同的新页 —— 每期白刷一遍版本，正是增量模式要防的事。
    判据用确定性信号（supports ∩ 新证据 id），不猜 LLM 意图：
    - 有交集 → 确有新证据，允许重写（新版带 supersedes 指针）；
    - 无交集 → 无新证据，强制沿用上期（丢弃新版，不写库）。
    """
    if not prev:
        return pages, reuses, []
    prev_gen = max(str(p["updated"]) for p in prev)
    fresh = {it["id"] for it in items if str(it["updated"])[:19] > prev_gen}
    prev_ids = {p["id"] for p in prev}
    kept, dropped = [], []
    for p in pages:
        old_id = p.get("supersedes") or ""
        if old_id not in prev_ids:
            # 没显式指针：按 topic / question 3-gram 找同主题上期页
            for q in prev:
                if q["topic"] == p["topic"] or _gram_cov(_grams(p["question"]), _grams(q["question"])) >= SAME_TOPIC_COV:
                    old_id = q["id"]
                    break
        if old_id and not (set(p["supports"]) & fresh):
            if old_id not in reuses:
                reuses.append(old_id)
            dropped.append(f"{p['topic']} → 沿用（supports 无上期 {prev_gen[:16]} 之后的新记忆）")
            continue
        kept.append(p)
    return kept, reuses, dropped


def build_prompt(items: list[dict], days: int, prev_pages: list[dict] | None = None) -> str:
    lines = []
    for it in items:
        sec = f"｜section={it['section']}" if it["section"] else ""
        lines.append(f"- id={it['id']}｜kind={it['kind']}｜{it['updated'][:10]}{sec}\n  {it['body']}")
    prev_pages = prev_pages or []
    if prev_pages:
        plines = [
            f"- id={p['id']}｜topic={p['topic']}｜问：{p['question']}｜答：{p['answer']}｜更新于 {p['updated']}"
            for p in prev_pages
        ]
        prev_txt = "\n".join(plines)
    else:
        prev_txt = "（无，本期为首期）"
    return PROMPT.format(
        max_pages=MAX_PAGES, days=days, n=len(items),
        items="\n".join(lines), prev=prev_txt,
    )


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


def all_memory_ids() -> set[str]:
    """库里全部记忆 id（含窗口外的旧记忆）。

    🔴 为什么不能用「窗口内 id」当唯一合法集：状态页要溯源的那条记忆很可能早于 7 天窗口
    （例如"0.3.23 发版"的源记忆在 8 天前）。首版只允许窗口内 id ⇒ 会因"编造 id"整条丢掉
    一个本来正确的状态页。判据应是「库里存在」而非「本窗口内」。
    """
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    ids = {r[0] for r in con.execute("SELECT id FROM memory_items").fetchall()}
    con.close()
    return ids


def _lev(a: str, b: str, cap: int = 3) -> int:
    """Levenshtein 距离（带上限提前返回）。"""
    if abs(len(a) - len(b)) > cap:
        return cap
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        if min(cur) > cap:
            return cap
        prev = cur
    return prev[-1]


def _fix_id_typo(bad: str, all_ids: set[str]) -> str | None:
    """抄写笔误纠正（唯一候选才纠，编辑距离 ≤2）。

    实测 2026-10-22 三例 LLM 抄 36 位 uuid 出错，都不是单纯单字符替换：
    - `…-1e1d86a27011` → `…-1d1d86a27011`（替换 1 位，距离 1）
    - `…-ba9a-5d9282650229` → `…-b9a9-5d9282650229`（相邻字符互换 + 位移，距离 2）
    只纠**等长且候选唯一**的情形；有歧义一律不纠（宁缺毋滥）。
    先用「前 8 位相同」缩小候选（uuid 前缀相同的情况占绝大多数，快且稳），
    退化时再全量比，6123 条库量可接受。
    """
    if not bad:
        return None
    same_len = [x for x in all_ids if len(x) == len(bad)]
    pref = [x for x in same_len if x[:8] == bad[:8]]
    cands = [x for x in (pref or same_len) if _lev(x, bad) <= 2]
    return cands[0] if len(cands) == 1 else None


def _verdict_ok(answer: str) -> bool:
    """状态页是否「结论先行」：读者读第一句就知道当前状态。"""
    head = answer[:VERDICT_HEAD_CHARS]
    if head.startswith(VERDICT_PREFIXES):
        return True
    if any(w in head for w in VERDICT_WORDS):
        return True
    return any(w in answer[:VERDICT_VERB_CHARS] for w in VERDICT_VERBS)


def validate(pages: list[dict], valid_ids: set[str],
             prev_ids: set[str] | None = None,
             all_ids: set[str] | None = None) -> tuple[list[dict], list[str], list[str]]:
    """机械校验：不通过的条目剔除并列原因，绝不"差不多就行"。

    返回 (可写入的新页, 剔除原因, 沿用的上期 id)。`reuse` 与 `supersedes` 的 id
    必须真实存在于上期清单 —— LLM 编 id 是很常见的失败形态（supports 已经踩过）。
    supports 的合法集用 `all_ids`（整库），比 `valid_ids`（窗口内）宽：窗口外旧记忆也允许溯源。
    """
    prev_ids = prev_ids or set()
    universe = all_ids or valid_ids
    ok, rejected, reuses = [], [], []
    for p in pages:
        reuse = str(p.get("reuse") or "").strip()
        if reuse:
            if reuse in prev_ids:
                reuses.append(reuse)
            else:
                rejected.append(f"reuse={reuse[:8]} → 不在上期清单里（编造 id）")
            continue
        q = str(p.get("question", "")).strip()
        aliases = [str(a).strip() for a in (p.get("aliases") or []) if str(a).strip()]
        answer = str(p.get("answer", "")).strip()
        supports = [str(s) for s in (p.get("supports") or [])]
        supersedes = str(p.get("supersedes") or "").strip()
        why = []
        if not q:
            why.append("question 为空")
        elif not any(m in q for m in QUESTION_MARKS):
            why.append(f"question 不是疑问句：{q[:24]}")
        if len(aliases) < 2:
            why.append(f"aliases 不足 2 个（{len(aliases)}）")
        if len(answer) < 60:
            why.append(f"answer 过短（{len(answer)} 字）")
        if not _verdict_ok(answer):
            why.append(f"结论不先行（前 {VERDICT_HEAD_CHARS} 字无状态词）：{answer[:20]}")
        # id 校验：不存在 → 尝试单字符笔误纠错（唯一候选才纠）
        fixed_supports, bad_ids = [], []
        for s in supports:
            if s in universe:
                fixed_supports.append(s)
                continue
            alt = _fix_id_typo(s, universe)
            if alt:
                print(f"  ~ id 笔误纠正：{s} → {alt}（{q[:16]}）")
                fixed_supports.append(alt)
            else:
                bad_ids.append(s)
        supports = fixed_supports
        if bad_ids:
            why.append(f"supports 含编造 id：{bad_ids[:2]}")
        if not supports:
            why.append("supports 为空（无溯源）")
        if why:
            rejected.append(f"{q[:20] or '(无标题)'} → " + "；".join(why))
        else:
            if supersedes and supersedes not in prev_ids:
                # 不整条拒绝：新页本身有效，只是演化指针无效 → 丢掉指针，回落 3-gram 判据
                rejected.append(f"{q[:20]} → supersedes={supersedes[:8]} 不在上期清单，已忽略该指针")
                supersedes = ""
            ok.append({
                "topic": str(p.get("topic", "")).strip() or q[:12],
                "question": q,
                "aliases": aliases[:3],
                "answer": answer,
                "supports": supports,
                "supersedes": supersedes,
            })
    return ok, rejected, reuses


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
                # 增量演化的显式指针（旧页 id）；与旧页的 supersededBy 互为反向，可对账
                **({"supersedes": p["supersedes"]} if p.get("supersedes") else {}),
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
    # 精确映射：旧 id → 新 id。优先用 LLM 在增量模式下给出的 supersedes，
    # 没给才回落到 topic/3-gram 判据（兼容首期与 --evolve-only）。
    exact: dict[str, str] = {}
    for p in new_pages:
        old = str(p.get("supersedes") or (p.get("metadata") or {}).get("supersedes") or "")
        if old and p.get("id"):
            exact[old] = p["id"]
    want_topics = {p["topic"]: p.get("id") for p in new_pages if p.get("topic")}
    want_questions = [(p.get("id"), _grams(p["question"])) for p in new_pages if p.get("question")]
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
        new_id = exact.get(m["id"])
        if new_id is None:
            # 同主题判据（任一命中即可）：topic 精确相等 OR question 3-gram 覆盖率 ≥ 阈值
            if meta.get("topic") in want_topics:
                new_id = want_topics[meta.get("topic")]
            else:
                old_g = _grams(str(meta.get("section") or ""))
                for nid, g in want_questions:
                    if _gram_cov(g, old_g) >= SAME_TOPIC_COV:
                        new_id = nid
                        break
        if not new_id:
            continue
        # 🔴 supersededBy 必须写：文档承诺「superseded + supersededBy」演化链，
        # 首版只写了 status/supersededAt ⇒ 旧页指向不明，无法回答"被哪条取代"，
        # 也无法在反向回滚时定位。2026-10-22 实测 2 条 superseded 的 supersededBy 全为 null。
        merged = {**meta, "status": "superseded",
                  "supersededBy": new_id,
                  "supersededAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
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
    ap.add_argument("--no-incremental", action="store_true",
                    help="关闭增量基线（不喂上期状态页清单）。默认开启：避免滚动窗口把同一批主题每期重写一遍")
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
    prev = [] if args.no_incremental else fetch_prev_pages()
    print(f"输入：近 {args.since} 天 {len(items)} 条记忆（每条截前 {BODY_CHARS} 字）"
          f"｜增量基线 {len(prev)} 条（{'关闭' if args.no_incremental else '开启'}）")

    key = load_key()
    t0 = time.time()
    try:
        raw = call_llm(build_prompt(items, args.since, prev), key, args.model)
    except Exception as e:
        fail(f"LLM 调用失败：{type(e).__name__} {e}")
    print(f"LLM 返回 {round(time.time()-t0,1)}s，pages={len(raw.get('pages') or [])}")

    valid_ids = {it["id"] for it in items}
    pages, rejected, reuses = validate(
        raw.get("pages") or [], valid_ids, {p["id"] for p in prev}, all_memory_ids())
    pages, reuses, unchanged = drop_unchanged(pages, items, prev, reuses)
    if unchanged:
        print(f"\n拦截零增益重写 {len(unchanged)} 条（无新证据 → 沿用上期，不写库）：")
        for u in unchanged:
            print(f"  ⊘ {u}")
    if reuses:
        print(f"\n沿用上期（无新证据，不重写）{len(reuses)} 条：")
        prev_q = {p["id"]: p["question"] for p in prev}
        for r in reuses:
            print(f"  = {prev_q.get(r, r[:8])}")
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
               "prev_pages": len(prev), "reused": reuses,
               "pages": pages, "rejected": rejected}
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"\n样本已写 {args.out}")

    if not args.apply:
        print("\n[dry-run] 未写入。确认样本后用 --apply 落地。")
        return 0
    if not pages:
        # 增量模式的正常形态：本期所有主题都无新证据 ⇒ 什么都不写（旧页保持 active 即可）
        print(f"\n无新状态可写（沿用上期 {len(reuses)} 条），本轮不写入。")
        return 0
    if not prev and len(pages) < MIN_PAGES:
        # 🔴 MIN_PAGES 只约束**首期**。增量期每期只更新 1~2 条是正常形态，
        # 若沿用首期的下限，会把真实的少量更新当成"凑数废页"拒掉。
        print(f"\n通过校验仅 {len(pages)} 条（<{MIN_PAGES}），首期不写入以免污染库。")
        return 1

    written = write_via_api(pages)
    print(f"\n已写入 {len(written)} 条：")
    for w in written:
        print(f"  + {w['topic']} → {w['id'][:8]}")
    # 把新 id 回填进 pages，供 supersede_previous 建立「旧 id → 新 id」精确映射（写 supersededBy）
    seen: dict[str, str] = {}
    for w in written:
        seen.setdefault(w["topic"], w["id"])
    for p in pages:
        if p["topic"] in seen:
            p["id"] = seen[p["topic"]]
    old = supersede_previous(pages, {w["id"] for w in written})
    if old:
        print(f"演化：{len(old)} 条同主题旧状态页标 superseded（内容未改，已写 supersededBy）")
    payload["written"] = written
    payload["superseded"] = old
    if args.out:
        json.dump(payload, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
