// OneFig 管理后台控制台（五页：数据看板 / 素材管理 / 账号管理 / 素材请求 / 网站体检）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PLANS = { basic: '青果会员', pro: '红果会员', team: '金果会员' };
const PLAN_PRICE = { basic: 29.9, pro: 99.9, team: 299.9 };

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

  // ---------- API ----------
  app.get('/console/api/stats', consoleAuth, (req, res) => {
    const users = load('users.json', []);
    const orders = load('orders.json', []).filter(o => o.status === 'paid');
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
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({
        date: key.slice(5),
        users: users.filter(u => (u.joinedAt || '').slice(0, 10) === key).length,
        revenue: rmb(orders.filter(o => (o.paidAt || '').slice(0, 10) === key).reduce((s, o) => s + o.amount, 0)),
      });
    }
    res.json({ ok: true, totalUsers: users.length, online: getOnline(), levelCount, totalRevenue, monthly, days });
  });

  // 每日走势：新增用户 + 收入（可选 7/30/180/365 天）
  app.get('/console/api/trend', consoleAuth, (req, res) => {
    const days = Math.min(366, Math.max(1, parseInt(req.query.range, 10) || 30));
    const users = load('users.json', []);
    const orders = load('orders.json', []).filter(o => o.status === 'paid');
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
    const all = load(path.join('..', 'ai', 'credit-orders.json'), []);
    const paid = all.filter(o => o.status === 'paid');
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
      ...u,
      totalPaid: rmb(orders.filter(o => o.userId === u.id).reduce((s, o) => s + o.amount, 0)),
      orderCount: orders.filter(o => o.userId === u.id).length,
    }));
    if (q) list = list.filter(u => ((u.name || '') + (u.contact || '') + (u.email || '')).toLowerCase().includes(q));
    res.json({ ok: true, list });
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
      const seen = new Map();
      for (const l of dls) {
        const hit = map.get(l.materialId);
        if (!hit) continue;
        seen.set(l.materialId, {
          id: l.materialId,
          title: hit.m.title,
          folder: hit.s.folder,
          series: hit.m.series || hit.s.folder,
          file: hit.m.file || (hit.m.title + '.png'),
          local: !!hit.m.local,
          time: l.time,
          code: l.code || null,
        });
      }
      downloads = [...seen.values()].sort((a, b) => b.time.localeCompare(a.time));
    } catch {}
    res.json({ ok: true, user: u, orders: my, totalPaid: rmb(my.reduce((s, o) => s + o.amount, 0)), levelLog, creditOrders, creditLog, boards, downloads });
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
    const { level, notes, resetQuota } = req.body || {};
    if (resetQuota) {
      // 测试工具：重置本月下载额度（dlMonth 清空后，下次下载按当月重新计数）
      u.dlUsed = 0;
      u.dlMonth = '';
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

  app.post('/console/api/orders', consoleAuth, (req, res) => {
    const { userName, contact, plan, amount, paidAt } = req.body || {};
    if (!userName || !PLANS[plan]) return res.status(400).json({ ok: false, error: '请填写用户昵称和会员类型' });
    const amt = Math.max(0, Number(amount) || PLAN_PRICE[plan]);
    const users = load('users.json', []);
    const orders = load('orders.json', []);
    let u = users.find(x => x.name === String(userName).trim() && (contact ? x.contact === String(contact).trim() : true));
    if (!u) {
      u = { id: crypto.randomUUID(), name: String(userName).trim(), contact: String(contact || '').trim(), level: 'none', joinedAt: new Date().toISOString(), memberSince: null, notes: '' };
      users.push(u);
    }
    u.level = plan;
    if (!u.memberSince) u.memberSince = new Date().toISOString();
    const granted = grantMemberCredits(u, plan);
    if (granted) logCredit(u, granted, '开通' + PLANS[plan] + '赠送');
    const order = { id: crypto.randomUUID(), userId: u.id, userName: u.name, plan, amount: amt, status: 'paid', paidAt: paidAt ? new Date(paidAt).toISOString() : new Date().toISOString(), channel: '手动记录' };
    orders.push(order);
    save('users.json', users); save('orders.json', orders);
    res.json({ ok: true, order });
  });

  // 在线订单：待确认列表 + 一键确认收款（自动升级会员）
  app.get('/console/api/orders', consoleAuth, (req, res) => {
    let orders = load('orders.json', []);
    if (req.query.status) orders = orders.filter(o => req.query.status.split(',').includes(o.status));
    orders.sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? 1 : -1);
    res.json({ ok: true, list: orders });
  });

  app.post('/console/api/orders/:id/confirm', consoleAuth, (req, res) => {
    // 升级逻辑与在线支付回调共用（pay.js markOrderPaid，幂等）：2026-10-08 起不再各自实现
    const result = require('./pay').markOrderPaid(DATA_DIR, req.params.id);
    if (!result) return res.status(404).json({ ok: false });
    res.json({ ok: true, order: result.order });
  });

  // 收款信息设置（网站付款页展示）
  app.get('/console/api/payinfo', consoleAuth, (req, res) => {
    res.json({ ok: true, ...load('payinfo.json', { wechat: '', alipay: '', note: '转账时备注你的注册邮箱，方便确认' }) });
  });
  app.put('/console/api/payinfo', consoleAuth, (req, res) => {
    const { wechat, alipay, note } = req.body || {};
    save('payinfo.json', { wechat: String(wechat || '').slice(0, 100), alipay: String(alipay || '').slice(0, 100), note: String(note || '').slice(0, 200) });
    res.json({ ok: true });
  });

  app.delete('/console/api/orders/:id', consoleAuth, (req, res) => {
    save('orders.json', load('orders.json', []).filter(o => o.id !== req.params.id));
    res.json({ ok: true });
  });

  app.get('/console/api/materials', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const flat = data.flatMap(s => s.materials);
    if (req.query.hot) { flat.sort((a, b) => b.downloads - a.downloads); return res.json({ ok: true, list: flat.slice(0, 50) }); }
    res.json({ ok: true, series: data, total: flat.length, totalDownloads: flat.reduce((s, m) => s + m.downloads, 0) });
  });

  app.post('/console/api/materials', consoleAuth, (req, res) => {
    const { series, title } = req.body || {};
    if (!series) return res.status(400).json({ ok: false, error: '请填写文件夹名称' });
    const data = load('materials.json', []);
    let s = data.find(x => x.folder === series);
    if (!s) { s = { folder: series, materials: [] }; data.push(s); }
    if (title) {
      if (s.materials.some(m => m.title === title)) return res.status(400).json({ ok: false, error: '该系列下已存在同名素材' });
      s.materials.push({ id: `${series}/${title}`, series, file: `${title}.png`, title, downloads: 0, createdAt: new Date().toISOString() });
    }
    save('materials.json', data);
    res.json({ ok: true });
  });

  app.delete('/console/api/series/:folder', consoleAuth, (req, res) => {
    save('materials.json', load('materials.json', []).filter(x => x.folder !== req.params.folder));
    res.json({ ok: true });
  });

  app.delete('/console/api/materials/:series/:title', consoleAuth, (req, res) => {
    const data = load('materials.json', []);
    const s = data.find(x => x.folder === req.params.series);
    if (s) s.materials = s.materials.filter(m => m.title !== req.params.title);
    save('materials.json', data);
    res.json({ ok: true });
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

    const bad = items.filter(i => i.status === 'bad').length;
    const warn = items.filter(i => i.status === 'warn').length;
    res.json({ ok: true, overall: bad ? 'bad' : warn ? 'warn' : 'ok', bad, warn, items, checkedAt: new Date().toISOString() });
  });

  // ---------- 页面（公开访问，内含登录界面；数据接口均有 consoleAuth 保护） ----------
  app.get(deps.ADMIN_PATH_FULL, (req, res) => res.send(PAGE));
  app.get('/', (req, res) => res.redirect(deps.ADMIN_PATH_FULL));
};

