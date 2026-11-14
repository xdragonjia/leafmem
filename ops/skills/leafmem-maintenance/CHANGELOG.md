## [1.8.6] - 2026-11-14

- 🔴 **(b) 纪律机械化：下沉到 core `remember()`，四写入通道全覆盖**（事故驱动，第三次重犯后根治）。
  - **事故**：raw 自动化任务每晚同模板摘要 `remember`，连续多晚静默覆盖 11-06（`f8ac5aec`）～11-09 条目；11-14 写后 `get` 见 `createdAt` 早于今日才暴露（lesson `77f0f740`）。损害面＝手写摘要层；日级全文由日志回流「文件头」条目独立承载、未丢。
  - **元教训一**：纪律写在文档/SOUL/prompt 里 ≠ 会被执行（(b) 条与 SOUL 6d 早已存在仍连犯三次）。**元教训二（小龙 11-14 追问「MCP 通道会不会漏」后补）**：防线加在哪一层决定它覆盖几条通道——最初只在 CLI 壳层加 `createdAt` 判据，但 **MCP `memory_write` 不经过 CLI**（直连 `dist/bin/leafmem-mcp.js`），CLI 层判据对 MCP 完全失效。「我以为我懂」陷阱：熟悉 CLI 就在 CLI 修，没回到汇聚点。
  - **修法（根治）**：判据下沉到最内层 `src/core/memory.ts` `remember()`——MCP / HTTP（CLI）/ batch / 摄入脚本**四条通道都汇聚于此**（同 §B2 enrichment 放置原则）。四个合并分支（evaluator ignore/update/contradict ＋ legacy threshold-dedupe）写回前统一调 `markMergedOver()`：打 `metadata.mergedOver`（`at`/`mode`/`incomingKind`/`incomingSource`）＋ stderr `OVERWRITE WARNING`。标记随响应返回，任何客户端可机械判「新建 vs 合并」，且能捕获「同日覆盖今日新建条目」这种 `createdAt` 盲区。CLI 壳层保留就近提示（优先读 `mergedOver`、回退 `createdAt`）。四层防线：**L0 core 权威打标＋警告**／L1 CLI 就近提示／L2 prompt 侧 `[leafmem]` 汇报行（M10）／L3 本技能四条纪律。
  - **验收**：`npm run check` exit 0；`npm test` **339/339 全绿**（新增专项用例：合并打 `mergedOver`+stderr 告警、全新创建两者皆无；既有用例断言同步补字段）；`npm run build` exit 0；`launchctl kickstart` 重启服务（防运行进程持旧码）；HTTP 通道 E2E：首次全新写入 `mergedOver=None`、二次同内容写入命中同 id 且 `mergedOver={mode:threshold-dedupe}`；**同日覆盖负例**（`createdAt` 启发式盲区）仍被 `mergedOver` 判据捕获；服务端 `agent-service.err.log` 收到 `OVERWRITE WARNING`；测试条目均已删。备份 `backups/05cli/leafmem-cli.sh.bak-20261114-0855`。细节外移 `references/cli-write-channel.md` §6 ④⑤，正文 (b) 只留判据＋指针（体积 cl100k <10,000）。

## [1.8.5] - 2026-11-09

