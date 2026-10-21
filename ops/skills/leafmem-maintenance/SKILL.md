---
name: leafmem-maintenance
version: "1.8.3"
agent_created: true
author: xiaoxia
description: >
  LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。
  覆盖健康检查、强制存档、真重复合并、碎片整合、长谱系条目拆分（content 近 6,000 上限）、原则蒸馏、画像刷新、衰减降权、镜像同步、周度观察与趋势判断、实体词表巡检。
  触发词：leafmem 维护、记忆整理、每周健康检查、深度整理、记忆治理、周度观察、长条目拆分。
  排除场景：不做 WeKnora 知识库维护、不替代每日只读观测告警任务、不处理宿主安装配置。
---

> 📜 **变更历史**：见 `CHANGELOG.md`（本技能全部版本的变更叙事与教训溯源；正文只写当前有效的规范）

> **元信息**：date = 2026-09-03 ｜ type = operations ｜ agent_created = true ｜ author = xiaoxia

## 身份（identity）

- **角色**：LeafMem 记忆治理工程师
- **目标**：让记忆库保持高信噪比：重复的合并、碎片的整合、过时的降权、画像与原则常新，且全程不丢数据、不误删
- **风格**：保守删除、忠实转录、先存档后动手

## 触发（triggers）

**关键词**：leafmem 维护 ｜ 记忆整理 ｜ 每周健康检查 ｜ 深度整理 ｜ 记忆治理 ｜ 周度观察 ｜ consolidation

**意图**：对 LeafMem 记忆库执行周期性质量维护与周度趋势观察（由每周自动化任务调用，或手动触发）

**排除**：

- WeKnora 知识库的维护（用 weknora-rag）
- 每日只读健康巡检（由「每日健康哨兵」自动化负责，模板 ops/automations/daily-sentinel.md）
- 宿主安装/配置（用安装器或 INSTALL-KUNLUNXIAOZHI.md）

## `<identity_note>` 身份备注

与 ops/consolidation.js 的关系：consolidation.js 是旧版 LLM 去重脚本（硬依赖 DEEPSEEK_API_KEY，2026-08-10 key 移除后已不可运行，仅存档于仓库作参考）。本技能是它的现行替代——语义级精修（整合/蒸馏/画像）由宿主模型通过 MCP 完成，免费；supports 断链清理已由 memory.forget() 内置级联覆盖。

## 工作流（workflow）

### 步骤 1：召回历史教训

执行任何维护动作前，先召回历史维护教训，避免重蹈覆辙

- **动作**：mcp__leafmem__memory_recall(action="recall", message="leafmem 维护 整理 误删 教训")
- **分支**：若 MCP 不可用 → 按 CLI-first（2026-09-04 v0.3.21）：首选 `bash ~/.leafmem/leafmem-cli.sh recall "..."`（HTTP 通道，launchd 守护，自动化会话 mcp__leafmem__* 恒 absent 属预期）→ CLI 也不可达先查 `launchctl list | grep leafmem` → 最后 conversation_search；召回失败仍不阻塞，但删除动作必须更保守

**📖 按需读** `references/cli-write-channel.md`（写入通道 task-append 子命令 / CLI-first 降级链 / recall 返回契约与 remember 覆盖事故全记录）——**要写记忆或 recall 结果异常时必读**，只做只读观测不必读。

**🔴 四条写入硬纪律（name=remember_overwrite_hazard，severity=P0；完整事故记录见 `references/cli-write-channel.md`，纪律本体在此）**：
(a) **追加型教训一律用 `update --content <old + 新增>`**（先 `get` 取原文，拼接后整段回写），**不要**用 `remember` 期望它「新建一条相近记录」；
(b) **`remember` 之后必须立刻 `get` 返回的 id 并核对 `createdAt`** —— 若早于今天即说明命中并覆盖了既有条目（`remember` 是「写入即可能覆盖」的非幂等操作，**同 kind+同 tags+同模板**即触发，与「我认为主题不同」的主观判断无关；且 `summary`/`tags`/`kind`/`importance`/`confidence` **一并被覆盖**），须立即恢复原文再决定是否拆分另建；
(c) `remember` 仅在**已用正确口径 recall 确认无同主题条目**时使用；
(d) 恢复原文的前提是**手上有原文**：写记忆前先 `get` 留存，或确认该条目内容已在当前上下文中。

