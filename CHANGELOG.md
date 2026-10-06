# Changelog

本文档记录 onefig.cn 后端 API（onefig-api）所有用户可见与运维可见的变更，遵循 Keep a Changelog 与 SemVer。

## [Unreleased]

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