- 🔴 **4b 判据加固：修「同节同文被 section 命名变异漏判」**（来源＝2026-11-09 周整实测 `executor_dups` 报 0，但库内确有 2 组同文，靠人工归一化验 MD5 才抓到）。
  - **三重成因**，全在归一化层，共同特征是**静默少抓、不报错**：
    ① section 未剥时间前缀——`09:02 外部技能/CLI/模型三线周检（ext-skill-weekly-check）` vs `09:02–09:40 …（… 第 10 次）`；
    ② section 有 `[:40]` 硬截断——两节名前 38 字相同、第 39 字恰为 `）` vs 空格，截断把尾部差异放大成关键差异；
    ③ `_bare` 未去尾部 `---`——v3 写入时本已剔除、legacy 没剔，同段正文差 3 字符（实证 bare 644 / 647）。
  - **修法**：新增 `_sec_key()` 归一到「主标题」（剥时间前缀 → 剥 `（续N）` → 取首个左括号前主干，**不截断**）；`_bare()` 补去尾部 `---`。取主标题而非逐个剥尾部括号，是因为括号内形态太多（编号/耗时/口径），剥不干净会留残括号导致仍不等。
  - 🔴 **section 约束保留，并新增「跨节同文不删」判据**：全库剥壳同文 2 组中，1 组异节（`2209616f`/`9ecb7a23`——`每日知识运营 #61` 与 `今日一览` 各记同一段哨兵结果，`chunk.span` 首尾相接 1370-1730 / 1730-2090）属**源文档合法重复**，删掉会丢失「该段在两节都出现」的结构信息。**去掉 section 约束就会误删它**。
  - **验收**：新增 `scripts/test_executor_dups.py` 固化回归（T1 已知正例／T2 空输入／T3 跨节零误伤／T4 阵容守卫＋可选新旧对照）。实测：新逻辑 2 组、旧逻辑 0 组（**证明改动非 no-op**）、跨节 0 组、空输入不崩，RESULT=PASS；真库复跑 `EXECUTOR_DUPS=0`。
  - **体积**：SKILL.md 仅改判据一行＋指针，细节全落 `references/step4bc-dedup-and-kind-gates.md` §1.3 / 1.3b / 1.3c；cl100k 9,958 → 9,988（<10,000，P1=0）。过程记录：首版改动曾写到 10,024 触发 P1「基线外新增」，压缩判据行与参考段元描述后回到 9,988——**本技能已几无余量，下次加段前必须先算 token**。

## [1.8.4] - 2026-11-03

- 🔴 **新增步骤 4b「双执行器同文重复」与 4c「非标准 kind 门禁」**（事故驱动：2026-11-03 哨兵转交遗留项处置）。
  - **4b 根因**：daily md 被两个执行器回流——语义层日更 13k1c（legacy 无 `chunk.span`）与哨兵 05:30（v3 带 span），两套 state 互不可见。**全文 SHA256 判不出**（面包屑格式不同：`[日期·标题]` vs `[日期·标题·序/总]`），只能剥壳后判。上一版 SKILL 的删除动作只消费「1. 真重复」段，而这类重复落在「3. 跨日近重复」段 ⇒ **报告了却无人处置**，10-02 周整清 90 条、11-03 又长 28 组。修法＝`weekly_scan.py` 新增 `scan_executor_dups` 段（同 `source_file` + 同 `section` + 剥壳正文 md5；**限定 section 以免误伤「不同节引用同一段话」的合法情形**），自动算出 `keep_id`（带 span 的 v3）与 `drop_ids`，SKILL 明确「保留 v3、删 legacy，反向保留会丢溯源能力」。
  - **4b 架构侧**：13k1c 已改为调用 `~/projects/leafmem/ops/ingest-daily-logs.py` 瘦封装、共用 `~/.leafmem/daily-ingest-state.json`。🔴 关键订正：仅加「库内正文指纹兜底」不够——兜底是**先到先得**，先跑的 legacy 劣质版占位会挡住后跑的 v3 优质版（**质量倒挂**）。业界幂等标准是「稳定 content hash + 在写入处约束」，**统一写入口优于兜底拦截**。
  - **4c 判据**：允许清单六种（`lesson/preference/decision/note/experience/principle`），`BAD_KIND` 必须＝0。**不是整洁问题而是通路问题**——`kind` 决定该条走哪条数据通路：`reflect` 只从 `lesson/decision/note` 蒸馏原则（`memory.ts:708`）、`profile` 只读 `preference/identity`（:891）、`principle` 召享有固定加权（:1034）；写错 kind ＝ 永远进不了对应通道 ＝ 内容静默失效。实证：10-30 两条 S9 结论写成 `finding`，连续 3 个周整周期未处置。
  - **验收**：终态 `executor_dups` 28→0、`exact_dups` 15→0、`BAD_KIND` 2→0；负例注入 5 例（同节同文→检出 1；异节同文→0；同节异文→0；非 daily→0；空输入→0）证明判据非恒真。存量 29 条先归档（88KB 定向备份 + 104MB 整库快照，`quick_check=ok`）后删除，验证待删 28 条零含 span。

