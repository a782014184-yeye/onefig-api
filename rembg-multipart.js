// 本地 rembg  multipart 请求：model 字段必须先于 image 文件字段。
// 旧实现先写 image 头、再写 model 字段，导致服务端拿到空图片并报 UnidentifiedImageError。
const crypto = require('crypto');

function buildRembgMultipart(imageBuf, model, filename = 'image.png') {
  const boundary = '----onefig' + crypto.randomBytes(8).toString('hex');
  const safeFilename = String(filename || 'image.png').replace(/["\r\n]/g, '_');
  const safeModel = String(model || '').replace(/["\r\n]/g, '');
  const imageHead = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeFilename}"\r\nContent-Type: image/png\r\n\r\n`);
  const modelField = safeModel ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${safeModel}\r\n`) : Buffer.alloc(0);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(modelField.length ? [modelField, imageHead, imageBuf, tail] : [imageHead, imageBuf, tail]);
  return { boundary, body };
}

module.exports = { buildRembgMultipart };
