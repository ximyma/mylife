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

const VERSION = 'v0.3.0';   // 与 CHANGELOG.md、web/app.js、安卓 versionName 保持一致   // 与 CHANGELOG.md、web/app.js、安卓 versionName 保持一致

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

const AUTH = require('./auth');
AUTH.init(DATA, migrateLegacy);
const SMS = require('./sms');

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
    catch (e) { console.warn('[schema] 跳过：', clean.slice(0, 50), e.message); }
  }
  console.log(`  数据库结构 ${ok}/${all} 条就绪`);
}

function dbForUser(uid) {
  if (userDbs.has(uid)) return userDbs.get(uid);
  const userDir = path.join(DATA, 'users', String(uid));
  fs.mkdirSync(path.join(userDir, 'files', 'photo'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'files', 'audio'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'files', 'video'), { recursive: true });
  const d = new DatabaseSync(path.join(userDir, 'archive.db'));
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  initSchemaOn(d);
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
async function apiAiTest(body) {
  const pick = pickProfile(body);
  if (!pick) return { ok: false, message: '还没有可用的模型配置' };
  const { profile, model } = pick;
  const useModel = model || profile.default_model;
  if (!useModel) return { ok: false, message: '这条配置还没选模型' };

  const t0 = Date.now();
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

/** 对话：支持多模态（messages 里带 image_url 直接透传） */
async function apiAi(body) {
  const pick = pickProfile(body);
  if (!pick) {
    return { ok: false, message: '还没配模型。打开「设置 → 模型」加一条。' };
  }
  const { profile, model } = pick;
  const useModel = model || profile.default_model;
  if (!useModel) return { ok: false, message: '这条配置还没选模型' };
  if (!body.messages || !body.messages.length) return { ok: false, message: '没有要发送的内容' };

  const payload = {
    model: useModel,
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    stream: false,
  };
  if (body.maxTokens) payload.max_tokens = body.maxTokens;

  const t0 = Date.now();
  try {
    const r = await fetchJson(endpointOf(profile) + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(profile),
      body: JSON.stringify(payload),
    }, 120000);
    const ms = Date.now() - t0;

    if (!r.ok) {
      return { ok: false, ms, status: r.status,
        message: `模型返回 ${r.status}：${String(r.text).slice(0, 200)}` };
    }
    const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    // 推理模型只吐思考、正文被 max_tokens 截断时，退一步拿思考内容，总比给用户一片空白强
    const body = (msg && (msg.content || msg.reasoning_content || msg.reasoning)) || '';
    return {
      ok: true,
      ms,
      model: useModel,
      profile: profile.name,
      text: body,
      usage: (r.json && r.json.usage) || null,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: '调不通：' + (e.message || e) };
  }
}

/* 路径安全：只允许落在 data/files/ 里 */
const safe = s => String(s || 'misc').replace(/\.\./g, '').replace(/[\/\\]/g, '');
const safePath = s => String(s || '').replace(/\.\./g, '').replace(/\\/g, '/');

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
  const useModel = model || body.model || profile.default_model;
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
  try {
    const r = await fetchJson(endpointOf(profile) + '/audio/transcriptions', {
      method: 'POST',
      headers: profile.api_key ? { authorization: 'Bearer ' + profile.api_key } : {},
      body: form,          // 不要手动设 content-type，让 fetch 带上 boundary
    }, 180000);
    const ms = Date.now() - t0;

    if (!r.ok) {
      return { ok: false, ms, message: `HTTP ${r.status}：${String(r.text).slice(0, 200)}` };
    }
    const text = (r.json && (r.json.text || r.json.transcript)) || '';
    if (!String(text).trim()) {
      return { ok: false, ms, message: '转出来是空的。录音里可能没说话，或者这段音频格式不支持。' };
    }
    return {
      ok: true, ms, model: useModel,
      text: String(text).trim(),
      bytes: size,
      usage: (r.json && r.json.usage) || null,
      language: (r.json && r.json.language) || null,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: '转不了：' + (e.message || e) };
  }
}

function apiFile(body) {
  const op = body.op || 'save';

  if (op === 'save') {
    const kind = safe(body.kind);
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
    if (body.append) fs.appendFileSync(abs, buf);
    else fs.writeFileSync(abs, buf);

    return { ok: true, path: kind + '/' + name, bytes: fs.statSync(abs).size };
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

function authUser(req) {
  const t = bearerToken(req) || cookieToken(req);
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
          else if (pathname === '/api/file') out = apiFile(body);
          else if (pathname === '/api/asr') out = await apiAsr(body);
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
