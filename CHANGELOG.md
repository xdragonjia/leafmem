# Changelog

All notable changes to LeafMem are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.21] - 2026-09-04

### Added
- **leafmem-cli 主动加载通道**：新增 `ops/leafmem-cli.sh`（12 子命令：health/recall/inspect-recall/remember/get/list/update/delete/stats/scopes/task-detail/commit-summary），封装 launchd 常驻 agent service 的 HTTP API（127.0.0.1:3377），独立于宿主 MCP 工具注册。安装/升级时自动部署到 `~/.leafmem/leafmem-cli.sh`（hooks.ts 新增 `installLeafmemCli`）。
- **SOUL 模板新增自动化降级链纪律**：`workBuddyInstructionBlock` 增加 "Automation active-loading channel" 条款——自动化会话读写 LeafMem 必须按 ①直连 MCP 工具 → ②leafmem-cli HTTP → ③宿主会话搜索 三级降级；①失败不得默认"环境差异"静默放过，须记录并取证宿主回归。所有用户新安装/`leafmem-agent update` 升级自动获得。

### Fixed
- **自动化会话 leafmem 工具不可用根因修复（宿主回归免疫层）**：WorkBuddy 5.5.1 对自定义 MCP 的 `--mcp-config` 注入即使包含完整配置且 stdio 连接成功（`doConnect OK`），仍无视 `defer_loading:false`、工具强进 deferred 索引后漏收，致自动化会话零 `mcp__leafmem__*` 工具（2026-09-04 日志实证：`Indexing deferred tools for server: leafmem` + 会话工具列表无 leafmem）。5.5.3 已修复字段尊重，但宿主升级可能回归；本版本提供 HTTP 通道作为不受宿主注册影响的保底链路。
- **leafmem-cli 含空格长文本被静默截断（2026-09-06 修复，数据损坏级）**：`ops/leafmem-cli.sh` 中 4 处向 Python 传参写作未加引号的 `${@:-}`（recall 行 67 / remember 行 98 / list 行 122 / update 行 148），shell 词分割会把 `--content "长文本 含空格"` 拆成多个独立参数，Python 侧 `a[i+1]` 只取到第一个词——**所有含空格的长文本字段被静默截断为首 token，无报错、无警告**。实测暴露：`update <id> --content "<699 字符>"` 回读后 content 仅剩 `2026-09-06`（10 字符）。全部改为 `${@+"$@"}`（仅当 `$@` 已设置才展开且保留引号语义，同时兼容 macOS 自带 bash 3.2 在 `set -u` 下的空 `"$@"` 展开）。验证三项：①`health`（空 `$@` 场景）exit=0，`set -u` 兼容性未破坏；②`update --summary "<84 字符含空格>"` 回读长度完整；③被截断的存量记录经 MCP `memory_govern(action=update)` 修复（content 699 字符 / tags 9 项 / kind、importance 完整）。
  - 影响范围：本缺陷自 0.3.21 引入 `leafmem-cli.sh` 起存在于所有 4 个写/查子命令的**可选参数透传路径**（位置参数 `$1`-`$5` 因带引号不受影响，故 recall/remember 的主文本正常、仅 `--tags`/`--metadata` 等尾部可选项及 update/list 全量参数受害）。0.3.21 未发布 npm（registry latest 仍为 0.3.19）也未打 tag，故本修复并入 0.3.21 而非另起 0.3.22。
  - 🔴 **升级用户须注意**：`installLeafmemCli()` 每次安装/升级会无条件 `copyFile` 覆盖 `~/.leafmem/leafmem-cli.sh`，因此只手工修本地副本会在下次 `leafmem-agent update` 时被回滚——修复必须落在仓库 `ops/leafmem-cli.sh`（本次已落）。
  - 泛化纪律：用 CLI 写含空格长文本后必须**回读校验字段长度**，不能只看退出码；CLI 与 MCP 两通道互为备份（本次即由 MCP 修复 CLI 损坏的数据）。

