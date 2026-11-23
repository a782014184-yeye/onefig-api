// 画板缩略图只允许真实位图 data URL；SVG、HTML、带属性字符的伪图片一律拒绝。
const THUMB_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

function isValidThumb(value, maxChars = 200000) {
  if (typeof value !== 'string' || value.length > maxChars) return false;
  const match = THUMB_RE.exec(value);
  if (!match) return false;
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length < 12) return false;
  const type = match[1].toLowerCase();
  if (type === 'png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'jpg' || type === 'jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'gif') return ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6));
  if (type === 'webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

module.exports = { isValidThumb, THUMB_RE };
