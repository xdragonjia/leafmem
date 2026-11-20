# 模式三件套（2026-11-19 步骤 4d 外置，判据展开与示例）

## 为什么需要（小龙「该去完善记忆系统」）
本机实证：8,001 条记忆 principle 仅 147（1.8%）；fail_tracker 08-28 建成时未命名「QA 闭环」、未标「凡采集→质量闸管道必配」触发情境 ⇒ 11-19 得到渠道漏复用。**命名模式＋触发情境＝新情境激活锚**；缺之即检索不到，经验闲置。

## 三件套判据（principle/lesson 通用）
| 件 | 字段 | 合格形态 | 不合格形态 |
|---|---|---|---|
| 命名模式 | `metadata.pattern`（亦体现在 summary 首句「<模式名>：…」） | 「QA 闭环」「负例注入」「判据形态」「纸面脱节」「先结构唤起」——可迁移短语 | 「11-19 索引修复」「fail_tracker.py 机制」——实例/实现名，不可联想 |
| 触发情境 | `metadata.trigger_context` | 功能结构关键词：「采集→质量闸→落盘」「判据→执行→验收」「新建机制性产物」——下次遇到这类任务该想起 | 「得到渠道」「02:30 任务」——具体渠道/任务名，新情境不命中 |
| 适用边界 | `metadata.applicability` | 「适用于确定性判据管道；不适用于纯创作任务」「样本<3 时禁下规律」 | 空／「很重要」 |

## 补写动作
- 能反推：从 content 读规律 → 用 `memory_govern(update)` 只补 metadata 三件（**不动 content/summary/tags**，防破坏既有召回）；
- 推不出：列入「待提炼」交日终复盘 Step 3「成功提炼四步」处理（那边负责**生产**模式，这边负责**验收与登记**）。
- 完备率＝三件套齐备的 principle/总 principle；`total=0` 标 N/A 禁写 100%（分母守卫）。

## 与既有决策的关系
- 兼容 10-22「不做独立 L2 信念层」：本步是 M1 条目级最小有效形态（挂字段），非新建层；与 `supports`/`reflectTag` 并存。
- 晋升通道：带 `pattern` 的 principle 晋升知识层时携带触发情境（消费侧支持登记，非本轮）。


---

### 步骤 4d：🔴 模式三件套巡检（2026-11-19 小龙「该去完善记忆系统」后新增）

**判据**：principle/lesson 须备**命名模式**（可迁移短语非实例描述）＋ `metadata.trigger_context`（功能结构关键词＝检索锚）＋ `metadata.applicability`（适用边界）；缺任一项＝不可联想。
**动作（已实跑化 2026-11-19）**：`python3 scripts/pattern_compliance.py --out runs/pattern_compliance_<date>.json`（判据命令，自检 5/5）。能反推的 govern(update) 补 metadata、推不出的列「待提炼」交日终复盘，禁留裸 principle。补 metadata 直接写要改的键即可——**引擎 ≥0.3.27（2026-11-20）update 默认浅合并**，键值 null=删键，整包替换须显式 `metadataMode:"replace"`（维护场景禁用）。历史事故存档：11-19 两次裸写冲掉 eventTime/recallCount＋35 条 supports（备份恢复），当时防线「先 get 合并」靠自觉两次失守，已下沉引擎层根治；旧引擎（<0.3.27）仍须先 get 合并。基线 2026-11-19 完备率 **0.1%**（缺命名 1226/情境 1694/边界 1527）。存量按重要性分批（importance≥0.85 且近 90 天优先＝112 条 principle 主战场，复盘每轮 ≤10 条），lesson 多为过程记录不强求。首批已做（2026-11-19）：全库 principle 149 条三件套覆盖＋聚类新提炼 2 条（判据形态族/表面复验族），recall 实证命中。📖 判据展开与示例→`references/pattern-triad.md`。

