// 透明底质量门禁测试：棋盘格、空图、同图二次去背景、rembg 表单顺序、模型降级与旧提示词兼容。
// 用法：node test-transparency.cjs（仅合成图片与临时目录，不请求外部 AI 服务）
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { PNG } = require('pngjs');
const { inspectTransparency, removeBackgroundWithRetry, cleanEdge } = require('./transparency');
const { buildRembgMultipart } = require('./rembg-multipart');

const W = 400, H = 400;
function makeImage(kind) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (W * y + x) << 2;
    const disk = Math.hypot(x - 200, y - 200) < 80;
    const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;
    png.data[i] = disk ? 40 : 255;
    png.data[i + 1] = disk ? 45 : 255;
    png.data[i + 2] = disk ? 50 : 255;
    if (kind === 'blank') png.data[i + 3] = 0;
    else if (kind === 'opaque') png.data[i + 3] = 255;
    else if (kind === 'checker') png.data[i + 3] = disk || checker ? 255 : 0;
    else png.data[i + 3] = disk ? 255 : 0;
  }
  return PNG.sync.write(png);
}

const good = makeImage('good');
const checker = makeImage('checker');
const blank = makeImage('blank');
const opaque = makeImage('opaque');
let passed = 0, failed = 0;
function ok(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

(async () => {
  const cleanReport = inspectTransparency(good);
  const checkerReport = inspectTransparency(checker);
  const blankReport = inspectTransparency(blank);
  const opaqueReport = inspectTransparency(opaque);
  ok(cleanReport.ok && cleanReport.borderOpaqueRatio === 0, '干净透明 PNG 通过检查');
  ok(!checkerReport.ok && checkerReport.reasons.includes('edge-background-residue'), `棋盘格边缘残留被拦截（${(checkerReport.borderOpaqueRatio * 100).toFixed(1)}%）`);
  ok(!blankReport.ok && blankReport.reasons.includes('no-visible-subject'), '全透明空图被拦截');
  ok(!opaqueReport.ok && opaqueReport.reasons.includes('background-almost-intact'), '背景几乎未去除被拦截');

  const fringeSource = new PNG({ width: 100, height: 100 });
  const fringeMatte = new PNG({ width: 100, height: 100 });
  for (let p = 0; p < 100 * 100; p++) {
    const i = p << 2;
    fringeSource.data[i] = fringeSource.data[i + 1] = fringeSource.data[i + 2] = 255;
    fringeSource.data[i + 3] = 255;
    fringeMatte.data[i] = fringeMatte.data[i + 1] = fringeMatte.data[i + 2] = 255;
    fringeMatte.data[i + 3] = 0;
  }
  const setPixel = (png, x, y, rgb, alpha) => {
    const i = (100 * y + x) << 2;
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = alpha;
  };
  for (let y = 30; y <= 70; y++) for (let x = 30; x <= 70; x++) {
    setPixel(fringeSource, x, y, [40, 40, 40], 255);
    setPixel(fringeMatte, x, y, [40, 40, 40], 255);
  }
  setPixel(fringeSource, 30, 30, [255, 255, 255], 255); // 近白色外缘，应减弱
  setPixel(fringeSource, 30, 50, [235, 180, 170], 255); // 粉色外缘，不 targeted erosion
  setPixel(fringeSource, 60, 60, [255, 255, 255], 255); // 白色主体内部，必须保留
  const fringeCleaned = PNG.sync.read(cleanEdge(PNG.sync.write(fringeSource), PNG.sync.write(fringeMatte)));
  const cleanedAlpha = (x, y) => fringeCleaned.data[((100 * y + x) << 2) + 3];
  ok(cleanedAlpha(30, 30) < 255 && cleanedAlpha(50, 50) === 255 && cleanedAlpha(30, 50) > 240, '近白色 fringe 减弱，深色主体与粉色边缘保留');
  const whiteCore = (60 * 100 + 60) << 2;
  ok(cleanedAlpha(60, 60) === 255 && fringeCleaned.data[whiteCore] === 255 && fringeCleaned.data[whiteCore + 1] === 255 && fringeCleaned.data[whiteCore + 2] === 255, '白色主体内部不被边缘清理误删');

  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
  const animeMultipart = buildRembgMultipart(imageBytes, 'anime', 'gen.png');
  const modelPos = animeMultipart.body.indexOf(Buffer.from('name="model"'));
  const imagePos = animeMultipart.body.indexOf(Buffer.from('name="image"'));
  const dataPos = animeMultipart.body.indexOf(imageBytes);
  const transition = Buffer.from(`\r\n\r\nanime\r\n--${animeMultipart.boundary}\r\nContent-Disposition: form-data; name="image"`);
  ok(modelPos >= 0 && imagePos > modelPos && dataPos > imagePos && animeMultipart.body.includes(transition), 'rembg 的 model 字段完整结束后才发送 image 文件');
  const generalMultipart = buildRembgMultipart(imageBytes, null, 'gen.png');
  ok(!generalMultipart.body.includes(Buffer.from('name="model"')) && generalMultipart.body.indexOf(imageBytes) > generalMultipart.body.indexOf(Buffer.from('name="image"')), '未指定模型时图片字段与二进制内容完整');

  const source = Buffer.from('only-one-generated-source');
  let calls = 0, rejected = 0, sameSource = true;
  const recovered = await removeBackgroundWithRetry({
    source,
    matte: (input, attempt) => {
      calls++;
      sameSource = sameSource && input === source && attempt === calls;
      return calls === 1 ? checker : good;
    },
    maxAttempts: 2,
    onRejected: () => { rejected++; },
  });
  ok(calls === 2 && rejected === 1 && sameSource && recovered.source === source && recovered.output.equals(good), '首次带格子时复用同一原图再次去背景成功');

  calls = 0;
  const modelRecovered = await removeBackgroundWithRetry({
    source,
    matte: () => {
      calls++;
      if (calls === 1) {
        const error = new Error('anime unavailable');
        error.code = 'MATTE_MODEL_UNAVAILABLE';
        throw error;
      }
      return good;
    },
    maxAttempts: 2,
  });
  ok(calls === 2 && modelRecovered.output.equals(good) && modelRecovered.attempts.length === 2, '插画模型不可用时可换通用模型，不交付洪泛单路结果');

  calls = 0; rejected = 0;
  let finalError = null;
  try {
    await removeBackgroundWithRetry({
      source,
      matte: () => { calls++; return checker; },
      maxAttempts: 2,
      onRejected: () => { rejected++; },
    });
  } catch (e) { finalError = e; }
  ok(calls === 2 && rejected === 2 && finalError && finalError.code === 'TRANSPARENCY_QC_FAILED' && finalError.attempts.length === 2, '连续不干净时停止本地重试并返回明确错误');

  calls = 0;
  let matteError = null;
  try {
    await removeBackgroundWithRetry({ source, matte: () => { calls++; throw new Error('local matte down'); } });
  } catch (e) { matteError = e; }
  ok(calls === 1 && matteError && matteError.message === 'local matte down', '其他本地抠图异常不会被误当作透明底残留重复调用');

  calls = 0;
  let singleError = null;
  try {
    await removeBackgroundWithRetry({ source, matte: () => { calls++; return checker; }, maxAttempts: 1 });
  } catch (e) { singleError = e; }
  ok(calls === 1 && singleError && singleError.code === 'TRANSPARENCY_QC_FAILED', '配置为 1 次时不做第二次去背景');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-transparency-'));
  try {
    const promptStore = require('./ai-prompts')(null);
    const defaults = promptStore.get();
    ok(!defaults.genTmpl.includes('透明背景') && defaults.genTmpl.includes('纯白背景') && defaults.genTmpl.includes('无棋盘格'), '默认提示词改为纯白底并排除棋盘格');

    const oldPrompts = { get: () => ({ ...defaults, genTmpl: '{topic}，透明背景，{styleSuffix}{scienceRules}{cellColorRules}' }) };
    const aiModule = require('./ai');
    aiModule(express(), {
      consoleAuth: (req, res, next) => next(), DATA_DIR: dataDir,
      authUser: (req, res, next) => next(), loadUsers: () => [], saveUsers: () => {},
      injectAigcMeta: b => b, logLine: () => {}, prompts: oldPrompts,
    });
    const prompt = aiModule.buildGenPrompt('一只科研鼠', 'matte');
    ok(!prompt.includes('，透明背景，') && prompt.includes('一只科研鼠，纯白背景') && prompt.includes('背景要求（覆盖前述背景描述）'), '后台旧模板中的透明背景措辞被自动兼容');

    const unionSource = new PNG({ width: 100, height: 100 });
    const unionModel = new PNG({ width: 100, height: 100 });
    const unionFlood = new PNG({ width: 100, height: 100 });
    for (let p = 0; p < 100 * 100; p++) {
      const i = p << 2;
      unionSource.data[i] = unionSource.data[i + 1] = unionSource.data[i + 2] = 255;
      unionSource.data[i + 3] = 255;
      unionModel.data[i + 3] = 0;
      unionFlood.data[i + 3] = 0;
    }
    setPixel(unionSource, 50, 80, [235, 235, 235], 255); // 低反差地面
    setPixel(unionFlood, 50, 80, [235, 235, 235], 255);
    setPixel(unionSource, 50, 20, [30, 30, 30], 255); // 高反差胡须
    setPixel(unionFlood, 50, 20, [30, 30, 30], 255);
    setPixel(unionSource, 50, 50, [250, 250, 250], 255); // 模型保住的白色主体
    setPixel(unionModel, 50, 50, [250, 250, 250], 255);
    const union = PNG.sync.read(aiModule.alphaUnion(PNG.sync.write(unionModel), PNG.sync.write(unionFlood), PNG.sync.write(unionSource)));
    const unionAlpha = (x, y) => union.data[((100 * y + x) << 2) + 3];
    ok(unionAlpha(50, 80) === 0 && unionAlpha(50, 20) === 255 && unionAlpha(50, 50) === 255, '低反差地面不并回，高反差细节与白色主体保留');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
