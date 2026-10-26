// OneFig AI 工坊：积分体系 + Seedream 生图流水线（供应商解耦：只认 generate() 适配器）
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// 2026-10-21：默认模型升 Seedream 5.0 Pro（准确率代际提升），尺寸 2048² → 1536²
// （1536×1536 = 236 万像素 ≤ 261 万，卡在 0.30 元/张档；2048² 会跳进 0.60 元档）
// 均可环境变量覆盖：ARK_MODEL / ARK_SIZE
const MODEL = process.env.ARK_MODEL || 'doubao-seedream-5-0-pro-260628';
const SIZE = process.env.ARK_SIZE || '1728x1728'; // 生成素材出图尺寸（2026-10-22 按反馈升高清档 1728²=298 万像素 >261 万，单价 0.60 元/张）
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const CANDIDATES = 1; // 每次生成 = 1 张候选 = 30 积分（Seedream 5.0 Pro 1728² 成本 0.60 元/张，定价 3 元/张，毛利约 80%）；不满意再生成再扣 30 积分，无免费重抽
const COST = 30; // 每次生成消耗积分（2026-10-22 晚按反馈调价 10→30）
const GEN_FREE = Math.max(0, Number(process.env.ONEFIG_AI_GEN_FREE ?? 1)); // 生成素材每人免费试用次数（2026-10-21 按反馈：1 次终身，与改图/风格转换同记 users.aiFreeUsed；0 = 纯积分制）

// ---- 生成大图（2026-10-22 新增）：期刊封面 / 文内摘要图 / 文内机制图 ----
// 面向科研用户的"大图"场景：保留背景（非透明底）、更高分辨率、单独定价
// 提示词模板与尺寸已迁入 ai-prompts.js（后台可视可改、保存即生效）；此处只留定价
const BIG_COST = Math.max(0, Number(process.env.ONEFIG_AI_BIG_COST ?? 30)); // 30 积分/张
const BIG_FREE = Math.max(0, Number(process.env.ONEFIG_AI_BIG_FREE ?? 1));   // 每人免费试用 1 次
// 图层拆分单价（2026-10-22；Seedream 5.0 pro 原生能力，按底图+图层张数计费，成本约为单图数倍）
const SPLIT_COST = Math.max(0, Number(process.env.ONEFIG_AI_SPLIT_COST ?? 100)); // 2026-10-22 晚按反馈调价 60→100
const CREDIT_PACKAGES = [
  { id: 'p100', credits: 100, price: 9.9 },
  { id: 'p800', credits: 800, price: 59.9 },
  { id: 'p2000', credits: 2000, price: 99.9 },
];
const MEMBER_GIFT = { basic: 150, pro: 900, team: 3000 }; // 终身制一次性赠送（按素材 30 积分/张约 5/30/100 张图）
// 平台安全策略会 403 的词，提前拦截并友好提示（不扣积分）
const BLOCKWORDS = ['肾小球', '肾小囊', '肾单位', '髓袢', '肾小管'];

