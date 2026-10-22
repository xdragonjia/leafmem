# Changelog

All notable changes to LeafMem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **状态页增量演化（`ops/status_page_gen.py`）**：把上一期 active 状态页清单喂给模型，
  并对「`supports` 里没有上期生成之后新记忆」的重写做**机械拦截**（回落沿用、不写库）。
  为什么需要：`--since N` 是滚动窗口，第 2 期窗口必然覆盖第 1 期的全部源记忆 ⇒
  不加基线就会把同一批主题每期重写一遍（旧版全标 superseded、新版内容几乎相同）。
  必须机械判：实测模型会在同一份输出里**同时**给出 `reuse` 和重写（自相矛盾）。
  新增 `--no-incremental` 可关闭。
- **`supersededBy` 反向指针**：旧状态页被取代时写入指向新版 id 的指针（建「旧 id→新 id」精确映射）。
  此前只写 `status` / `supersededAt`，演化链指向不明——库里 3 条 superseded 的指针全为 null，
  却没有任何机制发现。
- **`_resolve_ref` 引用解析**：模型会把 36 位 id 抄成 8 位前缀（实测 `supersedes=ca4aada6`），
  原全等比较判它"编造 id"并丢掉指针 ⇒ 演化静默失效、日志只说"已忽略该指针"不报错。
  现支持全 id 与**唯一前缀**（≥8 位，有歧义则拒），带引号/尖括号噪声先清洗。
- **`--backfill-superseded-by`**：存量自愈，给早期只有 `status/supersededAt` 的旧页补指针
  （按 topic 相等或 section 3-gram ≥0.6 找当前 active 页）。实测回填 2 条，缺指针 2 → 0。
- **`supports` 抄写笔误自动纠正**：模型抄 36 位 uuid 会出错（实测三例：替换 1 位 / 字符位移 /
  前缀错），编辑距离 ≤2 且候选唯一才纠，有歧义或乱码一律不纠。

### Changed

- **`supports` 合法 id 集从「窗口内」放宽为「整库」**：状态页要溯源的往往是 7 天窗口外的旧记忆，
  原判据会把这类完全正确的状态页当"编造 id"整条剔除。
- **结论先行判据改为结构性判定**（原为全文包含词表）：词表匹配对中文变体天然不足——
  实测依次漏掉「已解决/已发布/已排程」，最后连「已成功发布」也漏（词表有"已发布"但不含该连续子串）。
  现改为三条任一成立即通过：① 前 24 字以状态前缀起头（已/未/待/无/暂/正/当前…）；
  ② 前 24 字含状态词；③ 前 12 字含状态动词（完成/解决/发布/上线…，覆盖"安装器已完成修复"这类主语开头）。
  流水叙事（"10月21日夜间进行了三批修复…最终无需处理"）不再通过。词表**刻意不收**宽泛动词
  （进行/完成/通过），否则反例立刻蒙混过关（实测）。
- **状态页目录注入上限 8 → 12 条**（`STATUS_PAGE_MAX`）：增量演化后 active 状态页会持续累积
  （实测两轮生成就到 10 条），旧的 8 条上限会让早期主题在目录里不可见——目录是"有这些状态可查"
  的兜底提示，看不到就等于没有。
- **首次生成的下限校验（`MIN_PAGES`）只对首期生效**：增量期每期只更新 1~2 条属正常形态。

### Fixed

- 卫生守卫（`memory_hygiene_check.py`，项目脚本）此前只查 `supersededBy` **悬空**，查不出
  "该有却没有"——库里 superseded 指针全空时它一直报 OK。新增 `superseded_no_ptr` 判据
  （反向实测：副本库构造 1 条缺陷 → exit 1 并精确报出）。
- 模型调用耗时的打印把秒又除了一次 1000（显示 `0.0s`）。

## [0.3.25] - 2026-10-22

### Added
- **`ops/status_page_gen.py` 入库（随仓分发）**：状态页生成器原先放在私有项目目录，
  而 README §3.7 直接引用了那个路径 ⇒ **对分发用户是死引用**。现随仓分发，四个模式：
  `--since N`（dry-run）/ `--apply` / `--evolve-only`（只做同主题清理）/ `--backfill-refs`（补 `source_refs`）。
- **`LEAFMEM_DB` 支持 + `guard_write` 写入门禁**：允许用环境变量指向副本库做**只读**验证；
  一旦发现 DB 非默认库，**拒绝一切写入**并说明原因。
  为什么必须拦：脚本读取用 `LEAFMEM_DB`，写入却走服务端 HTTP API（目标库由服务进程决定），
  两者不一致时就是「算副本、改生产」——实测用副本验证演化时把生产库一条状态页误标 superseded。

### Fixed
- README §3.7 的生成器路径改为 `ops/status_page_gen.py`（原引用私有路径），并补四种用法示例。

## [0.3.24] - 2026-10-22

### Added

#### 记忆分层与生命周期（E1 / E2 / E5）

- **轻双时态元数据字段（零 DDL，全在 `metadata`）**：`status`(active·procedural·superseded·archived) /
  `eventTime` / `eventTimeSrc` / `invalidAt` / `supersededBy` / `supersededAt`（camelCase，与既有 `lastRecalledAt` 一致）。
  默认检索排除 `superseded/archived`，兼容 08-31 起的旧约定（`supersededBy` 单串与非空数组都认）。
- **`search({ asOf })`**：只保留 `eventTime <= asOf` 的记录，**缺 `eventTime` 仍可见**（未知时间不判为未来，
  否则一次 as-of 查询会静默丢掉 12.5% 记忆）。
- **`search({ includeInactive })` / HTTP `/v1/recall` 同名参数**：排查历史、对账、迁移核验时用。
- **`MemoryInput.preserveUpdatedAt`（core→platform→HTTP 全链路）**：元数据维护类写入不刷新 `updatedAt`。
  为什么必须有：`recency` 取 `max(lastRecalledAt, updatedAt)`，回填 4,308 条若把时间戳刷成 now，
  等于宣称"全部刚更新"（1 年前记录 recency 0.2→1.0，权重 0.08 ⇒ +0.064 分），排序被系统性污染。
- **`src/core/enrich.ts` 写入侧补齐**：`extractEventTime`（显式 → 面包屑 → 正文日期 → docDate → 文件名）
  与 `classifyStatus`（有待办词且无结论词才判 procedural），接在 `remember()` 最内层，
  MCP/CLI/HTTP/摄入脚本四条通道自动覆盖。全库实测 eventTime 可抽取 **85.7%**；
  且**与 createdAt 不同月占 46.7%**（与审计 46.9% 互证）⇒ 抽到的是事件时间而非入库时间。

#### 检索打分（E4.1 / E4.2 / E4.3 / E4.4）

- **`tokenOverlapScoreNormalized`（词法长度归一）**：原 `tokenOverlapScore` 的分母只有
  `queryTokens.length`，是「查询覆盖率」而非相似度 ⇒ 候选越长越容易碰巧覆盖全部查询字。
  实测一条 5,100 字的 principle 记录对「语义层日更重建有没有在跑」这种无关查询也拿 `lexical=1.000`。
  归一因子 `sqrt(600/candTokens)`，夹 `[0.5, 1.2]`。
