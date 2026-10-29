/**
 * 补拍公众号推文缺的三张界面图：
 *   04-注册登录.png   第一次打开的登录/注册页
 *   05-设置模型.png   设置 → 模型来源（API 配置教程配图）
 *   06-AI助手.png     AI 助手八档对话页
 * 用法： node tools/shots-extra.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startServer } = require('../test/_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');
const CDP_PORT = 9423 + Math.floor(Math.random() * 40);
const W = 390, H = 520, DSF = 1080 / W;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

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
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && p.waiting.has(m.id)) {
        const { res, rej } = p.waiting.get(m.id);
        p.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return p;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(2600); }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(function(){try{return (' + expr + ')}catch(e){return "ERR:"+e.message}})()',
      returnByValue: true, awaitPromise: true,
    });
    const v = r.result && r.result.value;
    if (typeof v === 'string' && v.indexOf('ERR:') === 0) throw new Error(v.slice(4));
    return v;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function waitCdp() {
  for (let i = 0; i < 60; i++) { try { return await getJson('/json/version'); } catch (e) { await sleep(250); } }
  throw new Error('Chrome 没起来');
}

const S = startServer('shotsx');
let chrome = null;

(async () => {
  await S.waitReady();
  const token = await S.register();
  console.log('实例已就绪');

  fs.rmSync(path.join(__dirname, '..', 'tmp', 'cdp-profile-x'), { recursive: true, force: true });
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + String(CDP_PORT),
    '--user-data-dir=' + path.join(__dirname, '..', 'tmp', 'cdp-profile-x'),
    'about:blank',
  ], { stdio: 'ignore' });

  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: DSF, mobile: true,
  });

  // 图4 注册登录：不带 token 打开首页
  await page.goto(S.base + '/#/');
  await page.js('document.title');
  const cap4 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '04-注册登录.png'), Buffer.from(cap4.data, 'base64'));
  console.log('04-注册登录 ✓');

  // 图5 设置-模型来源：滚到「模型来源」标题
  await page.goto(S.base + '/#/settings?token=' + token);
  const setY = await page.js(
    '(function(){var hs=document.querySelectorAll(".set-h,section h2,h2");' +
    'for(var i=0;i<hs.length;i++){if(hs[i].textContent.indexOf("模型来源")>=0){' +
    'var r=hs[i].getBoundingClientRect();return Math.round(r.top+window.scrollY);}}return 0;})()');
  const cap5 = await page.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: Math.max(0, setY - 40), width: W, height: H, scale: DSF },
    captureBeyondViewport: true,
  });
  fs.writeFileSync(path.join(OUT, '05-设置模型.png'), Buffer.from(cap5.data, 'base64'));
  console.log('05-设置模型 ✓ (y=' + setY + ')');

  // 图6 AI 助手对话页（八档标签）
  await page.goto(S.base + '/#/chat?token=' + token);
  await sleep(800);
  const cap6 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '06-AI助手.png'), Buffer.from(cap6.data, 'base64'));
  console.log('06-AI助手 ✓');

  page.close();
})().then(() => { try { chrome && chrome.kill(); } catch (e) {} process.exit(0); })
  .catch(e => { console.error('失败：', e.message); try { chrome && chrome.kill(); } catch (e2) {} process.exit(1); });
