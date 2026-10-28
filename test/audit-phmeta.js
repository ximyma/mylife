/**
 * v0.9.11 审计：照片「哪一年/在哪儿/什么事」保存
 *   P1 修复后的 UPDATE photos 语句能跑（v0.9.11 之前凭空写 note 列，必炸）
 *   P2 保存后能读回，年份/地点/事情都对
 *   P3 前端拼的 updatePhoto 语句里不该再出现 note
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
  const t = startServer('-phmeta');
  await t.waitReady();
  const token = await t.register();
  const me = await t.post('/api/auth/me', {}, token);
  const uid = me.uid;

  // 摆一张真照片文件
  const filesRoot = path.join(t.DATA_DIR, 'users', String(uid), 'files');
  const rel = 'photo/test/phmeta.jpg';
  fs.mkdirSync(path.dirname(path.join(filesRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, rel), 'FAKE_JPEG');

  const ins = await t.post('/api/exec', {
    sql: 'INSERT INTO archives (user_id, subject_name, archive_no) VALUES (?,?,?)',
    params: [uid, '照片说明测试', 'MS-TEST-PH'],
  }, token);
  const aid = ins.lastId;
  const ph = await t.post('/api/exec', {
    sql: "INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)",
    params: [aid, rel, 2026, '江西石城', '封底照'],
  }, token);
  ok('登记照片成功', ph.ok && ph.lastId > 0, JSON.stringify(ph));

  // —— P1：updatePhoto 修复后的同款 UPDATE ——
  const up = await t.post('/api/exec', {
    sql: 'UPDATE photos SET taken_year=?, place=?, event=? WHERE id=?',
    params: [2026, '江西石城', '封底照·修改后', ph.lastId],
  }, token);
  ok('UPDATE photos 不再报 no such column', up.ok === true, JSON.stringify(up));

  // —— P2：读回 ——
  const rows = await t.post('/api/query', { sql: 'SELECT taken_year, place, event FROM photos WHERE id=?', params: [ph.lastId] }, token);
  ok('年份读回一致', rows.length === 1 && rows[0].taken_year === 2026);
  ok('地点读回一致', rows[0].place === '江西石城');
  ok('事情读回一致', rows[0].event === '封底照·修改后');

  // —— P3：前端源码里不该再写 note ——
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'db.js'), 'utf8');
  ok('updatePhoto 不再写 note 列', !/UPDATE photos SET[^']*, note=\?/.test(src));

  t.stop();
  console.log('\n照片说明审计：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('审计挂了:', e.message); process.exit(1); });
