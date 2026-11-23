// 注册协议同意与版本留痕隔离测试：虚构账号、不发送真实邮件、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-register-consent-'));
const consoleDir = path.join(dataDir, 'console');
fs.mkdirSync(consoleDir, { recursive: true });
const salt = crypto.randomBytes(16).toString('hex');
const oldUser = { id: 'u-old', name: '老用户', email: 'old@example.invalid', salt, passHash: crypto.scryptSync('old-password', salt, 32).toString('hex'), level: 'none', verified: true, pwdVer: 0 };
fs.writeFileSync(path.join(consoleDir, 'users.json'), JSON.stringify([oldUser]));
fs.writeFileSync(path.join(consoleDir, 'materials.json'), '[]');
const port = 18206;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_ENV: 'test', ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: 'register-consent-test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const post = async (route, body) => {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const readUsers = () => JSON.parse(fs.readFileSync(path.join(consoleDir, 'users.json'), 'utf8'));
const registration = {
  name: '新用户', email: 'new-consent@example.invalid', password: 'dummy-password',
  termsAccepted: true, privacyAccepted: true, termsVersion: '2026-11-19', privacyVersion: '2026-11-19',
};

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);

    const noConsent = await post('/api/auth/register', { name: registration.name, email: registration.email, password: registration.password });
    assert.equal(noConsent.status, 400);
    assert.equal(readUsers().length, 1, '未同意不得创建账号');

    const oldVersion = await post('/api/auth/register', { ...registration, privacyVersion: '2026-01-01' });
    assert.equal(oldVersion.status, 409);
    assert.equal(readUsers().length, 1, '旧版本不得记成新版本同意');

    const created = await post('/api/auth/register', registration);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const stored = readUsers().find(u => u.email === registration.email);
    assert.ok(stored);
    assert.equal(stored.termsVersion, '2026-11-19');
    assert.equal(stored.privacyVersion, '2026-11-19');
    assert.ok(Date.parse(stored.termsAcceptedAt));
    assert.ok(Date.parse(stored.privacyAcceptedAt));

    const oldLogin = await post('/api/auth/login', { email: oldUser.email, password: 'old-password' });
    assert.equal(oldLogin.status, 200, '老用户不得因缺少历史同意字段而无法登录');
    assert.ok(oldLogin.data.token);

    console.log('✓ 未同意拒绝、旧版本拒绝、时间版本落库与老用户登录全部通过');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
