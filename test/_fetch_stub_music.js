'use strict';
/* 预加载桩：拦两家音乐服务的两段式接口（只拦它们，其余请求给空清单）。
 *
 *   阶跃星辰  POST /v1/audio/music/submit → {task_id}
 *             POST /v1/audio/music/query  → PENDING → RUNNING → SUCCESS + audio(base64)
 *   Mureka    POST /v1/song/generate      → {id}
 *             GET  /v1/song/query/{id}    → preparing → running → succeeded + choices[0].url
 *
 * 真实服务一首歌要几十秒到几分钟，桩里把排队过程压缩成两次轮询。
 * 每次提交的主体追加写到 <DATA_DIR>/last_music.txt，供测试跨进程核对发出去的到底是什么。 */
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || '.';

let sfCalls = 0, mkCalls = 0;

function jsonRes(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, async text() { return text; }, async json() { return obj; } };
}

// 一段"像 mp3"的字节：够长能被当成成品，够真能验证落盘没被截断
function fakeAudio() {
  const buf = Buffer.alloc(8192, 3);
  buf.write('ID3', 0, 'ascii');
  return buf;
}

function log(line) {
  try { fs.appendFileSync(DATA_DIR + '/last_music.txt', line + '\n'); } catch (e) {}
}

async function fakeFetch(url, opts) {
  const u = String(url);
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}

  /* ---------- 阶跃星辰 ---------- */
  if (u.indexOf('stepfun') !== -1 && u.indexOf('/audio/music/submit') !== -1) {
    log('stepfun submit ' + JSON.stringify({
      task: body.task, model: body.model_id, cap: body.caption,
      lyr: body.lyrics ? 'with-lyrics' : 'no-lyrics', inst: !!body.instrumental, fmt: body.response_format,
      url: u,
    }));
    // 模型名里带 FAIL 当作服务商拒绝，用来验证失败与兜底换家
    if (String(body.model_id || '').indexOf('FAIL') !== -1) {
      const err = JSON.stringify({ error: { message: 'model not found', type: 'request_params_invalid' } });
      return { ok: false, status: 400, async text() { return err; }, async json() { return JSON.parse(err); } };
    }
    return jsonRes({ task_id: 'sf-task-1' });
  }
  if (u.indexOf('stepfun') !== -1 && u.indexOf('/audio/music/query') !== -1) {
    sfCalls++;
    if (sfCalls === 1) return jsonRes({ status: 'PENDING' });
    if (sfCalls === 2) return jsonRes({ status: 'RUNNING' });
    return jsonRes({
      status: 'SUCCESS', task: 'text_to_music',
      rewritten_caption: '中文民谣，温暖男声',
      rewritten_lyrics: '[Verse]\n老屋的瓦上落着霜',
      audio: fakeAudio().toString('base64'),
    });
  }

  /* ---------- Mureka ---------- */
  if (u.indexOf('mureka') !== -1 && u.indexOf('/song/generate') !== -1) {
    log('mureka submit ' + JSON.stringify({
      model: body.model, prompt: body.prompt,
      lyr: body.lyrics === '[Instrumental]' ? 'instrumental' : 'with-lyrics', n: body.n,
      url: u,
    }));
    // 曲风描述里带 FAIL 当作这家也拒绝（余额不足之类），用来验证两家都拒时的报错
    if (String(body.prompt || '').indexOf('FAIL') !== -1) {
      const err = JSON.stringify({ message: 'insufficient balance', code: 40031 });
      return { ok: false, status: 402, async text() { return err; }, async json() { return JSON.parse(err); } };
    }
    return jsonRes({ id: 'mk-task-1' });
  }
  if (u.indexOf('mureka') !== -1 && u.indexOf('/song/query') !== -1) {
    mkCalls++;
    if (mkCalls === 1) return jsonRes({ status: 'preparing', id: 'mk-task-1' });
    if (mkCalls === 2) return jsonRes({ status: 'running', id: 'mk-task-1' });
    return jsonRes({
      id: 'mk-task-1', status: 'succeeded', model: 'auto',
      choices: [{ url: 'https://stub.local/m/1.mp3', duration: 168 }],
    });
  }
  if (u.indexOf('stub.local') !== -1) {
    const buf = fakeAudio();
    return {
      ok: true, status: 200,
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
      async text() { return ''; },
    };
  }

  return jsonRes({ data: [] });
}

global.fetch = fakeFetch;
