'use strict';
/* 预加载桩：只拦硅基流动的视频三件套（/video/submit、/video/status、成片地址）。
   真实接口是「提交拿 requestId → 轮询状态 → Succeed 给一个一小时就失效的链接」，
   桩按同样的流程走：先 InQueue，再 InProgress，第三次 Succeed。
   把每次提交的 model / 有没有参考图 追加写到 <DATA_DIR>/last_video.txt，供测试跨进程读取。 */
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || '.';
let statusCalls = 0;

function jsonRes(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, async text() { return text; }, async json() { return obj; } };
}

async function fakeFetch(url, opts) {
  const u = String(url);

  if (u.indexOf('/video/submit') !== -1) {
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    const line = [body.model || '', body.image ? 'with-image' : 'text-only', body.image_size || ''].join(' ');
    try { fs.appendFileSync(DATA_DIR + '/last_video.txt', line + '\n'); } catch (e) {}
    // 模型名里带 FAIL 的当作服务商拒绝，用来验证失败路径
    if (String(body.model || '').indexOf('FAIL') !== -1) {
      const err = JSON.stringify({ code: 20012, message: 'Model does not exist.' });
      return { ok: false, status: 400, async text() { return err; }, async json() { return JSON.parse(err); } };
    }
    return jsonRes({ requestId: 'rid-test-1' });
  }

  if (u.indexOf('/video/status') !== -1) {
    statusCalls++;
    if (statusCalls === 1) return jsonRes({ status: 'InQueue' });
    if (statusCalls === 2) return jsonRes({ status: 'InProgress' });
    return jsonRes({ status: 'Succeed', results: { videos: [{ url: 'https://stub.local/v/1.mp4' }] } });
  }

  if (u.indexOf('stub.local') !== -1) {
    const buf = Buffer.alloc(4096, 7);
    buf.write('ftyp', 4, 'ascii');
    return {
      ok: true, status: 200,
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
      async text() { return ''; },
    };
  }

  // 其余请求（拉模型列表等）一律给空清单
  return jsonRes({ data: [] });
}

global.fetch = fakeFetch;
