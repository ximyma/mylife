#!/usr/bin/env node
/* v0.9.19 审计：翻书预览 + 数据自检接口 + 版本一致性 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, failN = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failN++; console.log('  ✗ ' + name + (extra ? '  << ' + String(extra).slice(0, 120) : '')); }
}

const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('== 翻书预览（BookFlip）==');
const bk = rd('web/book.js');
ok(bk.indexOf('window.BookFlip') > 0, 'book.js 暴露 window.BookFlip');
ok(/\bopen:\s*open\b/.test(bk), 'BookFlip.open 入口存在');
ok(bk.indexOf('rotateY') > 0, '3D 翻页动画（rotateY）');
ok(bk.indexOf('buildPages') > 0, '分页函数 buildPages 存在');
ok(bk.indexOf('paginateBlocks') > 0, '按测量高度分页 paginateBlocks 存在');
ok(bk.indexOf("addEventListener('keydown'") > 0, '键盘翻页（方向键）');
ok(/=>/.test(bk) === false && /`/.test(bk) === false, 'book.js 纯 ES5（无箭头函数/模板串）');

const idxHtml = rd('web/index.html');
ok(/<script src="book\.js">/.test(idxHtml), 'index.html 引入 book.js（export.js 之后）');
ok(idxHtml.indexOf('export.js') < idxHtml.indexOf('book.js'), 'book.js 在 export.js 之后加载');

const app = rd('web/app.js');
ok(app.indexOf("data-pv=\"flip\"") > 0, '成书预览有「翻书看」按钮');
ok(app.indexOf("data-wb=\"flip\"") > 0, '看整本弹层有「翻书看」入口');
ok(app.indexOf('BookFlip.open') > 0, 'app.js 调用 BookFlip.open');
ok(app.indexOf('lastPreview') > 0, '预览图缓存复用（lastPreview）');

const css = rd('web/style.css');
ok(css.indexOf('.bk-leaf') > 0, '翻书样式（bk-leaf）');
ok(css.indexOf('.bk-single') > 0, '窄屏单页模式样式（bk-single）');
ok(css.indexOf('backface-visibility') > 0, '翻页背面隐藏（backface-visibility）');

console.log('== 数据自检接口（P1 修复）==');
const srv = rd('server/server.js');
ok(srv.indexOf("'/api/debug/data'") > 0, 'server 路由注册 /api/debug/data');
ok(srv.indexOf('function apiDebugData') > 0, 'apiDebugData 实现');
ok(/apiDebugData\(\)/.test(srv), 'apiDebugData 无参调用');
ok(srv.indexOf("quick_notes: count('quick_notes')") > 0, '自检含 quick_notes 计数');
ok(srv.indexOf('mediaFiles') > 0 && srv.indexOf('mediaBytes') > 0, '自检含媒体文件数与体积');

console.log('== 版本一致性 ==');
ok(app.indexOf("APP_VERSION = 'v0.9.19'") > 0, 'web/app.js v0.9.19');
ok(/VERSION\s*=\s*'v0\.9\.19'/.test(srv), 'server/server.js v0.9.19');
const gradle = rd('android/app/build.gradle');
ok(gradle.indexOf('versionCode 34') > 0, 'versionCode 34');
ok(gradle.indexOf('versionName "0.9.19"') > 0, 'versionName 0.9.19');

console.log('== 小程序同步（v0.9.19）==');
const MP = 'D:/works/mystory/mylife-mp/';
const mpjs = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
ok(mpjs('utils/store.js').indexOf('bigCls') > 0, 'mp store.bigCls');
ok(mpjs('pages/settings/settings.wxml').indexOf('bigFont') > 0, 'mp 设置页大字三档');
ok(mpjs('app.wxss').indexOf('.bf1 .en-text') > 0, 'mp 大字样式规则');
ok(mpjs('pages/archive/archive.wxml').indexOf('makeShareCard') > 0, 'mp 档案页分享卡片按钮');
ok(mpjs('pages/archive/archive.js').indexOf('saveImageToPhotosAlbum') > 0, 'mp 卡片存相册');
let rootCls = 0;
['index','archive','chat','edit','inbox','interview','promise','settings'].forEach((p) => {
  if (mpjs('pages/' + p + '/' + p + '.wxml').indexOf('{{bigCls}}') > 0) rootCls++;
});
ok(rootCls === 8, 'mp 8 个页面根节点挂 bigCls（实际 ' + rootCls + '）');

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + failN) + (failN ? '  <<<< 有失败项' : '  全部通过'));
process.exit(failN ? 1 : 0);
