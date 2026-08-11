# LeafMem 接入指南

这份文档面向第一次把 LeafMem 接进自己项目的开发者。内容按照接入顺序组织，从最小可用配置开始，逐步介绍各个子系统的用法。

## 1. LeafMem 是什么

LeafMem 是一个分层的记忆子系统，和常见的"一张表存所有记忆"或者"一个压缩摘要"的方案不同。它同时维护三个层次的记忆：

- **长期记忆**：每条记忆都完整保留，带有 scope、kind、confidence、importance、tags 等元数据。
- **Active Memory（活跃记忆）**：把 palace 中的内容压缩成两份文档——`context` 负责追踪当前工作状态，`experience` 负责沉淀可复用的经验。
- **Task Context（任务上下文）**：在单个任务粒度上管理对话 entries、rolling summary 和 key decisions。

在这三层之上还有三个横切模块：retrieval 负责检索编排，maintenance 负责经验维护（attribution、calibration、rebuild），runtime 负责把这些拼成一个完整的生命周期。

## 2. 运行要求

LeafMem 使用了 Node.js 内置的 `node:sqlite` 模块，所以需要 Node.js 22.13.0 或更高版本，并且项目需要是 ESM 模式。

```bash
npm install
npm run build
npm run check  # TypeScript 类型检查
npm test       # 运行测试
```

## 3. 最小可用配置

最简单的接入方式只需要创建两个对象：

```ts
import { createLeafMem } from "@xdragonjia/leafmem";
import { createMemoryRuntime } from "@xdragonjia/leafmem/runtime";

const memory = createLeafMem({
  storage: { backend: "sqlite", path: ".leafmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({
    ok: true,
    text: `${kind}: ${prompt.slice(0, 200)}`,
  }),
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice", weight: 1.05 }],
});
```

这样就已经可以使用 palace 的存取和搜索、active memory 的压缩、task context 的管理以及 layered recall 了。

上面的 `inferencer` 是一个 stub 实现。distillation、calibration、rebuild 这些操作都会通过这个接口调用 LLM，正式使用时需要把它替换成你自己的模型调用逻辑。没有配置 inferencer 的情况下，这些操作会 fallback 到简单的文本截断拼接，不会报错。

## 4. Scope 的设计

每条记忆都需要一个 scope，用来标记这条记忆属于谁、在什么上下文下生效。

| type | 用途 |
|------|------|
| `user` | 用户级的长期偏好和身份信息 |
| `task` | 某个具体任务或 workflow 中的决定 |
| `agent` | agent 自身的行为规则和约束 |
| `session` | 单次会话内的临时记忆 |
| `document` | 绑定到某个文件或文档的记忆 |

scope 的 `weight` 字段是可选的，只在检索排序时作为加权因子使用：

```ts
{ type: "user", id: "alice", weight: 1.05 }
{ type: "task", id: "release-2026-04-18" }
```

## 5. 长期记忆的使用

### 写入记忆

```ts
await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "用户偏好简洁的中文回复。",
  importance: 0.9,
  tags: ["language", "style"],
});
```

写入时 LeafMem 会自动和已有的同 scope、同 kind 记录做相似度比对。如果相似度超过阈值（默认 0.85），新内容会合并到已有记录上，而不是创建一条新的。

### 搜索

```ts
const hits = await memory.search("怎么回复这个用户", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});
```

每个命中结果都包含 `score` 总分和 `reasons` 分项（lexical、hash、recency、importance、scope 五个维度），以及一段 `snippet` 摘要。

### 召回为 prompt 文本

```ts
const recall = await memory.recall({
  query: "怎么回复这个用户",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxChars: 800,
});
// recall.injectedContext 可以直接拼进 system prompt
```

如果你只想用 palace 这一层，不需要接 runtime，用到这里就够了。

## 6. Active Memory 的使用

Active memory 分成两部分：`context` 是当前工作状态的快照，每次 distill 都会覆盖上一次的内容；`experience` 是可复用的经验总结，更新频率较低。

```ts
// 压缩当前上下文
await memory.active.distillContext({
  scope: { type: "task", id: "release-2026-04-18" },
  sessionSummary: "我们在整理发布清单和 QA 交接。",
});

// 积累经验
await memory.active.distillExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  newData: "发布清单只保留可执行项，不要放说明文字。",
});

// 读取
const ctx = await memory.active.read("context", { type: "task", id: "release-2026-04-18" });
const exp = await memory.active.read("experience", { type: "task", id: "release-2026-04-18" });
```

