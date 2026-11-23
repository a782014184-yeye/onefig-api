import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';
import bounds from 'svg-path-bounds';
import { generateGptsImage } from './gptsapi.mjs';

const MODEL = process.env.ONEFIG_REFERENCE_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628';
const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 1)); fs.renameSync(temp, file); };
const clean = (value, max = 4000) => String(value || '').trim().slice(0, max);

const STYLE_PROMPTS = {
  matte: '柔和的二维科研插画，细腻哑光渐变，低饱和紫粉橙配色，轮廓圆润干净，不要照片感，不要文字',
  flat: '发表级扁平矢量科研插画，封闭清晰轮廓，色块平涂，低饱和配色，少量柔和渐变，不要文字，不要水印',
  threed: '精致柔和的 3D 科研插画，材质细腻，光线柔和，主体结构科学准确，干净背景，不要文字，不要水印',
};
const BIG = {
  cover: { size: '1728x2304', rule: '竖版期刊封面，构图大气，有明确视觉中心和空间层次' },
  abstract: { size: '2560x1440', rule: '横版论文摘要图，研究逻辑一眼看懂，画面完整精致' },
  mechanism: { size: '2304x1728', rule: '横版科研机制图，分子、细胞器和细胞层级清晰，箭头关系简洁准确，不要流程框堆砌' },
};
const bigTypeSize = type => type === 'cover' ? '1024x1536' : type === 'mechanism' || type === 'abstract' ? '1536x1024' : '1024x1024';

async function callArk({ prompt, key, image, size, split = false }) {
  const body = { model: MODEL, prompt, size: split ? 'auto' : size, response_format: 'b64_json', watermark: false };
  if (image) body.image = [image];
  if (split) body.layer_decomposition = true;
  const response = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data?.data) || !data.data.length) throw new Error(data?.error?.message || data?.message || 'AI 图像服务生成失败');
  return data.data;
}

async function fallbackRemoveBackground(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const corners = [0, (w - 1) * 4, w * (h - 1) * 4, (w * h - 1) * 4];
  const br = corners.reduce((sum, i) => sum + data[i], 0) / 4;
  const bg = corners.reduce((sum, i) => sum + data[i + 1], 0) / 4;
  const bb = corners.reduce((sum, i) => sum + data[i + 2], 0) / 4;
  const tolerance = 42 * 42 * 3;
  const isBackground = pixel => {
    const i = pixel * 4;
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db < tolerance;
  };
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let x = 0; x < w; x += 1) { stack[sp++] = x; stack[sp++] = w * (h - 1) + x; }
  for (let y = 0; y < h; y += 1) { stack[sp++] = w * y; stack[sp++] = w * y + w - 1; }
  while (sp > 0) {
    const pixel = stack[--sp];
    if (visited[pixel] || !isBackground(pixel)) continue;
    visited[pixel] = 1;
    data[pixel * 4 + 3] = 0;
    const x = pixel % w, y = Math.floor(pixel / w);
    if (x > 0) stack[sp++] = pixel - 1;
    if (x < w - 1) stack[sp++] = pixel + 1;
    if (y > 0) stack[sp++] = pixel - w;
    if (y < h - 1) stack[sp++] = pixel + w;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

async function removeBackground(buffer, mime) {
  try {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime || 'image/png' }), 'image.png');
    const response = await fetch('http://127.0.0.1:9000/remove-bg', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('本地抠图服务不可用');
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return fallbackRemoveBackground(buffer);
  }
}

async function traceSvg(buffer) {
  const { data, info } = await sharp(buffer).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const svg = ImageTracer.imagedataToSVG(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    { numberofcolors: 24, colorquantcycles: 3, colorsampling: 2, ltres: 2.5, qtres: 2.5, pathomit: 40, rightangleenhance: true, strokewidth: 0, blurradius: 1, blurdelta: 32, roundcoords: 1, viewbox: true, desc: false },
  );
  return svg.replace(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/g, (match, d) => {
    try {
      const [x0, y0, x1, y1] = bounds(d);
      return x1 - x0 <= 12 && y1 - y0 <= 12 && (x1 - x0) * (y1 - y0) <= 144 ? '' : match;
    } catch { return match; }
  });
}

