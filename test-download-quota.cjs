// 已购素材与青果月度额度隔离回归：虚构图片与账号，不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-download-quota-'));
const consoleDir = path.join(dataDir, 'console');
fs.mkdirSync(consoleDir, { recursive: true });
const month = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
const user = { id: 'u-quota', name: '虚构青果用户', email: 'quota@example.invalid', level: 'basic', verified: true, pwdVer: 0, dlUsed: 2, dlMonth: month };
const png = new PNG({ width: 8, height: 8 });
const source = PNG.sync.write(png);
for (const title of ['已购素材', '未购素材']) {
  fs.mkdirSync(path.join(dataDir, 'originals', '测试系列'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'originals', '测试系列', title + '.png'), source);
}
fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([user]));
fs.writeFileSync(path.join(consoleDir, 'materials.json'), JSON.stringify([{ folder: '测试系列', materials: [
  { id: '测试系列/已购素材', title: '已购素材', series: '测试系列', file: '已购素材.png', local: true },
  { id: '测试系列/未购素材', title: '未购素材', series: '测试系列', file: '未购素材.png', local: true },
] }]));
fs.writeFileSync(path.join(consoleDir, 'purchases.json'), JSON.stringify([{ userId: user.id, materialId: '测试系列/已购素材', orderId: 'local-dummy-order' }]));
fs.writeFileSync(path.join(consoleDir, 'downloads.json'), '[]');
const secret = 'download-quota-test-secret';
const port = 18203;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_ENV: 'test', ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: secret, ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 3600000, pv: 0 })).toString('base64url');
const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const readUser = () => JSON.parse(fs.readFileSync(path.join(consoleDir, 'users.json'), 'utf8'))[0];
const download = async title => {
  const r = await fetch(base + '/api/download?id=' + encodeURIComponent('测试系列/' + title), { headers: { Authorization: `Bearer ${token}` } });
  await r.arrayBuffer();
  return r.status;
};

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    assert.equal(await download('已购素材'), 200);
    assert.equal(readUser().dlUsed, 2, '已购素材首次下载不得扣青果额度');
    assert.equal(await download('未购素材'), 200);
    assert.equal(readUser().dlUsed, 3, '未购素材首次下载才增加 1');
    assert.equal(await download('已购素材'), 200);
    assert.equal(readUser().dlUsed, 3, '已购素材历史重下也不得增加');
    console.log('✓ 已购首次不占额度、未购首次 +1、历史重下不增加的规则全部通过');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
