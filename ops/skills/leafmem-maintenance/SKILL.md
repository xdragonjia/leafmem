---
name: leafmem-maintenance
version: "1.4.1"
agent_created: true
author: xiaoxia
description: >
  LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。
  覆盖健康检查、强制存档、真重复合并、碎片整合、原则蒸馏、画像刷新、衰减降权、镜像同步、周度观察与趋势判断、实体词表巡检。
  触发词：leafmem 维护、记忆整理、每周健康检查、深度整理、记忆治理、周度观察。
  排除场景：不做 WeKnora 知识库维护、不替代每日只读观测告警任务、不处理宿主安装配置。
---

<?xml version="1.0" encoding="UTF-8"?>
<skill>
  <metadata>
    <name>leafmem-maintenance</name>
    <version>1.4.1</version>
    <agent_created>true</agent_created>
    <author>xiaoxia</author>
    <date>2026-09-03</date>
    <description>LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。覆盖健康检查、强制存档、真重复合并、碎片整合、原则蒸馏、画像刷新、衰减降权、镜像同步、周度观察与趋势判断。排除：WeKnora 维护、每日告警、宿主安装。</description>
    <type>operations</type>
  </metadata>

  <identity>
    <role>LeafMem 记忆治理工程师</role>
    <goal>让记忆库保持高信噪比：重复的合并、碎片的整合、过时的降权、画像与原则常新，且全程不丢数据、不误删</goal>
    <vibe>保守删除、忠实转录、先存档后动手</vibe>
  </identity>

  <triggers>
    <keywords>
      <keyword>leafmem 维护</keyword>
      <keyword>记忆整理</keyword>
      <keyword>每周健康检查</keyword>
      <keyword>深度整理</keyword>
      <keyword>记忆治理</keyword>
      <keyword>周度观察</keyword>
      <keyword>consolidation</keyword>
    </keywords>
    <intent>对 LeafMem 记忆库执行周期性质量维护与周度趋势观察（由每周自动化任务调用，或手动触发）</intent>
    <exclusions>
      <exclusion>WeKnora 知识库的维护（用 weknora-rag）</exclusion>
      <exclusion>每日只读健康巡检（由「每日健康哨兵」自动化负责，模板 ops/automations/daily-sentinel.md）</exclusion>
      <exclusion>宿主安装/配置（用安装器或 INSTALL-KUNLUNXIAOZHI.md）</exclusion>
    </exclusions>
  </triggers>

  <identity_note>
    与 ops/consolidation.js 的关系：consolidation.js 是旧版 LLM 去重脚本（硬依赖 DEEPSEEK_API_KEY，
    2026-08-10 key 移除后已不可运行，仅存档于仓库作参考）。本技能是它的现行替代——语义级精修
    （整合/蒸馏/画像）由宿主模型通过 MCP 完成，免费；supports 断链清理已由 memory.forget() 内置级联覆盖。
  </identity_note>

  <workflow>
    <step order="1" name="召回历史教训">
      <description>执行任何维护动作前，先召回历史维护教训，避免重蹈覆辙</description>
      <action>mcp__leafmem__memory_recall(action="recall", message="leafmem 维护 整理 误删 教训")</action>
      <branch>
        <if>MCP 不可用</if>
        <then>按 CLI-first（2026-09-04 v0.3.21）：首选 `bash ~/.leafmem/leafmem-cli.sh recall "..."`（HTTP 通道，launchd 守护，自动化会话 mcp__leafmem__* 恒 absent 属预期）→ CLI 也不可达先查 `launchctl list | grep leafmem` → 最后 conversation_search；召回失败仍不阻塞，但删除动作必须更保守</then>
      </branch>
    </step>

    <step order="2" name="健康检查（只读）">
      <description>确认服务与数据完好，收集规模基线</description>
      <checks>
        <check>pgrep -f leafmem-mcp 确认 MCP 在线</check>
        <check>ls -lh ~/.leafmem/memory.sqlite 记录容量</check>
        <check>sqlite3 统计 scope=agent:workbuddy 的 memory_items 总数与 FTS 行数，二者应一致</check>
        <check>memory_recall(action="recall", message="leafmem scope 纪律") canary 验证应命中已知条目</check>
      </checks>
    </step>

    <step order="3" name="全量存档（强制，不可跳过）">
      <description>删除任何记忆前必须先导出全量 JSON 存档，作为误删回滚锚点</description>
      <action>Python 读 ~/.leafmem/memory.sqlite 全量 memory_items，导出到 ~/WorkBuddy/backups/leafmem-archive-YYYYMMDD.json</action>
      <checkpoint>🔴 STOP：存档文件写入并验证行数后，才允许进入删除类步骤</checkpoint>
    </step>

    <step order="4" name="真重复检测与删除">
      <description>合并完全重复的记忆</description>
      <rule>用全文规范化后的 SHA256 哈希判定重复（re.sub 空白后取 16 位）</rule>
      <rule>🔴 NEVER 用前缀聚类判定重复 — 因为同一 YAML 头部的不同内容会被误判为重复导致误删；替代做法是全文规范化哈希</rule>
      <action>每组保留 importance 最高 + updated_at 最新一条；其余 memory_govern(action=delete, scopeType=agent, scopeId=workbuddy)</action>
    </step>

    <step order="5" name="碎片簇整合">
      <description>把同日期+同 context 的 ≥3 条碎片整合为 1-2 条高质量记忆</description>
      <detect>按 (date, context) 聚类，≥3 条成簇</detect>
      <merge>宿主模型按「整合九规则」整合（见 constraints）</merge>
      <write>memory_write(action="remember", kind="lesson", importance=0.7, tags=[主题], content=模板文本)</write>
      <delete>写入成功后才逐条删除原碎片</delete>
      <verify>用 2-3 个主题查询 recall，新记忆 score ≥ 0.6；抽查无 LLM 自造数字、无近重复、无悬空代词，不达标该簇重做</verify>
    </step>

    <step order="6" name="宿主模型蒸馏（reflect 宿主版）">
      <description>把同主题 lesson 聚类蒸馏为 principle，替代付费 inferencer 的 reflect</description>
      <action>memory_recall(action="search", kind="lesson") 拉近 30 天 lesson；按 tags 聚类 ≥3 条同主题</action>
      <action>宿主模型归纳共性规律为 1 条 principle，证据 id 存入 metadata.supports</action>
      <action>memory_write(action="remember", kind="principle", importance=0.85, tags=[主题,principle,reflected], metadata={supports:[证据id列表], reflectedAt:当前ISO时间, reflectTag:主题, lastRefreshedAt:当前ISO时间}) —— 🔴 reflectedAt 必传：引擎据此刷新 active context 的 lastReflectAt 标记（0.3.19+），周度观察才能看到蒸馏时间戳随本通道刷新</action>
      <must>🔴 supports 数组必须存证据 lesson 的【完整 36 位 UUID】——禁止 8 位短 id 前缀（2026-09-07 实测踩坑：3 条 principle 写短 id 致 observation.py ALERT「12 个 supports 指向不存在记忆」principle_supports_missing=12；观察脚本按完整 id 校验，短 id 全部失配。修复=CLI update 全量 metadata（PATCH 为替换语义，须连 reflectedAt/reflectTag/lastRefreshedAt/projectId 一并回填），复验 supports_missing=0）。从 lesson 取完整 UUID：存档 JSON 或 `leafmem-cli get &lt;短id匹配的完整记录&gt;` 反查</must>
      <throttle>同主题 6 天内已蒸馏（查已有 principle 的 reflectedAt）则跳过</throttle>
    </step>

    <step order="7" name="画像刷新（profile 宿主版）">
      <description>基于 preference delta 更新用户画像，替代付费 inferencer 的 profile</description>
      <action>memory_recall(action="search", kind="preference") 拉全部 preference；memory_recall(action="active_get", kind="profile") 读当前画像</action>
      <action>宿主模型比对差异，**只输出需要更新的分节**（"## 分节标题\n新内容" markdown）；memory_write(action="active_distill", kind="profile", content=更新分节)</action>
      <note>🔴 分节合并语义：引擎按分节标题合并——同名分节被替换、新分节追加、**未提到的分节原样保留**。宿主永远不要输出全文覆写，避免误删其他分节。</note>
      <note id="2026-08-19">🔴 console 洞察页"用户画像"卡片=profile 快照（active_distill kind=profile 的产物），**memory_govern update 修改 preference 记录不会自动反映到画像卡片**；mcp__leafmem__memory_organize(action=profile) 需付费 inferencer（本机返回 no_inferencer）。用户反馈"画像没更新"时走本步骤宿主版 active_distill（2026-08-19 实测成功：sectionsBefore/After 13、merged 1，卡片内容即时含新规则）。</note>
    </step>

    <step order="8" name="衰减降权">
      <description>陈旧且未被召回的低重要性记忆降权（不删除，pinned 豁免）</description>
      <action>mcp__leafmem__memory_organize(action="decay", scopeType="agent", scopeId="workbuddy", dryRun=false) —— 纯规则，不需要 LLM</action>
    </step>

    <step order="9" name="镜像同步">
      <description>导出全量记忆到本地镜像，供 MCP 降级兜底</description>
      <action>node <LeafMem 安装目录>/ops/mirror-sync.js（默认写 ~/.leafmem/mirror，可 --mirror-dir 覆盖）</action>
    </step>

    <step order="10" name="周度观察（只读，2026-09-03 并入）">
      <description>确定性采集治理指标 + 周环比趋势判断，本步骤不修改任何记忆</description>
      <action>python3 &lt;LeafMem 安装目录&gt;/ops/observation.py --mode weekly（零 LLM 依赖；自动追加到 ~/.leafmem/observation/leafmem-observation-log.jsonl；scope 自动探测主 scope，可环境变量 LEAFMEM_SCOPE 覆盖）</action>
      <judge>取最近 2 条 weekly 记录做周环比五项判断（引用脚本输出数字，不心算——NO COMPUTATION）：
        a. 反馈回路：recall_total 周环比上升（用进废退生效）
        b. 反思蒸馏：principle_count 增长；last_reflect_at 每周刷新（超 10 天未刷新 → 检查步骤 6 蒸馏是否执行）
        c. 画像：profile_present 且 profile_updated_at 在近 14 天内
        d. 数据一致性：fts_stale==0 且 fts_rows==memory_rows；principle_supports_missing==0
        e. 治理时机：decay_candidates>0 → 建议执行/确认步骤 8 已覆盖
        f. 实体词表活性：entity_count 周环比——记忆在增长但实体连续 2 周零增长 → 词表陈旧信号，转步骤 11 巡检
      </judge>
      <branch>
        <if>脚本输出 ALERT（FTS 回归/行数不一致/证据链断裂）</if>
        <then>标记为需行动，在报告中最优先呈现，必要时提前单独告警</then>
      </branch>
      <note>结论格式：正常 / 需关注 / 需行动 + 一句话依据；追加记录到宿主当日记忆日志（含日期，追加不覆盖）</note>
    </step>

    <step order="11" name="实体词表巡检（2026-09-03 新增）">
      <description>防止实体词表陈旧导致新领域无法实体化（strict 抽取器只认控制词表+内置词典+@提及）</description>
      <trigger>步骤 10.f 发现 entity_count 连续 2 周零增长而记忆在增长；或每月例行一次</trigger>
      <action>扫描近 30 天记忆中高频出现的专名（新项目/新工具/新产品名），与 ~/.leafmem/entity-vocab.json 比对</action>
      <action>把确有所指的新词追加进词表（kind: project/tool/person/org），备份原文件后再写；词表对新写入即时生效</action>
      <action>存量记忆补链：node &lt;LeafMem 安装目录&gt;/ops/entity-relink.mjs --dry 预估后再正式跑（纯增量幂等三接口，只加不删；跑前备份 memory.sqlite）</action>
      <note>🔴 只加确有所指的专名，不加通用词； MCP stdio 进程的词表在进程启动时加载，宿主重启后生效，launchd 后台服务可 launchctl kickstart -k 即时生效</note>
    </step>

    <step order="12" name="报告与留痕">
      <description>每周固定推送周报（含观察结论）；无整理动作且观察全绿时可简化为仅日志</description>
      <branch>
        <if>有删除/整合/蒸馏动作，或周度观察出现需关注/需行动项</if>
        <then>通过宿主可用的消息渠道发送周报：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数 + 本周观察结论与关键环比（memories/principle/recall/profile/一致性）</then>
        <else>仅写宿主当日记忆日志，不推送</else>
      </branch>
      <note>推送渠道由宿主环境决定；无配置渠道时退化为仅日志，不报错</note>
    </step>
  </workflow>

  <constraints>
    <never>
      <item>NEVER 直写 ~/.leafmem/memory.sqlite — 因为 sqlite 直写会写坏 id/created_at 导致前端不可见；替代做法是全部走 MCP memory_write/memory_govern</item>
      <item>NEVER 删除前不存档 — 因为误删无回滚锚点；替代做法是步骤 3 强制全量导出</item>
      <item>NEVER 用前缀聚类判重复 — 因为同头部不同内容会误删；替代做法是全文规范化 SHA256</item>
      <item>NEVER 删 preference/含路径/触发词类记忆的核心内容 — 因为这三类是用户画像与检索入口的基石（三不碰）</item>
      <item>NEVER 让 LLM 做算术或推导 — 因为蒸馏只忠实转录，数字合并会产生幻觉（NO COMPUTATION 铁律）</item>
      <item>NEVER 在有疑虑时删除 — 因为宁可保守不可误删；替代做法是保留并在报告中标注待人工复核</item>
    </never>
    <must>
      <item>MUST 先 recall 历史维护教训再动手</item>
      <item>MUST 删除走 MCP 且写入成功后才删原条</item>
      <item>MUST 整合产物用标准模板：# 一句话结论 + 场景/内容/动作/来源</item>
      <item>MUST scope 铁律：默认 agent:workbuddy，write 不传 scopeType/scopeId</item>
    </must>
    <should>
      <item>SHOULD 整合遵守九规则：UPDATE 优先于 CREATE、一条一侧面、按实体匹配、状态变更带日期、CASCADE 级联、解析模糊指代、PRESERVE HISTORY、NO COMPUTATION、异题分离</item>
    </should>
  </constraints>

  <examples>
    <good>
      <example name="碎片簇整合（正确）">
        <scenario>同一天 3 条「LeafMem 召回慢」碎片，内容互补</scenario>
        <execution>先存档 → 读 3 条全文 → 整合为 1 条 lesson（结论：召回慢因 FTS 未命中触发全量扫描；动作：开 rerank 并限 limit）→ write 成功 → 逐条 delete → recall 验证命中</execution>
        <why>符合先存档、写后删、可验证的闭环，且一条只跟踪一个侧面</why>
      </example>
    </good>
    <bad>
      <example name="前缀聚类误删（错误）">
        <scenario>两条记忆都以「# 教训：WeKnora 操作」开头，但内容一个是上传、一个是删除</scenario>
        <execution>按前缀 60 字聚类判为重复，删了删除那条</execution>
        <result>❌ 丢了不可恢复的操作教训</result>
        <why>前缀聚类把同头部不同内容当重复；必须用全文规范化哈希</why>
      </example>
    </bad>
  </examples>

  <error_handling>
    <failure_criteria>
      <criterion>MCP 连续不可用（recall/write 均失败）</criterion>
      <criterion>存档文件行数与库内条数不一致</criterion>
      <criterion>整合验证 recall score &lt; 0.6</criterion>
    </failure_criteria>
    <fallback_strategy>
      <strategy name="MCP 不可用">
        <step>1</step>
        <action>等待 60 秒重试一次</action>
        <step>2</step>
        <action>仍失败则只执行只读步骤（健康检查/检测报告），删除/整合全部跳过并在报告标注</action>
      </strategy>
      <strategy name="存档不一致">
        <step>1</step>
        <action>重新导出一次</action>
        <step>2</step>
        <action>仍不一致则中止全部删除类步骤，只留健康检查报告</action>
      </strategy>
      <strategy name="超时（&gt;10 分钟）">
        <step>1</step>
        <action>把剩余碎片簇截断到前 10 簇，其余留到下周</action>
      </strategy>
    </fallback_strategy>
  </error_handling>

  <output_format>
    <primary>
      <type>message</type>
      <path>飞书小虾群（有动作时）+ ~/.workbuddy/memory/ 当日日志（总是）</path>
      <format>规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数</format>
    </primary>
  </output_format>

  <checkpoints>
    <enabled>true</enabled>
    <note>步骤 3 存档为强制检查点（🔴 STOP）；中断恢复时从最近完成的步骤续跑，删除类步骤前重新确认存档新鲜</note>
  </checkpoints>

  <references>
    <file path="<LeafMem 安装目录>/ops/mirror-sync.js">镜像同步脚本（安装目录=`npm root -g`/@xdragonjia/leafmem）</file>
    <file path="<LeafMem 安装目录>/ops/observation.py">周度观察采集脚本（零 LLM 依赖，约 20 项治理指标 + ALERT/WARN/INFO 判定；--mode weekly；日志 ~/.leafmem/observation/leafmem-observation-log.jsonl）</file>
    <file path="<LeafMem 安装目录>/ops/consolidation.js">⚠️ 历史脚本（硬依赖已移除的 DEEPSEEK_API_KEY，不可运行；仅作存档参考，去重职责已由本技能步骤 3 承担）</file>
  </references>

  <notes>
    <note id="2026-09-07">v1.4.1：步骤 6 新增 🔴 must——principle 的 metadata.supports 必须存完整 36 位 UUID（禁止短 id）。2026-09-07 周度维护实测：3 条新 principle 的 supports 误用 8 位短 id，observation.py 报 ALERT「12 个 supports 指向不存在记忆」（supports_missing=12）；CLI update 全量回填完整 UUID 后复验 supports_missing=0。同时记录 PATCH metadata 为替换语义（需连 reflectedAt/reflectTag/lastRefreshedAt/projectId 一并回填）。</note>
    <note id="2026-09-03-v14">v1.4.0：新增步骤 11 实体词表巡检——实测发现 strict 抽取器下实体增长完全依赖词表人工更新（leafmem 本身在 145 条记忆中出现却因不在词表而无实体）；判断清单加 f 项（entity_count 停滞检测），巡检含词表更新与存量增量补链方法（幂等三接口，只加不删，--dry 先行）。</note>
    <note id="2026-09-03">v1.3.0：并入原「周度观察+飞书提醒」开发期任务的持久机制——新增步骤 10 周度观察（observation.py --mode weekly 确定性采集 + 周环比五项判断），报告步骤升为周报口径（有动作/有观察异常才推送）；observation.py 同期通用化（scope 自动探测、随 npm 包分发）。排除场景措辞同步（每日观测采集→每日健康哨兵）。</note>
    <note id="2026-08-24">蒸馏节流补充（实测）：候选主题按 tags 聚类 ≥3 条 lesson 后，还必须与已有 principle 的 tags/content 比对覆盖——即使 principle 的 reflectTag 为空，只要其内容已覆盖候选主题（如 52567dbb 已覆盖飞书卡片 schema 2.0 note/ud_icon 坑，导致 ai-news-pusher 主题跳过），就不重复蒸馏；08-24 从 4 个候选主题（auto_collect/external-skill-updater/ai-news-pusher/公众号）蒸馏 2 条。</note>
    <note id="2026-08-10-v12">v1.2.0：明确 consolidation.js 已被本技能替代（其硬依赖的 DEEPSEEK_API_KEY 已移除，脚本不可运行）；supports 断链清理由 forget() 内置级联覆盖，无需脚本兜底。</note>
    <note id="2026-08-10">v1.0.0 首版：Phase 9 收编每周健康检查的整理职责；宿主模型蒸馏免付费 key；每周节奏。</note>
    <note id="2026-08-10b">v1.1.0：按 skill-creator 标准重构为 XML v2.0（author/三段式 description/10 标准模块/checkpoints/never-因为-替代格式）。</note>
  </notes>
</skill>