- **`trigrams` / `trigramCoverage` + `sectionBoost`**：section 的 3-gram 命中给 0.2 加成
  （弱于 fts 0.22 / entity 0.18）。体检到的病根是**缺短语级信号**——process 型查询的答案块
  与查询有 5~8 字连续命中（10 题里 8 题），而 top1 只有 2~3 题有。
- **`metadata.aliases` 参与 section 短语匹配**（单串/数组都认）：同一主题可写多个不同「措辞粒度」的问法。
- **状态页目录注入（`runtime.buildStatusPageLayer`）**：把 `kindOfSnapshot=weekly-status` 且 active 的
  记忆标题（最多 8 条）作为一段短目录放进 `stableContext`，60s 缓存。
  解决"别名枚举不到的问法"——侧面是开放集合，靠别名穷举覆盖不完。

#### 性能与基础设施（B0 / B0.5 / B0.6）

- **`searchTextCache`（进程内）**：缓存 `searchText` 派生的 tokens 与 128 维哈希向量，键 `id` + `updatedAt` 指纹。
  实测 5,018 条单次 `search` **610ms → 91ms**（原实现中逐条实时算向量占 531ms，`store.load()` 仅 45ms）。
  安全性依据：`update()` 必改 `updatedAt`；`recordRecallCounts` 直改 metadata 不走 `update`（召回不打掉缓存）；
  `buildSearchText` 不含 metadata。
- **`docVectorCache`（进程内）**：`retrieval.searchBuiltin` 原对 `baseHits`（top-**512**）**每次 recall 全量重算远程 embedding**
  —— 实测带 agent context 的 HTTP recall **9.8s**（core search 只占 94ms）。修复后 **9.8s → 1.6s**，top-8 重合 8/8。
- **`SqliteVectorCache` + `memory_vectors` 表（跨进程持久）**：`(id, model_id, updated_at, dims, vector BLOB)`，
  与记忆同库、**不动 `memory_items`**。检索改三级查找：进程内 Map → SQLite → 远程 embedding。
  重启后同批查询 **5.7s → 2.3s**。`model_id` 记 `provider:model`（如 `openai:BAAI/bge-m3`），
  换模型必须失效，否则混用不同向量空间。

#### 观测与运维

- **`LEAFMEM_TIMING=1` 分阶段耗时打点**：输出 `palaceRecall / retrievalRecall / activeBlocks / taskWindow /
  navigation / statusPages / assemble`。实测稳态 retrievalRecall≈700–1000ms、palaceRecall≈220–280ms、其余≈0。
- **`ops/daily_chunker.py` 结构分块内核**：段落 / 列表 / 表格 / fenced code 为天然边界（表格与代码块原子不切），
  超长块再按中文句末标点细分，目标 900 字 / 下限 350 / 硬上限 5200；纯装饰分隔行（`---`）规范化剔除。
  **不采用 embedding 语义分块**——NAACL 2025《Is Semantic Chunking Worth the Computational Cost?》
  结论是额外算力换不来稳定收益，且实测易过碎（均值 43 tokens 时准确率反而低于递归 512 tokens）。
- **面包屑标题前缀写进正文**（`[日期·节标题·k/n]`，增量续写为 `·续N`）：向量与词法两路都能看到标题词，
  零 LLM 成本；Anthropic contextual retrieval 报告该族做法可降 top-20 失败率 35%~49%。
- **父块锚点**：每条块 metadata 带 `source_file / section / chunk{index,segment_total,seq,chars,span,continued}`，
  hits 后可回读整节或原文区间（small-to-big 的最小实现）。
- **`ops/ingest-daily-logs.py --rebuild-state` / `--selftest`**：从库内 `chunk.span` 反推偏移重建 state
  （杜绝"state 丢了就整批重导"）；`--selftest` 断言「块正文拼接（去空白）== 原文（去空白）」+ span 不重叠不越界。
- **`MemoryInput.dedupe?: boolean`（含 HTTP/平台透传）**：`false` 跳过服务端 0.85 语义合并。

### Changed

- 🔴 **默认检索排序会变（升级前请读）**：`LEAFMEM_LEXICAL_LEN_NORM` 默认 `sqrt`、
  `LEAFMEM_PRINCIPLE_BOOST_MODE` 默认 `tiebreak`、`LEAFMEM_SECTION_BOOST` 默认 `0.2`。
  41 题 golden 实测：core R@1 **9→28**、R@8 **25→38**；retrieval R@1 **27→31**、R@8 **36→39**、MRR 0.741→**0.829**。
  需要旧行为可显式设 `LEAFMEM_LEXICAL_LEN_NORM=off`、`LEAFMEM_PRINCIPLE_BOOST_MODE=flat`、`LEAFMEM_SECTION_BOOST=0`。
- **`PRINCIPLE_BOOST` 由"无条件加分"改为"排序期 tie-break"**：原实现只要 `kind=principle` 就白得 0.1，
  与其注释意图（"打平时让 curated 指南上位"）不符，实测导致 process 型查询 10 题里 6 题 top1 是无关原则。
- **rerank 参数由实测定档：`RERANK_TOP_K` 40 → 20、`RERANK_DOC_CHARS` 默认 4000（原先整篇送）**。
  15 条标注题正文覆盖 @1/@3/@8：不启用 rerank 4/5/7、topK40+全文 6/9/10（p50 1597ms）、
  **topK20+全文 6/10/10（p50 906ms）**、topK10 5/9/9。截断长度实测单调（800→4/7/9、4000→6/9/10），
  故 4000 是饱和点而非折中。生产端到端 recall p50 **1561ms → 1023ms（-34%）**。
- **rerank 失败不再静默**：`CrossEncoderReranker` 记录 `lastFailure` 并在降级时输出节流警告（5 分钟一次）。
  此前 429/超时一律 `return null`，表现为"配了 rerank 却不生效"。实测 siliconflow 连续约 11 次调用即 429。
- **`ops/ingest-daily-logs.py` 升 v3**：增量记账由「按行切 +（续N）」改为**字符偏移续写**
  （块尾天然落在结构/句边界）+ 块指纹 `state.seen` 吸收回退重叠；state 版本 3（旧 state 自动重建为空）。
  实测 293 个 daily md / 3600 节 → **4922 块，无损校验失败 0**，p50=645 / max=4828。

### Fixed

- **FTS 未排除已失效记录**：`ftsBoosts` 的 SQL 只 JOIN `memory_items` 判存活，没排除 `superseded`——
  它们既占满 `LIMIT 30` 名额，又通过 idf 影响全库 BM25。迁移 2,411 条后实测 6 条查询 `fts` 分项漂移 0.066~0.538。
  语义上也不成立：已被取代的事实不该影响"当前"答案的排序。
- **单条 `POST /v1/memories` 未透传 `dedupe`**（批量路由早已透传）：导致 `dedupe:false` 在单条路径被静默忽略。
  实际事故：恢复脚本写回一条与既有块同文的记录 → 0.85 去重把它合并进该块并返回**该块的 id** → 按该 id 删除，误删真实块。
