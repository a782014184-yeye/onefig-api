const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'submissions.json');
const ADMIN_PATH = process.env.ADMIN_PATH || 'admin';
const ADMIN_USER = process.env.ADMIN_USER || 'onefig';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change-me';
const MAX_UPLOAD_MB = 10;
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || '';
// 2026-10-15：qwen-image-edit(-plus|-max) 全系列被百炼下架（报 Model not exist），改用 qwen-image-2.0（0.2元/张，与原 plus 同价；以后换模型只改环境变量 QWEN_EDIT_MODEL）
const QWEN_EDIT_MODEL = process.env.QWEN_EDIT_MODEL || 'qwen-image-2.0';

// ---- AIGC 隐式标识（GB 45438-2025）与授权码 ----
const PRODUCER_CODE = '92330102MAKM5NHF44'; // 统一社会信用代码（生成合成服务提供者编码）
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 向 PNG 注入 AIGC 元数据隐式标识（tEXt chunk，插在 IHDR 之后，不重编码像素）
function injectAigcMeta(buf, code, licensee) {
  try {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return buf;
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return buf;
    const texts = [[Buffer.from('AIGC\0', 'latin1'), Buffer.from(JSON.stringify({ AIGC: { Label: '1', ContentProducer: PRODUCER_CODE, ProduceID: code, ReservedCode1: '', ContentPropagator: PRODUCER_CODE, PropagateID: code, ReservedCode2: '' } }), 'latin1')]];
    // 授权归属：把下载账号名写入元数据，文件流出后可追溯（2026-10-16）
    if (licensee) texts.push([Buffer.from('Licensee\0', 'latin1'), Buffer.from(String(licensee), 'latin1')]);
    const insertAt = 8 + 12 + buf.readUInt32BE(8); // 第一个 IHDR chunk 之后
    const chunks = texts.map(([key, val]) => {
      const body = Buffer.concat([key, val]);
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), body])));
      return Buffer.concat([len, Buffer.from('tEXt'), body, crc]);
    });
    return Buffer.concat([buf.subarray(0, insertAt), ...chunks, buf.subarray(insertAt)]);
  } catch { return buf; }
}
// 生成唯一授权码：OF-年份-6位（不含易混淆字符）
function genLicenseCode(logs) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
    code = `OF-${new Date().getFullYear()}-${s}`;
  } while (logs.some(l => l.code === code));
  return code;
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

const ALLOWED_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + (ALLOWED_MIME[file.mimetype] || '.bin')),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) return cb(null, true);
    cb(new Error('只支持 PNG / JPG / WebP / GIF 图片'));
  },
});

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function writeDB(rows) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const app = express();
// nginx 反代（X-Forwarded-Proto: https），信任代理头，req.protocol 才是 https——
// 否则生成的资源链接是 http://，浏览器拦截混合内容且 <a download> 失效（2026-10-15）
app.set('trust proxy', true);
// 画板内容最大 10MB：画板路由单独用大解析器（需在全局 256kb 解析器之前注册，
// body-parser 解析过后会置 req._body，全局解析器自动跳过）
app.use('/api/boards', express.json({ limit: '12mb' }));
app.use('/api/shared', express.json({ limit: '12mb' }));   // 可编辑分享的保存通道同样要走大 payload
// 微信支付回调需要原始报文验签（2026-10-08）：必须在全局 json 解析器之前挂载 raw
app.use('/api/pay/wechat/notify', express.raw({ type: '*/*' }));
// 支付宝回调是表单格式（application/x-www-form-urlencoded）
app.use('/api/pay/alipay/notify', express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '256kb' }));

// CORS: 公开接口（无 cookie 会话）开放 *；后台路由（/console 与 ADMIN_PATH）同源访问，
// 不发放行头，防止恶意网页借用浏览器缓存的 Basic Auth 偷数据/乱操作（2026-09-22 收紧）
app.use((req, res, next) => {
  const isConsole = req.path.startsWith('/console') || req.path.startsWith('/' + ADMIN_PATH);
  if (!isConsole) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- 限流工厂：每 IP 独立计数（2026-09-21 安全加固）----
function makeRateLimiter(max, windowMs, msg) {
  const hits = new Map();
  return function (req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const now = Date.now();
    const rec = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ ok: false, error: msg });
    rec.push(now);
    hits.set(ip, rec);
    next();
  };
}
const submitRateLimit = makeRateLimiter(5, 10 * 60 * 1000, '提交太频繁啦，请 10 分钟后再试');
const authRateLimit = makeRateLimiter(20, 10 * 60 * 1000, '尝试太频繁啦，请 10 分钟后再试');
const trackRateLimit = makeRateLimiter(60, 10 * 60 * 1000, '请求太频繁，请稍后再试');

// ---- 图片魔数校验：不信任客户端声明的 mimetype，防伪装文件上传（2026-09-21 安全加固）----
function sniffImage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
    return null;
  } catch { return null; }
}
// 上传后校验真实格式；无效则删除临时文件并拒绝。返回真实扩展名或 null
function verifyUploadedImage(req, res) {
  if (!req.file) return true; // 允许无文件的请求（由业务逻辑自行判断）
  const realExt = sniffImage(req.file.path);
  if (!realExt) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ ok: false, error: '文件内容不是有效的 PNG / JPG / WebP / GIF 图片' });
    return null;
  }
  return realExt;
}

// ---- 访问日志 / 错误日志（2026-09-21）：按天滚动，存 data/logs/，30 天前由 backup.sh 清理 ----
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
function logLine(type, line) {
  const f = path.join(LOG_DIR, `${type}-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFile(f, new Date().toISOString() + ' ' + line + '\n', () => {});
}
process.on('uncaughtException', e => logLine('error', 'uncaughtException ' + (e && e.stack || e)));
process.on('unhandledRejection', e => logLine('error', 'unhandledRejection ' + (e && e.stack || e)));
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    logLine('access', `${ip} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

// ---- 会员体系：注册 / 登录 / 订单 ----
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const CONSOLE_DIR = path.join(DATA_DIR, 'console');
const USERS_FILE = path.join(CONSOLE_DIR, 'users.json');
const ORDERS_FILE = path.join(CONSOLE_DIR, 'orders.json');
const PURCHASES_FILE = path.join(CONSOLE_DIR, 'purchases.json');
const PLANS = { basic: { name: '青果会员', price: 29.9 }, pro: { name: '红果会员', price: 99.9 }, team: { name: '金果会员', price: 299.9 } };
// 收款信息（微信支付），后台可改
const PAY_FILE = path.join(CONSOLE_DIR, 'payinfo.json');

function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function saveJSON(f, rows) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); }
const loadUsers = () => loadJSON(USERS_FILE, []);
const saveUsers = u => saveJSON(USERS_FILE, u);
const loadOrders = () => loadJSON(ORDERS_FILE, []);
const saveOrders = o => saveJSON(ORDERS_FILE, o);

function sign(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
}
function makeToken(userId, pv) {
  const p = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + 30 * 864e5, pv: pv || 0 })).toString('base64url');
  return p + '.' + sign(p);
}
// 在线人数：内存记录每个用户最近一次通过鉴权的时间，5 分钟内有活动即算在线（重启清零，无需持久化）
const ONLINE_SINCE = new Map();
function getOnlineCount() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [uid, t] of ONLINE_SINCE) if (t < cutoff) ONLINE_SINCE.delete(uid);
  return ONLINE_SINCE.size;
}
function authUser(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ ok: false, error: '请先登录' });
  const [p, s] = m[1].split('.');
  if (!p || sign(p) !== s) return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' }); }
  if (d.exp < Date.now()) return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
  const u = loadUsers().find(x => x.id === d.uid);
  if (!u) return res.status(401).json({ ok: false, error: '账号不存在' });
  if ((d.pv || 0) !== (u.pwdVer || 0)) return res.status(401).json({ ok: false, error: '密码已修改，请重新登录' });
  req.user = u;
  ONLINE_SINCE.set(u.id, Date.now());
  next();
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email || '', level: u.level || 'none', joinedAt: u.joinedAt, memberSince: u.memberSince || null, dlUsed: u.dlUsed || 0, dlMonth: u.dlMonth || '' };
}
// 可选认证：带合法登录 token 则识别身份，不带/失效不拦截（供公开验真区分作者本人/登录用户/游客，2026-10-16）
function optionalAuth(req, res, next) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (m) {
      const [p, s] = m[1].split('.');
      let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { d = null; }
      if (d && sign(p) === s && d.exp >= Date.now()) {
        const u = loadUsers().find(x => x.id === d.uid);
        if (u && (d.pv || 0) === (u.pwdVer || 0)) req.user = u;
      }
    }
  } catch {}
  next();
}
// 账号脱敏：邮箱显示首字符+***@域名，其他显示首字符+***
function maskAccount(raw) {
  if (!raw) return null;
  const at = raw.indexOf('@');
  return at > 0 ? raw.slice(0, 1) + '***@' + raw.slice(at + 1) : raw.slice(0, 1) + '***';
}
// 可选鉴权：带有效 token 返回用户，否则返回 null（不报错）
function optionalUser(req) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m) return null;
    const [p, s] = m[1].split('.');
    if (!p || sign(p) !== s) return null;
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp < Date.now()) return null;
    const u = loadUsers().find(x => x.id === d.uid);
    if (!u || (d.pv || 0) !== (u.pwdVer || 0)) return null;
    return u;
  } catch { return null; }
}

// 公开：素材列表（供前台网站动态读取）
app.get('/api/materials', (req, res) => {
  try {
    const data = loadJSON(path.join(CONSOLE_DIR, 'materials.json'), []);
    res.json({ ok: true, series: data, total: data.reduce((s, x) => s + x.materials.length, 0) });
  } catch { res.json({ ok: true, series: [], total: 0 }); }
});