## [1.8.3] - 2026-10-20

- 🔴 **体积余量专项：正文 cl100k 9,959 → 9,429 token（−530，余量 41 → 571 token）**。1.8.2 交付后该技能距 10,000 预算仅剩 41 token，任何一次正常追加都会撞 P1——属「随时越线」而非「已越线」，本轮按渐进式披露纪律提前腾位。
  - **外移**：`## 示例（examples）` 整节（396 字符）→ 新建 `references/examples.md`（含碎片整合正例、前缀聚类误删反例），正文留一句可执行边界「先存档 → 写入成功 → 再删原条」＋指针。
  - **压缩**：参考文件索引表（12 行描述）与步骤 12 产物落点段，改为一句话式；**判据与禁写路径全部保留**（`find ~/WorkBuddy/outputs -maxdepth 1 -type f` 只应见 `CLASSIFICATION_RULES.md`）。
  - **零丢失核验**：11 条 NEVER/MUST/SHOULD 全部在位；关键锚点全域 grep 命中——`recall_return_contract`、`remember_overwrite_hazard`、`三不碰`、`PRESERVE HISTORY`、`NO COMPUTATION`、`ORPHANS`、`parentId`、`scope 铁律`、`九规则`、`强制检查点` 均为 1–3 个文件命中，无消失项。
  - 门禁：`check_skill_size.py` P0/P1=0（P2 提示保留）；`check_skill_metadata.py --strict-xml --strict-changelog` 通过；已建 `skill_edit_guard` 快照，后续改动可校验锚点丢失。

## [1.8.2] - 2026-10-20

- 🔴 **步骤 5b 补「该不该拆」的判定维度，防每周对同一批合法长文反复分析**（来源＝10-20 每日哨兵报告被用户追问「这 7 条超长是否该处理」）。原文只有「content>4000 触发、≥5,500 高危」的长度口径，没写清「长 ≠ 该拆」，实际后果是每周对固定 7 条（4332–5318 字符）重复说明一遍。
  - 判据三分：`合法长文` 只是长度事实（`⚠️畸形(content==summary)` 才是缺陷）；真需拆＝≥5,500 **或** 一题多族的合并磁石；单主题长文与**过时 runbook 型**（加 `已被替代` 标注后走步骤 8 降权）不拆。
  - **落点分工**（体积纪律）：正文只留一行判据＋指针，完整判据表、2026-10-20 基线 7 条（4332–5318，全 `合法长文`）与已知待降权项外移至 `references/step5b-long-entry-split.md` §1.0。首版直接写进正文曾把 cl100k 推到 10,243（超 P1 预算 243 token），压缩后 **9,959 / 10,000** 通过。
  - 同日另修：`~/.leafmem/backups/backup-stderr.log` 的 2 行 08-12 旧路径报错系陈旧残留（mtime 冻结于 08-12，plist 已改指 ops/sqlite-backup.sh），已归档 `~/WorkBuddy/backups/02mem/` 并清空，哨兵不再每轮解释其来源。

## [1.8.1] - 2026-10-19

- 🔴 **步骤 6 修正一处「文档与实测不符」的反查说明**（来源＝本轮周维护真实踩坑）：原文让用 `leafmem-cli get <短id>` 反查 lesson 完整 UUID，但 **`get` 只认完整 UUID**——传 8 位短 id 返回 `{"error":"Memory not found"}`，症状酷似「条目已被删」，本轮为此多花 2 次调用。改为 `sqlite3 … WHERE id LIKE '<8位>%'` 前缀反查，并在正文标注该症状与误判风险（规则＋反例同处）。属一行级修订，正文体积基本不变（9,873 → 9,859 token 实测仍在 P1 预算内）。

## [1.8.0] - 2026-10-12

