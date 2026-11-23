// 存储型 XSS 隔离回归：恶意样本仅用于本地虚构数据，不做真实外发或生产测试。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const { sanitizeThumbHistory } = require('./sanitize-thumb-history.cjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-thumb-xss-'));
const webRoot = path.join(dataDir, 'web');
const port = 18201;
const base = `http://127.0.0.1:${port}`;
const secret = 'isolated-thumb-test-secret';
const user = { id: 'user-xss-test', name: '虚构用户', email: 'user@example.invalid', level: 'pro', verified: true, pwdVer: 0 };
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify([user]));
fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), '[]');
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_WEB_ROOT: webRoot, ONEFIG_ENV: 'test', TOKEN_SECRET: secret, ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password', ADMIN_PATH: 'admin' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 3600000, pv: 0 })).toString('base64url');
const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const png = new PNG({ width: 8, height: 8 });
const validThumb = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
const malicious = 'data:image/png" onerror="document.documentElement.dataset.xss=\'yes\'';

async function request(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, `测试服务启动失败：${logs}`);

    assert.equal((await request('/api/boards', 'POST', { id: 'testboard01', name: '测试画板' })).status, 200);
    const badSave = await request('/api/boards/testboard01', 'PUT', { payload: { elements: [] }, thumb: malicious });
    assert.equal(badSave.status, 400, '恶意缩略图必须在入库前拒绝');
    let index = JSON.parse(fs.readFileSync(path.join(dataDir, 'boards', user.id, 'index.json'), 'utf8'));
    assert.equal(index.boards[0].thumb, undefined, '恶意缩略图不得落库');

    const goodSave = await request('/api/boards/testboard01', 'PUT', { payload: { elements: [] }, thumb: validThumb });
    assert.equal(goodSave.status, 200, '正常 PNG 缩略图必须保存');
    index = JSON.parse(fs.readFileSync(path.join(dataDir, 'boards', user.id, 'index.json'), 'utf8'));
    assert.equal(index.boards[0].thumb, validThumb);

    const imported = await request('/api/boards/import-local', 'POST', { boards: [
      { id: 'importbad01', name: '坏缩略图', thumb: malicious, payload: { elements: [] } },
      { id: 'importgood01', name: '好缩略图', thumb: validThumb, payload: { elements: [] } },
    ] });
    assert.deepEqual(imported.data.imported, ['importgood01']);
    assert.match(imported.data.skipped[0].reason, /缩略图格式无效/);

    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /object-src 'none'/);

    // 按浏览器实际收到的 HTML 求值后，再验证白名单函数。
    const consoleSource = fs.readFileSync(path.join(__dirname, 'console.js'), 'utf8');
    const pageTemplate = consoleSource.match(/const\s+PAGE\s*=\s*`([\s\S]*?)`;/);
    const renderedPage = new Function('OSS', `return \`${pageTemplate[1]}\``)('');
    const inlineScript = renderedPage.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
    const match = inlineScript.match(/function safeImgSrc\(raw\)\{[\s\S]*?\n\}/);
    assert.ok(match, '必须找到 safeImgSrc');
    const safeImgSrc = new Function(match[0] + ';return safeImgSrc;')();
    assert.equal(safeImgSrc(malicious), '/brand/icon.png');
    assert.equal(safeImgSrc('javascript:alert(1)'), '/brand/icon.png');
    assert.equal(safeImgSrc(validThumb), validThumb);
    assert.equal(safeImgSrc('/previews/%E6%B5%8B%E8%AF%95/a.webp?v=wm9'), '/previews/%E6%B5%8B%E8%AF%95/a.webp?v=wm9');

    // 历史数据：dry-run 不写，apply 备份后只清无效 thumb。
    index.boards[0].thumb = malicious;
    fs.writeFileSync(path.join(dataDir, 'boards', user.id, 'index.json'), JSON.stringify(index, null, 2));
    const downloadsFile = path.join(dataDir, 'console', 'downloads.json');
    fs.writeFileSync(downloadsFile, JSON.stringify([{ id: 'bad', thumb: malicious }, { id: 'good', thumb: validThumb }]));
    const before = fs.readFileSync(downloadsFile, 'utf8');
    const dry = sanitizeThumbHistory({ dataDir });
    assert.equal(dry.invalidThumbs, 2);
    assert.equal(dry.filesChanged, 2);
    assert.equal(fs.readFileSync(downloadsFile, 'utf8'), before);
    const applied = sanitizeThumbHistory({ dataDir, apply: true });
    assert.equal(applied.invalidThumbs, 2);
    assert.ok(applied.backupRoot && fs.existsSync(applied.backupRoot));
    const downloads = JSON.parse(fs.readFileSync(downloadsFile, 'utf8'));
    assert.equal(downloads[0].thumb, null);
    assert.equal(downloads[1].thumb, validThumb);
    index = JSON.parse(fs.readFileSync(path.join(dataDir, 'boards', user.id, 'index.json'), 'utf8'));
    assert.equal(index.boards[0].thumb, null);

    console.log('✓ 恶意入库拒绝、正常 PNG 保存、批量导入、CSP、双出口白名单、历史清理与备份全部通过');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
