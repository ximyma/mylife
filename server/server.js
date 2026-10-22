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

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
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

if (fresh) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  let ok = 0, all = 0;
  for (const stmt of schema.split(';')) {
    // 逐行去掉注释后再判断
    const clean = stmt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (!clean) continue;
    all++;
    try { db.exec(clean); ok++; }
    catch (e) { console.warn('[schema] 跳过：', clean.slice(0, 50), e.message); }
  }
  console.log(`建表完成：${ok}/${all}`);
} else {
  console.log('已有数据库：' + DB_FILE);
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

/** 支持 Range：没有 206，视频拖不动进度条 */
function sendFile(req, res, abs) {
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
        'cache-control': 'private, max-age=86400',
      });
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'content-type': type, 'content-length': st.size,
    'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400',
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

async function apiAi(body) {
  const get = k => {
    const row = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
    return row ? String(row.v) : null;
  };
  const base = get('ai.base');
  const key = get('ai.key');
  const model = get('ai.model') || 'deepseek-ai/DeepSeek-V4-Flash';
  const temp = Number(get('ai.temp') || 0.7);

  if (!base) return { ok: false, message: '还没配模型。打开「设置 → 模型」，填上接口地址和 Key。' };
  if (!key) return { ok: false, message: '还没填 API Key。' };

  const url = base.replace(/\/+$/, '') + '/chat/completions';
  const payload = { model, messages: body.messages || [], temperature: temp, stream: false };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, message: `模型返回 ${r.status}：${text.slice(0, 200)}` };
    const j = JSON.parse(text);
    const content = j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content : '';
    return { ok: true, text: content };
  } catch (e) {
    return { ok: false, message: '调不通：' + (e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function apiFile(body) {
  const op = body.op || 'save';
  const safe = s => String(s || 'misc').replace(/\.\./g, '').replace(/[\/\\]/g, '');
  const safePath = s => String(s || '').replace(/\.\./g, '').replace(/\\/g, '/');

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
      else if (pathname === '/api/file') out = apiFile(body);
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
      return sendFile(req, res, path.join(WEB, 'index.html'));
    }
    return sendFile(req, res, abs);

  } catch (e) {
    if (pathname.startsWith('/api/')) return sendJson(res, 200, { __error: String(e.message || e) });
    sendText(res, 500, '服务器出了点问题：' + (e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log('我的人生档案 · http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
  console.log('数据目录：' + DATA);
});
