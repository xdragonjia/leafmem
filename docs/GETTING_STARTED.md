# LeafMem 快速上手（API Key 引导）

LeafMem 是一个本地长期记忆引擎（MCP server + 控制台）。它默认使用本地 SQLite 存储，**不需要任何账号即可运行基础记忆功能**。但要启用高质量检索（向量化）与反思蒸馏（inferencer），需要配置 1~2 个模型 API Key。

本文引导你完成两件事：

1. **申请硅基流动（SiliconFlow）API Key** —— 配置**免费**的向量化（embedding）与重排序（rerank）模型。
2. **（可选）配置 DeepSeek 或其他模型 API Key** —— 用于反思蒸馏、画像维护等需要对话模型的能力。

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

## 2. DeepSeek 或其他对话模型（可选：反思蒸馏）

向量化只解决「检索」。要让 LeafMem 具备**反思蒸馏**（把碎片记忆提炼为 principle）和**用户画像维护**能力，需要一个能做结构化输出的对话模型。DeepSeek 性价比高，也兼容任何 OpenAI 格式的服务（硅基流动同样可代理 DeepSeek）。

### 2.1 申请 DeepSeek API Key

1. 打开 <https://platform.deepseek.com> 注册。
2. 进入「API Keys」创建并复制 Key。

### 2.2 配置 inferencer

在 `leafmem` 的 `env` 中加入（以 DeepSeek 为例）：

```jsonc
{
  "DEEPSEEK_API_KEY": "sk-<你的 DeepSeek Key>",
  "LEAFMEM_INFERENCER": "{\"provider\":\"deepseek\",\"model\":\"deepseek-chat\"}"
}
```

> `LEAFMEM_INFERENCER` 是一段 JSON 字符串，描述 inferencer 用哪个 provider/model。不配置时，反思蒸馏与画像维护会自动降级关闭（不影响基础记忆与检索）。

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
