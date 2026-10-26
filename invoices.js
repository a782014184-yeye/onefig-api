const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 发票申请：只保存用户申请与处理状态，不在网站侧选择税收分类、税率或直接开具发票。
// 可开票范围按当前业务收敛为：单个素材授权、画板单次导出；会员/积分订单暂不混入。
module.exports = function registerInvoices(app, deps) {
  const { authUser, DATA_DIR, logLine, submitRateLimit } = deps;
  const CONSOLE_DIR = path.join(DATA_DIR, 'console');
  const ORDERS_FILE = path.join(CONSOLE_DIR, 'orders.json');
  const INVOICES_FILE = path.join(CONSOLE_DIR, 'invoices.json');
  const loadJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const saveJSON = (file, rows) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, file);
  };
  const loadOrders = () => loadJSON(ORDERS_FILE, []);
  const loadInvoices = () => loadJSON(INVOICES_FILE, []);
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const businessOf = order => order.kind === 'single' ? 'MATERIAL_LICENSE' : (order.kind === 'export' ? 'CANVAS_EXPORT' : null);
  const titleOf = order => order.kind === 'single'
    ? (clean(order.materialTitle, 120) || `素材使用授权（${clean(order.materialId, 80)}）`)
    : '画板导出（单次）';
  const publicApplication = row => ({
    id: row.id,
    orderId: row.orderId,
    businessType: row.businessType,
    orderTitle: row.orderTitle,
    amount: row.amount,
    buyerType: row.buyerType,
    title: row.title,
    taxId: row.taxId || '',
    invoiceType: row.invoiceType,
    email: row.email,
    note: row.note || '',
    status: row.status,
    statusNote: row.statusNote || '',
    invoiceNumber: row.invoiceNumber || '',
    createdAt: row.createdAt,
    issuedAt: row.issuedAt || null,
  });
  const eligibleOrders = (userId, invoices) => {
    const locked = new Set(invoices.filter(row => row.userId === userId && ['pending', 'issued', 'red_flushed'].includes(row.status)).map(row => row.orderId));
    return loadOrders()
      .filter(order => order.userId === userId && order.status === 'paid' && Number(order.amount) > 0 && businessOf(order) && !locked.has(order.id))
      .sort((a, b) => String(b.paidAt || b.createdAt).localeCompare(String(a.paidAt || a.createdAt)))
      .map(order => ({
        id: order.id,
        businessType: businessOf(order),
        title: titleOf(order),
        amount: Number(order.amount),
        paidAt: order.paidAt || order.createdAt,
        ...(order.kind === 'single' ? { materialId: clean(order.materialId, 80) } : {}),
      }));
  };

  app.get('/api/invoices', authUser, (req, res) => {
    const invoices = loadInvoices();
    const applications = invoices
      .filter(row => row.userId === req.user.id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicApplication);
    res.json({ ok: true, orders: eligibleOrders(req.user.id, invoices), applications });
  });

  app.post('/api/invoices', authUser, submitRateLimit, (req, res) => {
    const body = req.body || {};
    const orderId = clean(body.orderId, 100);
    const buyerType = body.buyerType === 'personal' ? 'personal' : (body.buyerType === 'company' ? 'company' : '');
    const invoiceType = body.invoiceType === 'special' ? 'special' : (body.invoiceType === 'normal' ? 'normal' : '');
    const title = clean(body.title, 100);
    const taxId = clean(body.taxId, 20).toUpperCase().replace(/\s/g, '');
    const email = clean(body.email, 160).toLowerCase();
    const note = clean(body.note, 200);
    if (!orderId) return res.status(400).json({ ok: false, error: '缺少订单信息' });
    if (!buyerType) return res.status(400).json({ ok: false, error: '请选择个人或单位抬头' });
    if (!title) return res.status(400).json({ ok: false, error: '请填写发票抬头' });
    if (buyerType === 'company' && !/^[0-9A-Z]{15,20}$/.test(taxId)) {
      return res.status(400).json({ ok: false, error: '请填写正确的纳税人识别号' });
    }
    if (buyerType === 'personal' && invoiceType === 'special') {
      return res.status(400).json({ ok: false, error: '个人抬头请选择普通发票' });
    }
    if (!invoiceType) return res.status(400).json({ ok: false, error: '请选择发票类型' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: '请填写正确的接收邮箱' });
    if (body.confirmed !== true) return res.status(400).json({ ok: false, error: '请确认开票资料真实、准确' });

    const order = loadOrders().find(row => row.id === orderId && row.userId === req.user.id);
    if (!order || order.status !== 'paid' || Number(order.amount) <= 0 || !businessOf(order)) {
      return res.status(400).json({ ok: false, error: '该订单不存在、未支付或不属于当前可开票范围' });
    }
    const invoices = loadInvoices();
    const existing = invoices.find(row => row.orderId === orderId && ['pending', 'issued', 'red_flushed'].includes(row.status));
    if (existing) return res.status(409).json({ ok: false, error: '该订单已有开票申请，请勿重复提交', application: publicApplication(existing) });

    const now = new Date().toISOString();
    const application = {
      id: 'INV-' + now.slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      userId: req.user.id,
      userName: clean(req.user.name, 100),
      orderId,
      businessType: businessOf(order),
      orderTitle: titleOf(order),
      amount: Number(order.amount),
      buyerType,
      title,
      taxId: buyerType === 'company' ? taxId : '',
      invoiceType,
      email,
      note,
      confirmed: true,
      confirmedAt: now,
      status: 'pending',
      createdAt: now,
    };
    invoices.push(application);
    saveJSON(INVOICES_FILE, invoices);
    if (logLine) logLine('invoice', `application-created id=${application.id} user=${req.user.id} order=${orderId} kind=${application.businessType}`);
    res.status(201).json({ ok: true, application: publicApplication(application) });
  });
};