const OSS = 'http://onefig.oss-cn-hangzhou.aliyuncs.com/previews/';

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无花有果 · 管理后台</title>
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
  <div class="brand" style="display:flex;align-items:center;justify-content:center;gap:8px"><img src="http://onefig.oss-cn-hangzhou.aliyuncs.com/brand/icon.png" style="width:30px;height:30px;object-fit:contain;border-radius:8px;background:#fff;padding:2px">无花有果 后台</div>
  <a href="#/dashboard" data-r="dashboard"><span class="ic">📊</span>数据看板</a>
  <a href="#/materials" data-r="materials"><span class="ic">🎨</span>素材管理</a>
  <a href="#/users" data-r="users"><span class="ic">👥</span>账号管理</a>
  <a href="#/requests" data-r="requests"><span class="ic">💌</span>素材请求</a>
  <a href="#/logs" data-r="logs"><span class="ic">📝</span>操作日志</a>
  <a href="#/health" data-r="health"><span class="ic">🩺</span>网站体检</a>
  <div class="acct"><span>👤</span><span id="acct-name" style="overflow:hidden;text-overflow:ellipsis">管理员</span><button onclick="logout()">退出</button></div>
</div>
<div class="main" id="view">加载中…</div>
<div class="modal-mask" id="mask"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>
<div class="login-mask" id="loginMask"><div class="login-card">
  <img src="http://onefig.oss-cn-hangzhou.aliyuncs.com/brand/icon.png" style="width:48px;height:48px;border-radius:12px;background:#f6f4fb;padding:4px;object-fit:contain">
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
window.payModal=async()=>{const p=await api('/console/api/payinfo').catch(()=>({wechat:'',alipay:'',note:''}));
  showModal('<h3>收款设置</h3>\
  <div class="row"><label>微信号（显示给付款粉丝）</label><input id="m-wx" value="'+esc(p.wechat||'')+'" placeholder="你的微信号"></div>\
  <div class="row"><label>支付宝账号</label><input id="m-zfb" value="'+esc(p.alipay||'')+'" placeholder="你的支付宝"></div>\
  <div class="row"><label>转账提示语</label><input id="m-note" value="'+esc(p.note||'')+'" placeholder="例如：转账请备注注册邮箱"></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="savePay()">保存</button></div>')};