- **`DELETE /v1/memories/batch` 的 scope 只认 query**：body 里的 `scope` 被静默忽略 ⇒ 返回 `{"deleted":0}` 且 HTTP 200。
  现在两处都接受，且"有 ids 却一条没删掉、又没给 scope"时回 `warning` 字段，不再假装成功。
- **`ops/ingest-daily-logs.py` 增加 state 缺失 fail-safe**：去重完全依赖 `--state`（`seen` + `lens` 记账），
  state 缺失时整批历史 daily 节会被当作全新导入。实测首跑后 state 未留存，此时重跑将重复入库 **2,698 节**；
  且 LeafMem 同 kind+tags 为 UPDATE 覆盖语义，重复导入会连带改写原条目，属破坏性。
  现行为：state 不存在且未显式传 `--force-fresh` → 打印原因并以 **exit 3** 拒绝执行。
- **`core/memory.ts` 实例化 `RetrievalManager` 时漏传可选能力**：`vectorCache` 未透传且缓存层 fail-open ⇒
  既不报错也不建表，功能"上线了但毫无效果"。新增可选能力后必须验证**产物存在**（表行数/计数器），不能只看类型检查通过。

## [0.3.23] - 2026-10-21

### Added
- **`src/agents/identity-path.ts`**：解析宿主**真实**身份文件路径。WorkBuddy 有 path service 时读到 `~/.workbuddy/user-<uuid>-personal/`（`workspace-state.json` 或身份文件存在即认定为 persona 目录），否则回退 `~/.workbuddy`。此前安装器硬编码 `~/.workbuddy/SOUL.md`，会把注入块写进宿主不读的文件（2026-10-21 实证：一轮 SOUL 优化白做）。
- **`src/agents/marked-block.ts`**：身份文件的标记块安全写入器——块内版本标记（`version=N`）、写前自动备份到 `~/.leafmem/backup/identity/<ts>/`、`写临时文件 + rename` 原子替换、**写后校验「块恰好 1 份 + 块外内容 hash 不变」**；标记不成对（只有 start）时**拒绝写入**而不是追加第二个块；软链路径先 `realpath` 再写（`rename` 会替换软链本身）。
- **`test/instructions.test.ts`**：7 条单测覆盖首次追加/替换保块外/幂等/坏标记拒绝/空文件/路径解析/软链写入。

- **注入块压缩（v3）**：16 条 → 7 组，6,473 → **3,022 字符（-53%）**；压缩中保留全部承重表述（`Lifecycle hooks are the primary path`、`Do this silently`、`defaults writes to agent:<scope>`、四工具名、`agent/sessionId/rollingSummary`、`status:"active"`、`maintenanceRequest`、禁直写 SQLite、`tags` 数组、`importance` 数字、CLI 首通道）。
- **注入块契约测试**（`test/instruction-block.test.ts`）：断言 15 个承重 token + 体积 <3,200 + CLI 是 PRIMARY；删规则会直接 CI 失败。
- **`placement:"top"` 支持**：块已存在时保持原位；首次安装钉在文件顶部（原有内容完整保留在块后）。

### Changed
- `installInstructions`（manager.ts）与 `writeWorkBuddyInstructions`（workbuddy.ts）统一走上述安全写入器；指令块首行新增 `<!-- leafmem-agent-instructions:version=2 -->`。

### Changed（第三批：投影清理与幂等）
- **`writeMarkdownListFile` 加护栏**：该原语会用渲染结果**整文件覆盖**并按 1,375/2,200 字符截断——对 30KB 身份文件＝静默损毁。现在：非空文件禁止被清空、新内容 <50% 时拒绝写入，除非显式 `allowShrink`（4 条单测锁定）。
- **hermes / openclaw 的 `syncProjection` 全部禁用**：与 mcp bin（2026-08-06）、workbuddy 保持一致——身份文件归用户所有，只做单向导入（`importExistingMemory`），不再把 DB 记录投影回写。
- **注入块改为宿主中性**：`update workbuddy` / `update kunlunxiaozhi` 写成 `update <host>`（示例仍给 `update workbuddy`）。此前双宿主共享同一 SOUL 时，每次安装会互相覆盖 → 永不幂等、反复产生备份（实测一次安装 9 份）。现三跑 hash 完全一致。

### Fixed
- 安装器把指令块写到宿主不读取的路径（顶层 `SOUL.md` 而非 scoped persona 目录）。
- 旧写入器无备份、无版本标记、坏标记会追加重复块。

### Added
- **`ops/ingest-daily-logs.py`（daily md → LeafMem 回流工具，产品化）**：把每日工作日志（`YYYY-MM-DD.md`）按 `## ` 节切分后增量写入 LeafMem（kind=experience，tags=[daily-log, 源, 日期]，metadata 带 source_file/section 可溯源）。参数化：`--source tag=path`（可重复）、`--api`、`--state`、`--scope`、`--max-len`、`--dry-run`。
- **A-MEM 式记忆间链接**（NeurIPS 2025 A-Mem 借鉴）：新表 `memory_links`（source/target/relation/confidence，区别于 entity_links 的记忆-实体链接）；召回命中 top5 的链接邻居以「🔗 关联记忆」块附加注入（走 `layers.linked` 跨后端通道，不占 hits 配额）。成本纪律：引擎写入时不调 LLM 建链，建链归宿主（规则版每日/LLM 判断版每周）。
- **召回保温**（Retrieval-Driven Reconsolidation 借鉴）：recency 评分取 `updatedAt` 与 `lastRecalledAt` 较新者——常被召回的记忆保温，不只按写入时间衰减。
- **`memory_govern` 新增 `supersede` 动作**（Zep invalidate-don't-delete 写入侧）：旧记忆被取代时链到新条 + 降权不删除，历史可查；同写 `memory_links(supersede)`。
- **受控词表 mtime 热加载**：`entity-vocab.json` 变化后下一条写入即生效，免重启服务。
- **console 记忆浏览页新增「全部标签」筛选下拉**（tag 频次 top12 + 计数）。
- **console 知识图谱交互重构**：布局归一化（主连通分量包围盒映射视口，力参数只负责相对结构）；deg=1 叶节点锚定邻接点；非主分量落外围环；语义缩放（标签/节点屏显恒定）；fit 双模式（默认主分量充满 /「适应屏幕」全节点）；**密度过滤**（per-node top-5 边 + 边透明度按权重分级 + 标签 top-degree 渐进 + 节点 glow 移除 + 「弱边」开关并声明过滤计数）；**箭头三档透明度**（SVG marker 不继承 stroke-opacity）；**筛选+选中语义**（选择邻域覆盖类别过滤：跨类邻居 context 档显示并带标签，NERVIS 规则）；筛选态标签全显（可见 ≤60 保底）。
- **`ops/ci-watch.sh`**：push 后轮询 GitHub Actions 到 conclusion 的机制化脚本（替代"口头承诺等 CI"）。
- README 新增 3.4（实体抽取判据与受控词表增强通道）、3.5（记忆链接/保温/取代机制）——console 帮助页同步。

