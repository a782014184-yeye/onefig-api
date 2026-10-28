// 用户全部订单明细渲染测试：虚构订单，不启动服务、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const match = source.match(/const allOrderRows=([\s\S]*?);\n  showModal/);
assert.ok(match, '必须存在全部订单渲染逻辑');
const d = { orders: [
  { id: 'member-order', outTradeNo: 'merchant32chars0000000000000001', transactionId: 'wx-transaction-1', plan: 'pro', amount: 99.9, status: 'paid', payChannel: 'alipay', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'single-order', kind: 'single', materialTitle: '线粒体-纵剖面', previewSeries: '细胞器', previewFile: '线粒体.png', previewLocal: false, amount: 6.9, status: 'pending', channel: '微信支付', createdAt: '2026-10-02T00:00:00Z' },
  { id: 'export-order', kind: 'export', exportCode: 'OF-2026-TEST01', preview: '/console/api/export-records/img?id=export-1', amount: 6.9, status: 'paid', payChannel: '支付宝', createdAt: '2026-10-03T00:00:00Z' },
  { id: 'refunded-order', kind: 'single', materialTitle: '已退款素材', refundedLicenseCodes: ['OF-2026-SINGLE1'], amount: 6.9, status: 'refunded', createdAt: '2026-10-04T00:00:00Z' },
  { id: 'credit-order', kind: 'credit', materialTitle: '100 积分', credits: 100, amount: 9.9, status: 'paid', createdAt: '2026-10-05T00:00:00Z' },
] };
const lvName = { none: '非会员', basic: '青果会员', pro: '红果会员', team: '金果会员' };
const esc = value => String(value);
const yuan = value => '¥' + Number(value).toFixed(1);
const fmtT = value => value;
const OSS_P = 'https://oss.test/';
const getTK = () => 'token';
const rows = eval('(' + match[1].replace(/\\'/g, "'") + ')');
assert.match(rows, /红果会员/);
assert.match(rows, /单张素材/);
assert.match(rows, /画板导出/);
assert.match(rows, /积分充值/);
assert.match(rows, /100 积分/);
assert.match(rows, /refundOrder\('credit-order'\)/);
assert.match(rows, /merchant32chars0000000000000001/);
assert.match(rows, /wx-transaction-1/);
assert.match(rows, /singleorder/);
assert.match(rows, /exportorder/);
assert.match(rows, /复制商户单号/);
assert.match(rows, /复制交易号/);
assert.match(rows, /未记录/);
assert.match(source, /style.height='92vh'/);
assert.match(rows, /待支付/);
assert.match(rows, /已支付/);
assert.match(rows, /线粒体-纵剖面/);
assert.match(rows, /微信支付/);
assert.match(rows, /支付宝/);
assert.match(source, /style.width='1200px'/);
assert.match(source, /style.maxWidth='96vw'/);
assert.match(source, /id="dt-b6"/);
assert.match(source, /id="dt-p6" style="display:none;overflow:visible"/);
assert.doesNotMatch(source, /id="dt-p[1-6]"[^>]*max-height/);
for (let i = 1; i <= 6; i++) assert.match(source, new RegExp(`id="dt-p${i}"[^>]*overflow:visible`));
assert.match(source, /\[1,2,3,4,5,6\]/);
assert.match(rows, /refundOrder\('member-order'\)/);
assert.match(rows, /已退款/);
assert.match(source, /<th>操作<\/th>/);
assert.match(source, /colspan="8"/);
assert.match(source, /window\.merchantLookupModal/);
assert.match(source, /window\.doMerchantLookup/);
assert.match(source, /\/console\/api\/order-lookup\?merchantNo=/);
assert.match(source, /previousOutTradeNos/);
assert.match(source, /window\.licenseLookupModal/);
assert.match(source, /window\.doLicenseLookup/);
assert.match(source, /\/console\/api\/license-lookup\?code=/);
assert.match(source, /window\.refundOrder/);
assert.match(source, /window\.doRefund/);
assert.match(source, /window\.undoRefundOrder/);
assert.match(source, /\/undo-refund/);
assert.match(source, /退款回收/);
assert.match(rows, /OF-2026-TEST01/);
assert.match(rows, /OF-2026-SINGLE1/);
assert.match(rows, /授权码：/);
assert.match(rows, /复制授权码/);
assert.match(rows, /undoRefundOrder\('refunded-order'\)/);
assert.match(source, /o.status==='refunded'\?'#d6336c'/);
assert.doesNotMatch(rows, /btn btn-d btn-xs/);
assert.match(rows, /btn btn-g btn-xs" onclick="refundOrder/);
assert.match(rows, /export-records\/img\?id=export-1&t=token/);
assert.match(rows, /https:\/\/oss\.test\//);
assert.match(rows, /\.webp/);
assert.match(rows, /viewMat\(this\.src\)/);
console.log('✓ 订单单号、授权码和对应预览图完整，支持退款与撤销');
