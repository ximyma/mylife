/**
 * v0.6 界面审计（P5）：朗读音色、配乐、主题曲页。
 * 用法： node test/audit-ui-v06.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9560 + Math.floor(Math.random() * 30);

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 160) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(p, m) {
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET' }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 60))); } });
    });
    rq.on('error', rej); rq.setTimeout(4000, () => rq.destroy(new Error('t'))); rq.end();
  });
}

(async () => {
  const S = startServer('uiv06');
  await S.waitReady();
  const t = await S.register();
  const x = (sql, p) => S.post('/api/exec', { sql, params: p || [] }, t);
  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-S-1','张桂芳',1942,'山东济南')")).lastId;
  await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'第一章 · 西郊的院子',1942,1955)", [aid]);

  const prof = path.join(__dirname, '..', 'tmp', 'cdp-v06-prof');
  fs.rmSync(prof, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }

  const target = await getJson('/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || 'err');
  };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  const js = async e => {
    const r = await send('Runtime.evaluate', { expression: '(function(){try{return (' + e + ')}catch(err){return "ERR:"+err.message}})()', returnByValue: true, awaitPromise: true });
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  };
  const goto = async h => { await send('Page.navigate', { url: S.base + '/#' + h + '?token=' + t }); await sleep(2200); };

  console.log('[A] 配乐引擎');
  await goto('/');
  ck('混音器加载了', await js('!!window.Mixer'));
  ck('有七套氛围（含不配乐）', await js('window.Mixer.presets().length === 7'), await js('window.Mixer.presets().length'));
  ck('默认不配乐', await js('window.Mixer.current() === "none"'), await js('window.Mixer.current()'));
  ck('可以切到旧钢琴', await js('window.Mixer.setPreset("piano") === "piano"'));
  ck('选择记进了本地', await js('localStorage.getItem("ms_bgm") === "piano"'));

  console.log('[B] 设置页');
  await goto('/settings');
  ck('有音色来源选项', await js('!!document.querySelector("#prefTtsMode")'));
  ck('有配乐选择', await js('!!document.querySelector("#prefBgm")'));
  ck('配乐当前值正确', await js('document.querySelector("#prefBgm").value === "piano"'),
    await js('document.querySelector("#prefBgm").value'));
  ck('有配乐音量', await js('!!document.querySelector("#prefBgmVol")'));
  ck('切到弦乐能生效', await js('(function(){var s=document.querySelector("#prefBgm");s.value="strings";s.onchange();return window.Mixer.current();})()') === 'strings');

  console.log('[C] 主题曲页');
  await goto('/a/' + aid + '/song');
  ck('页面起来了', await js('!!document.querySelector("#songGen")'));
  ck('有歌词区', await js('!!document.querySelector("#songLyr")'));
  ck('有三个按钮', await js('document.querySelectorAll(".song-acts .btn").length === 3'));
  ck('没模型时点生成给可读提示', await js('(function(){document.querySelector("#songGen").click();return 1;})()') === 1);
  await sleep(1500);
  ck('提示里说明了原因', await js('(document.querySelector("#songTip").textContent||"").length > 4'),
    await js('document.querySelector("#songTip").textContent'));
  ck('没配模型不会白屏', await js('!!document.querySelector(".song-card")'));

  console.log('[D] 控制台');
  const real = errors.filter(e => String(e).indexOf('favicon') < 0);
  ck('没有未捕获异常', real.length === 0, real.join(' | '));

  try { ws.close(); } catch (e) {}
  chrome.kill();
  S.stop();
  console.log('\nv0.6 界面: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('审计崩了：' + (e && e.stack || e)); process.exit(1); });
