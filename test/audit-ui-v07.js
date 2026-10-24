/**
 * v0.7 界面审计（P6）：润色与剧本。
 *
 * 这俩功能都靠模型，所以起一个假的 OpenAI 兼容服务，按 system prompt 分辨
 * 「要润色」还是「要剧本」，返回固定内容——不花钱，也能验证整条链路：
 *   㧱乐 → 出稿 → 并排对比 → 采纳 → 原文另存、正文替换
 *   选章 → 生成 → 解析出场次 → 导出 .txt 落盘
 *
 * 用法： node test/audit-ui-v07.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9600 + Math.floor(Math.random() * 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 180) : '')); }
};

function getJson(p, m) {
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m || 'GET' }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 60))); } });
    });
    rq.on('error', rej); rq.setTimeout(4000, () => rq.destroy(new Error('t'))); rq.end();
  });
}

const POLISHED = '一九五六年，国棉三厂招工，我十六岁。母亲给我做了一件蓝布褂子，把我送到厂门口。';
const SCRIPT = [
  '【场 1】外景 · 厂门口 · 日 / 1956 年春',
  '人物：桂芳、母亲',
  '△ 厂门口的招工牌子前站了一排人。',
  '母亲：好好干，别让人说咱家孩子不行。',
  '桂芳：（点头）嗯。',
  '',
  '【场 2】内景 · 细纱车间 · 日',
  '人物：桂芳、孙师傅',
  '△ 上百台织布机一起响。',
  '孙师傅：先看我接线头，看三天。',
  '旁白：那年我十六岁。',
].join('\n');

(async () => {
  /* 假模型：按 system 里有没有「编剧」分流 */
  let hits = 0;
  const mock = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      hits++;
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch (e) {}
      const sys = ((body.messages || []).filter(m => m.role === 'system')[0] || {}).content || '';
      const isScript = /编剧/.test(sys);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: isScript ? SCRIPT : POLISHED }, finish_reason: 'stop' }],
        usage: { total_tokens: 120 },
      }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  const S = startServer('uiv07');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, p) => S.post('/api/query', { sql, params: p || [] }, t);
  const x = (sql, p) => S.post('/api/exec', { sql, params: p || [] }, t);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-P-1','张桂芳',1942,'山东济南')")).lastId;
  const chId = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'第二章 · 十六岁进厂',1956,1962)", [aid])).lastId;
  const ORIGINAL = '一九五六年国棉三厂招工我十六岁母亲给我做了一件蓝布褂子把我送到厂门口说好好干别让人说咱家孩子不行';
  const eid = (await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited, at_year, at_precision, sort_key) VALUES (?,?,10,'text',?,'user',1,1956,'year',10)",
    [aid, chId, ORIGINAL])).lastId;

  await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) VALUES ('假模型','openai',?,'k','m1',1,0)",
    ['http://127.0.0.1:' + mockPort + '/v1']);
  await x("DELETE FROM ai_slots");
  await x("INSERT INTO ai_slots (slot, profile_id, model) VALUES ('title', 1, 'm1')");

  const prof = path.join(__dirname, '..', 'tmp', 'cdp-v07-prof');
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
    if (r.exceptionDetails) {
      throw new Error('页面脚本出错：' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    }
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  };
  const goto = async h => { await send('Page.navigate', { url: S.base + '/#' + h + '?token=' + t }); await sleep(2200); };

  /* ---------- A 剧本解析（纯函数） ---------- */
  console.log('[A] 剧本解析');
  await goto('/');
  const parsedMeta = await js('(function(){var s=DB.parseScript(' + JSON.stringify(SCRIPT) + ');' +
    'return {n:s.length, chars:s[0].chars.length, act:s[0].action.length, dlg:s[0].dialogue.length, who:s[0].dialogue[0].who};})()');
  ck('解析出两场', parsedMeta && parsedMeta.n === 2, JSON.stringify(parsedMeta));
  ck('解析出人物', parsedMeta && parsedMeta.chars === 2, JSON.stringify(parsedMeta));
  ck('解析出动作', parsedMeta && parsedMeta.act === 1);
  ck('解析出对白', parsedMeta && parsedMeta.dlg === 2);
  ck('对白归属正确', parsedMeta && parsedMeta.who === '母亲', parsedMeta && parsedMeta.who);

  const rt = await js('(function(){var s=DB.parseScript(' + JSON.stringify(SCRIPT) + ');' +
    'return DB.scriptToText({title:"测试", parsed:{scenes:s}});})()');
  ck('能回写成纯文本', /【场 1】/.test(rt) && /母亲：/.test(rt), String(rt).slice(0, 60));

  /* ---------- B 润色 ---------- */
  console.log('[B] 润色');
  await goto('/a/' + aid);
  ck('条目上有「润」', await js('!!document.querySelector("[data-polish=\\"' + eid + '\\"]")'));
  await js('(function(){var b=document.querySelector(\'[data-polish="' + eid + '"]\');if(!b)return 0;b.click();return 1;})()');
  await sleep(700);
  ck('抽屉打开了', await js('!!document.querySelector(".sheet-back .pw")'));
  ck('有五种风格', await js('document.querySelectorAll("[data-style]").length === 5'),
    await js('document.querySelectorAll("[data-style]").length'));

  await js('(function(){document.querySelector("#pwRun").click();return 1;})()');
  await sleep(2500);
  ck('润色稿出来了', await js('(document.querySelector("#pwB").textContent||"").length > 20'));
  ck('有词级差异标记', await js('document.querySelectorAll("#pwB mark").length > 0'),
    await js('document.querySelectorAll("#pwB mark").length'));
  ck('原文一字未动', (await q('SELECT text FROM entries WHERE id=?', [eid]))[0].text === ORIGINAL);
  const vBefore = await q('SELECT status, kind FROM entry_versions WHERE entry_id=?', [eid]);
  ck('先落成 proposal', vBefore.length === 1 && vBefore[0].status === 'proposal', JSON.stringify(vBefore));

  await js('(function(){document.querySelector("#pwUse").click();return 1;})()');
  await sleep(1600);
  const after = await q('SELECT text FROM entries WHERE id=?', [eid]);
  ck('采纳后正文换了', after[0].text !== ORIGINAL && after[0].text.length > 10, after[0].text.slice(0, 30));
  const kept = await q("SELECT text FROM entry_versions WHERE entry_id=? AND kind='original'", [eid]);
  ck('原文另存了一份', kept.length === 1 && kept[0].text === ORIGINAL, JSON.stringify(kept).slice(0, 80));
  const acc = await q("SELECT count(*) n FROM entry_versions WHERE entry_id=? AND status='accepted'", [eid]);
  ck('版本标为已采纳', Number(acc[0].n) === 1);

  /* ---------- C 剧本 ---------- */
  console.log('[C] 剧本');
  await goto('/a/' + aid + '/script');
  ck('剧本页起来了', await js('!!document.querySelector("#scGen")'));
  await js('(function(){document.querySelector("#scGen").click();return 1;})()');
  await sleep(3000);
  ck('排出了场次卡片', await js('document.querySelectorAll(".sc-card").length >= 2'),
    await js('document.querySelectorAll(".sc-card").length'));
  ck('场次头有字', await js('(document.querySelector(".sc-slug").textContent||"").length > 3'));
  ck('对白渲染了', await js('document.querySelectorAll(".sc-line").length >= 3'),
    await js('document.querySelectorAll(".sc-line").length'));
  const rows = await q('SELECT * FROM scripts WHERE archive_id=?', [aid]);
  ck('剧本落库', rows.length === 1, 'rows=' + rows.length);
  const savedJson = rows.length ? JSON.parse(rows[0].json) : {};
  ck('落库的是结构化的', (savedJson.scenes || []).length >= 2);

  await js('(function(){document.querySelector("[data-sc-txt]").click();return 1;})()');
  await sleep(1200);
  const expDir = path.join(S.DATA_DIR, 'users', '1', 'files', 'exports');
  const files = fs.existsSync(expDir) ? fs.readdirSync(expDir).filter(f => /\.txt$/.test(f)) : [];
  ck('导出了 txt', files.length >= 1, JSON.stringify(files));
  if (files.length) {
    const txt = fs.readFileSync(path.join(expDir, files[0]), 'utf8');
    ck('txt 里是剧本格式', /【场 1】/.test(txt) && /人物：/.test(txt), txt.slice(0, 60));
  }

  /* ---------- D 控制台 ---------- */
  console.log('[D] 控制台');
  const real = errors.filter(e => String(e).indexOf('favicon') < 0);
  ck('没有未捕获异常', real.length === 0, real.join(' | '));
  ck('调用过模型（假服务收到请求）', hits >= 2, 'hits=' + hits);

  try { ws.close(); } catch (e) {}
  chrome.kill();
  mock.close();
  S.stop();
  console.log('\nv0.7 润色与剧本: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('审计崩了：' + (e && e.stack || e)); process.exit(1); });
