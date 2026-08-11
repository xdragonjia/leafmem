# Changelog

All notable changes to LeafMem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.7] - 2026-08-12

### Fixed
- **单测污染真实审计日志**：`runMemoryMcpStdioServer` 在测试传 in-memory memory
  但未传 storagePath 时，审计事件库回落到真实 `~/.leafmem/memory.sqlite`——
  测试的 mock 写入把幽灵 memory_written 事件写进生产 console 事件页，记录本身
  随进程消亡（事件 61d8652c 即此，用户截图发现）。现 events 可注入，stdio 测试
  注入 InMemoryInspectEventStore；实测跑测试对真库零污染；6 条幽灵事件已清。

## [0.3.6] - 2026-08-11

### Fixed
- **Stop 门禁判据错误（双向）**：原门控以「启发式是否捕获」为 block 条件。
  ①硬写误触发（stored>0）会**致盲门禁**——agent 不被拉回总结，控制台只剩
  硬写垃圾（0.3.5 身份误存事故的连锁效应）；②agent 主动写过而启发式没捕获
  时被**多余 block**。现门禁问正确的问题：「本会话 agent 是否主动写入」
  （UPS 记 sessionStartAt；Stop 查 `GET /v1/memories?scope=agent:<id>`，
  统计 source 非 capture 路径且 createdAt≥会话起点的记录数；零条且实质工作
  才 block 一次；查询不可用 fail-open）。启发式 stored 数降为诊断信息。
  8 门禁测试含事故 fixture。

## [0.3.5] - 2026-08-11

### Fixed
- **启发式 capture 误存用户原话为 identity 记忆**：「我是通过 proxifier 访问
  github 的，…删除三行…@image#1:…」整句被存成身份记忆——裸「我是」线索命中
  了动作描述。identity 分支现排除「我是+方式/动作短语」（我是通过/用/在/正在…
  及英文等价），真实自我介绍仍捕获；`@image#N:…` 附件标记在所有启发式匹配前
  剥离。4 个回归测试（真实原话作 fixture）。

## [0.3.4] - 2026-08-11

### Added
- **任务生命周期关闭路径**：`TaskContextManager.setStatus()` + MCP `memory_write`
  的 `task_append` 接受可选 `status`（active/paused/completed/archived），创建时与
  存量转换均可。此前四态枚举只有类型定义、无任何转换写路径，task_append 建的
  任务永远停在 active（08-11 用户截图发现的机制缺陷）。
- **Stop 驱动指令④ 关闭一致性**：传 `status="completed"` 必须同传闭环版
  `rollingSummary`（清除待办/未完成表述）——completed 徽章配过时待办比没有
  summary 更误导。

### Docs
- ARCHITECTURE.md 新增 Task Lifecycle 节（任务 born active、永不自动关闭、
  显式转换三件套）；API.md 补 setRollingSummary/setStatus 示例；USAGE.md
  task_append 参数补全。

## [0.3.3] - 2026-08-11

### Fixed
- **POST /v1/memories 静默忽略 body 顶层 scope（根因双修）**：①路由层只认 URL
  query 的 scope，body 顶层 `scope` 字段被丢弃；②`resolveContextScopes` 的
  anyScope 分支把 writeScope 硬编码为会话 projectId——显式 `scope=agent:workbuddy`
  的写入实际落进 `proj_local_*`，对 agent scope 召回不可见（08-11 实测 14 条蒸馏
  记录全写错 scope）。现显式 scope 选择同时定向读与写，5 条回归测试锁定。
- **allScopes（全部记忆）召回范围退化为 project scope**：`resolveContextScopes`
  无视 allScopes 标志，console「全部记忆」召回检查只在会话 proj_local_* 里搜，
  永远只命中错 scope 的新记录、旧记忆零命中。现 allScopes 返回空 recallScopes
  （=全库搜索）。
- **task_append 不写 rollingSummary**：纯 task_append 建的任务在 console 任务页
  「有 Transcript、无 Summary」。task_append 现接受可选 rollingSummary 并落
  task_context_state；Stop 驱动指令同步要求同传。

### Added
- **Stop hook 驱动 agent 主动写入**：Stop 的关键词启发式 capture 只认
  记住/偏好/决定/我是四类措辞，复杂工作会话全天零写入。现「实质工作（≥15字）
  且 stored=0」时 Stop hook 返回 `decision:"block"` 拉回 agent，指令其
  memory_write 写经验/决策/教训 + task_append 记进度。三重防循环：
  stop_hook_active 协议标志、capture-state.json 每会话至多一次、已捕获/短会话
  放行。`LEAFMEM_HOOK_STOP_DRIVE=0` 可关。

### Changed
- **六文件初始导入改为 LLM 中介蒸馏**：机械逐行导入曾产出 300+ 碎片（分隔符、
  孤立标题、拆半的列表项）。安装器现只登记 pending 状态，由宿主 LLM 按 INSTALL
  引导步骤 7.5 把每文件蒸馏成 1-4 条段落级记忆。parseMarkdownEntries 保留为
  legacy 安全网（分隔符/孤立标题不独立入库、嵌套子项并入父）。
- **取消导入掩码**：记忆库为单机专用（127.0.0.1 + API Key），用户自记凭证无需
  掩码，掩码反而损坏笔记可用性。

## [0.3.2] - 2026-08-11

### Fixed
- **shared 拓扑下第二宿主导入写错 scope（根因修复）**：install 流程里 MCP 配置走拓扑
  解析（shared → primary scope），但六文件初始导入硬编码宿主自身 scope——shared 的
  昆仑小智安装把 167 条重复导入记录写进 agent:kunlunxiaozhi（内容 100% 已存在于主
  scope 的纯重复死池）。提取共享的 `resolveEffectiveScopeId`，import 与 MCP 同用一
  个解析函数，永不分叉。新增回归测试（shared 第二宿主导入落主 scope、自身 scope 零
  记录）。