app.post('/api/auth/register', authRateLimit, (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const name = String((req.body || {}).name || '').trim().slice(0, 30);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  // 生产环境闸：拦截 @test.com 注册，防止 e2e 联调误指生产时污染用户表（2026-10-16 事故防护）。
  // 隔离测试实例（8090 等）不设 ONEFIG_ENV，不受影响。
  if (process.env.ONEFIG_ENV === 'production' && /@test\.com$/i.test(email)) {
    logLine('auth', `blocked test-email register ip=${req.ip} email=${email}`);
    return res.status(400).json({ ok: false, error: '该邮箱不允许注册' });
  }
  if (password.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  if (!name) return res.status(400).json({ ok: false, error: '给自己起个昵称吧' });
  const users = loadUsers();
  if (users.some(u => u.email === email)) return res.status(400).json({ ok: false, error: '这个邮箱已经注册过啦，直接登录吧' });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomUUID(), name, email, contact: email, salt, passHash: crypto.scryptSync(password, salt, 32).toString('hex'), level: 'none', joinedAt: new Date().toISOString(), memberSince: null, notes: '' };
  users.push(u);
  saveUsers(users);
  res.json({ ok: true, token: makeToken(u.id, u.pwdVer || 0), user: publicUser(u) });
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  const u = loadUsers().find(x => x.email === email);
  if (!u || !u.passHash || crypto.scryptSync(password, u.salt, 32).toString('hex') !== u.passHash) {
    logLine('auth', `user-login-fail email=${email} ip=${req.ip}`);
    return res.status(401).json({ ok: false, error: '邮箱或密码不对，再检查一下' });
  }
  res.json({ ok: true, token: makeToken(u.id, u.pwdVer || 0), user: publicUser(u) });
});

// ---- 找回密码：邮箱验证码（2026-09-22）----
// 发信配置存 data/console/mail.json（{"user":"...","pass":"授权码","host":"smtp.163.com","port":465}），未来可换 DirectMail
const nodemailer = require('nodemailer');
const MAIL_FILE = path.join(CONSOLE_DIR, 'mail.json');
function getMailer() {
  try {
    const c = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'));
    if (!c.user || !c.pass) return null;
    return { mailer: nodemailer.createTransport({ host: c.host || 'smtp.163.com', port: c.port || 465, secure: true, auth: { user: c.user, pass: c.pass } }), user: c.user };
  } catch { return null; }
}
const RESET_FILE = path.join(CONSOLE_DIR, 'resetcodes.json');
const loadResets = () => loadJSON(RESET_FILE, []);
const saveResets = r => saveJSON(RESET_FILE, r);
const forgotRateLimit = makeRateLimiter(10, 60 * 60 * 1000, '请求太频繁啦，请 1 小时后再试');

// 第一步：发验证码（每邮箱每小时最多 3 封，验证码 10 分钟有效，哈希存储）
app.post('/api/auth/forgot', forgotRateLimit, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  const u = loadUsers().find(x => x.email === email);
  if (!u) return res.status(400).json({ ok: false, error: '这个邮箱还没注册过哦' });
  const now = Date.now();
  let resets = loadResets();
  if (resets.filter(r => r.email === email && now - r.sentAt < 3600e3).length >= 3)
    return res.status(429).json({ ok: false, error: '验证码发得太勤啦，1 小时后再试' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  resets = resets.filter(r => r.email !== email && now - r.sentAt < 24 * 3600e3);
  resets.push({ email, salt, codeHash: crypto.scryptSync(code, salt, 32).toString('hex'), exp: now + 600e3, attempts: 0, sentAt: now });
  saveResets(resets);
  const m = getMailer();
  if (!m) return res.status(500).json({ ok: false, error: '邮件服务未配置，请联系客服' });
  try {
    await m.mailer.sendMail({
      from: 'OneFig 无花有果 <' + m.user + '>',
      to: email,
      subject: '【OneFig 无花有果】重置密码验证码',
      text: '你正在重置 OneFig 无花有果账号的密码。\n\n验证码：' + code + '\n\n10 分钟内有效。如果这不是你本人的操作，请忽略本邮件，你的密码不会改变。',
    });
    logLine('auth', 'reset-code-sent email=' + email + ' ip=' + req.ip);
    res.json({ ok: true });
  } catch (e) {
    logLine('error', 'reset-code-send-fail email=' + email + ' ' + e.message);
    res.status(502).json({ ok: false, error: '邮件发送失败，请稍后再试' });
  }
});

// 第二步：验证码 + 新密码（错 5 次验证码作废，成功后旧登录状态全部失效）
app.post('/api/auth/reset', authRateLimit, (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();
  const password = String((req.body || {}).password || '');
  if (password.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  const resets = loadResets();
  const idx = resets.findIndex(r => r.email === email);
  if (idx < 0) return res.status(400).json({ ok: false, error: '请先获取验证码' });
  const r = resets[idx];
  if (r.exp < Date.now()) { resets.splice(idx, 1); saveResets(resets); return res.status(400).json({ ok: false, error: '验证码已过期，请重新获取' }); }
  if (r.attempts >= 5) { resets.splice(idx, 1); saveResets(resets); return res.status(429).json({ ok: false, error: '错误次数太多，验证码已作废，请重新获取' }); }
  if (crypto.scryptSync(code, r.salt, 32).toString('hex') !== r.codeHash) {
    r.attempts++;
    saveResets(resets);
    logLine('auth', 'reset-code-wrong email=' + email + ' ip=' + req.ip);
    return res.status(400).json({ ok: false, error: '验证码不对，再检查一下' });
  }
  const users = loadUsers();
  const u = users.find(x => x.email === email);
  if (!u) return res.status(400).json({ ok: false, error: '这个邮箱还没注册过哦' });
  const salt2 = crypto.randomBytes(16).toString('hex');
  u.salt = salt2;
  u.passHash = crypto.scryptSync(password, salt2, 32).toString('hex');
  u.pwdVer = (u.pwdVer || 0) + 1;
  saveUsers(users);
  resets.splice(idx, 1);
  saveResets(resets);
  logLine('auth', 'password-reset-ok email=' + email + ' ip=' + req.ip);
  res.json({ ok: true, token: makeToken(u.id, u.pwdVer), user: publicUser(u) });
});

app.get('/api/me', authUser, (req, res) => {
  const orders = loadOrders().filter(o => o.userId === req.user.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // 积分充值订单一并返回，账号中心「积分订单」区展示（2026-10-17）
  let creditOrders = [];
  try {
    creditOrders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ai', 'credit-orders.json'), 'utf8'))
      .filter(o => o.userId === req.user.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {}
  res.json({
    ok: true,
    user: publicUser(req.user),
    orders,
    creditOrders,
    // 单张购买过的素材 ID（永久可重下；前端据此把“¥6.9 下载”显示为“已购买”）
    purchases: loadJSON(PURCHASES_FILE, []).filter(p => p.userId === req.user.id).map(p => p.materialId),
  });
});

app.get('/api/payinfo', (req, res) => {
  const p = loadJSON(PAY_FILE, { wechat: '', alipay: '', note: '转账时备注你的注册邮箱，方便确认' });
  res.json({ ok: true, ...p });
});

// 下单（需登录），生成待支付订单
app.post('/api/orders', authUser, (req, res) => {
  const plan = String((req.body || {}).plan || '');
  if (!PLANS[plan]) return res.status(400).json({ ok: false, error: '无效的会员类型' });
  const orders = loadOrders();
  const pending = orders.find(o => o.userId === req.user.id && o.status === 'pending' && o.plan === plan);
  if (pending) return res.json({ ok: true, order: pending, existed: true });
  const order = { id: crypto.randomUUID(), userId: req.user.id, userName: req.user.name, plan, amount: PLANS[plan].price, status: 'pending', channel: '在线下单', createdAt: new Date().toISOString(), paidAt: null };
  orders.push(order);
  saveOrders(orders);
  res.json({ ok: true, order });
});

app.post('/api/orders/:id/notify-paid', authUser, (req, res) => {
  const orders = loadOrders();
  const o = orders.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!o) return res.status(404).json({ ok: false });
  if (o.status === 'pending') o.status = 'notified';
  saveOrders(orders);
  res.json({ ok: true, order: o });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/submissions', submitRateLimit, (req, res) => {
  // 参考图最多 3 张（2026-09-22）：新字段 images（数组），兼容旧字段 image（单张）
  upload.fields([{ name: 'images', maxCount: 3 }, { name: 'image', maxCount: 1 }])(req, res, (err) => {
    const files = (req.files ? [...(req.files.images || []), ...(req.files.image || [])] : []).slice(0, 3);
    const cleanup = () => files.forEach(f => fs.unlink(f.path, () => {}));
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `图片不能超过 ${MAX_UPLOAD_MB}MB` : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') ? '最多上传 3 张参考图' : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    try {
      // 逐张校验真实图片格式（防伪造扩展名）
      for (const f of files) {
        if (!sniffImage(f.path)) {
          cleanup();
          return res.status(400).json({ ok: false, error: '文件内容不是有效的 PNG / JPG / WebP / GIF 图片' });
        }
      }
      const desc = (req.body.desc || '').toString().trim();
      const contact = (req.body.contact || '').toString().trim().slice(0, 200);
      const series = (req.body.series || '').toString().trim().slice(0, 100);
      if (!desc && !files.length) {
        return res.status(400).json({ ok: false, error: '请至少填写文字描述或上传一张参考图' });
      }
      if (desc.length > 2000) { cleanup(); return res.status(400).json({ ok: false, error: '描述太长了（最多 2000 字）' }); }
      const rows = readDB();
      const u = optionalUser(req);
      if (!u) { cleanup(); return res.status(401).json({ ok: false, error: '请先登录后再提交需求' }); }
      // 求素材配额（2026-10-20 权益分级）：普通/青果/红果每月 5 个（自然月），金果不限量
      const reqMonth = new Date().toISOString().slice(0, 7);
      const usedReq = rows.filter(r => r.userId === u.id && String(r.createdAt || '').startsWith(reqMonth)).length;
      if ((u.level || 'none') !== 'team' && usedReq >= 5) {
        cleanup();
        return res.json({ ok: false, error: '本月求素材名额已用完（每月 5 个，自然月重置），金果会员不限量' });
      }
      const row = {
        id: crypto.randomUUID(),
        desc, contact, series,
        userId: u.id,
        type: (req.body.type === 'custom') ? 'custom' : 'request',
        image: files[0] ? path.basename(files[0].path) : null,
        images: files.map(f => path.basename(f.path)),
        createdAt: new Date().toISOString(),
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
        status: 'new',
      };
      rows.unshift(row);
      writeDB(rows);
      res.json({ ok: true, id: row.id });
    } catch (e) {
      cleanup();
      res.status(500).json({ ok: false, error: '服务器开小差了，请稍后再试' });
    }
  });
});

// ---- 管理后台 ----
function basicAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Basic (.+)$/);
  if (m) {
    const [u, p] = Buffer.from(m[1], 'base64').toString().split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  logLine('auth', `admin-login-fail ip=${req.ip} url=${req.originalUrl}`);
  res.setHeader('WWW-Authenticate', 'Basic realm="OneFig Admin"');
  res.status(401).send('需要登录');
}

// ---- 后台登录：账号密码换 Bearer token（12 小时有效），替代浏览器 Basic 弹窗（2026-09-22）----
// token 也可放 ?t= 查询参数：后台页面里 <img src="/uploads/..."> 无法带请求头
function makeConsoleToken() {
  const p = Buffer.from(JSON.stringify({ adm: 1, exp: Date.now() + 12 * 36e5 })).toString('base64url');
  return p + '.' + sign(p);
}
function checkConsoleToken(t) {
  const [p, s] = String(t || '').split('.');
  if (!p || sign(p) !== s) return false;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.adm === 1 && d.exp > Date.now();
  } catch { return false; }
}
function consoleAuth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if ((m && checkConsoleToken(m[1])) || checkConsoleToken(req.query.t)) return next();
  logLine('auth', `admin-auth-fail ip=${req.ip} url=${req.originalUrl}`);
  res.status(401).json({ ok: false, error: '请先登录后台' });
}
const consoleLoginLimit = makeRateLimiter(10, 10 * 60 * 1000, '尝试太频繁，请 10 分钟后再试');
app.post('/console/api/login', consoleLoginLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    logLine('auth', `admin-login-ok ip=${req.ip}`);
    return res.json({ ok: true, token: makeConsoleToken(), name: ADMIN_USER });
  }
  logLine('auth', `admin-login-fail ip=${req.ip}`);
  res.status(401).json({ ok: false, error: '账号或密码不对，再检查一下' });
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 公开下载计数接口（网站前端将来调用，用于热门排行）
app.post('/api/track-download', trackRateLimit, (req, res) => {
  try {
    const id = String((req.body || {}).id || '');
    const f = path.join(DATA_DIR, 'console', 'materials.json');
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let hit = false;
    for (const s of data) for (const m of s.materials) if (m.id === id) { m.downloads = (m.downloads || 0) + 1; hit = true; }
    if (hit) fs.writeFileSync(f, JSON.stringify(data, null, 1));
    res.json({ ok: hit });
  } catch { res.json({ ok: false }); }
});