module.exports = function registerAI(app, deps) {
  const { consoleAuth, DATA_DIR, authUser, loadUsers, saveUsers, injectAigcMeta, logLine } = deps;
  // 提示词存储：后台可改、保存即生效；未注入时用纯内存默认值（测试/降级）
  const prompts = deps.prompts || require('./ai-prompts')(null);
  // 生成素材提示词组装：模板占位符替换（模板内容见 ai-prompts.js，后台可改）
  const buildGenPrompt = (topic, style) => {
    const P = prompts.get();
    const cellular = new RegExp(P.cellularKeywords).test(topic);
    return P.genTmpl
      .split('{topic}').join(topic)
      .split('{styleSuffix}').join(P.styleSuffix[style] || P.styleSuffix.matte || '')
      .split('{scienceRules}').join(P.scienceRules || '')
      .split('{cellColorRules}').join(cellular ? (P.cellColorRules || '') : '');
  };
  const buildBigPrompt = (topic, bigType) => {
    const b = prompts.get().big[bigType];
    if (!b) throw new Error('未知的大图类型');
    return { prompt: String(b.prompt || '').split('{topic}').join(topic), size: b.size };
  };
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

  // 启动恢复（2026-10-22）：服务重启会中断内存中正在跑的生成任务，而任务记录仍停在
  // running——永远转圈且用户被"上一个任务还在跑"挡住。启动时把残留 running 记录
  // 标记为失败并原路退还（积分或免费试用次数）。
  (function recoverStuckJobs() {
    try {
      const jobs = loadJobs();
      const stuck = jobs.filter(j => j.status === 'running');
      if (!stuck.length) return;
      const users = loadUsers();
      let usersDirty = false;
      for (const j of stuck) {
        j.status = 'failed';
        j.error = '生成中断（服务维护），已自动退还';
        j.finishedAt = new Date().toISOString();
        const u = users.find(x => x.id === j.userId);
        if (u) {
          if (j.paidWith === 'credit') { u.credits = (u.credits || 0) + (j.cost || COST); usersDirty = true; }
          else if (j.paidWith === 'free' && u.aiFreeUsed) { u.aiFreeUsed.gen = Math.max(0, (u.aiFreeUsed.gen || 0) - 1); usersDirty = true; }
          logLine('ai-op', `recover stuck job user=${u.name} paidWith=${j.paidWith} refund`);
        }
      }
      saveJobs(jobs);
      if (usersDirty) saveUsers(users);
    } catch (e) { logLine('ai-op', `recover FAIL ${e && e.message}`); }
  })();

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
  // size：可选，默认素材尺寸 ARK_SIZE；生成大图时传对应构图尺寸
  function generateImage(prompt, size) {
    return new Promise((resolve, reject) => {
      const key = arkKey();
      if (!key) return reject(new Error('生图服务未配置'));
      const body = JSON.stringify({ model: MODEL, prompt, size: size || SIZE, response_format: 'b64_json', watermark: false });
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
  // ---- 洪泛抠底（2026-10-23 升级）：AI 生成图背景为纯色（提示词保证），
  // 洪泛"只删与边缘连通的背景色"能 100% 保留小碎片元素（Y 形抗体/细丝等），
  // 这是 DL 分割模型的固有弱项。背景色取四角均值（白底/彩色纯色底都适用），
  // 覆盖率异常（主体贴边/复杂背景）时抛错走 AI 模型兜底。----
  function floodMatte(buf) {
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
    // 背景参考色 = 四角 6x6 块均值
    let br = 0, bg = 0, bb = 0, bn = 0;
    const corner = (x0, y0) => { for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) { const i = (w * y + x) << 2; br += rgb[i]; bg += rgb[i + 1]; bb += rgb[i + 2]; bn++; } };
    corner(0, 0); corner(w - 6, 0); corner(0, h - 6); corner(w - 6, h - 6);
    br /= bn; bg /= bn; bb /= bn;
    const cornerLum = (br + bg + bb) / 3;
    // 亮度容差（2026-10-23 v2）：按与四角背景色的"亮度差"判定——
    // 背景渐变是"中性"的（各通道同步变化），而浅米/浅蓝主体与白色背景的差异
    // 远大于背景自身的不均匀度（米色 lum≈234 vs 白 255，差 21），
    // 亮度阈值 13 既能吞掉白底渐变噪点，又能让米色边缘挡住洪泛。
    // 注意：纯白主体（白鼠）会被吃掉——由 matteImage 的"模型∪洪泛"并集兜底。
    const isBg = (i) => Math.abs((rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3 - cornerLum) < 13;
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
    const cov = visited.reduce((a, b) => a + b, 0) / (w * h);
    if (!(cov > 0.03 && cov < 0.93)) throw new Error('flood coverage abnormal: ' + cov.toFixed(3));
    return PNG.sync.write({ width: w, height: h, data: rgb });
  }

  // model：'anime'=插画/卡通/3D 渲染专用会话（对 AI 生成的科研插画分布更匹配，
  // 浅色主体误删更少，2026-10-23）；缺省/其他值走 general（照片/通用）
  function rembgTransparent(buf, model) {
    return new Promise((resolve, reject) => {
      const boundary = '----onefig' + crypto.randomBytes(8).toString('hex');
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="gen.png"\r\nContent-Type: image/png\r\n\r\n`);
      const field = model ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`) : Buffer.alloc(0);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const req = require('http').request({
        host: '127.0.0.1', port: 9000, path: '/remove-bg', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': head.length + field.length + buf.length + tail.length },
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
      req.write(head); if (field.length) req.write(field); req.write(buf); req.write(tail); req.end();
    });
  }
  // 双 alpha 并集：模型结果（ anime 会话，≤1024）与洪泛结果（原尺寸）取 max。
  // 模型保住纯白主体/柔和过渡，洪泛保住小碎片与浅色边缘——各取所长（2026-10-23）
  function alphaUnion(modelBuf, floodBuf) {
    const { PNG } = require('pngjs');
    const m = PNG.sync.read(modelBuf);
    const f = PNG.sync.read(floodBuf);
    const W = f.width, H = f.height;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fi = (W * y + x) << 2;
      if (f.data[fi + 3] > 0) continue; // 洪泛已保留，无需补
      // 最近邻取模型 alpha（模型输出 ≤1024，缩回原尺寸）
      const mx = Math.min(m.width - 1, Math.floor(x * m.width / W));
      const my = Math.min(m.height - 1, Math.floor(y * m.height / H));
      const mi = (m.width * my + mx) << 2;
      const ma = m.data[mi + 3];
      if (ma > 24) { // 模型认为此处有内容：回填其 RGB，避免边缘色偏
        f.data[fi] = m.data[mi]; f.data[fi + 1] = m.data[mi + 1]; f.data[fi + 2] = m.data[mi + 2];
        f.data[fi + 3] = ma;
      }
    }
    return PNG.sync.write({ width: W, height: H, data: f.data });
  }

  async function matteImage(buf) {
    // AI 生成内容抠底（2026-10-23 v3）：模型（anime 会话）与洪泛两路并行，
    // alpha 取并集——小碎片/浅色边缘（洪泛保住）+ 纯白主体/柔和过渡（模型保住）。
    // 两路都失败才回退旧洪泛。
    let modelBuf = null, floodBuf = null;
    try { modelBuf = await rembgTransparent(buf, 'anime'); }
    catch (e) { logLine('ai-op', 'anime 模型不可用：' + e.message); }
    try { floodBuf = floodMatte(buf); }
    catch (e) { logLine('ai-op', 'flood-matte 不适用（' + e.message + '）'); }
    if (modelBuf && floodBuf) return alphaUnion(modelBuf, floodBuf);
    if (modelBuf) return modelBuf;
    if (floodBuf) return floodBuf;
    return whiteToTransparent(buf);
  }

  // ---- 生成大图：保留背景（不抠透明底），仅把 JPEG 字节统一转成 PNG 存储 ----
  function ensurePng(buf) {
    if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
      const jpeg = require('jpeg-js');
      const { PNG } = require('pngjs');
      const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
      return PNG.sync.write({ width: d.width, height: d.height, data: d.data });
    }
    return buf; // 已是 PNG
  }

  async function runJob(job) {
    const dir = path.join(AI_DIR, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const isBig = !!job.bigType;
    let prompt, size;
    if (isBig) ({ prompt, size } = buildBigPrompt(job.prompt, job.bigType));
    else { prompt = buildGenPrompt(job.prompt, job.style); size = undefined; }
    const results = [];
    for (let i = 0; i < CANDIDATES; i++) {
      try {
        const buf = await generateImage(prompt, size);
        // 大图勾选"移除背景"时走本地 rembg 抠透明底；否则保留背景统一转 PNG
        const out = isBig ? (job.transparent ? await matteImage(buf) : ensurePng(buf)) : await matteImage(buf);
        const f = path.join(dir, `c${i}.png`);
        fs.writeFileSync(f, out);
        results.push({ i, ok: true, size: out.length });
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
      // 全部失败 → 退还消耗（积分退回，或恢复免费试用次数）
      const users = loadUsers();
      const u = users.find(x => x.id === j.userId);
      if (u) {
        // 原路退还：积分退回（按实际扣费），或恢复对应功能的免费试用次数
        if (j.paidWith === 'credit') u.credits = (u.credits || 0) + (j.cost || COST);
        else if (j.paidWith === 'free' && u.aiFreeUsed) {
          const fk = j.kind === 'big' ? 'big' : 'gen';
          u.aiFreeUsed[fk] = Math.max(0, (u.aiFreeUsed[fk] || 0) - 1);
        }
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
      ? `generate${isBig ? '-big' : ''} FAIL user=${uname} kind=${j.kind || 'gen'} prompt="${job.prompt.slice(0, 40)}" err=${j.error} cost=${job.cost}`
      : `generate${isBig ? '-big' : ''} done user=${uname} kind=${j.kind || 'gen'} bigType=${j.bigType || '-'} prompt="${job.prompt.slice(0, 40)}" ok=${okCount}/${CANDIDATES} cost=${job.cost}`);
  }

  // ---- 图层拆分：单图 → 1 张底图 + N 个透明图层（Seedream 5.0 pro 原生 layer_decomposition）----
  // 响应约定（2026-10-22 真机验证）：data[0]=底图（output_format 控制格式），data[1:]=图层
  // （恒为 PNG 带透明通道，附 name/description/bounding_box/z_index），按 z_index 升序=从底到顶。
  function arkSplitLayers(imageBuf, instruction) {
    return new Promise((resolve, reject) => {
      const key = arkKey();
      if (!key) return reject(new Error('生图服务未配置'));
      const isJpg = imageBuf.length > 3 && imageBuf[0] === 0xFF && imageBuf[1] === 0xD8;
      const body = JSON.stringify({
        model: MODEL, prompt: instruction,
        image: ['data:image/' + (isJpg ? 'jpeg' : 'png') + ';base64,' + imageBuf.toString('base64')],
        layer_decomposition: true, size: 'auto', response_format: 'b64_json', watermark: false,
      });
      const req = https.request(ARK_URL, {
        method: 'POST', timeout: 300000,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 200 && Array.isArray(j.data) && j.data.length)
              return resolve(j.data.map(it => ({ b64: it.b64_json || '', fmt: it.output_format, name: it.name, description: it.description, z_index: it.z_index, size: it.size })));
            reject(new Error((j.error && j.error.message) || ('图层拆分服务报错 ' + res.statusCode)));
          } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('图层拆分超时，请重试')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function runSplitJob(job, imgBuf) {
    const dir = path.join(AI_DIR, job.id);
    fs.mkdirSync(dir, { recursive: true });
    // 原图一并保存：生成结果区主预览显示"拆分前的大图"（2026-10-22 按反馈）
    try { fs.writeFileSync(path.join(dir, 'orig.png'), ensurePng(imgBuf)); } catch {}
    try {
      const items = await arkSplitLayers(imgBuf, job.prompt);
      // data[0] 底图 → c0.png；图层按 z_index 从底到顶 → c1..cN.png
      fs.writeFileSync(path.join(dir, 'c0.png'), ensurePng(Buffer.from(items[0].b64, 'base64')));
      const layers = items.slice(1)
        .sort((a, b) => (a.z_index || 0) - (b.z_index || 0))
        .map((it, k) => {
          const i = k + 1;
          fs.writeFileSync(path.join(dir, `c${i}.png`), Buffer.from(it.b64, 'base64'));
          return { i, name: it.name || `图层 ${i}`, description: String(it.description || '').slice(0, 100), z_index: it.z_index };
        });
      const jobs = loadJobs();
      const j = jobs.find(x => x.id === job.id);
      if (!j) return;
      j.status = 'done';
      j.candidates = [0, ...layers.map(l => l.i)];
      j.layers = layers;
      j.finishedAt = new Date().toISOString();
      saveJobs(jobs);
      logLine('ai-op', `split done user=${(loadUsers().find(x => x.id === job.userId) || {}).name || job.userId} layers=${layers.length} cost=${job.cost}`);
    } catch (e) {
      const jobs = loadJobs();
      const j = jobs.find(x => x.id === job.id);
      if (j) { j.status = 'failed'; j.error = e.message; j.finishedAt = new Date().toISOString(); saveJobs(jobs); }
      // 失败全额退还
      const users = loadUsers();
      const u = users.find(x => x.id === job.userId);
      if (u && job.paidWith === 'credit') { u.credits = (u.credits || 0) + (job.cost || SPLIT_COST); saveUsers(users); }
      logLine('ai-op', `split FAIL user=${job.userId} err=${e && e.message} cost=${job.cost} refund`);
    }
  }

  // ---- 发起图层拆分：上传图片或传入生成记录 jobId；先扣后拆，失败全额退还 ----
  app.post('/api/ai/split-layers', authUser, (req, res) => {
    if (!deps.upload) return res.status(500).json({ ok: false, error: '服务器未配置文件上传' });
    deps.upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      try {
        let imgBuf = null;
        let srcDesc = '上传图片';
        if (req.file) {
          imgBuf = fs.readFileSync(req.file.path);
          fs.unlinkSync(req.file.path);
        } else if ((req.body || {}).jobId) {
          const src = loadJobs().find(x => x.id === req.body.jobId && x.userId === req.user.id);
          const idx = src && src.status === 'done' ? (src.picked ?? src.candidates[0]) : null;
          const f = idx != null ? path.join(AI_DIR, src.id, `c${idx}.png`) : null;
          if (!f || !fs.existsSync(f)) return res.status(404).json({ ok: false, error: '没有找到要拆分的生成结果，请直接上传图片' });
          imgBuf = fs.readFileSync(f);
          srcDesc = '记录:' + src.prompt.slice(0, 20);
        } else {
          return res.status(400).json({ ok: false, error: '请先上传图片' });
        }
        const instruction = String((req.body || {}).instruction || '').trim().slice(0, 500)
          || ((prompts.get().layerSplit || {}).instruction) || '将图片进行精确图层分离';

        // 费用闸门：无免费试用（成本数倍于单图），先扣后拆
        const users = loadUsers();
        const u = users.find(x => x.id === req.user.id);
        if ((u.credits || 0) < SPLIT_COST)
          return res.status(403).json({ ok: false, error: `图层拆分每次 ${SPLIT_COST} 积分，当前余额不足`, code: 'no-credit', credits: u.credits || 0, cost: SPLIT_COST });
        u.credits -= SPLIT_COST;
        const jobs = loadJobs();
        if (jobs.some(j => j.userId === u.id && j.status === 'running')) {
          u.credits += SPLIT_COST;
          saveUsers(users);
          return res.status(429).json({ ok: false, error: '上一个生成任务还在跑，等它出图后再试～' });
        }
        const job = { id: crypto.randomUUID(), userId: u.id, prompt: instruction, kind: 'split', status: 'running', candidates: [], picked: null, paidWith: 'credit', cost: SPLIT_COST, createdAt: new Date().toISOString() };
        jobs.unshift(job);
        saveJobs(jobs);
        saveUsers(users);
        logLine('ai-op', `split start user=${u.name} src=${srcDesc} cost=${SPLIT_COST}`);
        res.json({ ok: true, jobId: job.id, credits: u.credits });
        setImmediate(() => runSplitJob(job, imgBuf).catch(() => {
          const js = loadJobs(); const jj = js.find(x => x.id === job.id);
          if (jj && jj.status === 'running') { jj.status = 'failed'; jj.error = '拆分中断'; saveJobs(js); }
        }));
      } catch (e) { res.status(500).json({ ok: false, error: '服务器开小差了' }); }
    });
  });

  // ---- 公开：积分套餐 ----
  app.get('/api/ai/packages', (req, res) => {
    res.json({ ok: true, packages: CREDIT_PACKAGES, perGen: COST, candidates: CANDIDATES, memberGift: MEMBER_GIFT });
  });

  // ---- 状态：积分余额 + 今日免费次数 ----
  // aiFreeLeft（2026-10-21）：改图/风格转换各自的免费试用剩余次数，
  // 供前端"每人免费试 1 次"提示在试用用完后自动隐藏
  // aiLocal（2026-10-21）：移除背景/位图转矢量的今日剩余免费次数（会员返回 unlimited），aiLocalCost 为其超出单价
  app.get('/api/ai/status', authUser, (req, res) => {

    res.json({ ok: true, credits: req.user.credits || 0, freeLeft: freeLeft(req.user), level: req.user.level || 'none', aiFreeLeft: deps.aiFreeLeft ? deps.aiFreeLeft(req.user) : undefined, aiCost: deps.aiCost ? deps.aiCost() : undefined, aiBigCost: deps.aiBigCost ? deps.aiBigCost() : undefined, aiSplitCost: deps.aiSplitCost ? deps.aiSplitCost() : undefined, aiLocal: deps.aiLocalLeft ? deps.aiLocalLeft(req.user) : undefined, aiLocalCost: deps.aiLocalCost ? deps.aiLocalCost() : undefined });
  });

  // ---- 发起生成（含"生成大图"：bigType = cover 期刊封面 / abstract 摘要图 / mechanism 机制图）----
  app.post('/api/ai/generate', authUser, (req, res) => {
    try {
      const prompt = String((req.body || {}).prompt || '').trim().slice(0, 500);
      const style = ['flat', 'matte', 'threed'].includes((req.body || {}).style) ? req.body.style : 'matte';
      const bigType = ['cover', 'abstract', 'mechanism'].includes((req.body || {}).bigType) ? req.body.bigType : null;
      const transparent = !!((req.body || {}).transparent) && !!bigType; // 仅生成大图可选（生成素材本就透明底）
      if (!prompt) return res.status(400).json({ ok: false, error: bigType ? '先描述一下想要什么大图吧' : '先描述一下想要什么素材吧' });
      if (prompt.length < 4) return res.status(400).json({ ok: false, error: '描述再具体一点点，太简短容易画歪' });
      const hit = BLOCKWORDS.find(w => prompt.includes(w));
      if (hit) return res.status(400).json({ ok: false, error: `「${hit}」相关描述容易被平台安全策略拦截，试试换个说法（比如用泛指的上级名称），就不会浪费你的积分啦` });

      const users = loadUsers();
      const u = users.find(x => x.id === req.user.id);
      // 免费试用（2026-10-21 生成素材每人 1 次；2026-10-22 生成大图每人 1 次；同记 users.aiFreeUsed）
      const fu = u.aiFreeUsed && typeof u.aiFreeUsed === 'object' ? u.aiFreeUsed : (u.aiFreeUsed = {});
      const freeKey = bigType ? 'big' : 'gen';
      const freeLimit = bigType ? BIG_FREE : GEN_FREE;
      const cost = bigType ? BIG_COST : COST;
      let paidWith = 'credit';
      // 未验证邮箱不享受免费试用（2026-10-25 审计 ISSUE-3：防批量小号薅免费额度）
      if (req.user.verified !== false && (fu[freeKey] || 0) < freeLimit) { fu[freeKey] = (fu[freeKey] || 0) + 1; paidWith = 'free'; }
      else if ((u.credits || 0) < cost) return res.status(403).json({ ok: false, error: 'no-credit', credits: u.credits || 0, unverified: req.user.verified === false || undefined });
      else u.credits -= cost;

      // 简易限流：每用户同时只能跑 1 个任务
      const jobs = loadJobs();
      if (jobs.some(j => j.userId === u.id && j.status === 'running')) {
        // 不放行：把刚扣的免费试用 / 积分原路退回
        if (paidWith === 'free') fu[freeKey] = Math.max(0, (fu[freeKey] || 0) - 1); else u.credits += cost;
        saveUsers(users);
        return res.status(429).json({ ok: false, error: '上一个生成任务还在跑，等它出图后再试～' });
      }

      const job = { id: crypto.randomUUID(), userId: u.id, prompt, style: bigType ? undefined : style, bigType, transparent, kind: bigType ? 'big' : 'gen', status: 'running', candidates: [], picked: null, paidWith, cost, createdAt: new Date().toISOString() };
      jobs.unshift(job);
      saveJobs(jobs);
      saveUsers(users);
      logLine('ai-op', `generate start user=${u.name} kind=${bigType ? 'big' : 'gen'} bigType=${bigType || '-'} prompt="${prompt.slice(0, 40)}" style=${style} paidWith=${paidWith} cost=${paidWith === 'credit' ? cost : 0}`);
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
  module.exports.floodMatte = floodMatte; // 供合成测试与运维排障直接调用

  // ---- 我的任务列表 ----
  app.get('/api/ai/jobs', authUser, (req, res) => {
    const list = loadJobs().filter(j => j.userId === req.user.id)
      .map(j => ({ id: j.id, kind: j.kind || 'gen', bigType: j.bigType, transparent: j.transparent, layers: j.layers, prompt: j.prompt, style: j.style, ext: j.ext || 'png', status: j.status, candidates: j.candidates, picked: j.picked, createdAt: j.createdAt, error: j.error }));
    res.json({ ok: true, list });
  });

  // ---- 图层打包下载：ZIP（store 无压缩——PNG 本已压缩；免依赖手写 ZIP，2026-10-22）----
  function crc32(buf) {
    let table = crc32.table;
    if (!table) {
      table = crc32.table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function buildZip(entries) { // entries: [{name, buf}]（store 方式，CRC-32 + UTF-8 文件名）
    const encoder = new TextEncoder();
    const chunks = []; const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBuf = encoder.encode(e.name);
      const crc = crc32(e.buf);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
      head.writeUInt16LE(0, 8); // 存储方式 = store
      head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); // 时间/日期
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(e.buf.length, 18); head.writeUInt32LE(e.buf.length, 22);
      head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
      chunks.push(head, nameBuf, e.buf);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10); c.writeUInt16LE(0x21, 12);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(e.buf.length, 20); c.writeUInt32LE(e.buf.length, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt32LE(0, 30); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt16LE(0, 38);
      c.writeUInt32LE(0, 40); c.writeUInt32LE(offset, 42);
      central.push(c, nameBuf);
      offset += 30 + nameBuf.length + e.buf.length;
    }
    let cdSize = 0; for (const b of central) cdSize += b.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, ...central, eocd]);
  }

  // 拆分记录整包下载：底图 + 全部图层打成一个 ZIP
  app.get('/api/ai/job/:id/zip', authUser, (req, res) => {
    const j = loadJobs().find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j || j.status !== 'done' || j.kind !== 'split') return res.status(404).json({ ok: false, error: '记录不存在或未完成的拆分' });
    const entries = (j.candidates || []).map(i => {
      const f = path.join(AI_DIR, j.id, `c${i}.png`);
      if (!fs.existsSync(f)) return null;
      const meta = (j.layers || []).find(l => l.i === i);
      const raw = ((meta ? meta.name : (i === 0 ? '底图-背景' : `图层${i}`)).replace(/[\\/:*?"<>|\s]/g, '') || `图层${i}`).slice(0, 40);
      return { name: `${String(i).padStart(2, '0')}-${raw}.png`, buf: fs.readFileSync(f) };
    }).filter(Boolean);
    if (!entries.length) return res.status(404).json({ ok: false, error: '图层文件缺失' });
    logLine('ai-op', `zip download user=${req.user.name} job=${j.id.slice(0, 8)} files=${entries.length}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('OneFig-layers-' + j.id.slice(0, 8) + '.zip')}`);
    res.send(buildZip(entries));
  });

  // ---- 删除一条生成记录（2026-10-22 按反馈：卡片悬停删除，需弹窗确认）----
  // 记录与结果文件一并删除，不可恢复；只能删自己的
  app.delete('/api/ai/job/:id', authUser, (req, res) => {
    const jobs = loadJobs();
    const j = jobs.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j) return res.status(404).json({ ok: false, error: '记录不存在' });
    saveJobs(jobs.filter(x => x.id !== j.id));
    fs.rmSync(path.join(AI_DIR, j.id), { recursive: true, force: true });
    logLine('ai-op', `record delete user=${req.user.name} kind=${j.kind || 'gen'} prompt="${j.prompt.slice(0, 40)}"`);
    res.json({ ok: true });
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

  // 拆分原图预览（2026-10-22）：生成结果区主图显示拆分前的大图
  app.get('/api/ai/job/:id/orig', authUser, (req, res) => {
    const j = loadJobs().find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!j || j.kind !== 'split') return res.status(404).json({ ok: false });
    const f = path.join(AI_DIR, j.id, 'orig.png');
    if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', 'image/png');
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

  // ---- 积分购买：已全部走在线支付（pay.js creditPkg），人工转账下单/通知接口 2026-10-26 下线 ----
  app.get('/api/ai/my/credit-orders', authUser, (req, res) => {
    res.json({ ok: true, list: loadCO().filter(o => o.userId === req.user.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
  });

  // ---- 后台：积分订单管理（只读）+ 手工调积分 ----
  app.get('/console/api/credit-orders', consoleAuth, (req, res) => {
    let list = loadCO();
    if (req.query.status) list = list.filter(o => req.query.status.split(',').includes(o.status));
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ ok: true, list });
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
// 生成大图定价与试用次数（server.js 注入 status 用）
module.exports.BIG = { COST: BIG_COST, FREE: BIG_FREE };
// 图层拆分单价（server.js 注入 status 用）
module.exports.SPLIT = { COST: SPLIT_COST };
