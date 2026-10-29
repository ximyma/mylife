'use strict';
/**
 * 网页端宿主（安卓端用 LocalServer.java，接口完全一致）。
 *
 * 只做四件事：
 *   POST /api/query   {sql, params} -> rows[]
 *   POST /api/exec    {sql, params} -> {changes, lastId}
 *   POST /api/ai      {messages}    -> {text}
 *   POST /api/file    {op, ...}     -> 落盘 / 读取 / 删除
 *   GET  /files/<rel>                -> 二进制，支持 Range
 *   GET  /*                          -> web/ 下的静态文件
 *
 * 业务一律不懂。改需求只改 web/db.js。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const VERSION = 'v0.9.15';   // 与 CHANGELOG.md、web/app.js、安卓 versionName 保持一致

/*
 * 两种跑法：
 *   开发：node server/server.js        —— web/ 在上一级，数据在 ROOT/data
 *   打包：双击 MyLife.exe              —— 单文件 SEA，__dirname 不可靠，
 *                                        一律以 exe 所在目录为基准
 *
 * exe 旁边放 resources/（web 前端 + schema.sql），运行时生成 data/。
 * 这样整个程序可以整个文件夹拷走，数据随身。
 */
let sea = false;
try { sea = require('node:sea').isSea(); } catch (e) { sea = false; }

/* 打包时 web/ 和 schema.sql 也被塞进了 exe（SEA assets）。
 * 磁盘上的 resources/ 仍然优先——改完界面不用重新打包 exe；
 * resources/ 不在（单文件分发）就退回内置版本。 */
let assetKeys = null;
if (sea) {
  try { assetKeys = new Set(require('node:sea').getAssetKeys()); } catch (e) { assetKeys = null; }
}
function assetGet(key) {
  if (!assetKeys || !assetKeys.has(key)) return null;
  try { return Buffer.from(require('node:sea').getAsset(key)); } catch (e) { return null; }
}

const EXE_DIR = path.dirname(process.execPath);        // 打包后的基准目录
const BASE = sea ? path.join(EXE_DIR, 'resources') : path.join(__dirname, '..');

const ROOT = BASE;
const WEB = path.join(ROOT, 'web');
// 开发时 schema.sql 就躺在 server/ 里；打包后先进了 exe，resources/ 里的是可选覆盖
const SCHEMA_FILE = sea ? path.join(BASE, 'schema.sql') : path.join(__dirname, 'schema.sql');
const SCHEMA_EMBED = sea ? assetGet('schema.sql') : null;
const DATA = process.env.DATA_DIR || (sea ? path.join(EXE_DIR, 'data') : path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA, { recursive: true });

/* ---------------- 数据库：账号库 + 每用户一个业务库 ----------------
 * auth.db 存"谁能登录"（users + sessions），全局一份。
 * 业务库 data/users/<uid>/archive.db 登录后按需打开（LRU 缓存 20 个）。
 * 业务库里的表结构与 v0.2 完全一致——schema 是幂等的，新库首次打开时执行。 */


/* ---------------- 账号与短信（v0.3 内联：SEA 单文件不支持 require 本地文件） ----------------
 * 修改鉴权逻辑直接改下面 AUTH 段；原独立文件已并入，git 历史可查。
 * ------------------------------------------------------------------ */
const AUTH = (function () {
'use strict';
/*
 * 账号库（auth.db）：users + sessions。
 * 与用户数据（users/<uid>/archive.db）完全分离——这里只存"谁能登录"。
 * 密码 scrypt（Node 内置），token 32B 随机 hex，30 天。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const CODE_FIXED = '1234';                 // v0.3 演示版验证码
const TOKEN_DAYS = 30;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

let adb = null;
const failLocks = new Map();               // phone -> { fails, until }
let firstUserMigrate = null;               // server.js 注入：首个注册账号继承旧数据

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), String(salt), 64).toString('hex');
}

function sameHash(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function init(dataDir, onMigrate) {
  adb = new DatabaseSync(path.join(dataDir, 'auth.db'));
  adb.exec('PRAGMA journal_mode = WAL');
  adb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      nickname TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      security_q TEXT,
      security_a TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
  `);
  // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新字段
  const userCols = adb.prepare('PRAGMA table_info(users)').all().map(function (c) { return c.name; });
  const addCol = function (col, ddl) {
    if (!userCols.includes(col)) {
      try { adb.prepare('ALTER TABLE users ADD COLUMN ' + col + ' ' + ddl).run(); } catch (e) {}
    }
  };
  addCol('is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addCol('security_q', 'TEXT');
  addCol('security_a', 'TEXT');
  firstUserMigrate = onMigrate || null;
  return adb;
}

function userCount() {
  return Number(adb.prepare('SELECT count(*) n FROM users').get().n);
}

function issueToken(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  adb.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .run(token, uid);
  return token;
}

function locked(phone) {
  const lk = failLocks.get(phone);
  return lk && lk.until > Date.now() ? lk.until : 0;
}

/** 校验并消费验证码。v0.3 固定 1234；接真短信后在这里换成查 sms_codes 表 */
function checkCode(phone, code) {
  if (String(code || '').trim() !== CODE_FIXED) {
    throw new Error('验证码不对（演示版固定 ' + CODE_FIXED + '）');
  }
  return true;
}

function register(phone, password, code, nickname) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new Error('手机号格式不对');
  if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
  checkCode(phone, code);

  if (adb.prepare('SELECT id FROM users WHERE phone=?').get(phone)) {
    throw new Error('这个手机号已经注册过，直接登录');
  }

  const firstOne = userCount() === 0;   // 全站第一个账号 = 管理员
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(password, salt);
  const r = adb.prepare('INSERT INTO users (phone, password_hash, salt, nickname, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(phone, hash, salt, nickname || null, firstOne ? 1 : 0);
  const uid = Number(r.lastInsertRowid);

  let migrated = false;
  if (firstOne && firstUserMigrate) {
    migrated = !!firstUserMigrate(uid);
  }
  return { uid: uid, token: issueToken(uid), phone: phone, nickname: nickname || null, isAdmin: firstOne, migrated: migrated };
}

function login(phone, password) {
  const until = locked(phone);
  if (until) {
    throw new Error('失败次数太多，请 ' + Math.ceil((until - Date.now()) / 60000) + ' 分钟后再试');
  }
  const u = adb.prepare('SELECT * FROM users WHERE phone=?').get(String(phone || ''));
  const ok = u && sameHash(u.password_hash, hashPw(password || '', u.salt));
  if (!ok) {
    const lk = failLocks.get(phone) || { fails: 0, until: 0 };
    lk.fails++;
    if (lk.fails >= LOGIN_MAX_FAILS) lk.until = Date.now() + LOGIN_LOCK_MS;
    failLocks.set(phone, lk);
    throw new Error('手机号或密码不对' +
      (lk.until ? '，已锁定 10 分钟' : '（还剩 ' + (LOGIN_MAX_FAILS - lk.fails) + ' 次机会）'));
  }
  failLocks.delete(phone);
  return { uid: Number(u.id), token: issueToken(Number(u.id)), phone: u.phone };
}

/** 真短信上线前的空钩子：固定模式下不发、不落表 */
function sms(phone) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new Error('手机号格式不对');
  return { ok: true, fixed: true };
}

function verify(token) {
  if (!token) return null;
  try {
    return adb.prepare(
      "SELECT s.user_id AS uid, u.phone, u.nickname FROM sessions s " +
      "JOIN users u ON u.id = s.user_id " +
      "WHERE s.token = ? AND s.expires_at > datetime('now')"
    ).get(token) || null;
  } catch (e) { return null; }
}

function logout(token) {
  if (token) { try { adb.prepare('DELETE FROM sessions WHERE token=?').run(token); } catch (e) {} }
  return true;
}

/* ---------------- 用户管理（v0.9：单机版多用户 + 找回密码） ----------------
 * 首个注册账号是管理员（is_admin=1）。管理员可增删用户、重置他人密码；
 * 普通用户可改自己的密码、设置/使用密保问题自助找回。
 * 密保答案做 sha256（转小写去空格）存储，不存明文。 */

function hashAnswer(a) {
  return crypto.createHash('sha256').update(String(a || '').trim().toLowerCase()).digest('hex');
}

function isAdmin(uid) {
  const u = adb.prepare('SELECT is_admin FROM users WHERE id=?').get(Number(uid));
  return !!(u && u.is_admin);
}

function listUsers() {
  return adb.prepare('SELECT id, phone, nickname, is_admin, created_at FROM users ORDER BY id').all()
    .map(function (r) {
      return { id: Number(r.id), phone: r.phone, nickname: r.nickname, isAdmin: !!r.is_admin, createdAt: r.created_at };
    });
}

function addUser(actorUid, phone, password, nickname, makeAdmin) {
  if (!isAdmin(actorUid)) throw new Error('只有管理员能添加用户');
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new Error('手机号格式不对');
  if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
  if (adb.prepare('SELECT id FROM users WHERE phone=?').get(phone)) throw new Error('这个手机号已经存在');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(password, salt);
  const r = adb.prepare('INSERT INTO users (phone, password_hash, salt, nickname, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(phone, hash, salt, nickname || null, makeAdmin ? 1 : 0);
  return { uid: Number(r.lastInsertRowid), phone: phone, nickname: nickname || null, isAdmin: !!makeAdmin };
}

function deleteUser(actorUid, targetUid) {
  if (!isAdmin(actorUid)) throw new Error('只有管理员能删除用户');
  targetUid = Number(targetUid);
  if (actorUid === targetUid) throw new Error('不能删除自己');
  const t = adb.prepare('SELECT id, is_admin FROM users WHERE id=?').get(targetUid);
  if (!t) throw new Error('用户不存在');
  if (t.is_admin) {
    const adminCount = Number(adb.prepare('SELECT count(*) n FROM users WHERE is_admin=1').get().n);
    if (adminCount <= 1) throw new Error('至少保留一个管理员');
  }
  adb.prepare('DELETE FROM users WHERE id=?').run(targetUid);
  return { ok: true };
}

function changePassword(uid, oldPw, newPw) {
  uid = Number(uid);
  if (!newPw || String(newPw).length < 6) throw new Error('新密码至少 6 位');
  const u = adb.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!u) throw new Error('用户不存在');
  if (!sameHash(u.password_hash, hashPw(oldPw || '', u.salt))) throw new Error('原密码不对');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(newPw, salt);
  adb.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, uid);
  return { ok: true };
}

function resetPassword(actorUid, targetUid, newPw) {
  if (!isAdmin(actorUid)) throw new Error('只有管理员能重置密码');
  targetUid = Number(targetUid);
  if (!newPw || String(newPw).length < 6) throw new Error('新密码至少 6 位');
  const u = adb.prepare('SELECT id FROM users WHERE id=?').get(targetUid);
  if (!u) throw new Error('用户不存在');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(newPw, salt);
  adb.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, targetUid);
  return { ok: true };
}

function setSecurity(uid, q, a) {
  uid = Number(uid);
  if (!q || !a) throw new Error('密保问题和答案都要填');
  adb.prepare('UPDATE users SET security_q=?, security_a=? WHERE id=?').run(String(q), hashAnswer(a), uid);
  return { ok: true };
}

function getSecurityQuestion(phone) {
  const u = adb.prepare('SELECT security_q FROM users WHERE phone=?').get(String(phone || ''));
  if (!u) throw new Error('这个手机号没注册过');
  if (!u.security_q) throw new Error('该账号未设置密保问题，无法自助找回，请联系管理员重置');
  return { question: u.security_q };
}

function recoverPassword(phone, answer, newPw) {
  if (!newPw || String(newPw).length < 6) throw new Error('新密码至少 6 位');
  const u = adb.prepare('SELECT * FROM users WHERE phone=?').get(String(phone || ''));
  if (!u) throw new Error('这个手机号没注册过');
  if (!u.security_a) throw new Error('该账号未设置密保问题，无法自助找回，请联系管理员重置');
  if (u.security_a !== hashAnswer(answer)) throw new Error('密保答案不对');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(newPw, salt);
  adb.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, Number(u.id));
  return { ok: true };
}

return { init, register, login, sms, verify, logout, isAdmin, listUsers, addUser, deleteUser,
  changePassword, resetPassword, setSecurity, getSecurityQuestion, recoverPassword, CODE_FIXED };

})();
AUTH.init(DATA, migrateLegacy);
const SMS = (function () {
'use strict';
/*
 * 短信通道钩子。v0.3 用固定验证码（1234），这个文件是空实现占位。
 * v0.4 接阿里云/腾讯云短信时，只实现这里的 send()，注册逻辑一行不改。
 */

/** 发送验证码。返回 {ok, fixed:true} 表示演示模式（前端会提示验证码是 1234） */
function send(phone, code) {
  // TODO v0.4: 接入真实短信服务商
  //   阿里云: dysmsapi  SendSms
  //   腾讯云: sms SendSms
  //   模板参数 { code }, 60s 限一条、24h 限十条（服务端已在 auth 层限速）
  return { ok: true, fixed: true };
}

return { send };

})();

const { AsyncLocalStorage } = require('node:async_hooks');
const RLS = new AsyncLocalStorage();
const ctxDb = () => RLS.getStore().db;
const ctxFiles = () => RLS.getStore().files;

const userDbs = new Map();      // uid -> DatabaseSync
const USER_DB_MAX = 20;

function initSchemaOn(d) {
  const schema = SCHEMA_EMBED ? SCHEMA_EMBED.toString('utf8') : fs.readFileSync(SCHEMA_FILE, 'utf8');
  let ok = 0, all = 0;
  for (const stmt of schema.split(';')) {
    const clean = stmt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (!clean) continue;
    all++;
    try { d.exec(clean); ok++; }
    catch (e) {
      // ALTER TABLE 加列在第二次打开时会"重复列名"——幂等迁移，结构已就绪，算成功不算失败
      const msg = String(e && e.message || '');
      if (/duplicate column name|already exists/i.test(msg)) { ok++; continue; }
      console.warn('[schema] 跳过：', clean.slice(0, 50), msg);
    }
  }
  console.log(`  数据库结构 ${ok}/${all} 条就绪`);
}

function dbForUser(uid) {
  if (userDbs.has(uid)) return userDbs.get(uid);
  const userDir = path.join(DATA, 'users', String(uid));
  fs.mkdirSync(path.join(userDir, 'files', 'photo'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'files', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'files', 'video'), { recursive: true });
  // v0.5 的三类新目录：派生（缩略图/转码，可重建）、AI 产物、导出件。
  // 老的 photo/audio/video 就是「原始件」，不搬家——搬一万个用户的路径是拿数据冒险。
  for (const sub of ['derived', 'ai', 'exports']) {
    fs.mkdirSync(path.join(userDir, 'files', sub), { recursive: true });
  }
  const d = new DatabaseSync(path.join(userDir, 'archive.db'));
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  initSchemaOn(d);
  // 上次进程被杀时留下的 running 任务：重新入队，不让它永远卡在"进行中"
  try { d.prepare("UPDATE jobs SET status='queued', stage='重启后继续' WHERE status='running'").run(); } catch (e) {}
  if (userDbs.size >= USER_DB_MAX) {
    const oldest = userDbs.keys().next().value;
    try { userDbs.get(oldest).close(); } catch (e) {}
    userDbs.delete(oldest);
  }
  userDbs.set(uid, d);
  // 老版本合成的成片只躺在磁盘上（那时还不登记 media），等于"任务做完就找不到了"。
  // 这里补登记一次，让以前的片子也能在档案里出现。
  try { registerOrphanMovies(uid, d); } catch (e) {}
  return d;
}

/**
 * 把 ai/movie 下没登记的成片补进 media。
 * 归属档案怎么判断：① 任务记录里带 archiveId 的用它；② 否则看分镜里那张照片属于哪本档案；
 * ③ 还判断不出来就只在用户只有一本档案时挂上去——宁可不挂，也不挂错档案。
 */
function registerOrphanMovies(uid, d) {
  const base = path.join(DATA, 'users', String(uid), 'files', 'ai', 'movie');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (e) { return; }
  if (!dirs.length) return;

  let known;
  try {
    known = new Set(d.prepare("SELECT path FROM media WHERE kind='movie'").all().map(function (r) { return r.path; }));
  } catch (e) { return; }

  let onlyArchive = 0;
  try {
    const as = d.prepare('SELECT id FROM archives').all();
    if (as.length === 1) onlyArchive = Number(as[0].id);
  } catch (e) {}

  for (const name of dirs) {
    const rel = 'ai/movie/' + name + '/movie.mp4';
    if (known.has(rel)) continue;
    const abs = path.join(base, name, 'movie.mp4');
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st || !st.size) continue;

    let aid = 0, caption = '';
    try {
      const job = d.prepare("SELECT payload_json FROM jobs WHERE type='movie' AND result_json LIKE ? ORDER BY id DESC LIMIT 1")
        .get('%' + rel + '%');
      const p = (job && job.payload_json) ? (safeJson(job.payload_json) || {}) : {};
      caption = String(p.title || '');
      if (Number(p.archiveId)) aid = Number(p.archiveId);
      else {
        const fr = (p.frames || []).filter(function (f) { return f && f.image; })[0];
        if (fr) {
          const ph = d.prepare('SELECT archive_id FROM photos WHERE path=?').get(String(fr.image));
          if (ph) aid = Number(ph.archive_id);
        }
      }
    } catch (e) {}
    if (!aid) aid = onlyArchive;
    if (!aid) continue;

    try {
      d.prepare('INSERT INTO media (archive_id, kind, path, mime, bytes, caption) VALUES (?,?,?,?,?,?)')
        .run(aid, 'movie', rel, 'video/mp4', st.size, caption.slice(0, 120));
      console.log('  [movie] 补登记成片 ' + rel + ' → 档案 ' + aid);
    } catch (e) {}
  }
}

