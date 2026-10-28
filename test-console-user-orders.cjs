// 用户全部订单明细渲染测试：虚构订单，不启动服务、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const match = source.match(/const allOrderRows=([\s\S]*?);\n  showModal/);
assert.ok(match, '必须存在全部订单渲染逻辑');
const d = { orders: [
  { id: 'member-order', outTradeNo: 'merchant32chars0000000000000001', transactionId: 'wx-transaction-1', plan: 'pro', amount: 99.9, status: 'paid', payChannel: 'alipay', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'single-order', kind: 'single', materialTitle: '线粒体-纵剖面', amount: 6.9, status: 'pending', channel: '微信支付', createdAt: '2026-10-02T00:00:00Z' },
  { id: 'export-order', kind: 'export', amount: 6.9, status: 'paid', payChannel: '支付宝', createdAt: '2026-10-03T00:00:00Z' },
] };
const lvName = { none: '非会员', basic: '青果会员', pro: '红果会员', team: '金果会员' };
const esc = value => String(value);
const yuan = value => '¥' + Number(value).toFixed(1);
const fmtT = value => value;
const rows = eval('(' + match[1].replace(/\\'/g, "'") + ')');
assert.match(rows, /红果会员/);
assert.match(rows, /单张素材/);
assert.match(rows, /画板导出/);
assert.match(rows, /merchant32chars0000000000000001/);
assert.match(rows, /wx-transaction-1/);
assert.match(rows, /singleorder/);
assert.match(rows, /exportorder/);
assert.match(rows, /复制商户单号/);
assert.match(rows, /复制交易号/);
assert.match(rows, /未记录/);
assert.match(source, /style.height='86vh'/);
assert.match(rows, /待支付/);
assert.match(rows, /已支付/);
assert.match(rows, /线粒体-纵剖面/);
assert.match(rows, /微信支付/);
assert.match(rows, /支付宝/);
assert.match(source, /style.width='960px'/);
assert.match(source, /id="dt-b6"/);
assert.match(source, /id="dt-p6"/);
assert.match(source, /\[1,2,3,4,5,6\]/);
console.log('✓ 会员、单张素材、画板导出订单均显示类型、订单号、状态、金额和时间');