**🔴 读通道口径（name=recall_return_contract，severity=P0，两次踩坑）**：recall 结果的记忆条目在 **`hits[].record`**；❌ 禁用 `d.get('memories')/d.get('results')/d.get('items')` —— 这三个键都不存在，会静默落空打印「命中 0」，**进而驱动一次破坏性 `remember` 覆盖**（09-24 实证：覆盖了 principle `9c2cd747` 的 4,499 字符六代谱系）。**自检：先 `list(d.keys())` 断言含 `hits`；命中 0 走「空结果三查」，三查未过不得判为「无相关记忆」。**

**🔴 单条 content 硬上限 6,000 字符**，超限报 `memory content too long`；接近上限走**步骤 5b 拆分**，不要继续追加。

### 步骤 2：健康检查（只读）

确认服务与数据完好，收集规模基线

**检查项**：

- pgrep -f leafmem-mcp 确认 MCP 在线
- ls -lh ~/.leafmem/memory.sqlite 记录容量
- sqlite3 统计 scope=agent:workbuddy 的 memory_items 总数与 FTS 行数，二者应一致
- memory_recall(action="recall", message="leafmem scope 纪律") canary 验证应命中已知条目

### 步骤 2b：残留任务闭环清扫（2026-10-02 新增）

检出并闭环滞留在非 completed 状态的任务上下文——闭环依赖会话收尾显式 task_append(status=completed)，会话中断/超时/收尾被跳过会让任务永久滞留 active

- **检测**：python3 scripts/stale_task_sweep.py（只读；exit 2 = 有超龄未闭环或非法状态值；默认阈值 24h，--hours 可调）
- **规则**：🔴 闭环判据（逐条人工/宿主判定，禁止无脑批量关）：末条 entry 表明主流程已完成 且 超阈值无更新 → 用 `leafmem-cli task-append <taskId> <闭环说明> <闭环版 rollingSummary> completed` 补标；rollingSummary 必须写成闭环版表述（清除「待办/待回写」类措辞，尾项未回写的如实标注「按主流程完成闭环归档」）
- **规则**：🔴 主流程证据不足的任务不得强关——列入报告标注待复核，宁可滞留不可误判完成
- **规则**：🔴 状态合法枚举仅 active/paused/completed/archived（0.3.22+ handler 已运行时校验，非法值直接报错 -32602）；脚本检出非法值（如历史遗留 "done"）→ 按闭环判据修正为 completed 或归档

**备注**：根因修复（2026-10-02，leafmem commit aba363b）：handler.ts 的 status 原为裸类型断言无运行时校验，"done" 被原样写库；已加枚举校验 + 回归测试（8/8）。残留 active 属流程性问题（收尾步骤被跳过），本步骤是其常态化兜底

### 步骤 3：全量存档（强制，不可跳过）

删除任何记忆前必须先导出全量 JSON 存档，作为误删回滚锚点

- **动作**：`python3 scripts/archive_dump.py [输出路径]`（只读 `~/.leafmem/memory.sqlite`，默认写 `~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-YYYYMMDD.json`；脚本内置**回读校验**，输出 `ITEMS / ALL / FTS / SIZE / VERIFY` 五项，VERIFY=OK 即存档可用）。等价的最小实现＝Python 读全量 `memory_items`（scope=agent:workbuddy）导出 JSON。
- **检查点**：🔴 STOP：存档文件写入且 `VERIFY=OK`（条数与库内一致）后，才允许进入删除类步骤。🔴 若 `ITEMS != ALL` 或 `VERIFY=FAIL` → 中止全部删除类步骤，只留健康检查报告（见 fallback_strategy）。

### 步骤 4：真重复检测与删除

合并完全重复的记忆

- **动作**：🔴 先跑 `python3 scripts/weekly_scan.py` 取「1. 真重复」段与「3. 跨日近重复」段清单——量化、可复核、秒级，替代人工通读全库；脚本只读，删除动作仍在本步骤经 MCP 执行
- **规则**：用全文规范化后的 SHA256 哈希判定重复（re.sub 空白后取 16 位）
- **规则**：🔴 NEVER 用前缀聚类判定重复 — 因为同一 YAML 头部的不同内容会被误判为重复导致误删；替代做法是全文规范化哈希
- **动作**：每组保留 importance 最高 + updated_at 最新一条；其余 memory_govern(action=delete, scopeType=agent, scopeId=workbuddy)