/** v0.2 → v0.3 迁移：第一个注册的账号继承旧的单用户库（移动，不是复制）。 */
function migrateLegacy(uid) {
  const legacyDb = path.join(DATA, 'archive.db');
  const legacyFiles = path.join(DATA, 'files');
  if (!fs.existsSync(legacyDb)) return false;

  const userDir = path.join(DATA, 'users', String(uid));
  fs.mkdirSync(userDir, { recursive: true });
  const targetDb = path.join(userDir, 'archive.db');
  fs.rmSync(targetDb, { force: true });            // 删掉刚初始化的空库，让位给旧数据
  for (const ext of ['-wal', '-shm']) {
    const s = legacyDb + ext;
    if (fs.existsSync(s)) { try { fs.renameSync(s, targetDb + ext); } catch (e) {} }
  }
  fs.renameSync(legacyDb, targetDb);
  if (fs.existsSync(legacyFiles)) {
    fs.renameSync(legacyFiles, path.join(userDir, 'files'));
  }
  userDbs.delete(uid);                             // 让缓存失效，下次请求重开
  console.log('[迁移] v0.2 的档案已归属第一个注册的账号（uid=' + uid + '）');
  return true;
}

/* 请求级上下文：业务函数里的 db / FILES 全部改从这取，保证并发请求不串库 */

/* ---------------- HTTP 工具 ---------------- */

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('数据格式不对')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};

/** 支持 Range：没有 206，视频拖不动进度条。cache 默认给素材用一天，前端文件要 no-cache。 */
function sendFile(req, res, abs, cache) {
  var cache = arguments[3] || 'private, max-age=86400';
  let st;
  try { st = fs.statSync(abs); } catch { return sendText(res, 404, 'not found'); }
  if (!st.isFile()) return sendText(res, 404, 'not found');

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1,
        'cache-control': cache,
      });
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'content-type': type, 'content-length': st.size,
    'accept-ranges': 'bytes', 'cache-control': cache,
  });
  fs.createReadStream(abs).pipe(res);
}

/* ---------------- 业务路由 ---------------- */

function bind(params) {
  return (params || []).map(v => (v === null || v === undefined) ? null : String(v));
}

/** 剥掉前导空白与注释，返回小写化的语句开头。用于关键字检查，防止用注释绕过。 */
function leadingSql(sql) {
  let s = String(sql || '');
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl === -1 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const e = t.indexOf('*/'); s = e === -1 ? '' : t.slice(e + 2); continue; }
    return t.toLowerCase();
  }
}

/**
 * 多用户隔离：不许把别的数据库挂进来，也不许加载扩展。
 * 不拦的话，客户端可以用 ATTACH DATABASE '<别人 archive.db>' 读到别人的数据（已实测可行）。
 * 按分号拆成多条语句逐条看开头，既防注释/多语句绕过，也不会误伤正文里出现的 attach 字样。
 */
function assertNoAttach(sql) {
  const s = String(sql || '');
  // load_extension 可能作为函数出现在 SELECT 里，前导关键字抓不到，单独按调用形态拦
  if (/\bload_extension\s*\(/i.test(s)) throw new Error('不允许加载扩展');
  const parts = s.split(';');
  for (const p of parts) {
    const low = leadingSql(p);
    if (/^(attach|detach)\b/.test(low)) {
      throw new Error('不允许挂载或卸载其它数据库');
    }
  }
}

function apiQuery(body) {
  assertNoAttach(body.sql);
  const stmt = ctxDb().prepare(body.sql);
  return stmt.all(...bind(body.params));
}

function apiExec(body) {
  const sql = String(body.sql || '');
  assertNoAttach(sql);
  const low = leadingSql(sql);
  if (low.startsWith('select') || low.startsWith('pragma')) throw new Error('exec 不接受查询语句');
  if (/^(drop|alter|attach|detach|create|vacuum|load_extension)\b/.test(low)) throw new Error('exec 不允许改表结构');
  const r = ctxDb().prepare(sql).run(...bind(body.params));
  return { ok: true, changes: Number(r.changes || 0), lastId: Number(r.lastInsertRowid || 0) };
}

/* ---- AI：配置、拉模型、测试、对话 ---- */

function profileById(id) {
  return ctxDb().prepare('SELECT * FROM ai_profiles WHERE id=?').get(Number(id));
}

function profileForSlot(slot) {
  const row = ctxDb().prepare('SELECT profile_id, model FROM ai_slots WHERE slot=?').get(slot);
  if (!row) return null;
  // 老库里有把「没绑」写成字符串 'None' 的行（早期版本的坑）：它非空但不是 id，
  // 直接当空处理，否则会一路回退到默认文本模型去调语音接口，报 403 Illegal operation。
  const pid = row.profile_id;
  if (!pid || /^(none|null|undefined)$/i.test(String(pid).trim())) return null;
  const p = profileById(pid);
  if (!p) return null;
  const model = row.model && !/^(none|null|undefined)$/i.test(String(row.model).trim())
    ? row.model : p.default_model;
  return { profile: p, model: model };
}

function defaultProfile() {
  return ctxDb().prepare('SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id LIMIT 1').get();
}

/** 决定这次用哪条配置：显式 profileId > 用途槽位 > 第一条可用 */
function pickProfile(body) {
  if (body.profileId) {
    const p = profileById(body.profileId);
    if (p) return { profile: p, model: body.model || p.default_model };
  }
  if (body.slot) {
    const hit = profileForSlot(body.slot);
    if (hit) return hit;
  }
  const p = defaultProfile();
  return p ? { profile: p, model: body.model || p.default_model } : null;
}

function endpointOf(p) {
  const base = String(p.base_url || '').replace(/\/+$/, '');
  return base;
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 有的服务返回非 JSON */ }
    return { ok: r.ok, status: r.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(p) {
  const h = { 'content-type': 'application/json' };
  if (p.api_key) h.authorization = 'Bearer ' + p.api_key;
  return h;
}

/** 拉模型列表：GET /models（OpenAI / Ollama / vLLM 通吃） */
async function apiAiModels(body) {
  const p = body.profileId ? profileById(body.profileId) : null;
  if (!p) return { ok: false, message: '没有这条配置' };
  const url = endpointOf(p) + '/models';
  try {
    const r = await fetchJson(url, { method: 'GET', headers: authHeaders(p) }, 20000);
    if (!r.ok) {
      return { ok: false, message: `拉不到模型（HTTP ${r.status}）：${String(r.text).slice(0, 160)}` };
    }
    const list = (r.json && (r.json.data || r.json.models)) || [];
    const ids = [];
    for (const m of list) {
      const id = m && (m.id || m.name || m.model);
      if (id) ids.push(String(id));
    }
    ctxDb().prepare('UPDATE ai_profiles SET models_json=? WHERE id=?').run(JSON.stringify(ids), p.id);
    return { ok: true, models: ids, count: ids.length };
  } catch (e) {
    return { ok: false, message: '连不上：' + (e.message || e) };
  }
}

/** 测试连通性：发一句最短的话 */
/** 1 秒静音 WAV（16k 单声道 16bit）：只用来探测转写接口通不通，内容不重要 */
function tinyWav(seconds) {
  const rate = 16000;
  const n = Math.round(rate * (seconds || 1));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** 转写模型报"不存在"时，给一句能照着做的建议 */
function asrModelHint(model) {
  const m = String(model || '');
  if (/siliconflow/i.test(m) || /qwen3-asr|qwen.*asr/i.test(m)) {
    return '这个模型不支持转写接口。硅基流动免费能转写的只有 FunAudioLLM/SenseVoiceSmall 和 TeleAI/TeleSpeechASR，换成它们。';
  }
  return '换个语音模型试试：硅基流动 FunAudioLLM/SenseVoiceSmall（免费）、TeleAI/TeleSpeechASR（免费）、智谱 glm-asr-2512、Groq whisper-large-v3-turbo。';
}

/** 语音环节的真实试跑：发 1 秒静音到 /audio/transcriptions，HTTP 200 即通过 */
async function testAsr(profile, useModel, t0) {
  const form = new FormData();
  form.set('file', new Blob([tinyWav(1)], { type: 'audio/wav' }), 'probe.wav');
  form.set('model', useModel);
  try {
    const r = await fetchJson(endpointOf(profile) + '/audio/transcriptions', {
      method: 'POST',
      headers: profile.api_key ? { authorization: 'Bearer ' + profile.api_key } : {},
      body: form,
    }, 60000);
    const ms = Date.now() - t0;
    if (!r.ok) {
      const body0 = String(r.text || '').slice(0, 200);
      const missing = /20012|does not exist|model[_ ]?not[_ ]?found|invalid model/i.test(body0);
      return {
        ok: false, ms, status: r.status, model: useModel,
        message: `HTTP ${r.status}：${body0}` + (missing ? '\n→ ' + asrModelHint(useModel) : ''),
      };
    }
    return {
      ok: true, ms, model: useModel,
      reply: '转写接口可用（发了一段静音测试音）',
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: '连不上：' + (e.message || e) };
  }
}

async function apiAiTest(body) {
  const pick = pickProfile(body);
  if (!pick) return { ok: false, message: '还没有可用的模型配置' };
  const { profile, model } = pick;
  const useModel = body.model || model || profile.default_model;
  if (!useModel) return { ok: false, message: '这条配置还没选模型' };

  const t0 = Date.now();

  // 语音模型不能用对话接口试——ASR 模型在 /chat/completions 上必然报
  // "Model does not exist"，看起来像配置错了，其实是用错了接口。
  // 这里真发一段 1 秒静音 WAV 到 /audio/transcriptions：HTTP 200 就算通。
  if (body.slot === 'asr') return await testAsr(profile, useModel, t0);

  // 作曲模型也不认对话接口，而且真跑一次要一首歌的钱。与其报错让人以为配错了，
  // 不如直说：配好了，去「AI 助手 → 作曲」作一支就知道通不通。
  if (body.slot === 'music') {
    return { ok: false, ms: 0,
      message: '作曲模型不能用对话接口试跑（它只认音乐专用的接口，而且跑一次就是一首歌的钱）。' +
        '想验证 Key 对不对，去「AI 助手 → 作曲」作一支：' +
        '阶跃星辰目前限免，Mureka 会按首计费。' };
  }
  try {
    const r = await fetchJson(endpointOf(profile) + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(profile),
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: 'user', content: '只回两个字：可用' }],
        temperature: 0,
        // 推理模型（qwen3 / deepseek-r1）会先吐思考 token，给 16 会全被思考吃掉，
        // 正文一个字都不剩。给 96 才稳。
        max_tokens: 96,
        stream: false,
      }),
    }, 60000);

    const ms = Date.now() - t0;
    if (!r.ok) {
      return { ok: false, ms, status: r.status,
        message: `HTTP ${r.status}：${String(r.text).slice(0, 200)}` };
    }
    const choice = (r.json && r.json.choices && r.json.choices[0]) || {};
    const msg = choice.message || {};
    // 推理模型的思考内容字段各家叫法不同
    const text = String(msg.content || '').trim();
    const think = String(msg.reasoning_content || msg.reasoning || '').trim();
    const used = (r.json && r.json.usage && r.json.usage.completion_tokens) || 0;
    const finished = choice.finish_reason || '';

    if (!text && !think && !used) {
      return { ok: false, ms, model: useModel,
        message: '模型回了空内容，可能这不是对话模型' };
    }
    return {
      ok: true, ms, model: useModel,
      reply: String(text || '（推理模型，' + used + ' tokens 已响应）').slice(0, 40),
      thinking: !text && !!think,
      finish: finished,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: '连不上：' + (e.message || e) };
  }
}

/** 对话：支持多模态（messages 里带 image_url 直接透传）；一条不通自动换下一条 */
async function apiAi(body) {
  if (!body.messages || !body.messages.length) return { ok: false, message: '没有要发送的内容' };
  const chain = profileChain(body);
  if (!chain.length) {
    return { ok: false, message: '还没配模型。打开「设置 → 模型来源」加一条。' };
  }
  const errors = [];
  for (const cand of chain.slice(0, 3)) {
    if (!cand.model) { errors.push(cand.profile.name + ' 还没选模型'); continue; }
    const r = await aiChatOnce(cand, body);
    if (r.ok) {
      usageAdd('text', cand.model, (r.usage && r.usage.total_tokens) || Math.round(r.text.length / 2), 'token', 0, 'chat');
      return {
        ok: true, ms: r.ms, model: cand.model, profile: cand.profile.name,
        text: r.text, usage: r.usage || null,
        fallbacks: errors.length ? errors : undefined,
      };
    }
    errors.push(r.message || '失败');
  }
  return { ok: false, message: errors.join('\n') || '调用失败' };
}

/* 路径安全：只允许落在 data/files/ 里 */
const safe = s => String(s || 'misc').replace(/\.\./g, '').replace(/[\/\\]/g, '');
const safePath = s => String(s || '').replace(/\.\./g, '').replace(/\\/g, '/');

