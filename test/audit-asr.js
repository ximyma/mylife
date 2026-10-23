/**
 * 语音转文字专项审计：用本地假供应商模拟"模型列表里有 ASR、但转写接口不认"的真实情况
 * （硅基流动 Qwen3-ASR 就是这个坑）。
 *
 * 覆盖：
 *   1. 语音环节「试一下」走的是 /audio/transcriptions，不是 chat（v0.3.4 修）
 *   2. 模型不存在时给出可照做的建议
 *   3. 显式传 model 时以 body.model 为准（前端自动换模型靠它）
 *
 * 用法： node test/audit-asr.js
 */
'use strict';
const http = require('http');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); }
};

/* ---------- 假供应商：只认 SenseVoiceSmall ---------- */
const seen = [];
const mock = http.createServer((req, res) => {
  let buf = '';
  req.on('data', c => buf += c);
  req.on('end', () => {
    const isAsr = req.url.indexOf('/audio/transcriptions') >= 0;
    const m = buf.match(/name="model"\r\n\r\n([^\r\n]*)/);
    const model = m ? m[1] : '';
    seen.push({ url: req.url, model: model, bytes: buf.length });
    res.setHeader('content-type', 'application/json');
    if (isAsr) {
      if (/sensevoice/i.test(model)) {
        res.writeHead(200);
        res.end(JSON.stringify({ text: '今天天气不错' }));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ code: 20012, message: 'Model does not exist. Please check it carefully.', data: null }));
      }
      return;
    }
    res.writeHead(404);
    res.end('{"error":"not found"}');
  });
});

/* 1 秒静音 WAV */
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

const S = startServer('asr');
let TOKEN = '';

mock.listen(0, '127.0.0.1', async () => {
  const mport = mock.address().port;
  try {
    await S.waitReady();
    TOKEN = await S.register();

    // 假配置：指向本地假供应商
    const models = JSON.stringify(['Qwen/Qwen3-ASR-1.7B', 'FunAudioLLM/SenseVoiceSmall', 'telecom/x']);
    let r = await S.post('/api/exec', {
      sql: "INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, models_json) VALUES ('假供应商','openai',?,?,?, 1, ?)",
      params: ['http://127.0.0.1:' + mport + '/v1', 'sk-test', 'Qwen/Qwen3-ASR-1.7B', models],
    }, TOKEN);
    ck('A1 假配置写入', r && r.ok, JSON.stringify(r));
    r = await S.post('/api/exec', {
      sql: "UPDATE ai_slots SET profile_id=1, model='Qwen/Qwen3-ASR-1.7B' WHERE slot='asr'", params: [],
    }, TOKEN);
    ck('A2 语音环节绑到"转写接口不认"的模型', r && r.ok);

    // 传一段音频上去
    r = await S.post('/api/file', {
      op: 'save', kind: 'audio', name: 'seg-probe.wav', base64: tinyWav().toString('base64'),
    }, TOKEN);
    ck('A3 音频已存', r && r.ok && r.path === 'audio/seg-probe.wav', JSON.stringify(r));

    console.log('[B] 语音环节「试一下」');
    seen.length = 0;
    r = await S.post('/api/ai/test', { slot: 'asr' }, TOKEN);
    ck('B1 试跑走的是转写接口', seen.length && /audio\/transcriptions/.test(seen[0].url),
      JSON.stringify(seen));
    ck('B2 试跑不是 chat 接口', !seen.some(x => /chat\/completions/.test(x.url)));
    ck('B3 模型不存在时返回失败', r && r.ok === false, JSON.stringify(r).slice(0, 160));
    ck('B4 失败时给出可照做的建议', /SenseVoice|TeleSpeech/i.test(String(r && r.message)),
      String(r && r.message).slice(0, 120));

    console.log('[C] 转写与模型覆盖');
    r = await S.post('/api/asr', { path: 'audio/seg-probe.wav' }, TOKEN);
    ck('C1 绑定的坏模型 -> 报错', r && r.ok === false && /20012/.test(String(r.message)), JSON.stringify(r).slice(0, 160));
    ck('C2 错误里带建议', /SenseVoice|TeleSpeech/i.test(String(r && r.message)));

    r = await S.post('/api/asr', { path: 'audio/seg-probe.wav', model: 'FunAudioLLM/SenseVoiceSmall' }, TOKEN);
    ck('C3 显式传 model 时以它为准（自动换模型的前提）', r && r.ok === true && r.text === '今天天气不错',
      JSON.stringify(r).slice(0, 160));
    ck('C4 返回里带实际用的模型', r && r.model === 'FunAudioLLM/SenseVoiceSmall');

    r = await S.post('/api/ai/test', { slot: 'asr', model: 'FunAudioLLM/SenseVoiceSmall' }, TOKEN);
    ck('C5 换个能用的模型试跑通过', r && r.ok === true, JSON.stringify(r).slice(0, 160));
  } catch (e) {
    fail++;
    console.log('  ✗ 审计异常：' + e.message);
  } finally {
    S.stop();
    mock.close();
    setTimeout(() => {
      console.log('\n语音转文字: ' + pass + ' 通过 / ' + fail + ' 失败');
      process.exit(fail ? 1 : 0);
    }, 800);
  }
});
