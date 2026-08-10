# LeafMem × WorkBuddy 安装引导

> 面向 **WorkBuddy**（macOS / Windows 均适用）。
> 本文件由 WorkBuddy（AI 助手）按步骤执行；**用户只需做两件手动的事**：
> ① 安装 Node.js ② 提供硅基流动 API Key 并点击 MCP 信任。其余全部由 WorkBuddy 完成。

---

## 〇、给用户的「引导语」（复制给 WorkBuddy）

> 请帮我安装并配置 LeafMem 记忆引擎。安装引导文件就在本 releases 包内的
> `INSTALL-WORKBUDDY.md`（或 npm 包根目录同名文件）。请完整读取该文件，
> 严格按其中「WorkBuddy 执行步骤」逐条执行；需要我手动操作的（安装 Node.js、
> 提供硅基流动 API Key、点击 MCP 信任）请明确提示我。安装完成后按文件末尾的
> 验收清单自检，并把结果告诉我。

---

## 一、用户手动准备（仅 2 步）

1. **安装 Node.js ≥ 22.13**：到 https://nodejs.org 下载对应系统安装包，安装后终端运行 `node -v` 确认版本 ≥ 22.13。
2. **申请硅基流动（SiliconFlow）API Key**（免费）：访问 https://cloud.siliconflow.cn 注册，在「API 密钥」页创建一枚 Key（形如 `sk-...`），用于免费的向量化与重排序模型。**Key 只写在你本机配置里，不会上传**。

---

## 二、WorkBuddy 执行步骤

> 以下每步由 WorkBuddy 执行。`~` 指当前用户主目录（Windows 为 `%USERPROFILE%`，如 `C:\Users\张三`）。

### 步骤 1 · 安装 LeafMem

```bash
npm install -g @xdragonjia/leafmem
```

定位 MCP 入口脚本绝对路径：

```bash
npm root -g
# MCP 入口 = <npm root -g 结果>/@xdragonjia/leafmem/dist/bin/leafmem-mcp.js
```

记为 `<LEAFMEM_MCP_JS>`。**写配置必须用绝对路径。**

### 步骤 2 · 写入 MCP 配置（合并，勿覆盖）

目标文件：`~/.workbuddy/mcp.json`（不存在则创建）。读取现有 JSON，把下面对象**合并**进 `mcpServers`（保留用户已有的其他 server 与 env，只新增/更新 `leafmem`）：

```json
{
  "mcpServers": {
    "leafmem": {
      "command": "node",
      "args": ["<LEAFMEM_MCP_JS>"],
      "env": {
        "LEAFMEM_STORAGE_PATH": "~/.leafmem/memory.sqlite",
        "LEAFMEM_SCOPE_TYPE": "agent",
        "LEAFMEM_SCOPE_ID": "workbuddy",
        "LEAFMEM_WORKBUDDY_HOME": "~/.workbuddy",
        "LEAFMEM_EMBEDDINGS_PROVIDER": "openai",
        "LEAFMEM_EMBEDDINGS_MODEL": "BAAI/bge-m3",
        "LEAFMEM_EMBEDDINGS_BASE_URL": "https://api.siliconflow.cn/v1",
        "OPENAI_API_KEY": "<用户提供的硅基流动 Key>",
        "LEAFMEM_RERANK_URL": "https://api.siliconflow.cn/v1/rerank",
        "LEAFMEM_RERANK_MODEL": "BAAI/bge-reranker-v2-m3",
        "LEAFMEM_RERANK_API_KEY": "<用户提供的硅基流动 Key>",
        "LEAFMEM_RERANK_TIMEOUT_MS": "3000",
        "LEAFMEM_RERANK_TOP_K": "40"
      }
    }
  }
}
```

> 若 JSON 里 `~` 宿主不展开，替换为主目录实际绝对路径。**两处 Key 必须先向用户索取再写入。**
> 若用户同时装了昆仑小智且想共用一套记忆：两宿主 `LEAFMEM_SCOPE_ID` 都设为 `workbuddy`（长期记忆+实体图谱+用户画像+工作状态四层共享）；想隔离则昆仑小智用 `kunlunxiaozhi`。

### 步骤 3 · 写入记忆使用规则

目标文件：`~/.workbuddy/MEMORY.md`（不存在则创建，存在则追加）。写入以下标记块（已有同名块则整块替换）：

