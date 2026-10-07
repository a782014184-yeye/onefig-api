#!/bin/bash
# OneFig 看门狗：备份超期 / 磁盘 / 内存 / 服务存活检查
# 部署：/opt/onefig-api/watchdog.sh，cron：*/30 * * * *
LOG=/var/log/onefig-watchdog.log
NOW=$(date '+%F %T')
alert() { echo "[$NOW] ALERT: $1" >> "$LOG"; }

# 1. 备份日志超过 26 小时无更新 → 备份静默失败
if [ -f /var/log/onefig-backup.log ]; then
  LAST=$(stat -c %Y /var/log/onefig-backup.log 2>/dev/null || stat -f %m /var/log/onefig-backup.log)
  [ $(( $(date +%s) - LAST )) -gt 93600 ] && alert "备份超过26小时未执行"
else
  alert "备份日志不存在"
fi

# 2. 磁盘 > 80%
USE=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
[ "$USE" -gt 80 ] && alert "磁盘使用率 ${USE}%"

# 3. API 健康检查
curl -sf -m 5 http://127.0.0.1:8080/healthz >/dev/null || alert "onefig-api 健康检查失败"

# 4. rembg 服务存活（根路径无路由返回 404 属正常，探测 /docs）
curl -sf -m 5 -o /dev/null http://127.0.0.1:9000/docs || alert "rembg 服务无响应"

# 5. 近 26 小时内备份日志出现 OSS 上传失败记录
CUTOFF=$(date -d '26 hours ago' '+%F %T' 2>/dev/null)
if [ -n "$CUTOFF" ] && grep -h "OSS-UPLOAD-FAIL" /var/log/onefig-backup.log 2>/dev/null \
  | awk -v c="$CUTOFF" '{ts=substr($0,2,19)} ts>c {f=1} END{exit !f}'; then
  alert "近26小时内存在 OSS 备份上传失败"
fi
