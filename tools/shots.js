/**
 * 出公众号配图：起一个隔离实例 → 造一本完整的示范档案 → 用 CDP 精确截图。
 *
 * 为什么不用 chrome --screenshot：那个只能平截视口、不能滚动，
 * 而公众号要的是「手机比例 + 停在指定段落」。这里走 DevTools Protocol，
 * 可以设定 390×520@2.77（= 1080×1440 的 3:4 图）再滚到想要的位置。
 *
 * 用法： node tools/shots.js [输出目录]
 * 产出： shots/01-卷宗.png  02-录音转写.png  03-首页.png
 */
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('../test/_lib.js');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');
const CDP_PORT = 9333 + Math.floor(Math.random() * 40);
const W = 390, H = 520, DSF = 1080 / W;   // 390×2.769 = 1080 宽，正好 3:4

fs.mkdirSync(OUT, { recursive: true });

/* ============ 复古相纸风格的演示照片 ============ */
function photo(kind) {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">' +
    '<defs>' +
    '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#ddd0b4"/><stop offset="1" stop-color="#bda88a"/></linearGradient>' +
    '<radialGradient id="vig" cx="50%" cy="45%" r="74%">' +
    '<stop offset="55%" stop-color="#000" stop-opacity="0"/>' +
    '<stop offset="100%" stop-color="#3a2a17" stop-opacity=".5"/></radialGradient>' +
    '<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/>' +
    '<feColorMatrix type="saturate" values="0"/>' +
    '<feComponentTransfer><feFuncA type="linear" slope=".22"/></feComponentTransfer></filter>' +
    '</defs>' +
    '<rect width="800" height="600" fill="url(#sky)"/>';
  const tail = '<rect width="800" height="600" filter="url(#grain)" opacity=".55"/>' +
    '<rect width="800" height="600" fill="url(#vig)"/></svg>';

  if (kind === 'gate') {
    // 厂门口：砖墙大门 + 三个人影
    return head +
      '<rect x="0" y="380" width="800" height="220" fill="#a89574"/>' +
      '<rect x="0" y="300" width="800" height="20" fill="#8d7a5c" opacity=".55"/>' +
      // 门柱与拱
      '<rect x="250" y="150" width="34" height="290" fill="#8a775a"/>' +
      '<rect x="516" y="150" width="34" height="290" fill="#8a775a"/>' +
      '<path d="M250 160 Q400 60 550 160" stroke="#8a775a" stroke-width="26" fill="none"/>' +
      '<rect x="284" y="176" width="232" height="250" fill="#6f6049" opacity=".35"/>' +
      // 门里的光
      '<rect x="284" y="176" width="232" height="250" fill="#e8d9b8" opacity=".22"/>' +
      // 三个人影（父 母 孩子）
      '<g fill="#4a3d2b" opacity=".82">' +
      '<ellipse cx="330" cy="404" rx="16" ry="16"/><path d="M314 420 h32 l6 96 h-44 z"/>' +
      '<ellipse cx="378" cy="410" rx="15" ry="15"/><path d="M363 425 h30 l5 91 h-40 z"/>' +
      '<ellipse cx="424" cy="436" rx="11" ry="11"/><path d="M413 447 h22 l4 69 h-30 z"/>' +
      '</g>' +
      // 地面上的一小块光斑
      '<ellipse cx="400" cy="560" rx="260" ry="34" fill="#efe0c0" opacity=".18"/>' +
      tail;
  }
  if (kind === 'yard') {
    // 老院子：门楼 + 树 + 自行车
    return head +
      '<rect x="0" y="420" width="800" height="180" fill="#a99674"/>' +
      '<rect x="90" y="230" width="300" height="200" fill="#8f7c5d"/>' +
      '<path d="M80 235 L240 150 L400 235 Z" fill="#6d5c44"/>' +
      '<rect x="196" y="300" width="86" height="130" fill="#5b4c37"/>' +
      '<rect x="212" y="316" width="54" height="60" fill="#c9b795" opacity=".45"/>' +
      // 树
      '<rect x="590" y="250" width="16" height="170" fill="#5f5140"/>' +
      '<ellipse cx="598" cy="215" rx="105" ry="88" fill="#6b5f45" opacity=".85"/>' +
      '<ellipse cx="545" cy="245" rx="60" ry="52" fill="#7a6d4f" opacity=".7"/>' +
      // 自行车
      '<g stroke="#3f3526" stroke-width="5" fill="none">' +
      '<circle cx="470" cy="486" r="27"/><circle cx="560" cy="486" r="27"/>' +
      '<path d="M470 486 L505 440 L560 486 M505 440 L520 486 M497 440 h18"/></g>' +
      tail;
  }
  // kind === 'mountain'：泰山
  return head +
    '<path d="M0 430 L200 260 L330 360 L470 210 L620 340 L800 250 L800 600 L0 600 Z" fill="#8a7f66"/>' +
    '<path d="M470 210 L560 300 L620 340 L520 330 Z" fill="#efe3c6" opacity=".55"/>' +
    '<path d="M0 470 L170 360 L300 430 L420 380 L560 450 L700 390 L800 440 L800 600 L0 600 Z" fill="#6f6550"/>' +
    '<rect x="0" y="520" width="800" height="80" fill="#5c5343"/>' +
    // 三个人影
    '<g fill="#3a3226" opacity=".85">' +
    '<ellipse cx="352" cy="470" rx="13" ry="13"/><path d="M339 483 h26 l4 52 h-34 z"/>' +
    '<ellipse cx="390" cy="476" rx="12" ry="12"/><path d="M378 488 h24 l3 47 h-30 z"/>' +
    '<ellipse cx="424" cy="490" rx="9" ry="9"/><path d="M415 499 h18 l3 36 h-24 z"/>' +
    '</g>' +
    tail;
}

