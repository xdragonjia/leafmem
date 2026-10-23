#!/bin/zsh
# ci-watch.sh — push 后轮询 GitHub Actions 直到 conclusion（08-16 承诺的机制化，2026-10-21）
# 用法：ops/ci-watch.sh [超时秒，默认 600]
# 纪律来源：~/.workbuddy/memory/DETAIL-ENV-TOOLS.md:43「推送后必须等 CI 转绿；CI 红当场定位修复」
# 2026-10-21 小龙追问"你还记得以后如何监控吗"——承诺存在但无机制强制，本脚本即机制：
#   push 后必须跑本脚本；红则输出失败作业+步骤并 exit 1（调用方可链式 && 阻断后续宣称完成）
set -uo pipefail
TIMEOUT="${1:-600}"
# 🔴 2026-10-23 修复：cwd 依赖导致「假绿」——在非仓库目录调用时 git rev-parse 失败，
# HEAD_SHA 为空 ⇒ python 里 sha.startswith('') 恒真 ⇒ 拿最新一次 run 判绿（可能对错 commit 报绿）。
# 现在先切到脚本所在仓库根目录，取不到 SHA 直接 exit 4，绝不判绿。
cd "$(cd "$(dirname "$0")/.." && pwd)" || { echo "❌ 无法定位仓库目录"; exit 4; }
TOKEN="$(cat "$HOME/.workbuddy/secrets/github.token" 2>/dev/null | tr -d '\n')"
REPO="xdragonjia/leafmem"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
[[ -z "$TOKEN" ]] && { echo "❌ 无 github.token，无法查 CI"; exit 2; }
[[ -z "$HEAD_SHA" ]] && { echo "❌ 取不到 git HEAD（非仓库或 git 异常），拒绝判绿"; exit 4; }
start=$(date +%s)
while :; do
  now=$(date +%s); (( now - start > TIMEOUT )) && { echo "❌ CI 轮询超时 ${TIMEOUT}s"; exit 3; }
  RUN=$(curl -s "https://api.github.com/repos/$REPO/actions/runs?per_page=5" \
    -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
sha='$HEAD_SHA'
for r in json.load(sys.stdin).get('workflow_runs',[]):
    if r['head_sha'].startswith(sha):
        print(r['id'], r['status'], r['conclusion'] or '-'); break
" 2>/dev/null)
  [[ -z "$RUN" ]] && { sleep 15; continue; }
  rid=$(echo "$RUN" | awk '{print $1}'); st=$(echo "$RUN" | awk '{print $2}'); cc=$(echo "$RUN" | awk '{print $3}')
  if [[ "$st" == "completed" ]]; then
    # 🔴 变量后紧跟全角标点必须用 ${} 包住：用 bash 调用本脚本时，字节级解析会把「）」
    # 的首字节并进变量名（报 rid<乱码>: unbound variable），zsh 下正常——两种 shell 都要能跑。
    if [[ "$cc" == "success" ]]; then echo "✅ CI 转绿（run ${rid}）"; exit 0; fi
    echo "❌ CI 红（run ${rid}）——失败作业与步骤："
    curl -s "https://api.github.com/repos/$REPO/actions/runs/$rid/jobs" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
for j in json.load(sys.stdin).get('jobs',[]):
    if j['conclusion'] not in ('success','skipped'):
        print('  作业:', j['name'], j['conclusion'])
        for s in j.get('steps',[]):
            if s['conclusion'] not in ('success','skipped'): print('    步骤:', s['name'], s['conclusion'])"
    exit 1
  fi
  echo "  … CI ${st}（${cc}），15s 后重试"; sleep 15
done
