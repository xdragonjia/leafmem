#!/bin/zsh
# LeafMem SQLite 每日备份脚本
# 由 launchd com.leafmem.sqlite-backup 调用（每日 03:15）
#
# v2（2026-10-20）：补「备份可用性」与「失败可知」两条硬要求。
#   旧版只做 .backup + 输出 OK，失败仅写 stderr 且无人读 —— 08-12 备份静默断链 2 天即由此而来。
#   现版：备份后校验 quick_check + 行数对齐，并落 .last-backup-status.json 供哨兵判活。
#   🔴 校验一律用 immutable=1 打开，避免生成 -shm/-wal 垃圾（旧版校验路径留下的孤儿 sidecar 达 88 个）。

set -euo pipefail

SOURCE="${LEAFMEM_DB:-$HOME/.leafmem/memory.sqlite}"
BACKUP_DIR="${LEAFMEM_BACKUP_DIR:-$HOME/.leafmem/backups}"
STATUS="$BACKUP_DIR/.last-backup-status.json"
DATE_STR=$(/bin/date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/memory-${DATE_STR}.sqlite"
TS=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)

write_status() {
  local ok="$1" detail="$2" src_rows="${3:-0}" bak_rows="${4:-0}" bytes="${5:-0}"
  printf '{"ts":"%s","ok":%s,"file":"%s","bytes":%s,"src_rows":%s,"bak_rows":%s,"detail":"%s"}\n' \
    "$TS" "$ok" "$BACKUP_FILE" "$bytes" "$src_rows" "$bak_rows" "$detail" > "$STATUS"
}

on_error() {
  local code=$?
  trap - ERR
  # 半成品必须删掉：0 字节/残缺备份留在目录里比没有备份更危险（会被误当可用快照去恢复）
  [[ -f "$BACKUP_FILE" ]] && /bin/rm -f "$BACKUP_FILE" "${BACKUP_FILE}-wal" "${BACKUP_FILE}-shm"
  write_status false "exit=${code} line=${1:-?}"
  echo "[leafmem-backup] ERROR: exit=${code} line=${1:-?}" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

if [[ ! -f "$SOURCE" ]]; then
  write_status false "source_not_found"
  echo "[leafmem-backup] ERROR: source not found: $SOURCE" >&2
  exit 1
fi

# 1) 源库行数（在线库正常打开；其 -wal 属活库自身状态，勿删）
SRC_ROWS=$(/usr/bin/sqlite3 "$SOURCE" "SELECT COUNT(*) FROM memory_items;")

# 2) 在线备份（.backup 是 SQLite 官方一致性快照，无需停服）
/usr/bin/sqlite3 "$SOURCE" ".backup '${BACKUP_FILE}'"

# 3) 校验：可读 + 结构完好 + 行数与源一致，三者缺一即判失败
#    🔴 用普通打开而非 immutable：备份可能带 -wal，immutable 会忽略它而少读行数（假不一致）。
#    校验完立即删掉本次产生的 sidecar（SQLite 在最后连接关闭时会 checkpoint，删除安全）。
QUICK=$(/usr/bin/sqlite3 "$BACKUP_FILE" "PRAGMA quick_check;" | head -1)
BAK_ROWS=$(/usr/bin/sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM memory_items;")
BYTES=$(/usr/bin/stat -f%z "$BACKUP_FILE")
/bin/rm -f "${BACKUP_FILE}-wal" "${BACKUP_FILE}-shm"

if [[ "$QUICK" != "ok" ]]; then
  write_status false "quick_check=${QUICK}" "$SRC_ROWS" "$BAK_ROWS" "$BYTES"
  echo "[leafmem-backup] ERROR: quick_check=${QUICK}" >&2
  exit 2
fi
if [[ "$BAK_ROWS" != "$SRC_ROWS" ]]; then
  write_status false "row_mismatch src=${SRC_ROWS} bak=${BAK_ROWS}" "$SRC_ROWS" "$BAK_ROWS" "$BYTES"
  echo "[leafmem-backup] ERROR: row mismatch src=${SRC_ROWS} bak=${BAK_ROWS}" >&2
  exit 3
fi

# 4) 保留策略：SQLite 备份 7 天；sidecar 随主文件同步过期
find "$BACKUP_DIR" -name 'memory-*.sqlite' -mtime +7 -delete
find "$BACKUP_DIR" \( -name 'memory-*.sqlite-wal' -o -name 'memory-*.sqlite-shm' \) -mtime +7 -delete
# 孤儿 sidecar：主文件已不存在者直接删（纯垃圾，不承载数据）
for f in "$BACKUP_DIR"/memory-*.sqlite-wal(N) "$BACKUP_DIR"/memory-*.sqlite-shm(N); do
  base="${f%.sqlite-*}.sqlite"
  [[ -f "$base" ]] || /bin/rm -f "$f"
done

write_status true "verified" "$SRC_ROWS" "$BAK_ROWS" "$BYTES"
echo "[leafmem-backup] OK: ${BACKUP_FILE} rows=${BAK_ROWS} bytes=${BYTES} quick_check=ok"
