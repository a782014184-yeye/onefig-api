// 后台批量上传脚本单元测试：虚构文件与 Mock API，不启动服务、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const match = source.match(/window\.batchSaveMat=async\(\)=>\{[\s\S]*?\n\};/);
assert.ok(match, '必须找到 batchSaveMat');
const batchSaveMat = eval('(' + match[0].replace('window.batchSaveMat=', '').replace(/;$/, '') + ')');

const files = [{ name: '线粒体.png' }, { name: '同名旧素材.png' }, { name: '叶绿体.final.webp' }];
const calls = [];
let active = 0, maxActive = 0;
const progress = { textContent: '', innerHTML: '' };
const batchBtn = { disabled: false }, saveBtn = { disabled: false };
const elements = { 'm-img': { files }, 'm-progress': progress, 'm-batch-btn': batchBtn, 'm-save-btn': saveBtn };
global.document = { getElementById: id => elements[id] };
global.matView = { series: '测试系列' };
global.esc = value => String(value);
global.toast = () => {};
global.route = () => {};
global.api = async (_path, options) => {
  const title = options.body.get('title');
  active++; maxActive = Math.max(maxActive, active);
  calls.push({ title, file: options.body.get('image') });
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  if (title === '同名旧素材') throw new Error('该文件夹下已存在同名素材');
};

(async () => {
  await batchSaveMat();
  assert.deepEqual(calls.map(x => x.title), ['线粒体', '同名旧素材', '叶绿体.final'], '默认名称必须去掉最后一个扩展名');
  assert.equal(calls.length, 3, '单张失败不能阻断后续图片');
  assert.equal(maxActive, 1, '批量必须串行，避免服务器图片处理并发过高');
  assert.match(progress.innerHTML, /成功 2 张，失败 1 张/);
  assert.match(progress.innerHTML, /同名旧素材/);
  assert.equal(batchBtn.disabled, false);
  assert.equal(saveBtn.disabled, false);
  console.log('✓ 批量文件名命名、失败隔离、串行处理和结果汇总均正确');
})().catch(e => { console.error(e); process.exitCode = 1; });
