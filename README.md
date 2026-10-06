# OneFig 后端（onefig.cn API）

## 部署约定（重要，所有会话必读）

本服务曾被「旧副本覆盖部署」弄出过两次线上事故。规则：

1. **动手前先看 git**：本目录是唯一权威源码。改动前先 `git status` / `git log` 确认没有别的会话留下的未提交改动；有就先问清楚再动。
2. **部署前比对线上版本**：`ssh root@47.98.165.254 'md5sum /opt/onefig-api/server.js'`，与本文件不一致时先查原因（多半是没部署的新改动，或有会话部署了旧版），确认后再发。
3. **部署步骤**：
   ```bash
   scp server.js root@47.98.165.254:/opt/onefig-api/server.js
   ssh root@47.98.165.254 'cp /opt/onefig-api/server.js /opt/onefig-api/server.js.bak-$(date +%Y%m%d)-<标签>  # 注意：先备份再传
   systemctl restart onefig-api'
   ```
   顺序：先备份线上 → scp → 核验 md5 → 重启。
4. **部署后立即提交 git**：线上版本必须等于 git 最新 commit。
5. 测试用隔离实例：`PORT=8090 DATA_DIR=$(mktemp -d) node server.js`（在服务器 /opt/onefig-api 里跑，脚本名别叫 server.js，杀进程用 `fuser -k 8090/tcp`，千万别 pkill node）。

## 联调脚本

- `test-boards-api.sh` / `test-share-api.sh` / `test-lock-api.sh` / `test-comments-api.sh` — 各模块接口回归
- `test-author-comments.cjs` / `test-comment-delete.cjs` / `test-replies-api.cjs` — 批注作者侧/删除/回复（Node 直跑，打 127.0.0.1:8090 隔离实例）
