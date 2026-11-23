const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sniff(buffer) {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return 'image/png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return 'image/jpeg';
  if (buffer?.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  return 'image/png';
}

async function fetchImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`生成图片下载失败（${response.status}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mime: response.headers.get('content-type')?.split(';')[0] || sniff(buffer) };
}

async function generateGpt({ prompt, key, size, quality, file }) {
  const model = process.env.GPTSAPI_GPT_IMAGE_MODEL || 'gpt-image-2.6-flare';
  let body, headers;
  if (file) {
    body = new FormData();
    body.append('model', model);
    body.append('image', new Blob([file.buffer], { type: file.mimetype }), `reference.${file.mimetype === 'image/jpeg' ? 'jpg' : file.mimetype === 'image/webp' ? 'webp' : 'png'}`);
    body.append('prompt', prompt);
    body.append('size', size);
    body.append('quality', quality);
    body.append('output_format', 'png');
    body.append('response_format', 'b64_json');
    headers = { Authorization: `Bearer ${key}` };
  } else {
    body = JSON.stringify({ model, prompt, size, quality, output_format: 'png', response_format: 'b64_json' });
    headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }
  const response = await fetch(`https://api.gptsapi.net/v1/images/${file ? 'edits' : 'generations'}`, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(300000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `GPT Image 生成失败（${response.status}）`);
  const item = data?.data?.[0];
  if (item?.b64_json) {
    const buffer = Buffer.from(item.b64_json, 'base64');
    return { buffer, mime: sniff(buffer) };
  }
  if (item?.url) return fetchImage(item.url);
  throw new Error('GPT Image 没有返回图片');
}

function findImage(value, depth = 0) {
  if (depth > 7 || value == null) return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && !value.includes('/predictions/')) return { url: value };
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findImage(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['b64_json', 'base64', 'image_base64']) {
      if (typeof value[key] === 'string' && value[key].length > 100) return { base64: value[key] };
    }
    for (const key of ['url', 'image_url', 'imageUrl', 'output_url', 'download_url', 'image', 'output', 'outputs', 'result', 'data']) {
      if (!(key in value)) continue;
      const found = findImage(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function geminiError(value, fallback) {
  const raw = String(value || '');
  if (/resource exhausted|overloaded|rate limit|quota/i.test(raw)) {
    return Object.assign(new Error('Gemini 当前上游资源不足，请稍后重试；也可以切换 GPT Image 或 Seedream 继续生成。'), { status: 503 });
  }
  return new Error(raw || fallback);
}

async function generateGemini({ prompt, key, aspectRatio, file }) {
  const model = process.env.GPTSAPI_GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
  const response = await fetch(`https://api.gptsapi.net/api/v3/google/${model}/${file ? 'image-to-image' : 'text-to-image'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, aspect_ratio: aspectRatio, output_format: 'png', ...(file ? { image: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const created = await response.json().catch(() => ({}));
  if (!response.ok || (created?.code != null && Number(created.code) >= 400)) {
    throw geminiError(created?.message || created?.error?.message, `Gemini 创建生图任务失败（${response.status}）`);
  }
  const resultUrl = created?.data?.urls?.get || created?.urls?.get;
  if (!resultUrl) throw new Error('Gemini 没有返回任务查询地址');
  const deadline = Date.now() + 240000;
  let lastStatus = 'created';
  while (Date.now() < deadline) {
    await sleep(2500);
    const resultResponse = await fetch(resultUrl, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    const result = await resultResponse.json().catch(() => ({}));
    if (!resultResponse.ok) throw geminiError(result?.message, `Gemini 查询任务失败（${resultResponse.status}）`);
    lastStatus = String(result?.data?.status || result?.status || lastStatus).toLowerCase();
    const image = findImage(result);
    if (image?.base64) {
      const buffer = Buffer.from(image.base64.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
      return { buffer, mime: sniff(buffer) };
    }
    if (image?.url) return fetchImage(image.url);
    if (['failed', 'error', 'cancelled', 'canceled'].includes(lastStatus)) {
      throw geminiError(result?.data?.error || result?.error || result?.message, 'Gemini 生图失败');
    }
  }
  throw new Error(`Gemini 生图超时（最后状态：${lastStatus}），请重试`);
}

export async function generateGptsImage({ provider, prompt, key, size = '1536x1024', aspectRatio = '16:9', quality = 'high', file }) {
  if (!key) throw Object.assign(new Error('尚未配置 gptsapi API Key'), { status: 503 });
  if (provider === 'gpt-image') return generateGpt({ prompt, key, size, quality, file });
  if (provider === 'gemini-image') return generateGemini({ prompt, key, aspectRatio, file });
  throw Object.assign(new Error('未知的 gptsapi 图像模型'), { status: 400 });
}
