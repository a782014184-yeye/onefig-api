// 支付模块本地测试（2026-10-08）：不连微信服务器，验证签名/解密/升级逻辑
// 运行：node test-pay.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const pay = require('./pay');
const { aes256gcmDecrypt, verifyNotifySignature, wxSign } = pay._internal;

let passed = 0;
function ok(name) { passed++; console.log('  ✅', name); }

// ---- 1. AES-256-GCM 解密（模拟微信平台证书/回调资源解密）----
{
  const key = 'a'.repeat(32); // APIv3 密钥固定 32 字节
  const nonce = crypto.randomBytes(12).toString('hex');
  const ad = 'certificate';
  const plain = '-----BEGIN CERTIFICATE-----\nMIIB...fake\n-----END CERTIFICATE-----';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(ad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
  assert.strictEqual(aes256gcmDecrypt(key, nonce, ad, packed), plain);
  ok('AES-256-GCM 解密回环正确');
}

// ---- 2. 回调验签（模拟微信平台证书私钥签名 → 公钥验签）----
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = 'abc123';
  const body = '{"id":"evt-1","event_type":"TRANSACTION.SUCCESS"}';
  const message = `${ts}\n${nonce}\n${body}\n`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64');
  const certs = { SERIAL1: pubPem };
  const headers = { 'wechatpay-serial': 'SERIAL1', 'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': sig };
  assert.strictEqual(verifyNotifySignature(certs, headers, body), true);
  ok('正确签名验签通过');
  assert.strictEqual(verifyNotifySignature(certs, headers, body + ' '), false);
  ok('篡改报文验签拒绝');
  assert.strictEqual(verifyNotifySignature(certs, { ...headers, 'wechatpay-signature': sig.slice(0, -4) + 'AAAA' }), false);
  ok('伪造签名验签拒绝');
  const oldTs = (Math.floor(Date.now() / 1000) - 3600).toString();
  const oldMsg = `${oldTs}\n${nonce}\n${body}\n`;
  const oldSig = crypto.sign('RSA-SHA256', Buffer.from(oldMsg), privateKey).toString('base64');
  assert.strictEqual(verifyNotifySignature(certs, { ...headers, 'wechatpay-timestamp': oldTs, 'wechatpay-signature': oldSig }), false);
  ok('过期时间戳（重放攻击）验签拒绝');
  assert.strictEqual(verifyNotifySignature({}, headers, body), false);
  ok('未知证书序列号验签拒绝');
}

// ---- 3. 下单签名头格式 ----
{
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const auth = wxSign('POST', '/v3/pay/transactions/native', '{"a":1}', { mchid: '1001100963', serialNo: 'ABC', keyPem });
  assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 mchid="1001100963",nonce_str="[0-9a-f]{32}",timestamp="\d+",serial_no="ABC",signature="[A-Za-z0-9+/=]+"$/);
  ok('APIv3 请求签名头格式正确');
}

// ---- 4. markOrderPaid：升级会员 + 送积分 + 幂等 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-pay-'));
  const consoleDir = path.join(dir, 'console');
  fs.mkdirSync(consoleDir, { recursive: true });
  const user = { id: 'u1', name: '测试用户', level: 'none', memberSince: null, credits: 0 };
  const order = { id: 'o1', userId: 'u1', plan: 'pro', amount: 99.9, status: 'pending', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([user]));
  fs.writeFileSync(path.join(consoleDir, 'orders.json'), JSON.stringify([order]));

  const r1 = pay.markOrderPaid(dir, 'o1', { channel: '微信支付', transactionId: 'tx-001' });
  assert.strictEqual(r1.already, false);
  let u = JSON.parse(fs.readFileSync(path.join(consoleDir, 'users.json'), 'utf8'))[0];
  let o = JSON.parse(fs.readFileSync(path.join(consoleDir, 'orders.json'), 'utf8'))[0];
  assert.strictEqual(o.status, 'paid');
  assert.strictEqual(o.transactionId, 'tx-001');
  assert.strictEqual(u.level, 'pro');
  assert.ok(u.memberSince, 'memberSince 已设置');
  assert.strictEqual(u.credits, 900, '红果会员赠送 900 积分');
  ok('支付成功 → 订单置 paid + 会员升级 + 积分到账');

  const r2 = pay.markOrderPaid(dir, 'o1', { channel: '微信支付', transactionId: 'tx-001' });
  assert.strictEqual(r2.already, true);
  u = JSON.parse(fs.readFileSync(path.join(consoleDir, 'users.json'), 'utf8'))[0];
  assert.strictEqual(u.credits, 900, '重复回调不重复送积分');
  ok('重复回调幂等（微信重推最多 8 次，安全）');

  assert.strictEqual(pay.markOrderPaid(dir, '不存在'), null);
  ok('未知订单返回 null');

  const creditLog = JSON.parse(fs.readFileSync(path.join(dir, 'ai', 'credit-log.json'), 'utf8'));
  assert.strictEqual(creditLog.length, 1);
  assert.strictEqual(creditLog[0].delta, 900);
  ok('积分流水只记一条');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 5. 支付宝 RSA2 签名/验签（模拟：应用私钥签名 → 支付宝公钥验签）----
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const params = {
    app_id: '2021000000000000',
    out_trade_no: 'abc123def456',
    total_amount: '99.90',
    trade_status: 'TRADE_SUCCESS',
    trade_no: '2026100822001400000000000000',
  };
  const sign = pay._internal.alipaySign(params, priPem);
  assert.ok(pay._internal.alipayVerify(params, sign, pubPem));
  ok('支付宝 RSA2 签名验签回环正确');
  assert.ok(!pay._internal.alipayVerify({ ...params, total_amount: '0.01' }, sign, pubPem));
  ok('篡改金额验签拒绝');
  assert.ok(!pay._internal.alipayVerify(params, sign.slice(0, -4) + 'AAAA', pubPem));
  ok('伪造签名验签拒绝');
  assert.ok(!pay._internal.alipayVerify(params, undefined, pubPem));
  ok('缺失签名验签拒绝');
  // 签名串顺序无关性：参数乱序不影响验签
  const shuffled = {};
  Object.keys(params).reverse().forEach(k => { shuffled[k] = params[k]; });
  assert.ok(pay._internal.alipayVerify(shuffled, sign, pubPem));
  ok('参数乱序验签仍正确（按 key 排序）');
}

// ---- 6. 未配置时优雅降级 ----
{
  delete process.env.ONEFIG_PAY_CONFIG;
  const cfg = pay._internal.loadConfig();
  assert.strictEqual(cfg.wechat, null, '无配置文件时微信支付关闭，走人工转账');
  ok('无配置文件时优雅降级（网站照常运行）');
}

console.log(`\n全部通过（${passed} 项）`);