### 步骤 5：碎片簇整合

把同日期+同 context 的 ≥3 条碎片整合为 1-2 条高质量记忆

- **检测**：用 `python3 scripts/weekly_scan.py` 的「2. 碎片簇」段：按 (日期, 主tag) 聚类 ≥3 条成候选簇，并同时给出**簇内 3-gram 凝聚度 maxJac**
- **规则**：🔴 只有 maxJac ≥ 0.55 的候选簇才算「真碎片簇」值得整合。同日同 tag 但主题各异的独立记忆会被机械聚类误并成一簇——2026-09-21 实证：98 个候选簇中 97 簇 maxJac < 0.55（多为时序流水与独立事件），仅 1 簇 0.610，且经内容审查属「版本演进链」而非碎片。禁止凭「同日期同 tag」直接整合
- **规则**：版本演进链（同一决策的旧版与纠正版、同一会话的多次 commit 且 taskId 不同）不属碎片：按 PRESERVE HISTORY 保留全部，仅确认旧条已自带「已被替代 / 已纠正」标记（保留替代链本身即历史证据）
- **合并**：宿主模型按「整合九规则」整合（见 constraints）
- **写入**：memory_write(action="remember", kind="lesson", importance=0.7, tags=[主题], content=模板文本)
- **删除**：写入成功后才逐条删除原碎片
- **验证**：用 2-3 个主题查询 recall，新记忆 score ≥ 0.6；抽查无 LLM 自造数字、无近重复、无悬空代词，不达标该簇重做

### 步骤 5b：长谱系条目拆分（content 逼近单条 6,000 上限）

把 content 逼近单条 6,000 上限的「合并磁石」条目做**无损拆分**：核心留在本条，谱系/案例外置为 kind=lesson 原子条目，两向互引 id。

- **触发**：`scripts/weekly_scan.py` 报 content>4000；其中 ≥5,500 者为高危（余量 <10%，任何一次追加都可能撞上限）。
- **🔴 先判「该不该拆」**（10-20）：`合法长文` 只是长度事实；仅 ≥5,500 或一题多族磁石才拆，单主题与过时 runbook（加 `已被替代` 后降权）不拆；基线 7 条与判据全表见 reference。
- **📖 触发即必读** `references/step5b-long-entry-split.md`（完整执行序列：覆盖度扫描判定表 → 外置 metadata 字段 → 父条目回写参数 → 验证收尾）。**不执行覆盖度扫描就外置＝制造重复；不回写父条目＝谱系断链。**

**🔴 四条硬门禁（纪律本体在此，执行细节在 reference）**：
1. **覆盖度扫描前置**：原文每个语义段取 1–2 个特征串跑全库 `SELECT id ... WHERE content LIKE '%串%'`；命中**只含本条** ⇒ 必须外置，命中**含他人** ⇒ 索引指向既有 id **不复制**（复制＝制造重复）。
2. **`parentId` 必须取完整 36 位 UUID**，🔴 禁用 8 位短前缀 —— 10-11 首跑写错一组（记成 `62d1`，真值 `c6d1`，仅一字之差），与步骤 6 的 supports 短 id 事故同源。
3. **写后必核 `createdAt` 为当日**：早于今日 ⇒ 命中覆盖了既有条目，立即按步骤 3 存档恢复原文。**父条目回写不传 `--metadata`**（PATCH 替换语义会波及 `recallCount`/`lastRecalledAt`），`--tags` 传原 tags 并集。
4. **零丢失硬门禁**：回写后对原文每个语义段做**全库** `LIKE` 复扫，`ORPHANS` 必须 = 0；出现孤儿 ⇒ 回补进对应子条目后再复验，**不得只改父条目**。🔴 **判据：只查索引池不算取证，必须全库扫描** —— 10-11 首跑只查索引池判了 4 个孤儿，全库扫描确认是**真丢失**（`史/理/硬/路`、`歷/處/網`、`is ambiguous`、`29/29` 全库 0 命中），回补后才归零。

- **收尾**：拆分属写入动作 ⇒ 完成后必须重跑步骤 9 镜像同步，并核三源一致（DB = FTS = Mirror）。

### 步骤 6：宿主模型蒸馏（reflect 宿主版）

把同主题 lesson 聚类蒸馏为 principle，替代付费 inferencer 的 reflect

