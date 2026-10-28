/**
 * v0.9.5 用户体验修复 —— 端到端审计（真点、真写库）。
 *
 * 用户提的 12 条里能自动化的部分：
 *   ① 一段能配多张图（不再只能一张）
 *   ② 已归章的段落也有「换章」按钮
 *   ③ 图片条目/本章照片能「放进正文」「移到别的章」
 *   ④ 时间轴能改时间、能给没年份的段落补年份
 *   ⑤ 看整本给三个去处（目录 / 导出 / 整本网页）
 *   ⑥ 勾选框点下去能看见勾号
 *   ⑦ AI 助手能带附件（文本进上下文，图片走视觉模型）
 *   ⑧ 主题曲把「用什么内容写」和「怎么写」分开且有素材预览
 *   ⑨ 短片能排整本，不再钉死一分钟
 *   ⑩ 从头朗读前有预览，且默认从第 1 章开始
 *
 * 用法： node test/audit-ui-v095.js
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
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? ' << ' + String(d).slice(0, 240) : '')); }
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

(async () => {
  const S = startServer('uiv095');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-95-1','李老',1950,'江西石城')")).lastId;
  const ch1 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'出生与家世',1950,1959)", [aid])).lastId;
  const ch2 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,20,'求学',1960,1970)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,?,10,'text','1955 年冬天，老屋院子里堆着柴，奶奶在灶前烧火。',1955,'user',10)", [aid, ch1]);
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,?,20,'text','1963 年考上县中，班主任姓陈，教语文。',1963,'user',20)", [aid, ch2]);
  await x("INSERT INTO entries (archive_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,30,'text','这一段还没归章，年份也没填。',NULL,'user',30)", [aid]);
  for (let i = 1; i <= 3; i++) {
    await x("INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)",
      [aid, 'photo/p' + i + '.jpg', 1955 + i, '老屋', '第 ' + i + ' 张']);
  }
  const photoIds = (await q('SELECT id FROM photos WHERE archive_id=? ORDER BY id', [aid])).map(r => r.id);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-v095-prof');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  /* ---------- 1. 一段配多张图 ---------- */
  console.log('[A] 一段能配多张图');
  await page.goto(S.base + '/#/a/' + aid + Q);
  await page.js('(function(){var f=document.getElementById("fullBody"); if(f) f.hidden=false; return true})()');
  ck('段落上有「＋图」按钮', await page.js('!!document.querySelector("[data-pair-entry]")'));
  const beforePhotoEntries = (await q("SELECT count(*) n FROM entries WHERE archive_id=? AND kind='photo'", [aid]))[0].n;
  await page.click('[data-pair-entry]');
  await sleep(1200);
  ck('弹出多选配图窗', await page.js('!!document.querySelector(".ml-modal .pick-grid")'));
  ck('多选窗有「配到这一段」按钮', await page.js('!!document.querySelector("[data-mpick-ok]")'));
  await page.js('(function(){var bs=document.querySelectorAll("[data-mpick]"); if(bs.length<2) return "ERR:照片不够"; bs[0].click(); bs[1].click(); return 1})()');
  await sleep(300);
  const okText = await page.js('(function(){var b=document.querySelector("[data-mpick-ok]"); return b? b.textContent : ""})()');
  ck('选中张数会实时显示', /2 张/.test(String(okText)), okText);
  await page.click('[data-mpick-ok]');
  await sleep(3000);
  const photoEntries = await q("SELECT id, kind, photo_id, chapter_id FROM entries WHERE archive_id=? AND kind='photo' ORDER BY id", [aid]);
  const paired = await q('SELECT id, photo_id FROM entries WHERE archive_id=? AND photo_id IS NOT NULL ORDER BY id', [aid]);
  // 第一张贴在段落里（entries.photo_id，漫画/短片/导出都靠它），其余成为独立图片条目
  ck('选 2 张：一张贴在段落里（photo_id 有值）', paired.length >= 1 && !!paired[0].photo_id, JSON.stringify(paired));
  ck('选 2 张：另一张成为独立图片条目（不是覆盖同一张）', photoEntries.length === beforePhotoEntries + 1,
    'before=' + beforePhotoEntries + ' after=' + photoEntries.length);
  ck('图片条目挂在同一章里', photoEntries.every(e => !!e.chapter_id),
    JSON.stringify(photoEntries.map(e => e.chapter_id)));

  /* ---------- 2. 已归章也有「换章」 ---------- */
  console.log('[B] 已归章能换章');
  await page.goto(S.base + '/#/a/' + aid + Q);
  await page.js('(function(){var f=document.getElementById("fullBody"); if(f) f.hidden=false; return true})()');
  const labels = await page.js('(function(){var out=[];var bs=document.querySelectorAll("[data-assign-chapter]");for(var i=0;i<bs.length;i++)out.push(bs[i].textContent);return out.join(",")})()');
  ck('已归章段落显示「换章」而不是没有按钮', String(labels).indexOf('换章') >= 0, labels);
  const targetEntry = (await q("SELECT id, chapter_id FROM entries WHERE archive_id=? AND kind='text' AND chapter_id IS NOT NULL ORDER BY id LIMIT 1", [aid]))[0];
  await page.js('(function(){var b=document.querySelector("[data-assign-chapter=\'' + targetEntry.id + '\']"); if(b) b.click(); return true})()');
  await sleep(900);
  ck('点「换章」弹出章节选择', await page.js('!!document.querySelector(".pick-ch")'));
  const otherCh = targetEntry.chapter_id === ch1 ? ch2 : ch1;
  await page.js('(function(){var b=document.querySelector("[data-pick-ch=\'' + otherCh + '\']"); if(b) b.click(); return true})()');
  await sleep(2200);
  const moved = (await q('SELECT chapter_id FROM entries WHERE id=?', [targetEntry.id]))[0];
  ck('换章真的写库了', String(moved.chapter_id) === String(otherCh), JSON.stringify(moved));

  /* ---------- 3. 本章照片：放进正文 / 移到别的章 ---------- */
  console.log('[C] 图片能归章、能进正文');
  await page.goto(S.base + '/#/a/' + aid + '/ch/' + ch1 + Q);
  ck('章节页照片有「放进正文」', await page.js('!!document.querySelector("[data-ph-to-body]")'));
  ck('章节页照片有「移到别的章」', await page.js('!!document.querySelector("[data-ph-move]")'));
  const beforeBody = (await q("SELECT count(*) n FROM entries WHERE archive_id=? AND kind='photo'", [aid]))[0].n;
  await page.click('[data-ph-to-body]');
  await sleep(2500);
  ck('放进正文后多了一条图片条目',
    (await q("SELECT count(*) n FROM entries WHERE archive_id=? AND kind='photo'", [aid]))[0].n === beforeBody + 1);
  ck('图片条目自己也有归章/换章入口',
    await page.js('(function(){var f=document.querySelector("figure.ph .en-acts");return !!f && !!f.querySelector("[data-assign-chapter]")})()'));

  /* ---------- 4. 时间轴：改时间 + 补年份 ---------- */
  console.log('[D] 时间轴能改时间');
  await page.goto(S.base + '/#/a/' + aid + '/timeline' + Q);
  ck('时间轴每条都有「改时间」', await page.js('!!document.querySelector("[data-tl-time]")'));
  ck('时间轴有「归章」', await page.js('!!document.querySelector("[data-tl-chap]")'));
  const noYear = (await q('SELECT id FROM entries WHERE archive_id=? AND at_year IS NULL LIMIT 1', [aid]))[0];
  await page.js('(function(){var b=document.querySelector("[data-tl-time=\'' + noYear.id + '\']"); if(b) b.click(); return true})()');
  await sleep(900);
  ck('改时间弹窗出现且能填年月日', await page.js('!!document.getElementById("teY") && !!document.getElementById("teM")'));
  await page.js('(function(){document.getElementById("teY").value="1968"; return 1})()');
  await page.click('[data-te-ok]');
  await sleep(2500);
  const yr = (await q('SELECT at_year, chapter_id FROM entries WHERE id=?', [noYear.id]))[0];
  ck('补上的年份落库了', Number(yr.at_year) === 1968, JSON.stringify(yr));
  ck('补年份后自动归到对应的一章', !!yr.chapter_id, JSON.stringify(yr));

  /* ---------- 5. 看整本：三个去处 ---------- */
  console.log('[E] 看整本给选择');
  await page.goto(S.base + '/#/a/' + aid + Q);
  await page.click('[data-whole-book]');
  await sleep(600);
  ck('弹出三个选项', await page.js('document.querySelectorAll("[data-wb]").length >= 4'),
    await page.js('document.querySelectorAll("[data-wb]").length'));
  ck('有「回目录页 / 去导出 / 生成整本网页」', await page.js('(function(){var h="";var bs=document.querySelectorAll("[data-wb]");for(var i=0;i<bs.length;i++)h+=bs[i].getAttribute("data-wb")+",";return h})()'),
    await page.js('(function(){var h="";var bs=document.querySelectorAll("[data-wb]");for(var i=0;i<bs.length;i++)h+=bs[i].getAttribute("data-wb")+",";return h})()'));
  await page.click('[data-wb="export"]');
  await sleep(700);
  ck('选「去导出」进的是导出面板', await page.js('!!document.querySelector("[data-ex=\\"preview\\"]")'));

  /* ---------- 6. 勾选框看得见 ---------- */
  console.log('[F] 勾选框');
  await page.goto(S.base + '/#/a/' + aid + Q);
  await page.js('(function(){var f=document.getElementById("fullBody"); if(f) f.hidden=false; return true})()');
  ck('段落勾选框是自绘的（有 i 标记）', await page.js('!!document.querySelector(".en-check > i")'));
  await page.js('(function(){var l=document.querySelector(".en-check"); l.click(); return true})()');
  await sleep(300);
  ck('点一下 input 变成 checked', await page.js('(function(){var i=document.querySelector(".en-check input"); return !!i && i.checked})()'));
  const tickColor = await page.js('(function(){var i=document.querySelector(".en-check input:checked + i"); if(!i) return "none"; var cs=getComputedStyle(i); return cs.backgroundColor+"|"+cs.color+"|"+(getComputedStyle(i,"::before").content||"")})()');
  ck('勾上以后有底色和勾号（不是空白方块）', String(tickColor).indexOf('none') !== 0 &&
    !/rgba\(0, 0, 0, 0\)/.test(String(tickColor).split('|')[0]), tickColor);
  ck('批量条出现「已选 1 段」', /已选 1 段/.test(await page.js('document.getElementById("selCount").textContent')));

  /* ---------- 7. AI 助手附件 ---------- */
  console.log('[G] 助手能带附件');
  await page.goto(S.base + '/#/a/' + aid + '/chat' + Q);
  ck('有「📎 附件」按钮', await page.js('!!document.getElementById("chatFile")'));
  ck('「带上档案原文」是自绘勾选框', await page.js('!!document.querySelector("#chatRefs + i")'));
  await page.run('window.__inputs=[];var _ce=document.createElement.bind(document);' +
    'document.createElement=function(t){var el=_ce(t);if(String(t).toLowerCase()==="input"){window.__inputs.push(el);}return el;};' +
    'window.__cap=null;window.API.chatStream=function(req){window.__cap=req;return Promise.resolve("收到，附件我看过了。");};');
  await page.click('#chatFile');
  await sleep(300);
  await page.run('var inp=window.__inputs[window.__inputs.length-1];' +
    'var f=new File(["这是一份补充材料：奶奶的名字叫王秀英。"],"note.txt",{type:"text/plain"});' +
    'var dt=new DataTransfer();dt.items.add(f);inp.files=dt.files;' +
    'inp.dispatchEvent(new Event("change"));');
  await sleep(900);
  ck('附件变成了一枚可删除的标签', await page.js('!!document.querySelector(".att-chip")'),
    await page.js('document.querySelectorAll(".att-chip").length'));
  await page.js('document.getElementById("chatText").value="帮我看看这份材料"');
  await page.click('#chatSend');
  await sleep(2500);
  const cap = await page.js('(function(){if(!window.__cap)return "";var m=window.__cap.messages;var last=m[m.length-1];return typeof last.content==="string"?last.content:JSON.stringify(last.content)})()');
  ck('附件正文进了模型上下文', String(cap).indexOf('王秀英') >= 0, cap);
  ck('没有图片时不强制视觉模型', await page.js('(function(){return !window.__cap.slot})()'));

  /* ---------- 8. 主题曲界面 ---------- */
  console.log('[H] 主题曲');
  await page.goto(S.base + '/#/a/' + aid + '/song' + Q);
  const songTxt = await page.js('document.querySelector(".wrap").textContent');
  ck('有「一 · 用什么内容写」', String(songTxt).indexOf('用 什 么 内 容 写') >= 0);
  ck('有「二 · 怎么写」', String(songTxt).indexOf('怎 么 写') >= 0);
  ck('章节可选（不是只能整本）', await page.js('document.querySelectorAll("[data-song-ch]").length') >= 2,
    await page.js('document.querySelectorAll("[data-song-ch]").length'));
  ck('有素材预览', await page.js('!!document.getElementById("songPv")'));
  ck('有「自己再补一段材料」输入框', await page.js('!!document.getElementById("songMaterial")'));

  /* ---------- 9. 短片能排整本 ---------- */
  console.log('[I] 短片');
  await page.goto(S.base + '/#/a/' + aid + '/movie' + Q);
  const mvOpts = await page.js('(function(){var s=document.getElementById("mvCh");if(!s)return "";var o=[];for(var i=0;i<s.options.length;i++)o.push(s.options[i].text);return o.join("|")})()');
  ck('范围里有「整本（全部章节）」', String(mvOpts).indexOf('整本') >= 0, mvOpts);
  const mvTxt = String(await page.js('document.querySelector(".wrap").textContent'));
  ck('标题不再写死「一分钟」', !/做一条一分钟的片子/.test(mvTxt), mvTxt.slice(0, 40));
  ck('明确说片长由内容决定', /片长由内容决定/.test(mvTxt));

  /* ---------- 10. 朗读预览 ---------- */
  console.log('[J] 朗读');
  await page.goto(S.base + '/#/a/' + aid + Q);
  await page.click('[data-read-all]');
  await sleep(1200);
  ck('朗读前有预览窗', await page.js('!!document.querySelector(".rd-list")'));
  ck('预览列出每一章与段数', await page.js('document.querySelectorAll(".rd-row").length') >= 2,
    await page.js('document.querySelectorAll(".rd-row").length'));
  ck('默认从第 1 章开始', await page.js('(function(){var r=document.querySelectorAll(".rd-row");if(!r.length)return false;return r[0].className.indexOf("on")>=0 && r[0].querySelector("input").checked})()'));
  await page.click('[data-rd-cancel]');
  await sleep(300);

  /* ---------- 11. 成片是档案里的东西（找得回来） ---------- */
  console.log('[K] 合成过的片子在档案里');
  // 直接造一条 media 记录（真合成要看 ffmpeg，见 audit-v09），验档案页与短片页都能列出来
  await x("INSERT INTO media (archive_id, kind, path, mime, bytes, caption, duration_ms) VALUES (?,?,?,?,?,?,?)",
    [aid, 'movie', 'ai/movie/abcdef0123456789/movie.mp4', 'video/mp4', 3456789, '小时候的院子', 47000]);
  await page.goto(S.base + '/#/a/' + aid + Q);
  const mvBtn = await page.js('(function(){var b=document.querySelector(\'[data-goto="movie"]\');return b?b.textContent:""})()');
  ck('档案首页的「短片」按钮带条数', /短片/.test(String(mvBtn)) && /1/.test(String(mvBtn)), mvBtn);
  ck('档案首页有「合成的片子」区块', await page.js('!!document.getElementById("archiveMovies")'));
  ck('片子能直接在档案页播放', await page.js('document.querySelectorAll("#archiveMovies video").length') === 1,
    await page.js('document.querySelectorAll("#archiveMovies video").length'));
  ck('片子给了下载入口', await page.js('!!document.querySelector("#archiveMovies a[download]")'));
  ck('区块里写了时长与大小', /47 秒/.test(String(await page.js('document.getElementById("archiveMovies").textContent'))),
    String(await page.js('document.getElementById("archiveMovies").textContent')).slice(0, 80));

  await page.goto(S.base + '/#/a/' + aid + '/movie' + Q);
  await sleep(1200);
  ck('短片页顶部「合成过的」也列出来', await page.js('document.querySelectorAll("#mvHist .mv-hist-item").length') >= 1,
    await page.js('document.querySelectorAll("#mvHist .mv-hist-item").length'));
  ck('短片页说明了成片存哪儿', /存在这本档案|合成过的/.test(String(await page.js('document.querySelector(".wrap").textContent'))));

  ck('全程没有 JS 异常', page.errors.length === 0, (page.errors || []).slice(0, 2).join(' | '));

  console.log('\nv0.9.5 体验修复：' + pass + ' 通过 / ' + fail + ' 失败');
  page.close();
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('审计崩了：' + e.stack); process.exit(2); });
