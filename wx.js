// 微信扫码登录（2026-11-27，认证服务号「OneFig无花果」）
// 流程：网页申请带参数临时二维码 → 用户微信扫码关注/已是粉丝 → 微信服务器推送事件到 /api/wx/callback
//       → 网页轮询场景状态 → 已绑定直接发 token 登录；未绑定走「绑定已有邮箱账号」或「一键创建新账号」
// 安全：回调 sha1 验签（防伪 openid）、scene 一次性、5 分钟过期、绑定验证码 10 分钟有效、限流
// 配置：env ONEFIG_WX_APPID / ONEFIG_WX_SECRET / ONEFIG_WX_TOKEN（生产入 onefig-api.env），
//       本地联调可用 ONEFIG_WX_CONFIG 指向 {appid, secret, token} json。未配置 = 功能关闭。
const crypto = require('crypto');
const https = require('https');

module.exports = function registerWx(app, deps) {
  const {
    authUser, DATA_DIR, loadJSON, saveJSON, loadUsers, saveUsers, logLine,
    makeToken, publicUser, sign, isVerified, sendRegisterCode, LEGAL_VERSION, makeRateLimiter,
  } = deps;

  const fs = require('fs');
  const path = require('path');
  const WX_DIR = path.join(DATA_DIR, 'wx');
  fs.mkdirSync(WX_DIR, { recursive: true });
  const SCENES_FILE = path.join(WX_DIR, 'scenes.json');
  const loadScenes = () => loadJSON(SCENES_FILE, []);
  const saveScenes = r => saveJSON(SCENES_FILE, r);
  const TOKEN_CACHE_FILE = path.join(WX_DIR, 'access-token.json');

  const SCENE_TTL = 300e3;        // 与微信临时二维码 expire_seconds 对齐
  const BIND_CODE_TTL = 600e3;    // 关注后绑定窗口 10 分钟

  // ---- 配置 ----
  // env 优先；其次本地 ONEFIG_WX_CONFIG json；最后回退复用 pay-config 里 JSAPI 已在用的服务号凭据
  // （同一对 AppID/AppSecret，微信支付 JSAPI 与扫码登录共用，见 pay.js 的 wechat.appSecret 注释）
  function loadConfig() {
    const c = {
      appid: process.env.ONEFIG_WX_APPID || '',
      secret: process.env.ONEFIG_WX_SECRET || '',
      token: process.env.ONEFIG_WX_TOKEN || '',
    };
    if (c.appid && c.secret && c.token) return c;
    if ((!c.appid || !c.secret || !c.token) && process.env.ONEFIG_WX_CONFIG) {
      try {
        const f = JSON.parse(fs.readFileSync(process.env.ONEFIG_WX_CONFIG, 'utf8'));
        c.appid = c.appid || String(f.appid || '');
        c.secret = c.secret || String(f.secret || '');
        c.token = c.token || String(f.token || '');
      } catch { /* 本地配置缺失按未配置处理 */ }
    }
    if ((!c.appid || !c.secret) && !process.env.ONEFIG_WX_CONFIG) {
      try {
        const payFile = process.env.ONEFIG_PAY_CONFIG || path.join(__dirname, 'pay-config.local.json');
        const p = JSON.parse(fs.readFileSync(payFile, 'utf8'));
        const w = p.wechat || {};
        c.appid = c.appid || String(p.wechatJsapiAppid || w.appid || '');
        c.secret = c.secret || String(w.appSecret || '');
      } catch { /* pay-config 缺失时按未配置处理 */ }
    }
    return c;
  }
  const enabled = () => { const c = loadConfig(); return !!(c.appid && c.secret && c.token); };
  const notEnabled = res => res.status(503).json({ ok: false, code: 'wx_disabled', error: '微信登录暂未开通' });

  // ---- 微信服务端 API（json 往返）----
  function wxApi(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.weixin.qq.com', path: urlPath, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        timeout: 8000,
      }, res => {
        let text = '';
        res.on('data', d => { text += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 json 按失败处理 */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('wx api timeout')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // access_token 进程内缓存 + 磁盘兜底（重启不立即失效）
  let tokenCache = loadJSON(TOKEN_CACHE_FILE, null);
  async function getAccessToken() {
    if (tokenCache && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
    const { appid, secret } = loadConfig();
    const r = await wxApi('GET', `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`);
    const tok = r.json && r.json.access_token;
    if (!tok) { logLine(`wx access_token 获取失败: ${(r.text || '').slice(0, 200)}`); throw new Error('微信接口暂不可用'); }
    tokenCache = { token: tok, exp: Date.now() + 7000e3 };
    saveJSON(TOKEN_CACHE_FILE, tokenCache);
    return tok;
  }

  async function createQr(scene) {
    const tok = await getAccessToken();
    const r = await wxApi('POST', `/cgi-bin/qrcode/create?access_token=${encodeURIComponent(tok)}`, {
      expire_seconds: SCENE_TTL / 1000,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: scene } },
    });
    if (!r.json || !r.json.ticket) { logLine(`wx qrcode/create 失败: ${(r.text || '').slice(0, 200)}`); throw new Error('二维码生成失败，请稍后再试'); }
    return { ticket: r.json.ticket, url: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(r.json.ticket) };
  }

  // 拉取关注者昵称（best effort，失败不阻断登录）
  async function fetchWxName(openid) {
    try {
      const tok = await getAccessToken();
      const r = await wxApi('GET', `/cgi-bin/user/info?access_token=${encodeURIComponent(tok)}&openid=${encodeURIComponent(openid)}&lang=zh_CN`);
      const n = r.json && String(r.json.nickname || '').trim();
      return n ? n.slice(0, 30) : '';
    } catch { return ''; }
  }

  // ---- 回调验签：sha1(token, timestamp, nonce) 字典序拼接 ----
  function checkSignature(query) {
    const { token } = loadConfig();
    const { signature, timestamp, nonce } = query || {};
    if (!token || !signature || !timestamp || !nonce) return false;
    const expect = crypto.createHash('sha1').update([token, String(timestamp), String(nonce)].sort().join('')).digest('hex');
    return expect === String(signature);
  }

  // ---- 事件 XML 极简解析（仅取需要的字段，CDATA 兼容）----
  function parseEventXml(xml) {
    const pick = tag => {
      const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
      return m ? m[1].trim() : '';
    };
    return {
      to: pick('ToUserName'),
      from: pick('FromUserName'),
      msgType: pick('MsgType'),
      event: pick('Event'),
      eventKey: pick('EventKey'),
    };
  }

  // ---- 场景存取（一次性，过期即废）----
  function cleanupScenes() {
    const now = Date.now();
    const rows = loadScenes().filter(s => s.exp > now && s.status !== 'done');
    if (rows.length !== loadScenes().length) saveScenes(rows);
    return rows;
  }
  function findScene(scene) {
    return cleanupScenes().find(s => s.scene === scene) || null;
  }
  function updateScene(scene, patch) {
    const rows = loadScenes();
    const s = rows.find(x => x.scene === scene);
    if (s) { Object.assign(s, patch); saveScenes(rows); }
    return s;
  }

  // ---- 绑定短令牌：HMAC 签名 {ox: openid, wn: 微信昵称, jti, exp}，10 分钟有效且一次性（jti 防重放）----
  const CONSUMED_FILE = path.join(WX_DIR, 'consumed-codes.json');
  const consumedJtis = () => loadJSON(CONSUMED_FILE, []);
  function consumeJti(jti) {
    const rows = consumedJtis();
    rows.push({ jti, at: Date.now() });
    saveJSON(CONSUMED_FILE, rows.slice(-500)); // 上限 500 条，重启无安全影响（bindCode 自带 exp）
  }
  function makeBindCode(openid, wxName) {
    const p = Buffer.from(JSON.stringify({ ox: openid, wn: String(wxName || '').slice(0, 30), jti: crypto.randomBytes(8).toString('hex'), exp: Date.now() + BIND_CODE_TTL })).toString('base64url');
    return p + '.' + sign(p);
  }
  function readBindCode(code, { consume = false } = {}) {
    const m = String(code || '').match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    if (sign(m[1]) !== m[2]) return null;
    let d;
    try { d = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return null; }
    if (!d || !d.ox || !d.jti || d.exp < Date.now()) return null;
    if (consumedJtis().some(r => r.jti === d.jti)) return null;
    if (consume) consumeJti(d.jti);
    return d;
  }

  const checkPassword = (u, password) => u && u.passHash && crypto.scryptSync(String(password || ''), u.salt, 32).toString('hex') === u.passHash;
  const findByOpenid = openid => loadUsers().find(x => x.wxOpenid === openid);

  // 绑定 openid 到账号前的占用检查：一个微信只绑一个账号，一个账号只绑一个微信
  function bindable(u, openid) {
    if (!u) return { error: '账号不存在' };
    const owner = findByOpenid(openid);
    if (owner && owner.id !== u.id) return { error: '该微信已绑定过其他账号，请先在那个账号里解绑' };
    if (u.wxOpenid && u.wxOpenid !== openid) return { error: '该账号已绑定其他微信，请先解绑' };
    return {};
  }

  // ================= 路由 =================

  // 前端据此决定是否展示「微信扫码登录」入口
  app.get('/api/auth/wxqr/enabled', (req, res) => res.json({ ok: true, enabled: enabled() }));

  const qrCreateLimit = makeRateLimiter(10, 10 * 60e3, '二维码刷新太频繁啦，请 10 分钟后再试');
  // 生成登录/绑定二维码。mode=bind 需登录（扫码后直接绑到当前账号）
  app.post('/api/auth/wxqr', (req, res, next) => {
    if (req.body && req.body.mode === 'bind') return authUser(req, res, next);
    next();
  }, qrCreateLimit, async (req, res) => {
    if (!enabled()) return notEnabled(res);
    const mode = req.body && req.body.mode === 'bind' ? 'bind' : 'login';
    const scene = (mode === 'bind' ? 'b' : 'l') + crypto.randomBytes(10).toString('hex');
    let qr;
    try { qr = await createQr(scene); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
    const rows = cleanupScenes();
    rows.push({ scene, mode, bindUserId: mode === 'bind' ? req.user.id : null, status: 'pending', openid: null, wxName: '', ticket: qr.ticket, createdAt: new Date().toISOString(), exp: Date.now() + SCENE_TTL });
    saveScenes(rows);
    res.json({ ok: true, scene, qr: qr.url, expireSeconds: SCENE_TTL / 1000 });
  });

  const pollLimit = makeRateLimiter(120, 60e3, '');
  // 轮询场景状态：pending → followed（待绑定）→ bound（已发 token / 已绑定）
  app.get('/api/auth/wxqr/:scene', pollLimit, async (req, res) => {
    if (!enabled()) return notEnabled(res);
    let s = findScene(req.params.scene);
    if (!s) return res.json({ ok: true, status: 'expired' });
    if (s.status !== 'followed') return res.json({ ok: true, status: 'pending' });
    // 已关注：补昵称（best effort 已在回调时尽力拉取，这里再兜底一次）
    if (!s.wxName) { const n = await fetchWxName(s.openid); if (n) s = updateScene(s.scene, { wxName: n }) || s; }

    if (s.mode === 'bind') {
      const users = loadUsers();
      const u = users.find(x => x.id === s.bindUserId);
      if (!u) return res.json({ ok: true, status: 'expired' });
      const chk = bindable(u, s.openid);
      if (chk.error) { updateScene(s.scene, { status: 'done' }); return res.json({ ok: true, status: 'error', error: chk.error }); }
      u.wxOpenid = s.openid;
      u.wxName = s.wxName || u.wxName || '';
      u.wxBoundAt = new Date().toISOString();
      saveUsers(users);
      updateScene(s.scene, { status: 'done' });
      logLine(`wx-bind user=${u.email} openid=${s.openid.slice(0, 10)} via=scan`);
      return res.json({ ok: true, status: 'bound', user: publicUser(u) });
    }

    // login 模式：openid 已绑定 → 直接登录；未绑定 → 发绑定短令牌
    const u = findByOpenid(s.openid);
    if (u) {
      updateScene(s.scene, { status: 'done' });
      logLine(`wx-login user=${u.email} openid=${s.openid.slice(0, 10)}`);
      return res.json({ ok: true, status: 'bound', token: makeToken(u.id, u.pwdVer || 0), user: publicUser(u) });
    }
    return res.json({ ok: true, status: 'followed', bindCode: makeBindCode(s.openid, s.wxName), wxName: s.wxName || '' });
  });

  const bindLimit = makeRateLimiter(20, 10 * 60e3, '尝试太频繁啦，请 10 分钟后再试');
  // 关注后绑定已有邮箱账号（输一次邮箱密码 → 绑定 + 登录）
  app.post('/api/auth/wx-bind', bindLimit, async (req, res) => {
    if (!enabled()) return notEnabled(res);
    const bc = readBindCode((req.body || {}).bindCode);
    if (!bc) return res.status(400).json({ ok: false, error: '二维码已过期，请重新扫码' });
    const openid = bc.ox;
    const wxName = String((req.body || {}).wxName || '').trim().slice(0, 30) || bc.wn || '';
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    const users = loadUsers();
    const u = users.find(x => x.email === email);
    if (!checkPassword(u, password)) {
      logLine(`wx-bind-fail email=${email} reason=${u ? 'bad-password' : 'no-account'}`);
      return res.status(401).json({ ok: false, error: !u ? '无当前账号，请先注册' : '邮箱或密码不对，再检查一下' });
    }
    if (!isVerified(u)) {
      const r = await sendRegisterCode(email);
      return res.status(403).json({ ok: false, code: 'unverified', error: r === true ? '这个邮箱还没验证哦，新验证码已重新发到邮箱（记得看看垃圾邮件）' : '这个邮箱还没验证哦，请先验证后再绑定' });
    }
    const chk = bindable(u, openid);
    if (chk.error) return res.status(409).json({ ok: false, error: chk.error });
    consumeJti(bc.jti); // 绑定成功才作废，输错密码不消耗
    u.wxOpenid = openid;
    u.wxName = wxName || u.wxName || '';
    u.wxBoundAt = new Date().toISOString();
    saveUsers(users);
    logLine(`wx-bind user=${email} openid=${openid.slice(0, 10)} via=email`);
    res.json({ ok: true, token: makeToken(u.id, u.pwdVer || 0), user: publicUser(u) });
  });

  const wxRegLimit = makeRateLimiter(10, 10 * 60e3, '尝试太频繁啦，请 10 分钟后再试');
  // 关注后一键创建新账号（占位邮箱，之后可在账号中心补绑真实邮箱）
  app.post('/api/auth/wx-register', wxRegLimit, (req, res) => {
    if (!enabled()) return notEnabled(res);
    const bc = readBindCode((req.body || {}).bindCode);
    if (!bc) return res.status(400).json({ ok: false, error: '二维码已过期，请重新扫码' });
    const openid = bc.ox;
    const owner = findByOpenid(openid);
    if (owner) return res.json({ ok: true, token: makeToken(owner.id, owner.pwdVer || 0), user: publicUser(owner) });
    const b = req.body || {};
    if (b.termsAccepted !== true || b.privacyAccepted !== true) return res.status(400).json({ ok: false, error: '请先阅读并同意用户协议和隐私政策' });
    if (b.termsVersion !== LEGAL_VERSION || b.privacyVersion !== LEGAL_VERSION) return res.status(409).json({ ok: false, error: '协议已更新，请刷新页面后重新阅读并同意' });
    const name = (String(b.name || '').trim() || '微信用户').slice(0, 30);
    const email = `wx_${openid.slice(0, 12)}@wx.onefig.cn`; // 占位邮箱，openid 段保证唯一
    const salt = crypto.randomBytes(16).toString('hex');
    // 微信创建账号无密码：passHash 置空，登录只能靠微信扫码（补绑邮箱后可用邮箱验证码重设密码）
    const u = {
      id: crypto.randomUUID(), name, email, contact: email, salt, passHash: '',
      level: 'none', joinedAt: new Date().toISOString(), memberSince: null, notes: '', verified: false,
      source: '微信扫码', sourceHost: '',
      termsAcceptedAt: new Date().toISOString(), privacyAcceptedAt: new Date().toISOString(),
      termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION,
      wxOpenid: openid, wxName: String(b.wxName || '').trim().slice(0, 30) || bc.wn || '', wxBoundAt: new Date().toISOString(),
    };
    const users = loadUsers();
    users.push(u);
    saveUsers(users);
    consumeJti(bc.jti);
    logLine(`wx-register name=${name} openid=${openid.slice(0, 10)}`);
    res.json({ ok: true, token: makeToken(u.id, u.pwdVer || 0), user: publicUser(u) });
  });

  // 账号中心：查询微信绑定状态
  app.get('/api/auth/wx-status', authUser, (req, res) => {
    const u = req.user;
    res.json({
      ok: true,
      bound: !!u.wxOpenid,
      wxName: u.wxName || '',
      wxBoundAt: u.wxBoundAt || null,
      isWxCreated: /@wx\.onefig\.cn$/.test(u.email || ''),
    });
  });

  // 账号中心：解绑微信（需密码确认；微信创建的无密码账号不允许解绑——必须先补绑邮箱）
  app.post('/api/auth/wx-unbind', authUser, bindLimit, (req, res) => {
    const u = req.user;
    if (!u.wxOpenid) return res.status(400).json({ ok: false, error: '当前账号未绑定微信' });
    if (!u.passHash) return res.status(400).json({ ok: false, error: '该账号仅绑定了微信，请先补绑邮箱并设置密码，避免账号丢失' });
    if (!checkPassword(u, (req.body || {}).password)) return res.status(401).json({ ok: false, error: '密码不对，再检查一下' });
    const users = loadUsers();
    const t = users.find(x => x.id === u.id);
    delete t.wxOpenid; delete t.wxName; delete t.wxBoundAt;
    saveUsers(users);
    logLine(`wx-unbind user=${u.email}`);
    res.json({ ok: true });
  });

  // 微信创建账号补绑真实邮箱：发验证码
  app.post('/api/auth/wx-set-email', authUser, bindLimit, async (req, res) => {
    const u = req.user;
    if (!/@wx\.onefig\.cn$/.test(u.email || '')) return res.status(400).json({ ok: false, error: '当前账号已有邮箱；如需更换请联系客服' });
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^@\s"']+@[^@\s"']+\.[^@\s"']+$/.test(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
    if (loadUsers().some(x => x.email === email)) return res.status(400).json({ ok: false, error: '这个邮箱已经注册过啦' });
    const r = await sendRegisterCode(email);
    if (r === 'limited') return res.status(429).json({ ok: false, error: '验证码 1 小时内最多发 3 封，请稍后再试' });
    if (r !== true) return res.status(500).json({ ok: false, error: '邮件发送失败，请稍后再试' });
    res.json({ ok: true });
  });

  // 微信创建账号补绑真实邮箱：验证码确认
  app.post('/api/auth/wx-set-email/verify', authUser, bindLimit, (req, res) => {
    const u = req.user;
    if (!/@wx\.onefig\.cn$/.test(u.email || '')) return res.status(400).json({ ok: false, error: '当前账号已有邮箱；如需更换请联系客服' });
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const code = String((req.body || {}).code || '').trim();
    const REG_FILE = path.join(DATA_DIR, 'console', 'registercodes.json');
    const codes = loadJSON(REG_FILE, []);
    const rec = codes.find(r => r.email === email);
    if (!rec || rec.exp < Date.now()) return res.status(400).json({ ok: false, error: '验证码已过期，请重新发送' });
    if ((rec.attempts || 0) >= 5) return res.status(400).json({ ok: false, error: '验证码错误次数太多，请重新发送' });
    if (crypto.scryptSync(code, rec.salt, 32).toString('hex') !== rec.codeHash) {
      rec.attempts = (rec.attempts || 0) + 1;
      saveJSON(REG_FILE, codes);
      return res.status(400).json({ ok: false, error: '验证码不对，再检查一下' });
    }
    if (loadUsers().some(x => x.email === email && x.id !== u.id)) return res.status(400).json({ ok: false, error: '这个邮箱刚刚被其他账号绑定了，换一个吧' });
    const users = loadUsers();
    const t = users.find(x => x.id === u.id);
    t.email = email;
    t.contact = email;
    t.verified = true;
    saveUsers(users);
    saveJSON(REG_FILE, codes.filter(r => r.email !== email));
    logLine(`wx-set-email user=${u.id} email=${email}`);
    res.json({ ok: true, user: publicUser(t) });
  });

  // ---- 服务号服务器配置回调（GET 验证 / POST 事件推送）----
  app.get('/api/wx/callback', (req, res) => {
    if (!enabled()) return res.status(404).end();
    if (!checkSignature(req.query)) return res.status(403).end();
    res.send(String(req.query.echostr || ''));
  });

  // req.body 为 Buffer（server.js 已对该路径挂 express.raw）
  app.post('/api/wx/callback', (req, res) => {
    if (!enabled()) return res.status(404).end();
    if (!checkSignature(req.query)) { logLine('wx-callback 验签失败'); return res.status(403).end(); }
    const xml = (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '')).slice(0, 64 * 1024);
    const ev = parseEventXml(xml);
    res.send('success'); // 先应答，昵称拉取异步补齐
    if (ev.msgType !== 'event') return;
    // 关注：EventKey=qrscene_<scene>；已关注扫码：EventKey=<scene>
    let scene = ev.eventKey || '';
    if (ev.event === 'subscribe') scene = scene.replace(/^qrscene_/, '');
    if ((ev.event === 'subscribe' || ev.event === 'SCAN') && scene) {
      const s = findScene(scene);
      if (s && s.status === 'pending') {
        updateScene(scene, { status: 'followed', openid: ev.from });
        logLine(`wx-scan scene=${scene.slice(0, 6)} openid=${ev.from.slice(0, 10)}`);
        fetchWxName(ev.from).then(n => { if (n) updateScene(scene, { wxName: n }); }).catch(() => {});
      }
    }
  });
};
