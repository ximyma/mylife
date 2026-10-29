/**
 * 拉取 ffmpeg 二进制到 bin/（构建 exe 时会内置进去）。
 *
 * 为什么不直接用官方静态包：
 *   gyan.dev 的 zip 是 114MB，本机网速下要下 40 分钟；
 *   npm 上的 @ffmpeg-installer/win32-x64 包只有 22MB（压缩后），
 *   解出来就是同一个 ffmpeg.exe（4.1，带 libx264 / libass / freetype，够用）。
 *
 * 用法： node tools/fetch-ffmpeg.js
 * 产出： bin/ffmpeg.exe（约 62MB，已在 .gitignore 里，不入库）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const TARGET = path.join(BIN, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const PKG = process.platform === 'win32'
  ? { name: '@ffmpeg-installer/win32-x64', ver: '4.1.0', file: 'ffmpeg.exe' }
  : process.platform === 'darwin'
  ? { name: '@ffmpeg-installer/darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64'),
      ver: process.arch === 'arm64' ? '4.1.5' : '4.1.0', file: 'ffmpeg' }
  : { name: '@ffmpeg-installer/linux-x64', ver: '4.1.0', file: 'ffmpeg' };

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        return res.resume();
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, last = 0;
      res.on('data', c => {
        got += c.length;
        if (total && got - last > 4 * 1024 * 1024) {
          last = got;
          process.stdout.write('  ' + Math.round(got / 1048576) + '/' + Math.round(total / 1048576) + ' MB\n');
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(got)));
    }).on('error', e => { fs.unlink(dest, () => {}); reject(e); });
  });
}

(async () => {
  if (fs.existsSync(TARGET) && fs.statSync(TARGET).size > 1024 * 1024) {
    console.log('已经有了：' + TARGET + '（' + Math.round(fs.statSync(TARGET).size / 1048576) + ' MB）');
    return;
  }
  fs.mkdirSync(BIN, { recursive: true });
  const tgz = path.join(BIN, '__ffmpeg.tgz');
  const url = 'https://registry.npmjs.org/' + PKG.name + '/-/' +
    PKG.name.split('/')[1] + '-' + PKG.ver + '.tgz';
  console.log('下载 ' + url);
  await download(url, tgz);
  console.log('解包……');
  execFileSync('tar', ['xzf', tgz, '-C', BIN], { stdio: 'inherit' });
  const picked = path.join(BIN, 'package', PKG.file);
  fs.renameSync(picked, TARGET);
  if (process.platform !== 'win32') fs.chmodSync(TARGET, 0o755);   // npm 包里不带执行位
  fs.rmSync(path.join(BIN, 'package'), { recursive: true, force: true });
  fs.rmSync(tgz, { force: true });
  const size = fs.statSync(TARGET).size;
  console.log('好了：' + TARGET + '（' + Math.round(size / 1048576) + ' MB）');
  try {
    const v = execFileSync(TARGET, ['-version'], { encoding: 'utf8' });
    console.log('  ' + String(v).split('\n')[0]);
  } catch (e) {
    console.log('  （跑不起来：' + e.message + '）');
  }
})().catch(e => {
  console.error('失败：' + (e.message || e));
  process.exit(1);
});
