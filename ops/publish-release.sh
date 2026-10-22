#!/bin/zsh
# LeafMem GitHub Release 发布脚本 (publish-release.sh)
#
# 为什么有这个脚本（2026-10-22）：
#   「Release 标题 = `LeafMem X.Y.Z` 纯名，不带 v 前缀、不带描述后缀」这条约定
#   2026-09-03 就立规并写进了长期记忆（lesson 8d6683fd），此后 14 个版本全部合规。
#   但 2026-10-22 发 v0.3.26 时没查记忆，标题写成
#   「v0.3.26 — 状态页机制收口（A/B 证伪后停用）+ 基准可跑性修复」，
#   正文也从 890 字符膨胀到 2,440 字符（带多级标题+表格，偏离「一行概括+要点列表+验证行」）。
#   ⇒ 结论：靠记忆不可靠，格式必须固化成代码。本脚本不允许覆盖标题，也不接受命令行传标题。
#
# 用法：
#   zsh ops/build-release.sh                       # 先打包出 release/leafmem-<ver>.zip
#   zsh ops/publish-release.sh                     # 建/更新 Release 并上传 zip + 自动对账
#   zsh ops/publish-release.sh --dry-run           # 只打印将要提交的 name/body，不调用 API
#   zsh ops/publish-release.sh --notes <文件>      # 指定说明文件（默认 release/notes-<ver>.md）
#
# 说明文件要求（若不存在则报错退出，不猜内容）：
#   首行形如 `patch: v0.3.26 —— 一句话主题`，正文 = 简洁中文要点列表 + 末尾「验证」小节。
#
# 🔴 两个已踩过的坑（别改回去）：
#   1) curl -d 会发 application/x-www-form-urlencoded，GitHub 对 PATCH /releases 直接回 404。
#      必须 --data-binary + -H "Content-Type: application/json"。
#   2) zsh 的内置 echo 默认解释反斜杠转义，把 API 响应里的 "\n" 变成真实换行 ⇒ JSON 解析崩。
#      故所有响应一律落盘再读文件，不走 echo 管道。
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
NOTES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --notes) NOTES="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
REPO="xdragonjia/leafmem"
TAG="v${VERSION}"
# 🔴 标题格式唯一来源。禁改、禁传参、禁加后缀——历史 14 个版本都是这个形态。
NAME="LeafMem ${VERSION}"
ZIP="release/leafmem-${VERSION}.zip"
[[ -z "$NOTES" ]] && NOTES="release/notes-${VERSION}.md"
TOKEN=$(cat "$HOME/.workbuddy/secrets/github.token")
API="https://api.github.com/repos/${REPO}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

api() {  # api <输出文件> <curl 参数...>
  local out="$1"; shift
  curl -s -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" -o "$out" "$@"
}

echo "═══ LeafMem Release ${TAG} ═══"
echo "  标题（固定格式）: ${NAME}"

# ---- 1. 前置校验 ----
[[ -f "$ZIP" ]] || { echo "❌ 找不到发布物 ${ZIP}，先跑 zsh ops/build-release.sh" >&2; exit 1; }
[[ -f "$NOTES" ]] || { echo "❌ 找不到说明文件 ${NOTES}" >&2; exit 1; }

if ! head -1 "$NOTES" | grep -q "${VERSION}"; then
  echo "❌ 说明文件首行没有版本号 ${VERSION}：$(head -1 "$NOTES")" >&2
  exit 1
fi

BODY_CHARS=$(wc -m < "$NOTES" | tr -d ' ')
echo "  说明: ${NOTES}（${BODY_CHARS} 字符）"
if [[ "$BODY_CHARS" -gt 3000 ]]; then
  echo "  ⚠️  说明超过 3000 字符（0.3.25 是 891，0.3.26 修正后 2053）——约定是「简洁」，请确认没在正文里堆逐提交清单"
fi

# ---- 2. 打印上一版格式作对照（把「发版前先看上一版」变成脚本动作）----
if [[ "$DRY" == "0" ]]; then
  api "$TMP/list.json" "${API}/releases?per_page=3"
  node -e '
    const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const p=a.find(r=>r.tag_name!==process.argv[2]);
    if(p) console.log(`  上一版对照: ${p.tag_name} → name="${p.name}"（body ${p.body?p.body.length:0} 字符）`);
  ' "$TMP/list.json" "$TAG"
fi

if [[ "$DRY" == "1" ]]; then
  echo "--- DRY RUN：将提交 ---"
  echo "name: ${NAME}"
  echo "tag_name: ${TAG}"
  head -3 "$NOTES"
  exit 0
fi

