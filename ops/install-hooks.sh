#!/bin/sh
# 启用版本化 git 钩子（.githooks/），使 pre-push 检查随仓库分发、换机不失效。
# 用法：sh ops/install-hooks.sh    （或 npm run hooks:install）
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .githooks/pre-push ]; then
  echo "❌ 未找到 .githooks/pre-push，安装中止"
  exit 1
fi

chmod +x .githooks/pre-push .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks

echo "✅ 已启用版本化钩子目录"
echo "   core.hooksPath = $(git config --get core.hooksPath)"
echo "   钩子文件：$(ls -1 .githooks | tr '\n' ' ')"
echo "   停用：git config --unset core.hooksPath"
