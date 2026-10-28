// 后台画板导出预览隔离测试：临时导出记录与虚构用户，不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-export-preview-'));
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'exports'), { recursive: true });
const withPassword = (id, name) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return { id, name, email: `${id}@example.invalid`, level: 'pro', verified: true, salt, passHash: crypto.scryptSync('test-password', salt, 32).toString('hex'), pwdVer: 0 };
};
const user = withPassword('buyer', '虚构买家');
const other = withPassword('other', '另一个虚构用户');
const archive = { id: 'export-image-1', file: 'export.png', userId: user.id, boardId: 'board1', boardTitle: '测试画板', fmt: 'png', code: 'OF-TEST-1', size: 10, time: '2026-10-27T00:00:00.000Z' };
const png = new PNG({ width: 1, height: 1 });
png.data.set([124, 92, 214, 255]);
fs.writeFileSync(path.join(dataDir, 'exports', 'export.png'), PNG.sync.write(png));
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify([user, other]));
fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), JSON.stringify([{ folder: '测试系列', materials: [{ id: 'mat1', title: '测试素材', series: '测试系列', file: '测试素材.png' }] }]));
fs.writeFileSync(path.join(dataDir, 'console', 'orders.json'), JSON.stringify([
  { id: 'export-order', userId: user.id, kind: 'export', exportCode: archive.code, amount: 6.9, status: 'paid', createdAt: archive.time },
  { id: 'single-order', userId: user.id, kind: 'single', materialId: 'mat1', materialTitle: '测试素材', amount: 6.9, status: 'paid', createdAt: archive.time },
]));
fs.writeFileSync(path.join(dataDir, 'console', 'exports.json'), JSON.stringify([archive]));
fs.writeFileSync(path.join(dataDir, 'console', 'downloads.json'), JSON.stringify([{ userId: user.id, kind: 'export', orderId: 'export-order', materialId: '画板导出作品', boardTitle: '测试画板', code: archive.code, time: archive.time }]));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8090', DATA_DIR: dataDir, ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: 'test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
const stop = () => new Promise(resolve => {
  if (child.exitCode != null) return resolve();
  child.once('exit', resolve); child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 3000).unref();
});

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:8090/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    const login = await (await fetch('http://127.0.0.1:8090/console/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
    })).json();
    const detail = await (await fetch('http://127.0.0.1:8090/console/api/users/buyer', { headers: { Authorization: `Bearer ${login.token}` } })).json();
    assert.equal(detail.downloads.length, 1);
    assert.equal(detail.downloads[0].kind, 'export');
    assert.equal(detail.downloads[0].exportId, archive.id);
    const image = await fetch(`http://127.0.0.1:8090/console/api/export-records/img?id=${archive.id}&t=${encodeURIComponent(login.token)}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await image.arrayBuffer());
    assert.ok(body.length > 20);
    const loginApi = async (email) => (await (await fetch('http://127.0.0.1:8090/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test-password' }),
    })).json());
    const buyerLogin = await loginApi('buyer@example.invalid');
    assert.equal(buyerLogin.ok, true, JSON.stringify(buyerLogin));
    const me = await (await fetch('http://127.0.0.1:8090/api/me', { headers: { Authorization: `Bearer ${buyerLogin.token}` } })).json();
    const exportOrder = me.orders.find(o => o.id === 'export-order');
    const singleOrder = me.orders.find(o => o.id === 'single-order');
    assert.equal(exportOrder.preview, `/api/my/export-image?code=${encodeURIComponent(archive.code)}`);
    assert.match(singleOrder.preview, /^\/previews\//);
    assert.match(singleOrder.preview, /\.webp$/);
    const myImage = await fetch(`http://127.0.0.1:8090${exportOrder.preview}&tk=${encodeURIComponent(buyerLogin.token)}`);
    assert.equal(myImage.status, 200);
    assert.equal(myImage.headers.get('content-type'), 'image/png');
    const otherLogin = await loginApi('other@example.invalid');
    const forbidden = await fetch(`http://127.0.0.1:8090${exportOrder.preview}&tk=${encodeURIComponent(otherLogin.token)}`);
    assert.equal(forbidden.status, 404, '其他账号不得读取此导出快照');
    console.log('✓ 后台与用户订单均关联预览，导出快照可读取且禁止跨账号访问');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
