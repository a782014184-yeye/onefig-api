// AI/SVG 模板库与用户作品存储。
// AI 原件只归档；前端只读取经过清理的 SVG，不参与 AI 格式回写。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const MAX_SVG_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{16,32}$/;

function text(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// 管理端上传是可信入口，仍在服务端做基础清理；浏览器加载时会再清理一次。
function sanitizeSvg(input) {
  const svg = String(input || '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*\/\s*>/gi, '')
    .replace(/\s+on[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '')
    .trim();
  if (!svg || Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) throw new Error('SVG 不能超过 12MB');
  if (!/<svg\b[^>]*>/i.test(svg) || !/<\/svg\s*>/i.test(svg)) throw new Error('文件内容不是有效的 SVG');
  return svg;
}

function registerTemplateRoutes(app, { dataDir, authUser, consoleAuth }) {
  const root = path.join(dataDir, 'templates');
  const filesRoot = path.join(root, 'files');
  const dbFile = path.join(root, 'templates.json');
  const designsRoot = path.join(dataDir, 'designs');
  fs.mkdirSync(filesRoot, { recursive: true });
  fs.mkdirSync(designsRoot, { recursive: true });
  if (!fs.existsSync(dbFile)) writeJson(dbFile, []);

  const loadTemplates = () => readJson(dbFile, []);
  const saveTemplates = rows => writeJson(dbFile, rows);
  const validId = id => ID_RE.test(String(id || ''));
  const publicMeta = row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    tags: row.tags || [],
    width: row.width,
    height: row.height,
    status: row.status,
    hasSource: !!row.sourceName,
    svgUrl: row.svgName ? `/template-files/${row.id}/editable.svg` : '',
    previewUrl: row.svgName ? `/template-files/${row.id}/editable.svg` : '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  app.use('/template-files', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
    next();
  }, require('express').static(filesRoot));

  app.get('/api/templates', (req, res) => {
    const rows = loadTemplates()
      .filter(row => row.status === 'published' && row.svgName)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ ok: true, templates: rows.map(publicMeta) });
  });

  app.get('/api/templates/:id', (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '模板 ID 无效' });
    const row = loadTemplates().find(item => item.id === req.params.id && item.status === 'published' && item.svgName);
    if (!row) return res.status(404).json({ ok: false, error: '模板不存在或尚未上架' });
    res.json({ ok: true, template: publicMeta(row) });
  });

  app.get('/console/api/templates', consoleAuth, (req, res) => {
    const rows = loadTemplates().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ ok: true, templates: rows.map(row => ({ ...publicMeta(row), sourceName: row.sourceName })) });
  });

  const templateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_SOURCE_BYTES, files: 2, fields: 12 },
  }).fields([{ name: 'source', maxCount: 1 }, { name: 'svg', maxCount: 1 }]);

  app.post('/console/api/templates/upload', consoleAuth, (req, res) => {
    templateUpload(req, res, err => {
      if (err) return res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 50MB' : '上传失败，请检查文件和表单' });
      try {
        const source = req.files && req.files.source && req.files.source[0];
        const svgFile = req.files && req.files.svg && req.files.svg[0];
        const name = text(req.body.name, 80) || text(svgFile && svgFile.originalname, 80).replace(/\.svg$/i, '') || text(source && source.originalname, 80).replace(/\.ai$/i, '');
        if (!name) return res.status(400).json({ ok: false, error: '请填写模板名称' });
        if (!source && !svgFile) return res.status(400).json({ ok: false, error: '请至少上传 AI 原件或 SVG 文件' });
        if (source && !/\.ai$/i.test(source.originalname)) return res.status(400).json({ ok: false, error: '原件仅支持 .ai 文件' });
        if (svgFile && !/\.svg$/i.test(svgFile.originalname)) return res.status(400).json({ ok: false, error: '编辑文件仅支持 .svg 文件' });
        if (source && source.size > MAX_SOURCE_BYTES) return res.status(400).json({ ok: false, error: 'AI 原件不能超过 50MB' });

        const id = crypto.randomBytes(12).toString('hex');
        const dir = path.join(filesRoot, id);
        fs.mkdirSync(dir, { recursive: true });
        let svgName = '';
        let sourceName = '';
        if (svgFile) {
          const cleaned = sanitizeSvg(svgFile.buffer.toString('utf8'));
          svgName = 'editable.svg';
          fs.writeFileSync(path.join(dir, svgName), cleaned);
        }
        if (source) {
          sourceName = 'source.ai';
          fs.writeFileSync(path.join(dir, sourceName), source.buffer);
        }
        const now = new Date().toISOString();
        const row = {
          id,
          name,
          category: text(req.body.category, 40) || '未分类',
          description: text(req.body.description, 300),
          tags: text(req.body.tags, 160).split(/[,，]/).map(v => v.trim()).filter(Boolean).slice(0, 12),
          sourceName,
          sourceOriginalName: source ? path.basename(source.originalname) : '',
          svgName,
          width: Math.max(1, Math.min(10000, Number(req.body.width) || 1200)),
          height: Math.max(1, Math.min(10000, Number(req.body.height) || 800)),
          status: svgName ? 'published' : 'needs_svg',
          createdAt: now,
          updatedAt: now,
        };
        const rows = loadTemplates();
        rows.push(row);
        saveTemplates(rows);
        res.json({ ok: true, template: { ...publicMeta(row), sourceName: row.sourceName } });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message || '模板保存失败' });
      }
    });
  });

  app.patch('/console/api/templates/:id', consoleAuth, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '模板 ID 无效' });
    const rows = loadTemplates();
    const row = rows.find(item => item.id === req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: '模板不存在' });
    if (req.body.status !== undefined) {
      const status = text(req.body.status, 20);
      if (!['published', 'draft', 'needs_svg'].includes(status)) return res.status(400).json({ ok: false, error: '状态无效' });
      if (status === 'published' && !row.svgName) return res.status(400).json({ ok: false, error: '缺少 SVG，暂不能上架' });
      row.status = status;
    }
    for (const key of ['name', 'category', 'description']) {
      if (req.body[key] !== undefined) row[key] = text(req.body[key], key === 'description' ? 300 : 80);
    }
    row.updatedAt = new Date().toISOString();
    saveTemplates(rows);
    res.json({ ok: true, template: { ...publicMeta(row), sourceName: row.sourceName } });
  });

  app.get('/console/api/templates/:id/source', consoleAuth, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '模板 ID 无效' });
    const row = loadTemplates().find(item => item.id === req.params.id);
    if (!row || !row.sourceName) return res.status(404).json({ ok: false, error: 'AI 原件不存在' });
    res.download(path.join(filesRoot, row.id, 'source.ai'), row.sourceOriginalName || `${row.name}.ai`);
  });

  app.delete('/console/api/templates/:id', consoleAuth, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '模板 ID 无效' });
    const rows = loadTemplates();
    const row = rows.find(item => item.id === req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: '模板不存在' });
    saveTemplates(rows.filter(item => item.id !== row.id));
    fs.rmSync(path.join(filesRoot, row.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  function designDir(uid) {
    const key = crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 32);
    const dir = path.join(designsRoot, key);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const loadDesigns = uid => readJson(path.join(designDir(uid), 'index.json'), []);
  // 索引只保存元信息，SVG 正文独立存放，避免作品列表随内容体积膨胀。
  const saveDesigns = (uid, rows) => writeJson(path.join(designDir(uid), 'index.json'), rows.map(({ svg, ...meta }) => meta));
  const designMeta = row => ({ id: row.id, name: row.name, templateId: row.templateId, width: row.width, height: row.height, createdAt: row.createdAt, updatedAt: row.updatedAt });
  function validateDesignBody(body) {
    const svg = sanitizeSvg(String(body.svg || ''));
    return {
      name: text(body.name, 80) || '未命名作品',
      templateId: text(body.templateId, 80),
      svg,
      width: Math.max(1, Math.min(10000, Number(body.width) || 1200)),
      height: Math.max(1, Math.min(10000, Number(body.height) || 800)),
    };
  }

  app.get('/api/designs', authUser, (req, res) => {
    const rows = loadDesigns(req.user.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ ok: true, designs: rows.map(designMeta) });
  });

  app.post('/api/designs', authUser, (req, res) => {
    try {
      const value = validateDesignBody(req.body || {});
      const id = crypto.randomBytes(12).toString('hex');
      const now = new Date().toISOString();
      const row = { id, ...value, createdAt: now, updatedAt: now };
      fs.writeFileSync(path.join(designDir(req.user.id), `${id}.svg`), value.svg);
      const rows = loadDesigns(req.user.id);
      rows.push(row);
      saveDesigns(req.user.id, rows);
      res.json({ ok: true, design: designMeta(row) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message || '作品保存失败' }); }
  });

  app.get('/api/designs/:id', authUser, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '作品 ID 无效' });
    const row = loadDesigns(req.user.id).find(item => item.id === req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: '作品不存在' });
    const svg = fs.readFileSync(path.join(designDir(req.user.id), `${row.id}.svg`), 'utf8');
    res.json({ ok: true, design: { ...designMeta(row), svg } });
  });

  app.put('/api/designs/:id', authUser, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '作品 ID 无效' });
    try {
      const rows = loadDesigns(req.user.id);
      const row = rows.find(item => item.id === req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: '作品不存在' });
      const value = validateDesignBody(req.body || {});
      Object.assign(row, value, { updatedAt: new Date().toISOString() });
      fs.writeFileSync(path.join(designDir(req.user.id), `${row.id}.svg`), value.svg);
      saveDesigns(req.user.id, rows);
      res.json({ ok: true, design: designMeta(row) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message || '作品保存失败' }); }
  });

  app.delete('/api/designs/:id', authUser, (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: '作品 ID 无效' });
    const rows = loadDesigns(req.user.id);
    if (!rows.some(item => item.id === req.params.id)) return res.status(404).json({ ok: false, error: '作品不存在' });
    saveDesigns(req.user.id, rows.filter(item => item.id !== req.params.id));
    fs.rmSync(path.join(designDir(req.user.id), `${req.params.id}.svg`), { force: true });
    res.json({ ok: true });
  });
}

module.exports = { registerTemplateRoutes, sanitizeSvg };
