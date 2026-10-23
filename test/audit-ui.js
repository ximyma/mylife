/**
 * UI 层审计：headless Chrome 加载四个页面，核对关键元素。
 * 用法： node test/audit-ui.js
 */
'use strict';
const { execFileSync } = require('child_process');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { startServer } = require('./_lib.js');
const S = startServer('ui');
const BASE = S.base;
let TOKEN = '';

let pass = 0, fail = 0;
const ck = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); } };

function dom(hash) {
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=6000', '--dump-dom', BASE + '/#' + hash], { stdio: ['ignore', 'pipe', 'ignore'] });
  // execFileSync 返回 stdout，但直接拿有转码问题，改为写临时文件
  return null;
}

function domToFile(hash, file, noAuth) {
  const url = noAuth ? BASE + '/#' + hash
    : (hash.indexOf('token=') >= 0 ? BASE + '/#' + hash : BASE + '/#' + hash + '?token=' + TOKEN);
  const out = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=8000', '--dump-dom', url],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const html = out.toString('utf8');
  require('fs').writeFileSync(file, html);
  return html;
}

const tmp = require('os').tmpdir();

S.waitReady().then(() => S.register()).then((t) => {
  TOKEN = t;
  // 审计实例是空库：先造齐 UI 要展示的东西（审计账号固定 uid=1）
  return Promise.all([
    S.post('/api/exec', { sql: "INSERT INTO archives (subject_name, birth_year, status) VALUES ('审计老人', 1950, 'ready')" }, t),
    S.post('/api/exec', { sql: "INSERT INTO chapters (archive_id, seq, title) VALUES (1, 10, '第一章')" }, t),
    S.post('/api/exec', { sql: "INSERT INTO entries (archive_id, chapter_id, seq, kind, text, origin, edited) VALUES (1, 1, 10, 'text', '测试条目', 'user', 1)" }, t),
    S.post('/api/exec', { sql: "INSERT INTO segments (archive_id, raw_text) VALUES (1, '测试讲述')" }, t),
    S.post('/api/exec', { sql: "INSERT INTO ai_profiles (name, kind, base_url, api_key, default_model, enabled, models_json) VALUES ('审计AI', 'openai', 'https://api.siliconflow.cn/v1', 'sk-audit', 'tencent/Hunyuan-MT-7B', 1, '[\"tencent/Hunyuan-MT-7B\",\"deepseek-ai/DeepSeek-OCR\",\"Qwen/Qwen3-ASR-1.7B\"]')" }, t),
    S.post('/api/exec', { sql: "UPDATE ai_slots SET profile_id=1, model='tencent/Hunyuan-MT-7B' WHERE slot='title'" }, t),
    S.post('/api/exec', { sql: "UPDATE ai_slots SET profile_id=1, model='deepseek-ai/DeepSeek-OCR' WHERE slot='vision'" }, t),
  ]);
}).then((rs) => {
  const bad = rs.filter(r => r.__error);
  if (bad.length) { console.error('造数据失败:', JSON.stringify(bad[0])); process.exit(2); }
  main();
}).catch(e => { console.error('启动失败:', e.message); process.exit(2); });

function main() {
console.log('[U1] 首页');
let h = domToFile('/', tmp + '/u1.html');
ck('首页有标题', h.indexOf('我的档案') >= 0);
ck('首页有新建入口', h.indexOf('newBtn') >= 0);
ck('首页有档案卡（审计老人）', h.indexOf('审计老人') >= 0);
ck('档案卡带导出按钮', /data-export="\d+"/.test(h));
ck('档案卡带改按钮', /data-arc-edit="\d+"/.test(h));
ck('档案卡带删按钮', /data-arc-del="\d+"/.test(h));
ck('有导入入口（有档案时）', h.indexOf('importFile') >= 0);

console.log('[U2] 卷宗页');
h = domToFile('/a/1', tmp + '/u2.html');
ck('卷宗有封面', h.indexOf('cover-name') >= 0);
ck('有目录区', h.indexOf('toc') >= 0);
ck('条目有改按钮', /data-entry-edit="\d+"/.test(h));
ck('条目有传按钮', /data-entry-upload="\d+"/.test(h));
ck('条目有删按钮', /data-entry-del="\d+"/.test(h));
ck('章有改名按钮', /data-ch-edit="\d+"/.test(h));
ck('有朗读按钮', h.indexOf('data-read-all') >= 0);
ck('无 JS 报错（页面非空白）', h.length > 1200, '长度 ' + h.length);

console.log('[U3] 采集页');
h = domToFile('/a/1/collect', tmp + '/u3.html');
ck('有录入框', h.indexOf('sayText') >= 0);
ck('有录音按钮', h.indexOf('recBtn') >= 0);
ck('有照片入口', h.indexOf('photoInput') >= 0);
ck('讲述有改按钮', /data-seg-edit="\d+"/.test(h));
ck('讲述有传按钮', /data-seg-upload="\d+"/.test(h));
ck('讲述有删按钮', /data-seg-del="\d+"/.test(h));
ck('有生成按钮', h.indexOf('genBtn') >= 0);

console.log('[U4] 设置页');
h = domToFile('/settings', tmp + '/u4.html');
ck('有模型来源区', h.indexOf('模型来源') >= 0);
ck('有该填什么模型对照', h.indexOf('该填什么模型') >= 0);
ck('有注册引导', h.indexOf('signup-box') >= 0);
ck('配置卡有接口地址明细', h.indexOf('接口地址') >= 0);
ck('配置卡有密钥明细', h.indexOf('密钥') >= 0);
ck('配置卡显示负责环节', h.indexOf('负责') >= 0);
ck('环节绑定有模型下拉', /class="slot-model"/.test(h));
ck('下拉有免费标注', h.indexOf('· 免费') >= 0);
ck('有阅读偏好', h.indexOf('prefFont') >= 0);
ck('设置页显示当前账号', h.indexOf(S.phone) >= 0);
ck('有图片生成环节', h.indexOf('图片生成') >= 0);
ck('有视频生成环节', h.indexOf('视频生成') >= 0);
ck('视频下拉列出 Wan 模型', h.indexOf('Wan-AI/Wan2.2-T2V-A14B') >= 0);
ck('环节显示当前模型', h.indexOf('当前：<code>') >= 0 || /当前：/.test(h));

console.log('[U0] 未登录跳转');
const h0 = domToFile('/#/x-empty', tmp + '/u0.html', true);
ck('未登录访问被带到登录页', h0.indexOf('auPhone') >= 0);

console.log('\nUI 审计: ' + pass + ' 通过 / ' + fail + ' 失败');
S.stop();
process.exit(fail ? 1 : 0);
}
