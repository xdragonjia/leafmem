#!/usr/bin/env bash
# leafmem-cli — LeafMem 主动加载通道（HTTP API 封装）
#
# 背景（2026-09-04 钉死）：自动化调度会话中 leafmem MCP 工具恒走 deferred
# 索引且寻址失效（5.5.1/5.5.3 一致，一次性自动化实测 direct=absent）；
# 交互会话直连可用。本脚本是自动化会话的【主通道】：直连 launchd 常驻的
# LeafMem agent service（127.0.0.1:3377），独立于宿主 MCP 注册。
#
# 用法（子命令全集，字段面对齐 HTTP 路由 /v1/memories 与 /v1/recall）：
#   leafmem-cli health                              探活（GET /v1/health）
#   leafmem-cli recall "查询" [maxChars] [--task-title t] [--tool-context c]
#   leafmem-cli inspect-recall "查询" [maxChars]    召回调试（含分层诊断）
#   leafmem-cli remember "内容" [summary] [kind] [importance]
#                       [--tags "a,b"] [--confidence n] [--source s] [--metadata JSON]
#   leafmem-cli get <id>                             读单条
#   leafmem-cli list [limit] [kinds] [--tags "a,b"] [--cursor c]
#   leafmem-cli update <id> [--summary s] [--content c] [--kind k]
#                       [--importance n] [--confidence n] [--source s]
#                       [--tags "a,b"] [--metadata JSON]
#   leafmem-cli delete <id>                          删除单条
#   leafmem-cli stats                                统计快照（agent:workbuddy）
#   leafmem-cli scopes                               非空 scope 分布
#   leafmem-cli task-detail <taskId>                 任务窗口（meta+summary+entries）
#   leafmem-cli commit-summary "rollingSummary"      会话摘要捕获（turns/capture）
#
# 纪律：
#   - 写/删默认落 agent:workbuddy scope（URL ?scope= 参数；源码
#     writeContext→resolveContextScopes 证实正确路由，勿传 context.scope）
#   - task_append 无直接 HTTP 路由，用 remember + metadata.taskId 近似
#   - tags 用逗号分隔（"a,b,c"）；metadata 传 JSON 对象字符串
#   - 输出为 JSON 原文，调用方自行解析
set -euo pipefail

CFG="${HOME}/.leafmem/agent-service.json"
[ -f "$CFG" ] || { echo "ERROR: $CFG not found" >&2; exit 1; }

PY=/usr/bin/python3
command -v "$PY" >/dev/null 2>&1 || PY=python3
HOST=$($PY -c 'import json;print(json.load(open("'"$CFG"'"))["host"])' 2>/dev/null || echo "127.0.0.1")
PORT=$($PY -c 'import json;print(json.load(open("'"$CFG"'"))["port"])' 2>/dev/null || echo "3377")
KEY=$($PY -c 'import json;print(json.load(open("'"$CFG"'"))["apiKey"])')
BASE="http://${HOST}:${PORT}"
AGENT="workbuddy"
AUTH="Authorization: Bearer ${KEY}"
CT="Content-Type: application/json"

