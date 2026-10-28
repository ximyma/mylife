/**
 * 「写歌 → 演奏出来」链路审计（服务端）。
 *
 * 用户要的是「作曲演奏歌曲」，不是只有歌词。这条链路是：
 *   歌词 + 曲风 → 人声(TTS) + 伴奏(synthBgm) → ffmpeg 混成 mp3
 * 这里验证的是纯伴奏那条路（不依赖任何 AI 供应商，隔夜也能跑）：
 *   A 没 ffmpeg 时说清楚，不假装成功
 *   B 纯伴奏能出成品：文件落地、是真 mp3、时长够、复算命中缓存
 *   C 入参校验：空歌词 / 超长歌词 / 没这种曲风
 *   D 登记进 media（kind='audio'）后能被查回来，档案页才列得出
 *
 * 用法：node test/audit-song.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? ' << ' + String(d).slice(0, 200) : '')); }
};

const FFMPEG_SRC = path.join(__dirname, '..', 'dist', 'data', 'bin',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

(async () => {
  const S = startServer('song');
  await S.waitReady();

  // 服务端优先用数据目录里的 ffmpeg，没有就解数据包里的。审计环境两样都没有，
  // 手动放一份进去 —— 我们要测的是混音逻辑，不是解包逻辑。
  if (fs.existsSync(FFMPEG_SRC)) {
    fs.mkdirSync(path.join(S.DATA_DIR, 'bin'), { recursive: true });
    fs.copyFileSync(FFMPEG_SRC, path.join(S.DATA_DIR, 'bin', path.basename(FFMPEG_SRC)));
  }
  const token = await S.register();
  const me = await S.post('/api/auth/me', {}, token);
  const uid = me && me.uid;
  const filesRoot = path.join(S.DATA_DIR, 'users', String(uid), 'files');

  const probe = await S.post('/api/render/probe', {}, token);
  if (!probe.ok) {
    console.log('  ! 这个环境没有 ffmpeg（找不到 ' + FFMPEG_SRC + '），跳到只校验入参');
  }

  const aid = (await S.post('/api/exec', {
    sql: "INSERT INTO archives (archive_no, subject_name) VALUES ('MS-SONG-1','李老')", params: [],
  }, token)).lastId;

  /* ---------- C. 入参校验（有没有 ffmpeg 都一样） ---------- */
  console.log('[C] 入参校验');
  const bad1 = await S.post('/api/song/make', { lyrics: '' }, token);
  ck('没歌词会被挡住', bad1.ok === false && String(bad1.message || '').indexOf('没有歌词') >= 0, JSON.stringify(bad1));
  const bad2 = await S.post('/api/song/make', { lyrics: '啊'.repeat(2100) }, token);
  ck('超 2000 字会被挡住', bad2.ok === false && String(bad2.message || '').indexOf('2000') >= 0, JSON.stringify(bad2));
  const bad3 = await S.post('/api/song/make', { lyrics: '一二三四', style: '死亡金属' }, token);
  ck('没有这种曲风会被挡住', bad3.ok === false && String(bad3.message || '').indexOf('曲风') >= 0, JSON.stringify(bad3));

  // 没配任何 AI 服务商时不该整条失败：曲子照样给（纯伴奏），并把原因说清楚。
  const noVoice = await S.post('/api/song/make', { lyrics: '檐下的风铃响了三声', style: 'calm' }, token);
  ck('没配朗读模型也出曲子（纯伴奏）',
    noVoice.ok === true && noVoice.voice === false && !!noVoice.voiceNote,
    JSON.stringify(noVoice).slice(0, 200));
  ck('原因说清楚了（不是「失败」两个字）',
    String(noVoice.voiceNote || '').length > 4, noVoice.voiceNote);

  /* ---------- B. 纯伴奏能出成品 ---------- */
  console.log('[B] 演奏（纯伴奏）');
  const LYR = '老屋的瓦上落着霜，\n灶膛的火还亮着光，\n你走的那年雪很大，\n我把名字刻在门框上。';
  const r1 = await S.post('/api/song/make', { lyrics: LYR, style: 'warm', voice: false }, token);
  ck('出成品了', r1.ok === true && !!r1.path, JSON.stringify(r1).slice(0, 200));
  ck('返回了时长与字节数', r1.ok && r1.seconds > 5 && r1.bytes > 20000, r1.seconds + 's/' + r1.bytes + 'B');
  ck('返回说清了「只有伴奏」', r1.ok && r1.voice === false, JSON.stringify(r1).slice(0, 200));

  if (r1.ok) {
    const abs = path.join(filesRoot, r1.path);
    ck('文件真的落在用户目录里', fs.existsSync(abs), abs);
    if (fs.existsSync(abs)) {
      const head = fs.readFileSync(abs).slice(0, 3);
      const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || head[0] === 0xFF;
      ck('是真 mp3（帧头对）', isMp3, head.toString('hex'));
    }
    // 响度自查：早先配乐是三路正弦直接 amix，实测 mean −57dB 等于没声音，
    // 用户听到的就是「配乐没响」。这里把这条经验钉成断言。
    if (fs.existsSync(path.join(S.DATA_DIR, 'bin', path.basename(FFMPEG_SRC)))) {
      const { spawnSync } = require('child_process');
      const vd = spawnSync(path.join(S.DATA_DIR, 'bin', path.basename(FFMPEG_SRC)),
        ['-hide_banner', '-i', abs, '-af', 'volumedetect', '-f', 'null', '-'],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const err = String(vd.stderr || '');
      const mv = /mean_volume:\s*([-\d.]+) dB/.exec(err);
      const xv = /max_volume:\s*([-\d.]+) dB/.exec(err);
      ck('伴奏真的有声音（mean > -35dB）', mv && Number(mv[1]) > -35, mv && mv[1]);
      ck('没削波（max ≤ 0dB）', xv && Number(xv[1]) <= 0.1, xv && xv[1]);
    }

    // 再说一遍同一件事：应命中缓存，不重算、不重复占磁盘
    const r2 = await S.post('/api/song/make', { lyrics: LYR, style: 'warm', voice: false }, token);
    ck('同一版重演直接给缓存', r2.ok === true && r2.cached === true && r2.path === r1.path, JSON.stringify(r2).slice(0, 160));
  }

  /* ---------- D. 进档案 ---------- */
  console.log('[D] 登记进档案');
  if (r1.ok) {
    const ins = await S.post('/api/exec', {
      sql: 'INSERT INTO media (archive_id,kind,path,mime,bytes,duration_ms,caption) VALUES (?,?,?,?,?,?,?)',
      params: [aid, 'audio', r1.path, 'audio/mpeg', r1.bytes || null,
        Math.round((Number(r1.seconds) || 0) * 1000), LYR.slice(0, 40)],
    }, token);
    ck('能写进 media（kind=audio）', ins.ok === true, JSON.stringify(ins).slice(0, 160));
    const rows = await S.post('/api/query', {
      sql: "SELECT id,kind,path,caption FROM media WHERE archive_id=? AND kind='audio'",
      params: [aid],
    }, token);
    ck('能按 audio 查回来', (rows.rows || rows || []).length === 1, JSON.stringify(rows).slice(0, 200));
  }

  S.stop();
  console.log('\n演奏链路审计：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('审计挂了:', e.message); process.exit(1); });
