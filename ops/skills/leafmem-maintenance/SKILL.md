---
name: leafmem-maintenance
version: "1.11.0"
agent_created: true
author: xiaoxia
description: >
  LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。
  覆盖健康检查、强制存档、真重复合并、碎片整合、长谱系条目拆分（content 近 6,000 上限）、原则蒸馏、画像刷新、衰减降权、镜像同步、周度观察与趋势判断、实体词表巡检。
  触发词：leafmem 维护、记忆整理、每周健康检查、深度整理、记忆治理、周度观察、长条目拆分。
  排除场景：不做 WeKnora 知识库维护、不替代每日只读观测告警任务、不处理宿主安装配置。
---

> 📜 **变更历史**：见 `CHANGELOG.md`（本技能全部版本的变更叙事与教训溯源；正文只写当前有效的规范）

## 身份（identity）

- **角色**：LeafMem 记忆治理工程师
- **目标**：让记忆库保持高信噪比：重复的合并、碎片的整合、过时的降权、画像与原则常新，且全程不丢数据、不误删
- **风格**：保守删除、忠实转录、先存档后动手

## 触发（triggers）

**关键词**：leafmem 维护 ｜ 记忆整理 ｜ 每周健康检查 ｜ 深度整理 ｜ 记忆治理 ｜ 周度观察 ｜ consolidation

**意图**：LeafMem 记忆库周期性质量维护与周度趋势观察（每周自动化调用或手动触发）

**排除**：见 frontmatter `description` 末行（WeKnora 维护 / 每日只读巡检 / 宿主安装配置），三者均不在本技能范围。

## `<identity_note>` 身份备注

`ops/consolidation.js` 已退役（判据见表末「历史脚本」行）。本技能是现行替代：语义精修由宿主模型经 MCP 完成（免费）；supports 断链清理已由 memory.forget() 级联覆盖。

## 工作流（workflow）

### 步骤 1：召回历史教训

执行任何维护动作前，先召回历史维护教训，避免重蹈覆辙

- **动作**：mcp__leafmem__memory_recall(action="recall", message="leafmem 维护 整理 误删 教训")
- **分支**：MCP 不可用 → CLI-first：`bash ~/.leafmem/leafmem-cli.sh recall "..."`（HTTP，launchd 守护）→ 不可达查 `launchctl list | grep leafmem` → 最后 conversation_search；召回失败不阻塞，但删除动作更保守

**📖 按需读** `references/cli-write-channel.md`（task-append / CLI-first 降级链＋**§4b 不可用判定三类分流**＋§4c 节奏 / recall 契约 / remember 覆盖事故 / §7 引号陷阱）——**写记忆或 recall 异常时必读**，只读观测不必读。

🔴 **报错先分类再处置**（三类分流表＋阈值＋恢复补写要求全文见 §4b，禁跳步）：网络类＝真不可用（重试后降级）／参数类＝**不是服务故障**（自查类型禁重试）／ToolSearch absent＝**正常现象**（走 CLI，严禁判不可用）。

**🔴 五条写入硬纪律（name=remember_overwrite_hazard，severity=P0；纪律本体在此，事故记录见上方指针）**：
(a) **追加型教训一律用 `update --content <old + 新增>`**（先 `get` 取原文，拼接后整段回写），**不要**用 `remember` 期望它「新建一条相近记录」；
(b) **`remember` 后必须立刻 `get` 该 id 核对 `createdAt`** —— 早于今天＝命中并覆盖了既有条目（非幂等：**同 kind+同 tags+同模板**即触发，与「我认为主题不同」无关；`summary`/`tags`/`kind`/`importance`/`confidence` **一并被覆盖**），须立即恢复原文再决定拆分另建（core 自动打 `mergedOver` 告警，见 §6）；
(c) `remember` 仅在**已用正确口径 recall 确认无同主题条目**时使用；
(d) 恢复原文的前提是**手上有原文**：写记忆前先 `get` 留存，或确认该条目内容已在当前上下文中。
(e) 🔴 **「必须新建」场景一律带 `--no-dedupe`**（2026-11-25 第4例后立）：跨日跑次记录／覆盖事故恢复后另立／同主题不同日期的经验条——CLI `remember … --no-dedupe` 透传 `dedupe:false`，core 跳过模糊合并必新建。**日期锚+tags+措辞差异化是预防辅助不是保证**（相似度只比 content embedding，11-25 实证三防线全在位仍二次命中同条）；(b) 写后核仍必做，二者不可互替。

