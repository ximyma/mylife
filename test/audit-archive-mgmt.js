/* 档案级管理端到端：改（含封面）→ 删（级联+文件清理） */
global.window = {};
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
const fs = require('fs'), http = require('http');
const { startServer } = require('./_lib.js');
const S = startServer('mgmt');
let TOKEN = '';
function post(p, b) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(b);
    const r = http.request(S.base + p, { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) },
        TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}) },
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
  await S.waitReady();
  TOKEN = await S.register();
  eval(fs.readFileSync('web/db.js', 'utf8'));
  const DB = window.DB;
  let pass = 0, fail = 0;
  const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); } };

  // 1. 建测试档案 + 一张照片 + 一条录音
  const ar = await API.exec("INSERT INTO archives (subject_name) VALUES ('待删除审计')");
  const aid = ar.lastId;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex').toString('base64');
  await DB.addPhoto(aid, 'data:image/png;base64,' + png, 1958, '测试地', '测试事件', 'del-audit.png');
  const wav = Buffer.from('RIFF0000WAVEfmt ').toString('base64');
  await API.file({ op: 'save', kind: 'audio', name: 'del-audit.wav', base64: wav });
  await API.exec('INSERT INTO segments (archive_id,raw_text,audio_path) VALUES (?,?,?)', [aid, 'x', 'audio/del-audit.wav']);
  await API.exec('INSERT INTO chapters (archive_id,seq,title) VALUES (?,?,?)', [aid, 10, '章']);

  // 2. 改：改名 + 指定封面
  const photos = await API.query('SELECT id FROM photos WHERE archive_id=?', [aid]);
  await DB.updateArchive(aid, { name: '改名后', birth: '1940', hometown: '新籍贯', cover_photo_id: photos[0].id });
  const a2 = (await API.query('SELECT * FROM archives WHERE id=?', [aid]))[0];
  ck('H1 改名生效', a2.subject_name === '改名后');
  ck('H2 生卒/籍贯生效', a2.birth_year === 1940 && a2.hometown === '新籍贯');
  ck('H3 封面照片指向成功', a2.cover_photo_id === photos[0].id);

  // 3. listArchives 带 photo_list（封面下拉的数据源）
  const lst = (await DB.listArchives()).filter(x => x.id === aid);
  ck('H4 列表带照片清单', lst.length === 1 && lst[0].photo_list.length === 1);

  // 4. 删：库记录级联 + 文件清理
  const fileExisted = (await API.file({ op: 'read', path: 'audio/del-audit.wav' })).ok;
  ck('H5 删除前录音文件在', fileExisted);
  await DB.deleteArchive(aid);
  const gone = (await API.query('SELECT count(*) n FROM archives WHERE id=?', [aid]))[0].n;
  ck('H6 档案记录已删', gone === 0);
  const leftKids = (await API.query(
    'SELECT (SELECT count(*) FROM chapters WHERE archive_id=?)+'+
    '(SELECT count(*) FROM entries WHERE archive_id=?)+'+
    '(SELECT count(*) FROM photos WHERE archive_id=?)+'+
    '(SELECT count(*) FROM segments WHERE archive_id=?)+'+
    '(SELECT count(*) FROM media WHERE archive_id=?) n',
    [aid, aid, aid, aid, aid]))[0].n;
  ck('H7 子表全部级联清空', leftKids === 0, '剩 ' + leftKids);
  const fileGone = !(await API.file({ op: 'read', path: 'audio/del-audit.wav' })).ok;
  ck('H8 录音文件已清', fileGone);

  console.log('\n档案管理: ' + pass + ' 通过 / ' + fail + ' 失败');
  S.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
