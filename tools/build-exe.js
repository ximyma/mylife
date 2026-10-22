/**
 * 把网页端打成 Windows 单文件 EXE（Node 官方 SEA，不需要第三方打包器）。
 *
 * 产出 dist/win/：
 *   MyLife.exe          单文件，双击即用（内含 Node 运行时 + server.js）
 *   resources/web/      前端
 *   resources/schema.sql
 *   data/               运行时才生成（数据库、素材）
 *
 * 用法： node tools/build-exe.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'win');
const TMP = path.join(ROOT, 'tmp', 'sea');

const NODE_BIN = process.execPath;                       // 用当前这个 node 打包，版本一定一致
const WORKSPACE = 'C:/Users/ximym/.workbuddy/binaries/node/workspace';

function step(n, msg) { console.log('\n[' + n + '] ' + msg); }

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* ---- 1. SEA 配置 ---- */
step(1, '生成 sea 配置');
const cfg = path.join(TMP, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: path.join(ROOT, 'server', 'server.js'),
  output: path.join(TMP, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {},            // schema.sql / web/ 作为普通文件放在 exe 旁边，不塞进 blob，方便改界面不用重打包
}, null, 2));

execFileSync(NODE_BIN, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
console.log('  blob: ' + fs.statSync(path.join(TMP, 'sea-prep.blob')).size + ' bytes');

/* ---- 2. 复制 node.exe 做骨架 ---- */
step(2, '以 node.exe 为骨架');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
const exe = path.join(OUT, 'MyLife.exe');
fs.copyFileSync(NODE_BIN, exe);
console.log('  ' + exe);

/* ---- 3. 注入 blob ---- */
step(3, '注入应用');
const postject = path.join(WORKSPACE, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postject)) {
  console.error('缺 postject。先装：');
  console.error('  cd ' + WORKSPACE + ' && npm install postject');
  process.exit(1);
}
// fuse 串随 Node 版本变，写死会翻车（Node 22.22 实际值就和文档里的示例不同），
// 直接从 node.exe 二进制里捞，换版本也不需要改脚本。
const buf = fs.readFileSync(NODE_BIN);
const m = /NODE_SEA_FUSE_[0-9a-f]{32}/.exec(buf.toString('latin1'));
if (!m) {
  console.error('这个 node.exe 里找不到 SEA fuse，不支持单文件打包。');
  process.exit(1);
}
const fuse = m[0];
console.log('  fuse: ' + fuse);
execFileSync(NODE_BIN, [postject, exe, 'NODE_SEA_BLOB', path.join(TMP, 'sea-prep.blob'),
  '--sentinel-fuse', fuse], { stdio: 'inherit' });

/* ---- 4. 外置资源 ---- */
step(4, '复制前端资源');
function cp(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}
const WEB_SRC = path.join(ROOT, 'web');
const WEB_DST = path.join(OUT, 'resources', 'web');
cp(WEB_SRC, WEB_DST);
let webBytes = 0;
for (const f of fs.readdirSync(WEB_DST)) webBytes += fs.statSync(path.join(WEB_DST, f)).size;
fs.copyFileSync(path.join(ROOT, 'server', 'schema.sql'), path.join(OUT, 'resources', 'schema.sql'));
console.log('  resources/web ' + fs.readdirSync(WEB_DST).length + ' 个文件 ' +
  Math.round(webBytes / 1024) + 'KB');
console.log('  resources/schema.sql');

/* ---- 5. 启动说明 ---- */
step(5, '写使用说明');
const readme = [
  '我的人生档案 · The Story of My Life',
  '',
  '怎么用：双击 MyLife.exe，会自动打开浏览器；黑窗口别关，关了就停了。',
  '',
  '文件说明：',
  '  MyLife.exe            主程序（单文件，内含 Node 运行时）',
  '  resources/            界面文件，改一次界面不用重新打包 exe',
  '  data/                 你的档案、照片、录音都存在这里，只有这个目录需要备份',
  '',
  '换端口（比如 4321 被占）：',
  '  在地址栏输入 cmd 回车，然后： set PORT=4401 && MyLife.exe',
  '',
  '整个文件夹可以拷到别的电脑上用，数据是跟着文件夹走的。',
  '要彻底卸载，删掉整个文件夹即可，不会在别处留东西。',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme, 'utf8');

const size = fs.statSync(exe).size;
console.log('\n完成：');
console.log('  ' + exe + '  ' + Math.round(size / 1024 / 1024 * 10) / 10 + ' MB');
console.log('  目录：' + OUT);
