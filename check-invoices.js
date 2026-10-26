const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registerInvoices = require('./invoices');

const dataDir = path.join(__dirname, '.tmp-invoice-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'console', 'orders.json'), JSON.stringify([
  { id: 'single-paid', userId: 'u1', kind: 'single', materialId: 'MAT-001', materialTitle: '细胞示意图', amount: 6.9, status: 'paid', paidAt: '2026-10-25T08:00:00.000Z' },
  { id: 'export-paid', userId: 'u1', kind: 'export', amount: 6.9, status: 'paid', paidAt: '2026-10-24T08:00:00.000Z' },
  { id: 'single-pending', userId: 'u1', kind: 'single', materialId: 'MAT-002', amount: 6.9, status: 'pending' },
  { id: 'plan-paid', userId: 'u1', plan: 'pro', amount: 99.9, status: 'paid' },
]));

const routes = new Map();
const app = {
  get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
  post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
};
const authUser = (req, res, next) => {
  req.user = { id: req.headers['x-test-user'] || 'u1', name: '测试用户' };
  next();
};
registerInvoices(app, { authUser, DATA_DIR: dataDir, submitRateLimit: (req, res, next) => next() });

function request(method, route, body, userId = 'u1') {
  const handlers = routes.get(`${method} ${route}`);
  assert.ok(handlers, `missing route ${method} ${route}`);
  const req = { headers: { 'x-test-user': userId }, body: body || {} };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let index = 0;
  const next = () => handlers[index++](req, res, next);
  next();
  return res;
}

const valid = {
  orderId: 'single-paid',
  buyerType: 'company',
  title: '杭州示例科技有限公司',
  taxId: '91330102MAKM5NHF44',
  invoiceType: 'normal',
  email: 'Finance@Example.com',
  note: '',
  confirmed: true,
};

const initial = request('GET', '/api/invoices');
assert.equal(initial.payload.ok, true);
assert.deepEqual(initial.payload.orders.map(order => order.id), ['single-paid', 'export-paid']);
assert.equal(initial.payload.orders[0].businessType, 'MATERIAL_LICENSE');
assert.equal(initial.payload.orders[1].businessType, 'CANVAS_EXPORT');

const invalid = request('POST', '/api/invoices', { ...valid, taxId: 'bad' });
assert.equal(invalid.statusCode, 400);

const created = request('POST', '/api/invoices', valid);
assert.equal(created.statusCode, 201);
assert.equal(created.payload.application.email, 'finance@example.com');
assert.equal(created.payload.application.status, 'pending');
assert.ok(created.payload.application.id.startsWith('INV-'));

const duplicate = request('POST', '/api/invoices', valid);
assert.equal(duplicate.statusCode, 409);

const otherUser = request('POST', '/api/invoices', valid, 'u2');
assert.equal(otherUser.statusCode, 400);

const after = request('GET', '/api/invoices');
assert.deepEqual(after.payload.orders.map(order => order.id), ['export-paid']);
assert.equal(after.payload.applications.length, 1);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('发票接口检查通过：订单过滤、字段校验、提交、防重复和用户隔离。');