export function registerWorkshopRoutes(app, { root, readKey, readGptsKey, upload, charge }) {
  const dir = path.join(root, 'data/workshop');
  const indexFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });

  app.use('/workshop-files', (req, res, next) => {
    const parts = req.path.split('/').filter(Boolean).map(part => path.basename(part));
    if (parts.length !== 2) return next();
    const file = path.join(dir, parts[0], parts[1]);
    if (!fs.existsSync(file)) return next();
    res.sendFile(file);
  });

  function record(kind, prompt, files, provider = 'seedream', userId = '') {
    const id = crypto.randomUUID();
    const jobDir = path.join(dir, id);
    fs.mkdirSync(jobDir, { recursive: true });
    const saved = files.map(file => {
      if (file.url) return { name: file.label || file.name, url: file.url, ext: file.ext || 'png' };
      const filename = `${file.name}.${file.ext || 'png'}`;
      fs.writeFileSync(path.join(jobDir, filename), file.data);
      return { name: file.label || file.name, url: `/workshop-files/${id}/${filename}`, ext: file.ext || 'png' };
    });
    const job = { id, userId, kind, provider, prompt: clean(prompt, 500), createdAt: new Date().toISOString(), files: saved };
    const jobs = readJson(indexFile, []);
    jobs.unshift(job);
    saveJson(indexFile, jobs.slice(0, 100));
    return job;
  }

  const requireKey = () => {
    const key = readKey();
    if (!key) throw Object.assign(new Error('尚未配置火山方舟 API Key'), { status: 503 });
    return key;
  };
  const fail = (res, error) => {
    console.error('[workshop]', error);
    res.status(error?.status || 502).json({ ok: false, error: clean(error?.message || 'AI 处理失败，请重试', 300) });
  };
  const imageData = file => `data:${file.mimetype || 'image/png'};base64,${file.buffer.toString('base64')}`;

  app.get('/api/ai/workshop/jobs', (req, res) => res.json({ ok: true, jobs: readJson(indexFile, []).filter(job => job.userId === req.user.id) }));

  app.post('/api/ai/workshop/record', (req, res) => {
    const kind = ['gen', 'big', 'edit', 'style', 'nobg', 'vec', 'split', 'soul'].includes(req.body?.kind) ? req.body.kind : 'gen';
    const provider = clean(req.body?.provider || 'seedream', 60);
    const files = (Array.isArray(req.body?.files) ? req.body.files : []).slice(0, 12).filter(file => {
      const url = String(file?.url || '');
      return /^\/(references|vectors|vector-scenes|soul-svg|workshop-files)\//.test(url) && ['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(String(file?.ext || '').toLowerCase());
    }).map(file => ({
      name: `linked-${crypto.randomUUID()}`, label: clean(file?.name || '生成结果', 80),
      url: file.url, ext: String(file.ext).toLowerCase(),
    }));
    if (!files.length) return res.status(400).json({ ok: false, error: '没有可保存的生成结果' });
    res.json({ ok: true, job: record(kind, req.body?.prompt || '科研图生成', files, provider, req.user.id) });
  });

  app.post('/api/ai/workshop/generate', charge('gen'), async (req, res) => {
    try {
      const provider = ['seedream', 'gpt-image', 'gemini-image'].includes(req.body?.provider) ? req.body.provider : 'seedream';
      const kind = BIG[req.body?.bigType] ? 'big' : 'gen';
      const prompt = clean(req.body?.prompt);
      if (prompt.length < 4) return res.status(400).json({ ok: false, error: '请至少输入 4 个字的生成描述' });
      const style = STYLE_PROMPTS[req.body?.style] ? req.body.style : 'matte';
      const big = kind === 'big' ? BIG[req.body.bigType] : null;
      const fullPrompt = big
        ? `${prompt}。${big.rule}。${STYLE_PROMPTS[style]}，画面中没有水印。`
        : `${prompt}。单个科研素材，科学形态准确，主体完整居中，四周留白，纯白背景。${STYLE_PROMPTS[style]}`;
      let buffer;
      if (provider === 'seedream') {
        const items = await callArk({ prompt: fullPrompt, key: requireKey(), size: big?.size || '1728x1728' });
        buffer = Buffer.from(items[0].b64_json, 'base64');
      } else {
        const gptSize = bigTypeSize(req.body?.bigType);
        const aspectRatio = req.body?.bigType === 'cover' ? '3:4' : req.body?.bigType === 'mechanism' ? '4:3' : req.body?.bigType === 'abstract' ? '16:9' : '1:1';
        const result = await generateGptsImage({ provider, prompt: fullPrompt, key: readGptsKey(), size: gptSize, aspectRatio, quality: 'high' });
        buffer = result.buffer;
      }
      if (req.body?.transparent) buffer = await removeBackground(buffer, 'image/png');
      else buffer = await sharp(buffer).png().toBuffer();
      res.json({ ok: true, job: record(kind, prompt, [{ name: 'c0', label: kind === 'big' ? '生成大图' : '生成素材', data: buffer }], provider, req.user.id) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/ai/workshop/edit', upload.single('image'), charge('edit'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请先上传要修改的图片' });
      const prompt = clean(req.body?.prompt);
      if (!prompt) return res.status(400).json({ ok: false, error: '请填写修改要求' });
      const items = await callArk({ prompt: `${prompt}。保持科研内容准确和原图主体布局，输出精致完整的科研插画，不要添加文字或水印。`, key: requireKey(), image: imageData(req.file), size: '2560x1440' });
      let buffer = Buffer.from(items[0].b64_json, 'base64');
      if (req.body?.transparent === '1' || req.body?.transparent === 'true') buffer = await removeBackground(buffer, 'image/png');
      else buffer = await sharp(buffer).png().toBuffer();
      res.json({ ok: true, job: record('edit', prompt, [{ name: 'c0', label: 'AI 改图', data: buffer }], 'seedream', req.user.id) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/ai/workshop/style', upload.single('image'), charge('style'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请先上传要转换的图片' });
      const style = STYLE_PROMPTS[req.body?.style] ? req.body.style : 'flat';
      const items = await callArk({ prompt: `保持原图科研主体、组成和相对位置不变，将视觉风格重绘为：${STYLE_PROMPTS[style]}。不要增加或减少关键科研实体，不要文字或水印。`, key: requireKey(), image: imageData(req.file), size: '2560x1440' });
      let buffer = Buffer.from(items[0].b64_json, 'base64');
      if (req.body?.transparent === '1' || req.body?.transparent === 'true') buffer = await removeBackground(buffer, 'image/png');
      else buffer = await sharp(buffer).png().toBuffer();
      res.json({ ok: true, job: record('style', `风格转换：${style}`, [{ name: 'c0', label: '风格转换', data: buffer }], 'seedream', req.user.id) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/ai/workshop/remove-bg', upload.single('image'), charge('nobg'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请先上传图片' });
      const buffer = await removeBackground(req.file.buffer, req.file.mimetype);
      res.json({ ok: true, job: record('nobg', '移除背景', [{ name: 'c0', label: '透明底 PNG', data: buffer }], 'local', req.user.id) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/ai/workshop/vectorize', upload.single('image'), charge('vec'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请先上传图片' });
      const svg = await traceSvg(req.file.buffer);
      res.json({ ok: true, job: record('vec', '位图转矢量', [{ name: 'c0', label: '矢量 SVG', data: Buffer.from(svg), ext: 'svg' }], 'local', req.user.id) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/ai/workshop/split', upload.single('image'), charge('split'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请先上传要拆分的图片' });
      const instruction = clean(req.body?.instruction, 500) || '将图片精确拆分为独立科研实体图层，保留底图，各实体完整、边缘清晰、互不遮挡';
      const items = await callArk({ prompt: instruction, key: requireKey(), image: imageData(req.file), split: true });
      const layers = items.slice(1).sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
      const files = [{ name: 'c0', label: '底图', data: await sharp(Buffer.from(items[0].b64_json, 'base64')).png().toBuffer() }];
      for (const [index, layer] of layers.entries()) {
        files.push({ name: `c${index + 1}`, label: clean(layer.name, 60) || `图层 ${index + 1}`, data: Buffer.from(layer.b64_json, 'base64') });
      }
      res.json({ ok: true, job: record('split', instruction, files, 'seedream', req.user.id) });
    } catch (error) { fail(res, error); }
  });
}
