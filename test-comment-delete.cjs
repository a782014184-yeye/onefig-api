// 批注删除后端联调：钥匙机制 + 作者删除 + 越权拦截
const api = async (base, p, o = {}, t) => {
  const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(o.headers || {}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const B = 'http://127.0.0.1:8090';
const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m) };
(async () => {
  const owner = (await api(B, '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `t${Date.now()}@t.com`, password: 'Test123456', name: '作者' }) })).data;
  const other = (await api(B, '/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `t2${Date.now()}@t.com`, password: 'Test123456', name: '路人' }) })).data;
  const b = await api(B, '/api/boards', { method: 'POST', body: JSON.stringify({ name: 't' }) }, owner.token);
  await api(B, `/api/boards/${b.data.board.id}/share`, { method: 'POST', body: JSON.stringify({ mode: 'view' }) }, owner.token);
  const st = b.data && (await api(B, `/api/boards/${b.data.board.id}/share`, { method: 'POST', body: JSON.stringify({ mode: 'view' }) }, owner.token));
  const tok = st.data.shareToken;

  // state 带 owner 标记
  const stOwner = await api(B, `/api/shared/${tok}/state`, {}, owner.token);
  const stAnon = await api(B, `/api/shared/${tok}/state`);
  const stOther = await api(B, `/api/shared/${tok}/state`, {}, other.token);
  ok(stOwner.data.owner === true && stAnon.data.owner === false && stOther.data.owner === false, 'state 返回 owner 标记（作者 true，他人 false）');

  // 发批注 → 响应带 key
  const c1 = await api(B, `/api/shared/${tok}/comments`, { method: 'POST', body: JSON.stringify({ name: '王导', text: '第一条', x: 100, y: 100 }) });
  ok(c1.status === 200 && !!c1.data.comment.key, '发批注返回删除钥匙');
  const key1 = c1.data.comment.key, cid1 = c1.data.comment.id;

  // 列表不下发 key
  const list = await api(B, `/api/shared/${tok}/comments`);
  ok(list.data.comments.length === 1 && !('key' in list.data.comments[0]), '列表不下发钥匙');

  // PATCH 响应不下发 key
  const p1 = await api(B, `/api/shared/${tok}/comments/${cid1}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
  ok(!('key' in p1.data.comment), 'PATCH 响应不下发钥匙');

  // 无钥匙匿名删 → 403
  const d1 = await api(B, `/api/shared/${tok}/comments/${cid1}`, { method: 'DELETE' });
  ok(d1.status === 403, '匿名无钥匙删除被拒');

  // 错钥匙 → 403
  const d2 = await api(B, `/api/shared/${tok}/comments/${cid1}`, { method: 'DELETE', headers: { 'x-comment-key': 'wrong' } });
  ok(d2.status === 403, '错钥匙删除被拒');

  // 登录非作者 → 403
  const d3 = await api(B, `/api/shared/${tok}/comments/${cid1}`, { method: 'DELETE' }, other.token);
  ok(d3.status === 403, '登录但不是作者删除被拒');

  // 正确钥匙 → 200
  const d4 = await api(B, `/api/shared/${tok}/comments/${cid1}`, { method: 'DELETE', headers: { 'x-comment-key': key1 } });
  ok(d4.status === 200 && d4.data.ok, '发布者凭钥匙删除成功');

  // 作者删任意条
  const c2 = await api(B, `/api/shared/${tok}/comments`, { method: 'POST', body: JSON.stringify({ name: '王导', text: '第二条', x: 200, y: 200 }) });
  const d5 = await api(B, `/api/shared/${tok}/comments/${c2.data.comment.id}`, { method: 'DELETE' }, owner.token);
  ok(d5.status === 200 && d5.data.ok, '作者凭登录态删除任意条');

  const left = await api(B, `/api/shared/${tok}/comments`);
  ok(left.data.comments.length === 0, '两条都已删除');

  console.log(fails.length ? `\n${fails.length} 项失败` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1) });
