// 在线支付本地集成测试（2026-10-17）
// 不连支付宝/微信真实服务器：用自签 RSA 密钥对模拟支付宝回调，验证：
//   A. 积分充值：creditPkg 下单 / 回调验签入账 / 幂等 / 金额防篡改 / 状态查询 / 未配置降级
//   B. 会员购买：重复购买拦截（同档与低档）/ 升级差价收费 / 升级补差赠送积分
// 运行：node test-pay-credit.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const express = require('express');

const pay = require('./pay');
const { CREDIT_PACKAGES } = require('./ai');

let passed = 0;
function ok(name) { passed++; console.log('  ✅', name); }

(async () => {
  // ---- 环境搭建：临时数据目录 + 自签支付宝密钥 ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-creditpay-'));
  const consoleDir = path.join(dir, 'console');
  const aiDir = path.join(dir, 'ai');
  const secretsDir = path.join(dir, 'secrets');
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.mkdirSync(aiDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });

  const user = { id: 'u-credit-1', name: '积分测试用户', level: 'none', credits: 5 };
  fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([user]));
  fs.writeFileSync(path.join(consoleDir, 'orders.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(aiDir, 'credit-orders.json'), JSON.stringify([]));

  const PLANS = { basic: { name: '青果会员', price: 29.9 }, pro: { name: '红果会员', price: 99.9 }, team: { name: '金果会员', price: 299.9 } };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(secretsDir, 'alipay-app-private.pem'), priPem);
  fs.writeFileSync(path.join(secretsDir, 'alipay-public.pem'), pubPem);
  const APPID = '2026test0000000001';
  fs.writeFileSync(path.join(dir, 'pay-config.json'), JSON.stringify({
    alipay: { enabled: true, appid: APPID, notifyUrl: 'https://onefig.cn/api/pay/alipay/notify', privateKeyFile: path.join(secretsDir, 'alipay-app-private.pem'), alipayPublicKeyFile: path.join(secretsDir, 'alipay-public.pem') },
  }));
  process.env.ONEFIG_PAY_CONFIG = path.join(dir, 'pay-config.json');

  // ---- 迷你服务器（与 server.js 同样的 deps 形状）----
  const USERS_FILE = path.join(consoleDir, 'users.json');
  const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  const saveUsers = us => fs.writeFileSync(USERS_FILE, JSON.stringify(us, null, 1));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/pay/alipay/notify', express.raw({ type: '*/*' }));
  app.use(express.json());
  const authUser = (req, res, next) => { req.user = loadUsers().find(u => u.id === 'u-credit-1'); next(); };
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

  // 模拟支付宝异步通知（用自签私钥签名，服务端配的是对应公钥）
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
  const readUser = () => loadUsers()[0];

  // ========== A. 积分充值 ==========
  const cfg = await fetch(base + '/api/pay/config').then(r => r.json());
  assert.strictEqual(cfg.alipay, true);
  assert.strictEqual(cfg.wechatNative, false);
  ok('A1 支付能力探测：支付宝开、微信关（与本机配置一致）');

  const bad = await post('/api/pay/alipay/pagepay', { creditPkg: 'p999' });
  assert.strictEqual(bad.ok, false);
  ok('A2 无效积分套餐被拒绝');

  const r1 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100' });
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.payUrl.includes('alipay.trade.page.pay'));
  assert.strictEqual(r1.order.amount, 9.9);
  assert.strictEqual(r1.order.credits, 100);
  const cos = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8'));
  assert.strictEqual(cos.length, 1);
  assert.ok(cos[0].outTradeNo, '订单已生成 outTradeNo');
  ok('A3 creditPkg 下单成功，积分订单落库 ai/credit-orders.json');

  const r1b = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100' });
  assert.strictEqual(r1b.order.id, r1.order.id);
  ok('A4 同套餐待支付订单复用（不重复建单）');

  assert.strictEqual(await notify(r1.order), 'success');
  assert.strictEqual(readUser().credits, 105, '5 + 100 到账');
  const co1 = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8'))[0];
  assert.strictEqual(co1.status, 'paid');
  assert.strictEqual(co1.channel, '支付宝');
  const logs1 = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8'));
  assert.strictEqual(logs1.length, 1);
  assert.strictEqual(logs1[0].delta, 100);
  ok('A5 支付宝回调验签通过 → 订单 paid + 积分自动入账 + 流水记录');

  assert.strictEqual(await notify(r1.order), 'success');
  assert.strictEqual(readUser().credits, 105, '重复回调不重复入账');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8')).length, 1);
  ok('A6 重复回调幂等（不重复送积分、不重复记流水）');

  const r3 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p800' });
  assert.strictEqual(await notify(r3.order, { total_amount: '0.01', trade_no: 'X' }), 'failure');
  const co3 = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8')).find(o => o.id === r3.order.id);
  assert.strictEqual(co3.status, 'pending');
  ok('A7 回调金额不符 → 拒绝且订单保持待支付');

  const st = await get(`/api/orders/${r1.order.id}/status`);
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.status, 'paid');
  assert.strictEqual(st.credits, 100);
  ok('A8 订单状态查询返回积分订单信息');

  const wx = await post('/api/pay/wechat/native', { creditPkg: 'p100' });
  assert.strictEqual(wx.ok, false);
  assert.match(wx.error, /未开通/);
  ok('A9 微信支付未配置时返回友好提示（前端回退人工转账）');

  // ========== B. 会员购买：重复拦截 + 差价升级 ==========
  const b1 = await post('/api/pay/alipay/pagepay', { plan: 'basic' });
  assert.strictEqual(b1.ok, true);
  assert.strictEqual(b1.order.amount, 29.9);
  assert.strictEqual(await notify(b1.order), 'success');
  assert.strictEqual(readUser().level, 'basic');
  assert.strictEqual(readUser().credits, 255, '105 + 150 开通赠送');
  ok('B1 新用户全价开通青果，赠送 150 积分');

  const b2 = await post('/api/pay/alipay/pagepay', { plan: 'basic' });
  assert.strictEqual(b2.ok, false);
  assert.match(b2.error, /无需重复购买/);
  ok('B2 已是青果 → 不能重复购买青果');

  const p1 = await post('/api/pay/alipay/pagepay', { plan: 'pro' });
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.order.amount, 70, '升级红果收差价 99.9 − 29.9');
  assert.strictEqual(await notify(p1.order), 'success');
  assert.strictEqual(readUser().level, 'pro');
  assert.strictEqual(readUser().credits, 1005, '255 + 750 升级补差赠送');
  const plog = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8')).slice(-1)[0];
  assert.strictEqual(plog.delta, 750);
  assert.match(plog.reason, /升级红果会员赠送/);
  ok('B3 青果升级红果：差价 70 元 + 补差赠送 750 积分');

  const b3 = await post('/api/pay/alipay/pagepay', { plan: 'basic' });
  assert.strictEqual(b3.ok, false);
  assert.match(b3.error, /无需重复购买/);
  ok('B4 已是红果 → 不能购买更低档青果');

  const t1 = await post('/api/pay/alipay/pagepay', { plan: 'team' });
  assert.strictEqual(t1.ok, true);
  assert.strictEqual(t1.order.amount, 200, '升级金果收差价 299.9 − 99.9');
  assert.strictEqual(await notify(t1.order), 'success');
  assert.strictEqual(readUser().level, 'team');
  assert.strictEqual(readUser().credits, 3105, '1005 + 2100 升级补差赠送');
  ok('B5 红果升级金果：差价 200 元 + 补差赠送 2100 积分');

  const t2 = await post('/api/pay/alipay/pagepay', { plan: 'team' });
  assert.strictEqual(t2.ok, false);
  assert.match(t2.error, /无需重复购买/);
  const dupNotify = await notify(t1.order);
  assert.strictEqual(dupNotify, 'success');
  assert.strictEqual(readUser().credits, 3105, '重复通知不重复赠送');
  ok('B6 已是金果 → 不能重复购买；重复回调仍幂等');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n全部通过（${passed} 项）`);
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败：', e); process.exit(1); });
