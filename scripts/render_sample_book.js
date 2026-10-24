#!/usr/bin/env node
/* 蒋介石人生档案样本 —— 一键导出精美 PDF（复用 book_lib） */
'use strict';
const fs = require('fs');
const path = require('path');
const { ARCHIVE_DB, EXPORTS, findChrome, runProc, loadData, buildHtml } = require('./book_lib');

async function main() {
  if (!fs.existsSync(ARCHIVE_DB)) { console.error('找不到 archive.db，请先运行 build_jiang_sample.js'); process.exit(1); }
  const data = loadData();
  const html = buildHtml(data);
  fs.mkdirSync(EXPORTS, { recursive: true });
  const tmp = path.join(EXPORTS, '__book_' + Date.now() + '.html');
  fs.writeFileSync(tmp, html, 'utf8');

  const chrome = findChrome();
  if (!chrome) { console.error('未找到 Chrome，无法生成 PDF'); fs.unlinkSync(tmp); process.exit(2); }
  const outPdf = path.join(EXPORTS, '蒋介石人生档案.pdf');
  await runProc(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--virtual-time-budget=12000', '--print-to-pdf=' + outPdf,
    'file:///' + tmp.replace(/\\/g, '/')
  ], 120000);
  fs.unlinkSync(tmp);
  const bytes = fs.statSync(outPdf).size;
  console.log('PDF 已生成：' + outPdf + '  (' + (bytes / 1024).toFixed(0) + ' KB)');
}
main().catch(e => { console.error('失败：', e.message); process.exit(1); });
