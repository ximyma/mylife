/**
 * AI 作曲（真音乐大模型）链路审计。
 *
 * 用户要的是「让作曲模型生成真正的歌曲和自创的音乐」，不是本地念词配和弦。
 * 服务端为此加了后台任务 aimusic，接两家（阶跃星辰 StepAudio 3 / Mureka），
 * 两家都是「提交拿号 → 轮询 → 收音频」。这里验证的是：
 *   A 入参校验：什么都没说 / 歌词超长 / 曲风描述超长
 *   B 没配音乐服务时不闷声失败，要指路（去哪加、填什么地址）
 *   C 阶跃星辰：提交参数对、轮询到 SUCCESS、base64 音频落盘、登记进档案
 *   D Mureka：走 url 下载那条路，同样落盘、同样登记
 *   E 同一描述不重复计费；「再来一版」才重新提交
 *   F 服务商拒绝时任务带人话失败
 *
 * 用法：node test/audit-music.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp', 'audit-music-data');
const PORT = 4470 + Math.floor(Math.random() * 30);
const STUB = path.join(__dirname, '_fetch_stub_music.js');

let pass = 0, failN = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 300) : '')); }
};

function req(p, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { Authorization: 'Bearer ' + token } : {}),
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({ __bad: buf.slice(0, 200) }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    r.write(data); r.end();
  });
}

let srv = null;
function start() {
  const env = Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) });
  env.NODE_OPTIONS = '-r ' + STUB;
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
  return new Promise(resolve => {
    const t0 = Date.now();
    (function wait() {
      req('/api/auth/login', { phone: '13800138000', password: '123456' })
        .then(r => { if (!r.__bad) resolve(); else setTimeout(wait, 300); })
        .catch(() => setTimeout(wait, 300));
      if (Date.now() - t0 > 20000) resolve();
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
  const end = Date.now() + (ms || 40000);
  while (Date.now() < end) {
    const r = await req('/api/jobs', { id }, token);
    const j = r && r.job;
    if (j && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled')) return j;
    await sleep(200);
  }
  return null;
}

function lastLines() {
  const f = path.join(DATA_DIR, 'last_music.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
}

(async () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

  await start();
  const reg = await req('/api/auth/register', { phone: '13800138000', password: '123456', code: '1234', nickname: '测试' });
  if (!reg.token) { console.log('注册失败：', JSON.stringify(reg)); await stop(); process.exit(1); }
  const token = reg.token;
  const x = (sql, params) => req('/api/exec', { sql, params: params || [] }, token);
  // /api/query 直接返回数组（不是 {rows:[]}），两种形态都兜住
  const q = (sql, params) => req('/api/query', { sql, params: params || [] }, token)
    .then(r => Array.isArray(r) ? r : (r.rows || []));

  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year) VALUES ('MS-MU-1','李老',1950)")).lastId;
  ck('档案建好了', !!aid, aid);

  const CAP = '中文民谣，温暖男声，木吉他与钢琴，中速，怀旧真挚';
  const LYR = '[Verse]\n老屋的瓦上落着霜\n灶膛的火还亮着光\n[Chorus]\n你走的那年雪很大';

  /* ---------- A. 入参校验 ---------- */
  console.log('[A] 入参校验');
  const empty = await req('/api/jobs/create', { type: 'aimusic', payload: { caption: '', lyrics: '' } }, token);
  const jEmpty = empty.id ? await waitJob(empty.id, token, 15000) : null;
  ck('什么都没说会被挡住',
    !empty.ok || (jEmpty && jEmpty.status === 'failed' && /说说想要什么曲子/.test(String(jEmpty.error || ''))),
    JSON.stringify(jEmpty && jEmpty.error));

  const long = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: CAP, lyrics: '啊'.repeat(3600) },
  }, token);
  const jLong = long.id ? await waitJob(long.id, token, 15000) : null;
  ck('歌词超 3500 字会被挡住',
    jLong && jLong.status === 'failed' && /3500/.test(String(jLong.error || '')),
    JSON.stringify(jLong && jLong.error));

  /* ---------- B. 没配音乐服务：要指路，不能闷声失败 ---------- */
  console.log('[B] 还没配音乐服务时');
  const sf = (await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) " +
    "VALUES ('阶跃星辰', 'stepfun', 'https://api.stepfun.com/v1', 'sk-test', 'stepaudio-3-music-preview', 1, 5)")).lastId;
  ck('阶跃星辰配置建好了', !!sf, sf);

  const noBind = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: '试跑一句话', lyrics: '试跑', pollMs: 200, maxPoll: 20 },
  }, token);
  // 还没绑槽位，但 profileChain 会回退到「其余启用配置」——阶跃星辰一家，应该直接跑通
  const jNoBind = noBind.id ? await waitJob(noBind.id, token, 30000) : null;
  ck('只此一家音乐服务时也能直接用上（不用先绑槽位）',
    jNoBind && jNoBind.status === 'done', jNoBind && (jNoBind.status + ' ' + (jNoBind.error || '')));

  // 把这家禁用掉，再确认「一家都没有」时说的是人话、带指路
  await x('UPDATE ai_profiles SET enabled=0 WHERE id=?', [sf]);
  const none = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: CAP, lyrics: LYR, pollMs: 200, maxPoll: 20 },
  }, token);
  const jNone = none.id ? await waitJob(none.id, token, 20000) : null;
  ck('一家都没有时报「没配作曲演唱」',
    jNone && jNone.status === 'failed' && /作曲演唱/.test(String(jNone.error || '')),
    JSON.stringify(jNone && jNone.error));
  ck('错误信息里给了该填哪个地址',
    jNone && /stepfun\.com|mureka\.ai/.test(String(jNone.error || '')), JSON.stringify(jNone && jNone.error));
  await x('UPDATE ai_profiles SET enabled=1 WHERE id=?', [sf]);

  /* ---------- C. 阶跃星辰：base64 那条路 ---------- */
  console.log('[C] 阶跃星辰：提交 → 轮询 → 落盘');
  await x("INSERT OR REPLACE INTO ai_slots (slot, profile_id, model) VALUES ('music',?,?)",
    [sf, 'stepaudio-3-music-preview']);
  const c1 = await req('/api/jobs/create', {
    type: 'aimusic',
    payload: { caption: CAP, lyrics: LYR, archiveId: aid, pollMs: 200, maxPoll: 30 },
  }, token);
  ck('任务排上了', !!c1.id, JSON.stringify(c1));
  const j1 = c1.id ? await waitJob(c1.id, token, 40000) : null;
  ck('任务跑到完成', j1 && j1.status === 'done', j1 && (j1.status + ' ' + (j1.error || '')));

  const r1 = (j1 && j1.result) || {};
  ck('结果里有成品路径（ai/music/*.mp3）', /^ai\/music\/[0-9a-f]{16}\.mp3$/.test(String(r1.path || '')), r1.path);
  ck('标了是阶跃星辰出的', String(r1.vendor) === 'stepfun', r1.vendor);
  ck('这一版是新作的（不是缓存）', r1.cached === false, JSON.stringify(r1).slice(0, 160));
  ck('把模型名带回来了', /stepaudio-3/.test(String(r1.model || '')), r1.model);

  const abs1 = r1.path ? path.join(DATA_DIR, 'users', '1', 'files', r1.path) : '';
  ck('音频真的落盘了', !!abs1 && fs.existsSync(abs1) && fs.statSync(abs1).size > 1000,
    abs1 + ' ' + (abs1 && fs.existsSync(abs1) ? fs.statSync(abs1).size : 'missing'));
  if (abs1 && fs.existsSync(abs1)) {
    ck('落盘的是完整音频（没被截断）', fs.readFileSync(abs1).slice(0, 3).toString('ascii') === 'ID3',
      fs.readFileSync(abs1).slice(0, 3).toString('hex'));
  }

  const lines1 = lastLines();
  const sf1 = lines1.filter(s => s.indexOf('stepfun submit') === 0).pop() || '';
  ck('提交时 task 是 text_to_music', /"task":"text_to_music"/.test(sf1), sf1);
  ck('歌词一起发过去了', /"lyr":"with-lyrics"/.test(sf1), sf1);
  ck('要的是 mp3', /"fmt":"mp3"/.test(sf1), sf1);

  // 真踩过的坑：base_url 本身已带 /v1，代码里再写 /v1 会拼成 /v1/v1/... 被服务商判 404。
  // 桩是按子串匹配的，这种错它照样"通过"，所以在这里把 URL 钉死。
  const url1 = (sf1.match(/"url":"([^"]+)"/) || [])[1] || '';
  ck('提交地址是 /v1/audio/music/submit（没有重复的 /v1）',
    url1 === 'https://api.stepfun.com/v1/audio/music/submit', url1);

  const med1 = await q("SELECT id,kind,path,mime,bytes FROM media WHERE archive_id=? AND kind='audio'", [aid]);
  ck('成品登记进档案（kind=audio）', med1.length === 1 && med1[0].path === r1.path, JSON.stringify(med1));

  /* ---------- D. Mureka：url 下载那条路 ---------- */
  console.log('[D] Mureka：提交 → 轮询 → 下载落盘');
  const mk = (await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) " +
    "VALUES ('Mureka', 'mureka', 'https://api.mureka.ai/v1', 'sk-test', 'auto', 1, 6)")).lastId;
  const c2 = await req('/api/jobs/create', {
    type: 'aimusic',
    payload: { caption: '老上海爵士，慵懒女声', lyrics: LYR, archiveId: aid,
      profileId: mk, model: 'auto', pollMs: 200, maxPoll: 30 },
  }, token);
  const j2 = c2.id ? await waitJob(c2.id, token, 40000) : null;
  ck('Mureka 也能出歌', j2 && j2.status === 'done', j2 && (j2.status + ' ' + (j2.error || '')));
  const r2 = (j2 && j2.result) || {};
  ck('标了是 Mureka 出的', String(r2.vendor) === 'mureka', r2.vendor);
  const abs2 = r2.path ? path.join(DATA_DIR, 'users', '1', 'files', r2.path) : '';
  ck('Mureka 的成品也落盘了', !!abs2 && fs.existsSync(abs2) && fs.statSync(abs2).size > 1000,
    abs2 + ' ' + (abs2 && fs.existsSync(abs2) ? fs.statSync(abs2).size : 'missing'));
  const mkLine = lastLines().filter(s => s.indexOf('mureka submit') === 0).pop() || '';
  ck('Mureka 收到的是歌词而非占位符', /"lyr":"with-lyrics"/.test(mkLine), mkLine);
  const mkUrl = (mkLine.match(/"url":"([^"]+)"/) || [])[1] || '';
  ck('Mureka 提交地址是 /v1/song/generate（没有重复的 /v1）',
    mkUrl === 'https://api.mureka.ai/v1/song/generate', mkUrl);

  // 没给歌词 + 没勾纯音乐：Mureka 只能作纯音乐，必须说清楚（不能闷声出个没人声的版本）
  const c3 = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: '安静的钢琴', archiveId: aid,
      profileId: mk, model: 'auto', pollMs: 200, maxPoll: 30 },
  }, token);
  const j3 = c3.id ? await waitJob(c3.id, token, 40000) : null;
  ck('没歌词时 Mureka 也出成品', j3 && j3.status === 'done', j3 && (j3.status + ' ' + (j3.error || '')));
  ck('并且说明了「没给歌词只能作纯音乐」',
    j3 && /纯音乐/.test(String((j3.result || {}).note || '')), JSON.stringify(j3 && j3.result && j3.result.note));

  /* ---------- E. 不重复计费 / 再来一版 ---------- */
  console.log('[E] 同一版不重复计费');
  const before = lastLines().length;
  const c4 = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: CAP, lyrics: LYR, archiveId: aid, pollMs: 200, maxPoll: 30 },
  }, token);
  const j4 = c4.id ? await waitJob(c4.id, token, 30000) : null;
  ck('第二次也算完成', j4 && j4.status === 'done', j4 && j4.status);
  ck('第二次标了 cached', j4 && j4.result && j4.result.cached === true, JSON.stringify(j4 && j4.result));
  ck('第二次给的是同一个文件', j4 && j4.result && j4.result.path === r1.path, j4 && j4.result && j4.result.path);
  ck('没有重复向服务商提交（不重复计费）', lastLines().length === before,
    lastLines().length + ' vs ' + before);

  const c5 = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: CAP, lyrics: LYR, again: 1, pollMs: 200, maxPoll: 30 },
  }, token);
  const j5 = c5.id ? await waitJob(c5.id, token, 40000) : null;
  ck('「再来一版」能出新歌', j5 && j5.status === 'done' && j5.result && j5.result.cached === false,
    JSON.stringify(j5 && j5.result));
  ck('「再来一版」确实重新提交了（重新计费）', lastLines().length === before + 1,
    lastLines().length + ' vs ' + (before + 1));

  /* ---------- F. 服务商拒绝：先换下一家，两家都拒才说人话 ---------- */
  console.log('[F] 服务商拒绝与兜底');
  const c6 = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: CAP, lyrics: LYR, profileId: sf,
      model: 'FAIL-model', again: 1, pollMs: 200, maxPoll: 10 },
  }, token);
  const j6 = c6.id ? await waitJob(c6.id, token, 30000) : null;
  ck('一家被拒会自动换下一家（不至于整条失败）',
    j6 && j6.status === 'done' && String((j6.result || {}).vendor) === 'mureka',
    j6 && (j6.status + ' ' + (j6.error || '') + ' ' + ((j6.result || {}).vendor || '')));

  const c7 = await req('/api/jobs/create', {
    type: 'aimusic', payload: { caption: 'FAIL 两家都拒', lyrics: LYR,
      model: 'FAIL-model', again: 1, pollMs: 200, maxPoll: 10 },
  }, token);
  const j7 = c7.id ? await waitJob(c7.id, token, 30000) : null;
  ck('两家都拒时任务状态是 failed', j7 && j7.status === 'failed', j7 && j7.status);
  ck('错误里带服务商原话', j7 && /model not found/.test(String(j7.error || '')), JSON.stringify(j7 && j7.error));
  ck('错误里带另一家的原话（余额不足）',
    j7 && /insufficient balance/.test(String(j7.error || '')), JSON.stringify(j7 && j7.error));
  ck('错误里带服务商名字（知道是谁拒的）',
    j7 && /阶跃星辰/.test(String(j7.error || '')) && /Mureka/.test(String(j7.error || '')),
    JSON.stringify(j7 && j7.error));

  await stop();
  console.log('\nAI 作曲链路审计：' + pass + ' 通过 / ' + failN + ' 失败');
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('审计挂了:', e && e.message); process.exit(1); });
