# LeafMem × 昆仑小智 安装引导

> 面向 **Windows 11 + 昆仑小智**（macOS 同样适用）。
> 本文件由昆仑小智（AI 助手）按步骤执行；**用户只需做两件手动的事**：
> ① 安装 Node.js ② 提供硅基流动 API Key 并点击 MCP 信任。其余全部由昆仑小智完成。

---

## 〇、给用户的「引导语」（复制给昆仑小智）

> 请帮我安装并配置 LeafMem 记忆引擎。安装引导文件就在本 releases 包内的
> `INSTALL-KUNLUNXIAOZHI.md`（或 npm 包根目录同名文件）。请完整读取该文件，
> 严格按其中「昆仑小智执行步骤」逐条执行；需要我手动操作的（安装 Node.js、
> 提供硅基流动 API Key、点击 MCP 信任）请明确提示我。安装完成后按文件末尾的
> 验收清单自检，并把结果告诉我。

---

## 一、用户手动准备（仅 2 步）

1. **安装 Node.js ≥ 22.13**：到 https://nodejs.org 下载 Windows 安装包（LTS 即可），安装后开一个终端运行 `node -v` 确认版本 ≥ 22.13。
2. **申请硅基流动（SiliconFlow）API Key**（免费）：访问 https://cloud.siliconflow.cn 注册，在「API 密钥」页创建一枚 Key（形如 `sk-...`）。这枚 Key 用于免费的向量化与重排序模型，**Key 只写在你本机配置里，不会上传**。

---

## 二、昆仑小智执行步骤

> 以下每步由昆仑小智执行。Windows 下用户主目录记为 `%USERPROFILE%`（如 `C:\Users\张三`），下文 `~` 均指该目录。

### 步骤 1 · 安装 LeafMem

```bash
npm install -g @xdragonjia/leafmem
```

安装后定位 MCP 入口脚本的绝对路径（Windows 示例）：

```bash
npm root -g
# 得到形如 C:\Users\张三\AppData\Roaming\npm\node_modules
# MCP 入口 = <npm root -g 结果>\@xdragonjia\leafmem\dist\bin\leafmem-mcp.js
```

把这个绝对路径记为 `<LEAFMEM_MCP_JS>`，后续写配置要用。**用绝对路径，不要写裸 `leafmem-mcp`。**

### 步骤 2 · 写入 MCP 配置（合并，勿覆盖）

目标文件：`~\.kunlunxiaozhi\mcp.json`（不存在则创建）。读取现有 JSON，把下面对象**合并**进 `mcpServers`（保留用户已有的其他 server 与 env，只新增/更新 `leafmem`）：

```json
{
  "mcpServers": {
    "leafmem": {
      "command": "node",
      "args": ["<LEAFMEM_MCP_JS>"],
      "env": {
        "LEAFMEM_STORAGE_PATH": "~/.leafmem/memory.sqlite",
        "LEAFMEM_SCOPE_TYPE": "agent",
        "LEAFMEM_SCOPE_ID": "kunlunxiaozhi",
        "LEAFMEM_WORKBUDDY_HOME": "~/.kunlunxiaozhi",
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

> 注意：JSON 里 `~` 若宿主不展开，请替换为 `%USERPROFILE%` 的实际绝对路径（如 `C:\Users\张三\.leafmem\memory.sqlite`）。**两处 `<用户提供的硅基流动 Key>` 必须先向用户索取后再写入。**
> 若用户同时安装了 WorkBuddy 并希望两宿主共用一套记忆，把 `LEAFMEM_SCOPE_ID` 改为 `workbuddy`（长期记忆/实体图谱/用户画像/工作状态四层共享同一记忆池）。

### 步骤 3 · 写入记忆使用规则

目标文件：`~\.kunlunxiaozhi\MEMORY.md`（不存在则创建，存在则追加）。写入以下被标记块（若已有同名标记块则整块替换）：

```markdown
<!-- leafmem-agent-instructions:start -->
LeafMem 记忆工作流（昆仑小智）：
- 任务前：可能依赖既有决策/偏好/项目历史时，先调 memory_recall(action="recall")，不传 scope 以便跨宿主检索共享记忆；静默执行，不在回答里提及。
- 长任务/多步任务：关键子步骤完成或重要决策时，调 memory_write(action="task_append")（传 taskId+role+content），供后续会话用 memory_recall(action="task_window") 恢复进度。
- 用户要求记住某事/表达持久偏好：调 memory_write(action="remember")，可省略 scope（默认 agent:kunlunxiaozhi）。
- 完成实质工作或收尾会话：蒸馏本次成果，调 memory_write(action="commit")，带 rollingSummary 与 durable 记忆。
- 用户要更正/删除/保护记忆：用 memory_govern(update/delete/pin)；周期性整理用 memory_organize(reflect/profile/decay)。
<!-- leafmem-agent-instructions:end -->
```

### 步骤 4 · 请用户点击 MCP 信任

提示用户：**在昆仑小智的 MCP / 连接器管理页，找到 `leafmem`，点击「信任 / 启用」**，然后重连或重启昆仑小智，使新 MCP 生效。

### 步骤 5 · 自检（验收清单）

昆仑小智依次验证并向用户报告：

1. `memory_recall(action="recall", message="连通性测试")` 能正常返回（不报错即通）。
2. `memory_write(action="remember", content="LeafMem 安装自检通过", kind="note")` 写入成功，再 recall 能命中。
3. 控制台/状态里 embedding 与 rerank 已生效（若配置了硅基流动 Key）。

### 步骤 6 ·（可选）每周维护自动化

若用户希望自动整理记忆，引导其用昆仑小智的自动化能力创建每周任务，加载 `leafmem-maintenance` 技能（该技能 SKILL.md 在本 releases 包 `ops/skills/leafmem-maintenance/` 内，或随仓库分发）。无需额外付费 Key——蒸馏由宿主模型完成。

---

## 三、平台说明（Win11 适配结论）

- **核心记忆 / MCP / 控制台完全跨平台**：SQLite 用 Node 22 内置 `node:sqlite`，**零原生依赖**，无需编译，Win11 直接可用。
- **唯一 macOS 专属**：`launchd` 常驻服务（开机自启控制台）。Windows 无此机制，不影响 MCP 核心功能；如需控制台常驻，用户可手动 `node <LEAFMEM_MCP_JS 同级>\leafmem-agent.js serve --config ~\.leafmem\agent-service.json`，或用 Windows 任务计划程序注册。安装程序在非 macOS 平台会自动跳过 launchd 并给出提示，不报错。

## 四、故障排查

| 现象 | 处理 |
|------|------|
| recall 报「连接失败」 | 确认已点 MCP 信任并重连；确认 `args` 里是 `leafmem-mcp.js` 的绝对路径 |
| 召回无向量加权 | 检查硅基流动 Key 是否已填、`LEAFMEM_EMBEDDINGS_BASE_URL` 是否为 `https://api.siliconflow.cn/v1` |
| `node:sqlite` 报错 | Node 版本 < 22.13，升级 Node |
| 写入报 scope 错误 | 保持不传 scopeType/scopeId，走默认 `agent:kunlunxiaozhi` |