### Changed
- **自动化通道定版 CLI-first**：一次性自动化实测（2026-09-04 晚）证明自动化调度会话中 `mcp__leafmem__*` 工具恒 absent（5.5.1/5.5.3 一致，deferred 索引寻址失效），HTTP CLI 由降级备胎升格为**主通道**。SOUL 模板条款、daily-sentinel / weekly-maintenance 两个产品 SOP、README 1.7 全部改为 CLI-first：自动化首选 leafmem-cli；MCP 工具恰在函数表时可顺带直调，缺席属预期、不判异常、不静默重试。
- **leafmem-cli 字段面补全**：`remember` 新增 `--tags/--confidence/--source/--metadata`（tags 缺失被一次性验证任务实测暴露）；`update` 新增 `--tags/--metadata`；`list` 新增 `--tags/--cursor`；`recall` 新增 `--task-title/--tool-context`。全部字段对齐 HTTP 路由支持面，E2E 验证 tags 写入→读回→list 过滤→更新全链路。规避 macOS 系统 bash 3.2 下 `set -u` 空 `"$@"` 崩溃的兼容问题（当时采用 `${@:-}` 写法；🔴 该写法本身引入词分割缺陷，已于 2026-09-06 改为 `${@+"$@"}`，详见上方 Fixed）。
- `ops/automations/daily-sentinel.md` canary 段同步三级降级链与宿主回归取证命令。

## [0.3.20] - 2026-09-04

### Fixed
- **WorkBuddy/KLXZ ≥5.5.1 defer_loading 回归免疫**：宿主对 mcp.json 中未显式声明 `defer_loading` 的 MCP server 默认注入 `true`（app.asar `buildDesiredConfigs` 源码证实，与官方文档"默认 false"矛盾，属 5.5.1 升级回归），导致 leafmem 4 个工具转 deferred 模式、依赖 ToolSearch 检索激活，长会话/自动化会话中"时有时无"并两次引发"LeafMem 不可用"误判（2026-09-03/04）。安装器 `writeJsonMcpConfig` 现写入 `mcpServers.leafmem` 时固定带 `"defer_loading": false`（显式 boolean 被宿主尊重、工具直连注册），`setMemoryTopology` 同步自愈确保既有条目也被纠正——重装/升级/拓扑切换均不再复发。

### Changed
- `INSTALL-WORKBUDDY.md` / `INSTALL-KUNLUNXIAOZHI.md` 步骤 1 新增 defer_loading 必读说明（背景、安装器自动写入、手工维护须保留该字段、核对方法）。

## [0.3.19] - 2026-09-03

### Added
- **周度观察并入每周深度整理**：原开发期「周度观察+飞书提醒」任务到期下线，其持久机制并入每周维护——`ops/automations/weekly-maintenance.md` 新增 B 段周度观察（采集+周环比五项判断）与周报输出；`leafmem-maintenance` 技能升至 1.3.0 新增步骤 10 周度观察 + 步骤 11 周报口径。
- **observation.py 随包分发**：`ops/observation.py` 加入 npm `files`，其他用户安装后可直接使用周度观察采集脚本。
- **实体词表巡检机制**：`leafmem-maintenance` 技能升至 1.4.0——周度观察判断清单新增 f 项（entity_count 停滞检测：记忆增长但实体连续 2 周零增长 = 词表陈旧信号），新增步骤 11 实体词表巡检。起因：strict 抽取器下实体增长完全依赖词表人工更新，本机实测 leafmem 本身在 145 条记忆中出现却因不在词表而无实体。
- **ops/entity-relink.mjs 随包分发**：词表更新后的存量记忆纯增量补链脚本（幂等三接口只加不删，--dry 精确预估，LEAFMEM_DB 可覆盖库路径）。

### Fixed
- **知识图谱实体关联"大量重复"**：实体详情面板与力导向图按"实体对"聚合（原按记忆逐行显示——数据层零真重复，2707 行关系实为 712 个实体对 × 各自记忆）。面板显示共现次数徽标（×N），图谱边带 weight，边数 2707→703，节点度数与边宽不再灌水。

