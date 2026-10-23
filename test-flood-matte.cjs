// 洪泛抠底合成测试：米色盘 + 盘外细线碎片 + 白底轻微渐变
// 断言：碎片 100% 保留、背景 0 残留、盘芯 100% 保留（2026-10-23 v2 亮度容差）
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PNG } = require('pngjs');

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'floodtest-'));
const W = 400, H = 400;
const png = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (W * y + x) << 2;
  const v = 252 + Math.round(3 * Math.sin(x / 40)); // 白底轻微横向渐变
  png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = Math.min(255, v + 1); png.data[i + 3] = 255;
}
const disk = (cx, cy, r, fill) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (Math.hypot(x - cx, y - cy) < r) { const i = (W * y + x) << 2; png.data[i] = fill[0]; png.data[i + 1] = fill[1]; png.data[i + 2] = fill[2]; } } };
disk(200, 200, 120, [248, 238, 215]); // 浅米色盘
const linePix = [];
for (let k = 0; k < 14; k++) {
  const a = k / 14 * Math.PI * 2;
  const cx = 200 + Math.cos(a) * 165, cy = 200 + Math.sin(a) * 165;
  for (let t = 0; t < 26; t++) {
    const x = Math.round(cx + Math.cos(a) * t), y = Math.round(cy + Math.sin(a) * t);
    const i = (W * y + x) << 2;
    png.data[i] = 90; png.data[i + 1] = 150; png.data[i + 2] = 210;
    linePix.push([x, y]);
  }
}
const app = express();
const m = require('./ai');
m(app, { consoleAuth: (q, r, n) => n(), DATA_DIR: D, authUser: (q, r, n) => n(), loadUsers: () => [], saveUsers: () => {}, injectAigcMeta: b => b, logLine: () => {} });
if (!m.floodMatte) { console.error('❌ floodMatte 未导出'); process.exit(1); }
const out = PNG.sync.read(m.floodMatte(PNG.sync.write(png)));
let fragKept = 0;
for (const [x, y] of linePix) if (out.data[((W * y + x) << 2) + 3] > 200) fragKept++;
let bgBad = 0, diskKept = 0, diskN = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const a = out.data[((W * y + x) << 2) + 3];
  const d = Math.hypot(x - 200, y - 200);
  if (d > 320 && a > 0) bgBad++;
  if (d < 90) { diskN++; if (a > 200) diskKept++; }
}
console.log(`碎片保留 ${(fragKept / linePix.length * 100).toFixed(1)}% | 背景残留 ${bgBad} | 盘芯保留 ${(diskKept / diskN * 100).toFixed(1)}%`);
const ok = fragKept / linePix.length >= 0.98 && bgBad === 0 && diskKept / diskN >= 0.98;
console.log(ok ? '✅ floodMatte 合成测试通过' : '❌ 断言失败');
fs.rmSync(D, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