### Fixed
- **实体抽取 person 准确率修复（22 个 person 中 18 个噪声）**。根因两处：① `@mention→person` 启发式守卫太弱（只挡版本号/纯数字/7 泛词），字段名（paraId/idref/version）、标签词（mention/skill/image）、时长（120s/2K）、包名命名空间（xdragonjia/clawhub_*/user_*）全被建成 person；② `MENTION_RE` 的 `\w` 不含 CJK，`@韩丽敏` 只能匹配单字——**中文人名永远抽不出来，抽出来的全是英文噪声**。修复：
  - 噪声三重拦截：NOISE_MENTIONS 词表（字段/标签/结构词）+ NOISE_MENTION_RE（时长/编号形态）+ CHINESE_NON_PERSON 领域停用词（@巡察/@整改 等过形态但非人名）。
  - person 似然判据 PERSON_LIKE_RE：中文 2-4 字 / 首大写英文 / 小写单词；驼峰/全大写/下划线/带数字形态一律不建 person。
  - 包名形态 → 新 kind `namespace`（EntityKind 开放枚举）；产品名（ima/larksuite/workbuddy-buddy）→ `tool`。
  - MENTION_RE 扩展 CJK 字符类，中文 @mention 可完整抽取。
  - 受控词表增强通道：语义层权威实体（图谱 ONT_Person 481/ONT_Organization 116，源自文档注册表结构化 owner）经 export_vocab_to_leafmem.py 导出 entity-vocab.json，strict 模式第 0 步优先命中——**无 @ 符号的权威人名也能正确建 person**（本机端到端实测）。
  - 存量矫正：删 14 噪声 person、重分类 4（ima/larksuite/workbuddy-buddy→tool、xdragonjia→namespace，先改 kind 保链接再删）；语义层 bridge_leafmem.py 同步补"LeafMem 已删实体的图内残留清理"（原先只 MERGE 不删）。
  - 测试 18/18（新增噪声拒绝 + strict 真人抽取 + 中文停用词 + 短 CJK 词表子串防护用例）；tsc 0 错。
  - **词表子串误命中防护**：≤2 字 CJK 词表名只在 @mention 形态命中（实测"国王健康椅"误抽 person"王健"）；≥3 字名保留裸文本 includes（权威人名主通道）。

### Fixed（daily 回流管线）
- **append-only 日志的增量去重漏尾部（严重）**：旧实现以「节标题 + 正文前 200 字」做指纹，节尾追加内容不改指纹 → 当天下午/晚上的日志被永久跳过、静默丢失。改为按**已入长度**比对（`state['lens']`），节增长 >40 字即把新增部分以「（续N）」分段入库（≤4800 字/段）；state 只在发送成功后记账，失败自动重试。
- **长节截断后的尾部丢失**：单节超过 5600 字被截断的部分此前永不入库，现由增量机制补齐。
- **源目录硬断言过严**：非关键源缺失会导致整脚本退出（连累全部源），现降级为跳过并告警。

### Changed（维护层与发布卫生）
- **`task_append` status 运行时枚举校验**：非法状态不再静默入库。
- **`commit-summary` 零产出显式失败化（exit 3）**：避免"看起来成功"的空产出。
- **版本化 pre-push `publish-audit` 钩子**：发布审计前移到推送前。
- **leafmem-maintenance 技能 v1.4.1 → v1.8.3**：36 位 UUID 强制（principle metadata.supports）、自动化会话走 MCP stdio 通道、去重/碎片判据量化、复验鉴权口径与收尾留痕、残留任务闭环清扫、governance scope 参数与 profile 节数口径、`archive_dump.py` 定为步骤 3 标准实现、周报输出路径固定、短 id 查询修正 + 渐进披露引用、体积余量专项 + 步骤 5b 判定维度。
- **测试**：export 断言改确定性轮询（修 CI flaky 39557197915——count 依赖库残留状态）。

### Fixed（沿革：2026-09-11 四层写入闸门，随本版发布）
- **四层写入侧闸门：自动化任务书整段入库致全库召回 400 根治（2026-09-11，09-10/09-11 两日连续复发）**。根因链（备份库取证实证）：自动化会话的 `<user_query>` 内文就是系统生成的任务书全文（7951 字符），`sanitizeCapturedText` 的 user_query 提取将其当人类原话放行 → 规则提取器 decision cue「改用」在任务书正文命中（@6020）→ `normalizeMemoryCandidate` 无长度上限 → 整段任务书以 `content==summary`、`kind=decision`、`source=turn_inference` 入库 → recall 批量 embedding 超 bge-m3 单条上限 → **全库** recall 400。四层设防：
  - L1 `sanitize.ts` + hooks 桥客户端副本：自动化任务书拦截——骨架标志（`automation_system_reminder` / `<automations>` / `<user-prompt-submit-hook>`）直接拒；长文（>1500 字符）+ 宿主任务书句式（`You MUST follow these steps` / `Execute the task as specified in the user query`）组合拒。hook 对净化为空的行为为静默跳过（不发请求不报错），自动化会话 Stop 自动捕获（垃圾主要来源）随之停用，合法记忆走 CLI 显式写入不受影响。
  - L2 `runtime.ts` 规则提取器：推断候选（turn_inference）>500 字符丢弃——规则 cue 只该抓一句话声明；`explicit_remember`（用户说"记住：…"）豁免、上限 6000 与核心层一致（避免误杀显式长内容）。
  - L3 `service.ts` captureTurn：自动推断候选（turn_inference/llm_extraction）>2000 字符丢弃；显式 remember 豁免。
  - L4 `core/memory.ts`：`MAX_MEMORY_CONTENT_CHARS = 6000` 全通道硬上限（remember + update 双入口，`update()` 此前可绕过——变更推演发现的 G2 缺口同轮修复），超过即拒绝并提示拆分；6000 位于实测安全区（现有最长合法记录 5318 OK / 事故记录 7951 爆 400）。
  - 验证：真实 HTTP 端到端——任务书 capture 0 入库；2122 字符含 cue 长文 0 入库；显式记住 2292 字符正常入库；合法 3257/5500 字符 lesson 字节级完整；8400 字符 remember 与 7000 字符 update content 均拒绝且报错明确；recall 健康（CLI hits=8 命中旧记忆）。全量测试 286/286。

## [0.3.22] - 2026-09-06

### Added
- **知识图谱 d3-force 全面升级（三轮用户反馈迭代）**：console 知识图谱从手搓 canvas 力导升级为 d3-force 驱动——vendor `d3.min.js` 随包分发 + 懒加载 + 手搓 canvas 兜底降级；滚轮缩放/拖拽/悬停邻接高亮；点击节点**持久选中**（选中节点+关联高亮锁定，点空白取消）+ 右侧滑出式详情面板（点击才弹出，关联实体可点击跳转定位）；方向箭头（灰/高亮双 marker）；工具按钮：适应屏幕/箭头开关/重新布局。
- **图谱页全屏响应式**：图谱区占满除左侧菜单与顶栏外的全部空间，窗口缩放时 ResizeObserver 自动"适应屏幕"（zoom transform 适配，不动节点坐标、无重新洗牌）。

