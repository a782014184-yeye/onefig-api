// 本地 rembg  multipart 请求：model 字段必须先于 image 文件字段。
// 旧实现先写 image 头、再写 model 字段，导致服务端拿到空图片并报 UnidentifiedImageError。
// extraFields（可选）：额外文本字段，写在 model 之后、image 之前，如 { max_side: "1536" }
const crypto = require('crypto');

function buildRembgMultipart(imageBuf, model, filename = 'image.png', extraFields) {
  const boundary = '----onefig' + crypto.randomBytes(8).toString('hex');
  const safeFilename = String(filename || 'image.png').replace(/["\r\n]/g, '_');
  const safeModel = String(model || '').replace(/["\r\n]/g, '');
  const parts = [];
  if (safeModel) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${safeModel}\r\n`));
  for (const [k, v] of Object.entries(extraFields || {})) {
    const safeK = String(k).replace(/["\r\n]/g, '');
    const safeV = String(v).replace(/["\r\n]/g, '');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safeK}"\r\n\r\n${safeV}\r\n`));
  }
  const imageHead = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeFilename}"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([...parts, imageHead, imageBuf, tail]);
  return { boundary, body };
}

module.exports = { buildRembgMultipart };
