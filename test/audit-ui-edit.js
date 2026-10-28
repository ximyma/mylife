/**
 * 排序 / 配图 / 导出含全部照片 —— 端到端审计（真点、真写库）。
 *
 * 复刻用户遇到的场景：上传 3 张照片，但只有 1 张有对应「照片条目」。
 * 验证：
 *   ① 照片条目能显示图片（getArchive 带出 photo_path，不再空 src）
 *   ② 每个条目/每章都有上下移按钮
 *   ③ 文字段能「配图」，配完 photo_id 真的写库；配图随段落显示
 *   ④ 下移真的改顺序（sort_key 写回）
 *   ⑤ 导出模型里图片块数量 = 照片总数（Word 不再漏图）
 *   ⑥ docx 真能生成（bytes > 0）
 *
 * 用法： node test/audit-ui-edit.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9700 + Math.floor(Math.random() * 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 200) : '')); }
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
  const S = startServer('uiedit');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-ED-1','测试排序',1966,'江西')")).lastId;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  async function addPhoto(name, year, place) {
    const up = await S.post('/api/file', { op: 'save', dir: 'photo', name: name + '.png', base64: PNG }, token);
    return (await x('INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)', [aid, up.path, year, place, place])).lastId;
  }
  const pA = await addPhoto('a', 1968, '老屋门口');
  await addPhoto('b', 1975, '厂区');
  await addPhoto('c', 1980, '公园');

  const ch1 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from) VALUES (?,10,'第一章 · 老屋',1966)", [aid])).lastId;
  const ch2 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from) VALUES (?,20,'第二章 · 进城',1980)", [aid])).lastId;
  const e1 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key) VALUES (?,?,10,'text','天还没亮就起来生火做饭。','user',1,10)", [aid, ch1])).lastId;
  const e2 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,sort_key) VALUES (?,?,20,'text','父亲在厂里做钳工，手上全是老茧。','user',1,20)", [aid, ch1])).lastId;
  await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,photo_id,origin,edited,sort_key) VALUES (?,?,?,?,?,?,?,?,?)", [aid, ch1, 30, 'photo', '老屋门口', pA, 'user', 1, 30]);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-edit-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });

  const Q = '?token=' + token;
  await page.goto(S.base + '/#/a/' + aid + Q);

  console.log('[A] 显示与排序入口');
  ck('照片条目显示了真实图片', await page.js('(function(){var i=document.querySelector(".ph img");return !!i && !!i.getAttribute("src") && i.getAttribute("src").indexOf("/files/")>=0})()'));
  ck('每个条目都有上移/下移', await page.js('document.querySelectorAll("[data-move-entry]").length >= 6'), await page.js('document.querySelectorAll("[data-move-entry]").length'));
  ck('每章都有上移/下移', await page.js('document.querySelectorAll("[data-move-chapter]").length >= 4'), await page.js('document.querySelectorAll("[data-move-chapter]").length'));
  ck('文字段有「配图」入口', await page.js('document.querySelectorAll("[data-pair-entry]").length >= 2'));

  console.log('[B] 配图');
  await page.click('[data-pair-entry="' + e1 + '"]');
  await sleep(500);
  ck('选图弹窗打开了', await page.js('!!document.querySelector(".pick-grid")'));
  ck('弹窗里列出了照片', await page.js('document.querySelectorAll(".pick-ph").length >= 3'), await page.js('document.querySelectorAll(".pick-ph").length'));
  // v0.9.5 起配图是多选：点图 → 点「配到这一段」
  await page.click('.pick-ph');
  await sleep(300);
  ck('选中后确认按钮可用', await page.js('(function(){var b=document.querySelector("[data-mpick-ok]");return !!b && !b.disabled})()'));
  await page.click('[data-mpick-ok]');
  await sleep(1400);
  const rowE1 = (await q('SELECT photo_id FROM entries WHERE id=?', [e1]))[0];
  ck('配图写进了库（photo_id 有值）', rowE1 && rowE1.photo_id, JSON.stringify(rowE1));
  ck('配好的图显示在文字下面', await page.js('!!document.querySelector(".en-photo img")'));

  console.log('[C] 上下移动');
  const before = await q('SELECT id, sort_key FROM entries WHERE chapter_id=? ORDER BY COALESCE(sort_key,seq,0),id', [ch1]);
  await page.click('[data-move-entry="' + e2 + '"][data-dir="-1"]');
  await sleep(1400);
  const after = await q('SELECT id FROM entries WHERE chapter_id=? ORDER BY COALESCE(sort_key,seq,0),id', [ch1]);
  ck('下移/上移真的改了顺序', String(after[0].id) === String(e2), 'before=' + before.map(r => r.id).join(',') + ' after=' + after.map(r => r.id).join(','));

  console.log('[D] 导出包含全部照片');
  const photoBlocks = await page.js('(function(){return Exporter.model(' + aid + ').then(function(m){var n=0;m.chapters.forEach(function(c){c.blocks.forEach(function(b){if(b.type==="photo"||b.type==="video")n++})});return n})})()');
  ck('导出模型图片块 = 照片总数 3', Number(photoBlocks) === 3, 'got ' + photoBlocks);

  const dx = await page.js('(function(){return Exporter.model(' + aid + ').then(function(m){return Exporter.docx(m,{archiveId:' + aid + '})}).then(function(r){return r && r.ok && r.bytes>0 ? r.bytes : ("fail:"+JSON.stringify(r))})})()');
  ck('docx 真能生成（bytes>0）', typeof dx === 'number' && dx > 0, dx);

  ck('页面没有 JS 异常', page.errors.length === 0, (page.errors || []).join(' | '));

  page.close();
  try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\n排序/配图/导出：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('顶层异常：', e && e.stack || e); process.exit(2); });
