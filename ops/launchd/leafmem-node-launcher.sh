#!/bin/bash
# LeafMem agent 启动包装器（产品内置，2026-09-01 收编）
# 解决问题：launchd plist 写死受管 node 精确版本路径，WorkBuddy 升级 node
# 后旧版本目录被删，launchd 拉起失败 exit 78（EX_CONFIG），console :3377 不可达。
# 机制：启动时动态读取 WorkBuddy 受管 node 的 versions/current 指针文件解析
# node 路径；指针缺失/指向不存在版本时兜底取版本号最大的目录；均失败则
# exit 78 并输出可诊断错误。
# 部署：plist ProgramArguments 首元素指向本脚本（模板占位符 __LEAFMEM_REPO__）。
NODE_BASE="$HOME/.workbuddy/binaries/node/versions"
CUR_FILE="$NODE_BASE/current"

VER="$(tr -d '[:space:]' < "$CUR_FILE" 2>/dev/null)"
NODE_BIN="$NODE_BASE/$VER/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(ls -d "$NODE_BASE"/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[leafmem-node-launcher] FATAL: no usable managed node found under $NODE_BASE" >&2
  exit 78
fi

exec "$NODE_BIN" "$@"