- 🔴 **P1 体积越线专项修复：渐进式披露重构**（承接 1.7.1 登记的未修项）。`check_skill_size.py` 报 **cl100k 11,554 token ≥ 预算 10,000**，溯源 10-11 的 v1.7.0 新增整段步骤 5b（1,199 token）。按 `skill-maintainer/references/per-skill-slimming-sop.md` 执行，**先取证后下刀**：
  - **三处引用耦合取证**（SOP 第 2 步，缺一即假阴性）：① 文件系统 `grep -rln` 全库 —— 命中方全是 CHANGELOG／baseline／历史日志，非消费者；② 🔴 `~/.workbuddy/workbuddy.db` 的 `automations` 表 —— 命中 **`canary-weekly` 自动化任务（ACTIVE；任务 ID 前缀沿用旧品牌命名）**，读 prompt 原文确认它是**按 ①–⑦ 顺序整份顺序执行、不按锚点消费**；③ KLXZ 侧 `~/.kunlunxiaozhi/workbuddy.db` —— 无同名任务。据此排除「按锚点消费的段外移＝净负」风险。
  - **模式 B 外移**（非模式 A 路由化：单关注点技能里混入了「少数场景才用」的通道与用法细节）：新建 4 个 reference，正文留「指针 + 何时读 + 不读的后果」——
    | 外移内容 | 去向 | 正文保留 |
    |---|---|---|
    | 步骤 1 CLI 写入通道/task_append/recall 契约/remember 事故全记录 | `references/cli-write-channel.md` | 四条写入硬纪律 + 读通道口径判据 |
    | 步骤 5b 完整执行序列（覆盖度扫描判定表→回写参数→验证收尾） | `references/step5b-long-entry-split.md` | 四条硬门禁（含零丢失 ORPHANS=0） |
    | 步骤 7/8 自动化会话 MCP 通道（active_distill/decay/Bearer 鉴权/scope 空快照） | `references/mcp-channels.md` | scope 形态硬规则 + 分节合并语义 |
    | 4 个只读脚本 + ops 工具的完整用法与输出判读 | `references/scripts-usage.md` | 12 行职责索引表（文件/职责/用在哪一步） |
  - **判据留在正文**（SOP 硬纪律 2）：带日期与事故编号的 `name=recall_return_contract` / `name=remember_overwrite_hazard` 两个 **P0 具名契约**及其判据**全部保留在步骤 1 正文**，只把叙事与通道细节外移；四个步骤的硬门禁逐条留正文。
  - **结果**：正文 **11,554 → 9,709 token（−1,845，−16.0%）**、272 → 277 行（refs=4）、P1 清零。⚠️ 余量仅约 290 token，**下次加段前须先看 `check_skill_size.py --skill leafmem-maintenance`**。
  - **三重验证**：① `check_skill_size.py` exit 0（P0=0/P1=0）＋ 编辑守卫「能力零丢失」通过（锚点 44→51、纪律条数 10→10 无骤降）；② 内容零丢失 diff —— 39 个关键证据串全域（正文+references）保留，改前存在现消失项 **0**，章节标题无丢失；③ 4 个 reference 死链自检全通、>100 行均带 TOC、引用深度 1 级。
  - 🔴 **过程中被编辑守卫抓出的真实丢失**（已修，值得记）：改写步骤 1 时我把两个 P0 契约的 `name=` 具名前缀删掉了，守卫报「锚点丢失 6」。逐项核查发现 4 项是假丢（`routes-memory`/`routes-console`/`tags_json`/`task-detail` 仍在 references，仅因被我加反引号包裹不被裸词形态识别），**2 项是真丢**（契约名消失）—— 已恢复。**判据：外移/改写纪律段时，具名契约 ID 属能力标识，不属可压缩的叙事。**

## [1.7.1] - 2026-10-12

