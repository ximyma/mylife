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
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
  `);
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

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPw(password, salt);
  const r = adb.prepare('INSERT INTO users (phone, password_hash, salt, nickname) VALUES (?, ?, ?, ?)')
    .run(phone, hash, salt, nickname || null);
  const uid = Number(r.lastInsertRowid);

  let migrated = false;
  if (userCount() === 1 && firstUserMigrate) {
    migrated = !!firstUserMigrate(uid);
  }
  return { uid, token: issueToken(uid), phone, migrated };
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

module.exports = { init, register, login, sms, verify, logout, CODE_FIXED };
