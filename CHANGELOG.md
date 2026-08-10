# Changelog

All notable changes to LeafMem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