### Changed
- **observation.py scope 通用化**：原硬编码 `SCOPE="workbuddy"` 改为自动探测主 scope（记录数最多的 agent scope，与主 scope 模型一致），可用环境变量 `LEAFMEM_SCOPE` 覆盖，确保任意宿主用户可正确采集。

## [0.3.18] - 2026-08-13

### Fixed
- **画像卡间距**：dashboard 用户画像卡片加 margin-top 16px，与 grid2 卡片间距一致。
- **详情浮窗半透明**：drawer 背景改 rgba(255,255,255,.92) 实色+毛玻璃模糊，不再透字。
- **任务详情固定文字溢出**：底部说明文字 white-space normal+wrap，不再溢出屏幕。
- **图谱视觉打磨**：节点发光+白描边、边按连接强度变粗、hover 浮窗圆角玻璃底。

## [0.3.17] - 2026-08-13

### Changed
- **console 全面换肤为玻璃拟态（V2-glass，用户选定）**：浅色渐变背景+光斑
  装饰、毛玻璃侧边栏（backdrop-filter）、卡片/KPI 毛玻璃浮层+hover 抬起
  动效。仅视觉层，页面结构/逻辑/条件渲染零改动。
- **侧边栏加三组导航分类**：概览（仪表盘/记忆浏览/任务上下文/召回检查）、
  治理（洞察/知识图谱/事件日志）、系统（宿主接入/帮助文档）。

## [0.3.16] - 2026-08-12

### Fixed
- **翻页闪回顶部**：renderPage 渲染后恢复滚动位置（keepScroll 助手），
  洞察原则/记忆浏览/任务/事件四处翻页均不再跳顶（浏览器实测 scroll 保持）。
- **切页页码残留**：goPage 切走时重置 explorer/tasks/events/principles 四个
  页码（与 recallQuery 同纪律），切回即第一页（实测第3页→切走→返回第1页）。
- **事件时间列**：第一列改完整日期时间（2026-08-12 23:09），翻页可辨日。
- **任务详情时间**：浮窗加「创建 · 更新」完整日期时间行。

## [0.3.15] - 2026-08-12

### Fixed
- **记忆浏览横向溢出**：长不可断字符串（路径/token）撑宽表格超出页面背景。
  table-layout:fixed + overflow-wrap:anywhere，浏览器实测异常页无横向溢出。

### Changed
- **洞察页重设计**：用户画像改整宽卡片、分节按逻辑排序（身份→偏好→习惯→
  约束→环境）双列卡片；蒸馏原则改记忆浏览式交互——分页（8/页）+ 就地展开
  全文（不再闪回顶部、不再只显示标签）。PrincipleView 增加 content 全文。
- **事件日志翻页**：/v1/events 支持 offset+total（recent() 返回
  {events,total}），页面 50/页可翻全量（审计保留 2000 条，页面明示）。

## [0.3.14] - 2026-08-12

### Fixed
- **门禁无 sessionStartAt 时静默失效**（完整验收 v0.3.12 时发现）：countAgentWrites
  旧回退"无数话起点则数任何历史写入"，对长期账户恒>0→门禁永远放行。现回退为
  保守 2h 窗口近似"本会话"。实测三态矩阵正确（BLOCK/问号豁免/近期有写放行）。

### Added
- **console 任务页删除按钮**：详情浮窗「删除该任务上下文」+列表 DELETE
  /v1/tasks?id= 路由（两段 confirm，级联清除 transcript/摘要，不影响记忆记录）。
  浏览器实测全流程通过（按钮→确认文案→列表消失→浮窗关闭→DB 归零）。

## [0.3.13] - 2026-08-12

### Added
- **任务删除通道**：此前任务只能 completed/archived，测试探针等噪音任务
  永久可见（用户截图发现 probe4/probe5）。现：
  - store（Sqlite 级联 FK + InMemory）与 manager 增加 `deleteTask`；
  - MCP `memory_write(action="task_delete", taskId)`；
  - 删除不存在的任务返回 `deleted:false`（干净语义，非报错）。