// 会员下载原图：校验登录 + 会员/额度，记流水，返回文件（优先服务器原图，否则跳转 OSS 预览图）
const ORIG_DIR = path.join(DATA_DIR, 'originals');
const DOWNLOADS_FILE = path.join(CONSOLE_DIR, 'downloads.json');
// 会员干净预览（2026-10-19）：付费会员/已购单张的用户在画板中加载无水印预览图
// 图片标签不能带请求头，故接受 ?tk= 查询令牌（与 Bearer 同一校验；access log 会留查询串，已知晓）
function validateToken(tk) {
  if (!tk) return null;
  const [p, s] = String(tk).split('.');
  if (!p || sign(p) !== s) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (d.exp < Date.now()) return null;
  const u = loadUsers().find(x => x.id === d.uid);
  if (!u || (d.pv || 0) !== (u.pwdVer || 0)) return null;
  return u;
}
app.get('/api/clean-preview/:series/:title', (req, res) => {
  try {
    const tk = (req.headers.authorization || '').replace(/^Bearer /, '') || String(req.query.tk || '');
    const u = validateToken(tk);
    if (!u) return res.status(401).json({ ok: false, error: '请先登录' });
    const series = String(req.params.series || '');
    // 客户端带 .webp 后缀调用，服务端统一剥掉再拼（11-19 实测：双后缀导致 404）
    const title = String(req.params.title || '').replace(/\.webp$/i, '');
    if (!series || !title || series.includes('..') || title.includes('..') || series.includes('/') || title.includes('/')) {
      return res.status(400).json({ ok: false, error: '参数无效' });
    }
    // 2026-10-19 定稿：任何登录用户都可在画板使用干净预览（元素不再带水印）；
    // 导出硬墙与 300dpi 原图付费墙不变——防的是结果物而非作图过程
    const file = path.join(DATA_DIR, 'clean-previews', series, title + '.webp');
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '素材不存在' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, error: '读取失败' });
  }
});

const BASIC_MONTHLY_LIMIT = 5;
// 画板导出额度（2026-10-19 定价改版）：青果 5 次/月、红果 10 次/月、金果不限；
// 普通账户无月度额度，靠单次购买（exportCredits，¥6.9/次，用一次扣一次）
const EXPORT_MONTHLY = { basic: 5, pro: 10 };

// 导出预检（2026-10-20 修复"打开弹窗就扣额度"）：只查不扣，实际扣减在 /api/export/commit（确认下载时）
app.post('/api/export/permit', authUser, (req, res) => {
  try {
    const u = req.user;
    const level = u.level || 'none';
    if (level === 'team') return res.json({ ok: true, watermark: false, allowed: true });
    const month = curMonth();
    const used = u.exMonth === month ? (u.exUsed || 0) : 0;
    const limit = EXPORT_MONTHLY[level];
    if (limit !== undefined) {
      if (used >= limit) return res.json({ ok: true, watermark: true, allowed: false, reason: 'quota', limit, used });
      return res.json({ ok: true, watermark: false, allowed: true });
    }
    if ((u.exportCredits || 0) <= 0) return res.json({ ok: true, watermark: true, allowed: false, reason: 'no-plan' });
    res.json({ ok: true, watermark: false, allowed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: '校验失败，请稍后再试' });
  }
});

// 导出核销：确认下载时调用——扣额度/单次权益 + 生成授权码记流水（验真页可查）
// 2026-10-20 权益分级：PDF/SVG 矢量格式与 600dpi 高清为红果/金果专享（客户端已置灰，此为服务端硬墙）
app.post('/api/export/commit', authUser, (req, res) => {
  try {
    const u = req.user;
    const level = u.level || 'none';
    const fmt = String((req.body || {}).fmt || '');
    const dpi = Number((req.body || {}).dpi) || 300;
    if (level !== 'pro' && level !== 'team' && (fmt === 'pdf' || fmt === 'svg' || dpi > 300)) {
      return res.json({ ok: false, reason: 'fmt' });
    }
    const month = curMonth();
    if (u.exMonth !== month) { u.exMonth = month; u.exUsed = 0; }
    if (level !== 'team') {
      const limit = EXPORT_MONTHLY[level];
      if (limit !== undefined) {
        if ((u.exUsed || 0) >= limit) return res.json({ ok: false, reason: 'quota', limit, used: u.exUsed });
        u.exUsed = (u.exUsed || 0) + 1;
      } else {
        if ((u.exportCredits || 0) <= 0) return res.json({ ok: false, reason: 'no-plan' });
        u.exportCredits = (u.exportCredits || 0) - 1;
      }
      const users = loadUsers();
      const ui = users.findIndex(x => x.id === u.id);
      if (ui >= 0) { users[ui] = u; saveUsers(users); }
    }
    const logs = loadJSON(DOWNLOADS_FILE, []);
    const code = genLicenseCode(logs);
    const boardTitle = String((req.body || {}).boardTitle || '').slice(0, 80);
    logs.push({
      userId: u.id, kind: 'export', materialId: '画板导出作品',
      boardId: String((req.body || {}).boardId || ''), boardTitle,
      code, time: new Date().toISOString(), free: false,
    });
    saveJSON(DOWNLOADS_FILE, logs);
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: '核销失败，请稍后再试' });
  }
});

// 导出状态（画板导出按钮的额度显示用）
app.get('/api/export/status', authUser, (req, res) => {
  const u = req.user;
  const level = u.level || 'none';
  const month = curMonth();
  const used = u.exMonth === month ? (u.exUsed || 0) : 0;
  const limit = EXPORT_MONTHLY[level];
  res.json({
    ok: true, level,
    monthly: level === 'team' ? -1 : (limit ?? 0),   // -1 = 不限量
    used,
    credits: u.exportCredits || 0,                   // 普通账户单次购买余额
  });
});

fs.mkdirSync(ORIG_DIR, { recursive: true });
function curMonth() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

