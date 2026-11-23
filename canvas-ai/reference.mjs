import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { jsonrepair } from 'jsonrepair';
import { generateGptsImage } from './gptsapi.mjs';
import { readGenerationPrompt } from './prompt-store.mjs';

const IMAGE_MODEL = process.env.ONEFIG_REFERENCE_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628';
const VISION_MODEL = process.env.ONEFIG_DIAGRAM_MODEL || 'doubao-seed-2-1-pro-260915';
const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');

function buildGenerationPrompt(prompt, file, root, visualStyle = 'flat') {
  const lang = /[\u4e00-\u9fff]/.test(prompt) ? 'Chinese' : 'English';
  const generationPrompt = readGenerationPrompt(root);
  const styleRule = visualStyle === 'matte'
    ? '视觉风格补充：采用柔和哑光的 OneFig 科研插画风，细腻但克制，保持主体与机制关系清晰。'
    : visualStyle === 'threed'
      ? '视觉风格补充：采用精致柔和的 3D 科研立体质感，保持原有布局和实体结构，不改变科研内容。'
      : '视觉风格补充：严格采用扁平矢量插画风，色块清晰、硬边、无渐变、无阴影、无纹理。';
  return `${generationPrompt.replaceAll('{{lang}}', lang)}\n\n用户提供的文字内容：\n${prompt || '请主要依据随附参考图生成完整科研示意图。'}\n\n${styleRule}\n\n${file ? '同时结合随本次请求上传的参考图，保留其中有用的科研实体和机制关系，但按上述要求重新绘制。' : ''}`;
}
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const SHAPES = new Set(['roundRect', 'ellipse', 'circle', 'capsule', 'diamond', 'hexagon', 'cylinder']);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 1)); fs.renameSync(temp, file); };

function sniff(buffer) {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return 'image/png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return 'image/jpeg';
  if (buffer?.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  return '';
}
function parseJson(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { /* 提取对象 */ }
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('视觉模型没有返回有效的实体坐标');
  try { return JSON.parse(jsonrepair(raw.slice(start, end + 1))); }
  catch (error) {
    console.error('[reconstruct-json]', raw.slice(0, 3000));
    throw error;
  }
}
function normalizeScene(raw) {
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length < 3) throw new Error('识别到的有效科研实体不足');
  const source = raw.nodes.slice(0, 20);
  const idMap = new Map();
  const nodes = source.map((node, index) => {
    const oldId = clean(node?.id, 40) || `n${index + 1}`;
    const id = `n${index + 1}`; idMap.set(oldId, id); idMap.set(id, id);
    const kind = ['material', 'shape', 'text'].includes(node?.kind) ? node.kind : 'material';
    const defaultSize = kind === 'material' ? 0.15 : 0.2;
    return {
      id, label: clean(node?.label, 48) || `实体 ${index + 1}`,
      detail: clean(node?.detail, 80), stage: '',
      kind, materialQuery: clean(node?.materialQuery, 60),
      shape: SHAPES.has(node?.shape) ? node.shape : 'roundRect',
      x: clamp(Number(node?.x) || 0.5, 0.02, 0.98), y: clamp(Number(node?.y) || 0.5, 0.02, 0.98),
      w: clamp(Number(node?.w) || defaultSize, 0.025, 0.9), h: clamp(Number(node?.h) || defaultSize, 0.025, 0.9),
      rotation: clamp(Number(node?.rotation) || 0, -45, 45),
      color: /^#[0-9a-f]{6}$/i.test(node?.color || '') ? node.color : undefined,
    };
  });
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, 14).flatMap(edge => {
    const from = idMap.get(clean(edge?.from, 40)); const to = idMap.get(clean(edge?.to, 40));
    if (!from || !to || from === to) return [];
    return [{ from, to, label: clean(edge?.label, 32), relation: ['arrow', 'inhibit', 'dashed'].includes(edge?.relation) ? edge.relation : 'arrow' }];
  });
  return { title: clean(raw.title, 70) || '科研机制示意图', summary: clean(raw.summary, 180), nodes, edges };
}

async function generateImage(prompt, key, file, root, bigType, visualStyle) {
  const response = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: buildGenerationPrompt(prompt, file, root, visualStyle),
      ...(file ? { image: [`data:${file.mimetype};base64,${file.buffer.toString('base64')}`] } : {}),
      size: bigType === 'cover' ? '1728x2304' : '2560x1440', response_format: 'b64_json', watermark: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  const b64 = data?.data?.[0]?.b64_json;
  if (!response.ok || !b64) throw new Error(data?.error?.message || data?.message || '机制参考图生成失败');
  return Buffer.from(b64, 'base64');
}

