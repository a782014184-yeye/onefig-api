// OneFig 在线支付模块（2026-10-08）
// 第一阶段：微信支付 Native 扫码支付（APIv3，零第三方依赖，只用 Node 内置 crypto/https）
//
// 链路：前端下单 → 后端调微信 Native 下单拿 code_url → 前端展示二维码 →
//       微信服务器回调 /api/pay/wechat/notify（验签+解密）→ 自动升级会员
//       兜底：前端轮询 /api/orders/:id 时，后端主动向微信查单（防回调丢失）
//
// 配置：pay-config.local.json（不进 git，模板见 pay-config.example.json）
// ⚠️ APIv3 密钥、商户私钥只放服务器，绝不提交到代码仓库。

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const WX_API_HOST = 'api.mch.weixin.qq.com';
const MEMBER_GIFT = { basic: 150, pro: 900, team: 3000 }; // 与 console.js 保持一致：开通会员一次性赠送积分

// ---------- 配置加载 ----------
function loadConfig() {
  const file = process.env.ONEFIG_PAY_CONFIG || path.join(__dirname, 'pay-config.local.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = cfg.wechat || {};
    if (!w.enabled) return { wechat: null };
    const certFile = path.resolve(__dirname, w.certFile || 'secrets/apiclient_cert.pem');
    const keyFile = path.resolve(__dirname, w.keyFile || 'secrets/apiclient_key.pem');
    if (!w.appid || !w.mchid || !w.apiV3Key || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      console.warn('[pay] 微信支付配置不完整（缺 appid/mchid/apiV3Key/证书文件），扫码支付暂不开放');
      return { wechat: null };
    }
    const certPem = fs.readFileSync(certFile, 'utf8');
    const keyPem = fs.readFileSync(keyFile, 'utf8');
    let serialNo = w.serialNo || '';
    if (!serialNo) {
      try { serialNo = new crypto.X509Certificate(certPem).serialNumber.replace(/:/g, '').toUpperCase(); }
      catch (e) { console.warn('[pay] 读取证书序列号失败：' + e.message); }
    }
    return { wechat: { appid: w.appid, mchid: w.mchid, apiV3Key: w.apiV3Key, notifyUrl: w.notifyUrl, certPem, keyPem, serialNo } };
  } catch {
    return { wechat: null }; // 配置文件不存在 = 未开通在线支付，走原人工转账流程
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

// ---------- 回调验签：Wechatpay-Signature = RSA-SHA256(timestamp\nnonce\nbody\n) ----------
function verifyNotifySignature(certs, headers, rawBody) {
  const serial = String(headers['wechatpay-serial'] || '');
  const ts = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const sig = String(headers['wechatpay-signature'] || '');
  if (!serial || !ts || !nonce || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 防重放：5 分钟窗口
  const pem = certs[serial];
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

  const PLAN_NAMES = { basic: '青果会员', pro: '红果会员', team: '金果会员' };
  const u = users.find(x => x.id === o.userId);
  if (u) {
    u.level = o.plan;
    if (!u.memberSince) u.memberSince = o.paidAt;
    if (!u.name && o.userName) u.name = o.userName;
    // 赠送积分：每个等级只送一次
    if (MEMBER_GIFT[o.plan] && u.creditsGrantedFor !== o.plan) {
      u.creditsGrantedFor = o.plan;
      u.credits = (u.credits || 0) + MEMBER_GIFT[o.plan];
      const log = loadJSON(CREDIT_LOG, []);
      log.push({ userId: u.id, name: u.name, delta: MEMBER_GIFT[o.plan], reason: '开通' + (PLAN_NAMES[o.plan] || o.plan) + '赠送', time: new Date().toISOString(), by: 'system' });
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
  const { authUser, DATA_DIR, PLANS, logLine } = deps;
  const CONSOLE_DIR = path.join(DATA_DIR, 'console');
  const ORDERS_FILE = path.join(CONSOLE_DIR, 'orders.json');
  const CERTS_CACHE = path.join(CONSOLE_DIR, 'wx-platform-certs.json');
  const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const saveJSON = (f, rows) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); };
  const log = (msg) => { if (logLine) logLine('pay', msg); else console.log('[pay]', msg); };

  let cfg = loadConfig();
  const wxEnabled = () => !!cfg.wechat;

  // 支付能力探测：前端据此决定显示"扫码支付"还是"人工转账"
  app.get('/api/pay/config', (req, res) => {
    res.json({ ok: true, wechatNative: wxEnabled(), alipay: false });
  });

  // 微信 Native 下单：返回 code_url 供前端生成二维码
  app.post('/api/pay/wechat/native', authUser, async (req, res) => {
    cfg = loadConfig(); // 每次下单重读配置，改配置不用重启
    const w = cfg.wechat;
    if (!w) return res.status(503).json({ ok: false, error: '微信扫码支付暂未开通，请使用转账方式' });
    const plan = String((req.body || {}).plan || '');
    if (!PLANS[plan]) return res.status(400).json({ ok: false, error: '无效的会员类型' });

    const orders = loadJSON(ORDERS_FILE, []);
    let order = orders.find(o => o.userId === req.user.id && o.plan === plan && (o.status === 'pending'));
    if (!order) {
      const notified = orders.find(o => o.userId === req.user.id && o.plan === plan && o.status === 'notified');
      if (notified) return res.status(409).json({ ok: false, error: '这笔订单正在人工确认中，请稍等或联系客服' });
      order = { id: crypto.randomUUID(), userId: req.user.id, userName: req.user.name, plan, amount: PLANS[plan].price, status: 'pending', channel: '微信支付', createdAt: new Date().toISOString(), paidAt: null };
      orders.push(order);
    }
    const outTradeNo = order.id.replace(/-/g, ''); // 微信要求 6-32 位：UUID 去横线正好 32 位
    order.outTradeNo = outTradeNo;
    saveJSON(ORDERS_FILE, orders);

    try {
      const r = await wxRequest(w, 'POST', '/v3/pay/transactions/native', {
        appid: w.appid,
        mchid: w.mchid,
        description: '无花有果-' + PLANS[plan].name,
        out_trade_no: outTradeNo,
        notify_url: w.notifyUrl,
        attach: order.id,
        amount: { total: Math.round(order.amount * 100), currency: 'CNY' },
      });
      if (r.status !== 200 || !r.json || !r.json.code_url) {
        log(`native下单失败 order=${order.id} http=${r.status} body=${(r.text || '').slice(0, 300)}`);
        return res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试或使用转账方式' });
      }
      log(`native下单成功 order=${order.id} plan=${plan} amount=${order.amount}`);
      res.json({ ok: true, order, codeUrl: r.json.code_url });
    } catch (e) {
      log(`native下单异常 order=${order.id} err=${e.message}`);
      res.status(502).json({ ok: false, error: '微信支付下单失败，请稍后再试或使用转账方式' });
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

      let certs;
      try { certs = await getPlatformCerts(w, CERTS_CACHE); }
      catch (e) { log('平台证书获取失败：' + e.message); return fail(500, '平台证书不可用'); }
      if (!verifyNotifySignature(certs, req.headers, rawBody)) {
        // 可能是缓存里没有新证书：强制刷新一次再验
        try { fs.unlinkSync(CERTS_CACHE); certs = await getPlatformCerts(w, CERTS_CACHE); } catch {}
        if (!verifyNotifySignature(certs, req.headers, rawBody)) {
          log(`回调验签失败 ip=${req.ip} serial=${req.headers['wechatpay-serial']}`);
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
      const orders = loadJSON(ORDERS_FILE, []);
      const order = orders.find(o => o.id === orderId || (o.outTradeNo && o.outTradeNo === data.out_trade_no));
      if (!order) { log(`回调找不到订单 out_trade_no=${data.out_trade_no}`); return fail(404, '订单不存在'); }

      // 金额与商户号校验：防伪造/防串单
      const expectFen = Math.round(order.amount * 100);
      if (data.mchid !== w.mchid || !data.amount || data.amount.total !== expectFen) {
        log(`回调金额/商户号不符 order=${order.id} expect=${expectFen} got=${data.amount && data.amount.total} mchid=${data.mchid}`);
        return fail(400, '金额不符');
      }
      const result = markOrderPaid(DATA_DIR, order.id, {
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

  // 订单状态查询（前端轮询）。超过 20 秒未收到回调时，主动向微信查单兜底（每 15 秒最多查一次）
  app.get('/api/orders/:id/status', authUser, async (req, res) => {
    const orders = loadJSON(ORDERS_FILE, []);
    const o = orders.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!o) return res.status(404).json({ ok: false, error: '订单不存在' });
    if (o.status !== 'paid' && o.outTradeNo && cfg.wechat) {
      const last = o.lastWxQueryAt ? Date.parse(o.lastWxQueryAt) : 0;
      if (Date.now() - last > 15000 && Date.now() - Date.parse(o.createdAt) > 20000) {
        o.lastWxQueryAt = new Date().toISOString();
        saveJSON(ORDERS_FILE, orders);
        try {
          const r = await wxRequest(cfg.wechat, 'GET', `/v3/pay/transactions/out-trade-no/${o.outTradeNo}?mchid=${cfg.wechat.mchid}`, null);
          if (r.status === 200 && r.json && r.json.trade_state === 'SUCCESS') {
            markOrderPaid(DATA_DIR, o.id, { channel: '微信支付', transactionId: r.json.transaction_id, paidAt: r.json.success_time });
            o.status = 'paid';
            log(`查单补单成功 order=${o.id}（回调可能丢失）`);
          }
        } catch (e) { log(`查单异常 order=${o.id} err=${e.message}`); }
      }
    }
    res.json({ ok: true, status: o.status, plan: o.plan, paidAt: o.paidAt || null });
  });
};

module.exports.markOrderPaid = markOrderPaid;
// 仅供测试脚本使用
module.exports._internal = { aes256gcmDecrypt, verifyNotifySignature, loadConfig, wxSign };
