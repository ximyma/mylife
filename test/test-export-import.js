/* 端到端：导出档案 → 导入 → 对比条目/章/照片数量与引用完整性 */
global.window = {};
global.API = null;
global.btoa = s => Buffer.from(s, 'binary').toString('base64');

const fs = require('fs');
const http = require('http');
const { startServer } = require('./_lib.js');
const S = startServer('exim');
let TOKEN = '';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(S.base + path, { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}) },
      res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(buf.slice(0, 200))); } });
      });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

global.API = {
  query: (sql, params) => post('/api/query', { sql, params: params || [] }),
  exec: (sql, params) => post('/api/exec', { sql, params: params || [] }),
  file: p => post('/api/file', p || {}),
};

(async () => {
  await S.waitReady();
  TOKEN = await S.register();
  eval(fs.readFileSync('web/db.js', 'utf8'));
  const DB = window.DB;

  // 新账号空库：先造一本带照片的档案
  const aid0 = (await global.API.exec(
    "INSERT INTO archives (subject_name, birth_year) VALUES ('导出测试', 1950)")).lastId;
  await global.API.exec("INSERT INTO segments (archive_id, raw_text) VALUES (?, '1950年出生，测试讲述。')", [aid0]);
  const pngB64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex').toString('base64');
  const saved = await global.API.file({ op: 'save', kind: 'photo', name: 'exim.png', base64: pngB64 });
  await global.API.exec('INSERT INTO photos (archive_id, path, taken_year, place, event) VALUES (?,?,?,?,?)',
    [aid0, saved.path, 1950, '测试地', '测试事件']);

  console.log('=== 导出档案 ===');
  const pack = await DB.exportArchive(aid0);
  console.log('章:', pack.chapters.length, '条目:', pack.entries.length,
    '照片:', pack.photos.length, '讲述:', pack.segments.length, '媒体:', pack.media.length);
  const withB64 = pack.photos.filter(p => p.b64).length;
  console.log('照片带内容:', withB64, '/', pack.photos.length);
  console.log('包大小:', Math.round(JSON.stringify(pack).length / 1024) + 'KB');

  console.log('\n=== 导入回系统 ===');
  const r = await DB.importArchive(JSON.parse(JSON.stringify(pack)));
  console.log('新档案 id:', r.archiveId);
  const newAid = r.archiveId;

  console.log('\n=== 对比 ===');
  const q = s => API.query(s, []);
  const cnt = async (t, aid) => (await q(`SELECT count(*) n FROM ${t} WHERE archive_id=${aid}`))[0].n;
  void aid0;
  const [oc, oe, op, nc, ne, np] = await Promise.all([
    cnt('chapters', aid0), cnt('entries', aid0), cnt('photos', aid0),
    cnt('chapters', newAid), cnt('entries', newAid), cnt('photos', newAid),
  ]);
  console.log(`章 ${oc} -> ${nc} | 条目 ${oe} -> ${ne} | 照片 ${op} -> ${np}`);
  const ok = nc === oc && ne === oe && np === op;

  // 引用完整性：条目引用的照片 id 必须真实存在于新档案
  const broken = (await q(
    `SELECT count(*) n FROM entries e WHERE e.archive_id=${newAid} AND e.photo_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.id=e.photo_id AND p.archive_id=${newAid})`))[0].n;
  console.log('条目照片引用断链:', broken, broken === 0 ? '✓' : '!!');
  const cover = (await q(`SELECT cover_photo_id FROM archives WHERE id=${newAid}`))[0].cover_photo_id;
  console.log('封面已重映射:', cover ? '✓' : '(无封面)');

  console.log(ok && broken === 0 ? '\n导出导入全链路 ✓' : '\n有问题！');
  S.stop();
  process.exit(ok && broken === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
