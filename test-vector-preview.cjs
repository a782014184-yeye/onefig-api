const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishLocalMaterial } = require('./material-publish');
const { backfillMaterialPreviews } = require('./backfill-material-previews.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-vector-preview-'));
  const dataDir = path.join(root, 'data');
  const webRoot = path.join(root, 'web');
  const originalsDir = path.join(dataDir, 'originals');
  fs.mkdirSync(originalsDir, { recursive: true });
  const sourcePath = path.join(root, 'vector.svg');
  fs.writeFileSync(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><script>alert(1)</script><rect width="400" height="200" fill="#7c5cbf"/><path d="M10 10 L390 190" stroke="white"/></svg>');
  try {
    await publishLocalMaterial({ sourcePath, series: '矢量测试', title: '锐度', ext: '.svg', dataDir, webRoot, originalsDir });
    const clean = path.join(dataDir, 'clean-previews', '矢量测试', '锐度.svg');
    const publicSvg = path.join(webRoot, 'previews', '矢量测试', '锐度.svg');
    const thumb = path.join(webRoot, 'previews', 'thumb', '矢量测试', '锐度.svg');
    for (const file of [clean, publicSvg, thumb]) assert.ok(fs.existsSync(file), `缺少矢量预览：${file}`);
    const publicText = fs.readFileSync(publicSvg, 'utf8');
    assert.ok(publicText.includes('<rect width="400" height="200"'), '原始矢量节点必须保留');
    assert.ok(publicText.includes('<image href="data:image/png;base64,'), '必须内嵌原水印');
    assert.ok(publicText.includes('opacity="0.04"'), '水印透明度必须为 4%');
    assert.ok(!publicText.includes('<script'), 'SVG 安全清理必须生效');
    assert.ok(!fs.existsSync(path.join(webRoot, 'previews', '矢量测试', '锐度.webp')), 'SVG 不得再栅格化为 WebP');
    assert.ok(!fs.existsSync(path.join(dataDir, 'files', '矢量测试', '锐度.svg')), '不得生成公开原图');

    fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), JSON.stringify([
      { folder: '矢量测试', materials: [{ title: '锐度', file: '锐度.svg', local: true }] },
    ]));
    const report = await backfillMaterialPreviews({ dataDir, webRoot, apply: true, force: true });
    assert.equal(report.failed.length, 0);
    assert.equal(report.generated, 1);
    console.log('✓ SVG 矢量、4% 内嵌水印、安全清理、无公开原图及历史回填均通过');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
