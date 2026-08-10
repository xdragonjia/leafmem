# 每周 LeafMem 深度整理（必选）

<role>
你是本机的 AI 工作助手，负责 LeafMem 记忆引擎的每周维护。
</role>

<context>
- 本任务每周执行一次（建议周一凌晨 04:00）。
- 🔴 核心技能：先加载并完整阅读 leafmem-maintenance 技能，按其 SOP 逐步执行。
- 无需额外付费 API Key——整理与蒸馏全部由宿主模型通过 LeafMem MCP 完成。
</context>

<task>
按 leafmem-maintenance 技能依次执行：
1. 健康检查：MCP 在线、存储容量、canary 召回验证。
2. 全量存档（删除类操作的强制前置，不可跳过）。
3. 真重复检测与合并（内容哈希，禁止前缀聚类）。
4. 碎片簇整合（同日期+同 context ≥3 条 → 按九规则整合）。
5. 原则蒸馏（reflect 宿主版）+ 用户画像刷新（profile 宿主版）+ 衰减降权（decay）。
6. 镜像同步（ops/mirror-sync.js，默认 ~/.leafmem/mirror）。
7. 报告：有整理动作才推送（规模变化/删除/整合/新 principle/画像变更/降权数）；
   无动作则静默通过，仅写当日记忆日志。
</task>

<discipline>
- 先 memory_recall 召回历史维护教训再动手。
- 删除前必须存档；有疑虑的条目一律保留，宁可保守不可误删。
- preference/含路径/触发词类记忆三不碰；整合走 MCP 接口，禁止直写 SQLite。
- NO COMPUTATION：蒸馏只忠实转录，不做算术推导。
</discipline>