app.get('/api/download', authUser, (req, res) => {
  try {
    const id = String(req.query.id || '');
    const u = req.user;
    const level = u.level || 'none';
    // 单张购买权益：永久可重下；普通账户买了某张后也能下这一张
    const purchased = loadJSON(PURCHASES_FILE, []).some(p => p.userId === u.id && p.materialId === id);
    if (level === 'none' && !purchased) return res.status(403).json({ ok: false, error: 'no-plan' });

    // 找素材
    const f = path.join(CONSOLE_DIR, 'materials.json');
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let hit = null;
    for (const s of data) for (const m of s.materials) if (m.id === id) { hit = { s, m }; break; }
    if (!hit) return res.status(404).json({ ok: false, error: '素材不存在' });

    // 记账：历史下载过的素材再次下载免费（不占用额度、不计次数）
    const logs = loadJSON(DOWNLOADS_FILE, []);
    const already = logs.some(l => l.userId === u.id && l.materialId === id);
    // 授权码：同一用户对同一素材固定一个码（重复下载沿用首个码）
    const code = (logs.find(l => l.userId === u.id && l.materialId === id && l.code) || {}).code || genLicenseCode(logs);
    if (!already) {
      // 青果会员：每月 5 张额度（自然月重置，重复下载不占额度）；单张购买过的素材不占额度
      if (level === 'basic' && !purchased) {
        const month = curMonth();
        if (u.dlMonth !== month) { u.dlMonth = month; u.dlUsed = 0; }
        if ((u.dlUsed || 0) >= BASIC_MONTHLY_LIMIT) return res.status(403).json({ ok: false, error: 'quota' });
        u.dlMonth = month;
      }
      u.dlUsed = (u.dlUsed || 0) + 1;
      const users = loadUsers();
      const ui = users.findIndex(x => x.id === u.id);
      if (ui >= 0) { users[ui] = u; saveUsers(users); }
      hit.m.downloads = (hit.m.downloads || 0) + 1;
      fs.writeFileSync(f, JSON.stringify(data, null, 1));
    }
    logs.push({ userId: u.id, materialId: id, code, time: new Date().toISOString(), free: already });
    saveJSON(DOWNLOADS_FILE, logs);

    // 返回文件：优先本地原图目录（注入 AIGC 元数据 + 授权码 + 下载账号隐式标识），否则 302 到 OSS 预览图
    const file = hit.m.file || (hit.m.title + '.png');
    const local = path.join(ORIG_DIR, hit.s.folder, file);
    if (fs.existsSync(local)) {
      const buf = injectAigcMeta(fs.readFileSync(local), code, u.email || u.name);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(hit.m.title + '.png')}`);
      return res.send(buf);
    }
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(hit.m.title + '.webp')}`);
    const webp = file.replace(/\.png$/, '.webp');
    return res.redirect('https://onefig.oss-cn-hangzhou.aliyuncs.com/previews/' + encodeURIComponent(hit.s.folder) + '/' + encodeURIComponent(webp));
  } catch (e) {
    res.status(500).json({ ok: false, error: '下载失败，请稍后再试' });
  }
});

// 我的下载历史（素材去重 + 画板导出记录，按最近时间倒序，便于再次免费下载/查授权码）
app.get('/api/my/downloads', authUser, (req, res) => {
  try {
    const logs = loadJSON(DOWNLOADS_FILE, []).filter(l => l.userId === req.user.id);
    const data = loadJSON(path.join(CONSOLE_DIR, 'materials.json'), []);
    const map = new Map();
    for (const s of data) for (const m of s.materials) map.set(m.id, { s, m });
    const seen = new Map();
    const exports = [];
    for (const l of logs) {
      // 画板导出（2026-10-20）：每次导出对应一份独立作品文件和授权码，逐条展示
      if (l.kind === 'export') {
        exports.push({
          id: 'export:' + (l.code || l.time),
          kind: 'export',
          title: l.boardTitle || '画板导出作品',
          boardId: l.boardId || '',
          time: l.time,
          code: l.code || null,
        });
        continue;
      }
      const hit = map.get(l.materialId);
      if (!hit) continue;
      seen.set(l.materialId, {
        id: l.materialId,
        title: hit.m.title,
        file: hit.m.file || (hit.m.title + '.png'),
        folder: hit.s.folder,
        series: hit.m.series || hit.s.folder,
        time: l.time,
        code: l.code || null, // 授权码（旧记录无码时前端会显示临时码）
      });
    }
    const list = [...seen.values(), ...exports].sort((a, b) => b.time.localeCompare(a.time));
    res.json({ ok: true, list });
  } catch { res.status(500).json({ ok: false, error: '读取失败' }); }
});

// 公开验真：凭授权码查询授权状态（不返回完整用户信息，供期刊编辑等第三方核查）
app.get('/api/verify', optionalAuth, (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ ok: false, error: '缺少授权码' });
    const hit = loadJSON(DOWNLOADS_FILE, []).find(l => l.code === code);
    if (!hit) return res.json({ ok: false, error: '授权码不存在' });
    const data = loadJSON(path.join(CONSOLE_DIR, 'materials.json'), []);
    let mat = null;
    for (const s of data) for (const m of s.materials) if (m.id === hit.materialId) { mat = { title: m.title, series: m.series || s.folder }; break; }
    // 授权归属：仅返回脱敏账号（邮箱形如 o***@163.com），供第三方核对又不泄露完整隐私（2026-10-16）
    let licensee = null;
    try {
      const acc = (loadUsers() || []).find(x => x.id === hit.userId);
      licensee = maskAccount(acc ? (acc.email || acc.name || '') : '');
    } catch {}
    // 查询记录：按查询者身份分组统计（作者本人/登录用户[脱敏]/游客），仅记录成功查询。
    // 转卖的码会被大量"非作者"查询，此处公开次数与构成，供编辑/买家判断（2026-10-16）
    let qTotal = 1;
    const qBy = [];
    try {
      const QLOG = path.join(CONSOLE_DIR, 'verify-log.json');
      const qlog = loadJSON(QLOG, {});
      const now = new Date().toISOString();
      let rec = qlog[code];
      // 旧格式（count/first/last）迁移为游客记录
      if (rec && !rec.entries) rec = { entries: { guest: { count: rec.count || 0, first: rec.first || now, last: rec.last || now } } };
      if (!rec) rec = { entries: {} };
      const whoKey = req.user ? req.user.id : 'guest';
      const e = rec.entries[whoKey] || { count: 0, first: now };
      e.count += 1; e.last = now;
      rec.entries[whoKey] = e;
      qlog[code] = rec;
      saveJSON(QLOG, qlog);
      const users = loadUsers() || [];
      qTotal = Object.values(rec.entries).reduce((s, x) => s + x.count, 0);
      for (const [k, v] of Object.entries(rec.entries)) {
        if (k === hit.userId) qBy.push({ kind: 'author', count: v.count, first: v.first, last: v.last });
        else if (k === 'guest') qBy.push({ kind: 'guest', count: v.count, first: v.first, last: v.last });
        else {
          const qu = users.find(x => x.id === k);
          qBy.push({ kind: 'user', name: maskAccount(qu ? (qu.email || qu.name || '') : ''), count: v.count, first: v.first, last: v.last });
        }
      }
      qBy.sort((a, b) => (a.kind === 'author' ? -1 : b.kind === 'author' ? 1 : b.count - a.count));
    } catch {}
    // 导出授权码记录（2026-10-19）：与素材下载同流水，验真页按 kind 分支展示
    const isExport = hit.kind === 'export';
    res.json({
      ok: true,
      code,
      material: isExport ? ('画板导出作品' + (hit.boardTitle ? '：' + hit.boardTitle : '')) : (mat ? mat.title : hit.materialId),
      series: isExport ? '画板导出' : (mat ? mat.series : ''),
      licensee,
      qTotal, qBy,
      scope: '学术发表（期刊论文、学术会议、学位论文、学术海报、图文摘要），仅限非商业用途',
      time: hit.time,
      status: '有效',
    });
  } catch { res.status(500).json({ ok: false, error: '查询失败' }); }
});

// 后台：凭授权码反查下载记录与用户全部信息（仅管理员）
app.get('/console/api/license-lookup', consoleAuth, (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const hit = loadJSON(DOWNLOADS_FILE, []).find(l => l.code === code);
    if (!hit) return res.json({ ok: false, error: '授权码不存在' });
    const u = loadUsers().find(x => x.id === hit.userId) || null;
    const data = loadJSON(path.join(CONSOLE_DIR, 'materials.json'), []);
    let mat = null;
    for (const s of data) for (const m of s.materials) if (m.id === hit.materialId) { mat = { title: m.title, series: m.series || s.folder, file: m.file }; break; }
    res.json({
      ok: true,
      record: { code: hit.code, materialId: hit.materialId, material: mat, time: hit.time },
      user: u ? { id: u.id, name: u.name, email: u.email, level: u.level, joinedAt: u.joinedAt, memberSince: u.memberSince, dlUsed: u.dlUsed || 0, notes: u.notes || '' } : null,
    });
  } catch { res.status(500).json({ ok: false, error: '查询失败' }); }
});

// 后台：查某用户（按邮箱或用户ID）的全部下载记录与授权码
app.get('/console/api/user-licenses', consoleAuth, (req, res) => {
  try {
    const key = String(req.query.email || req.query.userId || '').trim().toLowerCase();
    if (!key) return res.status(400).json({ ok: false, error: '缺少 email 或 userId' });
    const u = loadUsers().find(x => x.email === key || x.id === key);
    if (!u) return res.json({ ok: false, error: '用户不存在' });
    const logs = loadJSON(DOWNLOADS_FILE, []).filter(l => l.userId === u.id);
    const data = loadJSON(path.join(CONSOLE_DIR, 'materials.json'), []);
    const map = new Map();
    for (const s of data) for (const m of s.materials) map.set(m.id, { title: m.title, series: m.series || s.folder });
    const list = logs.map(l => ({
      code: l.code || null,
      materialId: l.materialId,
      material: map.get(l.materialId)?.title || l.materialId,
      series: map.get(l.materialId)?.series || '',
      time: l.time,
    }));
    res.json({
      ok: true,
      user: { id: u.id, name: u.name, email: u.email, level: u.level, joinedAt: u.joinedAt, memberSince: u.memberSince },
      count: list.length,
      list,
    });
  } catch { res.status(500).json({ ok: false, error: '查询失败' }); }
});

// 我的求素材 / 定制进度
app.get('/api/my/submissions', authUser, (req, res) => {
  try {
    const list = readDB()
      .filter(r => r.userId === req.user.id)
      .map(r => ({ id: r.id, type: r.type || 'request', desc: r.desc, status: r.status || 'new', createdAt: r.createdAt }));
    res.json({ ok: true, list });
  } catch { res.status(500).json({ ok: false, error: '读取失败' }); }
});

