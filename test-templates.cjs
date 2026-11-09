const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { registerTemplateRoutes } = require('./templates');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-templates-'));
  const app = express();
  app.use(express.json({ limit: '14mb' }));
  const authUser = (req, res, next) => { req.user = { id: 'isolated-test-user' }; next(); };
  const consoleAuth = (req, res, next) => next();
  registerTemplateRoutes(app, { dataDir, authUser, consoleAuth });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><script>alert(1)</script><rect width="100" height="80" onclick="alert(1)" fill="#fff"/><text x="10" y="30">测试</text></svg>';
    const form = new FormData();
    form.append('name', '接口测试模板');
    form.append('source', new Blob(['%PDF-1.7 test']), 'source.ai');
    form.append('svg', new Blob([safeSvg], { type: 'image/svg+xml' }), 'editable.svg');
    const upload = await (await fetch(`${base}/console/api/templates/upload`, { method: 'POST', body: form })).json();
    assert.equal(upload.ok, true);
    assert.equal(upload.template.status, 'published');
    assert.equal(upload.template.hasSource, true);

    const list = await (await fetch(`${base}/api/templates`)).json();
    assert.equal(list.templates.length, 1);
    const svg = await (await fetch(`${base}${upload.template.svgUrl}`)).text();
    assert(!svg.includes('<script>'));
    assert(!svg.includes('onclick'));

    const created = await (await fetch(`${base}/api/designs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '云端作品', templateId: upload.template.id, svg: safeSvg, width: 100, height: 80 }) })).json();
    assert.equal(created.ok, true);
    const designDir = path.join(dataDir, 'designs');
    const userDir = fs.readdirSync(designDir)[0];
    const index = JSON.parse(fs.readFileSync(path.join(designDir, userDir, 'index.json'), 'utf8'));
    assert.equal(index[0].svg, undefined, '作品索引不应重复保存 SVG 正文');

    const loaded = await (await fetch(`${base}/api/designs/${created.design.id}`)).json();
    assert.equal(loaded.ok, true);
    assert(loaded.design.svg.includes('<svg'));
    const updated = await (await fetch(`${base}/api/designs/${created.design.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...loaded.design, name: '已更新作品' }) })).json();
    assert.equal(updated.design.name, '已更新作品');
    const removed = await (await fetch(`${base}/api/designs/${created.design.id}`, { method: 'DELETE' })).json();
    assert.equal(removed.ok, true);
    console.log(JSON.stringify({ ok: true, templateUpload: true, svgSanitized: true, cloudDesignCrud: true, compactIndex: true }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
