import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';

const MODEL = process.env.ONEFIG_DIAGRAM_MODEL || 'doubao-seed-2-1-pro-260915';
const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 1)); fs.renameSync(temp, file); };

function sanitizeIcon(value) {
  let svg = String(value || '').trim().replace(/^```(?:svg|xml)?\s*/i, '').replace(/\s*```$/, '');
  const start = svg.indexOf('<svg');
  const end = svg.lastIndexOf('</svg>');
  if (start < 0 || end <= start) return '';
  svg = svg.slice(start, end + 6);
  if (svg.length > 2_000_000) return '';
  svg = svg.replace(/<\?xml[^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  svg = svg.replace(/<\/?(?:script|foreignObject|iframe|object|embed|audio|video|image|text)\b[^>]*>/gi, '');
  svg = svg.replace(/\s(?:on[a-z]+|href|xlink:href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  svg = svg.replace(/\sstyle\s*=\s*(?:"[^"]*(?:url|expression|javascript)[^"]*"|'[^']*(?:url|expression|javascript)[^']*')/gi, '');
  if (!/^<svg\b[\s\S]*<\/svg>$/i.test(svg)) return '';
  if (!/<(?:path|rect|circle|ellipse|polygon|polyline|line)\b/i.test(svg)) return '';
  return svg;
}

async function cropEntity(reference, node) {
  try {
    const image = sharp(reference.buffer);
    const { width, height } = await image.metadata();
    if (!width || !height) return reference;
    const w = Number(node.w) || 0.15, h = Number(node.h) || 0.15;
    const padX = w * 0.08, padY = h * 0.08;
    const left = Math.max(0, Math.floor((Number(node.x) - w / 2 - padX) * width));
    const top = Math.max(0, Math.floor((Number(node.y) - h / 2 - padY) * height));
    const right = Math.min(width, Math.ceil((Number(node.x) + w / 2 + padX) * width));
    const bottom = Math.min(height, Math.ceil((Number(node.y) + h / 2 + padY) * height));
    if (right - left < 24 || bottom - top < 24) return reference;
    return { buffer: await image.extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer(), mime: 'image/png' };
  } catch {
    return reference;
  }
}

async function traceEntity(reference) {
  const { data, info } = await sharp(reference.buffer).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  return ImageTracer.imagedataToSVG(
    { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    { numberofcolors: 32, colorquantcycles: 3, colorsampling: 2, ltres: 1.2, qtres: 1.2, pathomit: 16, rightangleenhance: true, strokewidth: 0, blurradius: 0, blurdelta: 16, roundcoords: 1, viewbox: true, desc: false },
  );
}

async function generateIcon({ reference, node, key }) {
  const instruction = `你是科研矢量插画师。输入图是从完整科研机制图中裁切出的实体“${node.label}${node.detail ? `（${node.detail}）` : ''}”局部。
请按这个局部图重绘一个独立的 200×200 SVG 科研图标。只输出一个完整的 <svg>...</svg>，不要 JSON、解释或 Markdown。
要求：
1. 使用 viewBox="0 0 200 200"，包含 path/rect/circle/ellipse/polygon 等真实矢量元素。禁止 image、位图、外链、script、foreignObject、文字和 id 属性。
2. 必须忠实保留局部图的主体轮廓、朝向、内部结构和原有配色，不要重新设计造型，不要改成其他细胞或通用符号。仅移除周围背景和其他无关实体。
3. 使用清晰的封闭色块和纯色填色，保持与原局部图一致的视觉细节。禁止 defs、linearGradient、radialGradient、渐变、滤镜、厚阴影、纹理、3D、照片感和大量碎点。
4. 主体居中，四周留白不超过 8%。SVG 必须完整闭合，所有属性引号必须成对，禁止省略号或用空白填充。`;
  const content = [
    { type: 'image_url', image_url: { url: `data:${reference.mime};base64,${reference.buffer.toString('base64')}` } },
    { type: 'text', text: instruction },
  ];
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], temperature: 0.15, max_tokens: 4000, thinking: { type: 'disabled' } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || 'SVG 图标生成失败');
  const answer = data?.choices?.[0]?.message?.content;
  return Array.isArray(answer) ? answer.map(part => part?.text || '').join('') : String(answer || '');
}

export function registerAiIconRoutes(app, { root, readKey, refundReference }) {
  const referenceDir = path.join(root, 'data/references');
  const sceneDir = path.join(root, 'data/vector-scenes');
  const indexFile = path.join(referenceDir, 'index.json');
  fs.mkdirSync(sceneDir, { recursive: true });
  app.use('/vector-scenes', (req, res, next) => {
    const file = path.join(sceneDir, path.basename(req.path));
    if (!fs.existsSync(file)) return next();
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(file);
  });

  app.post('/api/ai/vector-icons', async (req, res) => {
    const referenceId = String(req.body?.referenceId || '');
    const scene = req.body?.scene;
    const index = readJson(indexFile, {});
    const record = index[referenceId];
    if (!record || record.userId !== req.user.id || !scene?.nodes) return res.status(404).json({ ok: false, error: '参考图或语义结构不存在' });
    const key = readKey();
    if (!key) { refundReference(referenceId); return res.status(503).json({ ok: false, error: '尚未配置火山方舟 API Key' }); }
    try {
      const reference = { buffer: fs.readFileSync(path.join(referenceDir, path.basename(record.file))), mime: record.mime };
      const nodes = scene.nodes.filter(node => node.kind === 'material').slice(0, 12);
      const icons = {};
      for (let i = 0; i < nodes.length; i += 6) {
        const batch = nodes.slice(i, i + 6);
        await Promise.all(batch.map(async node => {
          const localReference = await cropEntity(reference, node);
          let svg = '';
          for (let attempt = 0; attempt < 1 && !svg; attempt += 1) {
            const raw = await generateIcon({ reference: localReference, node, key });
            svg = sanitizeIcon(raw);
            if (!svg) console.warn(`[vector-icons] invalid ${node.id} attempt=${attempt + 1}: ${raw.slice(0, 160)}`);
          }
          if (!svg) {
            console.warn(`[vector-icons] local trace fallback ${node.id}`);
            svg = sanitizeIcon(await traceEntity(localReference));
          }
          if (svg) icons[node.id] = svg;
          else throw new Error(`“${node.label}”的 SVG 图标未完整生成，请重试`);
        }));
        console.log(`[vector-icons] completed=${Object.keys(icons).length}/${nodes.length}`);
      }
      res.json({ ok: true, icons, generated: Object.keys(icons).length });
    } catch (error) {
      refundReference(referenceId);
      console.error('[vector-icons]', error);
      res.status(502).json({ ok: false, error: String(error?.message || 'SVG 图标生成失败').slice(0, 300) });
    }
  });

  app.post('/api/ai/vector-scene', (req, res) => {
    const title = String(req.body?.title || '科研机制图').slice(0, 80);
    const svg = String(req.body?.svg || '');
    if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) return res.status(400).json({ ok: false, error: 'SVG 场景格式不正确' });
    if (svg.length > 5 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'SVG 场景过大' });
    if (/<script|foreignObject|<image\b|javascript:|on[a-z]+\s*=/i.test(svg)) return res.status(400).json({ ok: false, error: 'SVG 包含不安全内容' });
    const id = crypto.randomUUID();
    const file = `${id}.svg`;
    saveJson(path.join(sceneDir, 'index.json'), { ...readJson(path.join(sceneDir, 'index.json'), {}), [id]: { file, title, createdAt: Date.now() } });
    fs.writeFileSync(path.join(sceneDir, file), svg);
    res.json({ ok: true, url: `/vector-scenes/${file}` });
  });
}
