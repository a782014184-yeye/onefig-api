// OneFig 在线支付模块（2026-10-08）
// 微信支付 Native 扫码 + 支付宝电脑网站支付（均为官方接口、零第三方依赖，只用 Node 内置 crypto/https）
//
// 微信链路：前端下单 → 后端调 Native 下单拿 code_url → 前端展示二维码 →
//           微信回调 /api/pay/wechat/notify（验签+解密）→ 自动升级会员
// 支付宝链路：前端下单 → 后端返回收银台 URL（alipay.trade.page.pay，RSA2 签名）→
//            用户跳转支付宝付款 → 支付宝回调 /api/pay/alipay/notify（验签）→ 自动升级会员
// 共同兜底：前端轮询 /api/orders/:id/status 时，后端主动向微信/支付宝查单（防回调丢失）
//
// 2026-10-17 扩展：积分充值同样走在线支付（creditPkg 参数），订单复用 ai/credit-orders.json，
// 支付成功自动入账积分并记流水，后台积分统计/流水自动纳入，无需人工确认。
//
// 配置：pay-config.local.json（不进 git，模板见 pay-config.example.json）
// ⚠️ APIv3 密钥、商户私钥只放服务器，绝不提交到代码仓库。

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const WX_API_HOST = 'api.mch.weixin.qq.com';
const MEMBER_GIFT = { basic: 150, pro: 900, team: 3000 }; // 与 console.js 保持一致：开通会员一次性赠送积分
const PLAN_RANK = { basic: 1, pro: 2, team: 3 }; // 会员档位序：用于重复购买拦截与差价升级
// 单张素材统一价（服务端为准，前端只展示；可通过环境变量覆盖）
const SINGLE_PRICE = Math.round((Number(process.env.ONEFIG_SINGLE_PRICE) || 6.9) * 100) / 100;

// ---------- 配置加载 ----------
function loadConfig() {
  const file = process.env.ONEFIG_PAY_CONFIG || path.join(__dirname, 'pay-config.local.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = { wechat: null, alipay: null };

    const w = cfg.wechat || {};
    if (w.enabled) {
      const certFile = path.resolve(__dirname, w.certFile || 'secrets/apiclient_cert.pem');
      const keyFile = path.resolve(__dirname, w.keyFile || 'secrets/apiclient_key.pem');
      if (!w.appid || !w.mchid || !w.apiV3Key || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
        console.warn('[pay] 微信支付配置不完整（缺 appid/mchid/apiV3Key/证书文件），扫码支付暂不开放');
      } else {
        const certPem = fs.readFileSync(certFile, 'utf8');
        const keyPem = fs.readFileSync(keyFile, 'utf8');
        let serialNo = w.serialNo || '';
        if (!serialNo) {
          try { serialNo = new crypto.X509Certificate(certPem).serialNumber.replace(/:/g, '').toUpperCase(); }
          catch (e) { console.warn('[pay] 读取证书序列号失败：' + e.message); }
        }
        // 微信支付公钥（新商户公钥模式，2026-10-19）：商户平台「API安全→微信支付公钥」下载
        const pubKeyFile = w.pubKeyFile ? path.resolve(__dirname, w.pubKeyFile) : '';
        const pubKeyPem = pubKeyFile && fs.existsSync(pubKeyFile) ? fs.readFileSync(pubKeyFile, 'utf8') : '';
        out.wechat = { appid: w.appid, mchid: w.mchid, apiV3Key: w.apiV3Key, notifyUrl: w.notifyUrl, appSecret: w.appSecret || '', jsapiAppid: w.jsapiAppid || w.appid, jsapiEnabled: w.jsapiEnabled !== false, h5Enabled: !!w.h5Enabled, pubKeyId: w.pubKeyId || '', pubKeyPem, certPem, keyPem, serialNo };
      }
    }

    const a = cfg.alipay || {};
    if (a.enabled) {
      const priFile = path.resolve(__dirname, a.privateKeyFile || 'secrets/alipay-app-private.pem');
      const pubFile = path.resolve(__dirname, a.alipayPublicKeyFile || 'secrets/alipay-public.pem');
      if (!a.appid || !a.notifyUrl || !fs.existsSync(priFile) || !fs.existsSync(pubFile)) {
        console.warn('[pay] 支付宝配置不完整（缺 appid/notifyUrl/密钥文件），支付宝支付暂不开放');
      } else {
        out.alipay = {
          appid: a.appid,
          notifyUrl: a.notifyUrl,
          returnUrl: a.returnUrl || 'https://onefig.cn/pricing',
          gateway: a.gateway || 'https://openapi.alipay.com/gateway.do',
          privateKey: fs.readFileSync(priFile, 'utf8'),
          alipayPublicKey: fs.readFileSync(pubFile, 'utf8'),
        };
      }
    }
    return out;
  } catch {
    return { wechat: null, alipay: null }; // 配置文件不存在 = 未开通在线支付，走原人工转账流程
  }
}

// ---------- 微信支付 APIv3 签名（商户私钥 RSA-SHA256）----------
function wxSign(method, urlPath, body, w) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), w.keyPem).toString('base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${w.mchid}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${w.serialNo}",signature="${signature}"`;
}

function wxRequest(w, method, urlPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: WX_API_HOST, path: urlPath, method,
      headers: {
        'Authorization': wxSign(method, urlPath, body, w),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'OneFig/1.0',
      },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 微信开放接口（OAuth 换 openid 等）：GET JSON，不经过商户 API v3 签名
function httpsGetJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', reject);
  });
}

// 公众号网页授权 code → openid（JSAPI 必需；需要 pay-config 里的 wechat.appSecret）
async function getWechatOpenid(w, code) {
  if (!w || !w.appSecret) throw new Error('公众号 AppSecret 未配置');
  if (!code) throw new Error('缺少微信授权 code');
  const appid = w.jsapiAppid || w.appid;
  const url = 'https://api.weixin.qq.com/sns/oauth2/access_token?' + new URLSearchParams({
    appid, secret: w.appSecret, code, grant_type: 'authorization_code',
  }).toString();
  const r = await httpsGetJson(url);
  if (!r.json || !r.json.openid) {
    const detail = r.json ? `${r.json.errcode || ''} ${r.json.errmsg || ''}`.trim() : '';
    throw new Error(detail || '微信网页授权失败');
  }
  return { openid: r.json.openid, appid };
}

