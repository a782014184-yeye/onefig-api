#!/usr/bin/env node
// 后台 HTML 内嵌脚本部署前检查（2026-10-24）
// 目的：拦住「确认弹窗里的换行/引号转义写错，导致后台整页一直加载中」这类错误。
// 只编译 <script> 内容，不执行页面脚本，不产生网络请求或数据副作用。
// 用法：node ops/check-console-inline.cjs [console.js 路径]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'console.js'));
const source = fs.readFileSync(file, 'utf8');
const pageMatch = source.match(/const\s+PAGE\s*=\s*`([\s\S]*?)`;/)
if (!pageMatch) {
  console.error(`❌ 未在 ${file} 找到 const PAGE = \`...\` 页面模板，无法执行后台内嵌脚本检查`);
  process.exit(1);
}
// 先按模板字面量求值得到真实 HTML（只替换 ${OSS}，不执行页面业务代码）。
// 直接检查模板源码会把 \\\\' 之类的转义层级误判为语法错误。
let html;
try {
  html = new Function('OSS', `return \`${pageMatch[1]}\``)('');
} catch (e) {
  console.error(`❌ 后台页面模板求值失败：${e.message}`);
  process.exit(1);
}
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
if (!blocks.length) {
  console.error('❌ 后台 HTML 中未找到任何 <script> 块，检查未通过');
  process.exit(1);
}

let failed = false;
for (const [i, block] of blocks.entries()) {
  try {
    // 与浏览器一致：只做语法编译，不执行（避免产生副作用）
    new vm.Script(block[1], { filename: `console-inline-${i + 1}.js` });
  } catch (e) {
    failed = true;
    console.error(`❌ 后台第 ${i + 1} 个内嵌脚本语法错误：${e.message}`);
    console.error('   请检查该段模板字符串中的 \\n、引号、反斜杠转义；修复后重新部署。');
  }
}
if (failed) process.exit(1);
console.log(`✅ 后台 HTML 内嵌脚本语法检查通过（${blocks.length} 个脚本块）`);