### Fixed
- **箭头"糊成一片"根因链修复（两轮）**：①`markerUnits` 默认 `strokeWidth` 导致箭头尺寸=markerWidth×边宽，hub 粗边箭头放大 4 倍——改 `userSpaceOnUse` 固定尺寸；②再缩小至 9×5.5px 对齐 weknora 小巧感；③边端点按目标节点半径截断让箭头贴边。
- **布局"中间挤"根因修复**：高权重边 strength 封顶 0.85 把 hub 焊死中心（共现多≠拉更紧）——strength 封顶 0.45、link distance 95-155、charge 增加 `distanceMax(430)`（斥力只作用近邻）；中心区节点数 39→27。
- **孤立节点过远致适应屏幕整体缩太小**：孤立环原贴容器边缘排布（fit 缩放 ~0.55）——改固定紧凑半径 360（fit ~0.85）。
- **拖拽松手弹回原位**：drag end 保留 fx/fy（_dragged 标记），节点停留在拖放位置；重进页面或点"重新布局"才整体重排。
- **console 静态资源路径潜在 bug**：相对路径 `console/x.js` 在 `/console/` 尾斜杠入口下错解析为 `/console/console/`（SPA 兜底把 HTML 当 JS 返回）——改根绝对路径，mermaid 加载器同病同修。

## [0.3.21] - 2026-09-04

### Added
- **leafmem-cli 主动加载通道**：新增 `ops/leafmem-cli.sh`（12 子命令：health/recall/inspect-recall/remember/get/list/update/delete/stats/scopes/task-detail/commit-summary），封装 launchd 常驻 agent service 的 HTTP API（127.0.0.1:3377），独立于宿主 MCP 工具注册。安装/升级时自动部署到 `~/.leafmem/leafmem-cli.sh`（hooks.ts 新增 `installLeafmemCli`）。
- **SOUL 模板新增自动化降级链纪律**：`workBuddyInstructionBlock` 增加 "Automation active-loading channel" 条款——自动化会话读写 LeafMem 必须按 ①直连 MCP 工具 → ②leafmem-cli HTTP → ③宿主会话搜索 三级降级；①失败不得默认"环境差异"静默放过，须记录并取证宿主回归。所有用户新安装/`leafmem-agent update` 升级自动获得。

### Fixed
- **自动化会话 leafmem 工具不可用根因修复（宿主回归免疫层）**：WorkBuddy 5.5.1 对自定义 MCP 的 `--mcp-config` 注入即使包含完整配置且 stdio 连接成功（`doConnect OK`），仍无视 `defer_loading:false`、工具强进 deferred 索引后漏收，致自动化会话零 `mcp__leafmem__*` 工具（2026-09-04 日志实证：`Indexing deferred tools for server: leafmem` + 会话工具列表无 leafmem）。5.5.3 已修复字段尊重，但宿主升级可能回归；本版本提供 HTTP 通道作为不受宿主注册影响的保底链路。
- **leafmem-cli 含空格长文本被静默截断（2026-09-06 修复，数据损坏级）**：`ops/leafmem-cli.sh` 中 4 处向 Python 传参写作未加引号的 `${@:-}`（recall 行 67 / remember 行 98 / list 行 122 / update 行 148），shell 词分割会把 `--content "长文本 含空格"` 拆成多个独立参数，Python 侧 `a[i+1]` 只取到第一个词——**所有含空格的长文本字段被静默截断为首 token，无报错、无警告**。实测暴露：`update <id> --content "<699 字符>"` 回读后 content 仅剩 `2026-09-06`（10 字符）。全部改为 `${@+"$@"}`（仅当 `$@` 已设置才展开且保留引号语义，同时兼容 macOS 自带 bash 3.2 在 `set -u` 下的空 `"$@"` 展开）。验证三项：①`health`（空 `$@` 场景）exit=0，`set -u` 兼容性未破坏；②`update --summary "<84 字符含空格>"` 回读长度完整；③被截断的存量记录经 MCP `memory_govern(action=update)` 修复（content 699 字符 / tags 9 项 / kind、importance 完整）。
  - 影响范围：本缺陷自 0.3.21 引入 `leafmem-cli.sh` 起存在于所有 4 个写/查子命令的**可选参数透传路径**（位置参数 `$1`-`$5` 因带引号不受影响，故 recall/remember 的主文本正常、仅 `--tags`/`--metadata` 等尾部可选项及 update/list 全量参数受害）。0.3.21 未发布 npm（registry latest 仍为 0.3.19）也未打 tag，故本修复并入 0.3.21 而非另起 0.3.22。
  - 🔴 **升级用户须注意**：`installLeafmemCli()` 每次安装/升级会无条件 `copyFile` 覆盖 `~/.leafmem/leafmem-cli.sh`，因此只手工修本地副本会在下次 `leafmem-agent update` 时被回滚——修复必须落在仓库 `ops/leafmem-cli.sh`（本次已落）。
  - 泛化纪律：用 CLI 写含空格长文本后必须**回读校验字段长度**，不能只看退出码；CLI 与 MCP 两通道互为备份（本次即由 MCP 修复 CLI 损坏的数据）。

### Changed
- **自动化通道定版 CLI-first**：一次性自动化实测（2026-09-04 晚）证明自动化调度会话中 `mcp__leafmem__*` 工具恒 absent（5.5.1/5.5.3 一致，deferred 索引寻址失效），HTTP CLI 由降级备胎升格为**主通道**。SOUL 模板条款、daily-sentinel / weekly-maintenance 两个产品 SOP、README 1.7、leafmem-maintenance 技能（维护 SOP canary 召回分支）全部改为 CLI-first：自动化首选 leafmem-cli；MCP 工具恰在函数表时可顺带直调，缺席属预期、不判异常、不静默重试。
- **leafmem-cli 字段面补全**：`remember` 新增 `--tags/--confidence/--source/--metadata`（tags 缺失被一次性验证任务实测暴露）；`update` 新增 `--tags/--metadata`；`list` 新增 `--tags/--cursor`；`recall` 新增 `--task-title/--tool-context`。全部字段对齐 HTTP 路由支持面，E2E 验证 tags 写入→读回→list 过滤→更新全链路。规避 macOS 系统 bash 3.2 下 `set -u` 空 `"$@"` 崩溃的兼容问题（当时采用 `${@:-}` 写法；🔴 该写法本身引入词分割缺陷，已于 2026-09-06 改为 `${@+"$@"}`，详见上方 Fixed）。
- `ops/automations/daily-sentinel.md` canary 段同步三级降级链与宿主回归取证命令。

## [0.3.20] - 2026-09-04

### Fixed
- **WorkBuddy/KLXZ ≥5.5.1 defer_loading 回归免疫**：宿主对 mcp.json 中未显式声明 `defer_loading` 的 MCP server 默认注入 `true`（app.asar `buildDesiredConfigs` 源码证实，与官方文档"默认 false"矛盾，属 5.5.1 升级回归），导致 leafmem 4 个工具转 deferred 模式、依赖 ToolSearch 检索激活，长会话/自动化会话中"时有时无"并两次引发"LeafMem 不可用"误判（2026-09-03/04）。安装器 `writeJsonMcpConfig` 现写入 `mcpServers.leafmem` 时固定带 `"defer_loading": false`（显式 boolean 被宿主尊重、工具直连注册），`setMemoryTopology` 同步自愈确保既有条目也被纠正——重装/升级/拓扑切换均不再复发。

