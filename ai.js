// OneFig AI 工坊：积分体系 + Seedream 生图流水线（供应商解耦：只认 generate() 适配器）
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// 2026-10-21：默认模型升 Seedream 5.0 Pro（准确率代际提升），尺寸 2048² → 1536²
// （1536×1536 = 236 万像素 ≤ 261 万，卡在 0.30 元/张档；2048² 会跳进 0.60 元档）
// 均可环境变量覆盖：ARK_MODEL / ARK_SIZE
const MODEL = process.env.ARK_MODEL || 'doubao-seedream-5-0-pro-260628';
const SIZE = process.env.ARK_SIZE || '1536x1536';
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const CANDIDATES = 1; // 每次生成 = 1 张候选 = 10 积分（Seedream 5.0 Pro 1536² 成本 0.30 元/张，定价 1 元/张，毛利约 70%）；不满意再生成再扣 10 积分，无免费重抽
const COST = 10; // 每次生成消耗积分（2026-10-21 按反馈统一定价 10）
const GEN_FREE = Math.max(0, Number(process.env.ONEFIG_AI_GEN_FREE ?? 1)); // 生成素材每人免费试用次数（2026-10-21 按反馈：1 次终身，与改图/风格转换同记 users.aiFreeUsed；0 = 纯积分制）
const CREDIT_PACKAGES = [
  { id: 'p100', credits: 100, price: 9.9 },
  { id: 'p800', credits: 800, price: 59.9 },
  { id: 'p2000', credits: 2000, price: 99.9 },
];
const MEMBER_GIFT = { basic: 150, pro: 900, team: 3000 }; // 终身制一次性赠送（按 10 积分/张约 15/90/300 张图）
// 平台安全策略会 403 的词，提前拦截并友好提示（不扣积分）
const BLOCKWORDS = ['肾小球', '肾小囊', '肾单位', '髓袢', '肾小管'];

const STYLE_SUFFIX = {
  flat: '二维扁平矢量插画风格，类似Adobe Illustrator绘制的科研示意图，色块平涂加柔和线性渐变，完全没有3D效果、没有写实感、没有光泽高光、没有阴影渲染',
  matte: '柔和的二维插画，色块内有细腻柔和的渐变晕染，质感像水彩和哑光奶油的结合，轻微柔和体积感；但绝对不要玻璃光泽、不要塑料感、不要强烈高光、不要3D渲染感、不要写实照片感',
};
const PROMPT_TMPL = (topic, style) =>
  `${topic}，形态科学准确。${STYLE_SUFFIX[style] || STYLE_SUFFIX.matte}，轮廓圆润干净，类似现代科研示意图。紫色粉色橙色系低饱和配色，透明背景，无任何文字和标注，主体板正居中，极简专业`;