- 🔴 **步骤 12 新增「产物落点」段**（来源＝2026-10-12 小龙当场纠正的一次真实违规）。事故：本轮周维护把周报文件写到了 **`~/WorkBuddy/outputs/` 根目录**（`leafmem-weekly-report-20261012.md`），违反 `outputs/CLASSIFICATION_RULES.md` 的一级目录结构（**根目录只允许 `CLASSIFICATION_RULES.md`**）。根因＝技能与自动化 prompt **均未规定周报产物落点**，宿主临时自拟路径，且**未先读分类规则文件**（该文件明写「每次向 outputs/ 写入任何内容前，必须先读取本文件」）。三处按「规则＋反例＋判据」成对固化：
  (1) **规则**：需落盘周报时，落点固定为 `~/WorkBuddy/outputs/报告/leafmem-weekly-report-{YYYYMMDD}.md`（周报属规则中的「状态报告、日/周报」类；同类先例＝`报告/weknora-health/`）；**写前必读** `outputs/CLASSIFICATION_RULES.md`。
  (2) **反例（含确切症状）**：❌ 写 `outputs/` **根目录** —— 根目录只容忍 `CLASSIFICATION_RULES.md`（及 macOS `.DS_Store`），任何其它文件即违规散落；❌ 写 `outputs/项目/leafmem-productization/runs/observation/` —— 该路径 2026-09 起**已失效**，目录内只剩 `leafmem-observation-log.jsonl.legacy`／`.stale-20260810`／`weekly-judgment.md`（末条 2026-09-03），观测数据已改落 `~/.leafmem/observation/leafmem-observation-log.jsonl`。
  (3) **判据**：写入 `outputs/` 后跑 `find ~/WorkBuddy/outputs -maxdepth 1 -type f`，输出**只应**为 `CLASSIFICATION_RULES.md`（＋`.DS_Store`）；出现其它文件即落点错，当轮纠正。
  - 另：`default` 分支（无整理动作且观察全绿）**不落盘文件**，避免制造无价值产物。
- 处置：违规文件已 `mv` 至 `~/WorkBuddy/outputs/报告/leafmem-weekly-report-20261012.md`，`outputs/` 根目录已复检为干净。
- 🟠 **如实登记既有 P1（非本次引入）**：体积门禁 `check_skill_size.py` 报本技能 **token 11,790 ≥ 预算 10,000**（P1）。**归因取证**：对 1.7.1 编辑前的备份跑同一门禁得 **cl100k 11,284 token**，同样越线 ⇒ 越线**先于本次编辑**存在；溯源 10-05 周检记录为「size 无 P0/P1」，10-11 的 v1.7.0 新增整段**步骤 5b** 后越线，本次编辑再 +506 token。**未在本轮修复**：本条改动为针对性小修，把 280 行 SOP 压回预算需做渐进式披露重构（外移长细则至 `references/`），属独立任务，留待专项。**下轮技能门禁周巡检会复现该项**。

## [1.7.0] - 2026-10-11

- 新增**步骤 5b：长谱系条目拆分**（content 逼近单条 6,000 上限的无损拆分 SOP）。来源＝2026-10-11 每日只读哨兵任务中经小龙授权的一次实操：一次处置 3 条「合并磁石」（`9c2cd747` 5,996 / `5b540c89` 5,905 / `fcdcc15d` 5,857 字符），外置 8 条 kind=lesson 原子条目（`a69af85e`／`22a5e50b`／`80bd1d00`／`76c3a478`／`c22cb288`／`135da296`／`95bd8078`／`40f00c10`），父条目降至 2,294／2,744／1,671 字符；三族零丢失取证 ORPHANS=0、FTS 与镜像三源一致（2,171）。三处按「规则 + 反例 + 判据」成对固化：
  (1) **前置覆盖度扫描**——为每个语义段取特征串做全库 LIKE，命中只含本条 ⇒ 独有须外置；含他人 ⇒ 索引指向既有 id、不复制（避免制造重复）；
  (2) `parentId` 必须取**完整 36 位 UUID**——本轮实证记错一组（写成 `62d1`，真值 `c6d1`），与 1.6.1 前 supports 短 id 事故同源；
  (3) 🔴 **零丢失门禁 ＝ 全库扫描，不是只查索引池**——首版只比对「父+子+兄弟」索引池即宣布完成，4 个特征串实为**真丢失**（`史/理/硬/路`、`歷/處/網`、`is ambiguous`、`29/29` 全库 0 命中），回补进对应子条目后才归零。