## 7. Task Context 的使用

Task context 管理的是单个任务维度的信息：谁说了什么、当前的总结是什么、做过哪些关键决策。

```ts
// 创建任务
await memory.task.create({
  taskId: "release-flow",
  scope: { type: "task", id: "release-2026-04-18" },
  title: "Release flow",
});

// 追加对话 entry
await memory.task.appendEntry({
  taskId: "release-flow",
  role: "user",
  content: "还差最终 QA checklist。",
});

// 记录关键决策
await memory.task.addDecision({
  taskId: "release-flow",
  content: "checklist 保持简短、可执行。",
});

// 生成 prompt 窗口
const window = await memory.task.buildWindow({
  taskId: "release-flow",
  currentQuery: "发布前还差什么？",
});
```

`buildWindow` 返回的 `injectedContext` 包含 rolling summary、key decisions 和 recent entries，可以直接拼进 prompt。`charUsage` 字段会告诉你每个部分各占了多少字符。

## 8. Runtime 的使用

如果你不想手动编排 palace、active memory 和 task context 三层的调用顺序，可以直接使用 runtime。

### 捕获一轮对话

```ts
const capture = await runtime.captureTurn({
  taskId: "release-flow",
  taskTitle: "Release flow",
  userMessage: "记住我喜欢简洁的中文回复。",
  assistantMessage: "好的，以后用简洁中文。",
});
```

这一次调用会完成以下所有步骤：从用户消息里启发式提取可持久化的记忆（显式 remember 请求、偏好、决策、身份信息），写入 palace，追加 task entries 并更新 rolling summary，最后刷新 active context。

### 构建分层召回

```ts
const recall = await runtime.buildRecallContext({
  taskId: "release-flow",
  userMessage: "我们之前决定怎么部署来着？",
  recentMessages: ["刚才在比较 Fly.io 和 Railway。"],
  maxChars: 1000,
});
```

这一步会按 active memory → task window → palace recall → retrieval 的顺序合并四个层次的记忆，最终结果在 `recall.injectedContext` 中。如果需要分层检查，各层的原始内容在 `recall.layers` 里。

### 写入 reflection

```ts
await runtime.captureReflection({
  taskId: "release-flow",
  summary: "adapter API 要保持框架无关。",
  scopes: [{ type: "task", id: "release-2026-04-18" }],
});
```

这个操作会同时写 palace experience 记录、distill active experience、并在 task context 中追加一条 decision。

## 9. Adapter 的使用

如果你已经有自己的 agent loop，可以用 adapter 来简化集成。

### 逐轮 wrapper

每轮对话自动完成 capture 和 recall：

```ts
import { createGenericMemoryAdapter } from "@xdragonjia/leafmem/adapters";

const adapter = createGenericMemoryAdapter({
  memory,
  defaultScopes: [{ type: "agent", id: "support-bot" }],
});

// 在生成回复之前调用，获取记忆上下文
const { systemHint, injectedContext } = await adapter.beforePrompt({
  userMessage: "下一步做什么？",
});

// 在回复生成之后调用，持久化本轮的记忆
await adapter.afterTurn({
  userMessage: "记住我偏好简洁中文回复。",
  assistantMessage: "收到。",
});
```

### Session-flush wrapper

对于 Codex、Claude Code 这类 tool-heavy 的 agent，每轮都做 active context 和 task summary 的压缩可能开销太大。session-flush wrapper 把这些重操作延后到 session 结束时统一执行，但 recall 每轮仍然可用：

```ts
import { createSessionMemoryAdapter } from "@xdragonjia/leafmem/adapters";

const adapter = createSessionMemoryAdapter({
  memory,
  defaultScopes: [{ type: "session", id: "workbuddy-run-001" }],
});

await adapter.beforePrompt({ userMessage: "下一步？", taskId: "release" });
await adapter.afterTurn({
  userMessage: "还差 release checklist。",
  assistantMessage: "好的，保持简短。",
  taskId: "release",
  taskTitle: "Release checklist",
});

// 在 session 结束时调用
await adapter.flushSession();
```

