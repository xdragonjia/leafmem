# 4b／4c 门禁细则：双执行器同文重复 与 非标准 kind

> 🔴 **何时读**：执行 SKILL 步骤 4（真重复检测与删除）时读本文件；SKILL.md 正文只留判据与指针。
> 两条门禁均**机械可判定**（`weekly_scan.py` 的 `executor_dups` 字段 ＋ 一条 SQL），不依赖人工目视。

## 目录
1. [4b 双执行器同文重复](#1-4b-双执行器同文重复)
2. [4c 非标准 kind 门禁](#2-4c-非标准-kind-门禁)
3. [来源事故记录](#3-来源事故记录)
4. [复现与回归](#4-复现与回归)

---

## 1. 4b 双执行器同文重复

### 1.1 现象与根因

daily md 曾被两个执行器回流：

| 执行器 | 触发时刻 | state 位置 | 产物结构 |
|---|---|---|---|
| 语义层日更 `13k1c` | 04:30 链内 | 项目 `runs/daily_log_ingest_state.json` | **legacy**：无 `chunk.span` |
| LeafMem 哨兵 ops | 05:30 | `~/.leafmem/daily-ingest-state.json` | **v3**：带 `chunk.span` |

两套 state **互不可见** ⇒ 同一节各入一次。

🔴 **全文 SHA256 判不出**：两者面包屑格式不同（`[日期·标题]` vs `[日期·标题·序/总]`），必须**剥壳后**再比。

### 1.2 为什么上一版 SKILL 漏了它（这是「清了又长」的机制性原因）

`weekly_scan.py` 的「3. 跨日近重复」段（3-gram Jaccard ≥ 0.72）**早已报出**这些配对（实测 jac 0.84–0.92），
但步骤 4 的删除动作**只消费「1. 真重复」段**（全文 SHA256）⇒ **报告了却无人处置**。
2026-11-02 周整清掉 90 条，11-03 又长出 28 组。

### 1.3 判据

**同 `source_file` + 同 `section` + 剥壳正文 md5 相同**。

- 剥壳正则：`^\[(?:[^\[\]]|\[[^\]]*\]){0,200}\]\s*`（与 `ops/ingest-daily-logs.py` 的 `BREADCRUMB_RE` 同口径）
- `section` 需先剥 `（续N）` 后缀后取前 40 字符
- 🔴 **必须限定 section**：否则会误伤「不同节引用同一段话」的合法情形（实测全库 39 组剥壳重复中有 7 组属此类，不该删）

### 1.4 处置规则

| 项 | 规则 |
|---|---|
| 保留 | **带 `chunk.span` 的 v3 版**（可溯源、可精确回定位）。反向保留会丢溯源能力 |
| 删除 | legacy 版。`weekly_scan.py` 已算好 `keep_id` / `drop_ids`，照用 |
| 前置 | 与步骤 2.0 同一硬门禁——**先存档（VERIFY=OK）再删**；删前 `archive_and_purge.py` 归档 |
| 判据 | `len(executor_dups) == 0`，必须写进周报 |

### 1.5 架构侧：统一写入口 > 兜底拦截

`13k1c` 已于 2026-11-03 改为调用 `~/projects/leafmem/ops/ingest-daily-logs.py` 的**瘦封装**，
共用 `~/.leafmem/daily-ingest-state.json` 一份 state。

🔴 **关键教训（我第一版方案错在这里）**：只加「库内正文指纹兜底」不够——兜底是**先到先得**，
先跑的 legacy 劣质版占位会挡住后跑的 v3 优质版，构成**质量倒挂**，比重复更严重（系统性丢弃溯源信息）。
业界幂等标准是「稳定 content hash + 在写入处约束」，**统一写入口优于兜底拦截**。

`db_fps` 兜底保留，但定位改为「防未知第三执行器」——历史上出现过「以为只有一个写入口」的判断失误。

### 1.6 门禁命令

```bash
/Users/dragon/.workbuddy/binaries/python/envs/default/bin/python3 \
  /Users/dragon/.workbuddy/skills/leafmem-maintenance/scripts/weekly_scan.py --json 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); e=d['executor_dups']; print('EXECUTOR_DUPS=%d'%len(e)); [print('  keep=%s drop=%s'%(g['keep_id'][:8], ','.join(x[:8] for x in g['drop_ids']))) for g in e[:10]]"
```

判读：`EXECUTOR_DUPS=0` → 通过。`>0` → 按 `keep_id`/`drop_ids` 处置后复跑须＝0。

🔴 **判据只管 0，不看降幅**：单看数字下降不算修好，须说明来源（历史残留清完 / 又冒出第三个执行器）。
若归零后下周又长出来，查绕过共享 state 的写入口：

```bash
grep -rn "v1/memories/batch" ~/ --include=*.py
```

---

## 2. 4c 非标准 kind 门禁

### 2.1 允许清单

`lesson / preference / decision / note / experience / principle`
（权威定义见 `src/adapters/workbuddy.ts:315`）

### 2.2 为什么不是「整洁问题」而是「通路问题」

`kind` 直接决定该条走哪条数据通路：

| 通路 | 只读哪些 kind | 源码位置 |
|---|---|---|
| `reflect`（原则蒸馏） | `lesson` / `decision` / `note` | `src/core/memory.ts:708` |
| `profile`（画像刷新） | `preference` / `identity` | `src/core/memory.ts:891` |
| 召回加权 | `principle` 享固定 boost | `src/core/memory.ts:1034` |

⇒ 写错 kind ＝ 该条**永远进不了对应通道** ＝ **内容静默失效**。

`MemoryKind` 的类型定义是 `... | (string & {})`（`src/core/types.ts:11`），
即**类型层不拦任何字符串**，所以只能靠门禁断言兜住。

### 2.3 门禁命令

```bash
sqlite3 ~/.leafmem/memory.sqlite \
  "SELECT COUNT(*) FROM memory_items WHERE kind NOT IN ('lesson','preference','decision','note','experience','principle');"
```

必须＝0。

### 2.4 归并映射（按语义，不按字面）

| 原 kind 语义 | 归并为 | 例 |
|---|---|---|
| 实证后的裁定／改变工作对象的结论 | `decision` | 10-30 两条 S9 因子结论写成 `finding` → `decision` |
| 可执行规则／踩坑后的行为约束 | `lesson` | process_trap / tool_trap / procedural |
| 事实陈述／知识记录 | `note` | domain_finding / fact / workflow |
| 长期不变的原则 | `principle` | 铁律类 |

处置走 `leafmem-cli update <id> --kind <k>`：改前备份、改后回读核 `importance`／`confidence`／字数／`tags` 未变。

---

## 3. 来源事故记录

**2026-11-03（哨兵 `leafmem-obs-daily` 转交遗留项，交互会话按方法论处置）**

- **10-30**：两条 S9 多因子实证结论写入时 kind 用了 `finding`（清单外）。因类型层不拦、也无门禁断言，静默入库。
- **10-31 / 11-02 / 11-03**：连续 3 个周整周期未处置（周整既无 kind 断言，也不知道 `finding` 有问题）。
- **11-03 哨兵**：日报把 `finding` 计数为观察项，转交交互会话。
- **11-03 交互会话**：Step0 读源码发现通路问题（升级严重性）→ 归并为 `decision` → 补两道门禁。

同批还发现：周整清了 90 条重复后次日又长出 28 组，根因是 4b 所述「报告了却无人处置」。

---

## 4. 复现与回归

### 4.1 负例注入（判据非恒真的证明）

`scan_executor_dups` 必须能被故意造的坏数据触发，且不被合法数据误触发：

| 用例 | 输入 | 期望 |
|---|---|---|
| A 同节同文 | 同 file + 同 section + 同正文（一 v3 一 legacy） | **检出 1 组**，keep＝v3 |
| B 异节同文 | 同 file + **不同 section** + 同正文 | 0（防误伤合法引用） |
| C 同节异文 | 同 file + 同 section + **不同正文** | 0 |
| D 非 daily | 无 `source_file` 的条目 | 0（不参与判据） |
| E 空输入 | `[]` | 0 |

实测 2026-11-03：A=1、B=0、C=0、D=0、E=0，5/5 全过。

### 4.2 回归测试

```bash
cd /Users/dragon/projects/leafmem
/Users/dragon/.workbuddy/binaries/python/versions/3.13.12/bin/python3 ops/test_ingest_cross_root.py    # T1-T7
/Users/dragon/.workbuddy/binaries/python/versions/3.13.12/bin/python3 ops/test_ingest_failure_retry.py # T1-T3
```

两者须全绿。改动 `ops/ingest-daily-logs.py` 或 `weekly_scan.py` 后必跑。