/** 子目录也走得通（derived/thumbs、ai/img、exports），每一段都洗一遍 */
function safeRel(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(function (x) { return x && x !== '.' && x !== '..'; })
    .map(function (x) { return x.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_'); })
    .join('/');
}

/**
 * 语音转文字：把已经存好的音频转写成文字。
 * 走 OpenAI 兼容的 multipart 接口，与词录入 Qwen3-ASR / SenseVoice / Whisper 通用。
 * body: { path: 'audio/xxx.webm', profileId?, model?, language? }
 */
async function apiAsr(body) {
  const rel = safePath(body.path || '');
  if (!rel) return { ok: false, message: '没有指定音频' };

  const files = ctxFiles();
  const abs = path.join(files, rel);
  if (!abs.startsWith(files) || !fs.existsSync(abs)) {
    return { ok: false, message: '找不到这个音频文件' };
  }

  const pick = pickProfile({ slot: 'asr', profileId: body.profileId });
  if (!pick) return { ok: false, message: '没有可用的语音模型。去设置里给「语音转文字」绑一条配置。' };
  const { profile, model } = pick;
  // body.model 优先：前端在"模型不存在"时会显式换一个模型重试
  const useModel = body.model || model || profile.default_model;
  if (!useModel) return { ok: false, message: '这条配置还没选模型' };

  // 超过 25MB 的服务端通常不接受，提前说清楚而不是让人干等
  const size = fs.statSync(abs).size;
  if (size > 25 * 1024 * 1024) {
    return { ok: false, message: '音频 ' + Math.round(size / 1048576) + 'MB，超过服务端 25MB 上限，请先分段' };
  }

  const ext = (path.extname(abs) || '').toLowerCase();
  const MIME = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm',
    '.flac': 'audio/flac', '.aac': 'audio/aac', '.mp4': 'audio/mp4',
  };
  const mime = MIME[ext] || 'audio/mpeg';
  const buf = fs.readFileSync(abs);

  const form = new FormData();
  form.set('file', new Blob([buf], { type: mime }), path.basename(abs));
  form.set('model', useModel);
  if (body.language) form.set('language', body.language);

  const t0 = Date.now();
  // 失败时把请求原貌带回去：模型、接口、大小、HTTP 状态、服务端原话。
  // 手机上转不出来、电脑上又正常时，两边各点一次就能比出差异在哪。
  const diagOf = (status, body) => ({
    base: endpointOf(profile),
    profile: profile.name,
    model: useModel,
    path: rel,
    bytes: size,
    status: status,
    body: String(body || '').slice(0, 600),
  });
  try {
    const r = await fetchJson(endpointOf(profile) + '/audio/transcriptions', {
      method: 'POST',
      headers: profile.api_key ? { authorization: 'Bearer ' + profile.api_key } : {},
      body: form,          // 不要手动设 content-type，让 fetch 带上 boundary
    }, 180000);
    const ms = Date.now() - t0;

    if (!r.ok) {
      const body0 = String(r.text || '').slice(0, 200);
      const missing = /20012|does not exist|model[_ ]?not[_ ]?found|invalid model/i.test(body0);
      return {
        ok: false, ms, model: useModel,
        message: `HTTP ${r.status}：${body0}` + (missing ? '\n→ ' + asrModelHint(useModel) : ''),
        diag: diagOf(r.status, r.text),
      };
    }
    const text = (r.json && (r.json.text || r.json.transcript)) || '';
    if (!String(text).trim()) {
      return { ok: false, ms, message: '转出来是空的。录音里可能没说话，或者这段音频格式不支持。', diag: diagOf(200, r.text) };
    }
    usageAdd('asr', useModel, Math.round(size / 1024), 'KB', 0, 'asr');
    return {
      ok: true, ms, model: useModel,
      text: String(text).trim(),
      bytes: size,
      usage: (r.json && r.json.usage) || null,
      language: (r.json && r.json.language) || null,
    };  } catch (e) {
    return {
      ok: false, ms: Date.now() - t0,
      message: '连不上服务器：' + (e.message || e) + '\n→ 检查网络，或这条配置的地址是否需要代理',
      diag: diagOf(-1, e.message || String(e)),
    };
  }
}

function apiFile(body) {
  const op = body.op || 'save';

  if (op === 'save') {
    const kind = safeRel(body.dir || body.kind || 'misc') || 'misc';
    const name = safe(body.name || String(Date.now()));
    let b64 = String(body.base64 || '');
    const comma = b64.indexOf(',');
    if (b64.startsWith('data:') && comma > 0) b64 = b64.slice(comma + 1);
    if (!b64) throw new Error('没有收到内容');

    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('文件是空的');
    if (buf.length > 80 * 1024 * 1024) throw new Error('单个文件超过 80MB');

    const dir = path.join(ctxFiles(), kind);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    if (!abs.startsWith(ctxFiles())) throw new Error('路径不合法');
    if (body.append) fs.appendFileSync(abs, buf);
    else fs.writeFileSync(abs, buf);

    return { ok: true, path: kind + '/' + name, bytes: fs.statSync(abs).size };
  }

  if (op === 'stat') {
    const abs = path.join(ctxFiles(), safePath(body.path));
    if (!abs.startsWith(ctxFiles()) || !fs.existsSync(abs)) return { ok: true, exists: false };
    const st = fs.statSync(abs);
    return { ok: true, exists: st.isFile(), bytes: st.size, mtime: st.mtimeMs };
  }

  if (op === 'read') {
    const files = ctxFiles();
    const abs = path.join(files, safePath(body.path));
    if (!abs.startsWith(files) || !fs.existsSync(abs)) throw new Error('文件不存在');
    return { ok: true, base64: fs.readFileSync(abs).toString('base64'), bytes: fs.statSync(abs).size };
  }

  if (op === 'del') {
    const files = ctxFiles();
    const abs = path.join(files, safePath(body.path));
    if (!abs.startsWith(files)) return { ok: false };
    try { fs.unlinkSync(abs); return { ok: true }; } catch { return { ok: false }; }
  }

  if (op === 'list') {
    const dir = path.join(ctxFiles(), safe(body.kind));
    if (!fs.existsSync(dir)) return { ok: true, items: [] };
    return {
      ok: true,
      items: fs.readdirSync(dir).map(n => ({ name: n, bytes: fs.statSync(path.join(dir, n)).size })),
    };
  }

  throw new Error('未知操作 ' + op);
}

/* ================= v0.5 基座：用量记账 / 任务队列 / 能力网关 ================= */

/* ---------------- 用量记账 ---------------- */

function usageAdd(capability, model, units, unit, cost, ref) {
  try {
    ctxDb().prepare('INSERT INTO ai_usage (capability, model, units, unit, cost, ref) VALUES (?,?,?,?,?,?)')
      .run(String(capability || 'text'), model ? String(model) : null,
        Number(units) || 0, unit || null, Number(cost) || 0, ref || null);
  } catch (e) { console.warn('[usage] 记账失败：' + (e.message || e)); }
}

function usageSummary(body) {
  const days = Math.max(1, Number(body.days) || 30);
  const rows = ctxDb().prepare(
    "SELECT capability, COUNT(*) AS calls, COALESCE(SUM(units),0) AS units, COALESCE(SUM(cost),0) AS cost " +
    "FROM ai_usage WHERE at >= datetime('now', ?) GROUP BY capability ORDER BY capability"
  ).all('-' + days + ' days');
  let calls = 0, cost = 0;
  for (const r of rows) { calls += Number(r.calls || 0); cost += Number(r.cost || 0); }
  return { ok: true, days: days, byCapability: rows, calls: calls, cost: Math.round(cost * 100) / 100 };
}

/* ---------------- 任务队列 ----------------
 * 单线程、300ms 轮询、可取消、进程重启后 running 自动回队列。
 * 为什么不用 SSE 推：安卓老 WebView 的 EventSource 带不了 Authorization 头，
 * 本地回环上 1 秒一次的轮询开销可以忽略。 */

const JOB_TYPES = Object.create(null);
let jobBusy = false;
let jobTicker = null;

function registerJob(type, fn) { JOB_TYPES[type] = fn; }

function jobsStart() {
  if (jobTicker) return;
  jobTicker = setInterval(function () { jobsTick().catch(function () {}); }, 300);
  if (jobTicker.unref) jobTicker.unref();
}

function jobRowToJson(row) {
  if (!row) return null;
  return {
    id: Number(row.id), type: row.type, status: row.status,
    progress: Number(row.progress || 0), stage: row.stage || '',
    error: row.error || null,
    result: row.result_json ? safeJson(row.result_json) : null,
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function jobsTick() {
  if (jobBusy) return;
  const uids = Array.from(userDbs.keys());
  for (const uid of uids) {
    const db = userDbs.get(uid);
    if (!db) continue;
    let row = null;
    try { row = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get(); }
    catch (e) { continue; }
    if (!row) continue;
    jobBusy = true;
    try { await runJob(uid, db, row); }
    finally { jobBusy = false; }
    return;              // 一轮只处理一个，保证进度上报不互相打
  }
}

async function runJob(uid, db, row) {
  const files = path.join(DATA, 'users', String(uid), 'files');
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  const canceled = () => {
    try { return Number((db.prepare('SELECT cancel_flag FROM jobs WHERE id=?').get(row.id) || {}).cancel_flag || 0) === 1; }
    catch (e) { return false; }
  };

  db.prepare("UPDATE jobs SET status='running', started_at=?, progress=0, stage='准备中' WHERE id=?").run(now(), row.id);

  const ctx = {
    uid: uid, db: db, files: files,
    progress: function (p, stage) {
      if (canceled()) throw new Error('__canceled__');
      try {
        db.prepare('UPDATE jobs SET progress=?, stage=? WHERE id=?')
          .run(Math.max(0, Math.min(1, Number(p) || 0)), stage || null, row.id);
      } catch (e) {}
    },
  };

  const jobCtx = { uid: uid, db: db, files: files };
  try {
    const fn = JOB_TYPES[row.type];
    if (!fn) throw new Error('未知任务类型 ' + row.type);
    const payload = row.payload_json ? safeJson(row.payload_json) : {};
    const result = await RLS.run(jobCtx, function () { return fn(payload || {}, ctx); });
    db.prepare("UPDATE jobs SET status='done', progress=1, stage='完成', result_json=?, finished_at=? WHERE id=?")
      .run(JSON.stringify(result === undefined ? null : result), now(), row.id);
  } catch (e) {
    const isCancel = String(e && e.message) === '__canceled__';
    db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?')
      .run(isCancel ? 'canceled' : 'failed', isCancel ? null : String(e && e.message || e), now(), row.id);
  }
}

function apiJobCreate(body) {
  const type = String(body.type || '');
  if (!type) throw new Error('没有任务类型');
  if (!JOB_TYPES[type]) throw new Error('这个版本还不支持任务 ' + type);
  const r = ctxDb().prepare('INSERT INTO jobs (type, payload_json, stage) VALUES (?,?,?)')
    .run(type, JSON.stringify(body.payload || {}), '排队中');
  jobsStart();
  return { ok: true, id: Number(r.lastInsertRowid) };
}

function apiJobGet(body) {
  const id = Number(body.id);
  if (!id) {
    const rows = ctxDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 10').all();
    return { ok: true, items: rows.map(jobRowToJson) };
  }
  return { ok: true, job: jobRowToJson(ctxDb().prepare('SELECT * FROM jobs WHERE id=?').get(id)) };
}

function apiJobCancel(body) {
  const id = Number(body.id);
  if (!id) throw new Error('没有任务号');
  ctxDb().prepare("UPDATE jobs SET cancel_flag=1 WHERE id=? AND status IN ('queued','running')").run(id);
  const row = ctxDb().prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (row && row.status === 'queued') {
    ctxDb().prepare("UPDATE jobs SET status='canceled', finished_at=datetime('now') WHERE id=?").run(id);
  }
  return { ok: true };
}

/* 自检任务：设置页的「跑一次自检」用它，也是队列的验收用例 */
registerJob('selftest', async function (p, ctx) {
  const steps = Math.max(1, Number(p.steps) || 6);
  const ms = Math.max(10, Number(p.ms) || 120);
  for (let i = 1; i <= steps; i++) {
    await new Promise(function (r) { setTimeout(r, ms); });
    ctx.progress(i / steps, '第 ' + i + '/' + steps + ' 步');
  }
  return { steps: steps };
});


/* ---------------- 语音合成（TTS）：云端 + 文本级缓存 ---------------- */

function ttsKey(text, voice, speed, model) {
  return crypto.createHash('sha1')
    .update([text, voice, speed, model].join('|')).digest('hex').slice(0, 20);
}

/**
 * 把一段文字合成 mp3。命中缓存直接返回路径——同一句话读十次只付一次钱。
 * 供应商走 OpenAI 兼容的 /audio/speech；没有可用模型时返回 fallback:'system'，
 * 前端据此退回系统朗读（安卓 TextToSpeech / 浏览器 speechSynthesis）。
 */
async function apiTts(body) {
  const text = String(body.text || '').trim();
  if (!text) return { ok: false, message: '没有要读的文字' };
  if (text.length > 2000) return { ok: false, message: '一次最多 2000 字，长文请分段读' };

  const chain = profileChain({ slot: 'tts', profileId: body.profileId, model: body.model });
  if (!chain.length) {
    return { ok: false, fallback: 'system', message: '还没配「朗读」用的模型，先用系统音色读' };
  }

  const speed = Number(body.speed) || 1;
  const dir = path.join(ctxFiles(), 'ai', 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const errors = [];

  // 音色名各家不一样，写法还带坑：
  //   · OpenAI 是 alloy/nova…
  //   · 硅基流动的 CosyVoice2 必须写成「模型名:音色名」，只给 anna 会报 20047 Invalid voice（实测）
  // 所以按供应商拼默认值；用户自己传了带冒号的，就用他的。
  const VOICE_BY_KIND = { siliconflow: 'anna' };

  for (const cand of chain.slice(0, 3)) {
    const model = cand.model || 'tts-1';
    let voice = String(body.voice || '');
    if (!voice) {
      const short = VOICE_BY_KIND[cand.profile.kind];
      voice = short ? (model.indexOf(':') >= 0 ? model : model + ':' + short) : 'alloy';
    }
    const key = ttsKey(text, voice, speed, model);

    try {
      const hit = ctxDb().prepare('SELECT path FROM ai_assets WHERE cache_key=?').get(key);
      if (hit && hit.path && fs.existsSync(path.join(ctxFiles(), hit.path))) {
        return { ok: true, path: hit.path, cached: true, model: model };
      }
    } catch (e) { /* 老库没有 ai_assets 也不会崩 */ }

    try {
      const r = await fetch(endpointOf(cand.profile) + '/audio/speech', {
        method: 'POST',
        headers: authHeaders(cand.profile),
        body: JSON.stringify({
          model: model, input: text, voice: voice, speed: speed, response_format: 'mp3',
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        errors.push(cand.profile.name + ' HTTP ' + r.status + '：' + String(t).slice(0, 120));
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { errors.push(cand.profile.name + ' 返回空音频'); continue; }

      const rel = 'ai/tts/' + key + '.mp3';
      fs.writeFileSync(path.join(ctxFiles(), rel), buf);
      try {
        ctxDb().prepare('INSERT INTO ai_assets (capability, cache_key, path, prompt, model) VALUES (?,?,?,?,?)')
          .run('tts', key, rel, text.slice(0, 200), model);
      } catch (e) {}
      usageAdd('tts', model, text.length, 'char', 0, 'tts');
      return { ok: true, path: rel, bytes: buf.length, model: model, cached: false };
    } catch (e) {
      errors.push(cand.profile.name + ' 连不上：' + (e.message || e));
    }
  }

  return {
    ok: false, fallback: 'system',
    message: '云端朗读没成，已退回系统音色：' + errors.join('；'),
  };
}


/* ---------------- 插图生成（文生图） ---------------- */

function imgKey(prompt, model, size) {
  return crypto.createHash('sha1').update([prompt, model, size].join('|')).digest('hex').slice(0, 20);
}

/** 是不是文生图模型：与 web/db.js 的 modelKind（t2i 一类）保持一致 */
function isImageModel(model) {
  const s = String(model || '').toLowerCase();
  return /kolors|flux|cogview|qwen-image|z-image|stable-diffusion|sdxl|dall|imagen|seedream|janus|playground|ideogram|aura|sd3|dream/i.test(s);
}

/** 把供应商返回的报错整理成可读文字，避免原始 body 在某些构建里出现 [object Object] 之类乱码 */
function describeErr(r) {
  const j = r && r.json;
  if (j && typeof j === 'object') {
    if (j.message) return '(' + (j.code != null ? j.code + ' ' : '') + j.message + ')';
    try { return JSON.stringify(j); } catch (e) {}
  }
  return String((r && r.text) || '').slice(0, 150);
}

/**
 * 生成一张插图。供应商走 OpenAI 兼容的 /images/generations。
 * 硅基流动返回的是临时 URL（会过期），所以必须当场下载落盘，不能只存链接。
 * 同一段描述 + 同一模型 + 同一尺寸 = 同一张图，缓存命中直接返回。
 */
async function apiImage(body) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return { ok: false, message: '没有画面描述' };
  if (prompt.length > 1200) return { ok: false, message: '画面描述太长了（最多 1200 字）' };

  const chain = profileChain({ slot: 'img', profileId: body.profileId, model: body.model });
  if (!chain.length) {
    return {
      ok: false, fallback: 'none',
      message: '还没配「图片生成」的模型。设置 → 模型来源里绑一条，模型填 Kwai-Kolors/Kolors（免费）。',
    };
  }

  const size = /^\d{3,4}x\d{3,4}$/.test(String(body.size || '')) ? String(body.size) : '1024x1024';
  const dir = path.join(ctxFiles(), 'ai', 'img');
  fs.mkdirSync(dir, { recursive: true });
  const errors = [];
  // 参考图（可选）：带上它时缓存键也要变，否则换了参考图还命中旧图。
  // 循环外先声明——失败兜底那段（拼 refHint）也要用到它。
  const refB64 = body.refImage ? String(body.refImage).replace(/^data:[^,]*,/, '') : '';

  for (const cand of chain.slice(0, 2)) {
    // 图片模型必须真的是文生图模型。slot 走「默认 / 按规则」回退时，拿到的往往是该配置的
    // 文本默认模型（如 Qwen3-8B）；拿文本模型去调 /images/generations，硅基流动会判成
    // 非法操作，返回 403 code 30000 Illegal operation。所以这里强制：用户没显式指定模型时，
    // 只用图像模型，否则一律回退到免费的 Kwai-Kolors/Kolors。
    const model = body.model
      ? String(body.model)
      : (cand.model && isImageModel(cand.model) ? cand.model : 'Kwai-Kolors/Kolors');
    const key = imgKey(prompt + (refB64 ? '|ref:' + refB64.length + ':' + refB64.slice(0, 24) : ''), model, size);

    try {
      const hit = body.again ? null
        : ctxDb().prepare("SELECT path FROM ai_assets WHERE cache_key=? AND capability='image'").get(key);
      if (hit && hit.path && fs.existsSync(path.join(ctxFiles(), hit.path))) {
        return { ok: true, path: hit.path, cached: true, model: model };
      }
    } catch (e) {}

    // 参考图：只有部分模型（图生图）认 `image` 字段。不认的服务商直接 500/400，
    // 所以带参考图失败时自动退回纯文字再画一次——宁可少一张参考，也不能让用户点了没结果。
    const attempts = refB64 ? [true, false] : [false];
    for (let ai = 0; ai < attempts.length; ai++) {
      const withRef = attempts[ai];
      try {
        const t0 = Date.now();
        const r = await fetchJson(endpointOf(cand.profile) + '/images/generations', {
          method: 'POST',
          headers: authHeaders(cand.profile),
          body: JSON.stringify((function () {
            const pl = {
              model: model,
              prompt: prompt,
              image_size: size,
              batch_size: 1,
              num_inference_steps: Number(body.steps) || 20,
              guidance_scale: Number(body.cfg) || 7.5,
            };
            if (withRef) pl.image = refB64;
            return pl;
          })()),
        }, 180000);

        if (!r.ok) {
          errors.push(cand.profile.name + (withRef ? '（带参考图）' : '') + ' HTTP ' + r.status + '：' + describeErr(r));
          continue;
        }
        const j = r.json || {};
        const item = (j.images && j.images[0]) || (j.data && j.data[0]) || null;
        if (!item) { errors.push(cand.profile.name + ' 没返回图片'); continue; }

        let buf = null;
        const url = String(item.url || '');
        if (url.indexOf('data:') === 0) {
          buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
        } else if (item.b64_json) {
          buf = Buffer.from(String(item.b64_json), 'base64');
        } else if (/^https?:/.test(url)) {
          const img = await fetch(url);
          if (!img.ok) { errors.push('图床取图失败 ' + img.status); continue; }
          buf = Buffer.from(await img.arrayBuffer());
        }
        if (!buf || !buf.length) { errors.push(cand.profile.name + ' 图片是空的'); continue; }

        // 退回纯文字画出来的图，要按「不含参考图」的键落缓存，否则下次纯文字请求命中不到
        const finalKey = withRef ? key : imgKey(prompt, model, size);
        const rel = 'ai/img/' + finalKey + '.jpg';
        fs.writeFileSync(path.join(ctxFiles(), rel), buf);
        try {
          ctxDb().prepare('INSERT INTO ai_assets (capability, cache_key, path, prompt, model) VALUES (?,?,?,?,?)')
            .run('image', finalKey, rel, prompt.slice(0, 300), model);
        } catch (e) {}
        usageAdd('image', model, 1, 'image', 0, 'image');

        return {
          ok: true, path: rel, bytes: buf.length, model: model, ms: Date.now() - t0, cached: false,
          refIgnored: !!refB64 && !withRef,
          note: (!withRef && refB64)
            ? '这个模型不认参考图，已按提示词重新画一张。想严格照着照片画，请在「设置 → 图片生成」里换一个支持图生图的模型。'
            : '图片由 AI 生成，服务商会在角落加标识',
        };
      } catch (e) {
        errors.push(cand.profile.name + (withRef ? '（带参考图）' : '') + ' 连不上：' + (e.message || e));
      }
    }
  }

  const only = errors.join('；');
  const refHint = refB64 && /HTTP (4|5)\d\d/.test(only)
    ? '（带参考图的请求被服务商拒了，已自动改成纯文字重画；要给模型参考图，得换支持图生图的模型）' : '';
  return {
    ok: false,
    message: '没画出来：' + only + refHint +
      '。请到「设置 → 模型来源」把「图片生成」这一环选成硅基流动免费档，模型填 Kwai-Kolors/Kolors，并填好 API Key。',
  };
}

/* ---------------- 媒体渲染：ffmpeg 探测 ---------------- */

/**
 * ffmpeg 随 exe 一起分发（内置资源），首次用到时解到 data/bin 下。
 * 为什么不在 resources/ 里直接放：单文件分发时只有一个 exe，没有 resources 目录。
 */
function ffmpegPath() {
  const binDir = path.join(DATA, 'bin');
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const target = path.join(binDir, exeName);

  if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) {
    return target;
  }

  const asset = assetGet('bin/' + exeName);
  const onDisk = path.join(ROOT, 'bin', exeName);
  let buf = null;
  if (asset && asset.length) buf = asset;
  else if (fs.existsSync(onDisk)) buf = fs.readFileSync(onDisk);

  if (!buf || buf.length < 1024 * 1024) return null;

  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(target, buf);
    try { fs.chmodSync(target, 0o755); } catch (e) {}
    return target;
  } catch (e) {
    console.warn('[ffmpeg] 解包失败：', e.message);
    return null;
  }
}

function apiRenderProbe() {
  const bin = ffmpegPath();
  if (!bin) {
    return { ok: false, message: '这个包里没有 ffmpeg（构建时未内置），短片与混音导出用不了' };
  }
  try {
    const r = require('child_process').spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
    const first = String(r.stdout || '').split('\n')[0] || '';
    return {
      ok: r.status === 0, path: bin, version: first.trim(),
      bytes: fs.statSync(bin).size,
      encoders: true,
    };
  } catch (e) {
    return { ok: false, message: 'ffmpeg 调不起来：' + (e.message || e) };
  }
}


/* ---------------- 短片合成（P7）：ffmpeg 管线 ----------------
 *
 * 一条片子怎么出来的（每帧都带音轨，这样 concat 不会挑三拣四）：
 *   图 → 竖屏裁切 + 缓慢运镜 → 与配音（或静音）合成一段 mp4
 *   → concat 拼起来 → 烧字幕（ASS）+ 混 BGM → 成片
 *
 * 两个刻意的选择：
 *   ① **不用 AI 动态画面**。静态图 + 运镜 + 字幕 + 配音已经有片子的感觉，
 *      成本为零；真调视频模型一秒 0.5–2 元，三分钟片子几百块，不值。
 *   ② **字幕烧进画面**，不挂外挂字幕。发微信、发抖音的人不会去加载 srt。
 */

const MOVIE_W = 1080, MOVIE_H = 1920, MOVIE_FPS = 25;

function runFfmpeg(bin, args, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    const { spawn } = require('child_process');
    let p;
    try {
      p = spawn(bin, args, { windowsHide: true, cwd: o.cwd });
    } catch (e) { return reject(e); }
    let err = '';
    if (p.stderr) p.stderr.on('data', function (d) {
      err += String(d);
      if (err.length > 12000) err = err.slice(-6000);
    });
    const timer = setTimeout(function () {
      try { p.kill(); } catch (e) {}
      reject(new Error('渲染超时' + (o.what ? '（' + o.what + '）' : '')));
    }, o.timeout || 300000);
    p.on('error', function (e) { clearTimeout(timer); reject(e); });
    p.on('close', function (code) {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      const tail = String(err).split('\n').filter(Boolean).slice(-3).join(' | ');
      reject(new Error('ffmpeg 失败（' + code + '）：' + tail.slice(0, 300)));
    });
  });
}

/**
 * 图片能不能解。
 *
 * 必须单独检一遍，不能只靠 existsSync：ffmpeg 的 image2 是按**扩展名**选解码器的，
 * 一张 .jpg 里装着 PNG 数据时，mjpeg 解码器会一直等后续字节——既不报错也不出帧，
 * 整个任务就挂在那儿。宁可多花几十毫秒，也不要用户盯着进度条停在 28%。
 */
function imageOk(bin, file) {
  try {
    const r = require('child_process').spawnSync(bin,
      ['-hide_banner', '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

/** 读一段媒体的时长（秒）。没有 ffprobe，就从 ffmpeg 的 stderr 里抠 */function mediaSeconds(bin, file) {
  try {
    const r = require('child_process').spawnSync(bin, ['-hide_banner', '-i', file],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr || ''));
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch (e) { return 0; }
}

/* ---------- 程序化配乐：算出来的，不是素材 ----------
 *
 * 早先这里只叠了三路正弦（amix 后再 volume 0.09），实测成片 mean_volume −57dB、max −48dB
 * ——等于没有声音，用户听到的就是「配的背景音乐没响」。纯正弦也没有音乐性，嗡嗡一片。
 * 这里改成一段真和弦进行：八分音符琶音 + 低八度长音铺底 + 左右声道轻微失谐，
 * 仍然不打包任何音频素材（体积为零、不涉版权、断网也算得出来）。
 */
const BGM_PROG = {
  calm: { bar: 4.0, chords: [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]] },
  warm: { bar: 4.4, chords: [[53, 57, 60, 65], [50, 53, 57, 62], [46, 50, 53, 58], [48, 52, 55, 60]] },
  bright: { bar: 3.6, chords: [[57, 61, 64, 69], [54, 57, 61, 66], [50, 54, 57, 62], [52, 56, 59, 64]] },
  old: { bar: 5.0, chords: [[50, 53, 57, 62], [46, 50, 53, 58], [43, 46, 50, 55], [45, 49, 52, 57]] },
};

/** MIDI 音高 → 频率。69 = A4 = 440Hz */
function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function wavHeader(buf, dataBytes, sr, ch) {
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
}

/** 往两块缓冲区里叠一个音：pluck 是拨弦（快起快落），pad 是铺底（慢起慢收） */
function addNote(L, R, SR, hz, startSec, durSec, amp, kind) {
  const n0 = Math.round(startSec * SR);
  const n = Math.min(Math.round(durSec * SR), L.length - n0);
  if (n <= 0) return;
  const pad = kind === 'pad';
  const atk = pad ? 0.45 : 0.008;
  const dec = pad ? 0.22 : 2.2;
  const harm = pad ? [[1, 1], [2, 0.22], [3, 0.08]]
    : [[1, 1], [2, 0.46], [3, 0.22], [4, 0.11]];
  const detune = 1.0009;                 // 右声道差一点点，听上去更宽
  const fadeFrom = durSec - 0.3;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = Math.min(1, t / atk) * Math.exp(-t * dec);
    if (t > fadeFrom) env *= Math.max(0, (durSec - t) / 0.3);
    if (env < 2e-4) continue;
    let sL = 0, sR = 0;
    for (let h = 0; h < harm.length; h++) {
      const k = harm[h][0], a = harm[h][1];
      const ph = 6.283185307 * hz * k * t;
      sL += a * Math.sin(ph);
      sR += a * Math.sin(ph * detune + 0.35);
    }
    const g = env * amp;
    L[n0 + i] += sL * g;
    R[n0 + i] += sR * g;
  }
}

/**
 * 生成一条配乐 wav。逐小节渲染后立刻落盘，避免十几分钟的片子把内存吃满。
 * 返回文件路径；算不出来就返回空串（宁可只有配音，也不要整片失败）。
 */
function synthBgm(style, seconds, outFile) {
  const cfg = BGM_PROG[style] || BGM_PROG.calm;
  const SR = 44100;
  const total = Math.max(4, Number(seconds) || 0) + 1.5;
  const barSec = cfg.bar;
  const barN = Math.max(1, Math.ceil(total / barSec));
  const barSamples = Math.round(barSec * SR);
  const dataBytes = barN * barSamples * 4;

  let fd;
  try {
    fd = fs.openSync(outFile, 'w');
    const head = Buffer.alloc(44);
    wavHeader(head, dataBytes, SR, 2);
    fs.writeSync(fd, head);

    const L = new Float32Array(barSamples);
    const R = new Float32Array(barSamples);
    const pcm = Buffer.alloc(barSamples * 4);

    for (let b = 0; b < barN; b++) {
      L.fill(0); R.fill(0);
      const ch = cfg.chords[b % cfg.chords.length];
      // 低音铺底：根音与三音各低一个八度
      addNote(L, R, SR, midiHz(ch[0] - 12), 0, barSec, 0.16, 'pad');
      addNote(L, R, SR, midiHz(ch[1] - 12), 0, barSec, 0.10, 'pad');
      // 八分音符琶音：上行四音再下行，后半小节抬八度
      const step = barSec / 8;
      const seq = [0, 1, 2, 3, 2, 1, 0, 1];
      for (let k = 0; k < 8; k++) {
        const note = ch[seq[k]] + (k >= 4 ? 12 : 0);
        const dur = Math.min(2.0, barSec - k * step);
        addNote(L, R, SR, midiHz(note), k * step, dur, 0.085, 'pluck');
      }
      // 转 16bit PCM 写盘
      for (let i = 0; i < barSamples; i++) {
        const l = Math.max(-1, Math.min(1, L[i]));
        const r = Math.max(-1, Math.min(1, R[i]));
        pcm.writeInt16LE(Math.round(l * 32767), i * 4);
        pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
      }
      fs.writeSync(fd, pcm);
    }
    fs.closeSync(fd);
    return outFile;
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (e2) {}
    console.warn('[bgm] 配乐没算出来：', e.message);
    return '';
  }
}

/** ASS 的时间是「时:分:秒.百分秒」——毫秒必须除 10，写成 .500 会被当成 5 秒 */
function assTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const whole = Math.floor(s);
  const cs = Math.round((s - whole) * 100);
  const pad = function (n, w) { return String(n).padStart(w || 2, '0'); };
  return h + ':' + pad(m) + ':' + pad(whole) + '.' + pad(cs === 100 ? 99 : cs);
}

/** 服务端也要一份换行：libass 对超宽长句的自动换行不可靠，得自己插 \N */
function wrapSub(text, perLine, maxLines) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const lines = [];
  let cur = '', w = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    const cw = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
    if (w + cw > perLine + 0.001) { lines.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines || 4).join('\\N');
}

/** ASS 里 { } 是样式指令的语法，正文里出现会被 libass 吞掉，换成全角 */
function assEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\{/g, '（').replace(/\}/g, '）');
}

/* ---------------- 把一首歌真的「演奏」出来 ----------------
 *
 * 写歌档过去只出歌词：用户得自己拿去别的工具里唱。这里补上后半截——
 * ① 用模型合成人声（沿用 /api/tts 的缓存，同一段词不重复付费）
 * ② 用 synthBgm 算一段同长度、同风格的伴奏
 * ③ ffmpeg 混成一条 mp3，能听、能下载、能存进档案
 * 没人声时（没配朗读模型 / 用户只想听曲）只出纯伴奏，照样能用。
 */
async function apiSongMake(body) {
  const lyrics = String(body.lyrics || '').trim();
  if (!lyrics) return { ok: false, message: '没有歌词' };
  if (lyrics.length > 2000) return { ok: false, message: '歌词一次最多 2000 字' };

  const style = String(body.style || 'calm');
  if (!BGM_PROG[style]) return { ok: false, message: '没有这种曲风' };
  const wantVoice = body.voice !== false;

  const bin = ffmpegPath();
  const key = crypto.createHash('sha1')
    .update([lyrics, style, wantVoice ? 'v' : 'i'].join('|')).digest('hex').slice(0, 16);
  const dirAbs = path.join(ctxFiles(), 'ai', 'song', key);
  const outRel = path.posix.join('ai/song', key, 'song.mp3');
  fs.mkdirSync(dirAbs, { recursive: true });

  // 已经演过的版本直接给（没有 lyric 缓存表里那种跨 lip 的复用，靠路径存在与否判断）
  if (fs.existsSync(path.join(dirAbs, 'song.mp3'))) {
    const st = fs.statSync(path.join(dirAbs, 'song.mp3'));
    return { ok: true, path: outRel, bytes: st.size, seconds: mediaSeconds(bin, path.join(dirAbs, 'song.mp3')), cached: true };
  }

  // ① 人声
  let voiceAbs = '', voiceSec = 0, voiceNote = '';
  if (wantVoice) {
    const r = await apiTts({ text: lyrics, profileId: body.profileId, model: body.model, speed: body.speed });
    if (r && r.ok && r.path) {
      voiceAbs = path.join(ctxFiles(), r.path);
      voiceSec = mediaSeconds(bin, voiceAbs);
    } else {
      voiceNote = (r && r.message) || '没合成出人声，这版只有伴奏';
    }
  }

  // ② 伴奏：有人声就跟人声同长；没有就按字数估（约 6 字/秒，唱总比念慢）
  const estSec = voiceSec || Math.max(6, lyrics.replace(/\s/g, '').length / 6);
  const bgmAbs = path.join(dirAbs, 'bgm.wav');
  const bgmWav = synthBgm(style, estSec, bgmAbs);
  if (!bgmWav) return { ok: false, message: '伴奏没算出来' };

  // ③ 混音：有人声时伴奏压低做人声的垫子，纯伴奏则保持原音量
  const total = estSec + 2.0;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'bgm.wav'];
  let fc, mapA;
  if (voiceAbs) {
    args.push('-i', voiceAbs);
    fc = '[0:a]volume=' + (wantVoice ? 0.5 : 1.0) +
      ',afade=t=in:st=0:d=1.2,afade=t=out:st=' + (Math.max(0, total - 3)).toFixed(2) + ':d=2.6[bg];' +
      '[1:a]volume=1.9[va];[va][bg]amix=inputs=2:duration=first:dropout_transition=0,' +
      'alimiter=limit=0.94[a]';
    mapA = '[a]';
  } else {
    fc = '[0:a]volume=0.9,afade=t=in:st=0:d=1.2,' +
      'afade=t=out:st=' + (Math.max(0, total - 3)).toFixed(2) + ':d=2.6[a]';
    mapA = '[a]';
  }
  args.push('-filter_complex', fc, '-map', mapA,
    '-c:a', 'libmp3lame', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-t', String(total.toFixed(2)),
    '-y', 'song.mp3');

  try {
    await runFfmpeg(bin, args, { cwd: dirAbs, what: '演奏这首歌', timeout: 180000 });
  } catch (e) {
    return { ok: false, message: '混音失败：' + ((e && e.message) || e) };
  }
  try { fs.unlinkSync(bgmAbs); } catch (e) {}

  const outAbs = path.join(dirAbs, 'song.mp3');
  if (!fs.existsSync(outAbs)) return { ok: false, message: '没出成品' };
  const st = fs.statSync(outAbs);
  return {
    ok: true, path: outRel, bytes: st.size,
    seconds: Math.round(mediaSeconds(bin, outAbs) * 10) / 10,
    voice: !!voiceAbs, voiceNote: voiceNote, style: style,
  };
}