### 怎么选

| 使用场景 | 推荐方案 |
|---------|---------|
| 全自动、每轮完整 capture | `createGenericMemoryAdapter` |
| 想控制 token 开销，宿主能确定 session 结束时机 | `createSessionMemoryAdapter` |
| 已经有一份 Hermes，想少配一点直接接进去 | `leafmem-hermes install-plugin` |
| 需要暴露给外部 client 或多 agent 工具调用 | MCP handler |

### 接入 Hermes

如果你要把 Hermes 自带的 `MEMORY.md` / `USER.md` 交给 LeafMem 管理，推荐直接用 `installHermesAgentMemoryTakeover()`。它会做几件事：

- 默认按 session-flush 的方式工作
- 安装时先把已有的 `md` 内容导入进来
- 之后由 LeafMem 统一管理这些记忆
- 每次记忆有变化时，再把结果写回原来的文件

```ts
import { createLeafMem } from "@xdragonjia/leafmem";
import { installHermesAgentMemoryTakeover } from "@xdragonjia/leafmem/adapters";

const memory = createLeafMem({
  storage: { backend: "sqlite", path: "~/.leafmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({ ok: true, text: `${kind}: ${prompt}` }),
});

const { adapter, imported } = await installHermesAgentMemoryTakeover({
  memory,
  defaultScopes: [{ type: "agent", id: "hermes" }],
});

console.log(imported);

await adapter.afterTurn({
  userMessage: "Remember that I prefer concise Chinese replies.",
  assistantMessage: "I will keep responses concise.",
});
```

默认文件位置：

- `~/.hermes/memories/MEMORY.md`
- `~/.hermes/memories/USER.md`

如果你已经有一份 Hermes，想直接接到现成实例里，不改 Hermes 源码也可以。先 build，再安装 bridge plugin：

```bash
npm run build
node dist/bin/leafmem-hermes.js install-plugin \
  --hermes-home ~/.hermes \
  --storage-path ~/.hermes/leafmem.sqlite \
  --scope-type agent \
  --scope-id hermes
```

这个命令会先做一次初始化导入，然后把一个 Hermes plugin 写到 `~/.hermes/plugins/leafmem/`。后面 Hermes 每轮结束、原生 `memory` 工具写入、以及 session 结束时，都会自动把变更同步回 LeafMem，再把 `MEMORY.md` / `USER.md` 刷新出来。

Hermes 这类本身已经有 API key / provider 配置的 agent，可以给 bridge 一个 API-backed inferencer，让 session 结束时的 distill 走 LeafMem 内部 inferencer，而不是 host-mediated MCP 工具：

```bash
export LEAFMEM_INFERENCER='{"api":"openai-completions","model":"gpt-4.1-mini","baseUrl":"https://api.openai.com","apiKey":"..."}'
node dist/bin/leafmem-hermes.js install-plugin \
  --hermes-home ~/.hermes \
  --storage-path ~/.hermes/leafmem.sqlite \
  --scope-type agent \
  --scope-id hermes
```

也可以把同一段 JSON 直接传给 `--inferencer`。安装后的 plugin 会继续读取 `LEAFMEM_INFERENCER`，因此后续换模型或换 key 不需要重新安装 plugin。

### 接入 OpenClaw

如果你要把 OpenClaw 的 markdown memory 交给 LeafMem 管理，同样直接用 `installOpenClawMemoryTakeover()`。当前实现会处理：

- `MEMORY.md`
- `USER.md`
- `memory/YYYY-MM-DD.md`
- `DREAMS.md`

```ts
import { createLeafMem } from "@xdragonjia/leafmem";
import { installOpenClawMemoryTakeover } from "@xdragonjia/leafmem/adapters";

const memory = createLeafMem({
  storage: { backend: "sqlite", path: "~/.leafmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({ ok: true, text: `${kind}: ${prompt}` }),
});

const { adapter } = await installOpenClawMemoryTakeover({
  memory,
  defaultScopes: [{ type: "agent", id: "openclaw" }],
});

await adapter.afterTurn({
  taskTitle: "Release checklist",
  userMessage: "Remember that we use pnpm workspaces.",
  assistantMessage: "I will keep using pnpm workspaces.",
});

await adapter.flushSession();
```

默认工作区位置：

