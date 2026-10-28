// 退款、权益与授权码回收隔离测试：仅使用临时目录和虚构账号，不访问生产数据或支付平台。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-refund-'));
const consoleDir = path.join(dataDir, 'console');
const aiDir = path.join(dataDir, 'ai');
fs.mkdirSync(consoleDir, { recursive: true });
fs.mkdirSync(aiDir, { recursive: true });
const file = (name, dir = consoleDir) => path.join(dir, name);
const write = (name, rows, dir = consoleDir) => fs.writeFileSync(file(name, dir), JSON.stringify(rows, null, 1));
const read = (name, dir = consoleDir) => JSON.parse(fs.readFileSync(file(name, dir), 'utf8'));
const loginUser = (id, extra = {}) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return {
    id, name: `虚构用户-${id}`, email: `${id}@example.invalid`, level: 'none', verified: true,
    salt, passHash: crypto.scryptSync('test-password', salt, 32).toString('hex'), pwdVer: 0,
    joinedAt: '2026-10-01T00:00:00.000Z', ...extra,
  };
};
const users = [
  loginUser('u-member', { level: 'pro', credits: 1000, creditsGrantedFor: 'pro', memberSince: '2026-10-03T00:00:00.000Z' }),
  loginUser('u-changed', { level: 'team', credits: 5, creditsGrantedFor: 'team' }),
  loginUser('u-single'),
  loginUser('u-export-unused', { exportCredits: 1 }),
  loginUser('u-export-used', { exportCredits: 1 }),
  loginUser('u-export-commit', { exportCredits: 1 }),
  loginUser('u-legacy', { exportCredits: 0 }),
  loginUser('u-credit', { credits: 80 }),
  loginUser('u-other', { level: 'team', credits: 3000 }),
];
const orders = [
  { id: 'm-basic', userId: 'u-member', plan: 'basic', amount: 29.9, status: 'paid', createdAt: '2026-10-02T00:00:00.000Z', paidAt: '2026-10-02T00:00:00.000Z' },
  { id: 'm-pro', userId: 'u-member', plan: 'pro', amount: 99.9, status: 'paid', createdAt: '2026-10-03T00:00:00.000Z', paidAt: '2026-10-03T00:00:00.000Z', outTradeNo: 'MEMBERPRO001', transactionId: 'TX-MEMBER-PRO' },
  { id: 'm-changed', userId: 'u-changed', plan: 'pro', amount: 99.9, status: 'paid', createdAt: '2026-10-03T00:00:00.000Z', paidAt: '2026-10-03T00:00:00.000Z' },
  { id: 'm-other', userId: 'u-other', plan: 'basic', amount: 29.9, status: 'paid', createdAt: '2026-10-01T00:00:00.000Z', paidAt: '2026-10-01T00:00:00.000Z' },
  { id: 's-single', userId: 'u-single', kind: 'single', materialId: '测试系列/细胞', materialTitle: '细胞', amount: 6.9, status: 'paid', createdAt: '2026-10-04T00:00:00.000Z', paidAt: '2026-10-04T00:00:00.000Z' },
  { id: 'e-unused', userId: 'u-export-unused', kind: 'export', amount: 6.9, status: 'paid', createdAt: '2026-10-04T00:00:00.000Z', paidAt: '2026-10-04T00:00:00.000Z' },
  { id: 'e-used', userId: 'u-export-used', kind: 'export', amount: 6.9, status: 'paid', createdAt: '2026-10-04T00:00:00.000Z', paidAt: '2026-10-04T00:00:00.000Z', exportCode: 'OF-2026-USED01', consumedAt: '2026-10-05T00:00:00.000Z' },
  { id: 'e-other', userId: 'u-export-used', kind: 'export', amount: 6.9, status: 'paid', createdAt: '2026-10-06T00:00:00.000Z', paidAt: '2026-10-06T00:00:00.000Z' },
  { id: 'e-commit-legacy', userId: 'u-export-commit', kind: 'export', amount: 6.9, status: 'paid', createdAt: '2026-10-03T00:00:00.000Z', paidAt: '2026-10-03T00:00:00.000Z' },
  { id: 'e-commit', userId: 'u-export-commit', kind: 'export', creditSchema: 1, amount: 6.9, status: 'paid', createdAt: '2026-10-04T00:00:00.000Z', paidAt: '2026-10-04T00:00:00.000Z' },
  { id: 'e-legacy', userId: 'u-legacy', kind: 'export', amount: 6.9, status: 'paid', createdAt: '2026-10-04T00:00:00.000Z', paidAt: '2026-10-04T00:00:00.000Z' },
  { id: 's-pending', userId: 'u-single', kind: 'single', materialId: '测试系列/其他', amount: 6.9, status: 'pending', createdAt: '2026-10-04T00:00:00.000Z' },
];
const downloads = [
  { userId: 'u-single', materialId: '测试系列/细胞', materialTitle: '细胞', materialSeries: '测试系列', code: 'OF-2026-SING01', time: '2026-10-04T01:00:00.000Z' },
  { userId: 'u-single', materialId: '测试系列/细胞', materialTitle: '细胞', materialSeries: '测试系列', code: 'OF-2026-SING01', time: '2026-10-04T02:00:00.000Z', free: true },
  { userId: 'u-export-used', kind: 'export', orderId: 'e-used', materialId: '画板导出作品', boardTitle: '已导出画板', code: 'OF-2026-USED01', thumb: 'data:image/png;base64,TEST', time: '2026-10-05T00:00:00.000Z' },
  { userId: 'u-other', materialId: '测试系列/其他', materialTitle: '其他', materialSeries: '测试系列', code: 'OF-2026-VALID1', time: '2026-10-04T01:00:00.000Z' },
];
write('users.json', users);
write('orders.json', orders);
write('purchases.json', [{ userId: 'u-single', materialId: '测试系列/细胞', orderId: 's-single', amount: 6.9 }]);
write('downloads.json', downloads);
write('materials.json', [{ folder: '测试系列', materials: [
  { id: '测试系列/细胞', title: '细胞', series: '测试系列', file: '细胞.png' },
  { id: '测试系列/其他', title: '其他', series: '测试系列', file: '其他.png' },
] }]);
write('level-log.json', [
  { userId: 'u-member', from: 'none', to: 'basic', time: '2026-10-02T00:00:00.000Z', by: 'system' },
  { userId: 'u-member', from: 'basic', to: 'pro', time: '2026-10-03T00:00:00.000Z', by: 'system' },
  { userId: 'u-changed', from: 'none', to: 'pro', time: '2026-10-03T00:00:00.000Z', by: 'system' },
]);
write('credit-log.json', [], aiDir);
write('credit-orders.json', [
  { id: 'c-credit', userId: 'u-credit', pkg: 'p100', credits: 100, amount: 9.9, status: 'paid', createdAt: '2026-10-05T00:00:00.000Z', paidAt: '2026-10-05T00:00:00.000Z', outTradeNo: 'CREDITPAY001', transactionId: 'TX-CREDIT-1' },
  { id: 'c-pending', userId: 'u-credit', pkg: 'p100', credits: 100, amount: 9.9, status: 'pending', createdAt: '2026-10-06T00:00:00.000Z' },
], aiDir);
write('refund-log.json', []);

