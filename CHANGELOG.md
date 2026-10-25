# Changelog

本文档记录 onefig.cn 后端 API（onefig-api）所有用户可见与运维可见的变更，遵循 Keep a Changelog 与 SemVer。

## [Unreleased]

### Added
- 退款协议勾选全量合规（E11/O05，2026-10-23）：积分订单下单接口同会员/单张/导出一样强制 `refundConsent` 留痕；AI 工坊充值弹窗、账号中心「去支付」弹窗补齐勾选框，未勾选时支付按钮置灰禁用（三个支付入口统一，前端禁用 + 后端硬校验双保险）
- 画板导出付费弹窗补「购买即知悉」：署名义务（须注明出处 by onefig.cn）、授权码说明（文件名自带、验真页可查）、引用格式，与导出确认弹窗口径一致
- `/ai?buy=1` 自动弹充值弹窗：导航下拉「充值积分 →」直达 AI 工坊并自动弹窗，参数即用即清（刷新不重复弹）
- 支付集成测试门禁进部署脚本（部署上线.command [2/7]）：35+ 项测试不通过则中止部署；测试扩至 36 项（新增积分订单未勾选被拒、微信 Native 全链路假服务器、单张素材购买、查单兜底）
- 待支付订单有效期与支付渠道硬对齐（2026-10-18）：支付宝下单带 `timeout_express: 24h`（超时支付宝自动关单），订单标记 expired 时主动调用微信关单接口关闭旧预支付单——杜绝「页面显示已失效但旧二维码/旧收银台仍能付款」的窗口
- 待支付订单 24 小时有效期（2026-10-17）：超时显示「已失效」且不可再支付；账号中心待支付订单显示支付倒计时（⏳ 剩 X），「🧹 清空已失效订单」按钮一键删除本人名下失效单（会员 + 积分，`DELETE /api/orders/expired`）；后端复用待支付订单时自动把超期单标记 expired 并开新单，轮询与清空接口同一 TTL 口径
- 账号中心新增「⚡ 积分订单」区块（`/api/me` 返回 creditOrders），待支付积分订单可继续付款
- 待支付订单「去支付」（账号中心）：会员/积分待支付订单均可点击复用原订单继续在线支付；微信二维码有效期内直接复用、过期自动关旧单换新码；后端 `findOrCreateOrder` 返回 reused 标记
- 会员购买防重复与差价升级（2026-10-17）：已是某档会员时，下单接口拒绝购买同档或更低档位（409，前端购买页同步禁用按钮并显示「当前会员方案 / 低于当前会员方案」）；升级更高档按差价收费（如青果→红果 ¥70），赠送积分按「目标档应得 − 已赠送」补差（+750），流水原因区分「开通/升级」
- 积分充值接入在线支付（2026-10-17）：`POST /api/pay/wechat/native` 与 `POST /api/pay/alipay/pagepay` 新增 `creditPkg` 参数（会员 `plan` 与积分套餐二选一），积分订单复用 `ai/credit-orders.json` 存储，支付成功自动入账积分并记流水（幂等，与人工确认同一记法）
- 微信/支付宝回调与查单兜底支持积分订单：按 out_trade_no 跨订单存储查找，金额校验通过后自动履约（积分订单 → 入账；会员订单 → 升级）
- `GET /api/orders/:id/status` 支持积分订单查询（返回 `credits`），前端统一轮询
- 前端 AI 工坊「充值积分」弹窗改为在线支付流程（微信扫码 / 支付宝收银台 → 自动到账）；在线支付未配置时回退原人工转账
- 后台用户详情新增「🧾 积分订单」标签页（下单时间/积分/金额/状态/渠道/流水号）；积分统计套餐名更新为现行档位（100/800/2000）
- 新增 `test-pay-credit.cjs`：9 项积分支付集成测试（自签密钥模拟支付宝回调：下单/验签入账/幂等/金额防篡改/状态查询/未配置降级）

## [1.5.0] - 2026-10-25

### Security（安全审计 ISSUE-3）
- **注册邮箱验证上线**：新注册账号标记 `verified:false`，发送 6 位验证码（复用找回密码通道，每邮箱每小时 3 封、错 5 次作废）；新增 `POST /api/auth/register/verify` 与 `/register/resend`。设计为软闸门：未验证账号可登录可浏览，仅冻结 AI 免费试用额度（`chargeAIEdit`/`chargeAILocal`/ai.js 生成三处闸门），防批量小号薅羊毛；老用户无 `verified` 字段视为已验证，存量无感
- 注册邮箱正则同步排除引号字符（nodemailer addressparser 漏洞的纵深防御）

## [1.6.0] - 2026-10-25

### Security（应所有者要求升级硬闸门）
- **注册必须验证邮箱才能登录**：注册接口不再返回 token；未验证账号登录返回 403 + `code:'unverified'` 并自动重发验证码；找回密码成功即视为邮箱归属已证明（自动标记 verified，防卡死循环）
- 1.5.0 的软闸门（冻结 AI 免费额度）保留作为第二层

## [1.4.1] - 2026-10-25

### Security（安全审计 run-1 修复）
- **导出存档接口加固（ISSUE-1）**：`/api/export/archive` 新增权益闸门（仅会员/持有导出权益/有导出记录的账号可存档）+ 每用户每小时 30 次限流；闸门在 multer 落盘之前，免费账号无法再刷写磁盘
- **依赖漏洞修复（ISSUE-2）**：`npm audit fix`——body-parser 1.20.8→1.20.9（高危 DoS）、multer 2.4.0→2.5.0（高危 DoS）、nodemailer 10.0.16→10.2.1（中危地址解析）；npm audit 现 0 漏洞
- 审计报告与证据链：`../security-audit/run-1/`（Cloudflare security-audit 六阶段流程，14 条记录全部校验通过）

## [1.4.0] - 2026-10-15

### Added
- 微信支付 Native 扫码支付（`pay.js`，APIv3 零第三方依赖）：`POST /api/pay/wechat/native` 下单返回 code_url、`POST /api/pay/wechat/notify` 支付回调（平台证书验签 + AES-256-GCM 解密 + 金额/商户号校验，幂等）、`GET /api/orders/:id/status` 订单轮询（超 20 秒未回调时主动向微信查单兜底）、`GET /api/pay/config` 支付能力探测
- 支付成功自动升级会员并赠送积分，与后台人工确认共用 `markOrderPaid`（单一事实来源）
- 配置经 `pay-config.local.json`（已 gitignore，模板 `pay-config.example.json`），未配置时优雅降级为原人工转账流程
- 新增 `test-pay.cjs`：12 项单元测试（签名/验签/防重放/解密/幂等升级）

### Changed
- 后台订单确认 `POST /console/api/orders/:id/confirm` 改为调用 `pay.js` 的 `markOrderPaid`

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