**🔴 读通道口径（name=recall_return_contract，severity=P0）**：条目在 **`hits[].record`**；❌ 禁用 `d.get('memories')/d.get('results')/d.get('items')`（三键都不存在，静默落空打印「命中 0」**进而驱动破坏性 `remember` 覆盖**，事故全记录见 §6）。**自检：先 `list(d.keys())` 断言含 `hits`；命中 0 走「空结果三查」，未过不得判「无相关记忆」。**

**🔴 单条 content 硬上限 6,000 字符**，超限报 `memory content too long`；接近上限走**步骤 5b 拆分**，不要继续追加。

### 步骤 2：健康检查（只读）

确认服务与数据完好，收集规模基线

**检查项**：

- pgrep -f leafmem-mcp 确认 MCP 在线
- ls -lh ~/.leafmem/memory.sqlite 记录容量
- sqlite3 统计 scope=agent:workbuddy 的 memory_items 总数与 FTS 行数，二者应一致
- memory_recall(action="recall", message="leafmem scope 纪律") canary 验证应命中已知条目

### 步骤 2b：残留任务闭环清扫
判定与动作全文→`references/step2b-residual-tasks.md`。🔴 判据：`task_window` 里 `status=active` 且 ≥7 天未动的任务＝残留，逐条裁定（完成/转 BACKLOG/显式放弃）；禁让 active 任务无限挂账。

### 步骤 3：全量存档（强制，不可跳过）

删除任何记忆前必须先导出全量 JSON 存档，作为误删回滚锚点

- **动作**：`python3 scripts/archive_dump.py [输出路径]`（默认写 `~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-YYYYMMDD.json`，内置回读校验，输出 `ITEMS/ALL/FTS/SIZE/VERIFY` 五项）。参数细节见 `references/scripts-usage.md`。
- **检查点**：🔴 STOP：`VERIFY=OK`（条数与库内一致）后才允许进入删除类步骤；`ITEMS != ALL` 或 `VERIFY=FAIL` → 中止全部删除类步骤，只留健康检查报告。

### 步骤 4：真重复检测与删除（含 4b 双执行器同文、4c kind 门禁）

- **动作**：🔴 先跑 `python3 scripts/weekly_scan.py`，取「1. 真重复」「1b. 双执行器同文」「3. 跨日近重复」三段——量化可复核、秒级，替代人工通读；脚本只读，删除仍在本步骤经 MCP 执行。
- **规则**：真重复＝全文规范化 SHA256 相同（re.sub 空白后取 16 位）。🔴 **NEVER 用前缀聚类判重**——同 YAML 头的不同内容会被误判误删。
- **动作**：每组保留 importance 最高 + updated_at 最新一条；其余 `memory_govern(action=delete)`。
- 🔴 **真重复与 4b 必须同轮处置**：只跑「真重复」段是本步的历史缺陷（见 4b）。

#### 4b. 双执行器同文重复（🔴 2026-11-03 立）

- **判据**：`executor_dups`（1b 段）＝ **0**；＝同 `source_file`+同 section 主标题+剥壳 md5。🔴 11-09 加固（主标题归一/尾部 `---`/跨节同文不删）→`references/step4bc-dedup-and-kind-gates.md`。
- **处置**：保留带 `chunk.span` 的 v3 版、删 legacy 版（`keep_id`/`drop_ids` 已算好）；删前走步骤 2.0 存档。**只管 0，下降不算修好**。
- 🔴 **本步历史缺陷**：只消费「真重复」段 ⇒ 这类（面包屑格式不同、全文未判同）**报而不管**。**架构已修**：统一写入口共用 state——**兜底去重先到先得，会保住劣质版挡住优质版（质量倒挂）**。

#### 4c. 非标准 kind 门禁（🔴 2026-11-03 立）

