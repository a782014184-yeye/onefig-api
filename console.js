// OneFig 管理后台控制台（五页：数据看板 / 素材管理 / 账号管理 / 素材请求 / 网站体检）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { checkConsoleInline } = require('./ops/console-inline-lib.cjs');

const PLANS = { basic: '青果会员', pro: '红果会员', team: '金果会员' };

module.exports = function registerConsole(app, deps) {
  const { consoleAuth, esc, DATA_DIR } = deps;
  const getOnline = deps.getOnlineCount || (() => 0);
  const DIR = path.join(DATA_DIR, 'console');
  fs.mkdirSync(DIR, { recursive: true });
  const file = n => path.join(DIR, n);
  const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const save = (n, rows) => { const t = file(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, file(n)); };
  // 金额一律按"分"取整（2 位小数），避免 0.1+0.2 类浮点误差进统计
  const rmb = n => Math.round(Number(n) * 100) / 100;
  // 下发前剔除敏感字段（2026-10-20 P1-3）：密码哈希/盐/密码版本绝不出服务端——
  // 后台一旦 XSS 或被抓包，泄露的就是全站密码哈希（可离线爆破弱密码）
  const adminUserView = (u) => { if (!u) return u; const { passHash, salt, pwdVer, ...pub } = u; return pub; };

  // 测试账号过滤（2026-10-25）：users.json 里 test:true 的账号全部保留，
  // 但其订单不计入任何金额统计，新增用户走势也不含测试号（真实用户如张天志不标记）
  const testUserIds = () => new Set(load('users.json', []).filter(u => u.test).map(u => u.id));
  const paidOrdersExcludingTests = () => {
    const ids = testUserIds();
    return load('orders.json', []).filter(o => o.status === 'paid' && !ids.has(o.userId));
  };
  const realUsersOnly = users => { const ids = testUserIds(); return users.filter(u => !ids.has(u.id)); };

  // ---------- API ----------
  app.get('/console/api/stats', consoleAuth, (req, res) => {
    const users = load('users.json', []);
    const orders = paidOrdersExcludingTests();
    const totalRevenue = rmb(orders.reduce((s, o) => s + o.amount, 0));
    const levelCount = { basic: 0, pro: 0, team: 0 };
    users.forEach(u => { if (levelCount[u.level] !== undefined) levelCount[u.level]++; });
    const monthly = {};
    orders.forEach(o => {
      const m = (o.paidAt || '').slice(0, 7) || '未知';
      monthly[m] = monthly[m] || { basic: { n: 0, amt: 0 }, pro: { n: 0, amt: 0 }, team: { n: 0, amt: 0 } };
      if (monthly[m][o.plan]) { monthly[m][o.plan].n++; monthly[m][o.plan].amt = rmb(monthly[m][o.plan].amt + o.amount); }
    });
    const days = [];
    const now = new Date();
    const realUsers = realUsersOnly(users);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({
        date: key.slice(5),
        users: realUsers.filter(u => (u.joinedAt || '').slice(0, 10) === key).length,
        revenue: rmb(orders.filter(o => (o.paidAt || '').slice(0, 10) === key).reduce((s, o) => s + o.amount, 0)),
      });
    }
    res.json({ ok: true, totalUsers: users.length, online: getOnline(), levelCount, totalRevenue, monthly, days });
  });

  // 每日走势：新增用户 + 收入（可选 7/30/180/365 天）
  app.get('/console/api/trend', consoleAuth, (req, res) => {
    const days = Math.min(366, Math.max(1, parseInt(req.query.range, 10) || 30));
    const users = realUsersOnly(load('users.json', []));
    const orders = paidOrdersExcludingTests();
    const key = iso => {
      const d = new Date(iso);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = key(d.toISOString());
      out.push({
        date: k.slice(5),
        users: users.filter(u => u.joinedAt && key(u.joinedAt) === k).length,
        revenue: rmb(orders.filter(o => o.paidAt && key(o.paidAt) === k).reduce((s, o) => s + o.amount, 0)),
      });
    }
    res.json({ ok: true, days: out });
  });

  // 验真异常监控：非作者（游客+其他登录用户）查询明显多于作者的授权码，疑似泄露/转卖（2026-10-16）
  app.get('/console/api/leak-watch', consoleAuth, (req, res) => {
    try {
      const qlog = load('verify-log.json', {});
      const dls = load('downloads.json', []);
      const users = load('users.json', []);
      const mats = load('materials.json', []);
      const matMap = new Map();
      for (const s of mats) for (const m of s.materials) matMap.set(m.id, { title: m.title, series: m.series || s.folder });
      const byCode = new Map();
      for (const l of dls) if (l.code) byCode.set(l.code, l);
      const rows = [];
      for (const [code, rec] of Object.entries(qlog)) {
        if (!rec.entries) continue;
        const dl = byCode.get(code) || {};
        const authorId = dl.userId || null;
        const authorCount = (authorId && rec.entries[authorId]) ? rec.entries[authorId].count : 0;
        let guestCount = 0, otherTotal = 0, otherUsers = 0, last = rec.entries[authorId] ? rec.entries[authorId].last : '';
        for (const [k, v] of Object.entries(rec.entries)) {
          if (k !== authorId) {
            otherTotal += v.count;
            if (k === 'guest') guestCount = v.count; else otherUsers++;
          }
          if (v.last > last) last = v.last;
        }
        const total = authorCount + otherTotal;
        // 告警门槛：非作者查询 ≥3 且多于作者本人（新码编辑只查一两次不误报）
        if (otherTotal >= 3 && otherTotal > authorCount) {
          const author = users.find(x => x.id === authorId);
          const mat = matMap.get(dl.materialId) || { title: dl.materialId || '—', series: '' };
          rows.push({
            code, material: mat.title, series: mat.series,
            author: author ? (author.email || author.name) : '（账号已注销）',
            authorCount, guestCount, otherUsers, otherTotal, total, last,
          });
        }
      }
      rows.sort((a, b) => b.otherTotal - a.otherTotal || (b.last > a.last ? 1 : -1));
      res.json({ ok: true, list: rows.slice(0, 30), total: rows.length });
    } catch { res.status(500).json({ ok: false, error: '读取失败' }); }
  });

  // 积分统计：总收入 + 各套餐收入 + 每日购买积分数（近 N 天柱状图）
  app.get('/console/api/credit-stats', consoleAuth, (req, res) => {
    const days = Math.min(366, Math.max(7, parseInt(req.query.range, 10) || 30));
    const testIds = testUserIds();
    const all = load(path.join('..', 'ai', 'credit-orders.json'), []);
    const paid = all.filter(o => o.status === 'paid' && !testIds.has(o.userId));
    const PKG_NAMES = { p100: '100积分', p800: '800积分', p2000: '2000积分' };
    const byPkg = {};
    paid.forEach(o => {
      byPkg[o.pkg] = byPkg[o.pkg] || { pkg: o.pkg, name: PKG_NAMES[o.pkg] || o.pkg, count: 0, credits: 0, revenue: 0 };
      byPkg[o.pkg].count++; byPkg[o.pkg].credits += o.credits; byPkg[o.pkg].revenue = rmb(byPkg[o.pkg].revenue + o.amount);
    });
    const key = iso => {
      const d = new Date(iso);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = key(d.toISOString());
      const todays = paid.filter(o => o.paidAt && key(o.paidAt) === k);
      out.push({ date: k.slice(5), credits: todays.reduce((s, o) => s + o.credits, 0), revenue: rmb(todays.reduce((s, o) => s + o.amount, 0)), orders: todays.length });
    }
    res.json({
      ok: true,
      totalRevenue: rmb(paid.reduce((s, o) => s + o.amount, 0)),
      totalCredits: paid.reduce((s, o) => s + o.credits, 0),
      totalOrders: paid.length,
      pending: all.filter(o => o.status === 'pending' || o.status === 'notified').length,
      byPkg: Object.values(byPkg),
      days: out,
    });
  });

  // 积分流水（全部调整与赠送记录）
  app.get('/console/api/credit-log', consoleAuth, (req, res) => {
    const log = loadLog().slice().reverse().slice(0, 200);
    res.json({ ok: true, list: log });
  });

  // 操作日志（2026-10-15）：读 data/logs/<type>-日期.log（今天 + 昨天），返回最新 N 行（新→旧）
  // type 白名单：ai-op（AI 工坊语义操作）/ access / auth / error / mail / pay
  app.get('/console/api/logs', consoleAuth, (req, res) => {
    const type = String(req.query.type || 'ai-op');
    if (!/^[a-z-]+$/.test(type)) return res.status(400).json({ ok: false, error: '无效的日志类型' });
    const lines = Math.min(500, Math.max(20, parseInt(req.query.lines, 10) || 200));
    const days = [0, 1].map(d => {
      const dt = new Date(Date.now() - d * 864e5);
      const p = path.join(DATA_DIR, 'logs', `${type}-${dt.toISOString().slice(0, 10)}.log`);
      try { return fs.readFileSync(p, 'utf8') } catch { return '' }
    });
    const all = days.join('').trim().split('\n').filter(Boolean);
    res.json({ ok: true, list: all.slice(-lines).reverse(), total: all.length, type });
  });

  // AI 工坊今日用量概览（2026-10-15）：解析今天 ai-op 操作日志，供数据看板展示
  app.get('/console/api/ai-stats', consoleAuth, (req, res) => {
    const empty = { ok: true, total: 0, okCount: 0, failCount: 0, byFeature: {}, credits: 0 };
    try {
      const f = path.join(DATA_DIR, 'logs', `ai-op-${new Date().toISOString().slice(0, 10)}.log`);
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      const FEATURES = [
        ['generate done', '生成素材', false], ['generate FAIL', '生成素材', true],
        ['edit ok', 'AI 改图', false], ['edit FAIL', 'AI 改图', true], ['edit ERROR', 'AI 改图', true],
        ['stylize ok', '风格转换', false], ['stylize FAIL', '风格转换', true], ['stylize ERROR', '风格转换', true],
        ['remove-bg ok', '移除背景', false], ['remove-bg FAIL', '移除背景', true],
        ['vectorize ok', '位图转矢量', false], ['vectorize FAIL', '位图转矢量', true],
      ];
      let ok = 0, fail = 0, credits = 0;
      const byFeature = {};
      for (const l of lines) {
        const hit = FEATURES.find(([k]) => l.includes(' ' + k + ' '));
        if (hit) {
          byFeature[hit[1]] = (byFeature[hit[1]] || 0) + 1;
          if (hit[2]) fail++; else ok++;
          const c = l.match(/cost=(\d+)/);
          if (c) credits += Number(c[1]);
        } else if (l.includes(' download ')) {
          byFeature['下载'] = (byFeature['下载'] || 0) + 1;
        }
      }
      res.json({ ok: true, total: ok + fail, okCount: ok, failCount: fail, byFeature, credits });
    } catch { res.json(empty) }
  });

  app.get('/console/api/users', consoleAuth, (req, res) => {
    const users = load('users.json', []);
    const orders = load('orders.json', []).filter(o => o.status === 'paid');
    const q = (req.query.q || '').trim().toLowerCase();
    let list = users.map(u => ({
      ...adminUserView(u),
      totalPaid: rmb(orders.filter(o => o.userId === u.id).reduce((s, o) => s + o.amount, 0)),
      orderCount: orders.filter(o => o.userId === u.id).length,
    }));
    if (q) list = list.filter(u => ((u.name || '') + (u.contact || '') + (u.email || '')).toLowerCase().includes(q));
    res.json({ ok: true, list });
  });

  // 商户单号反查：与用户账号页展示的号码一致，支持有无连字符、大小写输入。
  app.get('/console/api/order-lookup', consoleAuth, (req, res) => {
    const raw = String(req.query.merchantNo || req.query.outTradeNo || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: '请输入商户订单号' });
    const normalize = value => String(value || '').replace(/-/g, '').toUpperCase();
    const key = normalize(raw);
    const orders = load('orders.json', []);
    const order = orders.find(o => normalize(o.outTradeNo || String(o.id || '').replace(/-/g, '')) === key || normalize(o.id) === key);
    if (!order) return res.json({ ok: false, error: '未找到该商户订单号对应的订单' });
    const merchantNo = order.outTradeNo || String(order.id || '').replace(/-/g, '');
    const user = load('users.json', []).find(u => u.id === order.userId);
    const downloads = load('downloads.json', []);
    const related = order.kind === 'export'
      ? downloads.filter(l => l.kind === 'export' && (l.orderId === order.id || (order.exportCode && l.code === order.exportCode)))
      : order.materialId ? downloads.filter(l => l.userId === order.userId && l.materialId === order.materialId) : [];
    const licenses = [...new Map(related.filter(l => l.code).map(l => [l.code, {
      code: l.code,
      title: l.kind === 'export' ? (l.boardTitle || '画板导出作品') : (l.materialTitle || order.materialTitle || order.materialId),
      time: l.time,
      status: l.status === 'refund-revoked' || l.revokeReason === 'refund' ? '退款回收' : '有效',
    }])).values()];
    res.json({
      ok: true,
      order: { ...order, merchantNo },
      user: user ? { id: user.id, name: user.name || '', email: user.email || user.contact || '', level: user.level || 'none' } : null,
      licenses,
    });
  });

  app.get('/console/api/users/:id', consoleAuth, (req, res) => {
    const users = load('users.json', []);
    const orders = load('orders.json', []).filter(o => o.userId === req.params.id);
    const u = users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false });
    const my = orders.sort((a, b) => (a.createdAt || a.paidAt) < (b.createdAt || b.paidAt) ? 1 : -1);
    const levelLog = loadLevelLog().filter(l => l.userId === u.id).reverse();
    let creditOrders = [];
    try {
      creditOrders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ai', 'credit-orders.json'), 'utf8'))
        .filter(o => o.userId === u.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch {}
    let creditLog = [];
    try {
      creditLog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ai', 'credit-log.json'), 'utf8'))
        .filter(l => l.userId === u.id).reverse();
    } catch {}
    // 画板 + 分享记录：boards/<uid>/index.json + shares.json（visitors = 打开过分享链接的登录用户，2026-10-15 起纳入后台）
    let boards = [];
    try {
      const bidx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'boards', String(u.id), 'index.json'), 'utf8'));
      const shares = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shares.json'), 'utf8'));
      const folders = Array.isArray(bidx.folders) ? bidx.folders : [];
      boards = (Array.isArray(bidx.boards) ? bidx.boards : []).map(b => {
        const share = b.shareToken ? shares[b.shareToken] : null;
        const visitors = share && share.visitors
          ? Object.values(share.visitors).sort((x, y) => (y.at || 0) - (x.at || 0))
          : [];
        return {
          id: b.id, name: b.name, savedAt: b.savedAt || 0,
          folder: ((folders.find(f => f.id === b.folderId) || {}).name) || '',
          shareMode: b.shareToken ? (b.shareMode || 'view') : null,
          visitorCount: visitors.length,
          visitors: visitors.slice(0, 20).map(v => ({ name: v.name, at: v.at })),
        };
      }).sort((a, b) => b.savedAt - a.savedAt);
    } catch {}
    // 下载历史：console/downloads.json 流水按素材去重（保留最近一次），联查 materials.json 取标题/系列/预览信息
    let downloads = [];
    try {
      const dls = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'console', 'downloads.json'), 'utf8'))
        .filter(l => l.userId === u.id);
      const map = new Map();
      for (const s of load('materials.json', [])) for (const m of s.materials) map.set(m.id, { s, m });
      const exportByCode = new Map(readJSON(path.join(DATA_DIR, 'console', 'exports.json'), []).map(x => [x.code, x]));
      const seen = new Map();
      for (const l of dls) {
        const licenseStatus = l.status === 'refund-revoked' || l.revokeReason === 'refund' ? '退款回收' : '有效';
        if (l.kind === 'export') {
          const linkedOrder = l.orderId && my.find(o => o.id === l.orderId);
          if (linkedOrder) {
            linkedOrder.exportCode = l.code || linkedOrder.exportCode;
            linkedOrder.licenseStatus = licenseStatus;
          }
          const archive = exportByCode.get(l.code);
          seen.set('export:' + (l.code || l.time), {
            id: 'export:' + (l.code || l.time), kind: 'export',
            title: l.boardTitle || '画板导出作品', exportId: archive ? archive.id : '',
            thumb: l.thumb || null, time: l.time, code: l.code || null, licenseStatus,
          });
          continue;
        }
        const hit = map.get(l.materialId);
        // 下架/改名后仍显示在用户的下载历史里，标题用下载时快照（2026-10-24）
        const parts = String(l.materialId || '').split('/');
        const title = hit ? hit.m.title : (l.materialTitle || parts[parts.length - 1] || l.materialId);
        const series = hit ? (hit.m.series || hit.s.folder) : (l.materialSeries || (parts.length > 1 ? parts.slice(0, -1).join('/') : ''));
        seen.set(l.materialId, {
          id: l.materialId,
          title,
          folder: hit ? hit.s.folder : series,
          series,
          file: hit ? (hit.m.file || (hit.m.title + '.png')) : undefined,
          local: hit ? !!hit.m.local : false,
          time: l.time,
          code: l.code || null,
          licenseStatus,
          removed: hit ? !!hit.m.removed : true,
        });
      }
      downloads = [...seen.values()].sort((a, b) => b.time.localeCompare(a.time));
    } catch {}
    res.json({ ok: true, user: adminUserView(u), orders: my, totalPaid: rmb(my.filter(o => o.status === 'paid').reduce((s, o) => s + o.amount, 0)), levelLog, creditOrders, creditLog, boards, downloads });
  });

  const MEMBER_GIFT = { basic: 150, pro: 900, team: 3000 }; // 终身制开通一次性赠送积分
  const CREDIT_LOG = path.join(DATA_DIR, 'ai', 'credit-log.json');
  const loadLog = () => { try { return JSON.parse(fs.readFileSync(CREDIT_LOG, 'utf8')); } catch { return []; } };
  const saveLog = rows => { fs.mkdirSync(path.dirname(CREDIT_LOG), { recursive: true }); const t = CREDIT_LOG + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows, null, 1)); fs.renameSync(t, CREDIT_LOG); };
  const logCredit = (u, delta, reason, by) => saveLog([...loadLog(), { userId: u.id, name: u.name, delta, reason, time: new Date().toISOString(), by: by || 'system' }]);

  // 会员等级变更流水（2026-09-22）：后台手动改等级时记录 时间/原等级/新等级/操作者
  const loadLevelLog = () => load('level-log.json', []);
  const logLevel = (u, from, to, by) => save('level-log.json', [...loadLevelLog(), { userId: u.id, name: u.name, from, to, time: new Date().toISOString(), by: by || 'admin' }]);

  // 开通会员时按等级一次性赠送 AI 积分（每个等级只送一次，重复改等级不重复送）
  function grantMemberCredits(u, level) {
    if (!MEMBER_GIFT[level]) return 0;
    if (u.creditsGrantedFor === level) return 0;
    u.creditsGrantedFor = level;
    u.credits = (u.credits || 0) + MEMBER_GIFT[level];
    return MEMBER_GIFT[level];
  }

  app.patch('/console/api/users/:id', consoleAuth, (req, res) => {
    const users = load('users.json', []);
    const u = users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false });
    const { level, notes, resetQuota, resetExport } = req.body || {};
    if (resetQuota) {
      // 测试工具：重置本月下载额度（dlMonth 清空后，下次下载按当月重新计数）
      u.dlUsed = 0;
      u.dlMonth = '';
    }
    if (resetExport) {
      // 测试工具：重置本月画板导出额度 + 清零单次导出权益
      u.exUsed = 0;
      u.exMonth = '';
      u.exportCredits = 0;
    }
    if (level !== undefined) {
      if (level !== 'none' && !PLANS[level]) return res.status(400).json({ ok: false, error: '无效的会员等级' });
      const from = u.level || 'none';
      if (level !== from) logLevel(u, from, level, 'admin');
      u.level = level;
      if (level !== 'none' && !u.memberSince) u.memberSince = new Date().toISOString();
      if (level === 'none') u.memberSince = null;
      const granted = grantMemberCredits(u, level);
      if (granted) logCredit(u, granted, '开通' + PLANS[level] + '赠送');
    }
    if (notes !== undefined) u.notes = String(notes).slice(0, 500);
    save('users.json', users);
    res.json({ ok: true });
  });

  // 测试工具：清空某账号的单张购买记录（只动 purchases.json，不影响会员等级与订单流水）
  app.delete('/console/api/users/:id/purchases', consoleAuth, (req, res) => {
    const rows = load('purchases.json', []);
    const kept = rows.filter(p => p.userId !== req.params.id);
    save('purchases.json', kept);
    res.json({ ok: true, removed: rows.length - kept.length });
  });

  // 在线订单列表（只读）。手动录单/确认收款/收款设置接口已于 2026-10-26 下线：
  // 微信/支付宝在线支付回调自动开通会员与积分，不再提供人工开通入口
  app.get('/console/api/orders', consoleAuth, (req, res) => {
    let orders = load('orders.json', []);
    if (req.query.status) orders = orders.filter(o => req.query.status.split(',').includes(o.status));
    orders.sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? 1 : -1);
    res.json({ ok: true, list: orders });
  });

  // ---- AI 提示词集中管理（2026-10-22）：读取/保存，保存即生效、无需重启 ----
  app.get('/console/api/ai-prompts', consoleAuth, (req, res) => {
    try { res.json({ ok: true, prompts: deps.promptStore.get() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.put('/console/api/ai-prompts', consoleAuth, (req, res) => {
    try {
      const saved = deps.promptStore.save((req.body || {}).prompts);
      (deps.logLine || (() => {}))('ai-op', 'AI 提示词已在后台更新');
      res.json({ ok: true, prompts: saved });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ---- 生成图库（2026-10-22）：全部用户的 AI 生成图，按账号/描述搜索、按时间排序 ----
  const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
  app.get('/console/api/ai-gallery', consoleAuth, (req, res) => {
    try {
      const users = readJSON(path.join(DATA_DIR, 'users.json'), []);
      const umap = Object.fromEntries(users.map(u => [u.id, { name: u.name || u.email || u.id, email: u.email || '' }]));
      let jobs = readJSON(path.join(DATA_DIR, 'ai', 'jobs.json'), []);
      const q = String(req.query.q || '').trim().toLowerCase();
      const sort = req.query.sort === 'asc' ? 'asc' : 'desc';
      if (q) jobs = jobs.filter(j => {
        const u = umap[j.userId] || { name: j.userId, email: '' };
        return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (j.prompt || '').toLowerCase().includes(q);
      });
      jobs.sort((a, b) => sort === 'asc' ? String(a.createdAt).localeCompare(String(b.createdAt)) : String(b.createdAt).localeCompare(String(a.createdAt)));
      const total = jobs.length;
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(120, Math.max(1, parseInt(req.query.limit, 10) || 60));
      const list = jobs.slice(offset, offset + limit).map(j => {
        const idxs = Array.isArray(j.candidates) ? j.candidates : [];
        // 预览图：拆分记录用首个真实图层，其余用选定/首个候选
        const img = j.kind === 'split' ? (idxs[1] ?? idxs[0]) : (j.picked ?? idxs[0]);
        const u = umap[j.userId] || { name: j.userId, email: '' };
        return { id: j.id, userId: j.userId, userName: u.name, userEmail: u.email, prompt: j.prompt, kind: j.kind || 'gen', bigType: j.bigType, status: j.status, createdAt: j.createdAt, layers: (j.layers || []).length, img };
      }).filter(j => j.status === 'done' && j.img != null);
      res.json({ ok: true, total, list });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // 图库取图（后台鉴权；n 为候选序号，orig 为拆分原图）
  app.get('/console/api/ai-gallery/img', consoleAuth, (req, res) => {
    const jobs = readJSON(path.join(DATA_DIR, 'ai', 'jobs.json'), []);
    const j = jobs.find(x => x.id === req.query.job);
    if (!j) return res.status(404).json({ ok: false });
    const n = String(req.query.n || '');
    const f = n === 'orig' ? path.join(DATA_DIR, 'ai', j.id, 'orig.png') : path.join(DATA_DIR, 'ai', j.id, `c${parseInt(n, 10)}.png`);
    if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(f).pipe(res);
  });
  // 画板导出图（2026-10-22 起导出时浏览器上传存档；此前只有 downloads.json 元数据，无图）
  app.get('/console/api/export-records', consoleAuth, (req, res) => {
    try {
      const users = readJSON(path.join(DATA_DIR, 'users.json'), []);
      const umap = Object.fromEntries(users.map(u => [u.id, { name: u.name || u.email || u.id, email: u.email || '' }]));
      let logs = readJSON(path.join(DATA_DIR, 'console', 'exports.json'), []);
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) logs = logs.filter(l => { const u = umap[l.userId] || { name: l.userId, email: '' }; return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (l.boardTitle || '').toLowerCase().includes(q); });
      logs.sort((a, b) => String(b.time).localeCompare(String(a.time)));
      res.json({ ok: true, total: logs.length, list: logs.slice(0, 100).map(l => ({ ...l, userName: (umap[l.userId] || {}).name || l.userId, userEmail: (umap[l.userId] || {}).email || '' })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // 导出图取图（tif 浏览器无法预览，只有 PNG/JPG 能显示）
  app.get('/console/api/export-records/img', consoleAuth, (req, res) => {
    const logs = readJSON(path.join(DATA_DIR, 'console', 'exports.json'), []);
    const l = logs.find(x => x.id === req.query.id);
    if (!l) return res.status(404).json({ ok: false });
    const f = path.join(DATA_DIR, 'exports', path.basename(String(l.file || '')));
    if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
    res.setHeader('Content-Type', l.fmt === 'jpg' || f.endsWith('.jpg') ? 'image/jpeg' : (l.fmt === 'tif' || f.endsWith('.tif') ? 'image/tiff' : 'image/png'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(f).pipe(res);
  });

  // 退款预览与执行：只处理 OneFig 权益和授权码，不在站内发起资金退款。
  // 授权码流水永不删除；退款后公开验真失败，后台仍可审计完整来源。
  function refundImpact(order, user, allOrders, allDownloads) {
    const lines = [];
    const downloads = allDownloads || [];
    if (order.kind === 'export') {
      const licenseCodes = [...new Set(downloads.filter(l => l.kind === 'export' && l.userId === order.userId && l.code &&
        (l.orderId === order.id || (order.exportCode && l.code === order.exportCode))).map(l => l.code))];
      const consumed = !!(order.exportCode || order.consumedAt);
      // 旧订单若没有订单↔授权码关联，只在余额足以证明所有未关联订单都未使用时扣减，绝不猜测。
      const unlinkedPaid = allOrders.filter(o => o.userId === order.userId && o.kind === 'export' && o.status === 'paid' && !o.exportCode && !o.consumedAt).length;
      const balance = Math.max(0, Number(user.exportCredits) || 0);
      const exportCreditsDelta = !consumed && !licenseCodes.length && balance >= unlinkedPaid ? Math.min(1, balance) : 0;
      if (licenseCodes.length) lines.push(`收回授权码 ${licenseCodes.join('、')}（公开验真将显示“已退款回收”）`);
      else if (exportCreditsDelta) lines.push('扣回 1 次未使用的画板导出权益');
      else if (consumed) lines.push('该订单的导出授权码记录缺失，请在后台授权码查询中人工核对');
      else lines.push('旧订单的使用记录不完整，未自动扣减或回收其他作品的授权码，请人工核对');
      return { kind: 'export', creditsDelta: 0, exportCreditsDelta, licenseCodes, lines };
    }
    if (order.materialId) {
      const licenseCodes = [...new Set(downloads.filter(l => l.userId === order.userId && l.materialId === order.materialId && l.code).map(l => l.code))];
      lines.push('取消该素材的后续下载权益；历史下载记录保留');
      lines.push(licenseCodes.length ? `收回授权码 ${licenseCodes.join('、')}（公开验真将显示“已退款回收”）` : '该订单尚无下载授权码，无需回收');
      return { kind: 'single', creditsDelta: 0, materialId: order.materialId, licenseCodes, lines };
    }
    const history = loadLevelLog().filter(l => l.userId === order.userId && l.to === order.plan)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const orderTime = String(order.paidAt || order.createdAt || '');
    const previousPaid = allOrders.filter(o => o.id !== order.id && o.userId === order.userId && o.status === 'paid' && PLANS[o.plan] && !o.materialId && !o.kind && String(o.paidAt || o.createdAt || '') < orderTime)
      .sort((a, b) => String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt)))[0];
    const previousLevel = history[0] ? history[0].from : (previousPaid ? previousPaid.plan : 'none');
    const creditsDelta = Math.max(0, (MEMBER_GIFT[order.plan] || 0) - (MEMBER_GIFT[previousLevel] || 0));
    const levelChanged = (user.level || 'none') !== order.plan;
    if (!levelChanged && previousLevel !== order.plan) lines.push(`会员等级恢复为 ${PLANS[previousLevel] || '非会员'}`);
    else if (levelChanged) lines.push('当前会员档位已发生其他变化，不自动改等级');
    else lines.push('会员档位保持不变');
    if (creditsDelta) lines.push(`扣回本次档位对应的赠送积分 ${creditsDelta}（最多扣到 0，不出现负数）`);
    return { kind: 'member', previousLevel, previousPaidAt: previousPaid ? (previousPaid.paidAt || previousPaid.createdAt) : null, levelChanged, creditsDelta, licenseCodes: [], lines };
  }
  app.get('/console/api/orders/:id/refund-preview', consoleAuth, (req, res) => {
    const orders = load('orders.json', []);
    const order = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
    if (order.status !== 'paid') return res.status(400).json({ ok: false, error: '只有已支付订单可以退款' });
    const user = load('users.json', []).find(u => u.id === order.userId);
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
    const impact = refundImpact(order, user, orders, load('downloads.json', []));
    res.json({ ok: true, order, impact, notice: '请确认你已在微信/支付宝商户平台完成资金退款。这里只收回 OneFig 权益和对应授权码。' });
  });
  app.post('/console/api/orders/:id/refund', consoleAuth, (req, res) => {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, error: '请先查看退款预览并确认' });
    // 保留写入前快照；任一文件写入失败时恢复原始版本，而不是把已修改的内存对象写回。
    const original = {
      users: load('users.json', []), orders: load('orders.json', []), purchases: load('purchases.json', []),
      downloads: load('downloads.json', []), creditLog: loadLog(), levelLog: loadLevelLog(), refundLog: load('refund-log.json', []),
    };
    const copy = value => JSON.parse(JSON.stringify(value));
    const users = copy(original.users), orders = copy(original.orders), purchases = copy(original.purchases), downloads = copy(original.downloads);
    const order = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
    if (order.status === 'refunded') return res.status(400).json({ ok: false, error: '该订单已退款，请勿重复操作' });
    if (order.status !== 'paid') return res.status(400).json({ ok: false, error: '只有已支付订单可以退款' });
    const user = users.find(u => u.id === order.userId);
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
    const impact = refundImpact(order, user, orders, downloads);
    const refundedAt = new Date().toISOString();
    // 撤销只回滚本次实际影响；积分曾扣到 0 时记录真实扣减量，避免撤销时多送积分。
    const undoData = {
      kind: impact.kind,
      licenseCodes: impact.licenseCodes,
      exportCreditsDelta: impact.exportCreditsDelta || 0,
      levelRestored: impact.kind === 'member' && !impact.levelChanged && impact.previousLevel !== order.plan,
      previousLevel: impact.previousLevel || null,
      creditsRestored: 0,
      memberSince: user.memberSince || null,
      creditsGrantedFor: user.creditsGrantedFor || null,
    };
    try {
      if (impact.kind === 'member') {
        const beforeCredits = Math.max(0, Number(user.credits) || 0);
        user.credits = Math.max(0, beforeCredits - impact.creditsDelta);
        undoData.creditsRestored = beforeCredits - user.credits;
        if (undoData.creditsRestored) logCredit(user, -undoData.creditsRestored, '会员退款扣回赠送积分', 'admin');
        if (!impact.levelChanged) {
          logLevel(user, user.level || 'none', impact.previousLevel, 'admin');
          user.level = impact.previousLevel;
          user.memberSince = impact.previousPaidAt;
          if (impact.previousLevel === 'none') delete user.creditsGrantedFor;
          else user.creditsGrantedFor = impact.previousLevel;
        }
      } else if (impact.kind === 'single') {
        const remaining = purchases.filter(p => !(p.orderId === order.id || (p.userId === order.userId && p.materialId === order.materialId)));
        save('purchases.json', remaining);
      } else if (impact.kind === 'export') {
        user.exportCredits = Math.max(0, (user.exportCredits || 0) - impact.exportCreditsDelta);
      }
      if (impact.licenseCodes.length) {
        downloads.forEach(l => {
          if (impact.licenseCodes.includes(l.code)) {
            l.status = 'refund-revoked';
            l.revokeReason = 'refund';
            l.refundOrderId = order.id;
            l.revokedAt = refundedAt;
          }
        });
        save('downloads.json', downloads);
      }
      order.status = 'refunded';
      order.refundedAt = refundedAt;
      order.refundedBy = 'admin';
      order.refundImpact = impact.lines;
      order.refundedLicenseCodes = impact.licenseCodes;
      order.refundUndoData = undoData;
      save('users.json', users);
      save('orders.json', orders);
      save('refund-log.json', [...original.refundLog, { orderId: order.id, userId: order.userId, impact: impact.lines, licenseCodes: impact.licenseCodes, time: refundedAt, by: 'admin' }]);
      res.json({ ok: true, order, impact });
    } catch (e) {
      save('users.json', original.users);
      save('orders.json', original.orders);
      save('purchases.json', original.purchases);
      save('downloads.json', original.downloads);
      saveLog(original.creditLog);
      save('level-log.json', original.levelLog);
      save('refund-log.json', original.refundLog);
      res.status(500).json({ ok: false, error: '退款权益处理失败，已恢复原数据' });
    }
  });

  // 撤销退款回收：仅恢复 OneFig 权益，不操作商户平台资金，也不删除退款审计记录。
  app.post('/console/api/orders/:id/undo-refund', consoleAuth, (req, res) => {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, error: '请确认后再撤销退款回收' });
    const original = {
      users: load('users.json', []), orders: load('orders.json', []), purchases: load('purchases.json', []),
      downloads: load('downloads.json', []), creditLog: loadLog(), levelLog: loadLevelLog(), refundLog: load('refund-log.json', []),
    };
    const copy = value => JSON.parse(JSON.stringify(value));
    const users = copy(original.users), orders = copy(original.orders), purchases = copy(original.purchases), downloads = copy(original.downloads);
    const order = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: '订单不存在' });
    if (order.status !== 'refunded') return res.status(400).json({ ok: false, error: '只有已退款订单可以撤销回收' });
    const user = users.find(u => u.id === order.userId);
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
    const kind = order.kind === 'export' ? 'export' : order.materialId ? 'single' : 'member';
    let data = order.refundUndoData;
    if (!data) {
      // 兼容新快照上线前的退款；积分曾扣到 0 的旧记录无法得知实际扣减量，必须人工处理。
      const lines = order.refundImpact || [];
      const creditLine = lines.find(x => x.includes('赠送积分')) || '';
      const match = creditLine.match(/赠送积分\s+(\d+)/);
      const creditsRestored = match ? Number(match[1]) : 0;
      if (kind === 'member' && creditsRestored > 0 && (Number(user.credits) || 0) <= 0) {
        return res.status(400).json({ ok: false, error: '旧退款缺少积分快照，不能安全撤销，请人工核对后调整' });
      }
      const levelLine = lines.find(x => x.startsWith('会员等级恢复为')) || '';
      const previousLevel = levelLine ? (Object.keys(PLANS).find(k => levelLine.includes(PLANS[k])) || 'none') : null;
      data = {
        kind,
        licenseCodes: order.refundedLicenseCodes || [],
        exportCreditsDelta: lines.some(x => x.includes('扣回 1 次未使用')) ? 1 : 0,
        levelRestored: !!levelLine,
        previousLevel,
        creditsRestored,
        memberSince: user.memberSince || null,
        creditsGrantedFor: user.creditsGrantedFor || null,
      };
    }
    const undoneAt = new Date().toISOString();
    try {
      if (kind === 'member') {
        const restored = Math.max(0, Number(data.creditsRestored) || 0);
        user.credits = Math.max(0, Number(user.credits) || 0) + restored;
        if (restored) logCredit(user, restored, '撤销会员退款回收，返还实际扣减积分', 'admin');
        if (data.levelRestored) {
          const current = user.level || 'none';
          if (current === data.previousLevel) {
            logLevel(user, current, order.plan, 'admin');
            user.level = order.plan;
            user.memberSince = data.memberSince || order.paidAt || order.createdAt || null;
            user.creditsGrantedFor = data.creditsGrantedFor || order.plan;
          }
          // 若用户此后已改成其他档位，不覆盖后续变化；只恢复实际扣减积分。
        }
      } else if (kind === 'single') {
        if (!purchases.some(p => p.userId === order.userId && p.materialId === order.materialId)) {
          purchases.push({
            userId: order.userId, materialId: order.materialId, materialTitle: order.materialTitle || '', orderId: order.id,
            amount: order.amount, channel: order.channel || '', paidAt: order.paidAt || null,
            refundConsent: !!order.refundConsent, refundConsentAt: order.refundConsentAt || null,
          });
        }
        save('purchases.json', purchases);
      } else if (kind === 'export') {
        user.exportCredits = Math.max(0, Number(user.exportCredits) || 0) + Math.max(0, Number(data.exportCreditsDelta) || 0);
      }
      const codes = data.licenseCodes || [];
      if (codes.length) {
        downloads.forEach(l => {
          if (codes.includes(l.code) && l.refundOrderId === order.id) {
            delete l.status;
            delete l.revokeReason;
            delete l.refundOrderId;
            delete l.revokedAt;
          }
        });
        save('downloads.json', downloads);
      }
      order.status = 'paid';
      delete order.refundedAt;
      delete order.refundedBy;
      delete order.refundImpact;
      delete order.refundedLicenseCodes;
      delete order.refundUndoData;
      const refundLog = copy(original.refundLog);
      const entry = refundLog.slice().reverse().find(l => l.orderId === order.id && !l.undoneAt);
      if (entry) { entry.undoneAt = undoneAt; entry.undoneBy = 'admin'; }
      else refundLog.push({ orderId: order.id, userId: order.userId, action: 'undo-refund', time: undoneAt, by: 'admin' });
      save('users.json', users);
      save('orders.json', orders);
      save('refund-log.json', refundLog);
      res.json({ ok: true, order, restored: data });
    } catch (e) {
      save('users.json', original.users);
      save('orders.json', original.orders);
      save('purchases.json', original.purchases);
      save('downloads.json', original.downloads);
      saveLog(original.creditLog);
      save('level-log.json', original.levelLog);
      save('refund-log.json', original.refundLog);
      res.status(500).json({ ok: false, error: '撤销失败，已恢复撤销前的数据' });
    }
  });

  app.delete('/console/api/orders/:id', consoleAuth, (req, res) => {
    save('orders.json', load('orders.json', []).filter(o => o.id !== req.params.id));
    res.json({ ok: true });
  });

  app.get('/console/api/materials', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const active = data.flatMap(s => (s.materials || []).filter(m => !m.removed));
    if (req.query.hot) { active.sort((a, b) => b.downloads - a.downloads); return res.json({ ok: true, list: active.slice(0, 50) }); }
    const removedTotal = data.reduce((n, s) => n + (s.materials || []).filter(m => m.removed).length, 0);
    res.json({ ok: true, series: data, total: active.length, totalDownloads: active.reduce((s, m) => s + m.downloads, 0), removedTotal });
  });

  // 下架记录：后台单独查看/恢复/彻底删除（授权码流水不随下架删除）
  app.get('/console/api/materials/removed', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const list = data.flatMap(s => (s.materials || [])
      .filter(m => m.removed)
      .map(m => ({ id: m.id, series: m.series || s.folder, folder: s.folder, title: m.title, file: m.file, local: !!m.local, size: m.size || 0, downloads: m.downloads || 0, removedAt: m.removedAt || null })))
      .sort((a, b) => String(b.removedAt || '').localeCompare(String(a.removedAt || '')));
    res.json({ ok: true, list });
  });

  app.post('/console/api/materials', consoleAuth, (req, res) => {
    const { series, title } = req.body || {};
    if (!series) return res.status(400).json({ ok: false, error: '请填写文件夹名称' });
    const data = load('materials.json', []);
    let s = data.find(x => x.folder === series);
    if (!s) { s = { folder: series, materials: [] }; data.push(s); }
    if (title) {
      const existing = s.materials.find(m => m.title === title);
      if (existing && !existing.removed) return res.status(400).json({ ok: false, error: '该系列下已存在同名素材' });
      const fp = path.join(DATA_DIR, 'files', series, `${title}.png`);
      let size = 0;
      try { size = fs.statSync(fp).size } catch { /* 文件可能尚未上传，size 记 0，下次上传接口会刷新 */ }
      if (existing) {
        // 下架后同名重传 = 恢复原条目与 ID，已有下载授权码不受影响（2026-10-24）
        existing.removed = false;
        existing.removedAt = null;
        existing.updatedAt = new Date().toISOString();
        existing.file = `${title}.png`;
        existing.local = true;
        existing.size = size;
      } else {
        // local:true 必须与上传接口（server.js /console/api/materials/upload）保持一致：
        // 缺了它前端会把素材当"内置"去 /previews/*.webp 取图 → 404 → 画板拖不出（2026-10-23 事故）
        s.materials.push({ id: `${series}/${title}`, series, file: `${title}.png`, title, downloads: 0, createdAt: new Date().toISOString(), local: true, size });
      }
    }
    save('materials.json', data);
    res.json({ ok: true });
  });

  app.delete('/console/api/series/:folder', consoleAuth, (req, res) => {
    // 删除文件夹 = 全部素材下架留痕，不物理删除，避免历史授权码失去名称（2026-10-24）
    const data = load('materials.json', []);
    const now = new Date().toISOString();
    const s = data.find(x => x.folder === req.params.folder);
    if (s) s.materials.forEach(m => { m.removed = true; m.removedAt = now; });
    save('materials.json', data);
    res.json({ ok: true });
  });

  app.delete('/console/api/materials/:series/:title', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === req.params.series);
    if (!s) return res.status(404).json({ ok: false, error: '文件夹不存在' });
    const m = s.materials.find(x => x.title === req.params.title);
    if (!m) return res.status(404).json({ ok: false, error: '素材不存在' });
    // 下架而非物理删除：保留素材条目，前台隐藏，授权码与下载流水照常验真（2026-10-24）
    m.removed = true;
    m.removedAt = new Date().toISOString();
    save('materials.json', data);
    res.json({ ok: true, removed: true });
  });

  app.post('/console/api/materials/:series/:title/restore', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === req.params.series);
    const m = s && s.materials.find(x => x.title === req.params.title);
    if (!m) return res.status(404).json({ ok: false, error: '素材不存在' });
    m.removed = false;
    m.removedAt = null;
    save('materials.json', data);
    res.json({ ok: true, restored: true });
  });

  app.delete('/console/api/materials/:series/:title/permanent', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === req.params.series);
    if (!s) return res.status(404).json({ ok: false, error: '文件夹不存在' });
    const m = s.materials.find(x => x.title === req.params.title);
    if (!m) return res.status(404).json({ ok: false, error: '素材不存在' });
    if (!m.removed) return res.status(400).json({ ok: false, error: '请先下架，再彻底删除' });
    // 仅删除清单条目；downloads.json 中的授权码与快照保留，旧码仍可验真
    s.materials = s.materials.filter(x => x.title !== req.params.title);
    save('materials.json', data);
    res.json({ ok: true, purged: true });
  });

  // 排序保存：整体文件夹顺序 或 某文件夹内素材顺序（materials.json 数组顺序即前台展示顺序）
  app.post('/console/api/materials/reorder', consoleAuth, (req, res) => {
    const { series, folder, materials } = req.body || {};
    const data = load('materials.json', []);
    if (Array.isArray(series)) {
      if (series.length !== data.length || !series.every(f => data.some(x => x.folder === f))) {
        return res.status(400).json({ ok: false, error: '顺序和现有数据对不上，请刷新后重试' });
      }
      const map = {}; data.forEach(x => { map[x.folder] = x; });
      save('materials.json', series.map(f => map[f]));
      return res.json({ ok: true });
    }
    if (folder && Array.isArray(materials)) {
      const s = data.find(x => x.folder === folder);
      if (!s) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      if (materials.length !== s.materials.length || !materials.every(t => s.materials.some(m => m.title === t))) {
        return res.status(400).json({ ok: false, error: '顺序和现有数据对不上，请刷新后重试' });
      }
      const map = {}; s.materials.forEach(m => { map[m.title] = m; });
      s.materials = materials.map(t => map[t]);
      save('materials.json', data);
      return res.json({ ok: true });
    }
    res.status(400).json({ ok: false, error: '参数不对' });
  });

  // ---- 首页精选开关（2026-10-26）：素材/系列打 featured 标，首页精选区与系列大卡优先展示 ----
  app.post('/console/api/materials/feature', consoleAuth, (req, res) => {
    const { kind, folder, title, on } = req.body || {};
    if (!['series', 'material'].includes(kind)) return res.status(400).json({ ok: false, error: '参数不对' });
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === folder);
    if (!s) return res.status(404).json({ ok: false, error: '系列不存在' });
    if (kind === 'series') {
      s.featured = !!on;
    } else {
      const m = s.materials.find(x => x.title === title);
      if (!m) return res.status(404).json({ ok: false, error: '素材不存在' });
      m.featured = !!on;
    }
    save('materials.json', data);
    res.json({ ok: true });
  });

  // ---- 重命名：文件夹 / 素材（同步改 materials.json + 服务器文件目录 + OSS 预览图）----
  const { execFile } = require('child_process');
  const FILES_DIR = path.join(DATA_DIR, 'files');
  const ORIG_DIR = path.join(DATA_DIR, 'originals');
  const cleanName = s => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '');
  const mvIfExists = (a, b) => { try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch {} };
  // OSS 改名 = 复制新名 + 删旧名；OSS 上没有对应对象时静默跳过（如本地上传的素材没有 OSS 预览图）
  const ossMv = (src, dst, isDir) => new Promise(resolve => {
    execFile('ossutil64', isDir ? ['cp', '-r', '-f', src, dst] : ['cp', '-f', src, dst], { timeout: 120000 }, e => {
      if (e) return resolve(false);
      execFile('ossutil64', isDir ? ['rm', '-r', '-f', src] : ['rm', '-f', src], { timeout: 60000 }, () => resolve(true));
    });
  });

  app.post('/console/api/series/rename', consoleAuth, async (req, res) => {
    const oldN = String((req.body || {}).old || '');
    const newN = cleanName((req.body || {}).new);
    if (!oldN || !newN) return res.status(400).json({ ok: false, error: '请填写新名称' });
    if (newN === oldN) return res.json({ ok: true });
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === oldN);
    if (!s) return res.status(404).json({ ok: false, error: '文件夹不存在' });
    if (data.some(x => x.folder === newN)) return res.status(400).json({ ok: false, error: '已存在同名文件夹' });
    s.folder = newN;
    s.materials.forEach(m => { m.series = newN; m.id = newN + '/' + m.title; });
    save('materials.json', data);
    mvIfExists(path.join(ORIG_DIR, oldN), path.join(ORIG_DIR, newN));
    mvIfExists(path.join(FILES_DIR, oldN), path.join(FILES_DIR, newN));
    await ossMv('oss://onefig/previews/' + oldN + '/', 'oss://onefig/previews/' + newN + '/', true);
    res.json({ ok: true });
  });

  app.post('/console/api/materials/rename', consoleAuth, async (req, res) => {
    const series = String((req.body || {}).series || '');
    const oldT = String((req.body || {}).oldTitle || '');
    const newT = cleanName((req.body || {}).newTitle);
    if (!series || !oldT || !newT) return res.status(400).json({ ok: false, error: '请填写新名称' });
    if (newT === oldT) return res.json({ ok: true });
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === series);
    if (!s) return res.status(404).json({ ok: false, error: '文件夹不存在' });
    const m = s.materials.find(x => x.title === oldT);
    if (!m) return res.status(404).json({ ok: false, error: '素材不存在' });
    if (s.materials.some(x => x.title === newT)) return res.status(400).json({ ok: false, error: '已存在同名素材' });
    const oldFile = m.file || oldT + '.png';
    const ext = oldFile.includes('.') ? oldFile.slice(oldFile.lastIndexOf('.')) : '.png';
    const newFile = newT + ext;
    if (m.local) mvIfExists(path.join(FILES_DIR, series, oldFile), path.join(FILES_DIR, series, newFile));
    mvIfExists(path.join(ORIG_DIR, series, oldFile), path.join(ORIG_DIR, series, newFile));
    m.title = newT; m.id = series + '/' + newT; m.file = newFile;
    save('materials.json', data);
    await ossMv('oss://onefig/previews/' + series + '/' + oldT + '.webp', 'oss://onefig/previews/' + series + '/' + newT + '.webp', false);
    res.json({ ok: true });
  });

  app.get('/console/api/submissions', consoleAuth, (req, res) => {
    res.json({ ok: true, list: deps.readSubmissions() });
  });

  // ---------- 网站体检（服务器实时健康状态，供后台体检页可视化展示；全部为固定命令，无用户输入拼接） ----------
  const sh = (cmd, timeout) => { try { return execSync(cmd, { timeout: timeout || 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  app.get('/console/api/health', consoleAuth, (req, res) => {
    const items = [];
    const add = (key, name, status, value, hint) => items.push({ key, name, status, value, hint });

    // 1. 网站主服务
    const apiActive = sh('systemctl is-active onefig-api') === 'active';
    add('api', '网站主服务', apiActive ? 'ok' : 'bad', apiActive ? '运行中' : '已停止',
      apiActive ? '处理所有访问请求的核心服务' : '网站现在打不开！请截图本页联系 Kimi 处理');

    // 2. AI 抠图服务
    const rembgActive = sh('systemctl is-active onefig-rembg') === 'active';
    add('rembg', 'AI 抠图服务', rembgActive ? 'ok' : 'warn', rembgActive ? '运行中' : '未运行',
      rembgActive ? '负责 AI 抠图功能' : 'AI 抠图暂不可用，其他功能不受影响，可联系 Kimi 恢复');

    // 3. 磁盘
    const diskPct = parseInt(sh('df / --output=pcent | tail -1') || '0', 10) || 0;
    const diskAvail = sh('df -h / --output=avail | tail -1') || '?';
    add('disk', '服务器磁盘', diskPct >= 90 ? 'bad' : diskPct >= 80 ? 'warn' : 'ok',
      diskPct + '% 已用（剩余 ' + diskAvail + '）',
      diskPct >= 80 ? '空间偏紧，请联系 Kimi 清理或扩容' : '存素材原图和备份用的空间');

    // 4. 内存
    const mem = sh("free -m | awk 'NR==2{print $3, $2}'");
    let memPct = 0;
    if (mem) { const p = mem.split(/\s+/).map(Number); if (p[1]) memPct = Math.round(p[0] / p[1] * 100); }
    add('mem', '服务器内存', memPct >= 95 ? 'bad' : memPct >= 85 ? 'warn' : 'ok', memPct + '% 已用',
      memPct >= 85 ? '内存偏紧，若网站变慢请联系 Kimi' : '运行程序的临时空间');

    // 5. 每日自动备份
    const lastBackup = sh("grep 'backup done' /var/log/onefig-backup.log 2>/dev/null | tail -1");
    let backupHours = null, backupTime = '';
    if (lastBackup) {
      const m = lastBackup.match(/\[([\d-]+ [\d:]+)\]/);
      if (m) { backupTime = m[1]; backupHours = Math.round((Date.now() - new Date(m[1].replace(' ', 'T') + '+08:00').getTime()) / 3600000); }
    }
    const upFail = sh("grep -c 'OSS-UPLOAD-FAIL' /var/log/onefig-backup.log 2>/dev/null") || '0';
    add('backup', '每日自动备份',
      backupHours === null ? 'bad' : backupHours <= 26 ? (upFail === '0' ? 'ok' : 'warn') : 'bad',
      backupHours === null ? '无记录' : '上次备份：' + backupTime,
      backupHours === null ? '备份从未运行过，请联系 Kimi'
        : backupHours > 26 ? '备份超过一天没跑了，请联系 Kimi'
        : upFail === '0' ? '每天凌晨 3:40 自动备份网站数据' : '备份已运行但上传云端有失败记录，建议联系 Kimi 查看');

    // 6. 云端异地备份
    const ossLast = sh("ossutil64 ls oss://onefig/backups/ 2>/dev/null | grep -oE 'onefig-json-[0-9]{8}-[0-9]{4}' | sort | tail -1", 15000);
    let ossTime = '', ossHours = null;
    if (ossLast) {
      const m = ossLast.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
      if (m) { ossTime = m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]; ossHours = Math.round((Date.now() - new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':00+08:00').getTime()) / 3600000); }
    }
    add('oss', '云端异地备份', ossHours === null ? 'warn' : ossHours <= 26 ? 'ok' : 'warn',
      ossHours === null ? '暂时查询不到' : '云端最新：' + ossTime,
      ossHours !== null && ossHours <= 26 ? '备份同时存了一份在阿里云，防服务器损坏' : '云端备份可能有延迟，持续多天请联系 Kimi');

    // 7. 自动巡检（看门狗）
    const alerts = sh("grep -c 'ALERT' /var/log/onefig-watchdog.log 2>/dev/null") || '0';
    add('watchdog', '自动巡检', alerts === '0' ? 'ok' : 'warn',
      alerts === '0' ? '无待处理告警' : '有 ' + alerts + ' 条告警待处理',
      alerts === '0' ? '每 30 分钟自动检查备份、磁盘和服务' : '巡检发现了问题，请截图本页联系 Kimi 查看');

    // 8. 当前版本
    let ver = '';
    try { ver = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || ''; } catch {}
    add('version', '系统版本', 'ok', ver ? 'v' + ver : '—', '反馈问题时把这个版本号一并发给 Kimi');

    // 9. 后台 HTML 内嵌脚本（与部署前门禁共用同一套检查）
    let inline;
    try { inline = checkConsoleInline(path.join(__dirname, 'console.js')); }
    catch (e) { inline = { ok: false, blocks: 0, error: e.message }; }
    add('inline-script', '后台页面脚本', inline.ok ? 'ok' : 'bad',
      inline.ok ? `${inline.blocks} 个脚本块语法正常` : '语法异常',
      inline.ok ? '后台 HTML 内嵌 JS 可正常解析' : (inline.error || '请检查确认弹窗换行/引号转义'));

    // 每周巡检简报（2026-10-25）：本机定时任务巡检后把摘要 scp 推送到此文件；无文件则前端不显示该卡片
    let report = null;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'console', 'health-report.json'), 'utf8'));
      if (r && r.date && r.summary) report = { date: String(r.date).slice(0, 20), overall: r.overall || 'ok', summary: String(r.summary).slice(0, 500), anomalies: Array.isArray(r.anomalies) ? r.anomalies.slice(0, 10).map(a => String(a).slice(0, 200)) : [] };
    } catch {}

    const bad = items.filter(i => i.status === 'bad').length;
    const warn = items.filter(i => i.status === 'warn').length;
    res.json({ ok: true, overall: bad ? 'bad' : warn ? 'warn' : 'ok', bad, warn, items, report, checkedAt: new Date().toISOString() });
  });

  // ---------- 页面（公开访问，内含登录界面；数据接口均有 consoleAuth 保护） ----------
  app.get(deps.ADMIN_PATH_FULL, (req, res) => res.send(PAGE));
  app.get('/', (req, res) => res.redirect(deps.ADMIN_PATH_FULL));
};

