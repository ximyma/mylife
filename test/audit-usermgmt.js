/**
 * v0.9 用户管理专项审计：单机版多用户 + 找回密码。
 * 起独立服务（DATA_DIR=audit-usermgmt-data），验证：
 *   首个注册=管理员 / 列出 / 添加 / 非管理员拦截 / 重置他人密码 /
 *   密保设置与找回 / 删除（不能删自己、不能删最后管理员）。
 * 用法：node test/audit-usermgmt.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp', 'audit-usermgmt-data');
const PORT = 4403;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, failN = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + (d || '') : '')); }
};

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method: method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { let j; try { j = JSON.parse(buf || '{}'); } catch (e) { j = {}; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const post = (p, b, t) => req('POST', p, b, t);
const del = (p, t) => req('DELETE', p, null, t);
const get = (p, t) => req('GET', p, null, t);

let srv = null;
function start() {
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { DATA_DIR: DATA_DIR, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
}
function stop() { if (srv) try { srv.kill(); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  start();
  await sleep(1800);

  // 首个注册 = 管理员
  let r = await post('/api/auth/register', { phone: '13800138000', password: 'admin01', code: '1234', nickname: '管理员' });
  const AT = r.json.token;
  ck('首个注册返回 token', !!AT);
  ck('首个注册是管理员', r.json.isAdmin === true);

  r = await get('/api/auth/me', AT);
  ck('me 返回 isAdmin=true', r.json.isAdmin === true);

  // 列出：只有 1 个
  r = await get('/api/auth/users', AT);
  ck('列出用户=1', r.json.users && r.json.users.length === 1);

  // 添加普通用户
  r = await post('/api/auth/users', { phone: '13900139000', password: 'user123', nickname: '小李' }, AT);
  ck('管理员添加用户成功', r.json.ok === true && r.json.uid === 2);
  r = await get('/api/auth/users', AT);
  ck('列出用户=2', r.json.users.length === 2);

  // 非管理员拦截
  let r2 = await post('/api/auth/login', { phone: '13900139000', password: 'user123' });
  const UT = r2.json.token;
  r = await post('/api/auth/users', { phone: '13700137000', password: 'abcdef' }, UT);
  ck('非管理员添加被拦截(403)', r.status === 403);

  // 管理员重置用户2密码
  r = await post('/api/auth/users/2/reset', { password: 'reset01' }, AT);
  ck('重置他人密码成功', r.json.ok === true);
  r2 = await post('/api/auth/login', { phone: '13900139000', password: 'reset01' });
  ck('用新密码能登录', r2.json.ok === true && !!r2.json.token);

  // 普通用户改自己密码
  const UT2 = r2.json.token;
  r = await post('/api/auth/me/password', { old: 'reset01', password: 'self012' }, UT2);
  ck('改自己密码成功', r.json.ok === true);
  r2 = await post('/api/auth/login', { phone: '13900139000', password: 'reset01' });
  ck('改密后旧密码失效', !r2.json.ok);
  r2 = await post('/api/auth/login', { phone: '13900139000', password: 'self012' });
  ck('改密后新密码生效', r2.json.ok === true);

  // 密保：设置 + 找回
  r = await post('/api/auth/me/security', { question: '我小学班主任姓什么', answer: '王' }, AT);
  ck('设置密保成功', r.json.ok === true);
  r = await post('/api/auth/recover/q', { phone: '13800138000' });
  ck('找回-取到密保问题', r.json.ok === true && /班主任/.test(r.json.question || ''));
  r = await post('/api/auth/recover', { phone: '13800138000', answer: '王', password: 'recov01' });
  ck('找回-改密码成功', r.json.ok === true);
  r2 = await post('/api/auth/login', { phone: '13800138000', password: 'recov01' });
  ck('找回后新密码可登录', r2.json.ok === true);
  // 密保答案错
  r = await post('/api/auth/recover', { phone: '13800138000', answer: '错', password: 'x12345' });
  ck('密保答案错误被拒', !r.json.ok);

  // 删除：不能删自己
  r = await del('/api/auth/users/1', AT);
  ck('不能删除自己', !r.json.ok);
  // 删除普通用户
  r = await del('/api/auth/users/2', AT);
  ck('删除普通用户成功', r.json.ok === true);
  // 不能删最后管理员：先把用户2加回，再试删自己仍应失败（只剩1个管理员）
  r = await post('/api/auth/users', { phone: '13900139000', password: 'user123' }, AT);
  // 现在用户3是普通用户；删自己(1)应因只剩一个管理员而失败
  r = await del('/api/auth/users/1', AT);
  ck('不能删除最后一个管理员', !r.json.ok);

  stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n用户管理: ' + pass + ' 通过 / ' + failN + ' 失败');
  process.exit(failN ? 1 : 0);
}
main().catch(e => { console.error('审计异常:', e); stop(); process.exit(1); });
