/**
 * 离线重置密码（不改任何档案内容，只改 auth.db 里某个账号的口令）
 *
 * 用法：
 *   列出账号：node --experimental-sqlite --no-warnings tools/reset-password.js <auth.db>
 *   查看账号：node --experimental-sqlite --no-warnings tools/reset-password.js <auth.db> 18079770096
 *   重置口令：node --experimental-sqlite --no-warnings tools/reset-password.js <auth.db> 18079770096 新密码
 *
 * 也可以直接双击 reset-password.bat，按提示输入。
 * ⚠ 运行前请先关掉正在跑的程序窗口，避免数据库被占用。
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');

function hashPw(pw, salt) {
  // 与服务端 server.js 完全一致：scrypt(pw, salt, 64).hex
  return crypto.scryptSync(String(pw), String(salt), 64).toString('hex');
}

const args = process.argv.slice(2);
const dbPath = args[0];
if (!dbPath || !fs.existsSync(dbPath)) {
  console.log('找不到 auth.db：' + (dbPath || '(未指定)'));
  console.log('用法：node --experimental-sqlite --no-warnings tools/reset-password.js <auth.db> [手机号] [新密码]');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

const phone = args[1] ? String(args[1]).trim() : '';
const pw = args[2] ? String(args[2]) : '';

if (!phone) {
  const rows = db.prepare('SELECT id,phone,nickname,created_at,is_admin FROM users ORDER BY id').all();
  console.log('库文件：' + dbPath);
  console.log('账号共 ' + rows.length + ' 个：');
  for (const r of rows) {
    console.log('  #' + r.id + '  ' + r.phone + '  ' + (r.nickname || '(无昵称)') + '  注册于 ' + (r.created_at || '?') + (r.is_admin ? '  [管理员]' : ''));
  }
  db.close();
  process.exit(0);
}

const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
if (!u) {
  console.log('这个手机号不在库里：' + phone);
  const rows = db.prepare('SELECT phone FROM users ORDER BY id').all();
  console.log('现有账号：' + rows.map(function (r) { return r.phone; }).join(', '));
  db.close();
  process.exit(2);
}

if (!pw) {
  console.log('账号 #' + u.id + '  ' + u.phone + '  昵称 ' + (u.nickname || '(无)') + '  注册于 ' + (u.created_at || '?'));
  console.log('（要改口令就再带上新密码：... ' + phone + ' 新密码）');
  db.close();
  process.exit(0);
}

if (pw.length < 6) {
  console.log('密码至少 6 位，未改动。');
  db.close();
  process.exit(3);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = hashPw(pw, salt);
db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
try { db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); } catch (e) {}
console.log('已重置：' + u.phone + '（昵称 ' + (u.nickname || '无') + '）的新密码已写入，档案内容未做任何改动。');
db.close();
