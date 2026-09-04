# LeafMem × 昆仑小智 安装引导

> 面向 **昆仑小智**（macOS / Windows 均适用）。
> 本文件由昆仑小智（AI 助手）按步骤执行；**用户只需做三件手动的事**：
> ① 安装 Node.js ② 提供硅基流动 API Key 并点击 MCP 信任 ③ 安装完成后重启一次昆仑小智（让生命周期 hook 生效）。其余全部由昆仑小智完成。
>
> **安装方式**：本 releases 包解压即用（dist 零运行时依赖），**全程不需要 npm**。

---

## 〇、给用户的「引导语」（连同解压后的包发给昆仑小智）

> 请帮我安装并配置 LeafMem 记忆引擎。安装引导文件就在本 releases 包解压目录内的
> `INSTALL-KUNLUNXIAOZHI.md`。请完整读取该文件，严格按其中「昆仑小智执行步骤」
> 逐条执行；需要我手动操作的（安装 Node.js、提供硅基流动 API Key、点击 MCP 信任）
> 请明确提示我。安装完成后按文件末尾的自检清单逐项验证，并把结果告诉我。

---

## 一、用户手动准备（仅 2 步）

1. **安装 Node.js ≥ 22.13**：到 https://nodejs.org 下载对应系统安装包（LTS 即可），安装后在终端运行 `node -v` 确认版本 ≥ 22.13。
2. **申请硅基流动（SiliconFlow）API Key**（免费）：访问 https://cloud.siliconflow.cn 注册，在「API 密钥」页创建一枚 Key（形如 `sk-...`），用于免费的向量化与重排序模型。**Key 只写在你本机配置里，不会上传**。

---

## 二、昆仑小智执行步骤

> 以下每步由昆仑小智执行。Windows 下用户主目录记为 `%USERPROFILE%`（如 `C:\Users\张三`），下文 `~` 均指该目录。
> `<包根目录>` 指本 releases 包解压后的目录（包含 dist/、ops/、README.md 的那一层）。

### 步骤 1 · 运行安装器

在终端执行（一条命令完成：MCP 配置、记忆待蒸馏登记、SOUL.md 纪律置顶、生命周期 hook 注册）：

```bash
node "<包根目录>/dist/bin/leafmem-agent.js" install kunlunxiaozhi --memory isolated
```

> 🔧 **宿主 ≥5.5.1 必读（defer_loading）**：宿主对 mcp.json 中未显式声明
> `defer_loading` 的 MCP server 默认注入 `true`（app.asar 源码证实，与官方文档
> "默认 false"矛盾，属升级回归），会把 leafmem 的 4 个工具转成 deferred 模式、
> 依赖 ToolSearch 检索激活，长会话/自动化会话中易"时有时无"。安装器
> （v0.3.20+）写入 `mcpServers.leafmem` 时已自动带上 `"defer_loading": false`；
> 手工维护 mcp.json 时请保留该字段。

> - 若本机还装了 WorkBuddy、且两宿主要**共用一套记忆**：把上面命令改为
>   `node "<包根目录>/dist/bin/leafmem-agent.js" install kunlunxiaozhi --memory shared`，
>   安装器会自动把 `LEAFMEM_SCOPE_ID` 解析为主 scope（WorkBuddy 与昆仑小智都配置时，
>   主 scope 固定是 `agent:workbuddy`）。安装完成后核对两宿主 mcp.json 的
>   `LEAFMEM_SCOPE_ID` 同为 `workbuddy` 即共用成立。单宿主安装用 `isolated` 即可。
> - 安装器**不再逐行机械导入**六个记忆文件（那会把标题/分隔符/子项拆成碎片，还曾把明文凭证带进记忆库）。
>   它只登记「待蒸馏」状态（`import-state.json` 的 `pending: true`），由你在**步骤 7.5 用 LLM
>   把每个文件蒸馏成几条段落级记忆**写入——这才是初始导入的正确形态。
> - 安装器同时会：把记忆工作流纪律块**置顶写入 `~/.kunlunxiaozhi/SOUL.md`**（H1 标题之后，
>   优先级高于其他行为规则）；把生命周期 hook 合并进 `~/.kunlunxiaozhi/settings.json`
>   （UserPromptSubmit → 自动召回注入上下文；Stop → 自动 capture/commit），并把桥脚本复制到
>   `~/.leafmem/hooks/leafmem-hooks.mjs`。

### 步骤 2 · 写入硅基流动向量化/重排配置（合并，勿覆盖）

目标文件：`~/.kunlunxiaozhi/mcp.json`。读取现有 JSON，把下列 env 键**合并**进
`mcpServers.leafmem.env`（保留安装器写入的其余键，只新增/更新以下 7 项）：

```json
{
  "LEAFMEM_EMBEDDINGS_PROVIDER": "openai",
  "LEAFMEM_EMBEDDINGS_MODEL": "BAAI/bge-m3",
  "LEAFMEM_EMBEDDINGS_BASE_URL": "https://api.siliconflow.cn",
  "OPENAI_API_KEY": "<用户提供的硅基流动 Key>",
  "LEAFMEM_RERANK_URL": "https://api.siliconflow.cn/v1/rerank",
  "LEAFMEM_RERANK_API_KEY": "<用户提供的硅基流动 Key>",
  "LEAFMEM_RERANK_MODEL": "BAAI/bge-reranker-v2-m3"
}
```

