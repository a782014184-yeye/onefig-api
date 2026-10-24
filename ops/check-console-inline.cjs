#!/usr/bin/env node
// 后台 HTML 内嵌脚本部署前检查（2026-10-24）
// 目的：拦住「确认弹窗里的换行/引号转义写错，导致后台整页一直加载中」这类错误。
// 只编译 <script> 内容，不执行页面脚本，不产生网络请求或数据副作用。
// 用法：node ops/check-console-inline.cjs [console.js 路径]
const path = require('path');
const { checkConsoleInline } = require('./console-inline-lib.cjs');

const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'console.js'));
let result;
try {
  result = checkConsoleInline(file);
} catch (e) {
  console.error(`❌ 后台页面检查失败：${e.message}`);
  process.exit(1);
}

if (!result.ok) {
  console.error(`❌ ${result.error || '后台 HTML 内嵌脚本检查未通过'}`);
  console.error('   请检查该段模板字符串中的 \\n、引号、反斜杠转义；修复后重新部署。');
  process.exit(1);
}
console.log(`✅ 后台 HTML 内嵌脚本语法检查通过（${result.blocks} 个脚本块）`);
