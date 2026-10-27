// 本地上传素材的同源发布：一份原图派生全部预览，全部就绪后发布，失败回滚。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const WATERMARK_FILE = path.join(__dirname, 'assets', 'wm-unit.png');
const WATERMARK_OPACITY = 0.20;

async function watermarkUnit(width, height) {
  const tile = await sharp(WATERMARK_FILE).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < tile.data.length; i += 4) tile.data[i] = Math.round(tile.data[i] * WATERMARK_OPACITY);
  return sharp(tile.data, { raw: tile.info }).png().toBuffer();
}

async function makeWatermarked(cleanPath, outputPath) {
  const source = sharp(cleanPath);
  const { width: w, height: h } = await source.metadata();
  const scale = Math.min(220 / w, 330 / h);
  const tw = Math.max(60, Math.round(120 / Math.max(scale, 0.05)));
  const unit = await sharp(WATERMARK_FILE).metadata();
  const th = Math.round(tw * unit.height / unit.width);
  const sx = Math.round(tw * 1.5), sy = Math.round(th * 2.2);
  const tile = await watermarkUnit(tw, th);
  const cx = w / 2, cy = h / 2;
  const ax = (cx - tw / 2) % sx, ay = (cy - th / 2) % sy;
  const rows = [];
  for (let y = ay - sy; y < h; y += sy) rows.push(y);
  const center = rows.reduce((best, y, i) => Math.abs(y + th / 2 - cy) < Math.abs(rows[best] + th / 2 - cy) ? i : best, 0);
  const composite = [];
  for (let i = 0; i < rows.length; i++) {
    const xOffset = (i - center) % 2 ? sx / 2 : 0;
    for (let x = ax - sx + xOffset; x < w; x += sx) {
      const rx = Math.round(x), ry = Math.round(rows[i]);
      const left = Math.max(0, rx), top = Math.max(0, ry);
      const cropLeft = Math.max(0, -rx), cropTop = Math.max(0, -ry);
      const right = Math.min(w, rx + tw), bottom = Math.min(h, ry + th);
      const width = right - left, height = bottom - top;
      if (width <= 0 || height <= 0) continue;
      // 小图或边缘单元需要裁切，sharp 不允许直接把更大的单元叠到画布外。
      const input = cropLeft || cropTop || width !== tw || height !== th
        ? await sharp(tile).extract({ left: cropLeft, top: cropTop, width, height }).toBuffer()
        : tile;
      composite.push({ input, left, top });
    }
  }
  await source.composite(composite).webp({ quality: 85, alphaQuality: 90, effort: 5 }).toFile(outputPath);
}

async function publishLocalMaterial({ sourcePath, series, title, ext, dataDir, webRoot, filesDir, originalsDir, commit }) {
  if (!series || !title || series.includes('..') || title.includes('..') || /[\\/]/.test(series + title)) throw new Error('素材路径无效');
  const cleanDir = path.join(dataDir, 'clean-previews');
  const previewDir = path.join(webRoot, 'previews');
  const stage = path.join(dataDir, 'staging', crypto.randomUUID());
  const backup = path.join(dataDir, 'backups', 'material-upload', `${Date.now()}-${crypto.randomUUID()}`);
  const originalName = title + ext;
  const previewName = title + '.webp';
  const staged = {
    original: path.join(stage, originalName),
    clean: path.join(stage, 'clean.webp'),
    public: path.join(stage, 'public.webp'),
    thumb: path.join(stage, 'thumb.webp'),
  };
  const targets = {
    original: path.join(originalsDir, series, originalName),
    files: path.join(filesDir, series, originalName),
    clean: path.join(cleanDir, series, previewName),
    public: path.join(previewDir, series, previewName),
    thumb: path.join(previewDir, 'thumb', series, previewName),
  };
  const previous = new Map();
  const published = [];
  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.copyFileSync(sourcePath, staged.original);
    // 完整解码校验，顺便限制异常像素图；原图字节不重编码、不压缩。
    const meta = await sharp(staged.original, { limitInputPixels: 60_000_000 }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 60_000_000) throw new Error('图片像素超出限制');
    await sharp(staged.original).webp({ quality: 90, alphaQuality: 90, effort: 6 }).toFile(staged.clean);
    await makeWatermarked(staged.clean, staged.public);
    await sharp(staged.public).resize(480).webp({ quality: 70, alphaQuality: 60, effort: 6 }).toFile(staged.thumb);

    fs.mkdirSync(backup, { recursive: true });
    for (const [key, target] of Object.entries(targets)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) {
        const old = path.join(backup, key);
        fs.copyFileSync(target, old);
        previous.set(key, old);
      }
    }
    const stagedFor = { original: staged.original, files: staged.original, clean: staged.clean, public: staged.public, thumb: staged.thumb };
    for (const [key, target] of Object.entries(targets)) {
      fs.copyFileSync(stagedFor[key], target);
      published.push(key);
    }
    // 清单写入也纳入回滚边界：清单失败时恢复旧文件，避免文件与清单分离。
    if (typeof commit === 'function') await commit();
    return { size: fs.statSync(targets.original).size };
  } catch (error) {
    // 已发布的恢复旧文件，新增文件删除；素材清单尚未修改，因此不会出现半新半旧。
    for (const key of published.reverse()) {
      const target = targets[key];
      try {
        if (previous.has(key)) fs.copyFileSync(previous.get(key), target);
        else fs.rmSync(target, { force: true });
      } catch { /* 保留原始错误，备份目录可用于人工恢复 */ }
    }
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { publishLocalMaterial };
