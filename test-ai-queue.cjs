// 验证：AI 生成全局队列、排队位置、单用户限制、超时退款
// 用法：node test-ai-queue.cjs（只打本机临时端口，绝不指向生产）
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');

process.env.ONEFIG_AI_GEN_WORKERS = '1';
process.env.ONEFIG_AI_GEN_TIMEOUT_MS = '900';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-ai-queue-'));
const AI_DIR = path.join(DATA_DIR, 'ai');
fs.mkdirSync(AI_DIR, { recursive: true });
fs.writeFileSync(path.join(AI_DIR, 'ark-key.txt'), 'test-key');

const USERS = [
  { id: 'u1', name: '用户一', credits: 100, verified: false, aiFreeUsed: {} },
  { id: 'u2', name: '用户二', credits: 100, verified: false, aiFreeUsed: {} },
];
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.writeFileSync(USERS_FILE, JSON.stringify(USERS));
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = u => fs.writeFileSync(USERS_FILE, JSON.stringify(u));
const authUser = (req, res, next) => {
  const id = req.headers.authorization === 'Bearer u2' ? 'u2' : 'u1';
  req.user = loadUsers().find(u => u.id === id);
  next();
};
const logLine = (tag, msg) => console.log(`  [log ${tag}] ${msg}`);

const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452' + '000000010000000108060000001f15c489' + '0000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
let stubDelay = 200;
const https = require('https');
https.request = (_url, _options, cb) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {
    setTimeout(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      const body = Buffer.from(JSON.stringify({ data: [{ b64_json: PNG_1PX.toString('base64') }] }));
      setImmediate(() => { res.emit('data', body); res.emit('end'); });
    }, stubDelay);
  };
  return req;
};

const app = express();
app.use(express.json({ limit: '12mb' }));
const aiFreeLeft = () => ({ gen: 0, big: 0, edit: 0, stylize: 0 });
const aiLocalLeft = () => ({ unlimited: true, nobg: null, vec: null });
const aiModule = require('./ai');
aiModule(app, {
  consoleAuth: (req, res, next) => next(), DATA_DIR, authUser, loadUsers, saveUsers,
  injectAigcMeta: b => b, logLine, aiFreeLeft,
  aiCost: () => 30, aiBigCost: () => 30, aiSplitCost: () => 100, aiLocalLeft, aiLocalCost: () => ({ nobg: 5, vec: 10 }),
});

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const post = (port, p, body, who = 'u1') => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const getJobs = (port, who = 'u1') => fetch(`http://127.0.0.1:${port}/api/ai/jobs`, { headers: { Authorization: `Bearer ${who}` } }).then(r => r.json());
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = app.listen(0, async () => {
    const port = server.address().port;
    console.log(`隔离实例起在 127.0.0.1:${port}，数据目录 ${DATA_DIR}`);

    const r1 = await post(port, '/api/ai/generate', { prompt: '一只科研小鼠站在白色背景前', bigType: 'abstract', transparent: false }, 'u1');
    const r2 = await post(port, '/api/ai/generate', { prompt: '一只科研小鼠站在白色背景前', bigType: 'abstract', transparent: false }, 'u2');
    ok(r1.status === 200 && r1.data.status === 'running', '第 1 个任务立即运行', JSON.stringify(r1.data));
    ok(r2.status === 200 && r2.data.status === 'queued' && r2.data.queuePosition === 1, '第 2 个任务进入队列且位置为 1', JSON.stringify(r2.data));

    const dup = await post(port, '/api/ai/generate', { prompt: '一只科研小鼠站在白色背景前', bigType: 'abstract', transparent: false }, 'u1');
    ok(dup.status === 429, '同一用户已有任务时再次提交会被拒绝', JSON.stringify(dup.data));

    let jobs1 = null;
    let jobs2 = null;
    for (let i = 0; i < 40; i++) {
      await wait(100);
      jobs1 = await getJobs(port, 'u1');
      jobs2 = await getJobs(port, 'u2');
      if (jobs1.list[0]?.status === 'done' && jobs2.list[0]?.status === 'done') break;
    }
    ok(jobs1?.list?.[0]?.status === 'done' && jobs2?.list?.[0]?.status === 'done', '队列任务按顺序完成', JSON.stringify({ u1: jobs1?.list?.[0]?.status, u2: jobs2?.list?.[0]?.status }));
    const credits = Object.fromEntries(loadUsers().map(u => [u.id, u.credits]));
    ok(credits.u1 === 70 && credits.u2 === 70, '两张成功任务各扣 30 积分', JSON.stringify(credits));

    // 超时退款：同一隔离实例里把生成响应延迟调到 1.5s，超过 900ms 超时
    stubDelay = 1500;
    const before = loadUsers().find(u => u.id === 'u1').credits;
    const rt = await post(port, '/api/ai/generate', { prompt: '一只科研小鼠站在白色背景前', bigType: 'abstract', transparent: false }, 'u1');
    await wait(1400);
    const afterJobs = await fetch(`http://127.0.0.1:${port}/api/ai/jobs`, { headers: { Authorization: 'Bearer u1' } }).then(r => r.json());
    const timed = afterJobs.list.find(j => j.id === rt.data.jobId);
    const after = loadUsers().find(u => u.id === 'u1').credits;
    ok(rt.status === 200 && timed?.status === 'failed' && /超时/.test(timed?.error || ''), '超时任务自动失败', JSON.stringify(timed));
    ok(after === before, '超时任务自动退还积分', `before=${before} after=${after}`);

    server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exit(failed ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(1); });
