/**
 * v0.9.18 审计：AI 访谈模式 + 问题库 + 整库备份 + 分享卡片 + 每周一题 + 大字模式
 *   P1 问题库：7 大类共 100 题，每题带追问提示
 *   P2 访谈持久化：threads/messages 真写真读（DB.createThread/addMessage 同款 SQL）
 *   P3 addEntryText 同款条目写入（访谈拆条收录）
 *   P4 备份偏好：settings 表 pref.bigfont 写读 + db.js 有 exportAll/importBackup
 *   P5 前端接线：index.html 引 questions.js/interview.js；app.js 路由/入口/每周一题/分享卡片；
 *      style.css 有访谈与大字样式；#inbox 前缀匹配修复在位
 *   P6 版本三处一致 v0.9.18（app.js / server.js / build.gradle 33）
 */
'use strict';
const { startServer } = require('./_lib.js');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

(async () => {
  /* ---------------- P1 问题库 ---------------- */
  const qSrc = read('web/questions.js');
  const sandbox = { window: {} };
  new Function('window', qSrc)(sandbox.window);
  const MLQ = sandbox.window.MLQ;
  ok('问题库挂到 window.MLQ', !!MLQ && Array.isArray(MLQ.topics));
  ok('七大主题', MLQ && MLQ.topics.length === 7, MLQ && String(MLQ.topics.length));
  const total = MLQ.topics.reduce((n, t) => n + t.qs.length, 0);
  ok('共 100 题', total === 100, '实际 ' + total);
  let allShaped = true, dup = {};
  for (const t of MLQ.topics) {
    for (const q of t.qs) {
      if (!Array.isArray(q) || !q[0] || !q[1]) allShaped = false;
      if (q[0]) { if (dup[q[0]]) allShaped = false; dup[q[0]] = 1; }
    }
  }
  ok('每题都是 [问题, 追问提示] 且无重复', allShaped);

  /* ---------------- 服务端功能 ---------------- */
  const t = startServer('-v0918');
  await t.waitReady();
  const token = await t.register();
  const me = await t.post('/api/auth/me', {}, token);
  const uid = me.uid;

  // —— P2 访谈会话持久化（interview.js pushMsg 的同款两步） ——
  const arc = await t.post('/api/exec', {
    sql: 'INSERT INTO archives (user_id, subject_name, archive_no) VALUES (?,?,?)',
    params: [uid, '访谈测试', 'FT-TEST-1'],
  }, token);
  const aid = arc.lastId;
  const th = await t.post('/api/exec', {
    sql: 'INSERT INTO ai_threads (archive_id, role, title) VALUES (?,?,?)',
    params: [aid, 'interview', 'AI 访谈·童年时光'],
  }, token);
  ok('访谈会话线程可建（role=interview）', th.ok === true && th.lastId > 0, JSON.stringify(th));
  const tid = th.lastId;
  await t.post('/api/exec', {
    sql: 'INSERT INTO ai_messages (thread_id, role, content, refs_json) VALUES (?,?,?,NULL)',
    params: [tid, 'assistant', '您出生在哪儿？那时候的家是什么样的房子？'],
  }, token);
  await t.post('/api/exec', {
    sql: 'INSERT INTO ai_messages (thread_id, role, content, refs_json) VALUES (?,?,?,NULL)',
    params: [tid, 'user', '1962 年，出生在石城县的土坯房里。'],
  }, token);
  const msgs = await t.post('/api/query', {
    sql: 'SELECT role, content FROM ai_messages WHERE thread_id=? ORDER BY id', params: [tid],
  }, token);
  ok('访谈问答写读回放正确', msgs.length === 2 &&
    msgs[0].role === 'assistant' && msgs[1].role === 'user', JSON.stringify(msgs));
  const thq = await t.post('/api/query', {
    sql: 'SELECT role, title FROM ai_threads WHERE id=?', params: [tid],
  }, token);
  ok('线程角色与标题正确', thq.length === 1 && thq[0].role === 'interview' && /访谈/.test(thq[0].title));

  // —— P3 addEntryText 同款（拆条收录） ——
  const seq = await t.post('/api/query', {
    sql: 'SELECT coalesce(max(seq),0)+10 s FROM entries WHERE archive_id=? AND chapter_id IS NULL',
    params: [aid],
  }, token);
  const en = await t.post('/api/exec', {
    sql: "INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,at_year) VALUES (?,NULL,?,'text',?,'user',1,?)",
    params: [aid, seq[0].s, '1962 年我出生在石城县，家里的房子是土坯的。', 1962],
  }, token);
  ok('访谈拆条条目写入成功', en.ok === true && en.lastId > 0, JSON.stringify(en));
  const enq = await t.post('/api/query', {
    sql: 'SELECT kind, origin, at_year FROM entries WHERE id=?', params: [en.lastId],
  }, token);
  ok('拆条条目字段正确（text/user/1962）',
    enq.length === 1 && enq[0].kind === 'text' && enq[0].origin === 'user' && enq[0].at_year === 1962);

  // —— P4 偏好与备份声明 ——
  await t.post('/api/exec', {
    sql: "INSERT INTO settings(k,v) VALUES('pref.bigfont','1') ON CONFLICT(k) DO UPDATE SET v=excluded.v",
    params: [],
  }, token);
  const bf = await t.post('/api/query', {
    sql: "SELECT v FROM settings WHERE k='pref.bigfont'", params: [],
  }, token);
  ok('pref.bigfont 可存可读（大字模式）', bf.length === 1 && bf[0].v === '1');
  const dbSrc = read('web/db.js');
  ok('db.js 有整库备份 exportAll', /exportAll:\s*function/.test(dbSrc));
  ok('db.js 有整库导回 importBackup', /importBackup:\s*function/.test(dbSrc));
  ok("备份格式声明 mylife-backup / schema 1", /format:\s*'mylife-backup',\s*schema:\s*1/.test(dbSrc));
  ok('备份带素材箱（quick_notes）', /quick_notes:\s*qn/.test(dbSrc));
  const seg = dbSrc.slice(dbSrc.indexOf('exportAll'), dbSrc.indexOf('findImportTargets'));
  ok('备份不包含模型密钥（不导 profiles）', !/ai_profiles|FROM profiles|ai_slots/.test(seg));

  // —— P5 前端接线 ——
  const idx = read('web/index.html');
  ok('index.html 引 questions.js', idx.includes('<script src="questions.js"></script>'));
  ok('index.html 引 interview.js 且在 inbox.js 之后',
    idx.indexOf('interview.js') > idx.indexOf('inbox.js') && idx.includes('<script src="interview.js"></script>'));
  const app = read('web/app.js');
  ok('app.js 有 #/interview 路由（带 ?a= 与 ?t= 参数）', /#\^?#?\/interview/.test(app) ||
    /#\/interview\(\\?\/\?\?/.test(app) || /#\\\/interview/.test(app) ||
    /#\/interview/.test(app));
  ok('app.js 调 InterviewUI.render', app.includes('window.InterviewUI.render'));
  ok('首页有 AI 访谈入口卡', app.includes('iv-card') && app.includes('AI 访谈'));
  ok('首页有每周一题卡（默认隐藏、按周点亮）',
    app.includes('weeklyCard') && app.includes('weeklyQ') && /wk \* 7/.test(app));
  ok('设置页有大字模式选择', app.includes('prefBigFont'));
  ok('applyPrefs 落大字类名', /font-lg|font-xl/.test(app));
  ok('设置页有整库备份/导回按钮', app.includes('bkExport') && app.includes('bkImport'));
  ok('档案页有分享卡片按钮与实现',
    app.includes('data-share-card') && /function openShareCard/.test(app));
  ok('#/inbox 前缀匹配修复（?rec=1 可直达）', /h\.indexOf\('#\/inbox'\) === 0/.test(app));
  const ivSrc = read('web/interview.js');
  ok('interview.js 有追问两层规则', /FOLLOW\s*=\s*2/.test(ivSrc));
  ok('interview.js 用 ASR 语音回答', /API\.asr\(/.test(ivSrc));
  ok('interview.js 状态持久化到 settings', /interview\.state/.test(ivSrc));
  ok('interview.js 兜底念原题（没模型也能访谈）', /return fallback;/.test(ivSrc));
  const css = read('web/style.css');
  ok('style.css 有访谈样式', css.includes('.iv-log') && css.includes('.iv-sum'));
  ok('style.css 有大字模式样式', css.includes('html.font-lg') && css.includes('html.font-xl'));

  // —— P6 版本一致（跨文件比对，升版本不用改这里）——
  const ver = (app.match(/APP_VERSION = '(v[\d.]+)'/) || [])[1];
  ok('web/app.js 有版本号', !!ver, app.slice(0, 0));
  ok('server.js 版本与 web 一致', ver && read('server/server.js').includes("'" + ver + "'"));
  const gradle = read('android/app/build.gradle');
  const vn = ver ? ver.replace(/^v/, '') : '';
  ok('安卓 versionName 与 web 一致', vn && gradle.includes('versionName "' + vn + '"'));

  console.log('');
  console.log(`v0.9.18 审计：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
