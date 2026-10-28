/**
 * v0.9.10 审计：合成片子的「删除」按钮背后的链路
 *   M1 建档案 + 登记成片（media kind='movie'）能查到
 *   M2 走 deleteMedia 的同款链路（DELETE FROM media + /api/file del）后：
 *      - media 表里没了
 *      - 视频文件真的从磁盘删掉
 *   M3 没登记进 media 的旧片子（jobs 兜底），按路径删文件也能走通
 *   M4 删除不存在的 media id 不炸（返回 changes 0）
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
  const t = startServer('-mvdel');
  await t.waitReady();
  const token = await t.register();

  // 注册出来的用户 uid 从 users 表查；档案建在他自己的 archive.db（ctxDb 按 token 路由）
  const me = await t.post('/api/auth/me', {}, token);
  const uid = me && (me.uid || (me.user && me.user.id));
  ok('能查到当前用户', !!uid, JSON.stringify(me).slice(0, 100));

  const filesRoot = path.join(t.DATA_DIR, 'users', String(uid), 'files');
  const mkFile = (rel) => {
    const abs = path.join(filesRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'FAKE_MP4_DATA_' + rel);
    return rel;
  };
  const relA = mkFile('ai/movie/aaaaaaaaaaaaaaaa/movie.mp4');
  const relB = mkFile('ai/movie/bbbbbbbbbbbbbbbb/movie.mp4');

  const ins = await t.post('/api/exec', {
    sql: 'INSERT INTO archives (user_id, subject_name, archive_no) VALUES (?,?,?)',
    params: [uid, '删除测试', 'MS-TEST-0001'],
  }, token);
  ok('建档案成功', ins.ok && ins.lastId > 0, JSON.stringify(ins).slice(0, 120));
  const aid = ins.lastId;

  const m1 = await t.post('/api/exec', {
    sql: "INSERT INTO media (archive_id, kind, path, mime, bytes, caption, duration_ms) VALUES (?,?,?,'video/mp4',123,'测试成片',41000)",
    params: [aid, 'movie', relA],
  }, token);
  const m2 = await t.post('/api/exec', {
    sql: "INSERT INTO media (archive_id, kind, path, mime, bytes, caption, duration_ms) VALUES (?,?,?,'video/mp4',123,'测试成片B',41000)",
    params: [aid, 'movie', relB],
  }, token);
  ok('登记两条成片', m1.ok && m2.ok && m1.lastId > 0 && m2.lastId > 0,
    JSON.stringify(m1).slice(0, 100) + JSON.stringify(m2).slice(0, 100));

  // —— M2：deleteMedia 的同款链路 ——
  const rows = await t.post('/api/query', { sql: 'SELECT path, poster FROM media WHERE id=?', params: [m1.lastId] }, token);
  ok('删除前能查到成片记录', rows.length === 1 && rows[0].path === relA);
  const del = await t.post('/api/exec', { sql: 'DELETE FROM media WHERE id=?', params: [m1.lastId] }, token);
  ok('DELETE media 返回 changes 1', del.ok && del.changes === 1, JSON.stringify(del));
  const fdel = await t.post('/api/file', { op: 'del', path: relA }, token);
  ok('/api/file del 返回 ok', fdel.ok !== false, JSON.stringify(fdel).slice(0, 100));
  ok('视频文件真的没了', !fs.existsSync(path.join(filesRoot, relA)));
  const after = await t.post('/api/query', { sql: 'SELECT id FROM media WHERE id=?', params: [m1.lastId] }, token);
  ok('media 表里也没了', after.length === 0);

  // —— M3：老片子（不在 media 表），按路径删文件 ——
  const fdel2 = await t.post('/api/file', { op: 'del', path: relB }, token);
  ok('兜底片子按路径删除走通', fdel2.ok !== false, JSON.stringify(fdel2).slice(0, 100));
  ok('第二个视频文件也没了', !fs.existsSync(path.join(filesRoot, relB)));

  // —— M4：删不存在的 id ——
  const ghost = await t.post('/api/exec', { sql: 'DELETE FROM media WHERE id=?', params: [999999] }, token);
  ok('删不存在的 id 不炸', ghost.ok && ghost.changes === 0, JSON.stringify(ghost));

  t.stop();
  console.log('\n删除审计：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('审计挂了:', e.message); process.exit(1); });