// JSAPI 支付参数签名：appId\ntimeStamp\nnonceStr\npackage\n
function jsapiPayParams(w, prepayId) {
  const appId = w.jsapiAppid || w.appid;
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = crypto.sign('RSA-SHA256', Buffer.from(message), w.keyPem).toString('base64');
  return { appId, timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

// ---------- 平台证书（用于回调验签）：/v3/certificates 获取，AES-256-GCM 解密，按天缓存 ----------
function aes256gcmDecrypt(key32, nonce, ad, ciphertextB64) {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key32, 'utf8'), Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(ad, 'utf8'));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function getPlatformCerts(w, cacheFile) {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.certs && cache.fetchedAt && Date.now() - cache.fetchedAt < 20 * 36e5) return cache.certs;
  } catch {}
  const r = await wxRequest(w, 'GET', '/v3/certificates', null);
  if (r.status !== 200 || !r.json || !r.json.data) throw new Error('获取微信平台证书失败：HTTP ' + r.status);
  const certs = {};
  for (const item of r.json.data) {
    const c = item.encrypt_certificate;
    certs[item.serial_no] = aes256gcmDecrypt(w.apiV3Key, c.nonce, c.associated_data, c.ciphertext);
  }
  const tmp = cacheFile + '.tmp';
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), certs }));
  fs.renameSync(tmp, cacheFile);
  return certs;
}