- `~/.openclaw/workspace/MEMORY.md`
- `~/.openclaw/workspace/USER.md`
- `~/.openclaw/workspace/memory/YYYY-MM-DD.md`
- `~/.openclaw/workspace/DREAMS.md`

如果你已经有一份真实的 OpenClaw 安装，想尽量少配东西，直接装 bridge plugin 就行：

```bash
npm run build
node dist/bin/leafmem-openclaw.js install-plugin \
  --scope-type agent \
  --scope-id openclaw
```

这个命令会先做一次初始化导入，然后把一个 OpenClaw plugin 写到 `~/.openclaw/plugins/leafmem/`。后面 OpenClaw 每轮开始前会先取 LeafMem 的 recall，上下文注入到 prompt 里；每轮结束后，再把这一轮对话写回 LeafMem，并刷新 `MEMORY.md` / `USER.md` / `DREAMS.md` 和当天的 `memory/YYYY-MM-DD.md`。

如果当前 OpenClaw 会话本身已经配好了正常的 HTTP 模型 provider，这个 bridge 还会直接复用那一套 provider/model 来做 LeafMem 的 session summary。也就是说，OpenClaw 这条接法默认不需要再额外给 LeafMem 配一套总结模型。

### 接入自带 provider key 的 runtime

直接拥有 provider/key 的 runtime（wrapper、宿主环境等）可以走同一条 API-backed inferencer 路径。做法是在创建 LeafMem 时把 runtime model config 转成 inferencer：

```ts
import { createLeafMem } from "@xdragonjia/leafmem";
import { createOpenClawInferencer } from "@xdragonjia/leafmem/adapters";

const memory = createLeafMem({
  storage: { backend: "sqlite", path: "~/.leafmem/memory.sqlite" },
  inferencer: createOpenClawInferencer({
    api: "openai-responses",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});
```

这样 active distill、task rolling summary、maintenance rebuild/calibration 都会直接用 runtime 提供的 API-backed inferencer。

## 10. Retrieval 的配置

### 只用 builtin（默认）

默认配置下 LeafMem 使用本地五维加权评分做检索，不需要任何外部服务。

### 加上 remote embeddings

如果你需要更强的语义 rerank 能力，可以显式配置 remote embedding provider。仅仅在环境变量里设置了 API key 并不会自动开启这个功能。

```ts
const memory = createLeafMem({
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },  // 也可以用 "gemini"、"voyage" 或 "auto"
  },
});
```

相关的环境变量：`OPENAI_API_KEY`、`GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）、`VOYAGE_API_KEY`。

### QMD backend

如果你的环境中已经安装了 `qmd` CLI，可以把它作为外部检索后端接入：

```ts
const memory = createLeafMem({
  retrieval: {
    backend: "qmd",
    qmd: {
      enabled: true,
      command: "qmd",
      collections: [{ name: "memory", path: ".leafmem/qmd", pattern: "**/*.md" }],
      includeDefaultMemory: true,
    },
  },
});
```

## 11. Maintenance 的使用

LeafMem 的 experience 不是写完就不管的，maintenance 模块提供了四个维护操作：

```ts
// attribution：判断这次回答中哪些 experience 条目实际起了作用
await memory.maintenance.attributeExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  response: "checklist 保持简短。",
  outcome: "positive",
});

