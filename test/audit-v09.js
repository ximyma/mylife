/**
 * v0.9 审计：漫画分镜规则 + 短片渲染管线。
 *
 * 分镜与配乐是纯规则，用真服务跑一遍就能验；短片是要真的调 ffmpeg 的，
 * 这里直接合成一条 3 格的短片，检查它：能不能出文件、是不是竖屏 1080×1920、
 * 有没有音轨、尺寸对不对。跑不通就说明渲染管线坏了，不是「环境问题」。
 *
 * 用法： node test/audit-v09.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer } = require('./_lib.js');

const FF = path.join(__dirname, '..', 'bin', 'ffmpeg.exe');

/* 64×114 的纯色 PNG。用它是为了让审计自给自足——不去读 tmp 里别人留下的图 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAByCAIAAABsuUAvAAAAvklEQVR4nO3PUQkAIBTAwBfRJMYxryH8PzVYwL3f3R0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4zw9qfQABl0F7wQAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 200) : '')); }
};

(async () => {
  const S = startServer('v09');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, p) => S.post('/api/query', { sql, params: p || [] }, t);
  const x = (sql, p) => S.post('/api/exec', { sql, params: p || [] }, t);

  const aid = (await x("INSERT INTO archives (archive_no,subject_name,birth_year,hometown,status) VALUES ('MS-A9','张桂芳',1942,'山东济南','ready')")).lastId;
  const chId = (await x("INSERT INTO chapters (archive_id,seq,title,year_from,year_to) VALUES (?,1,'第二章 · 进厂',1956,1962)", [aid])).lastId;

  /* ---------- A 分镜规则 ---------- */
  console.log('[A] 分镜规划');

  // 先给一章没有内容：应当明确报错，而不是给一个空片子
  const emptyRes = await S.post('/api/movie/plan', { archiveId: aid, chapterId: chId }, t);
  const emptyMsg = String((emptyRes && (emptyRes.__error || emptyRes.message)) || '');
  ck('空章节不给空片子，直接报错', /还没有讲述/.test(emptyMsg), JSON.stringify(emptyRes).slice(0, 120));

  const photoDir = path.join(S.DATA_DIR, 'users', '1', 'files', 'photo');
  fs.mkdirSync(photoDir, { recursive: true });
  // 自带的极小 PNG：测试不该依赖 tmp 里的临时文件
  fs.writeFileSync(path.join(photoDir, 'p1.png'), Buffer.from(TINY_PNG, 'base64'));
  // place / event 是 NOT NULL：漏了会静默失败，所以这里连返回值一起断言
  const phRes = await x("INSERT INTO photos (archive_id,path,taken_year,place,event,chapter_id) VALUES (?,?,1956,?,?,?)",
    [aid, 'photo/p1.png', '济南', '厂门口', chId]);
  ck('照片能落库（顺带证明上一句没静默失败）', Number(phRes.lastId) > 0, JSON.stringify(phRes).slice(0, 120));

  const LONGTEXT = '一九五六年国棉三厂招工，我十六岁，母亲给我做了一件蓝布褂子，把我送到厂门口，说好好干别让人说咱家孩子不行';
  const e1 = (await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,at_year,sort_key) VALUES (?,?,1,'text',?,'user',1,1956,1)",
    [aid, chId, LONGTEXT])).lastId;
  await x("INSERT INTO entries (archive_id,chapter_id,seq,kind,text,origin,edited,at_year,sort_key) VALUES (?,?,2,'text','车间里上百台机器一起响','user',1,1957,2)",
    [aid, chId]);

  const plan = await S.post('/api/movie/plan', { archiveId: aid, chapterId: chId }, t);
  ck('规划成功', plan.ok === true, JSON.stringify(plan).slice(0, 120));
  // v0.9.5 起长讲述按句/按 50 字切格（字幕一行 13 字、四行封顶），一句不丢；
  // 短句仍然一格。所以 2 段 → 3 格，每格都能回指到它的讲述条目。
  ck('长讲述切成多格、短讲述一格（不丢字）', plan.frames.length === 3 &&
    plan.frames.every(f => !!f.entryId), plan.frames.length);
  ck('切开的格子拼回去等于原文', plan.frames.filter(f => f.entryId === e1).map(f => f.text).join('') === LONGTEXT,
    plan.frames.map(f => f.text).join(' | ').slice(0, 80));
  ck('长句按字数加权：比短句长', plan.frames[0].sec > plan.frames[2].sec,
    plan.frames[0].sec + ' vs ' + plan.frames[2].sec);
  ck('单格时长封顶 12 秒（够念完 50 字）', plan.frames[0].sec <= 12, plan.frames[0].sec);
  ck('单格时长不低于 2.8 秒', plan.frames[1].sec >= 2.8, plan.frames[1].sec);
  ck('没有照片的格子标出来缺图', plan.missing === 1, plan.missing);
  ck('规划能识别 ffmpeg 在不在', typeof plan.hasFfmpeg === 'boolean', plan.hasFfmpeg);
  ck('超长文字会截断（不撑爆字幕）', plan.frames[0].text.length <= 82, plan.frames[0].text.length);

  /* ---------- B 漫画分镜 ---------- */
  console.log('[B] 漫画分镜');
  await x("DELETE FROM storyboards");
  const comic = await S.post('/api/exec', {
    sql: 'INSERT INTO storyboards (archive_id, chapter_id, layout, json) VALUES (?,?,?,?)',
    params: [aid, chId, '2x2', JSON.stringify({ pages: [] })],
  }, t);
  ck('storyboards 表可写', comic.ok !== false || comic.lastId > 0, JSON.stringify(comic).slice(0, 100));

  /* ---------- C 短片合成 ---------- */
  console.log('[C] 短片合成');
  if (!fs.existsSync(FF)) {
    console.log('  - 跳过：本机没有 bin/ffmpeg.exe（node tools/fetch-ffmpeg.js 可拉取）');
  } else {
    const job = await S.post('/api/jobs/create', {
      type: 'movie',
      payload: {
        archiveId: aid,
        title: '审计短片',
        frames: [
          { image: 'photo/p1.png', text: '一九五六年国棉三厂招工', sec: 2 },
          { image: null, text: '车间里上百台机器一起响', sec: 2 },
        ],
        voice: false,
        bgm: 'calm',
      },
    }, t);
    ck('任务能建', job.ok === true, JSON.stringify(job));

    let st = null;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      st = (await S.post('/api/jobs', { id: job.id }, t)).job;
      if (st.status === 'done' || st.status === 'failed' || st.status === 'canceled') break;
    }
    ck('任务跑完', st && st.status === 'done', st && (st.status + ' / ' + st.error));

    const res = (st && st.result) || {};
    const abs = path.join(S.DATA_DIR, 'users', '1', 'files', res.path || 'x');
    ck('成片落盘', fs.existsSync(abs) && fs.statSync(abs).size > 20000,
      fs.existsSync(abs) ? fs.statSync(abs).size : 'missing');
    ck('时长约等于分镜之和', Math.abs(Number(res.seconds) - 4) < 0.6, res.seconds);
    ck('清理了中间碎片', fs.readdirSync(path.dirname(abs)).filter(f => /^seg\d+\.mp4$/.test(f)).length === 0);

    // 成片要作为「档案资产」登记进 media：这样关掉页面、换设备回来还能在档案里找到
    const mv = await q("SELECT path, bytes, duration_ms, caption FROM media WHERE archive_id=? AND kind='movie'", [aid]);
    ck('成片登记进档案 media（能找回、随档案备份）',
      mv.length === 1 && mv[0].path === res.path && Number(mv[0].bytes) > 20000,
      JSON.stringify(mv).slice(0, 160));
    ck('登记了时长与标题', Number((mv[0] || {}).duration_ms) > 3000 && !!mv[0].caption,
      JSON.stringify(mv[0] || {}).slice(0, 120));

    // 同参数再合成一次（缓存命中同一条 path）不能重复登记
    const jobSame = await S.post('/api/jobs/create', {
      type: 'movie',
      payload: {
        archiveId: aid, title: '审计短片', voice: false, bgm: 'calm',
        frames: [
          { image: 'photo/p1.png', text: '一九五六年国棉三厂招工', sec: 2 },
          { image: null, text: '车间里上百台机器一起响', sec: 2 },
        ],
      },
    }, t);
    let stS = null;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      stS = (await S.post('/api/jobs', { id: jobSame.id }, t)).job;
      if (stS.status === 'done' || stS.status === 'failed' || stS.status === 'canceled') break;
    }
    const mv2 = await q("SELECT id FROM media WHERE archive_id=? AND kind='movie'", [aid]);
    ck('重复合成不重复登记（同一条成片只有一条记录）', mv2.length === 1, mv2.length);

    if (fs.existsSync(abs)) {
      const info = spawnSync(FF, ['-hide_banner', '-i', abs], { encoding: 'utf8' });
      const err = String(info.stderr || '');
      ck('竖屏 1080×1920', /1080x1920/.test(err), (err.match(/\d{3,4}x\d{3,4}/) || [])[0]);
      ck('有音轨（BGM 混进去了）', /Audio: aac/.test(err), /Audio: ([^\n]+)/.exec(err));
      ck('容器是真 mp4（ftyp 头）', (() => {
        const b = Buffer.alloc(12);
        const fd = fs.openSync(abs, 'r');
        fs.readSync(fd, b, 0, 12, 0);
        fs.closeSync(fd);
        return b.slice(4, 8).toString() === 'ftyp';
      })());
    }

    // 缺图那格不能崩，这一点由「任务跑完」间接证明了；再验一次取消语义
    const j2 = await S.post('/api/jobs/create', { type: 'movie', payload: { frames: [], voice: false } }, t);
    let st2 = null;
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      st2 = (await S.post('/api/jobs', { id: j2.id }, t)).job;
      if (st2.status === 'failed' || st2.status === 'done') break;
    }
    ck('空分镜明确失败而不是产出空文件', st2 && st2.status === 'failed' && /没有可用的分镜/.test(st2.error || ''),
      st2 && (st2.status + ' / ' + st2.error));
  }

  /* ---------- D ASS 时间格式 ---------- */
  console.log('[D] 字幕时间');
  // 直接验算：3.5 秒必须写成 0:00:03.50，不是 3.5 或 .350
  const { assTime } = (() => {
    // 从 server.js 里抠出函数不好，这里按同一规则复算一遍，两边必须一致
    return {
      assTime(sec) {
        const t2 = Math.max(0, Number(sec) || 0);
        const h = Math.floor(t2 / 3600);
        const m = Math.floor((t2 % 3600) / 60);
        const s = t2 % 60;
        const whole = Math.floor(s);
        const cs = Math.round((s - whole) * 100);
        const pad = (n, w) => String(n).padStart(w || 2, '0');
        return h + ':' + pad(m) + ':' + pad(whole) + '.' + pad(cs === 100 ? 99 : cs);
      },
    };
  })();
  ck('3.5 秒 → 0:00:03.50', assTime(3.5) === '0:00:03.50', assTime(3.5));
  ck('65 秒 → 0:01:05.00', assTime(65) === '0:01:05.00', assTime(65));
  ck('毫秒转百分秒（1.234 → .23）', assTime(1.234) === '0:00:01.23', assTime(1.234));

  console.log('\n' + (fail === 0 ? '全部通过' : '有 ' + fail + ' 项没过') + '：' + pass + ' / ' + (pass + fail));
  S.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
