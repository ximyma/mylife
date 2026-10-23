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

const EXE_DIR = path.dirname(process.execPath);        // 打包后的基准目录
const BASE = sea ? path.join(EXE_DIR, 'resources') : path.join(__dirname, '..');

const ROOT = BASE;
const WEB = path.join(ROOT, 'web');
// 开发时 schema.sql 就躺在 server/ 里；打包后才挪到 resources/
const SCHEMA_FILE = sea ? path.join(BASE, 'schema.sql') : path.join(__dirname, 'schema.sql');
const DATA = process.env.DATA_DIR || (sea ? path.join(EXE_DIR, 'data') : path.join(ROOT, 'data'));
const FILES = path.join(DATA, 'files');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA, { recursive: true });
for (const k of ['photo', 'audio', 'video']) fs.mkdirSync(path.join(FILES, k), { recursive: true });

/* ---------------- 数据库 ---------------- */

const DB_FILE = path.join(DATA, 'archive.db');
const fresh = !fs.existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// schema 里全是 IF NOT EXISTS / INSERT OR IGNORE，所以每次启动都跑一遍：
// 加新表自动生效，不需要维护迁移器。
{
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
  let ok = 0, all = 0;
  for (const stmt of schema.split(';')) {
    const clean = stmt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (!clean) continue;
    all++;
    try { db.exec(clean); ok++; }
    catch (e) { console.warn('[schema] 跳过：', clean.slice(0, 50), e.message); }
  }
  console.log(`${fresh ? '新建' : '已有'}数据库，结构 ${ok}/${all} 条就绪`);
}

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
  const stmt = db.prepare(body.sql);
  return stmt.all(...bind(body.params));
}

function apiExec(body) {
  const sql = String(body.sql || '');
  const low = sql.trim().toLowerCase();
  if (low.startsWith('select') || low.startsWith('pragma')) throw new Error('exec 不接受查询语句');
  if (/^(drop|alter|attach|create|vacuum)/.test(low)) throw new Error('exec 不允许改表结构');
  const r = db.prepare(sql).run(...bind(body.params));
  return { ok: true, changes: Number(r.changes || 0), lastId: Number(r.lastInsertRowid || 0) };
}

/* ---- AI：配置、拉模型、测试、对话 ---- */

function profileById(id) {
  return db.prepare('SELECT * FROM ai_profiles WHERE id=?').get(Number(id));
}

function profileForSlot(slot) {
  const row = db.prepare('SELECT profile_id, model FROM ai_slots WHERE slot=?').get(slot);
  if (!row || !row.profile_id) return null;
  const p = profileById(row.profile_id);
  return p ? { profile: p, model: row.model || p.default_model } : null;
}

function defaultProfile() {
  return db.prepare('SELECT * FROM ai_profiles WHERE enabled=1 ORDER BY sort, id LIMIT 1').get();
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
    db.prepare('UPDATE ai_profiles SET models_json=? WHERE id=?').run(JSON.stringify(ids), p.id);
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

  const abs = path.join(FILES, rel);
  if (!abs.startsWith(FILES) || !fs.existsSync(abs)) {
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

    const dir = path.join(FILES, kind);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    if (body.append) fs.appendFileSync(abs, buf);
    else fs.writeFileSync(abs, buf);

    return { ok: true, path: kind + '/' + name, bytes: fs.statSync(abs).size };
  }

  if (op === 'read') {
    const abs = path.join(FILES, safePath(body.path));
    if (!abs.startsWith(FILES) || !fs.existsSync(abs)) throw new Error('文件不存在');
    return { ok: true, base64: fs.readFileSync(abs).toString('base64'), bytes: fs.statSync(abs).size };
  }

  if (op === 'del') {
    const abs = path.join(FILES, safePath(body.path));
    if (!abs.startsWith(FILES)) return { ok: false };
    try { fs.unlinkSync(abs); return { ok: true }; } catch { return { ok: false }; }
  }

  if (op === 'list') {
    const dir = path.join(FILES, safe(body.kind));
    if (!fs.existsSync(dir)) return { ok: true, items: [] };
    return {
      ok: true,
      items: fs.readdirSync(dir).map(n => ({ name: n, bytes: fs.statSync(path.join(dir, n)).size })),
    };
  }

  throw new Error('未知操作 ' + op);
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST,GET,OPTIONS',
        });
        return res.end();
      }
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
    }

    if (pathname.startsWith('/files/')) {
      const rel = pathname.slice(7).replace(/\.\./g, '');
      const abs = path.join(FILES, rel);
      if (!abs.startsWith(FILES)) return sendText(res, 404, 'not found');
      return sendFile(req, res, abs);
    }

    // 静态文件（web/）
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const abs = path.join(WEB, rel.replace(/\.\./g, ''));
    if (!abs.startsWith(WEB)) return sendText(res, 404, 'not found');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      // 单页应用：未知路径回 index.html
      return sendFile(req, res, path.join(WEB, 'index.html'), 'no-cache');
    }
    return sendFile(req, res, abs, 'no-cache');

  } catch (e) {
    if (pathname.startsWith('/api/')) return sendJson(res, 200, { __error: String(e.message || e) });
    sendText(res, 500, '服务器出了点问题：' + (e.message || e));
  }
});

// 打包后 resources/ 是必须的，缺失时早一点说清楚，别让用户对着白屏猜
if (sea && !fs.existsSync(WEB)) {
  console.error('');
  console.error('找不到 resources/web 目录。');
  console.error('请把 MyLife.exe 和它旁边的 resources 文件夹放在同一个目录下。');
  console.error('当前 exe 位置：' + EXE_DIR);
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
  console.log('');
  console.log('  我的人生档案 · The Story of My Life');
  console.log('  ' + addr);
  console.log('  数据目录：' + DATA);
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
