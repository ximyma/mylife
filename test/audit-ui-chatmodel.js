/**
 * AI 助手页选模型 —— 端到端审计（真点、真写库）。
 *
 * 用户的诉求：配了硅基流动之后，能在对话界面直接挑付费模型，
 * 而且同一个输入框既能聊天、也能画图、也能出视频。
 * 这里验证：
 *   ① 顶部有「聊天 / 画图 / 视频」三档，切档只列这一类的模型
 *   ② 付费/免费标出来，选了会记住（写进 settings，下次打开还是它）
 *   ③ 聊天时选中的 profileId+model 真的随请求发出去，不再吃全局绑定
 *   ④ 画图档发送走 /api/image，并把模型传下去
 *   ⑤ 视频档发送排后台任务，进度回填，完成后气泡里是能播的 video
 *   ⑥ 手填模型名也能用（服务商上了新模型，不用等程序更新）
 *
 * 用法：node test/audit-ui-chatmodel.js
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

(async () => {
  const S = startServer('chatmodel');
  await S.waitReady();
  const token = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, token);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, token);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-CM-1','李老',1950,'江西石城')")).lastId;
  const ch1 = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'出生与家世',1950,1959)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, at_year, origin, sort_key) VALUES (?,?,10,'text','1955 年冬天，老屋院子里堆着柴。',1955,'user',10)", [aid, ch1]);

  const MODELS = JSON.stringify([
    'tencent/Hunyuan-MT-7B',
    'Qwen/Qwen3-8B',
    'deepseek-ai/DeepSeek-V3.2',
    'deepseek-ai/DeepSeek-OCR',
    'Kwai-Kolors/Kolors',
    'black-forest-labs/FLUX.1-schnell',
    'Wan-AI/Wan2.2-T2V-A14B',
  ]);
  const pid = (await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, models_json, default_model, enabled, sort) " +
    "VALUES ('硅基流动','cloud','https://api.siliconflow.cn/v1','sk-test',?,?,1,10)",
    [MODELS, 'Qwen/Qwen3-8B'])).lastId;
  ck('一份带付费模型的配置就位', !!pid, pid);

  const profileDir = path.join(__dirname, '..', 'tmp', 'cdp-chatmodel-prof');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
  const Q = '?token=' + token;

  /* ---------- A. 模型栏 ---------- */
  console.log('[A] 顶部模型栏');
  await page.goto(S.base + '/#/a/' + aid + '/chat' + Q);
  await sleep(1200);
  ck('有模型栏', await page.js('!!document.getElementById("chatModel")'));
  const tabs = await page.js('(function(){var bs=document.querySelectorAll("[data-cm-mode]");var a=[];for(var i=0;i<bs.length;i++)a.push(bs[i].textContent);return a.join("|")})()');
  ck('八档：聊天 / 画图 / 视频 / 提字 / 转文字 / 念稿 / 写歌 / 作曲', tabs === '聊天|画图|视频|提字|转文字|念稿|写歌|作曲', tabs);
  ck('默认停在聊天档', await page.js('!!document.querySelector("[data-cm-mode=\'chat\'].on")'));

  const chatOpts = await page.js('(function(){var s=document.getElementById("cmSel");var a=[];for(var i=0;i<s.options.length;i++)a.push(s.options[i].textContent);return a.join(" ;; ")})()');
  ck('聊天档列出文字模型', /DeepSeek-V3\.2/.test(chatOpts), chatOpts);
  ck('聊天档不列画图模型', !/Kolors/.test(chatOpts), chatOpts);
  ck('付费模型有「付费」字样', /DeepSeek-V3\.2.*付费/.test(chatOpts), chatOpts);
  ck('免费模型有「免费」字样', /Hunyuan-MT-7B.*免费/.test(chatOpts), chatOpts);
  ck('有「自动（按设置里绑的）」选项', /自动/.test(chatOpts), chatOpts);

  /* ---------- B. 切档只列同类模型 ---------- */
  console.log('[B] 切档换模型清单');
  await page.click('[data-cm-mode="img"]');
  await sleep(500);
  const imgOpts = await page.js('(function(){var s=document.getElementById("cmSel");var a=[];for(var i=0;i<s.options.length;i++)a.push(s.options[i].textContent);return a.join(" ;; ")})()');
  ck('画图档列图片模型', /Kolors/.test(imgOpts) && /FLUX/.test(imgOpts), imgOpts);
  ck('画图档不列纯文本模型', !/DeepSeek-V3\.2/.test(imgOpts), imgOpts);
  ck('画图档提示里说明会花多少时间', await page.js('(function(){return /4–10 秒/.test(document.getElementById("chatModel").textContent)})()'));

  await page.click('[data-cm-mode="vid"]');
  await sleep(500);
  const vidOpts = await page.js('(function(){var s=document.getElementById("cmSel");var a=[];for(var i=0;i<s.options.length;i++)a.push(s.options[i].textContent);return a.join(" ;; ")})()');
  ck('视频档列视频模型', /Wan2\.2-T2V/.test(vidOpts), vidOpts);
  ck('视频档不列画图模型', !/Kolors/.test(vidOpts), vidOpts);
  ck('视频档提示「按条计费」', await page.js('(function(){return /按条计费/.test(document.getElementById("chatModel").textContent)})()'));

  /* ---------- C. 选付费模型会记住 ---------- */
  console.log('[C] 选中的模型写进设置');
  await page.run('var s=document.getElementById("cmSel"); s.value="' + pid + '|Wan-AI/Wan2.2-T2V-A14B";' +
    's.dispatchEvent(new Event("change",{bubbles:true})); return 1;');
  await sleep(600);
  const saved = (await q("SELECT v FROM settings WHERE k='chat.model'", []))[0];
  ck('settings 里存下了 chat.model', !!saved && /Wan2\.2-T2V/.test(saved.v) && /"mode":"vid"/.test(saved.v), saved && saved.v);

  /* ---------- D. 画图档真的走生图接口 ---------- */
  console.log('[D] 画图档：走 /api/image 且带上选中的模型');
  await page.click('[data-cm-mode="img"]');
  await sleep(400);
  await page.run('var s=document.getElementById("cmSel"); s.value="' + pid + '|black-forest-labs/FLUX.1-schnell";' +
    's.dispatchEvent(new Event("change",{bubbles:true})); return 1;');
  await sleep(400);
  await page.run('window.__imgArgs=null;' +
    'window.API.image=function(o){window.__imgArgs=o;return Promise.resolve({ok:true,path:"ai/img/x.jpg",bytes:1234,model:o.model});};' +
    'document.getElementById("chatText").value="老屋门口的石阶，黄昏"; return 1;');
  await page.click('#chatSend');
  await sleep(1200);
  const imgArgs = await page.js('window.__imgArgs');
  ck('画图请求发出去了', !!imgArgs, JSON.stringify(imgArgs));
  ck('用的是选中的付费模型', imgArgs && imgArgs.model === 'black-forest-labs/FLUX.1-schnell', imgArgs && imgArgs.model);
  ck('profileId 一起传了', imgArgs && Number(imgArgs.profileId) === Number(pid), imgArgs && imgArgs.profileId);
  ck('提示词用的是输入框里的字', imgArgs && /石阶/.test(String(imgArgs.prompt)), imgArgs && imgArgs.prompt);
  ck('气泡里出现图片', await page.js('!!document.querySelector(".chat-img")'));
  ck('图片气泡有「重画一张」', await page.js('!!document.querySelector("[data-redraw]")'));
  // 点「重画一张」应该带 again 绕过缓存，而不是又拿回同一张
  await page.run('window.__imgArgs=null; document.querySelector("[data-redraw]").click(); return 1;');
  await sleep(900);
  const redraw = await page.js('window.__imgArgs');
  ck('重画时带 again=1 绕过缓存', redraw && Number(redraw.again) === 1, JSON.stringify(redraw && redraw.again));

  /* ---------- E. 视频档排后台任务并回填 ---------- */
  console.log('[E] 视频档：排任务 → 进度 → 出片');
  await page.click('[data-cm-mode="vid"]');
  await sleep(400);
  await page.run('var s=document.getElementById("cmSel"); s.value="' + pid + '|Wan-AI/Wan2.2-T2V-A14B";' +
    's.dispatchEvent(new Event("change",{bubbles:true})); return 1;');
  await sleep(400);
  await page.run('window.__vidCreate=null;' +
    'window.API.job.create=function(t,p){window.__vidCreate={type:t,payload:p};return Promise.resolve({ok:true,id:7});};' +
    'var n=0;' +
    'window.API.job.get=function(id){ n++;' +
    '  if(n<2) return Promise.resolve({ok:true,job:{id:id,status:"running",progress:0.4,stage:"生成中 · 已等 20 秒"}});' +
    '  return Promise.resolve({ok:true,job:{id:id,status:"done",progress:1,stage:"完成",' +
    '    result:{path:"ai/video/abc.mp4",bytes:2048,model:"Wan-AI/Wan2.2-T2V-A14B",archiveId:' + aid + '}}});};' +
    'document.getElementById("chatText").value="老人摇着蒲扇，镜头缓慢推近"; return 1;');
  await page.click('#chatSend');
  await sleep(1200);
  const vidCreate = await page.js('window.__vidCreate');
  ck('排的是 aivideo 任务', vidCreate && vidCreate.type === 'aivideo', JSON.stringify(vidCreate));
  ck('任务带了提示词', vidCreate && /蒲扇/.test(vidCreate.payload.prompt), vidCreate && vidCreate.payload.prompt);
  ck('任务带了选中的视频模型', vidCreate && vidCreate.payload.model === 'Wan-AI/Wan2.2-T2V-A14B',
    vidCreate && vidCreate.payload.model);
  ck('任务带了档案号（出片直接登记进这本）', vidCreate && Number(vidCreate.payload.archiveId) === Number(aid),
    vidCreate && vidCreate.payload.archiveId);
  // 轮询间隔 2.5 秒，等它把进度和成片回填到气泡
  await sleep(4200);
  ck('气泡里出现能播的 video', await page.js('!!document.querySelector(".chat-video")'));
  ck('完成后提示已存进档案', await page.js('(function(){var t=document.querySelector(".chat-ok");return !!t && /档案/.test(t.textContent)})()'));
  ck('视频气泡有「再来一版」', await page.js('!!document.querySelector("[data-vid-again]")'));
  await page.run('window.__vidCreate=null; document.querySelector("[data-vid-again]").click(); return 1;');
  await sleep(900);
  const redo = await page.js('window.__vidCreate');
  ck('再来一版带 again=1（重新计费）', redo && Number(redo.payload.again) === 1, JSON.stringify(redo && redo.payload.again));

  /* ---------- F. 聊天档把模型随请求发出 ---------- */
  console.log('[F] 聊天档：选中的模型随消息发出');
  await page.click('[data-cm-mode="chat"]');
  await sleep(400);
  await page.run('var s=document.getElementById("cmSel"); s.value="' + pid + '|deepseek-ai/DeepSeek-V3.2";' +
    's.dispatchEvent(new Event("change",{bubbles:true})); return 1;');
  await sleep(400);
  await page.run('window.__chatArgs=null;' +
    'window.API.chatStream=function(o,cb){window.__chatArgs=o;return Promise.resolve("这一段我帮你想了想。");};' +
    'document.getElementById("chatText").value="帮我把这一段写得像样一点"; return 1;');
  await page.click('#chatSend');
  await sleep(1800);
  const chatArgs = await page.js('window.__chatArgs');
  ck('聊天请求带上 profileId', chatArgs && Number(chatArgs.profileId) === Number(pid), chatArgs && chatArgs.profileId);
  ck('聊天请求带上付费模型', chatArgs && chatArgs.model === 'deepseek-ai/DeepSeek-V3.2', chatArgs && chatArgs.model);
  ck('回复进了对话', await page.js('(function(){var a=document.querySelectorAll(".msg.ai .msg-t");if(!a.length)return false;return /帮你想了想/.test(a[a.length-1].textContent)})()'));

  /* ---------- G. 手填模型名 ---------- */
  console.log('[G] 手填模型名');
  await page.run('window.prompt=function(){return "vendor/New-Paid-Model";};' +
    'var s=document.getElementById("cmSel"); s.value="__custom";' +
    's.dispatchEvent(new Event("change",{bubbles:true})); return 1;');
  await sleep(700);
  const selTxt = await page.js('(function(){var s=document.getElementById("cmSel");return s.options[s.selectedIndex].textContent})()');
  ck('手填的模型出现在下拉里并被选中', /New-Paid-Model/.test(String(selTxt)), selTxt);
  const saved2 = (await q("SELECT v FROM settings WHERE k='chat.model'", []))[0];
  ck('手填的模型也记住了', !!saved2 && /New-Paid-Model/.test(saved2.v), saved2 && saved2.v);

  ck('全程没有 JS 异常', page.errors.length === 0, (page.errors || []).slice(0, 2).join(' | '));

  console.log('\n' + (fail === 0 ? '全部通过：' : '有失败：') + pass + ' / ' + (pass + fail));
  page.close();
  try { chrome.kill(); } catch (e) {}
  await S.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async e => {
  console.log('崩了：', (e && e.stack) || e);
  process.exit(1);
});
