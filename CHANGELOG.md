# Changelog

本文档记录 onefig.cn 后端 API（onefig-api）所有用户可见与运维可见的变更，遵循 Keep a Changelog 与 SemVer。

## [Unreleased]

## [1.3.0] - 2026-10-08

### Added
- SEO 公开页服务端直出（`seo.js`）：`GET /sitemap.xml`（596 个 URL，随素材数据实时生成）、素材详情落地页 `/m/:series/:title`、系列页 `/s/:series`，均含完整 meta/og/JSON-LD 结构化数据，404 有友好页

### Ops
- nginx 开启 gzip（主 JS 608KB→180KB，-70%）；带哈希构建产物长缓存一年、index.html 与画板入口 no-cache、静态图一周缓存
- 补齐安全响应头（HSTS / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy），配置入库 `ops/onefig.nginx.conf`
- nginx 新增 /sitemap.xml、/m/、/s/ 反代路由

## [1.2.0] - 2026-10-08

### Added
- 管理后台新增「🩺 网站体检」页：服务器实时健康检查（主服务/AI 抠图服务/磁盘/内存/每日备份/云端异地备份/看门狗告警/系统版本），绿黄红三色可视化展示，附非技术人员可读的说明与处置建议；新增 `GET /console/api/health`（consoleAuth 保护，固定命令执行，无注入面）

### Fixed
- backup.sh 显式声明 PATH，修复 cron 环境下 ossutil64 找不到导致 OSS 上传静默失败；上传失败现写入备份日志供看门狗检测
- watchdog.sh 新增 OSS 上传失败检测项

## [1.1.1] - 2026-10-06

首个纳入版本管理的基线（对应当前线上版本，md5 已核验一致）。

### Added（基线能力）
- 素材 API：列表 / 分类 / 搜索 / 详情 / 下载（含授权码 OF-年份-6 位，GB 45438-2025 AIGC 隐式标识）
- 用户体系：注册登录（scrypt 加盐哈希）、token（HMAC 签名、30 天过期、pwdVer 失效）、找回密码（163 SMTP 验证码）
- 订单与会员、下载计数、求素材、用户上传
- 管理后台（console.js）：独立登录页 + Bearer token，素材/订单/用户/定价管理
- AI 工坊（ai.js）：积分、生图任务、选图、积分订单；对接阿里云百炼 qwen-image-edit-plus；rembg 抠图服务（127.0.0.1:9000）
- 公开验真页 API：凭授权码查询授权状态（不泄露用户信息）

### Security（基线状态）
- 上传魔数校验覆盖全部 6 个上传点（2026-09-21）
- 接口限流：注册/登录 20 次/10 分钟、track-download 60 次/10 分钟、求素材 5 次/10 分钟
- 密钥全部存于 `/opt/onefig-api/onefig-api.env`（600），代码与 git 历史无明文
- CORS：后台接口不再返回跨域头，公开接口保持 `*`

### Ops（基线状态）
- 访问 / 错误 / 登录失败审计三类日志，按天滚动 30 天清理
- 每日 03:40 备份（JSON+代码留 14 天、周日全量留 60 天），同步 OSS 异地
- systemd 自动重启 + /healthz 健康检查