const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8090', DATA_DIR: dataDir, ONEFIG_WEB_ROOT: path.join(dataDir, 'web'), TOKEN_SECRET: 'test-secret', ONEFIG_ENV: 'test', ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password' },
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
const base = 'http://127.0.0.1:8090';
let token = '';
const request = async (url, options = {}, admin = true) => {
  const res = await fetch(base + url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(admin ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const preview = id => request(`/console/api/orders/${id}/refund-preview`);
const refund = (id, confirm = true) => request(`/console/api/orders/${id}/refund`, { method: 'POST', body: JSON.stringify({ confirm }) });
const undo = (id, confirm = true) => request(`/console/api/orders/${id}/undo-refund`, { method: 'POST', body: JSON.stringify({ confirm }) });
const verify = code => request(`/api/verify?code=${encodeURIComponent(code)}`, {}, false);
const lookup = code => request(`/console/api/license-lookup?code=${encodeURIComponent(code)}`);
const user = id => request(`/console/api/users/${id}`);
const snapshot = () => Object.fromEntries([
  file('users.json'), file('orders.json'), file('purchases.json'), file('downloads.json'), file('level-log.json'), file('refund-log.json'), file('credit-log.json', aiDir), file('credit-orders.json', aiDir),
].map(f => [f, fs.readFileSync(f, 'utf8')]));

(async () => {
  try {
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { healthy = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(healthy, logs);
    const login = await request('/console/api/login', { method: 'POST', body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) }, false);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    token = login.body.token;

    const beforePreview = snapshot();
    const memberPreview = await preview('m-pro');
    assert.equal(memberPreview.status, 200);
    assert.equal(memberPreview.body.impact.previousLevel, 'basic');
    assert.equal(memberPreview.body.impact.creditsDelta, 750);
    assert.deepEqual(snapshot(), beforePreview, '退款预览不得写入任何数据文件');
    console.log('✓ 预览只读；会员升级退款只计算本单 750 积分差额');

    assert.equal((await refund('m-pro', false)).status, 400);
    const memberRefund = await refund('m-pro');
    assert.equal(memberRefund.status, 200, JSON.stringify(memberRefund.body));
    let member = read('users.json').find(u => u.id === 'u-member');
    assert.equal(member.level, 'basic');
    assert.equal(member.credits, 250);
    assert.equal(member.memberSince, '2026-10-02T00:00:00.000Z');
    assert.equal(read('orders.json').find(o => o.id === 'm-pro').status, 'refunded');
    assert.equal(read('orders.json').find(o => o.id === 'm-other').status, 'paid', '不得误用其他用户订单');
    assert.equal(read('credit-log.json', aiDir).at(-1).delta, -750);
    assert.equal((await user('u-member')).body.totalPaid, 29.9);
    assert.equal((await refund('m-pro')).status, 400, '重复退款必须拒绝');
    assert.equal(read('refund-log.json').filter(l => l.orderId === 'm-pro').length, 1);
    console.log('✓ 会员恢复上一档位、累计付款剔除退款、重复执行被拒绝');

    const changed = await refund('m-changed');
    assert.equal(changed.status, 200);
    member = read('users.json').find(u => u.id === 'u-changed');
    assert.equal(member.level, 'team', '档位另有变化时不得自动降级');
    assert.equal(member.credits, 0, '积分不得扣成负数');
    assert.equal(read('credit-log.json', aiDir).at(-1).delta, -5, '积分流水只记录实际扣减量');
    console.log('✓ 会员另有变更时不改等级，积分最低为 0 且流水按实记录');

    assert.equal((await verify('OF-2026-SING01')).body.ok, true);
    const singlePreview = await preview('s-single');
    assert.deepEqual(singlePreview.body.impact.licenseCodes, ['OF-2026-SING01']);
    const singleRefund = await refund('s-single');
    assert.equal(singleRefund.status, 200);
    assert.equal(read('purchases.json').length, 0);
    const singleLogs = read('downloads.json').filter(l => l.code === 'OF-2026-SING01');
    assert.equal(singleLogs.length, 2, '历史下载记录必须保留');
    assert.ok(singleLogs.every(l => l.status === 'refund-revoked' && l.refundOrderId === 's-single'));
    const publicSingle = await verify('OF-2026-SING01');
    assert.equal(publicSingle.body.ok, false);
    assert.equal(publicSingle.body.error, '授权码已退款回收');
    const adminSingle = await lookup('of-2026-sing01');
    assert.equal(adminSingle.status, 200);
    assert.equal(adminSingle.body.record.status, '退款回收');
    assert.equal(adminSingle.body.record.title, '细胞');
    assert.equal(adminSingle.body.user.id, 'u-single');
    assert.equal(adminSingle.body.order.status, 'refunded');
    const merchantLookup = await request('/console/api/order-lookup?merchantNo=S-SINGLE');
    assert.equal(merchantLookup.status, 200, JSON.stringify(merchantLookup.body));
    assert.equal(merchantLookup.body.order.id, 's-single');
    assert.equal(merchantLookup.body.order.status, 'refunded');
    assert.equal(merchantLookup.body.user.id, 'u-single');
    assert.equal(merchantLookup.body.licenses.length, 1);
    assert.equal(merchantLookup.body.licenses[0].code, 'OF-2026-SING01');
    assert.equal(merchantLookup.body.licenses[0].status, '退款回收');
    assert.equal((await request('/console/api/order-lookup?merchantNo=NOT-EXIST')).body.ok, false);
    assert.equal((await verify('OF-2026-VALID1')).body.ok, true, '不得误回收无关授权码');
    assert.equal((await refund('s-pending')).status, 400);
    console.log('✓ 单张素材保留下载历史、公开验真失败、后台可查且不影响其他码');

    const unusedPreview = await preview('e-unused');
    assert.equal(unusedPreview.body.impact.exportCreditsDelta, 1);
    assert.equal((await refund('e-unused')).status, 200);
    assert.equal(read('users.json').find(u => u.id === 'u-export-unused').exportCredits, 0);
    const used = await refund('e-used');
    assert.equal(used.status, 200);
    assert.deepEqual(used.body.impact.licenseCodes, ['OF-2026-USED01']);
    assert.equal(read('users.json').find(u => u.id === 'u-export-used').exportCredits, 1, '已使用订单不得扣另一笔未使用权益');
    assert.equal((await verify('OF-2026-USED01')).body.ok, false);
    assert.equal((await lookup('OF-2026-USED01')).body.record.status, '退款回收');
    const legacyPreview = await preview('e-legacy');
    assert.equal(legacyPreview.body.impact.exportCreditsDelta, 0);
    assert.equal(legacyPreview.body.impact.licenseCodes.length, 0);
    assert.match(legacyPreview.body.impact.lines[0], /人工核对/);
    console.log('✓ 未使用导出扣次数，已使用导出收码，旧关联不清时不猜扣');

    const userLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'u-export-commit@example.invalid', password: 'test-password' }) }, false);
    assert.equal(userLogin.status, 200, JSON.stringify(userLogin.body));
    const committed = await request('/api/export/commit', {
      method: 'POST', body: JSON.stringify({ fmt: 'png', dpi: 300, boardTitle: '订单绑定测试画板' }),
      headers: { Authorization: `Bearer ${userLogin.body.token}` },
    }, false);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.ok, true, JSON.stringify(committed.body));
    const newCode = committed.body.code;
    const committedOrder = read('orders.json').find(o => o.id === 'e-commit');
    assert.equal(committedOrder.exportCode, newCode);
    assert.ok(committedOrder.consumedAt);
    assert.equal(read('downloads.json').find(l => l.code === newCode).orderId, 'e-commit');
    assert.equal((await verify(newCode)).body.ok, true);
    const committedRefund = await refund('e-commit');
    assert.equal(committedRefund.status, 200);
    assert.deepEqual(committedRefund.body.impact.licenseCodes, [newCode]);
    assert.equal((await verify(newCode)).body.ok, false);
    assert.equal((await lookup(newCode)).body.order.id, 'e-commit');
    console.log('✓ 新导出自动绑定订单与授权码，退款可精确回收');

    const visibleSingleOrders = (await user('u-single')).body.orders;
    assert.equal(visibleSingleOrders.some(o => o.id === 's-pending'), false, '后台全部订单不得展示待支付记录');
    assert.equal(read('orders.json').some(o => o.id === 's-pending' && o.status === 'pending'), true, '隐藏列表不得删除待支付数据');

    const creditPreview = await preview('c-credit');
    assert.equal(creditPreview.status, 200, JSON.stringify(creditPreview.body));
    assert.equal(creditPreview.body.impact.kind, 'credit');
    assert.equal(creditPreview.body.impact.creditsDelta, 80, '积分不足时只扣当前余额');
    const creditBefore = await user('u-credit');
    assert.equal(creditBefore.body.orders[0].kind, 'credit');
    assert.equal(creditBefore.body.orders[0].materialTitle, '100 积分');
    assert.equal(creditBefore.body.creditOrders.some(o => o.id === 'c-pending'), false, '后台积分订单不得展示待支付记录');
    assert.equal(creditBefore.body.totalPaid, 9.9);
    const creditRefund = await refund('c-credit');
    assert.equal(creditRefund.status, 200, JSON.stringify(creditRefund.body));
    assert.equal(read('users.json').find(u => u.id === 'u-credit').credits, 0);
    assert.equal(read('credit-orders.json', aiDir).find(o => o.id === 'c-credit').status, 'refunded');
    assert.equal(read('credit-log.json', aiDir).at(-1).delta, -80);
    assert.equal((await user('u-credit')).body.totalPaid, 0);
    const creditLookup = await request('/console/api/order-lookup?merchantNo=CREDITPAY001');
    assert.equal(creditLookup.body.order.id, 'c-credit');
    assert.equal(creditLookup.body.order.kind, 'credit');
    assert.equal(creditLookup.body.user.id, 'u-credit');
    assert.equal((await refund('c-credit')).status, 400);
    console.log('✓ 积分订单并入全部订单和单号查询，按实际余额退款');

    const detail = await user('u-export-used');
    assert.equal(detail.body.downloads.find(d => d.code === 'OF-2026-USED01').licenseStatus, '退款回收');
    assert.equal(read('refund-log.json').length, 7, '每次成功退款只留一条审计记录');
    console.log('✓ 用户详情显示退款回收，退款审计日志完整');

    assert.equal((await undo('m-pro', false)).status, 400);
    const memberUndo = await undo('m-pro');
    assert.equal(memberUndo.status, 200, JSON.stringify(memberUndo.body));
    let restoredUser = read('users.json').find(u => u.id === 'u-member');
    assert.equal(restoredUser.level, 'pro');
    assert.equal(restoredUser.credits, 1000);
    assert.equal(restoredUser.memberSince, '2026-10-03T00:00:00.000Z');
    assert.equal((await user('u-member')).body.totalPaid, 129.8);
    assert.equal((await undo('m-pro')).status, 400, '重复撤销必须拒绝');
    assert.equal((await refund('m-pro')).status, 200);
    restoredUser = read('users.json').find(u => u.id === 'u-member');
    assert.equal(restoredUser.level, 'basic');
    assert.equal(restoredUser.credits, 250);
    console.log('✓ 会员撤销按快照恢复档位和积分，可再次退款且不能重复撤销');

    const changedRefund = read('orders.json').find(o => o.id === 'm-changed');
    assert.equal(changedRefund.refundUndoData.creditsRestored, 5, '扣到 0 时只记录真实扣减量');
    assert.equal((await undo('m-changed')).status, 200);
    assert.equal(read('users.json').find(u => u.id === 'u-changed').credits, 5, '撤销不得把套餐积分全部重复送回');
    assert.equal((await refund('m-changed')).status, 200);

    assert.equal((await undo('s-single')).status, 200);
    assert.equal(read('purchases.json').length, 1);
    assert.equal((await verify('OF-2026-SING01')).body.ok, true, '撤销后素材授权码恢复有效');
    assert.equal((await refund('s-single')).status, 200);
    assert.equal((await verify('OF-2026-SING01')).body.ok, false);

    assert.equal((await undo('e-unused')).status, 200);
    assert.equal(read('users.json').find(u => u.id === 'u-export-unused').exportCredits, 1);
    assert.equal((await refund('e-unused')).status, 200);
    assert.equal(read('users.json').find(u => u.id === 'u-export-unused').exportCredits, 0);

    assert.equal((await undo('e-used')).status, 200);
    assert.equal((await verify('OF-2026-USED01')).body.ok, true, '撤销后导出授权码恢复有效');
    assert.equal(read('users.json').find(u => u.id === 'u-export-used').exportCredits, 1);
    assert.equal((await refund('e-used')).status, 200);
    assert.equal((await verify('OF-2026-USED01')).body.ok, false);

    assert.equal((await undo('e-commit')).status, 200);
    assert.equal((await verify(newCode)).body.ok, true);
    assert.equal((await refund('e-commit')).status, 200);
    assert.equal((await verify(newCode)).body.ok, false);
    const ordersWithCodes = (await user('u-export-used')).body.orders;
    assert.equal(ordersWithCodes.find(o => o.id === 'e-used').exportCode, 'OF-2026-USED01');
    assert.equal(ordersWithCodes.find(o => o.id === 'e-used').licenseStatus, '退款回收');
    assert.equal(ordersWithCodes.find(o => o.id === 'e-used').preview, 'data:image/png;base64,TEST');
    const singleOrders = (await user('u-single')).body.orders;
    assert.equal(singleOrders.find(o => o.id === 's-single').previewSeries, '测试系列');
    assert.equal(singleOrders.find(o => o.id === 's-single').previewFile, '细胞.png');
    assert.equal(singleOrders.find(o => o.id === 's-single').licenseCode, 'OF-2026-SING01');
    assert.equal(singleOrders.find(o => o.id === 's-single').licenseStatus, '退款回收');
    console.log('✓ 素材和导出撤销恢复授权，订单列表保留对应授权码');

    const creditUndo = await undo('c-credit');
    assert.equal(creditUndo.status, 200, JSON.stringify(creditUndo.body));
    assert.equal(read('users.json').find(u => u.id === 'u-credit').credits, 80, '积分撤销只恢复实际扣减量');
    assert.equal(read('credit-orders.json', aiDir).find(o => o.id === 'c-credit').status, 'paid');
    assert.equal((await user('u-credit')).body.totalPaid, 9.9);
    assert.equal((await undo('c-credit')).status, 400);
    assert.equal((await refund('c-credit')).status, 200);
    assert.equal(read('users.json').find(u => u.id === 'u-credit').credits, 0);
    assert.equal(read('credit-orders.json', aiDir).find(o => o.id === 'c-credit').status, 'refunded');
    console.log('✓ 积分充值支持撤销与再次退款，不重复恢复');

    const legacyOrders = read('orders.json');
    delete legacyOrders.find(o => o.id === 'm-changed').refundUndoData;
    write('orders.json', legacyOrders);
    const unsafeLegacyUndo = await undo('m-changed');
    assert.equal(unsafeLegacyUndo.status, 400, '旧积分快照不完整时必须阻止不安全撤销');
    assert.match(unsafeLegacyUndo.body.error, /不能安全撤销/);
    assert.equal(read('refund-log.json').length, 14, '退款、撤销、再次退款均保留审计轨迹');
    assert.equal(read('refund-log.json').filter(l => l.undoneAt).length, 7);
    console.log('✓ 旧记录安全拦截，退款与撤销审计轨迹完整');
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