async function analyzeImage({ prompt, type, reference, materials, key }) {
  const schema = '{"title":"图题","summary":"一句话概括","nodes":[{"id":"n1","label":"实体名","detail":"简短机制说明","kind":"material|shape|text","materialQuery":"用于素材检索的名称","shape":"roundRect|ellipse|circle|capsule|diamond|hexagon|cylinder","x":0.2,"y":0.4,"w":0.15,"h":0.2,"rotation":0,"color":"#E9E4F9"}],"edges":[{"from":"n1","to":"n2","label":"激活","relation":"arrow|inhibit|dashed"}]}';
  const instruction = `你是科研机制图的视觉重建专家。分析输入的机制参考图和摘要，把画面拆成可以原位替换的科研实体、形状、文字和箭头。只输出 JSON，不要 Markdown。
结构：${schema}
1. x/y 是实体边界框中心的归一化坐标，w/h 是边界框归一化宽高，必须尽可能贴合参考图中的实际位置和大小，不要改成流程图分列布局。
2. 识别 7–18 个视觉实体，但只保留 5–14 条最关键因果箭头。优先左侧刺激→中央机制→右侧结局的主通路，中央细胞内部仅保留局部短箭头，底部干预流程与主通路分开。不要把实体连成网状结构。
3. 细胞、细胞器、蛋白、受体、基因、动物、器材和样本使用 kind=material，materialQuery 优先精确使用候选素材名称。抽象概念或容器才使用 shape，补充说明使用 text。
4. 参考图没有文字时，根据摘要为实体补充简短 label；detail 只写必要的机制说明。箭头必须忠实于参考图和摘要，不编造机制，避免重复、交叉和跨画面长斜线。图类型：${type}。
候选素材：${materials.map(item => `${item.title}（${item.folder}）`).join('、') || '暂无'}`;
  const content = [
    { type: 'image_url', image_url: { url: `data:${reference.mime};base64,${reference.buffer.toString('base64')}` } },
    { type: 'text', text: `${instruction}\n\n论文摘要或用户说明：\n${prompt || '请主要依据图片重建。'}` },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: VISION_MODEL, messages: [{ role: 'user', content }], temperature: 0.15, max_tokens: 6000, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.message || '参考图实体识别失败');
    const answer = data?.choices?.[0]?.message?.content;
    const answerText = Array.isArray(answer) ? answer.map(part => part?.text || '').join('') : answer;
    return { scene: normalizeScene(parseJson(answerText)), usage: data.usage };
  } finally { clearTimeout(timer); }
}

export function registerReferenceRoutes(app, { root, catalog, readKey, readGptsKey, upload, charge, refundReference }) {
  const dir = path.join(root, 'data/references');
  const indexFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  app.use('/references', (req, res, next) => {
    const file = path.join(dir, path.basename(req.path));
    if (!fs.existsSync(file)) return next();
    res.sendFile(file);
  });

  app.post('/api/ai/reference', charge('big'), (req, res) => {
    upload.single('image')(req, res, async uploadError => {
      if (uploadError) return res.status(400).json({ ok: false, error: '参考图上传失败，请使用 10 MB 以内的 PNG / JPG / WebP' });
      const prompt = clean(req.body?.prompt, 12000);
      const provider = ['seedream', 'gpt-image', 'gemini-image'].includes(req.body?.imageProvider) ? req.body.imageProvider : 'seedream';
      const bigType = ['mechanism', 'abstract', 'cover'].includes(req.body?.bigType) ? req.body.bigType : 'mechanism';
      const visualStyle = ['matte', 'flat', 'threed'].includes(req.body?.visualStyle) ? req.body.visualStyle : 'flat';
      if (!prompt && !req.file) return res.status(400).json({ ok: false, error: '请粘贴论文摘要，或上传一张参考图' });
      const key = readKey();
      if (provider === 'seedream' && !key) return res.status(503).json({ ok: false, error: '尚未配置火山方舟 API Key' });
      try {
        const generated = !req.file || req.body?.regenerate === '1';
        let buffer, mime;
        if (!generated) {
          buffer = req.file.buffer; mime = req.file.mimetype;
        } else if (provider === 'seedream') {
          buffer = await generateImage(prompt, key, req.file, root, bigType, visualStyle); mime = sniff(buffer) || 'image/png';
        } else {
          const fullPrompt = buildGenerationPrompt(prompt, req.file, root, visualStyle);
          const result = await generateGptsImage({ provider, prompt: fullPrompt, key: readGptsKey(), size: bigType === 'cover' ? '1024x1536' : '1536x1024', aspectRatio: bigType === 'cover' ? '3:4' : '16:9', quality: 'high', file: req.file });
          buffer = result.buffer; mime = result.mime;
        }
        const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
        const id = crypto.randomUUID();
        const file = `${id}.${ext}`;
        fs.writeFileSync(path.join(dir, file), buffer);
        const index = readJson(indexFile, {});
        index[id] = { file, mime, generated, provider, userId: req.user.id, charge: res.locals.canvasAiTicket };
        saveJson(indexFile, index);
        res.json({ ok: true, referenceId: id, url: `/references/${file}`, generated, provider });
      } catch (error) {
        res.status(502).json({ ok: false, error: clean(error?.message || '机制参考图生成失败', 300) });
      }
    });
  });

  app.post('/api/ai/reconstruct', async (req, res) => {
    const { referenceId } = req.body || {};
    const prompt = clean(req.body?.prompt, 12000);
    const type = ['mechanism', 'flow', 'compare'].includes(req.body?.diagramType) ? req.body.diagramType : 'mechanism';
    const index = readJson(indexFile, {});
    const record = index[referenceId];
    if (!record || record.userId !== req.user.id) return res.status(404).json({ ok: false, error: '参考图不存在或已过期，请重新生成' });
    const key = readKey();
    if (!key) { refundReference(referenceId); return res.status(503).json({ ok: false, error: '尚未配置火山方舟 API Key' }); }
    try {
      const reference = { buffer: fs.readFileSync(path.join(dir, path.basename(record.file))), mime: record.mime };
      const result = await analyzeImage({ prompt, type, reference, materials: catalog.retrieve(prompt), key });
      console.log(`[reconstruct] nodes=${result.scene.nodes.length} edges=${result.scene.edges.length} input=${result.usage?.prompt_tokens ?? '?'} output=${result.usage?.completion_tokens ?? '?'}`);
      res.json({ ok: true, scene: result.scene, model: VISION_MODEL });
    } catch (error) {
      refundReference(referenceId);
      const status = error?.name === 'AbortError' ? 504 : 502;
      res.status(status).json({ ok: false, error: error?.name === 'AbortError' ? '实体识别超时，请重试' : clean(error?.message || '实体识别失败', 300) });
    }
  });
}
