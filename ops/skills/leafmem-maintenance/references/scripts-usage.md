# 脚本与工具用法手册

> 🔴 **何时读**：需要知道某个脚本的完整参数、输出字段、退出码时读本文件。SKILL.md「参考文件」区只留一行职责摘要。
> 🔴 **全为只读脚本**（`archive_dump.py` 以 `file:...?mode=ro` 打开 sqlite），绝不写删；删除/整合动作一律经 MCP 在 SKILL.md 对应步骤执行。

## 目录
- [scripts/stale_task_sweep.py](#scriptsstale_task_sweeppy)
- [scripts/archive_dump.py](#scriptsarchive_dumppy)
- [scripts/weekly_scan.py](#scriptsweekly_scanpy)
- [scripts/leafmem_mcp_call.py](#scriptsleafmem_mcp_callpy)
- [ops/mirror-sync.js](#opsmirror-syncjs)
- [ops/observation.py](#opsobservationpy)
- [ops/entity-relink.mjs](#opsentity-relinkmjs)
- [ops/consolidation.js（历史·不可运行）](#opsconsolidationjs历史不可运行)

## scripts/stale_task_sweep.py

🔴 残留任务闭环清扫扫描器（2026-10-02 新增，只读、零 LLM 依赖）。

- **用法**：`python3 scripts/stale_task_sweep.py [--hours 24] [--json]`
- **输出**：超龄（默认 ≥24h，`--hours` 可调）未闭环任务 + 末条 entry 摘要 + 非法状态值检测（合法枚举 `active/paused/completed/archived`）。
- **退出码**：`0`=无残留 ｜ `2`=有残留需闭环 ｜ `1`=错误。
- **闭环动作不走本脚本**，由宿主判读后经 `leafmem-cli task-append` 执行。

## scripts/archive_dump.py

🔴 全量存档导出器（2026-10-05 新增，**步骤 3 强制检查点的标准实现**，只读 sqlite 绝不写入）。

- **用法**：`python3 scripts/archive_dump.py [输出路径]`
- **默认落点**：`~/WorkBuddy/backups/02mem/leafmem-archive/leafmem-archive-YYYYMMDD.json`
- **行为**：以 `file:...?mode=ro` 只读打开 `~/.leafmem/memory.sqlite`，导出 `scope=agent:workbuddy` 全量 `memory_items`（tags_json / metadata_json 两列自动解回为 tags / metadata 对象）并**回读校验**条数。
- **输出五项**：`ITEMS / ALL / FTS / SIZE / VERIFY`。**`VERIFY=OK` 才算存档可用。**

## scripts/weekly_scan.py

🔴 周维护量化扫描器（2026-09-21 新增，只读、零 LLM 依赖）。一次输出五类信号：

| 类别 | 内容 |
|---|---|
| ① 真重复 | 全文规范化 SHA256（技能 NEVER 规则禁用前缀聚类） |
| ② 碎片簇候选 | + **簇内 3-gram 凝聚度 maxJac**（仅 ≥0.55 判真碎片簇） |
| ③ 跨日近重复 | 3-gram 倒排索引，1800+ 条秒级（朴素 O(n^2) 全量集合交集会跑不动） |
| ④ 超长/畸形条目 | `content > 4000` 字符（`content == summary` 记号畸形体） |
| ⑤ 蒸馏候选 | 近 30 天 lesson 按 tag 聚类 ≥3 + 现有 principle 覆盖清单 + **supports 断链检查** |

- **用法**：`python3 scripts/weekly_scan.py [--json] [--days 30]`

## scripts/leafmem_mcp_call.py

🔴 MCP stdio 通道调用器（2026-09-14 新增）：用于调用 HTTP 面未暴露的 MCP 动作（`active_distill` / `organize` 类）。

- **用法**：`python3 scripts/leafmem_mcp_call.py <tool> '<args JSON>'`
- **例**：`python3 scripts/leafmem_mcp_call.py memory_organize '{"action":"decay","dryRun":false}'`
- 详细机制与鉴权见 `mcp-channels.md`。

## ops/mirror-sync.js

镜像同步脚本（步骤 9 标准实现）。

- **用法**：`node ~/projects/leafmem/ops/mirror-sync.js`（默认写 `~/.leafmem/mirror`，可 `--mirror-dir` 覆盖）。
- 🔴 **安装目录口径 = `~/projects/leafmem`**；旧文所记 `npm root -g/@xdragonjia/leafmem` 下**无 ops/ 与任何脚本**（2026-10-11 实测，按旧路径执行会报「脚本缺失」）。
- 🔴 2026-10-11 实测：该镜像**未被任何周期性任务覆盖**，本轮前已 6 天未刷新（2,069 vs 库内 2,171，差 102 条）—— 降级兜底会失真，需评估并入周维护常态化触发。

## ops/observation.py

周度观察采集脚本（零 LLM 依赖，约 20 项治理指标 + ALERT/WARN/INFO 判定）。

- **用法**：`python3 ~/projects/leafmem/ops/observation.py --mode weekly`
- **日志**：`~/.leafmem/observation/leafmem-observation-log.jsonl`（自动追加）
- **scope**：自动探测主 scope，环境变量 `LEAFMEM_SCOPE` 可覆盖。

🔴 **`profile_sections` 是子串计数口径，会比真值多算**（2026-10-05 实测：脚本报 28、治理接口解析真值 27）。根因＝`observation.py` 用 `content.count("## ")` 数分节，正文里任何 `## ` 字面示例（如「晶体来源文档规范」节内）都被计成额外一节。

> **引用画像分节数以治理接口 `/v1/governance?scope=agent:workbuddy` 解析出的 sections 数组长度为准**，脚本值只作环比趋势用；二者差 1–2 不算异常（差值突然变大才需查正文是否新插入了标题字面量）。

## ops/entity-relink.mjs

存量记忆补链（步骤 11 用）。

- **用法**：`node ~/projects/leafmem/ops/entity-relink.mjs --dry` 预估后再正式跑。
- 纯增量幂等三接口，**只加不删**；🔴 **跑前备份 `memory.sqlite`**。

## ops/consolidation.js（历史·不可运行）

⚠️ **历史脚本**，硬依赖已移除的 `DEEPSEEK_API_KEY`，**不可运行**；仅作存档参考。去重职责已由本技能步骤 4 承担。