#!/usr/bin/env bash
# leafmem-cli — LeafMem 主动加载通道（HTTP API 封装）
#
# 背景（2026-09-04 钉死）：WorkBuddy 5.5.1 宿主对自定义 MCP 的
# --mcp-config 注入即使包含完整配置且连接成功（stdio doConnect OK），
# defer_loading:false 仍被无视、工具进 deferred 索引后漏收 → 自动化会话
# 中 4 个 mcp__leafmem__* 工具既不在直连表也不在索引。5.5.3 已修复尊重
# 该字段，但宿主升级可能回归。本脚本是独立于宿主 MCP 注册的保底通道：
# 直连 launchd 常驻的 LeafMem agent service（127.0.0.1:3377）。
#
# 用法：
#   leafmem-cli health                          # 探活
#   leafmem-cli recall "查询内容" [maxChars]     # 召回（默认 6000 chars）
#   leafmem-cli remember "内容" [summary] [kind] [importance]  # 写入记忆
#   leafmem-cli commit-summary "rollingSummary"  # 提交会话摘要（turns/capture）
#
# 纪律：
#   - 写入默认落 agent:workbuddy scope（URL ?scope= 参数，源码
#     writeContext→resolveContextScopes 证实正确路由，勿传 context.scope）
#   - 输出为 JSON 原文，调用方自行解析
set -euo pipefail

CFG="${HOME}/.leafmem/agent-service.json"
[ -f "$CFG" ] || { echo "ERROR: $CFG not found" >&2; exit 1; }

HOST=$(python3 -c 'import json;print(json.load(open("'"$CFG"'"))["host"])' 2>/dev/null || echo "127.0.0.1")
PORT=$(python3 -c 'import json;print(json.load(open("'"$CFG"'"))["port"])' 2>/dev/null || echo "3377")
KEY=$(python3 -c 'import json;print(json.load(open("'"$CFG"'"))["apiKey"])')
BASE="http://${HOST}:${PORT}"
AGENT="workbuddy"

cmd="${1:-help}"
case "$cmd" in
  health)
    curl -s -m 5 "${BASE}/v1/health" -H "Authorization: Bearer ${KEY}"
    echo
    ;;
  recall)
    MSG="${2:?recall 需要查询内容}"
    MAX_CHARS="${3:-6000}"
    PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "maxChars": int(sys.argv[2]), "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$MSG" "$MAX_CHARS")
    curl -s -m 30 -X POST "${BASE}/v1/recall" \
      -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \
      -d "$PAYLOAD"
    echo
    ;;
  remember)
    CONTENT="${2:?remember 需要内容}"
    SUMMARY="${3:-}"
    KIND="${4:-note}"
    IMPORTANCE="${5:-0.7}"
    PAYLOAD=$(python3 -c 'import json,sys; d={"kind": sys.argv[3], "content": sys.argv[1], "importance": float(sys.argv[4])}; d["summary"]=sys.argv[2] if sys.argv[2] else None; d={k:v for k,v in d.items() if v is not None}; print(json.dumps(d, ensure_ascii=False))' "$CONTENT" "$SUMMARY" "$KIND" "$IMPORTANCE")
    curl -s -m 30 -X POST "${BASE}/v1/memories?scope=agent:${AGENT}" \
      -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \
      -d "$PAYLOAD"
    echo
    ;;
  commit-summary)
    SUMMARY="${2:?commit-summary 需要 rollingSummary}"
    PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"userMessage": sys.argv[1], "assistantMessage": "", "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$SUMMARY")
    curl -s -m 30 -X POST "${BASE}/v1/turns/capture" \
      -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \
      -d "$PAYLOAD"
    echo
    ;;
  help|*)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
