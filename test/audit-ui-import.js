/**
 * 导入审计（界面）：重复导入怎么办 + 能不能用 Word 文档建档案。
 *
 * 用户的原话：
 *   「我导出了档案，然后又导入了档案，生成了原来档案一模一样的档案，没有覆盖原档案，
 *     也没有改档案编号，没有修改档案名字。这是等于重复的档案吧。」
 *   「我导出了word文档，但是程序没有导入word文档生成档案的功能，能不能实现。」
 *
 * 这里真点真写库验证：
 *   A. 导同一本进来 → 先问「覆盖 / 另存」，不再默默多一本
 *   B. 选另存 → 名字加（副本）、编号重新发，原来那本一个字节没动
 *   C. 选覆盖 → id 不变、内容换成文件里的
 *   D. 选 Word → 先给预览（几章几段几字几图，名字可改）→ 建成档案（章/段/图都在）
 *
 * 用法： node test/audit-ui-import.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');
const docx = require('./_docx.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9960 + Math.floor(Math.random() * 60);
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
  async run(stmt) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){try{' + stmt + '}catch(e){return "ERR:"+e.message}})()',
      returnByValue: true, awaitPromise: true,
    });
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

/** 数据目录里按文件名找文件（用户号是多少不用关心） */
function findFile(dir, base) {
  let hit = '';
  (function walk(d) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      if (hit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === base) hit = p;
    }
  })(dir);
  return hit;
}

/** 在页面里"选一个文件"：造 File → 塞进 input → 触发 change */
function pickFileStmt(inputId, b64, name, mime, asText) {
  return '(function(){' +
    'var inp=document.getElementById(' + JSON.stringify(inputId) + ');if(!inp)return "ERR:没有文件框";' +
    'var bin=atob(' + JSON.stringify(b64) + ');' +
    'var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);' +
    'var f=new File([u8],' + JSON.stringify(name) + ',{type:' + JSON.stringify(mime) + '});' +
    'var dt=new DataTransfer();dt.items.add(f);inp.files=dt.files;' +
    'inp.dispatchEvent(new Event("change"));return "ok";})()';
}