- **batch DELETE 对 agent scope 记录静默失效**：`/v1/memories/batch` 用裸 projectId
  上下文，agent scope 记录永远 `deleted: 0`（08-08 修单条 DELETE 时漏了 batch，同根
  因）。现镜像单条语义：显式 `scope=` 才能删 agent scope 记录。回归测试锁定。
  240/240。

## [0.3.1] - 2026-08-11

### Fixed
- **hook 自动 capture 注入垃圾入库（根因修复）**：宿主会话文件把
  `<system-reminder>`/身份文件等系统注入块原样嵌入 transcript，bridge 按原文
  capture 后被规则提取器当"用户偏好"入库（08-11 实测 2 条 turn_inference 垃圾，
  已删）。修复为双层净化：①服务端 `captureTurn` 入口统一
  `sanitizeCapturedText`（提取 `<user_query>` 正文、剥离注入块、纯注入则直接跳过）；
  ②bridge 脚本同逻辑客户端先行净化。新增 2 条回归测试（238/238）。

## [0.3.0] - 2026-08-11

### Added
- **Hook architecture（本版本核心）**：安装器自动把生命周期 hook 注册进宿主
  `settings.json`（UserPromptSubmit → 自动 recall 注入上下文；Stop → 自动
  capture/commit），记忆写入与召回从「模型自觉」升级为「机制保障」。桥脚本
  `ops/hooks/leafmem-hooks.mjs` 零依赖、失败静默、超时可调
  （`LEAFMEM_HOOK_RECALL_TIMEOUT_MS` 等），并写 `~/.leafmem/hooks.log` 心跳
  供自检。宿主不触发 hook 时自动回退 SOUL.md 纪律规则。
- **release 包直装**：`ops/build-release.sh` 产出「解压即用」zip（dist 零运行
  时依赖），GitHub Release 附件分发，绕开国内 npm 慢的问题。
- **初始导入扩展为六文件**：SOUL / USER / MEMORY / IDENTITY / AGENTS /
  SYSTEM.md + `memory/` 原生档案全部导入记忆库（此前只导前三个），
  为安装后生成初版用户画像提供原料。

### Changed
- **纪律块置顶写入 SOUL.md**：安装器把记忆工作流块钉在 SOUL.md 顶部（H1
  标题之后），优先级高于其他行为规则；MEMORY.md 回归纯记忆存储。
- **scope 教义落地到写入路径**：宿主驱动的 capture/commit 写入 scope 解析
  改为 repo > agent > project（此前 agent 上下文会落到 project scope，违反
  「日常只有 agent scope」教义）。
- `leafmem-agent update` 兼容 release 安装：无 git 仓库时跳过代码刷新，
  直接幂等重跑 install。
- 纪律块补全 `commit` 必需参数说明（agent/sessionId/rollingSummary）。

### Fixed
- 安装引导的 `LEAFMEM_EMBEDDINGS_BASE_URL` 多写了 `/v1`（代码会自动拼
  `/v1/embeddings`，旧写法导致 `/v1/v1/embeddings` 404）。
- 重装/升级时 `sharedMemory` 未指定会把已配置的共用 scope 重置为宿主自身
  scope（昆仑小智共用安装会被静默拆成两池）；现在保留已有 LEAFMEM_SCOPE_ID。

## [Unreleased-0.2.x]

### Added
- `ops/publish-audit.sh` — publish hygiene audit (blocks API keys, personal
  data, memory dumps, git symlinks, node_modules, marvmem residue). Wired
  into `prepublishOnly` so every `npm publish` is gated by it.
- `.github/workflows/ci.yml` — CI regression gate: type check + full test
  suite + publish hygiene audit on every push/PR to main.
- `CHANGELOG.md` — this file.
- `package.json` — `repository` / `homepage` / `bugs` metadata.

## [0.2.0] - 2026-08-09

### Changed (breaking)
- **MCP surface restructured from 6 tools to 4 closed-loop tools**:
  `memory_write` (remember/commit/task_append/active_distill),
  `memory_recall` (recall/search/get/list/task_window/active_get),
  `memory_organize` (prepare/apply/reflect/profile/decay/calibrate/rebuild),
  `memory_govern` (update/delete/attribute/pin).
- License reverted to proprietary (`UNLICENSED`); THIRD-PARTY-NOTICES.md removed.

### Added
- Console: help-docs page (zero-dep Markdown renderer + TOC + full-text
  search + mermaid rendering), tasks-context page (pagination + right
  drawer), dashboard click-through with preset filters, entity graph
  polish (pre-simulation, inner/outer rings, adjacency highlight).
- README rewritten: system-intro / install-upgrade / usage chapters with
  mermaid architecture diagram and sub-component table.
- `forget()` now prunes dangling `principle.supports` references (every
  deletion path covered at the core).

### Fixed
- User profile was distilled but never injected into recall (dead link).
- `compactToolResult` strips `record.content` only for the `recall` action;
  `search`/`get`/`list`/`task_window`/`active_get` return full records.
- Console html/js/css served with `Cache-Control: no-store`.

## 0.1.x - 2026-08-08

Initial LeafMem releases (brand replacement from upstream fork, dual-host
installer, API-key guided setup, npm distribution). **All 0.1.x versions
were unpublished from npm on 2026-08-09 and superseded by 0.2.0.**

[Unreleased]: https://github.com/xdragonjia/leafmem/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/xdragonjia/leafmem/releases/tag/v0.2.0

