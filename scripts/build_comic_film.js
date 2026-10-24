#!/usr/bin/env node
/* 蒋介石样本 —— 漫画（SVG 分格 → 漫画 PDF）+ 短片（镜头卡 PNG → ffmpeg 合成 MP4）
 * 与 app 内置管线同一机制：
 *   漫画：SVG 分格 + 气泡 → Chrome 打印 PDF
 *   短片：分格图 → ffmpeg zoompan（Ken Burns）→ concat → ASS 字幕 + 三音和弦垫乐 → mp4
 * 运行：node --experimental-sqlite scripts/build_comic_film.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EXPORTS, findChrome, runProc, loadData } = require('./book_lib');

const FFMPEG = path.join(__dirname, '..', 'data', 'bin', 'ffmpeg.exe');
const W = 1920, H = 1080, FPS = 25, SEC = 4;

/* ---------- 通用：水墨风 SVG 场景母题 ---------- */
const PALETTES = {
  ink:   { bg1: '#f6f1e4', bg2: '#e7dcc4', fg: '#3a332a', accent: '#9e2b25' },
  dusk:  { bg1: '#f2e9d8', bg2: '#ddc9a8', fg: '#403428', accent: '#8a2f22' },
  night: { bg1: '#e8e2d2', bg2: '#c9c0aa', fg: '#2e2a22', accent: '#7c2820' }
};

function svgMountains(p, x, y, w, h, tone) {
  const pts = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const px = x + (w / n) * i;
    const py = y + h - (i % 2 === 0 ? h * 0.55 : h * 0.25) - (i === Math.floor(n / 2) ? h * 0.2 : 0);
    pts.push(px + ',' + py);
  }
  pts.push((x + w) + ',' + (y + h)); pts.push(x + ',' + (y + h));
  return '<polygon points="' + pts.join(' ') + '" fill="' + tone + '" opacity="0.55"/>';
}
function svgWaves(p, x, y, w, h, tone) {
  let s = '';
  for (let r = 0; r < 3; r++) {
    const yy = y + h * (0.2 + r * 0.28);
    let d = 'M ' + x + ' ' + yy;
    for (let i = 0; i < 8; i++) {
      const seg = w / 8;
      d += ' q ' + seg / 2 + ' ' + (r % 2 === 0 ? -14 : 14) + ' ' + seg + ' 0';
    }
    s += '<path d="' + d + '" stroke="' + tone + '" stroke-width="6" fill="none" opacity="' + (0.7 - r * 0.18) + '"/>';
  }
  return s;
}
function svgSun(p, cx, cy, r, tone) {
  return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + tone + '" opacity="0.75"/>'
    + '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 1.35) + '" fill="none" stroke="' + tone + '" stroke-width="3" opacity="0.3"/>';
}
function svgFlag(p, x, y, w, h, tone) {
  return '<line x1="' + x + '" y1="' + y + '" x2="' + x + '" y2="' + (y + h) + '" stroke="' + tone + '" stroke-width="7"/>'
    + '<path d="M ' + x + ' ' + y + ' q ' + (w * 0.45) + ' ' + (h * 0.12) + ' ' + w + ' 0 l -' + (w * 0.12) + ' ' + (h * 0.26) + ' l ' + (w * 0.12) + ' ' + (h * 0.26) + ' q -' + (w * 0.45) + ' ' + (h * 0.12) + ' -' + w + ' 0 z" fill="' + tone + '" opacity="0.8"/>';
}
function svgWall(p, x, y, w, tone) {
  let s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="26" fill="' + tone + '" opacity="0.75"/>';
  for (let i = 0; i < Math.floor(w / 60); i++) {
    s += '<rect x="' + (x + i * 60) + '" y="' + (y - 16) + '" width="30" height="16" fill="' + tone + '" opacity="0.75"/>';
  }
  return s;
}
function svgBoat(p, x, y, tone) {
  return '<path d="M ' + x + ' ' + y + ' l 70 0 l -18 34 l -34 0 z" fill="' + tone + '" opacity="0.85"/>'
    + '<line x1="' + (x + 35) + '" y1="' + y + '" x2="' + (x + 35) + '" y2="' + (y - 64) + '" stroke="' + tone + '" stroke-width="5"/>'
    + '<path d="M ' + (x + 35) + ' ' + (y - 64) + ' q 34 18 0 52 z" fill="' + tone + '" opacity="0.7"/>';
}
function svgClouds(p, x, y, tone) {
  return '<ellipse cx="' + x + '" cy="' + y + '" rx="90" ry="22" fill="' + tone + '" opacity="0.35"/>'
    + '<ellipse cx="' + (x + 110) + '" cy="' + (y + 14) + '" rx="70" ry="18" fill="' + tone + '" opacity="0.28"/>';
}

