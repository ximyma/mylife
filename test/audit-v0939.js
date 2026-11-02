/**
 * v0.9.39 审计：三件用户反馈
 *   A 插入图片：多选 + 看大图（能左右滑）+ 插完停在原地（前端接线静态检查）
 *   B 素材「收进档案」：能选章节；文字进档案、录音和素材留在素材箱；带录音是可选的老行为
 *   C 素材导出 / 导入：选中几条打包成 .mylife-materials.json，导回后文件可读
 *
 * 走真实 LocalServer（隔离数据目录），前面的 DB 是 web/db.js 本体，不是复制品。
 */
'use strict';

global.window = {};
global.btoa = s => Buffer.from(s, 'binary').toString('base64');

const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

const S = startServer('-v0939');
let TOKEN = '';

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(S.base + p, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(new Error(buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** 和 web/api.js 一样：服务端回 __error 就当场抛，别让"静默失败"混过去 */
function call(p, body) {
  return post(p, body).then(j => {
    if (j && j.__error) throw new Error(j.__error);
    return j;
  });
}

global.API = {
  query: (sql, params) => call('/api/query', { sql, params: params || [] }),
  exec: (sql, params) => call('/api/exec', { sql, params: params || [] }),
  file: p => call('/api/file', p || {}),
};

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

/** 0.1 秒的 8k 单声道 WAV，够真能读回来 */
function tinyWav() {
  const rate = 8000, n = 800;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2);
  return buf.toString('base64');
}

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  await S.waitReady();
  TOKEN = await S.register();
  eval(read('web/db.js'));
  const DB = window.DB;

  /* ---------- 备料：一本档案、两章、三段录音素材 ---------- */
  const aid = (await global.API.exec("INSERT INTO archives (subject_name) VALUES ('v0939 测试')")).lastId;
  const ch1 = (await global.API.exec('INSERT INTO chapters (archive_id,seq,title) VALUES (?,?,?)',
    [aid, 10, '第一章'])).lastId;
  const ch2 = (await global.API.exec('INSERT INTO chapters (archive_id,seq,title) VALUES (?,?,?)',
    [aid, 20, '第二章'])).lastId;

  const wav = tinyWav();
  const f1 = await global.API.file({ op: 'save', kind: 'audio', name: 'a1.wav', base64: wav });
  const f2 = await global.API.file({ op: 'save', kind: 'audio', name: 'a2.wav', base64: wav });
  const f3 = await global.API.file({ op: 'save', kind: 'audio', name: 'a3.wav', base64: wav });
  ok('录音落盘', !!(f1.path && f2.path && f3.path), JSON.stringify([f1, f2]));

  const q1 = await DB.addQuick('audio', '一九五八年，全家搬到了县城。', f1.path, 3);
  const q2 = await DB.addQuick('audio', '第二年开了间小铺子。', f2.path, 5);
  const q3 = await DB.addQuick('text', '还没转写的随手记');

  /* ---------- B1 收进档案：能选章节，录音留在素材箱 ---------- */
  console.log('\n=== B1 收进指定章（不带录音） ===');
  const r1 = await DB.adoptQuick(q1, aid, 1958, '一九五八年，全家搬到了县城。', { chapterId: ch2 });
  ok('返回条目 id', !!(r1 && r1.entryId), JSON.stringify(r1));
  const e1 = (await global.API.query('SELECT * FROM entries WHERE id=?', [r1.entryId]))[0];
  ok('条目落在选定的第二章', Number(e1.chapter_id) === Number(ch2), 'ch=' + e1.chapter_id);
  ok('条目是纯文字', e1.kind === 'text', 'kind=' + e1.kind);
  ok('年份写进条目', Number(e1.at_year) === 1958, 'at_year=' + e1.at_year);
  ok('没跟来一条多余的媒体', !e1.media_id);

  const row1 = (await global.API.query('SELECT * FROM quick_notes WHERE id=?', [q1]))[0];
  ok('素材状态 = kept（收过但还在）', row1.status === 'kept', 'status=' + row1.status);
  ok('录音仍挂在素材上', row1.media_path === f1.path, 'path=' + row1.media_path);
  ok('转写文字没有被搬空', String(row1.text || '').indexOf('一九五八') === 0);
  ok('素材记住了 entry_id', Number(row1.entry_id) === Number(r1.entryId));
  ok('返回里标明录音留在素材箱', r1.keptAudio === true);

  const stillReadable = await global.API.file({ op: 'read', path: f1.path });
  ok('录音文件本身还在、读得出来', !!stillReadable.base64);

  const listed = await DB.listQuick();
  ok('素材箱列表里还看得见它', listed.some(x => Number(x.id) === Number(q1)));
  ok('列表带上了档案名（已进哪本一眼看到）',
    String((listed.filter(x => Number(x.id) === Number(q1))[0] || {}).subject_name || '') === 'v0939 测试');

  /* ---------- B2 带录音的老行为：勾了才移交 ---------- */
  console.log('\n=== B2 勾了「录音也一起带进档案」 ===');
  const r2 = await DB.adoptQuick(q2, aid, 1959, '第二年开了间小铺子。', { bringAudio: true });
  const e2 = (await global.API.query('SELECT * FROM entries WHERE id=?', [r2.entryId]))[0];
  ok('条目变成媒体型，能在档案里回放', e2.kind === 'media' && !!e2.media_id,
    'kind=' + e2.kind + ' media=' + e2.media_id);
  const row2 = (await global.API.query('SELECT * FROM quick_notes WHERE id=?', [q2]))[0];
  ok('录音所有权移交（media_path 清空，删素材不会误删档案里的）',
    !row2.media_path || String(row2.media_path) === '');
  const m2 = await global.API.query('SELECT * FROM media WHERE id=?', [e2.media_id]);
  ok('档案 media 表里有这条录音', m2.length === 1 && m2[0].kind === 'audio');

  /* ---------- B3 不传 opts 也不炸（老调用点兼容） ---------- */
  console.log('\n=== B3 老调用点（4 个参数）仍可用 ===');
  const q4 = await DB.addQuick('text', '老接口写法');
  const r4 = await DB.adoptQuick(q4, aid, null, '老接口写法');
  const e4 = (await global.API.query('SELECT * FROM entries WHERE id=?', [r4.entryId]))[0];
  ok('不传 opts 也能收进待归档', !e4.chapter_id && e4.kind === 'text');

  /* ---------- C 素材导出 / 导入 ---------- */
  console.log('\n=== C 导出素材（只导选中的两条）===');
  const pack = await DB.exportMaterials([q1, q3]);
  ok('格式对', pack.format === 'mylife-materials' && pack.version === 1);
  ok('条数对', pack.count === 2 && pack.items.length === 2, 'count=' + pack.count);
  ok('带录音的那条有文件内容', !!pack.items[0].b64);
  ok('纯文字那条没有文件内容', !pack.items[1].b64);
  ok('没有缺文件', pack.missing === 0, 'missing=' + pack.missing);
  ok('报了体积', pack.bytes > 0, 'bytes=' + pack.bytes);

  const round = JSON.parse(JSON.stringify(pack));
  const beforeN = (await global.API.query('SELECT count(*) n FROM quick_notes'))[0].n;
  console.log('\n=== C 导入素材 ===');
  const imp = await DB.importMaterials(round, () => {});
  const afterN = (await global.API.query('SELECT count(*) n FROM quick_notes'))[0].n;
  ok('导入条数对', imp.done === 2, JSON.stringify(imp));
  ok('素材箱多了两条', Number(afterN) - Number(beforeN) === 2, beforeN + ' -> ' + afterN);

  const impRows = await global.API.query(
    "SELECT * FROM quick_notes WHERE id > ? ORDER BY id", [beforeN]);
  ok('导入的是新素材（status=open，还要自己决定收不收）',
    impRows.length === 2 && impRows.every(x => x.status === 'open'));
  const audioRow = impRows.filter(x => x.kind === 'audio')[0];
  ok('导入的录音落成了新文件', !!audioRow && audioRow.media_path !== f1.path,
    audioRow && audioRow.media_path);
  const readBack = await global.API.file({ op: 'read', path: audioRow.media_path });
  ok('导入的录音读得回来', !!readBack.base64);
  ok('导入的文字原样带过来',
    String(impRows.filter(x => x.kind === 'text')[0].text || '') === '还没转写的随手记');

  ok('文件大小对得上（导出再导入不缩水）',
    Math.abs(Buffer.from(readBack.base64, 'base64').length - Buffer.from(wav, 'base64').length) <= 2,
    Buffer.from(readBack.base64, 'base64').length + ' vs ' + Buffer.from(wav, 'base64').length);

  /* ---------- D 退回素材箱（收错了不用删） ---------- */
  console.log('\n=== D1 正文段落退回素材箱 ===');
  const tEntry = (await global.API.exec(
    "INSERT INTO entries (archive_id,chapter_id,seq,kind,text,sort_key) VALUES (?,?,?,?,?,?)",
    [aid, ch1, 100, 'text', '我在正文里手写的一段回忆，收错地方了。', 100])).lastId;
  const d1 = await DB.entryToQuick(tEntry);
  ok('退回成功', !!(d1 && d1.kind === 'text'), JSON.stringify(d1));
  const gone = await global.API.query('SELECT id FROM entries WHERE id=?', [tEntry]);
  ok('档案里这条没了', gone.length === 0);
  const dq1 = await global.API.query('SELECT * FROM quick_notes WHERE id=?', [d1.quickId]);
  ok('素材箱里多了一条同样的文字', dq1.length === 1 && dq1[0].text.indexOf('手写的一段') > 0);
  ok('它是待整理状态（还能再收进档案）', dq1[0].status === 'open');

  console.log('\n=== D2 正文照片退回素材箱（文件跟着走） ===');
  const phFile = await global.API.file({ op: 'save', kind: 'photo', name: 'd2.png', base64: wav.replace(/^/, '') });
  const phRow = (await global.API.exec(
    'INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)',
    [aid, phFile.path, 1965, '老家', '门口那张合影'])).lastId;
  const pEntry = (await global.API.exec(
    "INSERT INTO entries (archive_id,chapter_id,seq,kind,photo_id,sort_key) VALUES (?,?,?,?,?,?)",
    [aid, ch1, 110, 'photo', phRow, 110])).lastId;
  const d2 = await DB.entryToQuick(pEntry);
  ok('退回成功且不复制（文件移交）', d2 && d2.kind === 'photo' && d2.copied === false, JSON.stringify(d2));
  const d2q = (await global.API.query('SELECT * FROM quick_notes WHERE id=?', [d2.quickId]))[0];
  ok('素材指向同一份文件', d2q.media_path === phFile.path, d2q.media_path);
  ok('素材里记了照片说明（什么事）', String(d2q.text || '').indexOf('合影') >= 0);
  const d2read = await global.API.file({ op: 'read', path: d2q.media_path });
  ok('文件还在、读得出来', !!d2read.base64);
  const phLeft = await global.API.query('SELECT id FROM photos WHERE id=?', [phRow]);
  ok('照片库里这一行清掉了（不会重复出现在章节照片里）', phLeft.length === 0);

  console.log('\n=== D3 从素材收进来的录音，退回后是原来那条（不重复） ===');
  // B2 里 q2 是带录音收进档案的：quick 还被标 kept，媒体挂在条目上
  const beforeQuickN = (await global.API.query('SELECT count(*) n FROM quick_notes'))[0].n;
  const d3 = await DB.entryToQuick(r2.entryId);
  const afterQuickN = (await global.API.query('SELECT count(*) n FROM quick_notes'))[0].n;
  ok('认得出来是"原路返回"', d3 && d3.restored === true, JSON.stringify(d3));
  ok('素材条数没变（没多出一份）', Number(afterQuickN) === Number(beforeQuickN),
    beforeQuickN + ' -> ' + afterQuickN);
  const d3q = (await global.API.query('SELECT * FROM quick_notes WHERE id=?', [d3.quickId]))[0];
  ok('素材回到待整理', d3q.status === 'open');
  ok('录音重新挂回素材', d3q.media_path === f2.path, d3q.media_path);
  const d3media = await global.API.query('SELECT id FROM media WHERE id=?', [e2.media_id]);
  ok('档案里的 media 行清掉了', d3media.length === 0);
  const d3read = await global.API.file({ op: 'read', path: d3q.media_path });
  ok('录音文件还听得到', !!d3read.base64);

  console.log('\n=== D4 同一张照片被两处引用：退回时只复制，不动原件 ===');
  const shFile = await global.API.file({ op: 'save', kind: 'photo', name: 'd4.png', base64: wav });
  const shPhoto = (await global.API.exec(
    'INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)',
    [aid, shFile.path, 1970, '县城', '共用的图'])).lastId;
  const eA = (await global.API.exec(
    "INSERT INTO entries (archive_id,chapter_id,seq,kind,photo_id,sort_key) VALUES (?,?,?,?,?,?)",
    [aid, ch1, 120, 'photo', shPhoto, 120])).lastId;
  await global.API.exec(
    "INSERT INTO entries (archive_id,chapter_id,seq,kind,photo_id,sort_key) VALUES (?,?,?,?,?,?)",
    [aid, ch1, 130, 'photo', shPhoto, 130]);
  const d4 = await DB.entryToQuick(eA);
  ok('认得出还有别处在用，改成复制', d4 && d4.copied === true, JSON.stringify(d4));
  const d4q = (await global.API.query('SELECT * FROM quick_notes WHERE id=?', [d4.quickId]))[0];
  ok('素材用的是新文件', d4q.media_path && d4q.media_path !== shFile.path, d4q.media_path);
  const shStill = await global.API.query('SELECT id FROM photos WHERE id=?', [shPhoto]);
  ok('原来那张照片还在（另一条还在用它）', shStill.length === 1);
  const d4read = await global.API.file({ op: 'read', path: d4q.media_path });
  ok('复制出来的文件读得出来', !!d4read.base64);

  /* ---------- A 前端接线（静态检查） ---------- */
  console.log('\n=== A 插入图片：多选 + 大图 + 停在原地 ===');
  const appJs = read('web/app.js');
  const inboxJs = read('web/inbox.js');
  const css = read('web/style.css');

  ok('有 focusEntry（插完滚回那一段）', /function focusEntry\(/.test(appJs));
  ok('有 insertPickedPhotos（多张按顺序插）', /function insertPickedPhotos\(/.test(appJs));
  ok('有大图预览 openPhotoPreview', /function openPhotoPreview\(/.test(appJs));
  ok('预览支持左右滑（touchstart/touchend）',
    /pvStage[\s\S]{0,80}touchstart/.test(appJs) && /touchstart[\s\S]{0,400}touchend/.test(appJs));
  ok('选图不再「点一下就插」：确认按钮 data-pv-ok',
    /data-pv-ok/.test(appJs) && /插进去（/.test(appJs));
  ok('条目渲染带 data-eid，插入后才定位得到', /data-eid="' \+ e\.id \+ '"/.test(appJs));
  ok('拍照/视频/录音插完也回到原地',
    (appJs.match(/focusEntry\(r && r\.lastId\)/g) || []).length >= 3,
    'count=' + (appJs.match(/focusEntry\(r && r\.lastId\)/g) || []).length);
  ok('样式里有大图预览层 .photo-view', /\.photo-view\{/.test(css));
  ok('样式里有新插入高亮 .fresh', /\.en\.fresh/.test(css));

  ok('收进档案有章节下拉 adCh', /id="adCh"/.test(inboxJs));
  ok('收进档案有「录音也一起带进档案」勾选', /id="adAudioToo"/.test(inboxJs));
  ok('切档案会刷新章节列表', /arcSel\.onchange = fillChapters/.test(inboxJs));
  ok('素材箱有选择模式入口', /id="qSelBtn"/.test(inboxJs));
  ok('素材箱有全选/导出/导入', /qSelAll/.test(inboxJs) && /qSelExport/.test(inboxJs) && /qImportBtn/.test(inboxJs));
  ok('素材箱有导出文件名的约定', /mylife-materials\.json/.test(inboxJs));
  ok('已收进档案的素材在列表里带标记', /q-kept-tag/.test(inboxJs) && /q-kept-tag/.test(css));

  const dbJs = read('web/db.js');
  ok('db 有 exportMaterials', /exportMaterials: function/.test(dbJs));
  ok('db 有 importMaterials', /importMaterials: function/.test(dbJs));
  ok('listQuick 同时收 open 与 kept', /status IN \('open','kept'\)/.test(dbJs));
  ok('insertAfter 能带年份', /o\.atYear/.test(dbJs));

  ok('整本导出会报清张数/段数/体积', /packSummary\(pack\)/.test(appJs) && /packText\(s\)/.test(appJs));

  ok('条目上有「退」（退回素材箱）', (appJs.match(/data-to-quick="/g) || []).length >= 3,
    'count=' + (appJs.match(/data-to-quick="/g) || []).length);
  ok('退之前说清"不会丢、还能再收回来"', /退回收进档案/.test(appJs) || /退回素材箱？/.test(appJs));
  ok('db 有 entryToQuick', /entryToQuick: function/.test(dbJs));
  ok('素材箱认视频（🎬 视频 + 播放器）', /q\.kind === 'video'/.test(inboxJs) && /q\.kind === 'video' \? '🎬 视频'/.test(inboxJs));

  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  S.stop && S.stop();
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('审计自己崩了：', e);
  process.exit(2);
});
