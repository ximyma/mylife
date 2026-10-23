/**
 * v0.3 多用户隔离专项审计。
 * 起一个独立服务实例（DATA_DIR=audit-auth-data，不碰真实数据），
 * 注册两个账号，验证：401 / 注册校验 / 登录 / 隔离 / 迁移 / 退出。
 * 用法：node test/audit-auth.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp', 'audit-auth-data');
const PORT = 4402;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, failN = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + (d || '') : '')); } };

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        token ? { 'Authorization': 'Bearer ' + token } : {}),
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

let serverProc = null;
function startServer() {
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { DATA_DIR: DATA_DIR, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  serverProc.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));
  serverProc.on('exit', (c) => { process.stdout.write('[srv-exit] code=' + c + '\n'); });
}
function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} }
}

(async () => {
  // 干净环境 + 预置一个"v0.2 旧库"用于迁移测试
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'files', 'photo'), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(path.join(DATA_DIR, 'archive.db'));
  legacy.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
  legacy.exec("INSERT INTO archives (subject_name) VALUES ('v0.2老人')");
  legacy.exec("INSERT INTO segments (archive_id, raw_text) VALUES (1, '旧数据里的讲述')");
  legacy.close();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  fs.writeFileSync(path.join(DATA_DIR, 'files', 'photo', 'legacy.png'), png);

  startServer();
  await new Promise(r => setTimeout(r, 2500));

  console.log('[A] 未登录拦截');
  let r = await post('/api/query', { sql: 'SELECT 1' });
  ck('A1 未登录 401', r.status === 401);
  r = await post('/api/file', { op: 'read', path: 'photo/legacy.png' });
  ck('A2 未登录文件 401', r.status === 401);

  console.log('[B] 注册校验');
  r = await post('/api/auth/register', { phone: '13800000001', password: 'abc123', code: '9999' });
  ck('B1 错验证码拒绝', r.json.ok === false);
  r = await post('/api/auth/register', { phone: '1380000001', password: 'abc123', code: '1234' });
  ck('B2 手机号格式拒绝', r.json.ok === false);
  r = await post('/api/auth/register', { phone: '13800000001', password: '12345', code: '1234' });
  ck('B3 短密码拒绝', r.json.ok === false);

  console.log('[C] 首个注册 + 迁移');
  r = await post('/api/auth/register', { phone: '13800000001', password: 'abc123', code: '1234', nickname: '老大' });
  ck('C1 注册成功', r.json.ok === true && r.json.token);
  ck('C2 触发旧数据迁移', r.json.migrated === true);
  const tokenA = r.json.token;
  ck('C3 迁移后能看到 v0.2 的档案', (await post('/api/query', { sql: 'SELECT count(*) n FROM archives' }, tokenA)).json[0].n === 1);
  ck('C4 迁移后旧文件可见', (await post('/api/file', { op: 'read', path: 'photo/legacy.png' }, tokenA)).json.ok === true);
  r = await post('/api/auth/register', { phone: '13800000001', password: 'abc123', code: '1234' });
  ck('C5 重复手机号拒绝', r.json.ok === false);

  console.log('[D] 第二个用户 + 隔离');
  r = await post('/api/auth/register', { phone: '13900000002', password: 'xyz789', code: '1234' });
  ck('D1 第二个账号注册（不迁移）', r.json.ok === true && r.json.migrated === false);
  const tokenB = r.json.token;
  r = await post('/api/query', { sql: 'SELECT count(*) n FROM archives' }, tokenB);
  ck('D2 B 的库是空的', r.json[0].n === 0);
  r = await post('/api/query', { sql: "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='archives'" }, tokenB);
  ck('D3 B 有自己的独立库', r.json[0].n === 1);
  await post('/api/exec', { sql: "INSERT INTO archives (subject_name) VALUES ('B的老人')" }, tokenB);
  r = await post('/api/query', { sql: 'SELECT count(*) n FROM archives' }, tokenA);
  ck('D4 B 写入不影响 A', r.json[0].n === 1);
  r = await post('/api/file', { op: 'read', path: 'photo/legacy.png' }, tokenB);
  ck('D5 B 读不到 A 的文件', r.json.ok !== true && r.json.__error);

  console.log('[E] 登录与安全');
  r = await post('/api/auth/login', { phone: '13800000001', password: 'wrong' });
  ck('E1 错密码拒绝', r.json.ok === false);
  r = await post('/api/auth/login', { phone: '13800000001', password: 'abc123' });
  ck('E2 正确密码登录', r.json.ok === true);
  r = await post('/api/auth/me', {}, r.json.token);
  ck('E3 me 返回账号', r.json.ok === true && r.json.phone === '13800000001');
  r = await post('/api/auth/logout', {}, tokenA);
  ck('E4 退出成功', r.json.ok === true);
  r = await post('/api/query', { sql: 'SELECT 1' }, tokenA);
  ck('E5 退出后旧 token 失效', r.status === 401);

  console.log('[G] 清理');
  stopServer();
  await new Promise(r2 => setTimeout(r2, 800));
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  ck('G1 审计数据已清', !fs.existsSync(DATA_DIR));

  console.log('\n多用户隔离: ' + pass + ' 通过 / ' + failN + ' 失败');
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); stopServer(); process.exit(2); });
