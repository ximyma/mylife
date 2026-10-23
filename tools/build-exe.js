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
// 版本号唯一来源：android/app/build.gradle 的 versionName（EXE/APK/备份包命名都用它）
const VERSION_NAME = ((() => {
  try {
    return (fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8')
      .match(/versionName "([^"]+)"/) || [])[1] || '0.0.0';
  } catch (e) { return '0.0.0'; }
})());
const OUT = path.join(ROOT, 'dist', 'win');
const TMP = path.join(ROOT, 'tmp', 'sea');

const NODE_BIN = process.execPath;                       // 用当前这个 node 打包，版本一定一致
const WORKSPACE = 'C:/Users/ximym/.workbuddy/binaries/node/workspace';

function step(n, msg) { console.log('\n[' + n + '] ' + msg); }

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

/* ---- 1. SEA 配置 ---- */
step(1, '生成 sea 配置');
// web/ 和 schema.sql 直接打进 exe：分发时单文件即可。
// 磁盘上的 resources/ 仍会生成，作为"改界面不用重打包"的覆盖层。
const assets = {};
function addDir(rel) {
  const dir = path.join(ROOT, rel);
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isFile()) assets[rel + '/' + f] = fp;
  }
}
addDir('web');
assets['schema.sql'] = path.join(ROOT, 'server', 'schema.sql');
console.log('  内置资产 ' + Object.keys(assets).length + ' 个（web 前端 + schema）');

const cfg = path.join(TMP, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: path.join(ROOT, 'server', 'server.js'),
  output: path.join(TMP, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: assets,
}, null, 2));

execFileSync(NODE_BIN, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
console.log('  blob: ' + fs.statSync(path.join(TMP, 'sea-prep.blob')).size + ' bytes');

/* ---- 2. 复制 node.exe 做骨架 ---- */
step(2, '以 node.exe 为骨架');
// dist/win/data 是用户的数据，重打包不能动它：先挪开，打完再放回来
const dataDir = path.join(OUT, 'data');
const dataKeep = path.join(TMP, 'data-keep');
let hadData = fs.existsSync(dataDir);
if (hadData) fs.cpSync(dataDir, dataKeep, { recursive: true });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
if (hadData) {
  fs.cpSync(dataKeep, dataDir, { recursive: true });
  fs.rmSync(dataKeep, { recursive: true, force: true });
  console.log('  （已保留现有 data/ 数据）');
}
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
  '版本 v0.3.0（2026-10-23）',
  '',
  '怎么用：双击 MyLife.exe，会自动打开浏览器；黑窗口别关，关了就停了。',
  '',
  '文件说明：',
  '  MyLife.exe            主程序，界面已内置，**单文件即可分发**',
  '  resources/            可选覆盖层：想临时改界面时把新文件放进来，不用重打包',
  '  data/                 你的档案、照片、录音都存在这里，只有这个目录需要备份',
  '',
  '换端口（比如 4321 被占）：',
  '  在地址栏输入 cmd 回车，然后： set PORT=4401 && MyLife.exe',
  '',
  '分发给别人：只拷 MyLife.exe 一个文件就能用；',
  '整本档案可以在首页「导出」成一个文件，对方「导入」即可还原。',
  '要彻底卸载，删掉整个文件夹即可，不会在别处留东西。',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme, 'utf8');

const size = fs.statSync(exe).size;
console.log('  ' + exe + '  ' + Math.round(size / 1024 / 1024 * 10) / 10 + ' MB');

/* ---- 6. 最新安卓包同步到 dist 根（版本命名，防止装到旧包） ---- */
try {
  const distRoot = path.dirname(OUT);
  const arc = path.join(distRoot, 'archive');
  fs.mkdirSync(arc, { recursive: true });
  const vn = VERSION_NAME;

  const apkSrc = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (fs.existsSync(apkSrc)) {
    const apkOut = path.join(distRoot, 'MyLife-v' + vn + '-android.apk');
    fs.copyFileSync(apkSrc, apkOut);
    console.log('  ' + apkOut);
  }

  const winOut = path.join(distRoot, 'MyLife-v' + vn + '-windows.exe');
  fs.copyFileSync(exe, winOut);
  console.log('  ' + winOut);

  for (const f of fs.readdirSync(distRoot)) {
    if (/^MyLife-v.*-(android\.apk|windows\.exe)$/.test(f) &&
        f.indexOf('v' + vn + '-') < 0) {
      fs.renameSync(path.join(distRoot, f), path.join(arc, f));
    }
  }
} catch (e) { console.log('  （安装包同步跳过：' + e.message + '）'); }

console.log('\n完成：');
console.log('  目录：' + OUT);
