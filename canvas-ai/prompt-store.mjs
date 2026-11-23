import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GENERATION_PROMPT = `Based on the following content, generate a prompt for drawing schematic. The schematic illustration requirements are as follows: Vector illustration, Flat design, Hard edges, Color blocking, No gradients, No shading, No texture, Minimalist, High contrast. Biorender style. 

Use a clean white background, refined flat biomedical vector graphics, minimal text, and publication-quality visual hierarchy. The color palette should be soft pastel tones mint green, powder blue, blush pink, lavender, and pale peach.

单个元素不能太小，局部元素不要复杂、堆叠。
All labels must be in {{lang}}, Arial font, size 12, with precise alignment.`;

const promptFile = root => path.join(root, 'data/admin/generation-prompt.txt');
const metaFile = root => path.join(root, 'data/admin/generation-prompt.json');

export function readGenerationPrompt(root) {
  try {
    const value = fs.readFileSync(promptFile(root), 'utf8').trim();
    if (value) return value;
  } catch { /* 首次使用默认值 */ }
  return DEFAULT_GENERATION_PROMPT;
}

export function registerPromptRoutes(app, root, consoleAuth) {
  fs.mkdirSync(path.dirname(promptFile(root)), { recursive: true });
  app.get('/api/admin/generation-prompt', consoleAuth, (_req, res) => {
    let updatedAt = null;
    try { updatedAt = fs.statSync(promptFile(root)).mtime.toISOString(); } catch { /* 尚未保存过 */ }
    res.json({ ok: true, prompt: readGenerationPrompt(root), defaultPrompt: DEFAULT_GENERATION_PROMPT, updatedAt });
  });
  app.put('/api/admin/generation-prompt', consoleAuth, (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: '提示词不能为空' });
    if (prompt.length > 20000) return res.status(400).json({ ok: false, error: '提示词不能超过 20000 个字符' });
    try {
      const file = promptFile(root);
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, prompt);
      fs.renameSync(temp, file);
      const updatedAt = new Date().toISOString();
      fs.writeFileSync(metaFile(root), JSON.stringify({ updatedAt }, null, 2));
      res.json({ ok: true, prompt, updatedAt });
    } catch {
      res.status(500).json({ ok: false, error: '提示词保存失败，请重试' });
    }
  });
}
