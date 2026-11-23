import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCharging } from './canvas-ai/charging.mjs';

const users = [{ id: 'u1', verified: true, level: 'none', credits: 100, aiFreeUsed: {}, aiDailyUsed: {} }];
const { charge } = createCharging({ loadUsers: () => users, saveUsers: () => {} });

function run(feature, status = 200) {
  const req = { user: { id: 'u1' } };
  const res = new EventEmitter();
  res.locals = {};
  res.statusCode = status;
  let charged = false;
  charge(feature)(req, res, () => { charged = true; });
  assert(charged, `${feature} 应通过扣费闸门`);
  res.emit('finish');
  return res.locals.canvasAiTicket;
}

const gen = run('gen', 500);
assert.equal(gen.paidWith, 'free');
assert.equal(users[0].aiFreeUsed.gen, 0, '失败应退回免费生成次数');
assert.equal(users[0].credits, 100);

const big = run('big', 200);
assert.equal(big.paidWith, 'free');
assert.equal(users[0].aiFreeUsed.big, 1);

const edit = run('edit', 500);
assert.equal(edit.paidWith, 'free');
assert.equal(users[0].aiFreeUsed.edit, 0);

const daily = run('nobg', 500);
assert.equal(daily.paidWith, 'daily');
assert.equal(users[0].aiDailyUsed.nobg.count, 0, '失败应退回每日免费次数');

users[0].aiFreeUsed.gen = 1;
const paid = run('gen', 200);
assert.equal(paid.paidWith, 'credit');
assert.equal(users[0].credits, 70);

users[0].credits = 0;
const req = { user: { id: 'u1' } };
const res = new EventEmitter();
res.locals = {};
res.status = code => { res.statusCode = code; return res; };
res.json = body => { res.body = body; return res; };
charge('split')(req, res, () => assert.fail('余额不足不应进入处理'));
assert.equal(res.statusCode, 403);
assert.equal(res.body.code, 'no-credit');

console.log('画板 AI 扣费测试通过：免费、每日额度、积分、失败退还与余额不足均正常');