/**
 * 字幕样式分两类：
 *   ① 有图的格子 —— 底部字幕，半透明黑底框（BorderStyle=3），字号 62
 *   ② 没图的格子 —— 整屏换成「文字卡」：米色纸底 + 居中大字 + 顶部章节小标
 * 用户的原话是「没有图片的章节全黑的……至少要像播放 PPT 一样能看清楚」，
 * 所以没图时正文直接当画面主体排版，不再是一条压在黑底上的字幕。
 */
function buildAss(title, frames) {
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: ' + MOVIE_W,
    'PlayResY: ' + MOVIE_H,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
      'Alignment, MarginL, MarginR, MarginV, Encoding',
    // 有图：底部字幕，白字 + 半透明黑底框（BorderStyle=3 时 Outline 是框的留白像素）
    'Style: Sub,Microsoft YaHei,66,&H00FFFFFF,&H00FFFFFF,&HA0000000,&HA0000000,' +
      '0,0,0,0,100,100,1,0,3,14,0,2,70,70,220,1',
    // 无图：米色纸底上的深褐正文，居中，不加描边
    'Style: Card,Microsoft YaHei,80,&H00121B22,&H00121B22,&H00F6F0E2,&H00F6F0E2,' +
      '0,0,0,0,100,100,2,0,1,0,0,5,100,100,0,1',
    // 无图：顶部章节小标
    'Style: Kick,Microsoft YaHei,40,&H007A6A4E,&H007A6A4E,&H00F6F0E2,&H00F6F0E2,' +
      '0,0,0,0,100,100,6,0,1,0,0,8,80,80,200,1',
    // 片头：有封面图时的大标题
    'Style: Title,Microsoft YaHei,92,&H00FFFFFF,&H00FFFFFF,&H00140F08,&H00140F08,' +
      '0,0,0,0,100,100,3,0,1,6,3,5,80,80,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  let t = 0;
  for (const f of frames) {
    const d = Number(f.sec) || 3;
    const a = assTime(t), b = assTime(t + d);
    const text = assEsc(f.text || '');
    if (f.hasImage) {
      if (text) {
        head.push('Dialogue: 0,' + a + ',' + b + ',' +
          (f.kind === 'title' ? 'Title' : 'Sub') + ',,0,0,0,,' +
          wrapSub(text, f.kind === 'title' ? 9 : 13, 4));
      }
    } else {
      // 文字卡：上面一行章节小标，中间正文当主角
      const kick = assEsc(f.kicker || '');
      if (kick) head.push('Dialogue: 0,' + a + ',' + b + ',Kick,,0,0,0,,' + kick);
      if (text) head.push('Dialogue: 0,' + a + ',' + b + ',Card,,0,0,0,,' + wrapSub(text, 11, 6));
    }
    t += d;
  }
  if (!frames.length && title) head.push('Dialogue: 0,0:00:00.00,0:00:03.00,Card,,0,0,0,,' + assEsc(title));
  return head.join('\n') + '\n';
}