// ---------- 支付宝：RSA2 签名/验签（电脑网站支付，alipay.trade.page.pay）----------
// 签名串规则：所有非空参数按 key ASCII 升序，key=value 用 & 连接（值不编码），RSA2(SHA256withRSA) 签名
function alipaySignStr(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '' && k !== 'sign')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}
function alipaySign(params, privateKeyPem) {
  return crypto.sign('RSA-SHA256', Buffer.from(alipaySignStr(params)), privateKeyPem).toString('base64');
}
function alipayVerify(params, sign, publicKeyPem) {
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(alipaySignStr(params)), publicKeyPem, Buffer.from(String(sign || ''), 'base64'));
  } catch { return false; }
}
function alipayTimestamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 组装支付宝网关 URL（下单跳转发给用户浏览器）
function alipayPageUrl(a, method, bizContent, extra) {
  const params = {
    app_id: a.appid, method, charset: 'utf-8', sign_type: 'RSA2',
    timestamp: alipayTimestamp(new Date()), version: '1.0',
    ...(extra || {}), biz_content: JSON.stringify(bizContent),
  };
  params.sign = alipaySign(params, a.privateKey);
  return a.gateway + '?' + Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
}
// 服务端直调支付宝 API（查单兜底用）
function alipayApiCall(a, method, bizContent) {
  return new Promise((resolve, reject) => {
    const url = new URL(alipayPageUrl(a, method, bizContent));
    const body = url.search.slice(1);
    const req = https.request({
      host: url.host, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('支付宝接口请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- 回调验签：Wechatpay-Signature = RSA-SHA256(timestamp\nnonce\nbody\n) ----------
function verifyNotifySignature(certs, headers, rawBody, pubKeyPem) {
  const ts = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const sig = String(headers['wechatpay-signature'] || '');
  // 公钥模式的回调头为 Wechatpay-PublicKey-Id，证书模式为 Wechatpay-Serial
  const serial = String(headers['wechatpay-serial'] || headers['wechatpay-publickey-id'] || '');
  if (!serial || !ts || !nonce || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 防重放：5 分钟窗口
  // 公钥模式（2024 后新商户，平台不再下发证书，/v3/certificates 返回 RESOURCE_NOT_EXISTS）：
  // 直接用商户平台下载的「微信支付公钥」验签；老商户仍走平台证书
  const pem = pubKeyPem || certs[serial];
  if (!pem) return false;
  const message = `${ts}\n${nonce}\n${rawBody}\n`;
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(message), pem, Buffer.from(sig, 'base64'));
  } catch { return false; }
}

// ---------- 订单落库：支付成功 → 升级会员 + 赠送积分（幂等，重复回调安全）----------
// 与 console.js 的人工确认逻辑保持一致；console.js 的 confirm 也改为调用本函数。
function markOrderPaid(DATA_DIR, orderId, extra) {
  const CONSOLE_DIR = path.join(DATA_DIR, 'console');
  const USERS_FILE = path.join(CONSOLE_DIR, 'users.json');
  const ORDERS_FILE = path.join(CONSOLE_DIR, 'orders.json');
  const PURCHASES_FILE = path.join(CONSOLE_DIR, 'purchases.json');
  const CREDIT_LOG = path.join(DATA_DIR, 'ai', 'credit-log.json');
  const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const saveJSON = (f, rows) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); };

  const users = loadJSON(USERS_FILE, []);
  const orders = loadJSON(ORDERS_FILE, []);
  const o = orders.find(x => x.id === orderId);
  if (!o) return null;
  if (o.status === 'paid') return { order: o, already: true };

  o.status = 'paid';
  o.paidAt = (extra && extra.paidAt) || new Date().toISOString();
  if (extra && extra.channel) o.channel = extra.channel;
  if (extra && extra.transactionId) o.transactionId = extra.transactionId;

  // 单张素材购买：授予该用户这张素材的永久下载权益，不改会员等级
  if (o.kind === 'export') {
    // 画板导出单次权益：paid 后 +1 次（导出时经 /api/export/permit 核销）
    const u = users.find(x => x.id === o.userId);
    if (u) {
      u.exportCredits = (u.exportCredits || 0) + 1;
      saveJSON(USERS_FILE, users);
    }
    saveJSON(ORDERS_FILE, orders);
    return { order: o, already: false };
  }

  if (o.materialId) {
    const purchases = loadJSON(PURCHASES_FILE, []);
    if (!purchases.some(p => p.userId === o.userId && p.materialId === o.materialId)) {
      purchases.push({
        userId: o.userId,
        materialId: o.materialId,
        materialTitle: o.materialTitle || '',
        orderId: o.id,
        amount: o.amount,
        channel: o.channel || '',
        paidAt: o.paidAt,
        refundConsent: !!o.refundConsent,
        refundConsentAt: o.refundConsentAt || null,
      });
      saveJSON(PURCHASES_FILE, purchases);
    }
    saveJSON(ORDERS_FILE, orders);
    return { order: o, already: false };
  }

  const PLAN_NAMES = { basic: '青果会员', pro: '红果会员', team: '金果会员' };
  const u = users.find(x => x.id === o.userId);
  if (u) {
    u.level = o.plan;
    if (!u.memberSince) u.memberSince = o.paidAt;
    if (!u.name && o.userName) u.name = o.userName;
    // 赠送积分：按「目标档位应得总额 − 已赠送额」补差（升级只补差价，如青果→红果 +750）
    const targetGift = MEMBER_GIFT[o.plan] || 0;
    const granted = MEMBER_GIFT[u.creditsGrantedFor] || 0;
    const delta = targetGift - granted;
    if (delta > 0 && u.creditsGrantedFor !== o.plan) {
      u.creditsGrantedFor = o.plan;
      u.credits = (u.credits || 0) + delta;
      const verb = granted > 0 ? '升级' : '开通';
      const log = loadJSON(CREDIT_LOG, []);
      log.push({ userId: u.id, name: u.name, delta, reason: verb + (PLAN_NAMES[o.plan] || o.plan) + '赠送', time: new Date().toISOString(), by: 'system' });
      fs.mkdirSync(path.dirname(CREDIT_LOG), { recursive: true });
      saveJSON(CREDIT_LOG, log);
    }
  }
  saveJSON(USERS_FILE, users);
  saveJSON(ORDERS_FILE, orders);
  return { order: o, already: false };
}

// ---------- 路由注册 ----------
module.exports = function registerPay(app, deps) {
  const { authUser, DATA_DIR, PLANS, CREDIT_PACKAGES, loadUsers, saveUsers, logLine } = deps;
  const CONSOLE_DIR = path.join(DATA_DIR, 'console');
  const ORDERS_FILE = path.join(CONSOLE_DIR, 'orders.json');
  const CREDIT_ORDERS_FILE = path.join(DATA_DIR, 'ai', 'credit-orders.json');
  const CREDIT_LOG = path.join(DATA_DIR, 'ai', 'credit-log.json');
  const CERTS_CACHE = path.join(CONSOLE_DIR, 'wx-platform-certs.json');
  const MATERIALS_FILE = path.join(CONSOLE_DIR, 'materials.json');
  const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const saveJSON = (f, rows) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); };
  const log = (msg) => { if (logLine) logLine('pay', msg); else console.log('[pay]', msg); };
  const findMaterial = (id) => {
    for (const s of loadJSON(MATERIALS_FILE, [])) {
      for (const m of s.materials || []) if (m.id === id) return { s, m };
    }
    return null;
  };

  // 待支付订单有效期：超期显示「已失效」，不可再支付，可一键清空（2026-10-17）
  // 2026-10-18 收紧：与渠道侧硬对齐 —— 支付宝下单带 timeout_express=24h（超时支付宝自动关单），
  // 订单标记失效时主动关闭微信旧预支付单，杜绝「页面显示已失效但旧二维码仍能付款」的窗口
  const PENDING_TTL = 24 * 60 * 60 * 1000;
  const isStalePending = o => o.status === 'pending' && Date.now() - Date.parse(o.createdAt) > PENDING_TTL;
  // 返回本次新标记为 expired 的订单
  const markStaleExpired = (list, req) => {
    const marked = [];
    list.forEach(o => {
      if (o.userId === req.user.id && isStalePending(o)) {
        o.status = 'expired';
        o.expiredAt = new Date().toISOString();
        marked.push(o);
      }
    });
    return marked;
  };
  // 尽力关闭微信旧预支付单（无微信支付配置时为空操作；关单失败无害——可能已关闭或已支付）
  function closeWxPrepay(order) {
    cfg = loadConfig();
    const w = cfg.wechat;
    if (!w || !order.outTradeNo || order.payChannel !== '微信支付') return;
    wxRequest(w, 'POST', `/v3/pay/transactions/out-trade-no/${order.outTradeNo}/close`, { mchid: w.mchid })
      .then(() => log(`失效订单已关闭微信预支付单 order=${order.id}`))
      .catch(e => log(`失效关单失败（可忽略）order=${order.id} err=${e.message}`));
  }

  let cfg = loadConfig();
  const wxEnabled = () => !!cfg.wechat;

  // 支付能力探测：前端据此决定显示哪些扫码通道 / 微信内 JSAPI / H5 / 人工转账
  app.get('/api/pay/config', (req, res) => {
    cfg = loadConfig();
    res.json({
      ok: true,
      wechatNative: !!cfg.wechat,
      wechatJsapi: !!(cfg.wechat && cfg.wechat.appSecret && cfg.wechat.jsapiEnabled !== false),
      wechatH5: !!(cfg.wechat && cfg.wechat.h5Enabled),
      wechatJsapiAppid: cfg.wechat ? (cfg.wechat.jsapiAppid || cfg.wechat.appid) : '',
      alipay: !!cfg.alipay,
      singlePrice: SINGLE_PRICE,
    });
  });

  // 下单辅助：复用同档位待支付订单；有"人工确认中"的订单则拒绝重复下单
  // amount 可覆盖（升级差价），缺省 = 档位标价；reused=true 表示复用了已有待支付订单
  // 同一笔待支付订单只能复用于同一种支付方式：Native/JSAPI/H5/支付宝的 out_trade_no 不能混用
  const sameTradeType = (o, tradeType) => o.tradeType ? o.tradeType === tradeType : (tradeType === 'native' && !!o.codeUrl);

  function findOrCreateOrder(req, plan, channel, amount, tradeType, body) {
    // E11/O05（2026-10-18）：会员订单与单张订单同样必须勾选"不支持无理由退款"并留痕
    if (!body || body.refundConsent !== true) {
      return { error: '请先阅读并勾选：虚拟商品不支持无理由退款' };
    }
    const orders = loadJSON(ORDERS_FILE, []);
    markStaleExpired(orders, req).forEach(closeWxPrepay);
    let order = orders.find(o => o.userId === req.user.id && o.plan === plan && o.status === 'pending' && sameTradeType(o, tradeType));
    const reused = !!order;
    if (!order) {
      const notified = orders.find(o => o.userId === req.user.id && o.plan === plan && o.status === 'notified');
      if (notified) return { error: '这笔订单正在人工确认中，请稍等或联系客服' };
      order = { id: crypto.randomUUID(), userId: req.user.id, userName: req.user.name, plan, amount: Math.round((amount != null ? amount : PLANS[plan].price) * 100) / 100, status: 'pending', channel, createdAt: new Date().toISOString(), paidAt: null, refundConsent: true, refundConsentAt: new Date().toISOString() };
      orders.push(order);
    }
    order.outTradeNo = order.id.replace(/-/g, ''); // 微信要求 ≤32 位：UUID 去横线正好 32 位；支付宝同样兼容
    order.payChannel = channel;
    order.tradeType = tradeType;
    saveJSON(ORDERS_FILE, orders);
    return { order, reused };
  }

  // 画板导出单次订单（¥6.9/次，2026-10-19 定价改版）：同一用户可复用待支付单，paid 后 +1 导出权益
  function findOrCreateExportOrder(req, channel, body, tradeType) {
    if (!body || body.refundConsent !== true) {
      return { error: '请先阅读并勾选：虚拟商品不支持无理由退款' };
    }
    const orders = loadJSON(ORDERS_FILE, []);
    markStaleExpired(orders, req).forEach(closeWxPrepay);
    let order = orders.find(o => o.userId === req.user.id && o.kind === 'export' && o.status === 'pending' && sameTradeType(o, tradeType));
    const reused = !!order;
    if (!order) {
      const notified = orders.find(o => o.userId === req.user.id && o.kind === 'export' && o.status === 'notified');
      if (notified) return { error: '这笔订单正在人工确认中，请稍等或联系客服' };
      order = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        userName: req.user.name,
        kind: 'export',
        materialTitle: '画板导出（单次）',
        amount: SINGLE_PRICE,
        status: 'pending',
        channel,
        createdAt: new Date().toISOString(),
        paidAt: null,
        refundConsent: true,
        refundConsentAt: new Date().toISOString(),
      };
      orders.push(order);
    }
    order.outTradeNo = order.id.replace(/-/g, '');
    order.payChannel = channel;
    order.tradeType = tradeType;
    saveJSON(ORDERS_FILE, orders);
    return { order, reused };
  }

  // 单张素材订单：复用同一用户+素材的待支付订单；必须勾选“虚拟商品不支持无理由退款”
  function findOrCreateSingleOrder(req, target, channel, body, tradeType) {
    if (!body || body.refundConsent !== true) {
      return { error: '请先阅读并勾选：虚拟商品不支持无理由退款' };
    }
    const orders = loadJSON(ORDERS_FILE, []);
    markStaleExpired(orders, req).forEach(closeWxPrepay);
    let order = orders.find(o => o.userId === req.user.id && o.materialId === target.materialId && o.status === 'pending' && sameTradeType(o, tradeType));
    const reused = !!order;
    if (!order) {
      const notified = orders.find(o => o.userId === req.user.id && o.materialId === target.materialId && o.status === 'notified');
      if (notified) return { error: '这笔订单正在人工确认中，请稍等或联系客服' };
      order = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        userName: req.user.name,
        kind: 'single',
        materialId: target.materialId,
        materialTitle: target.materialTitle || '',
        amount: SINGLE_PRICE,
        status: 'pending',
        channel,
        createdAt: new Date().toISOString(),
        paidAt: null,
        refundConsent: true,
        refundConsentAt: new Date().toISOString(),
      };
      orders.push(order);
    }
    order.outTradeNo = order.id.replace(/-/g, '');
    order.payChannel = channel;
    order.tradeType = tradeType;
    saveJSON(ORDERS_FILE, orders);
    return { order, reused };
  }

  // ---- 会员购买守卫：不能重复购买当前或更低档位；升级更高档只补差价 ----
  // 返回 { error } 或 { amount }（应付金额，全价购买时为 null 用标价）
  function planPurchaseGuard(req, plan) {
    const cur = req.user.level || 'none';
    if ((PLAN_RANK[cur] || 0) >= PLAN_RANK[plan]) {
      const PLAN_CN = { basic: '青果会员', pro: '红果会员', team: '金果会员' };
      return { error: `你已经是${PLAN_CN[cur] || '更高档'}，无需重复购买。想升级请选择更高档位～` };
    }
    if ((PLAN_RANK[cur] || 0) > 0) {
      // 升级：收差价（如青果→红果 = 99.9 − 29.9 = 70），赠送积分同样按差额补
      const diff = Math.round((PLANS[plan].price - PLANS[cur].price) * 100) / 100;
      if (diff > 0) return { amount: diff };
    }
    return {};
  }

  // ---- 积分充值订单：与 ai.js 同一存储（ai/credit-orders.json），后台统计/流水天然兼容 ----
  const loadCO = () => loadJSON(CREDIT_ORDERS_FILE, []);
  const saveCO = rows => saveJSON(CREDIT_ORDERS_FILE, rows);

  // 积分订单下单辅助：复用同套餐待支付订单；有人工确认中的订单则拒绝重复下单
  function findOrCreateCreditOrder(req, pkgId, channel, tradeType) {
    const cos = loadCO();
    markStaleExpired(cos, req).forEach(closeWxPrepay);
    let order = cos.find(o => o.userId === req.user.id && o.pkg === pkgId && o.status === 'pending' && sameTradeType(o, tradeType));
    const reused = !!order;
    if (!order) {
      const notified = cos.find(o => o.userId === req.user.id && o.pkg === pkgId && o.status === 'notified');
      if (notified) return { error: '这笔订单正在人工确认中，请稍等或联系客服' };
      const pkg = CREDIT_PACKAGES.find(p => p.id === pkgId);
      order = { id: crypto.randomUUID(), userId: req.user.id, userName: req.user.name, pkg: pkg.id, credits: pkg.credits, amount: pkg.price, status: 'pending', createdAt: new Date().toISOString(), paidAt: null };
      cos.push(order);
    }
    order.outTradeNo = order.id.replace(/-/g, '');
    order.payChannel = channel;
    order.tradeType = tradeType;
    saveCO(cos);
    return { order, reused };
  }

  // 订单可在两个存储里：会员订单（console/orders.json）或积分订单（ai/credit-orders.json）
  function findOrderAnywhere(pred) {
    const planOrders = loadJSON(ORDERS_FILE, []);
    const o1 = planOrders.find(pred);
    if (o1) return { kind: 'plan', order: o1 };
    const creditOrders = loadCO();
    const o2 = creditOrders.find(pred);
    if (o2) return { kind: 'credit', order: o2 };
    return null;
  }

  // 支付成功履约：会员 → 升级会员；积分 → 入账积分并记流水。均幂等。
  function fulfillOrder(hit, extra) {
    if (hit.kind === 'plan') return markOrderPaid(DATA_DIR, hit.order.id, extra);
    const o = hit.order;
    if (o.status === 'paid') return { order: o, already: true };
    o.status = 'paid';
    o.paidAt = (extra && extra.paidAt) || new Date().toISOString();
    if (extra && extra.channel) o.channel = extra.channel;
    if (extra && extra.transactionId) o.transactionId = extra.transactionId;
    const users = loadUsers();
    const u = users.find(x => x.id === o.userId);
    if (u) {
      u.credits = (u.credits || 0) + o.credits;
      // 流水记用户本人（与 console.js 人工确认的记法一致）
      const logs = loadJSON(CREDIT_LOG, []);
      logs.push({ userId: u.id, name: u.name, delta: o.credits, reason: '积分充值', time: new Date().toISOString(), by: u.name });
      fs.mkdirSync(path.dirname(CREDIT_LOG), { recursive: true });
      saveJSON(CREDIT_LOG, logs);
      saveUsers(users);
    }
    saveCO(loadCO().map(x => (x.id === o.id ? o : x)));
    return { order: o, already: false };
  }

  // 下单入参解析：plan（会员）或 creditPkg（积分套餐）二选一
  function resolveOrderTarget(body) {
    const materialId = String((body || {}).materialId || '');
    if (materialId) {
      const hit = findMaterial(materialId);
      if (!hit) return { error: '素材不存在' };
      return { materialId, materialTitle: hit.m.title || '', materialSeries: hit.m.series || hit.s.folder || '' };
    }
    const plan = String((body || {}).plan || '');
    const creditPkg = String((body || {}).creditPkg || '');
    // 画板导出单次购买（2026-10-19）
    if (body && body.exportBoard) return { exportBoard: true };
    if (creditPkg) {
      const pkg = (CREDIT_PACKAGES || []).find(p => p.id === creditPkg);
      if (!pkg) return { error: '无效的积分套餐' };
      return { creditPkg, pkg };
    }
    if (!PLANS[plan]) return { error: '无效的会员类型' };
    return { plan };
  }

  function findOrCreateByTarget(req, target, channel, amount, body, tradeType) {
    if (target.materialId) return findOrCreateSingleOrder(req, target, channel, body, tradeType);
    if (target.exportBoard) return findOrCreateExportOrder(req, channel, body, tradeType);
    if (target.creditPkg) return findOrCreateCreditOrder(req, target.creditPkg, channel, tradeType);
    return findOrCreateOrder(req, target.plan, channel, amount, tradeType, body);
  }

  // 按订单类型持久化（保存 codeUrl 等附加字段时用）
  function persistOrder(target, order) {
    if (target.creditPkg) saveCO(loadCO().map(x => (x.id === order.id ? order : x)));
    else saveJSON(ORDERS_FILE, loadJSON(ORDERS_FILE, []).map(x => (x.id === order.id ? order : x)));
  }

  // 订单标题/商品描述
  function orderSubject(target, order) {
    if (target.materialId) {
      const title = target.materialTitle || order.materialTitle || '';
      return ('无花有果-单张素材-' + title).slice(0, 30);
    }
    if (target.exportBoard) return '无花有果-画板导出单次';
    if (target.creditPkg) return `无花有果-${order.credits}积分`;
    return '无花有果-' + PLANS[target.plan].name;
  }
  function targetLabel(target) {
    if (target.materialId) return 'material=' + target.materialId;
    if (target.exportBoard) return 'export=board';
    if (target.creditPkg) return 'pkg=' + target.creditPkg;
    return 'plan=' + target.plan;
  }

  // 微信 Native 下单：返回 code_url 供前端生成二维码（plan=会员 或 creditPkg=积分套餐）
  app.post('/api/pay/wechat/native', authUser, async (req, res) => {
    cfg = loadConfig(); // 每次下单重读配置，改配置不用重启
    const w = cfg.wechat;
    if (!w) return res.status(503).json({ ok: false, error: '微信扫码支付暂未开通，请使用转账方式' });
    const target = resolveOrderTarget(req.body);
    if (target.error) return res.status(400).json({ ok: false, error: target.error });
    let payAmount = null;
    if (target.plan) {
      const g = planPurchaseGuard(req, target.plan);
      if (g.error) return res.status(409).json({ ok: false, error: g.error });
      payAmount = g.amount;
    }

    const { order, error, reused } = findOrCreateByTarget(req, target, '微信支付', payAmount, req.body, 'native');
    if (error) return res.status(409).json({ ok: false, error });

    // 复用待支付订单：二维码仍在有效期（约 2 小时）直接返回旧码；已过期先关旧预支付单再换新码
    if (reused && order.codeUrl) {
      const age = Date.now() - Date.parse(order.codeUrlAt || order.createdAt);
      if (age < 110 * 60 * 1000) {
        return res.json({ ok: true, order, codeUrl: order.codeUrl, reused: true });
      }
      try { await wxRequest(w, 'POST', `/v3/pay/transactions/out-trade-no/${order.outTradeNo}/close`, { mchid: w.mchid }); log(`关闭过期预支付单 order=${order.id}`); }
      catch (e) { log(`关旧单失败（可能已关闭）order=${order.id} err=${e.message}`); }
    }

    try {
      const r = await wxRequest(w, 'POST', '/v3/pay/transactions/native', {
        appid: w.appid,
        mchid: w.mchid,
        description: orderSubject(target, order),
        out_trade_no: order.outTradeNo,
        notify_url: w.notifyUrl,
        attach: order.id,
        amount: { total: Math.round(order.amount * 100), currency: 'CNY' },
      });
      if (r.status !== 200 || !r.json || !r.json.code_url) {
        log(`native下单失败 order=${order.id} http=${r.status} body=${(r.text || '').slice(0, 300)}`);
        return res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试或使用转账方式' });
      }
      log(`native下单成功 order=${order.id} ${targetLabel(target)} amount=${order.amount}`);
      order.codeUrl = r.json.code_url; // 存下来：有效期内重新发起直接复用，不重复调微信
      order.codeUrlAt = new Date().toISOString();
      persistOrder(target, order);
      res.json({ ok: true, order, codeUrl: r.json.code_url });
    } catch (e) {
      log(`native下单异常 order=${order.id} err=${e.message}`);
      res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试或使用转账方式' });
    }
  });

  // 微信 JSAPI 下单（微信内置浏览器）：前端先走公众号网页授权拿 code，后端换 openid 后下单并签名
  app.post('/api/pay/wechat/jsapi', authUser, async (req, res) => {
    cfg = loadConfig();
    const w = cfg.wechat;
    if (!w) return res.status(503).json({ ok: false, error: '微信支付暂未开通' });
    if (!w.appSecret) return res.status(503).json({ ok: false, error: '公众号 AppSecret 未配置，微信内支付暂不可用' });
    const target = resolveOrderTarget(req.body);
    if (target.error) return res.status(400).json({ ok: false, error: target.error });
    let payAmount = null;
    if (target.plan) {
      const g = planPurchaseGuard(req, target.plan);
      if (g.error) return res.status(409).json({ ok: false, error: g.error });
      payAmount = g.amount;
    }
    let openid;
    try { openid = (await getWechatOpenid(w, String((req.body || {}).code || ''))).openid; }
    catch (e) {
      log(`JSAPI 授权换 openid 失败 err=${e.message}`);
      return res.status(400).json({ ok: false, error: '微信授权失败，请返回重试（' + e.message + '）' });
    }

    const { order, error, reused } = findOrCreateByTarget(req, target, '微信支付', payAmount, req.body, 'jsapi');
    if (error) return res.status(409).json({ ok: false, error });
    if (reused && order.prepayId) {
      const age = Date.now() - Date.parse(order.prepayAt || order.createdAt);
      if (age < 110 * 60 * 1000) {
        return res.json({ ok: true, order, payParams: jsapiPayParams(w, order.prepayId), reused: true });
      }
      try { await wxRequest(w, 'POST', `/v3/pay/transactions/out-trade-no/${order.outTradeNo}/close`, { mchid: w.mchid }); } catch {}
    }

    try {
      const r = await wxRequest(w, 'POST', '/v3/pay/transactions/jsapi', {
        appid: w.jsapiAppid || w.appid,
        mchid: w.mchid,
        description: orderSubject(target, order),
        out_trade_no: order.outTradeNo,
        notify_url: w.notifyUrl,
        attach: order.id,
        amount: { total: Math.round(order.amount * 100), currency: 'CNY' },
        payer: { openid },
      });
      if (r.status !== 200 || !r.json || !r.json.prepay_id) {
        log(`JSAPI下单失败 order=${order.id} http=${r.status} body=${(r.text || '').slice(0, 300)}`);
        return res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试' });
      }
      order.prepayId = r.json.prepay_id;
      order.prepayAt = new Date().toISOString();
      order.openid = openid;
      persistOrder(target, order);
      log(`JSAPI下单成功 order=${order.id} ${targetLabel(target)} amount=${order.amount}`);
      res.json({ ok: true, order, payParams: jsapiPayParams(w, order.prepayId) });
    } catch (e) {
      log(`JSAPI下单异常 order=${order.id} err=${e.message}`);
      res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试' });
    }
  });

  // 微信 H5（MWEB）下单：手机浏览器（微信外）使用，返回 h5_url 由前端跳转
  app.post('/api/pay/wechat/h5', authUser, async (req, res) => {
    cfg = loadConfig();
    const w = cfg.wechat;
    if (!w) return res.status(503).json({ ok: false, error: '微信支付暂未开通' });
    if (!w.h5Enabled) return res.status(503).json({ ok: false, error: '微信 H5 支付暂未开通，请使用微信内支付或支付宝' });
    const target = resolveOrderTarget(req.body);
    if (target.error) return res.status(400).json({ ok: false, error: target.error });
    let payAmount = null;
    if (target.plan) {
      const g = planPurchaseGuard(req, target.plan);
      if (g.error) return res.status(409).json({ ok: false, error: g.error });
      payAmount = g.amount;
    }

    const { order, error, reused } = findOrCreateByTarget(req, target, '微信支付', payAmount, req.body, 'h5');
    if (error) return res.status(409).json({ ok: false, error });
    if (reused && order.mwebUrl) {
      const age = Date.now() - Date.parse(order.mwebAt || order.createdAt);
      if (age < 5 * 60 * 1000) return res.json({ ok: true, order, h5Url: order.mwebUrl, reused: true });
      try { await wxRequest(w, 'POST', `/v3/pay/transactions/out-trade-no/${order.outTradeNo}/close`, { mchid: w.mchid }); } catch {}
    }

    try {
      // P0-2（2026-10-20）：只信 nginx 写入的 X-Real-IP，不用 req.ip（XFF 可伪造，会把假 IP 报给微信风控）
      const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '') || '47.98.165.254';
      const r = await wxRequest(w, 'POST', '/v3/pay/transactions/h5', {
        appid: w.appid,
        mchid: w.mchid,
        description: orderSubject(target, order),
        out_trade_no: order.outTradeNo,
        notify_url: w.notifyUrl,
        attach: order.id,
        amount: { total: Math.round(order.amount * 100), currency: 'CNY' },
        scene_info: {
          payer_client_ip: ip,
          h5_info: { type: 'Wap', app_name: 'OneFig', app_url: 'https://onefig.cn' },
        },
      });
      if (r.status !== 200 || !r.json || !r.json.h5_url) {
        log(`H5下单失败 order=${order.id} http=${r.status} body=${(r.text || '').slice(0, 300)}`);
        return res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试' });
      }
      order.mwebUrl = r.json.h5_url;
      order.mwebAt = new Date().toISOString();
      persistOrder(target, order);
      log(`H5下单成功 order=${order.id} ${targetLabel(target)} amount=${order.amount}`);
      res.json({ ok: true, order, h5Url: order.mwebUrl });
    } catch (e) {
      log(`H5下单异常 order=${order.id} err=${e.message}`);
      res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试' });
    }
  });

  // 微信支付结果通知（server.js 已为本路径挂载 express.raw，body 是原始 Buffer）
  app.post('/api/pay/wechat/notify', async (req, res) => {
    const fail = (code, msg) => res.status(code).json({ code: 'FAIL', message: msg });
    try {
      cfg = loadConfig();
      const w = cfg.wechat;
      if (!w) return fail(503, '支付未配置');
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!rawBody) return fail(400, '空请求体');

      let certs = {};
      // 公钥模式商户无需平台证书（配了 pubKeyPem 就跳过证书获取）
      if (!w.pubKeyPem) {
        try { certs = await getPlatformCerts(w, CERTS_CACHE); }
        catch (e) { log('平台证书获取失败：' + e.message); return fail(500, '平台证书不可用'); }
      }
      if (!verifyNotifySignature(certs, req.headers, rawBody, w.pubKeyPem)) {
        // 证书模式下可能是缓存里没有新证书：强制刷新一次再验
        if (!w.pubKeyPem) {
          try { fs.unlinkSync(CERTS_CACHE); certs = await getPlatformCerts(w, CERTS_CACHE); } catch {}
        }
        if (!verifyNotifySignature(certs, req.headers, rawBody, w.pubKeyPem)) {
          log(`回调验签失败 ip=${req.headers['x-real-ip'] || req.socket.remoteAddress} serial=${req.headers['wechatpay-serial'] || req.headers['wechatpay-publickey-id']}`);
          return fail(401, '验签失败');
        }
      }

      let notice;
      try { notice = JSON.parse(rawBody); } catch { return fail(400, '报文解析失败'); }
      if (notice.event_type !== 'TRANSACTION.SUCCESS' || !notice.resource) {
        return res.json({ code: 'SUCCESS', message: '已接收' }); // 其他事件直接确认
      }
      let data;
      try {
        data = JSON.parse(aes256gcmDecrypt(w.apiV3Key, notice.resource.nonce, notice.resource.associated_data, notice.resource.ciphertext));
      } catch (e) { log('回调解密失败：' + e.message); return fail(400, '解密失败'); }

      const orderId = String(data.attach || '');
      const hit = findOrderAnywhere(o => o.id === orderId || (o.outTradeNo && o.outTradeNo === data.out_trade_no));
      if (!hit) { log(`回调找不到订单 out_trade_no=${data.out_trade_no}`); return fail(404, '订单不存在'); }
      const order = hit.order;

      // 金额与商户号校验：防伪造/防串单
      const expectFen = Math.round(order.amount * 100);
      if (data.mchid !== w.mchid || !data.amount || data.amount.total !== expectFen) {
        log(`回调金额/商户号不符 order=${order.id} expect=${expectFen} got=${data.amount && data.amount.total} mchid=${data.mchid}`);
        return fail(400, '金额不符');
      }
      const result = fulfillOrder(hit, {
        channel: '微信支付',
        transactionId: data.transaction_id,
        paidAt: data.success_time || new Date().toISOString(),
      });
      log(`支付成功 order=${order.id} transaction=${data.transaction_id}${result && result.already ? '（重复通知，幂等忽略）' : ''}`);
      res.json({ code: 'SUCCESS', message: '成功' });
    } catch (e) {
      log('回调处理异常：' + (e && e.stack || e));
      fail(500, '处理异常');
    }
  });

  // 支付宝电脑网站支付下单：返回收银台 URL，前端新窗口打开（支付宝页内自带扫码/登录支付）
  app.post('/api/pay/alipay/pagepay', authUser, async (req, res) => {
    cfg = loadConfig();
    const a = cfg.alipay;
    if (!a) return res.status(503).json({ ok: false, error: '支付宝支付暂未开通，请使用其他方式' });
    const target = resolveOrderTarget(req.body);
    if (target.error) return res.status(400).json({ ok: false, error: target.error });
    let payAmount = null;
    if (target.plan) {
      const g = planPurchaseGuard(req, target.plan);
      if (g.error) return res.status(409).json({ ok: false, error: g.error });
      payAmount = g.amount;
    }

    const { order, error } = findOrCreateByTarget(req, target, '支付宝', payAmount, req.body, 'alipay');
    if (error) return res.status(409).json({ ok: false, error });

    const payUrl = alipayPageUrl(a, 'alipay.trade.page.pay', {
      out_trade_no: order.outTradeNo,
      total_amount: order.amount.toFixed(2),
      subject: orderSubject(target, order),
      product_code: 'FAST_INSTANT_TRADE_PAY',
      timeout_express: '24h', // 与 PENDING_TTL 对齐：超时支付宝自动关单，旧收银台页面无法再付款
    }, { notify_url: a.notifyUrl, return_url: a.returnUrl });
    log(`支付宝下单 order=${order.id} ${target.creditPkg ? 'pkg=' + target.creditPkg : 'plan=' + target.plan} amount=${order.amount}`);
    res.json({ ok: true, order, payUrl });
  });

  // 支付宝异步通知（application/x-www-form-urlencoded；server.js 已挂载 urlencoded 解析）
  app.post('/api/pay/alipay/notify', (req, res) => {
    try {
      cfg = loadConfig();
      const a = cfg.alipay;
      if (!a) return res.status(503).send('failure');
      const params = req.body || {};
      const { sign, sign_type: _st, ...rest } = params; // 验签时排除 sign 与 sign_type
      if (!alipayVerify(rest, sign, a.alipayPublicKey)) {
        log(`支付宝回调验签失败 ip=${req.headers['x-real-ip'] || req.socket.remoteAddress} out_trade_no=${params.out_trade_no}`);
        return res.status(400).send('failure');
      }
      if (params.app_id !== a.appid) { log('支付宝回调 app_id 不符'); return res.status(400).send('failure'); }
      if (params.trade_status !== 'TRADE_SUCCESS' && params.trade_status !== 'TRADE_FINISHED') {
        return res.send('success'); // 等待付款等非终态直接确认
      }
      const hit = findOrderAnywhere(o => o.outTradeNo === params.out_trade_no);
      if (!hit) { log(`支付宝回调找不到订单 out_trade_no=${params.out_trade_no}`); return res.status(404).send('failure'); }
      const order = hit.order;
      if (Number(params.total_amount) !== Math.round(order.amount * 100) / 100) {
        log(`支付宝回调金额不符 order=${order.id} expect=${order.amount} got=${params.total_amount}`);
        return res.status(400).send('failure');
      }
      const result = fulfillOrder(hit, { channel: '支付宝', transactionId: params.trade_no, paidAt: params.gmt_payment });
      log(`支付宝支付成功 order=${order.id} trade_no=${params.trade_no}${result && result.already ? '（重复通知，幂等忽略）' : ''}`);
      res.send('success');
    } catch (e) {
      log('支付宝回调处理异常：' + (e && e.stack || e));
      res.status(500).send('failure');
    }
  });

  // 订单状态查询（前端轮询）。超过 20 秒未收到回调时，主动向微信/支付宝查单兜底（每 15 秒最多查一次）
  // 会员订单与积分订单都可查：积分订单支付成功直接入账
  app.get('/api/orders/:id/status', authUser, async (req, res) => {
    cfg = loadConfig();
    const hit = findOrderAnywhere(x => x.id === req.params.id && x.userId === req.user.id);
    if (!hit) return res.status(404).json({ ok: false, error: '订单不存在' });
    const o = hit.order;
    // 超期待支付订单 → 标记失效 + 关闭微信旧预支付单（前端轮询到也会收敛）
    if (isStalePending(o)) {
      o.status = 'expired';
      o.expiredAt = new Date().toISOString();
      if (hit.kind === 'plan') { const all = loadJSON(ORDERS_FILE, []); const t = all.find(x => x.id === o.id); if (t) { t.status = 'expired'; t.expiredAt = o.expiredAt; saveJSON(ORDERS_FILE, all); } }
      else { const all = loadCO(); const t = all.find(x => x.id === o.id); if (t) { t.status = 'expired'; t.expiredAt = o.expiredAt; saveCO(all); } }
      closeWxPrepay(o);
    }
    if (o.status !== 'paid' && o.status !== 'expired' && o.outTradeNo) {
      const last = o.lastPayQueryAt ? Date.parse(o.lastPayQueryAt) : 0;
      if (Date.now() - last > 15000 && Date.now() - Date.parse(o.createdAt) > 20000) {
        o.lastPayQueryAt = new Date().toISOString();
        if (hit.kind === 'plan') { const all = loadJSON(ORDERS_FILE, []); const t = all.find(x => x.id === o.id); if (t) { t.lastPayQueryAt = o.lastPayQueryAt; saveJSON(ORDERS_FILE, all); } }
        else { const all = loadCO(); const t = all.find(x => x.id === o.id); if (t) { t.lastPayQueryAt = o.lastPayQueryAt; saveCO(all); } }
        try {
          if (o.payChannel === 'alipay' && cfg.alipay) {
            const r = await alipayApiCall(cfg.alipay, 'alipay.trade.query', { out_trade_no: o.outTradeNo });
            const resp = r.json && r.json.alipay_trade_query_response;
            if (resp && resp.code === '10000' && (resp.trade_status === 'TRADE_SUCCESS' || resp.trade_status === 'TRADE_FINISHED')) {
              fulfillOrder(hit, { channel: '支付宝', transactionId: resp.trade_no });
              o.status = 'paid';
              log(`支付宝查单补单成功 order=${o.id}（回调可能丢失）`);
            }
          } else if (o.payChannel !== 'alipay' && cfg.wechat) {
            const r = await wxRequest(cfg.wechat, 'GET', `/v3/pay/transactions/out-trade-no/${o.outTradeNo}?mchid=${cfg.wechat.mchid}`, null);
            if (r.status === 200 && r.json && r.json.trade_state === 'SUCCESS') {
              fulfillOrder(hit, { channel: '微信支付', transactionId: r.json.transaction_id, paidAt: r.json.success_time });
              o.status = 'paid';
              log(`微信查单补单成功 order=${o.id}（回调可能丢失）`);
            }
          }
        } catch (e) { log(`查单异常 order=${o.id} err=${e.message}`); }
      }
    }
    res.json({ ok: true, status: o.status, plan: o.plan || null, credits: o.credits || null, materialId: o.materialId || null, kind: o.kind === 'export' ? 'export' : (o.materialId ? 'single' : (o.creditPkg ? 'credit' : 'plan')), paidAt: o.paidAt || null });
  });

  // 一键清空当前用户的已失效待支付订单（会员订单 + 积分订单，2026-10-17）
  app.delete('/api/orders/expired', authUser, (req, res) => {
    let removed = 0;
    const planOrders = loadJSON(ORDERS_FILE, []);
    const keepPlans = planOrders.filter(o => !(o.userId === req.user.id && (o.status === 'expired' || isStalePending(o))));
    removed += planOrders.length - keepPlans.length;
    if (removed) saveJSON(ORDERS_FILE, keepPlans);
    const cos = loadCO();
    const keepCO = cos.filter(o => !(o.userId === req.user.id && (o.status === 'expired' || isStalePending(o))));
    removed += cos.length - keepCO.length;
    if (cos.length !== keepCO.length) saveCO(keepCO);
    log(`清空失效订单 user=${req.user.name} removed=${removed}`);
    res.json({ ok: true, removed });
  });
};

module.exports.markOrderPaid = markOrderPaid;
// 仅供测试脚本使用
module.exports._internal = { aes256gcmDecrypt, verifyNotifySignature, loadConfig, wxSign, alipaySign, alipayVerify, alipaySignStr, jsapiPayParams, getWechatOpenid, SINGLE_PRICE };
