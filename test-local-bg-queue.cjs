// 验证：单独“移除背景”进入本地串行队列，队列满时返回 429 并退款/不扣额度
// 用法：node test-local-bg-queue.cjs（只打本机临时端口，绝不指向生产）
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SECRET = 'local-bg-queue-test-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-local-bg-queue-'));
fs.mkdirSync(path.join(DATA_DIR, 'console'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'console', 'users.json'), JSON.stringify([
  { id: 'u-local', name: '本地队列用户', level: 'pro', verified: true, pwdVer: 0 },
]));
const token = (() => {
  const p = Buffer.from(JSON.stringify({ uid: 'u-local', exp: Date.now() + 3600e3, pv: 0 })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
})();

const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452' + '000000010000000108060000001f15c489' + '0000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
let serviceActive = 0;
let serviceMaxActive = 0;
const serviceTimes = [];
const bgStub = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
  req.resume();
  req.on('end', () => {
    serviceActive += 1;
    serviceMaxActive = Math.max(serviceMaxActive, serviceActive);
    serviceTimes.push(Date.now());
    setTimeout(() => {
      serviceActive -= 1;
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG_1PX);
    }, 220);
  });
});

const freePort = () => new Promise(resolve => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const postRemoveBg = (port) => {
  const fd = new FormData();
  fd.append('image', new Blob([PNG_1PX], { type: 'image/png' }), 'test.png');
  return fetch(`http://127.0.0.1:${port}/api/remove-bg`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
};

(async () => {
  await new Promise((resolve, reject) => bgStub.listen(9000, '127.0.0.1', resolve).on('error', reject));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR,
      TOKEN_SECRET: SECRET,
      ONEFIG_ENV: 'test',
      ADMIN_USER: 'test-admin',
      ADMIN_PASS: 'test-password',
      ONEFIG_LOCAL_BG_WORKERS: '1',
      ONEFIG_LOCAL_BG_MAX_WAITING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', x => { logs += x; });
  child.stderr.on('data', x => { logs += x; });
  const stopChild = () => new Promise(resolve => {
    if (child.exitCode != null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 3000).unref();
  });

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    if (!ready) throw new Error('server 启动超时\n' + logs);

    const t0 = Date.now();
    const results = await Promise.all([postRemoveBg(port), postRemoveBg(port), postRemoveBg(port)]);
    const elapsed = Date.now() - t0;
    const successes = results.filter(r => r.status === 200 && r.data.ok);
    const rejected = results.filter(r => r.status === 429 && /任务较多/.test(r.data.error || ''));
    ok(successes.length === 2, '两个移除背景任务按队列成功', JSON.stringify(results.map(r => ({ status: r.status, ok: r.data.ok }))));
    ok(rejected.length === 1, '队列满时多余任务被拒绝且不扣额度', JSON.stringify(rejected[0]?.data || {}));
    ok(serviceMaxActive === 1, '本地 rembg 服务同时只处理 1 个任务', `maxActive=${serviceMaxActive}`);
    ok(serviceTimes.length === 2 && serviceTimes[1] - serviceTimes[0] >= 180, '两个任务按队列顺序执行', `delta=${serviceTimes[1] - serviceTimes[0]}ms`);
    ok(elapsed >= 380, '并发请求实际等待队列完成', `elapsed=${elapsed}ms`);

    const users = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'console', 'users.json'), 'utf8'));
    ok(users[0].credits == null, '红果会员移除背景不计积分', JSON.stringify(users[0]));
  } finally {
    await stopChild();
    await new Promise(resolve => bgStub.close(resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
