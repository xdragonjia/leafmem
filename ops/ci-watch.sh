#!/bin/zsh
# ci-watch.sh — push 后轮询 GitHub Actions 直到 conclusion（08-16 承诺的机制化，2026-10-21）
# 用法：ops/ci-watch.sh [超时秒，默认 600]
# 退出码：0 绿 / 1 红 / 2 无 token / 3 轮询超时 / 4 取不到 HEAD / 5 本地 HEAD 未推送（无可等 run）
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
# 🔴 2026-11-10 修复：本地 HEAD 未推送时**永不会产生 CI run**，脚本会在 120/600s 后报
# 「❌ CI 轮询超时」exit 3，被误读成「网络不可达」或「CI 有风险」（10-31/11-02/11-09 三次误判）。
# 判据：origin/main..HEAD 有提交 ⇒ 直接 exit 5「未推送·无 run 可等」，不轮询、不判绿也不判红。
AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [[ "${AHEAD:-0}" -gt 0 ]]; then
  echo "⚠️ 本地 HEAD 未推送（领先 origin/main ${AHEAD} 个提交，${HEAD_SHA:0:7}）——不会产生 CI run，跳过轮询"
  echo "   处置：git push 后重跑本脚本；本轮结果记为「未验证」，不得当绿也不得当红。"
  exit 5
fi
start=$(date +%s)
# 🔴 2026-11-15 修复（第二条，通道层）：
# 实测本机 DNS/代理把 github 解析到保留段假地址（api.github.com → 0.0.79.4 / fd00:696e::ffff:…，属 Proxifier
# 隧道劫持），HTTP/2 走该假段时随机 403 或直接挂死（curl 000 超时），`git ls-remote` 直接报
# "Recv failure: Network is down"。三通道各 5 次实测：默认 0/5 成功、强制 -4 0/5、-6 0/5 全 000；
# 而 `--http1.1` + DoH 解析（--doh-url）3/3 返回 200。⇒ 判据：CI 取不到结论的**首选因是通道，不是限流**。
# 故本脚本改为：强制 HTTP/1.1；系统 DNS 失败即自动切 DoH 通道；并按 HTTP 码给出可执行诊断。
# 纪律来源：ui-design/SKILL.md「GitHub 访问」+ market-search Step2 0b（11-14 实证，禁归因沙箱/限流）。
DOH_URL="https://223.5.5.5/dns-query"
CH="sysdns"; CH_FAIL=0; API_FAIL=0; LAST_DIAG="(无)"
while :; do
  now=$(date +%s); (( now - start > TIMEOUT )) && {
    echo "❌ CI 轮询超时 ${TIMEOUT}s（末次 API 诊断：${LAST_DIAG}）"
    echo "   ↑ 这是「无法取得 CI 结论」，不等于 CI 红，也不等于已绿；按诊断项处置后重跑。"
    exit 3
  }
  if [[ "$CH" == "doh" ]]; then
    RAW=$(curl -s -m 20 --http1.1 --doh-url "$DOH_URL" -w "\n%{http_code}" \
      "https://api.github.com/repos/$REPO/actions/runs?per_page=5" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null)
  else
    RAW=$(curl -s -m 20 --http1.1 -4 -w "\n%{http_code}" \
      "https://api.github.com/repos/$REPO/actions/runs?per_page=5" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null)
  fi
  RUN=$(printf '%s' "$RAW" | python3 -c "
import json,sys
sha='$HEAD_SHA'
raw=sys.stdin.read()
body,_,code=raw.rpartition('\n')
code=code.strip() or '000'
if code!='200':
    msg=''
    try: msg=json.loads(body).get('message','')[:90]
    except Exception: msg=body[:90].replace('\n',' ')
    print('__APIFAIL__', code, msg); raise SystemExit
try: runs=json.loads(body).get('workflow_runs',[])
except Exception: print('__APIFAIL__','200','parse_error'); raise SystemExit
for r in runs:
    if r['head_sha'].startswith(sha):
        print(r['id'], r['status'], r['conclusion'] or '-'); break
" 2>/dev/null)
  case "$RUN" in
    __APIFAIL__*)
      CODE=$(echo "$RUN" | awk '{print $2}'); MSG=$(echo "$RUN" | cut -d' ' -f3-)
      LAST_DIAG="[${CH}] HTTP ${CODE} ${MSG}"
      API_FAIL=$((API_FAIL+1))
      # 只把「连不上/超时（000）」与「TLS/代理异常」计为通道故障；4xx 是 API 已达但被拒，不是通道问题
      if [[ "$CODE" == "000" || "$CODE" == "parse_error" ]]; then
        CH_FAIL=$((CH_FAIL+1))
        if (( CH_FAIL >= 2 )) && [[ "$CH" == "sysdns" ]]; then
          echo "  ⚠ 系统 DNS 通道连续失败（${LAST_DIAG}）——切 DoH 通道重试"
          CH="doh"; CH_FAIL=0; sleep 2; continue
        fi
        if (( CH_FAIL >= 2 )) && [[ "$CH" == "doh" ]]; then
          echo "❌ GitHub 双通道均不可达（系统 DNS + DoH 各失败 ≥2 次，末次：${LAST_DIAG}）"
          echo "   性质：未验证（非红非绿），且**不是 CI 结论**。"
          echo "   判据：本机 DNS 把 github 解析到 0.0.x.x 保留段假址（Proxifier 隧道），"
          echo "         HTTP/2 通道随机 403/挂死，git 会报 'Recv failure: Network is down'。"
          echo "   处置：① 检查 Proxifier 隧道上游节点（重连/换节点）② 直接验 git："
          echo "         git -c http.version=HTTP/1.1 ls-remote --heads origin main"
          echo "         ③ 仍不行改用真实浏览器（ego-browser）看 Actions 页，勿判 CI 红。"
          exit 3
        fi
      elif [[ "$CODE" == "401" ]]; then
        echo "❌ GitHub 鉴权失败（HTTP 401 Bad credentials）——与 CI 无关"
        echo "   处置：更新 $HOME/.workbuddy/secrets/github.token 后重跑；性质：未验证。"
        exit 3
      elif [[ "$CODE" == "403" ]]; then
        echo "  ⚠ HTTP 403（${MSG}）——代理出口 IP 共享被限流/被拦，非 CI 红；稍后重试"
      fi
      if (( API_FAIL >= 8 )); then
        echo "❌ GitHub API 连续 8 轮异常（末次：${LAST_DIAG}）"
        echo "   性质：未验证（非红非绿）。按码分因：401=token ／ 403含 rate limit=出口限流 ／ 000=通道故障"
        exit 3
      fi
      sleep 3; continue ;;
  esac
  API_FAIL=0; CH_FAIL=0
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