// calibration：检测并清理 zombie 条目（从未激活且在近期记忆中找不到支撑的）、harmful 条目（激活多次但正面反馈比例低的）
await memory.maintenance.calibrateExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// rebuild：从 palace 中最近的记录重新构建 experience 文档
await memory.maintenance.rebuildExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// deep consolidation：依次执行 rebuild 和 calibrate
await memory.maintenance.deepConsolidate({
  scope: { type: "task", id: "release-2026-04-18" },
});
```

## 12. MCP 的接入

有两种接法：

- 自己写宿主：直接用 `createMemoryMcpHandler()`
- 给 Codex、Claude Code、Cursor、Copilot、WorkBuddy、TRAE Work 这类 MCP client 用：运行本地 `leafmem-mcp` stdio server

如果你需要把 LeafMem 嵌进自己的宿主，可以直接使用 MCP handler：

```ts
import { createMemoryMcpHandler } from "@xdragonjia/leafmem/mcp";
const handler = createMemoryMcpHandler({ memory });
```

MCP handler 提供了 6 个聚合工具：

| 工具 | 功能 |
|------|------|
| `memory_write` | `action: "remember" / "commit" / "task_append" / "active_distill"`，写记忆：remember 记录、commit 提交会话、task_append 追加任务条目、active_distill 蒸馏 active |
| `memory_recall` | `action: "recall" / "search" / "get" / "list" / "task_window" / "active_get"`，召回记忆：召回上下文、检索、任务窗口、读 active |
| `memory_organize` | `action: "prepare" / "apply" / "reflect" / "profile" / "decay" / "calibrate" / "rebuild"`，整理记忆：维护准备/应用、蒸馏原则、刷新画像、衰减、experience 校准重建 |
| `memory_govern` | `action: "update" / "delete" / "attribute" / "pin"`，管理记忆：更新/删除记录、归因召回价值、固定防衰减 |

`memory_write` 的 `action: "commit"` 是 Codex、Claude Code、Cursor、Copilot、Antigravity 这类宿主 agent 的推荐 session-flush 路径：宿主 agent 先用自己的当前模型生成 `rollingSummary` 和可选 `durableMemories`，LeafMem 只负责追加新增 `entries`、设置 task rolling summary、更新同一条 session memory。这个工具不会调用 LLM，也不需要 LeafMem 读取宿主 agent 的 OAuth token 或订阅凭据。

OpenClaw、Hermes 这类 runtime / wrapper 自己能拿到 provider key 或 runtime model config 的 agent，推荐直接把 API-backed inferencer 传给 LeafMem。OpenClaw plugin 会自动复用当前 runtime model；Hermes bridge 支持 `LEAFMEM_INFERENCER` / `--inferencer`；其他自带 key 的 runtime 可以用 `createOpenClawInferencer()` 创建同一类 inferencer。

`memory_write` 的 `action: "remember"`（更新用 `memory_govern` 的 `action: "update"`） 可以写入 `source`、`tags` 和 `metadata`。如果一条新记忆被合并到已有记录，tags 和 metadata 会合并，额外来源会保存在 `metadata.sourceHistory`，有冲突的标记会保存在 `metadata.markerHistory`。`memory_recall` 的 `action: "recall"` 会在返回的 `hits[].record` 中保留完整记录，并在 prompt-ready 文本里显示每条命中的 source、tags 和 metadata 标记。

示例参数：

```json
{
  "scope": { "type": "agent", "id": "kunlunxiaozhi" },
  "kind": "preference",
  "content": "用户希望代码修复走根因路径，不要堆兜底补丁。",
  "source": "kunlunxiaozhi",
  "tags": ["coding", "preference"],
  "metadata": {
    "project": "leafmem",
    "origin": "manual-note"
  }
}
```

如果你是要本地部署一个正式可用的 MCP server，推荐直接运行：

```bash
npm run build
node dist/bin/leafmem-mcp.js
```

默认行为：

- 存储路径：`~/.leafmem/memory.sqlite`
- retrieval backend：`builtin`
- remote embeddings：默认关闭，只有显式配置才启用

常用环境变量：

```bash
LEAFMEM_STORAGE_PATH=/custom/path/memory.sqlite
LEAFMEM_SCOPE_TYPE=agent
LEAFMEM_SCOPE_ID=kunlunxiaozhi
LEAFMEM_RETRIEVAL_BACKEND=builtin
LEAFMEM_EMBEDDINGS_PROVIDER=openai
LEAFMEM_EMBEDDINGS_MODEL=text-embedding-3-small
```

接到昆仑小智的最简单方式：

```bash
node dist/bin/leafmem-agent.js install kunlunxiaozhi
```

这个命令会写入用户级 `~/.kunlunxiaozhi/mcp.json`。如果当前昆仑小智会话没有立刻看到新 server，开一个新会话再试。

接到 WorkBuddy 的最简单方式：

```bash
node dist/bin/leafmem-agent.js install workbuddy
```

如果你只是想给 WorkBuddy 装好并立刻使用，可以直接看普通用户版教程：[`WORKBUDDY.md`](WORKBUDDY.md)。

这个命令会写入用户级 `~/.workbuddy/mcp.json`，并给 MCP server 配好默认 scope：

```json
{
  "mcpServers": {
    "leafmem": {
      "command": "node",
      "args": ["/absolute/path/to/leafmem/dist/bin/leafmem-mcp.js"],
      "env": {
        "LEAFMEM_STORAGE_PATH": "~/.leafmem/memory.sqlite",
        "LEAFMEM_SCOPE_TYPE": "agent",
        "LEAFMEM_SCOPE_ID": "workbuddy",
        "LEAFMEM_WORKBUDDY_HOME": "~/.workbuddy"
      }
    }
  }
}
```

安装时还会导入并接管 `~/.workbuddy/SOUL.md`、`~/.workbuddy/USER.md`、`~/.workbuddy/MEMORY.md`。接管后主要记忆存储在 LeafMem 数据库中，这三份 Markdown 文件继续留在原位置作为 WorkBuddy 的映射文件；LeafMem 同步前会先吸收文件中的直接改动，再刷新投影。

因此在 WorkBuddy 里调用 `memory_write` 的 `action: "remember"`、`action: "active_distill"`、`memory_organize` 的 `action: "calibrate"` 这类需要 scope 的操作时，可以省略 `scopeType` / `scopeId`；LeafMem 会自动落到 `agent:workbuddy`。如果要跨工具查询共享记忆，调用 `memory_recall` 的 `action: "recall"` 时仍然可以不传 scope。

### 安装到宿主（WorkBuddy / 昆仑小智）

LeafMem 面向两个宿主：WorkBuddy 与昆仑小智（同源 WorkBuddy 家族，配置结构一致）。推荐用安装入口：

```bash
npm run build
node dist/bin/leafmem-agent.js install all
```

也可以只安装某一个宿主：

```bash
node dist/bin/leafmem-agent.js install workbuddy
node dist/bin/leafmem-agent.js install kunlunxiaozhi
```

默认会做两件事：

- 安装 MCP 配置，两个宿主指向同一个 `~/.leafmem/memory.sqlite`
- 写入 LeafMem 使用规则到宿主的 MEMORY.md（含召回/写入/commit 纪律）

各宿主的默认落点：

| 宿主 | MCP 配置 | 指令文件 | 记忆 scope |
|------|----------|----------|-----------|
| WorkBuddy | `~/.workbuddy/mcp.json` | `~/.workbuddy/MEMORY.md` | `agent:workbuddy` |
| 昆仑小智 | `~/.kunlunxiaozhi/mcp.json` | `~/.kunlunxiaozhi/MEMORY.md` | `agent:kunlunxiaozhi`（共用记忆时 `agent:workbuddy`） |

**共用一套记忆**：两个宿主都安装时，installer 通过 `sharedMemory` 选项决定 scope 拓扑——共用时两宿主统一落到 `agent:workbuddy` 单一记忆池，长期记忆、实体图谱、用户画像、active 工作状态四层全部共享；隔离时各自独立 scope。

常用选项：

```bash
node dist/bin/leafmem-agent.js install all \
  --storage-path ~/.leafmem/memory.sqlite

