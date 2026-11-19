---

# 步骤 2b 残留任务闭环清扫（2026-10-02 新增，外置 2026-11-19）
## 步骤 2b：残留任务闭环清扫（2026-10-02 新增）

检出并闭环滞留在非 completed 状态的任务上下文——闭环依赖会话收尾显式 task_append(status=completed)，会话中断/超时/收尾被跳过会让任务永久滞留 active

- **检测**：python3 scripts/stale_task_sweep.py（只读；exit 2 = 有超龄未闭环或非法状态值；默认阈值 24h，--hours 可调）
- **规则**：🔴 闭环判据（逐条人工/宿主判定，禁止无脑批量关）：末条 entry 表明主流程已完成 且 超阈值无更新 → 用 `leafmem-cli task-append <taskId> <闭环说明> <闭环版 rollingSummary> completed` 补标；rollingSummary 必须写成闭环版表述（清除「待办/待回写」类措辞，尾项未回写的如实标注「按主流程完成闭环归档」）
- **规则**：🔴 主流程证据不足的任务不得强关——列入报告标注待复核，宁可滞留不可误判完成
- **规则**：🔴 状态合法枚举仅 active/paused/completed/archived（0.3.22+ handler 已运行时校验，非法值直接报错 -32602）；脚本检出非法值（如历史遗留 "done"）→ 按闭环判据修正为 completed 或归档

**备注**：根因修复（2026-10-02，leafmem commit aba363b）：handler.ts 的 status 原为裸类型断言无运行时校验，"done" 被原样写库；已加枚举校验 + 回归测试（8/8）。残留 active 属流程性问题（收尾步骤被跳过），本步骤是其常态化兜底

