/**
 * 「＋ 在这里插入」与「照片放进正文」——端到端审计（真点、真写库）。
 * 复刻用户反馈：照片只能堆在最后、找不到地方插、也没法手动放。
 *
 * 用法： node test/audit-ui-place.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9800 + Math.floor(Math.random() * 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 220) : '')); } };

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
  const S = startServer('uiplace');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (subject_name,birth_year) VALUES ('放置测试',1966)")).lastId;
  const ch1 = (await x("INSERT INTO chapters (archive_id,seq,title) VALUES (?,10,'第一章')", [aid])).lastId;
  const e1 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key) VALUES (?,?,10,'text','第一段','user',1,10)", [aid, ch1])).lastId;
  const e2 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key) VALUES (?,?,20,'text','第二段','user',1,20)", [aid, ch1])).lastId;

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  async function addPhoto(name, year) {
    const up = await S.post('/api/file', { op: 'save', dir: 'photo', name: name + '.png', base64: PNG }, token);
    return (await x('INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)', [aid, up.path, year, '某地', '某地'])).lastId;
  }
  const p1 = await addPhoto('x1', 1970);
  const p2 = await addPhoto('x2', 1975);

  const ORDER_SQL = "SELECT e.id FROM entries e LEFT JOIN chapters c ON c.id=e.chapter_id " +
    "WHERE e.archive_id=? ORDER BY (e.chapter_id IS NULL), COALESCE(c.seq,1000000000), COALESCE(e.sort_key,e.seq,0), e.id";

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-place-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  await page.goto(S.base + '/#/a/' + aid + '?token=' + token);

  console.log('[A] 插入点可见');
  ck('正文里有「＋ 在这里插入」', await page.js('document.querySelectorAll(".ins-btn").length >= 2'), await page.js('document.querySelectorAll(".ins-btn").length'));
  ck('照片区显示 2 张待放', await page.js('document.querySelectorAll(".pending .ph").length === 2'), await page.js('document.querySelectorAll(".pending .ph").length'));
  ck('每张待放照片有「放进某章」', await page.js('document.querySelectorAll("[data-ph-place]").length === 2'));

  console.log('[B] 在指定位置插照片');
  await page.click('[data-ins-after="' + e1 + '"]');
  await sleep(400);
  ck('插入菜单打开', await page.js('!!document.querySelector(".ins-menu")'));
  await page.click('[data-ins-kind="photo"]');
  await sleep(500);
  ck('选照片弹窗打开', await page.js('!!document.querySelector(".pick-grid")'));
  ck('列出 2 张待放照片', await page.js('document.querySelectorAll(".pick-ph").length === 2'), await page.js('document.querySelectorAll(".pick-ph").length'));
  await page.click('.pick-ph');
  await sleep(1500);
  const ord1 = (await q(ORDER_SQL, [aid])).map(r => r.id);
  const phEntry = (await q('SELECT id,chapter_id,photo_id FROM entries WHERE archive_id=? AND kind=? AND photo_id=?', [aid, 'photo', p1]))[0];
  ck('照片条目插到了第一段正后面',
    phEntry && ord1.indexOf(phEntry.id) === ord1.indexOf(e1) + 1,
    'order=' + JSON.stringify(ord1) + ' 新条目=' + (phEntry && phEntry.id) + ' e1=' + e1);
  ck('生成了照片条目且归到该章', phEntry && String(phEntry.chapter_id) === String(ch1), JSON.stringify(phEntry));

  console.log('[C] 写一段话');
  await page.click('[data-ins-after="' + e2 + '"]');
  await sleep(400);
  await page.click('[data-ins-kind="text"]');
  await sleep(400);
  ck('写字弹窗打开', await page.js('!!document.getElementById("insTextArea")'));
  await page.js('document.getElementById("insTextArea").value="这是新插的一段话"');
  await page.click('[data-txt-ok="1"]');
  await sleep(1500);
  const ord2 = (await q(ORDER_SQL, [aid])).map(r => r.id);
  const newText = (await q('SELECT id FROM entries WHERE archive_id=? AND text=?', [aid, '这是新插的一段话']))[0];
  ck('新写的一段插在第二段后面', newText && ord2.indexOf(newText.id) === ord2.indexOf(e2) + 1, 'order=' + JSON.stringify(ord2));

  console.log('[D] 照片放进某章');
  ck('还剩 1 张待放', await page.js('document.querySelectorAll("[data-ph-place]").length === 1'), await page.js('document.querySelectorAll("[data-ph-place]").length'));
  await page.click('[data-ph-place="' + p2 + '"]');
  await sleep(400);
  ck('章节选择弹窗打开', await page.js('!!document.querySelector(".pick-chs")'));
  await page.click('[data-pick-ch="' + ch1 + '"]');
  await sleep(1500);
  const p2Entry = (await q('SELECT id,chapter_id FROM entries WHERE archive_id=? AND kind=? AND photo_id=?', [aid, 'photo', p2]))[0];
  ck('放进了第一章', p2Entry && String(p2Entry.chapter_id) === String(ch1), JSON.stringify(p2Entry));
  ck('待放区清空', await page.js('document.querySelectorAll("[data-ph-place]").length === 0'), await page.js('document.querySelectorAll("[data-ph-place]").length'));

  console.log('[E] 无异常');
  ck('页面无 JS 异常', page.errors.length === 0, (page.errors || []).join(' | '));

  page.close(); try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\n插入/放置：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('顶层异常：', e && e.stack || e); process.exit(2); });