node dist/bin/leafmem-agent.js install kunlunxiaozhi \
  --shared-memory

node dist/bin/leafmem-agent.js install workbuddy \
  --skip-import
```

`leafmem-agent` 命令速查：

| 命令 | 用途 |
|------|------|
| `leafmem-agent install <agent\|all>` | 写入 MCP 配置、导入历史 session、写入全局指令 |
| `leafmem-agent update <agent\|all>` | 更新代码和依赖，然后重新执行安装入口 |
| `leafmem-agent service <cmd>` | 安装、启动、停止、查询本地常驻控制台服务 |
| `leafmem-agent serve` | LaunchAgent 使用的长跑 HTTP console 入口，并每 15 分钟增量导入本地 agent sessions |
| `leafmem-agent ui` | 启动本地 Web 控制台 |
| `leafmem-agent tui` | 启动终端控制台 |

`install` 和 `update` 支持的 target：`workbuddy`、`kunlunxiaozhi`、`all`。

`leafmem-agent` 的常用参数：

| 参数 | 适用命令 | 作用 |
|------|----------|------|
| `--storage-path <path>` | `install` / `update` / `ui` / `tui` | 指定共享 SQLite 路径 |
| `--mcp-path <path>` | `install` / `update` / `ui` / `tui` | 指定写入 agent 配置的 `leafmem-mcp` 脚本路径 |
| `--home <path>` | `install` / `update` / `ui` / `tui` | 指定 agent 配置所在的 home 目录，测试或迁移时有用 |
| `--sessions-root <path>` | `install` / `update` 单 agent | 覆盖该 agent 的历史 session 目录 |
| `--skip-mcp` | `install` / `update` | 不写 MCP 配置 |
| `--skip-import` | `install` / `update` | 不导入历史 session |
| `--skip-instructions` | `install` / `update` | 不写全局指令 |
| `--skip-service` | `install all` / `update all` | 不安装本地常驻 console 服务 |
| `--no-service-start` | `install all` / `update all` | 写入 LaunchAgent 但不立刻启动 |
| `--port <number>` | `ui` | 指定 Web 控制台端口 |
| `--host <host>` | `ui` | 指定 Web 控制台监听地址 |
| `--once` | `tui` | 只打印一次状态并退出 |

### 本地常驻 agent service

`leafmem-agent install all` 默认会确保本地控制台服务存在。服务配置保存在：

```text
~/.leafmem/agent-service.json
```

macOS 上会写入用户级 LaunchAgent：

```text
~/Library/LaunchAgents/com.leafmem.agent.plist
```

它运行 `leafmem-agent serve`，使用同一个 `~/.leafmem/memory.sqlite` 和一枚稳定的本地 API key。这样重启机器后 console URL 不会因为临时进程退出而失效。

`serve` 只做轻量兜底同步：它定时读取宿主本地 session 文件并复用幂等 importer 写入 LeafMem，不会启动宿主 agent，也不会调用额外模型。高质量 session summary 仍然建议由宿主 agent 在重要工作或会话收尾时主动调用 `memory_write` 的 `action: "commit"`。

常用命令：

```bash
node dist/bin/leafmem-agent.js service install
node dist/bin/leafmem-agent.js service status
node dist/bin/leafmem-agent.js service url
node dist/bin/leafmem-agent.js service restart
node dist/bin/leafmem-agent.js service stop
node dist/bin/leafmem-agent.js service uninstall
```

安装但不立刻启动：

```bash
node dist/bin/leafmem-agent.js service install --no-start
```

指定端口：

```bash
node dist/bin/leafmem-agent.js service install --port 3379
```

### 本地 agent 设置 UI

安装 LeafMem 之后，也可以启动一次性的本地控制台来探测和统一配置这些 agent：

```bash
npm run build
node dist/bin/leafmem-agent.js ui
```

启动后命令行会打印 Console 地址和本次 API key。打开 `http://127.0.0.1:3377/console#agents`，输入 API key 后，Agents 页面会显示：

