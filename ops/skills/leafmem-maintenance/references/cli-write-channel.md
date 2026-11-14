# LeafMem 写入通道与 task_append 细则（步骤 1 的执行手册）

> 🔴 **何时读**：需要用 `leafmem-cli` 写入记忆、登记/关闭任务上下文，或 recall/MCP 异常时读本文件。
> **不读的后果**：可能用 `remember` 覆盖既有条目（破坏性），或用错 task 子命令导致任务状态没落库。
> 只做「健康检查 + 只读观测」时不必读。

## 目录
- [1. 主通道与子命令](#1-主通道与子命令)
- [2. task_append：HTTP 面没有的路由](#2-task_appendhttp-面没有的路由)
- [3. 🔴 禁止用 --help 试探子命令](#3-️-禁止用---help-试探子命令)
- [4. CLI-first 降级链（MCP 不可用时）](#4-cli-first-降级链mcp-不可用时)
- [5. recall 返回结构契约（P0）](#5-recall-返回结构契约p0)
- [6. remember 覆盖事故全记录（P0）](#6-remember-覆盖事故全记录p0)

## 1. 主通道与子命令

- **主通道**：`bash ~/.leafmem/leafmem-cli.sh`（HTTP 通道，launchd 守护）
- **子命令**：`remember` / `update` / `delete` / `get` / `list` / `stats` / `scopes` / task-detail / `task-append`
- **缺口关闭说明（2026-09-15 补齐）**：以上即补齐后的完整写入通道。

## 2. task_append：HTTP 面没有的路由

🔴 HTTP 服务**无 task_append 路由** —— 任务登记与关闭必须用子命令：

```bash
bash ~/.leafmem/leafmem-cli.sh task-append <taskId> <content> [rollingSummary] [status] [title] [role]
```

- 底层由 `~/.leafmem/leafmem-mcp-write.mjs` 按 `mcp.json` 的 leafmem 服务配置**原样拉起 MCP 做 stdio 握手**（不复制密钥）。
- **创建即关闭时须同传 rollingSummary**，且写成**闭环版表述**（清除「待办」类措辞；尾项未回写的如实标注「按主流程完成闭环归档」）。
- `task-detail` 已修 URL 编码，**含中文/冒号的 taskId 方可正常回读**。

## 3. 🔴 禁止用 --help 试探子命令

🔴 **本 CLI 无参数自省能力**：`remember --help` 会把 `--help` 当【内容】**真实写库**。

- **实证（2026-09-25）**：误建一条 `content="--help"` 的 note，已 delete。
- **正确做法**：查用法**读脚本 1–50 行注释**。
- 该误写入路径已于 2026-09-25 就地加固：`remember` 的 CONTENT 呈标志形态即拦截 `exit 2`（含空格的短横开头如 Markdown 项目符号不拦），回归四例 + 正向对照已过。

## 4. CLI-first 降级链（MCP 不可用时）

1. 首选 `bash ~/.leafmem/leafmem-cli.sh recall "..."`（HTTP 通道，launchd 守护）。
2. **自动化会话 `mcp__leafmem__*` 恒 absent 属预期**，不是故障信号。
3. CLI 也不可达 → 查 `launchctl list | grep leafmem`。
4. 最后降级 `conversation_search`。
5. **召回失败仍不阻塞后续动作，但删除类动作必须更保守。**

## 5. recall 返回结构契约（P0）

🔴 **两次踩坑，必须照抄**：返回顶层 keys =
`query / hits / injectedContext / dynamicContext / navigationContext / evidence / layers / stableContext`。

- **记忆条目在 `hits[].record`**（`record` 内含 `id/kind/content/summary/tags/scope/createdAt/importance/confidence`）。
- ❌ **禁用口径**：`d.get('memories') or d.get('results') or d.get('items')` —— 这三个键**都不存在**，会静默落空并打印「命中 0」。
- 🔴 **后果等级 = 破坏性**：2026-09-24 实证，因误读为「无同主题记忆」而执行 `remember`，服务端按同构语义 **UPDATE 覆盖了既有 principle `9c2cd747` 的 4,499 字符六代谱系**（连带覆盖 summary/tags/kind/importance）。**「查过了」不等于「查对了」——读通道口径错会直接驱动一次破坏性写入。**
- ✅ **自检动作**：解析 recall 结果时**先打印 `list(d.keys())` 并断言含 `hits`**；命中数为 0 时按「空结果三查」判定（见 weknora-rag v3.7.2）——**stderr 是否为空 / 判据能否命中已知正例 / key 口径是否与数据一致**，三查未过**不得**判为「无相关记忆」。

## 6. remember 覆盖事故全记录（P0）

🔴 `remember` 是**「写入即可能覆盖」的非幂等操作**，危险性与 `rm` / SQL `UPDATE` 同级（2026-09-07 首次实证，09-24 第二次重犯且覆盖范围更广）。

- ① **触发条件**：服务端对**同 kind + 同 tags + 同模板**的高相似内容执行「更新最相似既有条目」语义 —— **逐日/周期性观测类记录（模板高度同构）是高危场景**；**与「我认为主题不同」的主观判断无关**。
- ② **覆盖范围（09-24 实证升级）**：不只 `content`，**`summary` / `tags` / `kind` / `importance` / `confidence` 全部被本次调用的入参覆盖**（tags 为并集，但其余为替换）⇒ 既有条目若原本元数据更精确（如 kind=principle、importance 0.9），会**静默降级**为本次参数值。
- ③ **硬上限**：单条 `content` **6000 字符**，超限报 `memory content too long: N chars (max 6000)`；长谱系条目接近上限时应**拆分为原子条目 + 互相引用 id**，不要继续追加。
- ④ **第三次重犯与 core 层机械化（2026-11-14，lesson `77f0f740`）**：raw 自动化任务每晚同模板摘要 `remember`，连续多晚静默覆盖 11-06（`f8ac5aec`）～11-09 的条目未被发现；直到 11-14 写后 `get` 见 `createdAt` 早于今日才暴露。**元教训一：纪律写在文档/SOUL/prompt 里 ≠ 会被执行**——文档纪律存在已久仍连犯三次。**元教训二：防线加在哪一层，决定了它覆盖几条通道**——最初只在 CLI 壳层（`~/.leafmem/leafmem-cli.sh`）加 `createdAt` 判据，但 **MCP `memory_write` 不经过 CLI**（直连 `dist/bin/leafmem-mcp.js`），CLI 层判据对 MCP 通道完全失效。
  **根治＝下沉到最内层 `src/core/memory.ts` 的 `remember()`**：MCP / HTTP（CLI）/ batch / 摄入脚本**四条写入通道都汇聚到 core remember()**（同 §B2 enrichment 的放置原则，见 memory.ts 内注释）。在四个合并分支（evaluator 的 ignore/update/contradict ＋ legacy threshold-dedupe）写回前统一调 `markMergedOver()`：给被合并记录打 `metadata.mergedOver`（`at`/`mode`/`incomingKind`/`incomingSource`）并向 stderr 打 `OVERWRITE WARNING`。`mergedOver` 随响应返回，**任何客户端（含 MCP）都能机械判定「新建 vs 合并」**；且它能捕获「同一天内覆盖今日新建条目」这种 `createdAt` 启发式的盲区。
- ⑤ **分层防线（三层，缺一不可）**：**L0（权威）core 层 `metadata.mergedOver` + stderr 警告**——最内层、四通道全覆盖、确定性判据，是真正的防线；**L1 CLI 就近提示**——壳层解析响应，优先读 L0 的 `mergedOver`、回退 `createdAt` 早于今日，命中即向 stderr 打 `LEAFMEM_OVERWRITE_WARNING`（客户端就近可见，不改 stdout/退出码）；**L2 自动化 prompt 侧**「摘要必须输出 `[leafmem] id=<前8位> createdAt=<日期>` 行」＝产物侧可 grep 的汇报判据（M10，缺行＝漏核，raw 任务 prompt ①b 已固化）；**L3 本技能四条写入纪律（a-d）**。恢复流程：先从 `~/.workbuddy/memory/<被覆盖日期>.md` 重建原文 `update` 回填（`createdAt` 不变、不重生），再把新内容差异化措辞＋唯一日期 tags 另立新条目。

> 四条机械纪律（🔴 MUST）见 SKILL.md 步骤 1 正文，此处不重复。