/** 每帧的运镜。奇偶交替推/拉，节奏上比一路推近耐看 */
function zoomExpr(i) {
  if (i % 2 === 0) return "z='min(zoom+0.00055,1.13)'";
  return "z='if(eq(on,1),1.13,max(zoom-0.00055,1.0))'";
}

/**
 * 字幕一行放得下多少字：竖屏 + 58px 字号，一行 13 个字，最多四行。
 * 长段落不再一刀切成 80 字丢掉后半截，而是按句子切成多格——内容多的章，片子自然更长。
 */
function splitSubtitle(text, limit) {
  const max = limit || 50;
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return [s];
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    buf += ch;
    const isEnd = '。！？；'.indexOf(ch) >= 0;
    if ((isEnd && buf.length >= max * 0.5) || buf.length >= max) {
      out.push(buf.trim()); buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 分镜规划。规则决定，不花模型的钱：
 * 一段讲述可能拆成几格（字幕一行 13 字，四行封顶）；时长按字数走；图取条目自带的照片，没有就按章内顺序轮。
 * 不传 chapterId = 整本档案，按章节顺序一路排下去。
 */
function apiMoviePlan(body) {
  const aid = Number(body.archiveId);
  const chId = Number(body.chapterId) || 0;
  if (!aid) throw new Error('要指定档案');
  const a = ctxDb().prepare('SELECT * FROM archives WHERE id=?').get(aid);
  if (!a) throw new Error('找不到这本档案');
  const ch = chId ? ctxDb().prepare('SELECT * FROM chapters WHERE id=?').get(chId) : null;

  const rawEntries = chId
    ? ctxDb().prepare('SELECT * FROM entries WHERE chapter_id=? ORDER BY COALESCE(sort_key,seq,0), id').all(chId)
    : ctxDb().prepare(
      'SELECT e.*, c.title AS chapter_title FROM entries e LEFT JOIN chapters c ON c.id=e.chapter_id ' +
      "WHERE e.archive_id=? AND e.kind IN ('text','quote') " +
      'ORDER BY COALESCE(c.seq, 999999), COALESCE(e.sort_key, e.seq, 0), e.id').all(aid);
  const entries = rawEntries.filter(function (e) { return String(e.text || '').trim().length > 0; });
  if (!entries.length) throw new Error(chId ? '这一章还没有讲述，先攒几段再来' : '这本档案还没有文字内容');

  const photos = chId
    ? ctxDb().prepare('SELECT * FROM photos WHERE chapter_id=? ORDER BY taken_year, taken_month, id').all(chId)
    : ctxDb().prepare('SELECT * FROM photos WHERE archive_id=? ORDER BY taken_year, taken_month, id').all(aid);
  const byId = {};
  for (const ph of photos) byId[ph.id] = ph;
  const used = {};
  let cursor = 0;

  const cover = ctxDb().prepare(
    'SELECT p.path FROM photos p WHERE p.id=?').get(a.cover_photo_id || -1);

  const frames = [];
  if (cover && cover.path) {
    frames.push({
      image: cover.path,
      text: a.subject_name + (a.birth_year ? ' · ' + a.birth_year : ''),
      sec: 2.6, kind: 'title',
    });
  }

  // 整本排下来可能很长：格数和总时长都留个上限，超了就截断，并在返回里告诉人
  const MAX_FRAMES = 160;
  const MAX_SECONDS = 900;   // 15 分钟封顶
  let totalSec = 0;
  let truncated = 0;

  entries.forEach(function (en) {
    if (frames.length >= MAX_FRAMES || totalSec >= MAX_SECONDS) { truncated++; return; }
    const text = String(en.text || '').trim();
    let ph = en.photo_id ? byId[en.photo_id] : null;
    if (!ph) {
      while (cursor < photos.length && used[photos[cursor].id]) cursor++;
      if (cursor < photos.length) { ph = photos[cursor]; used[ph.id] = 1; cursor++; }
    } else { used[ph.id] = 1; }

    // 文字卡顶部那行小标：章节名 + 年份。没图的格子靠它交代「现在讲到哪儿」。
    // 正文里已经提到这一年就不重复了——否则会出现「1941 年」压着「生于1927年」的怪画面。
    const chName = String((ch && ch.title) || en.chapter_title || '')
      .replace(/^[^·]*·\s*/, '').trim();

    // 一段可能切成好几格：字幕一行 13 字、最多四行，所以一格不超过 50 字，内容一句不丢
    const parts = splitSubtitle(text, 50);
    parts.forEach(function (piece, pi) {
      if (frames.length >= MAX_FRAMES || totalSec >= MAX_SECONDS) { truncated++; return; }
      const sec = Math.min(12, Math.max(2.8, 2.4 + piece.length / 9));
      const yearInLine = en.at_year && String(piece).indexOf(String(en.at_year)) >= 0;
      const kicker = [chName, en.at_year && !yearInLine ? en.at_year + ' 年' : '']
        .filter(Boolean).join(' · ') || a.subject_name;
      frames.push({
        image: ph ? ph.path : null,
        text: piece,
        sec: Math.round(sec * 10) / 10,
        year: en.at_year || null,
        entryId: en.id,
        part: pi ? pi + 1 : 0,
        kicker: kicker,
      });
      totalSec += Math.round(sec * 10) / 10;
    });
  });

  const total = frames.reduce(function (s, f) { return s + f.sec; }, 0);
  return {
    ok: true,
    title: (ch && ch.title) || a.subject_name,
    name: a.subject_name,
    archiveNo: a.archive_no || '',
    frames: frames,
    seconds: Math.round(total * 10) / 10,
    missing: frames.filter(function (f) { return !f.image; }).length,
    truncated: truncated,
    entries: entries.length,
    hasFfmpeg: !!ffmpegPath(),
  };
}

/**
 * 真正的合成。走任务队列：几十秒到几分钟的活，不能挂在 HTTP 请求上等。
 * 返回 { path, seconds, bytes }
 */
registerJob('movie', async function (p, ctx) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('这个安装包没带 ffmpeg，合成不了短片。用桌面版，或先跑 tools/fetch-ffmpeg.js 重新打包。');

  const frames = (p.frames || []).filter(function (f) { return f && (f.image || f.text); });
  if (!frames.length) throw new Error('没有可用的分镜');

  const bgmName = String(p.bgm || 'none');
  const wantVoice = !!p.voice;

  const key = crypto.createHash('sha1')
    .update(JSON.stringify([p.title, frames, bgmName, wantVoice])).digest('hex').slice(0, 16);
  const relDir = 'ai/movie/' + key;
  const absDir = path.join(ctx.files, 'ai', 'movie', key);
  fs.mkdirSync(absDir, { recursive: true });

  const outRel = relDir + '/movie.mp4';
  const outAbs = path.join(absDir, 'movie.mp4');

  // 配音：先试一句探通不通，再逐帧合成。
  // 早先这里是「失败就静音过去」，结果用户拿到一条 73 秒的哑片，界面上一个字都没解释。
  // 现在探不通直接中止，并把「去哪儿配」写进报错；探通了也记下成功/失败格数给前端看。
  const voiceStat = { want: wantVoice, done: 0, failed: 0, reason: '' };
  if (wantVoice) {
    ctx.progress(0.02, '检查朗读模型');
    let probe = null;
    try {
      probe = await apiTts({ text: '好', speed: p.speed || 1 });
    } catch (e) {
      probe = { ok: false, message: e.message || String(e) };
    }
    if (!probe || !probe.ok) {
      voiceStat.reason = (probe && probe.message) || '朗读模型没配好';
      throw new Error('配音做不了：' + voiceStat.reason +
        '。请去「设置 → 各环节用哪个模型 → 语音朗读」绑一个语音模型' +
        '（硅基流动可以用 FunAudioLLM/CosyVoice2-0.5B，免费），' +
        '或者把「配音」取消勾选，只出画面与配乐。');
    }

    for (let i = 0; i < frames.length; i++) {
      ctx.progress(0.03 + (i / frames.length) * 0.24, '配音 ' + (i + 1) + '/' + frames.length);
      if (!frames[i].text) continue;
      try {
        const r = await apiTts({ text: frames[i].text, speed: p.speed || 1 });
        if (r && r.ok && r.path) {
          frames[i].voiceFile = path.join(ctx.files, r.path);
          const d = mediaSeconds(bin, frames[i].voiceFile);
          if (d > 0) frames[i].sec = Math.max(Number(frames[i].sec) || 2.8, Math.round((d + 0.45) * 10) / 10);
          voiceStat.done++;
        } else {
          voiceStat.failed++;
          if (!voiceStat.reason) voiceStat.reason = (r && r.message) || '有一段没合成出来';
        }
      } catch (e) {
        voiceStat.failed++;
        if (!voiceStat.reason) voiceStat.reason = e.message || String(e);
      }
    }
    if (voiceStat.done === 0) {
      throw new Error('配音全失败了：' + (voiceStat.reason || '朗读模型没响应') +
        '。可以先取消勾选「配音」，只出画面与配乐。');
    }
  }

  // 逐帧渲染
  const segs = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    ctx.progress(0.3 + (i / frames.length) * 0.52, '渲染第 ' + (i + 1) + '/' + frames.length + ' 格');
    const seg = 'seg' + String(i).padStart(3, '0') + '.mp4';
    const d = Number(f.sec) || 3;

    const imgAbs = f.image ? path.join(ctx.files, f.image) : '';
    const hasImg = !!(imgAbs && fs.existsSync(imgAbs) && imageOk(bin, imgAbs));
    f.hasImage = hasImg;      // 字幕排版按这个决定「底部字幕」还是「整屏文字卡」

    const args = ['-hide_banner', '-loglevel', 'error'];
    let vf;
    if (hasImg) {
      args.push('-loop', '1', '-i', imgAbs);
      vf = [
        'scale=' + (MOVIE_W * 3 / 2) + ':' + (MOVIE_H * 3 / 2) + ':force_original_aspect_ratio=increase',
        'crop=' + (MOVIE_W * 3 / 2) + ':' + (MOVIE_H * 3 / 2),
        'zoompan=' + zoomExpr(i) + ":d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=" +
          MOVIE_W + 'x' + MOVIE_H + ':fps=' + MOVIE_FPS,
        'format=yuv420p',
      ].join(',');
    } else {
      // 缺图：不再铺深色底（那是「全黑」的来源），改成米色纸底 + 上下两条细线，
      // 正文由 ASS 以大字排在中间——像一页稿纸，而不是一块黑屏。
      args.push('-f', 'lavfi', '-i',
        'color=c=0xF6F0E2:s=' + MOVIE_W + 'x' + MOVIE_H + ':d=' + d + ':r=' + MOVIE_FPS);
      vf = 'drawbox=x=0:y=0:w=' + MOVIE_W + ':h=14:color=0xC9A87C@0.85:t=fill,' +
        'drawbox=x=0:y=' + (MOVIE_H - 8) + ':w=' + MOVIE_W + ':h=8:color=0xC9A87C@0.55:t=fill,' +
        'format=yuv420p';
    }

    const hasVoice = f.voiceFile && fs.existsSync(f.voiceFile);
    if (hasVoice) args.push('-i', f.voiceFile);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');

    const aIdx = 1;
    const af = hasVoice
      ? '[' + aIdx + ':a]apad,atrim=0:' + d + ',asetpts=N/SR/TB[a]'
      : '[' + aIdx + ':a]atrim=0:' + d + ',asetpts=N/SR/TB[a]';

    args.push('-t', String(d),
      '-filter_complex', '[0:v]' + vf + '[v];' + af,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-r', String(MOVIE_FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-y', seg);

    await runFfmpeg(bin, args, { cwd: absDir, what: '第 ' + (i + 1) + ' 格', timeout: 120000 });
    segs.push(seg);
  }

  // 拼接
  ctx.progress(0.85, '拼接');
  const listFile = path.join(absDir, 'list.txt');
  fs.writeFileSync(listFile, segs.map(function (s) { return 'file \'' + s + '\''; }).join('\n') + '\n', 'utf8');
  const joined = 'joined.mp4';
  await runFfmpeg(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
    '-i', 'list.txt', '-c', 'copy', '-y', joined], { cwd: absDir, what: '拼接', timeout: 180000 });

  // 字幕 + 配乐
  ctx.progress(0.86, '配字幕与配乐');
  const assName = 'subs.ass';
  fs.writeFileSync(path.join(absDir, assName), buildAss(p.title || '', frames), 'utf8');

  const totalSec = frames.reduce(function (s2, f) { return s2 + (Number(f.sec) || 3); }, 0);
  const args2 = ['-hide_banner', '-loglevel', 'error', '-i', joined];
  let fc = '[0:v]ass=' + assName + '[v]';

  // 配乐：现算一条和弦进行（琶音 + 长音铺底），不再是三路正弦垫。
  // 音量按「有没有配音」分档：有人说话时音乐退到后面，只有音乐时才推上来。
  let bgmWav = '';
  if (bgmName !== 'none') {
    ctx.progress(0.88, '编配乐');
    bgmWav = synthBgm(bgmName, totalSec, path.join(absDir, 'bgm.wav'));
  }

  if (bgmWav && fs.existsSync(bgmWav)) {
    args2.push('-i', 'bgm.wav');
    const bgVol = wantVoice ? 0.55 : 1.3;
    const fadeOutAt = Math.max(0, totalSec - 3);
    fc += ';[1:a]volume=' + bgVol +
      ',afade=t=in:st=0:d=1.5,afade=t=out:st=' + fadeOutAt.toFixed(2) + ':d=2.6[bg]';
    // 语音先做响度归一：各家 TTS 电平差很多（硅基流动 CosyVoice 实测 mean −31.6dB，
    // 手机外放几乎听不清；OpenAI 的 tts-1 又在 −20dB 上下），固定增益必然一头爆一头闷。
    // loudnorm 拉到 −18 LUFS，再由 amix 之后补回被平分的那 6dB。
    fc += wantVoice
      ? ';[0:a]loudnorm=I=-18:TP=-2:LRA=11,aresample=44100[va]'
      : ';[0:a]anull[va]';
    fc += ';[va][bg]amix=inputs=2:duration=first:dropout_transition=0,' +
      'volume=2.0,alimiter=limit=0.95[a]';
  } else {
    fc += wantVoice
      ? ';[0:a]loudnorm=I=-18:TP=-2:LRA=11,aresample=44100[a]'
      : ';[0:a]anull[a]';
  }

  args2.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-r', String(MOVIE_FPS),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '-shortest', '-y', 'movie.mp4');

  await runFfmpeg(bin, args2, { cwd: absDir, what: '合成', timeout: 600000 });

  // 碎片清掉，只留成片。用户不需要知道中间产物
  for (const s2 of segs) { try { fs.unlinkSync(path.join(absDir, s2)); } catch (e) {} }
  try { fs.unlinkSync(listFile); } catch (e) {}
  try { fs.unlinkSync(path.join(absDir, joined)); } catch (e) {}
  try { fs.unlinkSync(path.join(absDir, 'bgm.wav')); } catch (e) {}

  ctx.progress(0.99, '收尾');
  const bytes = fs.existsSync(outAbs) ? fs.statSync(outAbs).size : 0;

  // 成片登记进这本档案的媒体表：这样关掉页面、换个设备、或者过几天再回来，
  // 都能在「档案 → 合成过的片子」里找到（成片是档案资产，不是一次性任务产物）。
  const aid = Number(p.archiveId) || 0;
  if (aid && bytes > 0) {
    try {
      const dup = ctx.db.prepare("SELECT id FROM media WHERE archive_id=? AND kind='movie' AND path=?")
        .get(aid, outRel);
      if (dup) {
        ctx.db.prepare('UPDATE media SET bytes=?, duration_ms=?, caption=? WHERE id=?')
          .run(bytes, Math.round(totalSec * 1000), String(p.title || '短片').slice(0, 120), dup.id);
      } else {
        ctx.db.prepare(
          'INSERT INTO media (archive_id, kind, path, mime, bytes, caption, duration_ms) VALUES (?,?,?,?,?,?,?)')
          .run(aid, 'movie', outRel, 'video/mp4', bytes,
            String(p.title || '短片').slice(0, 120), Math.round(totalSec * 1000));
      }
    } catch (e) { /* 登记失败不影响成片：任务结果里仍旧带 path */ }
  }

  return {
    path: outRel,
    seconds: Math.round(totalSec * 10) / 10,
    bytes: bytes,
    frames: frames.length,
    // 前端按这三个字段如实告诉人：配音成没成、几格没配上、有没有配乐
    voice: wantVoice ? (voiceStat.done > 0 ? 'ok' : 'failed') : 'off',
    voiceDone: voiceStat.done,
    voiceFailed: voiceStat.failed,
    voiceReason: voiceStat.reason || '',
    bgm: bgmWav ? bgmName : 'none',
    bgmWant: bgmName,
    cards: frames.filter(function (f) { return !f.hasImage; }).length,
    archiveId: aid || null,
  };
});

