// 用户首次来源隔离验收：注册写入、后台列表/详情读取，不访问生产数据。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const PORT = Number(process.env.TEST_PORT || 8091);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-user-source-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TOKEN_SECRET: 'source-test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const stop = () => new Promise(resolve => {
  if (child.exitCode != null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 3000).unref();
});
const post = async (route, body, token) => {
  const res = await fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    const registered = await post('/api/auth/register', { name: '百度图片用户', email: 'baidu-image@example.invalid', password: 'dummy-password', source: '百度图片', sourceHost: 'image.baidu.com' });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.needVerify, true);
    await post('/api/auth/register', { name: '直接访问用户', email: 'direct@example.invalid', password: 'dummy-password' });
    const admin = await post('/console/api/login', { username: 'test-admin', password: 'test-password' });
    const users = await (await fetch(BASE + '/console/api/users', { headers: { Authorization: `Bearer ${admin.data.token}` } })).json();
    const sourceUser = users.list.find(u => u.email === 'baidu-image@example.invalid');
    assert.equal(sourceUser.source, '百度图片');
    assert.equal(sourceUser.sourceHost, 'image.baidu.com');
    assert.equal(users.list.find(u => u.email === 'direct@example.invalid').source, '直接访问');
    const filtered = await (await fetch(BASE + '/console/api/users?q=' + encodeURIComponent('百度图片'), { headers: { Authorization: `Bearer ${admin.data.token}` } })).json();
    assert.equal(filtered.list.length, 1);
    const detail = await (await fetch(BASE + '/console/api/users/' + sourceUser.id, { headers: { Authorization: `Bearer ${admin.data.token}` } })).json();
    assert.equal(detail.user.source, '百度图片');
    console.log('✓ 百度图片来源随注册写入，后台列表、搜索和详情均可读取');
    console.log('✓ 未提供来源时默认记录为直接访问');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
