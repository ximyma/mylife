/**
 * AI 视频生成 —— 端到端审计（后台任务链路）。
 *
 * 用户在对话里选付费视频模型直接出片，所以服务端要保证：
 *   ① 提交 → 轮询 → Succeed → 当场把临时链接下载落盘（链接一小时失效，只存链接等于没存）
 *   ② 同一个描述不重复扣费（第二次直接给旧片子）
 *   ③ 图生视频能把参考图塞进 image 字段
 *   ④ 出片登记进档案 media，档案首页「合成的片子」看得见
 *   ⑤ 服务商拒绝时，任务带人话失败，不是卡在 0%
 *
 * 用法：node test/audit-video.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
// 固定名字方便翻现场；清不干净时（文件被占用）必须换名字，
// 否则上一轮残留的库会让下面 13800138000 注册撞号，整套审计崩在起跑线上。
let DATA_DIR = path.join(ROOT, 'tmp', 'audit-video-data');
if (!emptyDir(DATA_DIR)) { DATA_DIR = DATA_DIR + '-' + Date.now(); emptyDir(DATA_DIR); }
function emptyDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清不掉不致命 */ }
  try { return !fs.existsSync(dir); } catch (e) { return false; }
}
const PORT = 4430 + Math.floor(Math.random() * 40);   // 随机端口：批量跑测试时不跟别的套件抢
const STUB = path.join(__dirname, '_fetch_stub_video.js');

