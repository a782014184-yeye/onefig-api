// 素材卡片：只留精选/删除，双击名称原地改名并持久化
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const puppeteer = require('../canvas-lab/node_modules/puppeteer-core');
const PORT = 8149;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-inline-rename-'));
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'users.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), JSON.stringify([{ folder: '测试系列', materials: [{ title: '旧名字', file: '旧名字.png', local: true, downloads: 0, size: 0 }] }]));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TOKEN_SECRET: 'isolated-test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', d => { logs += d; });
child.stderr.on('data', d => { logs += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let browser;
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) { try { healthy = (await fetch(BASE + '/healthz')).ok; } catch {} if (!healthy) await sleep(100); }
    assert.ok(healthy, logs);
    const login = await (await fetch(BASE + '/console/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) })).json();
    browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1440, height: 900 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.url().includes('/api/materials/rename')) console.log('改名接口:', r.status(), r.url()); });
    await page.evaluateOnNewDocument(t => localStorage.setItem('onefig_console_token', t), login.token);
    await page.goto(BASE + '/admin#/materials', { waitUntil: 'networkidle2' });
    await page.click('.folder'); await sleep(400);
    const actions = await page.$$eval('.mat button', bs => bs.map(b => b.textContent.trim()));
    assert.deepEqual(actions, ['☆ 精选', '删除']);
    assert.equal(await page.$eval('.mat .mat-del', e => getComputedStyle(e).display), 'inline-block');
    console.log('✓ 卡片操作只保留精选和删除，且无需悬停始终显示');
    await page.$eval('.mat .t', e => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await page.waitForSelector('.mat .t input');
    await page.$eval('.mat .t input', e => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '新名字');
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.focus();
    });
    await page.keyboard.press('Enter'); await sleep(1000);
    console.log('保存中状态:', await page.evaluate(() => ({ toast: document.getElementById('toast')?.textContent, input: document.querySelector('.mat .t input')?.value, disabled: document.querySelector('.mat .t input')?.disabled })));
    await page.waitForFunction(() => !document.querySelector('.mat .t input'), { timeout: 10000 });
    assert.equal(await page.$eval('.mat .t', e => e.textContent), '新名字');
    const data = await (await fetch(BASE + '/console/api/materials', { headers: { Authorization: `Bearer ${login.token}` } })).json();
    assert.equal(data.series[0].materials[0].title, '新名字');
    assert.deepEqual(errors, []);
    console.log('✓ 双击名称回车保存，后台数据同步更新');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