window.savePay=async()=>{try{await api('/console/api/payinfo',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({wechat:document.getElementById('m-wx').value.trim(),alipay:document.getElementById('m-zfb').value.trim(),note:document.getElementById('m-note').value.trim()})});closeModal();toast('已保存 ✅')}catch(e){toast(e.message)}};
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
let VIEW_LIST=[],VIEW_I=0,CUR_IMGS=[],REQ_IMGS=[];
window.viewMat=src=>viewMatList([{src}],0);
window.viewMatList=(list,i)=>{VIEW_LIST=list;VIEW_I=i;renderView()};
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
function closeModal(){document.getElementById('mask').style.display='none'}
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
  return '<div class="toolbar"><h2>📊 数据看板</h2><div class="sp"></div><button class="btn btn-g" onclick="payModal()">💳 收款设置</button><button class="btn btn-p" onclick="orderModal()">＋ 记一笔订单</button></div>\
  <div class="cards">\
    <div class="kpi"><div class="lbl">总用户</div><div class="num">'+s.totalUsers+'</div><div class="chips"><span class="chip" style="color:#2f9e5f">🟢 当前在线 '+s.online+' 人</span></div></div>\
    <div class="kpi"><div class="lbl">🟢 青果会员</div><div class="num">'+s.levelCount.basic+'</div></div>\
    <div class="kpi"><div class="lbl">🔴 红果会员</div><div class="num">'+s.levelCount.pro+'</div></div>\
    <div class="kpi"><div class="lbl">🟡 金果会员</div><div class="num">'+s.levelCount.team+'</div></div>\
    <div class="kpi"><div class="lbl">总支付金额</div><div class="num">'+yuan(s.totalRevenue)+'</div></div>\
  </div>'+aiPanel+'\
  <div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">💰 每日收入走势</h3><div class="sp"></div>'+tabBtns+'</div>'+chart(trend.days,'revenue','linear-gradient(180deg,#a78bfa,#7c5cbf)',v=>yuan(v))+'</div>\
  <div class="panel"><div class="toolbar" style="margin-bottom:10px"><h3 style="font-size:15px">🌱 每日新增用户</h3><div class="sp"></div>'+tabBtns+'</div>'+chart(trend.days,'users','linear-gradient(180deg,#6ee7b7,#34d399)',v=>v+'人')+'</div>'+leakPanel+creditPanel;
};
window.setRange=r=>{window._range=r;route()};
window.setCRange=r=>{window._crange=r;route()};