/* ============ 1 秒静音 WAV ============ */
function silentWav(seconds) {
  const rate = 16000, n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

/* ============ 造数据 ============ */
async function seed(S, t) {
  const exec = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, t)
    .then(r => { if (r && r.__error) throw new Error(r.__error + ' << ' + sql.slice(0, 60)); return r; });

  const files = path.join(S.DATA_DIR, 'users', '1', 'files');
  fs.mkdirSync(path.join(files, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(files, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(files, 'photos', 'p1.svg'), photo('gate'));
  fs.writeFileSync(path.join(files, 'photos', 'p2.svg'), photo('yard'));
  fs.writeFileSync(path.join(files, 'photos', 'p3.svg'), photo('mountain'));
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(files, 'audio', 'seg-' + i + '.wav'), silentWav(2));
  }

  // 主角：李秀兰，1942 年生，济南国棉三厂挡车工
  await exec(`INSERT INTO archives (archive_no, subject_name, birth_year, hometown, intro, facts_json, status, visibility)
    VALUES ('MS-2026-001','李秀兰',1942,'山东济南',
    '我这一辈子没做过什么大事，就是把三个孩子拉扯大了。',
    '[{"k":"出生","v":"1942 年，济南西郊段店"},{"k":"兄弟姐妹","v":"五个，我排老三"},{"k":"工作","v":"国棉三厂挡车工，四十一年"},{"k":"子女","v":"两个儿子，一个女儿"}]',
    'ready',1)`);

  const chapters = [
    [10, '第一章 · 西郊的院子', 1942, 1955, '童年', '天不亮就起来推磨，推完了才去上学。'],
    [20, '第二章 · 十六岁进厂', 1956, 1962, '学徒', '第一次听见机器响，我心里发慌。'],
    [30, '第三章 · 成家', 1963, 1968, '成家', ''],
    [40, '第四章 · 三班倒的二十年', 1969, 1989, '进厂那些年', ''],
    [50, '第五章 · 退休以后', 1990, 2020, '晚年', ''],
  ];
  for (const c of chapters) {
    await exec('INSERT INTO chapters (archive_id, seq, title, year_from, year_to, stage, quote) VALUES (1,?,?,?,?,?,?)', c);
  }

  const entries = [
    [1, 10, '我生在济南西郊一个叫段店的地方。家里五个孩子，我排老三。父亲在铁路上做临时工，母亲给人家缝衣服，缝一件两毛钱。'],
    [1, 20, '那时候院子里有盘石磨，天不亮母亲就把我叫起来推磨。一圈一圈地推，推完了才能去上学。我到现在还记得那个磨盘压在手上的感觉。'],
    [2, 10, '一九五六年，国棉三厂招工，我十六岁。母亲给我做了一件蓝布褂子，把我送到厂门口，说：好好干，别让人说咱家孩子不行。'],
    [2, 20, '车间里上百台织布机一起响，第一次进去我心里发慌。师傅姓孙，让我先看她接线头，看了整整三天。'],
    [3, 10, '我爱人是同一个厂的，钳工。那时候厂里办集体婚礼，八对新人，一人一块肥皂、一个搪瓷盆。'],
    [4, 10, '三班倒，最怕的是夜班。半夜十二点接班，早上八点下班，回到家太阳已经很高了。'],
    [5, 10, '一九九七年退休，在厂里干了四十一年。厂里送了一个暖水瓶，上面印着「光荣退休」。'],
  ];
  for (const e of entries) {
    await exec('INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited) VALUES (1,?,?,?,?,?,1)',
      [e[0], e[1], 'text', e[2], 'user']);
  }

  // 照片：年份 / 地点 / 事件，全部归到章
  const photos = [
    ['photos/p1.svg', 1965, '济南', '一家五口在厂门口', 3],
    ['photos/p2.svg', 1978, '济南', '买了第一辆自行车，永久牌，一百五十块', 4],
    ['photos/p3.svg', 1986, '泰安', '全家第一次出远门，爬泰山', 5],
  ];
  for (const p of photos) {
    await exec('INSERT INTO photos (archive_id, path, taken_year, place, event, chapter_id, match_score, match_reason) VALUES (1,?,?,?,?,?,?,?)',
      [p[0], p[1], p[2], p[3], p[4], 0.92, '年份落在这一章的范围内']);
  }
  await exec('UPDATE archives SET cover_photo_id = 1 WHERE id = 1');

  // 讲述：三条带录音，其中一条已转好
  await exec('INSERT INTO segments (archive_id, audio_path, raw_text, year_hint, duration_ms) VALUES (1,?,?,?,?)',
    ['audio/seg-1.wav', '我生在济南西郊一个叫段店的地方。家里五个孩子，我排老三。', 1942, 41000]);
  await exec('INSERT INTO segments (archive_id, audio_path, raw_text, year_hint, duration_ms) VALUES (1,?,?,?,?)',
    ['audio/seg-2.wav', '一九五六年，国棉三厂招工，我十六岁。母亲给我做了一件蓝布褂子。', 1956, 36000]);
  await exec('INSERT INTO segments (archive_id, audio_path, raw_text, year_hint, duration_ms) VALUES (1,?,?,?,?)',
    ['audio/seg-3.wav', '录音已保存，还没转文字', 1978, 29000]);

  // 第二条档案：让首页不止一本
  await exec(`INSERT INTO archives (archive_no, subject_name, birth_year, death_year, hometown, intro, status, visibility)
    VALUES ('MS-2026-002','王德福',1936,2019,'江苏无锡','手艺人的一辈子，都在刨花里。','ready',0)`);
  await exec('INSERT INTO chapters (archive_id, seq, title, year_from, year_to, stage) VALUES (2,10,?,?,?,?)',
    ['第一章 · 木匠铺', 1949, 1965, '学徒']);
  await exec('INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited) VALUES (2,6,10,?,?,?,1)',
    ['text', '十三岁跟舅舅学木匠，刨子一推就是一天，手上全是泡。', 'user']);

  // 第三条：刚建好还没材料，展示"从零开始"的状态
  await exec(`INSERT INTO archives (archive_no, subject_name, birth_year, hometown, status, visibility)
    VALUES ('MS-2026-003','陈志远',1955,'浙江宁波','draft',0)`);
}

