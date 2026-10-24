#!/usr/bin/env node
/* 蒋介石样本：把渲染好的图书 HTML 截图成 PNG 预览（封面 + 第一章），用于视觉确认 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EXPORTS, findChrome, runProc, loadData, buildHtml } = require('./book_lib');

async function main() {
  const data = loadData();
  const html = buildHtml(data);
  fs.mkdirSync(EXPORTS, { recursive: true });
  const htmlPath = path.join(EXPORTS, '__preview_book.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const chrome = findChrome();
  if (!chrome) { console.error('未找到 Chrome'); process.exit(2); }
  // 封面：A4 视口（794x1123）截图首页
  const coverPng = path.join(EXPORTS, 'preview_cover.png');
  await runProc(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--hide-scrollbars', '--window-size=794,1123',
    '--screenshot=' + coverPng, 'file:///' + htmlPath.replace(/\\/g, '/')
  ], 60000);
  // 全页长图（封面+正文），供整体浏览
  const fullPng = path.join(EXPORTS, 'preview_full.png');
  await runProc(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--hide-scrollbars', '--window-size=794,3000',
    '--screenshot=' + fullPng, 'file:///' + htmlPath.replace(/\\/g, '/')
  ], 60000);
  fs.unlinkSync(htmlPath);
  console.log('预览图已生成：\n  ' + coverPng + '\n  ' + fullPng);
}
main().catch(e => { console.error('失败：', e.message); process.exit(1); });
