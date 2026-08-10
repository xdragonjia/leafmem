# ops/ — LeafMem 运维脚本（产品化收编，2026-08-10）

此前这些脚本散落在 `~/WorkBuddy/scripts/` 与 `~/WorkBuddy/backups/`，
不在 git 版本控制内。收编后 **本目录是唯一事实源**，部署位置用软链接，
改这里即改全部（自动化/launchd 引用的路径不变）。

| 文件 | 职责 | 调度方 |
|------|------|--------|
| `consolidation.js` | v8.1 记忆整理：去重合并、importance 升标、experience 蒸馏、删除后级联清理 supports、镜像同步 | 每周自动化「LeafMem 每周健康检查+深度整理」 |
| `observation.py` | 只读治理指标采集 + 告警（含 supports 断链检测） | 每日观测/周度观察自动化 |
| `mirror-sync.js` | 导出全量记忆到 backups/leafmem-mirror/（MCP 降级兜底） | consolidation 自动调用；可手动跑 |
| `sqlite-backup.sh` | SQLite 每日 .backup + 7 天轮转 | launchd 每日 03:15 |
| `launchd/com.dragon.leafmem-sqlite-backup.plist` | 备份任务的 launchd 模板 | 部署于 ~/Library/LaunchAgents/ |
| `launchd/com.leafmem.agent.plist.template` | 常驻服务 plist 模板（Key 为占位符，不入库） | install-agent-plist.sh 注入后部署 |
| `launchd/install-agent-plist.sh` | 从模板注入 mcp.json 中的 API Key 并 bootstrap 服务 | 手动执行 |

## 部署位置（软链接，勿在部署位置直接改文件）

```
~/WorkBuddy/scripts/leafmem_consolidation.js  → ops/consolidation.js
~/WorkBuddy/scripts/leafmem_observation.py    → ops/observation.py
~/WorkBuddy/scripts/leafmem_sqlite_backup.sh  → ops/sqlite-backup.sh
```

## 历史教训（2026-08-10 审计发现）

1. **镜像断链**：旧 `backups/marvmem-mirror/sync.js` 仍 import
   `projects/marvmem` 并读 `~/.marvmem/memory.sqlite`（冻结在 730 条），
   导出的镜像与活库（753+）悄悄分叉，而 SOUL.md 承诺的降级路径
   `backups/leafmem-mirror/` 根本不存在。→ 由 `mirror-sync.js` 修复。
2. **脚本无版本控制**：v8.1 级联清理等改动没有 git 历史可查。→ 收编入仓库。
3. **教训：产品化后任何支撑性脚本/配置都必须入仓库**；部署位置用软链或
   模板，避免"仓库一份、外面一份、互不知道"的漂移。
