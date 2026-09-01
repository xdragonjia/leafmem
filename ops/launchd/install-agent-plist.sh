#!/bin/zsh
# 安装 com.leafmem.agent 服务 plist（从模板注入 API Key 后部署）
# 用法: zsh ops/launchd/install-agent-plist.sh
# 🔒 Key 不落仓库：运行时从 ~/.workbuddy/mcp.json 读取 OPENAI_API_KEY
set -euo pipefail

TEMPLATE="$(dirname "$0")/com.leafmem.agent.plist.template"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/com.leafmem.agent.plist"
MCP_JSON="$HOME/.workbuddy/mcp.json"

KEY=$(/usr/bin/python3 -c "import json;print(json.load(open('$MCP_JSON'))['mcpServers']['leafmem']['env']['OPENAI_API_KEY'])")
if [[ -z "$KEY" ]]; then
  echo "FATAL: 未能从 $MCP_JSON 读取 OPENAI_API_KEY" >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/com.leafmem.agent" 2>/dev/null || true
chmod +x "$REPO/ops/launchd/leafmem-node-launcher.sh"
sed -e "s|__SILICONFLOW_API_KEY__|$KEY|" -e "s|__LEAFMEM_REPO__|$REPO|g" "$TEMPLATE" > "$TARGET"
chmod 600 "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$TARGET"
sleep 3
if curl -s -m 5 -o /dev/null http://127.0.0.1:3377/console; then
  echo "✅ com.leafmem.agent 已安装并在线（:3377）"
else
  echo "⚠️ 服务已安装但 :3377 未响应，请检查 ~/.leafmem/agent-service.err.log" >&2
fi
