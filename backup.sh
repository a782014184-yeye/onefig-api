#!/bin/bash
# OneFig 备份策略（2026-09-21 配置，2026-09-21 追加 OSS 异地备份）
#   每日：核心业务数据（JSON + AI 记录，约 15MB）+ 后端代码，本机保留 14 天
#   每周日：全量数据（含 465MB 原图），本机保留 60 天
#   所有备份同时上传 OSS oss://onefig/backups/（异地容灾）
set -e
# cron 环境 PATH 不含 /usr/local/bin，ossutil64 在那里，必须显式声明
export PATH=/usr/local/bin:/usr/bin:/bin
DEST=/opt/backups/onefig
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M)

# 每日：JSON 业务数据 + 代码（2026-10-16 补 shares.json/comments：画板分享关系与批注此前只在周日全量里，删除事件当天无快照可回滚）
tar -czf "$DEST/onefig-json-$TS.tar.gz" -C /opt/onefig-api/data console submissions.json pricing-config.json ai boards shares.json comments
tar -czf "$DEST/onefig-code-$TS.tar.gz" -C /opt/onefig-api server.js console.js ai.js pay.js seo.js package.json package-lock.json

# 每周日：全量（含原图）
if [ "$(date +%u)" = "7" ]; then
  tar -czf "$DEST/onefig-full-$TS.tar.gz" -C /opt/onefig-api data
fi

# 上传 OSS 异地备份（失败不阻断本机备份，但记日志供看门狗发现）
for f in "$DEST"/*"$TS"*.tar.gz; do
  [ -f "$f" ] && ossutil64 cp -f "$f" "oss://onefig/backups/$(basename "$f")" >/dev/null 2>&1 \
    || echo "[$(date '+%F %T')] OSS-UPLOAD-FAIL: $f" >> /var/log/onefig-backup.log
done

find "$DEST" -name 'onefig-json-*.tar.gz' -mtime +14 -delete
find "$DEST" -name 'onefig-code-*.tar.gz' -mtime +14 -delete
find "$DEST" -name 'onefig-full-*.tar.gz' -mtime +60 -delete
# 清理 30 天前的访问/错误日志
find /opt/onefig-api/data/logs -name '*.log' -mtime +30 -delete 2>/dev/null || true
echo "[$(date '+%F %T')] backup done ($TS)"
