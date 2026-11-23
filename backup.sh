#!/bin/bash
# OneFig 备份策略：每日核心数据 + 完整运行源码；周日全量数据；本机/OSS 双副本。
set -e
export PATH=/usr/local/bin:/usr/bin:/bin

DEST=${BACKUP_ROOT:-/opt/backups/onefig}
DATA_ROOT=${DATA_ROOT:-/opt/onefig-api/data}
CODE_ROOT=${CODE_ROOT:-/opt/onefig-api}
LOG=${BACKUP_LOG:-/var/log/onefig-backup.log}
OSSUTIL=${OSSUTIL:-ossutil64}
mkdir -p "$DEST" "$(dirname "$LOG")"
TS=$(date +%Y%m%d-%H%M%S)
JSON_TAR="$DEST/onefig-json-$TS.tar.gz"
CODE_TAR="$DEST/onefig-code-$TS.tar.gz"
FULL_TAR="$DEST/onefig-full-$TS.tar.gz"

trap 'rc=$?; echo "[$(date "+%F %T")] BACKUP-FAIL line=$LINENO cmd=$BASH_COMMAND rc=$rc" >> "$LOG"; rm -f "$JSON_TAR" "$CODE_TAR" "$FULL_TAR"; exit $rc' ERR

[ -d "$DATA_ROOT" ] || { echo "[$(date '+%F %T')] BACKUP-FAIL missing-data-root=$DATA_ROOT" >> "$LOG"; exit 1; }
[ -d "$CODE_ROOT" ] || { echo "[$(date '+%F %T')] BACKUP-FAIL missing-code-root=$CODE_ROOT" >> "$LOG"; exit 1; }
for f in server.js package.json package-lock.json; do
  [ -f "$CODE_ROOT/$f" ] || { echo "[$(date '+%F %T')] BACKUP-FAIL missing-code=$f" >> "$LOG"; exit 1; }
done

# 核心数据必须存在；首次使用才创建的可选数据允许缺失，但必须留下 SKIP 记录。
DATA_CORE=(console)
DATA_OPT=(ai boards submissions.json shares.json comments ai-prompts.json pricing-config.json)
DATA_ARGS=()
for f in "${DATA_CORE[@]}"; do
  [ -e "$DATA_ROOT/$f" ] || { echo "[$(date '+%F %T')] BACKUP-FAIL missing-core=$f" >> "$LOG"; exit 1; }
  DATA_ARGS+=("$f")
done
for f in "${DATA_OPT[@]}"; do
  if [ -e "$DATA_ROOT/$f" ]; then DATA_ARGS+=("$f"); else echo "[$(date '+%F %T')] BACKUP-SKIP optional=$f" >> "$LOG"; fi
done

tar -czf "$JSON_TAR" -C "$DATA_ROOT" \
  --exclude='console/mail.json' --exclude='console/tinify.json' --exclude='secrets' \
  "${DATA_ARGS[@]}"

# 不再手工追逐 require 文件清单：保留完整运行源码，排除数据、依赖、密钥和历史副本。
tar -czf "$CODE_TAR" -C "$CODE_ROOT" \
  --exclude='./data' --exclude='./node_modules' --exclude='./.git' \
  --exclude='./secrets' --exclude='./.env' --exclude='./.env.*' \
  --exclude='./pay-config*.json' --exclude='./*.pem' --exclude='./*.key' \
  --exclude='./__pycache__' --exclude='./.DS_Store' --exclude='./*.bak*' .

if [ "$(date +%u)" = "7" ]; then
  tar -czf "$FULL_TAR" -C "$DATA_ROOT" \
    --exclude='console/mail.json' --exclude='console/tinify.json' --exclude='secrets' .
fi

for f in "$JSON_TAR" "$CODE_TAR" "$FULL_TAR"; do
  if [ -f "$f" ]; then
    if ! "$OSSUTIL" cp -f "$f" "oss://onefig/backups/$(basename "$f")" >/dev/null 2>&1; then
      echo "[$(date '+%F %T')] OSS-UPLOAD-FAIL: $f" >> "$LOG"
    fi
  fi
done

find "$DEST" -name 'onefig-json-*.tar.gz' -mtime +14 -delete
find "$DEST" -name 'onefig-code-*.tar.gz' -mtime +14 -delete
find "$DEST" -name 'onefig-full-*.tar.gz' -mtime +60 -delete
find "$DATA_ROOT/logs" -name '*.log' -mtime +30 -delete 2>/dev/null || true
# AI 源图只清 ai-src-*；AI 结果图可能被画板引用，不动。
find "$DATA_ROOT/files" -name 'ai-src-*' -mtime +1 -delete 2>/dev/null || true
echo "[$(date '+%F %T')] BACKUP-OK ts=$TS" >> "$LOG"
