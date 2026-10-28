/**
 * AI 生成「可控」审计：提示词可改、可传参考图、各生成页有"要求"输入、助手可控制带不带原文。
 * 只验交互（不需要真的调用模型）。
 * 用法： node test/audit-ui-ai-control.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9840 + Math.floor(Math.random() * 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 200) : '')); } };

function getJson(p, method) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: CDP_PORT, path: p, method: method || 'GET' }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 80))); } });
    });
    rq.on('error', reject); rq.setTimeout(4000, () => rq.destroy(new Error('cdp timeout'))); rq.end();
  });
}
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async open() {
    const t = await getJson('/json/new?' + encodeURIComponent('about:blank'), 'PUT');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws); p.errors = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.waiting.has(m.id)) { const { res, rej } = p.waiting.get(m.id); p.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') { const d = m.params && m.params.exceptionDetails; p.errors.push((d && (d.exception && d.exception.description || d.text)) || 'unknown'); }
    };
    return p;
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(2400); }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: '(function(){try{return (' + expr + ')}catch(e){return "ERR:"+e.message}})()', returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  }
  async click(sel) { return this.js('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return false;el.click();return true;})()'); }
  close() { try { this.ws.close(); } catch (e) {} }
}
async function waitCdp() { for (let i = 0; i < 60; i++) { try { return await getJson('/json/version'); } catch (e) { await sleep(250); } } throw new Error('Chrome 没起来'); }

(async () => {
  const S = startServer('uiaicontrol');
  await S.waitReady();
  const token = await S.register();
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (subject_name,birth_year,hometown) VALUES ('可控测试',1966,'江西')")).lastId;
  const ch = (await x("INSERT INTO chapters (archive_id,seq,title) VALUES (?,10,'第一章')", [aid])).lastId;
  await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key,at_year) VALUES (?,?,10,'text','我家小时候住的是泥瓦房，门口有棵枣树。','user',1,10,1970)", [aid, ch]);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-aicontrol-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  console.log('[A] 插图：提示词可改 + 参考图');
  await page.goto(S.base + '/#/a/' + aid + '/art' + Q);
  ck('插图页有「配一张图」', await page.js('!!document.querySelector("[data-art-panel]")'));
  await page.click('[data-art-panel]');
  await sleep(500);
  ck('生成面板打开了', await page.js('!!document.querySelector(".art-panel")'));
  ck('提示词是多行文本框', await page.js('(function(){var t=document.getElementById("apPrompt");return !!t && t.tagName==="TEXTAREA"})()'));
  ck('提示词已预填（按这段生成）', await page.js('(function(){var t=document.getElementById("apPrompt");return !!t && t.value.length>10})()'),
    await page.js('(function(){var t=document.getElementById("apPrompt");return t?t.value.slice(0,40):""})()'));
  const edited = await page.js('(function(){var t=document.getElementById("apPrompt");t.value="我自己改的提示词，画一个院子";return t.value})()');
  ck('提示词可以改', edited === '我自己改的提示词，画一个院子', edited);
  ck('有「选一张图做参考」', await page.js('!!document.getElementById("apRefPick")'));

  console.log('[B] 剧本：可改生成要求');
  await page.goto(S.base + '/#/a/' + aid + '/script' + Q);
  ck('剧本页有生成要求输入', await page.js('(function(){var t=document.getElementById("scExtra");return !!t && t.tagName==="TEXTAREA"})()'));

  console.log('[C] 歌词：可改写词要求');
  await page.goto(S.base + '/#/a/' + aid + '/song' + Q);
  ck('歌词页有写词要求输入', await page.js('(function(){var t=document.getElementById("songExtra");return !!t && t.tagName==="TEXTAREA"})()'));

  console.log('[D] AI 助手：可控制资料与附加要求');
  await page.goto(S.base + '/#/a/' + aid + '/chat' + Q);
  ck('有「带上档案原文」开关', await page.js('(function(){var c=document.getElementById("chatRefs");return !!c && c.type==="checkbox"})()'));
  ck('有「附加要求」输入', await page.js('!!document.getElementById("chatExtra")'));

  console.log('[E] 无异常');
  ck('页面无 JS 异常', page.errors.length === 0, (page.errors || []).join(' | '));

  page.close(); try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\nAI 可控性：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('顶层异常：', e && e.stack || e); process.exit(2); });
