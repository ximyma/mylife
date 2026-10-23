/* 生成逻辑端到端：造数据 -> DB.generate -> 验证分章/条目/照片归位/金句 */
global.window = {};
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
const fs = require('fs'), http = require('http');
function post(p, b) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(b);
    const r = http.request({ hostname: '127.0.0.1', port: 4321, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      x => { let o = ''; x.on('data', c => o += c); x.on('end', () => { try { res(JSON.parse(o)); } catch (e) { rej(new Error(o.slice(0, 200))); } }); });
    r.on('error', rej); r.write(d); r.end();
  });
}
global.API = {
  query: (s, p) => post('/api/query', { sql: s, params: p || [] }),
  exec: (s, p) => post('/api/exec', { sql: s, params: p || [] }),
  file: x => post('/api/file', x || {}),
};

(async () => {
  eval(fs.readFileSync('web/db.js', 'utf8'));
  const DB = window.DB;
  const now = Date.now();
  let pass = 0, fail = 0;
  const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' << ' + (d || '')); } };

  // 1. 建审计档案 + 三段讲述（不同年份）+ 一张 1958 照片
  const ar = await API.exec("INSERT INTO archives (subject_name,birth_year) VALUES ('生成审计',1949)");
  const aid = ar.lastId;
  await DB.addSegment(aid, '1949年我出生在乡下，家里五个孩子。');
  await DB.addSegment(aid, '一九五八年，我九岁，去村小读书。');
  await DB.addSegment(aid, '1975年我进了纺织厂当工人。');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex').toString('base64');
  await DB.addPhoto(aid, 'data:image/png;base64,' + png, 1958, '村小学', '开学第一天照相', 'audit-photo.png');

  // 2. 生成
  await DB.generate(aid);

  // 3. 验证
  const chapters = await API.query('SELECT * FROM chapters WHERE archive_id=? ORDER BY seq', [aid]);
  const entries = await API.query('SELECT * FROM entries WHERE archive_id=?', [aid]);
  const photos = await API.query('SELECT * FROM photos WHERE archive_id=?', [aid]);
  const st = (await API.query('SELECT status FROM archives WHERE id=?', [aid]))[0].status;

  ck('G1 生成后状态 ready', st === 'ready');
  ck('G2 至少分出 3 章（1949/1958/1975）', chapters.length >= 3, '实际 ' + chapters.length);
  ck('G3 每章有标题', chapters.every(c => c.title && c.title.length > 0));
  const has1949 = chapters.some(c => c.year_from === 1949);
  const has1975 = chapters.some(c => c.year_from === 1975);
  ck('G4 1949 与 1975 各归各章', has1949 && has1975);
  const textEntries = entries.filter(e => e.kind === 'text');
  ck('G5 三段讲述都进了条目', textEntries.length >= 3, '实际 ' + textEntries.length);
  ck('G6 条目都挂在章下（无孤儿）', textEntries.every(e => e.chapter_id));
  const photo1958 = photos.filter(p => p.taken_year === 1958);
  ck('G7 1958 年的照片归进了对应章', photo1958.length === 1 && photo1958[0].chapter_id,
    photo1958[0] ? 'chapter_id=' + photo1958[0].chapter_id : '无');
  const anyQuote = chapters.some(c => c.quote && c.quote.length > 2);
  ck('G8 至少一章有金句', anyQuote);
  const stage = chapters.some(c => c.stage);
  ck('G9 有阶段标签', stage);

  // 4. 再生成一次：用户手改过的内容不被覆盖（走真实 UI 路径 updateEntry）
  const before = (await API.query('SELECT id FROM entries WHERE archive_id=? AND kind=\'text\' LIMIT 1', [aid]))[0];
  await DB.updateEntry(before.id, '手改的内容不应被冲掉');
  const marked = (await API.query('SELECT origin, edited FROM entries WHERE id=?', [before.id]))[0];
  ck('G10a 手改后归属标记为 user', marked.origin === 'user' && marked.edited === 1, JSON.stringify(marked));
  await DB.generate(aid);
  const again = (await API.query('SELECT text, edited FROM entries WHERE id=?', [before.id]))[0];
  ck('G10 二次生成保留手改', again && again.text === '手改的内容不应被冲掉' && again.edited === 1,
    JSON.stringify(again));
  const quotes2 = (await API.query('SELECT count(*) n FROM chapters WHERE archive_id=? AND quote IS NOT NULL AND quote<>\'\'', [aid]))[0].n;
  ck('G10b 二次生成金句仍在', quotes2 > 0);

  // 5. 清理
  for (const p of photos) await API.file({ op: 'del', path: p.path });
  await API.exec('DELETE FROM entries WHERE archive_id=?', [aid]);
  await API.exec('DELETE FROM chapters WHERE archive_id=?', [aid]);
  await API.exec('DELETE FROM photos WHERE archive_id=?', [aid]);
  await API.exec('DELETE FROM segments WHERE archive_id=?', [aid]);
  await API.exec('DELETE FROM archives WHERE id=?', [aid]);
  ck('G11 审计数据已清', ((await API.query('SELECT count(*) n FROM archives WHERE id=?', [aid]))[0].n) === 0);

  console.log('\n生成逻辑: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