- **判据**：`kind NOT IN (六种)` 计数 ＝ **0**。🔴 **是通路问题不是整洁问题**——`kind` 决定 `reflect`（只看 lesson/decision/note）/`profile`（只看 preference/identity）/principle 加权，写错＝**内容静默失效**。
- **归并**：实证裁定→`decision`、规则→`lesson`、事实→`note`。SQL、映射表、负例与回归清单见 `references/step4bc-dedup-and-kind-gates.md`。

#### 4d. 覆盖走样残留门禁（🔴 2026-11-16 立）

- **判据**：`weekly_scan.py`「1c」段 ＝ **0**（记录带 `source_file`+`section` 溯源，且正文 `[YYYY-MM-DD·` ≠ `doc_date`／文件名日期）。
- **性质**：`remember()` 0.85 模糊合并吞同模板日志节的痕迹，无报错/告警且 `exact_dups`/`near_dups` 均抓不到。处置＝正文权威只修 metadata、无孪生禁删；增量已由 `looksStructuralChunk()` 汇聚点拦截。根因链/SQL/PATCH 必带 `?scope=` → `references/step4bc-dedup-and-kind-gates.md` §4d。

### 步骤 4d：🔴 模式三件套巡检
`python3 scripts/pattern_compliance.py --out runs/pattern_compliance_<date>.json`（自检 5/5）。补 metadata 直接 govern(update) 即可——**引擎 ≥0.3.27 默认浅合并**（键值 null=删键；整包替换须显式 `metadataMode:"replace"`，维护场景禁用），11-19 裸写覆盖事故已在引擎层根治，不再依赖「先 get 合并」自觉。判据展开/三件套定义/存量处置→`references/pattern-triad.md`。

### 步骤 5：碎片簇整合

把同日期+同 context 的 ≥3 条碎片整合为 1-2 条高质量记忆

- **检测**：用 `python3 scripts/weekly_scan.py` 的「2. 碎片簇」段：按 (日期, 主tag) 聚类 ≥3 条成候选簇，并同时给出**簇内 3-gram 凝聚度 `max_jac`**
- **规则**：🔴 只有 **`is_fragment=True`**（`max_jac ≥ 0.55`）的簇才值得核验，禁凭「同日期同 tag」整合（→ `references/fragment-cluster-evidence.md`）。🔴 读 JSON 必用 `max_jac`／`is_fragment`：写 `maxJac` 会静默取 0，产出权威假阴性（11-16 实证）。
- **规则**：版本演进链（同一决策的旧版与纠正版、同一会话的多次 commit 且 taskId 不同）不属碎片：按 PRESERVE HISTORY 保留全部，仅确认旧条已自带「已被替代 / 已纠正」标记
- **合并**：宿主模型按「整合九规则」整合（见 constraints）
- **写入**：memory_write(action="remember", kind="lesson", importance=0.7, tags=[主题], content=模板文本)
- **删除**：写入成功后才逐条删除原碎片
- **验证**：2-3 个主题查 recall，新记忆 score ≥ 0.6；抽查无 LLM 自造数字/近重复/悬空代词，不达标该簇重做

### 步骤 5b：长谱系条目拆分（content 逼近单条 6,000 上限）

把 content 逼近单条 6,000 上限的「合并磁石」条目做**无损拆分**：核心留在本条，谱系/案例外置为 kind=lesson 原子条目，两向互引 id。

- **触发**：`scripts/weekly_scan.py` 报 content>4000；**≥5,500 为高危**（余量 <10%，一次追加即可能撞上限）。
- **🔴 先判「该不该拆」**：`合法长文` 只是长度事实；仅 ≥5,500 或一题多族磁石才拆，单主题与过时 runbook（加 `已被替代` 降权）不拆；基线 7 条与全表见 reference。
- **📖 触发即必读** `references/step5b-long-entry-split.md`（完整执行序列：覆盖度扫描判定表 → 外置 metadata 字段 → 父条目回写参数 → 验证收尾）。**不执行覆盖度扫描就外置＝制造重复；不回写父条目＝谱系断链。**