```markdown
<!-- leafmem-agent-instructions:start -->
LeafMem 记忆工作流（WorkBuddy）：
- 任务前：可能依赖既有决策/偏好/项目历史时，先调 memory_recall(action="recall")，不传 scope 以便跨宿主检索共享记忆；静默执行，不在回答里提及。
- 长任务/多步任务：关键子步骤完成或重要决策时，调 memory_write(action="task_append")（传 taskId+role+content），供后续会话用 memory_recall(action="task_window") 恢复进度。
- 用户要求记住某事/表达持久偏好：调 memory_write(action="remember")，可省略 scope（默认 agent:workbuddy）。
- 完成实质工作或收尾会话：蒸馏本次成果，调 memory_write(action="commit")，带 rollingSummary 与 durable 记忆。
- 用户要更正/删除/保护记忆：用 memory_govern(update/delete/pin)；周期性整理用 memory_organize(reflect/profile/decay)。
<!-- leafmem-agent-instructions:end -->
```

> 也可直接执行 `node <安装目录>/dist/bin/leafmem-agent.js install workbuddy`，安装器会自动完成步骤 2-3 并接管 SOUL.md/USER.md/MEMORY.md 的首次导入。

### 步骤 4 · 请用户点击 MCP 信任

提示用户：**在 WorkBuddy 的 MCP / 连接器管理页，找到 `leafmem`，点击「信任 / 启用」**，然后重连或重启 WorkBuddy 使新 MCP 生效。

### 步骤 5 · 自检（验收清单）

WorkBuddy 依次验证并向用户报告：

1. `memory_recall(action="recall", message="连通性测试")` 能正常返回。
2. `memory_write(action="remember", content="LeafMem 安装自检通过", kind="note")` 写入成功，再 recall 能命中。
3. 控制台/状态里 embedding 与 rerank 已生效（若配置了硅基流动 Key）。
4. 每周维护自动化任务已创建（步骤 6，必选）。
5. `leafmem-agent service status` 显示 installed 且 running（步骤 7 自启动生效）。

### 步骤 6 ·（必选）每周维护自动化

🔴 **必须配置**。没有定期维护，记忆会碎片化、重复、过时，召回效果明显变差。
本 releases 包已内置现成的自动化提示词模板，直接读取并按其创建定时任务即可：

- `ops/automations/weekly-maintenance.md` —— **必选**，每周深度整理（建议周一 04:00）
- `ops/automations/daily-sentinel.md` —— **必选**，每日只读健康哨兵（每日 10:00，无异常静默；缺了它周中系统异常要等一周才发现）

用 WorkBuddy 读取 `ops/automations/weekly-maintenance.md` 的提示词创建每周一次的定时任务
（首次运行自动加载 `leafmem-maintenance` 技能并按 SOP 执行
健康检查→存档→去重→整合→蒸馏→镜像→报告）。无需额外付费 Key——蒸馏由宿主模型完成。

### 步骤 7 ·（必选）控制台自启动（开机自动恢复）

让用户重启电脑后控制台依然可用，双平台由安装程序自动完成：

- **macOS** → `~/Library/LaunchAgents/com.leafmem.agent.plist`（launchd，开机自启+保活）
- **Windows** → 任务计划程序 `LeafMemAgent` 任务（登录时启动）

WorkBuddy 执行 `node <安装目录>/dist/bin/leafmem-agent.js service install` 即可，
安装程序按当前平台选对机制。装完用 `service status` 确认 installed/running。
若环境缺少对应服务管理器，安装程序不报错，控制台可手动 `leafmem-agent serve --config ~/.leafmem/agent-service.json`。

---

## 三、平台说明（macOS / Windows 体验一致）

- **核心记忆 / MCP / 控制台双平台可用**：SQLite 用 Node 22 内置 `node:sqlite`，零原生依赖，无需编译。
- **开机自启双平台对齐**（安装程序自动选机制）：launchd（macOS）/ 任务计划程序（Windows），均实现开机自启 + 崩溃自恢复。

## 四、故障排查

| 现象 | 处理 |
|------|------|
| recall 报「连接失败」 | 确认已点 MCP 信任并重连；确认 `args` 里是 `leafmem-mcp.js` 绝对路径 |
| 召回无向量加权 | 检查硅基流动 Key 是否已填、`LEAFMEM_EMBEDDINGS_BASE_URL` 是否为 `https://api.siliconflow.cn/v1` |
| `node:sqlite` 报错 | Node 版本 < 22.13，升级 Node |
| 写入报 scope 错误 | 保持不传 scopeType/scopeId，走默认 `agent:workbuddy` |
