# MCP 通道手册（自动化会话专用）

> 🔴 **何时读**：在自动化会话里（`mcp__leafmem__*` 恒 absent）需要执行 HTTP 面未暴露的动作时读本文件 —— 即**步骤 7 画像刷新**（`active_distill`）与**步骤 8 衰减降权**（`decay`）。
> 交互式会话有常驻 MCP 时不需要本文件，直接调 `mcp__leafmem__*` 即可。

## 目录
- [1. 通道调用器](#1-通道调用器)
- [2. 步骤 7 画像刷新（active_distill）](#2-步骤-7-画像刷新active_distill)
- [3. 步骤 8 衰减降权（decay）](#3-步骤-8-衰减降权decay)
- [4. HTTP 复验与鉴权](#4-http-复验与鉴权)
- [5. 🔴 scope 参数形态（静默返回空快照）](#5-️-scope-参数形态静默返回空快照)

## 1. 通道调用器

```bash
python3 scripts/leafmem_mcp_call.py <tool> '<args JSON>'
```

- 按 `~/.workbuddy/mcp.json` 的 leafmem 条目启动**临时 stdio 进程**，`initialize` 后发 `tools/call`。
- 与常驻服务**共享同一 sqlite**，无需复制密钥。
- **未暴露动作清单**：`active_distill`（画像写入）、`organize` 的 `decay` / `profile`。

## 2. 步骤 7 画像刷新（active_distill）

- 🔴 **通道事实（2026-09-14 实测打通）**：`active_distill` 仅实现在 src/mcp/handler.ts，HTTP 面（routes-memory / routes-console 两个路由）**不暴露**。
- **自动化会话调用**：

  ```bash
  python3 scripts/leafmem_mcp_call.py memory_write '{"action":"active_distill","kind":"profile","content":"..."}'
  ```

- **实测收益（2026-09-14）**：18 → 21 分节、merged=3、`updatedAt` 刷新为当日。
- 🔴 **分节合并语义**：引擎按分节标题合并 —— 同名分节被替换、新分节追加、**未提到的分节原样保留**。宿主**永远不要输出全文覆写**，避免误删其他分节。
- 🔴 **节奏**：周度观察的 `[WARN]`「画像超过 14 天未刷新」即本步骤的触发信号（2026-09-14 实测命中：08-30 最后一次刷新，09-14 已 15 天）。**周维护时先跑 observation（步骤 10），再据此决定是否刷新画像。**

### 2b. console 洞察页「用户画像」卡片 ≠ 改 preference 会自动刷新

- 卡片 = profile 快照（`active_distill kind=profile` 的产物）。
- 🔴 **`memory_govern update` 修改 preference 记录不会自动反映到画像卡片**。
- `mcp__leafmem__memory_organize(action=profile)` 需付费 inferencer（本机返回 `no_inferencer`）。
- **用户反馈「画像没更新」时**走宿主版 `active_distill`（2026-08-19 实测成功：sectionsBefore/After 13、merged 1，卡片内容即时含新规则）。

## 3. 步骤 8 衰减降权（decay）

```bash
python3 scripts/leafmem_mcp_call.py memory_organize '{"action":"decay","dryRun":true}'   # 先预演
python3 scripts/leafmem_mcp_call.py memory_organize '{"action":"decay","dryRun":false}'  # 正式
```

- 纯规则，**不需要 LLM**。
- 返回 `{scanned, decayed[]}`，**`scanned` 应等于库内总条数**。
- **交叉印证（2026-09-14 实测）**：`scanned=1601` / `decayed=0`，与 observation 的 `decay_candidates=0` 互相印证。

## 4. HTTP 复验与鉴权

- **端点**：`GET /v1/governance?scope=agent:workbuddy`
- 🔴 **鉴权（2026-09-28 实测）**：HTTP 面只认 `Authorization: Bearer <apiKey>` 头，**`X-API-Key` 无效**（返回 `Missing or invalid API key`，易误判为服务故障）。
- **apiKey 取值**：`~/.leafmem/agent-service.json` 的 `apiKey` 字段。
- **返回结构**：顶层 `profile / principles / stats / recallHot`；
  `profile = { present, preamble, sections[{title, content}], updatedAt }`，**分节数 = sections 数组长度**。

## 5. 🔴 scope 参数形态（静默返回空快照）

**必须走查询串 `?scope=agent:workbuddy`**（2026-10-05 实测）。

传 `?scopeType=agent&scopeId=workbuddy`、或省略 scope，服务端**不报错**而是返回**空快照**：

- `profile.present=false` / `profile.updatedAt=null` / `sections=[]`
- `principles=0` / `stats.principleCount=0` / `totalRecallCount=0`
- 唯 `entityCount` 仍返回全局值 ⇒ **极易被误读为「只有实体还在、画像与原则全丢了」**。

**症状酷似数据丢失，实为口径错。**

> 🔴 **判据**：`stats.principleCount` 与步骤 2 的 `kind='principle'` 计数不一致，即先怀疑 scope 参数形态。