/* 每章一个视觉母题组合 */
function sceneSvg(chIdx, pw, ph, p) {
  const midY = ph * 0.42;
  switch (chIdx) {
    case 0: return svgSun(p, pw * 0.72, ph * 0.2, pw * 0.07, p.accent) + svgMountains(p, 0, midY, pw, ph * 0.4, p.fg) + svgClouds(p, pw * 0.2, ph * 0.14, p.fg);
    case 1: return svgWaves(p, 0, midY, pw, ph * 0.42, p.fg) + svgSun(p, pw * 0.25, ph * 0.2, pw * 0.06, p.accent) + svgBoat(p, pw * 0.62, midY + 18, p.fg);
    case 2: return svgFlag(p, pw * 0.14, ph * 0.1, pw * 0.3, ph * 0.55, p.accent) + svgMountains(p, 0, midY + 40, pw, ph * 0.32, p.fg);
    case 3: return svgClouds(p, pw * 0.62, ph * 0.16, p.fg) + svgClouds(p, pw * 0.2, ph * 0.24, p.fg) + svgWall(p, 0, midY + 70, pw, p.fg) + svgSun(p, pw * 0.82, ph * 0.22, pw * 0.05, p.accent);
    case 4: return svgWall(p, 0, midY + 30, pw, p.fg) + svgSun(p, pw * 0.3, ph * 0.18, pw * 0.06, p.accent) + svgClouds(p, pw * 0.72, ph * 0.2, p.fg);
    case 5: return svgWaves(p, 0, midY + 20, pw, ph * 0.4, p.fg) + svgBoat(p, pw * 0.4, midY + 6, p.fg) + svgSun(p, pw * 0.78, ph * 0.24, pw * 0.07, p.accent);
  }
  return '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function truncate(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------- 漫画：A4 分格页（每页 1 章 4 格 + 气泡） ---------- */
function comicPageHtml(ch, chIdx, p) {
  const pw = 340, ph = 220; // 每格 SVG 尺寸
  const panels = ch.entries.slice(0, 4).map((en, i) => {
    const body = truncate(en.text, 46).replace(new RegExp('^' + en.at_year + '\\s*年?'), '');
    return `
    <div class="panel">
      <svg viewBox="0 0 ${pw} ${ph}" width="100%">
        <rect x="0" y="0" width="${pw}" height="${ph}" fill="url(#bg${chIdx})"/>
        ${sceneSvg(chIdx, pw, ph, p)}
      </svg>
      <div class="cap"><span class="yr">${esc(en.at_year)}</span>${esc(body)}</div>
    </div>`; }).join('');
  const bubble = ch.quote ? `<div class="bubble">${esc(truncate(ch.quote, 40))}</div>` : '';
  return `
  <div class="page">
    <div class="p-head"><span class="p-no">第 ${esc(ch.seq)} 格章</span><span class="p-title">${esc(ch.title)}</span><span class="p-stage">${esc(ch.stage || '')}</span></div>
    ${bubble}
    <div class="grid">${panels}</div>
    <div class="p-foot">我的人生档案 · ${esc('蒋介石')} · 漫画样本</div>
  </div>`;
}

function buildComicHtml(data) {
  const pages = data.chapters.map((ch, i) => comicPageHtml(ch, i, PALETTES.ink)).join('');
  const gradDefs = data.chapters.map((ch, i) =>
    `<linearGradient id="bg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f1e4"/><stop offset="1" stop-color="#e7dcc4"/></linearGradient>`
  ).join('');
  const cover = `
  <div class="page cover-page">
    <div class="c-kick">人 生 档 案 · 漫 画 样 本</div>
    <h1>${esc(data.arc.subject_name)}</h1>
    <div class="c-dates">${esc(data.arc.birth_year)} — ${esc(data.arc.death_year)}</div>
    <div class="c-sub">六幕 · 水墨分镜 · ${data.chapters.length} 章人生</div>
  </div>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",serif; color:#2b2620; }
  .page { page-break-after: always; background:#fbf7ee; padding:8mm; border:1px solid #d9c7a6; }
  .cover-page { height:250mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; background:radial-gradient(circle at 50% 35%, #fbf6ec, #e9dcc2); }
  .c-kick { letter-spacing:8px; color:#9e2b25; font-size:5mm; margin-bottom:10mm; }
  .cover-page h1 { font-size:26mm; margin:0; letter-spacing:5px; }
  .c-dates { font-size:6mm; margin-top:7mm; color:#5a4f40; }
  .c-sub { font-size:4mm; margin-top:10mm; color:#8a7a60; letter-spacing:3px; }
  .p-head { display:flex; align-items:baseline; gap:4mm; border-bottom:1px solid #d9c7a6; padding-bottom:2mm; margin-bottom:4mm; }
  .p-no { color:#9e2b25; font-size:3.6mm; letter-spacing:2px; }
  .p-title { font-size:5.5mm; font-weight:700; flex:1; }
  .p-stage { background:#9e2b25; color:#fff; padding:1mm 3mm; border-radius:3mm; font-size:3.4mm; }
  .bubble { background:#fff; border:2px solid #9e2b25; border-radius:6mm; padding:2mm 4mm; margin:0 0 4mm 30%; font-size:3.8mm; position:relative; }
  .bubble:before { content:""; position:absolute; left:-4mm; top:5mm; border:4mm solid transparent; border-right-color:#9e2b25; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:4mm; }
  .panel { border:2px solid #3a332a; background:#fff; }
  .panel svg { display:block; }
  .cap { padding:2.4mm 3mm; font-size:3.5mm; line-height:1.6; background:#fffdf8; border-top:1px dashed #c9b48c; }
  .cap .yr { color:#9e2b25; font-weight:700; margin-right:2mm; }
  .p-foot { text-align:center; font-size:3.2mm; color:#8a7a60; margin-top:4mm; letter-spacing:2px; }
  </style></head><body><svg width="0" height="0" style="position:absolute"><defs>${gradDefs}</defs></svg>${cover}${pages}</body></html>`;
}

/* ---------- 短片：镜头卡 PNG + ffmpeg 合成 ---------- */
function frameHtml(it, idx, total, ch) {
  const p = PALETTES.ink;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; overflow:hidden; font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",serif; }
  .frame { width:${W}px; height:${H}px; position:relative; background:radial-gradient(circle at 50% 38%, #fbf6ec, #e9dcc2); display:flex; flex-direction:column; justify-content:center; }
  .scene { position:absolute; inset:0; opacity:.5; }
  .year { text-align:center; color:${p.accent}; font-size:120px; letter-spacing:14px; font-weight:700; }
  .stage { text-align:center; color:${p.fg}; font-size:34px; letter-spacing:10px; margin-top:10px; opacity:.8; }
  .text { text-align:center; color:${p.fg}; font-size:40px; line-height:1.9; max-width:1300px; margin:56px auto 0; }
  .foot { position:absolute; bottom:46px; left:0; right:0; text-align:center; color:#8a7a60; font-size:22px; letter-spacing:6px; }
  .bar { position:absolute; left:0; right:0; top:0; height:14px; background:${p.accent}; opacity:.85; }
  .bar2 { position:absolute; left:0; right:0; bottom:0; height:14px; background:${p.accent}; opacity:.85; }
  .no { position:absolute; top:40px; right:60px; color:${p.fg}; opacity:.5; font-size:26px; letter-spacing:3px; }
  </style></head><body><div class="frame">
  <svg class="scene" viewBox="0 0 ${W} ${H}">${sceneSvg(idx % 6, W, H, p)}</svg>
  <div class="bar"></div><div class="bar2"></div><div class="no">${idx + 1} / ${total}</div>
  <div class="year">${esc(it.year || '')}</div>
  <div class="stage">${esc(ch.stage || '')} · ${esc(ch.title || '')}</div>
  <div class="text">${esc(truncate(it.text, 52))}</div>
  <div class="foot">我的人生档案 · 蒋介石 · 短片样本</div>
  </div></body></html>`;
}

async function renderFrames(data, dir) {
  const frames = [];
  let idx = 0;
  for (const ch of data.chapters) {
    for (const en of ch.entries.slice(0, 3)) {
      frames.push({ year: en.at_year, text: en.text, ch });
      idx++;
    }
  }
  const total = frames.length;
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome');
  for (let i = 0; i < total; i++) {
    const f = frames[i];
    const hp = path.join(dir, 'f' + i + '.html');
    fs.writeFileSync(hp, frameHtml(f, i, total, f.ch), 'utf8');
    await runProc(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--window-size=' + W + ',' + H, '--screenshot=' + path.join(dir, 'f' + i + '.png'),
      'file:///' + hp.replace(/\\/g, '/')
    ], 60000);
    fs.unlinkSync(hp);
    process.stdout.write('  镜头 ' + (i + 1) + '/' + total + '\r\n');
  }
  return frames;
}

function buildAss(frames) {
  function ts(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60);
    return h + ':' + String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  }
  let evts = '';
  frames.forEach((f, i) => {
    const start = i * SEC, end = start + SEC - 0.2;
    const txt = f.year + '年 · ' + truncate(f.text, 30).replace(/\n/g, ' ');
    evts += 'Dialogue: 0,' + ts(start) + ',' + ts(end) + ',Sub,,0,0,0,,{\\fad(240,240)}' + txt + '\n';
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Noto Serif CJK SC,54,&H00FFFFFF,&H000000FF,&H77000000,&H96000000,0,0,0,0,100,100,0,0,1,3,2,2,60,60,130,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${evts}`;
}

function runFfmpeg(args, what, timeout, cwd) {
  return runProc(FFMPEG, ['-hide_banner', '-loglevel', 'error'].concat(args), timeout, { cwd: cwd || undefined });
}

async function buildFilm(frames, dir, outMp4) {
  const segs = [];
  for (let i = 0; i < frames.length; i++) {
    const seg = path.join(dir, 's' + i + '.mp4');
    await runFfmpeg([
      '-loop', '1', '-i', path.join(dir, 'f' + i + '.png'),
      '-filter_complex', "[0:v]scale=2400:-2,zoompan=z='min(zoom+0.0009,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=" + (SEC * FPS) + ":s=" + W + "x" + H + ":fps=" + FPS + ",format=yuv420p[v]",
      '-map', '[v]', '-t', String(SEC),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', String(FPS),
      '-y', seg
    ], '镜头 ' + (i + 1), 120000, dir);
    segs.push(seg);
  }
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, segs.map(s => "file '" + s.replace(/\\/g, '/') + "'").join('\n') + '\n', 'utf8');
  const joined = path.join(dir, 'joined.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', joined], '拼接', 180000, dir);

  // 字幕 + 三音和弦垫乐（与 app 相同配方）
  const assPath = path.join(dir, 'subs.ass');
  fs.writeFileSync(assPath, buildAss(frames), 'utf8');
  const totalSec = frames.length * SEC;
  const args = ['-i', joined];
  const ch3 = [196, 247, 294];
  ch3.forEach(hz => args.push('-f', 'lavfi', '-i', 'sine=frequency=' + hz + ':duration=' + Math.ceil(totalSec + 1)));
  let fc = '[0:v]ass=subs.ass[v]';
  fc += ';[1:a][2:a][3:a]amix=inputs=3:duration=first,volume=0.09,tremolo=f=0.14:d=0.35[a]';
  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '-shortest', '-y', outMp4);
  await runFfmpeg(args, '合成', 600000, dir);
  // 清理中间产物
  for (const s of segs) { try { fs.unlinkSync(s); } catch (e) {} }
  try { fs.unlinkSync(listFile); } catch (e) {}
  try { fs.unlinkSync(joined); } catch (e) {}
  try { fs.unlinkSync(assPath); } catch (e) {}
}

/* ---------- 主流程 ---------- */
async function main() {
  const data = loadData();
  fs.mkdirSync(EXPORTS, { recursive: true });
  const work = path.join(EXPORTS, '__sample_work');
  fs.mkdirSync(work, { recursive: true });

  // 1. 漫画 PDF
  console.log('[1/3] 生成漫画 PDF ...');
  const comicHtml = buildComicHtml(data);
  const comicHtmlPath = path.join(work, 'comic.html');
  fs.writeFileSync(comicHtmlPath, comicHtml, 'utf8');
  const comicPdf = path.join(EXPORTS, '蒋介石人生漫画.pdf');
  await runProc(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--virtual-time-budget=12000', '--print-to-pdf=' + comicPdf,
    'file:///' + comicHtmlPath.replace(/\\/g, '/')
  ], 120000);
  console.log('  漫画 PDF：' + comicPdf + ' (' + Math.round(fs.statSync(comicPdf).size / 1024) + ' KB)');

  // 2. 镜头卡 PNG
  console.log('[2/3] 渲染短片镜头卡 ...');
  const frames = await renderFrames(data, work);

  // 3. ffmpeg 合成短片
  console.log('[3/3] ffmpeg 合成短片 ...');
  const filmMp4 = path.join(EXPORTS, '蒋介石人生短片.mp4');
  await buildFilm(frames, work, filmMp4);
  console.log('  短片 MP4：' + filmMp4 + ' (' + Math.round(fs.statSync(filmMp4).size / 1024) + ' KB, ' + (frames.length * SEC) + ' 秒)');

  // 清理工作目录
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  console.log('完成。');
}
module.exports = { buildComicHtml, frameHtml, renderFrames, buildFilm };
if (require.main === module) {
  main().catch(e => { console.error('失败：', e.message); process.exit(1); });
}
