/**
 * 审计公共库：起一个隔离的服务实例（独立数据目录 + 随机端口），
 * 注册一个审计账号，返回带 token 的请求函数。用完 stop() 清理。
 * 这样审计永远不碰真实数据，也不会触发迁移逻辑。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

function startServer(tag) {
  // 固定名字方便翻现场，但清不干净时（文件被占用/权限受限）必须让路：
  // 否则上一轮残留的库会让「注册」撞号，整轮审计直接崩在起跑线上。
  let DATA_DIR = path.join(__dirname, '..', 'tmp', 'audit-data-' + tag);
  if (!emptyDir(DATA_DIR)) {
    DATA_DIR = path.join(__dirname, '..', 'tmp', 'audit-data-' + tag + '-' + Date.now());
    emptyDir(DATA_DIR);
  }
  const PORT = 4410 + Math.floor(Math.random() * 80);
  const proc = spawn(process.execPath, [path.join(ROOT(), 'server', 'server.js')], {
    env: Object.assign({}, process.env, { DATA_DIR: DATA_DIR, PORT: String(PORT) }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = 'http://127.0.0.1:' + PORT;

  /** 清掉整个目录；清不掉（文件被占用等）返回 false，让调用方换个名字再来 */
  function emptyDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清不掉不致命 */ }
    try { return !fs.existsSync(dir); } catch (e) { return false; }
  }

  function post(p, body, token) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, path: p, method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          token ? { 'Authorization': 'Bearer ' + token } : {}),
      }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(new Error(buf.slice(0, 150))); }
        });
      });
      req.on('error', reject);
      req.setTimeout(200000, () => req.destroy(new Error('timeout')));
      req.write(data); req.end();
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const phone = '138' + String(Date.now()).slice(-8);

  return {
    DATA_DIR, base, post, phone,
    async register() {
      const r = await post('/api/auth/register', { phone, password: 'audit123', code: '1234' });
      if (!r.ok || !r.token) throw new Error('审计账号注册失败: ' + JSON.stringify(r).slice(0, 120));
      return r.token;
    },
    async waitReady() {
      for (let i = 0; i < 40; i++) {
        try {
          const r = await post('/api/auth/sms', { phone: '13800000000' });
          if (r.ok) return;
        } catch (e) {}
        await sleep(300);
      }
      throw new Error('服务 12 秒内没就绪');
    },
    stop() {
      try { proc.kill(); } catch (e) {}
      setTimeout(() => {
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
      }, 600);
    },
  };
}

function ROOT() { return path.join(__dirname, '..'); }

module.exports = { startServer };
