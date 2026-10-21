// 冒烟测试：AI 工坊五类结果统一入账"我的生成记录"（2026-10-21）
// 覆盖：recordAIResult 入账、/api/ai/jobs 返回 kind/ext、img/download 的 SVG/PNG 分发、旧记录兼容
// 用法：node test-ai-records.cjs   （只打本机临时端口，绝不指向生产）
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-ai-records-'));
const AI_DIR = path.join(DATA_DIR, 'ai');
fs.mkdirSync(AI_DIR, { recursive: true });

const USER = { id: 'u-test-1', name: '测试用户', credits: 100, pwdVer: 1, aiFreeUsed: { gen: 0, edit: 1, stylize: 0 }, aiDailyUsed: { nobg: { date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), count: 1 }, vec: { date: '2026-01-01', count: 9 } } };
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.writeFileSync(USERS_FILE, JSON.stringify([USER]));
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const saveUsers = u => fs.writeFileSync(USERS_FILE, JSON.stringify(u));
const authUser = (req, res, next) => { req.user = USER; next(); };
const logLine = (tag, msg) => console.log(`  [log ${tag}] ${msg}`);

// 最小可用的 injectAigcMeta（原实现依赖 crc32，这里只验证"非 PNG 原样返回"路径与调用）
const injectAigcMeta = (buf) => buf;

const app = express();
app.use(express.json({ limit: '12mb' }));
const aiFreeLeft = u => ({ gen: Math.max(0, 1 - ((u.aiFreeUsed || {}).gen || 0)), edit: Math.max(0, 1 - ((u.aiFreeUsed || {}).edit || 0)), stylize: Math.max(0, 1 - ((u.aiFreeUsed || {}).stylize || 0)) });
const aiLocalLeft = u => {
  if (['pro', 'team'].includes(u.level)) return { unlimited: true, nobg: null, vec: null };
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const left = f => { const s = (u.aiDailyUsed || {})[f]; return s && s.date === today ? Math.max(0, 5 - s.count) : 5; };
  return { unlimited: false, nobg: left('nobg'), vec: left('vec') };
};
const aiModule = require('./ai');
aiModule(app, { consoleAuth: (req, res, next) => next(), DATA_DIR, authUser, loadUsers, saveUsers, injectAigcMeta, logLine, aiFreeLeft, aiCost: () => 10, aiLocalLeft, aiLocalCost: () => ({ nobg: 5, vec: 10 }) });

