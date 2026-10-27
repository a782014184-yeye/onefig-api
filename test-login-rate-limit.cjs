// 登录限流隔离回归：8090 + 临时数据目录 + 虚构账号，绝不连接生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-login-limit-'));
const password = 'dummy-correct-password';
const makeUser = id => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id, name: `虚构 ${id}`, email: `${id}@example.invalid`, salt, passHash: crypto.scryptSync(password, salt, 32).toString('hex'), level: 'none', joinedAt: '', memberSince: null, verified: true, pwdVer: 0 };
};
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify(['a', 'b', 'c'].map(makeUser)));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8090', DATA_DIR: dataDir, TOKEN_SECRET: 'isolated-test-secret', ONEFIG_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const login = async (id, pass = password) => {
  const res = await fetch('http://127.0.0.1:8090/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${id}@example.invalid`, password: pass }),
  });
  return { status: res.status, data: await res.json() };
};
const stop = () => new Promise(resolve => {
  if (child.exitCode != null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 3000).unref();
});

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:8090/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, `隔离实例启动失败：${logs}`);

    for (let i = 0; i < 10; i++) {
      const r = await login(i % 2 ? 'a' : 'b');
      assert.equal(r.status, 200, `第 ${i + 1} 次正确切换登录不应被限流`);
    }

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) assert.equal((await login('a', 'wrong-password')).status, 401);
      assert.equal((await login('a')).status, 200, '5 次失败后密码正确必须能登录并清零');
    }

    for (let i = 0; i < 6; i++) assert.equal((await login('a', 'wrong-password')).status, 401);
    const locked = await login('a');
    assert.equal(locked.status, 429, '第 6 次失败后必须锁定该账号');
    assert.match(locked.data.error, /密码错误次数太多/);
    assert.equal((await login('b')).status, 200, 'A 被锁定不能影响 B 的正常登录');

    // 目前已有 16 次 IP 失败记录，再补 14 次，验证换邮箱也不能绕过网络级防护。
    for (let i = 0; i < 14; i++) assert.equal((await login(`c${i}`, 'wrong-password')).status, 401);
    const sprayBlocked = await login('b');
    assert.equal(sprayBlocked.status, 429, '同 IP 累计失败过多必须继续拦截');
    assert.match(sprayBlocked.data.error, /当前网络登录失败次数过多/);

    console.log('✓ 连续 10 次正确切换账号均可登录，成功请求不计失败次数');
    console.log('✓ 成功登录清零当前账号失败记录；锁定的账号互不影响');
    console.log('✓ 同 IP 换邮箱累计失败仍受网络级防爆破限制');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
