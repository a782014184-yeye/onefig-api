// ISSUE-03 本地回归：Native/JSAPI/H5 续付、关单失败、软隐藏与迟到微信回调。
// 微信、OAuth、签名与加密通知全部为本地模拟，不访问真实服务。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const assert = require('assert/strict');
const express = require('express');
const pay = require('./pay');
const { CREDIT_PACKAGES } = require('./ai');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-pay-retry-'));
  const consoleDir = path.join(dir, 'console');
  const aiDir = path.join(dir, 'ai');
  const secretsDir = path.join(dir, 'secrets');
  for (const d of [consoleDir, aiDir, secretsDir]) fs.mkdirSync(d, { recursive: true });
  const user = { id: 'u-retry', name: '虚构测试用户', level: 'none', credits: 0, exportCredits: 0 };
  const usersFile = path.join(consoleDir, 'users.json');
  const ordersFile = path.join(consoleDir, 'orders.json');
  const creditOrdersFile = path.join(aiDir, 'credit-orders.json');
  fs.writeFileSync(usersFile, JSON.stringify([user]));
  fs.writeFileSync(ordersFile, '[]');
  fs.writeFileSync(creditOrdersFile, '[]');
  fs.writeFileSync(path.join(consoleDir, 'materials.json'), '[]');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pri = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const keyFile = path.join(secretsDir, 'wx-key.pem');
  const certFile = path.join(secretsDir, 'wx-cert.pem');
  const pubKeyFile = path.join(secretsDir, 'wx-public.pem');
  fs.writeFileSync(keyFile, pri);
  fs.writeFileSync(certFile, pub);
  fs.writeFileSync(pubKeyFile, pub);
  const apiV3Key = 'k'.repeat(32);
  const mchid = '1001100999';
  const configFile = path.join(dir, 'pay-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ wechat: {
    enabled: true, appid: 'wx-retry', jsapiAppid: 'wx-retry', mchid, apiV3Key,
    serialNo: 'RETRY', notifyUrl: 'https://onefig.cn/api/pay/wechat/notify',
    appSecret: 'dummy-secret', h5Enabled: true, certFile, keyFile, pubKeyFile, pubKeyId: 'RETRY',
  } }));
  process.env.ONEFIG_PAY_CONFIG = configFile;

  let sequence = 0;
  let failNextClose = false;
  const calls = [];
  function response(status, json) {
    const buf = Buffer.from(JSON.stringify(json || {}));
    return { statusCode: status, on(event, fn) {
      if (event === 'data') setImmediate(() => fn(buf));
      if (event === 'end') setImmediate(() => fn());
      return this;
    } };
  }
  https.request = (opts, cb) => {
    const chunks = [];
    const req = {
      write(d) { chunks.push(Buffer.from(d)); },
      end(d) {
        if (d) chunks.push(Buffer.from(d));
        const body = Buffer.concat(chunks).toString('utf8');
        const p = String(opts.path || '');
        calls.push({ method: opts.method, path: p, body: body ? JSON.parse(body) : null });
        let out;
        if (p === '/v3/pay/transactions/native') out = response(200, { code_url: `weixin://retry-${++sequence}` });
        else if (p === '/v3/pay/transactions/jsapi') out = response(200, { prepay_id: `prepay-retry-${++sequence}` });
        else if (p === '/v3/pay/transactions/h5') out = response(200, { h5_url: `https://example.invalid/retry-${++sequence}` });
        else if (p.endsWith('/close')) out = failNextClose ? response(500, { code: 'UNKNOWN' }) : response(200, {});
        else out = response(404, { message: 'unexpected retry path' });
        cb(out);
      },
      on() { return this; }, destroy() {},
    };
    return req;
  };
  https.get = (url, cb) => {
    if (!String(url).startsWith('https://api.weixin.qq.com/')) throw new Error('unexpected OAuth host');
    cb(response(200, { openid: 'openid-retry' }));
    return { setTimeout() { return this; }, on() { return this; }, destroy() {} };
  };

  const loadUsers = () => JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const saveUsers = rows => fs.writeFileSync(usersFile, JSON.stringify(rows, null, 1));
  const app = express();
  app.use('/api/pay/wechat/notify', express.raw({ type: '*/*' }));
  app.use(express.json());
  const authUser = (req, res, next) => { req.user = loadUsers()[0]; next(); };
  pay(app, {
    authUser, DATA_DIR: dir,
    PLANS: { basic: { name: '青果会员', price: 29.9 }, pro: { name: '红果会员', price: 99.9 }, team: { name: '金果会员', price: 299.9 } },
    CREDIT_PACKAGES, loadUsers, saveUsers, logLine() {},
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const mutate = (file, id, changes) => {
    const rows = read(file);
    Object.assign(rows.find(x => x.id === id), changes);
    fs.writeFileSync(file, JSON.stringify(rows, null, 1));
  };
  const notifyWx = async order => {
    const data = { attach: order.id, out_trade_no: order.outTradeNo, mchid, amount: { total: Math.round(order.amount * 100) }, transaction_id: 'wx-late-payment', success_time: new Date().toISOString() };
    const nonce = crypto.randomBytes(12).toString('hex');
    const associatedData = 'transaction';
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associatedData));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
    const raw = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { nonce, associated_data: associatedData, ciphertext } });
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${ts}\n${nonce}\n${raw}\n`), pri).toString('base64');
    const r = await fetch(base + '/api/pay/wechat/notify', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': ts, 'Wechatpay-Nonce': nonce, 'Wechatpay-Signature': signature, 'Wechatpay-Serial': 'RETRY' },
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    // 金额变化：99.9 元旧单不能在青果升级时复用为全价；关单失败不开新单，成功后开 70 元新单。
    const oldOrder = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.equal(oldOrder.data.order.amount, 99.9);
    const users = loadUsers(); users[0].level = 'basic'; saveUsers(users);
    failNextClose = true;
    const blocked = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.equal(blocked.status, 409);
    assert.equal(read(ordersFile).filter(x => x.plan === 'pro').length, 1, '关单失败不得新增订单');
    failNextClose = false;
    const upgraded = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.data.order.amount, 70);
    assert.notEqual(upgraded.data.order.id, oldOrder.data.order.id);
    const afterUpgrade = read(ordersFile);
    assert.equal(afterUpgrade.find(x => x.id === oldOrder.data.order.id).status, 'expired');
    assert.equal(afterUpgrade.find(x => x.id === oldOrder.data.order.id).closeReason, 'amount-changed');
    const sameUpgrade = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.equal(sameUpgrade.data.order.id, upgraded.data.order.id);
    assert.equal(sameUpgrade.data.order.amount, 70);

    // Native：轮换后再次复用必须保留新号。
    const n1 = upgraded;
    const nativeId = n1.data.order.id;
    mutate(ordersFile, nativeId, { codeUrlAt: new Date(Date.now() - 3 * 3600e3).toISOString() });
    const n2 = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.notEqual(n2.data.order.outTradeNo, n1.data.order.outTradeNo);
    assert.ok(n2.data.order.previousOutTradeNos.includes(n1.data.order.outTradeNo));
    const n3 = await post('/api/pay/wechat/native', { plan: 'pro', refundConsent: true, licenseConsent: true });
    assert.equal(n3.data.order.outTradeNo, n2.data.order.outTradeNo, 'Native 复用不得重置回旧号');

    // JSAPI：23 小时旧订单 + 3 小时旧预支付，换号但保留原始 createdAt，并刷新支付时效。
    const j1 = await post('/api/pay/wechat/jsapi', { creditPkg: 'p100', code: 'dummy', refundConsent: true });
    const jsId = j1.data.order.id;
    const staleCreatedAt = new Date(Date.now() - 23 * 3600e3).toISOString();
    mutate(creditOrdersFile, jsId, { createdAt: staleCreatedAt, prepayAt: new Date(Date.now() - 3 * 3600e3).toISOString() });
    const j2 = await post('/api/pay/wechat/jsapi', { creditPkg: 'p100', code: 'dummy', refundConsent: true });
    assert.notEqual(j2.data.order.outTradeNo, j1.data.order.outTradeNo);
    assert.equal(j2.data.order.createdAt, staleCreatedAt);
    assert.ok(Date.parse(j2.data.order.expiresAt) > Date.now());
    assert.ok(j2.data.order.latestPaymentAttemptAt);

    // H5：关单失败必须 409 且不重开；恢复后超时续付换号。
    const h1 = await post('/api/pay/wechat/h5', { creditPkg: 'p100', refundConsent: true });
    const h5Id = h1.data.order.id;
    mutate(creditOrdersFile, h5Id, { mwebAt: new Date(Date.now() - 6 * 60e3).toISOString() });
    failNextClose = true;
    const h5CallsBefore = calls.filter(x => x.path === '/v3/pay/transactions/h5').length;
    const failed = await post('/api/pay/wechat/h5', { creditPkg: 'p100', refundConsent: true });
    assert.equal(failed.status, 409);
    assert.equal(calls.filter(x => x.path === '/v3/pay/transactions/h5').length, h5CallsBefore, '关单失败不得再次下单');
    assert.equal(read(creditOrdersFile).find(x => x.id === h5Id).outTradeNo, h1.data.order.outTradeNo);
    failNextClose = false;
    const h2 = await post('/api/pay/wechat/h5', { creditPkg: 'p100', refundConsent: true });
    assert.notEqual(h2.data.order.outTradeNo, h1.data.order.outTradeNo);

    // 清空：两笔当前订单 + 一张金额变化旧单软隐藏；随后迟到微信付款通知仍须履约。
    const expiredAt = new Date(Date.now() - 3600e3).toISOString();
    for (const id of [jsId, h5Id]) mutate(creditOrdersFile, id, { expiresAt: expiredAt, latestPaymentAttemptAt: expiredAt });
    const del = await fetch(base + '/api/orders/expired', { method: 'DELETE', headers: { Authorization: 'Bearer dummy' } });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).removed, 3);
    let rows = read(creditOrdersFile);
    assert.ok(rows.find(x => x.id === jsId)?.hiddenAt);
    assert.ok(rows.find(x => x.id === h5Id)?.hiddenAt);
    const lateOrder = rows.find(x => x.id === jsId);
    const notified = await notifyWx(lateOrder);
    assert.equal(notified.status, 200, JSON.stringify(notified.data));
    assert.equal(notified.data.code, 'SUCCESS');
    rows = read(creditOrdersFile);
    assert.equal(rows.find(x => x.id === jsId).status, 'paid');
    assert.equal(loadUsers()[0].credits, 100, '迟到回调必须入账且不重复');

    console.log('✓ Native 换号保持、JSAPI/H5 超时续付、支付时效、关单失败阻断、软隐藏与迟到回调全部通过');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