- 当前共享 SQLite 路径和 MCP 脚本路径
- Codex、Claude Code、Cursor、Copilot、Antigravity 的 MCP 配置状态
- 全局指令是否已写入
- 默认 session 目录是否存在
- 已导入到共享记忆库的 session memory / task 数量

页面里的 `Install` / `Install All` 调用的就是 `leafmem-agent install` 同一套逻辑；`Sync` / `Sync Now` 调用下面的 session 导入工具，同样写入同一个 `~/.leafmem/memory.sqlite`。

如果默认端口已经被占用，换一个端口即可：

```bash
node dist/bin/leafmem-agent.js ui \
  --port 3378 \
  --storage-path ~/.leafmem/memory.sqlite
```

也可以把 API key 放进 URL 直接进入 Agents 页：

```text
http://127.0.0.1:3378/console?apiKey=<printed-api-key>#agents
```

### 本地 agent 设置 TUI

如果只想在终端里完成同样的探测和配置，可以启动 TUI：

```bash
npm run build
node dist/bin/leafmem-agent.js tui
```

TUI 会显示同一组状态字段，并提供安装全部、导入全部、安装单个 agent、导入单个 agent、刷新和退出。它复用 `leafmem-agent install` 和 session 导入工具，不维护第二套配置逻辑。

只打印一次状态、不进入交互菜单：

```bash
node dist/bin/leafmem-agent.js tui --once
```

指定同一套共享库和 MCP 脚本：

```bash
node dist/bin/leafmem-agent.js tui \
  --storage-path ~/.leafmem/memory.sqlite \
  --mcp-path /absolute/path/to/leafmem/dist/bin/leafmem-mcp.js
```

