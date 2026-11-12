// 透明 PNG 质量检查与同图本地抠图重试：不依赖外部生图服务，便于隔离测试。
const DEFAULTS = {
  alphaThreshold: 24,
  borderBandRatio: 0.03,
  maxBorderOpaqueRatio: 0.005,
  maxOpaqueRatio: 0.90,
};

function inspectTransparency(buf, options = {}) {
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  if (!w || !h) throw new Error('透明底检查失败：图片尺寸无效');

  const alphaThreshold = options.alphaThreshold ?? DEFAULTS.alphaThreshold;
  const bandRatio = options.borderBandRatio ?? DEFAULTS.borderBandRatio;
  const maxBorderOpaqueRatio = options.maxBorderOpaqueRatio ?? DEFAULTS.maxBorderOpaqueRatio;
  const maxOpaqueRatio = options.maxOpaqueRatio ?? DEFAULTS.maxOpaqueRatio;
  const band = Math.max(1, Math.min(Math.floor(Math.min(w, h) / 2), Math.round(Math.min(w, h) * bandRatio)));

  let opaque = 0;
  let borderTotal = 0;
  let borderOpaque = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const visible = data[((w * y + x) << 2) + 3] > alphaThreshold;
    if (visible) opaque++;
    if (x < band || x >= w - band || y < band || y >= h - band) {
      borderTotal++;
      if (visible) borderOpaque++;
    }
  }

  const opaqueRatio = opaque / (w * h);
  const borderOpaqueRatio = borderTotal ? borderOpaque / borderTotal : 1;
  const reasons = [];
  if (opaque === 0) reasons.push('no-visible-subject');
  if (opaqueRatio > maxOpaqueRatio) reasons.push('background-almost-intact');
  if (borderOpaqueRatio > maxBorderOpaqueRatio) reasons.push('edge-background-residue');

  return {
    ok: reasons.length === 0,
    reasons,
    width: w,
    height: h,
    band,
    opaqueRatio,
    borderOpaqueRatio,
  };
}

function decodeRaster(buf) {
  const { PNG } = require('pngjs');
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
    const jpeg = require('jpeg-js');
    const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  return PNG.sync.read(buf);
}

// 仅清理靠近透明区域的近白色 fringe；不对整个主体缩边，也不改变不透明主体颜色。
function cleanEdge(sourceBuf, matteBuf) {
  const { PNG } = require('pngjs');
  const source = decodeRaster(sourceBuf);
  const matte = decodeRaster(matteBuf);
  const w = matte.width, h = matte.height;
  if (!w || !h || !source.width || !source.height) throw new Error('边缘清理失败：图片尺寸无效');
  const raw = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) raw[p] = matte.data[(p << 2) + 3];

  // 3×3 alpha 最小值，只用来定位并收缩近白色外缘。
  const eroded = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let min = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const value = raw[w * yy + xx];
      if (value < min) min = value;
    }
    eroded[w * y + x] = min;
  }

  const targeted = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = w * y + x;
    const sx = Math.min(source.width - 1, Math.floor(x * source.width / w));
    const sy = Math.min(source.height - 1, Math.floor(y * source.height / h));
    const si = (source.width * sy + sx) << 2;
    const dr = source.data[si] - 255, dg = source.data[si + 1] - 255, db = source.data[si + 2] - 255;
    const nearWhite = dr * dr + dg * dg + db * db < 70 * 70;
    targeted[p] = nearWhite && eroded[p] < raw[p] ? eroded[p] : raw[p];
  }

  // 与离线预览一致的轻微高斯柔化（sigma=0.35，可分离 3×3 核，边缘 clamp）。
  const sigma = 0.35;
  const side = Math.exp(-0.5 / (sigma * sigma));
  const sum = 1 + 2 * side;
  const weights = [side / sum, 1 / sum, side / sum];
  const temp = new Float32Array(w * h);
  const blurred = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let value = 0;
    for (let k = -1; k <= 1; k++) value += targeted[w * y + Math.max(0, Math.min(w - 1, x + k))] * weights[k + 1];
    temp[w * y + x] = value;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let value = 0;
    for (let k = -1; k <= 1; k++) value += temp[w * Math.max(0, Math.min(h - 1, y + k)) + x] * weights[k + 1];
    blurred[w * y + x] = Math.round(value);
  }

  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = w * y + x, oi = p << 2;
    const sx = Math.min(source.width - 1, Math.floor(x * source.width / w));
    const sy = Math.min(source.height - 1, Math.floor(y * source.height / h));
    const si = (source.width * sy + sx) << 2;
    const a = blurred[p] / 255;
    const semi = a > 0.02 && a < 0.98;
    for (let c = 0; c < 3; c++) {
      const original = source.data[si + c];
      // 白底反解只作用于半透明边，避免把白色污染留在主体外缘。
      const recovered = semi ? (original - (1 - a) * 255) / Math.max(a, 1e-4) : original;
      out[oi + c] = Math.max(0, Math.min(255, Math.round(recovered)));
    }
    out[oi + 3] = blurred[p];
  }
  return PNG.sync.write({ width: w, height: h, data: out });
}

// 只复用同一张原图做本地抠图，不重新调用生图模型，因此不会产生额外生图费用。
async function removeBackgroundWithRetry({ source, matte, maxAttempts = 2, onRejected }) {
  const attemptsLimit = Math.min(3, Math.max(1, Number(maxAttempts) || 2));
  const attempts = [];

  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    let output;
    try {
      output = await matte(source, attempt);
    } catch (e) {
      // anime 不可用时仍可使用同一原图尝试 general；其他异常不盲目重试。
      if (e.code === 'MATTE_MODEL_UNAVAILABLE' && attempt < attemptsLimit) {
        attempts.push({ attempt, report: { ok: false, reasons: [e.code], error: e.message } });
        continue;
      }
      throw e;
    }
    let report;
    try {
      report = inspectTransparency(output);
    } catch (e) {
      report = { ok: false, reasons: ['invalid-output'], error: e.message };
    }
    attempts.push({ attempt, report });
    if (report.ok) return { source, output, report, attempts };
    if (onRejected) await onRejected({ attempt, source, output, report });
  }

  const error = new Error('透明底检查未通过，已自动再次去背景；本次不扣积分，请再试一次');
  error.code = 'TRANSPARENCY_QC_FAILED';
  error.attempts = attempts;
  throw error;
}

module.exports = { inspectTransparency, removeBackgroundWithRetry, cleanEdge };