### Tests
- 删除级联回归（InMemory）+ 真实 MCP stdio 端到端（真库创建→删除→零残留）；
  连带影响扫描（events/capture-state/tmp）全绿。281/281。

## [0.3.12] - 2026-08-12

### Added
- **SessionStart hook（会话预热）**：新会话注入进行中的任务上下文
  （active/paused 任务+rolling_summary），跨会话续接从"用户口述"变"自动恢复"；
  无在途任务静默跳过。`/v1/tasks` 列表路由补 rolling_summary（LEFT JOIN
  state 表）。双宿主注册（install 器 events 数组加 SessionStart）。
- **Stop 门禁问号豁免**：`last_assistant_message` 以 ?/？ 结尾（回合未完结、
  等用户输入）不拉回——借鉴 workbuddy-buddy ends_with_question 信号
  （其 spool 实测 1/6 Stop 为 True）。

### Changed
- **stdin 限读**：hook 输入超 1MB 整包丢弃 fail-open（与 buddy 同纪律，防
  异常 payload 拖垮/撑爆 hook）。

### Docs
- 桌宠研究报告 v1.5：未竟观测三项补全 + buddy 源码再读 + 实施记录。

## [0.3.11] - 2026-08-12

### Fixed
- **事件数据未转义吞掉整块 DOM（含画像卡）**：仪表盘「最近活动」与事件页对
  事件 data 的字符串值未 esc；08-12 01:50 的 recall 事件 query 恰为含
  `<!-- … -->` 标记的自动化 prompt，裸 `<!--` 注入 innerHTML 后把后续全部
  DOM（画像卡）吞进注释节点——卡片不是没渲染，是被 HTML 注释"埋葬"。
  两处 `tl-data` 渲染补 esc。浏览器实测画像卡恢复、comment 节点归零。

## [0.3.10] - 2026-08-12

### Fixed
- **仪表盘画像卡静默消失**：08-10 前 console 的 localStorage 存裸 scope 值
  （`workbuddy` 无 `agent:` 前缀），governance 落到空 project scope 找不到画像，
  卡片三元 else 为空串→整块消失且无提示。现：scope-context 裸值映射
  agent:<值>；console 读取时归一；卡片 else 分支显示占位说明（不再静默消失）。
- **备份链路断链修复**：已部署 launchd plist 仍指向已移除的旧外部路径
  （08-11 23:30 与 08-12 03:15 备份失败）。从仓库模板重新部署
  com.leafmem.sqlite-backup.plist，立即补备，launchd 健康。

## [0.3.9] - 2026-08-12

### Changed
- **时间存储与展示统一**（行业标准：存 UTC、显式时区渲染）：
  - 存储与 API：全部时间戳统一为 ISO 8601 UTC 字符串；task 族表由 epoch-ms
    INTEGER 迁移（`migrateTaskTimestampsToIso`，开库即跑、幂等）；DDL 改 TEXT；
    读取侧 `isoOrEpoch` 防御性归一。
  - console：单一 fmtDate/fmtTime/fmtDateTime 入口，基于
    `Intl.DateTimeFormat(timeZone:'Asia/Shanghai')`——所有页面时间一律北京
    时间，不随浏览器时区、不显示裸 UTC。此前「有的 UTC 有的本地」的混乱消除。
  - ARCHITECTURE.md 新增 Time Convention 章节。

## [0.3.8] - 2026-08-12

### Fixed
- **启发式质量底线**：净化后的 transcript 残余「.」通过 preference 线索被存成
  内容为「.」的记忆（KLXZ 自动化会话事故）。现 `inferMemoryProposals` 过滤无
  实质内容的 proposal（去标点后≥6 字符才算实质）。
- **门禁 block 指令点名未关闭任务**：0.3.6 门禁正确拉回 agent 后，agent 仍可能
  做裸 task_append（无 rollingSummary/status），任务页保持 active 无 summary。
  通用③④依赖 agent 自觉。现 block 时查询本会话有新进度
  （updated_at≥sessionStartAt）且未 completed/archived 的任务，点名加入指令⑤，
  要求逐条闭环。

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

