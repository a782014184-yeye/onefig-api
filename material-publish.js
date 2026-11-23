// 本地上传素材的同源发布：一份原图派生全部预览，全部就绪后发布，失败回滚。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// 与前端 WatermarkOverlay 完全一致：同一图片、4% 透明度、按图片高度居中铺放。
const WATERMARK_FILE = path.join(__dirname, 'assets', 'watermark.png');
const WATERMARK_OPACITY = 0.04;
const MAX_SVG_BYTES = 10 * 1024 * 1024;

// 管理端上传的 SVG 只做必要的安全清理，保留 Illustrator 的图层、渐变与可编辑结构。
function sanitizeSvg(input) {
  const svg = String(input || '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href|src)\s*=\s*(["'])\s*(?:javascript:|https?:|\/\/)[\s\S]*?\1/gi, '')
    .replace(/url\(\s*(?:javascript:|https?:|\/\/)[^)]*\)/gi, '')
    .trim();
  if (!svg || Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) throw new Error('SVG 不能超过 10MB');
  if (!/<svg\b[^>]*>/i.test(svg) || !/<\/svg\s*>/i.test(svg)) throw new Error('文件内容不是有效的 SVG');
  if (/<script\b|javascript:|<!ENTITY/i.test(svg)) throw new Error('SVG 包含不安全内容');
  return svg;
}

async function watermarkUnit(width, height) {
  const tile = await sharp(WATERMARK_FILE).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < tile.data.length; i += 4) tile.data[i] = Math.round(tile.data[i] * WATERMARK_OPACITY);
  return sharp(tile.data, { raw: tile.info }).png().toBuffer();
}

async function makeWatermarked(cleanPath, outputPath) {
  const source = sharp(cleanPath);
  const { width: w, height: h } = await source.metadata();
  if (!w || !h) throw new Error('无法读取图片尺寸');
  // 对应 CSS：background-size: auto 100%; background-position: center; opacity: 0.04。
  const tile = await watermarkUnit(h, h);
  const rx = Math.round((w - h) / 2);
  const left = Math.max(0, rx), cropLeft = Math.max(0, -rx);
  const right = Math.min(w, rx + h);
  const width = right - left;
  if (width <= 0) throw new Error('图片尺寸不支持水印铺放');
  const input = cropLeft || width !== h
    ? await sharp(tile).extract({ left: cropLeft, top: 0, width, height: h }).toBuffer()
    : tile;
  await source.composite([{ input, left, top: 0 }]).webp({ quality: 85, alphaQuality: 90, effort: 5 }).toFile(outputPath);
}

// SVG 保留原始矢量节点，只在末尾追加同样的 4% 水印，不经过位图栅格化。
async function makeSvgWatermarked(sourcePath, outputPath) {
  const clean = sanitizeSvg(fs.readFileSync(sourcePath, 'utf8'));
  const { width: w, height: h } = await sharp(sourcePath, { limitInputPixels: 60_000_000 }).metadata();
  if (!w || !h) throw new Error('SVG 缺少可识别的尺寸或 viewBox');
  const encoded = fs.readFileSync(WATERMARK_FILE).toString('base64');
  const x = (w - h) / 2;
  const overlay = `<image href="data:image/png;base64,${encoded}" x="${x}" y="0" width="${h}" height="${h}" opacity="${WATERMARK_OPACITY}" preserveAspectRatio="xMidYMid meet" pointer-events="none" />`;
  const output = clean.replace(/<\/svg>\s*$/, `${overlay}</svg>`);
  fs.writeFileSync(outputPath, output);
}

async function publishLocalMaterial({ sourcePath, series, title, ext, dataDir, webRoot, originalsDir, commit }) {
  if (!series || !title || series.includes('..') || title.includes('..') || /[\\/]/.test(series + title)) throw new Error('素材路径无效');
  const isSvg = String(ext).toLowerCase() === '.svg';
  const previewExt = isSvg ? '.svg' : '.webp';
  const cleanDir = path.join(dataDir, 'clean-previews');
  const previewDir = path.join(webRoot, 'previews');
  const stage = path.join(dataDir, 'staging', crypto.randomUUID());
  const backup = path.join(dataDir, 'backups', 'material-upload', `${Date.now()}-${crypto.randomUUID()}`);
  const originalName = title + ext;
  const previewName = title + previewExt;
  const staged = {
    original: path.join(stage, originalName),
    clean: path.join(stage, 'clean' + previewExt),
    public: path.join(stage, 'public' + previewExt),
    thumb: path.join(stage, 'thumb' + previewExt),
  };
  const targets = {
    original: path.join(originalsDir, series, originalName),
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
    if (isSvg) {
      fs.writeFileSync(staged.clean, sanitizeSvg(fs.readFileSync(staged.original, 'utf8')));
      await makeSvgWatermarked(staged.clean, staged.public);
      fs.copyFileSync(staged.public, staged.thumb);
    } else {
      await sharp(staged.original).webp({ quality: 90, alphaQuality: 90, effort: 6 }).toFile(staged.clean);
      await makeWatermarked(staged.clean, staged.public);
      await sharp(staged.public).resize(480).webp({ quality: 70, alphaQuality: 60, effort: 6 }).toFile(staged.thumb);
    }

    fs.mkdirSync(backup, { recursive: true });
    for (const [key, target] of Object.entries(targets)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) {
        const old = path.join(backup, key);
        fs.copyFileSync(target, old);
        previous.set(key, old);
      }
    }
    const stagedFor = { original: staged.original, clean: staged.clean, public: staged.public, thumb: staged.thumb };
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

module.exports = { publishLocalMaterial, sanitizeSvg, makeWatermarked, makeSvgWatermarked };
