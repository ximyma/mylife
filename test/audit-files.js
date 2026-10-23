/**
 * /files 鉴权 + 前端转写请求形态 审计。
 *
 * 两件事：
 *   ① 图片和录音是 <img src>/<audio src> 直接取的，标签发不了 Authorization 头。
 *      所以 /files 必须同时接受 cookie 和 ?token=；登录响应要 Set-Cookie。
 *      安卓本地服务原来只认 Authorization —— 这正是手机端照片不显示、录音点不动的原因。
 *   ② 前端 DB.transcribe 发的是 { model: null, language: null }。
 *      服务端必须把 null 当成"没给"，否则就会拿 model="null" 去请求转写接口。
 *      （安卓端的 bug 是这个 null 被 org.json 变成字符串 "null"，
 *        这里用同样的请求形态在 Node 端把契约钉住。）
 *
 * 用法： node test/audit-files.js
 */
'use strict';
const http = require('http');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); }
};

const seen = [];
const mock = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => {
    const m = buf.match(/name="model"\r\n\r\n([^\r\n]*)/);
    seen.push({ url: req.url, model: m ? m[1] : '' });
    res.setHeader('content-type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ text: '录音听清了' }));
  });
});

function tinyWav() {
  const rate = 16000, n = rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii'); buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** 裸 GET：要自己控制 cookie / query，拿得到状态码和 Set-Cookie */
function rawGet(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawPost(port, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const S = startServer('files');
const PORT = Number(new URL(S.base).port);
let TOKEN = '';

mock.listen(0, '127.0.0.1', async () => {
  const mport = mock.address().port;
  try {
    await S.waitReady();

    /* 注册时顺便验 Set-Cookie —— 浏览器靠它给 <img>/<audio> 过鉴权 */
    const reg = await rawPost(PORT, '/api/auth/register', {
      phone: S.phone, password: 'audit123', code: '1234',
    });
    const regJson = JSON.parse(reg.body.toString() || '{}');
    TOKEN = regJson.token;
    const sc = String(reg.headers['set-cookie'] || '');
    console.log('\n[A] 登录态');

    ck('A1 注册成功', !!(regJson.ok && TOKEN), JSON.stringify(regJson).slice(0, 120));
    ck('A2 注册响应带 Set-Cookie', /mylife_token=/.test(sc), sc || '（无）');
    ck('A3 cookie 是 HttpOnly', /HttpOnly/i.test(sc));

    /* 存一个文件 */
    const saved = await S.post('/api/file', {
      op: 'save', kind: 'photo', name: 'probe.txt', base64: Buffer.from('hello-mylife').toString('base64'),
    }, TOKEN);
    ck('A4 文件已落盘', saved && saved.ok && saved.path === 'photo/probe.txt', JSON.stringify(saved));

    console.log('\n[B] /files 的三条鉴权通道');

    let r = await rawGet(PORT, '/files/photo/probe.txt');
    ck('B1 什么凭证都不带 -> 401', r.status === 401, 'status=' + r.status);

    r = await rawGet(PORT, '/files/photo/probe.txt', { Authorization: 'Bearer ' + TOKEN });
    ck('B2 Authorization 头 -> 200', r.status === 200 && r.body.toString() === 'hello-mylife',
      'status=' + r.status + ' body=' + r.body.toString().slice(0, 40));

    r = await rawGet(PORT, '/files/photo/probe.txt', { Cookie: 'mylife_token=' + TOKEN });
    ck('B3 cookie -> 200（<img>/<audio> 靠这条）', r.status === 200 && r.body.toString() === 'hello-mylife',
      'status=' + r.status);

    r = await rawGet(PORT, '/files/photo/probe.txt?token=' + encodeURIComponent(TOKEN));
    ck('B4 ?token= -> 200（兜底）', r.status === 200, 'status=' + r.status);

    r = await rawGet(PORT, '/files/photo/probe.txt?token=deadbeef');
    ck('B5 假 token -> 401', r.status === 401, 'status=' + r.status);

    r = await rawGet(PORT, '/files/../users/1/archive.db?token=' + encodeURIComponent(TOKEN));
    // 服务端用 new URL() 解析，../ 已经被归一化掉，落到静态兜底（回 index.html）。
    // 关键是绝对拿不到数据库内容。
    ck('B6 路径穿越取不到数据库',
      r.body.toString().indexOf('SQLite format 3') < 0,
      'status=' + r.status + ' len=' + r.body.length + ' 开头=' + JSON.stringify(r.body.toString().slice(0, 20)));

    console.log('\n[C] 前端转写请求的形态（model: null）');

    await S.post('/api/exec', {
      sql: "INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, models_json) VALUES ('假转写','openai',?,?,?,1,'[]')",
      params: ['http://127.0.0.1:' + mport + '/v1', 'sk-test', 'FunAudioLLM/SenseVoiceSmall'],
    }, TOKEN);
    await S.post('/api/exec', {
      sql: "UPDATE ai_slots SET profile_id=1, model='FunAudioLLM/SenseVoiceSmall' WHERE slot='asr'", params: [],
    }, TOKEN);
    await S.post('/api/file', {
      op: 'save', kind: 'audio', name: 'seg-1.wav', base64: tinyWav().toString('base64'),
    }, TOKEN);

    seen.length = 0;
    // 这就是 web/db.js 里 call(null) 真正发出去的东西
    r = await S.post('/api/asr', {
      path: 'audio/seg-1.wav', slot: 'asr', profileId: null, model: null, language: null,
    }, TOKEN);
    ck('C1 model:null 时转写成功', r && r.ok === true, JSON.stringify(r).slice(0, 160));
    ck('C2 发出去的是配置里的模型，不是字符串 "null"',
      seen.length > 0 && seen[0].model === 'FunAudioLLM/SenseVoiceSmall',
      '实际发出 model=' + JSON.stringify(seen[0] && seen[0].model));
    ck('C3 没有把 language=null 塞进表单',
      seen.length > 0 && (seen[0].model || '').indexOf('null') < 0);
    ck('C4 正常转写不返回 diag', r && !r.diag);

    console.log('\n[D] 失败时要带诊断信息');

    await S.post('/api/exec', {
      sql: "UPDATE ai_profiles SET base_url=? WHERE id=1",
      params: ['http://127.0.0.1:1/v1'],
    }, TOKEN);
    r = await S.post('/api/asr', {
      path: 'audio/seg-1.wav', slot: 'asr', profileId: null, model: null, language: null,
    }, TOKEN);
    ck('D1 连不上时返回失败而不是抛异常', r && r.ok === false, JSON.stringify(r).slice(0, 160));
    ck('D2 带 diag.base', r && r.diag && /127\.0\.0\.1:1/.test(String(r.diag.base)), JSON.stringify(r && r.diag));
    ck('D3 带 diag.model', r && r.diag && r.diag.model === 'FunAudioLLM/SenseVoiceSmall');
    ck('D4 带 diag.bytes（音频没找到会说清楚）', r && r.diag && typeof r.diag.bytes === 'number');
  } catch (e) {
    fail++;
    console.log('  ✗ 审计过程出错：' + (e && e.message));
    console.log(e && e.stack);
  } finally {
    console.log('\n' + (fail === 0 ? '全部通过' : '有 ' + fail + ' 项没过') +
      '：' + pass + ' 通过 / ' + fail + ' 失败\n');
    try { mock.close(); } catch (e) {}
    S.stop();
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 400);
  }
});