交互菜单动作：

| 动作 | 效果 |
|------|------|
| `Install all` | 给所有支持的 agent 写入 MCP 配置、指令，并导入历史 session |
| `Import all` | 只导入所有 agent 的历史 session |
| `Install agent` | 对单个 agent 执行安装 |
| `Import agent` | 对单个 agent 执行导入 |
| `Refresh` | 重新探测状态 |

### 本地 agent 设置 HTTP API

`leafmem-agent ui` 启动的本地 server 也提供同一套 agent 控制 API。它使用启动时打印的 API key 鉴权：

```bash
export BASE=http://127.0.0.1:3377
export API_KEY=<printed-api-key>
```

| Endpoint | 方法 | 用途 |
|----------|------|------|
| `/v1/agents/status` | `GET` | 返回共享库路径、MCP 脚本路径、每个 agent 的配置和导入状态 |
| `/v1/agents/install` | `POST` | 安装单个宿主，body 为 `{"agent":"kunlunxiaozhi"}` |
| `/v1/agents/import` | `POST` | 导入单个 agent 的历史 session |
| `/v1/agents/install-all` | `POST` | 安装全部 agent |
| `/v1/agents/import-all` | `POST` | 导入全部 agent 的历史 session |

示例：

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "$BASE/v1/agents/status"

curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent":"kunlunxiaozhi"}' \
  "$BASE/v1/agents/install"

curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$BASE/v1/agents/import-all"
```

### 导入已有宿主记忆

WorkBuddy 家族宿主（WorkBuddy / 昆仑小智）不需要单独的导入工具——installer 在安装时通过 **takeover 接管**自动导入：读取宿主目录下的 `SOUL.md`、`USER.md`、`MEMORY.md` 与原生记忆文件，写入 LeafMem 数据库。重复运行 `install` / `update` 是幂等的，只增量吸收新内容。

```bash
node dist/bin/leafmem-agent.js install workbuddy
node dist/bin/leafmem-agent.js install kunlunxiaozhi
```

导入结果写入长期记忆，`source` 为 `workbuddy_import` / `workbuddy_native_import`。

## 13. 存储方式的选择

SQLite 是默认的存储后端，正式使用时推荐这个：

```ts
storage: { backend: "sqlite", path: ".leafmem/memory.sqlite" }
```

跑测试或者做 demo 的时候可以用 InMemoryStore，数据只在内存中存在：

```ts
import { createLeafMem, InMemoryStore } from "@xdragonjia/leafmem";
const memory = createLeafMem({ store: new InMemoryStore() });
```

## 14. 接入方式总结

| 你的情况 | 推荐接法 |
|---------|---------|
| 单进程应用，先跑起来 | `createLeafMem()` + `createMemoryRuntime()` |
| 需要把记忆工具暴露给外部 | 优先用 `leafmem-mcp`，自定义宿主再直接用 `createMemoryMcpHandler()` |
| 有现成的 agent 框架，宿主可以控制 session 结束 | 用 `createSessionMemoryAdapter()` |
| 有现成的 agent 框架，想全自动处理 | 用 `createGenericMemoryAdapter()` |
| 只想评估 palace 这一层 | 只用 `memory.remember` / `search` / `recall` |

这个系统最有特点的地方在于 active memory、task context 和 maintenance 三层协同工作。只接 palace 当然能用，但 LeafMem 相比普通记忆表的差异化价值主要来自这三层。

## 15. 当前的限制

- 长期记忆存储对外暴露的是 `MemoryStore` 接口（`load()` / `save()`），不是直接的 SQL 查询 API。
- Builtin retrieval 基于确定性的本地评分；remote embeddings + rerank 是叠加层——对 SDK 裸接入是可选的，但双宿主安装引导**默认开启**（硅基流动免费额度，见 README 基准表与 GETTING_STARTED）。
- 使用 QMD backend 需要运行环境中已安装 `qmd` CLI。
- Turn capture 中的记忆提取使用的是启发式正则匹配，不是 LLM 调用。
- Session-flush wrapper 的 buffer 存在 adapter 进程内存中，由宿主决定何时 flush。
- Adapter 层设计上刻意保持轻薄，不封装框架特定的逻辑。
