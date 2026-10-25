// OneFig SEO 公开页（服务端直出）：sitemap.xml + 素材详情页 /m/ + 系列页 /s/
// 面向搜索引擎爬虫与社交分享链接；真人在这些页面也能完整浏览，并一键跳回主站。
// 2026-10-08 新增。所有输出均经 esc() 转义；素材数据只读。
const fs = require('fs');
const path = require('path');

const SITE = 'https://onefig.cn';
const SITE_NAME = 'OneFig 无花有果';
const SITE_DESC = '高清科研绘图素材库：细胞、器官、实验仪器、信号通路等专业插画，会员可下载，也支持单张购买，适用于论文配图、课题汇报与科普设计。';
const ICP = '浙ICP备2026079784号';

module.exports = function registerSeo(app, deps) {
  const { esc, DATA_DIR } = deps;
  const MAT_FILE = path.join(DATA_DIR, 'console', 'materials.json');
  const loadSeries = () => { try { return JSON.parse(fs.readFileSync(MAT_FILE, 'utf8')); } catch { return []; } };
  // 预览图带版本参数（2026-10-19 水印烘焙上线后破 7 天缓存，让旧干净图立即失效）
  const previewUrl = (folder, file) => `${SITE}/previews/${encodeURIComponent(folder)}/${encodeURIComponent(String(file || '').replace(/\.png$/i, '.webp'))}?v=wm8`;
  const matPath = m => `/m/${encodeURIComponent(m.series)}/${encodeURIComponent(m.title)}`;
  const seriesPath = f => `/s/${encodeURIComponent(f)}`;
  const fmtSize = b => { b = Number(b) || 0; if (!b) return '—'; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };

  // 2026-10-23 换皮：版式对齐主站（紫品牌色、圆角卡片、同款顶栏/页脚），搜索进来的第一印象不再掉价
  const CSS = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f8f7fc;color:#2e2a3b;min-height:100vh;display:flex;flex-direction:column}
    a{color:#7c5cbf;text-decoration:none}
    /* 顶栏：与主站一致的 sticky 毛玻璃 */
    .hd{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.82);backdrop-filter:blur(12px);border-bottom:1px solid #ece8f5}
    .hdin{max-width:1120px;margin:0 auto;height:64px;display:flex;align-items:center;gap:16px;padding:0 20px}
    .brand img{height:36px;width:auto;display:block}
    .hd nav{flex:1;display:flex;justify-content:center;gap:6px}
    .hd nav a{padding:6px 12px;border-radius:999px;font-size:14px;font-weight:500;color:#7a7490;transition:.15s}
    .hd nav a:hover{color:#2e2a3b}
    .hd nav a.on{background:rgba(124,92,191,.1);font-weight:700;color:#7c5cbf}
    .login{flex-shrink:0;background:#7c5cbf;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;border-radius:10px;transition:.15s}
    .login:hover{background:#6a4dad}
    .wrap{flex:1;max-width:1000px;width:100%;margin:0 auto;padding:28px 20px 50px}
    .card{background:#fff;border:1px solid #ece8f5;border-radius:16px;padding:28px;box-shadow:0 1px 3px rgba(60,45,100,.06)}
    .crumb{font-size:12px;color:#a39dbc;margin-bottom:14px}
    .crumb a{color:#a39dbc}.crumb a:hover{color:#7c5cbf}
    .hero{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
    .hero img{width:340px;max-width:100%;border-radius:12px;background:repeating-conic-gradient(#f1eef8 0 25%,#fff 0 50%) 0 0/20px 20px;border:1px solid #ece8f5}
    .hero .info{flex:1;min-width:240px}
    h1{font-size:22px;margin-bottom:8px}
    .meta{font-size:13px;color:#7a7490;line-height:2}
    .meta b{color:#2e2a3b;font-weight:600}
    .cta{display:inline-block;margin-top:16px;background:linear-gradient(135deg,#7c5cbf,#a78bfa);color:#fff;font-weight:600;padding:12px 26px;border-radius:10px;font-size:14px;box-shadow:0 4px 12px rgba(124,92,191,.25);transition:.15s}
    .cta:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(124,92,191,.35)}
    .desc{font-size:14px;line-height:1.9;color:#5a5472;margin-top:18px}
    .aibadge{display:inline-block;background:rgba(124,92,191,.1);color:#7c5cbf;font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:top;margin-top:4px}
    .note{margin-top:14px;font-size:12px;line-height:1.8;color:#a39dbc;background:#f8f7fc;border-radius:8px;padding:10px 12px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;margin-top:16px}
    .mcard{background:#fff;border:1px solid #ece8f5;border-radius:12px;padding:10px;text-align:center;transition:.15s}
    .mcard:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(124,92,191,.15);border-color:rgba(124,92,191,.35)}
    .mcard img{width:100%;height:100px;object-fit:contain;background:repeating-conic-gradient(#f1eef8 0 25%,#fff 0 50%) 0 0/16px 16px;border-radius:8px}
    .mcard .t{font-size:12px;font-weight:600;margin-top:8px;color:#2e2a3b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    h2{font-size:16px;margin:26px 0 6px}
    /* 页脚：与主站一致 */
    .ft{border-top:1px solid #ece8f5;background:#fff;margin-top:auto}
    .ftin{max-width:1120px;margin:0 auto;padding:24px 20px;display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;justify-content:space-between}
    .ftbrand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
    .ftbrand img{height:28px;width:28px}
    .ftslogan{font-size:12px;color:#a39dbc;margin-top:6px}
    .ftlinks{display:flex;gap:48px;font-size:13px}
    .ftlinks h4{font-size:12px;color:#a39dbc;font-weight:600;margin-bottom:8px}
    .ftlinks a{display:block;color:#5a5472;padding:3px 0}
    .ftlinks a:hover{color:#7c5cbf}
    .icp{text-align:center;font-size:12px;color:#b5aec7;padding:14px;border-top:1px solid #f3f0f9;background:#fff}
    .icp a{color:#b5aec7}.icp a:hover{color:#7c5cbf}
    @media(max-width:640px){.hero img{width:100%}.hd nav{display:none}.ftlinks{gap:28px}}
  `;
  const head = (title, desc, img, jsonld, canonical) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${img ? `<meta property="og:image" content="${esc(img)}">` : ''}
${jsonld ? `<script type="application/ld+json">${jsonld.replace(/</g, '\\u003c')}</script>` : ''}
<style>${CSS}</style></head><body>`;
  const topbar = `<header class="hd"><div class="hdin">
<a class="brand" href="/"><img src="/brand/logo.png" alt="${SITE_NAME}"></a>
<nav><a href="/">首页</a><a href="/materials" class="on">AI素材库</a><a href="/request">求素材</a><a href="/ai">AI工坊</a><a href="/boards">画板</a></nav>
<a class="login" href="/login">登录 / 注册</a>
</div></header>`;
  const footer = `<footer class="ft"><div class="ftin">
<div><div class="ftbrand"><img src="/brand/icon.png" alt="OneFig">OneFig</div><div class="ftslogan">一颗无花果，万千科研图</div></div>
<div class="ftlinks">
<div><h4>产品</h4><a href="/materials">素材库</a><a href="/pricing">订阅方案</a></div>
<div><h4>支持</h4><a href="/request">求素材</a><a href="/verify">授权验真</a></div>
<div><h4>关于</h4><a href="/terms">用户协议</a><a href="/privacy">隐私政策</a></div>
</div></div>
<div class="icp">${SITE_NAME} · 科研绘图素材库 · <a href="https://beian.miit.gov.cn/" rel="nofollow">${ICP}</a></div>
</footer></body></html>`;

  // ---------- sitemap.xml ----------
  app.get('/sitemap.xml', (req, res) => {
    const series = loadSeries();
    const today = new Date().toISOString().slice(0, 10);
    // 静态公开页一律带尾斜杠（issue-03：无斜杠会 301，sitemap 必须直达 200 的最终地址）
    const urls = [
      { loc: '/', priority: '1.0', lastmod: today },
      { loc: '/materials/', priority: '0.9', lastmod: today },
      { loc: '/pricing/', priority: '0.6' },
      { loc: '/ai/', priority: '0.6' },
      { loc: '/request/', priority: '0.5' },
      { loc: '/custom/', priority: '0.5' },
      { loc: '/verify/', priority: '0.4' },
      { loc: '/terms/', priority: '0.3' },
      { loc: '/privacy/', priority: '0.3' },
      { loc: '/license/', priority: '0.3' },
      { loc: '/certificate/', priority: '0.3' },
    ];
    series.forEach(s => {
      const lastmod = s.materials.map(m => m.createdAt).sort().pop() || today;
      urls.push({ loc: seriesPath(s.folder), priority: '0.8', lastmod });
      s.materials.forEach(m => urls.push({ loc: matPath(m), priority: '0.7', lastmod: m.createdAt || today }));
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${SITE}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`).join('\n') +
      `\n</urlset>\n`;
    res.type('application/xml').send(xml);
  });

  // ---------- 素材详情页 /m/:series/:title ----------
  app.get('/m/:series/:title', (req, res) => {
    const { series, title } = req.params;
    const all = loadSeries();
    const sd = all.find(s => s.folder === series);
    const m = sd && sd.materials.find(x => x.title === title);
    if (!m) {
      return res.status(404).send(head('素材不存在 - ' + SITE_NAME, SITE_DESC, null, null) + topbar +
        `<div class="wrap"><div class="card" style="text-align:center;padding:60px 20px"><h1>没有找到这张素材</h1><p class="desc">它可能已下架或链接有误。</p><a class="cta" href="/materials">去素材库看看</a></div></div>` + footer);
    }
    const img = previewUrl(m.series, m.file);
    const pageTitle = `${m.title} - ${m.series}素材高清下载 - ${SITE_NAME}`;
    const desc = `${m.title}，${m.series}高清科研绘图素材，${SITE_NAME}提供会员下载与单张购买（¥6.9 起），可用于论文配图、学术汇报与科普设计。`;
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'ImageObject',
      name: m.title, contentUrl: img, description: desc,
      datePublished: m.createdAt || undefined,
      creator: { '@type': 'Organization', name: SITE_NAME },
    });
    const related = sd.materials.filter(x => x.title !== m.title).slice(0, 8);
    res.send(head(pageTitle, desc, img, jsonld, SITE + matPath(m)) + topbar + `<div class="wrap">
<div class="crumb"><a href="/">首页</a> › <a href="/materials">素材库</a> › <a href="${seriesPath(m.series)}">${esc(m.series)}</a> › ${esc(m.title)}</div>
<div class="card"><div class="hero">
  <img src="${img}" alt="${esc(m.title)} - ${esc(m.series)}科研绘图素材">
  <div class="info">
    <h1>${esc(m.title)}<span class="aibadge">AI</span></h1>
    <div class="meta">所属系列：<a href="${seriesPath(m.series)}">${esc(m.series)}</a><br>文件大小：${fmtSize(m.size)}<br>价格：会员可下载 / 单张 ¥6.9<br>授权：学术发表（非商用 · 须署名）<br>上架时间：${esc(m.createdAt || '—')}<br>已被下载：${m.downloads || 0} 次</div>
    <a class="cta" href="/materials?focus=${encodeURIComponent(m.id)}">会员可下载 · ¥6.9 起 →</a>
    <p class="desc">${esc(m.title)}是${esc(m.series)}中的高清科研插画素材，适用于论文配图、课题汇报 PPT、基金申请书与科普推文。注册登录后可开通会员下载，或单张 ¥6.9 购买；也可在在线画板中直接编辑组合。</p>
    <p class="note">素材均为 AI 辅助生成：投稿前请留意目标期刊的 AI 使用规则；受当前模型能力限制，素材形态可能存在误差，使用前请自行核验正确性。</p>
  </div>
</div></div>
${related.length ? `<h2>同系列素材</h2><div class="grid">` + related.map(x => `<a class="mcard" href="${matPath(x)}"><img src="${previewUrl(x.series, x.file)}" alt="${esc(x.title)}"><div class="t">${esc(x.title)}</div></a>`).join('') + `</div>` : ''}
</div>` + footer);
  });

  // ---------- 系列页 /s/:series ----------
  app.get('/s/:series', (req, res) => {
    const all = loadSeries();
    const sd = all.find(s => s.folder === req.params.series);
    if (!sd) {
      return res.status(404).send(head('系列不存在 - ' + SITE_NAME, SITE_DESC, null, null) + topbar +
        `<div class="wrap"><div class="card" style="text-align:center;padding:60px 20px"><h1>没有找到这个系列</h1><a class="cta" href="/materials">去素材库看看</a></div></div>` + footer);
    }
    const names = sd.materials.slice(0, 6).map(m => m.title).join('、');
    const pageTitle = `${sd.folder} - 高清科研绘图素材合集 - ${SITE_NAME}`;
    const desc = `${sd.folder}系列收录 ${sd.materials.length} 张高清科研绘图素材，包括${names}等，会员可下载或单张购买，适用于论文配图与学术汇报。`;
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: sd.folder, description: desc,
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
    });
    res.send(head(pageTitle, desc, sd.materials[0] ? previewUrl(sd.folder, sd.materials[0].file) : null, jsonld, SITE + seriesPath(sd.folder)) + topbar + `<div class="wrap">
<div class="crumb"><a href="/">首页</a> › <a href="/materials">素材库</a> › ${esc(sd.folder)}</div>
<h1>${esc(sd.folder)}</h1>
<p class="desc">本系列共收录 ${sd.materials.length} 张高清素材，包括${esc(names)}等。全部素材支持会员下载、单张购买、在线画板编辑与 AI 处理，适用于论文配图、课题汇报与科普设计。</p>
<div class="grid">${sd.materials.map(x => `<a class="mcard" href="${matPath(x)}"><img src="${previewUrl(x.series, x.file)}" alt="${esc(x.title)}"><div class="t">${esc(x.title)}</div></a>`).join('')}</div>
</div>` + footer);
  });
};