// 挂载四页管理控制台
require('./console')(app, { consoleAuth, esc, DATA_DIR, ADMIN_PATH_FULL: '/' + ADMIN_PATH, readSubmissions: readDB, getOnlineCount });

// AI 工坊：积分体系 + 生图流水线
const CREDIT_PACKAGES = require('./ai').CREDIT_PACKAGES;
require('./ai')(app, { consoleAuth, DATA_DIR, authUser, loadUsers, saveUsers, injectAigcMeta, logLine });

// 在线支付：微信 Native 扫码 + 支付宝电脑网站支付（2026-10-08；2026-10-17 起同时支持积分充值）
require('./pay')(app, { authUser, DATA_DIR, PLANS, CREDIT_PACKAGES, loadUsers, saveUsers, logLine });

// SEO 公开页：sitemap.xml + 素材详情页 /m/ + 系列页 /s/（服务端直出）
require('./seo')(app, { esc, DATA_DIR });

app.post('/' + ADMIN_PATH + '/toggle', consoleAuth, (req, res) => {
  const rows = readDB();
  const r = rows.find(x => x.id === req.body.id);
  if (!r) return res.status(404).json({ ok: false });
  r.status = r.status === 'done' ? 'new' : 'done';
  writeDB(rows);
  res.json({ ok: true });
  // 素材上新后给提交者发邮件通知（仅登录用户提交的需求有 userId；游客提交无邮箱可发）
  if (r.status === 'done' && r.userId) {
    const u = loadUsers().find(x => x.id === r.userId);
    const m = getMailer();
    if (u && u.email && m) {
      const desc = String(r.desc || '').replace(/\s+/g, ' ').slice(0, 100);
      m.mailer.sendMail({
        from: 'OneFig 无花有果 <' + m.user + '>',
        to: u.email,
        subject: '【OneFig 无花有果】你求的素材上新啦',
        text: '你好！\n\n你之前提交的素材需求已制作完成并上新到素材库：\n\n「' + desc + (String(r.desc || '').length > 100 ? '…' : '') + '」\n\n前往查看：https://onefig.cn/materials\n\n感谢你的建议，祝科研顺利！\n— OneFig 无花有果团队',
      })
        .then(() => logLine('mail', 'submission-notify-sent id=' + r.id + ' email=' + u.email))
        .catch(e => logLine('error', 'submission-notify-fail id=' + r.id + ' email=' + u.email + ' ' + e.message));
    }
  }
});

app.post('/' + ADMIN_PATH + '/delete', consoleAuth, (req, res) => {
  const rows = readDB();
  const r = rows.find(x => x.id === req.body.id);
  if (r) {
    const imgs = r.images && r.images.length ? r.images : (r.image ? [r.image] : []);
    imgs.forEach(img => fs.unlink(path.join(UPLOAD_DIR, img), () => {}));
  }
  writeDB(rows.filter(x => x.id !== req.body.id));
  res.json({ ok: true });
});

app.use('/uploads', consoleAuth, express.static(UPLOAD_DIR));

// 后台上传的素材图片（公开可读，供网站前台展示）
app.use('/files', express.static(FILES_DIR));

// 后台上传素材图片：multipart（series + title + image），存服务器并登记
// TinyPNG 压缩：key 存在 data/console/tinify.json（{"key":"..."}），未配置或失败时静默跳过
const TINIFY_KEY_FILE = path.join(CONSOLE_DIR, 'tinify.json');
function getTinifyKey() {
  try { return JSON.parse(fs.readFileSync(TINIFY_KEY_FILE, 'utf8')).key || ''; } catch { return ''; }
}
function tinifyRequest(opt, cb) {
  const req = require('https').request({ hostname: 'api.tinify.com', ...opt }, cb);
  req.on('error', () => { /* 网络失败静默 */ });
  return req;
}
function tinifyCompress(filePath) {
  return new Promise((resolve) => {
    const key = getTinifyKey();
    if (!key) return resolve(false);
    const data = fs.readFileSync(filePath);
    const req = tinifyRequest({
      path: '/shrink', method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from('api:' + key).toString('base64'), 'Content-Type': 'application/octet-stream', 'Content-Length': data.length },
    }, (res) => {
      if (res.statusCode !== 201) return resolve(false);
      const loc = res.headers.location;
      res.resume();
      if (!loc) return resolve(false);
      require('https').get(loc, (r2) => {
        if (r2.statusCode !== 200) return resolve(false);
        const tmp = filePath + '.tiny';
        const w = fs.createWriteStream(tmp);
        r2.pipe(w);
        w.on('finish', () => { fs.renameSync(tmp, filePath); resolve(true); });
        w.on('error', () => { fs.unlink(tmp, () => {}); resolve(false); });
      }).on('error', () => resolve(false));
    });
    req.write(data);
    req.end();
  });
}

app.post('/console/api/materials/upload', consoleAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `图片不能超过 ${MAX_UPLOAD_MB}MB` : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    try {
      const series = String(req.body.series || '').trim();
      const title = String(req.body.title || '').trim().replace(/[\\/:*?"<>|]/g, '');
      if (!series || !title) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ ok: false, error: '请填写文件夹和素材名称' });
      }
      if (!req.file) return res.status(400).json({ ok: false, error: '请选择要上传的图片' });
      const realExt = verifyUploadedImage(req, res);
      if (!realExt) return;
      const ext = realExt;
      const dir = path.join(FILES_DIR, series);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, title + ext);
      fs.renameSync(req.file.path, dest);
      // TinyPNG 自动压缩（失败静默跳过，不阻断上传）
      await tinifyCompress(dest);
      const size = fs.statSync(dest).size;
      const f = path.join(DATA_DIR, 'console', 'materials.json');
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      let s = data.find(x => x.folder === series);
      if (!s) { s = { folder: series, materials: [] }; data.push(s); }
      if (s.materials.some(m => m.title === title)) {
        return res.status(400).json({ ok: false, error: '该文件夹下已存在同名素材' });
      }
      s.materials.push({ id: `${series}/${title}`, series, file: title + ext, title, downloads: 0, createdAt: new Date().toISOString().slice(0, 10), local: true, size });
      fs.writeFileSync(f, JSON.stringify(data, null, 1));
      res.json({ ok: true });
    } catch (e) {
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ ok: false, error: '上传失败，请稍后再试' });
    }
  });
});

app.listen(PORT, () => console.log(`OneFig API listening on :${PORT}`));

// ---- 位图转 SVG 矢量（服务器本地 vtracer，免费）----
app.post('/api/vectorize', authUser, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: '请上传图片' });
    if (!verifyUploadedImage(req, res)) return;
    try {
      const buf = fs.readFileSync(req.file.path);
      fs.unlinkSync(req.file.path);
      const fd = new FormData();
      fd.append('image', new Blob([buf], { type: req.file.mimetype }), req.file.originalname || 'image.png');
      const t0 = Date.now();
      const r = await fetch('http://127.0.0.1:9000/vectorize', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('vectorize service ' + r.status);
      const out = Buffer.from(await r.arrayBuffer());
      const outName = 'ai-vec-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.svg';
      fs.writeFileSync(path.join(FILES_DIR, outName), out);
      const baseUrl = req.protocol + '://' + req.get('host');
      logLine('ai-op', `vectorize ok user=${req.user.name} ${Date.now() - t0}ms`);
      res.json({ ok: true, url: baseUrl + '/files/' + encodeURIComponent(outName) });
    } catch (e) {
      logLine('ai-op', `vectorize FAIL user=${req.user.name} ${e && e.message}`);
      res.status(502).json({ ok: false, error: '矢量转换服务开小差了，请稍后重试' });
    }
  });
});

// ---- 移除背景（服务器本地 rembg 抠图，免费）----
app.post('/api/remove-bg', authUser, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: '请上传图片' });
    if (!verifyUploadedImage(req, res)) return;
    try {
      const buf = fs.readFileSync(req.file.path);
      fs.unlinkSync(req.file.path);
      const fd = new FormData();
      fd.append('image', new Blob([buf], { type: req.file.mimetype }), req.file.originalname || 'image.png');
      const t0 = Date.now();
      const r = await fetch('http://127.0.0.1:9000/remove-bg', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('bg service ' + r.status);
      const out = Buffer.from(await r.arrayBuffer());
      const outName = 'ai-nobg-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png';
      fs.writeFileSync(path.join(FILES_DIR, outName), out);
      const baseUrl = req.protocol + '://' + req.get('host');
      logLine('ai-op', `remove-bg ok user=${req.user.name} ${Date.now() - t0}ms`);
      res.json({ ok: true, url: baseUrl + '/files/' + encodeURIComponent(outName) });
    } catch (e) {
      logLine('ai-op', `remove-bg FAIL user=${req.user.name} ${e && e.message}`);
      res.status(502).json({ ok: false, error: '抠图服务开小差了，请稍后重试' });
    }
  });
});

