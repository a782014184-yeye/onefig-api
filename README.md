# OneFig 后端（onefig.cn API）

## 部署约定（重要，所有会话必读）

本服务曾被「旧副本覆盖部署」弄出过两次线上事故。规则：

1. **动手前先看 git**：本目录是唯一权威源码。改动前先 `git status` / `git log` 确认没有别的会话留下的未提交改动；有就先问清楚再动。
2. **部署前比对线上版本**：`ssh root@47.98.165.254 'md5sum /opt/onefig-api/server.js'`，与本文件不一致时先查原因（多半是没部署的新改动，或有会话部署了旧版），确认后再发。
3. **部署步骤**：
   ```bash
   # ① 先在服务器上备份线上版本（<标签> 换成本次改动说明，如 pay-fix）
   ssh root@47.98.165.254 'cp /opt/onefig-api/server.js /opt/onefig-api/server.js.bak-$(date +%Y%m%d)-<标签>'
   # ② 上传新文件
   scp server.js root@47.98.165.254:/opt/onefig-api/server.js
   # ③ 核验线上 md5 与本地一致后再重启
   ssh root@47.98.165.254 'md5sum /opt/onefig-api/server.js && systemctl restart onefig-api'
   ```
   顺序：先备份线上 → scp → 核验 md5 → 重启。**切勿颠倒**——先传文件再备份，备份出来的就是新文件，回滚件直接丢失。
4. **部署后立即提交 git**：线上版本必须等于 git 最新 commit。
5. 测试用隔离实例：在服务器 `/opt/onefig-api` 里跑 `PORT=8090 DATA_DIR=$(mktemp -d) node server.js`——用本目录的 server.js 本体，靠端口 8090 + 独立数据目录与 8080 生产实例隔离；停止用 `fuser -k 8090/tcp`，千万别 pkill node（会误杀生产）。
6. **留底卫生**：服务器上的 `*.bak*` 只保留**最近 10 份**，超出即删。git（已推 Gitee）是权威历史，留底仅为最近部署的快速回滚；堆积旧副本正是历史事故的隐患来源。部署后顺手检查：`ls -t *.bak* | tail -n +11` 列出的都可删。

## 联调脚本

- `test-boards-api.sh` / `test-share-api.sh` / `test-lock-api.sh` / `test-comments-api.sh` — 各模块接口回归
- `test-author-comments.cjs` / `test-comment-delete.cjs` / `test-replies-api.cjs` — 批注作者侧/删除/回复（Node 直跑，打 127.0.0.1:8090 隔离实例）
