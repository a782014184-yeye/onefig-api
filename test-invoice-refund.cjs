// 发票与退款联动隔离测试：虚构订单、本地服务，不操作商户资金。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-invoice-refund-'));
const consoleDir = path.join(dataDir, 'console');
fs.mkdirSync(consoleDir, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(consoleDir, name), JSON.stringify(value, null, 1));
const read = name => JSON.parse(fs.readFileSync(path.join(consoleDir, name), 'utf8'));
write('users.json', [{ id: 'u-invoice', name: '虚构用户', email: 'invoice@example.invalid', level: 'none', verified: true, pwdVer: 0 }]);
write('materials.json', [{ folder: '测试系列', materials: [
  { id: '测试系列/已开具', title: '已开具', file: '已开具.png' },
  { id: '测试系列/待处理', title: '待处理', file: '待处理.png' },
] }]);
write('orders.json', [
  { id: 'order-issued', userId: 'u-invoice', kind: 'single', materialId: '测试系列/已开具', amount: 6.9, status: 'paid', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'order-pending', userId: 'u-invoice', kind: 'single', materialId: '测试系列/待处理', amount: 6.9, status: 'paid', createdAt: '2026-11-01T00:00:00.000Z' },
]);
write('purchases.json', [
  { userId: 'u-invoice', materialId: '测试系列/已开具', orderId: 'order-issued' },
  { userId: 'u-invoice', materialId: '测试系列/待处理', orderId: 'order-pending' },
]);
write('downloads.json', []);
write('refund-log.json', []);
write('invoices.json', [
  { id: 'INV-TEST-ISSUED', userId: 'u-invoice', orderId: 'order-issued', status: 'issued', invoiceNumber: 'LOCAL-001', createdAt: '2026-11-02T00:00:00.000Z' },
  { id: 'INV-TEST-PENDING', userId: 'u-invoice', orderId: 'order-pending', status: 'pending', createdAt: '2026-11-02T00:00:00.000Z' },
]);
const port = 18202;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ONEFIG_ENV: 'test', ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: 'invoice-test-secret', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', x => { logs += x; });
child.stderr.on('data', x => { logs += x; });

(async () => {
  let token = '';
  const request = async (route, options = {}) => {
    const r = await fetch(base + route, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    const login = await request('/console/api/login', { method: 'POST', body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) });
    token = login.data.token;
    assert.ok(token);

    const blocked = await request('/console/api/orders/order-issued/refund', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /红冲/);
    assert.equal(read('orders.json').find(o => o.id === 'order-issued').status, 'paid');

    const red = await request('/console/api/invoices/INV-TEST-ISSUED', { method: 'PATCH', body: JSON.stringify({ status: 'red_flushed', statusNote: '本地测试红冲' }) });
    assert.equal(red.status, 200, JSON.stringify(red.data));
    const refundedIssued = await request('/console/api/orders/order-issued/refund', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    assert.equal(refundedIssued.status, 200, JSON.stringify(refundedIssued.data));
    assert.equal(read('orders.json').find(o => o.id === 'order-issued').status, 'refunded');

    const refundedPending = await request('/console/api/orders/order-pending/refund', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    assert.equal(refundedPending.status, 200, JSON.stringify(refundedPending.data));
    const pendingInvoice = read('invoices.json').find(row => row.id === 'INV-TEST-PENDING');
    assert.equal(pendingInvoice.status, 'rejected');
    assert.match(pendingInvoice.statusNote, /订单已退款/);
    assert.equal(read('orders.json').find(o => o.id === 'order-pending').status, 'refunded');
    assert.ok(read('invoices.json').every(row => row.id), '退款不得删除发票审计记录');

    console.log('✓ 已开具退款阻断、红冲后退款、pending 自动驳回与审计保留全部通过');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
