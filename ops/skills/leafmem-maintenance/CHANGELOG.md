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
