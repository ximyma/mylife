/**
 * 文生图回归测试：验证「图片生成」slot 走「默认 / 按规则」回退时，
 * 不会拿配置的文本默认模型（如 Qwen3-8B）去调 /images/generations（那会被硅基流动判成
 * 非法操作 → 403 code 30000），而是强制用图像模型 Kwai-Kolors/Kolors。
 *
 * 做法：用 NODE_OPTIONS=-r 预加载一个 fetch 桩，拦截 /images/generations，记录请求里的 model，
 *   模型是 Kolors 就返回 200 + 一张 1x1 PNG；否则返回 403（模拟硅基流动的 Illegal operation）。
 * 用法：node test/audit-image.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp', 'audit-image-data');
const PORT = 4411;
const BASE = 'http://127.0.0.1:' + PORT;
const STUB = path.join(__dirname, '_fetch_stub_image.js');

let pass = 0, failN = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + (d || '') : '')); }
};

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { Authorization: 'Bearer ' + token } : {}),
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    r.write(data); r.end();
  });
}

let srv = null;
function start(withStub) {
  const env = Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) });
  const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (withStub) env.NODE_OPTIONS = '-r ' + STUB;
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], opts);
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
  return new Promise((resolve) => {
    // 轮询直到能登录或超时
    const t0 = Date.now();
    (function wait() {
      req('POST', '/api/auth/login', { phone: '13800138000', password: '123456' })
        .then(r => { if (r.status !== 404) resolve(); else setTimeout(wait, 300); })
        .catch(() => setTimeout(wait, 300));
      if (Date.now() - t0 > 15000) resolve();
    })();
  });
}
function stop() {
  return new Promise(function (resolve) {
    if (!srv) return resolve();
    var p = srv; srv = null; var done = false;
    var fin = function () { if (!done) { done = true; resolve(); } };
    try { p.on('exit', fin); } catch (e) {}
    try { p.kill(); } catch (e) {}
    setTimeout(fin, 2500);   // 兜底：万一没触发 exit
  });
}

// 服务刚被杀时 SQLite 的 WAL 可能还没放锁，打开库要重试几下
function openDbRetry(file, tries) {
  tries = tries || 20;
  for (var i = 0; i < tries; i++) {
    try { return new DatabaseSync(file); } catch (e) {
      if (i === tries - 1) throw e;
      var end = Date.now() + 120; while (Date.now() < end) {}
    }
  }
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

  // 1) 起服务并注册一个管理员账号（服务会建好 auth.db + 用户的 archive.db + 全部表）
  await start(false);
  const reg = await req('POST', '/api/auth/register', { phone: '13800138000', password: '123456', code: '1234', nickname: '测试' });
  if (!reg.json || !reg.json.token) { console.log('注册失败：', JSON.stringify(reg.json)); stop(); process.exit(1); }
  console.log('  注册：', reg.json.ok ? 'ok（首个账号自动为管理员）' : 'fail');
  const regToken = reg.json.token;

  // 发一个带 token 的请求，强制服务端为该用户创建 archive.db 并应用 schema
  await req('POST', '/api/query', { sql: 'SELECT 1 AS ok' }, regToken);
  await stop();

  // 读出真实 uid，定位 archive.db
  const adb = openDbRetry(path.join(DATA_DIR, 'auth.db'));
  const u = adb.prepare('SELECT id FROM users WHERE phone=?').get('13800138000');
  const uid = u ? u.id : 1;
  adb.close();

  // 2) 往该用户的 archive.db 插一条「硅基流动免费档」配置：默认模型设成文本模型 Qwen3-8B，
  //    并且「图片生成」slot 不显式绑定（= 默认 / 按规则，会回退到这条配置的 default_model）。
  const arc = openDbRetry(path.join(DATA_DIR, 'users', String(uid), 'archive.db'));
  arc.exec("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) VALUES ('硅基流动 · 免费档','siliconflow','https://api.siliconflow.cn/v1','sk-test','Qwen3-8B',1,0)");
  // 确保 img slot 是「默认 / 按规则」(profile_id 为 NULL)
  arc.exec("UPDATE ai_slots SET profile_id=NULL, model=NULL WHERE slot='img'");

  // 3) 用 fetch 桩重启服务，调用文生图
  fs.rmSync(path.join(DATA_DIR, 'last_model.txt'), { force: true });
  await start(true);
  const login = await req('POST', '/api/auth/login', { phone: '13800138000', password: '123456' });
  const token = login.json.token;
  const img = await req('POST', '/api/image', { prompt: '一栋农村两层小楼，泥瓦房，暖色调', size: '1024x1024' }, token);

  // 3b) 带参考图：桩会照抄硅基流动的真实行为（Kolors 不收 image 字段 → 500 code 50500）。
  //     服务端应当自动退回纯文字再画一次，而不是把 500 直接丢给用户。
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const imgRef = await req('POST', '/api/image', {
    prompt: '照着这张老照片画一张插画：村口的老槐树',
    size: '1024x1024',
    refImage: 'data:image/png;base64,' + PNG,
  }, token);
  await stop();

  // 4) 断言
  const last = fs.existsSync(path.join(DATA_DIR, 'last_model.txt'))
    ? fs.readFileSync(path.join(DATA_DIR, 'last_model.txt'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  console.log('  服务端实际请求的模型：', JSON.stringify(last));
  console.log('  /api/image 返回：', JSON.stringify(img.json).slice(0, 200));

  ck('服务端用图像模型 Kwai-Kolors/Kolors 调接口（不是文本默认模型）',
    last.length >= 1 && last[0] === 'Kwai-Kolors/Kolors', last.join(','));
  ck('文生图成功返回图片路径', img.json && img.json.ok === true && /\.jpg$/.test(img.json.path || ''),
    img.json && img.json.message);
  ck('no [object Object] 乱码出现在报错里（若失败）',
    !(img.json && img.json.message && img.json.message.indexOf('[object Object]') !== -1));

  // 5) 参考图降级：带 image 字段被 500 拒掉后，自动纯文字重画并标记 refIgnored
  console.log('  带参考图返回：', JSON.stringify(imgRef.json).slice(0, 240));
  ck('带参考图被拒后自动退回纯文字重画（不把 500 丢给用户）',
    imgRef.json && imgRef.json.ok === true && /\.jpg$/.test(imgRef.json.path || ''),
    imgRef.json && imgRef.json.message);
  ck('返回里标记 refIgnored，前端可提示「模型不认参考图」',
    imgRef.json && imgRef.json.refIgnored === true, JSON.stringify(imgRef.json && imgRef.json.refIgnored));
  ck('桩里记录了「先带参考图、再纯文字」两次请求',
    last.some(function (x) { return x.indexOf('(with-ref)') !== -1; }),
    last.join(' | '));

  console.log('\n图片生成回归：' + pass + ' 通过 / ' + failN + ' 失败');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(failN ? 1 : 0);
})();
