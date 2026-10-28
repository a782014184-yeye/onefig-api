// 后台大图与父弹窗层级测试：只执行弹窗函数，不启动服务、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const pick = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `找不到脚本段：${start}`);
  return source.slice(a, b);
};
const modal = { innerHTML: '', dataset: {}, style: { width: '' } };
const mask = { style: { display: 'none' } };
const document = { getElementById: id => id === 'modal' ? modal : mask };
const window = {};
const esc = value => String(value);
eval(
  pick('function showModal', '/* 大图浏览') + '\n' +
  pick('let VIEW_LIST', 'document.addEventListener') + '\n' +
  pick('function closeModal', "document.getElementById('mask').onclick")
);

showModal('<div>素材详情弹窗</div>');
window.viewMatList([{ src: 'a.png', t: '大图 1' }, { src: 'b.png', t: '大图 2' }], 0);
assert.match(modal.innerHTML, /a.png/);
assert.equal(mask.style.display, 'flex');
closeModal();
assert.equal(modal.innerHTML, '<div>素材详情弹窗</div>', '关闭大图必须恢复父弹窗');
assert.equal(mask.style.display, 'flex', '父弹窗必须保持打开');
assert.equal(modal.dataset.nav, undefined, '恢复后不能残留大图导航状态');
closeModal();
assert.equal(mask.style.display, 'none', '再次关闭才完全退出');

showModal('<div>另一个详情</div>');
window.viewMatList([{ src: 'single.png' }], 0);
closeModal();
assert.equal(modal.innerHTML, '<div>另一个详情</div>', '切换图片后仍应返回原详情');

console.log('✓ 关闭大图返回父弹窗，再次关闭才退出，导航状态正确清理');