> ⚠️ 注意两个 URL 的差别（常见错误）：`LEAFMEM_EMBEDDINGS_BASE_URL` 是
> **不带 `/v1`** 的根地址（LeafMem 内部会自动拼 `/v1/embeddings`）；
> `LEAFMEM_RERANK_URL` 是**完整端点**（含 `/v1/rerank`）。两处 Key 必须先向用户索取再写入。
> JSON 里 `~` 若宿主不展开，请替换为 `%USERPROFILE%` 的实际绝对路径。

### 步骤 3 · 请用户点击 MCP 信任

提示用户：**在昆仑小智的 MCP / 连接器管理页，找到 `leafmem`，点击「信任 / 启用」**，然后重连 MCP。

### 步骤 4 · 安装控制台服务与开机自启

```bash
node "<包根目录>/dist/bin/leafmem-agent.js" service install
```

安装程序按平台自动选择自启机制：macOS → launchd（`com.leafmem.agent.plist`）；
Windows → 任务计划程序 `LeafMemAgent`（登录时启动）。装完执行
`node "<包根目录>/dist/bin/leafmem-agent.js" service status` 确认 installed/running。
控制台地址 = `service url` 输出（本地 127.0.0.1，免 API Key 自动连接）。

### 步骤 5 · 安装每周维护技能

把随包分发的 `leafmem-maintenance` 技能装入昆仑小智技能目录：

```text
源：  <包根目录>/ops/skills/leafmem-maintenance/
目标：~/.kunlunxiaozhi/skills/leafmem-maintenance/
```

整个文件夹复制过去（保留目录结构，确保 `skills/leafmem-maintenance/SKILL.md` 存在），
然后让昆仑小智确认技能列表里能找到 `leafmem-maintenance`。

### 步骤 6 · 创建两个维护自动化

读取本包内两个现成的提示词模板，用昆仑小智的自动化能力各创建一个定时任务：

| 模板 | 节奏 | 作用 |
|------|------|------|
| `<包根目录>/ops/automations/weekly-maintenance.md` | 每周一 04:00 | 深度整理（首次运行自动加载 leafmem-maintenance 技能执行 SOP） |
| `<包根目录>/ops/automations/daily-sentinel.md` | 每日 10:00 | 只读健康哨兵（无异常静默，异常才提醒） |

> 无需任何付费 Key——蒸馏与整理由宿主模型通过 LeafMem MCP 完成。

### 步骤 7.5 · 初始记忆蒸馏（LLM 中介，替代机械导入）

读取用户本地六个记忆文件（SOUL.md / USER.md / MEMORY.md / IDENTITY.md / AGENTS.md / SYSTEM.md），
**用你的语言理解能力把每个文件蒸馏成 1-4 条段落级记忆**，逐条用
`memory_write(action="remember", source="workbuddy_import", kind=principle|preference|lesson|note, tags=["workbuddy","<文件名>"])` 写入。

蒸馏纪律（违反即产生碎片/泄密）：
- 每条是一段完整、自足的话（100-400 字），合并同主题要点；**不要逐行照搬**，不要产出 `---`、孤立标题、半句话。
- 如实转录即可：记忆库是本机专用（仅 127.0.0.1 + API Key 访问），纪律文件里用户自己记录的凭证信息按原样写入；若用户明确不想让某类明文值进记忆库，写入后再按其要求修订该条。
- 写完后把 `~/.leafmem/import-state.json` 中本宿主的 `pending` 置为 `false`（记录 distilledAt）。
- 用户本地无记忆文件时跳过本步（pending 直接置 false）。

> 本步把"读文件→理解→写成记忆"交给宿主 LLM，安装器只做状态登记——这是 2026-08-11
> 对机械逐行导入的替代（机械导入曾产出 300+ 碎片并把明文密码带进记忆库）。

### 步骤 7 · 生成初版用户画像

利用步骤 7.5 蒸馏出的记忆（尤其 USER/SOUL 条目），为 LeafMem 建立第一版用户画像：

1. 昆仑小智读取 `~/.kunlunxiaozhi/` 下的 `USER.md`、`SOUL.md`、`IDENTITY.md`、`MEMORY.md`
   等文件（它们是画像信息最集中的来源），归纳出分节 markdown，每节形如：

   ```markdown
   ## 基本信息
   （称呼、语言、时区、常用环境）

   ## 偏好与习惯
   （沟通风格、输出格式偏好、工具习惯）

   ## 工作与项目
   （职业、当前项目、常用路径约定）
   ```

2. 调用 MCP 写入画像（分节合并语义，之后局部更新不会误删其他节）：

   ```text
   memory_write(action="active_distill", kind="profile", content="<上面归纳的分节 markdown>")
   ```

3. 用 `memory_recall(action="active_get")` 或控制台「洞察」页确认画像已生成。

