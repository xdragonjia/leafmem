---
name: leafmem-maintenance
version: "1.1.0"
agent_created: true
author: xiaoxia
description: >
  LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。
  覆盖健康检查、强制存档、真重复合并、碎片整合、原则蒸馏、画像刷新、衰减降权、镜像同步。
  触发词：leafmem 维护、记忆整理、每周健康检查、深度整理、记忆治理、consolidation。
  排除场景：不做 WeKnora 知识库维护、不替代每日只读观测告警任务、不处理宿主安装配置。
---

<?xml version="1.0" encoding="UTF-8"?>
<skill>
  <metadata>
    <name>leafmem-maintenance</name>
    <version>1.1.0</version>
    <agent_created>true</agent_created>
    <author>xiaoxia</author>
    <date>2026-08-10</date>
    <description>LeafMem 记忆引擎的周期性维护与深度整理 SOP（宿主模型驱动，免付费 inferencer）。触发词：leafmem 维护、记忆整理、每周健康检查、深度整理、记忆治理。排除：WeKnora 维护、每日告警、宿主安装。</description>
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
      <keyword>consolidation</keyword>
    </keywords>
    <intent>对 LeafMem 记忆库执行周期性质量维护（由每周自动化任务调用，或手动触发）</intent>
    <exclusions>
      <exclusion>WeKnora 知识库的维护（用 weknora-rag）</exclusion>
      <exclusion>每日只读观测告警（由「每日观测采集」自动化负责）</exclusion>
      <exclusion>宿主安装/配置（用安装器或 INSTALL-KUNLUNXIAOZHI.md）</exclusion>
    </exclusions>
  </triggers>

  <identity_note>
    与 ops/consolidation.js 的分工：consolidation.js 做大批量机械去重（需独立 inferencer key，可选）；
    本技能做语义级精修（整合/蒸馏/画像），LLM 工作由宿主模型通过 MCP 完成，免费。
  </identity_note>

  <workflow>
    <step order="1" name="召回历史教训">
      <description>执行任何维护动作前，先召回历史维护教训，避免重蹈覆辙</description>
      <action>mcp__leafmem__memory_recall(action="recall", message="leafmem 维护 整理 误删 教训")</action>
      <branch>
        <if>MCP 不可用</if>
        <then>降级 conversation_search 召回；召回失败仍不阻塞，但删除动作必须更保守</then>
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
      <action>memory_write(action="remember", kind="principle", importance=0.85, tags=[主题,principle,reflected])</action>
      <throttle>同主题 6 天内已蒸馏（查已有 principle 的 reflectedAt）则跳过</throttle>
    </step>

    <step order="7" name="画像刷新（profile 宿主版）">
      <description>基于 preference delta 更新用户画像，替代付费 inferencer 的 profile</description>
      <action>memory_recall(action="search", kind="preference") 拉全部 preference；memory_recall(action="active_get", kind="profile") 读当前画像</action>
      <action>宿主模型比对差异，**只输出需要更新的分节**（"## 分节标题\n新内容" markdown）；memory_write(action="active_distill", kind="profile", content=更新分节)</action>
      <note>🔴 分节合并语义：引擎按分节标题合并——同名分节被替换、新分节追加、**未提到的分节原样保留**。宿主永远不要输出全文覆写，避免误删其他分节。</note>
    </step>

    <step order="8" name="衰减降权">
      <description>陈旧且未被召回的低重要性记忆降权（不删除，pinned 豁免）</description>
      <action>mcp__leafmem__memory_organize(action="decay", scopeType="agent", scopeId="workbuddy", dryRun=false) —— 纯规则，不需要 LLM</action>
    </step>

    <step order="9" name="镜像同步">
      <description>导出全量记忆到本地镜像，供 MCP 降级兜底</description>
      <action>node <LeafMem 安装目录>/ops/mirror-sync.js（默认写 ~/.leafmem/mirror，可 --mirror-dir 覆盖）</action>
    </step>

    <step order="10" name="报告与留痕">
      <description>有动作才推送，无动作静默</description>
      <branch>
        <if>有删除/整合/蒸馏动作</if>
        <then>通过宿主可用的消息渠道（如飞书/企业微信/仅日志）发送：规模变化/真重复删除数/碎片整合数/新 principle 数/画像 section 数/decay 降权数</then>
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
    <file path="~/projects/leafmem/ops/mirror-sync.js">镜像同步脚本</file>
    <file path="~/projects/leafmem/ops/consolidation.js">机械去重脚本（互补，需独立 key，可选）</file>
  </references>

  <notes>
    <note id="2026-08-10">v1.0.0 首版：Phase 9 收编每周健康检查的整理职责；宿主模型蒸馏免付费 key；每周节奏。</note>
    <note id="2026-08-10b">v1.1.0：按 skill-creator 标准重构为 XML v2.0（author/三段式 description/10 标准模块/checkpoints/never-因为-替代格式）。</note>
  </notes>
</skill>
