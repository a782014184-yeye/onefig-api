#!/usr/bin/env node
// 将既有画板中的公开素材原图引用迁移为水印预览。默认 dry-run；--apply 才备份并写入。
const fs = require('fs');
const path = require('path');

const REF_KEYS = new Set(['src', 'librarySrc', 'colorOriginalSrc']);
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
const previewName = file => String(file || '').replace(/\.[^.]+$/, String(file).toLowerCase().endsWith('.svg') ? '.svg' : '.webp');

function migrateMaterialPreviewRefs({ dataDir, webRoot, apply = false }) {
  const manifestFile = path.join(dataDir, 'console', 'materials.json');
  const boardsRoot = path.join(dataDir, 'boards');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const replacements = [];
  const missingPreviews = new Set();

  for (const series of manifest) {
    const folder = String(series.folder || '');
    if (!folder || folder === 'Fig') continue;
    for (const material of series.materials || []) {
      if (!material.local) continue;
      const file = String(material.file || material.title + '.png');
      const preview = previewName(file);
      const previewPath = path.join(webRoot, 'previews', folder, preview);
      const from = `/files/${folder}/${file}`;
      const to = `/previews/${folder}/${preview}`;
      if (!fs.existsSync(previewPath)) {
        missingPreviews.add(from);
        continue;
      }
      replacements.push({ from, to }, { from: encodePath(from), to: encodePath(to) });
    }
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    boardFilesScanned: 0,
    boardFilesChanged: 0,
    refsChanged: 0,
    missingPreviews: [...missingPreviews].sort(),
    unresolvedRefs: [],
    backupRoot: null,
  };
  if (!fs.existsSync(boardsRoot)) return report;

  const backupRoot = path.join(dataDir, 'backups', 'material-preview-refs', new Date().toISOString().replace(/[:.]/g, '-'));
  const unresolved = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue;
      report.boardFilesScanned++;
      let data;
      try { data = JSON.parse(fs.readFileSync(fullPath, 'utf8')); }
      catch (error) {
        unresolved.set(fullPath, [`JSON 解析失败：${error.message}`]);
        continue;
      }
      let changed = false;
      const visit = value => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== 'object') return;
        for (const [key, current] of Object.entries(value)) {
          if (REF_KEYS.has(key) && typeof current === 'string') {
            let next = current;
            for (const pair of replacements) next = next.split(pair.from).join(pair.to);
            if (next !== current) { value[key] = next; changed = true; report.refsChanged++; }
            if (next.includes('/files/')) {
              const allowedAi = /\/files\/(?:ai-out|ai-sty|ai-nobg|ai-vec|ai-src)-[A-Za-z0-9._-]+/.test(next);
              if (!allowedAi && !next.includes('/files/Fig/')) {
                const list = unresolved.get(fullPath) || [];
                list.push(`${key}: 未找到可验证的预览映射`);
                unresolved.set(fullPath, list);
              }
            }
          } else visit(current);
        }
      };
      visit(data);
      if (!changed || !apply) continue;
      const relative = path.relative(boardsRoot, fullPath);
      const backup = path.join(backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(fullPath, backup);
      const tmp = fullPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, fullPath);
      report.boardFilesChanged++;
      report.backupRoot = backupRoot;
    }
  };
  walk(boardsRoot);
  report.unresolvedRefs = [...unresolved.entries()].map(([file, reasons]) => ({ file: path.relative(boardsRoot, file), reasons }));
  return report;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const webRoot = process.env.ONEFIG_WEB_ROOT || '/opt/onefig-web';
  const apply = process.argv.includes('--apply');
  try {
    const report = migrateMaterialPreviewRefs({ dataDir, webRoot, apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.missingPreviews.length || report.unresolvedRefs.length) process.exitCode = 1;
  } catch (error) {
    console.error(`迁移失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { migrateMaterialPreviewRefs, previewName };