/* ---------------- AI 视频：文生 / 图生（硅基流动 /video/submit + /video/status） ----------------
 * 为什么要做成后台任务：一条 Wan2.2 通常要一两分钟，最长见过四分钟。
 * 挂在前端一个请求上，用户切个页面就断了。这里提交拿到 requestId 后按间隔问状态，
 * Succeed 时把临时链接当场下载落盘——官方链接 1 小时就失效，只存链接等于没存。
 * 同一个描述 + 模型 + 尺寸只花一次钱：命中 ai_assets 直接返回旧片子。
 */
function isVideoModel(model) {
  return /cogvideo|seedance|video|t2v|i2v|wan2|veo|kling|hailuo|sora/i.test(String(model || '').toLowerCase());
}

function videoKey(prompt, model, size) {
  return crypto.createHash('sha1')
    .update([prompt, model, size].join('|')).digest('hex').slice(0, 16);
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

registerJob('aivideo', async function (p, ctx) {
  const prompt = String(p.prompt || '').trim();
  if (!prompt) throw new Error('没有画面描述');
  if (prompt.length > 1200) throw new Error('画面描述太长了（最多 1200 字）');

  const size = /^\d{3,4}x\d{3,4}$/.test(String(p.size || '')) ? String(p.size) : '720x1280';
  const chain = profileChain({ slot: 'vid', profileId: p.profileId, model: p.model });
  if (!chain.length) {
    throw new Error('还没配「视频生成」的模型。设置 → 模型来源 → 加一条，模型填 Wan-AI/Wan2.2-T2V-A14B（图生视频填 Wan-AI/Wan2.2-I2V-A14B）。');
  }

  // 图生视频：参考图已经在 users/<uid>/files 里，读成 data URL 发出去
  let image = '';
  if (p.imagePath) {
    const rel = safePath(p.imagePath);
    const abs = path.join(ctx.files, rel);
    if (rel && abs.startsWith(ctx.files) && fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      if (buf.length > 10 * 1024 * 1024) throw new Error('参考图超过 10MB，先缩小一点');
      image = 'data:' + (MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'image/jpeg') +
        ';base64,' + buf.toString('base64');
    }
  }

  const step = Math.max(500, Number(p.pollMs) || 5000);
  const maxPoll = Math.max(6, Number(p.maxPoll) || 120);   // 默认 5 秒 × 120 ≈ 10 分钟
  const errors = [];

  for (const cand of chain.slice(0, 2)) {
    const model = p.model
      ? String(p.model)
      : (cand.model && isVideoModel(cand.model) ? cand.model : 'Wan-AI/Wan2.2-T2V-A14B');
    const key = videoKey(prompt, model, size);

    // 已经生成过同一段：直接给旧片子，不再扣一次钱（想要新的一版就带 again=1）
    if (!p.again) {
      try {
        const hit = ctxDb().prepare("SELECT path FROM ai_assets WHERE cache_key=? AND capability='video'").get(key);
        if (hit && hit.path && fs.existsSync(path.join(ctx.files, hit.path))) {
          return { ok: true, path: hit.path, bytes: fs.statSync(path.join(ctx.files, hit.path)).size,
            model: model, cached: true, archiveId: Number(p.archiveId) || null };
        }
      } catch (e) {}
    }

    try {
      ctx.progress(0.08, '提交给 ' + cand.profile.name);
      const pl = { model: model, prompt: prompt, image_size: size };
      if (image) pl.image = image;
      if (p.seed) pl.seed = Number(p.seed);

      const sub = await fetchJson(endpointOf(cand.profile) + '/video/submit', {
        method: 'POST', headers: authHeaders(cand.profile), body: JSON.stringify(pl),
      }, 90000);

      if (!sub.ok) {
        errors.push(cand.profile.name + ' 提交失败 HTTP ' + sub.status + '：' + describeErr(sub));
        continue;
      }
      const rid = String((sub.json && (sub.json.requestId || sub.json.request_id)) || '');
      if (!rid) { errors.push(cand.profile.name + ' 没给任务号'); continue; }

      let url = '', bad = '';
      const t0 = Date.now();
      for (let i = 1; i <= maxPoll; i++) {
        await new Promise(r => setTimeout(r, step));
        const secs = Math.round((Date.now() - t0) / 1000);
        ctx.progress(Math.min(0.9, 0.08 + 0.8 * (i / maxPoll)), '生成中 · 已等 ' + secs + ' 秒');
        if (i % 12 === 0) ctx.progress(0.08 + 0.8 * (i / maxPoll), '生成中 · 已等 ' + secs + ' 秒（一般 1–4 分钟）');

        const st = await fetchJson(endpointOf(cand.profile) + '/video/status', {
          method: 'POST', headers: authHeaders(cand.profile), body: JSON.stringify({ requestId: rid }),
        }, 30000);

        if (!st.ok) {
          // 5xx 多半是排队时抖动，接着问；4xx 说明任务号或权限有问题，别再耗
          if (st.status >= 500) continue;
          bad = cand.profile.name + ' 查状态失败 HTTP ' + st.status + '：' + describeErr(st);
          break;
        }
        const js = st.json || {};
        const status = String(js.status || '');
        if (status === 'Succeed') {
          const vids = (js.results && js.results.videos) || [];
          url = String((vids[0] && vids[0].url) || '');
          if (!url) { bad = cand.profile.name + ' 说成功了但没给视频地址'; }
          break;
        }
        if (status === 'Failed') {
          bad = cand.profile.name + ' 生成失败：' + String(js.reason || '服务商没给原因');
          break;
        }
        // InQueue / InProgress：继续等
      }

      if (!url) {
        errors.push(bad || (cand.profile.name + ' 等了 ' + Math.round(step * maxPoll / 1000) + ' 秒还没出片'));
        continue;
      }

      ctx.progress(0.94, '下载成片');
      const got = await fetch(url);
      if (!got.ok) { errors.push('取成片失败 HTTP ' + got.status); continue; }
      const buf = Buffer.from(await got.arrayBuffer());
      if (!buf.length) { errors.push('成片是空的'); continue; }

      const rel = 'ai/video/' + key + '.mp4';
      const abs = path.join(ctx.files, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      try {
        ctxDb().prepare('INSERT INTO ai_assets (capability, cache_key, path, prompt, model) VALUES (?,?,?,?,?)')
          .run('video', key, rel, prompt.slice(0, 300), model);
      } catch (e) {}
      usageAdd('video', model, 1, 'clip', 0, 'chat');

      // 登记进这本档案：变成档案资产，导出整本时也会带上
      const aid = Number(p.archiveId) || 0;
      if (aid) {
        try {
          const dup = ctx.db.prepare("SELECT id FROM media WHERE archive_id=? AND kind='video' AND path=?").get(aid, rel);
          if (dup) {
            ctx.db.prepare('UPDATE media SET bytes=?, caption=? WHERE id=?')
              .run(buf.length, prompt.slice(0, 120), dup.id);
          } else {
            ctx.db.prepare(
              'INSERT INTO media (archive_id, kind, path, mime, bytes, caption) VALUES (?,?,?,?,?,?)')
              .run(aid, 'video', rel, 'video/mp4', buf.length, prompt.slice(0, 120));
          }
        } catch (e) { /* 登记失败不影响成片 */ }
      }

      return {
        ok: true, path: rel, bytes: buf.length, model: model,
        requestId: rid, archiveId: aid || null, cached: false,
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === '__canceled__') throw e;
      errors.push(cand.profile.name + ' 连不上：' + msg);
    }
  }

  throw new Error('没做出片子：' + (errors.join('；') || '未知原因'));
});

/* ---------------- AI 作曲：交给音乐大模型真写一首歌 ----------------
 *
 * 与上面「演奏出来」是两条路：演奏是本地 TTS 念词 + 按和弦算的钢琴琶音，
 * 省事但只是「配乐朗读」；这里是专门的音乐大模型（阶跃星辰 StepAudio 3、
 * Mureka）真写旋律、编曲、演唱，出来的是一首有起承转合的完整歌曲。
 *
 * 两家都是「提交拿号 → 轮询 → 收音频」的两段式，一首歌要几十秒到几分钟，
 * 所以照样走后台任务：关掉页面也继续跑。音频当场落盘——外链几小时就失效，
 * 只存链接等于没存。
 *
 *   阶跃星辰  POST /v1/audio/music/submit {task, model_id, caption, lyrics, instrumental, response_format}
 *             POST /v1/audio/music/query  {task_id} → {status, audio(base64)}
 *   Mureka    POST /v1/song/generate      {lyrics, model, prompt, n}
 *             GET  /v1/song/query/{id}    → {status, choices:[{url}]}
 *
 * ⚠️ 上面写的是**完整 API 路径**；代码里用 endpointOf()（= base_url，本身已含 /v1）拼接，
 *    所以实际写的是 '/audio/music/submit'。曾经多写一层 /v1 变成 /v1/v1/... 被判 404，
 *    而测试桩只按子串匹配、发现不了——真链路必须自己跑一次。
 */
function musicVendorOf(p) {
  const s = (String((p && p.base_url) || '') + ' ' + String((p && p.kind) || '')).toLowerCase();
  if (/mureka/.test(s)) return 'mureka';
  if (/stepfun/.test(s)) return 'stepfun';
  return '';
}

/** 把一支曲子记进这本档案（media.kind='audio'），档案首页「写的歌」才列得出来 */
function registerMusic(ctx, aid, rel, bytes, seconds, caption) {
  try {
    const dup = ctx.db.prepare("SELECT id FROM media WHERE archive_id=? AND kind='audio' AND path=?").get(aid, rel);
    if (dup) {
      ctx.db.prepare('UPDATE media SET bytes=?, duration_ms=?, caption=? WHERE id=?')
        .run(bytes, Math.round(seconds * 1000), String(caption || 'AI 作的曲').slice(0, 120), dup.id);
    } else {
      ctx.db.prepare(
        'INSERT INTO media (archive_id, kind, path, mime, bytes, caption, duration_ms) VALUES (?,?,?,?,?,?,?)')
        .run(aid, 'audio', rel, 'audio/mpeg', bytes,
          String(caption || 'AI 作的曲').slice(0, 120), Math.round(seconds * 1000));
    }
  } catch (e) { /* 登记失败不影响成品：任务结果里仍旧带 path */ }
}

function musicKey(vendor, model, caption, lyrics, instrumental) {
  return crypto.createHash('sha1')
    .update([vendor, model, caption, lyrics, instrumental ? 'i' : 'v'].join('|'))
    .digest('hex').slice(0, 16);
}

registerJob('aimusic', async function (p, ctx) {
  const caption = String(p.caption || p.prompt || '').trim();
  const lyrics = String(p.lyrics || '').trim();
  const instrumental = !!p.instrumental;

  if (!caption && !lyrics) throw new Error('说说想要什么曲子，或者把歌词给我');
  if (caption.length > 1000) throw new Error('曲风描述最多 1000 字');
  if (lyrics.length > 3500) throw new Error('歌词最多 3500 字（再长一首都唱不完）');

  const chain = profileChain({ slot: 'music', profileId: p.profileId, model: p.model });
  if (!chain.length) {
    throw new Error('还没配「作曲演唱」的模型。设置 → 模型来源 → 加一条：' +
      '阶跃星辰 https://api.stepfun.com/v1（音乐目前限免）或 Mureka https://api.mureka.ai/v1，' +
      '再加好「模型分工 → 作曲演唱」就能用。');
  }

  const step = Math.max(3000, Number(p.pollMs) || 5000);
  const maxPoll = Math.max(6, Number(p.maxPoll) || 150);   // 5 秒 × 150 ≈ 12 分钟
  const errors = [];
  let musicNote = '';

  for (const cand of chain.slice(0, 2)) {
    const vendor = musicVendorOf(cand.profile);
    if (!vendor) {
      errors.push(cand.profile.name + '（' + String(cand.profile.base_url || '') + '）不做音乐生成');
      continue;
    }
    const defModel = vendor === 'stepfun' ? 'stepaudio-3-music-preview' : 'auto';
    const model = String(p.model || cand.model || defModel);
    const key = musicKey(vendor, model, caption, lyrics, instrumental);

    // 同一个描述 + 同一版歌词只花一次钱；想要新的一版就带 again=1。
    // 命中缓存也要登记进档案：上次可能是没绑档案时作的，这次换了本档案同样要看得到。
    if (!p.again) {
      try {
        const hit = ctxDb().prepare("SELECT path FROM ai_assets WHERE cache_key=? AND capability='music'").get(key);
        if (hit && hit.path && fs.existsSync(path.join(ctx.files, hit.path))) {
          const abs0 = path.join(ctx.files, hit.path);
          const sec0 = Math.round(mediaSeconds(ffmpegPath(), abs0) * 10) / 10;
          const bytes0 = fs.statSync(abs0).size;
          const aid0 = Number(p.archiveId) || 0;
          if (aid0) registerMusic(ctx, aid0, hit.path, bytes0, sec0, p.title || caption || lyrics);
          return { ok: true, path: hit.path, bytes: bytes0, seconds: sec0,
            model: model, vendor: vendor, cached: true,
            archiveId: aid0 || null };
        }
      } catch (e) {}
    }

    try {
      ctx.progress(0.06, '提交给 ' + cand.profile.name);

      // ① 提交
      let taskId = '';
      if (vendor === 'stepfun') {
        const body = {
          task: 'text_to_music',
          model_id: model,
          caption: caption || (lyrics || '一首温柔的中文老歌').slice(0, 200),
          response_format: 'mp3',
        };
        if (instrumental) body.instrumental = true;
        else if (lyrics) body.lyrics = lyrics;

        const sub = await fetchJson(endpointOf(cand.profile) + '/audio/music/submit', {
          method: 'POST', headers: authHeaders(cand.profile), body: JSON.stringify(body),
        }, 90000);
        if (!sub.ok) {
          errors.push(cand.profile.name + ' 提交失败 HTTP ' + sub.status + '：' + describeErr(sub));
          continue;
        }
        taskId = String(((sub.json || {}).task_id || (sub.json || {}).id) || '');
      } else {
        // Mureka 的 lyrics 是必填：没给词就只能当纯音乐，不能闷声出个没人的版本
        const noLyric = instrumental || !lyrics;
        const body = {
          lyrics: noLyric ? '[Instrumental]' : lyrics,
          model: model,
          prompt: (caption || (noLyric ? 'instrumental' : 'chinese vocal')).slice(0, 1024),
          n: 1,
        };
        if (noLyric && !instrumental) {
          musicNote = '没给歌词，这家（Mureka）只能作成纯音乐；想要人声就把歌词填上，或改用阶跃星辰（能自己写词）';
        }
        const sub = await fetchJson(endpointOf(cand.profile) + '/song/generate', {
          method: 'POST', headers: authHeaders(cand.profile), body: JSON.stringify(body),
        }, 90000);
        if (!sub.ok) {
          errors.push(cand.profile.name + ' 提交失败 HTTP ' + sub.status + '：' + describeErr(sub));
          continue;
        }
        taskId = String(((sub.json || {}).id || (sub.json || {}).task_id) || '');
      }
      if (!taskId) { errors.push(cand.profile.name + ' 没给任务号'); continue; }

      // ② 轮询
      let buf = null, bad = '', gotCaption = '', gotLyrics = '';
      const t0 = Date.now();
      for (let i = 1; i <= maxPoll; i++) {
        await new Promise(r => setTimeout(r, step));
        const secs = Math.round((Date.now() - t0) / 1000);
        ctx.progress(Math.min(0.92, 0.06 + 0.85 * (i / maxPoll)),
          '作曲中 · 已等 ' + secs + ' 秒（一首歌通常 1–3 分钟）');

        let st;
        if (vendor === 'stepfun') {
          st = await fetchJson(endpointOf(cand.profile) + '/audio/music/query', {
            method: 'POST', headers: authHeaders(cand.profile),
            body: JSON.stringify({ task_id: taskId }),
          }, 30000);
        } else {
          st = await fetchJson(endpointOf(cand.profile) + '/song/query/' + encodeURIComponent(taskId), {
            method: 'GET', headers: authHeaders(cand.profile),
          }, 30000);
        }
        if (!st.ok) {
          if (st.status >= 500) continue;
          bad = cand.profile.name + ' 查状态失败 HTTP ' + st.status + '：' + describeErr(st);
          break;
        }
        const js = st.json || {};

        if (vendor === 'stepfun') {
          const s = String(js.status || '').toUpperCase();
          if (s === 'SUCCESS') {
            const b64 = String(js.audio || '');
            if (!b64) { bad = cand.profile.name + ' 说成功了但没给音频'; break; }
            buf = Buffer.from(b64, 'base64');
            gotCaption = String(js.rewritten_caption || '');
            gotLyrics = String(js.rewritten_lyrics || '');
            break;
          }
          if (s === 'FAILED') {
            const e2 = js.error || {};
            bad = cand.profile.name + ' 作曲失败：' +
              String(e2.message || e2.stage || '服务商没给原因');
            break;
          }
          continue;                                   // PENDING / RUNNING
        }

        const s2 = String(js.status || '').toLowerCase();
        if (s2 === 'succeeded') {
          const ch = (js.choices && js.choices[0]) || {};
          const url = String(ch.url || ch.mp3_url || ch.audio_url || ch.flac_url || '');
          if (!url) { bad = cand.profile.name + ' 说成功了但没给音频地址'; break; }
          ctx.progress(0.94, '下载成品');
          const got = await fetch(url);
          if (!got.ok) { bad = '取成品失败 HTTP ' + got.status; break; }
          buf = Buffer.from(await got.arrayBuffer());
          break;
        }
        if (s2 === 'failed' || s2 === 'timeouted' || s2 === 'cancelled') {
          bad = cand.profile.name + ' 作曲失败：' + String(js.failed_reason || s2);
          break;
        }
      }

      if (!buf || !buf.length) {
        errors.push(bad || (cand.profile.name + ' 等了 ' + Math.round(step * maxPoll / 1000) + ' 秒还没出歌'));
        continue;
      }

      // ③ 落盘：外链会失效，必须当场存下来
      const rel = 'ai/music/' + key + '.mp3';
      const abs = path.join(ctx.files, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      const seconds = Math.round(mediaSeconds(ffmpegPath(), abs) * 10) / 10;
      try {
        ctxDb().prepare('INSERT INTO ai_assets (capability, cache_key, path, prompt, model) VALUES (?,?,?,?,?)')
          .run('music', key, rel, (caption || lyrics).slice(0, 300), model);
      } catch (e) {}
      try { usageAdd('music', model, 1, 'song', 0, 'chat'); } catch (e) {}

      // ④ 登记进档案
      const aid = Number(p.archiveId) || 0;
      if (aid) registerMusic(ctx, aid, rel, buf.length, seconds, p.title || caption || 'AI 作的曲');

      return {
        ok: true, path: rel, bytes: buf.length, seconds: seconds,
        model: model, vendor: vendor, vendorName: cand.profile.name,
        caption: gotCaption || caption, lyrics: gotLyrics || lyrics,
        note: musicNote, archiveId: aid || null, cached: false,
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === '__canceled__') throw e;
      errors.push(cand.profile.name + ' 连不上：' + msg);
    }
  }

  throw new Error('没作出曲子：' + (errors.join('；') || '未知原因'));
});

/* ---------------- 能力网关 ----------------
 * 一条能力 = 一组候选配置（显式指定 → 用途槽位 → 其余启用配置）。
 * 前一个失败就换下一个，把每一次失败原话带回前端。 */

function enabledProfiles() {
  return ctxDb().prepare('SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id').all();
}

function profileChain(body) {
  const out = [], seen = {};
  function push(profile, model) {
    if (!profile || seen[profile.id]) return;
    seen[profile.id] = 1;
    out.push({ profile: profile, model: model || profile.default_model });
  }
  if (body.profileId) push(profileById(body.profileId), body.model);
  if (body.slot) {
    const hit = profileForSlot(body.slot);
    if (hit) push(hit.profile, body.model || hit.model);
  }
  for (const p of enabledProfiles()) push(p, null);
  return out;
}

function chatPayload(cand, body) {
  const payload = {
    model: cand.model,
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream: false,
  };
  if (body.maxTokens) payload.max_tokens = body.maxTokens;
  return payload;
}

async function aiChatOnce(cand, body) {
  const t0 = Date.now();
  try {
    const r = await fetchJson(endpointOf(cand.profile) + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(cand.profile),
      body: JSON.stringify(chatPayload(cand, body)),
    }, 120000);
    if (!r.ok) {
      return { ok: false, ms: Date.now() - t0, status: r.status,
        message: cand.profile.name + ' 返回 HTTP ' + r.status + '：' + String(r.text).slice(0, 160) };
    }
    const choice = (r.json && r.json.choices && r.json.choices[0]) || {};
    const msg = choice.message || {};
    const text = String(msg.content || msg.reasoning_content || msg.reasoning || '');
    if (!text.trim()) {
      return { ok: false, ms: Date.now() - t0, message: cand.profile.name + ' 回了空内容' };
    }
    return { ok: true, ms: Date.now() - t0, text: text, usage: r.json.usage || null, model: cand.model };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: cand.profile.name + ' 连不上：' + (e.message || e) };
  }
}

/* ---------------- 流式对话（NDJSON：每行一个 json） ---------------- */

async function apiChatStream(req, res, body) {
  const chain = profileChain(body);
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const send = function (o) { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };

  if (!chain.length) {
    send({ t: 'err', message: '还没配模型。打开「设置 → 模型来源」加一条。' });
    return res.end();
  }
  if (!body.messages || !body.messages.length) {
    send({ t: 'err', message: '没有要发送的内容' });
    return res.end();
  }

  const errors = [];
  for (const cand of chain.slice(0, 3)) {
    try {
      const payload = chatPayload(cand, body);
      payload.stream = true;
      const r = await fetch(endpointOf(cand.profile) + '/chat/completions', {
        method: 'POST', headers: authHeaders(cand.profile), body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const txt = await r.text();
        errors.push(cand.profile.name + ' HTTP ' + r.status + '：' + String(txt).slice(0, 120));
        send({ t: 'retry', message: errors[errors.length - 1] });
        continue;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '', full = '', done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '').trim();
          buf = buf.slice(idx + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          try {
            const j = JSON.parse(data);
            const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            const piece = delta.content || delta.reasoning_content || '';
            if (piece) { full += piece; send({ t: 'd', v: piece }); }
          } catch (e) { /* 心跳或畸形行，跳过 */ }
        }
      }
      send({ t: 'done', text: full, model: cand.model, profile: cand.profile.name });
      usageAdd('text', cand.model, Math.round(full.length / 2), 'token', 0, 'chat');
      return res.end();
    } catch (e) {
      errors.push(cand.profile.name + ' 断流：' + (e.message || e));
      send({ t: 'retry', message: errors[errors.length - 1] });
    }
  }
  send({ t: 'err', message: '所有模型都没通：' + errors.join('；') });
  return res.end();
}

/* ---------------- 导出：PDF（无头 Chrome） ---------------- */

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

function runProc(bin, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const { spawn } = require('child_process');
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(function () { try { p.kill(); } catch (e) {} reject(new Error('超时')); }, timeoutMs || 120000);
    p.stderr.on('data', function (c) { err += String(c); });
    p.on('error', function (e) { clearTimeout(timer); reject(e); });
    p.on('close', function (code) {
      clearTimeout(timer);
      if (code === 0) resolve(true); else reject(new Error('进程退出码 ' + code + '：' + err.slice(0, 200)));
    });
  });
}

