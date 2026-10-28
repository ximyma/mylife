/**
 * 跨章排序 / 批量移动 / 碎片归章 —— 端到端审计（真点、真写库）。
 * 复刻用户反馈：「章节像一堵墙，段落移不过去」「几段没法整体前移」「待归档碎片调不动」。
 *
 * 用法： node test/audit-ui-reorder.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9760 + Math.floor(Math.random() * 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 220) : '')); }
};

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
  const S = startServer('uireorder');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (subject_name, birth_year) VALUES ('排序测试',1966)")).lastId;
  const ch1 = (await x("INSERT INTO chapters (archive_id,seq,title) VALUES (?,10,'第一章')", [aid])).lastId;
  const ch2 = (await x("INSERT INTO chapters (archive_id,seq,title) VALUES (?,20,'第二章')", [aid])).lastId;
  async function addText(chId, k, text) {
    return (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key) VALUES (?,?,?,?,?,?,?,?)",
      [aid, chId, k, 'text', text, 'user', 1, k])).lastId;
  }
  const a1 = await addText(ch1, 10, '甲一');
  const a2 = await addText(ch1, 20, '甲二');
  const a3 = await addText(ch1, 30, '甲三');
  const b1 = await addText(ch2, 10, '乙一');
  const b2 = await addText(ch2, 20, '乙二');
  const o1 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited) VALUES (?,NULL,10,'text','游离碎片','user',1)", [aid])).lastId;

  const ORDER_SQL = "SELECT e.id, e.chapter_id FROM entries e LEFT JOIN chapters c ON c.id=e.chapter_id " +
    "WHERE e.archive_id=? ORDER BY (e.chapter_id IS NULL), COALESCE(c.seq,1000000000), COALESCE(e.sort_key,e.seq,0), e.id";
  async function orderOf(chId) {
    const all = await q(ORDER_SQL, [aid]);
    return all.filter(r => String(r.chapter_id) === String(chId)).map(r => r.id);
  }

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-reorder-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });

  await page.goto(S.base + '/#/a/' + aid + '?token=' + token);

  console.log('[A] 基本入口');
  ck('有勾选框', await page.js('document.querySelectorAll("[data-check-entry]").length >= 6'), await page.js('document.querySelectorAll("[data-check-entry]").length'));
  ck('有批量操作条', await page.js('!!document.getElementById("selBar")'));

  console.log('[B] 批量移动（同章两段整体下移）');
  await page.click('[data-check-entry="' + a1 + '"]');
  await page.click('[data-check-entry="' + a2 + '"]');
  await sleep(200);
  ck('勾选后批量条出现', await page.js('document.getElementById("selBar").className.indexOf("on") >= 0'));
  ck('已选 2 段', await page.js('(document.getElementById("selCount").textContent||"").indexOf("2")>=0'), await page.js('document.getElementById("selCount").textContent'));
  await page.click('[data-sel-move="1"]');
  await sleep(1600);
  const ch1AfterBatch = await orderOf(ch1);
  ck('两段整体下移一格（甲三,甲一,甲二）',
    JSON.stringify(ch1AfterBatch) === JSON.stringify([a3, a1, a2]),
    'got ' + JSON.stringify(ch1AfterBatch));

  console.log('[C] 跨章移动（第二章首段上移进第一章）');
  await page.click('[data-move-entry="' + b1 + '"][data-dir="-1"]');
  await sleep(1600);
  const b1row = (await q('SELECT chapter_id FROM entries WHERE id=?', [b1]))[0];
  ck('跨章后自动归到上一章', String(b1row.chapter_id) === String(ch1), 'chapter_id=' + b1row.chapter_id);
  const ch1AfterCross = await orderOf(ch1);
  ck('确实出现在第一章里', ch1AfterCross.indexOf(b1) >= 0, JSON.stringify(ch1AfterCross));

  console.log('[D] 碎片归章');
  ck('游离碎片有「归章」入口', await page.js('!!document.querySelector("[data-assign-chapter=\\"' + o1 + '\\"]")'));
  await page.click('[data-assign-chapter="' + o1 + '"]');
  await sleep(500);
  ck('章节选择弹窗打开', await page.js('!!document.querySelector(".pick-chs")'));
  await page.click('[data-pick-ch="' + ch2 + '"]');
  await sleep(1500);
  const oRow = (await q('SELECT chapter_id FROM entries WHERE id=?', [o1]))[0];
  ck('碎片归到第二章', String(oRow.chapter_id) === String(ch2), 'chapter_id=' + oRow.chapter_id);

  console.log('[E] 无异常');
  ck('页面无 JS 异常', page.errors.length === 0, (page.errors || []).join(' | '));

  page.close(); try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\n跨章/批量/归章：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('顶层异常：', e && e.stack || e); process.exit(2); });
