// 测试账号：手动标记、图标渲染、首页收入与会员人数过滤
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const puppeteer = require('../canvas-lab/node_modules/puppeteer-core');
const PORT = 8148;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-test-accounts-'));
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
const users = [
  { id: 'real-pro', name: '真实会员', email: 'real@example.invalid', level: 'pro', joinedAt: new Date().toISOString() },
  { id: 'known-test', name: '既有测试', email: 'test@example.invalid', level: 'basic', test: true, joinedAt: new Date().toISOString() },
  { id: 'candidate', name: '待标记账号', email: 'candidate@example.invalid', level: 'pro', joinedAt: new Date().toISOString() },
];
const orders = [
  { id: 'o-real', userId: 'real-pro', plan: 'pro', amount: 100, status: 'paid', paidAt: new Date().toISOString() },
  { id: 'o-test', userId: 'known-test', plan: 'basic', amount: 50, status: 'paid', paidAt: new Date().toISOString() },
  { id: 'o-candidate', userId: 'candidate', plan: 'pro', amount: 25, status: 'paid', paidAt: new Date().toISOString() },
];
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), JSON.stringify(users));
fs.writeFileSync(path.join(dataDir, 'console', 'orders.json'), JSON.stringify(orders));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TOKEN_SECRET: 'isolated-test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => { logs += d; });
child.stderr.on('data', d => { logs += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (route, options = {}, token = '') => {
  const r = await fetch(BASE + route, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) { try { healthy = (await fetch(BASE + '/healthz')).ok; } catch {} if (!healthy) await sleep(100); }
    assert.ok(healthy, logs);
    const login = await api('/console/api/login', { method: 'POST', body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) });
    assert.equal(login.status, 200);
    const token = login.data.token;
    let stats = (await api('/console/api/stats', {}, token)).data;
    assert.equal(stats.totalRevenue, 125, '既有测试账号金额应排除');
    assert.equal(stats.levelCount.pro, 2, '标记前两个真实 pro 都计入');
    assert.equal(stats.levelCount.basic, 0, '既有测试账号会员人数应排除');
    console.log('✓ 首页原本就排除既有测试账号的金额和会员人数');

    let changed = await api('/console/api/users/candidate', { method: 'PATCH', body: JSON.stringify({ test: true }) }, token);
    assert.equal(changed.status, 200);
    stats = (await api('/console/api/stats', {}, token)).data;
    assert.equal(stats.totalRevenue, 100, '手动标记后金额应扣除');
    assert.equal(stats.levelCount.pro, 1, '手动标记后会员人数应扣除');
    const list = (await api('/console/api/users', {}, token)).data.list;
    assert.equal(list.find(u => u.id === 'candidate').test, true, '标记应持久化到用户列表');
    assert.equal(list.find(u => u.id === 'candidate').totalPaid, 25, '测试账号列表保留真实累计付款');
    assert.equal(list.find(u => u.id === 'known-test').totalPaid, 50, '既有测试账号也保留真实累计付款');
    assert.equal(list.find(u => u.id === 'real-pro').totalPaid, 100, '真实账号金额不受影响');
    console.log('✓ 列表保留真实累计付款，数据看板仍立即扣除测试账号数据');

    changed = await api('/console/api/users/candidate', { method: 'PATCH', body: JSON.stringify({ test: false }) }, token);
    assert.equal(changed.status, 200);
    stats = (await api('/console/api/stats', {}, token)).data;
    assert.equal(stats.totalRevenue, 125);
    assert.equal(stats.levelCount.pro, 2);
    console.log('✓ 取消标记后恢复计入');

    const invalid = await api('/console/api/users/candidate', { method: 'PATCH', body: JSON.stringify({ test: 'true' }) }, token);
    assert.equal(invalid.status, 400, '非布尔标记必须拒绝');
    const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
    assert.match(source, /data-test-account/);
    assert.match(source, /accountSourceBadge/);
    assert.match(source, /oncontextmenu="userTestMenu/);
    assert.match(source, /setTestAccount/);
    assert.match(source, /测<\/span>/);
    assert.match(source, /color:#7c5cbf/);
    assert.doesNotMatch(source, /testAccountBadge/);
    console.log('✓ 来源图标显示“测”、昵称紫色，右键可切换测试/非测试');

    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1440, height: 900 } });
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.message));
      await page.evaluateOnNewDocument(t => localStorage.setItem('onefig_console_token', t), token);
      await page.goto(BASE + '/admin#/users', { waitUntil: 'networkidle2' });
      await page.waitForSelector('td[oncontextmenu]');
      await page.click('td[oncontextmenu]', { button: 'right' });
      await page.waitForSelector('#user-test-menu');
      const choices = await page.$$eval('#user-test-menu button', bs => bs.map(b => b.textContent));
      assert.deepEqual(choices, ['测试', '非测试']);
      await page.evaluate(() => [...document.querySelectorAll('#user-test-menu button')].find(b => b.textContent === '测试').click());
      await sleep(500);
      assert.equal(await page.$$eval('[data-test-account]', els => els.length), 2, '右键应能把普通账号设为测试账号');
      const nameColor = await page.$eval('td[oncontextmenu] b', e => getComputedStyle(e).color);
      assert.equal(nameColor, 'rgb(124, 92, 191)');
      assert.deepEqual(pageErrors, []);
      console.log('✓ 实际右键昵称出现菜单，设为测试后来源显示“测”且昵称紫色');
    } finally {
      await browser.close();
    }
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