**🔴 四条硬门禁（纪律本体在此，执行细节在 reference）**：
1. **覆盖度扫描前置**：原文每个语义段取 1–2 个特征串跑全库 `SELECT id ... WHERE content LIKE '%串%'`；命中**只含本条** ⇒ 必须外置，命中**含他人** ⇒ 索引指向既有 id **不复制**（复制＝制造重复）。
2. **`parentId` 必须取完整 36 位 UUID**，🔴 禁用 8 位短前缀（10-11 首跑写错一组，与步骤 6 supports 短 id 事故同源）。
3. **写后必核 `createdAt` 为当日**：早于今日 ⇒ 覆盖了既有条目，立即按步骤 3 存档恢复原文。父条目回写 `--metadata` 自 0.3.27 起浅合并（`recallCount`/`lastRecalledAt` 不再被冲掉），但**只传要改的键**最稳；`--tags` 传原 tags 并集（tags 仍整体替换）。
4. **零丢失硬门禁**：回写后对原文每个语义段做**全库** `LIKE` 复扫，`ORPHANS` 必须 = 0；出现孤儿 ⇒ 回补进对应子条目再复验，**不得只改父条目**。🔴 **只查索引池不算取证，必须全库扫描**（10-11 实证：索引池判 4 孤儿，全库确认真丢失，明细见 reference）。

- **收尾**：拆分属写入动作 ⇒ 完成后必须重跑步骤 9 镜像同步，并核三源一致（DB = FTS = Mirror）。

### 步骤 6：宿主模型蒸馏（reflect 宿主版）

把同主题 lesson 聚类蒸馏为 principle，替代付费 inferencer 的 reflect

- **动作**：memory_recall(action="search", kind="lesson") 拉近 30 天 lesson；按 tags 聚类 ≥3 条同主题
- **动作**：宿主模型归纳共性规律为 1 条 principle，证据 id 存入 metadata.supports
- 🔴 **产出形态＝模式三件套（2026-11-19，防「蒸馏出大号流水账」）**：必带 `metadata.pattern`（可迁移短语非实例名）＋ `trigger_context`（功能结构关键词）＋ `applicability`（边界），summary 首句「<模式名>：<规律>」格式，缺任一项＝未完成蒸馏（判据展开→`references/pattern-triad.md`）。
- **动作**：memory_write(remember, kind=principle, importance=0.85, tags=[主题,principle,reflected], metadata={supports, pattern, trigger_context, applicability, reflectedAt:当前ISO, reflectTag:主题, lastRefreshedAt:当前ISO})——🔴 reflectedAt 必传（引擎据此刷 lastReflectAt，周度观察方可见本通道刷新）
- **MUST**：🔴 supports 存证据 lesson 的**完整 36 位 UUID**（8 位短 id 全失配→`principle_supports_missing` ALERT）；PATCH 只传需更新的键（引擎 ≥0.3.27 默认合并，无需回填全量）。反查法→`references/scripts-usage.md`。
- **节流**：同主题 6 天内已蒸馏（查已有 principle 的 reflectedAt）则跳过

### 步骤 7：画像刷新（profile 宿主版）

基于 preference delta 更新用户画像，替代付费 inferencer 的 profile

- **动作**：memory_recall(action="search", kind="preference") 拉全部 preference；memory_recall(action="active_get", kind="profile") 读当前画像
- **动作**：宿主模型比对差异，**只输出需要更新的分节**（"## 分节标题\n新内容" markdown）；memory_write(action="active_distill", kind="profile", content=更新分节)
- **动作**：🔴 通道：自动化会话用 `scripts/leafmem_mcp_call.py memory_write '{"action":"active_distill","kind":"profile","content":"..."}'`（`active_distill` 仅 `src/mcp/handler.ts` 实现，HTTP 不暴露；该脚本拉临时 stdio 与常驻服务共享 sqlite）。
- **动作**：🔴 **scope 必须走查询串 `?scope=agent:workbuddy`**：传 `?scopeType=agent&scopeId=workbuddy` 或省略会返回**空快照**（`profile.present=false`/`principles=0`，酷似数据丢失实为口径错）。判据：`stats.principleCount` 与步骤 2 计数不一致即先怀疑 scope 形态。
- **动作**：🔴 节奏：周度观察的 [WARN]「画像超过 14 天未刷新」即本步骤的触发信号（2026-09-14 实测命中）。周维护时先跑 observation（步骤 10），再据此决定是否刷新画像。

