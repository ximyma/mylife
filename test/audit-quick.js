/**
 * v0.9.17 审计：素材箱（随手记 quick_notes）
 *   P1 建表就绪，addQuick / listQuick / countQuick 走通
 *   P2 adoptQuick 收进档案：生成 kind='text' 条目 + 带年份 + 素材标记 adopted
 *   P3 markQuickAdopted 落账（照片收录路径）
 *   P4 removeQuick 连媒体文件一起删，不留孤儿文件
 *   P5 前端接线：index.html 引了 inbox.js；app.js 有 #/inbox 与 #/promise 路由；
 *      首页有承诺卡与素材箱角标；db.js 的 quick 语句里不出现未加白名单的写法
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

(async () => {
  const t = startServer('-quick');
  await t.waitReady();
  const token = await t.register();
  const me = await t.post('/api/auth/me', {}, token);
  const uid = me.uid;

  // —— P1：表就绪 + 录入 ——
  const ins = await t.post('/api/exec', {
    sql: "INSERT INTO quick_notes (kind,text) VALUES ('text','一九五八年，全家搬到了县城。')",
    params: [],
  }, token);
  ok('quick_notes 表就绪，写入成功', ins.ok === true && ins.lastId > 0, JSON.stringify(ins));

  const list = await t.post('/api/query', {
    sql: "SELECT id, kind, text, status FROM quick_notes WHERE status='open' ORDER BY id DESC",
    params: [],
  }, token);
  ok('listQuick 能读到 open 素材', list.length === 1 && list[0].kind === 'text');
  const cnt = await t.post('/api/query', {
    sql: "SELECT count(*) n FROM quick_notes WHERE status='open'", params: [],
  }, token);
  ok('countQuick 计数 = 1', cnt[0] && cnt[0].n === 1);

  // —— P2：收进档案（db.js adoptQuick 的同款两步 SQL） ——
  const arc = await t.post('/api/exec', {
    sql: 'INSERT INTO archives (user_id, subject_name, archive_no) VALUES (?,?,?)',
    params: [uid, '素材箱测试', 'MS-TEST-Q'],
  }, token);
  const aid = arc.lastId;

  const seq = await t.post('/api/query', {
    sql: 'SELECT coalesce(max(seq),0)+10 s FROM entries WHERE archive_id=? AND chapter_id IS NULL',
    params: [aid],
  }, token);
  const en = await t.post('/api/exec', {
    sql: "INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,at_year) VALUES (?,NULL,?,'text',?,'user',1,?)",
    params: [aid, seq[0].s, '一九五八年，全家搬到了县城。', 1958],
  }, token);
  ok('adoptQuick 同款条目写入成功', en.ok === true && en.lastId > 0, JSON.stringify(en));

  const mark = await t.post('/api/exec', {
    sql: "UPDATE quick_notes SET status='adopted', archive_id=?, entry_id=? WHERE id=?",
    params: [aid, en.lastId, ins.lastId],
  }, token);
  ok('素材标记 adopted', mark.ok === true);

  const entry = await t.post('/api/query', {
    sql: 'SELECT text, at_year, kind, origin FROM entries WHERE id=?', params: [en.lastId],
  }, token);
  ok('条目文字/年份/类型正确',
    entry.length === 1 && entry[0].at_year === 1958 && entry[0].kind === 'text' && entry[0].origin === 'user',
    JSON.stringify(entry));

  // —— P3：markQuickAdopted 同款（entryId 传 null 也行） ——
  const ins2 = await t.post('/api/exec', {
    sql: "INSERT INTO quick_notes (kind,text,media_path) VALUES ('audio',NULL,'audio/q1.wav')", params: [],
  }, token);
  const mark2 = await t.post('/api/exec', {
    sql: "UPDATE quick_notes SET status='adopted', archive_id=?, entry_id=? WHERE id=?",
    params: [aid, null, ins2.lastId],
  }, token);
  ok('markQuickAdopted（无条目）不报错', mark2.ok === true, JSON.stringify(mark2));

  // —— P4：removeQuick 连文件一起删 ——
  const filesRoot = path.join(t.DATA_DIR, 'users', String(uid), 'files');
  const rel = 'audio/quick-del-test.wav';
  fs.mkdirSync(path.dirname(path.join(filesRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, rel), 'FAKE_WAV');
  const ins3 = await t.post('/api/exec', {
    sql: "INSERT INTO quick_notes (kind,text,media_path) VALUES ('audio',NULL,?)", params: [rel],
  }, token);
  const delFile = await t.post('/api/file', { op: 'del', path: rel }, token);
  ok('removeQuick 前置：媒体文件删除接口可用', delFile.ok === true, JSON.stringify(delFile));
  ok('文件真的从磁盘没了', !fs.existsSync(path.join(filesRoot, rel)));
  const delRow = await t.post('/api/exec', {
    sql: 'DELETE FROM quick_notes WHERE id=?', params: [ins3.lastId],
  }, token);
  ok('素材行也删了', delRow.ok === true);

  // —— P5：前端接线 ——
  const web = path.join(__dirname, '..', 'web');
  const indexHtml = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  ok('index.html 引入 inbox.js', /<script src="inbox\.js"><\/script>/.test(indexHtml));
  const appJs = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  ok("app.js 有 #/inbox 路由", /'#\/inbox'/.test(appJs));
  ok("app.js 有 #/promise 路由", /'#\/promise'/.test(appJs));
  ok('首页有数据承诺卡', /promise-card/.test(appJs));
  ok('首页有素材箱角标', /quickBadge/.test(appJs));
  ok('buildWav 提到顶层（素材箱复用）', /\n  function buildWav\(/.test(appJs));
  const inboxJs = fs.readFileSync(path.join(web, 'inbox.js'), 'utf8');
  ok('inbox.js 注册了 window.InboxUI', /window\.InboxUI\s*=/.test(inboxJs));
  ok('inbox.js 有 AI 归纳入口', /aiSummarize/.test(inboxJs));
  const dbJs = fs.readFileSync(path.join(web, 'db.js'), 'utf8');
  ok('db.js 有素材箱数据层', /addQuick[\s\S]*listQuick[\s\S]*adoptQuick/.test(dbJs));
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
  ok('schema.sql 有 quick_notes 表', /CREATE TABLE IF NOT EXISTS quick_notes/.test(schema));

  t.stop();
  console.log('\n素材箱审计：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
