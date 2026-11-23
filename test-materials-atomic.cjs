// 素材清单原子写与损坏语义回归：虚构清单、本地服务，不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-materials-atomic-'));
const consoleDir = path.join(dataDir, 'console');
fs.mkdirSync(consoleDir, { recursive: true });
const manifestFile = path.join(consoleDir, 'materials.json');
fs.writeFileSync(manifestFile, JSON.stringify([{ folder: '测试系列', materials: [{ id: '测试系列/素材', title: '素材', file: '素材.png', downloads: 0 }] }]));
fs.writeFileSync(path.join(consoleDir, 'users.json'), '[]');
const port = 18204;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_ENV: 'test', ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: 'materials-atomic-test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(base + '/api/track-download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '测试系列/素材' }),
    })));
    assert.ok(responses.every(r => r.ok));
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest[0].materials[0].downloads, 50);
    assert.ok(!fs.existsSync(manifestFile + '.tmp'), '成功写入后不得残留临时文件');
    const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(!serverSource.includes('writeFileSync(f, JSON.stringify(data'), '两条计数路径不得再直接覆盖写');

    fs.writeFileSync(manifestFile, '{broken-json');
    const broken = await fetch(base + '/api/materials');
    assert.equal(broken.status, 503, '损坏清单必须明确失败');
    assert.equal((await broken.json()).ok, false, '不得把损坏清单伪装成空素材库');
    const errorFile = path.join(dataDir, 'logs', `error-${new Date().toISOString().slice(0, 10)}.log`);
    assert.ok(fs.readFileSync(errorFile, 'utf8').includes('materials-read-fail'));

    console.log('✓ 50 次计数完整、临时文件清理、直写消除、损坏 503 与错误日志全部通过');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