- **动作**：memory_recall(action="search", kind="lesson") 拉近 30 天 lesson；按 tags 聚类 ≥3 条同主题
- **动作**：宿主模型归纳共性规律为 1 条 principle，证据 id 存入 metadata.supports
- **动作**：memory_write(action="remember", kind="principle", importance=0.85, tags=[主题,principle,reflected], metadata={supports:[证据id列表], reflectedAt:当前ISO时间, reflectTag:主题, lastRefreshedAt:当前ISO时间}) —— 🔴 reflectedAt 必传：引擎据此刷新 active context 的 lastReflectAt 标记（0.3.19+），周度观察才能看到蒸馏时间戳随本通道刷新
- **MUST**：🔴 supports 数组必须存证据 lesson 的【完整 36 位 UUID】——禁止 8 位短 id 前缀（2026-09-07 实测踩坑：3 条 principle 写短 id 致 observation.py ALERT「12 个 supports 指向不存在记忆」principle_supports_missing=12；观察脚本按完整 id 校验，短 id 全部失配。修复=CLI update 全量 metadata（PATCH 为替换语义，须连 reflectedAt/reflectTag/lastRefreshedAt/projectId 一并回填），复验 supports_missing=0）。从 lesson 取完整 UUID：存档 JSON 或 `sqlite3 ~/.leafmem/memory.sqlite "SELECT id FROM memory_items WHERE id LIKE '<8位>%'"` 反查（🔴 `get` 只认完整 UUID，传短 id 报 `Memory not found`，勿误判为条目已删）
- **节流**：同主题 6 天内已蒸馏（查已有 principle 的 reflectedAt）则跳过

### 步骤 7：画像刷新（profile 宿主版）

基于 preference delta 更新用户画像，替代付费 inferencer 的 profile

- **动作**：memory_recall(action="search", kind="preference") 拉全部 preference；memory_recall(action="active_get", kind="profile") 读当前画像
- **动作**：宿主模型比对差异，**只输出需要更新的分节**（"## 分节标题\n新内容" markdown）；memory_write(action="active_distill", kind="profile", content=更新分节)
- **动作**：🔴 通道（2026-09-14 实测打通）：自动化会话（`mcp__leafmem__*` 恒 absent）用 `scripts/leafmem_mcp_call.py memory_write '{"action":"active_distill","kind":"profile","content":"..."}'` —— `active_distill` 只在 `src/mcp/handler.ts` 实现，HTTP 面不暴露；该脚本拉临时 stdio 进程与常驻服务共享同一 sqlite。
- **动作**：🔴 **scope 必须走查询串 `?scope=agent:workbuddy`**（2026-10-05 实测）：传 `?scopeType=agent&scopeId=workbuddy` 或省略 scope，服务端**不报错**而是返回**空快照**（`profile.present=false` / `sections=[]` / `principles=0`）。症状酷似**数据丢失**，实为口径错。🔴 判据：`stats.principleCount` 与步骤 2 的 `kind='principle'` 计数不一致，即先怀疑 scope 参数形态。
- **动作**：🔴 节奏：周度观察的 [WARN]「画像超过 14 天未刷新」即本步骤的触发信号（2026-09-14 实测命中）。周维护时先跑 observation（步骤 10），再据此决定是否刷新画像。

**🔴 分节合并语义**：引擎按分节标题合并——同名分节被替换、新分节追加、**未提到的分节原样保留**。宿主永远不要输出全文覆写，避免误删其他分节。

**备注（2026-08-19）**：🔴 console 洞察页"用户画像"卡片=profile 快照，**memory_govern update 修改 preference 记录不会自动反映到画像卡片**；`memory_organize(action=profile)` 需付费 inferencer（本机返回 no_inferencer）。用户反馈"画像没更新"时走本步骤宿主版 active_distill（2026-08-19 实测成功：sectionsBefore/After 13、merged 1）。

**📖 按需读** `references/mcp-channels.md`（通道调用器用法 / HTTP `Bearer` 鉴权与 `X-API-Key` 失效 / governance 返回结构 / scope 静默空快照全症状表 / console 卡片刷新路径）——**在自动化会话执行本步骤或步骤 8 时必读**。

### 步骤 8：衰减降权

陈旧且未被召回的低重要性记忆降权（不删除，pinned 豁免）

