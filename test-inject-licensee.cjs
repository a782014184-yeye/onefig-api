// 临时测试：验证 injectAigcMeta 注入 Licensee 元数据
const zlib = require('zlib');
const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');

// 截取 server.js 顶部常量区 + crc32 + injectAigcMeta（约 20-58 行），eval 到当前作用域
const start = src.indexOf('const PRODUCER_CODE');
const end = src.indexOf('// 生成唯一授权码');
eval(src.slice(start, end));

function makePng() {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function readTextChunks(buf) {
  const out = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt') out.push(buf.toString('latin1', off + 8, off + 8 + len));
    off += 12 + len;
  }
  return out;
}

const before = makePng();
const withLicensee = injectAigcMeta(makePng(), 'OF-2026-TEST01', 'onefig0611@163.com');
const without = injectAigcMeta(makePng(), 'OF-2026-TEST01');

console.log('注入前 tEXt:', readTextChunks(before).length, '（应为 0）');
console.log('带账号注入 tEXt:', readTextChunks(withLicensee).length, '（应为 2）');
readTextChunks(withLicensee).forEach(t => console.log('  -', t.length > 90 ? t.slice(0, 90) + '…' : t));
console.log('不带账号注入 tEXt:', readTextChunks(without).length, '（应为 1，向后兼容）');

// 校验注入后 PNG 仍合法（chunk 遍历无异常且能完整走完）
let off = 8, ok = true;
try {
  while (off < withLicensee.length) { const len = withLicensee.readUInt32BE(off); off += 12 + len; }
  if (off !== withLicensee.length) ok = false;
} catch { ok = false; }
console.log('注入后 PNG 结构合法:', ok ? '✅' : '❌');
