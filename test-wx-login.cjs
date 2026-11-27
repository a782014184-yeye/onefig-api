// 微信扫码登录本地集成测试（2026-11-27）
// 不连微信真实服务器：拦截 https.request 假扮 api.weixin.qq.com（token/qrcode/user-info）
// 覆盖：
//   A. 配置开关（未配置 → 关闭；配置 → 开启）
//   B. 二维码创建（login/bind 两种模式；bind 需登录）
//   C. 服务号回调（GET 验签/echostr；POST 关注事件、签名伪造拦截、一次性 scene）
//   D. 轮询状态机（pending → followed → bound/error/expired）
//   E. 邮箱绑定（错误密码/未绑定扫码绑定/一个微信绑一个账号的占用拦截）
//   F. 一键注册（协议同意校验/占位邮箱/再次扫码直接登录）
//   G. 账号中心（wx-status / wx-unbind 密码确认 / 补绑邮箱验证码全流程）
// 运行：node test-wx-login.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const https = require('https');
const express = require('express');

// ---- 假微信服务器：按 URL 路由返回固定响应 ----
const WX_API = {
  '/cgi-bin/token': () => ({ access_token: 'TEST_ACCESS_TOKEN', expires_in: 7200 }),
  '/cgi-bin/qrcode/create': (body) => {
    const scene = body && body.action_info && body.action_info.scene && body.action_info.scene.scene_str;
    return { ticket: 'TICKET_' + scene, expire_seconds: 300, url: 'http://t/' + scene };
  },
  '/cgi-bin/user/info': () => ({ subscribe: 1, nickname: '科研小果', openid: 'ox' }),
};
const realRequest = https.request;
https.request = function (opts, cb) {
  const p = typeof opts === 'string' ? new URL(opts) : new URL(opts.path, 'https://api.weixin.qq.com');
  if (p.hostname !== 'api.weixin.qq.com') return realRequest.apply(this, arguments);
  let body = '';
  const req = new (require('stream').PassThrough)();
  req.write = d => { body += d; return true; };
  req.end = () => {
    const route = Object.keys(WX_API).find(k => p.pathname.startsWith(k));
    const json = route ? WX_API[route](JSON.parse(body || '{}')) : { errcode: 40466 };
    const payload = JSON.stringify(json);
    setImmediate(() => {
      cb({
        statusCode: 200,
        on(ev, fn) { if (ev === 'data') fn(Buffer.from(payload)); if (ev === 'end') fn(); return this; },
      });
    });
  };
  req.destroy = () => {};
  req.on = () => req;
  req.setTimeout = () => req;
  return req;
};

