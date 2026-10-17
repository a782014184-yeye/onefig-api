// 积分充值在线支付本地集成测试（2026-10-17）
// 不连支付宝/微信真实服务器：用自签 RSA 密钥对模拟支付宝回调，验证：
//   1. creditPkg 下单（alipay pagepay 本地组装 URL，无网络）
//   2. 支付宝回调验签 + 积分自动入账 + 流水
//   3. 重复回调幂等
//   4. 金额不符拒绝
//   5. 订单状态查询（会员订单/积分订单通用端点）
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
    authUser, DATA_DIR: dir,
    PLANS: { basic: { name: '青果会员', price: 29.9 } },
    CREDIT_PACKAGES, loadUsers, saveUsers,
    logLine: (tag, msg) => console.log(`    [${tag}]`, msg),
  });

  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, auth = true) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer t' } : {}) },
    body: JSON.stringify(body),
  }).then(r => r.json());
  const get = p => fetch(base + p, { headers: { Authorization: 'Bearer t' } }).then(r => r.json());

  // ---- 1. 支付能力探测 ----
  const cfg = await fetch(base + '/api/pay/config').then(r => r.json());
  assert.strictEqual(cfg.alipay, true);
  assert.strictEqual(cfg.wechatNative, false);
  ok('支付能力探测：支付宝开、微信关（与本机配置一致）');

  // ---- 2. creditPkg 下单 ----
  const bad = await post('/api/pay/alipay/pagepay', { creditPkg: 'p999' });
  assert.strictEqual(bad.ok, false);
  ok('无效积分套餐被拒绝');

  const r1 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100' });
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.payUrl.includes('alipay.trade.page.pay'));
  assert.strictEqual(r1.order.amount, 9.9);
  assert.strictEqual(r1.order.credits, 100);
  assert.strictEqual(r1.order.status, 'pending');
  const cos = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8'));
  assert.strictEqual(cos.length, 1);
  assert.ok(cos[0].outTradeNo, '订单已生成 outTradeNo');
  ok('creditPkg 下单成功，积分订单落库 ai/credit-orders.json');

  // 同套餐重复下单 → 复用同一笔
  const r1b = await post('/api/pay/alipay/pagepay', { creditPkg: 'p100' });
  assert.strictEqual(r1b.order.id, r1.order.id);
  ok('同套餐待支付订单复用（不重复建单）');

  // ---- 3. 模拟支付宝回调：验签 + 入账 ----
  const notify = async (overrides) => {
    const params = {
      app_id: APPID,
      out_trade_no: r1.order.outTradeNo,
      total_amount: '9.90',
      trade_status: 'TRADE_SUCCESS',
      trade_no: '202610172200000000000000001',
      gmt_payment: '2026-10-17 20:00:00',
      ...overrides,
    };
    params.sign = pay._internal.alipaySign(params, priPem);
    params.sign_type = 'RSA2';
    const body = new URLSearchParams(params).toString();
    const res = await fetch(base + '/api/pay/alipay/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.text();
  };

  const t1 = await notify();
  assert.strictEqual(t1, 'success');
  let u = loadUsers()[0];
  assert.strictEqual(u.credits, 105, '5 + 100 到账');
  let co = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8'))[0];
  assert.strictEqual(co.status, 'paid');
  assert.strictEqual(co.channel, '支付宝');
  assert.strictEqual(co.transactionId, '202610172200000000000000001');
  const logs = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8'));
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].delta, 100);
  assert.strictEqual(logs[0].reason, '积分充值');
  ok('支付宝回调验签通过 → 订单 paid + 积分自动入账 + 流水记录');

  // ---- 4. 幂等：重复回调不再加积分 ----
  const t2 = await notify();
  assert.strictEqual(t2, 'success');
  u = loadUsers()[0];
  assert.strictEqual(u.credits, 105, '重复回调不重复入账');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-log.json'), 'utf8')).length, 1);
  ok('重复回调幂等（不重复送积分、不重复记流水）');

  // ---- 5. 金额不符拒绝 ----
  const r3 = await post('/api/pay/alipay/pagepay', { creditPkg: 'p800' });
  const tampered = await notify({ out_trade_no: r3.order.outTradeNo, total_amount: '0.01', trade_no: 'X' });
  assert.strictEqual(tampered, 'failure');
  const co3 = JSON.parse(fs.readFileSync(path.join(aiDir, 'credit-orders.json'), 'utf8')).find(o => o.id === r3.order.id);
  assert.strictEqual(co3.status, 'pending');
  ok('回调金额不符 → 拒绝且订单保持待支付');

  // ---- 6. 订单状态查询（积分订单走通用端点）----
  const st = await get(`/api/orders/${r1.order.id}/status`);
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.status, 'paid');
  assert.strictEqual(st.credits, 100);
  ok('订单状态查询返回积分订单信息');

  // ---- 7. 微信积分下单：未配置时优雅提示 ----
  const wx = await post('/api/pay/wechat/native', { creditPkg: 'p100' });
  assert.strictEqual(wx.ok, false);
  assert.match(wx.error, /未开通/);
  ok('微信支付未配置时返回友好提示（前端回退人工转账）');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n全部通过（${passed} 项）`);
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败：', e); process.exit(1); });
