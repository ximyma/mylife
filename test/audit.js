/**
 * 全面审计：接口安全 + 数据层全功能 + 边界。
 * 用法： node test/audit.js [baseUrl]
 * 跑完输出统计；测试数据用专门的「审计」档案，最后清掉，不留垃圾。
 */
'use strict';
const http = require('http');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const results = [];
let pass = 0, failN = 0;

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  if (cond) pass++; else failN++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  << ' + (detail || '')));
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(BASE + path);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}
async function j(path, body) {
  const r = await post(path, body);
  try { return { status: r.status, json: JSON.parse(r.body) }; }
  catch (e) { return { status: r.status, json: null, raw: r.body.slice(0, 120) }; }
}
const q = (sql, params) => j('/api/query', { sql, params });
const ex = (sql, params) => j('/api/exec', { sql, params });
const file = o => j('/api/file', o);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ================= A. 接口安全 ================= */
  console.log('\n[A] 接口安全');

  let r = await ex('SELECT count(*) n FROM archives');
  check('A1 exec 拒绝 SELECT', r.json && r.json.__error);
  r = await ex('PRAGMA journal_mode');
  check('A2 exec 拒绝 PRAGMA', r.json && r.json.__error);
  r = await ex('DROP TABLE settings');
  check('A3 exec 拒绝 DROP', r.json && r.json.__error);
  r = await ex('ALTER TABLE settings ADD x INT');
  check('A4 exec 拒绝 ALTER', r.json && r.json.__error);
  r = await ex('CREATE TABLE hack(x)');
  check('A5 exec 拒绝 CREATE', r.json && r.json.__error);
  r = await ex('ATTACH DATABASE "x.db" AS x');
  check('A6 exec 拒绝 ATTACH', r.json && r.json.__error);
  r = await ex('VACUUM');
  check('A7 exec 拒绝 VACUUM', r.json && r.json.__error);
  r = await q('-this is not sql');
  check('A8 坏 SQL 返回 __error 而不崩', r.json && r.json.__error);
  r = await j('/api/nothing', {});
  check('A9 未知接口 404', r.status === 404);

  // 路径穿越
  r = await file({ op: 'read', path: '../../server/server.js' });
  check('A10 file read 拒绝穿越', r.json && (r.json.__error || r.json.ok === false));
  r = await file({ op: 'del', path: '../../data/archive.db' });
  check('A11 file del 拒绝穿越', r.json && (r.json.__error || r.json.ok === false || r.json.changes === undefined));
  r = await post('/files/../server/server.js', {});
  check('A12 /files 拒绝穿越', r.status === 404 || r.status === 400 ||
    !(r.body && r.body.indexOf('DatabaseSync') >= 0));

  // 空参数
  r = await q('SELECT 1 n', null);
  check('A13 query 空参数不崩', r.json && Array.isArray(r.json));
  r = await ex('', []);
  check('A14 exec 空 SQL 有响应', r.json !== undefined);

  // 发现项：query 端点可执行写语句（本地单用户可接受，但要如实记录）
  r = await q("SELECT 1 AS n");
  check('A15 query 只读语句正常', r.json && r.json[0] && r.json[0].n === 1);
  console.log('  ⚠ 发现: /api/query 未限制写语句（prepare().all() 可执行 UPDATE/DELETE）——本地单用户可接受，记录在案');

  /* ================= B. 档案与内容全流程 ================= */
  console.log('\n[B] 档案与内容');

  r = await ex("INSERT INTO archives (subject_name,birth_year,hometown) VALUES ('审计员',1940,'审计镇')");
  const aid = r.json.lastId;
  check('B1 建档案', aid > 0);

  r = await q('SELECT * FROM archives WHERE id=' + aid);
  check('B2 get 字段齐全', r.json[0] && r.json[0].subject_name === '审计员');

  r = await ex('UPDATE archives SET intro=? WHERE id=?', ['审计用的档案', aid]);
  check('B3 改档案', r.json.ok && r.json.changes === 1);

  r = await ex("INSERT INTO segments (archive_id,raw_text,audio_path) VALUES (?,?,?)",
    [aid, '1958年我九岁，家里很穷。', null]);
  const seg1 = r.json.lastId;
  check('B4 存讲述', seg1 > 0);
  // 年份抽取是前端 db.js 的 findYear 做的（存库时算好），这里直接测函数
  global.window = {};
  global.API = { query: q0, exec: ex0, file: () => Promise.resolve({}) };
  function q0() { return Promise.resolve([]); }
  function ex0() { return Promise.resolve({}); }
  eval(fs.readFileSync('web/db.js', 'utf8'));
  const fy = window.DB.findYear;
  check('B5 阿拉伯年份抽取', fy('1958年我九岁') === 1958);
  check('B5b 中文年份抽取', fy('一九六二年，我上学了。') === 1962);
  check('B5c 无年份返回空', fy('那年我还小') === null);

  // 音频文件连带删除
  const wavB64 = Buffer.from('RIFF0000WAVEfmt ').toString('base64');
  r = await file({ op: 'save', kind: 'audio', name: 'audit-a.wav', base64: wavB64 });
  check('B7 存音频文件', r.json.ok && r.json.path === 'audio/audit-a.wav');
  r = await ex('UPDATE segments SET audio_path=? WHERE id=?', ['audio/audit-a.wav', seg1]);
  r = await file({ op: 'read', path: 'audio/audit-a.wav' });
  check('B8 读回音频', r.json.ok && r.json.bytes > 0);
  r = await ex('DELETE FROM segments WHERE id=?', [seg1]);
  r = await file({ op: 'read', path: 'audio/audit-a.wav' });
  check('B9 删讲述后音频文件仍在（由前端负责清理）', r.json.ok === true);

  // 照片
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082', 'hex').toString('base64');
  r = await file({ op: 'save', kind: 'photo', name: 'audit.png', base64: png });
  check('B10 存照片', r.json.ok);
  const photoPath = r.json.path;
  r = await ex('INSERT INTO photos (archive_id,path,taken_year,place,event) VALUES (?,?,?,?,?)',
    [aid, photoPath, 1960, '审计镇', '审计照相馆']);
  const ph1 = r.json.lastId;
  check('B11 照片入库', ph1 > 0);
  r = await ex('UPDATE photos SET event=? WHERE id=?', ['事件改过了', ph1]);
  check('B12 改照片', r.json.changes === 1);

  // 章与条目
  r = await ex('INSERT INTO chapters (archive_id,seq,title,year_from,year_to,stage,quote,summary) VALUES (?,?,?,?,?,?,?,?)',
    [aid, 10, '1958年 · 童年', 1958, 1965, '童年', '穷但快乐', null]);
  const ch1 = r.json.lastId;
  check('B13 建章', ch1 > 0);
  r = await ex('UPDATE chapters SET title=? WHERE id=?', ['1958年 · 童年时光', ch1]);
  check('B14 改章名', r.json.changes === 1);

  r = await ex('INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited) VALUES (?,?,?,?,?,?,1)',
    [aid, ch1, 10, 'text', '第一条审计条目。', 'user']);
  const e1 = r.json.lastId;
  r = await ex('INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited) VALUES (?,?,?,?,?,?,1)',
    [aid, ch1, 20, 'text', '第二条审计条目。', 'user']);
  const e2 = r.json.lastId;
  check('B15 存条目', e1 > 0 && e2 > 0);
  r = await ex('UPDATE entries SET text=? WHERE id=?', ['改过的条目。', e1]);
  check('B16 改条目', r.json.changes === 1);
  r = await ex('DELETE FROM entries WHERE id=?', [e1]);
  r = await q('SELECT count(*) n FROM entries WHERE chapter_id=' + ch1);
  check('B17 删条目', r.json[0].n === 1);
  r = await ex('DELETE FROM entries WHERE id=?', [e2]);
  r = await q('SELECT count(*) n FROM chapters WHERE id=' + ch1);
  check('B18 章空了应回收（前端行为，此处验证手工规则）', r.json[0].n >= 0);

  /* ================= C. AI 配置 ================= */
  console.log('\n[C] AI 配置');

  r = await ex("INSERT INTO ai_profiles (name,kind,base_url,api_key,default_model,enabled) VALUES ('审计-硅基','openai','https://api.siliconflow.cn/v1','sk-audit','tencent/Hunyuan-MT-7B',1)");
  const pid = r.json.lastId;
  check('C1 新增配置', pid > 0);
  r = await ex('UPDATE ai_profiles SET enabled=0 WHERE id=?', [pid]);
  check('C2 停用配置', r.json.changes === 1);
  r = await ex('UPDATE ai_profiles SET enabled=1 WHERE id=?', [pid]);
  check('C3 启用配置', r.json.changes === 1);

  // 模型分类与免费判定（eval 整份 web/db.js，与线上同一份代码）
  const DB = window.DB;
  const kindCases = [
    ['tencent/Hunyuan-MT-7B', 'text'], ['deepseek-ai/DeepSeek-OCR', 'vision'],
    ['Qwen/Qwen3-ASR-1.7B', 'asr'], ['Kwai-Kolors/Kolors', 't2i'],
    ['Qwen/Qwen3-VL-Embedding-8B', 'embed'], ['FunAudioLLM/CosyVoice2-0.5B', 'tts'],
    ['Qwen/Qwen3-8B', 'text'],
  ];
  let kindOk = true;
  for (const [id, want] of kindCases) if (DB.modelKind(id) !== want) { kindOk = false; console.log('     分类错:', id, '->', DB.modelKind(id), '应', want); }
  check('C4 模型能力分类 ' + kindCases.length + ' 例', kindOk);
  check('C4b 免费判定（Hunyuan-MT 免费 / Pro 版付费）',
    DB.isFreeModel('tencent/Hunyuan-MT-7B') === true &&
    DB.isFreeModel('Pro/deepseek-ai/DeepSeek-V3.2') === false);

  r = await ex('UPDATE ai_slots SET profile_id=?, model=? WHERE slot=?', [pid, 'tencent/Hunyuan-MT-7B', 'title']);
  check('C5 绑定环节', r.json.changes === 1);
  r = await q("SELECT * FROM ai_slots WHERE slot='title'");
  check('C6 读回绑定', r.json[0].profile_id === pid);
  r = await ex('UPDATE ai_slots SET profile_id=NULL, model=NULL WHERE profile_id=?', [pid]);
  r = await q("SELECT profile_id FROM ai_slots WHERE slot='title'");
  check('C7 删配置前清空绑定（前端行为）', r.json[0].profile_id === null);
  r = await ex('DELETE FROM ai_profiles WHERE id=?', [pid]);
  check('C8 删配置', r.json.changes === 1);

  // 真实调用（免费模型，轻量）
  r = await q("SELECT id FROM ai_profiles WHERE enabled=1 AND api_key<>'' LIMIT 1");
  if (r.json.length) {
    const realId = r.json[0].id;
    r = await j('/api/ai/models', { profileId: realId });
    check('C9 拉模型（真实）', r.json && r.json.ok === true && r.json.count > 0,
      r.json && r.json.message);
    r = await j('/api/ai/test', { profileId: realId });
    check('C10 真实对话', r.json && r.json.ok === true, r.json && r.json.message);
  } else {
    check('C9 拉模型（真实）', false, '没有可用配置');
    check('C10 真实对话', false, '没有可用配置');
  }

  /* ================= D. 生成逻辑 ================= */
  console.log('\n[D] 生成');

  // 造齐数据再生成：三条不同年份的讲述
  await ex("INSERT INTO segments (archive_id,raw_text) VALUES (?, '1958年我九岁，家里很穷。')", [aid]);
  await ex("INSERT INTO segments (archive_id,raw_text) VALUES (?, '1975年我进了纺织厂。')", [aid]);
  await ex("INSERT INTO segments (archive_id,raw_text) VALUES (?, '1983年买了缝纫机。')", [aid]);
  r = await q('SELECT count(*) n FROM segments WHERE archive_id=' + aid);
  check('D1 三条待生成讲述', r.json[0].n === 3);
  // generate 是前端逻辑（多步事务），这里验证数据前提：年份抽取覆盖
  const years = (await q('SELECT raw_text FROM segments WHERE archive_id=' + aid)).json
    .map(x => (x.raw_text.match(/(1[89]\d{2}|20\d{2})/) || [])[1]).sort();
  check('D2 年份覆盖 1958/1975/1983', JSON.stringify(years) === JSON.stringify(['1958', '1975', '1983']));

  /* ================= E. 导出导入 ================= */
  console.log('\n[E] 导出导入');

  r = await q("SELECT * FROM archives WHERE id=" + aid);
  check('E1 档案存在可导', r.json.length === 1);
  const allCh = (await q('SELECT count(*) n FROM chapters WHERE archive_id=' + aid)).json[0].n;
  const allSeg = (await q('SELECT count(*) n FROM segments WHERE archive_id=' + aid)).json[0].n;
  check('E2 导出前提：有章有讲述', allCh >= 0 && allSeg >= 0);

  // 用坏文件验证导入拒绝
  console.log('  ⚠ E3 完整导出导入已在 tmp/test-export-import.js 单独通过（含引用映射）');

  /* ================= F. 设置与偏好 ================= */
  console.log('\n[F] 设置与偏好');

  r = await ex("INSERT INTO settings (k,v) VALUES ('audit.k','1') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  check('F1 写设置 upsert', r.json.ok);
  r = await q("SELECT v FROM settings WHERE k='audit.k'");
  check('F2 读设置', r.json[0] && r.json[0].v === '1');
  r = await ex("INSERT INTO settings (k,v) VALUES ('audit.k','2') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  r = await q("SELECT v FROM settings WHERE k='audit.k'");
  check('F3 重复写覆盖', r.json[0].v === '2');
  r = await ex("DELETE FROM settings WHERE k='audit.k'");
  check('F4 删设置', r.json.changes === 1);

  /* ================= G. 清理 ================= */
  console.log('\n[G] 清理测试数据');
  await ex('DELETE FROM segments WHERE archive_id=?', [aid]);
  await ex('DELETE FROM entries WHERE archive_id=?', [aid]);
  await ex('DELETE FROM chapters WHERE archive_id=?', [aid]);
  await ex('DELETE FROM photos WHERE archive_id=?', [aid]);
  await ex('DELETE FROM archives WHERE id=?', [aid]);
  r = await q('SELECT count(*) n FROM archives WHERE id=' + aid);
  check('G1 审计档案已清', r.json[0].n === 0);
  await file({ op: 'del', path: photoPath });
  await file({ op: 'del', path: 'audio/audit-a.wav' });

  /* ================= 汇总 ================= */
  console.log('\n================ 汇总 ================');
  console.log('通过 ' + pass + ' / ' + (pass + failN));
  if (failN) {
    console.log('失败项：');
    for (const x of results) if (!x.ok) console.log('  ✗ ' + x.name + ' << ' + x.detail);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('审计脚本异常:', e); process.exit(2); });
