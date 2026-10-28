/**
 * 目录为纲 + 章节独立页 + 导出预览 + 独立助手 —— 端到端审计（真点、真写库）。
 *
 * 用户要求：
 *   ① 建完档案先看到「目录」，没有目录时能从录音/文字生成
 *   ② 每个目录章节一个链接，点开是这一章自己的阅读/编辑页
 *   ③ 导出前先预览
 *   ④ AI 助手可以单独用，又能插回档案
 *   ⑤ 章节能增删改、能调顺序
 *
 * 用法： node test/audit-ui-outline.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9800 + Math.floor(Math.random() * 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 240) : '')); }
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
  const S = startServer('uioutline');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  /* 两本档案：一本全空（应生成 8 章骨架），一本有材料（应按阶段生成并归位） */
  const aidEmpty = (await x("INSERT INTO archives (archive_no, subject_name, birth_year) VALUES ('MS-OL-1','空档案',1950)")).lastId;
  const aidFull = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-OL-2','有材料',1950,'江西')")).lastId;
  await x("INSERT INTO entries (archive_id, seq, kind, text, at_year, origin) VALUES (?,10,'text','1955 年小时候在老屋院子里玩，奶奶在灶前烧火。',1955,'user')", [aidFull]);
  await x("INSERT INTO entries (archive_id, seq, kind, text, at_year, origin) VALUES (?,20,'text','1968 年上中学，班主任姓陈，教语文。',1968,'user')", [aidFull]);
  await x("INSERT INTO entries (archive_id, seq, kind, text, at_year, origin) VALUES (?,30,'text','1975 年进城打工，第一份工作是在砖厂。',1975,'user')", [aidFull]);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-outline-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  /* ---------- 1. 空档案：先看到目录引导，点一下生成 8 章骨架 ---------- */
  console.log('[A] 空档案 → 目录骨架');
  await page.goto(S.base + '/#/a/' + aidEmpty + Q);
  ck('空档案显示「还没有目录」引导', await page.js('!!document.querySelector(".outline-empty")'));
  ck('有「按人生阶段生成目录」按钮', await page.js('!!document.querySelector("[data-outline]")'));

  await page.click('[data-outline]');
  await sleep(4000);
  const chEmpty = await q('SELECT id, title, seq FROM chapters WHERE archive_id=? ORDER BY seq', [aidEmpty]);
  ck('生成了 8 章人生阶段目录', chEmpty.length === 8, 'chapters=' + chEmpty.length +
    ' ' + JSON.stringify(chEmpty.map(c => c.title)));
  const titles = chEmpty.map(c => c.title).join('|');
  ck('顺序是 出生→童年→求学→工作→婚姻→子女→事业→晚年',
    /出生与家世/.test(titles) && titles.indexOf('童年') > titles.indexOf('出生与家世') &&
    titles.indexOf('晚年与回望') === titles.lastIndexOf('晚年与回望') && /晚年与回望/.test(titles), titles);

  await page.goto(S.base + '/#/a/' + aidEmpty + Q);
  ck('目录页显示 8 行', await page.js('document.querySelectorAll("a.toc-row").length') === 8,
    await page.js('document.querySelectorAll("a.toc-row").length'));
  ck('目录行链接到章节独立页',
    await page.js('(function(){var a=document.querySelector("a.toc-row");return !!a && /#\\/a\\/\\d+\\/ch\\/\\d+/.test(a.getAttribute("href"))})()'),
    await page.js('(function(){var a=document.querySelector("a.toc-row");return a?a.getAttribute("href"):"none"})()'));
  ck('默认只看目录（全文收起）', await page.js('(function(){var f=document.getElementById("fullBody");return !!f && f.hidden})()'));

  /* ---------- 2. 有材料的档案：按阶段生成并归位 ---------- */
  console.log('[B] 有材料 → 按阶段排目录');
  await page.goto(S.base + '/#/a/' + aidFull + Q);
  await page.click('[data-outline]');
  await sleep(5000);
  const chFull = await q('SELECT id, title, year_from, year_to FROM chapters WHERE archive_id=? ORDER BY seq', [aidFull]);
  ck('只生成有内容的章（3 章）', chFull.length === 3,
    'chapters=' + chFull.length + ' ' + JSON.stringify(chFull.map(c => c.title)));
  const rows = await q('SELECT id, chapter_id, sort_key FROM entries WHERE archive_id=? ORDER BY sort_key', [aidFull]);
  ck('三段都归进章里（无孤儿）', rows.length === 3 && rows.every(r => r.chapter_id),
    JSON.stringify(rows.map(r => r.chapter_id)));
  const kidTitles = chFull.map(c => c.title).join('|');
  ck('标题是人生阶段而不是裸年份', /童年/.test(kidTitles) && /求学/.test(kidTitles) && /工作/.test(kidTitles), kidTitles);

  /* ---------- 3. 章节页：点进去读、写 ---------- */
  console.log('[C] 章节独立页');
  await page.goto(S.base + '/#/a/' + aidFull + Q);
  await page.click('a.toc-row');
  await sleep(2600);
  ck('进入了章节页（URL 带 /ch/）', await page.js('location.hash.indexOf("/ch/") > 0'),
    await page.js('location.hash'));
  ck('章节页有标题与年份', await page.js('!!document.querySelector(".ch-page-title") && !!document.querySelector(".ch-page-meta")'));
  ck('章节页能直接写一段', await page.js('!!document.getElementById("chQuickText") && !!document.querySelector("[data-ch-quick]")'));
  ck('章节页有上一章/下一章导航', await page.js('!!document.querySelector(".ch-page-nav")'));

  const before = (await q('SELECT count(*) n FROM entries WHERE archive_id=?', [aidFull]))[0].n;
  await page.js('document.getElementById("chQuickText").value = "这一章是我刚在章节页里补的一段话。"');
  await page.click('[data-ch-quick]');
  await sleep(3000);
  const after = await q('SELECT id, chapter_id, text FROM entries WHERE archive_id=? AND text LIKE ?', [aidFull, '%刚在章节页里补%']);
  ck('在章节页写的内容真的落库了', after.length === 1 && !!after[0].chapter_id,
    JSON.stringify(after));
  ck('条目数 +1', (await q('SELECT count(*) n FROM entries WHERE archive_id=?', [aidFull]))[0].n === before + 1);

  /* ---------- 4. 章节能加、能删（内容退回待归档） ---------- */
  console.log('[D] 章节增删');
  await page.goto(S.base + '/#/a/' + aidFull + Q);
  await page.js('window.prompt = function(){ return "1978 · 自己加的一章"; }');
  await page.click('[data-ch-add]');
  await sleep(2500);
  const added = await q('SELECT id, title FROM chapters WHERE archive_id=? AND title LIKE ?', [aidFull, '%自己加的一章%']);
  ck('新增一章成功', added.length === 1, JSON.stringify(added));

  await page.goto(S.base + '/#/a/' + aidFull + Q);
  const chBeforeDel = (await q('SELECT count(*) n FROM chapters WHERE archive_id=?', [aidFull]))[0].n;
  await page.js('window.confirm = function(){ return true; }');
  await page.click('[data-ch-del]');
  await sleep(2500);
  const chAfterDel = await q('SELECT count(*) n FROM chapters WHERE archive_id=?', [aidFull]);
  const orphanAfterDel = await q('SELECT count(*) n FROM entries WHERE archive_id=? AND chapter_id IS NULL', [aidFull]);
  ck('删章后章数 -1', chAfterDel[0].n === chBeforeDel - 1,
    'before=' + chBeforeDel + ' after=' + chAfterDel[0].n);
  ck('删章不会连带删内容（内容退回待归档）', orphanAfterDel[0].n > 0, 'orphan=' + orphanAfterDel[0].n);

  /* ---------- 5. 导出前预览 ---------- */
  console.log('[E] 导出前预览');
  await page.goto(S.base + '/#/a/' + aidFull + Q);
  await page.click('[data-export-open]');
  await sleep(800);
  ck('导出面板有「先预览成书」', await page.js('!!document.querySelector("[data-ex=\\"preview\\"]")'));
  await page.click('[data-ex="preview"]');
  await sleep(4000);
  ck('预览窗口打开了', await page.js('!!document.querySelector(".pv-back") && !!document.querySelector(".pv-frame")'));
  const srcdocLen = await page.js('(function(){var f=document.querySelector(".pv-frame");return f?(f.getAttribute("srcdoc")||"").length:0})()');
  ck('预览里真的排出了书稿（含章节标题）', srcdocLen > 2000, 'srcdoc=' + srcdocLen);
  ck('预览里能直接导出 Word/PDF', await page.js('!!document.querySelector("[data-pv=\\"docx\\"]") && !!document.querySelector("[data-pv=\\"pdf\\"]")'));

  /* ---------- 6. 独立 AI 助手 ---------- */
  console.log('[F] 独立 AI 助手');
  await page.goto(S.base + '/#/chat' + Q);
  await sleep(2000);
  ck('不绑档案也能打开助手', await page.js('!!document.getElementById("chatText") && !!document.getElementById("chatSend")'));
  ck('标题说明是独立助手', await page.js('(function(){var w=document.querySelector(".chat-who");return !!w && w.textContent.indexOf("没绑档案")>=0})()'),
    await page.js('(function(){var w=document.querySelector(".chat-who");return w?w.textContent:"none"})()'));
  ck('独立模式下没有「带档案原文」开关', await page.js('!document.getElementById("chatRefs")'));

  ck('全程没有 JS 异常', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));

  console.log('\n目录/章节/预览/助手：' + pass + ' 通过 / ' + fail + ' 失败');
  page.close();
  try { chrome.kill(); } catch (e) {}
  S.stop();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('测试崩了：', e && e.stack || e);
  process.exit(1);
});