**🔴 分节合并语义**：引擎按分节标题合并——同名分节被替换、新分节追加、**未提到的分节原样保留**。宿主永远不要输出全文覆写，避免误删其他分节。

**备注**：console「用户画像」卡片=profile 快照，govern(update) 改 preference **不自动反映**；`memory_organize(action=profile)` 需付费 inferencer（本机 no_inferencer）⇒「画像没更新」走本步骤宿主版 active_distill。

**📖 按需读** `references/mcp-channels.md`（通道调用器用法 / HTTP `Bearer` 鉴权与 `X-API-Key` 失效 / governance 返回结构 / scope 静默空快照全症状表 / console 卡片刷新路径）——**在自动化会话执行本步骤或步骤 8 时必读**。

### 步骤 8：衰减降权

陈旧且未被召回的低重要性记忆降权（不删除，pinned 豁免）

- **动作**：mcp__leafmem__memory_organize(action="decay", scopeType="agent", scopeId="workbuddy", dryRun=false) —— 纯规则，不需要 LLM
- **动作**：🔴 通道：decay 不在 HTTP 暴露面 → 自动化会话用 `scripts/leafmem_mcp_call.py memory_organize '{"action":"decay","dryRun":false}'`；返回 {scanned, decayed[]}，scanned 应等于库内总条数；可先 --dryRun:true 预演。

### 步骤 9：镜像同步

导出全量记忆到本地镜像，供 MCP 降级兜底

- **动作**：node `~/projects/leafmem/ops/mirror-sync.js`（默认写 ~/.leafmem/mirror，可 --mirror-dir 覆盖）。🔴 **安装目录口径＝`~/projects/leafmem`**；`npm root -g`/@xdragonjia/leafmem 下**无 ops/ 与脚本**（2026-10-11 实测，按旧路径必报「脚本缺失」）。
- **规则**：🔴 镜像必须是**全部写入动作完成之后**的收尾步骤——commit 本身写 1 条 session 记录，先跑镜像会差 1 条（2026-09-21 实测 1832→1833）。镜像后再有任何写入（commit / task_append / remember）必须重跑本步骤
- **检查**：三源同数 `DB = FTS = Mirror 记录数`，并由 `memory_items_fts - memory_items = 0` 佐证 FTS 无滞

### 步骤 10：周度观察（只读，2026-09-03 并入）

确定性采集治理指标 + 周环比趋势判断，本步骤不修改任何记忆

- **动作**：python3 ~/projects/leafmem/ops/observation.py --mode weekly（零 LLM 依赖；自动追加到 ~/.leafmem/observation/leafmem-observation-log.jsonl；scope 自动探测主 scope，可环境变量 LEAFMEM_SCOPE 覆盖）
- **判断**：取最近 2 条 weekly 记录做周环比五项判断（引用脚本输出数字，不心算——NO COMPUTATION）：
  - a. 反馈回路：recall_total 周环比上升（用进废退生效）
  - b. 反思蒸馏：principle_count 增长；last_reflect_at 每周刷新（超 10 天未刷新 → 检查步骤 6 蒸馏是否执行）
  - c. 画像：profile_present 且 profile_updated_at 在近 14 天内
  - d. 数据一致性：fts_stale==0 且 fts_rows==memory_rows；principle_supports_missing==0
  - e. 治理时机：decay_candidates>0 → 建议执行/确认步骤 8 已覆盖
  - f. 实体词表活性：entity_count 周环比——记忆在增长但实体连续 2 周零增长 → 词表陈旧信号，转步骤 11 巡检
- **分支**：若脚本输出 ALERT（FTS 回归/行数不一致/证据链断裂）→ 标记为需行动，在报告中最优先呈现，必要时提前单独告警
- **规则**：🔴 **`profile_sections` 是子串计数口径，比真值多算**——分节数须以治理接口 `/v1/governance?scope=agent:workbuddy` 的 sections 长度为准；差 1–2 属正常，突增才查正文是否插了标题字面量（详见 `references/scripts-usage.md`）