# 远端 tag 必须已存在（tag 由人工 push，脚本不代打，避免误移动已发布 tag）
git ls-remote --tags origin "$TAG" | grep -q "$TAG" \
  || { echo "❌ 远端没有 tag ${TAG}，先 git tag -a && git push origin ${TAG}" >&2; exit 1; }

# ---- 3. 建 / 更新 Release（幂等；已存在则强制改标题）----
api "$TMP/existing.json" "${API}/releases/tags/${TAG}" || true
EXISTING_ID=$(node -e '
  try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.id||"")}
  catch(e){console.log("")}' "$TMP/existing.json")

node -e '
  const fs=require("fs");
  const [name,tag,bodyFile]=process.argv.slice(1);
  fs.writeFileSync(process.argv[4], JSON.stringify({
    name, tag_name: tag,
    body: fs.readFileSync(bodyFile,"utf8"),
    draft:false, prerelease:false}));
' "$NAME" "$TAG" "$NOTES" "$TMP/payload.json"

if [[ -n "$EXISTING_ID" ]]; then
  echo "→ 已有 Release id=${EXISTING_ID}，更新标题与说明"
  api "$TMP/release.json" -X PATCH -H "Content-Type: application/json" \
    --data-binary @"$TMP/payload.json" "${API}/releases/${EXISTING_ID}"
  REL_ID="$EXISTING_ID"
else
  echo "→ 新建 Release"
  api "$TMP/release.json" -X POST -H "Content-Type: application/json" \
    --data-binary @"$TMP/payload.json" "${API}/releases"
  REL_ID=$(node -e '
    try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.id||"")}
    catch(e){console.log("")}' "$TMP/release.json")
  [[ -n "$REL_ID" ]] || { echo "❌ 建 Release 失败: $(head -c 300 "$TMP/release.json")" >&2; exit 1; }
fi

UPLOAD_URL=$(node -e '
  const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  console.log((d.upload_url||"").replace("{?name,label}",""));' "$TMP/release.json")
[[ -n "$UPLOAD_URL" ]] || { echo "❌ 拿不到 upload_url: $(head -c 300 "$TMP/release.json")" >&2; exit 1; }

# ---- 4. 上传 / 替换 zip 附件 ----
ASSET_NAME=$(basename "$ZIP")
OLD_ASSET=$(node -e '
  const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const a=(d.assets||[]).find(x=>x.name===process.argv[2]);
  console.log(a?a.id:"");' "$TMP/release.json" "$ASSET_NAME")
if [[ -n "$OLD_ASSET" ]]; then
  echo "→ 删除同名旧附件 id=${OLD_ASSET}"
  curl -s -X DELETE -o /dev/null -H "Authorization: Bearer ${TOKEN}" "${API}/releases/assets/${OLD_ASSET}"
fi
echo "→ 上传 ${ASSET_NAME}"
curl -s -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/zip" \
  --data-binary @"$ZIP" "${UPLOAD_URL}?name=${ASSET_NAME}" -o "$TMP/asset.json"

# ---- 5. 对账（uploads.github.com 有假 200 前科，必须回查）----
echo "→ 对账"
sleep 2
api "$TMP/final.json" "${API}/releases/${REL_ID}"
node -e '
  const fs=require("fs");
  const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const want=process.argv[2], zipBase=process.argv[3], localSize=fs.statSync(process.argv[4]).size;
  const fail=[];
  if(d.name!==want) fail.push(`标题不符: 期望 "${want}" 实际 "${d.name}"`);
  if(!d.tag_name.startsWith("v")) fail.push(`tag 异常: ${d.tag_name}`);
  if(d.draft) fail.push("仍是 draft");
  const a=(d.assets||[]).find(x=>x.name===zipBase);
  if(!a) fail.push(`附件缺失: ${zipBase}`);
  else {
    if(a.state!=="uploaded") fail.push(`附件 state=${a.state}`);
    if(Math.abs(a.size-localSize)>1024) fail.push(`附件大小不符: 远端 ${a.size} / 本地 ${localSize}`);
  }
  if(!d.body || d.body.length<200) fail.push(`说明过短: ${d.body?d.body.length:0} 字符`);
  console.log(`  标题: ${d.name}`);
  console.log(`  说明: ${d.body?d.body.length:0} 字符`);
  console.log(`  附件: ${(d.assets||[]).map(x=>x.name+" "+Math.round(x.size/1024/1024*100)/100+"MB").join(", ")}`);
  if(fail.length){ console.log("❌ 对账失败:\n  - "+fail.join("\n  - ")); process.exit(1); }
  console.log("✅ 对账通过");
' "$TMP/final.json" "$NAME" "$ASSET_NAME" "$ZIP"

echo ""
echo "═══ 完成 ═══"
echo "https://github.com/${REPO}/releases/tag/${TAG}"
