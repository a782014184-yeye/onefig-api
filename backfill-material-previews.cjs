#!/usr/bin/env node
// 为历史本地素材补齐 clean/public/thumb 预览。默认 dry-run；--apply 才写预览，不改原图与清单。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { makeWatermarked, makeSvgWatermarked, sanitizeSvg } = require('./material-publish');

async function backfillMaterialPreviews({ dataDir, webRoot, apply = false, limit = 0, offset = 0, stride = 1, force = false, onlySvg = false }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'console', 'materials.json'), 'utf8'));
  const report = { mode: apply ? 'apply' : 'dry-run', needed: 0, generated: 0, skippedExisting: 0, missingSource: [], failed: [] };
  let materialIndex = 0;
  for (const series of manifest) {
    const folder = String(series.folder || '');
    if (!folder || folder === 'Fig') continue;
    for (const material of series.materials || []) {
      if (!material.local) continue;
      const shardIndex = materialIndex++;
      const title = String(material.title || '');
      const file = String(material.file || title + '.png');
      const isSvg = file.toLowerCase().endsWith('.svg');
      if (onlySvg && !isSvg) continue;
      const previewExt = isSvg ? '.svg' : '.webp';
      const preview = title + previewExt;
      const original = path.join(dataDir, 'originals', folder, file);
      const legacyPublic = path.join(dataDir, 'files', folder, file);
      const source = fs.existsSync(original) ? original : legacyPublic;
      const targets = {
        clean: path.join(dataDir, 'clean-previews', folder, preview),
        public: path.join(webRoot, 'previews', folder, preview),
        thumb: path.join(webRoot, 'previews', 'thumb', folder, preview),
      };
      if (!force && Object.values(targets).every(target => fs.existsSync(target))) { report.skippedExisting++; continue; }
      if (!fs.existsSync(source)) { report.missingSource.push(`${folder}/${file}`); continue; }
      report.needed++;
      if (!apply) continue;
      if (stride > 1 && shardIndex % stride !== offset) continue;
      if (limit > 0 && report.generated >= limit) continue;
      const stage = path.join(dataDir, 'staging', 'preview-backfill-' + crypto.randomUUID());
      try {
        fs.mkdirSync(stage, { recursive: true });
        const stagedClean = path.join(stage, 'clean' + previewExt);
        const stagedPublic = path.join(stage, 'public' + previewExt);
        const stagedThumb = path.join(stage, 'thumb' + previewExt);
        if (isSvg) {
          fs.writeFileSync(stagedClean, sanitizeSvg(fs.readFileSync(source, 'utf8')));
          await makeSvgWatermarked(stagedClean, stagedPublic);
          fs.copyFileSync(stagedPublic, stagedThumb);
        } else {
          await sharp(source, { limitInputPixels: 60_000_000 }).webp({ quality: 90, alphaQuality: 90, effort: 6 }).toFile(stagedClean);
          await makeWatermarked(stagedClean, stagedPublic);
          await sharp(stagedPublic).resize(480).webp({ quality: 70, alphaQuality: 60, effort: 6 }).toFile(stagedThumb);
        }
        for (const [key, target] of Object.entries(targets)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const tmpTarget = `${target}.${process.pid}.tmp`;
          fs.copyFileSync({ clean: stagedClean, public: stagedPublic, thumb: stagedThumb }[key], tmpTarget);
          fs.renameSync(tmpTarget, target);
        }
        report.generated++;
        if (report.generated % 100 === 0) console.log(`分片 ${offset}/${stride}：已生成 ${report.generated} 张预览…`);
      } catch (error) {
        report.failed.push({ material: `${folder}/${file}`, error: error.message });
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
  }
  return report;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const onlySvg = process.argv.includes('--only-svg');
  const numberArg = name => {
    const arg = process.argv.find(value => value.startsWith(`--${name}=`));
    return arg ? Number(arg.split('=')[1]) : undefined;
  };
  const limit = Math.max(0, numberArg('limit') || 0);
  const stride = Math.max(1, numberArg('stride') || 1);
  const offset = Math.min(stride - 1, Math.max(0, numberArg('offset') || 0));
  backfillMaterialPreviews({
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    webRoot: process.env.ONEFIG_WEB_ROOT || '/opt/onefig-web',
    apply, limit, offset, stride, force, onlySvg,
  }).then(report => {
    console.log(JSON.stringify({ ...report, missingSource: report.missingSource.length, failed: report.failed }, null, 2));
    if (report.missingSource.length || report.failed.length) process.exitCode = 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { backfillMaterialPreviews };