### Changed
- `INSTALL-WORKBUDDY.md` / `INSTALL-KUNLUNXIAOZHI.md` 步骤 1 新增 defer_loading 必读说明（背景、安装器自动写入、手工维护须保留该字段、核对方法）。

## [0.3.19] - 2026-09-03

### Added
- **周度观察并入每周深度整理**：原开发期「周度观察+飞书提醒」任务到期下线，其持久机制并入每周维护——`ops/automations/weekly-maintenance.md` 新增 B 段周度观察（采集+周环比五项判断）与周报输出；`leafmem-maintenance` 技能升至 1.3.0 新增步骤 10 周度观察 + 步骤 11 周报口径。
- **observation.py 随包分发**：`ops/observation.py` 加入 npm `files`，其他用户安装后可直接使用周度观察采集脚本。
- **实体词表巡检机制**：`leafmem-maintenance` 技能升至 1.4.0——周度观察判断清单新增 f 项（entity_count 停滞检测：记忆增长但实体连续 2 周零增长 = 词表陈旧信号），新增步骤 11 实体词表巡检。起因：strict 抽取器下实体增长完全依赖词表人工更新，本机实测 leafmem 本身在 145 条记忆中出现却因不在词表而无实体。
- **ops/entity-relink.mjs 随包分发**：词表更新后的存量记忆纯增量补链脚本（幂等三接口只加不删，--dry 精确预估，LEAFMEM_DB 可覆盖库路径）。

### Fixed
- **知识图谱实体关联"大量重复"**：实体详情面板与力导向图按"实体对"聚合（原按记忆逐行显示——数据层零真重复，2707 行关系实为 712 个实体对 × 各自记忆）。面板显示共现次数徽标（×N），图谱边带 weight，边数 2707→703，节点度数与边宽不再灌水。

### Changed
- **observation.py scope 通用化**：原硬编码 `SCOPE="workbuddy"` 改为自动探测主 scope（记录数最多的 agent scope，与主 scope 模型一致），可用环境变量 `LEAFMEM_SCOPE` 覆盖，确保任意宿主用户可正确采集。

## [0.3.18] - 2026-08-13

### Fixed
- **画像卡间距**：dashboard 用户画像卡片加 margin-top 16px，与 grid2 卡片间距一致。
- **详情浮窗半透明**：drawer 背景改 rgba(255,255,255,.92) 实色+毛玻璃模糊，不再透字。
- **任务详情固定文字溢出**：底部说明文字 white-space normal+wrap，不再溢出屏幕。
- **图谱视觉打磨**：节点发光+白描边、边按连接强度变粗、hover 浮窗圆角玻璃底。

## [0.3.17] - 2026-08-13

### Changed
- **console 全面换肤为玻璃拟态（V2-glass，用户选定）**：浅色渐变背景+光斑
  装饰、毛玻璃侧边栏（backdrop-filter）、卡片/KPI 毛玻璃浮层+hover 抬起
  动效。仅视觉层，页面结构/逻辑/条件渲染零改动。
- **侧边栏加三组导航分类**：概览（仪表盘/记忆浏览/任务上下文/召回检查）、
  治理（洞察/知识图谱/事件日志）、系统（宿主接入/帮助文档）。

## [0.3.16] - 2026-08-12

### Fixed
- **翻页闪回顶部**：renderPage 渲染后恢复滚动位置（keepScroll 助手），
  洞察原则/记忆浏览/任务/事件四处翻页均不再跳顶（浏览器实测 scroll 保持）。
- **切页页码残留**：goPage 切走时重置 explorer/tasks/events/principles 四个
  页码（与 recallQuery 同纪律），切回即第一页（实测第3页→切走→返回第1页）。
- **事件时间列**：第一列改完整日期时间（2026-08-12 23:09），翻页可辨日。
- **任务详情时间**：浮窗加「创建 · 更新」完整日期时间行。

## [0.3.15] - 2026-08-12

### Fixed
- **记忆浏览横向溢出**：长不可断字符串（路径/token）撑宽表格超出页面背景。
  table-layout:fixed + overflow-wrap:anywhere，浏览器实测异常页无横向溢出。

### Changed
- **洞察页重设计**：用户画像改整宽卡片、分节按逻辑排序（身份→偏好→习惯→
  约束→环境）双列卡片；蒸馏原则改记忆浏览式交互——分页（8/页）+ 就地展开
  全文（不再闪回顶部、不再只显示标签）。PrincipleView 增加 content 全文。
- **事件日志翻页**：/v1/events 支持 offset+total（recent() 返回
  {events,total}），页面 50/页可翻全量（审计保留 2000 条，页面明示）。

## [0.3.14] - 2026-08-12

### Fixed
- **门禁无 sessionStartAt 时静默失效**（完整验收 v0.3.12 时发现）：countAgentWrites
  旧回退"无数话起点则数任何历史写入"，对长期账户恒>0→门禁永远放行。现回退为
  保守 2h 窗口近似"本会话"。实测三态矩阵正确（BLOCK/问号豁免/近期有写放行）。

### Added
- **console 任务页删除按钮**：详情浮窗「删除该任务上下文」+列表 DELETE
  /v1/tasks?id= 路由（两段 confirm，级联清除 transcript/摘要，不影响记忆记录）。
  浏览器实测全流程通过（按钮→确认文案→列表消失→浮窗关闭→DB 归零）。

## [0.3.13] - 2026-08-12

### Added
- **任务删除通道**：此前任务只能 completed/archived，测试探针等噪音任务
  永久可见（用户截图发现 probe4/probe5）。现：
  - store（Sqlite 级联 FK + InMemory）与 manager 增加 `deleteTask`；
  - MCP `memory_write(action="task_delete", taskId)`；
  - 删除不存在的任务返回 `deleted:false`（干净语义，非报错）。

### Tests
- 删除级联回归（InMemory）+ 真实 MCP stdio 端到端（真库创建→删除→零残留）；
  连带影响扫描（events/capture-state/tmp）全绿。281/281。

## [0.3.12] - 2026-08-12

### Added
- **SessionStart hook（会话预热）**：新会话注入进行中的任务上下文
  （active/paused 任务+rolling_summary），跨会话续接从"用户口述"变"自动恢复"；
  无在途任务静默跳过。`/v1/tasks` 列表路由补 rolling_summary（LEFT JOIN
  state 表）。双宿主注册（install 器 events 数组加 SessionStart）。
- **Stop 门禁问号豁免**：`last_assistant_message` 以 ?/？ 结尾（回合未完结、
  等用户输入）不拉回——借鉴 workbuddy-buddy ends_with_question 信号
  （其 spool 实测 1/6 Stop 为 True）。

### Changed
- **stdin 限读**：hook 输入超 1MB 整包丢弃 fail-open（与 buddy 同纪律，防
  异常 payload 拖垮/撑爆 hook）。

### Docs
- 桌宠研究报告 v1.5：未竟观测三项补全 + buddy 源码再读 + 实施记录。

## [0.3.11] - 2026-08-12

