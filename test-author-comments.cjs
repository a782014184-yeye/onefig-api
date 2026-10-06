// 作者侧批注接口联调（打隔离实例 :8090）
const B = 'http://127.0.0.1:8090'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name) } }
const j = r => r.json().catch(() => ({}))

const run = async () => {
  const email = `e2e_cmt_${Date.now()}@test.com`
  // 1. 注册
  let r = await fetch(`${B}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test123456', name: '批注测试' }) })
  let d = await j(r)
  const token = d.token
  ok(!!token, '注册拿到 token')
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  // 2. 新建画板
  r = await fetch(`${B}/api/boards`, { method: 'POST', headers: H, body: JSON.stringify({ name: '批注联调板' }) })
  d = await j(r)
  const bid = d.board?.id || d.id
  ok(!!bid, '新建画板')

  // 3. 未分享时拉批注 → shared=false 空列表
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: H })
  d = await j(r)
  ok(d.ok && d.shared === false && d.comments.length === 0, '未分享时返回空+shared=false')

  // 4. 开分享
  r = await fetch(`${B}/api/boards/${bid}/share`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'view' }) })
  d = await j(r)
  const shareToken = d.shareToken
  ok(!!shareToken, '开启分享')

  // 5. 访客加两条批注
  for (const text of ['第一条批注', '第二条批注']) {
    r = await fetch(`${B}/api/shared/${shareToken}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '导师', text, x: 100, y: 200 }) })
    d = await j(r)
    if (!d.ok) ok(false, `访客加批注 ${text}: ${JSON.stringify(d)}`)
  }
  ok(true, '访客加两条批注')

  // 6. 作者拉批注：2 条，readAt=0 → 全部未读
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: H })
  d = await j(r)
  ok(d.ok && d.shared === true && d.comments.length === 2, '作者拉到 2 条批注')
  ok((d.readAt ?? 1) === 0, '初始 readAt=0')
  const cid = d.comments[0].id
  ok(!('key' in d.comments[0]), '删除钥匙不下发')

  // 7. 标记已读
  r = await fetch(`${B}/api/boards/${bid}/comments/read`, { method: 'POST', headers: H })
  d = await j(r)
  ok(d.ok && d.readAt > 0, '标记已读返回 readAt')
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: H })
  d = await j(r)
  ok(d.comments.every(c => c.at <= d.readAt), '已读后无未读')

  // 8. 作者标记已处理
  r = await fetch(`${B}/api/boards/${bid}/comments/${cid}`, { method: 'PATCH', headers: H, body: JSON.stringify({ done: true }) })
  d = await j(r)
  ok(d.ok && d.comment.done === true, '作者标记已处理')

  // 9. 访客侧能看到 done 状态（同一份数据）
  r = await fetch(`${B}/api/shared/${shareToken}/comments`)
  d = await j(r)
  ok(d.comments.find(c => c.id === cid)?.done === true, '访客侧同步已处理')

  // 10. 作者删批注
  r = await fetch(`${B}/api/boards/${bid}/comments/${cid}`, { method: 'DELETE', headers: H })
  d = await j(r)
  ok(d.ok, '作者删批注')
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: H })
  d = await j(r)
  ok(d.comments.length === 1, '删除后剩 1 条')

  // 11. 别人不能碰：伪造 token
  r = await fetch(`${B}/api/boards/${bid}/comments`, { headers: { Authorization: 'Bearer badtoken' } })
  ok(r.status === 401, '无登录态被拒')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
run().catch(e => { console.error(e); process.exit(1) })