- **动作**：mcp__leafmem__memory_organize(action="decay", scopeType="agent", scopeId="workbuddy", dryRun=false) —— 纯规则，不需要 LLM
- **动作**：🔴 通道（2026-09-14 实测打通）：decay 同样不在 HTTP 暴露面 → 自动化会话用 `scripts/leafmem_mcp_call.py memory_organize '{"action":"decay","dryRun":false}'`；返回 {scanned, decayed[]}，scanned 应等于库内总条数（2026-09-14 实测 scanned=1601 / decayed=0，与 observation 的 decay_candidates=0 互相印证）。可先 --dryRun:true 预演。

### 步骤 9：镜像同步

导出全量记忆到本地镜像，供 MCP 降级兜底

- **动作**：node `~/projects/leafmem/ops/mirror-sync.js`（默认写 ~/.leafmem/mirror，可 --mirror-dir 覆盖）。🔴 **安装目录口径 ＝ `~/projects/leafmem`**；旧文所记 `npm root -g`/@xdragonjia/leafmem 下**无 ops/ 与任何脚本**（2026-10-11 实测，按旧路径执行会报"脚本缺失"）。
- **规则**：🔴 执行顺序：镜像必须是**全部写入动作完成之后**的收尾步骤。LeafMem commit（收尾留痕）本身会写入 1 条 session 记录，先跑镜像会留下 1 条差——2026-09-21 实测 1832→1833，重跑后三方一致。凡镜像之后再有任何写入（含 commit / task_append / remember），必须重跑本步骤
- **检查**：收尾核对须三源同数：`DB = FTS = Mirror 记录数`，并由 `memory_items_fts - memory_items = 0` 佐证 FTS 无滞

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
- **规则**：🔴 **`profile_sections` 是子串计数口径，会比真值多算**（2026-10-05 实测：脚本报 28、治理接口真值 27）。**引用画像分节数以治理接口 `/v1/governance?scope=agent:workbuddy` 的 sections 数组长度为准**，脚本值只作环比趋势用；二者差 1–2 不算异常，差值突然变大才需查正文是否新插了标题字面量（根因与全症状见 `references/scripts-usage.md`）

**备注**：结论格式：正常 / 需关注 / 需行动 + 一句话依据；追加记录到宿主当日记忆日志（含日期，追加不覆盖）

### 步骤 11：实体词表巡检（2026-09-03 新增）

防止实体词表陈旧导致新领域无法实体化（strict 抽取器只认控制词表+内置词典+@提及）

- **触发**：步骤 10.f 发现 entity_count 连续 2 周零增长而记忆在增长；或每月例行一次
- **动作**：扫描近 30 天记忆中高频出现的专名（新项目/新工具/新产品名），与 ~/.leafmem/entity-vocab.json 比对
- **动作**：把确有所指的新词追加进词表（kind: project/tool/person/org），备份原文件后再写；词表对新写入即时生效
- **动作**：存量记忆补链：node ~/projects/leafmem/ops/entity-relink.mjs --dry 预估后再正式跑（纯增量幂等三接口，只加不删；跑前备份 memory.sqlite）

**备注**：🔴 只加确有所指的专名，不加通用词； MCP stdio 进程的词表在进程启动时加载，宿主重启后生效，launchd 后台服务可 launchctl kickstart -k 即时生效

### 步骤 12：报告与留痕

每周固定推送周报（含观察结论）；无整理动作且观察全绿时可简化为仅日志

- **分支**：
  - 若有删除/整合/蒸馏动作，或周度观察出现需关注/需行动项 → 通过宿主可用的消息渠道发送周报：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数 + 本周观察结论与关键环比（memories/principle/recall/profile/一致性）
  - 否则 → 仅写宿主当日记忆日志，不推送

- **产物落点**：🔴 写 `outputs/` 前必读 `~/WorkBuddy/outputs/CLASSIFICATION_RULES.md`。周报固定落 `~/WorkBuddy/outputs/报告/leafmem-weekly-report-{YYYYMMDD}.md`。**禁写**：`outputs/` 根目录、`outputs/项目/leafmem-productization/runs/observation/`（2026-09 起失效）。**判据**：写后 `find ~/WorkBuddy/outputs -maxdepth 1 -type f` 只应见 `CLASSIFICATION_RULES.md`。全绿且无动作 → 不落盘。

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

**SHOULD**：