/* ============ CDP ============ */
function getJson(p, method) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: CDP_PORT, path: p, method: method || 'GET' }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        // 新版 Chrome 对 /json/new 只认 PUT，用 GET 会回一句纯文本，这里挑明
        try { resolve(JSON.parse(b)); } catch (e) {
          reject(new Error('CDP ' + (method || 'GET') + ' ' + p + ' → ' + b.slice(0, 80)));
        }
      });
    });
    rq.on('error', reject);
    rq.setTimeout(3000, () => rq.destroy(new Error('cdp timeout')));
    rq.end();
  });
}

function waitCdp() {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      getJson('/json/version').then(v => resolve(v)).catch(() => {
        if (++n > 60) return reject(new Error('Chrome 没起来'));
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async open(url) {
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
      } else if (m.method) {
        p.events.push(m.method);
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
    await sleep(2600);   // 前端要跑 boot（取 token → me() → 渲染），给足时间
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.value;
  }
  async shoot(file, scrollTo) {
    if (scrollTo !== undefined && scrollTo !== null) {
      await this.evalJs('window.scrollTo(0,' + scrollTo + ')');
    }
    await sleep(500);
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log('  ' + path.basename(file) + '  ' + kb + ' KB');
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* ============ 主流程 ============ */
const S = startServer('shots');
let chrome = null;

(async () => {
  await S.waitReady();
  const token = await S.register();
  await seed(S, token);
  console.log('示范档案已就绪（李秀兰 / 王德福 / 陈志远）');

  fs.rmSync(path.join(__dirname, '..', 'tmp', 'cdp-profile'), { recursive: true, force: true });
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + String(CDP_PORT),
    '--user-data-dir=' + path.join(__dirname, '..', 'tmp', 'cdp-profile'),
    'about:blank',
  ], { stdio: 'ignore' });

  await waitCdp();
  const page = await Page.open();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: DSF, mobile: true,
  });
  // 模拟一台正常手机（不给它 2G 网络的慢）
  await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const Q = '?token=' + token;

  // 图1 卷宗：封面 + 档案信息 + 目录开头
  await page.goto(S.base + '/#/a/1' + Q);
  await page.shoot(path.join(OUT, '01-卷宗.png'), 0);

  // 图2 已有的材料：讲述条目（试听 / 转成文字）+ 照片，是「录音→转文字」最直观的一屏
  await page.goto(S.base + '/#/a/1/collect' + Q);
  const matY = await page.evalJs(
    '(function(){var ts=document.querySelectorAll(".blk-title");' +
    'for(var i=0;i<ts.length;i++){if(ts[i].textContent.indexOf("已有的材料")>=0){' +
    'var r=ts[i].getBoundingClientRect();return Math.round(r.top+window.scrollY);}}return 0;})()');
  await page.shoot(path.join(OUT, '02-已有材料.png'), Math.max(0, matY - 54));

  // 图3 首页：三本档案
  await page.goto(S.base + '/#/' + Q);
  await page.shoot(path.join(OUT, '03-首页.png'), 0);

  page.close();
  console.log('\n输出目录：' + OUT);
})().catch(e => {
  console.error('截图失败：' + e.message);
  process.exitCode = 1;
}).finally(() => {
  try { if (chrome) chrome.kill(); } catch (e) {}
  S.stop();
});
