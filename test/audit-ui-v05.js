/**
 * v0.5 端到端审计：用 CDP 真的点、真的存、真的生成文件。
 *
 * 覆盖四件事（这四件光看代码看不出来，必须跑）：
 *   ① 封面工坊改版式 → 真的写进库
 *   ② 时间轴插入一条 → 真的出现在 v_timeline
 *   ③ 导出 docx / pptx / pdf → 真的产出能被打开的文件
 *   ④ 助手页能起来、无配置时给出人话
 *
 * 用法： node test/audit-ui-v05.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9400 + Math.floor(Math.random() * 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 200) : '')); }
};

function getJson(p, method) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: CDP_PORT, path: p, method: method || 'GET' }, res => {
      let b = '';
      res.on('data', c => b += c);
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
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        p.errors.push('console.error: ' + (m.params.args || []).map(a => a.value || a.description).join(' '));
      }
    };
    return p;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(2200);
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){try{return (' + expr + ')}catch(e){return "ERR:"+e.message}})()',
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    }
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  }
  async click(sel) {
    return this.js('(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!el) return false; el.click(); return true;})()');
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try { return await getJson('/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('Chrome 没起来');
}

(async () => {
  const S = startServer('uiv05');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  /* 造一本有点内容的档案，外加一张真图（1×1 PNG，够验通道了） */
  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown, intro) VALUES ('MS-UI-1','张桂芳',1942,'山东济南','把三个孩子拉扯大')")).lastId;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await S.post('/api/file', { op: 'save', dir: 'photo', name: 'ui-test.png', base64: PNG }, token);
  await x("INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,1965,'济南','厂门口')", [aid, up.path]);
  await x('UPDATE archives SET cover_photo_id=1 WHERE id=?', [aid]);
  const ch1 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'第一章 · 西郊的院子',1942,1955)", [aid])).lastId;
  const ch2 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,20,'第二章 · 十六岁进厂',1956,1962)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited, at_year, at_precision, sort_key) VALUES (?,?,10,'text','天不亮就起来推磨，推完了才去上学。','user',1,1948,'year',10)", [aid, ch1]);
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited, at_year, at_precision, sort_key) VALUES (?,?,10,'text','一九五六年国棉三厂招工，我十六岁。','user',1,1956,'year',10)", [aid, ch2]);

  fs.mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });
  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-v05-prof');
  fs.rmSync(profileDir, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank',
  ], { stdio: 'ignore' });

  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

  const Q = '?token=' + token;

  /* ---------- A 档案页 ---------- */
  console.log('[A] 档案页');
  await page.goto(S.base + '/#/a/' + aid + Q);
  ck('封面渲染出来了', await page.js('!!document.querySelector(".cv")'));
  ck('封面有四个工具按钮', await page.js('document.querySelectorAll(".cover-tools .btn").length >= 4'));
  ck('封面与头像走同一份渲染', await page.js('!!document.querySelector(".cv-name")'));

  /* ---------- B 封面工坊 ---------- */
  console.log('[B] 封面工坊');
  await page.js('window.CoverUI.open(' + aid + ')');
  await sleep(800);
  ck('抽屉打开了', await page.js('!!document.querySelector(".sheet-back .cw")'));
  ck('有版式选项', await page.js('document.querySelectorAll("[data-style]").length === 4'));
  ck('有头像选择区', await page.js('!!document.querySelector("#cwPortrait")'));

  await page.js('document.querySelector(\'[data-style="ink"]\').click()');
  await sleep(150);
  ck('切换版式即时生效', await page.js('document.querySelector(".cw-stage .cv").className.indexOf("style-ink") >= 0'));
  await page.js('document.querySelector(\'[data-accent="#7B2E2E"]\').click()');
  await sleep(100);
  await page.js('document.querySelector("#cwPortrait [data-pt]:not([data-pt=\\"\\"])").click()');
  await sleep(200);
  await page.click('#cwSave');
  await sleep(1600);

  const aRow = (await q('SELECT cover_config_json, portrait_photo_id FROM archives WHERE id=?', [aid]))[0];
  let cfg = {};
  try { cfg = JSON.parse(aRow.cover_config_json || '{}'); } catch (e) {}
  ck('版式写进库了', cfg.style === 'ink', aRow.cover_config_json);
  ck('主色写进库了', cfg.accent === '#7B2E2E', cfg.accent);
  ck('头像写进库了', String(aRow.portrait_photo_id) === '1', String(aRow.portrait_photo_id));
  const thumbs = await q('SELECT * FROM derivations WHERE source_path=?', [up.path]);
  ck('生成了三档头像缩略图', thumbs.length >= 3, 'rows=' + thumbs.length);

  /* ---------- C 时间轴插叙 ---------- */
  console.log('[C] 时间轴');
  await page.goto(S.base + '/#/a/' + aid + '/timeline' + Q);
  ck('时间轴页起来了', await page.js('!!document.querySelector("#tlAdd")'));
  ck('按年分组了', await page.js('document.querySelectorAll(".tl-year").length >= 2'),
    await page.js('document.querySelectorAll(".tl-year").length'));
  await page.click('#tlAdd');
  await sleep(400);
  ck('插入抽屉打开了', await page.js('!!document.querySelector("#insYear")'));
  await page.js('document.querySelector("#insYear").value="1962"');
  await page.js('document.querySelector("#insMonth").value="3"');
  await page.js('document.querySelector("#insText").value="三月里换了车间，师傅姓孙。"');
  await page.click('#insSave');
  await sleep(1400);
  const ins = await q('SELECT * FROM v_timeline WHERE archive_id=? AND at_year=1962', [aid]);
  ck('插到 1962 年了', ins.length === 1, 'rows=' + ins.length);
  ck('自动归到第二章', String(ins[0] && ins[0].chapter_id) === String(ch2),
    'chapter=' + (ins[0] && ins[0].chapter_id) + ' 期望 ' + ch2);
  ck('月份也记下了', String(ins[0] && ins[0].at_month) === '3');

  /* 生成卷宗会重建章节——手写插叙必须跟着年份重新归位，不能变成孤儿 */
  await x("INSERT INTO segments (archive_id, raw_text, year_hint) VALUES (?,'一九五六年国棉三厂招工，我十六岁。',1956)", [aid]);
  await x("INSERT INTO segments (archive_id, raw_text, year_hint) VALUES (?,'一九六二年三月，我换了车间。',1962)", [aid]);
  const genOk = await page.js('window.DB.generate(' + aid + ').then(function(){return 1},function(e){return "ERR:"+e.message})');
  ck('生成卷宗能跑完', genOk === 1, String(genOk));
  const after = await q("SELECT chapter_id, at_year FROM entries WHERE text LIKE '%三月里换了车间%'");
  ck('生成后插叙还在', after.length === 1, 'rows=' + after.length);
  ck('生成后按年份归回章节', after.length === 1 && after[0].chapter_id !== null,
    JSON.stringify(after[0] || null));

  /* ---------- D 导出 ---------- */
  console.log('[D] 导出');
  const modelInfo = await page.js('window.Exporter.model(' + aid + ').then(function(m){' +
    'return {ch:m.chapters.length, blocks:(m.chapters[0]?m.chapters[0].blocks.length:0), words:m.meta.words};})');
  ck('文档模型建出来了', modelInfo && modelInfo.ch >= 2, JSON.stringify(modelInfo));
  ck('模型里有字数统计', modelInfo && modelInfo.words > 20, JSON.stringify(modelInfo));

  const htmlOk = await page.js('window.Exporter.model(' + aid + ').then(function(m){' +
    'var h=window.Exporter.html(m,{size:"a5",theme:"paper"});' +
    'return {page:h.indexOf("@page")>=0, toc:h.indexOf("目 录")>=0, ch:h.indexOf("<h2>")>=0, len:h.length};})');
  ck('印刷版 HTML 有分页规则', htmlOk && htmlOk.page);
  ck('印刷版有目录', htmlOk && htmlOk.toc);
  ck('印刷版有章节标题', htmlOk && htmlOk.ch);
  ck('HTML 长度合理', htmlOk && htmlOk.len > 2000, JSON.stringify(htmlOk));

  const docxRes = await page.js('window.Exporter.model(' + aid + ').then(function(m){' +
    'return window.Exporter.docx(m,{archiveId:' + aid + '});}).then(function(r){return r;})');
  ck('docx 生成成功', docxRes && docxRes.ok && docxRes.bytes > 3000, JSON.stringify(docxRes));

  const pptxRes = await page.js('window.Exporter.model(' + aid + ').then(function(m){' +
    'return window.Exporter.pptx(m,{archiveId:' + aid + '});}).then(function(r){return r;})');
  ck('pptx 生成成功', pptxRes && pptxRes.ok && pptxRes.bytes > 3000, JSON.stringify(pptxRes));

  const pdfRes = await page.js('window.Exporter.model(' + aid + ').then(function(m){' +
    'return window.Exporter.pdf(m,{size:"a5",theme:"paper",archiveId:' + aid + '});})');
  ck('PDF 生成成功（或给出可读的原因）', pdfRes && (pdfRes.ok ? pdfRes.bytes > 3000 : /Chrome|打印/.test(pdfRes.message || '')),
    JSON.stringify(pdfRes));

  const exRows = await q('SELECT kind, bytes FROM exports WHERE archive_id=?', [aid]);
  ck('导出记录落库', exRows.length >= 2, JSON.stringify(exRows));

  /* 真的能打开吗：查文件头与包内目录，别只看"生成成功" */
  function readExport(p) {
    const abs = path.join(S.DATA_DIR, 'users', '1', 'files', p);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  }
  const docxBuf = readExport((docxRes && docxRes.path) || '');
  ck('docx 是 zip 包（PK 头）', !!docxBuf && docxBuf.slice(0, 2).toString() === 'PK');
  ck('docx 里有 word/document.xml', !!docxBuf && docxBuf.indexOf('word/document.xml') >= 0);
  ck('docx 里有正文样式表', !!docxBuf && docxBuf.indexOf('word/styles.xml') >= 0);

  const pptxBuf = readExport((pptxRes && pptxRes.path) || '');
  ck('pptx 是 zip 包（PK 头）', !!pptxBuf && pptxBuf.slice(0, 2).toString() === 'PK');
  ck('pptx 里有幻灯片', !!pptxBuf && pptxBuf.indexOf('ppt/slides/slide1.xml') >= 0);
  ck('pptx 至少两页', !!pptxBuf && pptxBuf.indexOf('ppt/slides/slide2.xml') >= 0);

  const pdfBuf = pdfRes && pdfRes.ok ? readExport(pdfRes.path) : null;
  if (pdfRes && pdfRes.ok) {
    ck('pdf 有 %PDF 头', !!pdfBuf && pdfBuf.slice(0, 4).toString() === '%PDF');
    ck('pdf 不是空壳', !!pdfBuf && pdfBuf.length > 5000, pdfBuf && pdfBuf.length);
  } else {
    ck('没装 Chrome 时给了可操作提示', /Chrome|打印/.test(pdfRes && pdfRes.message || ''), JSON.stringify(pdfRes));
  }

  /* ---------- E 助手页 ---------- */
  console.log('[E] 助手');
  await page.goto(S.base + '/#/a/' + aid + '/chat' + Q);
  ck('助手页起来了', await page.js('!!document.querySelector("#chatText")'));
  ck('五个角色', await page.js('document.querySelectorAll("[data-role]").length === 5'),
    await page.js('document.querySelectorAll("[data-role]").length'));
  ck('有无配置时的引导语', await page.js('!!document.querySelector(".chat-empty")'));

  /* ---------- F 控制台干净 ---------- */
  console.log('[F] 控制台');
  const errs = page.errors.filter(e => String(e).indexOf('favicon') < 0);
  ck('页面没有未捕获异常', errs.length === 0, errs.join(' | '));

  page.close();
  try { chrome.kill(); } catch (e) {}
  await x('DELETE FROM archives WHERE id=?', [aid]);
  S.stop();
  console.log('\nv0.5 界面与导出: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error('审计崩了：' + (e && e.stack || e));
  try { process.exit(1); } catch (e2) {}
});
