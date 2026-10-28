/**
 * 多用户隔离加固回归：/api/query 与 /api/exec 必须拒绝 ATTACH/DETACH/load_extension，
 * 否则一个用户能把别人的 archive.db 挂进来读到别人的数据（已实测 node:sqlite 允许 ATTACH）。
 * 同时验证注释前缀、多语句绕过都会被拦住，且正常 SELECT 不受影响。
 * 用法：node test/audit-query-guard.js
 */
'use strict';
const path = require('path');
const { startServer } = require('./_lib');

let pass = 0, failN = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { failN++; console.log('  ✗ ' + n + (d ? ' << ' + (d || '') : '')); }
};

(async () => {
  const s = startServer('query-guard');
  try {
    await s.waitReady();

    // 用户 A（uid=1）：首个注册者，管理员
    const tokenA = await s.register();
    await s.post('/api/exec', { sql: "INSERT INTO archives (subject_name) VALUES ('A的隐私档案')" }, tokenA);

    // 用户 B（uid=2）
    const phoneB = '139' + String(Date.now()).slice(-8);
    const rb = await s.post('/api/auth/register', { phone: phoneB, password: 'audit123', code: '1234' });
    const tokenB = rb.token;
    ck('第二个账号注册成功', !!tokenB, JSON.stringify(rb).slice(0, 120));

    const aDb = path.join(s.DATA_DIR, 'users', '1', 'archive.db').replace(/\\/g, '/');

    // 1) 直接 ATTACH
    const at = await s.post('/api/query', { sql: "ATTACH DATABASE '" + aDb + "' AS o" }, tokenB);
    ck('直接 ATTACH 被拒', !!at.__error, JSON.stringify(at).slice(0, 140));

    // 2) 注释前缀绕过
    const at2 = await s.post('/api/query', { sql: '-- hi\nATTACH DATABASE \'' + aDb + '\' AS o2' }, tokenB);
    ck('注释前缀 ATTACH 被拒', !!at2.__error, JSON.stringify(at2).slice(0, 140));

    // 3) 多语句绕过
    const at3 = await s.post('/api/query', { sql: "SELECT 1;\nATTACH DATABASE '" + aDb + "' AS o3" }, tokenB);
    ck('多语句中的 ATTACH 被拒', !!at3.__error, JSON.stringify(at3).slice(0, 140));

    // 4) exec 通道也不能 ATTACH
    const at4 = await s.post('/api/exec', { sql: "ATTACH DATABASE '" + aDb + "' AS o4" }, tokenB);
    ck('exec 通道 ATTACH 被拒', !!at4.__error, JSON.stringify(at4).slice(0, 140));

    // 5) load_extension
    const at5 = await s.post('/api/query', { sql: "select load_extension('evil')" }, tokenB);
    ck('load_extension 被拒', !!at5.__error, JSON.stringify(at5).slice(0, 140));

    // 6) 确认 ATTACH 没成功：B 的库里看不到 o.* 表（若挂上了就会读到 A 的 archives）
    const leak = await s.post('/api/query', { sql: 'SELECT count(*) n FROM o.archives' }, tokenB);
    ck('ATTACH 未生效（查 o.archives 失败）', !!leak.__error, JSON.stringify(leak).slice(0, 140));

    // 7) 正常 SELECT 仍可用
    const ok = await s.post('/api/query', { sql: 'SELECT count(*) n FROM archives' }, tokenB);
    ck('正常 SELECT 仍可用', Array.isArray(ok) && ok[0] && Number(ok[0].n) === 0, JSON.stringify(ok).slice(0, 120));

    // 8) 正常 INSERT（正文里含"attach"字样也不该误伤）
    const ins = await s.post('/api/exec',
      { sql: "INSERT INTO archives (subject_name) VALUES ('讲讲 attach database 这个命令')" }, tokenB);
    ck('正文含 attach 字样的正常写入不被误伤', ins && ins.ok === true, JSON.stringify(ins).slice(0, 120));
  } finally {
    s.stop();
  }

  console.log('\n隔离加固：' + pass + ' 通过 / ' + failN + ' 失败');
  process.exit(failN ? 1 : 0);
})();