let pass = 0, failN = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 300) : '')); }
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
function start() {
  const env = Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) });
  env.NODE_OPTIONS = '-r ' + STUB;
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
  srv.on('error', e => console.log('[srv] 拉不起来：' + e.message));
  return new Promise(resolve => {
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
  return new Promise(resolve => {
    if (!srv) return resolve();
    const p = srv; srv = null; let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    p.on('exit', fin);
    try { p.kill(); } catch (e) {}
    setTimeout(fin, 2500);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitJob(id, token, ms) {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) {
    const r = await req('POST', '/api/jobs', { id }, token);
    const j = r.json && r.json.job;
    if (j && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled')) return j;
    await sleep(250);
  }
  return null;
}

(async () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

  await start();
  const reg = await req('POST', '/api/auth/register', { phone: '13800138000', password: '123456', code: '1234', nickname: '测试' });
  if (!reg.json || !reg.json.token) { console.log('注册失败：', JSON.stringify(reg.json)); await stop(); process.exit(1); }
  const token = reg.json.token;

  const exec = (sql, params) => req('/api/exec', {}, 0).catch(() => {});
  void exec;
  const x = (sql, params) => req('POST', '/api/exec', { sql, params: params || [] }, token);
  const q = (sql, params) => req('POST', '/api/query', { sql, params: params || [] }, token).then(r => r.json);

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year) VALUES ('MS-AV-1','李老',1950)")).json.lastId;
  ck('档案建好了', !!aid, aid);

  // 一条「硅基流动」配置，默认模型就是视频模型（这就是用户在设置里填的东西）
  const pid = (await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) " +
    "VALUES ('硅基流动', 'cloud', 'https://api.siliconflow.cn/v1', 'sk-test', 'Wan-AI/Wan2.2-T2V-A14B', 1, 10)")).json.lastId;
  ck('模型配置建好了', !!pid, pid);

  /* ---------- 1. 出一段视频 ---------- */
  console.log('[A] 文生视频：提交 → 轮询 → 下载落盘');
  const create = await req('POST', '/api/jobs/create', {
    type: 'aivideo',
    payload: { prompt: '老人在院子里摇蒲扇，镜头缓慢推近', size: '720x1280', archiveId: aid, pollMs: 200, maxPoll: 30 },
  }, token);
  ck('任务排上了', create.json && create.json.ok && !!create.json.id, JSON.stringify(create.json));
  const job = await waitJob(create.json.id, token, 30000);
  ck('任务跑到完成', job && job.status === 'done', job ? (job.status + ' ' + (job.error || '')) : 'timeout');

  const res = (job && job.result) || {};
  ck('结果里有成片路径', /^ai\/video\/[0-9a-f]+\.mp4$/.test(String(res.path || '')), res.path);
  const abs = res.path ? path.join(DATA_DIR, 'users', '1', 'files', res.path) : '';
  ck('成片真的落盘了', !!abs && fs.existsSync(abs) && fs.statSync(abs).size > 100,
    abs + ' ' + (abs && fs.existsSync(abs) ? fs.statSync(abs).size : 'missing'));
  ck('返回里带了模型名', String(res.model || '').indexOf('Wan2.2') !== -1, res.model);

  const last = fs.existsSync(path.join(DATA_DIR, 'last_video.txt'))
    ? fs.readFileSync(path.join(DATA_DIR, 'last_video.txt'), 'utf8').trim().split('\n') : [];
  ck('提交时用的是配置里的视频模型', last[0] && /Wan-AI\/Wan2\.2-T2V-A14B .*720x1280/.test(last[0]), last[0]);
  ck('默认是纯文生视频（没塞图）', last[0] && /text-only/.test(last[0]), last[0]);

  const media = await q("SELECT id, kind, path, mime, bytes, caption FROM media WHERE archive_id=? AND kind='video'", [aid]);
  ck('成片登记进档案 media', media.length === 1 && media[0].path === res.path, JSON.stringify(media));
  ck('media 里记了大小和描述', media[0] && Number(media[0].bytes) > 100 && /蒲扇/.test(String(media[0].caption || '')),
    media[0] && (media[0].bytes + ' / ' + media[0].caption));

  /* ---------- 2. 同一句描述不重复扣费 ---------- */
  console.log('[B] 同一句描述再点一次：直接给旧片子');
  const again = await req('POST', '/api/jobs/create', {
    type: 'aivideo',
    payload: { prompt: '老人在院子里摇蒲扇，镜头缓慢推近', size: '720x1280', archiveId: aid, pollMs: 200, maxPoll: 30 },
  }, token);
  const job2 = await waitJob(again.json.id, token, 20000);
  ck('第二次也算完成', job2 && job2.status === 'done', job2 && job2.status);
  ck('第二次标了 cached', job2 && job2.result && job2.result.cached === true, JSON.stringify(job2 && job2.result));
  ck('第二次给的是同一个文件', job2 && job2.result && job2.result.path === res.path, job2 && job2.result && job2.result.path);
  const last2 = fs.readFileSync(path.join(DATA_DIR, 'last_video.txt'), 'utf8').trim().split('\n');
  ck('没有向服务商重复提交（不重复扣费）', last2.length === last.length, last2.length + ' vs ' + last.length);

  // 「再来一版」：绕过缓存，真的重新提交一次（用户想换个版本时用）
  const redoJob = await req('POST', '/api/jobs/create', {
    type: 'aivideo',
    payload: { prompt: '老人在院子里摇蒲扇，镜头缓慢推近', size: '720x1280', again: 1, pollMs: 200, maxPoll: 30 },
  }, token);
  const job2b = await waitJob(redoJob.json.id, token, 30000);
  ck('再来一版能出新片', job2b && job2b.status === 'done' && job2b.result && job2b.result.cached === false,
    JSON.stringify(job2b && job2b.result));
  const last2b = fs.readFileSync(path.join(DATA_DIR, 'last_video.txt'), 'utf8').trim().split('\n');
  ck('再来一版确实重新提交了（重新计费）', last2b.length === last2.length + 1, last2b.length + ' vs ' + last2.length);

  /* ---------- 3. 图生视频 ---------- */
  console.log('[C] 图生视频：参考图进 image 字段');
  fs.mkdirSync(path.join(DATA_DIR, 'users', '1', 'files', 'video-src'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'users', '1', 'files', 'video-src', 'ref.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const i2v = await req('POST', '/api/jobs/create', {
    type: 'aivideo',
    payload: {
      prompt: '照片里的人抬起头看向镜头', size: '720x1280', archiveId: aid,
      imagePath: 'video-src/ref.jpg', pollMs: 200, maxPoll: 30,
    },
  }, token);
  const job3 = await waitJob(i2v.json.id, token, 30000);
  ck('图生视频也能出片', job3 && job3.status === 'done', job3 && (job3.status + ' ' + (job3.error || '')));
  const last3 = fs.readFileSync(path.join(DATA_DIR, 'last_video.txt'), 'utf8').trim().split('\n');
  ck('参考图被塞进提交请求', last3.length > last2.length && /with-image/.test(last3[last3.length - 1]),
    last3[last3.length - 1]);

  /* ---------- 4. 服务商拒绝时给人话 ---------- */
  console.log('[D] 服务商拒绝：任务带人话失败');
  await x('UPDATE ai_profiles SET default_model=? WHERE id=?', ['Wan-AI/FAIL-T2V', pid]);
  const bad = await req('POST', '/api/jobs/create', {
    type: 'aivideo',
    payload: { prompt: '这一条会被服务商拒绝', model: 'Wan-AI/FAIL-T2V', size: '720x1280', pollMs: 200, maxPoll: 6 },
  }, token);
  const job4 = await waitJob(bad.json.id, token, 25000);
  ck('失败任务状态是 failed', job4 && job4.status === 'failed', job4 && job4.status);
  ck('错误里带了服务商原话，不是 [object Object]',
    job4 && /Model does not exist/.test(String(job4.error || '')) && String(job4.error).indexOf('[object Object]') === -1,
    job4 && job4.error);

  console.log('\n' + (failN === 0 ? '全部通过：' : '有失败：') + pass + ' / ' + (pass + failN));
  await stop();
  process.exit(failN === 0 ? 0 : 1);
})().catch(async e => {
  console.log('崩了：', e && e.stack || e);
  await stop();
  process.exit(1);
});
