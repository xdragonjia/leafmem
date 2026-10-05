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
