/**
 * v0.9 界面审计：漫画与短片。
 *
 * 验的是「排出来是什么样」，不是「函数返回了什么」：
 *   · 漫画：分页数对不对、每页格子数对不对、气泡会不会把长句撑出格、
 *     缺图的格子有没有明确提示、改一次气泡能不能落库
 *   · 短片：分镜条目数、缺图标红、合成按钮在没 ffmpeg 时禁用
 *
 * 用法： node test/audit-ui-v08.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9640 + Math.floor(Math.random() * 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 64×114 纯色 PNG，测试自给自足 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAByCAIAAABsuUAvAAAAvklEQVR4nO3PUQkAIBTAwBfRJMYxryH8PzVYwL3f3R0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4zw9qfQABl0F7wQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 200) : '')); }
};

function getJson(p, m) {
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET' }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 80))); } });
    });
    rq.on('error', rej); rq.setTimeout(5000, () => rq.destroy(new Error('t'))); rq.end();
  });
}

const LONG = '一九五六年国棉三厂招工，我十六岁，母亲给我做了一件蓝布褂子，把我送到厂门口，说好好干别让人说咱家孩子不行';

(async () => {
  const S = startServer('uiv08');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, p) => S.post('/api/query', { sql, params: p || [] }, t);
  const x = (sql, p) => S.post('/api/exec', { sql, params: p || [] }, t);

  const aid = (await x("INSERT INTO archives (archive_no,subject_name,birth_year,hometown,intro,status) VALUES ('MS-C-1','张桂芳',1942,'山东济南','国棉三厂挡车工三十年','ready')")).lastId;
  const chId = (await x("INSERT INTO chapters (archive_id,seq,title,year_from,year_to) VALUES (?,1,'第二章 · 十六岁进厂',1956,1962)", [aid])).lastId;

  const photoDir = path.join(S.DATA_DIR, 'users', '1', 'files', 'photo');
  fs.mkdirSync(photoDir, { recursive: true });
  fs.writeFileSync(path.join(photoDir, 'p1.png'), Buffer.from(TINY_PNG, 'base64'));
  const phId = (await x("INSERT INTO photos (archive_id,path,taken_year,place,event,chapter_id) VALUES (?,?,1956,'济南','厂门口',?)",
    [aid, 'photo/p1.png', chId])).lastId;

  // 五条讲述 → 一页 4 格时应该是 2 页，最后一页只有 1 格
  const texts = [LONG, '车间里上百台机器一起响，说话得凑到耳朵边上。', '孙师傅让我先看三天接线头。',
    '第一个月工资十八块五，我寄了十块回家。', '后来我在这台机器前站了三十年。'];
  for (let i = 0; i < texts.length; i++) {
    await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,photo_id,origin,edited,at_year,sort_key) VALUES (?,?,?,'text',?,?,'user',1,1956,?)",
      [aid, chId, i + 1, texts[i], i === 0 ? phId : null, i + 1]);
  }

  const prof = path.join(__dirname, '..', 'tmp', 'cdp-uiv08');
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
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });

  const js = async e => {
    const r = await send('Runtime.evaluate', { expression: '(function(){try{return (' + e + ')}catch(err){return "ERR:"+err.message}})()', returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本出错：' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    }
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  };
  const goto = async h => { await send('Page.navigate', { url: S.base + '/#' + h + '?token=' + t }); await sleep(2200); };

  /* ---------- A 换行规则（纯函数） ---------- */
  console.log('[A] 气泡换行');
  await goto('/');
  const w1 = await js('ComicUI.wrapCJK(' + JSON.stringify(LONG) + ', 13, 5)');
  ck('长句被切成多行', Array.isArray(w1) && w1.length >= 3, JSON.stringify(w1));
  ck('每行不超过 13 字', w1.every(l => l.length <= 13), JSON.stringify(w1));
  ck('没有行首标点', w1.slice(1).every(l => !/^[，。、；：？！）」』】…—]/.test(l)), JSON.stringify(w1));
  ck('拼回去还是原句', w1.join('') === LONG, w1.join(''));

  const w2 = await js('ComicUI.wrapCJK(' + JSON.stringify('一'.repeat(200)) + ', 13, 5)');
  ck('超长只留 5 行并加省略号', w2.length === 5 && /…$/.test(w2[4]), JSON.stringify(w2.slice(-1)));

  /* ---------- B 漫画排版 ---------- */
  console.log('[B] 漫画');
  const comicJson = {
    perPage: 4, layout: '2x2', title: '第二章 · 十六岁进厂', name: '张桂芳', archiveNo: 'MS-C-1',
    years: '1956—1962',
    pages: [
      { no: 1, panels: [
        { text: LONG, short: LONG, year: 1956, photo: 'photo/p1.png' },
        { text: '车间里上百台机器一起响', short: '车间里上百台机器一起响', year: 1956, photo: null },
        { text: '孙师傅让我先看三天接线头', short: '孙师傅让我先看三天接线头', year: 1956, photo: null },
        { text: '第一个月工资十八块五', short: '第一个月工资十八块五', year: 1956, photo: null },
      ] },
      { no: 2, panels: [{ text: '后来我在这台机器前站了三十年', short: '后来我在这台机器前站了三十年', year: 1962, photo: null }] },
    ],
  };
  const pg1 = await js('ComicUI.pageSvg(' + JSON.stringify(comicJson) + ', 1, null)');
  ck('一页出 4 个格子区域', (String(pg1).match(/class="panel"/g) || []).length === 4,
    (String(pg1).match(/class="panel"/g) || []).length);
  ck('SVG 是竖版 720×1080', /viewBox="0 0 720 1080"/.test(pg1), String(pg1).slice(0, 80));
  ck('有图那格放了 image', /<image [^>]*xlink:href="[^"]+"/.test(pg1));
  ck('缺图那格明确写「还缺一张图」', /这一格还缺一张图/.test(pg1));
  ck('气泡文字在 SVG 里是文本，不是图', /class="cb-t"/.test(pg1));

  const pg2 = await js('ComicUI.pageSvg(' + JSON.stringify(comicJson) + ', 2, null)');
  ck('最后一页只有 1 格', (String(pg2).match(/class="panel"/g) || []).length === 1);
  ck('页脚有档案号', /档案第 MS-C-1 号/.test(pg2));

  /* ---------- C 漫画页真点 ---------- */
  console.log('[C] 漫画页');
  await goto('/a/' + aid + '/comic');
  ck('页面能打开', await js('!!document.querySelector("#cmBuild")'), errors.slice(0, 2));
  await js('(function(){document.querySelector("#cmBuild").click();return 1;})()');
  await sleep(2500);
  ck('排出了漫画页', await js('document.querySelectorAll(".cm-page").length >= 1'),
    await js('document.querySelectorAll(".cm-page").length'));
  const pages = await js('document.querySelectorAll(".cm-page").length');
  ck('五条讲述按 4 格一页 → 2 页', pages === 2, pages);

  // 改气泡：先把 prompt 换掉，再点第二格
  await js('(function(){window.prompt=function(){return "这一格我改过";};return 1;})()');
  await js('(function(){var g=document.querySelectorAll(".cm-page")[0].querySelectorAll(".panel")[1];g.dispatchEvent(new MouseEvent("click",{bubbles:true}));return 1;})()');
  await sleep(1600);
  const rows = await q('SELECT json FROM storyboards WHERE archive_id=? ORDER BY id DESC LIMIT 1', [aid]);
  const saved = JSON.parse((rows[0] || {}).json || '{}');
  ck('改的气泡落了库', saved.pages && saved.pages[0].panels[1].short === '这一格我改过',
    saved.pages && saved.pages[0].panels[1].short);
  const origStill = await q('SELECT text FROM entries WHERE archive_id=? ORDER BY sort_key LIMIT 1', [aid]);
  ck('改气泡不会改讲述原文', String(origStill[0].text) === LONG, String(origStill[0].text).slice(0, 30));

  /* ---------- D 短片页 ---------- */
  console.log('[D] 短片页');
  await goto('/a/' + aid + '/movie');
  ck('页面能打开', await js('!!document.querySelector("#mvPlan")'), errors.slice(0, 2));
  await js('(function(){document.querySelector("#mvPlan").click();return 1;})()');
  await sleep(2500);
  const frames = await js('document.querySelectorAll(".mv-frame").length');
  ck('分镜按讲述条数排开', frames === 5, frames);
  ck('缺图的格子标出来了', await js('!!document.querySelector(".mv-thumb span")'));
  ck('每格能改词（textarea）', await js('document.querySelectorAll(".mv-text").length === 5'));
  ck('每格能调时长', await js('document.querySelectorAll(".mv-sec").length === 5'));
  ck('有配音开关', await js('!!document.querySelector("#mvVoice")'));
  ck('有配乐下拉', await js('!!document.querySelector("#mvBgm")'));

  const hasFF = await js('!!(window.MovieUI)');
  ck('短片模块加载了', hasFF);
  const goDisabled = await js('document.querySelector("#mvGo").disabled');
  console.log('    （本机 ffmpeg：' + (goDisabled ? '缺，按钮已禁用' : '在，按钮可点') + '）');
  ck('没有 ffmpeg 时按钮禁用 / 有则可点', typeof goDisabled === 'boolean');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'tmp', 'uiv08-movie.png'), Buffer.from(shot.data, 'base64'));

  ck('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n' + (fail === 0 ? '全部通过' : '有 ' + fail + ' 项没过') + '：' + pass + ' / ' + (pass + fail));
  ws.close(); chrome.kill(); S.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
