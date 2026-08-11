#!/bin/zsh
# LeafMem release 打包脚本 (build-release.sh)
# 产出一个「解压即用」的 release zip，供 GitHub Release 附件分发。
#
# 背景（2026-08-11）：国内访问 npm 很慢，用户拿到 GitHub release 包后不应再
# 依赖 npm install。dist/ 是零运行时依赖（仅 node: 内置模块），所以 release
# 包 = dist + ops + docs + 引导文件，解压即用，无需 node_modules。
#
# 用法：zsh ops/build-release.sh            # 产出 release/leafmem-<ver>.zip
#       zsh ops/build-release.sh --no-build # 跳过重新构建（dist 已新）
set -euo pipefail
cd "$(dirname "$0")/.."

DO_BUILD=1
[[ "${1:-}" == "--no-build" ]] && DO_BUILD=0

VERSION=$(node -p "require('./package.json').version")
STAGE="release/staging/leafmem-${VERSION}"
OUT="release/leafmem-${VERSION}.zip"

echo "═══ LeafMem release 打包 v${VERSION} ═══"

# ---- 1. 卫生审计（与 npm publish 同门）----
zsh ops/publish-audit.sh

# ---- 2. 构建 ----
if [[ "$DO_BUILD" == "1" ]]; then
  echo "→ 构建 dist/ ..."
  npm run build
fi

# ---- 3. 组装 staging 目录 ----
rm -rf release/staging
mkdir -p "$STAGE"

# dist（零依赖运行时）+ 顶层文档/引导 + ops（技能/自动化/hooks/脚本）+ docs + 元数据
cp -R dist "$STAGE/dist"
cp -R ops "$STAGE/ops"
cp -R docs "$STAGE/docs"
cp README.md LICENSE package.json "$STAGE/"
cp INSTALL-WORKBUDDY.md INSTALL-KUNLUNXIAOZHI.md "$STAGE/"

# 清理 staging 里不应分发的东西
find "$STAGE" -name ".DS_Store" -delete 2>/dev/null || true

# ---- 4. 校验关键文件在位 ----
for f in \
  "$STAGE/dist/bin/leafmem-mcp.js" \
  "$STAGE/dist/bin/leafmem-agent.js" \
  "$STAGE/dist/agents/hooks.js" \
  "$STAGE/ops/hooks/leafmem-hooks.mjs" \
  "$STAGE/ops/skills/leafmem-maintenance/SKILL.md" \
  "$STAGE/ops/automations/weekly-maintenance.md" \
  "$STAGE/ops/automations/daily-sentinel.md" \
  "$STAGE/INSTALL-WORKBUDDY.md" \
  "$STAGE/INSTALL-KUNLUNXIAOZHI.md" \
; do
  if [[ ! -e "$f" ]]; then
    echo "❌ release 缺关键文件: $f" >&2
    exit 1
  fi
done
echo "✅ 关键文件齐全"

# ---- 5. 冒烟：用 release 里的 dist 跑一次 --help ----
node "$STAGE/dist/bin/leafmem-agent.js" --help >/dev/null
echo "✅ release dist 可执行（--help 冒烟通过）"

# ---- 6. 打包 zip ----
rm -f "$OUT"
(cd release/staging && zip -qr "../leafmem-${VERSION}.zip" "leafmem-${VERSION}")
rm -rf release/staging

echo ""
echo "═══ 完成 ═══"
echo "产物: $OUT"
ls -lh "$OUT"
echo ""
echo "下一步："
echo "  1) 到 GitHub 仓库 → Releases → 编辑/新建 v${VERSION}"
echo "  2) 把 $OUT 作为附件上传"
echo "  3) 用户下载解压即可，无需 npm install（dist 零运行时依赖）"
