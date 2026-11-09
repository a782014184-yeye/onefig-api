const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-manager-login-'));
const port = 8098;
const base = `http://127.0.0.1:${port}`;
const password = 'manager-test-password';
const makeUser = (id, email, flags) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id, name: email.split('@')[0], email, contact: email, salt, passHash: crypto.scryptSync(password, salt, 32).toString('hex'), pwdVer: 0, verified: true, level: 'none', ...flags };
};
const manager = makeUser('template-manager', 'template@example.invalid', { templateAdmin: true });
const pricingManager = makeUser('pricing-manager', 'pricing@example.invalid', { pricingAdmin: true });
const ordinary = makeUser('ordinary-user', 'ordinary@example.invalid', {});
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify([manager, pricingManager, ordinary]));
const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TOKEN_SECRET: 'manager-login-test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-only-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });
const stop = () => new Promise(resolve => {
  if (server.exitCode != null) return resolve();
  server.once('exit', resolve);
  server.kill('SIGTERM');
  setTimeout(() => { if (server.exitCode == null) server.kill('SIGKILL'); }, 2000).unref();
});
const login = async (username, passwordValue = password) => {
  const response = await fetch(`${base}/console/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: passwordValue }) });
  return { status: response.status, data: await response.json() };
};

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) { healthy = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, logs);
    const main = await login('test-admin', 'test-only-password');
    assert.equal(main.status, 200, JSON.stringify(main.data));
    const template = await login(manager.email);
    assert.equal(template.status, 200);
    assert.equal(template.data.name, manager.name);
    const pricing = await login(pricingManager.email);
    assert.equal(pricing.status, 200);
    assert.equal((await login(ordinary.email)).status, 401);
    const wrong = await fetch(`${base}/console/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: manager.email, password: 'wrong-password' }) });
    assert.equal(wrong.status, 401);
    for (const token of [template.data.token, pricing.data.token]) {
      const response = await fetch(`${base}/console/api/materials`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
    }
    const revoked = await fetch(`${base}/console/api/users/${manager.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${main.data.token}` }, body: JSON.stringify({ templateAdmin: false }) });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${base}/console/api/materials`, { headers: { Authorization: `Bearer ${template.data.token}` } });
    assert.equal(afterRevoke.status, 401);
    const pricingStillValid = await fetch(`${base}/console/api/materials`, { headers: { Authorization: `Bearer ${pricing.data.token}` } });
    assert.equal(pricingStillValid.status, 200);
    console.log(JSON.stringify({ ok: true, mainAdmin: true, templateManagerLogin: true, pricingManagerLogin: true, ordinaryBlocked: true, wrongPasswordBlocked: true, revokedTokenBlocked: true }, null, 2));
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
