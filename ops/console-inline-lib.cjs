// 后台 HTML 内嵌脚本检查（部署门禁与网站体检共用，2026-10-24）
// 只构造 HTML 并编译其中的 <script>，不执行页面业务逻辑。
const fs = require('fs');
const vm = require('vm');

function checkConsoleInline(file) {
  const source = fs.readFileSync(file, 'utf8');
  const pageMatch = source.match(/const\s+PAGE\s*=\s*`([\s\S]*?)`;/);
  if (!pageMatch) return { ok: false, blocks: 0, error: `未在 ${file} 找到 const PAGE = \`...\` 页面模板` };

  let html;
  try {
    // 与浏览器收到的 HTML 一致：只替换 ${OSS}，不执行页面业务代码
    html = new Function('OSS', `return \`${pageMatch[1]}\``)('');
  } catch (e) {
    return { ok: false, blocks: 0, error: `页面模板求值失败：${e.message}` };
  }

  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) return { ok: false, blocks: 0, error: '后台 HTML 中未找到任何 <script> 块' };

  for (const [i, block] of blocks.entries()) {
    try {
      new vm.Script(block[1], { filename: `console-inline-${i + 1}.js` });
    } catch (e) {
      return { ok: false, blocks: blocks.length, error: `第 ${i + 1} 个内嵌脚本语法错误：${e.message}` };
    }
  }
  return { ok: true, blocks: blocks.length };
}

module.exports = { checkConsoleInline };
