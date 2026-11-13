// image-ops worker 线程入口：在独立线程执行 image-ops.js 的同步算子，
// 避免 floodMatte/alphaUnion/cleanEdge 等 CPU 密集遍历阻塞主进程事件循环。
// 与主进程跑的是同一份函数代码（require 同一模块），结果逐字节一致。
const { parentPort } = require('worker_threads');
const imageOps = require('./image-ops');

parentPort.on('message', ({ id, fn, args }) => {
  try {
    // worker_threads 结构化克隆把 Buffer 变成 Uint8Array，调用前还原为 Buffer
    const fixed = args.map(a => a instanceof Uint8Array ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : a);
    const result = imageOps[fn](...fixed);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e && e.message || String(e), code: e && e.code });
  }
});