cmd="${1:-help}"
case "$cmd" in
  health)
    curl -s -m 5 "${BASE}/v1/health" -H "$AUTH"; echo
    ;;
  recall)
    MSG="${2:?recall 需要查询内容}"; MAX="${3:-6000}"; shift $(( $# >= 3 ? 3 : $# ))
    P=$($PY -c '
import json, sys
d = {"message": sys.argv[1], "maxChars": int(sys.argv[2]), "context": {"agentIds": ["workbuddy"]}}
a = sys.argv[3:]
i = 0
while i < len(a):
    if a[i] == "--task-title" and i + 1 < len(a):
        d["taskTitle"] = a[i+1]; i += 2
    elif a[i] == "--tool-context" and i + 1 < len(a):
        d["toolContext"] = a[i+1]; i += 2
    else:
        i += 1
print(json.dumps(d, ensure_ascii=False))
' "$MSG" "$MAX" ${@:-})
    curl -s -m 30 -X POST "${BASE}/v1/recall" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  inspect-recall)
    MSG="${2:?inspect-recall 需要查询内容}"; MAX="${3:-6000}"
    P=$($PY -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "maxChars": int(sys.argv[2]), "inspect": True, "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$MSG" "$MAX")
    curl -s -m 30 -X POST "${BASE}/v1/recall" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  remember)
    CONTENT="${2:?remember 需要内容}"; SUMMARY="${3:-}"; KIND="${4:-note}"; IMP="${5:-0.7}"
    shift $(( $# >= 5 ? 5 : $# ))
    P=$($PY -c '
import json, sys
d = {"kind": sys.argv[3], "content": sys.argv[1], "importance": float(sys.argv[4])}
if sys.argv[2]:
    d["summary"] = sys.argv[2]
a = sys.argv[5:]
i = 0
while i < len(a):
    k = a[i]
    if k == "--tags" and i + 1 < len(a):
        d["tags"] = [t for t in a[i+1].split(",") if t]; i += 2
    elif k == "--confidence" and i + 1 < len(a):
        d["confidence"] = float(a[i+1]); i += 2
    elif k == "--source" and i + 1 < len(a):
        d["source"] = a[i+1]; i += 2
    elif k == "--metadata" and i + 1 < len(a):
        d["metadata"] = json.loads(a[i+1]); i += 2
    else:
        i += 1
print(json.dumps(d, ensure_ascii=False))
' "$CONTENT" "$SUMMARY" "$KIND" "$IMP" ${@:-})
    curl -s -m 30 -X POST "${BASE}/v1/memories?scope=agent:${AGENT}" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  get)
    ID="${2:?get 需要 id}"
    curl -s -m 10 "${BASE}/v1/memories/${ID}?scope=agent:${AGENT}" -H "$AUTH"; echo
    ;;
  list)
    LIMIT="${2:-20}"; KINDS="${3:-}"
    shift $(( $# >= 3 ? 3 : $# ))
    EXTRA=$($PY -c '
import sys
from urllib.parse import quote
parts = []
a = sys.argv[1:]
i = 0
while i < len(a):
    if a[i] == "--tags" and i + 1 < len(a):
        parts.append("tags=" + quote(a[i+1])); i += 2
    elif a[i] == "--cursor" and i + 1 < len(a):
        parts.append("cursor=" + quote(a[i+1])); i += 2
    else:
        i += 1
print("&".join(parts))
' ${@:-})
    Q="scope=agent:${AGENT}&limit=${LIMIT}"
    [ -n "$KINDS" ] && Q="${Q}&kinds=${KINDS}"
    [ -n "$EXTRA" ] && Q="${Q}&${EXTRA}"
    curl -s -m 15 "${BASE}/v1/memories?${Q}" -H "$AUTH"; echo
    ;;
  update)
    ID="${2:?update 需要 id}"; shift 2
    P=$($PY -c '
import json, sys
d = {}
a = sys.argv[1:]
i = 0
while i < len(a):
    k = a[i]
    if k in ("--summary", "--content", "--kind", "--source") and i + 1 < len(a):
        d[k[2:]] = a[i+1]; i += 2
    elif k in ("--importance", "--confidence") and i + 1 < len(a):
        d[k[2:]] = float(a[i+1]); i += 2
    elif k == "--tags" and i + 1 < len(a):
        d["tags"] = [t for t in a[i+1].split(",") if t]; i += 2
    elif k == "--metadata" and i + 1 < len(a):
        d["metadata"] = json.loads(a[i+1]); i += 2
    else:
        i += 1
print(json.dumps(d, ensure_ascii=False))
' ${@:-})
    curl -s -m 15 -X PATCH "${BASE}/v1/memories/${ID}?scope=agent:${AGENT}" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  delete)
    ID="${2:?delete 需要 id}"
    curl -s -m 10 -X DELETE "${BASE}/v1/memories/${ID}?scope=agent:${AGENT}" -H "$AUTH" -w "HTTP_%{http_code}\n"
    ;;
  stats)
    curl -s -m 15 "${BASE}/v1/stats?scope=agent:${AGENT}" -H "$AUTH"; echo
    ;;
  scopes)
    curl -s -m 15 "${BASE}/v1/scopes" -H "$AUTH"; echo
    ;;
  task-detail)
    ID="${2:?task-detail 需要 taskId}"
    curl -s -m 10 "${BASE}/v1/tasks/detail?id=${ID}" -H "$AUTH"; echo
    ;;
  commit-summary)
    SUMMARY="${2:?commit-summary 需要 rollingSummary}"
    P=$($PY -c 'import json,sys; print(json.dumps({"userMessage": sys.argv[1], "assistantMessage": "", "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$SUMMARY")
    curl -s -m 30 -X POST "${BASE}/v1/turns/capture" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  help|*)
    sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
