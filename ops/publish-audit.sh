#!/bin/zsh
# LeafMem 发布卫生审计 (publish-audit.sh)
# 触发：npm prepublishOnly / 手动 zsh ops/publish-audit.sh / CI
#
# 把三起真实事故固化为检测规则：
#   ① 2026-08-08 node_modules 软链误入 git（暴露 marvmem 路径）
#   ② 2026-08-10 plist 明文 SiliconFlow API Key 险随模板入库
#   ③ 2026-08-10 marvmem 残留引用
# 原则：发现任何"不该进仓库/不该发布的东西"立即 exit 1 阻断发布。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
FAIL=0
RED=$'\033[31m'; GRN=$'\033[32m'; NC=$'\033[0m'
bad() { echo "${RED}❌ $1${NC}"; FAIL=1; }
ok()  { echo "${GRN}✅ $1${NC}"; }

echo "═══ LeafMem 发布卫生审计 ═══"

# ---- 1. 密钥/凭据（真实 SiliconFlow key + 常见 key 形态）----
KEYS=$(grep -rn "sk-[a-zA-Z0-9]\{25,\}" dist/ src/ ops/ docs/ README.md package.json 2>/dev/null \
  | grep -v "mermaid" | grep -v "node_modules")
if [[ -n "$KEYS" ]]; then bad "源码/产物中发现疑似 API Key:\n$KEYS"; else ok "无明文 API Key"; fi
NPM_TOKEN=$(grep -rn "npm_[a-zA-Z0-9]\{30,\}" dist/ src/ ops/ package.json 2>/dev/null)
if [[ -n "$NPM_TOKEN" ]]; then bad "发现 npm token"; else ok "无 npm token"; fi

# ---- 2. 个人数据（姓名/真实邮箱/工作内容）----
PRIV=$(grep -rn "贾小龙\|xdragonjia@hotmail\|巡察\|昆仑数智\|党委\|玉门" \
  dist/ src/ docs/ README.md package.json 2>/dev/null | grep -v "node_modules")
if [[ -n "$PRIV" ]]; then bad "发现个人/工作敏感信息:\n$PRIV"; else ok "无个人敏感信息"; fi

# ---- 3. 数据文件（记忆库/镜像不该被打包发布）----
# 精确枚举 SQLite 附属文件后缀（-wal/-shm/-journal），避免 *.sqlite-* 通配
# 误伤含 "sqlite-backup" 字样的模板/脚本（2026-08-10 举一反三审计修复）。
DATA=$(find . -name "*.sqlite" -o -name "*.sqlite-wal" -o -name "*.sqlite-shm" \
       -o -name "*.sqlite-journal" -o -name "full-dump*" \
  | grep -v node_modules | grep -v "\.git/")
if [[ -n "$DATA" ]]; then bad "发现数据文件:\n$DATA"; else ok "无记忆数据文件"; fi

# ---- 4. git 索引中不应有的条目（软链/目录误入）----
BAD_GIT=$(git ls-files -s | awk '$1==120000{print $4}')  # 120000=symlink
if [[ -n "$BAD_GIT" ]]; then bad "git 索引中存在软链条目:\n$BAD_GIT"; else ok "git 索引无软链"; fi
if git ls-files | grep -q "^node_modules"; then bad "node_modules 被 git 追踪"; else ok "node_modules 未入库"; fi

# ---- 5. marvmem 品牌残留（产品化完整性）----
# ops/ 也在检测范围内（0.2.0 审查 M2），但排除审计脚本自身，
# 否则会命中本规则自己的检测正则。
MARV=$(grep -rn "marvmem" dist/ src/ ops/ docs/ README.md package.json 2>/dev/null \
  | grep -v "mermaid" | grep -v node_modules | grep -v "publish-audit.sh")
if [[ -n "$MARV" ]]; then bad "发现 marvmem 品牌残留:\n$MARV"; else ok "无 marvmem 残留"; fi

# ---- 6. dist 是否存在且为最新构建 ----
if [[ ! -d dist ]]; then bad "dist/ 不存在，先 npm run build"; else ok "dist/ 存在"; fi

# ---- 6.5 npm 打包产物审计（最可靠：实际生成 tgz 再检查清单）----
if command -v npm >/dev/null 2>&1; then
  PACK_TMP=$(mktemp -d)
  TGZ=$(npm pack --pack-destination "$PACK_TMP" --silent 2>/dev/null | tail -1)
  if [[ -n "$TGZ" && -f "$PACK_TMP/$TGZ" ]]; then
    PACK_LIST=$(tar -tzf "$PACK_TMP/$TGZ" 2>/dev/null)
    # BAD_PACK 累加而非覆盖（0.2.0 审查 m3b）：否则多条命中只报最后一条原因。
    BAD_PACK=""
    echo "$PACK_LIST" | grep -qiE "\.sqlite|full-dump|agent-service\.json|(^|/)\.env$" && BAD_PACK="${BAD_PACK}${BAD_PACK:+；}数据/密钥文件"
    echo "$PACK_LIST" | grep -qE "package/node_modules" && BAD_PACK="${BAD_PACK}${BAD_PACK:+；}node_modules"
    # 放宽 plist 检测（0.2.0 审查 m3a）：原 `com\.leafmem\.agent\.plist$` 的 $ 锚点
    # 匹配不到实际文件名。凡是包内出现非 template 的 .plist 即视为风险。
    echo "$PACK_LIST" | grep -iE "\.plist" | grep -qivE "\.plist\.template" && BAD_PACK="${BAD_PACK}${BAD_PACK:+；}部署 plist（可能含密钥）"
    echo "$PACK_LIST" | grep -qiE "marvmem" && BAD_PACK="${BAD_PACK}${BAD_PACK:+；}marvmem 残留"
    if [[ -n "$BAD_PACK" ]]; then
      bad "npm 打包产物不干净：$BAD_PACK"
    else
      ok "npm 打包产物干净（$(echo "$PACK_LIST" | grep -c '^package/' | tr -d ' ') 个文件）"
    fi
    rm -rf "$PACK_TMP"
  else
    rm -rf "$PACK_TMP"
    echo "⚠️  npm pack 失败，跳过打包产物审计"
  fi
else
  echo "⚠️  npm 不可用，跳过打包产物审计"
fi

# ---- 7. package.json 版本与 tag 一致性提示 ----
VER=$(/usr/bin/python3 -c "import json;print(json.load(open('package.json'))['version'])")
if git tag -l | grep -q "v$VER"; then ok "git tag v$VER 已存在"; else echo "⚠️  git tag v$VER 尚未创建（发布后建议补打）"; fi

echo "═══════════════════════════"
if [[ $FAIL -ne 0 ]]; then
  echo "${RED}发布卫生审计未通过，已阻断发布。${NC}"
  exit 1
fi
echo "${GRN}发布卫生审计全部通过。${NC}"
exit 0
