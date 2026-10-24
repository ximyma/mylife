/**
 * v0.6 语音与音乐审计（P5）。
 *
 * 盯三件事：
 *   ① /api/tts 的缓存是否真的生效（同一句只合成一次，这是省钱的命门）
 *   ② 没有可用模型时是否老实退回系统音色，而不是丢一句看不懂的错
 *   ③ 供应商报错时前端能不能拿到可操作的话
 *
 * 用法： node test/audit-v06.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 160) : '')); }
};

(async () => {
  const S = startServer('v06');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, t);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, t);

  /* 假 TTS 服务：返回一段假 mp3，记录调用次数 */
  let calls = 0, mode = 'ok';
  const mock = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      calls++;
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"tts boom"}');
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('ID3FAKEMP3' + 'x'.repeat(200)));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;

  console.log('[A] 没有模型时的兜底');
  const none = await S.post('/api/tts', { text: '天不亮就起来推磨。' }, t);
  ck('明确说要用系统音色', none.ok === false && none.fallback === 'system', JSON.stringify(none));
  ck('错误话术能看懂', /系统音色|配/.test(none.message || ''), none.message);

  console.log('[B] 正常合成');
  await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) VALUES ('假TTS','openai',?,'k','tts-1',1,0)",
    ['http://127.0.0.1:' + port + '/v1']);
  await x("DELETE FROM ai_slots WHERE slot='tts'");
  await x("INSERT INTO ai_slots (slot, profile_id, model) VALUES ('tts', 1, 'tts-1')");

  const one = await S.post('/api/tts', { text: '天不亮就起来推磨。' }, t);
  ck('合成成功', one.ok === true && !!one.path, JSON.stringify(one));
  ck('落在 ai/tts 下', /^ai\/tts\/[0-9a-f]+\.mp3$/.test(one.path || ''), one.path);
  ck('文件真的存在', fs.existsSync(path.join(S.DATA_DIR, 'users', '1', 'files', one.path)));
  ck('第一次不是缓存', one.cached === false);
  const size1 = fs.statSync(path.join(S.DATA_DIR, 'users', '1', 'files', one.path)).size;
  ck('文件不是空的', size1 > 100, size1);
  ck('只请求了一次', calls === 1, 'calls=' + calls);

  console.log('[C] 缓存');
  const two = await S.post('/api/tts', { text: '天不亮就起来推磨。' }, t);
  ck('第二次命中缓存', two.ok === true && two.cached === true, JSON.stringify(two));
  ck('没有重复请求供应商', calls === 1, 'calls=' + calls);
  ck('路径一致', two.path === one.path);

  const three = await S.post('/api/tts', { text: '换一句话试试。' }, t);
  ck('不同文本走新请求', three.ok === true && three.cached === false && calls === 2, 'calls=' + calls);

  console.log('[D] 用量记账');
  const u = await S.post('/api/ai/usage', { days: 30 }, t);
  const ttsRow = (u.byCapability || []).filter(r => r.capability === 'tts')[0];
  ck('记了 tts 用量', !!ttsRow, JSON.stringify(u.byCapability));
  ck('按字数计', ttsRow && Number(ttsRow.units) > 0, ttsRow && ttsRow.units);

  console.log('[E] 边界');
  const long = await S.post('/api/tts', { text: '字'.repeat(2100) }, t);
  ck('超长文本被挡', long.ok === false && /2000/.test(long.message || ''), long.message);
  const empty = await S.post('/api/tts', { text: '' }, t);
  ck('空文本被挡', empty.ok === false);

  mode = 'fail';
  const bad = await S.post('/api/tts', { text: '供应商坏了会怎样。' }, t);
  ck('供应商 500 时仍给系统兜底', bad.ok === false && bad.fallback === 'system', JSON.stringify(bad));
  ck('错误里带 HTTP 状态', /500/.test(bad.message || ''), bad.message);

  mock.close();
  S.stop();
  console.log('\nv0.6 语音与音乐: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('审计崩了：' + (e && e.stack || e)); process.exit(1); });
