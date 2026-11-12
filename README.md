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

## AI 透明底质检

- 生成素材统一让生图模型输出纯白背景，再由本地抠图服务透明化，避免把“透明背景”画成灰白棋盘格。
- 每个任务只生图 1 次，同一原图本地去背景也只执行 1 次，不做第二次生成或本地重试；透明结果仍检查边缘背景残留、空图和背景几乎未去除，最终失败沿用现有退款逻辑。
- Alpha 使用明暗自适应的选择性并集：浅色主体保持保守阈值；深色主体提高白底洪泛容差，并清理画面下部高亮低饱和地面及被主体包围的接触阴影。有颜色的脚趾、耳朵、尾巴和上方白色细节必须由模型恢复。
- rembg 请求统一由 `rembg-multipart.js` 组装，model 字段先于 image 文件，避免插画模型收到空图片。洪泛只用于补充模型结果；AI 抠图模型不可用时禁止洪泛单路交付，防止白色或浅色主体被挖空。
- `cleanEdge` 只收缩邻近透明区域的近白色 fringe，并对半透明像素做白色去污染与轻微 Alpha 柔化；不整体缩边、不改变不透明主体。黑鼠白边与白鼠完整性均须离线样本验证。
- 任务目录中的 `source-c*.png` 是唯一一次生图的原图，`rejected-c*-a*.png` 是被质检拦截的结果，`qc-c*.json` 是检测报告；均仅供服务端排障，不通过公开图片路由暴露，删除生成记录时一并删除。
- `node test-transparency.cjs` 可运行透明底合成图、自动重试和旧提示词兼容测试，不请求外部 AI 服务。

## 联调脚本

- `test-boards-api.sh` / `test-share-api.sh` / `test-lock-api.sh` / `test-comments-api.sh` — 各模块接口回归
- `test-author-comments.cjs` / `test-comment-delete.cjs` / `test-replies-api.cjs` — 批注作者侧/删除/回复（Node 直跑，打 127.0.0.1:8090 隔离实例）
- `test-transparency.cjs` — 透明底检查与重试（Node 直跑，无外部服务依赖）