- 修正 `<LeafMem 安装目录>` 路径口径：实测安装目录 ＝ **`~/projects/leafmem`**；技能旧文所记 `npm root -g`/@xdragonjia/leafmem 下**无 ops/ 与任何脚本**（按旧路径执行 mirror-sync 会报"脚本缺失"）。步骤 9/10/11 动作与 references 已统一改写。
- 顺带发现（**未修，登记待办**）：`~/.leafmem/mirror` 在本次前已 **6 天未刷新**（2,069 条 vs 库内 2,171，差 102 条）——镜像同步未被任何周期性任务覆盖，降级兜底会失真，需评估是否并入周维护步骤 9 的常态化触发。本次已手动刷新至三源一致。

## [1.6.2] - 2026-10-05

- 脚本归一：新增 `scripts/archive_dump.py`（步骤 3 全量存档的标准实现，只读 sqlite + 回读校验，输出 ITEMS/ALL/FTS/SIZE/VERIFY 五项）。此前每周的存档都是临时内联 Python，无固定实现、无内置回读校验——而步骤 3 是唯一的 🔴 STOP 检查点，理应由确定性脚本承载。步骤 3 动作改写为直接调用脚本，并补「VERIFY 不过 → 中止全部删除类步骤」的显式分支；references 同步登记。

## [1.6.1] - 2026-10-05

- 两处实测细节补录（均来自 2026-10-05 周度维护的走弯路现场，按「规则+反例」成对固化）：
  (1) 步骤 7 补 **scope 参数形态硬规则**：`GET /v1/governance` 必须走 `?scope=agent:workbuddy`；传 `?scopeType=&scopeId=` 或省略 scope 时服务端**不报错**，而是返回**空快照**（`profile.present=false`／`sections=[]`／`principles=0`／`stats.principleCount=0`／`totalRecallCount=0`，唯 `entityCount` 仍是全局值）——症状酷似「画像与原则全丢」，本轮花 2 次调用才定位。判据：`stats.principleCount` 与步骤 2 的 `kind='principle'` 计数不一致时，先怀疑 scope 形态而非数据。
  (2) 步骤 10 补 **画像分节计数口径**：observation.py 的 `profile_sections` 用 `content.count("## ")` 子串计数，会多算正文内的标题字面示例（本轮实测脚本 28 vs 治理接口真值 27）。引用分节数一律以治理接口 sections 数组长度为准，脚本值仅供环比。

## [1.6.0] - 2026-10-03

- XML 外壳退役：正文重写为纯 Markdown（结构规范化，零内容丢失）——删除 `<?xml?>` 声明、`<skill>` 包裹与 `<metadata>` 块（date/type/agent_created 并入正文首行元信息说明），顶层 XML 段转为 `## ` 标题并保留锚点字面量（identity_note / error_handling / failure_criteria / fallback_strategy / output_format），嵌套标签转为 MD 列表/加粗，正文逐字保留，`&lt; &gt; &amp;` 反转义回原始字符。frontmatter 仅 version 1.5.1→1.6.0，description 逐字未动。编辑守卫 verify 通过（锚点 6/规则ID 0/触发词 30/路由 0 四项零丢失）。

## [1.5.1] - 2026-10-03

- 渐进式披露：`<notes>`（2,209 tok）外置。

# Changelog — leafmem-maintenance

## 版本索引

