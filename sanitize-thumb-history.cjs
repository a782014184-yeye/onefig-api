#!/usr/bin/env node
// 清理历史恶意/损坏缩略图：默认 dry-run；--apply 时先备份，再原子写入，不删除业务记录。
const fs = require('fs');
const path = require('path');
const { isValidThumb } = require('./thumb-safety');

function sanitizeThumbHistory({ dataDir, apply = false }) {
  const report = { mode: apply ? 'apply' : 'dry-run', filesScanned: 0, filesChanged: 0, invalidThumbs: 0, backupRoot: null, errors: [] };
  const backupRoot = path.join(dataDir, 'backups', 'thumb-safety', new Date().toISOString().replace(/[:.]/g, '-'));

  const processFile = (file, clean) => {
    report.filesScanned++;
    try {
      const originalText = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(originalText);
      const changed = clean(data);
      if (!changed) return;
      if (!apply) { report.filesChanged++; return; }
      const relative = path.relative(dataDir, file);
      const backup = path.join(backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(file, backup);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
      report.filesChanged++;
      report.backupRoot = backupRoot;
    } catch (error) {
      report.errors.push({ file: path.relative(dataDir, file), error: error.message });
    }
  };

  const downloads = path.join(dataDir, 'console', 'downloads.json');
  if (fs.existsSync(downloads)) processFile(downloads, rows => {
    let changed = false;
    if (!Array.isArray(rows)) return false;
    for (const row of rows) {
      if (row && row.thumb != null && !isValidThumb(row.thumb)) {
        row.thumb = null;
        report.invalidThumbs++;
        changed = true;
      }
    }
    return changed;
  });

  const boardsRoot = path.join(dataDir, 'boards');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'index.json') processFile(full, index => {
        let changed = false;
        for (const board of index.boards || []) {
          if (board && board.thumb != null && !isValidThumb(board.thumb)) {
            board.thumb = null;
            report.invalidThumbs++;
            changed = true;
          }
        }
        return changed;
      });
    }
  };
  if (fs.existsSync(boardsRoot)) walk(boardsRoot);
  return report;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const apply = process.argv.includes('--apply');
  const report = sanitizeThumbHistory({ dataDir, apply });
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

module.exports = { sanitizeThumbHistory };