const OSS = 'http://onefig.oss-cn-hangzhou.aliyuncs.com/previews/';

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无花有果 · 管理后台</title>
<link rel="icon" type="image/png" href="/brand/icon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f6f4fb;color:#3d3a4b;display:flex;min-height:100vh}
.side{width:220px;background:linear-gradient(180deg,#6d4fb0,#8f73d6);color:#fff;padding:22px 14px;position:sticky;top:0;height:100vh;flex-shrink:0;display:flex;flex-direction:column;gap:4px}
.side .brand{font-size:18px;font-weight:700;text-align:center;padding:6px 0 22px}
.side a{display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.82);text-decoration:none;padding:11px 14px;border-radius:10px;font-size:14px;transition:.15s}
.side a:hover{background:rgba(255,255,255,.12);color:#fff}
.side a.active{background:rgba(255,255,255,.92);color:#6d4fb0;font-weight:600}
.main{flex:1;padding:26px 40px 60px;max-width:1600px;width:100%;margin:0 auto}
h2{font-size:20px;margin-bottom:4px}
.sub{color:#8b84a3;font-size:13px;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(124,92,191,.07)}
.kpi .num{font-size:26px;font-weight:700;color:#6d4fb0;margin-top:6px}
.kpi .lbl{font-size:12px;color:#8b84a3}
.kpi .chips{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.chip{font-size:11px;background:#f3f0fa;color:#6d4fb0;border-radius:999px;padding:2px 9px;font-weight:600}
.panel{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px rgba(124,92,191,.07);margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#8b84a3;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid #efeafb;font-size:12px}
td{padding:10px;border-bottom:1px solid #f6f4fb;vertical-align:middle}
select,input,textarea{font-family:inherit;font-size:13px;padding:7px 10px;border:1px solid #e3dcf2;border-radius:8px;background:#fff;color:#3d3a4b;outline:none}
select:focus,input:focus{border-color:#a78bfa}
/* 统一自定义下拉框：原生 select 保留在 DOM 中，继续承担值与 onchange 逻辑 */
.select-native{display:none!important}
.ui-select{position:relative;display:inline-flex;vertical-align:middle;max-width:100%;font-size:13px}
.ui-select-block{display:flex;width:100%;min-width:0!important}
.select-control{position:relative;display:flex;align-items:center;width:100%;min-height:36px;padding:8px 38px 8px 12px;border:1px solid #e0d7ef;border-radius:9px;background:#fff;color:#3d3a4b;font-family:inherit;font-size:13px;font-weight:600;line-height:1.35;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s}
.select-control:hover{border-color:#b9a4df;background:#fcfbfe}
.select-control:focus-visible,.ui-select.open .select-control{border-color:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.14);outline:none}
.select-value{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.select-arrow{position:absolute;right:12px;top:50%;width:15px;height:15px;transform:translateY(-50%);color:#8b73b7;pointer-events:none;transition:transform .16s,color .15s}
.ui-select.open .select-arrow{transform:translateY(-50%) rotate(180deg);color:#6d4fb0}
.select-menu{position:absolute;z-index:100;top:calc(100% + 7px);left:0;display:none;min-width:100%;max-height:248px;overflow:auto;padding:6px;border:1px solid #e5dcf2;border-radius:12px;background:#fff;box-shadow:0 14px 36px rgba(62,42,96,.16),0 3px 10px rgba(62,42,96,.06)}
.ui-select.open .select-menu{display:block;animation:select-in .14s ease-out}
.ui-select.up .select-menu{top:auto;bottom:calc(100% + 7px)}
.select-option{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;min-height:36px;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:#514a61;font-family:inherit;font-size:13px;line-height:1.35;text-align:left;white-space:nowrap;cursor:pointer}
.select-option:hover,.select-option:focus-visible{background:#f4f0fb;color:#6d4fb0;outline:none}
.select-option[aria-selected="true"]{background:#eee8fa;color:#6d4fb0;font-weight:600}
.select-check{display:inline-block;min-width:14px;color:#7c5cbf;font-weight:700;text-align:right}
@keyframes select-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.btn{border:none;border-radius:9px;padding:8px 16px;font-size:13px;cursor:pointer;font-weight:600;transition:.15s;white-space:nowrap}
.btn-p{background:linear-gradient(135deg,#7c5cbf,#a78bfa);color:#fff}
.btn-p:hover{transform:translateY(-1px);box-shadow:0 4px 10px rgba(124,92,191,.35)}
.btn-g{background:#f3f0fa;color:#6d4fb0}
.btn-d{background:#fdeef0;color:#d6336c}
.btn-xs{padding:4px 10px;font-size:12px}
.bar-row{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:12px}
.bar-row .d{width:44px;color:#8b84a3;text-align:right}
.bar-row .track{flex:1;height:14px;background:#f3f0fa;border-radius:4px;overflow:hidden;display:flex}
.bar-row .ub{height:100%;background:linear-gradient(90deg,#a78bfa,#c4b5fd)}
.bar-row .rb{height:100%;background:linear-gradient(90deg,#f0abfc,#f5d0fe)}
.bar-row .v{width:70px;color:#6d4fb0;font-weight:600}
.legend{display:flex;gap:16px;font-size:12px;color:#8b84a3;margin:4px 0 10px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
.chart{display:flex;align-items:flex-end;gap:3px;height:170px;padding-top:18px}
.chart .ccol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0;position:relative;height:100%}
.chart .cbar{width:70%;max-width:26px;border-radius:4px 4px 0 0;min-height:2px;transition:.2s;position:relative}
.chart .ccol:hover .cbar{filter:brightness(1.12)}
.chart .cval{position:absolute;bottom:calc(100% + 3px);left:50%;transform:translateX(-50%);font-size:10px;color:#6d4fb0;font-weight:600;white-space:nowrap}
.clabels{display:flex;gap:3px;margin-top:6px}
.clabels span{flex:1;font-size:10px;color:#b0aac4;text-align:center;min-width:0;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px}
.mat{background:#fff;border-radius:12px;padding:10px;box-shadow:0 2px 8px rgba(124,92,191,.07);text-align:center}
.mat img{width:100%;height:96px;object-fit:contain;background:#faf9fd;border-radius:8px;border:1px solid #efeafb}
.mat .t{font-size:12px;margin-top:6px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mat .mat-del{display:none}
.mat:hover .mat-del{display:inline-block}
.mat .dl{font-size:11px;color:#a78bfa;margin:3px 0 6px}
.folder{background:#fff;border-radius:14px;padding:16px;box-shadow:0 2px 8px rgba(124,92,191,.07);cursor:pointer;transition:.15s;text-align:center;position:relative}
.folder:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(124,92,191,.15)}
.folder .ic{font-size:34px}
.folder .n{font-size:13px;font-weight:600;margin-top:6px}
.folder .c{font-size:11px;color:#8b84a3}
.folder.sorting,.mat.sorting{cursor:grab;outline:2px dashed #c4b5fd;outline-offset:-2px}
.folder.sorting:hover,.mat.sorting:hover{outline-color:#7c5cbf;transform:none}
.f-edit{position:absolute;top:8px;right:8px;display:none;padding:3px 9px;font-size:12px}
.folder:hover .f-edit{display:inline-block}
.vnav{position:absolute;top:44%;transform:translateY(-50%);width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.88);color:#6d4fb0;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(40,25,70,.25);font-weight:700}
.vnav:hover{background:#fff}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.toolbar .sp{flex:1}
.card{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(124,92,191,.07);padding:16px;margin-bottom:12px;display:flex;gap:14px}
.card.done{opacity:.55}
.thumb{display:flex;flex-wrap:nowrap;gap:8px;max-width:356px;flex:none;overflow-x:auto}
.thumb img{width:110px;height:110px;object-fit:contain;border-radius:10px;background:#faf9fd;border:1px solid #efeafb}
.noimg{width:110px;height:110px;border-radius:10px;background:#f3f0fa;color:#b3a6d4;display:flex;align-items:center;justify-content:center;font-size:11px;text-align:center;line-height:1.5}
.cbody{flex:1;min-width:0}
.tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;font-size:11px}
.tag{background:#f3f0fa;color:#6d4fb0;border-radius:999px;padding:2px 9px;font-weight:600}
.tag.new{background:linear-gradient(135deg,#7c5cbf,#a78bfa);color:#fff}
.tag.done2{background:#e8f7ee;color:#2f9e5f}
.time{margin-left:auto;color:#b0aac4}
.desc{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.contact{font-size:12px;color:#8b84a3;margin-top:6px;background:#faf9fd;border-radius:6px;padding:4px 9px;display:inline-block}
.ops{display:flex;flex-direction:column;justify-content:center;gap:10px;flex:none}
.ops .btn{padding:10px 16px;font-size:13px;white-space:nowrap}
.btn-del{opacity:0;transition:opacity .15s}
.card:hover .btn-del{opacity:1}
.modal-mask{position:fixed;inset:0;background:rgba(40,25,70,.4);display:none;align-items:center;justify-content:center;z-index:10}
.modal{background:#fff;border-radius:16px;padding:22px;width:380px;max-width:92vw}
.modal h3{font-size:16px;margin-bottom:14px}
.modal .row{margin-bottom:12px}
.modal .row label{display:block;font-size:12px;color:#8b84a3;margin-bottom:4px}
.modal input,.modal select{width:100%}
.modal .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);background:rgba(61,58,75,.82);backdrop-filter:blur(6px);color:#fff;padding:10px 20px;border-radius:999px;font-size:13px;display:none;z-index:60;pointer-events:none;box-shadow:0 4px 16px rgba(61,58,75,.25)}
.login-mask{position:fixed;inset:0;background:linear-gradient(135deg,#f6f4fb,#e9dffb);display:none;align-items:center;justify-content:center;z-index:50}
.login-card{background:#fff;border-radius:18px;padding:36px 34px;width:340px;max-width:92vw;box-shadow:0 14px 44px rgba(124,92,191,.2);text-align:center}
.login-card h1{font-size:19px;margin:12px 0 4px}
.login-card .sub{margin-bottom:20px}
.login-card input{width:100%;margin-bottom:12px;padding:10px 12px}
.login-card .btn{width:100%;padding:11px;font-size:14px}
.login-err{color:#d6336c;font-size:12px;min-height:18px;margin-bottom:6px}
.acct{margin-top:auto;background:rgba(255,255,255,.14);border-radius:12px;padding:9px 12px;font-size:12px;color:rgba(255,255,255,.88);display:flex;align-items:center;gap:6px}
.acct button{margin-left:auto;padding:4px 10px;font-size:11px;background:rgba(255,255,255,.22);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600}
.acct button:hover{background:rgba(255,255,255,.34)}
.hl{display:flex;gap:12px;align-items:flex-start}
.hl .dot{width:12px;height:12px;border-radius:50%;margin-top:5px;flex-shrink:0}
.hl .dot.ok{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.16)}
.hl .dot.warn{background:#fbbf24;box-shadow:0 0 0 4px rgba(251,191,36,.16)}
.hl .dot.bad{background:#f87171;box-shadow:0 0 0 4px rgba(248,113,113,.16)}
.hl .t{font-weight:600;font-size:14px}
.hl .v{font-size:13px;color:#6d4fb0;font-weight:600;margin-top:3px}
.hl .h{font-size:12px;color:#8b84a3;margin-top:2px}
.banner{border-radius:14px;padding:22px 24px;color:#fff;margin-bottom:18px;box-shadow:0 4px 14px rgba(124,92,191,.12)}
.banner.ok{background:linear-gradient(135deg,#34d399,#10b981)}
.banner.warn{background:linear-gradient(135deg,#fbbf24,#f59e0b)}
.banner.bad{background:linear-gradient(135deg,#f87171,#ef4444)}
@media(max-width:760px){.side{width:60px;padding:14px 6px}.side .brand{font-size:0}.side a{font-size:0;justify-content:center}.side a .ic{font-size:18px}.main{padding:16px}}
</style></head><body>
<div class="side">
  <div class="brand" style="display:flex;align-items:center;justify-content:center;gap:8px"><img src="/brand/icon.png" style="width:30px;height:30px;object-fit:contain;border-radius:8px;background:#fff;padding:2px">无花有果 后台</div>
  <a href="#/dashboard" data-r="dashboard"><span class="ic">📊</span>数据看板</a>
  <a href="#/materials" data-r="materials"><span class="ic">🎨</span>素材管理</a>
  <a href="#/users" data-r="users"><span class="ic">👥</span>账号管理</a>
  <a href="#/invoices" data-r="invoices"><span class="ic">🧾</span>发票管理</a>
  <a href="#/requests" data-r="requests"><span class="ic">💌</span>素材请求</a>
  <a href="#/aiprompts" data-r="aiprompts"><span class="ic">🤖</span>AI 提示词</a>
  <a href="#/gallery" data-r="gallery"><span class="ic">🖼️</span>生成图库</a>
  <a href="#/logs" data-r="logs"><span class="ic">📝</span>操作日志</a>
  <a href="#/health" data-r="health"><span class="ic">🩺</span>网站体检</a>
  <div class="acct"><span>👤</span><span id="acct-name" style="overflow:hidden;text-overflow:ellipsis">管理员</span><button onclick="logout()">退出</button></div>
</div>
<div class="main" id="view">加载中…</div>
<div class="modal-mask" id="mask"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>
<div class="login-mask" id="loginMask"><div class="login-card">
  <img src="/brand/icon.png" style="width:48px;height:48px;border-radius:12px;background:#f6f4fb;padding:4px;object-fit:contain">
  <h1>无花有果 · 管理后台</h1>
  <div class="sub">请登录后使用</div>
  <div class="login-err" id="loginErr"></div>
  <input id="loginUser" placeholder="账号" autocomplete="username" onkeydown="if(event.key==='Enter')doLogin()">
  <input id="loginPass" type="password" placeholder="密码" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()">
  <button class="btn btn-p" onclick="doLogin()">登 录</button>
</div></div>
<script>
const H={};let SUBS=[],CACHE={};
const PLANS={basic:'青果会员',pro:'红果会员',team:'金果会员'};
/* ---------- 登录态 ---------- */
const TK_KEY='onefig_console_token',NM_KEY='onefig_console_name';
function getTK(){return localStorage.getItem(TK_KEY)||''}
function setTK(t,n){if(t){localStorage.setItem(TK_KEY,t);localStorage.setItem(NM_KEY,n||'')}else{localStorage.removeItem(TK_KEY);localStorage.removeItem(NM_KEY)}}
window.logout=()=>{setTK('');document.getElementById('loginMask').style.display='flex'};
window.doLogin=async()=>{
  const u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value;
  const err=document.getElementById('loginErr');err.textContent='';
  if(!u||!p){err.textContent='请输入账号和密码';return}
  try{
    const r=await fetch('/console/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const j=await r.json();
    if(!j.ok){err.textContent=j.error||'登录失败';return}
    setTK(j.token,j.name||u);document.getElementById('acct-name').textContent=j.name||u;
    document.getElementById('loginPass').value='';
    document.getElementById('loginMask').style.display='none';route();
  }catch(e){err.textContent='网络错误，稍后再试'}
};
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2200)}
async function api(u,opt){
  opt=opt||{};opt.headers=Object.assign({},opt.headers,{Authorization:'Bearer '+getTK()});
  const r=await fetch(u,opt);
  if(r.status===401){logout();throw new Error('登录已过期，请重新登录')}
  const j=await r.json();if(!j.ok)throw new Error(j.error||'操作失败');return j;
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function yuan(n){return '¥'+Number(n).toLocaleString('zh-CN',{minimumFractionDigits:1,maximumFractionDigits:1})}
function fmtSize(b){b=Number(b)||0;if(!b)return '—';return b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB'}
function fmtT(t){if(!t)return '—';if(/^\d{4}-\d{2}-\d{2}$/.test(t))return t;const d=new Date(t);if(isNaN(d))return t;const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
const OSS_P='${OSS}';
function matImg(m){return m.local?'/files/'+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.file||(m.title+'.png')):OSS_P+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.title)+'.webp'}
function showModal(html){const m=document.getElementById('modal');m.style.width='';delete m.dataset.nav;m.innerHTML=html;document.getElementById('mask').style.display='flex'}
/* 大图浏览：支持左右箭头 + 键盘 ← →，Escape 关闭；条目可为 {src,t} 带标题 */
let VIEW_LIST=[],VIEW_I=0,CUR_IMGS=[],REQ_IMGS=[],MODAL_BACK=null;
window.viewMat=src=>viewMatList([{src}],0);
window.viewMatList=(list,i)=>{
  const m=document.getElementById('modal');
  // 从详情弹窗进入大图时记录父层；关闭大图应返回详情，而不是全部退出。
  if(document.getElementById('mask').style.display==='flex'&&m.dataset.nav!=='1')MODAL_BACK={html:m.innerHTML,width:m.style.width};
  VIEW_LIST=list;VIEW_I=i;renderView()
};
window.viewNav=d=>{if(document.getElementById('modal').dataset.nav!=='1')return;const n=VIEW_LIST.length;if(!n)return;VIEW_I=(VIEW_I+d+n)%n;renderView()};
function renderView(){
  const it=VIEW_LIST[VIEW_I],src=it.src||it,t=it.t||'',multi=VIEW_LIST.length>1;
  showModal('<div style="background:#c9cad1;border-radius:12px;padding:12px;position:relative">'
    +(t?'<div style="text-align:center;font-weight:700;color:#3d3a4b;font-size:14px;margin-bottom:8px">'+esc(t)+'</div>':'')
    +'<img src="'+src+'" style="max-width:76vw;max-height:72vh;object-fit:contain;display:block;margin:0 auto">'
    +(multi?'<button class="vnav" style="left:20px" onclick="viewNav(-1)">‹</button><button class="vnav" style="right:20px" onclick="viewNav(1)">›</button>':'')
    +(multi?'<div style="text-align:center;font-size:12px;color:#6d4fb0;margin-top:8px;font-weight:600">'+(VIEW_I+1)+' / '+VIEW_LIST.length+'</div>':'')
    +'</div>');
  const m=document.getElementById('modal');m.style.width='auto';m.dataset.nav='1';
}
document.addEventListener('keydown',e=>{
  if(document.getElementById('mask').style.display!=='flex')return;
  if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.key==='ArrowLeft')viewNav(-1);
  else if(e.key==='ArrowRight')viewNav(1);
  else if(e.key==='Escape')closeModal();
});
/* 复制：http 环境下 navigator.clipboard 不可用，自动降级 execCommand */
window.cpTxt=t=>{
  t=t.trim();if(!t||t==='—')return;
  const done=()=>toast('已复制：'+t);
  const fallback=()=>{const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done()}catch(e){toast('复制失败，请手动选择')}document.body.removeChild(ta)};
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(done).catch(fallback)}else fallback();
};
function closeModal(){
  if(MODAL_BACK){
    const m=document.getElementById('modal'),back=MODAL_BACK;MODAL_BACK=null;
    m.innerHTML=back.html;m.style.width=back.width;delete m.dataset.nav;
    document.getElementById('mask').style.display='flex';
    return;
  }
  document.getElementById('mask').style.display='none';
}
document.getElementById('mask').onclick=e=>{if(e.target.id==='mask')closeModal()};

/* ---------- 1. 数据看板 ---------- */
// 2026-10-15 起微信/支付宝在线支付已对接，付款回调自动升级会员/到账积分，
// 不再有人工「待确认收款」环节；看板只保留统计卡片与走势图。
H.dashboard=async()=>{
  const s=await api('/console/api/stats');
  const trend=await api('/console/api/trend?range='+(window._range||30));
  const RANGES=[[7,'一周'],[30,'一月'],[180,'半年'],[365,'一年']];
  const tabBtns=RANGES.map(r=>'<button class="btn btn-xs '+( (window._range||30)===r[0]?'btn-p':'btn-g')+'" onclick="setRange('+r[0]+')">'+r[1]+'</button>').join('');
  const chart=(days,key,color,fmt)=>{
    const max=Math.max(1,...days.map(d=>d[key]));
    const cols=days.map(d=>{
      const h=Math.max(d[key]>0?4:1.5, d[key]/max*100);
      return '<div class="ccol" title="'+d.date+' · '+fmt(d[key])+'"><div class="cbar" style="height:'+h+'%;background:'+color+'">'+(d[key]>0?'<div class="cval">'+fmt(d[key])+'</div>':'')+'</div></div>';
    }).join('');
    const step=Math.ceil(days.length/8);
    const labels=days.map((d,i)=>(i%step===0||i===days.length-1)?'<span>'+d.date+'</span>':'<span></span>').join('');
    return '<div class="chart">'+cols+'</div><div class="clabels">'+labels+'</div>';
  };
  const cs=await api('/console/api/credit-stats?range='+(window._crange||30)).catch(()=>null);
  const ai=await api('/console/api/ai-stats').catch(()=>null);
  const leak=await api('/console/api/leak-watch').catch(()=>null);
  // 验真异常：非作者查询明显多于作者的授权码，疑似泄露/转卖
  const leakPanel=leak?('<div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">🔍 验真异常监控</h3><div class="sp"></div><span class="sub" style="font-size:12px">非作者查询 ≥3 且多于作者本人的授权码</span></div>'
    +(leak.list.length
      ? '<div style="max-height:260px;overflow:auto"><table><tr><th>授权码</th><th>素材</th><th>获授权账号</th><th>查询构成</th><th>最近查询</th></tr>'
        +leak.list.map(r=>'<tr><td><button class="btn btn-g btn-xs" title="点击复制" onclick="cpTxt(\\''+r.code+'\\')">'+esc(r.code)+'</button></td><td><b>'+esc(r.material)+'</b>'+(r.series?' <span style="color:#b0aac4;font-size:12px">'+esc(r.series)+'</span>':'')+'</td><td style="font-size:12px">'+esc(r.author)+'</td><td style="font-size:12px">👤 作者 '+r.authorCount+' 次 · 🧑‍💻 游客 '+r.guestCount+' 次 · 🔐 其他 '+r.otherUsers+' 人共 '+(r.otherTotal-r.guestCount)+' 次<span style="color:#d6336c;font-weight:600">（共 '+r.total+' 次）</span></td><td style="font-size:12px">'+fmtT(r.last)+'</td></tr>').join('')
        +'</table></div>'
      : '<div class="sub" style="padding:14px;text-align:center">✅ 暂无异常授权码</div>')+'</div>'):'';
  const aiPanel=ai?('<div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">🤖 今日 AI 工坊使用</h3><div class="sp"></div><a class="btn btn-g btn-xs" href="#/logs">查看操作明细</a></div>'
    +(ai.total
      ? '<div class="cards">\
        <div class="kpi"><div class="lbl">今日使用</div><div class="num">'+ai.total+' 次</div></div>\
        <div class="kpi"><div class="lbl">成功 / 失败</div><div class="num">'+ai.okCount+' / <span style="color:'+(ai.failCount?'#d6336c':'#2f9e5f')+';font-weight:700">'+ai.failCount+'</span></div></div>\
        <div class="kpi"><div class="lbl">消耗积分</div><div class="num">'+ai.credits+' 分</div></div>\
      </div>\
      <div class="chips" style="margin-top:10px">'+Object.entries(ai.byFeature).map(([k,v])=>'<span class="chip">'+esc(k)+' '+v+' 次</span>').join('')+'</div>'
      : '<div class="sub">今日还没有 AI 使用记录</div>')+'</div>'):'';
  const crange=window._crange||30;
  const crBtns=RANGES.map(r=>'<button class="btn btn-xs '+(crange===r[0]?'btn-p':'btn-g')+'" onclick="setCRange('+r[0]+')">'+r[1]+'</button>').join('');
  const creditPanel=cs?('<div class="cards">\
    <div class="kpi"><div class="lbl">⚡ 积分总收入</div><div class="num">'+yuan(cs.totalRevenue)+'</div><div class="chips"><span class="chip">共售出 '+cs.totalCredits+' 积分</span><span class="chip">'+cs.totalOrders+' 笔</span></div></div>\
    '+cs.byPkg.map(p=>'<div class="kpi"><div class="lbl">💠 '+p.name+' 套餐</div><div class="num">'+yuan(p.revenue)+'</div><div class="chips"><span class="chip">'+p.count+' 笔</span><span class="chip">'+p.credits+' 积分</span></div></div>').join('')+'\
  </div>\
  <div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">⚡ 每日购买积分数</h3><div class="sp"></div>'+crBtns+'</div>'+chart(cs.days,'credits','linear-gradient(180deg,#fbbf24,#f59e0b)',v=>v+'分')+'</div>'):'';
  return '<div class="toolbar"><h2>📊 数据看板</h2><div class="sp"></div></div>\
  <div class="cards">\
    <div class="kpi"><div class="lbl">总用户</div><div class="num">'+s.totalUsers+'</div><div class="chips"><span class="chip" style="color:#2f9e5f">🟢 当前在线 '+s.online+' 人</span></div></div>\
    <div class="kpi"><div class="lbl">🟢 青果会员</div><div class="num">'+s.levelCount.basic+'</div></div>\
    <div class="kpi"><div class="lbl">🔴 红果会员</div><div class="num">'+s.levelCount.pro+'</div></div>\
    <div class="kpi"><div class="lbl">🟡 金果会员</div><div class="num">'+s.levelCount.team+'</div></div>\
    <div class="kpi"><div class="lbl">总支付金额</div><div class="num">'+yuan(s.totalRevenue)+'</div><div class="chips"><span class="chip">不含测试账号</span></div></div>\
  </div>'+aiPanel+'\
  <div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">💰 每日收入走势</h3><div class="sp"></div>'+tabBtns+'</div>'+chart(trend.days,'revenue','linear-gradient(180deg,#a78bfa,#7c5cbf)',v=>yuan(v))+'</div>\
  <div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">🌱 每日新增用户</h3><div class="sp"></div>'+tabBtns+'</div>'+chart(trend.days,'users','linear-gradient(180deg,#6ee7b7,#34d399)',v=>v+'人')+'</div>'+leakPanel+creditPanel;
};
window.setRange=r=>{window._range=r;route()};
window.setCRange=r=>{window._crange=r;route()};

/* ---------- 2. 素材管理 ---------- */
let matView={series:null,hot:false,featured:false,q:''},sortMode=false,MAT_DATA=null,dragI=-1;
window.toggleSort=()=>{sortMode=!sortMode;dragI=-1;route()};
window.fDrag=(e,i)=>{dragI=i;e.dataTransfer.effectAllowed='move'};
window.fDrop=async(e,i)=>{e.preventDefault();if(dragI<0||dragI===i){dragI=-1;return}
  const arr=MAT_DATA.series;const[mv]=arr.splice(dragI,1);arr.splice(i,0,mv);dragI=-1;
  try{await api('/console/api/materials/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({series:arr.map(x=>x.folder)})});toast('顺序已保存 ✅')}catch(err){toast(err.message)}
  route()};
window.mDrag=(e,i)=>{dragI=i;e.dataTransfer.effectAllowed='move';e.stopPropagation()};
window.mDrop=async(e,i)=>{e.preventDefault();e.stopPropagation();if(dragI<0||dragI===i){dragI=-1;return}
  const sd=MAT_DATA.series.find(x=>x.folder===matView.series);const arr=sd.materials;const[mv]=arr.splice(dragI,1);arr.splice(i,0,mv);dragI=-1;
  try{await api('/console/api/materials/reorder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:matView.series,materials:arr.map(m=>m.title)})});toast('顺序已保存 ✅')}catch(err){toast(err.message)}
  route()};
const sortBtn=()=>'<button class="btn '+(sortMode?'btn-p':'btn-g')+'" onclick="toggleSort()">'+(sortMode?'✅ 完成排序':'⇅ 调整顺序')+'</button>';
window.matGlobalSearch=()=>{matView.q=document.getElementById('mat-global-q').value.trim();route()};
window.matGlobalClear=()=>{matView.q='';route()};
H.materials=async()=>{
  const s=await api('/console/api/materials');MAT_DATA=s;
  const activeOf = sd => (sd.materials || []).filter(m => !m.removed);
  if(matView.hot){
    const hot=await api('/console/api/materials?hot=1');CUR_IMGS=hot.list.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><button class="btn btn-g" onclick="matView.hot=false;route()">← 返回</button><h2>🎨 热门排行</h2><div class="sp"></div></div>\
    <div class="panel" style="font-size:13px;color:#8b84a3;margin-bottom:16px">🏆 热门素材 TOP（按下载量）· 全库共 '+s.total+' 个素材，总下载 '+s.totalDownloads+' 次</div>\
    <div class="grid">'+hot.list.map((m,i)=>'<div class="mat"><img src="'+matImg(m)+'" onerror="this.style.opacity=.2" onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"><div class="t">'+esc(m.title)+'</div><div class="dl">⬇ '+m.downloads+' 次 · '+fmtSize(m.size)+' · '+esc(m.series.split('-')[1]||m.series)+'</div></div>').join('')+'</div>';
  }
  if(matView.featured){
    const starredSeries=s.series.filter(x=>x.featured);
    const starredMats=[];s.series.forEach(x=>(x.materials||[]).forEach(m=>{if(m.featured&&!m.removed)starredMats.push(Object.assign({},m,{folder:x.folder}))}));
    CUR_IMGS=starredMats.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><button class="btn btn-g" onclick="matView.featured=false;route()">← 返回</button><h2>⭐ 精选管理</h2><div class="sp"></div></div>\
    <div class="panel" style="font-size:13px;color:#8b84a3;margin-bottom:16px">这里列出所有打过星的素材和文件夹：首页「精选素材」展示打星素材（最多 18 个），「精选合集」大卡展示打星文件夹（最多 4 个）；点「⭐ 取消精选」即移出首页。一个星都没有时，首页维持默认推荐不变。</div>\
    <h3 style="font-size:15px;margin:14px 0 10px">📁 精选文件夹（'+starredSeries.length+'）</h3>\
    '+(starredSeries.length?'<div class="grid">'+starredSeries.map(x=>'<div class="folder"><button class="btn btn-g f-edit" style="display:inline-block;color:#b45309;background:#fef3c7" onclick="toggleFeature(\\'series\\',\\''+x.folder+'\\',null,false)">⭐</button><div class="ic">📁</div><div class="n">'+esc(x.folder)+'</div><div class="c">'+x.materials.filter(m=>!m.removed).length+' 个素材</div></div>').join('')+'</div>':'<div class="sub" style="margin-bottom:6px">暂无打星文件夹：回到素材管理，悬停文件夹卡片点左上角 ☆ 即可添加</div>')+'\
    <h3 style="font-size:15px;margin:18px 0 10px">🎨 精选素材（'+starredMats.length+'）</h3>\
    '+(starredMats.length?'<div class="grid">'+starredMats.map((m,i)=>'<div class="mat"><img src="'+matImg(m)+'" onerror="this.style.opacity=.2" onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"><div class="t">'+esc(m.title)+'</div><div class="dl">'+esc(m.folder)+'</div><button class="btn btn-g btn-xs mat-del" style="display:inline-block;color:#b45309;background:#fef3c7" onclick="toggleFeature(\\'material\\',\\''+m.folder+'\\',\\''+m.title+'\\',false)">⭐ 取消精选</button></div>').join('')+'</div>':'<div class="sub">暂无打星素材：回到素材管理，悬停素材卡片点「☆ 精选」即可添加</div>');
  }
  if(matView.series){
    const sd=s.series.find(x=>x.folder===matView.series) || {materials:[]};
    const ms=activeOf(sd);CUR_IMGS=ms.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><button class="btn btn-g" onclick="matView.series=null;route()">← 返回</button><h2>🎨 '+esc(matView.series)+'</h2><div class="sp"></div>'+sortBtn()+'<button class="btn btn-p" onclick="addMatModal()">＋ 添加素材</button></div>\
    '+(sortMode?'<div class="sub" style="color:#7c5cbf;font-weight:600">⇅ 排序模式：拖动素材卡片换位，松手即保存，前台同步生效。点「✅ 完成排序」退出</div>':'')+'\
    <div class="grid">'+ms.map((m,i)=>'<div class="mat'+(sortMode?' sorting':'')+'"'+(sortMode?' draggable="true" ondragstart="mDrag(event,'+i+')" ondragover="event.preventDefault()" ondrop="mDrop(event,'+i+')"':'')+'><img src="'+matImg(m)+'" onerror="this.style.opacity=.2"'+(sortMode?'':' onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"')+'><div class="t">'+esc(m.title)+'</div><div class="dl">⬇ '+m.downloads+' · '+fmtSize(m.size)+'</div>'+(sortMode?'':'<button class="btn btn-g btn-xs mat-del" style="'+(m.featured?'display:inline-block;color:#b45309;background:#fef3c7':'')+'" onclick="toggleFeature(\\'material\\',\\''+m.series+'\\',\\''+m.title+'\\','+!m.featured+')">'+(m.featured?'⭐ 已精选':'☆ 精选')+'</button> <button class="btn btn-g btn-xs mat-del" onclick="renameMatModal(\\''+m.series+'\\',\\''+m.title+'\\')">✏️ 改名</button> <button class="btn btn-d btn-xs mat-del" onclick="delMat(\\''+m.series+'\\',\\''+m.title+'\\')">删除</button>')+'</div>').join('')+'</div>';
  }
  const removed=await api('/console/api/materials/removed').catch(()=>({list:[]}));
  const removedHtml=removed.list.length
    ? '<div class="panel" style="margin-top:18px"><h3 style="font-size:15px;margin-bottom:10px">🗑 下架记录（'+removed.list.length+'）</h3><div class="sub" style="margin-bottom:8px">下架只影响前台展示，历史下载的授权码仍可验真；同名重传或点「恢复上架」会保留原 ID。</div><table><tr><th>素材</th><th>系列</th><th>下架时间</th><th>操作</th></tr>'+removed.list.map(m=>'<tr><td><b>'+esc(m.title)+'</b></td><td>'+esc(m.series)+'</td><td>'+fmtT(m.removedAt)+'</td><td><button class="btn btn-g btn-xs" onclick="restoreMat(\\''+m.series+'\\',\\''+m.title+'\\')">↩️ 恢复上架</button> <button class="btn btn-d btn-xs" onclick="purgeMat(\\''+m.series+'\\',\\''+m.title+'\\')">彻底删除</button></td></tr>').join('')+'</table></div>'
    : '';
  const folders=s.series.filter(x=>x.materials.some(m=>!m.removed));
  const searchBar='<input id="mat-global-q" placeholder="搜索素材名称，回车确认" value="'+esc(matView.q||'')+'" onchange="matGlobalSearch()" onkeydown="if(event.key===\\'Enter\\')matGlobalSearch()" style="width:240px">'+(matView.q?'<button class="btn btn-g" onclick="matGlobalClear()">清空</button>':'');
  if(matView.q){
    const q=matView.q.toLowerCase(),matches=[];
    s.series.forEach(x=>activeOf(x).forEach(m=>{if(String(m.title||'').toLowerCase().includes(q))matches.push(Object.assign({},m,{folder:x.folder}))}));
    CUR_IMGS=matches.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><h2>🎨 素材管理</h2><div class="sp"></div>'+searchBar+sortBtn()+'<button class="btn btn-g" onclick="matView.featured=true;route()">⭐ 精选管理</button><button class="btn btn-g" onclick="matView.hot=true;route()">🏆 热门排行</button><button class="btn btn-p" onclick="addSeriesModal()">＋ 新建文件夹</button></div>\
    <div class="sub">“'+esc(matView.q)+'” 找到 '+matches.length+' 个匹配素材 · 显示全部系列结果</div>'
    +(matches.length?'<div class="grid">'+matches.map((m,i)=>'<div class="mat"><img src="'+matImg(m)+'" onerror="this.style.opacity=.2" onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"><div class="t">'+esc(m.title)+'</div><div class="dl">📁 '+esc(m.folder)+' · ⬇ '+m.downloads+' · '+fmtSize(m.size)+'</div><button class="btn btn-g btn-xs mat-del" style="'+(m.featured?'display:inline-block;color:#b45309;background:#fef3c7':'')+'" onclick="toggleFeature(\\'material\\',\\''+m.series+'\\',\\''+m.title+'\\','+!m.featured+')">'+(m.featured?'⭐ 已精选':'☆ 精选')+'</button> <button class="btn btn-g btn-xs mat-del" onclick="renameMatModal(\\''+m.series+'\\',\\''+m.title+'\\')">✏️ 改名</button> <button class="btn btn-d btn-xs mat-del" onclick="delMat(\\''+m.series+'\\',\\''+m.title+'\\')">删除</button></div>').join('')+'</div>':'<div class="panel" style="text-align:center;color:#8b84a3;padding:36px">没有找到匹配素材，请换个名称试试</div>');
  }
  return '<div class="toolbar"><h2>🎨 素材管理</h2><div class="sp"></div>'+searchBar+sortBtn()+'<button class="btn btn-g" onclick="matView.featured=true;route()">⭐ 精选管理</button><button class="btn btn-g" onclick="matView.hot=true;route()">🏆 热门排行</button><button class="btn btn-p" onclick="addSeriesModal()">＋ 新建文件夹</button></div>\
  <div class="sub">'+(sortMode?'⇅ 排序模式：拖动文件夹换位，松手即保存，前台网站同步生效。点「✅ 完成排序」退出':'共 '+s.total+' 个素材 · 点击文件夹查看和管理')+'</div>\
  <div class="grid">'+folders.map((x,i)=>'<div class="folder'+(sortMode?' sorting':'')+'" '+(sortMode?'draggable="true" ondragstart="fDrag(event,'+i+')" ondragover="event.preventDefault()" ondrop="fDrop(event,'+i+')"':'onclick="matView.series=\\''+x.folder+'\\';route()"')+'>'+(sortMode?'':'<button class="btn btn-g f-edit" style="right:56px;'+(x.featured?'display:inline-block;color:#b45309;background:#fef3c7':'')+'" onclick="event.stopPropagation();toggleFeature(\\'series\\',\\''+x.folder+'\\',null,'+!x.featured+')">'+(x.featured?'⭐':'☆')+'</button><button class="btn btn-g f-edit" onclick="event.stopPropagation();renameSeriesModal(\\''+x.folder+'\\')">✏️</button>')+'<div class="ic">📁</div><div class="n">'+esc(x.folder)+'</div><div class="c">'+x.materials.filter(m=>!m.removed).length+' 个素材</div></div>').join('')+'</div>'+removedHtml;
};
window.delMat=async(series,title)=>{if(!confirm('确定下架「'+title+'」吗？\\n下架只隐藏前台展示，历史下载的授权码仍可验真。'))return;await api('/console/api/materials/'+encodeURIComponent(series)+'/'+encodeURIComponent(title),{method:'DELETE'});toast('已下架，授权码仍可验真');route()};
window.toggleFeature=async(kind,folder,title,on)=>{try{await api('/console/api/materials/feature',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,folder,title,on})});toast(on?'⭐ 已加入首页精选':'已取消首页精选');route()}catch(e){toast(e.message)}};
window.restoreMat=async(series,title)=>{try{await api('/console/api/materials/'+encodeURIComponent(series)+'/'+encodeURIComponent(title)+'/restore',{method:'POST'});toast('已恢复上架 ✅');route()}catch(e){toast(e.message)}};
window.purgeMat=async(series,title)=>{if(!confirm('彻底删除「'+title+'」的清单条目？\\n下载流水和授权码快照会保留，旧码仍能验真。'))return;try{await api('/console/api/materials/'+encodeURIComponent(series)+'/'+encodeURIComponent(title)+'/permanent',{method:'DELETE'});toast('已彻底删除');route()}catch(e){toast(e.message)}};
window.renameSeriesModal=f=>showModal('<h3>✏️ 重命名文件夹</h3>\
  <div class="row"><label>新名称</label><input id="m-rn" value="'+esc(f)+'"></div>\
  <div class="sub">会同步修改服务器文件目录和 OSS 预览图目录，前台立即生效</div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="doRenameSeries(\\''+f+'\\')">保存</button></div>');
window.doRenameSeries=async(old)=>{const n=document.getElementById('m-rn').value.trim();if(!n)return toast('请填写名称');try{await api('/console/api/series/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({old,new:n})});closeModal();toast('已改名 ✅');route()}catch(e){toast(e.message)}};
window.renameMatModal=(s2,t)=>showModal('<h3>✏️ 重命名素材</h3>\
  <div class="row"><label>新名称</label><input id="m-rn" value="'+esc(t)+'"></div>\
  <div class="sub">会同步修改服务器上的图片文件名和 OSS 预览图名，前台立即生效</div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="doRenameMat(\\''+s2+'\\',\\''+t+'\\')">保存</button></div>');
window.doRenameMat=async(s2,old)=>{const n=document.getElementById('m-rn').value.trim();if(!n)return toast('请填写名称');try{await api('/console/api/materials/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({series:s2,oldTitle:old,newTitle:n})});closeModal();toast('已改名 ✅');route()}catch(e){toast(e.message)}};
window.addMatModal=()=>showModal('<h3>添加素材（'+esc(matView.series)+'）</h3>\
  <div class="row"><label>素材名称（留空则使用图片文件名）</label><input id="m-title" placeholder="例如：线粒体-粉色版"></div>\
  <div class="row"><label>素材图片（可多选，PNG 透明底最佳）</label><input id="m-img" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" style="padding:6px"><div class="sub" style="margin-top:4px">单张优先使用填写的名称，未填写时用图片文件名；多张逐张使用文件名。同名或失败不影响其他图片</div></div>\
  <div id="m-progress" style="max-height:220px;overflow:auto;font-size:12px;line-height:1.8"></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-g" id="m-batch-btn" onclick="batchSaveMat()">批量上传</button><button class="btn btn-p" id="m-save-btn" onclick="saveMat()">保存</button></div>');
window.saveMat=async()=>{
  const file=document.getElementById('m-img').files[0];
  const title=document.getElementById('m-title').value.trim()||(file?file.name.replace(/\.[^.]+$/,''):'');
  try{
    if(file){
      const fd=new FormData();
      fd.append('series',matView.series);fd.append('title',title);fd.append('image',file);
      await api('/console/api/materials/upload',{method:'POST',body:fd});
    }else{
      await api('/console/api/materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({series:matView.series,title})});
    }
    closeModal();toast('已添加 ✅');route();
  }catch(e){toast(e.message)}
};
window.batchSaveMat=async()=>{
  const files=Array.from(document.getElementById('m-img').files||[]);
  if(!files.length)return toast('请先选择要批量上传的图片');
  const customTitle=document.getElementById('m-title').value.trim();
  const progress=document.getElementById('m-progress');
  const batchBtn=document.getElementById('m-batch-btn'),saveBtn=document.getElementById('m-save-btn');
  batchBtn.disabled=true;saveBtn.disabled=true;
  const results=[];
  for(let i=0;i<files.length;i++){
    const file=files[i],title=(files.length===1&&customTitle)||file.name.replace(/\.[^.]+$/,'');
    progress.textContent='正在上传 '+(i+1)+'/'+files.length+'：'+title;
    try{
      const fd=new FormData();
      fd.append('series',matView.series);fd.append('title',title);fd.append('image',file);
      await api('/console/api/materials/upload',{method:'POST',body:fd});
      results.push({title,ok:true});
    }catch(e){results.push({title,ok:false,error:e.message})}
  }
  const okCount=results.filter(x=>x.ok).length;
  progress.innerHTML='<div style="margin:6px 0;font-weight:600">批量完成：成功 '+okCount+' 张，失败 '+(results.length-okCount)+' 张</div>'+results.map(x=>'<div style="color:'+(x.ok?'#25824c':'#c05555')+'">'+(x.ok?'✅ ':'❌ ')+esc(x.title)+(x.ok?' 已发布':' '+esc(x.error||'上传失败'))+'</div>').join('');
  batchBtn.disabled=false;saveBtn.disabled=false;
  toast('批量上传完成：成功 '+okCount+' 张，失败 '+(results.length-okCount)+' 张');route();
};
window.addSeriesModal=()=>showModal('<h3>新建文件夹</h3>\
  <div class="row"><label>文件夹名称 *（建议带编号，如 25-组织与器官系列）</label><input id="m-folder" placeholder="25-组织与器官系列"></div>\
  <div class="sub">提示：文件夹用于归类素材，之后可在文件夹里添加素材</div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="saveSeries()">创建</button></div>');
window.saveSeries=async()=>{const f=document.getElementById('m-folder').value.trim();if(!f)return toast('请填写文件夹名称');try{await api('/console/api/materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({series:f})});closeModal();toast('文件夹已创建 ✅');matView.series=f;route()}catch(e){toast(e.message)}};

/* ---------- 3. 账号管理 ---------- */
let userQ='';
H.users=async()=>{
  const s=await api('/console/api/users?q='+encodeURIComponent(userQ));
  const lvName={none:'—',basic:'青果会员',pro:'红果会员',team:'金果会员'};
  const rows=s.list.map(u=>'<tr><td onclick="cpTxt(this.textContent)" style="cursor:pointer" title="点击复制"><b>'+esc(u.name)+'</b></td><td onclick="cpTxt(this.textContent)" style="cursor:pointer" title="点击复制">'+esc(u.email||u.contact||'—')+'</td>\
    <td><select onchange="setLevel(\\''+u.id+'\\',this.value)">'+Object.keys(lvName).map(k=>'<option value="'+k+'" '+(u.level===k?'selected':'')+'>'+lvName[k]+'</option>').join('')+'</select></td>\
    <td>'+(u.credits||0)+' ⚡</td>\
    <td>'+(u.memberSince?esc(u.memberSince.slice(0,10)):'—')+'</td><td>'+u.orderCount+' 笔</td><td><b>'+yuan(u.totalPaid)+'</b></td>\
    <td><button class="btn btn-g btn-xs" onclick="userDetail(\\''+u.id+'\\')">详情</button></td></tr>').join('')
    ||'<tr><td colspan="8" style="color:#b0aac4;text-align:center;padding:24px">暂无用户</td></tr>';
  return '<div class="toolbar"><h2>👥 账号管理</h2><div class="sp"></div><input placeholder="搜索昵称/邮箱" value="'+esc(userQ)+'" onchange="userQ=this.value;route()" style="width:200px"><button class="btn btn-g" onclick="merchantLookupModal()">🧾 商户单号查询</button><button class="btn btn-g" onclick="licenseLookupModal()">🔑 授权码查询</button><button class="btn btn-g" onclick="creditLogModal()">⚡ 积分流水</button></div>\
  <div class="panel"><table><tr><th>昵称</th><th>邮箱</th><th>会员等级</th><th>AI积分</th><th>开通时间</th><th>订单</th><th>累计付款</th><th></th></tr>'+rows+'</table></div>';
};
window.merchantLookupModal=()=>{
  showModal('<h3>🧾 商户单号查询</h3><div class="sub" style="margin-bottom:12px">粘贴用户账号页复制的商户订单号，可查订单、用户和关联授权码。</div><div style="display:flex;gap:8px"><input id="merchant-no" placeholder="请输入完整商户订单号" style="flex:1;font-family:monospace" onkeydown="if(event.key===\\'Enter\\')doMerchantLookup()"><button class="btn btn-p" onclick="doMerchantLookup()">查询</button></div><div id="merchant-result" style="margin-top:16px"></div><div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>');
  const m=document.getElementById('modal');m.style.width='760px';m.style.maxWidth='94vw';m.style.height='auto';m.style.maxHeight='86vh';m.style.overflowY='auto';
  setTimeout(()=>document.getElementById('merchant-no').focus(),0);
};
window.doMerchantLookup=async()=>{
  const input=document.getElementById('merchant-no'),out=document.getElementById('merchant-result'),merchantNo=input.value.trim();
  if(!merchantNo)return toast('请输入商户订单号');
  out.innerHTML='<div class="sub">正在查询…</div>';
  try{
    const d=await api('/console/api/order-lookup?merchantNo='+encodeURIComponent(merchantNo)),o=d.order,u=d.user;
    const status={pending:'待支付',notified:'待确认',paid:'已支付',refunded:'已退款',expired:'已失效',failed:'支付失败'}[o.status]||o.status;
    const lvName={basic:'青果会员',pro:'红果会员',team:'金果会员'};
    const type=o.kind==='export'?'画板导出':o.kind==='single'?'单张素材':(lvName[o.plan]||'会员订单');
    const refunded=o.status==='refunded';
    const row=(k,v)=>'<tr><td style="width:130px;color:#8b84a3">'+k+'</td><td>'+v+'</td></tr>';
    const licenses=(d.licenses||[]).map(l=>'<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f1eef9"><span><b>'+esc(l.title)+'</b><br><span style="font-family:monospace;font-size:12px">'+esc(l.code)+'</span></span><b style="color:'+(l.status==='退款回收'?'#d6336c':'#2f9e5f')+'">'+esc(l.status)+'</b></div>').join('');
    out.innerHTML='<div style="border:1px solid '+(refunded?'#f0b4c8':'#d9d2ec')+';border-radius:12px;padding:14px"><div style="font-size:16px;font-weight:700;color:'+(refunded?'#d6336c':'#6d4fb0')+';margin-bottom:10px">'+esc(type)+' · '+esc(status)+'</div><table>'
      +row('商户订单号','<span style="font-family:monospace;word-break:break-all">'+esc(o.merchantNo)+'</span> <button class="btn btn-g btn-xs" onclick="cpTxt(\\''+o.merchantNo+'\\')">复制</button>')
      +row('微信/支付宝交易号',o.transactionId?'<span style="font-family:monospace;word-break:break-all">'+esc(o.transactionId)+'</span>':'未记录')
      +row('金额',yuan(o.amount))+row('支付方式',esc(o.payChannel||o.channel||'—'))+row('支付/下单时间',fmtT(o.paidAt||o.createdAt))
      +(refunded?row('退款时间',fmtT(o.refundedAt)):'')
      +row('用户',u?'<b>'+esc(u.name||'—')+'</b> · '+esc(u.email||u.id):'账号已注销')
      +'</table>'+(licenses?'<h4 style="margin-top:14px">关联授权码</h4>'+licenses:'')
      +(u?'<div class="btns"><button class="btn btn-g" onclick="userDetail(\\''+u.id+'\\')">查看用户详情</button></div>':'')+'</div>';
  }catch(e){out.innerHTML='<div style="color:#d6336c;padding:12px">'+esc(e.message)+'</div>'}
};
window.licenseLookupModal=()=>{
  showModal('<h3>🔑 授权码查询</h3><div class="sub" style="margin-bottom:12px">支持素材下载码和画板导出码；退款回收的记录也会保留在这里。</div><div style="display:flex;gap:8px"><input id="license-code" placeholder="例如 OF-2026-ABC123" style="flex:1;font-family:monospace" onkeydown="if(event.key===\\'Enter\\')doLicenseLookup()"><button class="btn btn-p" onclick="doLicenseLookup()">查询</button></div><div id="license-result" style="margin-top:16px"></div><div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>');
  const m=document.getElementById('modal');m.style.height='auto';m.style.maxHeight='86vh';m.style.overflowY='auto';
  setTimeout(()=>document.getElementById('license-code').focus(),0);
};
window.doLicenseLookup=async()=>{
  const input=document.getElementById('license-code'),out=document.getElementById('license-result'),code=input.value.trim();
  if(!code)return toast('请输入授权码');
  out.innerHTML='<div class="sub">正在查询…</div>';
  try{
    const d=await api('/console/api/license-lookup?code='+encodeURIComponent(code)),r=d.record,u=d.user,o=d.order,revoked=r.status==='退款回收';
    const row=(k,v)=>'<tr><td style="width:110px;color:#8b84a3">'+k+'</td><td>'+v+'</td></tr>';
    out.innerHTML='<div style="border:1px solid '+(revoked?'#f0b4c8':'#bde5cd')+';background:'+(revoked?'#fff5f8':'#f3fbf6')+';border-radius:12px;padding:14px"><div style="font-size:16px;font-weight:700;color:'+(revoked?'#d6336c':'#2f9e5f')+';margin-bottom:10px">'+(revoked?'⛔ 退款回收':'✅ 授权有效')+'</div><table>'
      +row('授权码','<b style="font-family:monospace">'+esc(r.code)+'</b> <button class="btn btn-g btn-xs" onclick="cpTxt(\\''+esc(r.code)+'\\')">复制</button>')
      +row('类型',r.kind==='export'?'画板导出':'素材下载')+row('名称',esc(r.title))+row('系列',esc(r.series||'—'))+row('授权时间',fmtT(r.time))
      +(revoked?row('回收时间',fmtT(r.revokedAt)):'')
      +row('用户',u?'<b>'+esc(u.name||'—')+'</b> · '+esc(u.email||u.id):'账号已注销')
      +(o?row('关联订单','<span style="font-family:monospace">'+esc(o.outTradeNo||o.id)+'</span> · '+esc(o.status==='refunded'?'已退款':o.status)):'')
      +'</table>'+(u?'<div class="btns"><button class="btn btn-g" onclick="userDetail(\\''+u.id+'\\')">查看用户详情</button></div>':'')+'</div>';
  }catch(e){out.innerHTML='<div style="color:#d6336c;padding:12px">'+esc(e.message)+'</div>'}
};
window.creditLogModal=async()=>{const d=await api('/console/api/credit-log').catch(()=>({list:[]}));const rows=d.list.map(l=>'<tr><td>'+fmtT(l.time)+'</td><td><b>'+esc(l.name||'')+'</b></td><td style="color:'+(l.delta>0?'#2f9e5f':'#d6336c')+';font-weight:600">'+(l.delta>0?'+':'')+l.delta+'</td><td>'+esc(l.reason||'')+'</td><td>'+esc(l.by||'')+'</td></tr>').join('')||'<tr><td colspan="5" style="text-align:center;color:#b0aac4;padding:20px">暂无流水</td></tr>';
  showModal('<h3>⚡ 积分流水（最近 200 条）</h3><div style="max-height:320px;overflow:auto"><table><tr><th>时间</th><th>用户</th><th>变动</th><th>原因</th><th>操作者</th></tr>'+rows+'</table></div><div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>')};
window.setLevel=async(id,level)=>{await api('/console/api/users/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({level})});toast('已修改 ✅')};
window.adjCredits=async(id)=>{const delta=parseInt(document.getElementById('m-delta').value,10);if(!delta)return toast('填写调整数量');try{await api('/console/api/users/'+id+'/credits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delta,reason:document.getElementById('m-reason').value.trim()})});toast('已调整 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.resetQuota=async(id)=>{if(!confirm('把该账号本月下载额度重置为未使用？（测试用）'))return;try{await api('/console/api/users/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetQuota:true})});toast('本月额度已重置 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.resetExport=async(id)=>{if(!confirm('重置该账号本月导出额度并清零单次导出权益？（测试用）'))return;try{await api('/console/api/users/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetExport:true})});toast('导出额度已重置 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.clearPurchases=async(id)=>{if(!confirm('清空该账号的全部单张购买记录？不影响会员等级与订单流水（测试用）'))return;try{const r=await api('/console/api/users/'+id+'/purchases',{method:'DELETE'});toast('已清空 '+r.removed+' 条 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.dtShow=n=>{[1,2,3,4,5,6].forEach(i=>{document.getElementById('dt-p'+i).style.display=i===n?'block':'none';document.getElementById('dt-b'+i).className='btn btn-xs '+(i===n?'btn-p':'btn-g')})};
window.userDetail=async(id)=>{
  const d=await api('/console/api/users/'+id);
  const lvName={none:'非会员',basic:'青果会员',pro:'红果会员',team:'金果会员'};
  const coRows=(d.creditLog&&d.creditLog.length)
    ?d.creditLog.map(l=>'<tr><td>'+fmtT(l.time)+'</td><td style="color:'+(l.delta>0?'#2f9e5f':'#d6336c')+';font-weight:600">'+(l.delta>0?'+':'')+l.delta+'</td><td>'+esc(l.reason||'—')+'</td><td>'+esc(l.by||'')+'</td></tr>').join('')
    :'<tr><td colspan="4" style="text-align:center;color:#b0aac4;padding:14px">暂无积分记录</td></tr>';
  const lvRows=(d.levelLog&&d.levelLog.length)
    ?d.levelLog.map(l=>'<tr><td>'+fmtT(l.time)+'</td><td>'+(lvName[l.from]||l.from)+' → <b style="color:#6d4fb0">'+(lvName[l.to]||l.to)+'</b></td><td>'+esc(l.by||'')+'</td></tr>').join('')
    :'<tr><td colspan="3" style="text-align:center;color:#b0aac4;padding:14px">暂无变更记录（此功能上线前的修改不追溯）</td></tr>';
  // 画板与分享：分享记录 = 打开过该画板分享链接的登录用户（游客不统计）
  const shareName={view:'👀 只读',edit:'✏️ 可编辑',edit_dl:'✏️ 可编辑+可导出'};
  const bdRows=(d.boards&&d.boards.length)
    ?d.boards.map(b=>{
      const who=b.visitors&&b.visitors.length
        ?b.visitors.map(v=>'<span class="chip" title="最近打开：'+fmtT(v.at)+'">'+esc(v.name)+' · '+fmtT(v.at).slice(5)+'</span>').join(' ')+(b.visitorCount>20?' <span class="chip">…共 '+b.visitorCount+' 人</span>':'')
        :'<span style="color:#b0aac4">—</span>';
      return '<tr><td><b>'+esc(b.name)+'</b>'+(b.folder?' <span style="color:#b0aac4;font-size:12px">'+esc(b.folder)+'</span>':'')+'</td><td>'+fmtT(b.savedAt)+'</td><td>'+(b.shareMode?shareName[b.shareMode]||b.shareMode:'<span style="color:#b0aac4">未分享</span>')+'</td><td style="max-width:220px">'+who+'</td></tr>'}).join('')
    :'<tr><td colspan="4" style="text-align:center;color:#b0aac4;padding:14px">还没有画板</td></tr>';
  // 下载历史：预览图可点击放大，授权码点击复制
  window.DL_IMGS=[];
  const dlRows=(d.downloads&&d.downloads.length)
    ?d.downloads.map(m=>{
      const src=(m.kind==='export'
        ? (m.exportId?'/console/api/export-records/img?id='+encodeURIComponent(m.exportId)+'&t='+getTK():(m.thumb||''))
        : (m.local?'/files/'+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.file):OSS_P+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.title)+'.webp'))||'/brand/icon.png';
      const sub=m.kind==='export'?'画板导出':m.folder;
      DL_IMGS.push({src:src,t:m.title});
      const i=DL_IMGS.length-1;
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid #f1eef9"><img src="'+src+'" onerror="this.style.opacity=.2" onclick="viewMatList(DL_IMGS,'+i+')" style="width:56px;height:56px;object-fit:contain;background:#f4f2fa;border-radius:8px;cursor:zoom-in;flex:none"><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(m.title)+'">'+esc(m.title)+'</div><div class="sub" style="font-size:12px">'+esc(sub)+' · '+fmtT(m.time)+(m.licenseStatus==='退款回收'?' · <b style="color:#d6336c">退款回收</b>':'')+'</div></div>'+(m.code?'<button class="btn btn-g btn-xs" title="点击复制授权码" onclick="cpTxt(\\''+m.code+'\\')">🔑 '+esc(m.code)+'</button>':'<span style="color:#b0aac4;font-size:12px">无授权码</span>')+'</div>'}).join('')
    :'<div style="text-align:center;color:#b0aac4;padding:20px">还没有下载记录</div>';
  const coListRows=(d.creditOrders&&d.creditOrders.length)
    ?d.creditOrders.map(o=>{
      const stTxt={pending:'待支付',notified:'待人工确认',paid:'已到账'}[o.status]||o.status;
      const stClr={pending:'#b8860b',notified:'#d6336c',paid:'#2f9e5f'}[o.status]||'#8b84a3';
      return '<tr><td>'+fmtT(o.createdAt)+'</td><td><b>'+(o.credits||0)+'</b> 积分</td><td>'+yuan(o.amount)+'</td><td style="color:'+stClr+';font-weight:600">'+stTxt+(o.channel?' · '+esc(o.channel):'')+'</td><td style="font-size:11px;color:#8b84a3">'+(o.transactionId?esc(String(o.transactionId)):'—')+'</td></tr>'}).join('')
    :'<tr><td colspan="5" style="text-align:center;color:#b0aac4;padding:14px">暂无积分订单</td></tr>';
  const allOrderRows=(d.orders&&d.orders.length)
    ?d.orders.map(o=>{
      const type=o.kind==='export'?'画板导出':o.kind==='single'?'单张素材':(lvName[o.plan]||'会员订单');
      const status={pending:'待支付',notified:'待确认',paid:'已支付',refunded:'已退款',expired:'已失效',failed:'支付失败'}[o.status]||o.status;
      const color=o.status==='paid'?'#2f9e5f':o.status==='pending'?'#b8860b':'#8b84a3';
      const rawChannel=String(o.payChannel||o.channel||'');
      const channel=/wechat|微信/i.test(rawChannel)?'微信支付':/alipay|支付宝/i.test(rawChannel)?'支付宝':(rawChannel||'未知');
      const merchantNo=String(o.outTradeNo||String(o.id||'').replace(/-/g,''));
      const providerNo=String(o.transactionId||'');
      const merchantCell='<div style="font-family:monospace;font-size:11px;word-break:break-all">'+esc(merchantNo)+'</div><button class="btn btn-g btn-xs" onclick="cpTxt(\\''+merchantNo+'\\')">复制商户单号</button>';
      const providerCell=providerNo?'<div style="font-family:monospace;font-size:11px;word-break:break-all">'+esc(providerNo)+'</div><button class="btn btn-g btn-xs" onclick="cpTxt(\\''+providerNo+'\\')">复制交易号</button>':'<span style="color:#b0aac4">未记录</span>';
      const exportCode=String(o.exportCode||(o.refundedLicenseCodes&&o.refundedLicenseCodes[0])||'');
      const exportCell=o.kind==='export'?'<div class="sub" style="margin-top:4px">导出码：'+(exportCode?'<span style="font-family:monospace">'+esc(exportCode)+'</span> <button class="btn btn-g btn-xs" title="复制导出授权码" onclick="cpTxt(\\''+exportCode+'\\')">复制</button>':'<span style="color:#b0aac4">未生成/未绑定</span>')+'</div>':'';
      const action=o.status==='paid'?'<button class="btn btn-d btn-xs" onclick="refundOrder(\\''+o.id+'\\')">退款回收</button>':o.status==='refunded'?'<button class="btn btn-g btn-xs" onclick="undoRefundOrder(\\''+o.id+'\\')">撤销退款</button>':'<span style="color:#b0aac4">—</span>';
      return '<tr><td>'+esc(type)+(o.materialTitle?'<div class="sub">'+esc(o.materialTitle)+'</div>':'')+exportCell+'</td><td>'+merchantCell+'</td><td>'+providerCell+'</td><td style="color:'+color+';font-weight:600">'+esc(status)+'</td><td>'+esc(channel)+'</td><td>'+yuan(o.amount)+'</td><td>'+fmtT(o.paidAt||o.createdAt)+'</td><td>'+action+'</td></tr>'}).join('')
    :'<tr><td colspan="8" style="text-align:center;color:#b0aac4;padding:14px">暂无订单</td></tr>';
  showModal('<h3>👤 '+esc(d.user.name)+'</h3>\
  <div class="sub" style="margin-bottom:14px">注册：'+esc((d.user.joinedAt||'').slice(0,10))+' · 会员：'+lvName[d.user.level]+(d.user.memberSince?'（'+d.user.memberSince.slice(0,10)+' 开通）':'')+' · AI 积分 <b style="color:#6d4fb0">'+(d.user.credits||0)+' ⚡</b> · 本月已下 '+(d.user.dlUsed||0)+' 张 · 本月已导出 '+(d.user.exUsed||0)+' 次（单次权益剩 '+(d.user.exportCredits||0)+'） · 累计付款 <b style="color:#6d4fb0">'+yuan(d.totalPaid)+'</b></div>\
  <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center"><input id="m-delta" type="number" placeholder="积分调整，如 5 或 -3" style="flex:1"><input id="m-reason" placeholder="原因（选填）" style="flex:2"><button class="btn btn-g btn-xs" onclick="adjCredits(\\''+d.user.id+'\\')">调整</button></div>\
  <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><button class="btn btn-g btn-xs" onclick="resetQuota(\\''+d.user.id+'\\')">🧪 重置本月下载额度</button><button class="btn btn-g btn-xs" onclick="resetExport(\\''+d.user.id+'\\')">🧪 重置导出额度</button><button class="btn btn-g btn-xs" onclick="clearPurchases(\\''+d.user.id+'\\')">🧪 清空单张购买记录</button></div>\
  <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><button class="btn btn-xs btn-p" id="dt-b1" onclick="dtShow(1)">⚡ 积分变动记录</button><button class="btn btn-xs btn-g" id="dt-b2" onclick="dtShow(2)">📜 会员变更记录</button><button class="btn btn-xs btn-g" id="dt-b3" onclick="dtShow(3)">🎨 画板与分享</button><button class="btn btn-xs btn-g" id="dt-b4" onclick="dtShow(4)">⬇️ 下载历史</button><button class="btn btn-xs btn-g" id="dt-b5" onclick="dtShow(5)">🧾 积分订单</button><button class="btn btn-xs btn-g" id="dt-b6" onclick="dtShow(6)">🧾 全部订单</button></div>\
  <div id="dt-p1" style="overflow:visible"><table><tr><th>时间</th><th>变动</th><th>原因</th><th>操作者</th></tr>'+coRows+'</table></div>\
  <div id="dt-p2" style="display:none;overflow:visible"><table><tr><th>时间</th><th>变更</th><th>操作者</th></tr>'+lvRows+'</table></div>\
  <div id="dt-p3" style="display:none;overflow:visible"><table><tr><th>画板</th><th>最近编辑</th><th>分享状态</th><th>打开过的人</th></tr>'+bdRows+'</table></div>\
  <div id="dt-p4" style="display:none;overflow:visible">'+dlRows+'</div>\
  <div id="dt-p5" style="display:none;overflow:visible"><table><tr><th>下单时间</th><th>积分</th><th>金额</th><th>状态 / 渠道</th><th>流水号</th></tr>'+coListRows+'</table></div>\
  <div id="dt-p6" style="display:none;overflow:visible"><table><tr><th>类型</th><th>商户订单号</th><th>微信/支付宝交易号</th><th>状态</th><th>支付方式</th><th>金额</th><th>支付 / 下单时间</th><th>操作</th></tr>'+allOrderRows+'</table></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>');
  document.getElementById('modal').style.width='1200px';
  document.getElementById('modal').style.maxWidth='96vw';
  document.getElementById('modal').style.height='92vh';
  document.getElementById('modal').style.overflowY='auto';
};
window.refundOrder=async(id)=>{
  try{
    const d=await api('/console/api/orders/'+encodeURIComponent(id)+'/refund-preview'),o=d.order;
    const type=o.kind==='export'?'画板导出':o.kind==='single'?'单张素材':'会员订单';
    const lines=(d.impact.lines||[]).map(x=>'<li style="margin:7px 0">'+esc(x)+'</li>').join('');
    showModal('<h3>退款回收确认</h3><div style="background:#fff7e8;border:1px solid #f1d39a;border-radius:12px;padding:14px;line-height:1.7"><b>请先在微信/支付宝商户平台完成资金退款。</b><br>'+esc(d.notice)+'</div><div style="margin:16px 0"><b>'+esc(type)+' · '+yuan(o.amount)+'</b><div class="sub" style="margin-top:6px">商户订单号：<span style="font-family:monospace">'+esc(o.outTradeNo||o.id)+'</span></div></div><h4>将执行以下操作：</h4><ul style="padding-left:22px;line-height:1.6">'+lines+'</ul><div class="sub">历史订单、下载记录和授权记录不会删除；授权码退款回收后，公开验真将不能通过。</div><div class="btns"><button class="btn btn-g" onclick="userDetail(\\''+o.userId+'\\')">取消</button><button class="btn btn-d" id="refund-confirm" onclick="doRefund(\\''+o.id+'\\')">已在商户平台退款，确认回收</button></div>');
    const m=document.getElementById('modal');m.style.width='680px';m.style.maxWidth='94vw';m.style.height='auto';m.style.maxHeight='86vh';m.style.overflowY='auto';
  }catch(e){toast(e.message)}
};
window.doRefund=async(id)=>{
  const btn=document.getElementById('refund-confirm');if(btn){btn.disabled=true;btn.textContent='正在回收…'}
  try{
    const d=await api('/console/api/orders/'+encodeURIComponent(id)+'/refund',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});
    MODAL_BACK=null;document.getElementById('mask').style.display='none';toast('已标记退款并回收对应权益 ✅');await userDetail(d.order.userId);
  }catch(e){if(btn){btn.disabled=false;btn.textContent='已在商户平台退款，确认回收'}toast(e.message)}
};
window.undoRefundOrder=async(id)=>{
  if(!confirm('确定撤销这笔退款回收吗？\\n只恢复 OneFig 权益和授权码，不会撤销商户平台的资金退款。'))return;
  try{
    const d=await api('/console/api/orders/'+encodeURIComponent(id)+'/undo-refund',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});
    MODAL_BACK=null;document.getElementById('mask').style.display='none';toast('已撤销回收并恢复对应权益 ✅');await userDetail(d.order.userId);
  }catch(e){toast(e.message)}
};

/* ---------- 4. 素材请求与问题反馈 ---------- */
let reqQ='',reqFilter='all',reqType='all';
const subHandled=r=>r.type==='feedback'?['read','done'].includes(r.status):r.status==='done';
H.requests=async()=>{
  const s=await api('/console/api/submissions');
  SUBS=s.list;REQ_IMGS=[];
  const q=reqQ.trim().toLowerCase();
  const flt=s.list.map((r,ci)=>({r,ci})).filter(({r})=>{
    const type=r.type||'request';
    if(reqType==='request'&&!['request','custom'].includes(type))return false;
    if(reqType==='feedback'&&type!=='feedback')return false;
    if(reqFilter==='new'&&subHandled(r))return false;
    if(reqFilter==='done'&&!subHandled(r))return false;
    if(q&&((r.desc||'')+(r.contact||'')+(r.series||'')).toLowerCase().indexOf(q)<0)return false;
    return true});
  const cards=flt.map(({r,ci})=>{const d=new Date(r.createdAt);const when=(d.getMonth()+1)+'月'+d.getDate()+'日 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    const isFeedback=r.type==='feedback',handled=subHandled(r);
    const statusTag=isFeedback?(handled?'✅ 已读':'🆕 未读'):(handled?'✅ 已上新':'🆕 新需求');
    const actionText=isFeedback?(handled?'↩️ 标为未读':'✓ 标为已读'):(handled?'↩️ 标为未完成':'✨ 标为已上新');
    const imgs=(r.images&&r.images.length?r.images:(r.image?[r.image]:[]));
    const rimgs=imgs.map(im=>'/uploads/'+encodeURIComponent(im)+'?t='+getTK());REQ_IMGS[ci]=rimgs;
    return '<div class="card '+(handled?'done':'')+'"><div class="thumb">'+(rimgs.length?rimgs.map((u,j)=>'<img src="'+u+'" onclick="viewMatList(REQ_IMGS['+ci+'],'+j+')" style="cursor:zoom-in">').join(''):'<div class="noimg">🎨<br>无参考图</div>')+'</div>\
    <div class="cbody"><div class="tags">'+(r.type==='custom'?'<span class="tag" style="background:#fdf0f6;color:#c2418e">🖌️ 定制单</span>':'')+(r.type==='feedback'?'<span class="tag" style="background:#e0f2fe;color:#0369a1">📝 问题反馈</span>':'')+'<span class="tag '+(handled?'done2':'new')+'">'+statusTag+'</span>'+(r.series?'<span class="tag">'+esc(r.series)+'</span>':'')+'<span class="time">'+when+'</span></div>\
    <div class="desc">'+esc(r.desc).replace(/\\n/g,'<br>')+'</div>'+(r.contact?'<div class="contact">📮 '+esc(r.contact)+'</div>':'')+'</div>\
    <div class="ops"><button class="btn btn-p" onclick="subAct(\\''+r.id+'\\',\\'toggle\\')">'+actionText+'</button><button class="btn btn-g btn-del" onclick="subAct(\\''+r.id+'\\',\\'delete\\')">🗑 删除</button></div></div>'}).join('')
    ||'<div class="panel" style="text-align:center;color:#b0aac4;padding:50px">'+(s.list.length?'🔍<br>没有匹配的内容':'🌷<br>还没有素材请求或问题反馈～')+'</div>';
  const fBtn=(k,t)=>'<button class="btn btn-xs '+(reqFilter===k?'btn-p':'btn-g')+'" onclick="reqFilter=\\''+k+'\\';route()">'+t+'</button>';
  const typeSelect='<select onchange="reqType=this.value;route()"><option value="all"'+(reqType==='all'?' selected':'')+'>全部类型</option><option value="request"'+(reqType==='request'?' selected':'')+'>素材请求</option><option value="feedback"'+(reqType==='feedback'?' selected':'')+'>问题反馈</option></select>';
  return '<div class="toolbar"><h2>💌 素材请求与问题反馈</h2><div class="sp"></div>'+typeSelect+fBtn('all','全部状态')+fBtn('new','未处理')+fBtn('done','已处理')+'<input placeholder="搜索内容/邮箱" value="'+esc(reqQ)+'" onchange="reqQ=this.value;route()" style="width:180px"></div>\
  <div class="sub">共 '+s.list.length+' 条'+((reqType!=='all'||reqFilter!=='all'||q)?'，筛出 '+flt.length+' 条':'')+'</div>'+cards;
};
window.subAct=async(id,action)=>{if(action==='delete'&&!confirm('确定删除这条吗？'))return;try{await api(location.pathname+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});route()}catch(e){toast(e.message)}};

/* ---------- 5.5 操作日志（2026-10-15：AI 工坊语义操作 + 原始访问/认证日志） ---------- */
const LOG_TYPES=[['ai-op','AI 工坊操作'],['access','访问日志'],['auth','登录审计'],['error','错误日志']];
let LOG_CUR='ai-op';
window.switchLog=t=>{LOG_CUR=t;route()};
H.logs=async()=>{
  const d=await api('/console/api/logs?type='+LOG_CUR+'&lines=300').catch(e=>({list:[],error:e.message}));
  const tabs=LOG_TYPES.map(t=>'<button class="btn '+(t[0]===LOG_CUR?'btn-p':'btn-g')+'" style="margin-right:6px" onclick="switchLog(\\''+t[0]+'\\')">'+t[1]+'</button>').join('');
  const color=l=>/FAIL|ERROR/.test(l)?'color:#d6336c':/ok|done/.test(l)?'color:#2f9e5f':'';
  const rows=(d.list||[]).map(l=>'<div style="padding:5px 2px;border-bottom:1px solid #f1eef9;font-size:12px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;'+color(l)+'">'+esc(l)+'</div>').join('')||'<div class="sub" style="padding:20px;text-align:center">今天还没有这类日志</div>';
  return '<div class="toolbar"><h2>📝 操作日志</h2><div class="sp"></div>'+tabs+'<button class="btn btn-g" onclick="route()">🔄 刷新</button></div>'
    +'<div class="panel" style="padding:12px 16px"><div class="sub" style="margin-bottom:8px">'+(LOG_TYPES.find(t=>t[0]===LOG_CUR)[1])+' · 今天 + 昨天 · 共 '+(d.total||0)+' 行，显示最新 '+(d.list||[]).length+' 行（新→旧，服务器保留 30 天）</div>'+rows+'</div>';
};

/* ---------- 6. 网站体检（可视化健康状态，无需懂技术） ---------- */
H.health=async()=>{
  const d=await api('/console/api/health');
  const ovMap={ok:['🎉 网站一切正常','所有检查项都健康，放心使用'],warn:['⚠️ 有 '+d.warn+' 项需要注意','暂不影响使用，建议抽空处理或联系 Kimi'],bad:['🚨 有 '+d.bad+' 项异常','请截图本页联系 Kimi 处理']};
  const ov=ovMap[d.overall]||ovMap.ok;
  const stTxt=s=>s==='ok'?'<span style="color:#10b981">● 正常</span>':s==='warn'?'<span style="color:#f59e0b">● 注意</span>':'<span style="color:#ef4444">● 异常</span>';
  const rows=d.items.map(it=>'<div class="panel" style="margin-bottom:12px;padding:16px 20px"><div class="hl"><span class="dot '+it.status+'"></span><div style="flex:1"><div class="t">'+esc(it.name)+'<span style="float:right;font-size:12px">'+stTxt(it.status)+'</span></div><div class="v">'+esc(it.value)+'</div><div class="h">'+esc(it.hint)+'</div></div></div></div>').join('');
  // 每周巡检简报卡（2026-10-25）：定时任务推送的最新报告，有异常时红字列出
  const rep=d.report?'<div class="panel" style="margin-bottom:12px;padding:16px 20px"><div class="hl"><span style="font-size:18px">📋</span><div style="flex:1"><div class="t">每周巡检简报<span style="float:right;font-size:12px;color:#8b84a3">'+esc(d.report.date)+'</span></div><div class="h" style="margin-top:4px">'+esc(d.report.summary)+'</div>'+(d.report.anomalies&&d.report.anomalies.length?'<div class="h" style="color:#d6336c;margin-top:6px">🔴 '+d.report.anomalies.map(esc).join('；')+'</div>':'')+'</div></div></div>':'';
  return '<div class="toolbar"><h2>🩺 网站体检</h2><div class="sp"></div><button class="btn btn-g" onclick="route()">🔄 刷新</button></div>'
    +'<div class="banner '+d.overall+'"><div style="font-size:19px;font-weight:700">'+ov[0]+'</div><div style="font-size:13px;opacity:.92;margin-top:4px">'+ov[1]+'</div></div>'
    +rep
    +rows
    +'<div class="sub" style="text-align:center;margin-top:10px">体检时间：'+fmtT(d.checkedAt)+' · 本页数据来自服务器实时检查，打开自动更新，无需任何操作</div>';
};

/* ---------- AI 提示词（2026-10-22）：全部 AI 生成提示词集中在此，保存即生效 ---------- */
H.aiprompts=async()=>{
  const {prompts:P}=await api('/console/api/ai-prompts');
  const ta=(id,label,val,rows,hint)=>'<div class="row"><label>'+label+(hint?' <span style="color:#b0aac4;font-weight:400">'+hint+'</span>':'')+'</label><textarea id="'+id+'" rows="'+(rows||3)+'" style="width:100%;resize:vertical;line-height:1.6">'+esc(val||'')+'</textarea></div>';
  const bigRow=(key,name)=>'<div class="panel"><h3 style="font-size:15px;margin-bottom:10px">'+name+'</h3>'
    +ta('p-big-'+key+'-prompt','提示词模板（{topic} = 用户描述）',P.big&&P.big[key]&&P.big[key].prompt,4)
    +'<div class="row"><label>尺寸（宽x高，像素）</label><input id="p-big-'+key+'-size" value="'+esc(P.big&&P.big[key]&&P.big[key].size||'')+'" style="width:180px"></div></div>';
  return '<h2>🤖 AI 提示词</h2><div class="sub">全部 AI 生成提示词集中管理：修改后点保存<strong>立即生效</strong>，无需重启服务。占位符：{topic}=用户描述，{styleSuffix}/{scienceRules}/{cellColorRules}=对应规则（生成素材模板内使用）。</div>'
    +'<div class="toolbar"><button class="btn btn-p" onclick="savePrompts()">💾 保存全部修改</button><span class="sub" id="p-hint">修改后记得保存</span></div>'
    +'<div class="panel"><h3 style="font-size:15px;margin-bottom:10px">📐 通用科学约束（生成素材）</h3>'
    +ta('p-sci','科学约束 scienceRules',P.scienceRules,3)
    +ta('p-cellcolor','微观配色 cellColorRules（仅细胞类描述自动插入）',P.cellColorRules,2)
    +ta('p-cellkw','细胞类关键词（正则）',P.cellularKeywords,1)
    +'</div>'
    +'<div class="panel"><h3 style="font-size:15px;margin-bottom:10px">✨ 生成素材总模板 genTmpl</h3>'
    +ta('p-gentmpl','模板（可用占位符：{topic} {styleSuffix} {scienceRules} {cellColorRules}）',P.genTmpl,7)
    +'<h3 style="font-size:14px;margin:14px 0 10px">三种风格描述 styleSuffix</h3>'
    +ta('p-suffix-flat','矢量插画风格 flat',P.styleSuffix&&P.styleSuffix.flat,3)
    +ta('p-suffix-matte','OneFig 风格 matte',P.styleSuffix&&P.styleSuffix.matte,3)
    +ta('p-suffix-threed','3D 立体质感 threed',P.styleSuffix&&P.styleSuffix.threed,3)
    +'</div>'
    +'<h3 style="font-size:15px;margin:4px 0 12px">🖌️ 生成大图（三种类型）</h3>'
    +bigRow('cover','期刊封面（竖版）')+bigRow('abstract','文内摘要图（横版）')+bigRow('mechanism','文内机制图（横版）')
    +'<div class="panel"><h3 style="font-size:15px;margin-bottom:10px">🖼️ 风格转换指令 stylize（qwen-image 图生图）</h3>'
    +ta('p-sty-flat','矢量插画风格 flat',P.stylize&&P.stylize.flat,2)
    +ta('p-sty-matte','OneFig 风格 matte',P.stylize&&P.stylize.matte,2)
    +ta('p-sty-threed','3D 立体质感 threed',P.stylize&&P.stylize.threed,2)
    +'</div>'
    +'<div class="toolbar"><button class="btn btn-p" onclick="savePrompts()">💾 保存全部修改</button></div>';
};
window.savePrompts=async()=>{
  const v=id=>document.getElementById(id).value;
  const prompts={
    scienceRules:v('p-sci').trim(),cellColorRules:v('p-cellcolor').trim(),cellularKeywords:v('p-cellkw').trim(),
    genTmpl:v('p-gentmpl').trim(),
    styleSuffix:{flat:v('p-suffix-flat').trim(),matte:v('p-suffix-matte').trim(),threed:v('p-suffix-threed').trim()},
    big:{
      cover:{prompt:v('p-big-cover-prompt').trim(),size:v('p-big-cover-size').trim()},
      abstract:{prompt:v('p-big-abstract-prompt').trim(),size:v('p-big-abstract-size').trim()},
      mechanism:{prompt:v('p-big-mechanism-prompt').trim(),size:v('p-big-mechanism-size').trim()},
    },
    stylize:{flat:v('p-sty-flat').trim(),matte:v('p-sty-matte').trim(),threed:v('p-sty-threed').trim()},
  };
  try{await api('/console/api/ai-prompts',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompts})});toast('已保存，立即生效 ✅');document.getElementById('p-hint').textContent='已保存 ✓ 下次生成即用新提示词'}
  catch(e){toast(e.message)}
};

/* ---------- 生成图库（2026-10-22）：全部用户 AI 生成图，可搜索/排序 ---------- */
/* 2026-10-23 按反馈：顶部加「AI 生图记录 / 画板导出图」切换按钮——AI 生图越来越多，导出图沉底找不到 */
const G_KIND={gen:'生成素材',big:'生成大图',edit:'AI 改图',style:'风格转换',nobg:'移除背景',vec:'位图转矢量',split:'拆分图层'};
function gState(){return window._gq=window._gq||{q:'',sort:'desc',offset:0,limit:60,total:0,items:[],tab:'ai',aiTotal:null,expTotal:null}}
window.galleryTab=(k)=>{const g=gState();if(g.tab!==k){g.tab=k;route()}};
function galleryTabs(g){
  const aiN=g.aiTotal==null?'':'（'+g.aiTotal+'）';
  const exN=g.expTotal==null?'':'（'+g.expTotal+'）';
  return '<div class="toolbar" style="margin-bottom:14px">'+
    '<button class="btn btn-xs '+(g.tab==='ai'?'btn-p':'btn-g')+'" onclick="galleryTab(\\'ai\\')">🖼️ AI 生图记录'+aiN+'</button>'+
    '<button class="btn btn-xs '+(g.tab==='export'?'btn-p':'btn-g')+'" onclick="galleryTab(\\'export\\')">🎨 画板导出图'+exN+'</button>'+
    '</div>';
}
function renderGallery(){
  const g=gState();
  // 点击小图看大图（2026-10-23 按反馈）：复用后台 viewMatList 查看器，支持左右翻页
  window.G_LIST=g.items.map(it=>({src:'/console/api/ai-gallery/img?job='+it.id+'&n='+it.img+'&t='+getTK(),t:it.prompt||''}));
  const cards=g.items.map((it,i)=>'<div class="mat"><img loading="lazy" src="'+window.G_LIST[i].src+'" alt="" style="cursor:zoom-in" onclick="viewMatList(G_LIST,'+i+')" onerror="this.style.opacity=.2">'+
    '<div class="t" title="'+esc(it.prompt)+'">'+esc((it.prompt||'').slice(0,20))+'</div>'+
    '<div class="dl">'+esc(it.userName)+(it.userEmail?' · '+esc(it.userEmail):'')+'<br>'+(G_KIND[it.kind]||it.kind)+(it.kind==='split'?' · '+it.layers+' 层':'')+' · '+fmtT(it.createdAt)+'</div></div>').join('');
  return '<h2>🖼️ 生成图库</h2><div class="sub">全部用户的 AI 生成图（AI 工坊），支持按账号 / 邮箱 / 描述搜索，按时间排序。</div>'+
    galleryTabs(g)+
    '<div class="toolbar"><input id="g-q" placeholder="搜索账号 / 邮箱 / 描述，回车确认" value="'+esc(g.q)+'" style="width:260px" onkeydown="if(event.key===\\'Enter\\')gallerySearch()">'+
    '<select id="g-sort" onchange="gallerySearch()"><option value="desc"'+(g.sort==='desc'?' selected':'')+'>最新优先</option><option value="asc"'+(g.sort==='asc'?' selected':'')+'>最早优先</option></select>'+
    '<button class="btn btn-p btn-xs" onclick="gallerySearch()">搜索</button><div class="sp"></div><a class="btn btn-g btn-xs" href="#/logs">操作明细</a></div>'+
    (g.items.length?'<div class="grid">'+cards+'</div>':'<div class="panel" style="text-align:center;color:#8b84a3">没有匹配的记录</div>')+
    (g.offset<g.total?'<div style="text-align:center;margin-top:14px"><button class="btn btn-g" onclick="galleryMore()">加载更多（还有 '+(g.total-g.offset)+' 条）</button></div>':'');
}
// 画板导出图（2026-10-22 起上传存档；TIF 浏览器无法预览显示占位）
function renderExport(e){
  // 点击小图看大图（2026-10-23）：TIF 浏览器看不了，占位图不挂查看器
  window.G_EXP=e.list.map(r=>({src:'/console/api/export-records/img?id='+r.id+'&t='+getTK(),t:(r.boardTitle||'画板导出')+' · '+(r.fmt||'').toUpperCase()}));
  const cards=e.list.map((r,i)=>'<div class="mat"><img loading="lazy" src="'+window.G_EXP[i].src+'" alt=""'+(r.fmt==='tif'?'':' style="cursor:zoom-in" onclick="viewMatList(G_EXP,'+i+')"')+' onerror="this.parentElement.innerHTML=\\'<div class=&quot;noimg&quot; style=&quot;height:96px&quot;>'+(r.fmt==='tif'?'TIF 无法预览':(r.fmt||'').toUpperCase())+'</div>\\'">'+
    '<div class="t" title="'+esc(r.boardTitle||'')+'">'+esc((r.boardTitle||'画板导出').slice(0,16))+'</div>'+
    '<div class="dl">'+esc(r.userName)+(r.userEmail?' · '+esc(r.userEmail):'')+'<br>'+esc((r.fmt||'').toUpperCase())+' · '+fmtSize(r.size)+' · '+fmtT(r.time)+'</div></div>').join('');
  return '<div class="sub" style="margin-bottom:12px">2026-10-22 起导出时自动上传存档（PDF/SVG 矢量格式不上传）。</div>'+
    (e.list.length?'<div class="grid">'+cards+'</div>':'<div class="panel" style="text-align:center;color:#8b84a3">暂无导出记录（旧记录为本地导出，无图）</div>');
}
H.gallery=async()=>{
  const g=gState();
  if(g.tab==='export'){
    const e=await api('/console/api/export-records?q='+encodeURIComponent(g.q));
    g.expTotal=e.total;
    return '<h2>🖼️ 生成图库</h2>'+galleryTabs(g)+renderExport(e);
  }
  const d=await api('/console/api/ai-gallery?q='+encodeURIComponent(g.q)+'&sort='+g.sort+'&offset=0&limit='+g.limit);
  g.total=d.total; g.aiTotal=d.total; g.items=d.list; g.offset=d.list.length;
  return renderGallery();
};
window.gallerySearch=()=>{const g=gState();g.q=document.getElementById('g-q').value.trim();g.sort=document.getElementById('g-sort').value;g.offset=0;g.items=[];route()};
window.galleryMore=async()=>{
  const g=gState();
  const d=await api('/console/api/ai-gallery?q='+encodeURIComponent(g.q)+'&sort='+g.sort+'&offset='+g.offset+'&limit='+g.limit);
  g.items=g.items.concat(d.list); g.offset+=d.list.length;
  document.getElementById('view').innerHTML=renderGallery();
};

/* ---------- 9. 发票管理：申请资料筛选与批量导出 ---------- */
let INV_ROWS=[],INV_SELECTED=new Set();
const INV_FILTER={status:'all',exportStatus:'all',from:'',to:'',q:''};
function invQuery(mode){
  const p=new URLSearchParams();
  if(mode==='selected')p.set('ids',Array.from(INV_SELECTED).join(','));
  else{
    if(INV_FILTER.status!=='all')p.set('status',INV_FILTER.status);
    if(INV_FILTER.exportStatus!=='all')p.set('exportStatus',INV_FILTER.exportStatus);
    if(INV_FILTER.from)p.set('from',INV_FILTER.from);
    if(INV_FILTER.to)p.set('to',INV_FILTER.to);
    if(INV_FILTER.q)p.set('q',INV_FILTER.q);
  }
  return p.toString();
}
function invSelectedText(){return '下载已选（'+INV_SELECTED.size+'）'}
H.invoices=async()=>{
  const d=await api('/console/api/invoices?'+invQuery('filter'));
  INV_ROWS=d.list;
  const rows=INV_ROWS.length?INV_ROWS.map(r=>{
    const checked=INV_SELECTED.has(r.id)?' checked':'';
    const business=r.businessType==='MATERIAL_LICENSE'?'素材使用授权':'画板导出服务';
    const buyer=r.buyerType==='company'?'单位':'个人';
    const exported=r.exportStatus==='exported';
    return '<tr><td><input type="checkbox" data-inv-check="'+esc(r.id)+'"'+checked+' onchange="invToggle(\\''+r.id+'\\',this.checked)"></td>'
      +'<td><b>'+esc(r.title)+'</b><div class="sub" style="margin:4px 0 0">'+esc(r.taxId||'个人抬头')+'</div><div style="font-size:12px;color:#8b84a3;margin-top:3px">'+esc(r.email)+'</div></td>'
      +'<td><b>'+esc(r.orderTitle)+'</b><div style="font-size:12px;color:#8b84a3;margin-top:4px">'+business+' · '+esc(r.orderId)+'</div></td>'
      +'<td>'+buyer+'<div style="font-size:12px;color:#8b84a3;margin-top:4px">'+(r.invoiceType==='special'?'专用发票':'普通发票')+'</div></td>'
      +'<td><b>'+yuan(r.amount)+'</b></td>'
      +'<td><span class="'+(exported?'tag done2':'tag')+'">'+(exported?'已导出':'未导出')+'</span><div style="font-size:11px;color:#8b84a3;margin-top:4px">'+(exported?fmtT(r.lastExportedAt)+' · 第 '+(r.exportCount||1)+' 次':'—')+'</div></td>'
      +'<td style="white-space:nowrap">'+fmtT(r.createdAt)+'<div style="font-size:11px;color:#8b84a3;margin-top:4px">'+esc(r.id)+'</div></td></tr>';
  }).join(''):'<tr><td colspan="7" style="text-align:center;color:#b0aac4;padding:28px">当前筛选条件下没有开票申请</td></tr>';
  return '<div class="toolbar"><h2>🧾 发票管理</h2><div class="sp"></div><button class="btn btn-g" onclick="route()">🔄 刷新</button></div>'
    +'<div class="panel"><div class="toolbar">'
    +'<select id="inv-status"><option value="all"'+(INV_FILTER.status==='all'?' selected':'')+'>全部状态</option><option value="pending"'+(INV_FILTER.status==='pending'?' selected':'')+'>待处理</option><option value="issued"'+(INV_FILTER.status==='issued'?' selected':'')+'>已开具</option><option value="rejected"'+(INV_FILTER.status==='rejected'?' selected':'')+'>已驳回</option><option value="red_flushed"'+(INV_FILTER.status==='red_flushed'?' selected':'')+'>已红冲</option></select>'
    +'<select id="inv-export-status"><option value="all"'+(INV_FILTER.exportStatus==='all'?' selected':'')+'>全部导出状态</option><option value="unexported"'+(INV_FILTER.exportStatus==='unexported'?' selected':'')+'>未导出</option><option value="exported"'+(INV_FILTER.exportStatus==='exported'?' selected':'')+'>已导出</option></select>'
    +'<input id="inv-from" type="date" value="'+esc(INV_FILTER.from)+'" title="开始日期"><span class="sub" style="margin:0">至</span><input id="inv-to" type="date" value="'+esc(INV_FILTER.to)+'" title="结束日期">'
    +'<input id="inv-q" placeholder="搜索抬头 / 税号 / 邮箱 / 订单号" value="'+esc(INV_FILTER.q)+'" style="width:240px" onkeydown="if(event.key===\\'Enter\\')invSearch()">'
    +'<button class="btn btn-p" onclick="invSearch()">查询</button><button class="btn btn-g" onclick="invReset()">重置</button></div>'
    +'<div class="toolbar" style="margin-bottom:0"><span class="sub" style="margin:0">共 '+d.total+' 条申请；选中导出后自动标记为已导出</span><div class="sp"></div>'
    +'<button class="btn btn-g" onclick="invSelectUnexported()">全选未导出</button><button class="btn btn-g" onclick="invExport(\\'filter\\')">下载筛选结果</button><button class="btn btn-p" id="inv-selected-btn" onclick="invExport(\\'selected\\')">'+invSelectedText()+'</button></div></div>'
    +'<div class="panel" style="overflow:auto"><table><tr><th><input type="checkbox" onchange="invToggleAll(this.checked)" title="全选当前列表"></th><th>购买方 / 接收邮箱</th><th>订单 / 业务类型</th><th>抬头 / 发票类型</th><th>金额</th><th>导出状态</th><th>申请时间 / 编号</th></tr>'+rows+'</table></div>';
};
window.invSearch=()=>{
  INV_FILTER.status=document.getElementById('inv-status').value;
  INV_FILTER.exportStatus=document.getElementById('inv-export-status').value;
  INV_FILTER.from=document.getElementById('inv-from').value;
  INV_FILTER.to=document.getElementById('inv-to').value;
  INV_FILTER.q=document.getElementById('inv-q').value.trim();
  route();
};
window.invReset=()=>{INV_FILTER.status='all';INV_FILTER.exportStatus='all';INV_FILTER.from='';INV_FILTER.to='';INV_FILTER.q='';route()};
window.invToggle=(id,checked)=>{if(checked)INV_SELECTED.add(id);else INV_SELECTED.delete(id);document.getElementById('inv-selected-btn').textContent=invSelectedText()};
window.invToggleAll=checked=>{INV_ROWS.forEach(r=>{if(checked)INV_SELECTED.add(r.id);else INV_SELECTED.delete(r.id)});document.querySelectorAll('[data-inv-check]').forEach(c=>{c.checked=checked});document.getElementById('inv-selected-btn').textContent=invSelectedText()};
window.invSelectUnexported=()=>{
  INV_SELECTED.clear();
  const ids=INV_ROWS.filter(r=>r.exportStatus!=='exported').map(r=>r.id);
  ids.forEach(id=>INV_SELECTED.add(id));
  document.querySelectorAll('[data-inv-check]').forEach(c=>{c.checked=INV_SELECTED.has(c.dataset.invCheck)});
  document.getElementById('inv-selected-btn').textContent=invSelectedText();
  toast(ids.length?'已勾选 '+ids.length+' 条未导出申请':'当前列表没有未导出申请');
};
window.invExport=async mode=>{
  if(mode==='selected'&&!INV_SELECTED.size)return toast('请先勾选需要下载的申请');
  if(mode==='filter'&&!INV_ROWS.length)return toast('当前筛选条件下没有可下载的申请');
  try{
    const count=mode==='selected'?INV_SELECTED.size:INV_ROWS.length;
    const r=await fetch('/console/api/invoices/export?'+invQuery(mode),{headers:{Authorization:'Bearer '+getTK()}});
    if(r.status===401){logout();throw new Error('登录已过期，请重新登录')}
    if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||'下载失败')}
    const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='开票申请资料-'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('已下载 '+count+' 条申请资料'+(mode==='selected'?'，并标记为已导出':''));
    if(mode==='selected'){INV_SELECTED.clear();await route()}
  }catch(e){toast(e.message)}
};

/* ---------- 路由 ---------- */
async function route(){
  if(!getTK()){document.getElementById('loginMask').style.display='flex';return}
  const h=(location.hash||'#/dashboard').slice(2);
  document.querySelectorAll('.side a').forEach(a=>a.classList.toggle('active',a.dataset.r===h));
  const v=document.getElementById('view');
  try{v.innerHTML=await (H[h]||H.dashboard)()}catch(e){v.innerHTML='<div class="panel">加载失败：'+esc(e.message)+'</div>'}
}
/* ---------- 全局下拉框增强：动态页面与弹窗中的 select 自动套用，原 onchange 不变 ---------- */
function closeUiSelects(except){
  document.querySelectorAll('.ui-select.open').forEach(w=>{if(w!==except){w.classList.remove('open');w.querySelector('.select-control').setAttribute('aria-expanded','false')}});
}
function enhanceSelects(){
  document.querySelectorAll('select:not([data-ui-ready])').forEach(select=>{
    select.dataset.uiReady='1';
    const naturalWidth=select.offsetWidth;
    const wrap=document.createElement('span');wrap.className='ui-select';
    if(select.closest('.modal'))wrap.classList.add('ui-select-block');
    else wrap.style.minWidth=Math.max(112,naturalWidth)+'px';
    const control=document.createElement('button');control.type='button';control.className='select-control';control.setAttribute('aria-haspopup','listbox');control.setAttribute('aria-expanded','false');
    control.innerHTML='<span class="select-value"></span><svg class="select-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const menu=document.createElement('span');menu.className='select-menu';menu.setAttribute('role','listbox');
    const buttons=[];
    Array.from(select.options).forEach((opt,index)=>{
      const item=document.createElement('button');item.type='button';item.className='select-option';item.setAttribute('role','option');item.disabled=opt.disabled;
      const label=document.createElement('span');label.textContent=opt.textContent;item.appendChild(label);
      const check=document.createElement('span');check.className='select-check';item.appendChild(check);menu.appendChild(item);buttons.push(item);
      item.addEventListener('click',()=>{
        select.value=opt.value;sync();closeUiSelects();control.focus();
        select.dispatchEvent(new Event('change',{bubbles:true}));
      });
    });
    function sync(){
      const index=select.selectedIndex,opt=select.options[index];
      control.querySelector('.select-value').textContent=opt?opt.textContent:'';
      buttons.forEach((b,i)=>{const yes=i===index;b.setAttribute('aria-selected',yes?'true':'false');b.querySelector('.select-check').textContent=yes?'✓':''});
    }
    function open(focusCurrent){
      closeUiSelects(wrap);wrap.classList.add('open');control.setAttribute('aria-expanded','true');
      const rect=control.getBoundingClientRect();wrap.classList.toggle('up',rect.bottom+260>window.innerHeight&&rect.top>280);
      if(focusCurrent)(buttons[select.selectedIndex]||buttons[0]||control).focus();
    }
    control.addEventListener('click',()=>wrap.classList.contains('open')?closeUiSelects():open(false));
    control.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open(true)}});
    menu.addEventListener('keydown',e=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
      e.preventDefault();const at=buttons.indexOf(document.activeElement);let next=at;
      if(e.key==='Home')next=0;else if(e.key==='End')next=buttons.length-1;else next=(at+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
      if(buttons[next])buttons[next].focus();
    });
    select.classList.add('select-native');select.after(wrap);wrap.appendChild(control);wrap.appendChild(menu);sync();
  });
}
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.ui-select'))closeUiSelects()});
document.addEventListener('keydown',e=>{
  const open=document.querySelector('.ui-select.open');if(!open||e.key!=='Escape')return;
  e.preventDefault();e.stopPropagation();open.querySelector('.select-control').focus();closeUiSelects();
},true);
new MutationObserver(enhanceSelects).observe(document.body,{childList:true,subtree:true});
enhanceSelects();

window.addEventListener('hashchange',route);
if(getTK()){document.getElementById('acct-name').textContent=localStorage.getItem(NM_KEY)||'管理员';route()}
else{document.getElementById('loginMask').style.display='flex'}
</script></body></html>`;