- SHOULD 整合遵守九规则：UPDATE 优先于 CREATE、一条一侧面、按实体匹配、状态变更带日期、CASCADE 级联、解析模糊指代、PRESERVE HISTORY、NO COMPUTATION、异题分离

## 示例（examples）

**📖 按需读** `references/examples.md` —— 碎片整合正例、前缀聚类误删反例。执行只需记一句：**先存档 → 写入成功 → 再删原条**。

## CLI 通道：长文本引号陷阱（2026-09-06 实测修复，🔴 数据损坏级）

`~/.leafmem/leafmem-cli.sh` 曾有 4 处未加引号的 `${@:-}`（recall/remember/list/update 向 Python 传参），shell 词分割会拆碎 `--content "长文本 含空格"`，Python 只取首词 → **含空格长文本静默截断，无报错**。

- 修法＝`${@+"$@"}`（保引号语义 + 兼容 bash 3.2 + `set -u`）
- 🔴 **两处都要改**：本地 `~/.leafmem/leafmem-cli.sh` ＋ 上游模板 `projects/leafmem/ops/leafmem-cli.sh`——`dist/agents/hooks.js` 的 `installLeafmemCli()` 每次升级会**无条件覆盖本地**，只改本地必被回滚
- CLI 写完**回读校验字段长度**；CLI 出问题可用 MCP 直连兜底（两通道互为备份）

## `<error_handling>` 异常处理

**failure_criteria 失败判据**：

- MCP 连续不可用（recall/write 均失败）
- 存档文件行数与库内条数不一致
- 整合验证 recall score < 0.6

**fallback_strategy 降级策略**：

- **MCP 不可用**：① 等待 60 秒重试一次；② 仍失败则只执行只读步骤（健康检查/检测报告），删除/整合全部跳过并在报告标注
- **存档不一致**：① 重新导出一次；② 仍不一致则中止全部删除类步骤，只留健康检查报告
- **超时（>10 分钟）**：① 把剩余碎片簇截断到前 10 簇，其余留到下周

## `<output_format>` 输出格式

- **类型**：message
- **路径**：飞书小虾群（有动作时）+ ~/.workbuddy/memory/ 当日日志（总是）
- **格式**：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数

## 检查点（checkpoints）

- **启用**：true
- **备注**：步骤 3 存档为强制检查点（🔴 STOP）；中断恢复时从最近完成的步骤续跑，删除类步骤前重新确认存档新鲜

## 参考文件（references）

**📖 按需读** `references/scripts-usage.md` —— 各脚本的**完整参数、输出字段、退出码、判读陷阱**。各步骤正文已写「何时用」，此处只留职责索引：

| 文件 | 职责（细节读文件） | 步骤 |
|---|---|---|
| `references/cli-write-channel.md` | 写入通道／CLI 降级链／recall 契约／remember 覆盖事故 | 1 |
| `references/step5b-long-entry-split.md` | 长条目拆分执行序列＋判定表＋基线 | 5b |
| `references/mcp-channels.md` | 自动化 MCP 通道／鉴权／scope 空快照 | 7、8 |
| `references/examples.md` | 整合正例／前缀聚类反例 | 5 |
| `references/scripts-usage.md` | 脚本参数、输出字段、退出码、判读陷阱 | 2b、3、4、5、9、10、11 |
| `scripts/stale_task_sweep.py` | 残留任务扫描（只读；exit 2＝有超龄/非法状态） | 2b |
| `scripts/archive_dump.py` | 全量存档导出（步骤 3 检查点实现） | 3 |
| `scripts/weekly_scan.py` | 周维护量化扫描（五类信号，只读） | 4、5、5b |
| `scripts/leafmem_mcp_call.py` | MCP stdio 调用（HTTP 面未暴露的动作） | 7、8 |
| `ops/mirror-sync.js` | 镜像同步（🔴 安装目录 `~/projects/leafmem`） | 9 |
| `ops/observation.py` | 周度观察采集（约 20 指标，零 LLM） | 10 |
| `ops/entity-relink.mjs` | 实体补链（只加不删，跑前备份） | 11 |
| `ops/consolidation.js` | ⚠️ 历史脚本（缺 DEEPSEEK_API_KEY 不可运行；去重已归步骤 4） | — |

> 📜 版本演进记录已外置 → **CHANGELOG.md 末尾**。
