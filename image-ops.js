// 图像算法工作线程池（2026-11-13 阶段1）：
// floodMatte / alphaUnion / isDarkSubject / ensurePng 从 ai.js 原样迁入此处，
// cleanEdge / inspectTransparency 由 transparency.js 提供——本文件同时是它们的
// 同步实现载体（供测试与运维脚本直接调用）和 worker_threads 派发器（供生产路径调用）。
// 目的：这些函数单次 0.5-2.6 秒且为 CPU 密集，此前跑在 Node 主进程事件循环里，
// 一次透明底任务阻塞全站约 4.2 秒；迁入 worker 后主进程只做毫秒级编排。
// 注意：所有函数保持纯计算（同步、无 I/O、无外部状态），算法逻辑一字未改。
const path = require('path');
const { Worker } = require('worker_threads');
const { cleanEdge, inspectTransparency } = require('./transparency');

// ---- 生成大图共用：JPEG 字节统一转 PNG（2026-10-22）----
function ensurePng(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
    const jpeg = require('jpeg-js');
    const { PNG } = require('pngjs');
    const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    return PNG.sync.write({ width: d.width, height: d.height, data: d.data });
  }
  return buf; // 已是 PNG
}

// ---- 洪泛抠底（自 ai.js 原样迁入）：AI 生成图背景为纯色（提示词保证），
// 洪泛"只删与边缘连通的背景色"能 100% 保留小碎片元素（Y 形抗体/细丝等），
// 这是 DL 分割模型的固有弱项。背景色取四角均值（白底/彩色纯色底都适用），
// 覆盖率异常（主体贴边/复杂背景）时抛错走 AI 模型兜底。----
function floodMatte(buf, luminanceTolerance = 13) {
  const { PNG } = require('pngjs');
  let rgb, w, h;
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) {
    const jpeg = require('jpeg-js');
    const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    rgb = d.data; w = d.width; h = d.height;
  } else {
    const png = PNG.sync.read(buf);
    rgb = png.data; w = png.width; h = png.height;
  }
  // 背景参考色 = 四角 6x6 块均值
  let br = 0, bg = 0, bb = 0, bn = 0;
  const corner = (x0, y0) => { for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) { const i = (w * y + x) << 2; br += rgb[i]; bg += rgb[i + 1]; bb += rgb[i + 2]; bn++; } };
  corner(0, 0); corner(w - 6, 0); corner(0, h - 6); corner(w - 6, h - 6);
  br /= bn; bg /= bn; bb /= bn;
  const cornerLum = (br + bg + bb) / 3;
  // 默认阈值 13 保护浅色主体；仅深色主体提高到 85，用于清理近白色地面阴影。
  const isBg = (i) => Math.abs((rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3 - cornerLum) < luminanceTolerance;
  const visited = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, w * (h - 1) + x); }
  for (let y = 0; y < h; y++) { stack.push(w * y, w * y + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    if (visited[p] || !isBg(p << 2)) continue;
    visited[p] = 1;
    rgb[(p << 2) + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  const cov = visited.reduce((a, b) => a + b, 0) / (w * h);
  if (!(cov > 0.03 && cov < 0.93)) throw new Error('flood coverage abnormal: ' + cov.toFixed(3));
  return PNG.sync.write({ width: w, height: h, data: rgb });
}

function isDarkSubject(modelBuf, sourceBuf) {
  const { PNG } = require('pngjs');
  const m = PNG.sync.read(modelBuf);
  const s = PNG.sync.read(ensurePng(sourceBuf));
  const luminance = [];
  for (let y = 0; y < m.height; y += 16) for (let x = 0; x < m.width; x += 16) {
    if (m.data[((m.width * y + x) << 2) + 3] <= 128) continue;
    const sx = Math.min(s.width - 1, Math.floor(x * s.width / m.width));
    const sy = Math.min(s.height - 1, Math.floor(y * s.height / m.height));
    const si = (s.width * sy + sx) << 2;
    luminance.push((s.data[si] + s.data[si + 1] + s.data[si + 2]) / 3);
  }
  if (luminance.length < 100) return false;
  luminance.sort((a, b) => a - b);
  return luminance[Math.floor(luminance.length / 2)] < 150;
}

// 选择性并集：模型负责主体；洪泛只补充与背景色反差明显的小碎片。
// 深色主体使用更严格的白底洪泛，低反差地面即使被模型误判为前景也不再保留。
function alphaUnion(modelBuf, floodBuf, sourceBuf, darkSubject = false, detailLuminance = 180) {
  const { PNG } = require('pngjs');
  const m = PNG.sync.read(modelBuf);
  const f = PNG.sync.read(floodBuf);
  const s = PNG.sync.read(ensurePng(sourceBuf));
  const W = f.width, H = f.height;
  let br = 0, bg = 0, bb = 0, bn = 0;
  const corner = (x0, y0) => {
    for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) {
      const i = (s.width * y + x) << 2;
      br += s.data[i]; bg += s.data[i + 1]; bb += s.data[i + 2]; bn++;
    }
  };
  corner(0, 0); corner(s.width - 6, 0); corner(0, s.height - 6); corner(s.width - 6, s.height - 6);
  br /= bn; bg /= bn; bb /= bn;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fi = (W * y + x) << 2;
    const si = (s.width * y + x) << 2;
    const dr = s.data[si] - br, dg = s.data[si + 1] - bg, db = s.data[si + 2] - bb;
    const colorSpan = Math.max(s.data[si], s.data[si + 1], s.data[si + 2]) - Math.min(s.data[si], s.data[si + 1], s.data[si + 2]);
    const luminance = (s.data[si] + s.data[si + 1] + s.data[si + 2]) / 3;
    const darkFloor = darkSubject && colorSpan < 18 && luminance > 130 && y > H * 0.55;
    if (darkFloor) { f.data[fi + 3] = 0; continue; } // 深色主体下部的高亮中性灰地面，含被主体包围的阴影
    const strongDetail = (colorSpan >= 30) || (luminance < detailLuminance && colorSpan < 6 && dr * dr + dg * dg + db * db >= 42 * 42); // 高饱和彩色结构始终保留；中性细线只在足够深时补
    if (f.data[fi + 3] > 0 && strongDetail) continue; // 只直接保留高反差洪泛细节
    if (darkSubject && !strongDetail && f.data[fi + 3] <= 24 && y > H * 0.55) { f.data[fi + 3] = 0; continue; } // 仅下部中性低反差地面；上方白色细节仍由模型恢复
    const mx = Math.min(m.width - 1, Math.floor(x * m.width / W));
    const my = Math.min(m.height - 1, Math.floor(y * m.height / H));
    const mi = (m.width * my + mx) << 2;
    const ma = m.data[mi + 3];
    if (ma > 24) {
      f.data[fi] = m.data[mi]; f.data[fi + 1] = m.data[mi + 1]; f.data[fi + 2] = m.data[mi + 2];
      f.data[fi + 3] = ma;
    } else {
      f.data[fi + 3] = 0; // 低反差地面、阴影或背景噪点
    }
  }
  return PNG.sync.write({ width: W, height: H, data: f.data });
}

