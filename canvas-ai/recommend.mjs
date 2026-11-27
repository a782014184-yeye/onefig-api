import crypto from 'node:crypto';
import { createTagLibrary } from './tag-library.mjs';

const BASE_URL = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const VISION_MODEL = process.env.ONEFIG_DIAGRAM_MODEL || 'doubao-seed-2-1-pro-260915';
const cache = new Map();

async function vectorSimilarity(file, limit) {
  if (!file) return [];
  try {
    const response = await fetch('http://127.0.0.1:9100/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, limit }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !Array.isArray(data.items) || data.topScore < 0.70) return [];
    return data.items;
  } catch {
    return [];
  }
}

function previewFor(series, item) {
  const fileName = item.file || `${item.title}.png`;
  const previewName = fileName.replace(/\.[^.]+$/, fileName.toLowerCase().endsWith('.svg') ? '.svg' : '.webp');
  return {
    name: item.title,
    folder: series.folder,
    src: `/previews/${encodeURIComponent(series.folder)}/${encodeURIComponent(previewName)}`,
  };
}

function parseAnswer(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('素材识别结果格式无效');
  const data = JSON.parse(text.slice(start, end + 1));
  const subject = String(data.subject || '').trim().slice(0, 40);
  const keywords = (Array.isArray(data.keywords) ? data.keywords : [])
    .map(item => String(item || '').trim()).filter(item => item.length >= 2 && item.length <= 24).slice(0, 8);
  if (!keywords.length && subject) keywords.push(subject);
  if (!keywords.length) throw new Error('没有识别到可用于检索的主体');
  return { subject: subject || keywords[0], keywords };
}

function vectorRootName(name) {
  // 素材标题末尾的颜色、编号只是变体，不应成为主体名称。
  return String(name || '').replace(/(?:[-_](?:\d+|v\d+|米白|浅蓝|蓝色|浅绿|绿色|黄色|棕色|粉色|紫色|淡紫|浅青|浅黄|橙红|橙色|橙粉|蓝绿|红色|白色|黑色|灰色))+$/i, '').trim();
}

export function registerRecommendRoutes(app, { upload, readKey, catalog }) {
  const tagLibrary = createTagLibrary(catalog.loadSeries);
  app.post('/api/ai/recommend-materials', upload.array('images', 6), async (req, res) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, error: '请先选择要识别的图片元素' });
      const signature = crypto.createHash('sha256').update(files.map(file => `${file.buffer.length}:${file.buffer.toString('base64')}`).join('|')).digest('hex');
      const cached = cache.get(signature);
      if (cached && Date.now() - cached.time < 10 * 60 * 1000) return res.json({ ok: true, ...cached.result });
      const key = readKey();
      if (!key) return res.status(503).json({ ok: false, error: '尚未配置视觉识别 API Key' });
      const content = files.map(file => ({ type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` } }));
      content.push({ type: 'text', text: `你是科研素材检索助手。识别图片中的科研主体，并给出能在科研素材库中检索的相关元素名称。
只输出 JSON：{"subject":"主体简称","keywords":["主体","直接相关结构","相关细胞或器材"]}
要求：
- keywords 为 3–8 个简短中文名词，按相关度从高到低排列。
- 同时有多个主体时综合整组图片的共同主题，先判断组合整体轮廓像什么器官、结构或实验对象，再寻找相关元素。
- 例如肺部图片可返回肺、支气管、肺泡、呼吸系统等，但必须与图形实际内容一致。
- 忽略图片中的文字、标题和标签，不把任何文字作为识别依据；只根据图形轮廓、内部结构和视觉语义判断主体。
- 不要返回句子、机制解释、抽象动词或图片中不存在的主题。` });
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: VISION_MODEL, messages: [{ role: 'user', content }], temperature: 0.1, max_tokens: 800, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(90000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || data?.message || '图片主体识别失败');
      const answer = data?.choices?.[0]?.message?.content;
      const answerText = Array.isArray(answer) ? answer.map(part => part?.text || '').join('') : answer;
      const parsed = parseAnswer(answerText);
      let subject = parsed.subject;
      let keywords = parsed.keywords;
      // 主体永远参与第一轮检索；不能只用“呼吸、结构”等相关关键词而漏掉肺本身。
      const semanticText = [subject, ...keywords].join(' ');
      const isTumor = /肿瘤|癌/.test(semanticText);
      const isImmune = /免疫|淋巴|T细胞|B细胞|NK|自然杀伤|巨噬|树突|白细胞|粒细胞|浆细胞|肥大细胞/i.test(semanticText);
      const isMitochondria = /线粒体|线粒体嵴|线粒体内嵴/.test(semanticText);
      let rootSubject = isMitochondria ? '线粒体' : subject;
      const immuneQueries = ['免疫细胞', '白细胞', '淋巴细胞', 'T细胞', 'B细胞', 'NK细胞', '自然杀伤细胞', '巨噬细胞', '单核细胞', '树突状细胞', '中性粒细胞', '嗜酸性粒细胞', '嗜碱性粒细胞', '浆细胞', '肥大细胞', '扁平免疫细胞', '不规则圆形免疫细胞'];
      const queries = [...new Set([subject, ...keywords].filter(item => String(item || '').trim()))];
      // 肿瘤主体同时补齐单细胞、细胞团、细胞簇和球体模型，避免只返回普通细胞。
      if (isTumor) queries.push('肿瘤细胞团', '肿瘤细胞', '癌细胞', '细胞团', '细胞簇', '细胞群', '肿瘤球体模型');
      // 免疫主体扩展主要免疫亚群，避免只返回少数泛化圆形细胞。
      if (isImmune) queries.push(...immuneQueries);
      if (isMitochondria) queries.push('线粒体');
      const scored = new Map();
      queries.forEach((keyword, index) => {
        for (const item of catalog.retrieve(keyword, 24)) {
          // 单个零散二字词根只有 2 分，不能作为相关素材；至少达到 4 分才进入候选。
          if (!(item.score >= 4)) continue;
          const id = `${item.folder}/${item.title}`;
          const current = scored.get(id);
          const directSubjectBonus = index === 0 && item.title.includes(rootSubject) ? 6000 : 0;
          const score = item.score + (queries.length - index) * 12 + directSubjectBonus;
          scored.set(id, { ...item, score: (current?.score || 0) + score });
        }
      });
      // 本地结构化标签补充“同类、结构、机制联想”候选；不增加视觉模型调用。
      for (const item of tagLibrary.retrieve([subject, ...keywords], 48)) {
        const id = `${item.folder}/${item.title}`;
        const current = scored.get(id);
        scored.set(id, { ...item, score: (current?.score || 0) + item.score * 0.6 });
      }
      const byId = new Map(catalog.loadSeries().flatMap(series => series.materials.map(item => [`${series.folder}/${item.title}`, { series, item }])));
      const ranked = [...scored.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
      let selected = ranked.slice(0, 96);
      if (isTumor && !isImmune) {
        // 保留 12 个免疫细胞位置，避免肿瘤主体完全遮住肿瘤微环境中的免疫元素。
        const immuneQueries = ['免疫细胞', '巨噬细胞', 'T细胞', '淋巴细胞', '自然杀伤细胞', '树突状细胞'];
        const immuneMap = new Map();
        immuneQueries.forEach(query => {
          for (const item of catalog.retrieve(query, 16)) {
            if (item.score > 0 && !immuneMap.has(item.title)) immuneMap.set(item.title, item);
          }
        });
        const immune = [...immuneMap.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN')).slice(0, 12);
        selected = [...ranked.slice(0, 84), ...immune].filter((item, index, all) => all.findIndex(candidate => candidate.title === item.title && candidate.folder === item.folder) === index).slice(0, 96);
      }
      const vectorItems = await vectorSimilarity(files[0], 96);
      if (vectorItems.length) {
        const topVector = vectorItems[0];
        const vectorRoot = vectorRootName(topVector.name);
        const secondScore = vectorItems[1]?.score || 0;
        const sameRootVotes = vectorItems.slice(0, 8).filter(item => vectorRootName(item.name) === vectorRoot).length;
        // 只有高分且领先明显，或前 8 个结果中有多个同类支持时，才允许向量证据纠正语义主体。
        const vectorSubjectTrusted = !!vectorRoot && topVector.score >= 0.82 && (topVector.score - secondScore >= 0.06 || sameRootVotes >= 2);
        if (vectorSubjectTrusted) {
          rootSubject = vectorRoot;
          subject = vectorRoot;
          keywords = [vectorRoot];
        }
        const hybrid = new Map();
        selected.forEach((item, index) => {
          const key = `${item.folder}/${item.title}`;
          hybrid.set(key, {
            ...item,
            hybridScore: (1 - index / Math.max(1, selected.length)) * 0.35 + (item.title.includes(rootSubject) ? 0.45 : 0),
          });
        });
        if (vectorSubjectTrusted) {
          // 只补齐真实标题命中的直接同类；catalog 为绘图检索补入的 0 分素材不能进入推荐加分。
          // 1.20 高于普通“语义 0.35＋向量 0.65”的理论上限，确保同类排在联想结果之前。
          for (const item of catalog.retrieve(rootSubject, 48)) {
            if (!(item.score > 0)) continue;
            const key = `${item.folder}/${item.title}`;
            const current = hybrid.get(key);
            hybrid.set(key, { ...item, hybridScore: Math.max(current?.hybridScore || 0, 1.20) });
          }
        }
        vectorItems.forEach(item => {
          const key = `${item.folder}/${item.name}`;
          const current = hybrid.get(key);
          hybrid.set(key, {
            name: item.name, folder: item.folder, title: item.name, src: item.src,
            hybridScore: (current?.hybridScore || 0) + item.score * 0.65,
          });
        });
        const vectorKeys = new Set(vectorItems.map(item => `${item.folder}/${item.name}`));
        selected = [...hybrid.values()].filter(item => {
          if (!vectorSubjectTrusted) return true;
          // 冲突明确时，不再让纯错误语义的候选混入；保留视觉相近或直接同类素材。
          return vectorKeys.has(`${item.folder}/${item.title}`) || item.title.includes(rootSubject);
        }).sort((a, b) => b.hybridScore - a.hybridScore).slice(0, 96);
      }
      const materials = selected.map(item => {
        const found = byId.get(`${item.folder}/${item.title}`);
        return found ? previewFor(found.series, found.item) : null;
      }).filter(Boolean);
      const result = { subject, keywords, materials, vectorEnhanced: vectorItems.length > 0 };
      cache.set(signature, { time: Date.now(), result });
      if (cache.size > 60) cache.delete(cache.keys().next().value);
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('[recommend-materials]', error);
      res.status(502).json({ ok: false, error: String(error?.message || '相关素材推荐失败，请稍后重试').slice(0, 200) });
    }
  });
}
