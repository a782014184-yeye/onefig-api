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

// 只复用同一张原图做本地抠图，不重新调用生图模型，因此不会产生额外生图费用。
async function removeBackgroundWithRetry({ source, matte, maxAttempts = 2, onRejected }) {
  const attemptsLimit = Math.min(3, Math.max(1, Number(maxAttempts) || 2));
  const attempts = [];

  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    const output = await matte(source, attempt);
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

module.exports = { inspectTransparency, removeBackgroundWithRetry };