> 画像内容必须忠实转录用户文件，不要编造；文件里没有的信息留空不猜。

### 步骤 8 · 请用户重启昆仑小智（激活生命周期 hook）

提示用户：**完全退出并重新打开昆仑小智**，让步骤 1 注册的生命周期 hook 生效。
重启后每次对话：提交消息时 hook 自动召回相关记忆注入上下文；回合结束时 hook 自动
capture 本轮要点——记忆的写入与召回由机制保障，不再依赖模型自觉。

> 昆仑小智 5.2.x 及以上版本已实测确认支持用户级 hooks（SessionStart / UserPromptSubmit /
> Stop / SessionEnd 事件均触发）。若极个别版本不触发，桥脚本会静默空转，
> SOUL.md 纪律规则继续兜底（功能不受影响，只是退回"模型按规则调用"模式）。

### 步骤 9 · 自检（验收清单，最后执行）

昆仑小智依次验证并向用户报告每一项的结果：

1. **MCP 连通**：`memory_recall(action="recall", message="连通性测试")` 正常返回。
2. **写入闭环**：`memory_write(action="remember", content="LeafMem 安装自检通过", kind="note")`
   写入成功，再 recall 能命中；确认后删除该测试记忆。
3. **向量化+重排生效**：硅基流动 Key 已写入时，召回结果带向量加权与交叉编码器重排（控制台/状态可见 embedding 与 rerank 生效）。
4. **纪律置顶**：`~/.kunlunxiaozhi/SOUL.md` 顶部（H1 之后）含 `leafmem-agent-instructions` 块；
   `MEMORY.md` 中无该块残留。
5. **初始导入（蒸馏）**：控制台能看到 `source=workbuddy_import` 的**段落级**记录（每文件 1-4 条，
   无 `---`/孤立标题类碎片；记录落在宿主自身 scope 如 `agent:workbuddy`，不是 project scope）。
6. **用户画像**：`memory_recall(action="active_get")` 返回的 profile 非空。
7. **hook 已注册**：`~/.kunlunxiaozhi/settings.json` 的 `hooks` 含 UserPromptSubmit 与 Stop
   两项，命令均指向 `~/.leafmem/hooks/leafmem-hooks.mjs`。
8. **hook 桥连通**：终端执行（跨平台，无需管道）
   `node ~/.leafmem/hooks/leafmem-hooks.mjs self-test --agent kunlunxiaozhi`
   （共用拓扑下 scope 为主 scope id，如 workbuddy，则换成对应值），
   输出 `self-test OK` 即通过；`~/.leafmem/hooks.log` 有新增心跳行。
   用户重启昆仑小智后的真实对话若持续产生心跳，说明宿主真正触发了 hooks；
   若始终无新心跳，按步骤 8 的版本说明降级使用（不报错）。
9. **技能可见**：技能列表能找到 `leafmem-maintenance`。
10. **自动化就绪**：每周维护与每日哨兵两个定时任务均已创建。
11. **服务自启**：`service status` 显示 installed 且 running。

---

## 三、升级（拿到新版 release 包时）

解压新包后执行（release 安装无需 git/npm，安装器会幂等重跑配置；记忆库不受影响）：

```bash
node "<新包根目录>/dist/bin/leafmem-agent.js" update kunlunxiaozhi
```

## 四、平台说明（macOS / Windows 体验一致）

- **核心记忆 / MCP / 控制台双平台可用**：SQLite 用 Node 22 内置 `node:sqlite`，**零原生依赖**，无需编译。
- **开机自启双平台对齐**（安装程序自动选择机制，无需用户操心）：
  - macOS → launchd（`com.leafmem.agent.plist`）
  - Windows → 任务计划程序（`LeafMemAgent`，登录自启）
- 两者均实现「开机/登录后自动启动控制台 + 崩溃自恢复」。

## 五、故障排查

| 现象 | 处理 |
|------|------|
| recall 报「连接失败」 | 确认已点 MCP 信任并重连；确认 `args` 里是 `<包根目录>/dist/bin/leafmem-mcp.js` 的绝对路径 |
| 召回无向量加权 | 检查硅基流动 Key 是否已填；`LEAFMEM_EMBEDDINGS_BASE_URL` 必须是 `https://api.siliconflow.cn`（**不带 /v1**） |
| `node:sqlite` 报错 | Node 版本 < 22.13，升级 Node |
| 写入报 scope 错误 | 保持不传 scopeType/scopeId，走 mcp.json 里配置的默认 scope（shared 拓扑下为 `agent:workbuddy`，isolated 下为 `agent:kunlunxiaozhi`） |
| hook 无心跳（重启后） | 查 `~/.leafmem/hooks.log` 是否为空；为空说明该宿主版本未触发 hooks，SOUL.md 纪律兜底，功能不受影响 |
| hook 拖慢消息提交 | 语义召回含远程 embedding+rerank，默认 8 秒超时；可在 hook 命令的 env 中设 `LEAFMEM_HOOK_RECALL_TIMEOUT_MS`（调小）或 `=0`（关闭 hook 召回，仅保留 Stop 自动 capture） |
