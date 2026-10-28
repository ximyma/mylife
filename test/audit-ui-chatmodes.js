/**
 * AI 助手八档模式 + 选章节 —— 端到端审计（真点、真切档）。
 *
 * 用户的诉求：①关联档案原文太多，想按章节选着发；②模式太少，
 * 要能提字(OCR)、声音转文字、念稿(TTS)、写歌。
 * 这里验证：
 *   A 顶部七个档都在，切档换 placeholder 和提示语
 *   B 选章节弹窗：多选、全选、清空、记住选择，私有行显示手选了几章
 *   C 念稿档没绑 TTS 模型时把话说清楚（不静默失败）
 *   D 提字档没传图就发送，只会提示不会乱调接口
 *
 * 用法：node test/audit-ui-chatmodes.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9900 + Math.floor(Math.random() * 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? ' << ' + String(d).slice(0, 260) : '')); }
};

function getJson(p, method) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: CDP_PORT, path: p, method: method || 'GET' }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 80))); } });
    });
    rq.on('error', reject);
    rq.setTimeout(4000, () => rq.destroy(new Error('cdp timeout')));
    rq.end();
  });
}

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async open() {
    const t = await getJson('/json/new?' + encodeURIComponent('about:blank'), 'PUT');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    p.errors = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.waiting.has(m.id)) {
        const { res, rej } = p.waiting.get(m.id);
        p.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        p.errors.push((d && (d.exception && d.exception.description || d.text)) || 'unknown');
      }
    };
    return p;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(2400); }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){try{return (' + expr + ')}catch(e){return "ERR:"+e.message}})()',
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  }
  /** 跑语句（不是表达式）：不能塞进 return (...)，所以单独开一条路 */
  async run(code) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){try{' + code + '}catch(e){throw new Error(e.message)}})()',
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result && r.result.value;
  }
  async click(sel) {
    return this.js('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return false;el.click();return true;})()');
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function waitCdp() {
  for (let i = 0; i < 60; i++) { try { return await getJson('/json/version'); } catch (e) { await sleep(250); } }
  throw new Error('Chrome 没起来');
}

(async () => {
  const S = startServer('chatmodes');
  await S.waitReady();
  const token = await S.register();
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-CMD-1','李老',1950,'江西石城')")).lastId;
  const ch1 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'出生与家世',1950,1959)", [aid])).lastId;
  const ch2 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,20,'进厂',1960,1969)", [aid])).lastId;
  const ch3 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,30,'退休之后',2010,2020)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,?,10,'text','1955 年冬天，老屋院子里堆着柴。',1955,'user',10)", [aid, ch1]);
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,?,10,'text','1962 年他进了县农机厂，当学徒工。',1962,'user',10)", [aid, ch2]);

  const MODELS = JSON.stringify([
    'Qwen/Qwen3-8B',
    'deepseek-ai/DeepSeek-OCR',
    'FunAudioLLM/CosyVoice2-0.5B',
    'FunAudioLLM/SenseVoiceSmall',
  ]);
  await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, models_json, default_model, enabled, sort) " +
    "VALUES ('硅基流动','cloud','https://api.siliconflow.cn/v1','sk-test',?,'Qwen/Qwen3-8B',1,10)", [MODELS]);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-chatmodes-prof');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  await page.goto(S.base + '/#/a/' + aid + '/chat' + Q);
  await sleep(1400);

  /* ---------- A. 八档 ---------- */
  console.log('[A] 七个档');
  const tabs = await page.js('(function(){var bs=document.querySelectorAll("[data-cm-mode]");var a=[];for(var i=0;i<bs.length;i++)a.push(bs[i].textContent);return a.join("|")})()');
  ck('八档：聊天/画图/视频/提字/转文字/念稿/写歌/作曲',
    tabs === '聊天|画图|视频|提字|转文字|念稿|写歌|作曲', tabs);

  await page.click('[data-cm-mode="tts"]');
  await sleep(300);
  const phTts = await page.js('document.getElementById("chatText").getAttribute("placeholder")');
  ck('念稿档提示一次最多 2000 字', phTts.indexOf('2000') >= 0, phTts);
  const noteTts = await page.js('(function(){var e=document.querySelector(".cm-note");return e?e.textContent:""})()');
  ck('念稿档提示 CosyVoice2 免费', noteTts.indexOf('CosyVoice2') >= 0, noteTts);

  await page.click('[data-cm-mode="asr"]');
  await sleep(300);
  const noteAsr = await page.js('(function(){var e=document.querySelector(".cm-note");return e?e.textContent:""})()');
  ck('转文字档提示免费模型', noteAsr.indexOf('免费') >= 0, noteAsr);

  await page.click('[data-cm-mode="ocr"]');
  await sleep(300);
  const phOcr = await page.js('document.getElementById("chatText").getAttribute("placeholder")');
  ck('提字档提示先传图', phOcr.indexOf('📎') >= 0, phOcr);

  await page.click('[data-cm-mode="song"]');
  await sleep(300);
  const phSong = await page.js('document.getElementById("chatText").getAttribute("placeholder")');
  ck('写歌档提示选章节取材', phSong.indexOf('章节') >= 0, phSong);

  await page.click('[data-cm-mode="music"]');
  await sleep(300);
  const phMu = await page.js('document.getElementById("chatText").getAttribute("placeholder")');
  ck('作曲档提示写清什么曲子', phMu.indexOf('曲子') >= 0, phMu);
  const noteMu = await page.js('(function(){var e=document.querySelector(".cm-note");return e?e.textContent:""})()');
  ck('作曲档说清了要去哪儿配（阶跃星辰 / Mureka）',
    noteMu.indexOf('Mureka') >= 0 && noteMu.indexOf('阶跃星辰') >= 0, noteMu);
  ck('作曲档不列对话模型（它不是聊天模型干的活）',
    await page.js('(function(){var s=document.getElementById("cmSel");' +
      'return !!s && s.options.length <= 2})()'));
  ck('没可用模型时给出「去设置里加一条」的出口',
    await page.js('(function(){var e=document.querySelector(".cm-empty");' +
      'return !!e && e.textContent.indexOf("去设置里加一条") >= 0})()'));

  await page.click('[data-cm-mode="chat"]');
  await sleep(300);

  /* ---------- B. 选章节 ---------- */
  console.log('[B] 按章节带原文');
  ck('有「选章节」按钮', await page.js('!!document.getElementById("chatChs")'));
  await page.click('#chatChs');
  await sleep(500);
  ck('弹窗打开了', await page.js('!!document.querySelector(".pick-modal")'));
  const chips = await page.js('(function(){var bs=document.querySelectorAll("[data-ck-ch]");return bs.length})()');
  ck('三章都在弹窗里', chips === 3, chips);

  await page.click('[data-ck-ch="' + ch1 + '"]');
  await page.click('[data-ck-ch="' + ch2 + '"]');
  const onCnt = await page.js('(function(){var bs=document.querySelectorAll("[data-ck-ch].on");return bs.length})()');
  ck('点两个亮两个', onCnt === 2, onCnt);

  await page.click('[data-ck-all]');
  const onAll = await page.js('(function(){var bs=document.querySelectorAll("[data-ck-ch].on");return bs.length})()');
  ck('全选亮三个', onAll === 3, onAll);

  await page.click('[data-ck-none]');
  const onNone = await page.js('(function(){var bs=document.querySelectorAll("[data-ck-ch].on");return bs.length})()');
  ck('清空全灭', onNone === 0, onNone);

  await page.click('[data-ck-ch="' + ch2 + '"]');
  await page.click('[data-ck-ok]');
  await sleep(300);
  ck('弹窗关了', await page.js('!document.querySelector(".pick-modal")'));
  await page.run('document.getElementById("chatText").value="测试一句话";' +
    'document.getElementById("chatText").dispatchEvent(new Event("input"));');
  await sleep(200);
  const priv = await page.js('(function(){var e=document.getElementById("chatPriv");return e?e.textContent:""})()');
  ck('私有行显示手选 1 章', priv.indexOf('手选 1 章') >= 0, priv);

  // 重开确认记住；顺手清空，别影响后面的用例
  await page.click('#chatChs');
  await sleep(400);
  const again = await page.js('(function(){var on=document.querySelectorAll("[data-ck-ch].on");return on.length&&on[0].getAttribute("data-ck-ch")})()');
  ck('重开还记着选了哪章', String(again) === String(ch2), again);
  await page.click('[data-ck-none]');
  await page.click('[data-ck-ok]');
  await sleep(200);
  const priv2 = await page.js('(function(){var e=document.getElementById("chatPriv");return e?e.textContent:""})()');
  ck('清空后私有行不再显示手选', priv2.indexOf('手选') === -1, priv2);

  /* ---------- C. 念稿：没绑 TTS 模型时把话说清楚 ---------- */
  console.log('[C] 念稿兜底');
  await page.click('[data-cm-mode="tts"]');
  await sleep(300);
  await page.run('document.getElementById("chatText").value="今天天气不错，我们出去走走。";' +
    'document.getElementById("chatText").dispatchEvent(new Event("input"));');
  await sleep(200);
  const bubbles0 = await page.js('document.querySelectorAll("#chatLog .msg").length');
  await page.click('#chatSend');
  await sleep(2500);
  const ttsOut = await page.js('(function(){var ms=document.querySelectorAll("#chatLog .msg.ai .msg-t");return ms.length?ms[ms.length-1].textContent:""})()');
  ck('没绑 TTS 模型会说明原因（去设置里绑）', ttsOut.indexOf('没念出来') >= 0 && ttsOut.indexOf('模型分工') >= 0, ttsOut);
  const bubbles1 = await page.js('document.querySelectorAll("#chatLog .msg").length');
  ck('念稿在对话记录里留了两笔（问 + 答）', bubbles1 === bubbles0 + 2, bubbles0 + '->' + bubbles1);

  /* ---------- D. 提字：没传图不乱调接口 ---------- */
  console.log('[D] 提字兜底');
  await page.click('[data-cm-mode="ocr"]');
  await sleep(300);
  const b2 = await page.js('document.querySelectorAll("#chatLog .msg").length');
  await page.run('document.getElementById("chatText").value="认一下这张图";' +
    'document.getElementById("chatText").dispatchEvent(new Event("input"));');
  await sleep(200);
  await page.click('#chatSend');
  await sleep(800);
  const toastTxt = await page.js('(function(){var e=document.querySelector(".toast");return e?e.textContent:""})()');
  ck('提示先传图', toastTxt.indexOf('传一张带字的图片') >= 0, toastTxt);
  const b3 = await page.js('document.querySelectorAll("#chatLog .msg").length');
  ck('没传图不会产生气泡', b3 === b2, b2 + '->' + b3);

  ck('全程没有 JS 异常', page.errors.length === 0, page.errors.join(' | ').slice(0, 200));

  page.close();
  try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\n八档模式审计：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('审计挂了:', e.message); process.exit(1); });
