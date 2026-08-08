# LeafMem

Layered memory subsystem for AI agents.

LeafMem is a standalone long-term memory engine for AI agents. It is not a single memory table or one compressed summary. It keeps long-term memory, active working state, and task-local context in separate layers, then composes them when an agent needs recall.

LeafMem 是一个面向 AI 智能体的独立长期记忆引擎。它不是一张简单的记忆表，也不是单一滚动摘要，而是把长期记忆、当前工作状态和任务上下文分层保存，并在需要时组合召回。

## Why / 为什么

Most agent memory systems drift toward either full chat history or one rolling summary. LeafMem keeps the layers separate:

- Palace: durable records with scope, kind, source, tags, confidence, importance, and metadata
- Active memory: compressed `context` and reusable `experience`
- Task context: task transcript entries, rolling summaries, and decisions
- Retrieval: local weighted scoring, optional embedding rerank, optional QMD backend

这样做的好处是：写入更可控，召回更容易解释，跨 agent 共享记忆时也能保留来源和标记，而不会把所有上下文揉成一团。

## Highlights / 功能摘要

- SQLite by default, with WAL mode and FTS5
- In-memory store for tests and ephemeral sessions
- Scope-aware memory records: `user`, `task`, `agent`, `session`, `document`, `project`, `repo`
- CJK-aware tokenizer for Chinese/Japanese/Korean text
- Local builtin retrieval with no external API requirement
- Optional OpenAI, Gemini, Voyage, or script-based embeddings
- Active memory and task context managers
- Runtime layer for turn capture and prompt-ready recall
- 6 consolidated MCP tools plus local stdio MCP server
- Local setup for Codex, Claude Code, Cursor, GitHub Copilot, Antigravity, WorkBuddy, KunlunXiaoZhi, and Trae Solo
- Browser console and terminal TUI for agent setup
- Hermes and OpenClaw compatibility adapters
- Source, tags, metadata, and source history are preserved through writes and recall

## Install / 安装

```bash
npm install @xdragonjia/leafmem
```

Or from source:

```bash
git clone https://github.com/xdragonjia/leafmem.git
cd leafmem
npm install
npm run build
```

Requirements:

- Node.js `>= 22.13.0`
- ESM environment

Verify:

```bash
npm run check
npm test
```

## Quick Start / 最小示例

```ts
import { createLeafMem } from "@xdragonjia/leafmem";
import { createMemoryRuntime } from "@xdragonjia/leafmem/runtime";

const memory = createLeafMem({
  storage: { backend: "sqlite", path: ".leafmem/memory.sqlite" },
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice" }],
});

await runtime.captureTurn({
  taskId: "reply-style",
  taskTitle: "Reply style guidance",
  userMessage: "Remember that I prefer concise Chinese replies.",
});

const recall = await runtime.buildRecallContext({
  taskId: "reply-style",
  userMessage: "How should I answer this user?",
  maxChars: 800,
});

console.log(recall.injectedContext);
```

## MCP / Agent Setup

Run the local MCP server:

```bash
npm run build
node dist/bin/leafmem-mcp.js
```

Install LeafMem globally into supported coding agents:

```bash
node dist/bin/leafmem-agent.js install all
```

Update LeafMem and refresh agent entries:

```bash
node dist/bin/leafmem-agent.js update all
```

This writes agent MCP config, imports existing local sessions, adds global memory-use instructions where the host supports an instruction file, and installs a user-level local service for the browser console. All supported agents point at the same default SQLite store:

```text
~/.leafmem/memory.sqlite
```

Supported targets:

```text
codex | claude | cursor | copilot | antigravity | workbuddy | kunlunxiaozhi | trae | all
```

Start the browser setup console:

```bash
node dist/bin/leafmem-agent.js ui
```

Manage the persistent local console service:

```bash
node dist/bin/leafmem-agent.js service install
node dist/bin/leafmem-agent.js service status
node dist/bin/leafmem-agent.js service url
```

Start the terminal setup UI:

