/**
 * ES5 语法守卫（静态检查）。
 * 项目要跑在安卓 5/6 的老 WebView（约 Chrome 37）上，那里不认 const/let/箭头函数/模板字符串/
 * for...of/可选链 等，一处违规整个文件就语法报错、App 白屏。这类问题在现代 Chrome 测试里
 * 抓不到，只能静态守。这里扫 web/*.js（不含 vendor 第三方库），命中就失败。
 *
 * 用法：node test/audit-es5.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');

const RULES = [
  { re: /=>/, name: '箭头函数 =>' },
  { re: /`/, name: '模板字符串 ``' },
  { re: /\bconst\s+[A-Za-z_$]/, name: 'const' },
  { re: /\blet\s+[A-Za-z_$]/, name: 'let' },
  { re: /\basync\s+function\b|\basync\s*\(|\bawait\s+[A-Za-z_$(]/, name: 'async / await' },
  { re: /for\s*\([^)]*\bof\s+[A-Za-z_$]/, name: 'for...of' },
  { re: /\.\.\.\s*[A-Za-z_$]/, name: '展开 / 剩余 ...' },
  { re: /\?\./, name: '可选链 ?.' },
  { re: /\?\?/, name: '空值合并 ??' },
  { re: /\bclass\s+[A-Za-z_$]/, name: 'class' },
  { re: /\bObject\.assign\s*\(/, name: 'Object.assign（Chrome 45+）' },
  { re: /\bArray\.from\s*\(/, name: 'Array.from（Chrome 45+）' },
];

// 只把"整行注释"剔掉，避免误判注释里的示例；不动行内字符串（本仓库是严谨 ES5，行内极少出现这些记号）
function isCommentLine(line) {
  const t = line.replace(/^\s+/, '');
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

function scan() {
  const files = fs.readdirSync(WEB).filter(f => /\.js$/.test(f)); // 只看一层，vendor/ 是第三方不扫
  let hits = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(WEB, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          hits++;
          console.log('  ✗ ' + f + ':' + (i + 1) + '  [' + rule.name + ']  ' + line.trim().slice(0, 90));
        }
      }
    });
  }
  return { files: files.length, hits };
}

const r = scan();
console.log('\nES5 守卫：扫描 ' + r.files + ' 个文件，违规 ' + r.hits + ' 处');
process.exit(r.hits ? 1 : 0);
