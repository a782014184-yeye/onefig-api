// 透明底质量门禁测试：棋盘格残留、空图、背景未去除、同一原图二次去背景、旧提示词兼容。
// 用法：node test-transparency.cjs（仅合成图片与临时目录，不请求外部 AI 服务）
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { PNG } = require('pngjs');
const { inspectTransparency, removeBackgroundWithRetry } = require('./transparency');

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
  ok(calls === 1 && matteError && matteError.message === 'local matte down', '本地抠图异常不会被误当作透明底残留重复调用');

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
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
