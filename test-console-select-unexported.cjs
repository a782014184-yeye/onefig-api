// 发票“全选未导出”逻辑测试：虚构申请，不启动服务、不访问生产。
const assert = require('assert/strict');
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./console.js'), 'utf8');
const match = source.match(/window\.invSelectUnexported=\(\)=>\{([\s\S]*?)\n\};/);
assert.ok(match, '必须存在全选未导出功能');
const INV_ROWS = [
  { id: 'done-1', exportStatus: 'exported' },
  { id: 'new-1', exportStatus: 'unexported' },
  { id: 'new-2', exportStatus: 'unexported' },
];
const INV_SELECTED = new Set(['done-1']);
const checks = [
  { dataset: { invCheck: 'done-1' }, checked: true },
  { dataset: { invCheck: 'new-1' }, checked: false },
  { dataset: { invCheck: 'new-2' }, checked: false },
];
const button = { textContent: '' };
global.document = {
  querySelectorAll: () => checks,
  getElementById: () => button,
};
global.toast = () => {};
const invSelectedText = () => '下载已选（' + INV_SELECTED.size + '）';
eval('(' + match[0].replace('window.invSelectUnexported=', '').replace(/;$/, '') + ')')();

assert.deepEqual(Array.from(INV_SELECTED).sort(), ['new-1', 'new-2'], '只能保留未导出申请，已导出必须取消选择');
assert.equal(checks[0].checked, false);
assert.equal(checks[1].checked, true);
assert.equal(checks[2].checked, true);
assert.equal(button.textContent, '下载已选（2）');
console.log('✓ 全选未导出会排除已导出记录，并同步勾选状态和数量');
