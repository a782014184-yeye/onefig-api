// image-ops worker 线程池测试：结果与同步实现逐字节一致、事件循环零阻塞、异常正确传递。
// 用法：node test-image-ops-pool.cjs（仅合成图片，无外部依赖）
const { PNG } = require('pngjs');
const imageOps = require('./image-ops');

const W = 1024, H = 1024;
function makeSource() {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (W * y + x) << 2;
    const disk = Math.hypot(x - 512, y - 512) < 300;
    png.data[i] = disk ? 60 : 252; png.data[i + 1] = disk ? 120 : 252;
    png.data[i + 2] = disk ? 200 : 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const bufEq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

(async () => {
  const source = makeSource();

  // 1) cleanEdge：worker 结果与同步实现逐字节一致
  const syncCleaned = imageOps.cleanEdge(source, source);
  const poolCleaned = await imageOps.run('cleanEdge', source, source);
  ok(bufEq(syncCleaned, poolCleaned), 'cleanEdge：worker 与同步实现逐字节一致');

  // 2) floodMatte + alphaUnion 链路：worker 与同步一致
  const syncFlood = imageOps.floodMatte(source, 13);
  const poolFlood = await imageOps.run('floodMatte', source, 13);
  ok(bufEq(syncFlood, poolFlood), 'floodMatte：worker 与同步实现逐字节一致');
  const syncUnion = imageOps.alphaUnion(source, syncFlood, source, false);
  const poolUnion = await imageOps.run('alphaUnion', source, poolFlood, source, false);
  ok(bufEq(syncUnion, poolUnion), 'alphaUnion：worker 与同步实现逐字节一致');

  // 3) inspectTransparency 经 worker 返回结构化报告
  const report = await imageOps.run('inspectTransparency', poolCleaned);
  ok(report && typeof report.ok === 'boolean' && 'borderOpaqueRatio' in report, 'inspectTransparency：结构化报告返回', JSON.stringify(report).slice(0, 80));

  // 4) 事件循环零阻塞：worker 跑大图期间，主进程定时器最大漂移 < 100ms
  const bigPng = new PNG({ width: 2048, height: 2048 });
  for (let y = 0; y < 2048; y++) for (let x = 0; x < 2048; x++) {
    const i = (2048 * y + x) << 2;
    const disk = Math.hypot(x - 1024, y - 1024) < 600;
    bigPng.data[i] = disk ? 60 : 252; bigPng.data[i + 1] = disk ? 120 : 252;
    bigPng.data[i + 2] = disk ? 200 : 255; bigPng.data[i + 3] = 255;
  }
  const big = PNG.sync.write(bigPng);
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  const t0 = Date.now();
  await imageOps.run('cleanEdge', big, big);
  const elapsed = Date.now() - t0;
  clearInterval(timer);
  ok(maxGap < 100, `事件循环零阻塞（2048² 处理期间定时器最大漂移 ${maxGap}ms）`, `worker 实际耗时 ${elapsed}ms`);
  // 参照：同图同步执行应明显阻塞（证明测试本身有效）
  const s0 = Date.now();
  imageOps.cleanEdge(big, big);
  console.log(`     参照：同图同步执行耗时 ${Date.now() - s0}ms`);

  // 5) 异常传递：未知算子 / flood 覆盖率异常 → Promise 拒绝且信息保留
  let unknownErr = null;
  try { await imageOps.run('noSuchFn', source); } catch (e) { unknownErr = e; }
  ok(unknownErr && /未知图像算子/.test(unknownErr.message), '未知算子拒绝并提示', unknownErr && unknownErr.message);
  // 噪点背景 + 极小容差 → 洪泛覆盖率≈0 → 抛 coverage abnormal
  const noisy = new PNG({ width: 512, height: 512 });
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let p = 0; p < 512 * 512; p++) {
    noisy.data[p * 4] = 200 + Math.floor(rnd() * 55);
    noisy.data[p * 4 + 1] = 200 + Math.floor(rnd() * 55);
    noisy.data[p * 4 + 2] = 200 + Math.floor(rnd() * 55);
    noisy.data[p * 4 + 3] = 255;
  }
  let covErr = null;
  try { await imageOps.run('floodMatte', PNG.sync.write(noisy), 0.5); } catch (e) { covErr = e; }
  ok(covErr && /flood coverage abnormal/.test(covErr.message), 'flood 覆盖率异常正确传递', covErr && covErr.message);

  // 6) 并发派发：两路并行 cleanEdge 都成功且互不串结果
  const [r1, r2] = await Promise.all([
    imageOps.run('cleanEdge', source, source),
    imageOps.run('cleanEdge', syncUnion, syncUnion),
  ]);
  ok(bufEq(r1, syncCleaned) && bufEq(r2, imageOps.cleanEdge(syncUnion, syncUnion)), '并发两路派发结果各自正确');

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
