#!/bin/zsh
# LeafMem SQLite 每日备份脚本
# 由 daily-cleanup launchd 调用

set -euo pipefail

SOURCE="${LEAFMEM_DB:-$HOME/.leafmem/memory.sqlite}"
BACKUP_DIR="${LEAFMEM_BACKUP_DIR:-$HOME/.leafmem/backups}"
DATE_STR=$(/bin/date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/memory-${DATE_STR}.sqlite"

if [[ ! -f "$SOURCE" ]]; then
  echo "[leafmem-backup] ERROR: source not found: $SOURCE" >&2
  exit 1
fi

/usr/bin/sqlite3 "$SOURCE" ".backup '${BACKUP_FILE}'"

# 保留最近 7 天备份
find "$BACKUP_DIR" -name 'memory-*.sqlite' -mtime +7 -delete

echo "[leafmem-backup] OK: ${BACKUP_FILE}"