let passed = 0;
function ok(name) { passed++; console.log('  ✅', name); }

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-wxtest-'));
  const consoleDir = path.join(dir, 'console');
  fs.mkdirSync(consoleDir, { recursive: true });
  fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([{
    id: 'u-email-1', name: '邮箱用户', email: 'user@test.local', contact: 'user@test.local',
    salt: 's1', passHash: crypto.scryptSync('pass-123', 's1', 32).toString('hex'),
    level: 'none', joinedAt: new Date().toISOString(), verified: true,
  }]));
  const wxCfgFile = path.join(dir, 'wx-config.json');
  fs.writeFileSync(wxCfgFile, JSON.stringify({ appid: 'wx-test-appid', secret: 'test-secret', token: 'tk123456' }));
  process.env.ONEFIG_WX_CONFIG = wxCfgFile;
  // 防止「复用 pay-config 服务号凭据」的兜底误读开发机真实配置：指向不存在的文件
  process.env.ONEFIG_PAY_CONFIG = path.join(dir, 'no-such-pay-config.json');

  const TOKEN_SECRET = 'test-token-secret';
  const sign = p => crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('base64url');
  const makeToken = (uid, pv) => { const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 864e5, pv: pv || 0 })).toString('base64url'); return p + '.' + sign(p); };
  const publicUser = u => ({ id: u.id, name: u.name, email: u.email || '', level: u.level || 'none', verified: u.verified !== false });
  function authUser(req, res, next) {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ ok: false, error: '请先登录' });
    const [p, s] = m[1].split('.');
    if (!p || sign(p) !== s) return res.status(401).json({ ok: false, error: '登录已过期' });
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp < Date.now()) return res.status(401).json({ ok: false, error: '登录已过期' });
    const u = loadUsers().find(x => x.id === d.uid);
    if (!u) return res.status(401).json({ ok: false, error: '账号不存在' });
    if ((d.pv || 0) !== (u.pwdVer || 0)) return res.status(401).json({ ok: false, error: '密码已修改，请重新登录' });
    req.user = u;
    next();
  }
  const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const saveJSON = (f, rows) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); };
  const USERS_FILE = path.join(consoleDir, 'users.json');
  const loadUsers = () => loadJSON(USERS_FILE, []);
  const saveUsers = rows => saveJSON(USERS_FILE, rows);
  // sendRegisterCode 替身：同一套哈希写入 registercodes.json（与 server.js 格式一致）
  async function sendRegisterCode(email) {
    const code = '424242';
    const salt = 'regsalt';
    const f = path.join(consoleDir, 'registercodes.json');
    const rows = loadJSON(f, []).filter(r => r.email !== email);
    rows.push({ email, salt, codeHash: crypto.scryptSync(code, salt, 32).toString('hex'), exp: Date.now() + 600e3, attempts: 0, sentAt: Date.now() });
    saveJSON(f, rows);
    return true;
  }
  const makeRateLimiter = (max, windowMs, msg) => {
    const hits = new Map();
    return (req, res, next) => {
      const ip = req.socket.remoteAddress || '?';
      const now = Date.now();
      const rec = (hits.get(ip) || []).filter(t => now - t < windowMs);
      if (rec.length >= max) return res.status(429).json({ ok: false, error: msg });
      rec.push(now);
      hits.set(ip, rec);
      next();
    };
  };

  const app = express();
  app.use('/api/wx/callback', express.raw({ type: '*/*' }));
  app.use(express.json({ limit: '256kb' }));
  require('./wx')(app, {
    authUser, DATA_DIR: dir, loadJSON, saveJSON, loadUsers, saveUsers, logLine: () => {},
    makeToken, publicUser, sign, isVerified: u => u.verified !== false, sendRegisterCode,
    LEGAL_VERSION: '2026-11-19', makeRateLimiter,
  });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = async (p, token) => (await fetch(base + p, token ? { headers: { Authorization: 'Bearer ' + token } } : {})).json();
  const post = async (p, body, token) => (await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  })).json();
  const postXml = async (qs, xml) => {
    const r = await fetch(base + '/api/wx/callback?' + qs, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml });
    return { status: r.status, text: await r.text() };
  };
  const cbQuery = () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n' + Math.random().toString(36).slice(2, 8);
    const signature = crypto.createHash('sha1').update(['tk123456', ts, nonce].sort().join('')).digest('hex');
    return `signature=${signature}&timestamp=${ts}&nonce=${nonce}`;
  };
  const subscribeXml = (scene, openid) => `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event><EventKey><![CDATA[qrscene_${scene}]]></EventKey></xml>`;
  const waitFollowed = async scene => {
    for (let i = 0; i < 20; i++) {
      const st = await get('/api/auth/wxqr/' + scene);
      if (st.status !== 'pending') return st;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('等待关注超时 scene=' + scene);
  };

  // ====== A. 配置开关 ======
  {
    const en = await get('/api/auth/wxqr/enabled');
    assert.strictEqual(en.enabled, true);
    ok('A1 配置齐全时功能开启');
    delete process.env.ONEFIG_WX_CONFIG;
    const en2 = await get('/api/auth/wxqr/enabled');
    assert.strictEqual(en2.enabled, false);
    const r = await post('/api/auth/wxqr', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'wx_disabled');
    process.env.ONEFIG_WX_CONFIG = wxCfgFile;
    ok('A2 未配置时功能关闭且接口明确报错');
    // A3：复用 pay-config 里 JSAPI 的服务号凭据兜底（AppID/AppSecret 与微信支付共用一对）
    {
      delete process.env.ONEFIG_WX_CONFIG;
      const payFile = path.join(dir, 'pay-fallback.json');
      fs.writeFileSync(payFile, JSON.stringify({ wechat: { appid: 'wx-pay-same-appid', appSecret: 'same-secret' } }));
      process.env.ONEFIG_PAY_CONFIG = payFile;
      const en3 = await get('/api/auth/wxqr/enabled');
      assert.strictEqual(en3.enabled, false, 'pay-config 兜底只有 appid/secret，缺 token 仍应关闭');
      process.env.ONEFIG_WX_TOKEN = 'tk-from-env';
      const en4 = await get('/api/auth/wxqr/enabled');
      assert.strictEqual(en4.enabled, true, 'appid/secret 走 pay-config 兜底 + token 走 env → 开启');
      delete process.env.ONEFIG_WX_TOKEN;
      process.env.ONEFIG_PAY_CONFIG = path.join(dir, 'no-such-pay-config.json');
      process.env.ONEFIG_WX_CONFIG = wxCfgFile;
      ok('A3 AppID/Secret 复用 pay-config 兜底生效（token 仍需显式配置）');
    }
  }

  // ====== B. 二维码创建 ======
  const q1 = await post('/api/auth/wxqr', {});
  assert.strictEqual(q1.ok, true);
  assert.ok(q1.scene.startsWith('l'));
  assert.ok(q1.qr.includes('TICKET_' + q1.scene));
  ok('B1 登录二维码创建成功（scene 前缀 l，回显 ticket）');
  const noAuth = await post('/api/auth/wxqr', { mode: 'bind' });
  assert.strictEqual(noAuth.ok, false);
  ok('B2 bind 模式未登录被拒绝');

  // ====== C. 回调验签与事件 ======
  {
    const bad = await fetch(base + '/api/wx/callback?signature=bad&timestamp=1&nonce=2');
    assert.strictEqual(bad.status, 403);
    ok('C1 伪造签名被 403');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'abc';
    const signature = crypto.createHash('sha1').update(['tk123456', ts, nonce].sort().join('')).digest('hex');
    const r = await fetch(base + '/api/wx/callback?' + `signature=${signature}&timestamp=${ts}&nonce=${nonce}&echostr=helloechostr`);
    assert.strictEqual(await r.text(), 'helloechostr');
    ok('C2 GET 验签通过回显 echostr');
  }
  const OX1 = 'oXTESTopenid000000001';
  let loginBindCode = '';
  {
    const r = await postXml(cbQuery(), subscribeXml(q1.scene, OX1));
    assert.match(r.text, /<MsgType><!\[CDATA\[text\]\]><\/MsgType>/, '订阅事件应回复欢迎语文本消息');
    assert.match(r.text, /OneFig无花果|欢迎/, '欢迎语包含品牌与欢迎字样');
    assert.match(r.text, new RegExp('<ToUserName><!\\[CDATA\\[' + OX1), '回复接收方为关注者 openid');
    const st = await waitFollowed(q1.scene);
    assert.strictEqual(st.status, 'followed');
    assert.ok(st.bindCode);
    assert.strictEqual(st.wxName, '科研小果');
    loginBindCode = st.bindCode;
    ok('C3 关注事件 → 欢迎语回复 + followed + bindCode + 昵称');
  }
  // 已关注用户扫码（SCAN 事件）→ 回操作提示，同样置 scene followed
  {
    const qScan = await post('/api/auth/wxqr', {});
    const scanXml = `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[${OX1}]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event><EventKey><![CDATA[${qScan.scene}]]></EventKey></xml>`;
    const r = await postXml(cbQuery(), scanXml);
    assert.match(r.text, /已收到你的扫码/, 'SCAN 事件应回复扫码提示');
    const st = await waitFollowed(qScan.scene);
    assert.strictEqual(st.status, 'followed');
    ok('C3b 已关注扫码（SCAN）→ 操作提示 + followed');
  }

  // ====== D/E. 邮箱绑定 ======
  {
    const bad = await post('/api/auth/wx-bind', { bindCode: loginBindCode, email: 'user@test.local', password: 'wrong-pass' });
    assert.strictEqual(bad.ok, false);
    ok('D1 错误密码绑定被拒绝');
    const tampered = await post('/api/auth/wx-bind', { bindCode: loginBindCode + 'x', email: 'user@test.local', password: 'pass-123' });
    assert.strictEqual(tampered.ok, false);
    ok('D2 篡改 bindCode 被拒绝');
    const good = await post('/api/auth/wx-bind', { bindCode: loginBindCode, email: 'user@test.local', password: 'pass-123' });
    assert.strictEqual(good.ok, true);
    assert.ok(good.token);
    const me = await get('/api/auth/wx-status', good.token);
    assert.strictEqual(me.bound, true);
    assert.strictEqual(me.wxName, '科研小果');
    ok('D3 邮箱密码绑定成功 → 直接登录，状态可查');
    const reuse = await post('/api/auth/wx-bind', { bindCode: loginBindCode, email: 'user@test.local', password: 'pass-123' });
    assert.strictEqual(reuse.ok, false);
    ok('D4 bindCode 一次性，复用被拒');
  }

  // ====== E. 绑定后再次扫码 → 直接登录 ======
  {
    const q2 = await post('/api/auth/wxqr', {});
    await postXml(cbQuery(), subscribeXml(q2.scene, OX1));
    const st = await waitFollowed(q2.scene);
    assert.strictEqual(st.status, 'bound');
    assert.ok(st.token);
    ok('E1 已绑定微信再次扫码 → 直接发 token');
    const again = await get('/api/auth/wxqr/' + q2.scene);
    assert.strictEqual(again.status, 'expired');
    ok('E2 scene 一次性，消费后 expired');
  }

  // ====== E2. 占用拦截（bind 模式：登录态扫码直接绑） ======
  {
    fs.writeFileSync(USERS_FILE, JSON.stringify([
      ...loadUsers(),
      { id: 'u-email-2', name: '另一个邮箱用户', email: 'other@test.local', contact: 'other@test.local', salt: 's2', passHash: crypto.scryptSync('pass-456', 's2', 32).toString('hex'), level: 'none', joinedAt: new Date().toISOString(), verified: true },
    ]));
    // 已绑定 OX1 的微信扫 u-email-2 的 bind 二维码 → 拒
    const tok2 = makeToken('u-email-2', 0);
    const q3 = await post('/api/auth/wxqr', { mode: 'bind' }, tok2);
    assert.ok(q3.scene.startsWith('b'));
    await postXml(cbQuery(), subscribeXml(q3.scene, OX1));
    const st3 = await waitFollowed(q3.scene);
    assert.strictEqual(st3.status, 'error');
    assert.match(st3.error, /已绑定过其他账号/);
    ok('E3 一个微信不能绑两个账号（bind 模式拦截）');
    // OX1 绑定的 u-email-1 扫 bind 二维码绑新微信 oXTESTopenid000000009 → 拒
    const tok1 = makeToken('u-email-1', 0);
    const q4 = await post('/api/auth/wxqr', { mode: 'bind' }, tok1);
    await postXml(cbQuery(), subscribeXml(q4.scene, 'oXTESTopenid000000009'));
    const st4 = await waitFollowed(q4.scene);
    assert.strictEqual(st4.status, 'error');
    assert.match(st4.error, /已绑定其他微信/);
    ok('E4 一个账号不能绑两个微信（bind 模式拦截）');
    // 干净的组合：u-email-2 绑 OX2（留给 F/G 复用前先解绑干净——直接用 F 的新 openid 即可，这里仅验证拦截）
  }

  // ====== F. 一键注册 ======
  const OX2 = 'oXTESTopenid000000002';
  let regToken = '';
  {
    const q4 = await post('/api/auth/wxqr', {});
    await postXml(cbQuery(), subscribeXml(q4.scene, OX2));
    const st = await waitFollowed(q4.scene);
    const noTerms = await post('/api/auth/wx-register', { bindCode: st.bindCode });
    assert.strictEqual(noTerms.ok, false);
    ok('F1 未同意协议注册被拒');
    const reg = await post('/api/auth/wx-register', { bindCode: st.bindCode, name: '扫码新同学', wxName: '科研小果', termsAccepted: true, privacyAccepted: true, termsVersion: '2026-11-19', privacyVersion: '2026-11-19' });
    assert.strictEqual(reg.ok, true);
    assert.ok(reg.token);
    assert.ok(/@wx\.onefig\.cn$/.test(reg.user.email));
    regToken = reg.token;
    const me = await get('/api/auth/wx-status', regToken);
    assert.strictEqual(me.isWxCreated, true);
    ok('F2 一键注册成功（占位邮箱 + isWxCreated 标记）');
  }

  // ====== G. 账号中心管理 ======
  {
    const wrongPw = await post('/api/auth/wx-unbind', { password: 'nope' }, regToken);
    assert.strictEqual(wrongPw.ok, false);
    const noPw = await post('/api/auth/wx-unbind', {}, regToken);
    assert.strictEqual(noPw.ok, false);
    assert.match(noPw.error, /先补绑邮箱/);
    ok('G1 无密码微信账号禁止解绑（防账号丢失）');
  }
  {
    const sent = await post('/api/auth/wx-set-email', { email: 'real@test.local' }, regToken);
    assert.strictEqual(sent.ok, true);
    const badCode = await post('/api/auth/wx-set-email/verify', { email: 'real@test.local', code: '000000' }, regToken);
    assert.strictEqual(badCode.ok, false);
    const good = await post('/api/auth/wx-set-email/verify', { email: 'real@test.local', code: '424242' }, regToken);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.user.email, 'real@test.local');
    assert.strictEqual(good.user.verified, true);
    const again = await post('/api/auth/wx-set-email', { email: 'third@test.local' }, regToken);
    assert.strictEqual(again.ok, false);
    ok('G2 补绑邮箱全流程（验证码错拒/成功/已有邮箱后不可再改）');
    const un = await post('/api/auth/wx-unbind', { password: 'whatever' }, regToken);
    assert.strictEqual(un.ok, false, '微信账号无密码，仍应拒绝解绑');
  }
  {
    const tok = makeToken('u-email-1', 0);
    const un1 = await post('/api/auth/wx-unbind', { password: 'wrong' }, tok);
    assert.strictEqual(un1.ok, false);
    const un2 = await post('/api/auth/wx-unbind', { password: 'pass-123' }, tok);
    assert.strictEqual(un2.ok, true);
    const me = await get('/api/auth/wx-status', tok);
    assert.strictEqual(me.bound, false);
    ok('G3 邮箱账号解绑需密码确认，解绑后状态更新');
  }

  // ====== G4. 无密码账号登录态设置密码（补绑邮箱后完善账号的最后一步） ======
  {
    // regToken 对应的账号此前已补绑邮箱 real@test.local，但无密码
    let st = await get('/api/auth/wx-status', regToken);
    assert.strictEqual(st.hasPassword, false);
    const weak = await post('/api/auth/set-password', { password: '123' }, regToken);
    assert.strictEqual(weak.ok, false);
    const set = await post('/api/auth/set-password', { password: 'new-pass-789' }, regToken);
    assert.strictEqual(set.ok, true);
    assert.ok(set.token);
    // 旧 token 已失效（pwdVer 递增），新 token 可用
    const oldMe = await get('/api/auth/wx-status', regToken);
    assert.strictEqual(oldMe.ok, false, '旧 token 应已失效');
    const newMe = await get('/api/auth/wx-status', set.token);
    assert.strictEqual(newMe.hasPassword, true);
    // 已有密码后拒绝重复设置
    const again = await post('/api/auth/set-password', { password: 'another-1' }, set.token);
    assert.strictEqual(again.ok, false);
    ok('G4 无密码账号登录态设置密码：旧登录态失效、新 token 签发、重复设置被拒');
  }

  // ====== H. bind 模式（登录态扫码直接绑） ======
  {
    const tok = makeToken('u-email-2', 0);
    const q5 = await post('/api/auth/wxqr', { mode: 'bind' }, tok);
    assert.strictEqual(q5.ok, true);
    assert.ok(q5.scene.startsWith('b'));
    const OX3 = 'oXTESTopenid000000003';
    await postXml(cbQuery(), subscribeXml(q5.scene, OX3));
    const st = await waitFollowed(q5.scene);
    assert.strictEqual(st.status, 'bound');
    const me = await get('/api/auth/wx-status', tok);
    assert.strictEqual(me.bound, true);
    ok('H1 登录态 bind 二维码：关注后直接绑定当前账号');
  }

  server.close();
  console.log(`\n全部通过（${passed} 项）`);
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败:', e && e.stack || e); process.exit(1); });