**备注**：结论格式：正常 / 需关注 / 需行动 + 一句话依据；追加记录到宿主当日记忆日志（含日期，追加不覆盖）

### 步骤 11：实体词表巡检（2026-09-03 新增）

防止实体词表陈旧导致新领域无法实体化（strict 抽取器只认控制词表+内置词典+@提及）

- **触发**：步骤 10.f 发现 entity_count 连续 2 周零增长而记忆在增长；或每月例行一次
- **动作**：扫描近 30 天记忆中高频出现的专名（新项目/新工具/新产品名），与 ~/.leafmem/entity-vocab.json 比对
- **动作**：把确有所指的新词追加进词表（kind: project/tool/person/org），备份原文件后再写；词表对新写入即时生效
- **动作**：存量记忆补链：node ~/projects/leafmem/ops/entity-relink.mjs --dry 预估后再正式跑（纯增量幂等三接口，只加不删；跑前备份 memory.sqlite）

**备注**：🔴 只加确有所指的专名，不加通用词； MCP stdio 进程的词表在进程启动时加载，宿主重启后生效，launchd 后台服务可 launchctl kickstart -k 即时生效

### 步骤 11b：🔴 模式复用观察（2026-11-19 新增，周度「提炼有效性」最终证据）

- **动作**：grep 当周对话日志与任务 memory.md 中模式短语出现次数，得 **pattern_reuse_count**（新任务显式引用既往命名模式次数）。
- **判据**：连续两周为 0 ⇒ 提炼空转，改提炼方式（命名过抽象/情境词漂移）**禁加复盘时长**；报告写「本周模式复用 N 次」，当周无新任务标 N/A。与日终复盘「模式提炼率」对账：那边管过程（命名率/归族率），这边管结果（复用），过程高而结果 0 ⇒ 命名不可检索。

### 步骤 12：报告与留痕

每周固定推送周报（含观察结论）；无整理动作且观察全绿时可简化为仅日志

- **分支**：
  - 若有删除/整合/蒸馏动作，或周度观察出现需关注/需行动项 → 通过宿主可用的消息渠道发送周报：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数 + 本周观察结论与关键环比（memories/principle/recall/profile/一致性）
  - 否则 → 仅写宿主当日记忆日志，不推送

- **产物落点**：🔴 写 `outputs/` 前必读 `~/WorkBuddy/outputs/CLASSIFICATION_RULES.md`；周报落 `outputs/报告/leafmem-weekly-report-{YYYYMMDD}.md`（禁 outputs 根目录与 leafmem-productization/runs/observation/）。全绿且无动作→不落盘。

**备注**：推送渠道由宿主环境决定；无配置渠道时退化为仅日志，不报错

## `<constraints>` 纪律

**NEVER**：

- NEVER 直写 ~/.leafmem/memory.sqlite — 因为 sqlite 直写会写坏 id/created_at 导致前端不可见；替代做法是全部走 MCP memory_write/memory_govern
- NEVER 删除前不存档 — 因为误删无回滚锚点；替代做法是步骤 3 强制全量导出
- NEVER 用前缀聚类判重复 — 因为同头部不同内容会误删；替代做法是全文规范化 SHA256
- NEVER 删 preference/含路径/触发词类记忆的核心内容 — 因为这三类是用户画像与检索入口的基石（三不碰）
- NEVER 让 LLM 做算术或推导 — 因为蒸馏只忠实转录，数字合并会产生幻觉（NO COMPUTATION 铁律）
- NEVER 在有疑虑时删除 — 因为宁可保守不可误删；替代做法是保留并在报告中标注待人工复核

**MUST**：

- MUST 先 recall 历史维护教训再动手
- MUST 删除走 MCP 且写入成功后才删原条
- MUST 整合产物用标准模板：# 一句话结论 + 场景/内容/动作/来源
- MUST scope 铁律：默认 agent:workbuddy，write 不传 scopeType/scopeId
- MUST 🔴 **维护动作四阈值**：recall 降噪（同主题先 update）／**同一坑 ≥2 次即升 importance**／`commit` 返 `maintenanceRequest` **立即** apply／**单回合 tool calls ≥8 写当日日志**。节奏与降级（周一 04:00 整理／MCP 超时 5s／BGE-M3→hash／console Sync 不覆盖身份文件／写记忆模板）→ `references/cli-write-channel.md` §4c

