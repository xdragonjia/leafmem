# Changelog

All notable changes to LeafMem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-08-11

### Fixed
- **shared 拓扑下第二宿主导入写错 scope（根因修复）**：install 流程里 MCP 配置走拓扑
  解析（shared → primary scope），但六文件初始导入硬编码宿主自身 scope——shared 的
  昆仑小智安装把 167 条重复导入记录写进 agent:kunlunxiaozhi（内容 100% 已存在于主
  scope 的纯重复死池）。提取共享的 `resolveEffectiveScopeId`，import 与 MCP 同用一
  个解析函数，永不分叉。新增回归测试（shared 第二宿主导入落主 scope、自身 scope 零
  记录），239/239。

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

