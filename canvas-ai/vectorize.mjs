import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';
import bounds from 'svg-path-bounds';

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export function registerVectorizeRoute(app, root, charge) {
  const referenceDir = path.join(root, 'data/references');
  const vectorDir = path.join(root, 'data/vectors');
  const indexFile = path.join(referenceDir, 'index.json');
  fs.mkdirSync(vectorDir, { recursive: true });
  app.use('/vectors', (req, res, next) => {
    const file = path.join(vectorDir, path.basename(req.path));
    if (!fs.existsSync(file)) return next();
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(file);
  });

  app.post('/api/ai/vectorize', charge('vec'), async (req, res) => {
    const referenceId = String(req.body?.referenceId || '');
    const index = readJson(indexFile, {});
    const record = index[referenceId];
    if (!record || record.userId !== req.user.id) return res.status(404).json({ ok: false, error: '参考图不存在或已过期' });
    try {
      const source = path.join(referenceDir, path.basename(record.file));
      const { data, info } = await sharp(source)
        .resize({ width: 1280, height: 720, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const svg = ImageTracer.imagedataToSVG(
        { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
        {
          numberofcolors: 24,
          colorquantcycles: 3,
          colorsampling: 2,
          ltres: 2.5,
          qtres: 2.5,
          pathomit: 40,
          rightangleenhance: true,
          strokewidth: 0,
          blurradius: 1,
          blurdelta: 32,
          roundcoords: 1,
          viewbox: true,
          desc: false,
        },
      );
      const cleanedSvg = svg.replace(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/g, (match, d) => {
        try {
          const [x0, y0, x1, y1] = bounds(d);
          const width = x1 - x0;
          const height = y1 - y0;
          // 删除几像素的碎点；长箭头、细线和大主体不受影响。
          return width <= 12 && height <= 12 && width * height <= 144 ? '' : match;
        } catch { return match; }
      });
      const withBackground = cleanedSvg.replace(/<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#ffffff"/>');
      const file = `${referenceId}.svg`;
      fs.writeFileSync(path.join(vectorDir, file), withBackground);
      res.json({ ok: true, url: `/vectors/${file}`, width: info.width, height: info.height, paths: (withBackground.match(/<path/g) || []).length, bytes: Buffer.byteLength(withBackground) });
    } catch (error) {
      console.error('[vectorize]', error);
      res.status(502).json({ ok: false, error: 'SVG 矢量转换失败，请重试' });
    }
  });
}
