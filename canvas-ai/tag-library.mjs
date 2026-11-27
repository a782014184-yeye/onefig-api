const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\-_—–·，。；：、（）()\[\]【】]/g, '');
const variantSuffix = /(?:[-_](?:\d+|v\d+|米白|浅蓝|蓝色|浅绿|绿色|黄色|棕色|粉色|紫色|淡紫|浅青|浅黄|橙红|橙色|橙粉|蓝绿|红色|白色|黑色|灰色))+$/i;

// 主题标签只描述素材库中的对象，不读取用户图片里的文字。
const TOPIC_RULES = [
  { match: /线粒体/, tags: ['细胞结构', '细胞器', '膜结构', '能量代谢', '细胞呼吸'] },
  { match: /细胞核|核膜|核仁|核孔/, tags: ['细胞结构', '细胞器', '膜结构', '遗传信息'] },
  { match: /细胞膜|磷脂|膜蛋白/, tags: ['细胞结构', '膜结构', '物质运输'] },
  { match: /内质网|高尔基|溶酶体|液泡|中心体|核糖体|过氧化物酶体/, tags: ['细胞结构', '细胞器'] },
  { match: /免疫|淋巴|T细胞|B细胞|NK细胞|巨噬细胞|树突状细胞|白细胞|粒细胞/i, tags: ['细胞结构', '免疫应答', '炎症反应'] },
  { match: /肿瘤|癌/, tags: ['细胞结构', '肿瘤微环境', '免疫应答', '异常增殖'] },
  { match: /试管|离心管|EP管|培养皿|锥形瓶|烧杯|烧瓶|量筒|移液器|移液枪|注射器|培养瓶/i, tags: ['实验器材', '液体容器', '实验操作'] },
  { match: /肺|支气管|肺泡|呼吸道|气管/, tags: ['呼吸系统', '器官', '气体交换'] },
  { match: /线粒体DNA|DNA|RNA|基因|染色体|核酸/i, tags: ['遗传信息', '分子生物学', '核酸'] },
  { match: /蛋白|受体|配体|抗体|酶/, tags: ['分子生物学', '蛋白结构', '分子互作'] },
  { match: /细菌|真菌|病毒|微生物|噬菌体/, tags: ['微生物', '感染与宿主'] },
];

const STRUCTURE_RULES = [
  { match: /同心|圆环|环形|环状/, tags: ['环形结构', '同心结构', '闭合轮廓'] },
  { match: /圆形|球形|圆球|球体|圆盘/, tags: ['圆形结构', '闭合轮廓'] },
  { match: /椭圆|梭形|长杆|长条|杆状/, tags: ['长形结构', '闭合轮廓'] },
  { match: /矩形|长方形|方形|方框|圆角/, tags: ['矩形结构', '框体'] },
  { match: /膜|双层/, tags: ['膜结构'] },
  { match: /剖面|横切|纵切|切面/, tags: ['剖面结构', '内部结构'] },
  { match: /细胞核|核仁|内嵴|内部/, tags: ['内部结构'] },
  { match: /分支|分叉|树突|网络/, tags: ['分支结构'] },
  { match: /不规则|星形|突起|棘|表面纤维/, tags: ['不规则轮廓', '表面突起'] },
];

export function materialProfile(folder, title) {
  const subject = String(title || '').replace(variantSuffix, '').trim();
  const text = `${folder} ${subject}`;
  const tags = new Set([folder, subject].filter(Boolean));
  for (const rule of [...TOPIC_RULES, ...STRUCTURE_RULES]) {
    if (rule.match.test(text)) rule.tags.forEach(tag => tags.add(tag));
  }
  return { subject, tags: [...tags] };
}

export function createTagLibrary(loadSeries) {
  const entries = loadSeries().flatMap(series => series.materials.map(item => ({
    title: item.title,
    folder: series.folder,
    ...materialProfile(series.folder, item.title),
  })));
  const normalized = entries.map(entry => ({
    ...entry,
    normalizedSubject: norm(entry.subject),
    normalizedTags: new Set(entry.tags.map(norm)),
  }));

  const retrieve = (query, limit = 32) => {
    const text = Array.isArray(query) ? query.join(' ') : String(query || '');
    if (!text.trim()) return [];
    const profile = materialProfile('查询', text);
    const queryText = norm(text);
    const queryTags = new Set(profile.tags.map(norm));
    const scored = [];
    for (const entry of normalized) {
      let score = 0;
      if (entry.normalizedSubject && (queryText.includes(entry.normalizedSubject) || entry.normalizedSubject.includes(queryText))) score += 100 + entry.normalizedSubject.length * 4;
      for (const tag of queryTags) {
        if (!tag || !entry.normalizedTags.has(tag)) continue;
        if (tag === norm(entry.subject)) score += 70;
        else if (/结构|轮廓|框体/.test(tag)) score += 14;
        else if (tag !== norm('查询')) score += 8;
      }
      // 只有共同文件夹不足以进入联想推荐，避免“同目录”淹没真正的结构或主题关系。
      if (score >= 12) scored.push({ title: entry.title, folder: entry.folder, score, tags: entry.tags });
    }
    return scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN')).slice(0, limit);
  };

  return { entries, retrieve, size: entries.length };
}
