// SIGTERM 优雅退出隔离测试：慢速发送一个真实画板请求，确保服务等待在飞请求完成。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-graceful-'));
const consoleDir = path.join(dataDir, 'console');
fs.mkdirSync(consoleDir, { recursive: true });
const user = { id: 'u-graceful', name: '虚构用户', email: 'graceful@example.invalid', level: 'none', verified: true, pwdVer: 0 };
fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([user]));
fs.writeFileSync(path.join(consoleDir, 'materials.json'), '[]');
const port = 18205;
const secret = 'graceful-test-secret';
const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 3600000, pv: 0 })).toString('base64url');
const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
let child;
let logs = '';
const start = async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_ENV: 'test', ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: secret, ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', x => { logs += x; });
  child.stderr.on('data', x => { logs += x; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`服务启动失败：${logs}`);
};
const stop = () => new Promise(resolve => {
  if (!child || child.exitCode != null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
});

(async () => {
  try {
    await start();
    const body = JSON.stringify({ id: 'slowtest01', name: '慢请求画板' });
    const result = new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/boards', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` },
      }, res => {
        let text = '';
        res.on('data', x => { text += x; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.write(body.slice(0, 5));
      setTimeout(() => child.kill('SIGTERM'), 100);
      setTimeout(() => req.end(body.slice(5)), 350);
    });
    const response = await result;
    assert.equal(response.status, 200, `在飞请求应完成：${response.text}`);
    const exitCode = await new Promise(resolve => child.once('close', resolve));
    assert.equal(exitCode, 0, '正常 SIGTERM 应退出 0');
    assert.ok(logs.includes('[shutdown] signal=SIGTERM'), `退出日志缺失，实际输出：${logs}`);

    await start();
    await stop();
    console.log('✓ SIGTERM 等待在飞请求、退出 0、日志完整，并可立即同端口重启');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
