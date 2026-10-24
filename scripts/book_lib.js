#!/usr/bin/env node
/* 蒋介石样本：图书渲染公共库（被 render_sample_book.js / preview_sample.js 复用） */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE_DB = path.join(DATA, 'users', '1', 'archive.db');
const EXPORTS = path.join(DATA, 'users', '1', 'files', 'exports');

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
function runProc(bin, args, timeoutMs, opts) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: (opts && opts.cwd) || undefined });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('超时')); }, timeoutMs || 120000);
    p.stderr.on('data', c => { err += String(c); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(true) : reject(new Error('退出码 ' + code + '：' + err.slice(0, 200))); });
  });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadData() {
  const d = new DatabaseSync(ARCHIVE_DB);
  d.exec('PRAGMA foreign_keys = ON');
  const arc = d.prepare('SELECT * FROM archives WHERE id=1').get();
  const chapters = d.prepare('SELECT * FROM chapters WHERE archive_id=1 ORDER BY seq').all();
  for (const ch of chapters) {
    ch.entries = d.prepare('SELECT * FROM entries WHERE archive_id=1 AND chapter_id=? ORDER BY seq').all(ch.id);
  }
  d.close();
  return { arc, chapters };
}

const CSS = `
  @page { size: A4; margin: 16mm 14mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",serif; color:#2b2620; line-height:1.9; }
  .cover { height: 265mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center;
           background: radial-gradient(circle at 50% 30%, #fbf6ec 0%, #f3e9d6 70%, #e9dcc2 100%); page-break-after: always; position:relative; }
  .cover .seal { position:absolute; top:22mm; right:22mm; width:34mm; height:34mm; border:2.2mm solid #9e2b25; border-radius:6mm;
                 color:#9e2b25; font-size:5.2mm; font-weight:700; display:flex; align-items:center; justify-content:center; letter-spacing:2px; transform:rotate(-6deg); opacity:.85; }
  .cover .kicker { font-size:5mm; letter-spacing:8px; color:#9e2b25; margin-bottom:10mm; }
  .cover h1 { font-size:30mm; margin:0; letter-spacing:6px; color:#2b2620; }
  .cover .dates { font-size:7mm; margin-top:8mm; color:#5a4f40; }
  .cover .home { font-size:5mm; margin-top:5mm; color:#7a6c55; letter-spacing:3px; }
  .cover .deco { width:60mm; height:1px; background:#9e2b25; margin:12mm 0 0; opacity:.6; }
  .cover .sub { font-size:4mm; margin-top:6mm; color:#8a7a60; letter-spacing:4px; }
  .intro { page-break-after: always; }
  .intro h2, .timeline h2, .chapter h2 { color:#9e2b25; border-bottom:1px solid #d9c7a6; padding-bottom:2mm; }
  .intro .bio { font-size:4.4mm; text-indent:2em; margin:5mm 0; }
  table.facts { width:100%; border-collapse:collapse; margin-top:6mm; font-size:3.9mm; }
  table.facts th { text-align:right; color:#9e2b25; padding:2mm 4mm 2mm 0; width:28%; vertical-align:top; border-bottom:1px dashed #e0d2b6; }
  table.facts td { padding:2mm 0; border-bottom:1px dashed #e0d2b6; }
  .timeline .tl-item { display:flex; gap:6mm; padding:2mm 0; border-left:2px solid #d9c7a6; margin-left:3mm; padding-left:6mm; position:relative; }
  .timeline .tl-item:before { content:""; position:absolute; left:-5px; top:8mm; width:8px; height:8px; background:#9e2b25; border-radius:50%; }
  .timeline .tl-year { font-weight:700; color:#9e2b25; width:20mm; flex:none; }
  .timeline .tl-text { font-size:3.7mm; color:#4a4034; }
  .chapter { page-break-before: always; }
  .ch-head { text-align:center; margin-bottom:8mm; }
  .ch-no { font-size:3.6mm; color:#9e2b25; letter-spacing:4px; }
  .ch-title { font-size:8mm; margin:2mm 0; letter-spacing:2px; }
  .ch-meta { font-size:3.6mm; color:#7a6c55; }
  .ch-stage { background:#9e2b25; color:#fff; padding:1mm 3mm; border-radius:3mm; margin-right:3mm; }
  .ch-summary { font-size:4.2mm; color:#5a4f40; text-indent:2em; background:#f7efdd; padding:4mm; border-radius:3mm; }
  .ch-quote { border-left:4px solid #9e2b25; margin:6mm 0; padding:2mm 0 2mm 6mm; font-style:italic; color:#6a5d47; font-size:4.4mm; }
  .entry { font-size:4mm; text-indent:2em; margin:3mm 0; }
  .e-year { display:inline-block; color:#9e2b25; font-weight:700; margin-right:2mm; text-indent:0; }
  @media print { .chapter { page-break-before: always; } }
`;

function buildHtml({ arc, chapters }) {
  const facts = (() => { try { return JSON.parse(arc.facts_json || '{}'); } catch (e) { return {}; } })();
  const factRows = Object.keys(facts).map(k => `<tr><th>${esc(k)}</th><td>${esc(facts[k])}</td></tr>`).join('');
  const tl = [];
  for (const ch of chapters) for (const en of ch.entries) if (en.at_year) tl.push({ y: en.at_year, t: en.text });
  tl.sort((a, b) => a.y - b.y);
  const timelineHtml = tl.map(it => `<div class="tl-item"><div class="tl-year">${esc(it.y)}</div><div class="tl-text">${esc(it.t)}</div></div>`).join('');
  const chapterHtml = chapters.map(ch => {
    const entries = ch.entries.map(en => `<p class="entry"><span class="e-year">${esc(en.at_year || '')}</span>${esc(en.text)}</p>`).join('');
    return `<section class="chapter"><div class="ch-head"><div class="ch-no">第 ${esc(ch.seq)} 章</div>`
      + `<h2 class="ch-title">${esc(ch.title)}</h2>`
      + `<div class="ch-meta"><span class="ch-stage">${esc(ch.stage || '')}</span><span class="ch-range">${esc(ch.year_from)} — ${esc(ch.year_to)}</span></div></div>`
      + (ch.summary ? `<p class="ch-summary">${esc(ch.summary)}</p>` : '')
      + (ch.quote ? `<blockquote class="ch-quote">${esc(ch.quote)}</blockquote>` : '')
      + `<div class="ch-entries">${entries}</div></section>`;
  }).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>`
    + `<div class="cover"><div class="seal">样本档案</div><div class="kicker">人 生 档 案</div>`
    + `<h1>${esc(arc.subject_name)}</h1><div class="dates">${esc(arc.birth_year)} — ${esc(arc.death_year)}</div>`
    + `<div class="home">${esc(arc.hometown)}人</div><div class="deco"></div>`
    + `<div class="sub">我的人生档案 · 历史人物样本</div></div>`
    + `<div class="intro"><h2>人物小传</h2><p class="bio">${esc(arc.intro)}</p>`
    + `<table class="facts">${factRows}</table></div>`
    + `<div class="timeline"><h2>生平年表</h2>${timelineHtml}</div>`
    + chapterHtml + `</body></html>`;
}

module.exports = { ROOT, DATA, ARCHIVE_DB, EXPORTS, findChrome, runProc, esc, loadData, buildHtml };
