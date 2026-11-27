import fs from 'node:fs';
import path from 'node:path';

const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\-_—–·，。；：、（）()\[\]【】]/g, '');

export function createCatalog({ dataDir, webRoot }) {
  const materialsFile = path.join(dataDir, 'console/materials.json');
  const previewDir = path.join(webRoot, 'previews');
  const cleanDir = path.join(dataDir, 'clean-previews');
  const loadSeries = () => {
    const rows = JSON.parse(fs.readFileSync(materialsFile, 'utf8'));
    return rows.filter(series => !series.deleted && series.folder !== 'Fig')
      .map(series => ({ ...series, materials: (series.materials || []).filter(item => !item.removed) }))
      .filter(series => series.materials.length);
  };

  const retrieve = (prompt, limit = 32) => {
    const query = norm(prompt);
    if (!query) return [];
    const grams = new Set();
    for (let i = 0; i < query.length - 1; i++) grams.add(query.slice(i, i + 2));
    const scored = [];
    for (const series of loadSeries()) for (const item of series.materials) {
      const name = norm(item.title);
      if (!name) continue;
      let score = query.includes(name) ? 120 + name.length * 10 : 0;
      if (name.includes(query)) score += 50;
      for (const gram of grams) if (name.includes(gram)) score += 2;
      if (score > 0) scored.push({ title: item.title, folder: series.folder, score });
    }
    scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
    const selected = scored.slice(0, limit);
    // 检索不足时补充常用科研实体，避免模型只能画概念框。
    if (selected.length < 30) {
      const used = new Set(selected.map(item => `${item.folder}/${item.title}`));
      for (const series of loadSeries()) for (const item of series.materials) {
        const key = `${series.folder}/${item.title}`;
        if (used.has(key)) continue;
        selected.push({ title: item.title, folder: series.folder, score: 0 });
        used.add(key);
        if (selected.length >= 40) return selected;
      }
    }
    return selected;
  };

  return { loadSeries, retrieve, previewDir, cleanDir };
}

export function registerCatalogRoutes(app, root) {
  const catalog = createCatalog(root);
  app.get('/api/materials', (_req, res) => {
    try { res.json({ ok: true, series: catalog.loadSeries() }); }
    catch { res.status(503).json({ ok: false, error: '素材清单暂时不可用' }); }
  });
  app.get('/api/clean-preview/:series/:title', (req, res) => {
    const series = path.basename(req.params.series);
    const title = path.basename(req.params.title);
    const candidates = [
      path.join(catalog.cleanDir, series, `${title}.webp`),
      path.join(catalog.cleanDir, series, `${title}.svg`),
      path.join(catalog.previewDir, series, `${title}.webp`),
      path.join(catalog.previewDir, series, `${title}.svg`),
    ];
    const file = candidates.find(candidate => fs.existsSync(candidate));
    if (!file) return res.status(404).json({ ok: false, error: '素材预览不存在' });
    res.sendFile(file);
  });
  app.use('/previews', (req, res, next) => {
    // 静态目录只暴露公开预览，不提供原始素材下载。
    res.setHeader('Cache-Control', 'public, max-age=86400');
    next();
  }, (req, res) => {
    let relative;
    try { relative = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
    const candidates = [path.join(catalog.previewDir, relative), path.join(catalog.cleanDir, relative)];
    const file = candidates.find(candidate => {
      const inside = candidate.startsWith(catalog.previewDir + path.sep) || candidate.startsWith(catalog.cleanDir + path.sep);
      return inside && fs.existsSync(candidate);
    });
    if (!file) return res.status(404).json({ ok: false, error: '素材预览不存在' });
    res.sendFile(file);
  });
  return catalog;
}