async function apiExportPdf(body) {
  const html = String(body.html || '');
  if (!html) return { ok: false, message: '没有可打印的内容' };
  const files = ctxFiles();
  const outDir = path.join(files, 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = safe(body.name || 'book') + '-' + stamp;
  const tmpHtml = path.join(outDir, '__p-' + Date.now() + '.html');
  const outPdf = path.join(outDir, base + '.pdf');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const chrome = findChrome();
  if (!chrome) {
    try { fs.unlinkSync(tmpHtml); } catch (e) {}
    return {
      ok: false,
      message: '这台机器上没找到 Chrome / Edge，做不了"一键 PDF"。\n' +
               '可以改用「打印版」：浏览器里按 Ctrl+P，目标选「另存为 PDF」，效果一样。',
    };
  }
  try {
    await runProc(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
      '--virtual-time-budget=12000',
      '--print-to-pdf=' + outPdf,
      'file:///' + tmpHtml.replace(/\\/g, '/'),
    ], 120000);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (e) {}
  }
  if (!fs.existsSync(outPdf)) return { ok: false, message: 'PDF 没生成出来（Chrome 可能开了沙箱限制）' };
  const bytes = fs.statSync(outPdf).size;
  ctxDb().prepare('INSERT INTO exports (archive_id, kind, path, bytes, params_json) VALUES (?,?,?,?,?)')
    .run(body.archiveId ? Number(body.archiveId) : null, 'pdf', 'exports/' + base + '.pdf', bytes, JSON.stringify(body.params || {}));
  return { ok: true, path: 'exports/' + base + '.pdf', bytes: bytes };
}

/** 前端生成好的 docx/pptx（base64）落盘，统一进 exports/ */
function apiExportSave(body) {
  const name = safe(body.name || ('file-' + Date.now()));
  const ext = String(body.ext || 'bin').replace(/[^a-z0-9]/gi, '');
  const b64 = String(body.base64 || '');
  if (!b64) throw new Error('没有文件内容');
  const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw new Error('文件是空的');
  const outDir = path.join(ctxFiles(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const filename = name + '.' + ext;
  fs.writeFileSync(path.join(outDir, filename), buf);
  ctxDb().prepare('INSERT INTO exports (archive_id, kind, path, bytes, params_json) VALUES (?,?,?,?,?)')
    .run(body.archiveId ? Number(body.archiveId) : null, ext, 'exports/' + filename, buf.length, JSON.stringify(body.params || {}));
  return { ok: true, path: 'exports/' + filename, bytes: buf.length };
}

/* ---------------- 导入 Word（.docx）：把文档读回成档案 ---------------- */

/**
 * 极简 zip 解包：Word/WPS 写 docx 只用 store(0) 和 deflate(8) 两种，
 * 自己解就够了——不为一个导入功能引第三方库（exe 是单文件 SEA，多一个依赖就多一份麻烦）。
 * 返回 { 'word/document.xml': Buffer, 'word/media/image1.jpg': Buffer, ... }
 */
function unzipDocx(buf) {
  // zip 末尾是中央目录（EOCD，签名 0x06054b50），后面可能还有注释，所以从尾部往前找
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是 .docx 文件（不是 zip 格式）。老的 .doc 请先用 Word/WPS 另存为 .docx');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('这个 docx 用了 zip64 格式，暂不支持；用 Word 另存一次通常就好了');
  const out = {};
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + cmtLen;
    if (compSize === 0xffffffff || localOff === 0xffffffff) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch (e) { /* 单个文件坏了不影响正文，跳过 */ }
  }
  return out;
}

function xmlChr(code) {
  try { return String.fromCodePoint(code); } catch (e) { return ''; }
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => xmlChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => xmlChr(parseInt(d, 10)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (m, k) => (
      { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }[m] || k));
}

/** 一个 <w:p> 里的可见文字：把分段的 <w:t> 拼起来（Word 会把一句话切成很多 run） */
function paraText(chunk) {
  const ts = chunk.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g) || [];
  let s = '';
  for (const t of ts) {
    s += xmlUnescape(t.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>\s*$/, ''));
  }
  return s.replace(/\u00a0/g, ' ').trim();
}

function headLevel(style) {
  const s = String(style || '');
  const m = /^(?:heading|Heading|HEADING)\s*([1-6])$/.exec(s) ||
    /^标题\s*([1-6])$/.exec(s) || /^([1-6])$/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** 「1921 · 江西石城 · 父亲李前裕」这种图注 */
function looksLikeCaption(t) {
  const s = String(t || '');
  return s.length <= 80 && /^[0-9]{4}/.test(s) && s.indexOf('·') > 0;
}

/**
 * 解析 docx 正文 -> 档案草稿。
 * 认两种文档：① 本程序导出的 Word（有「档案信息」「目录」页，章标题是「第 N 章　」）
 *           ② 别人随便写的 Word（靠「标题 1」样式分章，没样式就整篇当一章）
 */
function parseDocx(buf, fileName) {
  const files = unzipDocx(buf);
  const docBuf = files['word/document.xml'];
  if (!docBuf) throw new Error('这个 .docx 里没有正文（可能不是 Word 文档，或者是加密的）');
  const xml = docBuf.toString('utf8');

  // 关系表：rId -> 包内路径（图片靠它找）
  const rels = {};
  const relBuf = files['word/_rels/document.xml.rels'];
  if (relBuf) {
    const s = relBuf.toString('utf8');
    const re = /<Relationship\b[^>]*\/?>/g;
    let m;
    while ((m = re.exec(s))) {
      const id = /Id="([^"]+)"/.exec(m[0]);
      const tg = /Target="([^"]+)"/.exec(m[0]);
      if (!id || !tg) continue;
      let t = tg[1];
      if (/^https?:/i.test(t)) continue;                       // 外链图片不取
      if (t.charAt(0) === '/') t = t.slice(1);
      else if (t.indexOf('word/') !== 0) t = 'word/' + t;
      rels[id[1]] = t;
    }
  }

  const bodyAt = xml.indexOf('<w:body>');
  const chunks = xml.slice(bodyAt < 0 ? 0 : bodyAt).split('</w:p>');

  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const st = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(c);
    const text = paraText(c);
    const imgs = [];
    const re2 = /r:embed="([^"]+)"/g;
    let m2;
    while ((m2 = re2.exec(c))) {
      const p = rels[m2[1]];
      if (p && files[p] && /\.(jpe?g|png|gif|webp|bmp)$/i.test(p)) imgs.push(p);
    }
    if (!text && !imgs.length) continue;                        // 空段落直接丢
    items.push({ style: st ? st[1] : '', text: text, imgs: imgs });
  }

  const meta = { subject_name: '', archive_no: '', birth_year: null, years: '', hometown: '', intro: '' };
  const chapters = [];
  const warnings = [];
  const headItems = [];
  let cur = null;
  let skipping = false;        // 处在「档案信息」「目录」这种不算正文的块里
  let imgCount = 0;
  const MAX_IMGS = 40;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const lv = headLevel(it.style);

    if (lv === 1) {
      const t = String(it.text || '').replace(/[\s\u3000]+/g, ' ').trim();
      if (/^(档案信息|目\s*录)$/.test(t)) { skipping = true; cur = null; continue; }
      skipping = false;
      const mc = /^第\s*[0-9一二三四五六七八九十百千]+\s*章\s*(.*)$/.exec(t);
      let title = mc ? mc[1] : t;
      let years = '';
      // 第三方文档的「第一章 出生（1921）」：把括注里的年份挪到章头
      const my = /[（(]\s*([0-9]{4}(?:\s*[-—–~至]\s*[0-9]{4})?)\s*[）)]\s*$/.exec(title);
      if (my) { years = my[1]; title = title.slice(0, my.index).trim(); }
      cur = {
        title: title || ('第 ' + (chapters.length + 1) + ' 章'),
        years: years, stage: '', quote: '', blocks: [],
      };
      chapters.push(cur);
      continue;
    }
    if (skipping) continue;
    if (!cur) { headItems.push(it); continue; }

    // 图片：单独成块，紧跟的那行「年 · 地点 · 说明」当图注
    if (it.imgs.length) {
      let cap = '';
      const nx = items[i + 1];
      if (nx && !nx.imgs.length && looksLikeCaption(nx.text)) { cap = nx.text; i++; }
      for (const p of it.imgs) {
        if (imgCount >= MAX_IMGS) {
          if (warnings.indexOf('图片太多') < 0) warnings.push('图片太多，只导入了前 ' + MAX_IMGS + ' 张');
          continue;
        }
        const bytes = files[p];
        if (!bytes || bytes.length > 8 * 1024 * 1024) continue;
        imgCount++;
        cur.blocks.push({
          type: 'photo', name: path.basename(p), caption: cap,
          b64: bytes.toString('base64'),
        });
      }
      continue;
    }

    const t = it.text;
    if (!t) continue;

    // 章头下一行「1921 · 幼年」
    if (!cur.years && !cur.blocks.length &&
        /^[0-9]{4}(?:\s*[-—–~至]\s*[0-9]{0,4})?\s*(?:·.*)?$/.test(t)) {
      const parts = t.split('·');
      cur.years = String(parts[0] || '').trim();
      cur.stage = String(parts[1] || '').trim();
      continue;
    }
    // 「……」：第一个当章引语，其余当引文块
    if (/^「[\s\S]*」$/.test(t)) {
      const inner = t.slice(1, -1).trim();
      if (!cur.quote && !cur.blocks.length) cur.quote = inner;
      else cur.blocks.push({ type: 'quote', text: inner });
      continue;
    }
    cur.blocks.push({ type: 'text', text: t });
  }

  /* 章之前的内容 = 封面 + 档案信息。只有在真有章节时才当封面读——
     整篇没有章标题的文档，前面那些段落是正文，不能拿第一句当人名。 */
  if (chapters.length) {
    for (const it of headItems) {
      const t = it.text;
      if (!t) continue;
      const mno = /^档案编号\s*[：:]\s*(.+)$/.exec(t);
      if (mno) { meta.archive_no = mno[1].trim(); continue; }
      if (/^(篇幅|整理日期|共\s*\d+\s*章)\s*[：:]/.test(t)) continue;
      const my = /^([0-9]{4}(?:\s*[-—–~至]\s*[0-9]{0,4})?)\s*(?:·\s*(.*))?$/.exec(t);
      if (my && !meta.years) { meta.years = my[1]; meta.hometown = String(my[2] || '').trim(); continue; }
      if (/^「[\s\S]*」$/.test(t) && !meta.intro) { meta.intro = t.slice(1, -1).trim(); continue; }
      if (!meta.archive_no && /^[A-Za-z]{1,8}[-0-9]{2,}$/.test(t)) { meta.archive_no = t; continue; }
      // 人名：短、且不像句子（不带句读）
      if (!meta.subject_name && t.length <= 24 && !/[。！？，、；：]/.test(t)) { meta.subject_name = t; continue; }
    }
  }

  meta.birth_year = meta.years ? (parseInt(meta.years, 10) || null) : null;

  /* 一章都没认出来：整篇当一章，别让用户白选一次文件 */
  const stat = { chapters: 0, paragraphs: 0, words: 0, photos: 0 };
  if (!chapters.length) {
    const all = [];
    for (const it of items) {
      if (it.text) all.push({ type: 'text', text: it.text });
      for (const p of it.imgs) {
        if (!files[p] || imgCount >= MAX_IMGS) continue;
        imgCount++;
        all.push({ type: 'photo', name: path.basename(p), caption: '', b64: files[p].toString('base64') });
      }
    }
    if (all.length) {
      chapters.push({ title: meta.subject_name || '全文', years: '', stage: '', quote: '', blocks: all });
      warnings.push('没找到章节标题，把整篇当成一章导入了');
    } else {
      throw new Error('这个 Word 里没读到文字（可能是扫描件或纯图片）');
    }
  }

  for (const c of chapters) {
    stat.chapters++;
    for (const b of c.blocks) {
      if (b.type === 'photo') stat.photos++;
      else { stat.paragraphs++; stat.words += String(b.text || '').length; }
    }
  }

  return {
    format: 'mylife-docx',
    archive: meta,
    chapters: chapters,
    stats: stat,
    warnings: warnings,
    suggest_name: meta.subject_name || String(fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]\d{6,8}$/, ''),
  };
}

