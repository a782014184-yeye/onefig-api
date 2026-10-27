// 8090 隔离实例：纯账号云端画板与 AI 历史验收。只用临时目录和虚构账号，绝不连接生产。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-cloud-isolation-'));
const secret = 'isolated-test-secret';
const users = [
  { id: 'user-a', name: '虚构 A', email: 'a@example.invalid', level: 'none', pwdVer: 0, joinedAt: '', memberSince: null },
  { id: 'user-b', name: '虚构 B', email: 'b@example.invalid', level: 'none', pwdVer: 0, joinedAt: '', memberSince: null },
];
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify(users));
fs.mkdirSync(path.join(dataDir, 'ai'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'ai', 'jobs.json'), JSON.stringify([
  { id: 'job-a', userId: 'user-a', kind: 'gen', prompt: 'A 私有记录', status: 'done', candidates: [0], picked: 0 },
  { id: 'job-b', userId: 'user-b', kind: 'gen', prompt: 'B 私有记录', status: 'done', candidates: [0], picked: 0 },
]));
const token = uid => {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 3600000, pv: 0 })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};
const tokens = { 'user-a': token('user-a'), 'user-b': token('user-b') };
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8090', DATA_DIR: dataDir, TOKEN_SECRET: secret, ONEFIG_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });
const request = async (method, route, uid, body) => {
  const res = await fetch('http://127.0.0.1:8090' + route, {
    method,
    headers: { ...(uid ? { Authorization: `Bearer ${tokens[uid]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
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
    assert.ok(healthy, `8090 隔离实例启动失败：${logs}`);

    assert.equal((await request('GET', '/api/boards')).status, 401, '游客不得读取画板');
    assert.equal((await request('GET', '/api/ai/jobs')).status, 401, '游客不得读取 AI 历史');

    const created = await request('POST', '/api/boards', 'user-a', { id: 'boarda001', name: 'A 的画板' });
    assert.equal(created.status, 200);
    const saved = await request('PUT', '/api/boards/boarda001', 'user-a', { payload: { els: [{ id: 'private-a' }], board: { w: 100, h: 100 }, refLines: [] } });
    assert.equal(saved.status, 200);
    const aBoard = await request('GET', '/api/boards/boarda001', 'user-a');
    assert.equal(aBoard.data.payload.els[0].id, 'private-a');

    const aList = await request('GET', '/api/boards', 'user-a');
    const bList = await request('GET', '/api/boards', 'user-b');
    assert.deepEqual(aList.data.boards.map(x => x.id), ['boarda001']);
    assert.deepEqual(bList.data.boards, []);
    assert.equal((await request('GET', '/api/boards/boarda001', 'user-b')).status, 404, 'B 不得按 ID 读取 A 画板');
    assert.equal((await request('PUT', '/api/boards/boarda001', 'user-b', { payload: { els: [] } })).status, 404, 'B 不得覆盖 A 画板');
    assert.equal((await request('DELETE', '/api/boards/boarda001', 'user-b')).status, 404, 'B 不得删除 A 画板');

    const aJobs = await request('GET', '/api/ai/jobs', 'user-a');
    const bJobs = await request('GET', '/api/ai/jobs', 'user-b');
    assert.deepEqual(aJobs.data.list.map(x => x.id), ['job-a']);
    assert.deepEqual(bJobs.data.list.map(x => x.id), ['job-b']);
    assert.equal((await request('GET', '/api/ai/job/job-a/img/0', 'user-b')).status, 404, 'B 不得读取 A 的 AI 图片');
    assert.equal((await request('DELETE', '/api/ai/job/job-a', 'user-b')).status, 404, 'B 不得删除 A 的 AI 记录');

    console.log('✓ 8090 隔离实例：游客的画板与 AI 历史均被拒绝');
    console.log('✓ A / B 画板列表、读取、保存、删除均按账号隔离');
    console.log('✓ A / B AI 历史、图片和删除均按账号隔离');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
