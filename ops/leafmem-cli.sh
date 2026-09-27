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
#   leafmem-cli task-detail <taskId>                 任务窗口（meta+summary+entries，自动 URL 编码）
#   leafmem-cli task-append <taskId> <content> [rollingSummary] [status] [title] [role]
#                                                    任务登记/关闭（走 MCP stdio，HTTP 无此路由）
#   leafmem-cli commit-summary "rollingSummary"      刷新 active context（turns/capture 启发式通道）；
#                                                    🔴 不产生持久记忆（stored 常=0，退出码 3=零产出）；
#                                                    持久记忆用 remember，真 commit 走 MCP memory_write
#
# 纪律：
#   - 写/删默认落 agent:workbuddy scope（URL ?scope= 参数；源码
#     writeContext→resolveContextScopes 证实正确路由，勿传 context.scope）
#   - task_append 无 HTTP 路由 → 走 task-append 子命令（MCP stdio，见 leafmem-mcp-write.mjs）
#   - tags 用逗号分隔（"a,b,c"）；metadata 传 JSON 对象字符串
#   - 输出为 JSON 原文，调用方自行解析
#   - 🔴 本脚本【无参数自省能力】：`remember --help` 会把 "--help" 当【内容】写库
#     （2026-09-25 实测踩坑，已加拦截 exit 2）。查用法请读本文件 1–50 行注释，
#     不要用 --help 试探任何子命令。
set -euo pipefail

CFG="${HOME}/.leafmem/agent-service.json"
[ -f "$CFG" ] || { echo "ERROR: $CFG not found" >&2; exit 1; }

PY=/usr/bin/python3
command -v "$PY" >/dev/null 2>&1 || PY=python3
# task-append 走 MCP stdio（HTTP 服务无 task_append 路由）；node 取 mcp.json 里 leafmem 服务同一份
NODEBIN=$($PY -c 'import json,os;print(json.load(open(os.path.expanduser("~/.workbuddy/mcp.json")))["mcpServers"]["leafmem"]["command"])' 2>/dev/null || echo node)
MCPWRITE="${HOME}/.leafmem/leafmem-mcp-write.mjs"
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
' "$MSG" "$MAX" ${@+"$@"})
    curl -s -m 30 -X POST "${BASE}/v1/recall" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  inspect-recall)
    MSG="${2:?inspect-recall 需要查询内容}"; MAX="${3:-6000}"
    P=$($PY -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "maxChars": int(sys.argv[2]), "inspect": True, "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$MSG" "$MAX")
    curl -s -m 30 -X POST "${BASE}/v1/recall" -H "$AUTH" -H "$CT" -d "$P"; echo
    ;;
  remember)
    # 🔴 2026-09-25 加固：本脚本【无参数自省能力】——`remember --help` 曾被当作
    # 【内容】真实写入了一条 content="--help" 的记忆（id 2116b02f，已删除）。
    # 凡 CONTENT 呈命令行标志形态（以 - 开头、无空格、长度 ≥2）一律拦截，绝不进写路径；
    # 含空格的短横开头（如 Markdown 项目符号 "- 条目"）不拦。用法见本脚本头部 1–50 行注释。
    case "${2:-}" in
      help|-h|--help)
        echo "leafmem-cli: remember 的 CONTENT 收到帮助标志 '${2:-}'，已拦截（防误写入库）。" >&2
        echo "用法：sed -n '1,50p' ~/.leafmem/leafmem-cli.sh" >&2
        exit 2 ;;
    esac
    if [ "${2:0:1}" = "-" ] && [ "${#2}" -ge 2 ] && [ "$2" = "${2%% *}" ]; then
      echo "leafmem-cli: remember 的 CONTENT 形如命令行标志 '${2}'，疑似误传，已拦截（防误写入库）。" >&2
      echo "若确为内容，请改为不在开头使用连续的 - 或用 Python 版写入脚本。" >&2
      exit 2
    fi
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
' "$CONTENT" "$SUMMARY" "$KIND" "$IMP" ${@+"$@"})
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
' ${@+"$@"})
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
' ${@+"$@"})
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
    EID=$($PY -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$ID")
    curl -s -m 10 "${BASE}/v1/tasks/detail?id=${EID}" -H "$AUTH"; echo
    ;;
  task-append)
    TID="${2:?task-append 需要 taskId}"; CONTENT="${3:?task-append 需要 content}"
    RS="${4:-}"; ST="${5:-}"; TITLE="${6:-}"; ROLE="${7:-assistant}"
    P=$($PY -c '
import json, sys
a = {"action": "task_append", "taskId": sys.argv[1], "role": sys.argv[2], "content": sys.argv[3]}
if sys.argv[4]:
    a["rollingSummary"] = sys.argv[4]
if sys.argv[5]:
    a["status"] = sys.argv[5]
if sys.argv[6]:
    a["title"] = sys.argv[6]
print(json.dumps(a, ensure_ascii=False))
' "$TID" "$ROLE" "$CONTENT" "$RS" "$ST" "$TITLE")
    [ -f "$MCPWRITE" ] || { echo "ERROR: $MCPWRITE 不存在（MCP stdio 写通道缺失）" >&2; exit 1; }
    "$NODEBIN" "$MCPWRITE" --tool memory_write --args "$P"
    ;;
  commit-summary)
    # 🔴 语义澄清（2026-09-27 源码取证 routes-recall.ts / platform/service.ts / runtime.ts）：
    #   本命令 = turns/capture 启发式通道，不是「持久化会话摘要」通道：
    #   ① 摘要文本【不会】写为持久记忆——提案器只对线索词（记住/我更喜欢/我们决定/我是…）
    #      产生提案，运营报告类文本一律 proposals=0/stored=0；
    #   ② 唯一副作用 = 刷新 agent:workbuddy 的 active context（单槽、clamp 400 字符、
    #      无 LLM 时为原文截断），且会被后续任何会话的 turn capture 覆盖——非持久；
    #   ③ 持久记忆请用 remember；真 commit（rollingSummary→task+activeContext）请走
    #      MCP memory_write(action=commit)，本 CLI 无对应子命令。
    #   零产出时退出码 3（显式失败化，防「返回 200 误判已完成记忆写入」）。
    SUMMARY="${2:?commit-summary 需要 rollingSummary}"
    P=$($PY -c 'import json,sys; print(json.dumps({"userMessage": sys.argv[1], "assistantMessage": "", "context": {"agentIds": ["workbuddy"]}}, ensure_ascii=False))' "$SUMMARY")
    RESP=$(curl -s -m 30 -X POST "${BASE}/v1/turns/capture" -H "$AUTH" -H "$CT" -d "$P")
    echo "$RESP"
    echo "$RESP" | $PY -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # 非 JSON 响应，交由调用方自行判断
if d.get("stored", 0) == 0 and d.get("proposals", 0) == 0 and d.get("taskEntries", 0) == 0:
    print("leafmem-cli: commit-summary 零产出（stored=0/proposals=0/taskEntries=0）——"
          "本命令只刷新 active context，不产生持久记忆；持久记忆请用 remember 子命令。",
          file=sys.stderr)
    sys.exit(3)
'
    ;;
  help|*)
    sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