// ---- AI 风格转换（照片/其他图 → 指定插画风）----
const STYLE_PROMPTS = {
  flat: '把这张图重绘成扁平矢量插画风格：色块平涂、柔和渐变、简洁流畅的轮廓线条，类似 Figdraw 科研示意图，保持原有构图和主体不变，纯色干净背景',
  matte: '把这张图重绘成柔和奶油质感插画：水彩般的渐变晕染、哑光柔和色彩、边缘圆润，保持原有构图和主体不变，纯色干净背景',
  threed: '把这张图重绘成 3D 渲染风格：立体光影、柔和材质、类似 Blender 卡通渲染，保持原有构图和主体不变，纯色干净背景',
};
app.post('/api/ai-stylize', authUser, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!DASHSCOPE_KEY) return res.status(500).json({ ok: false, error: '服务器未配置 AI 服务' });
    if (!req.file) return res.status(400).json({ ok: false, error: '请上传图片' });
    if (!verifyUploadedImage(req, res)) return;
    const style = (req.body.style || 'flat').trim();
    const custom = (req.body.prompt || '').trim();
    const t0 = Date.now();
    const prompt = custom || STYLE_PROMPTS[style] || STYLE_PROMPTS.flat;
    const pubName = 'ai-src-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(req.file.filename);
    fs.renameSync(req.file.path, path.join(FILES_DIR, pubName));
    const baseUrl = req.protocol + '://' + req.get('host');
    const imageUrl = baseUrl + '/files/' + encodeURIComponent(pubName);
    try {
      const r = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: QWEN_EDIT_MODEL,
          input: { messages: [{ role: 'user', content: [{ image: imageUrl }, { text: prompt }] }] },
        }),
      });
      const data = await r.json().catch(() => ({}));
      const outUrl = data && data.output && data.output.choices && data.output.choices[0] &&
        data.output.choices[0].message.content.find(c => c.image) &&
        data.output.choices[0].message.content.find(c => c.image).image;
      if (!outUrl) { logLine('ai-op', `stylize FAIL user=${req.user.name} style=${style}${custom ? ' custom="' + custom.slice(0, 30) + '"' : ''} err=${(data && data.message) || 'no-image'} ${Date.now() - t0}ms`); return res.status(502).json({ ok: false, error: (data && data.message) || 'AI 处理失败，请重试' }); }
      const imgRes = await fetch(outUrl);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const outName = 'ai-sty-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png';
      // 注入 AIGC 元数据隐式标识（GB 45438-2025），内容编号即文件名
      fs.writeFileSync(path.join(FILES_DIR, outName), injectAigcMeta(buf, outName.replace(/\.png$/, '')));
      logLine('ai-op', `stylize ok user=${req.user.name} style=${style}${custom ? ' custom="' + custom.slice(0, 30) + '"' : ''} ${Date.now() - t0}ms`);
      res.json({ ok: true, url: baseUrl + '/files/' + encodeURIComponent(outName) });
    } catch (e) {
      logLine('ai-op', `stylize ERROR user=${req.user.name} style=${style} ${e && e.message} ${Date.now() - t0}ms`);
      res.status(502).json({ ok: false, error: 'AI 服务连接失败，请稍后重试' });
    }
  });
});

// ---- AI 图像编辑（百炼 QWEN_EDIT_MODEL，指令改图）----
app.post('/api/ai-edit', authUser, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!DASHSCOPE_KEY) return res.status(500).json({ ok: false, error: '服务器未配置 AI 服务' });
    if (!req.file) return res.status(400).json({ ok: false, error: '请上传图片' });
    if (!verifyUploadedImage(req, res)) return;
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: '请填写修改要求' });
    const t0 = Date.now();
    // 把上传文件移到 /files，使其公网可访问（百炼需要能拉到图）
    const pubName = 'ai-src-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(req.file.filename);
    fs.renameSync(req.file.path, path.join(FILES_DIR, pubName));
    const baseUrl = req.protocol + '://' + req.get('host');
    const imageUrl = baseUrl + '/files/' + encodeURIComponent(pubName);
    try {
      const r = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + DASHSCOPE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: QWEN_EDIT_MODEL,
          input: { messages: [{ role: 'user', content: [{ image: imageUrl }, { text: prompt }] }] },
        }),
      });
      const data = await r.json().catch(() => ({}));
      const outUrl = data && data.output && data.output.choices && data.output.choices[0] &&
        data.output.choices[0].message.content.find(c => c.image) &&
        data.output.choices[0].message.content.find(c => c.image).image;
      if (!outUrl) { logLine('ai-op', `edit FAIL user=${req.user.name} prompt="${prompt.slice(0, 40)}" err=${(data && data.message) || 'no-image'} ${Date.now() - t0}ms`); return res.status(502).json({ ok: false, error: (data && data.message) || 'AI 处理失败，换个描述试试' }); }
      // 结果图转存到服务器，避免 OSS 临时链接过期
      const imgRes = await fetch(outUrl);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const outName = 'ai-out-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png';
      // 注入 AIGC 元数据隐式标识（GB 45438-2025），内容编号即文件名
      fs.writeFileSync(path.join(FILES_DIR, outName), injectAigcMeta(buf, outName.replace(/\.png$/, '')));
      logLine('ai-op', `edit ok user=${req.user.name} prompt="${prompt.slice(0, 40)}" ${Date.now() - t0}ms`);
      res.json({ ok: true, url: baseUrl + '/files/' + encodeURIComponent(outName) });
    } catch (e) {
      logLine('ai-op', `edit ERROR user=${req.user.name} prompt="${prompt.slice(0, 40)}" ${e && e.message} ${Date.now() - t0}ms`);
      res.status(502).json({ ok: false, error: 'AI 服务连接失败，请稍后重试' });
    }
  });
});

// ---- 画板云端同步（2026-10-04）----
// 存储：data/boards/<uid>/index.json（folders + boards 元信息）+ <boardId>.json（画板内容）
// 鉴权：全部走 authUser；数量上限按会员等级在服务端强制（前端校验仅为体验）
const BOARDS_DIR = path.join(DATA_DIR, 'boards');
const BOARD_LIMITS = { none: 3, basic: 3, pro: 10, team: Infinity };
const MAX_BOARD_BYTES = 10 * 1024 * 1024;   // 单画板内容上限 10MB
const MAX_THUMB_CHARS = 200000;             // 缩略图 dataURL 上限（约 150KB jpeg）
const BOARD_ID_RE = /^[a-z0-9]{4,40}$/;     // 前端 newBoardId 格式：时间戳36进制+随机

function boardDir(uid) {
  const d = path.join(BOARDS_DIR, String(uid));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const loadBoardIndex = (uid) => {
  const d = loadJSON(path.join(boardDir(uid), 'index.json'), { folders: [], boards: [] });
  return { folders: Array.isArray(d.folders) ? d.folders : [], boards: Array.isArray(d.boards) ? d.boards : [] };
};
const saveBoardIndex = (uid, idx) => saveJSON(path.join(boardDir(uid), 'index.json'), idx);
const newBoardId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);
const validBoardId = (id) => typeof id === 'string' && BOARD_ID_RE.test(id);
const boardMeta = (b) => ({ id: b.id, name: b.name, folderId: b.folderId, savedAt: b.savedAt, thumb: b.thumb, shareToken: b.shareToken, shareMode: b.shareToken ? (b.shareMode || 'view') : undefined });

// ---- 画板分享（2026-10-05）----
// shares.json：token → { uid, boardId } 反查表；token 同时存在画板 meta.shareToken
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const loadShares = () => loadJSON(SHARES_FILE, {});
const saveShares = (s) => saveJSON(SHARES_FILE, s);
const newShareToken = () => crypto.randomBytes(12).toString('base64url');   // 16 位不可猜测
const shareRateLimit = makeRateLimiter(2400, 10 * 60 * 1000, '请求太频繁，请稍后再试');   // 协同编辑期间 state+批注双 1s 轮询（120 次/分）+ 内容拉取，放宽到 2400 次/10 分钟
const removeShare = (token) => {
  if (!token) return;
  const shares = loadShares();
  if (shares[token]) { delete shares[token]; saveShares(shares); }
};

// 列表（元信息，不含内容）
app.get('/api/boards', authUser, (req, res) => {
  const idx = loadBoardIndex(req.user.id);
  res.json({ ok: true, folders: idx.folders, boards: idx.boards.map(boardMeta).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)), limit: BOARD_LIMITS[req.user.level] ?? 3 });
});

// 新建画板：服务端强制数量上限
app.post('/api/boards', authUser, (req, res) => {
  const idx = loadBoardIndex(req.user.id);
  const limit = BOARD_LIMITS[req.user.level] ?? 3;
  if (idx.boards.length >= limit) {
    return res.status(403).json({ ok: false, code: 'BOARD_LIMIT', error: `画板数量已达上限（${limit} 个），升级会员可解锁更多`, limit });
  }
  const id = validBoardId(req.body.id) ? req.body.id : newBoardId();
  if (idx.boards.some(b => b.id === id)) return res.status(409).json({ ok: false, error: '画板已存在' });
  const folderId = typeof req.body.folderId === 'string' && idx.folders.some(f => f.id === req.body.folderId) ? req.body.folderId : undefined;
  const meta = { id, name: (req.body.name || '未命名的作品').slice(0, 60), folderId, savedAt: Date.now() };
  idx.boards.push(meta);
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, board: boardMeta(meta) });
});

// 取单个画板完整内容
app.get('/api/boards/:id', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  const payload = loadJSON(path.join(boardDir(req.user.id), req.params.id + '.json'), null);
  res.json({ ok: true, board: boardMeta(meta), payload });
});

// 轻量时间戳：编辑器轮询"云端是否有协作者更新"用（不含内容/缩略图，1s 一次无压力；2026-10-15）
// 顺带返回协同编辑锁占用者，作者端据此浮出「xxx 正在操作中」
app.get('/api/boards/:id/meta', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  const lock = activeLock(meta);
  res.json({ ok: true, savedAt: meta.savedAt ?? 0, lock: lock ? { name: lock.name, mine: lock.uid === req.user.id } : null });
});

// 保存画板内容（自动保存通道）
app.put('/api/boards/:id', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  const payload = req.body.payload;
  if (payload == null || typeof payload !== 'object') return res.status(400).json({ ok: false, error: '缺少画板内容' });
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_BOARD_BYTES) return res.status(413).json({ ok: false, code: 'BOARD_TOO_LARGE', error: '画板内容超过 10MB，建议减少图片或拆分画板' });
  saveJSON(path.join(boardDir(req.user.id), req.params.id + '.json'), payload);
  meta.savedAt = Date.now();
  if (typeof req.body.thumb === 'string' && req.body.thumb.startsWith('data:image/') && req.body.thumb.length <= MAX_THUMB_CHARS) meta.thumb = req.body.thumb;
  if (typeof req.body.name === 'string' && req.body.name.trim()) meta.name = req.body.name.trim().slice(0, 60);
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, savedAt: meta.savedAt });
});