### Fixed
- **事件数据未转义吞掉整块 DOM（含画像卡）**：仪表盘「最近活动」与事件页对
  事件 data 的字符串值未 esc；08-12 01:50 的 recall 事件 query 恰为含
  `<!-- … -->` 标记的自动化 prompt，裸 `<!--` 注入 innerHTML 后把后续全部
  DOM（画像卡）吞进注释节点——卡片不是没渲染，是被 HTML 注释"埋葬"。
  两处 `tl-data` 渲染补 esc。浏览器实测画像卡恢复、comment 节点归零。

## [0.3.10] - 2026-08-12

### Fixed
- **仪表盘画像卡静默消失**：08-10 前 console 的 localStorage 存裸 scope 值
  （`workbuddy` 无 `agent:` 前缀），governance 落到空 project scope 找不到画像，
  卡片三元 else 为空串→整块消失且无提示。现：scope-context 裸值映射
  agent:<值>；console 读取时归一；卡片 else 分支显示占位说明（不再静默消失）。
- **备份链路断链修复**：已部署 launchd plist 仍指向已移除的旧外部路径
  （08-11 23:30 与 08-12 03:15 备份失败）。从仓库模板重新部署
  com.leafmem.sqlite-backup.plist，立即补备，launchd 健康。

## [0.3.9] - 2026-08-12

### Changed
- **时间存储与展示统一**（行业标准：存 UTC、显式时区渲染）：
  - 存储与 API：全部时间戳统一为 ISO 8601 UTC 字符串；task 族表由 epoch-ms
    INTEGER 迁移（`migrateTaskTimestampsToIso`，开库即跑、幂等）；DDL 改 TEXT；
    读取侧 `isoOrEpoch` 防御性归一。
  - console：单一 fmtDate/fmtTime/fmtDateTime 入口，基于
    `Intl.DateTimeFormat(timeZone:'Asia/Shanghai')`——所有页面时间一律北京
    时间，不随浏览器时区、不显示裸 UTC。此前「有的 UTC 有的本地」的混乱消除。
  - ARCHITECTURE.md 新增 Time Convention 章节。

## [0.3.8] - 2026-08-12

### Fixed
- **启发式质量底线**：净化后的 transcript 残余「.」通过 preference 线索被存成
  内容为「.」的记忆（KLXZ 自动化会话事故）。现 `inferMemoryProposals` 过滤无
  实质内容的 proposal（去标点后≥6 字符才算实质）。
- **门禁 block 指令点名未关闭任务**：0.3.6 门禁正确拉回 agent 后，agent 仍可能
  做裸 task_append（无 rollingSummary/status），任务页保持 active 无 summary。
  通用③④依赖 agent 自觉。现 block 时查询本会话有新进度
  （updated_at≥sessionStartAt）且未 completed/archived 的任务，点名加入指令⑤，
  要求逐条闭环。

## [0.3.7] - 2026-08-12

### Fixed
- **单测污染真实审计日志**：`runMemoryMcpStdioServer` 在测试传 in-memory memory
  但未传 storagePath 时，审计事件库回落到真实 `~/.leafmem/memory.sqlite`——
  测试的 mock 写入把幽灵 memory_written 事件写进生产 console 事件页，记录本身
  随进程消亡（事件 61d8652c 即此，用户截图发现）。现 events 可注入，stdio 测试
  注入 InMemoryInspectEventStore；实测跑测试对真库零污染；6 条幽灵事件已清。

## [0.3.6] - 2026-08-11

### Fixed
- **Stop 门禁判据错误（双向）**：原门控以「启发式是否捕获」为 block 条件。
  ①硬写误触发（stored>0）会**致盲门禁**——agent 不被拉回总结，控制台只剩
  硬写垃圾（0.3.5 身份误存事故的连锁效应）；②agent 主动写过而启发式没捕获
  时被**多余 block**。现门禁问正确的问题：「本会话 agent 是否主动写入」
  （UPS 记 sessionStartAt；Stop 查 `GET /v1/memories?scope=agent:<id>`，
  统计 source 非 capture 路径且 createdAt≥会话起点的记录数；零条且实质工作
  才 block 一次；查询不可用 fail-open）。启发式 stored 数降为诊断信息。
  8 门禁测试含事故 fixture。

## [0.3.5] - 2026-08-11

### Fixed
- **启发式 capture 误存用户原话为 identity 记忆**：「我是通过 proxifier 访问
  github 的，…删除三行…@image#1:…」整句被存成身份记忆——裸「我是」线索命中
  了动作描述。identity 分支现排除「我是+方式/动作短语」（我是通过/用/在/正在…
  及英文等价），真实自我介绍仍捕获；`@image#N:…` 附件标记在所有启发式匹配前
  剥离。4 个回归测试（真实原话作 fixture）。

## [0.3.4] - 2026-08-11

### Added
- **任务生命周期关闭路径**：`TaskContextManager.setStatus()` + MCP `memory_write`
  的 `task_append` 接受可选 `status`（active/paused/completed/archived），创建时与
  存量转换均可。此前四态枚举只有类型定义、无任何转换写路径，task_append 建的
  任务永远停在 active（08-11 用户截图发现的机制缺陷）。
- **Stop 驱动指令④ 关闭一致性**：传 `status="completed"` 必须同传闭环版
  `rollingSummary`（清除待办/未完成表述）——completed 徽章配过时待办比没有
  summary 更误导。

### Docs
- ARCHITECTURE.md 新增 Task Lifecycle 节（任务 born active、永不自动关闭、
  显式转换三件套）；API.md 补 setRollingSummary/setStatus 示例；USAGE.md
  task_append 参数补全。

## [0.3.3] - 2026-08-11

### Fixed
- **POST /v1/memories 静默忽略 body 顶层 scope（根因双修）**：①路由层只认 URL
  query 的 scope，body 顶层 `scope` 字段被丢弃；②`resolveContextScopes` 的
  anyScope 分支把 writeScope 硬编码为会话 projectId——显式 `scope=agent:workbuddy`
  的写入实际落进 `proj_local_*`，对 agent scope 召回不可见（08-11 实测 14 条蒸馏
  记录全写错 scope）。现显式 scope 选择同时定向读与写，5 条回归测试锁定。
- **allScopes（全部记忆）召回范围退化为 project scope**：`resolveContextScopes`
  无视 allScopes 标志，console「全部记忆」召回检查只在会话 proj_local_* 里搜，
  永远只命中错 scope 的新记录、旧记忆零命中。现 allScopes 返回空 recallScopes
  （=全库搜索）。
- **task_append 不写 rollingSummary**：纯 task_append 建的任务在 console 任务页
  「有 Transcript、无 Summary」。task_append 现接受可选 rollingSummary 并落
  task_context_state；Stop 驱动指令同步要求同传。

### Added
- **Stop hook 驱动 agent 主动写入**：Stop 的关键词启发式 capture 只认
  记住/偏好/决定/我是四类措辞，复杂工作会话全天零写入。现「实质工作（≥15字）
  且 stored=0」时 Stop hook 返回 `decision:"block"` 拉回 agent，指令其
  memory_write 写经验/决策/教训 + task_append 记进度。三重防循环：
  stop_hook_active 协议标志、capture-state.json 每会话至多一次、已捕获/短会话
  放行。`LEAFMEM_HOOK_STOP_DRIVE=0` 可关。

