// 素材请求 / 问题反馈状态与邮件回归测试。使用隔离数据目录，不访问真实邮件服务。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DATA_DIR = path.join(__dirname, '.tmp-test-submissions-' + process.pid);
const CONSOLE_DIR = path.join(DATA_DIR, 'console');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(CONSOLE_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'submissions.json'), JSON.stringify([
  { id: 'feedback-1', type: 'feedback', userId: 'user-1', desc: '页面有问题', status: 'new', createdAt: new Date().toISOString() },
  { id: 'request-1', type: 'request', userId: 'user-1', desc: '求一张细胞图', status: 'new', createdAt: new Date().toISOString() },
]));
fs.writeFileSync(path.join(CONSOLE_DIR, 'users.json'), JSON.stringify([
  { id: 'user-1', name: '测试用户', email: 'reader@example.com' },
]));
fs.writeFileSync(path.join(CONSOLE_DIR, 'mail.json'), JSON.stringify({ user: 'mock@example.com', pass: 'mock' }));

const sent = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async mail => { sent.push(mail); return { messageId: 'mock' }; },
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  Object.assign(process.env, {
    PORT: String(port), DATA_DIR, ADMIN_PATH: 'admin', ADMIN_USER: 'tester',
    ADMIN_PASS: 'test-pass', TOKEN_SECRET: 'test-token-secret', ONEFIG_ENV: 'test',
  });
  require('./server');
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const login = await fetch(base + '/console/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'test-pass' }),
  }).then(r => r.json());
  assert(login.token, '后台登录失败');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const toggle = async id => {
    const response = await fetch(base + '/admin/toggle', { method: 'POST', headers, body: JSON.stringify({ id }) });
    assert.strictEqual(response.status, 200);
    return response.json();
  };
  const rows = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'submissions.json'), 'utf8'));
  const status = id => rows().find(r => r.id === id).status;

  await toggle('feedback-1');
  assert.strictEqual(status('feedback-1'), 'read', '问题反馈应标为已读');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(sent.length, 0, '问题反馈标为已读不应发送邮件');

  await toggle('feedback-1');
  assert.strictEqual(status('feedback-1'), 'new', '问题反馈应可恢复为未读');
  assert.strictEqual(sent.length, 0, '问题反馈恢复未读也不应发送邮件');

  await toggle('request-1');
  assert.strictEqual(status('request-1'), 'done', '素材请求仍应标为已上新');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(sent.length, 1, '素材请求完成上新仍应发送一封邮件');
  assert(sent[0].subject.includes('上新啦'));

  const list = await fetch(base + '/console/api/submissions', { headers }).then(r => r.json());
  assert.strictEqual(list.list.find(r => r.id === 'feedback-1').status, 'new');
  console.log('✅ 问题反馈：已读 / 未读状态正常，已读不发邮件');
  console.log('✅ 素材请求：已上新状态与邮件通知保持不变');
}

main().then(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}).catch(error => {
  console.error(error);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