// 重命名 / 移动文件夹
app.patch('/api/boards/:id', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) meta.name = req.body.name.trim().slice(0, 60);
  if ('folderId' in req.body) {
    meta.folderId = typeof req.body.folderId === 'string' && idx.folders.some(f => f.id === req.body.folderId) ? req.body.folderId : undefined;
  }
  meta.savedAt = Date.now();
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, board: boardMeta(meta) });
});

// 删除画板（元信息 + 内容文件）
app.delete('/api/boards/:id', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const i = idx.boards.findIndex(b => b.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: '画板不存在' });
  const shareToken = idx.boards[i].shareToken;
  idx.boards.splice(i, 1);
  saveBoardIndex(req.user.id, idx);
  fs.unlink(path.join(boardDir(req.user.id), req.params.id + '.json'), () => {});
  removeShare(shareToken);   // 删掉画板同时关掉它的分享链接
  if (shareToken) fs.unlink(commentsFile(shareToken), () => {});   // 批注一并清除
  res.json({ ok: true });
});

// 文件夹：新建 / 重命名 / 删除（删除时夹内画板移回全部，不删画板）
app.post('/api/folders', authUser, (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ ok: false, error: '文件夹名称不能为空' });
  const idx = loadBoardIndex(req.user.id);
  const folder = { id: validBoardId(req.body.id) ? req.body.id : newBoardId(), name };
  if (idx.folders.some(f => f.id === folder.id)) return res.status(409).json({ ok: false, error: '文件夹已存在' });
  idx.folders.push(folder);
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, folder });
});

app.patch('/api/folders/:id', authUser, (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ ok: false, error: '文件夹名称不能为空' });
  const idx = loadBoardIndex(req.user.id);
  const folder = idx.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ ok: false, error: '文件夹不存在' });
  folder.name = name;
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, folder });
});

app.delete('/api/folders/:id', authUser, (req, res) => {
  const idx = loadBoardIndex(req.user.id);
  const i = idx.folders.findIndex(f => f.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: '文件夹不存在' });
  idx.folders.splice(i, 1);
  idx.boards.forEach(b => { if (b.folderId === req.params.id) b.folderId = undefined; });
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true });
});

// 首次登录迁移：批量导入本地画板（受数量上限约束，逐个导入并汇报跳过项）
app.post('/api/boards/import-local', authUser, (req, res) => {
  const idx = loadBoardIndex(req.user.id);
  const limit = BOARD_LIMITS[req.user.level] ?? 3;
  const inFolders = Array.isArray(req.body.folders) ? req.body.folders : [];
  const inBoards = Array.isArray(req.body.boards) ? req.body.boards : [];
  const imported = [], skipped = [];
  // 先并文件夹（按 id 对齐）
  for (const f of inFolders.slice(0, 100)) {
    if (f && validBoardId(f.id) && typeof f.name === 'string' && f.name.trim() && !idx.folders.some(x => x.id === f.id)) {
      idx.folders.push({ id: f.id, name: f.name.trim().slice(0, 40) });
    }
  }
  for (const b of inBoards.slice(0, 200)) {
    if (!b || !validBoardId(b.id)) { skipped.push({ id: b?.id, reason: '无效 id' }); continue; }
    if (idx.boards.some(x => x.id === b.id)) { skipped.push({ id: b.id, reason: '已存在' }); continue; }
    if (idx.boards.length >= limit) { skipped.push({ id: b.id, name: b.name, reason: '超过数量上限' }); continue; }
    if (b.payload && Buffer.byteLength(JSON.stringify(b.payload)) > MAX_BOARD_BYTES) { skipped.push({ id: b.id, name: b.name, reason: '内容超过 10MB' }); continue; }
    const meta = {
      id: b.id,
      name: (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : '未命名的作品').slice(0, 60),
      folderId: typeof b.folderId === 'string' && idx.folders.some(f => f.id === b.folderId) ? b.folderId : undefined,
      savedAt: typeof b.savedAt === 'number' ? b.savedAt : Date.now(),
    };
    if (typeof b.thumb === 'string' && b.thumb.startsWith('data:image/') && b.thumb.length <= MAX_THUMB_CHARS) meta.thumb = b.thumb;
    idx.boards.push(meta);
    if (b.payload && typeof b.payload === 'object') saveJSON(path.join(boardDir(req.user.id), b.id + '.json'), b.payload);
    imported.push(b.id);
  }
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, imported, skipped, limit });
});

// 开启分享：生成/复用 token，可带 mode（view 只读 / edit 可编辑），返回分享链接标识
app.post('/api/boards/:id/share', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  const mode = ['view', 'edit', 'edit_dl'].includes(req.body.mode) ? req.body.mode : 'view';   // edit_dl = 可编辑+可导出（被分享者可导出，2026-10-15）
  // 协作分享分档（2026-10-19 定价改版）：只读 view 全档可用；可编辑类（edit/edit_dl）需红果/金果
  if (mode !== 'view' && !['pro', 'team'].includes(req.user.level || 'none')) {
    return res.status(403).json({ ok: false, error: 'collab-forbidden', message: '协作分享（可编辑）需红果/金果会员' });
  }
  if (meta.shareToken) {
    if (mode !== (meta.shareMode || 'view')) {   // 切换模式
      meta.shareMode = mode;
      saveBoardIndex(req.user.id, idx);
    }
    return res.json({ ok: true, shareToken: meta.shareToken, mode: meta.shareMode || 'view' });
  }
  const shares = loadShares();
  let token = newShareToken();
  while (shares[token]) token = newShareToken();   // 理论上不会撞，兜底
  meta.shareToken = token;
  meta.shareMode = mode;
  shares[token] = { uid: req.user.id, boardId: meta.id };
  saveBoardIndex(req.user.id, idx);
  saveShares(shares);
  res.json({ ok: true, shareToken: token, mode });
});

// 关闭分享：链接立即失效
app.delete('/api/boards/:id/share', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (meta.shareToken) {
    removeShare(meta.shareToken);
    fs.unlink(commentsFile(meta.shareToken), () => {});   // 批注一并清除
    meta.shareToken = undefined;
    meta.shareMode = undefined;
    meta.lock = undefined;
    saveBoardIndex(req.user.id, idx);
  }
  res.json({ ok: true });
});

// 「我的接收」：别人分享给我、且我打开过的画板（按 visitors 记录反查；2026-10-15）
// 注意：必须注册在 /api/shared/:token 之前，否则会被当成 token="incoming" 命中 404
app.get('/api/shared/incoming', authUser, (req, res) => {
  const shares = loadShares();
  const out = [];
  for (const [token, ref] of Object.entries(shares)) {
    const v = (ref.visitors ?? {})[req.user.id];
    if (!v) continue;
    const idx = loadBoardIndex(ref.uid);
    const meta = idx.boards.find(b => b.id === ref.boardId);
    if (!meta || meta.shareToken !== token) continue;
    const owner = loadUsers().find(u => u.id === ref.uid);
    out.push({ token, mode: meta.shareMode || 'view', name: meta.name, savedAt: meta.savedAt ?? 0, thumb: meta.thumb, ownerName: owner?.name ?? '一位用户', at: v.at ?? 0 });
  }
  out.sort((a, b) => b.at - a.at);
  res.json({ ok: true, list: out });
});

// 公开只读访问：凭 token 看画板内容（不含任何用户信息）
app.get('/api/shared/:token', shareRateLimit, (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(token)) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const shares = loadShares();
  const ref = shares[token];
  if (!ref || !validBoardId(ref.boardId)) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const idx = loadBoardIndex(ref.uid);
  const meta = idx.boards.find(b => b.id === ref.boardId);
  if (!meta || meta.shareToken !== token) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const payload = loadJSON(path.join(boardDir(ref.uid), ref.boardId + '.json'), null);
  if (!payload) return res.status(404).json({ ok: false, error: '画板内容为空' });
  res.json({ ok: true, name: meta.name, savedAt: meta.savedAt, payload });
});

// ---- 可编辑分享 + 编辑锁（2026-10-05）----
// 锁存画板 meta.lock = { uid, name, at }；35 秒无心跳自动过期（关页面/断网不用显式释放）
const LOCK_TTL = 35 * 1000;
const activeLock = (meta) => (meta.lock && Date.now() - meta.lock.at < LOCK_TTL) ? meta.lock : null;
// 凭 token 找到画板（含反查校验）；失败返回 null
function loadShared(token) {
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(String(token || ''))) return null;
  const ref = loadShares()[token];
  if (!ref || !validBoardId(ref.boardId)) return null;
  const idx = loadBoardIndex(ref.uid);
  const meta = idx.boards.find(b => b.id === ref.boardId);
  if (!meta || meta.shareToken !== token) return null;
  return { ref, idx, meta };
}

// 可编辑分享的状态：模式 + 画板名 + 锁占用者昵称 + 我是谁（登录可选）
app.get('/api/shared/:token/state', shareRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const me = optionalUser(req);
  // 记录接收人（登录用户，作者本人不算）：「我的接收」板块的数据来源。60 秒内重复访问不重复写盘（state 轮询 1s 一次）
  if (me && me.id !== s.ref.uid) {
    const shares = loadShares();
    const rec = shares[req.params.token];
    if (rec) {
      const v = (rec.visitors ?? {})[me.id];
      if (!v || Date.now() - (v.at ?? 0) > 60 * 1000) {
        rec.visitors = { ...(rec.visitors ?? {}), [me.id]: { name: me.name, at: Date.now() } };
        saveShares(shares);
      }
    }
  }
  const lock = activeLock(s.meta);
  res.json({
    ok: true,
    mode: s.meta.shareMode || 'view',
    name: s.meta.name,
    savedAt: s.meta.savedAt,
    lock: lock ? { name: lock.name, mine: !!(me && me.id === lock.uid) } : null,
    me: me ? { id: me.id, name: me.name } : null,
    owner: !!(me && me.id === s.ref.uid),   // 我是画板作者（可删任意批注）
  });
});

