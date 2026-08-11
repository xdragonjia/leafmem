# LeafMem 快速上手（API Key 引导）

LeafMem 是一个本地长期记忆引擎（MCP server + 控制台）。它默认使用本地 SQLite 存储，**不需要任何账号即可运行基础记忆功能**。要启用高质量检索（向量化 + 重排），需要一枚**免费**的硅基流动 API Key（安装引导会默认帮你配好）；蒸馏与画像由宿主模型完成，不需要任何额外 Key。

本文引导你完成一件事：

1. **申请硅基流动（SiliconFlow）API Key** —— 配置**免费**的向量化（embedding）与重排序（rerank）模型。

> 全部配置只写在你本机的宿主 MCP 配置里（如 `~/.workbuddy/mcp.json`），LeafMem 不会上传你的 Key 或记忆内容。

---

## 1. 硅基流动（免费向量化模型）

向量化模型把记忆文本转成向量，是语义召回的基础。硅基流动提供**免费额度**的 BGE-M3 模型，足够个人长期使用。

### 1.1 申请 API Key

1. 打开 <https://cloud.siliconflow.cn> 注册账号（新用户有免费额度）。
2. 登录后进入「账号管理 → API 密钥（API Keys）」。
3. 点击「新建 API 密钥」，复制生成的 Key（形如 `sk-...`）。

### 1.2 写入宿主 MCP 配置

在宿主 MCP 配置（如 WorkBuddy 的 `~/.workbuddy/mcp.json`）的 `leafmem` 条目 `env` 中加入：

```jsonc
{
  "mcpServers": {
    "leafmem": {
      "command": "node",
      "args": ["/path/to/leafmem/dist/bin/leafmem-mcp.js"],
      "env": {
        "LEAFMEM_STORAGE_PATH": "/Users/<you>/.leafmem/memory.sqlite",
        // 向量化（embedding）
        "LEAFMEM_EMBEDDINGS_PROVIDER": "openai",
        "LEAFMEM_EMBEDDINGS_MODEL": "BAAI/bge-m3",
        "LEAFMEM_EMBEDDINGS_BASE_URL": "https://api.siliconflow.cn/v1",
        "OPENAI_API_KEY": "sk-<你的硅基流动 Key>",
        // 重排序（rerank，同源免费，强烈建议一并配置）
        "LEAFMEM_RERANK_URL": "https://api.siliconflow.cn/v1/rerank",
        "LEAFMEM_RERANK_MODEL": "BAAI/bge-reranker-v2-m3",
        "LEAFMEM_RERANK_API_KEY": "sk-<你的硅基流动 Key>",
        "LEAFMEM_RERANK_TIMEOUT_MS": "3000",
        "LEAFMEM_RERANK_TOP_K": "40"
      }
    }
  }
}
```

> `OPENAI_API_KEY` 同时作为 rerank 的兜底 Key；`LEAFMEM_RERANK_API_KEY` 缺省时也会回退读取 `OPENAI_API_KEY`。

配置完成后在宿主里重连 MCP（或重启宿主），在控制台 Dashboard 确认检索栈生效。

---

## 2. 反思蒸馏与画像维护（默认免费，无需额外 Key）

向量化只解决「检索」。反思蒸馏（把碎片记忆提炼为 principle）与用户画像维护需要对话模型，产品默认路径是：

**`leafmem-maintenance` 运维技能（默认，免费）**——由宿主模型（WorkBuddy/昆仑小智自带）通过 MCP 完成蒸馏与画像刷新，**不需要任何额外 API Key**，配合每周自动化任务运行。这是安装引导默认建立的路径，无需你做任何配置。

> 说明：`memory_organize(action=reflect/profile)` 的 MCP 内置路径在**未提供 inferencer 时自动降级关闭**（不报错）。inferencer 是 SDK 编程接口（`createLeafMem({ inferencer })`，见 [`docs/USAGE.md`](docs/USAGE.md)），面向把 LeafMem 嵌入自己代码的开发者；普通双宿主安装不涉及，也没有对应的配置界面——请勿寻找"在哪里填 DeepSeek Key"，默认路径用不上它。

---

## 3. 双宿主数据策略

LeafMem 支持 WorkBuddy（`~/.workbuddy/`）与昆仑小智（`~/.kunlunxiaozhi/`）两个宿主：

- **只装了其中一个**：不存在双宿主问题，正常 `leafmem-agent install <host>` 即可。
- **两个都装了**：默认各自指向同一个 `~/.leafmem/memory.sqlite`（共享记忆）。若希望隔离，为不同宿主传不同 `--storage-path`，或设置不同 `LEAFMEM_SCOPE_ID`。

---

## 4. 验证

```bash
# 启动控制台（含 Dashboard / Insights / Explorer）
leafmem-agent serve
# 浏览器打开 http://127.0.0.1:3377/console
```

在 Insights 页能看到画像与 principle，在 Explorer 能看到记忆条目，即说明向量化与检索栈工作正常。


---

## 双宿主记忆拓扑（WorkBuddy + 昆仑小智）

同时安装两个宿主时，安装器会询问记忆拓扑（也可用 `--memory` 指定）：

- **shared（推荐，默认）**：两个宿主写入同一记忆池 `agent:workbuddy`，用户画像、蒸馏原则、召回完全共享；
- **isolated**：各宿主写入各自 scope（`agent:kunlunxiaozhi` 等），记忆彼此隔离。

```bash
leafmem-agent install kunlunxiaozhi --memory shared    # 共用一套记忆
leafmem-agent install kunlunxiaozhi --memory isolated  # 各自独立
```

控制台「宿主接入」页同样提供「共用一套记忆」开关。切换拓扑只改 mcp.json 的
`LEAFMEM_SCOPE_ID`，历史数据可用 SQL 更新 scope_id 迁移。