const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452' + '000000010000000108060000001f15c489' + '0000000a49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const SVG_MINI = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}`); } };
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: 'Bearer x', ...headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

(async () => {
  const server = app.listen(0, async () => {
    const port = server.address().port;
    console.log(`隔离实例起在 127.0.0.1:${port}，数据目录 ${DATA_DIR}`);

    // 1) 直接入账三类结果（edit=png / nobg=png / vec=svg）
    const idEdit = aiModule.recordAIResult({ userId: USER.id, kind: 'edit', prompt: 'AI 改图：把颜色换成紫色', ext: 'png', buf: PNG_1PX });
    const idNobg = aiModule.recordAIResult({ userId: USER.id, kind: 'nobg', prompt: '移除背景：cell.png', ext: 'png', buf: PNG_1PX });
    const idVec = aiModule.recordAIResult({ userId: USER.id, kind: 'vec', prompt: '位图转矢量：logo.png', ext: 'svg', buf: SVG_MINI });
    ok(idEdit && idNobg && idVec, 'recordAIResult 三类入账均返回 id');
    ok(fs.existsSync(path.join(AI_DIR, idVec, 'c0.svg')), 'SVG 结果文件落盘 c0.svg');

    // 2) 手工造一条旧版"生成素材"记录（无 kind/ext 字段，模拟存量数据）
    const legacyId = 'legacy-job-0001';
    const jobs = JSON.parse(fs.readFileSync(path.join(AI_DIR, 'jobs.json'), 'utf8'));
    fs.mkdirSync(path.join(AI_DIR, legacyId), { recursive: true });
    fs.writeFileSync(path.join(AI_DIR, legacyId, 'c0.png'), PNG_1PX);
    jobs.push({ id: legacyId, userId: USER.id, prompt: '一个巨噬细胞', style: 'matte', status: 'done', candidates: [0], picked: 0, createdAt: '2026-10-20T00:00:00.000Z' });
    fs.writeFileSync(path.join(AI_DIR, 'jobs.json'), JSON.stringify(jobs, null, 1));

    // 3) /api/ai/jobs 返回 kind/ext，旧记录默认 gen/png
    const listRes = await get(port, '/api/ai/jobs');
    const list = JSON.parse(listRes.body.toString()).list;
    ok(listRes.status === 200 && list.length === 4, `jobs 列表返回 4 条（实际 ${list.length}）`);
    const byId = Object.fromEntries(list.map(j => [j.id, j]));
    ok(byId[idEdit].kind === 'edit' && byId[idEdit].ext === 'png', 'edit 记录 kind/ext 正确');
    ok(byId[idVec].kind === 'vec' && byId[idVec].ext === 'svg', 'vec 记录 kind/ext 正确');
    ok(byId[legacyId].kind === 'gen' && byId[legacyId].ext === 'png', '旧记录默认 gen/png 兼容');

    // 4) img 端点：PNG / SVG 分发正确 Content-Type
    const imgPng = await get(port, `/api/ai/job/${idEdit}/img/0`);
    ok(imgPng.status === 200 && imgPng.headers['content-type'] === 'image/png', 'PNG 记录 img 返回 image/png');
    const imgSvg = await get(port, `/api/ai/job/${idVec}/img/0`);
    ok(imgSvg.status === 200 && imgSvg.headers['content-type'] === 'image/svg+xml' && imgSvg.body.equals(SVG_MINI), 'SVG 记录 img 返回 image/svg+xml 且字节一致');

    // 5) download 端点：扩展名与 Content-Type 正确
    const dlSvg = await get(port, `/api/ai/job/${idVec}/download`);
    ok(dlSvg.status === 200 && dlSvg.headers['content-type'] === 'image/svg+xml' && /filename\*=UTF-8''.*\.svg/.test(dlSvg.headers['content-disposition']), 'SVG 记录 download 返回 svg 附件');
    const dlPng = await get(port, `/api/ai/job/${idEdit}/download`);
    ok(dlPng.status === 200 && dlPng.headers['content-type'] === 'image/png' && /\.png/.test(dlPng.headers['content-disposition']), 'PNG 记录 download 返回 png 附件');

    // 6) /api/ai/status 字段（2026-10-21）：aiFreeLeft/aiCost = 改图/风格转换试用体系；
    //    aiLocal/aiLocalCost = 移除背景/位图转矢量每日额度体系（今日已抠 1 次 → nobg 剩 4；vec 记录是旧日期 → 满额 5）
    //    定价已统一为 10 积分（aiCost / aiLocalCost 均应为 10）
    const stRes = await get(port, '/api/ai/status');
    const st = JSON.parse(stRes.body.toString());
    ok(stRes.status === 200
      && st.aiFreeLeft && st.aiFreeLeft.gen === 1 && st.aiFreeLeft.edit === 0 && st.aiFreeLeft.stylize === 1 && st.aiCost === 10
      && st.aiLocal && st.aiLocal.unlimited === false && st.aiLocal.nobg === 4 && st.aiLocal.vec === 5 && st.aiLocalCost && st.aiLocalCost.nobg === 5 && st.aiLocalCost.vec === 10,
      `status 返回计费体系字段（实际 ${JSON.stringify({ aiFreeLeft: st.aiFreeLeft, aiCost: st.aiCost, aiLocal: st.aiLocal, aiLocalCost: st.aiLocalCost })}）`);

    server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exit(failed ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(1); });