// 拿锁 / 心跳：空闲、过期或锁本来就是我的 → 拿到；否则 409 + 占用者昵称
app.post('/api/shared/:token/lock', authUser, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  if (!['edit', 'edit_dl'].includes(s.meta.shareMode || 'view')) return res.status(403).json({ ok: false, error: '这个分享是只读的' });
  const lock = activeLock(s.meta);
  if (lock && lock.uid !== req.user.id) {
    return res.status(409).json({ ok: false, code: 'LOCKED', lockName: lock.name });
  }
  s.meta.lock = { uid: req.user.id, name: req.user.name || '一位用户', at: Date.now() };
  saveBoardIndex(s.ref.uid, s.idx);
  res.json({ ok: true, lock: { name: s.meta.lock.name, mine: true } });
});

// 主动释放锁（关闭页面/切走）
app.delete('/api/shared/:token/lock', authUser, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  if (s.meta.lock && s.meta.lock.uid === req.user.id) {
    s.meta.lock = undefined;
    saveBoardIndex(s.ref.uid, s.idx);
  }
  res.json({ ok: true });
});

// 协同保存：必须持有有效锁；写入作者的画板存档（分享链接看到的就是这份）
app.put('/api/shared/:token', authUser, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  if (!['edit', 'edit_dl'].includes(s.meta.shareMode || 'view')) return res.status(403).json({ ok: false, error: '这个分享是只读的' });
  const lock = activeLock(s.meta);
  if (!lock || lock.uid !== req.user.id) {
    return res.status(409).json({ ok: false, code: 'LOCKED', lockName: lock ? lock.name : null, error: lock ? `${lock.name} 正在编辑中` : '编辑锁已失效，请刷新页面' });
  }
  const payload = req.body.payload;
  if (payload == null || typeof payload !== 'object') return res.status(400).json({ ok: false, error: '缺少画板内容' });
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_BOARD_BYTES) return res.status(413).json({ ok: false, code: 'BOARD_TOO_LARGE', error: '画板内容超过 10MB' });
  saveJSON(path.join(boardDir(s.ref.uid), s.ref.boardId + '.json'), payload);
  s.meta.savedAt = Date.now();
  if (typeof req.body.thumb === 'string' && req.body.thumb.startsWith('data:image/') && req.body.thumb.length <= MAX_THUMB_CHARS) s.meta.thumb = req.body.thumb;
  s.meta.lock.at = Date.now();   // 保存本身也算一次心跳
  saveBoardIndex(s.ref.uid, s.idx);
  res.json({ ok: true, savedAt: s.meta.savedAt });
});

// ---- 免登录批注（2026-10-05）----
// 存储：data/comments/<token>.json —— 凭分享链接即可读写（昵称由评论者自填，前端记在其浏览器本地）
const COMMENTS_DIR = path.join(DATA_DIR, 'comments');
fs.mkdirSync(COMMENTS_DIR, { recursive: true });
const commentsFile = (token) => path.join(COMMENTS_DIR, String(token).replace(/[^A-Za-z0-9_-]/g, '') + '.json');
const loadComments = (token) => { const d = loadJSON(commentsFile(token), []); return Array.isArray(d) ? d : []; };
const saveComments = (token, list) => saveJSON(commentsFile(token), list);
const commentRateLimit = makeRateLimiter(30, 10 * 60 * 1000, '批注太频繁啦，请 10 分钟后再试');

// 拉批注列表（公开，凭分享链接）
app.get('/api/shared/:token/comments', shareRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  // eslint-disable-next-line no-unused-vars
  res.json({ ok: true, comments: loadComments(req.params.token).map(({ key, ...pub }) => pub) });   // 删除钥匙不下发
});

// 加批注：钉在画板世界坐标上；昵称必填（前端引导填一次）
app.post('/api/shared/:token/comments', commentRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const name = String(req.body?.name ?? '').trim().slice(0, 20);
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  const x = Number(req.body?.x), y = Number(req.body?.y);
  if (!name) return res.status(400).json({ ok: false, error: '先填个称呼再批注' });
  if (!text) return res.status(400).json({ ok: false, error: '批注内容不能为空' });
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ ok: false, error: '缺少位置' });
  const list = loadComments(req.params.token);
  if (list.length >= 200) return res.status(429).json({ ok: false, error: '批注太多了，先解决掉一些吧' });
  // key：删除钥匙，只在创建响应里返回给发布者本人，列表接口不下发，防拿到链接的人互删
  const c = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), key: crypto.randomBytes(8).toString('hex'), name, text, x: Math.round(x), y: Math.round(y), at: Date.now(), done: false };
  list.push(c);
  saveComments(req.params.token, list);
  res.json({ ok: true, comment: c });
});

// 标记已解决/重新打开：拿到链接的人都能操作（导师提、学生勾）
app.patch('/api/shared/:token/comments/:cid', commentRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const list = loadComments(req.params.token);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  if (typeof req.body?.done === 'boolean') c.done = req.body.done;
  saveComments(req.params.token, list);
  // eslint-disable-next-line no-unused-vars
  const { key, ...pub } = c;   // 删除钥匙不下发
  res.json({ ok: true, comment: pub });
});

// 删批注：发布者凭删除钥匙（存在其本地），或画板作者凭登录态；其他人 403
app.delete('/api/shared/:token/comments/:cid', commentRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const list = loadComments(req.params.token);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  const me = optionalUser(req);
  const isOwner = !!(me && me.id === s.ref.uid);
  const hasKey = typeof req.headers['x-comment-key'] === 'string' && req.headers['x-comment-key'] === c.key;
  if (!isOwner && !hasKey) return res.status(403).json({ ok: false, error: '只能删除自己发的批注' });
  saveComments(req.params.token, list.filter(x => x.id !== c.id));
  res.json({ ok: true });
});

// ---- 作者在编辑器里看批注（2026-10-05）----
// 拉自己画板的批注（含未读判断基准 readAt）；未分享的画板返回空列表
app.get('/api/boards/:id/comments', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (!meta.shareToken) return res.json({ ok: true, comments: [], readAt: meta.commentsReadAt || 0, shared: false });
  // eslint-disable-next-line no-unused-vars
  const comments = loadComments(meta.shareToken).map(({ key, ...pub }) => pub);   // 删除钥匙不下发
  res.json({ ok: true, comments, readAt: meta.commentsReadAt || 0, shared: true });
});

// 标记批注已读：记录时间戳，之前（含）的批注都算已读
app.post('/api/boards/:id/comments/read', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  meta.commentsReadAt = Date.now();
  saveBoardIndex(req.user.id, idx);
  res.json({ ok: true, readAt: meta.commentsReadAt });
});

// 作者删批注：走自己画板的 shareToken，复用同一份存储
app.delete('/api/boards/:id/comments/:cid', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (!meta.shareToken) return res.status(404).json({ ok: false, error: '批注不存在' });
  const list = loadComments(meta.shareToken);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  saveComments(meta.shareToken, list.filter(x => x.id !== c.id));
  res.json({ ok: true });
});

// 作者标记已处理/重新打开：与分享侧同一份数据
app.patch('/api/boards/:id/comments/:cid', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (!meta.shareToken) return res.status(404).json({ ok: false, error: '批注不存在' });
  const list = loadComments(meta.shareToken);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  if (typeof req.body?.done === 'boolean') c.done = req.body.done;
  saveComments(meta.shareToken, list);
  // eslint-disable-next-line no-unused-vars
  const { key, ...pub } = c;
  res.json({ ok: true, comment: pub });
});

// ---- 批注回复（2026-10-05）：批注变对话；replies=[{name,text,at,by:'owner'|'guest'}]，rt=最后回复时间（供未读判断）----
// 访客回复：凭分享链接，昵称必填
app.post('/api/shared/:token/comments/:cid/replies', commentRateLimit, (req, res) => {
  const s = loadShared(req.params.token);
  if (!s) return res.status(404).json({ ok: false, error: '分享链接不存在或已关闭' });
  const list = loadComments(req.params.token);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  const name = String(req.body?.name ?? '').trim().slice(0, 20);
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  if (!name) return res.status(400).json({ ok: false, error: '先填个称呼再回复' });
  if (!text) return res.status(400).json({ ok: false, error: '回复内容不能为空' });
  c.replies = Array.isArray(c.replies) ? c.replies : [];
  if (c.replies.length >= 50) return res.status(429).json({ ok: false, error: '这条批注的回复太多了' });
  const r = { name, text, at: Date.now(), by: 'guest' };
  c.replies.push(r);
  c.rt = r.at;
  saveComments(req.params.token, list);
  res.json({ ok: true, reply: r });
});

// 作者回复：登录态，昵称取账号名
app.post('/api/boards/:id/comments/:cid/replies', authUser, (req, res) => {
  if (!validBoardId(req.params.id)) return res.status(400).json({ ok: false, error: '无效的画板 id' });
  const idx = loadBoardIndex(req.user.id);
  const meta = idx.boards.find(b => b.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: '画板不存在' });
  if (!meta.shareToken) return res.status(404).json({ ok: false, error: '批注不存在' });
  const list = loadComments(meta.shareToken);
  const c = list.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ ok: false, error: '批注不存在' });
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: '回复内容不能为空' });
  c.replies = Array.isArray(c.replies) ? c.replies : [];
  if (c.replies.length >= 50) return res.status(429).json({ ok: false, error: '这条批注的回复太多了' });
  const r = { name: (req.user.name || '作者').slice(0, 20), text, at: Date.now(), by: 'owner' };
  c.replies.push(r);
  c.rt = r.at;
  saveComments(meta.shareToken, list);
  res.json({ ok: true, reply: r });
});

// （2026-10-05）「提醒作者」邮件接口已下线：批注改由作者在编辑器批注面板直接查看

// ---- 统一错误处理（2026-09-21，必须放在所有路由之后）----
app.use((err, req, res, next) => {
  logLine('error', `${req.method} ${req.originalUrl} ${err && err.stack || err}`);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: '服务器开小差了，请稍后再试' });
});
