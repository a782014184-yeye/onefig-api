import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROMPT = `Precisely recreate the layout as an editable SVG: use <text> elements for text, and separate vector elements for 图中的所有实体元素，boxes, lines, icons, and charts. 

箭头和杆子都需要重绘，不能用单独的箭头替代。箭头朝向和杆子要保持同一水平线，不能歪斜。箭头和杆子是一个整体，不要分开。
图中的所有实体元素重绘时，需要保留细节，不能通过简略来替代。
椭圆方框的宽度需要均匀一致，特别是转弯处一定要均匀。
细胞和在细胞表面的抗体要分开绘制。
Preserve the original font hierarchy, colors, spacing, borders, corner radii, shadows, and alignment. Do not redesign the layout, and do not embed the entire image directly in the SVG.


Ensure that font sizes fit their corresponding boxes and are neither too small nor too large.


请不要加入透明背景，为支持流式 SVG 预览，请按画面绘制顺序输出 SVG：


Output valid SVG code only:`;
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const saveJson = (file, value) => { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 1)); fs.renameSync(temp, file); };

async function readModelAnswer(response) {
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await response.json().catch(() => ({}));
    const answer = data?.choices?.[0]?.message?.content;
    return { content: Array.isArray(answer) ? answer.map(part => part?.text || '').join('') : String(answer || ''), usage: data?.usage };
  }
  if (!response.body) return { content: '', usage: undefined };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', content = '', usage;
  const consume = line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content;
      content += Array.isArray(delta) ? delta.map(part => part?.text || '').join('') : String(delta || '');
      if (chunk?.usage) usage = chunk.usage;
    } catch { /* 忽略不完整的 SSE 心跳行 */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    lines.forEach(consume);
    if (done) break;
  }
  if (pending.trim()) consume(pending);
  return { content, usage };
}

export function registerSoulRoute(app, { root, upload, readGptsKey, charge }) {
  const dir = path.join(root, 'data/soul');
  const referenceDir = path.join(root, 'data/references');
  const referenceIndex = path.join(referenceDir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });
  app.use('/soul-svg', (req, res, next) => {
    const file = path.join(dir, path.basename(req.path));
    if (!fs.existsSync(file)) return next();
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(file);
  });

  app.post('/api/ai/soul-redraw', upload.single('image'), charge('soul'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: '请先上传一张完整图片' });
    const key = readGptsKey();
    if (!key) return res.status(503).json({ ok: false, error: '尚未配置 gptsapi API Key' });
    const model = process.env.GPTSAPI_SOUL_MODEL || 'gpt-6.2-sol';
    try {
      const response = await fetch('https://api.gptsapi.net/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` } },
          ] }],
          max_tokens: 65536,
          stream: true,
        }),
        signal: AbortSignal.timeout(900000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Object.assign(new Error(data?.error?.message || data?.message || `Soul 重绘失败（${response.status}）`), { status: 502 });
      }
      const answer = await readModelAnswer(response);
      const content = answer.content;
      const start = content.indexOf('<svg');
      const end = content.lastIndexOf('</svg>');
      if (start < 0 || end <= start) throw new Error('Soul 没有返回完整 SVG，请重试');
      const svg = content.slice(start, end + 6).replace(/<\?xml[^>]*>/g, '').trim();
      if (/<script|foreignObject|<image\b|javascript:|on[a-z]+\s*=/i.test(svg)) throw new Error('返回的 SVG 包含不支持的内容');
      if (!/<(?:path|rect|circle|ellipse|polygon|polyline|line|text)\b/i.test(svg)) throw new Error('返回的 SVG 没有可编辑图形');

      const referenceId = crypto.randomUUID();
      const ext = req.file.mimetype === 'image/jpeg' ? 'jpg' : req.file.mimetype === 'image/webp' ? 'webp' : 'png';
      const referenceFile = `${referenceId}.${ext}`;
      fs.writeFileSync(path.join(referenceDir, referenceFile), req.file.buffer);
      const references = readJson(referenceIndex, {});
      references[referenceId] = { file: referenceFile, mime: req.file.mimetype, generated: false, provider: model, userId: req.user.id };
      saveJson(referenceIndex, references);

      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, `${id}.svg`), svg);
      res.json({ ok: true, model, svg, url: `/soul-svg/${id}.svg`, referenceId, referenceUrl: `/references/${referenceFile}`, usage: answer.usage });
    } catch (error) {
      console.error('[soul-redraw]', error);
      res.status(error?.status || 502).json({ ok: false, error: String(error?.message || 'Soul 重绘失败，请重试').slice(0, 300) });
    }
  });
}
