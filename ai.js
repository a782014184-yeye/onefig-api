// OneFig AI 工坊：积分体系 + Seedream 生图流水线（供应商解耦：只认 generate() 适配器）
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { inspectTransparency, removeBackgroundWithRetry } = require('./transparency');
const { buildRembgMultipart } = require('./rembg-multipart');
// 2026-11-13 阶段1：像素级图像算法迁入 image-ops.js，经 worker 线程池执行（主进程零阻塞）
const imageOps = require('./image-ops');

// 2026-10-21：默认模型升 Seedream 5.0 Pro（准确率代际提升），尺寸 2048² → 1536²
// （1536×1536 = 236 万像素 ≤ 261 万，卡在 0.30 元/张档；2048² 会跳进 0.60 元档）
// 均可环境变量覆盖：ARK_MODEL / ARK_SIZE
const MODEL = process.env.ARK_MODEL || 'doubao-seedream-5-0-pro-260628';
const SIZE = process.env.ARK_SIZE || '1728x1728'; // 生成素材出图尺寸（2026-10-22 按反馈升高清档 1728²=298 万像素 >261 万，单价 0.60 元/张）
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const CANDIDATES = 1; // 每次生成 = 1 张候选 = 30 积分（Seedream 5.0 Pro 1728² 成本 0.60 元/张，定价 3 元/张，毛利约 80%）；不满意再生成再扣 30 积分，无免费重抽
const COST = 30; // 每次生成消耗积分（2026-10-22 晚按反馈调价 10→30）
const GEN_FREE = Math.max(0, Number(process.env.ONEFIG_AI_GEN_FREE ?? 1)); // 生成素材每人免费试用次数（2026-10-21 按反馈：1 次终身，与改图/风格转换同记 users.aiFreeUsed；0 = 纯积分制）
const MATTE_MAX_ATTEMPTS = 1; // 每个任务只生图 1 次、同图本地去背景也只执行 1 次，不自动重试
// 2026-11-12：当前 2 核 4G 小服务器先用全局队列保稳定；不升级配置时默认只同时跑 1 个重任务。
const GEN_WORKERS = Math.max(1, Number(process.env.ONEFIG_AI_GEN_WORKERS ?? 1));
const GEN_JOB_TIMEOUT_MS = Math.max(1000, Number(process.env.ONEFIG_AI_GEN_TIMEOUT_MS ?? 5 * 60 * 1000));
const GEN_BACKGROUND_RULE = '背景要求（覆盖前述背景描述）：使用均匀纯白背景，不要透明底棋盘格、灰白方格、纹理、渐变、地面或投影；主体完整居中，四周保留充足空白。透明化由后续抠图步骤完成。';

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
    const assembled = P.genTmpl
      .split('{topic}').join(topic)
      .split('{styleSuffix}').join(P.styleSuffix[style] || P.styleSuffix.matte || '')
      .split('{scienceRules}').join(P.scienceRules || '')
      .split('{cellColorRules}').join(cellular ? (P.cellColorRules || '') : '');
    // 兼容后台已保存的旧模板：生图阶段只画纯白底，避免模型把“透明背景”画成棋盘格。
    return assembled.replace(/透明背景|透明底|transparent\s+background/gi, '纯白背景') + GEN_BACKGROUND_RULE;
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
      const stuck = jobs.filter(j => j.status === 'running' || j.status === 'queued');
      if (!stuck.length) return;
      const users = loadUsers();
      let usersDirty = false;
      for (const j of stuck) {
        j.status = 'failed';
        j.error = '生成排队中断（服务维护），已自动退还';
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

  // 2026-11-12 全局 AI 生成队列：不升级服务器时，先把重任务限制为串行，避免多人同时生成把整台机器压死。
  let activeGenJobs = 0;
  const cancelledGenJobs = new Set();

  const refundJob = (j) => {
    const users = loadUsers();
    const u = users.find(x => x.id === j.userId);
    if (!u) return false;
    let dirty = false;
    if (j.paidWith === 'credit') { u.credits = (u.credits || 0) + (j.cost || COST); dirty = true; }
    else if (j.paidWith === 'free' && u.aiFreeUsed) {
      const key = j.kind === 'big' ? 'big' : 'gen';
      u.aiFreeUsed[key] = Math.max(0, (u.aiFreeUsed[key] || 0) - 1);
      dirty = true;
    }
    if (dirty) saveUsers(users);
    return dirty;
  };

  const failActiveJob = (jobId, error) => {
    const jobs = loadJobs();
    const j = jobs.find(x => x.id === jobId);
    if (!j || j.status !== 'running') return;
    j.status = 'failed';
    j.error = error;
    j.finishedAt = new Date().toISOString();
    cancelledGenJobs.add(jobId);
    const refunded = refundJob(j);
    saveJobs(jobs);
    logLine('ai-op', `job timeout/fail id=${jobId.slice(0, 8)} refund=${refunded ? 'yes' : 'no'} error=${error}`);
  };

  const genQueuePosition = (jobs, job) => {
    if (job.status !== 'queued') return 0;
    const queued = jobs
      .filter(j => j.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const idx = queued.findIndex(j => j.id === job.id);
    return idx >= 0 ? idx + 1 : queued.length + 1;
  };

  const launchGenJob = (job, runner) => {
    activeGenJobs += 1;
    const timer = setTimeout(() => {
      failActiveJob(job.id, `生成超时（${Math.round(GEN_JOB_TIMEOUT_MS / 60000)} 分钟），已自动退还`);
    }, GEN_JOB_TIMEOUT_MS);
    timer.unref?.();
    Promise.resolve()
      .then(() => runner(job))
      .catch((e) => failActiveJob(job.id, e?.message || '生成中断，已自动退还'))
      .finally(() => {
        clearTimeout(timer);
        cancelledGenJobs.delete(job.id);
        activeGenJobs = Math.max(0, activeGenJobs - 1);
        setImmediate(pumpGenQueue);
      });
  };

  function pumpGenQueue() {
    while (activeGenJobs < GEN_WORKERS) {
      const jobs = loadJobs();
      const next = jobs
        .filter(j => j.status === 'queued')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (!next) return;
      const runner = runnerByJobId.get(next.id);
      if (!runner) return;
      runnerByJobId.delete(next.id);
      next.status = 'running';
      next.startedAt = new Date().toISOString();
      saveJobs(jobs);
      logLine('ai-op', `job start id=${next.id.slice(0, 8)} user=${next.userId} queuedBehind=${Math.max(0, activeGenJobs)}`);
      launchGenJob(next, runner);
    }
  }

  // runner 不能序列化到 jobs.json，用进程内映射保存；服务重启后 recover 会把 running 退掉，queued 重新 pump。
  const runnerByJobId = new Map();
  const enqueueGenJob = (job, runner) => {
    const jobs = loadJobs();
    const canRun = activeGenJobs < GEN_WORKERS && !jobs.some(j => j.status === 'running');
    job.status = canRun ? 'running' : 'queued';
    if (canRun) job.startedAt = new Date().toISOString();
    jobs.unshift(job);
    saveJobs(jobs);
    runnerByJobId.set(job.id, runner);
    const queuePosition = genQueuePosition(loadJobs(), job);
    if (canRun) {
      logLine('ai-op', `job start id=${job.id.slice(0, 8)} user=${job.userId} immediate=true`);
      launchGenJob(job, runner);
    } else {
      logLine('ai-op', `job queued id=${job.id.slice(0, 8)} user=${job.userId} position=${queuePosition}`);
      setImmediate(pumpGenQueue);
    }
    return queuePosition;
  };

  setImmediate(pumpGenQueue);

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
  // ---- 洪泛抠底 / 明暗判定 / 选择性并集 / ensurePng：2026-11-13 阶段1 迁入 image-ops.js ----
  // 生产路径经 imageOps.run() 在 worker 线程执行（主进程零阻塞）；
  // 同步实现仍通过 module.exports 暴露给测试与运维脚本（同一份代码）。
  function rembgTransparent(buf, model) {
    return new Promise((resolve, reject) => {
      const { boundary, body } = buildRembgMultipart(buf, model, 'gen.png');
      const req = require('http').request({
        host: '127.0.0.1', port: 9000, path: '/remove-bg', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
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
      req.end(body);
    });
  }
  // ---- 阶段2：整条透明底流水线下沉 rembg 服务 /matte-full（numpy 一次完成，~0.5s）----
  // 优先远程；端点不存在/服务不可达时回退本地 JS 流水线（matteImageLocal，image-ops worker 执行）。
  function matteFullRemote(buf, model) {
    return new Promise((resolve, reject) => {
      const { boundary, body } = buildRembgMultipart(buf, model, 'gen.png', { max_side: 1536 });
      const req = require('http').request({
        host: '127.0.0.1', port: 9000, path: '/matte-full', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
        timeout: 150000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200 && chunks.length) return resolve(Buffer.concat(chunks));
          if (res.statusCode === 503) {
            const error = new Error('本地 AI 抠图模型暂时不可用，请稍后重试（本次不扣积分）');
            error.code = 'MATTE_MODEL_UNAVAILABLE';
            return reject(error);
          }
          const e = new Error('matte-full ' + res.statusCode);
          if (res.statusCode === 404) e.code = 'MATTE_FULL_UNSUPPORTED'; // 旧版服务：回退本地流水线
          reject(e);
        });
      });
      req.on('timeout', () => req.destroy(new Error('matte-full 超时')));
      req.on('error', (e) => { e.code = e.code || 'MATTE_FULL_UNSUPPORTED'; reject(e); });
      req.end(body);
    });
  }
  async function matteImage(buf, attempt = 1) {
    const retry = attempt > 1;
    const modelName = retry ? 'general' : 'anime';
    try {
      const out = await matteFullRemote(buf, modelName);
      logLine('ai-op', `matte-full remote ok attempt=${attempt} model=${modelName} bytes=${out.length}`);
      return out;
    } catch (e) {
      if (e && e.code === 'MATTE_MODEL_UNAVAILABLE') throw e; // 与本地语义一致：禁止洪泛单路交付
      logLine('ai-op', `matte-full 不可用/异常（${e && e.message}），回退本地流水线 attempt=${attempt}`);
      return matteImageLocal(buf, attempt);
    }
  }
  async function matteImageLocal(buf, attempt = 1) {
    // 第一次沿用“anime 模型 ∪ 洪泛”保住细丝、浅色边缘和纯白主体；不合格时
    // 第二次复用同一张原图，改用普通移除背景功能已在用的 general 模型。
    // 全程只调用本地抠图服务，不会再次请求生图供应商。
    // 2026-11-13 阶段1：洪泛(13) 与 rembg 并行起跑（原串行 await 白白多花约 1 秒；
    // 深色主体判定依赖模型结果，确为深色再按 85 容差重跑洪泛，结果与原实现一致）；
    // 洪泛/并集/边缘/质检全部经 imageOps 线程池执行，主进程事件循环零阻塞。
    const retry = attempt > 1;
    const modelName = retry ? 'general' : 'anime';
    let modelBuf = null, floodBuf = null;
    const floodSoft = () => imageOps.run('floodMatte', buf, 13).catch(e => { logLine('ai-op', 'flood-matte 不适用（' + e.message + '）'); return null; });
    const floodLightP = floodSoft();
    try { modelBuf = await rembgTransparent(buf, retry ? undefined : 'anime'); }
    catch (e) { logLine('ai-op', `${modelName} 模型不可用：` + e.message); }
    const darkSubject = modelBuf ? await imageOps.run('isDarkSubject', modelBuf, buf) : false;
    if (darkSubject) {
      floodBuf = await imageOps.run('floodMatte', buf, 85).catch(e => { logLine('ai-op', 'flood-matte 不适用（' + e.message + '）'); return null; });
      logLine('ai-op', 'transparency dark subject: flood tolerance=85');
    } else {
      floodBuf = await floodLightP;
    }
    // 洪泛只用于补充模型边缘，不能在模型失败时单独交付：白色/浅色主体会被挖空。
    if (!modelBuf) {
      const error = new Error('本地 AI 抠图模型暂时不可用，请稍后重试（本次不扣积分）');
      error.code = 'MATTE_MODEL_UNAVAILABLE';
      throw error;
    }
    const unionJobs = [];
    if (!retry) {
      if (floodBuf) unionJobs.push({ name: 'anime-union', p: imageOps.run('alphaUnion', modelBuf, floodBuf, buf, darkSubject) });
      unionJobs.push({ name: 'anime', p: Promise.resolve(modelBuf) });
    } else {
      unionJobs.push({ name: 'general', p: Promise.resolve(modelBuf) });
      if (floodBuf) unionJobs.push({ name: 'general-union', p: imageOps.run('alphaUnion', modelBuf, floodBuf, buf, darkSubject) });
    }
    const resolved = await Promise.all(unionJobs.map(j => j.p));
    const candidates = unionJobs.map((j, i) => ({ name: j.name, buf: resolved[i] }));
    const cleanedList = await Promise.all(candidates.map(async (candidate) => {
      try {
        const cleaned = await imageOps.run('cleanEdge', buf, candidate.buf);
        const report = await imageOps.run('inspectTransparency', cleaned);
        return { candidate, cleaned, report, err: null };
      } catch (e) { return { candidate, cleaned: null, report: null, err: e }; }
    }));
    for (const { candidate, cleaned, report, err } of cleanedList) {
      if (err) { logLine('ai-op', `transparency matte invalid=${candidate.name} ${err.message}`); continue; }
      if (report.ok) {
        logLine('ai-op', `transparency matte selected=${candidate.name} attempt=${attempt} borderOpaque=${report.borderOpaqueRatio.toFixed(4)}`);
        return cleaned;
      }
    }
    return imageOps.run('cleanEdge', buf, candidates[0].buf);
  }

  async function runJob(job) {
    const dir = path.join(AI_DIR, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const saveDiagnostic = (name, data) => {
      try { fs.writeFileSync(path.join(dir, name), data); }
      catch (e) { logLine('ai-op', `diagnostic save failed job=${job.id} file=${name} ${e.message}`); }
    };
    const isBig = !!job.bigType;
    let prompt, size;
    if (isBig) ({ prompt, size } = buildBigPrompt(job.prompt, job.bigType));
    else { prompt = buildGenPrompt(job.prompt, job.style); size = undefined; }
    const results = [];
    for (let i = 0; i < CANDIDATES; i++) {
      try {
        let out;
        if (!job.transparent) {
          // 默认直接交付生图原图（白底），不再自动做本地透明底重处理；需要透明底时可单独移除。
          out = await imageOps.run('ensurePng', await generateImage(prompt, size));
        } else {
          // 生图只在透明候选开始时调用一次；后续重试全部复用这份原图。
          const source = await generateImage(prompt, size);
          saveDiagnostic(`source-c${i}.png`, await imageOps.run('ensurePng', source));
          const checked = await removeBackgroundWithRetry({
            source,
            maxAttempts: MATTE_MAX_ATTEMPTS,
            matte: matteImage,
            onRejected: ({ attempt, output, report }) => {
              saveDiagnostic(`rejected-c${i}-a${attempt}.png`, output);
              logLine('ai-op', `transparency QC rejected job=${job.id} candidate=${i} attempt=${attempt} reasons=${(report.reasons || []).join(',')} borderOpaque=${Number(report.borderOpaqueRatio || 0).toFixed(4)} opaque=${Number(report.opaqueRatio || 0).toFixed(4)}`);
            },
          });
          out = checked.output;
          saveDiagnostic(`qc-c${i}.json`, JSON.stringify(checked.attempts, null, 1));
          logLine('ai-op', `transparency QC passed job=${job.id} candidate=${i} localMatteAttempts=${checked.attempts.length} borderOpaque=${checked.report.borderOpaqueRatio.toFixed(4)}`);
        }
        const f = path.join(dir, `c${i}.png`);
        fs.writeFileSync(f, out);
        results.push({ i, ok: true, size: out.length });
      } catch (e) {
        if (e.code === 'TRANSPARENCY_QC_FAILED') saveDiagnostic(`qc-c${i}.json`, JSON.stringify(e.attempts || [], null, 1));
        results.push({ i, ok: false, err: e.message });
      }
    }
    const jobs = loadJobs();
    const j = jobs.find(x => x.id === job.id);
    if (!j) return;
    // 超时守护可能已把任务标记为失败并退款；后台 runner 晚到一步时不得覆盖该结果。
    if (cancelledGenJobs.has(job.id) || j.status !== 'running') return;
    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      j.status = 'failed';
      j.error = results[0] && results[0].err;
      refundJob(j);
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
    try { fs.writeFileSync(path.join(dir, 'orig.png'), await imageOps.run('ensurePng', imgBuf)); } catch {}
    try {
      const items = await arkSplitLayers(imgBuf, job.prompt);
      // data[0] 底图 → c0.png；图层按 z_index 从底到顶 → c1..cN.png
      fs.writeFileSync(path.join(dir, 'c0.png'), await imageOps.run('ensurePng', Buffer.from(items[0].b64, 'base64')));
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
      if (cancelledGenJobs.has(job.id) || j.status !== 'running') return;
      j.status = 'done';
      j.candidates = [0, ...layers.map(l => l.i)];
      j.layers = layers;
      j.finishedAt = new Date().toISOString();
      saveJobs(jobs);
      logLine('ai-op', `split done user=${(loadUsers().find(x => x.id === job.userId) || {}).name || job.userId} layers=${layers.length} cost=${job.cost}`);
    } catch (e) {
      const jobs = loadJobs();
      const j = jobs.find(x => x.id === job.id);
      if (!j) return;
      if (cancelledGenJobs.has(job.id) || j.status !== 'running') return;
      j.status = 'failed';
      j.error = e.message;
      j.finishedAt = new Date().toISOString();
      refundJob(j);
      saveJobs(jobs);
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
        if (jobs.some(j => j.userId === u.id && (j.status === 'running' || j.status === 'queued'))) {
          u.credits += SPLIT_COST;
          saveUsers(users);
          return res.status(429).json({ ok: false, error: '你已有生成任务在排队或处理中，等它完成后再试～' });
        }
        const job = { id: crypto.randomUUID(), userId: u.id, prompt: instruction, kind: 'split', status: 'queued', candidates: [], picked: null, paidWith: 'credit', cost: SPLIT_COST, createdAt: new Date().toISOString() };
        saveUsers(users);
        logLine('ai-op', `split submit user=${u.name} src=${srcDesc} cost=${SPLIT_COST}`);
        const queuePosition = enqueueGenJob(job, j => runSplitJob(j, imgBuf));
        res.json({ ok: true, jobId: job.id, credits: u.credits, status: job.status, queuePosition });
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
      const transparent = !!((req.body || {}).transparent); // 默认不自动移除背景；需要透明底时再显式开启（2026-11-13）
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

      // 每用户同时只能有 1 个进行中/排队中的任务；全局任务再进队列，避免多人同时压满小服务器。
      const jobs = loadJobs();
      if (jobs.some(j => j.userId === u.id && (j.status === 'running' || j.status === 'queued'))) {
        if (paidWith === 'free') fu[freeKey] = Math.max(0, (fu[freeKey] || 0) - 1); else u.credits += cost;
        saveUsers(users);
        return res.status(429).json({ ok: false, error: '你已有生成任务在排队或处理中，等它完成后再试～' });
      }

      const job = { id: crypto.randomUUID(), userId: u.id, prompt, style: bigType ? undefined : style, bigType, transparent, kind: bigType ? 'big' : 'gen', status: 'queued', candidates: [], picked: null, paidWith, cost, createdAt: new Date().toISOString() };
      saveUsers(users);
      logLine('ai-op', `generate submit user=${u.name} kind=${bigType ? 'big' : 'gen'} bigType=${bigType || '-'} prompt="${prompt.slice(0, 40)}" style=${style} paidWith=${paidWith} cost=${paidWith === 'credit' ? cost : 0}`);
      const queuePosition = enqueueGenJob(job, j => runJob(j));
      res.json({ ok: true, jobId: job.id, paidWith, status: job.status, queuePosition });
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
  module.exports.floodMatte = imageOps.floodMatte; // 供合成测试与运维排障直接调用（同步实现，同一份代码）
  module.exports.alphaUnion = imageOps.alphaUnion; // 验证低反差地面不会再被洪泛并回
  module.exports.isDarkSubject = imageOps.isDarkSubject; // 深色主体自适应洪泛阈值测试
  module.exports.buildGenPrompt = buildGenPrompt; // 验证旧后台模板也会被强制改为纯白生图背景
  module.exports.inspectTransparency = inspectTransparency;

  // ---- 我的任务列表（含全站排队位置，便于前端展示“当前第几位”） ----
  app.get('/api/ai/jobs', authUser, (req, res) => {
    const all = loadJobs();
    const list = all.filter(j => j.userId === req.user.id)
      .map(j => ({ id: j.id, kind: j.kind || 'gen', bigType: j.bigType, transparent: j.transparent, layers: j.layers, prompt: j.prompt, style: j.style, ext: j.ext || 'png', status: j.status, candidates: j.candidates, picked: j.picked, createdAt: j.createdAt, error: j.error, queuePosition: genQueuePosition(all, j) }));
    res.json({ ok: true, list, genWorkers: GEN_WORKERS });
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
    if (j.status === 'running' || j.status === 'queued') return res.status(400).json({ ok: false, error: '任务进行中，暂时不能删除' });
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