```bash
node dist/bin/leafmem-agent.js tui
node dist/bin/leafmem-agent.js tui --once
```

这些入口都会复用同一套 agent manager：探测 MCP 配置、写入全局配置、导入历史 session，并显示每个 agent 已写入的 memory/task 数量。

## Getting Started (API keys) / 快速上手

LeafMem runs out of the box with local builtin retrieval. To enable vectorized recall and reflection distillation, configure free embedding (SiliconFlow BGE-M3) and an optional inferencer (DeepSeek or any OpenAI-compatible model). See [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md).

LeafMem 开箱即用（本地内置检索）。如需启用向量化召回与反思蒸馏，请按 [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) 配置免费的硅基流动向量化模型与可选的 DeepSeek inferencer。

## Benchmarks / 基准测试

Full methodology and per-category analysis live in [`benchmarks/BENCHMARKS.md`](benchmarks/BENCHMARKS.md). Numbers below were re-measured on this codebase on 2026-08-08 (builtin deterministic; BGE-M3 rerank via the SiliconFlow embedding API). See the benchmark document for reproduction commands.

| Benchmark | Mode | R@5 | R@10 | NDCG@10 | LLM required |
|-----------|------|-----|------|---------|--------------|
| LongMemEval (500q) | Builtin, zero dependency | 89.6% | 94.6% | 0.834 | No |
| LongMemEval (500q) | + BGE-M3 rerank | 95.8% | 97.6% | 0.916 | No |
| LoCoMo (1986q) | Builtin, zero dependency | 84.1% | 92.0% | 0.733 | No |
| LoCoMo (1986q) | + BGE-M3 rerank | 88.4% | 94.9% | 0.790 | No |

README 只保留摘要数字。复现命令、数据集说明和结果解释请看 benchmark 文档。

## Documentation / 文档

| Document | 内容 |
|----------|------|
| [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) | API key setup guide (free SiliconFlow embeddings + optional DeepSeek inferencer), dual-host data strategy |
| [`docs/USAGE.md`](docs/USAGE.md) | Step-by-step integration guide, including MCP, agent setup, UI/TUI, imports, and storage choices |
| [`docs/WORKBUDDY.md`](docs/WORKBUDDY.md) | 普通用户把 LeafMem 安装并接入 WorkBuddy 的最短路径 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layer design, module structure, recall flow, turn capture flow, SQLite schema |
| [`docs/API.md`](docs/API.md) | Core APIs, runtime, retrieval, MCP tools, adapters, HTTP routes, package exports |
| [`benchmarks/BENCHMARKS.md`](benchmarks/BENCHMARKS.md) | Benchmark methodology, commands, and full result notes |

## Package Exports / 包入口

```text
@xdragonjia/leafmem
@xdragonjia/leafmem/core
@xdragonjia/leafmem/active
@xdragonjia/leafmem/task
@xdragonjia/leafmem/retrieval
@xdragonjia/leafmem/maintenance
@xdragonjia/leafmem/runtime
@xdragonjia/leafmem/mcp
@xdragonjia/leafmem/adapters
@xdragonjia/leafmem/system
@xdragonjia/leafmem/cloud
@xdragonjia/leafmem/platform
@xdragonjia/leafmem/http
@xdragonjia/leafmem/auth
@xdragonjia/leafmem/entity
@xdragonjia/leafmem/inspect
@xdragonjia/leafmem/bridge
@xdragonjia/leafmem/products/coding
@xdragonjia/leafmem/products/runtime
```

## Current Boundaries / 当前边界

- Builtin search is local and deterministic. Very large stores should use embedding rerank or QMD.
- Remote embeddings are opt-in. API keys alone do not enable remote calls.
- QMD support requires the `qmd` CLI in `PATH`.
- Turn capture currently uses lightweight proposal extraction unless you provide an inferencer.
- Markdown host compatibility is one-way SQLite to markdown after first import.
- Generic adapters are thin by design. Host-specific wrappers should reuse host provider/model/auth when available.

## License / 许可

[MIT](./LICENSE). LeafMem builds on open-source foundations; see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