function apiDocxParse(body) {
  try {
    let b64 = String(body.base64 || '');
    const comma = b64.indexOf(',');
    if (b64.indexOf('data:') === 0 && comma > 0) b64 = b64.slice(comma + 1);
    if (!b64) throw new Error('没有收到文件内容，可能选文件时被取消了');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('文件是空的');
    if (buf.length > 80 * 1024 * 1024) throw new Error('这个 Word 超过 80MB，先用 Word 压一下里面的图片再导');
    const r = parseDocx(buf, body.name || '');
    r.ok = true;
    return r;
  } catch (e) {
    // 读不出来是常事（选错文件、加密文档、扫描件），如实说，不要抛给前端当异常
    return { ok: false, message: e.message || '这个 Word 读不出来' };
  }
}

/* ---------------- 服务 ---------------- */

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const m = /(?:^|;\s*)mylife_token=([^;]+)/.exec(raw);
  return m ? m[1] : null;
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ''));
  return m ? m[1].trim() : null;
}

/** 给 <img src>/<audio src> 兜底：这两个标签发不了自定义头，也不一定带得上 cookie */
function queryToken(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || null;
  } catch (e) {
    return null;
  }
}

function authUser(req) {
  const t = bearerToken(req) || cookieToken(req) || queryToken(req);
  const u = AUTH.verify(t);
  console.log('[auth]', pathname_hint, 'token=' + (t ? t.slice(0, 8) + '...' : '无'), '->', u ? 'uid=' + u.uid : '无效');
  return u;
}
let pathname_hint = '';

async function handleAuth(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST,GET,OPTIONS',
    });
    return res.end();
  }
  try {
    const body = await readBody(req);

    if (pathname === '/api/auth/sms') {
      SMS.send(body.phone, null);
      return sendJson(res, 200, { ok: true, message: '验证码已发送（演示版固定 ' + AUTH.CODE_FIXED + '）' });
    }
    if (pathname === '/api/auth/register') {
      const out = AUTH.register(body.phone, body.password, body.code, body.nickname);
      res.setHeader('Set-Cookie',
        'mylife_token=' + out.token + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax');
      return sendJson(res, 200, {
        ok: true, token: out.token, uid: out.uid, phone: out.phone,
        isAdmin: out.isAdmin, migrated: out.migrated,
        message: out.migrated ? '注册成功，v0.2 的旧档案已归属这个账号' : (out.isAdmin ? '注册成功，你已是管理员' : '注册成功'),
      });
    }
    if (pathname === '/api/auth/login') {
      const out = AUTH.login(body.phone, body.password);
      res.setHeader('Set-Cookie',
        'mylife_token=' + out.token + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax');
      return sendJson(res, 200, { ok: true, token: out.token, uid: out.uid, phone: out.phone });
    }

    const user = authUser(req);
    if (pathname === '/api/auth/me') {
      if (!user) return sendJson(res, 401, { __auth: '需要登录' });
      return sendJson(res, 200, { ok: true, uid: user.uid, phone: user.phone, nickname: user.nickname, isAdmin: AUTH.isAdmin(user.uid) });
    }
    if (pathname === '/api/auth/logout') {
      if (user) AUTH.logout(bearerToken(req) || cookieToken(req));
      res.setHeader('Set-Cookie', 'mylife_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 用户管理（管理员） ---- */
    if (pathname === '/api/auth/users' && req.method === 'GET') {
      if (!user || !AUTH.isAdmin(user.uid)) return sendJson(res, 403, { __error: '需要管理员权限' });
      return sendJson(res, 200, { ok: true, users: AUTH.listUsers(), me: user.uid });
    }
    if (pathname === '/api/auth/users' && req.method === 'POST') {
      if (!user || !AUTH.isAdmin(user.uid)) return sendJson(res, 403, { __error: '需要管理员权限' });
      const out = AUTH.addUser(user.uid, body.phone, body.password, body.nickname, !!body.isAdmin);
      return sendJson(res, 200, Object.assign({ ok: true }, out));
    }
    var um = /^\/api\/auth\/users\/(\d+)$/.exec(pathname);
    if (um && req.method === 'DELETE') {
      if (!user || !AUTH.isAdmin(user.uid)) return sendJson(res, 403, { __error: '需要管理员权限' });
      return sendJson(res, 200, Object.assign({ ok: true }, AUTH.deleteUser(user.uid, um[1])));
    }
    var rm = /^\/api\/auth\/users\/(\d+)\/reset$/.exec(pathname);
    if (rm && req.method === 'POST') {
      if (!user || !AUTH.isAdmin(user.uid)) return sendJson(res, 403, { __error: '需要管理员权限' });
      return sendJson(res, 200, Object.assign({ ok: true }, AUTH.resetPassword(user.uid, rm[1], body.password)));
    }
    if (pathname === '/api/auth/me/password' && req.method === 'POST') {
      if (!user) return sendJson(res, 401, { __auth: '需要登录' });
      return sendJson(res, 200, Object.assign({ ok: true }, AUTH.changePassword(user.uid, body.old, body.password)));
    }
    if (pathname === '/api/auth/me/security' && req.method === 'POST') {
      if (!user) return sendJson(res, 401, { __auth: '需要登录' });
      return sendJson(res, 200, Object.assign({ ok: true }, AUTH.setSecurity(user.uid, body.question, body.answer)));
    }
    if (pathname === '/api/auth/recover/q' && req.method === 'POST') {
      try { return sendJson(res, 200, Object.assign({ ok: true }, AUTH.getSecurityQuestion(body.phone))); }
      catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    }
    if (pathname === '/api/auth/recover' && req.method === 'POST') {
      try { return sendJson(res, 200, Object.assign({ ok: true }, AUTH.recoverPassword(body.phone, body.answer, body.password))); }
      catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    }
    return sendJson(res, 404, { __error: '未知接口 ' + pathname });
  } catch (e) {
    return sendJson(res, 200, { ok: false, message: e.message || '操作失败' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  pathname_hint = pathname;

  try {
    if (pathname.startsWith('/api/auth/')) return await handleAuth(req, res, pathname);

    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST,GET,OPTIONS',
        });
        return res.end();
      }
      const user = authUser(req);
      if (!user) return sendJson(res, 401, { __auth: '需要登录' });

      const udb = dbForUser(user.uid);
      const files = path.join(DATA, 'users', String(user.uid), 'files');
      return RLS.run({ uid: user.uid, db: udb, files: files }, async () => {
        // 错误处理必须在这层里面——RLS.run 返回的 Promise 不会传回外层的 try
        try {
          const body = await readBody(req);
          let out;
          if (pathname === '/api/query') out = apiQuery(body);
          else if (pathname === '/api/exec') out = apiExec(body);
          else if (pathname === '/api/ai') out = await apiAi(body);
          else if (pathname === '/api/ai/models') out = await apiAiModels(body);
          else if (pathname === '/api/ai/test') out = await apiAiTest(body);
          else if (pathname === '/api/ai/chat') return await apiChatStream(req, res, body);
          else if (pathname === '/api/ai/usage') out = usageSummary(body);
          else if (pathname === '/api/file') out = apiFile(body);
          else if (pathname === '/api/asr') out = await apiAsr(body);
          else if (pathname === '/api/tts') out = await apiTts(body);
          else if (pathname === '/api/song/make') out = await apiSongMake(body);
          else if (pathname === '/api/image') out = await apiImage(body);
          else if (pathname === '/api/render/probe') out = apiRenderProbe();
          else if (pathname === '/api/movie/plan') out = apiMoviePlan(body);
          else if (pathname === '/api/jobs') out = apiJobGet(body);
          else if (pathname === '/api/jobs/create') out = apiJobCreate(body);
          else if (pathname === '/api/jobs/cancel') out = apiJobCancel(body);
          else if (pathname === '/api/export/pdf') out = await apiExportPdf(body);
          else if (pathname === '/api/export/save') out = apiExportSave(body);
          else if (pathname === '/api/docx/parse') out = apiDocxParse(body);
          else return sendJson(res, 404, { __error: '未知接口 ' + pathname });
          return sendJson(res, 200, out);
        } catch (e) {
          return sendJson(res, 200, { __error: e.message || String(e) });
        }
      });
    }

    if (pathname.startsWith('/files/')) {
      const user = authUser(req);
      if (!user) return sendText(res, 401, '需要登录');
      const files = path.join(DATA, 'users', String(user.uid), 'files');
      const rel = pathname.slice(7).replace(/\.\./g, '');
      const abs = path.join(files, rel);
      if (!abs.startsWith(files)) return sendText(res, 404, 'not found');
      return sendFile(req, res, abs);
    }

    // 静态文件（web/）
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const clean = rel.replace(/\.\./g, '');

    // 内置 assets：resources/ 磁盘上没有的文件，从 exe 里取（单文件分发模式）
    if (sea) {
      const key = ('web/' + clean).replace(/\\/g, '/');
      const buf = assetGet(key);
      if (buf) {
        const type = MIME[path.extname(key).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache' });
        return res.end(buf);
      }
    }

    const abs = path.join(WEB, clean);
    if (!abs.startsWith(WEB)) return sendText(res, 404, 'not found');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      // 单页应用：未知路径回 index.html（内置的也要兜住）
      if (sea && !fs.existsSync(path.join(WEB, 'index.html'))) {
        const idx = assetGet('web/index.html');
        if (idx) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': idx.length, 'cache-control': 'no-cache' });
          return res.end(idx);
        }
      }
      return sendFile(req, res, path.join(WEB, 'index.html'), 'no-cache');
    }
    return sendFile(req, res, abs, 'no-cache');

  } catch (e) {
    if (pathname.startsWith('/api/')) return sendJson(res, 200, { __error: String(e.message || e) });
    sendText(res, 500, '服务器出了点问题：' + (e.message || e));
  }
});

// 打包后前端有两种来源：resources/ 磁盘（可随时改界面）或 exe 内置 assets（单文件分发）。
// 只有两边都没有才值得报错。
if (sea && !fs.existsSync(WEB) && !assetKeys) {
  console.error('');
  console.error('找不到界面文件（resources/web 或内置资源都不在）。');
  console.error('请重新运行打包：node tools/build-exe.js');
  process.exit(1);
}

/* 端口被占：不退出，自动往后找一个能用的端口。
 * 以前这里直接 process.exit(1)，双击 exe 的用户只看到一个黑窗一闪，
 * 于是结论是"网页打不开"——实际上只是上一次的程序还开着。 */
let listenPort = PORT;
let portTries = 0;

/**
 * 把启动情况追加到 data/启动日志.txt。
 * 用户说「打不开」时，这是唯一能拿到现场的东西——黑窗口一闪就没了，
 * 截图也来不及。所以每次启动都留一行，失败也留。
 */
function startLog(line) {
  try {
    const p = path.join(DATA, '启动日志.txt');
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    let old = '';
    try {
      const st = fs.statSync(p);
      if (st.size > 200 * 1024) old = '';            // 超过 200KB 就重来，别无限长
      else old = fs.readFileSync(p, 'utf8');
    } catch (e) { old = ''; }
    const head = old || '我的人生档案 · 启动日志（打不开的时候，把这个文件发出来就能定位）\n\n';
    fs.writeFileSync(p, head + '[' + stamp + '] ' + line + '\n', 'utf8');
  } catch (e) { /* 日志写不了也不能影响启动 */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && portTries < 12) {
    portTries++;
    listenPort = PORT + portTries;
    console.error('  端口 ' + (PORT + portTries - 1) + ' 被占用，改用 ' + listenPort + '');
    startLog('端口 ' + (PORT + portTries - 1) + ' 被占用，改用 ' + listenPort);
    setTimeout(() => { try { server.listen(listenPort, HOST); } catch (x) {} }, 120);
    return;
  }
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('端口 ' + PORT + ' 到 ' + (PORT + 11) + ' 都被占用了。');
    console.error('多半是之前的程序开了太多没关。把它们关掉再双击；');
    console.error('或者换个端口启动： set PORT=4401 && MyLife.exe');
    startLog('失败：' + PORT + '~' + (PORT + 11) + ' 端口全被占用');
  } else {
    console.error('启动失败：' + (e.message || e));
    startLog('失败：' + (e.message || e));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  jobsStart();          // 重启后把没跑完的任务捡起来
  try { ffmpegPath(); } catch (e) {}   // 内置的 ffmpeg 先解出来，第一次用的时候就不用等
  const addr = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + listenPort;
  const hasLegacy = fs.existsSync(path.join(DATA, 'archive.db'));
  console.log('');
  console.log('  我的人生档案 · The Story of My Life  ' + VERSION);
  console.log('  ' + addr);
  console.log('  数据目录：' + DATA);
  if (hasLegacy) {
    console.log('');
    console.log('  ★ 检测到 v0.2 的旧数据。注册第一个账号时它会自动归属到该账号。');
  }
  console.log('');
  console.log('  在这个黑窗口里按 Ctrl+C 或者关掉它就退出了。');
  console.log('');
  startLog('启动成功 ' + VERSION + ' → ' + addr + '（数据：' + DATA + '）');

  // 打包版双击运行：直接把浏览器打开，不用自己去敲地址。
  // 只在桌面系统上尝试；命令不存在也绝不能让服务退出——
  // Linux/mac 上没有 cmd，曾把整个服务炸掉（Unhandled 'error' event）。
  if (sea && !process.env.NO_OPEN) {
    try {
      const { spawn } = require('child_process');
      const cmd = process.platform === 'win32' ? 'cmd'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', addr] : [addr];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});   // 没装浏览器 / 命令不存在：吞掉，地址已在上面打印
      child.unref();
    } catch (e) { /* 打不开也无妨，地址已经打在上面了 */ }
  }
});
