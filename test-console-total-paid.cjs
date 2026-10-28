// 累计付款口径测试：待支付、失效、失败均不计入。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const match = source.match(/totalPaid: rmb\((my\.filter\(o => o\.status === 'paid'\)\.reduce\(\(s, o\) => s \+ o\.amount, 0\))\)/);
assert.ok(match, '账号详情必须只按 paid 过滤后累计');
const my = [
  { amount: 99.9, status: 'paid' },
  { amount: 6.9, status: 'pending' },
  { amount: 6.9, status: 'expired' },
  { amount: 6.9, status: 'failed' },
];
const total = eval(match[1]);
assert.equal(total, 99.9, '累计付款只能包含已支付订单');
console.log('✓ 累计付款仅统计 paid，待支付/失效/失败订单不计入');