(async () => {
  const S = startServer('uiimport');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  /* 库里先有一本「导入测试」，编号 MS-2099-0001 */
  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-2099-0001','导入测试',1950,'江西石城')")).lastId;
  const cid = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'库里的第一章',1950,1960)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text) VALUES (?,?,10,'text','库里原本的这一段')", [aid, cid]);

  /* 导出文件（同一本：同名字同编号，内容换掉，好分辨覆盖有没有生效） */
  const pack = {
    format: 'mylife-archive', version: 1, exported_at: '2026-10-28T02:00:00.000Z',
    archive: {
      id: 1, subject_name: '导入测试', archive_no: 'MS-2099-0001',
      birth_year: 1950, death_year: null, hometown: '江西石城', intro: '文件里的自序',
      cover_photo_id: null,
    },
    chapters: [{ id: 11, seq: 10, title: '文件里的第一章', year_from: 1950, year_to: 1960, stage: '幼年', quote: null, summary: null }],
    entries: [
      { id: 21, chapter_id: 11, seq: 10, kind: 'text', text: '文件里的第一段', photo_id: null, media_id: null, segment_id: null, origin: 'ai', edited: 0 },
      { id: 22, chapter_id: 11, seq: 20, kind: 'text', text: '文件里的第二段', photo_id: null, media_id: null, segment_id: null, origin: 'ai', edited: 0 },
    ],
    photos: [], segments: [], media: [],
  };
  const packB64 = Buffer.from(JSON.stringify(pack), 'utf8').toString('base64');

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-import-prof');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  /* ---------- A. 导同一本：先问怎么办 ---------- */
  console.log('[A] 导同一本要问一句');
  await page.goto(S.base + '/#/' + Q);
  ck('首页有导入入口（有档案也照样在）', await page.js('!!document.getElementById("importFile")'));
  ck('接受 .docx', await page.js('(function(){var i=document.getElementById("importFile");return i&&/\\.docx/.test(i.getAttribute("accept")||"")})()'));
  await page.run(pickFileStmt('importFile', packB64, '导入测试.mylife.json', 'application/json'));
  await sleep(1600);
  const sheetTxt = await page.js('(function(){var m=document.querySelector(".ml-modal");return m?m.textContent:""})()');
  ck('弹出「库里已经有」的选择框', String(sheetTxt).indexOf('库里已经有') >= 0, sheetTxt);
  ck('说清楚是哪一本（带编号）', String(sheetTxt).indexOf('MS-2099-0001') >= 0, sheetTxt);
  ck('给了「覆盖」这一项', await page.js('!!document.querySelector(\'[data-im="replace"]\')'));
  ck('给了「另存」这一项', await page.js('!!document.querySelector(\'[data-im="copy"]\')'));
  ck('覆盖项里写了会清掉多少东西',
    /1 章.*1 条内容/.test(String(await page.js('(function(){var b=document.querySelector(\'[data-im="replace"]\');return b?b.textContent:""})()'))),
    await page.js('(function(){var b=document.querySelector(\'[data-im="replace"]\');return b?b.textContent:""})()'));

  /* ---------- B. 另存：名字加副本、编号重发 ---------- */
  console.log('[B] 选「当成另一本存进来」');
  await page.click('[data-im="copy"]');
  await sleep(3500);
  const arcs = await q('SELECT id, subject_name, archive_no FROM archives WHERE deleted_at IS NULL ORDER BY id');
  const copy = arcs.filter(a => a.id !== aid);
  ck('多出了第二本', copy.length === 1, JSON.stringify(arcs));
  ck('名字带（副本）', copy[0] && copy[0].subject_name === '导入测试（副本）', copy[0] && copy[0].subject_name);
  ck('编号重新发了（不再撞号）', copy[0] && copy[0].archive_no !== 'MS-2099-0001', copy[0] && copy[0].archive_no);
  ck('原档案一点没动（还是 1 段）',
    (await q('SELECT COUNT(*) n FROM entries WHERE archive_id=?', [aid]))[0].n === 1);
  ck('副本里是文件内容（2 段）',
    (await q('SELECT COUNT(*) n FROM entries WHERE archive_id=?', [copy[0].id]))[0].n === 2);
  ck('导入后自动跳到那本新档案',
    String(await page.js('location.hash')).indexOf('#/a/' + copy[0].id) === 0,
    await page.js('location.hash'));

  /* ---------- C. 覆盖：id 不变，内容换掉 ---------- */
  console.log('[C] 选「覆盖现在这一本」');
  await page.goto(S.base + '/#/' + Q);
  await page.run(pickFileStmt('importFile', packB64, '导入测试.mylife.json', 'application/json'));
  await sleep(1600);
  ck('又弹出选择框', await page.js('!!document.querySelector(\'[data-im="replace"]\')'));
  await page.click('[data-im="replace"]');
  await sleep(4000);
  const after = await q('SELECT id, subject_name, archive_no FROM archives WHERE id=?', [aid]);
  ck('原档案还在，id 没变', after.length === 1 && after[0].id === aid, JSON.stringify(after));
  ck('编号没变', after[0] && after[0].archive_no === 'MS-2099-0001', after[0] && after[0].archive_no);
  const chs = await q('SELECT id, title FROM chapters WHERE archive_id=? ORDER BY seq', [aid]);
  ck('章节换成了文件里的', chs.length === 1 && chs[0].title === '文件里的第一章', JSON.stringify(chs));
  const ents = await q('SELECT text FROM entries WHERE archive_id=? ORDER BY seq', [aid]);
  ck('内容换成了文件里的（2 段）', ents.length === 2 && ents[0].text === '文件里的第一段',
    JSON.stringify(ents.map(e => e.text)));
  ck('旧的那段"库里原本的这一段"没了', !ents.some(e => e.text === '库里原本的这一段'));
  ck('覆盖不碰另一本副本',
    (await q('SELECT COUNT(*) n FROM entries WHERE archive_id=?', [copy[0].id]))[0].n === 2);

  /* ---------- D. Word 导入 ---------- */
  console.log('[D] 用 Word 文档建档案');
  const buf = docx.likeExport({
    no: 'MS-2099-0777', name: '王阿婆', years: '1938—', intro: '一辈子在灶台边。',
    chapters: [
      {
        title: '灶台边', years: '1938', stage: '幼年', quote: '那时候一盏煤油灯要点到半夜。',
        paras: ['我 1938 年生在岭下村，家里七个孩子。', '九岁开始学着做饭，锅比我还高。'],
        photoCaption: '1948 · 老屋灶间 · 王阿婆',
      },
      { title: '嫁到镇上', years: '1958', stage: '青年', paras: ['1958 年嫁到镇上，丈夫在供销社上班。'] },
    ],
  });
  await page.goto(S.base + '/#/' + Q);
  await page.run(pickFileStmt('importFile', buf.toString('base64'), '王阿婆-20261028.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  await sleep(4000);
  const pvTxt = await page.js('(function(){var m=document.querySelector(".imp-modal");return m?m.textContent:""})()');
  ck('先给预览，不直接入库', String(pvTxt).indexOf('读成了 2 章') >= 0, pvTxt.slice(0, 160));
  ck('预览里有段数字数', /3 段 · \d+ 字 · 1 张图片/.test(String(pvTxt)), pvTxt);
  ck('预览里列了章名', String(pvTxt).indexOf('灶台边') >= 0);
  ck('名字可以改（有输入框）', await page.js('!!document.getElementById("impName")'));
  ck('预填的是文档里的名字', (await page.js('(function(){var i=document.getElementById("impName");return i?i.value:""})()')) === '王阿婆',
    await page.js('(function(){var i=document.getElementById("impName");return i?i.value:""})()'));
  ck('检查前库里还没有王阿婆',
    (await q("SELECT COUNT(*) n FROM archives WHERE subject_name='王阿婆'"))[0].n === 0);
  await page.js('(function(){document.getElementById("impName").value="王阿婆（口述）";return 1})()');
  await page.click('[data-imp="go"]');
  await sleep(5000);

  const wa = await q("SELECT id, subject_name, archive_no, birth_year FROM archives WHERE subject_name='王阿婆（口述）'");
  ck('Word 建成了一本档案', wa.length === 1, JSON.stringify(wa));
  ck('编号沿用了文档里的', wa[0] && wa[0].archive_no === 'MS-2099-0777', wa[0] && wa[0].archive_no);
  ck('出生年读对了', wa[0] && wa[0].birth_year === 1938, wa[0] && wa[0].birth_year);
  const wch = await q('SELECT id, title, year_from, stage, quote FROM chapters WHERE archive_id=? ORDER BY seq', [wa[0].id]);
  ck('2 章都在', wch.length === 2, JSON.stringify(wch));
  ck('章标题对', wch[0] && wch[0].title === '灶台边', wch[0] && wch[0].title);
  ck('章头年份/阶段对', wch[0] && wch[0].year_from === 1938 && wch[0].stage === '幼年', JSON.stringify(wch[0]));
  ck('章引语入位', wch[0] && wch[0].quote === '那时候一盏煤油灯要点到半夜。', wch[0] && wch[0].quote);
  const went = await q('SELECT kind, text, chapter_id FROM entries WHERE archive_id=? ORDER BY seq', [wa[0].id]);
  ck('正文 3 段 + 1 张图条目', went.length === 4, went.length);
  const pe = went.filter(e => e.kind === 'photo')[0];
  ck('图片条目挂在第 1 章', pe && String(pe.chapter_id) === String(wch[0].id),
    JSON.stringify({ pe: pe && pe.chapter_id, ch: wch[0] && wch[0].id }));
  const wph = await q('SELECT id, path, taken_year, place, event FROM photos WHERE archive_id=?', [wa[0].id]);
  ck('照片登记了 1 张', wph.length === 1, JSON.stringify(wph));
  ck('图注拆成了年/地点/事件',
    wph[0] && wph[0].taken_year === 1948 && wph[0].place === '老屋灶间' && wph[0].event === '王阿婆',
    JSON.stringify(wph[0]));
  const abs = wph[0] ? findFile(S.DATA_DIR, path.basename(wph[0].path)) : '';
  ck('照片文件真的落盘了', abs && fs.existsSync(abs) && fs.statSync(abs).size > 50, abs);
  ck('导入后跳到了这本档案', String(await page.js('location.hash')).indexOf('#/a/' + wa[0].id) === 0,
    await page.js('location.hash'));

  /* ---------- E. 收尾 ---------- */
  console.log('[E] 收尾');
  ck('全程没有 JS 异常', page.errors.length === 0, (page.errors || []).slice(0, 2).join(' | '));
  await page.goto(S.base + '/#/' + Q);
  ck('导入入口处的旧文案没回退', await page.js('(function(){var b=document.getElementById("importBtn");return b?/Word/.test(b.textContent):false})()'));

  page.close();
  try { chrome.kill(); } catch (e) {}
  S.stop();
  console.log('\n  ' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})();