// ---- 同步实现注册表：测试与运维脚本直接调用（与 worker 内执行的是同一份代码）----
const registry = { floodMatte, alphaUnion, isDarkSubject, ensurePng, cleanEdge, inspectTransparency };

// ---- worker 线程池：生产路径用 run() 派发，主进程事件循环零阻塞 ----
// 池大小跟随生图并发（ONEFIG_IMAGE_WORKERS 可单独覆盖）；worker 懒创建，
// 纯测试同步调用不会拉起线程；unref 保证线程不阻止进程自然退出。
const POOL_SIZE = Math.max(1, Number(process.env.ONEFIG_IMAGE_WORKERS ?? process.env.ONEFIG_AI_GEN_WORKERS ?? 2));
let pool = null;
let seq = 0;
const pending = new Map(); // id -> { worker, resolve, reject }

function getPool() {
  if (pool) return pool;
  pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const worker = new Worker(path.join(__dirname, 'image-ops-worker.js'));
    worker.unref();
    worker.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.worker.busy = false;
      if (msg.error) {
        const err = new Error(msg.error);
        if (msg.code) err.code = msg.code;
        p.reject(err);
      } else {
        // 结构化克隆把 Buffer 变 Uint8Array，还原后再交给业务（保持原同步实现的返回类型）
        const r = msg.result;
        p.resolve(r instanceof Uint8Array ? Buffer.from(r.buffer, r.byteOffset, r.byteLength) : r);
      }
    });
    worker.on('error', (e) => {
      // worker 崩溃：让全部在途任务失败，避免挂起；下次派发会重建池
      for (const [id, p] of pending) {
        if (p.worker.worker === worker) { pending.delete(id); p.worker.busy = false; p.reject(e); }
      }
      pool = null;
    });
    pool.push({ worker, busy: false });
  }
  return pool;
}

// run('cleanEdge', bufA, bufB) → Promise<Buffer>：在 worker 内执行同名同步函数。
// 参数经 structured clone 传递（1728² PNG 约 3-6MB，拷贝开销毫秒级，可忽略）。
function run(fn, ...args) {
  if (!registry[fn]) return Promise.reject(new Error('未知图像算子: ' + fn));
  const workers = getPool();
  const idle = workers.find(w => !w.busy) || workers[0];
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { worker: idle, resolve, reject });
    idle.busy = true;
    idle.worker.postMessage({ id, fn, args });
  });
}

module.exports = { ...registry, run, POOL_SIZE };
