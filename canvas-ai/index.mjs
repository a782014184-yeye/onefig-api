import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { createCatalog } from './catalog.mjs';
import { registerReferenceRoutes } from './reference.mjs';
import { registerAiIconRoutes } from './ai-icons.mjs';
import { registerWorkshopRoutes } from './workshop.mjs';
import { registerSoulRoute } from './soul.mjs';
import { registerVectorizeRoute } from './vectorize.mjs';
import { registerPromptRoutes } from './prompt-store.mjs';
import { registerRecommendRoutes } from './recommend.mjs';
import { createCharging } from './charging.mjs';

export function registerCanvasAi(app, deps) {
  const { DATA_DIR, ONEFIG_WEB_ROOT, authUser, consoleAuth, loadUsers, saveUsers, logLine } = deps;
  const root = path.join(DATA_DIR, 'canvas-ai');
  fs.mkdirSync(root, { recursive: true });
  const upload = multer({
    storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 },
    fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
  });
  const readKey = () => {
    if (process.env.ARK_API_KEY?.trim()) return process.env.ARK_API_KEY.trim();
    try { return fs.readFileSync(path.join(DATA_DIR, 'ai', 'ark-key.txt'), 'utf8').trim(); } catch { return ''; }
  };
  const readGptsKey = () => process.env.GPTSAPI_API_KEY?.trim() || '';
  const catalog = createCatalog({ dataDir: DATA_DIR, webRoot: ONEFIG_WEB_ROOT });
  const charging = createCharging({ loadUsers, saveUsers, logLine });
  const referenceIndex = path.join(root, 'data', 'references', 'index.json');
  const refundReference = referenceId => {
    try {
      const index = JSON.parse(fs.readFileSync(referenceIndex, 'utf8'));
      const record = index[referenceId];
      if (!record?.charge || record.refundedAt) return;
      record.refundedAt = new Date().toISOString();
      fs.writeFileSync(referenceIndex, JSON.stringify(index, null, 1));
      charging.refund(record.charge);
    } catch (error) { logLine('error', `canvas-ai reference-refund-fail ${error?.message || error}`); }
  };

  // 本模块的所有 AI 接口都要求主站登录；静态结果使用随机 UUID 文件名，沿用现有 AI 文件访问方式。
  app.use('/api/ai', authUser);
  registerPromptRoutes(app, root, consoleAuth);
  registerReferenceRoutes(app, { root, catalog, readKey, readGptsKey, upload, charge: charging.charge, refundReference });
  registerAiIconRoutes(app, { root, readKey, refundReference });
  registerWorkshopRoutes(app, { root, readKey, readGptsKey, upload, charge: charging.charge });
  registerSoulRoute(app, { root, upload, readGptsKey, charge: charging.charge });
  registerRecommendRoutes(app, { upload, readKey, catalog });
  registerVectorizeRoute(app, root, charging.charge);
  logLine('ai-op', 'canvas-ai routes registered');
}
