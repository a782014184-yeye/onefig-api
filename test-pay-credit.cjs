// 在线支付本地集成测试（2026-10-23 全面优化版）
// 不连微信/支付宝真实服务器：
//   - 支付宝：自签 RSA 密钥对模拟异步通知回调
//   - 微信：拦截 https.request 假扮 api.mch.weixin.qq.com（下单/关单/查单）
// 覆盖：
//   A. 积分充值（下单/复用/回调入账/幂等/金额防篡改/状态查询）
//   B. 会员购买（退款勾选/重复拦截/差价升级/补差赠送/重启复用）
//   C. 24h 失效（超期标记/开新单/清空失效单）
//   D. 画板导出单次（exportBoard 全链路）
//   E. 单张素材购买（materialId 授权入账）
//   F. 微信 Native（下单/codeUrl 存储与复用/过期关单换新码）
//   G. 查单兜底（回调丢失时主动向支付宝查单补单）
//   H. 未开通通道降级（微信 H5 / JSAPI 友好提示）
// 运行：node test-pay-credit.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const https = require('https');
const express = require('express');

const pay = require('./pay');
const { CREDIT_PACKAGES } = require('./ai');

let passed = 0;
function ok(name) { passed++; console.log('  ✅', name); }

(async () => {
  // ---- 环境：临时数据目录 + 自签支付宝密钥 + 微信密钥 + 素材 fixture ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-paytest-'));
  const consoleDir = path.join(dir, 'console');
  const aiDir = path.join(dir, 'ai');
  const secretsDir = path.join(dir, 'secrets');
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(aiDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });

  const user = { id: 'u-test-1', name: '集成测试用户', level: 'none', credits: 5, exportCredits: 0 };
  fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([user]));
  fs.writeFileSync(path.join(consoleDir, 'orders.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(consoleDir, 'materials.json'), JSON.stringify([
    { folder: '测试系列', materials: [{ id: 'm-test-1', title: '测试素材图', series: '测试系列' }] },
  ]));
  fs.writeFileSync(path.join(aiDir, 'credit-orders.json'), JSON.stringify([]));

  const PLANS = { basic: { name: '青果会员', price: 29.9 }, pro: { name: '红果会员', price: 99.9 }, team: { name: '金果会员', price: 299.9 } };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(secretsDir, 'alipay-app-private.pem'), priPem);
  fs.writeFileSync(path.join(secretsDir, 'alipay-public.pem'), pubPem);
  fs.writeFileSync(path.join(secretsDir, 'wx-app-private.pem'), priPem);
  fs.writeFileSync(path.join(secretsDir, 'wx-app-cert.pem'), pubPem); // 内容不会被真实解析（serialNo 直接配置）
  const APPID = '2026test0000000001';
  fs.writeFileSync(path.join(dir, 'pay-config.json'), JSON.stringify({
    alipay: { enabled: true, appid: APPID, notifyUrl: 'https://onefig.cn/api/pay/alipay/notify', privateKeyFile: path.join(secretsDir, 'alipay-app-private.pem'), alipayPublicKeyFile: path.join(secretsDir, 'alipay-public.pem') },
    wechat: { enabled: true, appid: 'wx-test-appid', mchid: '1001100999', apiV3Key: 'k'.repeat(32), serialNo: 'TESTSERIAL001', notifyUrl: 'https://onefig.cn/api/pay/wechat/notify', certFile: path.join(secretsDir, 'wx-app-cert.pem'), keyFile: path.join(secretsDir, 'wx-app-private.pem') },
  }));
  process.env.ONEFIG_PAY_CONFIG = path.join(dir, 'pay-config.json');

  // ---- 拦截 https.request：假扮微信支付 / 支付宝网关 ----
  const wxLog = [];
  const aliLog = [];
  function makeFakeReq(handler) {
    return function (opts, cb) {
      const chunks = [];
      const req = {
        write(d) { chunks.push(Buffer.from(d)); },
        end(d) {
          if (d) chunks.push(Buffer.from(d));
          const body = Buffer.concat(chunks).toString('utf8');
          const r = handler(opts, body) || { status: 200, json: {} };
          const buf = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.json || {}));
          const res = {
            statusCode: r.status || 200,
            on(ev, fn) {
              if (ev === 'data') setImmediate(() => fn(buf));
              else if (ev === 'end') setImmediate(() => fn());
              return this;
            },
          };
          if (cb) cb(res);
        },
        on() { return this; },
        destroy() {},
      };
      return req;
    };
  }
  https.request = makeFakeReq((opts, body) => {
    const host = String(opts.host || '');
    const p = String(opts.path || '');
    if (host === 'api.mch.weixin.qq.com') {
      if (p === '/v3/pay/transactions/native') { wxLog.push('native'); return { json: { code_url: 'weixin://fake-qr-' + wxLog.length } }; }
      if (p.endsWith('/close')) { wxLog.push('close'); return { json: {} }; }
      if (p.startsWith('/v3/pay/transactions/out-trade-no/')) { wxLog.push('query'); return { json: { trade_state: 'SUCCESS', transaction_id: 'wx-fake-tx' } }; }
      return { status: 404, json: { message: 'unknown wx path: ' + p } };
    }
    if (host === 'openapi.alipay.com') {
      aliLog.push(body.includes('method=alipay.trade.query') ? 'query' : 'other');
      return { json: { alipay_trade_query_response: { code: '10000', trade_status: 'TRADE_SUCCESS', trade_no: 'ali-fake-tx' } } };
    }
    return { status: 404, json: { message: 'unexpected host: ' + host } };
  });

  // ---- 迷你服务器（与 server.js 同样的 deps 形状）----
  const USERS_FILE = path.join(consoleDir, 'users.json');
  const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  const saveUsers = us => fs.writeFileSync(USERS_FILE, JSON.stringify(us, null, 1));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/pay/alipay/notify', express.raw({ type: '*/*' }));
  app.use(express.json());
  const authUser = (req, res, next) => { req.user = loadUsers().find(u => u.id === 'u-test-1'); next(); };
  pay(app, {
    authUser, DATA_DIR: dir, PLANS, CREDIT_PACKAGES, loadUsers, saveUsers,
    logLine: (tag, msg) => console.log(`    [${tag}]`, msg),
  });

  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  }).then(r => r.json());
  const get = p => fetch(base + p, { headers: { Authorization: 'Bearer t' } }).then(r => r.json());
  const readUser = () => loadUsers()[0];
  const readOrders = () => JSON.parse(fs.readFileSync(path.join(consoleDir, 'orders.json'), 'utf8'));
  const readCOs = () => JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8'));
  const backdate = (file, orderId, iso) => {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const o = rows.find(x => x.id === orderId);
    if (o) o.createdAt = iso;
    fs.writeFileSync(file, JSON.stringify(rows, null, 1));
  };

  // 模拟支付宝异步通知（自签私钥签名，服务端配的是对应公钥）
  const notify = async (order, overrides = {}) => {
    const params = {
      app_id: APPID,
      out_trade_no: order.outTradeNo,
      total_amount: order.amount.toFixed(2),
      trade_status: 'TRADE_SUCCESS',
      trade_no: '202610172200000000000000001',
      gmt_payment: '2026-10-17 20:00:00',
      ...overrides,
    };
    params.sign = pay._internal.alipaySign(params, priPem);
    params.sign_type = 'RSA2';
    const res = await fetch(base + '/api/pay/alipay/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    return res.text();
  };

  // ========== A. 积分充值 ==========
  const cfg = await fetch(base + '/api/pay/config').then(r => r.json());
  assert.strictEqual(cfg.alipay, true);
  assert.strictEqual(cfg.wechatNative, true);
  ok('A1 支付能力探测：微信 + 支付宝均开通');

  const bad = await post('/api/pay/alipay/pagepay', { creditPkg: 'p999' });
  assert.strictEqual(bad.ok, false);
  ok('A2 无效积分套餐被拒绝');

  const noConsent = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100' });
  assert.strictEqual(noConsent.ok, false);
  assert.match(noConsent.error, /退款/);
  ok('A2b 积分订单未勾选退款协议被拒绝（E11/O05 全量合规）');

  const r1 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100', refundConsent: true });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.order.amount, 9.9);
  assert.strictEqual(r1.order.credits, 100);
  assert.ok(readCOs()[0].outTradeNo);
  ok('A3 creditPkg 下单成功，积分订单落库');

  const r1b = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100', refundConsent: true });
  assert.strictEqual(r1b.order.id, r1.order.id);
  ok('A4 同套餐待支付订单复用（不重复建单）');

  assert.strictEqual(await notify(r1.order), 'success');
  assert.strictEqual(readUser().credits, 105);
  const logs1 = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8'));
  assert.strictEqual(logs1.length, 1);
  ok('A5 回调验签通过 → 积分入账 + 流水');

  assert.strictEqual(await notify(r1.order), 'success');
  assert.strictEqual(readUser().credits, 105);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8')).length, 1);
  ok('A6 重复回调幂等');

  const r3 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p800', refundConsent: true });
  assert.strictEqual(await notify(r3.order, { total_amount: '0.01', trade_no: 'X' }), 'failure');
  assert.strictEqual(readCOs().find(o => o.id === r3.order.id).status, 'pending');
  ok('A7 回调金额不符 → 拒绝且订单保持待支付');

  const st = await get(`/api/orders/${r1.order.id}/status`);
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.status, 'paid');
  assert.strictEqual(st.credits, 100);
  ok('A8 订单状态查询返回积分订单信息');

  // ========== B. 会员购买：退款勾选 + 重复拦截 + 差价升级 ==========
  const b0 = await post('/api/pay/alipay/pagepay', { plan: 'basic' });
  assert.strictEqual(b0.ok, false);
  assert.match(b0.error, /退款/);
  ok('B0 会员订单未勾选退款协议被拒绝');

  const b1 = await post('/api/pay/alipay/pagepay', { plan: 'basic', refundConsent: true });
  assert.strictEqual(b1.ok, true);
  assert.strictEqual(b1.order.amount, 29.9);
  const b1r = await post('/api/pay/alipay/pagepay', { plan: 'basic', refundConsent: true });
  assert.strictEqual(b1r.order.id, b1.order.id);
  ok('B1 待支付订单可再次发起付款（复用原订单）');

  assert.strictEqual(await notify(b1.order), 'success');
  assert.strictEqual(readUser().level, 'basic');
  assert.strictEqual(readUser().credits, 255, '105 + 150');
  ok('B2 全价开通青果，赠送 150 积分');

  const b2 = await post('/api/pay/alipay/pagepay', { plan: 'basic', refundConsent: true });
  assert.strictEqual(b2.ok, false);
  assert.match(b2.error, /无需重复购买/);
  ok('B3 已是青果 → 重复购买被拦截');

  const p1 = await post('/api/pay/alipay/pagepay', { plan: 'pro', refundConsent: true });
  assert.strictEqual(p1.order.amount, 70, '升级差价 99.9 − 29.9');
  assert.strictEqual(await notify(p1.order), 'success');
  assert.strictEqual(readUser().level, 'pro');
  assert.strictEqual(readUser().credits, 1005, '255 + 750 补差');
  assert.match(JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8')).slice(-1)[0].reason, /升级红果会员赠送/);
  ok('B4 青果升级红果：差价 70 元 + 补差 750 积分');

  const b3 = await post('/api/pay/alipay/pagepay', { plan: 'basic', refundConsent: true });
  assert.strictEqual(b3.ok, false);
  ok('B5 已是红果 → 不能买更低档');

  const t1 = await post('/api/pay/alipay/pagepay', { plan: 'team', refundConsent: true });
  assert.strictEqual(t1.order.amount, 200);
  assert.strictEqual(await notify(t1.order), 'success');
  assert.strictEqual(readUser().level, 'team');
  assert.strictEqual(readUser().credits, 3105);
  ok('B6 红果升级金果：差价 200 元 + 补差 2100 积分');

  const t2 = await post('/api/pay/alipay/pagepay', { plan: 'team', refundConsent: true });
  assert.strictEqual(t2.ok, false);
  assert.strictEqual(await notify(t1.order), 'success');
  assert.strictEqual(readUser().credits, 3105);
  ok('B7 已是金果 → 重复购买被拦截；回调仍幂等');

  // ========== C. 24h 失效 + 一键清空 ==========
  { const us = loadUsers(); us[0].level = 'none'; saveUsers(us); }
  const H25 = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const c1 = await post('/api/pay/alipay/pagepay', { plan: 'pro', refundConsent: true });
  const c2 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p2000', refundConsent: true });
  backdate(path.join(consoleDir, 'orders.json'), c1.order.id, H25);
  backdate(path.join(aiDir, 'credit-orders.json'), c2.order.id, H25);

  const c1n = await post('/api/pay/alipay/pagepay', { plan: 'pro', refundConsent: true });
  assert.notStrictEqual(c1n.order.id, c1.order.id);
  assert.strictEqual(readOrders().find(o => o.id === c1.order.id).status, 'expired');
  ok('C1 超期待支付订单重启 → 旧单标记失效、开新单');

  const c2n = await post('/api/pay/alipay/pagepay', { creditPkg: 'p2000', refundConsent: true });
  assert.notStrictEqual(c2n.order.id, c2.order.id);
  assert.strictEqual(readCOs().find(o => o.id === c2.order.id).status, 'expired');
  ok('C2 积分订单同口径过期');

  const del = await fetch(base + '/api/orders/expired', { method: 'DELETE', headers: { Authorization: 'Bearer t' } }).then(r => r.json());
  assert.strictEqual(del.removed, 2);
  assert.ok(!readOrders().some(o => o.id === c1.order.id));
  assert.ok(readOrders().some(o => o.id === c1n.order.id));
  assert.ok(!readCOs().some(o => o.id === c2.order.id));
  ok('C3 一键清空失效订单（进行中保留）');

  // ========== D. 画板导出单次（exportBoard）============
  const d0 = await post('/api/pay/alipay/pagepay', { exportBoard: true });
  assert.strictEqual(d0.ok, false);
  assert.match(d0.error, /退款/);
  ok('D1 导出订单未勾选退款协议被拒绝');

  const d1 = await post('/api/pay/alipay/pagepay', { exportBoard: true, refundConsent: true });
  assert.strictEqual(d1.ok, true);
  assert.strictEqual(d1.order.kind, 'export');
  assert.strictEqual(d1.order.amount, 6.9);
  assert.strictEqual(d1.order.creditSchema, 1);
  ok('D2 exportBoard 下单成功（kind=export，¥6.9，可绑定授权码）');

  assert.strictEqual(await notify(d1.order), 'success');
  assert.strictEqual(readUser().exportCredits, 1);
  ok('D3 回调履约 → exportCredits 到账');

  assert.strictEqual(await notify(d1.order), 'success');
  assert.strictEqual(readUser().exportCredits, 1);
  ok('D4 重复回调幂等');

  const dst = await get(`/api/orders/${d1.order.id}/status`);
  assert.strictEqual(dst.kind, 'export');
  ok('D5 状态查询返回 kind=export');

  // ========== E. 单张素材购买（materialId）============
  const e0 = await post('/api/pay/alipay/pagepay', { materialId: 'm-not-exist', refundConsent: true });
  assert.strictEqual(e0.ok, false);
  assert.match(e0.error, /素材不存在/);
  ok('E1 无效素材 ID 被拒绝');

  const e1 = await post('/api/pay/alipay/pagepay', { materialId: 'm-test-1', refundConsent: true });
  assert.strictEqual(e1.ok, true);
  assert.strictEqual(e1.order.kind, 'single');
  assert.strictEqual(e1.order.amount, 6.9);
  assert.strictEqual(e1.order.materialTitle, '测试素材图');
  ok('E2 materialId 下单成功（kind=single）');

  assert.strictEqual(await notify(e1.order), 'success');
  const purchases = JSON.parse(fs.readFileSync(path.join(consoleDir, 'purchases.json'), 'utf8'));
  assert.strictEqual(purchases.length, 1);
  assert.strictEqual(purchases[0].materialId, 'm-test-1');
  assert.strictEqual(readUser().level, 'none', '单张购买不影响会员等级');
  ok('E3 回调 → 素材永久下载权益入账');

  assert.strictEqual(await notify(e1.order), 'success');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(consoleDir, 'purchases.json'), 'utf8')).length, 1);
  ok('E4 重复回调不重复记购买');

  // ========== F. 微信 Native（假微信支付服务器）============
  const f1 = await post('/api/pay/wechat/native', { plan: 'basic', refundConsent: true });
  assert.strictEqual(f1.ok, true);
  assert.ok(String(f1.codeUrl).startsWith('weixin://'));
  assert.ok(readOrders().find(o => o.id === f1.order.id).codeUrl, 'codeUrl 已持久化');
  ok('F1 微信 Native 下单成功，二维码落库');

  const f2 = await post('/api/pay/wechat/native', { plan: 'basic', refundConsent: true });
  const nativeCallsAfterF1 = wxLog.filter(x => x === 'native').length;
  assert.strictEqual(f2.reused, true);
  assert.strictEqual(f2.codeUrl, f1.codeUrl, '有效期内复用同一二维码');
  assert.strictEqual(wxLog.filter(x => x === 'native').length, nativeCallsAfterF1, '未重复调微信');
  ok('F2 有效期内重启 → 复用旧二维码，零额外调用');

  // 把二维码生成时间拨回 3 小时前（订单本身仍在 24h 有效期内）→ 触发关旧单换新码
  {
    const rows = readOrders();
    const o = rows.find(x => x.id === f1.order.id);
    o.codeUrlAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(consoleDir, 'orders.json'), JSON.stringify(rows, null, 1));
  }
  const f3 = await post('/api/pay/wechat/native', { plan: 'basic', refundConsent: true });
  await new Promise(r => setTimeout(r, 50));
  assert.notStrictEqual(f3.codeUrl, f1.codeUrl, '过期后换新码');
  assert.notStrictEqual(f3.order.outTradeNo, f1.order.outTradeNo, '过期续付必须更换商户支付单号');
  assert.ok(f3.order.previousOutTradeNos.includes(f1.order.outTradeNo), '旧支付单号保留用于后台反查');
  assert.strictEqual(f3.order.id, f1.order.id, '内部订单与权益归属保持不变');
  assert.ok(wxLog.includes('close'), '已调用微信关单接口');
  ok('F3 二维码过期 → 关旧单 + 新支付单号 + 新码');

  // ========== G. 查单兜底（回调丢失，轮询触发主动查单）============
  const g1 = readCOs().find(o => o.id === r3.order.id); // A7 留下的 p800 待支付单
  backdate(path.join(aiDir, 'credit-orders.json'), g1.id, new Date(Date.now() - 60 * 1000).toISOString());
  const aliQueriesBefore = aliLog.filter(x => x === 'query').length;
  const g1st = await get(`/api/orders/${g1.id}/status`);
  assert.strictEqual(g1st.status, 'paid');
  assert.ok(aliLog.filter(x => x === 'query').length > aliQueriesBefore, '触发了支付宝查单');
  assert.strictEqual(readUser().credits, 3905, '3105 + 800 查单补单到账');
  ok('G1 回调丢失 → 轮询触发查单 → 自动补单入账');

  const g1st2 = await get(`/api/orders/${g1.id}/status`);
  assert.strictEqual(g1st2.status, 'paid');
  assert.strictEqual(readUser().credits, 3905);
  ok('G2 已支付订单重复查询无副作用');

  // ========== H. 未开通通道降级 ==========
  const h1 = await post('/api/pay/wechat/h5', { creditPkg: 'p100' });
  assert.strictEqual(h1.ok, false);
  assert.match(h1.error, /H5/);
  ok('H1 微信 H5 未开通 → 友好提示');

  const h2 = await post('/api/pay/wechat/jsapi', { creditPkg: 'p100', code: 'fake-code' });
  assert.strictEqual(h2.ok, false);
  ok('H2 微信 JSAPI 未配置 AppSecret → 友好提示');

  server.close();
  https.request = () => { throw new Error('https.request 未恢复'); }; // 占位防止误用（进程随即退出）
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n全部通过（${passed} 项）`);
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败：', e); process.exit(1); });
