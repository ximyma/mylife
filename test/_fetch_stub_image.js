'use strict';
/* 预加载桩：只拦截 SiliconFlow 的 /images/generations，其余请求放行成空成功响应。
   模型是 Kolors 返回 200 + 1x1 PNG 的 data URL；否则返回 403（模拟硅基流动 Illegal operation）。
   把实际用到的 model 追加写到 <DATA_DIR>/last_model.txt，供测试跨进程读取。 */
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || '.';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function fakeFetch(url, opts) {
  const u = String(url);
  if (u.indexOf('/images/generations') !== -1) {
    let model = '';
    try { model = JSON.parse((opts && opts.body) || '{}').model; } catch (e) {}
    try { fs.appendFileSync(DATA_DIR + '/last_model.txt', model + '\n'); } catch (e) {}
    if (model === 'Kwai-Kolors/Kolors') {
      const payload = JSON.stringify({ images: [{ url: 'data:image/png;base64,' + PNG }] });
      return { ok: true, status: 200, async text() { return payload; } };
    }
    const err = JSON.stringify({ code: 30000, message: 'Illegal operation.' });
    return { ok: false, status: 403, async text() { return err; } };
  }
  return { ok: true, status: 200, async text() { return '[]'; } };
}
global.fetch = fakeFetch;
