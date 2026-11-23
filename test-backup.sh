#!/bin/bash
# 备份脚本隔离验收：虚构数据、假 OSS 上传器，不访问生产或外部服务。
set -e
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
DATA="$ROOT/data"
CODE="$ROOT/code"
OUT="$ROOT/out"
LOG="$ROOT/backup.log"
mkdir -p "$DATA/console" "$DATA/boards" "$CODE/ops" "$OUT" "$ROOT/bin"
printf '[{"id":"dummy-user"}]\n' > "$DATA/console/users.json"
printf '[]\n' > "$DATA/console/orders.json"
printf '{"custom":"dummy"}\n' > "$DATA/ai-prompts.json"
printf 'module.exports = {};\n' > "$CODE/server.js"
printf 'module.exports = {};\n' > "$CODE/console.js"
printf '{"name":"backup-test"}\n' > "$CODE/package.json"
printf '{"lockfileVersion":3}\n' > "$CODE/package-lock.json"
printf 'module.exports = {};\n' > "$CODE/ops/console-inline-lib.cjs"
printf 'secret-not-for-backup\n' > "$CODE/pay-config.local.json"
printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/ossutil64"
chmod +x "$ROOT/bin/ossutil64"

BACKUP_ROOT="$OUT" DATA_ROOT="$DATA" CODE_ROOT="$CODE" BACKUP_LOG="$LOG" OSSUTIL="$ROOT/bin/ossutil64" bash backend/backup.sh
JSON_TAR=$(find "$OUT" -name 'onefig-json-*.tar.gz' | head -1)
CODE_TAR=$(find "$OUT" -name 'onefig-code-*.tar.gz' | head -1)
[ -n "$JSON_TAR" ] && [ -n "$CODE_TAR" ]
tar -tzf "$JSON_TAR" | grep -q 'console/users.json'
tar -tzf "$JSON_TAR" | grep -q 'console/orders.json'
tar -tzf "$JSON_TAR" | grep -q 'ai-prompts.json'
tar -tzf "$CODE_TAR" | grep -q 'server.js'
tar -tzf "$CODE_TAR" | grep -q 'ops/console-inline-lib.cjs'
if tar -tzf "$CODE_TAR" | grep -q 'pay-config.local.json'; then echo '密钥配置误入备份'; exit 1; fi
grep -q 'BACKUP-OK' "$LOG"
grep -q 'BACKUP-SKIP optional=' "$LOG"

mkdir -p "$ROOT/restore"
tar -xzf "$CODE_TAR" -C "$ROOT/restore"
node --check "$ROOT/restore/server.js"
test -f "$ROOT/restore/ops/console-inline-lib.cjs"

# 核心目录缺失：必须非零、记录失败，不生成新的半截包。
mv "$DATA/console" "$DATA/console.missing"
if BACKUP_ROOT="$OUT" DATA_ROOT="$DATA" CODE_ROOT="$CODE" BACKUP_LOG="$LOG" OSSUTIL="$ROOT/bin/ossutil64" bash backend/backup.sh; then
  echo '核心目录缺失却备份成功'; exit 1
fi
grep -q 'BACKUP-FAIL missing-core=console' "$LOG"

echo '✓ 核心/可选数据、完整源码、密钥排除、成功/失败日志与恢复语法检查全部通过'
