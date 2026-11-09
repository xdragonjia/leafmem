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

**同 `source_file` + 同 `section 主标题` + 剥壳正文 md5 相同**。

- 剥壳（`_bare`）：剥头部面包屑 + **去尾部 `---`** + 折叠全部空白
  - 面包屑正则：`^\[(?:[^\[\]]|\[[^\]]*\]){0,200}\]\s*`（与 `ops/ingest-daily-logs.py` 的 `BREADCRUMB_RE` 同口径）
  - 🔴 尾部 `---`（11-09 补）：v3 分块器写入时本已剔除、legacy 没剔 ⇒ 同一段正文在库里差 3 字符（实证 `e0eb7468` bare=644 / `775fb01a` bare=647，差异恰为文末 `---`）。不补这条，同节同文的 legacy 副本永远判不出来。
- section 归一到**主标题**（`_sec_key`）：剥时间前缀 → 剥 `（续N）` → 取首个左括号前的主干 → **不做 40 字符截断**
  - 三处动态修饰都必剥：① 时间前缀 `09:02` / `09:02–09:40` / `09:0x`；② 续块 `（续2）`；③ 括号内运行编号 `（ext-skill-weekly-check）` vs `（… 第 10 次）`
  - 🔴 为何不逐个正则剥尾部括号：括号内形态太多（编号/耗时/口径），剥不干净会留残括号导致仍不等；**取主标题一次覆盖全部形态**
  - 🔴 为何不再 `[:40]`：截断会把「第 40 字符恰好落在差异位」的长节名放大成关键差异（11-09 事故的第二重成因，两节名前 38 字相同、第 39 字一个是 `）` 一个是空格）
- 🔴 **必须限定 section**：否则会误伤「不同节引用同一段话」的合法情形（见 1.3b）

### 1.3b 🔴 跨节同文不删（11-09 立）

同 `source_file`、剥壳正文相同、但 section 主标题**不同** ⇒ **不删**。

- **性质**：多为源文档在两个节各记了一次同一段（如「每日知识运营 #61」与「今日一览」都复述了同一份哨兵结果）。入库两次是**忠实反映源文档**，删掉会丢失「该段在两节都出现」的结构信息。
- **指纹**：两条 `chunk.span` 首尾相接（`[1370,1730]` / `[1730,2090]`），`chars` 相同、正文逐字节一致。
- **实证（2026-11-09 全库）**：剥壳同文共 **2 组**——1 组同节（`e0eb7468`/`775fb01a`，已删）、1 组异节（`2209616f`/`9ecb7a23`，保留）。原注释「39 组里 7 组属此类」是 10 月基线，11 月已收敛到 1 组。
- 🔴 **这就是 section 约束必须保留的原因**：去掉它，这一组会被误删。

### 1.3c 负例回归（2026-11-09 实跑，改 `_bare`/`_sec_key` 后必须复跑）

| 用例 | 输入 | 期望 | 实测 |
|---|---|---|---|
| T1 正例命中 | 存档取 4 条（2 组已知同文） | 新逻辑 2 组、旧逻辑 0 组 | ✅ 2 / 0 |
| T2 空输入守卫 | `rows=[]` | 返回 0 组且不崩 | ✅ |
| T3 全库零误伤 | 存档 7,460 条 | 仅命中上述 2 组，跨节组不得出现 | ✅ 2 组 |
| T4 真库复跑 | 当前库 | `EXECUTOR_DUPS=0` | ✅ 0 |

🔴 **T1 的「旧逻辑必须为 0」是改动有效性的证明**——新旧逻辑结果若相同则改动是 no-op。历史上有把 no-op 当修复上报的事故（见 CHANGELOG），故此处为硬门禁而非参考项。

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