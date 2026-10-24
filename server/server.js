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
const { DatabaseSync } = require('node:sqlite');

const VERSION = 'v0.8.0';   // 与 CHANGELOG.md、web/app.js、安卓 versionName 保持一致

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

return { init, register, login, sms, verify, logout, CODE_FIXED };

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
      // ALTER TABLE 加列在第二次打开时必然"重复列名"——这是幂等迁移的正常现象，不用刷屏
      const msg = String(e && e.message || '');
      if (/duplicate column name|already exists/i.test(msg)) continue;
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
  return d;
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

function apiQuery(body) {
  const stmt = ctxDb().prepare(body.sql);
  return stmt.all(...bind(body.params));
}

function apiExec(body) {
  const sql = String(body.sql || '');
  const low = sql.trim().toLowerCase();
  if (low.startsWith('select') || low.startsWith('pragma')) throw new Error('exec 不接受查询语句');
  if (/^(drop|alter|attach|create|vacuum)/.test(low)) throw new Error('exec 不允许改表结构');
  const r = ctxDb().prepare(sql).run(...bind(body.params));
  return { ok: true, changes: Number(r.changes || 0), lastId: Number(r.lastInsertRowid || 0) };
}

/* ---- AI：配置、拉模型、测试、对话 ---- */

function profileById(id) {
  return ctxDb().prepare('SELECT * FROM ai_profiles WHERE id=?').get(Number(id));
}

function profileForSlot(slot) {
  const row = ctxDb().prepare('SELECT profile_id, model FROM ai_slots WHERE slot=?').get(slot);
  if (!row || !row.profile_id) return null;
  const p = profileById(row.profile_id);
  return p ? { profile: p, model: row.model || p.default_model } : null;
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

  const voice = String(body.voice || 'alloy');
  const speed = Number(body.speed) || 1;
  const dir = path.join(ctxFiles(), 'ai', 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const errors = [];

  for (const cand of chain.slice(0, 3)) {
    const model = cand.model || 'tts-1';
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

  for (const cand of chain.slice(0, 2)) {
    const model = cand.model || 'Kwai-Kolors/Kolors';
    const key = imgKey(prompt, model, size);

    try {
      const hit = ctxDb().prepare("SELECT path FROM ai_assets WHERE cache_key=? AND capability='image'").get(key);
      if (hit && hit.path && fs.existsSync(path.join(ctxFiles(), hit.path))) {
        return { ok: true, path: hit.path, cached: true, model: model };
      }
    } catch (e) {}

    try {
      const t0 = Date.now();
      const r = await fetchJson(endpointOf(cand.profile) + '/images/generations', {
        method: 'POST',
        headers: authHeaders(cand.profile),
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          image_size: size,
          batch_size: 1,
          num_inference_steps: Number(body.steps) || 20,
          guidance_scale: Number(body.cfg) || 7.5,
        }),
      }, 180000);

      if (!r.ok) {
        errors.push(cand.profile.name + ' HTTP ' + r.status + '：' + String(r.text).slice(0, 150));
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

      const rel = 'ai/img/' + key + '.jpg';
      fs.writeFileSync(path.join(ctxFiles(), rel), buf);
      try {
        ctxDb().prepare('INSERT INTO ai_assets (capability, cache_key, path, prompt, model) VALUES (?,?,?,?,?)')
          .run('image', key, rel, prompt.slice(0, 300), model);
      } catch (e) {}
      usageAdd('image', model, 1, 'image', 0, 'image');

      return {
        ok: true, path: rel, bytes: buf.length, model: model, ms: Date.now() - t0, cached: false,
        note: '图片由 AI 生成，服务商会在角落加标识',
      };
    } catch (e) {
      errors.push(cand.profile.name + ' 连不上：' + (e.message || e));
    }
  }

  return { ok: false, message: '没画出来：' + errors.join('；') };
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
        migrated: out.migrated,
        message: out.migrated ? '注册成功，v0.2 的旧档案已归属这个账号' : '注册成功',
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
      return sendJson(res, 200, { ok: true, uid: user.uid, phone: user.phone, nickname: user.nickname });
    }
    if (pathname === '/api/auth/logout') {
      if (user) AUTH.logout(bearerToken(req) || cookieToken(req));
      res.setHeader('Set-Cookie', 'mylife_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
      return sendJson(res, 200, { ok: true });
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
          else if (pathname === '/api/image') out = await apiImage(body);
          else if (pathname === '/api/render/probe') out = apiRenderProbe();
          else if (pathname === '/api/jobs') out = apiJobGet(body);
          else if (pathname === '/api/jobs/create') out = apiJobCreate(body);
          else if (pathname === '/api/jobs/cancel') out = apiJobCancel(body);
          else if (pathname === '/api/export/pdf') out = await apiExportPdf(body);
          else if (pathname === '/api/export/save') out = apiExportSave(body);
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

// 端口被别的程序占了，给句人话，别抛一堆 ERR_ 堆栈
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('端口 ' + PORT + ' 已经被占用了。');
    console.error('多半是上一次的程序还没关。关掉它再双击；');
    console.error('或者换个端口启动： set PORT=4401 && MyLife.exe');
  } else {
    console.error('启动失败：' + (e.message || e));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  jobsStart();          // 重启后把没跑完的任务捡起来
  try { ffmpegPath(); } catch (e) {}   // 内置的 ffmpeg 先解出来，第一次用的时候就不用等
  const addr = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
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

  // 打包版双击运行：直接把浏览器打开，不用自己去敲地址
  if (sea) {
    try {
      require('child_process')
        .spawn('cmd', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore' })
        .unref();
    } catch (e) { /* 打不开也无妨，地址已经打在上面了 */ }
  }
});
