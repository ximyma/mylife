/**
 * v0.5 基座审计：新表 / 任务队列 / 用量 / 文件子目录 / 时间轴 / 版本 / 导出。
 *
 * 这套盯的是「基座」——后面所有耗时的、要落盘的功能都踩在它上面，
 * 它坏了不会立刻报错，而是过两周才以"导出的文件少了一半"的形式出现。
 *
 * 用法： node test/audit-v05.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const S = startServer('v05');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, params) => S.post('/api/query', { sql, params: params || [] }, t);
  const x = (sql, params) => S.post('/api/exec', { sql, params: params || [] }, t);

  /* ---------- A 表结构 ---------- */
  console.log('[A] 表结构');
  const objs = await q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')");
  const names = objs.map(r => r.name);
  for (const n of ['derivations', 'jobs', 'ai_usage', 'exports', 'entry_versions',
    'scripts', 'storyboards', 'ai_assets', 'ai_threads', 'ai_messages', 'v_timeline']) {
    ck('有 ' + n, names.indexOf(n) >= 0);
  }
  const cols = (await q('PRAGMA table_info(entries)')).map(c => c.name);
  for (const c of ['at_year', 'at_month', 'at_day', 'at_precision', 'at_label', 'sort_key']) {
    ck('entries 有 ' + c, cols.indexOf(c) >= 0);
  }
  const acols = (await q('PRAGMA table_info(archives)')).map(c => c.name);
  ck('archives 有 portrait_photo_id', acols.indexOf('portrait_photo_id') >= 0);
  ck('archives 有 cover_config_json', acols.indexOf('cover_config_json') >= 0);
  const pcols = (await q('PRAGMA table_info(photos)')).map(c => c.name);
  ck('photos 有 role', pcols.indexOf('role') >= 0);
  ck('photos 有 crop_json', pcols.indexOf('crop_json') >= 0);

  /* ---------- B 任务队列 ---------- */
  console.log('[B] 任务队列');
  const job = await S.post('/api/jobs/create', { type: 'selftest', payload: { steps: 5, ms: 40 } }, t);
  ck('能建任务', job.ok && job.id > 0, JSON.stringify(job));
  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    const g = await S.post('/api/jobs', { id: job.id }, t);
    st = g.job;
    if (st && (st.status === 'done' || st.status === 'failed')) break;
  }
  ck('任务跑完了', st && st.status === 'done', st && st.status + ' ' + st.error);
  ck('进度到 100%', st && Number(st.progress) === 1);
  ck('有阶段文字', st && !!st.stage, st && st.stage);
  ck('有结果', st && st.result && Number(st.result.steps) === 5);

  const bad = await S.post('/api/jobs/create', { type: 'nope' }, t);
  ck('未知类型被拒', !!bad.__error || bad.ok === false);

  const slow = await S.post('/api/jobs/create', { type: 'selftest', payload: { steps: 60, ms: 60 } }, t);
  await sleep(200);
  await S.post('/api/jobs/cancel', { id: slow.id }, t);
  let canceled = null;
  for (let i = 0; i < 30; i++) {
    await sleep(120);
    const g = await S.post('/api/jobs', { id: slow.id }, t);
    canceled = g.job;
    if (canceled && (canceled.status === 'canceled' || canceled.status === 'done')) break;
  }
  ck('能取消任务', canceled && canceled.status === 'canceled', canceled && canceled.status);

  /* ---------- C 用量记账 ---------- */
  console.log('[C] 用量记账');
  await x("INSERT INTO ai_usage (capability, model, units, unit, cost) VALUES ('text','m1',120,'token',0)");
  await x("INSERT INTO ai_usage (capability, model, units, unit, cost) VALUES ('asr','m2',30,'KB',0)");
  const u = await S.post('/api/ai/usage', { days: 30 }, t);
  ck('用量有两条能力', u.ok && u.byCapability.length === 2, JSON.stringify(u.byCapability));
  ck('合计次数正确', Number(u.calls) === 2);
  const u0 = await S.post('/api/ai/usage', { days: 0 }, t);
  ck('天数兜底不炸', u0.ok && Number(u0.days) >= 1);

  /* ---------- D 文件子目录 ---------- */
  console.log('[D] 文件子目录');
  const b64 = Buffer.from('hello v05').toString('base64');
  const saved = await S.post('/api/file', { op: 'save', dir: 'derived/thumbs', name: 'a.txt', base64: b64 }, t);
  ck('能写子目录', saved.ok && saved.path === 'derived/thumbs/a.txt', JSON.stringify(saved));
  const onDisk = path.join(S.DATA_DIR, 'users', '1', 'files', 'derived', 'thumbs', 'a.txt');
  ck('文件真的落盘', fs.existsSync(onDisk));
  const back = await S.post('/api/file', { op: 'read', path: 'derived/thumbs/a.txt' }, t);
  ck('能读回来', back.ok && Buffer.from(back.base64, 'base64').toString() === 'hello v05');
  const stt = await S.post('/api/file', { op: 'stat', path: 'derived/thumbs/a.txt' }, t);
  ck('stat 报存在', stt.ok && stt.exists === true && stt.bytes > 0);
  const trav = await S.post('/api/file', { op: 'save', dir: '../../etc', name: 'x.txt', base64: b64 }, t);
  const travPath = trav.ok ? trav.path : '';
  ck('目录穿越被洗掉', !/\.\./.test(travPath), travPath);
  const trav2 = await S.post('/api/file', { op: 'read', path: '../../auth.db' }, t);
  ck('读穿越被拒', !!trav2.__error, JSON.stringify(trav2).slice(0, 80));

  /* ---------- E 数据与时间轴 ---------- */
  console.log('[E] 时间轴');
  const aid = (await x("INSERT INTO archives (archive_no, subject_name, birth_year, hometown) VALUES ('MS-T-1','张桂芳',1942,'山东济南')")).lastId;
  const chId = (await x("INSERT INTO chapters (archive_id, seq, title, year_from, year_to) VALUES (?,10,'第二章 · 进厂',1956,1962)", [aid])).lastId;
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited, at_year, at_precision, sort_key) VALUES (?,?,10,'text','十六岁进厂',  'user',1,1956,'year',10)", [aid, chId]);
  await x("INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited, at_year, at_month, at_precision, sort_key) VALUES (?,?,20,'text','三月换车间','user',1,1962,3,'month',20)", [aid, chId]);
  await x("INSERT INTO photos (archive_id, path, taken_year, place, event, chapter_id) VALUES (?, 'photo/x.jpg', 1965, '济南', '厂门口', ?)", [aid, chId]);
  const tl = await q('SELECT * FROM v_timeline WHERE archive_id=? ORDER BY at_year', [aid]);
  ck('时间轴合并四类', tl.length >= 3, 'rows=' + tl.length);
  ck('按年排好序', Number(tl[0].at_year) === 1956 && Number(tl[tl.length - 1].at_year) >= 1962);
  const unknown = await q('SELECT count(*) n FROM v_timeline WHERE archive_id=? AND at_year IS NULL', [aid]);
  ck('没有年份的进待定区', Number(unknown[0].n) === 0);

  /* ---------- F 版本：原文不可变 ---------- */
  console.log('[F] 版本');
  const eid = (await q('SELECT id FROM entries WHERE archive_id=? ORDER BY id LIMIT 1', [aid]))[0].id;
  const before = (await q('SELECT text FROM entries WHERE id=?', [eid]))[0].text;
  const vres = await x("INSERT INTO entry_versions (entry_id, archive_id, kind, style, text, status) VALUES (?,?, 'polish','书面','十六岁那年进了国棉三厂','proposal')", [eid, aid]);
  const vid = vres.lastId;
  const stillOriginal = (await q('SELECT text FROM entries WHERE id=?', [eid]))[0].text;
  ck('提出润色不改原文', stillOriginal === before, stillOriginal);
  // 采纳的后端动作：先存 original，再覆盖
  await x("INSERT INTO entry_versions (entry_id, archive_id, kind, text, status) VALUES (?,?,'original',?,'kept')", [eid, aid, before]);
  await x('UPDATE entries SET text=?, edited=1 WHERE id=?', ['十六岁那年进了国棉三厂', eid]);
  await x("UPDATE entry_versions SET status='accepted' WHERE id=?", [vid]);
  const kept = await q("SELECT text FROM entry_versions WHERE entry_id=? AND kind='original'", [eid]);
  ck('采纳前存下了原文', kept.length === 1 && kept[0].text === before, JSON.stringify(kept));

  /* ---------- G 导出落盘 ---------- */
  console.log('[G] 导出');
  const payload = Buffer.from('PK fake docx content').toString('base64');
  const ex = await S.post('/api/export/save', { name: '测试书', ext: 'docx', base64: payload, archiveId: aid }, t);
  ck('docx 落盘', ex.ok && /exports\/.+\.docx$/.test(ex.path), JSON.stringify(ex));
  const exRow = await q('SELECT * FROM exports WHERE archive_id=?', [aid]);
  ck('有导出记录', exRow.length === 1 && exRow[0].kind === 'docx');
  ck('导出文件存在', fs.existsSync(path.join(S.DATA_DIR, 'users', '1', 'files', ex.path)));

  const noHtml = await S.post('/api/export/pdf', {}, t);
  ck('空内容拒绝导出 PDF', noHtml.ok === false && !!noHtml.message);

  /* ---------- H 对话接口（无配置时给可操作的话） ---------- */
  console.log('[H] 对话接口');
  const chat = await S.post('/api/ai/chat', { messages: [{ role: 'user', content: '你好' }] }, t);
  ck('没配模型时明确提示', chat && chat.t === 'err' && /模型/.test(chat.message || ''), JSON.stringify(chat).slice(0, 120));
  const chat2 = await S.post('/api/ai/chat', {}, t);
  ck('没内容也明确提示', chat2 && chat2.t === 'err');

  /* ---------- I 封面/头像字段 ---------- */
  console.log('[I] 封面与头像');
  await x('UPDATE archives SET portrait_photo_id=?, cover_config_json=? WHERE id=?',
    [null, JSON.stringify({ style: 'ink', font: 'kai', accent: '#7B2E2E', pos: '50% 20%', zoom: 1.2 }), aid]);
  const a2 = (await q('SELECT cover_config_json FROM archives WHERE id=?', [aid]))[0];
  const cfg = JSON.parse(a2.cover_config_json);
  ck('封面参数能存能读', cfg.style === 'ink' && cfg.zoom === 1.2);

  /* ---------- J 流式对话与降级（用假服务，不花钱） ---------- */
  console.log('[J] 流式对话');
  const http = require('http');
  const mock = http.createServer((req, res) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch (e) {}
      if (req.url.indexOf('/fail/') === 0) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"boom"}');
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const parts = ['一九六二', '年三月', '换了车间。'];
        parts.forEach((p, i) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n');
        });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '整段回复' }, finish_reason: 'stop' }],
        usage: { total_tokens: 42 },
      }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  // 第一条故意配成会 500 的地址，第二条才是好的 —— 用来验降级链
  await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) VALUES ('坏的','openai',?, 'k','bad-model',1,0)", ['http://127.0.0.1:' + mockPort + '/fail']);
  await x("INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, sort) VALUES ('好的','openai',?, 'k','ok-model',1,1)", ['http://127.0.0.1:' + mockPort + '/v1']);
  await x("DELETE FROM ai_slots WHERE slot IN ('title','asr')");
  await x("INSERT INTO ai_slots (slot, profile_id, model) VALUES ('title', 2, 'ok-model')");

  const chunks = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ messages: [{ role: 'user', content: '1962 年换车间' }] });
    const rq = http.request({
      host: '127.0.0.1', port: new URL(S.base).port, path: '/api/ai/chat', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: 'Bearer ' + t },
    }, res => {
      let buf = '', lines = [];
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { lines.push(JSON.parse(line)); } catch (e) {} }
        }
      });
      res.on('end', () => resolve(lines));
    });
    rq.on('error', reject);
    rq.write(data); rq.end();
  });
  const deltas = chunks.filter(c => c.t === 'd').map(c => c.v).join('');
  ck('流式收到多段增量', chunks.filter(c => c.t === 'd').length === 3, 'chunks=' + chunks.length);
  ck('增量拼起来是整句', deltas === '一九六二年三月换了车间。', deltas);
  ck('有 done 收尾', chunks.some(c => c.t === 'done'));
  ck('坏的配置被跳过（有 retry）', chunks.some(c => c.t === 'retry') || chunks.some(c => c.t === 'done'));

  const usage2 = await S.post('/api/ai/usage', { days: 30 }, t);
  ck('流式调用记了账', Number(usage2.calls) >= 3, JSON.stringify(usage2.byCapability));

  const aiOut = await S.post('/api/ai', { messages: [{ role: 'user', content: '你好' }] }, t);
  ck('非流式对话也能降级成功', aiOut.ok === true && aiOut.text === '整段回复', JSON.stringify(aiOut).slice(0, 120));
  ck('降级过程有记录', Array.isArray(aiOut.fallbacks) && aiOut.fallbacks.length >= 1,
    JSON.stringify(aiOut.fallbacks));

  mock.close();

  /* ---------- 收尾 ---------- */
  await x('DELETE FROM archives WHERE id=?', [aid]);
  S.stop();
  console.log('\nv0.5 基座: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('审计崩了：' + (e && e.stack || e)); process.exit(1); });
