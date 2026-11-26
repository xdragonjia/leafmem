# 步骤 10b dreaming 记忆校验 — 执行细则（B98-R1，2026-11-26）

> 正文只留触发与汇报行；本文件承载裁决细则与实证。来源＝Personal Agent 调研 R1（Anthropic 11-6「components of agent memory」：错记忆可致长任务全败，Dreaming 对照原始 transcript 校验纠错；OpenClaw REM Backfill 同族）。

## 为什么

记忆漂移＝错误决策的放大器（09-20 privacy 事故实证「记忆是隐蔽污染源」）。高重要性记忆（principle/lesson，importance≥0.9）大量指向文件路径/脚本/口径，这些持续演进而记忆不动——不等召回时靠人发现，每周主动核对。

## 执行序列

1. `python3 scripts/dreaming_check.py --sample 20`（只读；确定性抽样 seed=ISO周号，同周复跑同批可复核，跨周轮换覆盖全库；人群守卫 <50 exit 2 禁报绿）。
2. 读 `runs/dreaming_check_<date>.json` 的 `drift_candidates`（正文引用的本机路径已不存在）。
3. 🔴 **裁决（宿主语义判断，脚本永不直接改记忆）**：missing path ≠ 记忆错误——文件可能合法改名/归档。逐条对照证据源（现行技能/文件现状/DB）：
   - 确认漂移 → `memory_govern(update)` 顶部加订正块（「🔴 YYYY-MM-DD dreaming 校验订正：旧 X 已失效，现行＝Y，以 Z 为准」），旧内容保留作历史标失效，**禁删**（三不碰：preference/含路径/触发词类核心内容）。
   - 确认合法迁移 → 同样补订正指向新位置。
   - 无法裁定 → 报告标注待人工复核，保留。
4. 订正后复跑脚本确认该条不再报候选（或候选路径已指向现行位置）。

## 汇报行（无条件，M10）

当日日志/周报含「dreaming校验：已执行（抽N条/候选M条/订正K条）」；exit 2 写「dreaming校验：未执行＋守卫失败原因」。缺行＝漏跑。

## 边界

- 本步骤只核对**路径存在性**这一类确定性漂移；语义级漂移（口径/数字/结论过时）由步骤 6 蒸馏与 recall 时「时态判据」覆盖，不在此扩权。
- compute 成本控制：按 Anthropic 建议聚焦易变信息（指向路径/版本的记忆），每周 20 条，不全量核对。

## 实证（2026-11-26 首跑）

- 人群 1,636（lesson/principle/decision，importance≥0.85），抽 20，with_paths=2，候选 1。
- 真实命中：id=edb2f9ce（lark-cli 多 Bot 隔离，5-18 旧 npm 路径）——node 22.12.0→22.22.2-6、npm 版→Go 二进制 `/Users/dragon/bin/lark-cli`、mavis 目录已不存在；govern update 顶部订正＋旧文保留，metadata（recallCount 等）零漂移。
- 脚本首版两缺陷均被 --self-test 抓出当轮修：①`~/` 形态被「反引号紧贴+字符类排除反引号」静默吞掉→只认 /Users/ 绝对形态；②macOS tempfile 落 /var/folders 不匹配前缀致空提取假 FAIL→负例目录自建 HOME 下用后即清。自测 4/4。

## 判据修复记录（2026-11-26 复验轮，小龙指令「再完成测试一遍」抓出）

首版判据在全量复验（--sample 1636）下暴露三类缺陷，均当轮修＋负例入自测（4/4→8/8）：
1. **已裁决记忆重复报候选**：订正后正文有意保留失效旧路径（禁删纪律）→ 再报＝每周重复报已裁决项。修法＝含「dreaming 校验订正」块的记忆只核订正块中「现行＝/已换为/迁移至」等指向短语后的路径；订正块自身断链仍报（豁免不过宽，负例守住）。
2. **占位/模板路径误报**：{id}/YYYYMMDD/.../xxx/（ 等形态不是真实引用 → 过滤（负例：真实缺失仍须报）。
3. **中文顿号并列被整串当路径**：「/Users/、~/、references/」→ 截到首个顿号/全角逗号，截后 <3 段或含 */< 跳过。

🔴 方法论教训：**抽样首跑绿 ≠ 判据正确**——首跑抽 20 恰好没抽到已裁决条目与占位形态，全量复验才暴露。「必中旧数据」验证（edb2f9ce 订正后须不再报）是抓出缺陷①的直接手段。

## 全量裁决实证（2026-11-26）

全量 1,636 条 → 判据修复后真实候选 11 条 → 逐条证据源核实（只读 ls/plist/技能正文）→ 三类裁决：
- **迁移**（5条）：wrapper→projects/leafmem/ops/launchd/、备份脚本→ops/sqlite-backup.sh、compose→/Users/dragon/weknora/、baoyu备份→backups/00system/、node→22.22.2-6
- **退役/并入**（2条）：mmx-cli→image-gen、persona skills→wise-cabinet 实体文件＋backups/03knowledge 归档
- **预期生命周期终点**（4条）：tmp 一次性脚本/测试产物/污染目录治理清除——缺失＝治理完成态非漂移
全部 govern update 顶部订正＋原文保留，写后核 updatedAt 11/11 当日；复跑全量候选 11→0（已裁决 12 条全部不再报）。
