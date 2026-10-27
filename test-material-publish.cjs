// 同源素材发布隔离验收：8090 + 临时目录 + 虚构图片，不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const { publishLocalMaterial } = require('./material-publish');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-material-publish-'));
const webRoot = path.join(dataDir, 'web');
const secret = 'isolated-material-secret';
const png = new PNG({ width: 40, height: 40 });
for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
  const i = (y * 40 + x) * 4;
  png.data[i] = 240; png.data[i + 1] = 80; png.data[i + 2] = 60; png.data[i + 3] = 255;
}
const source = PNG.sync.write(png);
const sourcePath = path.join(dataDir, 'source.png');
fs.writeFileSync(sourcePath, source);
const user = { id: 'buyer', name: '虚构买家', email: 'buyer@example.invalid', level: 'pro', verified: true, pwdVer: 0 };
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify([user]));
fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), '[]');
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8090', DATA_DIR: dataDir, ONEFIG_WEB_ROOT: webRoot, TOKEN_SECRET: secret, ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 3600000, pv: 0 })).toString('base64url');
const userToken = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const stop = () => new Promise(resolve => {
  if (child.exitCode != null) return resolve();
  child.once('exit', resolve); child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 3000).unref();
});
const uploadImage = async token => {
  const form = new FormData();
  form.append('series', '测试系列'); form.append('title', '测试素材');
  form.append('image', new Blob([source], { type: 'image/png' }), '测试素材.png');
  const res = await fetch('http://127.0.0.1:8090/console/api/materials/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: res.status, data: await res.json() };
};

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch('http://127.0.0.1:8090/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, `隔离实例启动失败：${logs}`);
    const loginRes = await fetch('http://127.0.0.1:8090/console/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-password' }),
    });
    const login = await loginRes.json();
    assert.ok(login.token);
    const uploaded = await uploadImage(login.token);
    const errorLog = path.join(dataDir, 'logs', `error-${new Date().toISOString().slice(0, 10)}.log`);
    const errorDetail = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '';
    assert.equal(uploaded.status, 200, `新素材上传发布应成功：${JSON.stringify(uploaded.data)} ${logs} ${errorDetail}`);

    const original = path.join(dataDir, 'originals', '测试系列', '测试素材.png');
    const publicOriginal = path.join(dataDir, 'files', '测试系列', '测试素材.png');
    const clean = path.join(dataDir, 'clean-previews', '测试系列', '测试素材.webp');
    const preview = path.join(webRoot, 'previews', '测试系列', '测试素材.webp');
    const thumb = path.join(webRoot, 'previews', 'thumb', '测试系列', '测试素材.webp');
    assert.ok(fs.readFileSync(original).equals(source), 'originals 必须保留上传原图字节');
    assert.ok(fs.readFileSync(publicOriginal).equals(source), '公开原图必须与 originals 一致');
    for (const file of [clean, preview, thumb]) {
      const buf = fs.readFileSync(file);
      assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
      assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'console', 'materials.json'), 'utf8'));
    assert.equal(manifest[0].materials[0].local, true);
    assert.equal(manifest[0].materials[0].size, source.length);

    assert.equal((await uploadImage(login.token)).status, 400, '活跃同名素材必须拒绝，不能静默覆盖');
    assert.ok(fs.readFileSync(original).equals(source), '重复上传失败不得改变已发布原图');

    const download = await fetch('http://127.0.0.1:8090/api/download?id=' + encodeURIComponent('测试系列/测试素材'), { headers: { Authorization: `Bearer ${userToken}` } });
    assert.equal(download.status, 200);
    const downloaded = PNG.sync.read(Buffer.from(await download.arrayBuffer()));
    assert.deepEqual([...downloaded.data.slice(0, 4)], [240, 80, 60, 255], '下载图片像素必须与上传原图一致');
    const history = await (await fetch('http://127.0.0.1:8090/api/my/downloads', { headers: { Authorization: `Bearer ${userToken}` } })).json();
    assert.equal(history.list[0].local, true, '下载历史必须保留 local 标记');

    const downloadsFile = path.join(dataDir, 'console', 'downloads.json');
    const countBefore = JSON.parse(fs.readFileSync(downloadsFile, 'utf8')).length;
    fs.renameSync(original, original + '.missing');
    const missing = await fetch('http://127.0.0.1:8090/api/download?id=' + encodeURIComponent('测试系列/测试素材'), { headers: { Authorization: `Bearer ${userToken}` } });
    assert.equal(missing.status, 404, '原图缺失必须拒绝下载，不能回退其他图片');
    const countAfter = JSON.parse(fs.readFileSync(downloadsFile, 'utf8')).length;
    assert.equal(countAfter, countBefore, '原图缺失不能新增下载记账');

    // 直接模拟发布到公开预览时失败：已写入的 originals/files 必须回滚。
    const rollbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-publish-rollback-'));
    const rollbackWeb = path.join(rollbackDir, 'web');
    for (const dir of [path.join(rollbackDir, 'originals', '测试系列'), path.join(rollbackDir, 'files', '测试系列')]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '测试素材.png'), 'OLD');
    }
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = (src, dest) => {
      if (String(dest) === path.join(rollbackWeb, 'previews', '测试系列', '测试素材.webp')) throw new Error('模拟公开预览写入失败');
      return originalCopy(src, dest);
    };
    try {
      await assert.rejects(publishLocalMaterial({
        sourcePath, series: '测试系列', title: '测试素材', ext: '.png', dataDir: rollbackDir,
        webRoot: rollbackWeb, filesDir: path.join(rollbackDir, 'files'), originalsDir: path.join(rollbackDir, 'originals'),
      }), /模拟公开预览写入失败/);
    } finally { fs.copyFileSync = originalCopy; }
    assert.equal(fs.readFileSync(path.join(rollbackDir, 'originals', '测试系列', '测试素材.png'), 'utf8'), 'OLD');
    assert.equal(fs.readFileSync(path.join(rollbackDir, 'files', '测试系列', '测试素材.png'), 'utf8'), 'OLD');
    fs.rmSync(rollbackDir, { recursive: true, force: true });

    console.log('✓ 新上传由原图生成全部文件，原图字节、清单和预览一致');
    console.log('✓ 重复上传拒绝覆盖；下载像素与上传原图一致，历史 local 正确');
    console.log('✓ 原图缺失不下载、不记账；发布中途失败会回滚已写文件');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
