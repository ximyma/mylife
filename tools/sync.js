'use strict';
/**
 * 把 web/ 和 schema.sql 同步进安卓 assets。
 * 前端只有一份，网页端和安卓端读的是同一批文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SCHEMA = path.join(ROOT, 'server', 'schema.sql');
const OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0, bytes = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      const r = copyDir(s, d);
      n += r.n; bytes += r.bytes;
    } else {
      fs.copyFileSync(s, d);
      n++; bytes += st.size;
    }
  }
  return { n, bytes };
}

function main() {
  if (!fs.existsSync(WEB)) {
    console.error('找不到 web/ 目录');
    process.exit(1);
  }

  // 清掉旧的 web 副本，避免删掉的文件还留在 assets 里
  const webOut = path.join(OUT, 'web');
  if (fs.existsSync(webOut)) fs.rmSync(webOut, { recursive: true, force: true });

  const r = copyDir(WEB, webOut);
  console.log(`web/ -> assets/web  ${r.n} 个文件 ${(r.bytes / 1024).toFixed(1)} KB`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(SCHEMA, path.join(OUT, 'schema.sql'));
  console.log(`schema.sql -> assets  ${(fs.statSync(SCHEMA).size / 1024).toFixed(1)} KB`);
}

main();