### Changed
- **六文件初始导入改为 LLM 中介蒸馏**：机械逐行导入曾产出 300+ 碎片（分隔符、
  孤立标题、拆半的列表项）。安装器现只登记 pending 状态，由宿主 LLM 按 INSTALL
  引导步骤 7.5 把每文件蒸馏成 1-4 条段落级记忆。parseMarkdownEntries 保留为
  legacy 安全网（分隔符/孤立标题不独立入库、嵌套子项并入父）。
- **取消导入掩码**：记忆库为单机专用（127.0.0.1 + API Key），用户自记凭证无需
  掩码，掩码反而损坏笔记可用性。

## [0.3.2] - 2026-08-11

### Fixed
- **shared 拓扑下第二宿主导入写错 scope（根因修复）**：install 流程里 MCP 配置走拓扑
  解析（shared → primary scope），但六文件初始导入硬编码宿主自身 scope——shared 的
  昆仑小智安装把 167 条重复导入记录写进 agent:kunlunxiaozhi（内容 100% 已存在于主
  scope 的纯重复死池）。提取共享的 `resolveEffectiveScopeId`，import 与 MCP 同用一
  个解析函数，永不分叉。新增回归测试（shared 第二宿主导入落主 scope、自身 scope 零
  记录）。
- **batch DELETE 对 agent scope 记录静默失效**：`/v1/memories/batch` 用裸 projectId
  上下文，agent scope 记录永远 `deleted: 0`（08-08 修单条 DELETE 时漏了 batch，同根
  因）。现镜像单条语义：显式 `scope=` 才能删 agent scope 记录。回归测试锁定。
  240/240。

## [0.3.1] - 2026-08-11

### Fixed
- **hook 自动 capture 注入垃圾入库（根因修复）**：宿主会话文件把
  `<system-reminder>`/身份文件等系统注入块原样嵌入 transcript，bridge 按原文
  capture 后被规则提取器当"用户偏好"入库（08-11 实测 2 条 turn_inference 垃圾，
  已删）。修复为双层净化：①服务端 `captureTurn` 入口统一
  `sanitizeCapturedText`（提取 `<user_query>` 正文、剥离注入块、纯注入则直接跳过）；
  ②bridge 脚本同逻辑客户端先行净化。新增 2 条回归测试（238/238）。

## [0.3.0] - 2026-08-11

### Added
- **Hook architecture（本版本核心）**：安装器自动把生命周期 hook 注册进宿主
  `settings.json`（UserPromptSubmit → 自动 recall 注入上下文；Stop → 自动
  capture/commit），记忆写入与召回从「模型自觉」升级为「机制保障」。桥脚本
  `ops/hooks/leafmem-hooks.mjs` 零依赖、失败静默、超时可调
  （`LEAFMEM_HOOK_RECALL_TIMEOUT_MS` 等），并写 `~/.leafmem/hooks.log` 心跳
  供自检。宿主不触发 hook 时自动回退 SOUL.md 纪律规则。
- **release 包直装**：`ops/build-release.sh` 产出「解压即用」zip（dist 零运行
  时依赖），GitHub Release 附件分发，绕开国内 npm 慢的问题。
- **初始导入扩展为六文件**：SOUL / USER / MEMORY / IDENTITY / AGENTS /
  SYSTEM.md + `memory/` 原生档案全部导入记忆库（此前只导前三个），
  为安装后生成初版用户画像提供原料。

### Changed
- **纪律块置顶写入 SOUL.md**：安装器把记忆工作流块钉在 SOUL.md 顶部（H1
  标题之后），优先级高于其他行为规则；MEMORY.md 回归纯记忆存储。
- **scope 教义落地到写入路径**：宿主驱动的 capture/commit 写入 scope 解析
  改为 repo > agent > project（此前 agent 上下文会落到 project scope，违反
  「日常只有 agent scope」教义）。
- `leafmem-agent update` 兼容 release 安装：无 git 仓库时跳过代码刷新，
  直接幂等重跑 install。
- 纪律块补全 `commit` 必需参数说明（agent/sessionId/rollingSummary）。

### Fixed
- 安装引导的 `LEAFMEM_EMBEDDINGS_BASE_URL` 多写了 `/v1`（代码会自动拼
  `/v1/embeddings`，旧写法导致 `/v1/v1/embeddings` 404）。
- 重装/升级时 `sharedMemory` 未指定会把已配置的共用 scope 重置为宿主自身
  scope（昆仑小智共用安装会被静默拆成两池）；现在保留已有 LEAFMEM_SCOPE_ID。

## [Unreleased-0.2.x]

### Added
- `ops/publish-audit.sh` — publish hygiene audit (blocks API keys, personal
  data, memory dumps, git symlinks, node_modules, marvmem residue). Wired
  into `prepublishOnly` so every `npm publish` is gated by it.
- `.github/workflows/ci.yml` — CI regression gate: type check + full test
  suite + publish hygiene audit on every push/PR to main.
- `CHANGELOG.md` — this file.
- `package.json` — `repository` / `homepage` / `bugs` metadata.

## [0.2.0] - 2026-08-09

### Changed (breaking)
- **MCP surface restructured from 6 tools to 4 closed-loop tools**:
  `memory_write` (remember/commit/task_append/active_distill),
  `memory_recall` (recall/search/get/list/task_window/active_get),
  `memory_organize` (prepare/apply/reflect/profile/decay/calibrate/rebuild),
  `memory_govern` (update/delete/attribute/pin).
- License reverted to proprietary (`UNLICENSED`); THIRD-PARTY-NOTICES.md removed.

### Added
- Console: help-docs page (zero-dep Markdown renderer + TOC + full-text
  search + mermaid rendering), tasks-context page (pagination + right
  drawer), dashboard click-through with preset filters, entity graph
  polish (pre-simulation, inner/outer rings, adjacency highlight).
- README rewritten: system-intro / install-upgrade / usage chapters with
  mermaid architecture diagram and sub-component table.
- `forget()` now prunes dangling `principle.supports` references (every
  deletion path covered at the core).

### Fixed
- User profile was distilled but never injected into recall (dead link).
- `compactToolResult` strips `record.content` only for the `recall` action;
  `search`/`get`/`list`/`task_window`/`active_get` return full records.
- Console html/js/css served with `Cache-Control: no-store`.

## 0.1.x - 2026-08-08

Initial LeafMem releases (brand replacement from upstream fork, dual-host
installer, API-key guided setup, npm distribution). **All 0.1.x versions
were unpublished from npm on 2026-08-09 and superseded by 0.2.0.**

[Unreleased]: https://github.com/xdragonjia/leafmem/compare/v0.3.25...HEAD
[0.3.25]: https://github.com/xdragonjia/leafmem/releases/tag/v0.3.25
[0.3.24]: https://github.com/xdragonjia/leafmem/releases/tag/v0.3.24
[0.2.0]: https://github.com/xdragonjia/leafmem/releases/tag/v0.2.0