module.exports = function registerAI(app, deps) {
  const { consoleAuth, DATA_DIR, authUser, loadUsers, saveUsers, injectAigcMeta, logLine } = deps;
  const AI_DIR = path.join(DATA_DIR, 'ai');
  const JOBS_FILE = path.join(AI_DIR, 'jobs.json');
  const CREDIT_ORDERS_FILE = path.join(AI_DIR, 'credit-orders.json');
  const KEY_FILE = path.join(AI_DIR, 'ark-key.txt');
  fs.mkdirSync(AI_DIR, { recursive: true });
  const loadJobs = () => { try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { return []; } };
  const saveJobs = j => { const t = JOBS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(j, null, 1)); fs.renameSync(t, JOBS_FILE); };
  const loadCO = () => { try { return JSON.parse(fs.readFileSync(CREDIT_ORDERS_FILE, 'utf8')); } catch { return []; } };
  const saveCO = o => { const t = CREDIT_ORDERS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, CREDIT_ORDERS_FILE); };

  const arkKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } };

  function today() { return new Date().toISOString().slice(0, 10); }
  function freeLeft() { return 0; } // 每日免费已取消，一律走积分

  // ---- 白底转透明：从边缘洪泛填充近似白色/浅灰背景；另裁左下角平台水印区 ----
  // 注意：Ark 的 b64_json 可能返回 JPEG 字节（与文件名无关），按魔数自动选择解码器
  function whiteToTransparent(buf) {
    const { PNG } = require('pngjs');
    let rgb, w, h;
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
      const jpeg = require('jpeg-js');
      const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
      rgb = d.data; w = d.width; h = d.height;
    } else {
      const png = PNG.sync.read(buf);
      rgb = png.data; w = png.width; h = png.height;
    }
    // 1) 裁掉左下角 AI 水印带（即使已关 watermark，防御性处理）
    for (let y = h - 44; y < h; y++) for (let x = 0; x < 180; x++) {
      const i = (w * y + x) << 2; rgb[i + 3] = 0;
    }
    // 2) 边缘洪泛：背景色取四角均值，容差内连通即透明
    const corners = [0, (w - 1) << 2, (w * (h - 1)) << 2, (w * h - 1) << 2];
    const br = corners.reduce((s, i) => s + rgb[i], 0) / 4;
    const bg = corners.reduce((s, i) => s + rgb[i + 1], 0) / 4;
    const bb = corners.reduce((s, i) => s + rgb[i + 2], 0) / 4;
    const TOL2 = 42 * 42 * 3; // 颜色距离容差
    const isBg = (i) => {
      const dr = rgb[i] - br, dg = rgb[i + 1] - bg, db = rgb[i + 2] - bb;
      return dr * dr + dg * dg + db * db < TOL2;
    };
    const visited = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, w * (h - 1) + x); }
    for (let y = 0; y < h; y++) { stack.push(w * y, w * y + w - 1); }
    while (stack.length) {
      const p = stack.pop();
      if (visited[p] || !isBg(p << 2)) continue;
      visited[p] = 1;
      rgb[(p << 2) + 3] = 0;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    return PNG.sync.write({ width: w, height: h, data: rgb });
  }

  // ---- 供应商适配层：换成别的生图服务只需改这个函数 ----
  function generateImage(prompt) {
    return new Promise((resolve, reject) => {
      const key = arkKey();
      if (!key) return reject(new Error('生图服务未配置'));
      const body = JSON.stringify({ model: MODEL, prompt, size: SIZE, response_format: 'b64_json', watermark: false });
      const req = https.request(ARK_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 200 && j.data && j.data[0] && j.data[0].b64_json)
              return resolve(Buffer.from(j.data[0].b64_json, 'base64'));
            reject(new Error((j.error && j.error.message) || ('生图服务报错 ' + res.statusCode)));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---- 智能抠底（2026-10-21）：优先调用本地 rembg 服务（AI 识别主体，浅色/奶油风描边不会被误吃），
  // 服务不可用时回退到洪泛算法 whiteToTransparent。
  // 背景：Seedream 5.0 Pro 出图底色接近纯白（249-255），洪泛容差 42 会把浅蓝/浅紫主体边缘
  // （距白 <40/通道）一起抠掉，用户反馈"生成的图被扣了底色"。
  function rembgTransparent(buf) {
    return new Promise((resolve, reject) => {
      const boundary = '----onefig' + crypto.randomBytes(8).toString('hex');
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="gen.png"\r\nContent-Type: image/png\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const req = require('http').request({
        host: '127.0.0.1', port: 9000, path: '/remove-bg', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': head.length + buf.length + tail.length },
        timeout: 120000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200 && chunks.length) return resolve(Buffer.concat(chunks));
          reject(new Error('rembg ' + res.statusCode));
        });
      });
      req.on('timeout', () => req.destroy(new Error('rembg 超时')));
      req.on('error', reject);
      req.write(head); req.write(buf); req.write(tail); req.end();
    });
  }
  async function matteImage(buf) {
    try { return await rembgTransparent(buf); }
    catch (e) { logLine('ai-op', 'rembg 不可用，回退洪泛抠底：' + e.message); return whiteToTransparent(buf); }
  }

  async function runJob(job) {
    const dir = path.join(AI_DIR, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const prompt = PROMPT_TMPL(job.prompt, job.style);
    const results = [];
    for (let i = 0; i < CANDIDATES; i++) {
      try {
        const buf = await generateImage(prompt);
        const transparent = await matteImage(buf);
        const f = path.join(dir, `c${i}.png`);
        fs.writeFileSync(f, transparent);
        results.push({ i, ok: true, size: transparent.length });
      } catch (e) {
        results.push({ i, ok: false, err: e.message });
      }
    }
    const jobs = loadJobs();
    const j = jobs.find(x => x.id === job.id);
    if (!j) return;
    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      j.status = 'failed';
      j.error = results[0] && results[0].err;
      // 全部失败 → 退还消耗（积分退回，或恢复当日免费次数）
      const users = loadUsers();
      const u = users.find(x => x.id === j.userId);
      if (u) {
        // 全部失败 → 原路退还：积分退回，或恢复免费试用次数（2026-10-21 生成素材新增试用）
        if (j.paidWith === 'credit') u.credits = (u.credits || 0) + COST;
        else if (j.paidWith === 'free' && u.aiFreeUsed) u.aiFreeUsed.gen = Math.max(0, (u.aiFreeUsed.gen || 0) - 1);
        saveUsers(users);
      }
    } else {
      j.status = 'done';
      j.candidates = results.filter(r => r.ok).map(r => r.i);
    }
    j.finishedAt = new Date().toISOString();
    saveJobs(jobs);
    // AI 操作语义日志（2026-10-15）：谁、什么时间、什么描述、成败与原因
    const uname = (loadUsers().find(x => x.id === job.userId) || {}).name || job.userId;
    logLine('ai-op', okCount === 0
      ? `generate FAIL user=${uname} prompt="${job.prompt.slice(0, 40)}" err=${j.error} cost=${job.cost}`
      : `generate done user=${uname} prompt="${job.prompt.slice(0, 40)}" ok=${okCount}/${CANDIDATES} cost=${job.cost}`);
  }

  // ---- 公开：积分套餐 ----
  app.get('/api/ai/packages', (req, res) => {
    res.json({ ok: true, packages: CREDIT_PACKAGES, perGen: COST, candidates: CANDIDATES, memberGift: MEMBER_GIFT });
  });

  // ---- 状态：积分余额 + 今日免费次数 ----
  // aiFreeLeft（2026-10-21）：改图/风格转换各自的免费试用剩余次数，
  // 供前端"每人免费试 1 次"提示在试用用完后自动隐藏
  // aiLocal（2026-10-21）：移除背景/位图转矢量的今日剩余免费次数（会员返回 unlimited），aiLocalCost 为其超出单价
  app.get('/api/ai/status', authUser, (req, res) => {

    res.json({ ok: true, credits: req.user.credits || 0, freeLeft: freeLeft(req.user), level: req.user.level || 'none', aiFreeLeft: deps.aiFreeLeft ? deps.aiFreeLeft(req.user) : undefined, aiCost: deps.aiCost ? deps.aiCost() : undefined, aiLocal: deps.aiLocalLeft ? deps.aiLocalLeft(req.user) : undefined, aiLocalCost: deps.aiLocalCost ? deps.aiLocalCost() : undefined });
  });

  // ---- 发起生成 ----
  app.post('/api/ai/generate', authUser, (req, res) => {
    try {
      const prompt = String((req.body || {}).prompt || '').trim().slice(0, 500);
      const style = (req.body || {}).style === 'flat' ? 'flat' : 'matte';
      if (!prompt) return res.status(400).json({ ok: false, error: '先描述一下想要什么素材吧' });
      if (prompt.length < 4) return res.status(400).json({ ok: false, error: '描述再具体一点点，太简短容易画歪' });
      const hit = BLOCKWORDS.find(w => prompt.includes(w));
      if (hit) return res.status(400).json({ ok: false, error: `「${hit}」相关描述容易被平台安全策略拦截，试试换个说法（比如用泛指的上级名称），就不会浪费你的积分啦` });

      const users = loadUsers();
      const u = users.find(x => x.id === req.user.id);
      // 免费试用（2026-10-21 按反馈：每人 1 次终身免费，与改图/风格转换同记 users.aiFreeUsed）
      const fu = u.aiFreeUsed && typeof u.aiFreeUsed === 'object' ? u.aiFreeUsed : (u.aiFreeUsed = {});
      let paidWith = 'credit';
      if ((fu.gen || 0) < GEN_FREE) { fu.gen = (fu.gen || 0) + 1; paidWith = 'free'; }
      else if ((u.credits || 0) < COST) return res.status(403).json({ ok: false, error: 'no-credit', credits: u.credits || 0 });
      else u.credits -= COST;

      // 简易限流：每用户同时只能跑 1 个任务
      const jobs = loadJobs();
      if (jobs.some(j => j.userId === u.id && j.status === 'running')) {
        // 不放行：把刚扣的免费试用 / 积分原路退回（2026-10-21 与免费试用同加）
        if (paidWith === 'free') fu.gen = Math.max(0, fu.gen - 1); else u.credits += COST;
        saveUsers(users);
        return res.status(429).json({ ok: false, error: '上一个生成任务还在跑，等它出图后再试～' });
      }

      const job = { id: crypto.randomUUID(), userId: u.id, prompt, style, status: 'running', candidates: [], picked: null, paidWith, cost: COST, createdAt: new Date().toISOString() };
      jobs.unshift(job);
      saveJobs(jobs);
      saveUsers(users);
      logLine('ai-op', `generate start user=${u.name} prompt="${prompt.slice(0, 40)}" style=${style} paidWith=${paidWith} cost=${paidWith === 'credit' ? COST : 0}`);
      res.json({ ok: true, jobId: job.id, paidWith });
      setImmediate(() => runJob(job).catch(() => {
        const js = loadJobs(); const jj = js.find(x => x.id === job.id);
        if (jj && jj.status === 'running') { jj.status = 'failed'; jj.error = '生成中断'; saveJobs(js); }
      }));
    } catch { res.status(500).json({ ok: false, error: '服务器开小差了' }); }
  });

  // ---- 生成记录入账：AI 工坊五个页签统一（2026-10-21，此前仅"生成素材"有记录）----
  // edit/stylize/remove-bg/vectorize 成功后各写一条 job 记录，结果文件存
  // AI_DIR/<id>/c0.<ext>，与生成素材共用同一套列表 / 预览 / 下载接口。
  // 失败不入账（失败本来就不出图，也无积分损失争议）；入账失败不影响接口返回。
  function recordAIResult({ userId, kind, prompt, ext = 'png', buf }) {
    try {
      if (!buf || !buf.length) return null;
      const id = crypto.randomUUID();
      const dir = path.join(AI_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `c0.${ext}`), buf);
      const jobs = loadJobs();
      jobs.unshift({ id, userId, kind, prompt: String(prompt || '').slice(0, 200), status: 'done', candidates: [0], picked: 0, ext, cost: 0, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      saveJobs(jobs);
      logLine('ai-op', `record kind=${kind} user=${userId} id=${id.slice(0, 8)}`);
      return id;
    } catch (e) { logLine('ai-op', `record FAIL kind=${kind} ${e && e.message}`); return null; }
  }
  module.exports.recordAIResult = recordAIResult;

  // ---- 我的任务列表 ----
  app.get('/api/ai/jobs', authUser, (req, res) => {
    const list = loadJobs().filter(j => j.userId === req.user.id)
      .map(j => ({ id: j.id, kind: j.kind || 'gen', prompt: j.prompt, style: j.style, ext: j.ext || 'png', status: j.status, candidates: j.candidates, picked: j.picked, createdAt: j.createdAt, error: j.error }));
    res.json({ ok: true, list });
  });

  // ---- 任务详情（含候选图，需登录，二进制返回） ----
  app.get('/api/ai/job/:id/img/:n', authUser, (req, res) => {
    const j = loadJobs().find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j || j.status !== 'done') return res.status(404).json({ ok: false });
    const n = parseInt(req.params.n, 10);
    if (!j.candidates.includes(n)) return res.status(404).json({ ok: false });
    const ext = j.ext === 'svg' ? 'svg' : 'png';
    const f = path.join(AI_DIR, j.id, `c${n}.${ext}`);
    if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(f).pipe(res);
  });

  // ---- 选定 1 张 ----
  app.post('/api/ai/job/:id/pick', authUser, (req, res) => {
    const jobs = loadJobs();
    const j = jobs.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j || j.status !== 'done') return res.status(404).json({ ok: false, error: '任务不存在或未完成' });
    const n = parseInt((req.body || {}).index, 10);
    if (!j.candidates.includes(n)) return res.status(400).json({ ok: false, error: '候选不存在' });
    j.picked = n;
    j.pickedAt = new Date().toISOString();
    saveJobs(jobs);
    res.json({ ok: true });
  });

  // ---- 下载选定的透明底 PNG（可反复下载；注入 AIGC 元数据隐式标识，内容编号 = AI-任务号）----
  // 2026-10-21：兼容五类记录（edit/style/nobg/vec），SVG 记录不注入 PNG 元数据
  app.get('/api/ai/job/:id/download', authUser, (req, res) => {
    const j = loadJobs().find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j || j.picked == null) return res.status(404).json({ ok: false, error: '还没有选定素材' });
    const ext = j.ext === 'svg' ? 'svg' : 'png';
    const f = path.join(AI_DIR, j.id, `c${j.picked}.${ext}`);
    if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
    const name = (j.prompt.slice(0, 20).replace(/[\\/:*?"<>|\s]/g, '') || 'onefig') + '.' + ext;
    const raw = fs.readFileSync(f);
    const buf = ext === 'png' ? injectAigcMeta(raw, 'AI-' + j.id.slice(0, 8).toUpperCase()) : raw;
    logLine('ai-op', `download user=${req.user.name} kind=${j.kind || 'gen'} prompt="${j.prompt.slice(0, 40)}"`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Type', ext === 'svg' ? 'image/svg+xml' : 'image/png');
    res.send(buf);
  });

  // ---- 积分购买订单（半自动收款：下单 → 转账 → 后台确认 → 积分到账） ----
  app.post('/api/ai/credit-orders', authUser, (req, res) => {
    const pkg = CREDIT_PACKAGES.find(p => p.id === (req.body || {}).pkg);
    if (!pkg) return res.status(400).json({ ok: false, error: '无效的积分套餐' });
    const cos = loadCO();
    const pending = cos.find(o => o.userId === req.user.id && o.status === 'pending' && o.pkg === pkg.id);
    if (pending) return res.json({ ok: true, order: pending, existed: true });
    const order = { id: crypto.randomUUID(), userId: req.user.id, userName: req.user.name, pkg: pkg.id, credits: pkg.credits, amount: pkg.price, status: 'pending', createdAt: new Date().toISOString(), paidAt: null };
    cos.push(order);
    saveCO(cos);
    res.json({ ok: true, order });
  });

  app.post('/api/ai/credit-orders/:id/notify-paid', authUser, (req, res) => {
    const cos = loadCO();
    const o = cos.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!o) return res.status(404).json({ ok: false });
    if (o.status === 'pending') o.status = 'notified';
    saveCO(cos);
    res.json({ ok: true, order: o });
  });

  app.get('/api/ai/my/credit-orders', authUser, (req, res) => {
    res.json({ ok: true, list: loadCO().filter(o => o.userId === req.user.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
  });

  // ---- 后台：积分订单管理 + 手工调积分 ----
  app.get('/console/api/credit-orders', consoleAuth, (req, res) => {
    let list = loadCO();
    if (req.query.status) list = list.filter(o => req.query.status.split(',').includes(o.status));
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ ok: true, list });
  });

  app.post('/console/api/credit-orders/:id/confirm', consoleAuth, (req, res) => {
    const cos = loadCO();
    const o = cos.find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ ok: false });
    if (o.status === 'paid') return res.json({ ok: true, order: o });
    o.status = 'paid';
    o.paidAt = new Date().toISOString();
    const users = loadUsers();
    const u = users.find(x => x.id === o.userId);
    if (u) {
      u.credits = (u.credits || 0) + o.credits;
      // 用户自己充值：积分流水操作者记用户本人（2026-09-23）
      const logs = loadJSON(path.join(AI_DIR, 'credit-log.json'), []);
      logs.push({ userId: u.id, name: u.name, delta: o.credits, reason: '积分充值', time: new Date().toISOString(), by: u.name });
      saveJSON(path.join(AI_DIR, 'credit-log.json'), logs);
    }
    saveCO(cos); if (u) saveUsers(users);
    res.json({ ok: true, order: o });
  });

  app.delete('/console/api/credit-orders/:id', consoleAuth, (req, res) => {
    saveCO(loadCO().filter(o => o.id !== req.params.id));
    res.json({ ok: true });
  });

  // 手工调整积分（正数加、负数减），记流水
  app.post('/console/api/users/:id/credits', consoleAuth, (req, res) => {
    const delta = parseInt((req.body || {}).delta, 10);
    if (!delta) return res.status(400).json({ ok: false, error: '调整数量无效' });
    const users = loadUsers();
    const u = users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false });
    u.credits = Math.max(0, (u.credits || 0) + delta);
    saveUsers(users);
    const logs = loadJSON(path.join(AI_DIR, 'credit-log.json'), []);
    logs.push({ userId: u.id, name: u.name, delta, reason: String((req.body || {}).reason || '').slice(0, 100), time: new Date().toISOString(), by: 'admin' });
    saveJSON(path.join(AI_DIR, 'credit-log.json'), logs);
    res.json({ ok: true, credits: u.credits });
  });
  function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
  function saveJSON(f, rows) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, f); }
};

// 供 server.js / pay.js 共享同一份套餐定义（在线支付下单时校验用）
module.exports.CREDIT_PACKAGES = CREDIT_PACKAGES;
// 生成素材免费试用次数（server.js 的 aiFreeLeft 注入 status 用）
module.exports.GEN_FREE = GEN_FREE;
