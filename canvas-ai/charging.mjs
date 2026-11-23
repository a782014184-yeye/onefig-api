const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const number = (value, fallback) => Math.max(0, Number(value ?? fallback));

export function createCharging({ loadUsers, saveUsers, logLine = () => {} }) {
  const rules = {
    gen: { cost: number(process.env.ONEFIG_AI_COST, 30), free: number(process.env.ONEFIG_AI_GEN_FREE, 1), freeKey: 'gen' },
    big: { cost: number(process.env.ONEFIG_AI_BIG_COST, 30), free: number(process.env.ONEFIG_AI_BIG_FREE, 1), freeKey: 'big' },
    soul: { cost: number(process.env.ONEFIG_AI_BIG_COST, 30), free: number(process.env.ONEFIG_AI_BIG_FREE, 1), freeKey: 'big' },
    edit: { cost: number(process.env.ONEFIG_AI_EDIT_COST, 10), free: number(process.env.ONEFIG_AI_EDIT_FREE, 1), freeKey: 'edit' },
    style: { cost: number(process.env.ONEFIG_AI_EDIT_COST, 10), free: number(process.env.ONEFIG_AI_EDIT_FREE, 1), freeKey: 'stylize' },
    split: { cost: number(process.env.ONEFIG_AI_SPLIT_COST, 100) },
    nobg: { cost: number(process.env.ONEFIG_AI_NOBG_COST, 5), daily: number(process.env.ONEFIG_AI_LOCAL_FREE, 5), dailyKey: 'nobg' },
    vec: { cost: number(process.env.ONEFIG_AI_VEC_COST, 10), daily: number(process.env.ONEFIG_AI_LOCAL_FREE, 5), dailyKey: 'vec' },
  };

  function refund(ticket) {
    if (!ticket || ticket.refunded) return;
    ticket.refunded = true;
    try {
      const users = loadUsers();
      const user = users.find(item => item.id === ticket.userId);
      if (!user) return;
      if (ticket.paidWith === 'credit') user.credits = (user.credits || 0) + ticket.cost;
      if (ticket.paidWith === 'free' && user.aiFreeUsed) user.aiFreeUsed[ticket.freeKey] = Math.max(0, (user.aiFreeUsed[ticket.freeKey] || 0) - 1);
      if (ticket.paidWith === 'daily' && user.aiDailyUsed?.[ticket.dailyKey]) {
        const entry = user.aiDailyUsed[ticket.dailyKey];
        entry.count = Math.max(0, (entry.count || 0) - 1);
      }
      saveUsers(users);
      logLine('ai-op', `canvas-ai refund user=${ticket.userId} feature=${ticket.feature} paidWith=${ticket.paidWith}`);
    } catch (error) { logLine('error', `canvas-ai refund-fail ${error?.message || error}`); }
  }

  function charge(feature) {
    return (req, res, next) => {
      const rule = rules[feature];
      const users = loadUsers();
      const user = users.find(item => item.id === req.user.id);
      if (!rule || !user) return res.status(403).json({ ok: false, error: '账号状态异常，请重新登录' });
      const ticket = { userId: user.id, feature, cost: rule.cost, paidWith: 'credit', freeKey: rule.freeKey, dailyKey: rule.dailyKey };
      if (rule.daily && ['pro', 'team'].includes(user.level || 'none')) ticket.paidWith = 'member';
      else if (rule.free && user.verified !== false) {
        const freeUsed = user.aiFreeUsed && typeof user.aiFreeUsed === 'object' ? user.aiFreeUsed : (user.aiFreeUsed = {});
        if ((freeUsed[rule.freeKey] || 0) < rule.free) {
          freeUsed[rule.freeKey] = (freeUsed[rule.freeKey] || 0) + 1;
          ticket.paidWith = 'free';
        }
      }
      if (rule.daily && ticket.paidWith === 'credit') {
        const dailyUsed = user.aiDailyUsed && typeof user.aiDailyUsed === 'object' ? user.aiDailyUsed : (user.aiDailyUsed = {});
        const today = day();
        const entry = dailyUsed[rule.dailyKey]?.date === today ? dailyUsed[rule.dailyKey] : { date: today, count: 0 };
        dailyUsed[rule.dailyKey] = entry;
        if ((entry.count || 0) < rule.daily) {
          entry.count = (entry.count || 0) + 1;
          ticket.paidWith = 'daily';
        }
      }
      if (ticket.paidWith === 'credit') {
        if ((user.credits || 0) < rule.cost) return res.status(403).json({ ok: false, error: `本次需要 ${rule.cost} 积分，当前余额不足`, code: 'no-credit', credits: user.credits || 0, cost: rule.cost });
        user.credits -= rule.cost;
      }
      saveUsers(users);
      let refunded = false;
      res.locals.canvasAiTicket = ticket;
      res.locals.canvasAiRefund = () => { if (!refunded) { refunded = true; refund(ticket); } };
      res.on('finish', () => { if (res.statusCode >= 400) res.locals.canvasAiRefund(); });
      logLine('ai-op', `canvas-ai charge user=${user.id} feature=${feature} paidWith=${ticket.paidWith}`);
      next();
    };
  }

  return { charge, refund };
}