**SHOULD**：

- SHOULD 整合遵守九规则：UPDATE 优先于 CREATE、一条一侧面、按实体匹配、状态变更带日期、CASCADE 级联、解析模糊指代、PRESERVE HISTORY、NO COMPUTATION、异题分离

## 示例（examples）

**📖 按需读** `references/examples.md` —— 碎片整合正例、前缀聚类误删反例。执行只需记一句：**先存档 → 写入成功 → 再删原条**。

## `<error_handling>` 异常处理

**failure_criteria 失败判据**：

- MCP 连续不可用（recall/write 均失败）
- 存档文件行数与库内条数不一致
- 整合验证 recall score < 0.6

**fallback_strategy 降级策略**：

- **MCP 不可用**（🔴 先按 `references/cli-write-channel.md` §4b 分类错误，`must be array`/ToolSearch 查不到**不算不可用**）：① **等 60s 重试，共 3 次**；② 仍失败先走 CLI-first 降级链（CLI → `launchctl list` → `conversation_search`／`~/.leafmem/mirror/`），只执行只读步骤（健康检查/检测报告），删除/整合全部跳过并在报告标注；③ 记当日日志，🔴 **服务恢复后必须补写降级期间产生的 durable**（不补写＝永久丢失）
- **存档不一致**：① 重新导出一次；② 仍不一致则中止全部删除类步骤，只留健康检查报告
- **超时（>10 分钟）**：① 把剩余碎片簇截断到前 10 簇，其余留到下周

## `<output_format>` 输出格式

- **类型**：message
- **路径**：飞书小虾群（有动作时）+ ~/.workbuddy/memory/ 当日日志（总是）
- **格式**：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数

## 检查点（checkpoints）

- **启用**：true
- **备注**：步骤 3 存档为强制检查点（🔴 STOP）；中断恢复时从最近完成的步骤续跑，删除类步骤前重新确认存档新鲜

## console 设计（2026-11-15）

改 console 界面前必读 `references/console-design-notes.md`。

## 参考文件（references）

**📖 按需读** `references/scripts-usage.md` —— 各脚本的**完整参数、输出字段、退出码、判读陷阱**（正文只留「何时用」）：

| 文件 | 职责（细节读文件） | 步骤 |
|---|---|---|
| `references/cli-write-channel.md` | 写入通道／CLI 降级链／recall 契约／remember 覆盖事故 | 1 |
| `references/step5b-long-entry-split.md` | 长条目拆分执行序列＋判定表＋基线 | 5b |
| `references/mcp-channels.md` | 自动化 MCP 通道／鉴权／scope 空快照 | 7、8 |
| `references/examples.md` | 整合正例／前缀聚类反例 | 5 |
| `references/step4bc-dedup-and-kind-gates.md` | 4b/4c 根因链＋执行器对照＋门禁命令＋负例 5 例 | 4b、4c |
| `references/scripts-usage.md` | 脚本参数、输出字段、退出码、判读陷阱 | 2b、3、4、5、9、10、11 |
| `scripts/stale_task_sweep.py` | 残留任务扫描（只读；exit 2＝有超龄/非法状态） | 2b |
| `scripts/archive_dump.py` | 全量存档导出（步骤 3 检查点实现） | 3 |
| `scripts/weekly_scan.py` | 周维护量化扫描（六类信号，含 1b 双执行器同文，只读） | 4、5、5b |
| `scripts/leafmem_mcp_call.py` | MCP stdio 调用（HTTP 面未暴露的动作） | 7、8 |
| `ops/mirror-sync.js` | 镜像同步（🔴 安装目录 `~/projects/leafmem`） | 9 |
| `ops/observation.py` | 周度观察采集（约 20 指标，零 LLM） | 10 |
| `ops/entity-relink.mjs` | 实体补链（只加不删，跑前备份） | 11 |
| `ops/consolidation.js` | ⚠️ 历史脚本（缺 DEEPSEEK_API_KEY 不可运行；去重已归步骤 4） | — |

> 📜 版本演进记录已外置 → **CHANGELOG.md 末尾**。