window.orderModal=()=>showModal('<h3>记一笔订单</h3>\
  <div class="row"><label>用户昵称 *</label><input id="m-name" placeholder="粉丝昵称"></div>\
  <div class="row"><label>联系方式</label><input id="m-contact" placeholder="微信/邮箱（选填）"></div>\
  <div class="row"><label>会员类型 *</label><select id="m-plan"><option value="basic">青果会员 ¥29</option><option value="pro">红果会员 ¥99</option><option value="team">金果会员 ¥299</option></select></div>\
  <div class="row"><label>实收金额（元）</label><input id="m-amt" type="number" placeholder="留空按标价"></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="saveOrder()">保存</button></div>');
window.saveOrder=async()=>{
  const body={userName:document.getElementById('m-name').value.trim(),contact:document.getElementById('m-contact').value.trim(),plan:document.getElementById('m-plan').value,amount:document.getElementById('m-amt').value};
  try{await api('/console/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal();toast('已记录 ✅');route()}catch(e){toast(e.message)}
};

/* ---------- 2. 素材管理 ---------- */
let matView={series:null,hot:false},sortMode=false,MAT_DATA=null,dragI=-1;
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
H.materials=async()=>{
  const s=await api('/console/api/materials');MAT_DATA=s;
  if(matView.hot){
    const hot=await api('/console/api/materials?hot=1');CUR_IMGS=hot.list.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><button class="btn btn-g" onclick="matView.hot=false;route()">← 返回</button><h2>🎨 热门排行</h2><div class="sp"></div></div>\
    <div class="panel" style="font-size:13px;color:#8b84a3;margin-bottom:16px">🏆 热门素材 TOP（按下载量）· 全库共 '+s.total+' 个素材，总下载 '+s.totalDownloads+' 次</div>\
    <div class="grid">'+hot.list.map((m,i)=>'<div class="mat"><img src="'+matImg(m)+'" onerror="this.style.opacity=.2" onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"><div class="t">'+esc(m.title)+'</div><div class="dl">⬇ '+m.downloads+' 次 · '+fmtSize(m.size)+' · '+esc(m.series.split('-')[1]||m.series)+'</div></div>').join('')+'</div>';
  }
  if(matView.series){
    const sd=s.series.find(x=>x.folder===matView.series);CUR_IMGS=sd.materials.map(m=>({src:matImg(m),t:m.title}));
    return '<div class="toolbar"><button class="btn btn-g" onclick="matView.series=null;route()">← 返回</button><h2>🎨 '+esc(matView.series)+'</h2><div class="sp"></div>'+sortBtn()+'<button class="btn btn-p" onclick="addMatModal()">＋ 添加素材</button></div>\
    '+(sortMode?'<div class="sub" style="color:#7c5cbf;font-weight:600">⇅ 排序模式：拖动素材卡片换位，松手即保存，前台同步生效。点「✅ 完成排序」退出</div>':'')+'\
    <div class="grid">'+sd.materials.map((m,i)=>'<div class="mat'+(sortMode?' sorting':'')+'"'+(sortMode?' draggable="true" ondragstart="mDrag(event,'+i+')" ondragover="event.preventDefault()" ondrop="mDrop(event,'+i+')"':'')+'><img src="'+matImg(m)+'" onerror="this.style.opacity=.2"'+(sortMode?'':' onclick="viewMatList(CUR_IMGS,'+i+')" style="cursor:zoom-in"')+'><div class="t">'+esc(m.title)+'</div><div class="dl">⬇ '+m.downloads+' · '+fmtSize(m.size)+'</div>'+(sortMode?'':'<button class="btn btn-g btn-xs mat-del" onclick="renameMatModal(\\''+m.series+'\\',\\''+m.title+'\\')">✏️ 改名</button> <button class="btn btn-d btn-xs mat-del" onclick="delMat(\\''+m.series+'\\',\\''+m.title+'\\')">删除</button>')+'</div>').join('')+'</div>';
  }
  return '<div class="toolbar"><h2>🎨 素材管理</h2><div class="sp"></div>'+sortBtn()+'<button class="btn btn-g" onclick="matView.hot=true;route()">🏆 热门排行</button><button class="btn btn-p" onclick="addSeriesModal()">＋ 新建文件夹</button></div>\
  <div class="sub">'+(sortMode?'⇅ 排序模式：拖动文件夹换位，松手即保存，前台网站同步生效。点「✅ 完成排序」退出':'共 '+s.total+' 个素材 · 点击文件夹查看和管理')+'</div>\
  <div class="grid">'+s.series.map((x,i)=>'<div class="folder'+(sortMode?' sorting':'')+'" '+(sortMode?'draggable="true" ondragstart="fDrag(event,'+i+')" ondragover="event.preventDefault()" ondrop="fDrop(event,'+i+')"':'onclick="matView.series=\\''+x.folder+'\\';route()"')+'>'+(sortMode?'':'<button class="btn btn-g f-edit" onclick="event.stopPropagation();renameSeriesModal(\\''+x.folder+'\\')">✏️</button>')+'<div class="ic">📁</div><div class="n">'+esc(x.folder)+'</div><div class="c">'+x.materials.length+' 个素材</div></div>').join('')+'</div>';
};
window.delMat=async(series,title)=>{if(!confirm('确定从清单删除「'+title+'」吗？'))return;await api('/console/api/materials/'+encodeURIComponent(series)+'/'+encodeURIComponent(title),{method:'DELETE'});toast('已删除');route()};
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
  <div class="row"><label>素材名称 *</label><input id="m-title" placeholder="例如：线粒体-粉色版"></div>\
  <div class="row"><label>素材图片（PNG 透明底最佳）</label><input id="m-img" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="padding:6px"><div class="sub" style="margin-top:4px">选图上传后网站立即可见；不传图则只登记名称</div></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">取消</button><button class="btn btn-p" onclick="saveMat()">保存</button></div>');
window.saveMat=async()=>{
  const title=document.getElementById('m-title').value.trim();
  const file=document.getElementById('m-img').files[0];
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
    ||'<tr><td colspan="8" style="color:#b0aac4;text-align:center;padding:24px">暂无用户，点「记一笔订单」会自动创建</td></tr>';
  return '<div class="toolbar"><h2>👥 账号管理</h2><div class="sp"></div><input placeholder="搜索昵称/邮箱" value="'+esc(userQ)+'" onchange="userQ=this.value;route()" style="width:200px"><button class="btn btn-g" onclick="creditLogModal()">⚡ 积分流水</button><button class="btn btn-p" onclick="orderModal()">＋ 记一笔订单</button></div>\
  <div class="panel"><table><tr><th>昵称</th><th>邮箱</th><th>会员等级</th><th>AI积分</th><th>开通时间</th><th>订单</th><th>累计付款</th><th></th></tr>'+rows+'</table></div>';
};
window.creditLogModal=async()=>{const d=await api('/console/api/credit-log').catch(()=>({list:[]}));const rows=d.list.map(l=>'<tr><td>'+fmtT(l.time)+'</td><td><b>'+esc(l.name||'')+'</b></td><td style="color:'+(l.delta>0?'#2f9e5f':'#d6336c')+';font-weight:600">'+(l.delta>0?'+':'')+l.delta+'</td><td>'+esc(l.reason||'')+'</td><td>'+esc(l.by||'')+'</td></tr>').join('')||'<tr><td colspan="5" style="text-align:center;color:#b0aac4;padding:20px">暂无流水</td></tr>';
  showModal('<h3>⚡ 积分流水（最近 200 条）</h3><div style="max-height:320px;overflow:auto"><table><tr><th>时间</th><th>用户</th><th>变动</th><th>原因</th><th>操作者</th></tr>'+rows+'</table></div><div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>')};
window.setLevel=async(id,level)=>{await api('/console/api/users/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({level})});toast('已修改 ✅')};
window.adjCredits=async(id)=>{const delta=parseInt(document.getElementById('m-delta').value,10);if(!delta)return toast('填写调整数量');try{await api('/console/api/users/'+id+'/credits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delta,reason:document.getElementById('m-reason').value.trim()})});toast('已调整 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.resetQuota=async(id)=>{if(!confirm('把该账号本月下载额度重置为未使用？（测试用）'))return;try{await api('/console/api/users/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetQuota:true})});toast('本月额度已重置 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.clearPurchases=async(id)=>{if(!confirm('清空该账号的全部单张购买记录？不影响会员等级与订单流水（测试用）'))return;try{const r=await api('/console/api/users/'+id+'/purchases',{method:'DELETE'});toast('已清空 '+r.removed+' 条 ✅');userDetail(id)}catch(e){toast(e.message)}};
window.dtShow=n=>{[1,2,3,4,5].forEach(i=>{document.getElementById('dt-p'+i).style.display=i===n?'block':'none';document.getElementById('dt-b'+i).className='btn btn-xs '+(i===n?'btn-p':'btn-g')})};
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
      const src=m.local?'/files/'+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.file):OSS_P+encodeURIComponent(m.series)+'/'+encodeURIComponent(m.title)+'.webp';
      DL_IMGS.push({src:src,t:m.title});
      const i=DL_IMGS.length-1;
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid #f1eef9"><img src="'+src+'" onerror="this.style.opacity=.2" onclick="viewMatList(DL_IMGS,'+i+')" style="width:56px;height:56px;object-fit:contain;background:#f4f2fa;border-radius:8px;cursor:zoom-in;flex:none"><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(m.title)+'">'+esc(m.title)+'</div><div class="sub" style="font-size:12px">'+esc(m.folder)+' · '+fmtT(m.time)+'</div></div>'+(m.code?'<button class="btn btn-g btn-xs" title="点击复制授权码" onclick="cpTxt(\\''+m.code+'\\')">🔑 '+esc(m.code)+'</button>':'<span style="color:#b0aac4;font-size:12px">无授权码</span>')+'</div>'}).join('')
    :'<div style="text-align:center;color:#b0aac4;padding:20px">还没有下载记录</div>';
  const coListRows=(d.creditOrders&&d.creditOrders.length)
    ?d.creditOrders.map(o=>{
      const stTxt={pending:'待支付',notified:'待人工确认',paid:'已到账'}[o.status]||o.status;
      const stClr={pending:'#b8860b',notified:'#d6336c',paid:'#2f9e5f'}[o.status]||'#8b84a3';
      return '<tr><td>'+fmtT(o.createdAt)+'</td><td><b>'+(o.credits||0)+'</b> 积分</td><td>'+yuan(o.amount)+'</td><td style="color:'+stClr+';font-weight:600">'+stTxt+(o.channel?' · '+esc(o.channel):'')+'</td><td style="font-size:11px;color:#8b84a3">'+(o.transactionId?esc(String(o.transactionId)):'—')+'</td></tr>'}).join('')
    :'<tr><td colspan="5" style="text-align:center;color:#b0aac4;padding:14px">暂无积分订单</td></tr>';
  showModal('<h3>👤 '+esc(d.user.name)+'</h3>\
  <div class="sub" style="margin-bottom:14px">注册：'+esc((d.user.joinedAt||'').slice(0,10))+' · 会员：'+lvName[d.user.level]+(d.user.memberSince?'（'+d.user.memberSince.slice(0,10)+' 开通）':'')+' · AI 积分 <b style="color:#6d4fb0">'+(d.user.credits||0)+' ⚡</b> · 本月已下 '+(d.user.dlUsed||0)+' 张 · 累计付款 <b style="color:#6d4fb0">'+yuan(d.totalPaid)+'</b></div>\
  <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center"><input id="m-delta" type="number" placeholder="积分调整，如 5 或 -3" style="flex:1"><input id="m-reason" placeholder="原因（选填）" style="flex:2"><button class="btn btn-g btn-xs" onclick="adjCredits(\\''+d.user.id+'\\')">调整</button></div>\
  <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><button class="btn btn-g btn-xs" onclick="resetQuota(\\''+d.user.id+'\\')">🧪 重置本月下载额度</button><button class="btn btn-g btn-xs" onclick="clearPurchases(\\''+d.user.id+'\\')">🧪 清空单张购买记录</button></div>\
  <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"><button class="btn btn-xs btn-p" id="dt-b1" onclick="dtShow(1)">⚡ 积分变动记录</button><button class="btn btn-xs btn-g" id="dt-b2" onclick="dtShow(2)">📜 会员变更记录</button><button class="btn btn-xs btn-g" id="dt-b3" onclick="dtShow(3)">🎨 画板与分享</button><button class="btn btn-xs btn-g" id="dt-b4" onclick="dtShow(4)">⬇️ 下载历史</button><button class="btn btn-xs btn-g" id="dt-b5" onclick="dtShow(5)">🧾 积分订单</button></div>\
  <div id="dt-p1" style="max-height:200px;overflow:auto"><table><tr><th>时间</th><th>变动</th><th>原因</th><th>操作者</th></tr>'+coRows+'</table></div>\
  <div id="dt-p2" style="display:none;max-height:200px;overflow:auto"><table><tr><th>时间</th><th>变更</th><th>操作者</th></tr>'+lvRows+'</table></div>\
  <div id="dt-p3" style="display:none;max-height:200px;overflow:auto"><table><tr><th>画板</th><th>最近编辑</th><th>分享状态</th><th>打开过的人</th></tr>'+bdRows+'</table></div>\
  <div id="dt-p4" style="display:none;max-height:260px;overflow:auto">'+dlRows+'</div>\
  <div id="dt-p5" style="display:none;max-height:220px;overflow:auto"><table><tr><th>下单时间</th><th>积分</th><th>金额</th><th>状态 / 渠道</th><th>流水号</th></tr>'+coListRows+'</table></div>\
  <div class="btns"><button class="btn btn-g" onclick="closeModal()">关闭</button></div>');
  document.getElementById('modal').style.width='640px';
};

/* ---------- 4. 素材请求 ---------- */
let reqQ='',reqFilter='all';
H.requests=async()=>{
  const s=await api('/console/api/submissions');
  SUBS=s.list;REQ_IMGS=[];
  const q=reqQ.trim().toLowerCase();
  const flt=s.list.map((r,ci)=>({r,ci})).filter(({r})=>{
    if(reqFilter==='new'&&r.status==='done')return false;
    if(reqFilter==='done'&&r.status!=='done')return false;
    if(q&&((r.desc||'')+(r.contact||'')+(r.series||'')).toLowerCase().indexOf(q)<0)return false;
    return true});
  const cards=flt.map(({r,ci})=>{const d=new Date(r.createdAt);const when=(d.getMonth()+1)+'月'+d.getDate()+'日 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    const imgs=(r.images&&r.images.length?r.images:(r.image?[r.image]:[]));
    const rimgs=imgs.map(im=>'/uploads/'+encodeURIComponent(im)+'?t='+getTK());REQ_IMGS[ci]=rimgs;
    return '<div class="card '+(r.status==='done'?'done':'')+'"><div class="thumb">'+(rimgs.length?rimgs.map((u,j)=>'<img src="'+u+'" onclick="viewMatList(REQ_IMGS['+ci+'],'+j+')" style="cursor:zoom-in">').join(''):'<div class="noimg">🎨<br>无参考图</div>')+'</div>\
    <div class="cbody"><div class="tags">'+(r.type==='custom'?'<span class="tag" style="background:#fdf0f6;color:#c2418e">🖌️ 定制单</span>':'')+(r.status==='done'?'<span class="tag done2">✅ 已上新</span>':'<span class="tag new">🆕 新需求</span>')+(r.series?'<span class="tag">'+esc(r.series)+'</span>':'')+'<span class="time">'+when+'</span></div>\
    <div class="desc">'+esc(r.desc).replace(/\\n/g,'<br>')+'</div>'+(r.contact?'<div class="contact">📮 '+esc(r.contact)+'</div>':'')+'</div>\
    <div class="ops"><button class="btn btn-p" onclick="subAct(\\''+r.id+'\\',\\'toggle\\')">'+(r.status==='done'?'↩️ 标为未完成':'✨ 标为已上新')+'</button><button class="btn btn-g btn-del" onclick="subAct(\\''+r.id+'\\',\\'delete\\')">🗑 删除</button></div></div>'}).join('')
    ||'<div class="panel" style="text-align:center;color:#b0aac4;padding:50px">'+(s.list.length?'🔍<br>没有匹配的请求':'🌷<br>还没有粉丝提交素材需求～')+'</div>';
  const fBtn=(k,t)=>'<button class="btn btn-xs '+(reqFilter===k?'btn-p':'btn-g')+'" onclick="reqFilter=\\''+k+'\\';route()">'+t+'</button>';
  return '<div class="toolbar"><h2>💌 粉丝的素材请求</h2><div class="sp"></div>'+fBtn('all','全部')+fBtn('new','🆕 未上新')+fBtn('done','✅ 已上新')+'<input placeholder="搜索请求内容/邮箱" value="'+esc(reqQ)+'" onchange="reqQ=this.value;route()" style="width:180px"></div>\
  <div class="sub">共 '+s.list.length+' 条'+((reqFilter!=='all'||q)?'，筛出 '+flt.length+' 条':'')+'</div>'+cards;
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
  return '<div class="toolbar"><h2>🩺 网站体检</h2><div class="sp"></div><button class="btn btn-g" onclick="route()">🔄 刷新</button></div>'
    +'<div class="banner '+d.overall+'"><div style="font-size:19px;font-weight:700">'+ov[0]+'</div><div style="font-size:13px;opacity:.92;margin-top:4px">'+ov[1]+'</div></div>'
    +rows
    +'<div class="sub" style="text-align:center;margin-top:10px">体检时间：'+fmtT(d.checkedAt)+' · 本页数据来自服务器实时检查，打开自动更新，无需任何操作</div>';
};

/* ---------- 路由 ---------- */
async function route(){
  if(!getTK()){document.getElementById('loginMask').style.display='flex';return}
  const h=(location.hash||'#/dashboard').slice(2);
  document.querySelectorAll('.side a').forEach(a=>a.classList.toggle('active',a.dataset.r===h));
  const v=document.getElementById('view');
  try{v.innerHTML=await (H[h]||H.dashboard)()}catch(e){v.innerHTML='<div class="panel">加载失败：'+esc(e.message)+'</div>'}
}
window.addEventListener('hashchange',route);
if(getTK()){document.getElementById('acct-name').textContent=localStorage.getItem(NM_KEY)||'管理员';route()}
else{document.getElementById('loginMask').style.display='flex'}
</script></body></html>`;
