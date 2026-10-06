// 批注回复接口联调（打隔离实例 :8090）
const B = 'http://127.0.0.1:8090'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }
const j = r => r.json().catch(() => ({}))

const run = async () => {
  const email = `e2e_rpl_${Date.now()}@test.com`
  let r = await fetch(`${B}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test123456', name: '作者小明' }) })
  let d = await j(r)
  const token = d.token
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  r = await fetch(`${B}/api/boards`, { method: 'POST', headers: H, body: JSON.stringify({ name: '回复联调板' }) })
  d = await j(r)
  const bid = d.board?.id || d.id
  r = await fetch(`${B}/api/boards/${bid}/share`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'view' }) })
  d = await j(r)
  const st = d.shareToken

  // 访客批注
  r = await fetch(`${B}/api/shared/${st}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '王导', text: '箭头反了', x: 10, y: 20 }) })
  d = await j(r)
  const cid = d.comment.id

  // 1. 作者回复
  r = await fetch(`${B}/api/boards/${bid}/comments/${cid}/replies`, { method: 'POST', headers: H, body: JSON.stringify({ text: '收到，今晚改' }) })
  d = await j(r)
  ok(d.ok && d.reply.by === 'owner' && d.reply.name === '作者小明', '作者回复（by=owner，昵称取账号名）')

  // 2. 访客回复
  r = await fetch(`${B}/api/shared/${st}/comments/${cid}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '王导', text: '好，改完我再看' }) })
  d = await j(r)
  ok(d.ok && d.reply.by === 'guest', '访客回复（by=guest）')

  // 3. 访客缺昵称被拒
  r = await fetch(`${B}/api/shared/${st}/comments/${cid}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })
  ok(r.status === 400, '访客缺昵称 400')

  // 4. 空内容被拒
  r = await fetch(`${B}/api/boards/${bid}/comments/${cid}/replies`, { method: 'POST', headers: H, body: JSON.stringify({ text: '  ' }) })
  ok(r.status === 400, '空回复 400')

  // 5. 拉取：replies 两条 + rt 更新
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: H })
  d = await j(r)
  const c = d.comments.find(x => x.id === cid)
  ok(c.replies.length === 2 && c.replies[0].by === 'owner' && c.replies[1].by === 'guest', '作者侧拉到 2 条回复')
  ok(c.rt >= c.at, 'rt 已更新（供未读判断）')
  r = await fetch(`${B}/api/shared/${st}/comments`)
  d = await j(r)
  ok(d.comments[0].replies.length === 2, '访客侧同步看到 2 条回复')

  // 6. 不存在的批注 404
  r = await fetch(`${B}/api/boards/${bid}/comments/nope/replies`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) })
  ok(r.status === 404, '批注不存在 404')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
run().catch(e => { console.error(e); process.exit(1) })