| 版本 | 日期 | 主题 |
|---|---|---|
| [1.8.6](#186---2026-11-14) | 2026-11-14 | remember 写后自动核对 `createdAt`（CLI 通道级防线，第三次重犯后根治）；细节外移 `references/cli-write-channel.md` §6 |
| [1.8.5](#185---2026-11-09) | 2026-11-09 | 4b 判据加固：修「同节同文被 section 命名变异漏判」（`_sec_key()` 归一＋`_bare()` 去尾 `---`），跨节同文不删 |
| [1.8.4](#184) | 2026-11-03 | 新增步骤 4b「双执行器同文重复」与 4c「非标准 kind 门禁」（事故驱动：2026-11-03 哨兵转交遗留项处置）。 |
| [1.8.3](#183---2026-10-20) | 2026-10-20 | 体积余量专项：9,959→9,429 token（余量 41→571），示例外移＋索引表压缩 |
| [1.8.2](#182---2026-10-20) | 2026-10-20 | 步骤 5b 补「该不该拆」判据（长≠该拆／过时 runbook 不拆），基线 7 条入 reference |
| [1.8.1](#181---2026-10-19) | 2026-10-19 | 步骤 6 修正 `get` 只认完整 UUID 的反查说明（短 id 报 Memory not found） |
| [1.8.0](#180) | 2026-10-12 | P1 体积越线专项修复：渐进式披露重构（承接 1.7.1 登记的未修项）。… |
| [1.7.1](#171) | 2026-10-12 | 步骤 12 新增「产物落点」段（来源＝2026-10-12 小龙当场纠正的一次真实违规）。… |
| [1.7.0](#170---2026-10-11) | 2026-10-11 | 新增步骤 5b 长谱系条目拆分 SOP；修正 LeafMem 安装目录口径 |
| [1.6.2](#162---2026-10-05) | 2026-10-05 | 脚本归一：新增 scripts/archive_dump.py（步骤 3 标准实现） |
| [1.6.1](#161---2026-10-05) | 2026-10-05 | 补录治理接口 scope 参数形态 + 画像分节计数口径 |
| [1.6.0](#160---2026-10-03) | 2026-10-03 | XML 外壳退役：正文重写为纯 Markdown |
| [1.5.1](#151---2026-10-03) | 2026-10-03 | 渐进式披露：`<notes>` 外置 |

---

## 正文 `<notes>` 外置留档（2026-10-03）

<notes>
    <note id="2026-10-02">v1.5.0：新增步骤 2b「残留任务闭环清扫」+ scripts/stale_task_sweep.py。实证：控制台任务上下文滞留 9 条 active + 1 条非法 "done"（均为 09-15~10-02 期间自动化会话收尾未补 status 所致，主流程实际均已完成）。双根因：① 流程性——闭环靠收尾显式 task_append，中断/超时即滞留，本步骤为常态化兜底；② 产品性——handler.ts status 裸类型断言无运行时校验，已修（leafmem commit aba363b：枚举校验 + 回归测试，非法值报 -32602）。当日 10 条已全部闭环，复验 475/475 completed。</note>
    <note id="2026-09-28">v1.4.5：补齐两处实测细节。① 步骤 7 复验通道的**鉴权口径**——`GET /v1/governance` 只认 `Authorization: Bearer &lt;apiKey&gt;`，`X-API-Key` 头会被拒（返回 `Missing or invalid API key`，此前未记录，本周实测 4 次调用才定位，属可复用的操作性缺口；apiKey 在 `~/.leafmem/agent-service.json`）。② 收尾留痕的机械事实——`memory_write action=commit`（agent + sessionId + rollingSummary）会写入**恰好 1 条 session note**（本周实测 1955→1956），故镜像必须排在 commit **之后**，否则留 1 条差（与步骤 9 既有规则互相印证）。另：`scripts/leafmem_mcp_call.py` 是 Python 脚本，**必须用 python3 调起**（误用 bash 会报 `import: command not found`，症状酷似脚本损坏）。</note>
    <note id="2026-09-21">v1.4.3：把步骤 4/5 的判定从「人工抽样目视」升级为**量化判据**——新增 `scripts/weekly_scan.py`（只读，一次输出真重复 / 碎片簇+簇内 3-gram 凝聚度 / 跨日近重复 / 超长畸形 / 蒸馏候选+supports 断链五类信号）。步骤 5 立规：仅 maxJac ≥ 0.55 的候选簇才算真碎片簇（2026-09-21 实证 98 簇中 97 簇 &lt;0.55，唯一 0.610 者经内容审查为版本演进链应按 PRESERVE HISTORY 保留）。此前周维护结论形如「44 簇经人工审查全为独立记忆」，不可复核也无法跨周比较；改为脚本量化后结论可复现、可对账。同类判据纪律：近重复检测用 3-gram 倒排索引（1800+ 条秒级），朴素 O(n^2) 全量集合交集在本机跑不动。步骤 9 同步补执行顺序规则：镜像须在含 commit 在内的全部写入之后跑，否则留 1 条差（本轮实测 1832→1833）。</note>
    <note id="2026-09-14">v1.4.2：打通自动化会话的 MCP stdio 通道（步骤 7 画像刷新 / 步骤 8 decay）——active_distill 与 organize 类动作仅实现在 src/mcp/handler.ts，HTTP 面（routes-memory / routes-console）不暴露，此前周维护只能"跳过"；现以新增的 scripts/leafmem_mcp_call.py 按 mcp.json 配置启动临时 stdio 进程调用（initialize + tools/call），与常驻服务共享同一 sqlite、不冲突。2026-09-14 实测：画像 18→21 分节（merged=3，updatedAt 刷新为当日）、decay scanned=1601 / decayed=0（与 observation 的 decay_candidates=0 互相印证）、用 HTTP /v1/governance 复验通过。同时把「画像 14 天新鲜度」与 observation 的 [WARN] 显式挂钩为步骤 7 的触发信号。</note>
    <note id="2026-09-07">v1.4.1：步骤 6 新增 🔴 must——principle 的 metadata.supports 必须存完整 36 位 UUID（禁止短 id）。2026-09-07 周度维护实测：3 条新 principle 的 supports 误用 8 位短 id，observation.py 报 ALERT「12 个 supports 指向不存在记忆」（supports_missing=12）；CLI update 全量回填完整 UUID 后复验 supports_missing=0。同时记录 PATCH metadata 为替换语义（需连 reflectedAt/reflectTag/lastRefreshedAt/projectId 一并回填）。</note>
    <note id="2026-09-03-v14">v1.4.0：新增步骤 11 实体词表巡检——实测发现 strict 抽取器下实体增长完全依赖词表人工更新（leafmem 本身在 145 条记忆中出现却因不在词表而无实体）；判断清单加 f 项（entity_count 停滞检测），巡检含词表更新与存量增量补链方法（幂等三接口，只加不删，--dry 先行）。</note>
    <note id="2026-09-03">v1.3.0：并入原「周度观察+飞书提醒」开发期任务的持久机制——新增步骤 10 周度观察（observation.py --mode weekly 确定性采集 + 周环比五项判断），报告步骤升为周报口径（有动作/有观察异常才推送）；observation.py 同期通用化（scope 自动探测、随 npm 包分发）。排除场景措辞同步（每日观测采集→每日健康哨兵）。</note>
    <note id="2026-08-24">蒸馏节流补充（实测）：候选主题按 tags 聚类 ≥3 条 lesson 后，还必须与已有 principle 的 tags/content 比对覆盖——即使 principle 的 reflectTag 为空，只要其内容已覆盖候选主题（如 52567dbb 已覆盖飞书卡片 schema 2.0 note/ud_icon 坑，导致 ai-news-pusher 主题跳过），就不重复蒸馏；08-24 从 4 个候选主题（auto_collect/external-skill-updater/ai-news-pusher/公众号）蒸馏 2 条。</note>
    <note id="2026-08-10-v12">v1.2.0：明确 consolidation.js 已被本技能替代（其硬依赖的 DEEPSEEK_API_KEY 已移除，脚本不可运行）；supports 断链清理由 forget() 内置级联覆盖，无需脚本兜底。</note>
    <note id="2026-08-10">v1.0.0 首版：Phase 9 收编每周健康检查的整理职责；宿主模型蒸馏免付费 key；每周节奏。</note>
    <note id="2026-08-10b">v1.1.0：按 skill-creator 标准重构为 XML v2.0（author/三段式 description/10 标准模块/checkpoints/never-因为-替代格式）。</note>
  </notes>
