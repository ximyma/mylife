/**
 * v0.8 审计（P6 插图 + P7 前置）：文生图与渲染引擎。
 *
 * 文生图有两个必须钉死的点：
 *   ① 供应商返回的是**临时 URL**（硅基流动就是这样），必须当场下载落盘，
 *      只存链接的话，过几个小时图就全变成 404；
 *   ② 同一段描述不能重复花钱，缓存要真的命中。
 *
 * 用法： node test/audit-v08.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./_lib.js');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + String(d).slice(0, 170) : '')); }
};

/* 1×1 红色 PNG，够验证通道了 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

(async () => {
  let genCalls = 0, imgHits = 0, mode = 'url';
  const mock = http.createServer((req, res) => {
    if (req.url.indexOf('/img.png') === 0) {
      imgHits++;
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      genCalls++;
      if (mode === 'fail') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"message":"bad prompt"}');
      }
      if (mode === 'b64') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ images: [{ url: 'data:image/png;base64,' + PNG.toString('base64') }] }));
      }
      const port = mock.address().port;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ images: [{ url: 'http://127.0.0.1:' + port + '/img.png' }] }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  const S = startServer('v08');
  await S.waitReady();
  const t = await S.register();
  const q = (sql, p) => S.post('/api/query', { sql, params: p || [] }, t);
  const x = (sql, p) => S.post('/api/exec', { sql, params: p || [] }, t);

  console.log('[A] 没配模型时的提示');
  const none = await S.post('/api/image', { prompt: '一位老人在院子里推磨' }, t);
  ck('明确说没配图片模型', none.ok === false && /图片生成/.test(none.message || ''), none.message);
  ck('顺手告诉该填哪个模型', /Kolors/.test(none.message || ''), none.message);

  console.log('[B] 临时 URL 必须当场下载');
  await x("INSERT INTO ai_profiles (name,kind,base_url,api_key,default_model,enabled,sort) VALUES ('假画师','openai',?,'k','Kwai-Kolors/Kolors',1,0)",
    ['http://127.0.0.1:' + mockPort + '/v1']);
  await x("DELETE FROM ai_slots WHERE slot='img'");
  await x("INSERT INTO ai_slots (slot, profile_id, model) VALUES ('img', 1, 'Kwai-Kolors/Kolors')");

  const one = await S.post('/api/image', { prompt: '1960年代山东济南，棉纺织厂车间，一位穿蓝布褂子的女工' }, t);
  ck('生成成功', one.ok === true && !!one.path, JSON.stringify(one).slice(0, 120));
  ck('落在 ai/img 下', /^ai\/img\/[0-9a-f]+\.jpg$/.test(one.path || ''), one.path);
  const abs = path.join(S.DATA_DIR, 'users', '1', 'files', one.path || '');
  ck('图片真的存下来了', fs.existsSync(abs) && fs.statSync(abs).size === PNG.length, fs.existsSync(abs) ? fs.statSync(abs).size : 'missing');
  ck('图床被请求过（没有只存链接）', imgHits === 1, 'hits=' + imgHits);
  ck('记了一条素材', (await q("SELECT count(*) n FROM ai_assets WHERE capability='image'"))[0].n === 1);

  console.log('[C] 缓存');
  const two = await S.post('/api/image', { prompt: '1960年代山东济南，棉纺织厂车间，一位穿蓝布褂子的女工' }, t);
  ck('第二次命中缓存', two.ok && two.cached === true, JSON.stringify(two).slice(0, 100));
  ck('没有再请求生成接口', genCalls === 1, 'calls=' + genCalls);

  console.log('[D] 其它返回形态');
  mode = 'b64';
  const b64 = await S.post('/api/image', { prompt: '换一段描述试 b64 返回' }, t);
  ck('data: 内联图也能处理', b64.ok === true, JSON.stringify(b64).slice(0, 120));

  mode = 'fail';
  const bad = await S.post('/api/image', { prompt: '这一段会被服务端拒绝' }, t);
  ck('供应商报错带原话', bad.ok === false && /400/.test(bad.message || ''), bad.message);

  console.log('[E] 边界与账');
  const long = await S.post('/api/image', { prompt: '字'.repeat(1300) }, t);
  ck('超长描述被挡', long.ok === false && /太长/.test(long.message || ''), long.message);
  const u = await S.post('/api/ai/usage', { days: 30 }, t);
  const row = (u.byCapability || []).filter(r => r.capability === 'image')[0];
  ck('图片调用记了账', !!row && Number(row.calls) >= 2, JSON.stringify(u.byCapability));

  console.log('[F] 渲染引擎');
  const probe = await S.post('/api/render/probe', {}, t);
  if (probe.ok) {
    ck('ffmpeg 可用', /^ffmpeg version/.test(probe.version || ''), probe.version);
    ck('解到了 data/bin', /bin[\\/]ffmpeg(\.exe)?$/.test(probe.path || ''), probe.path);
    ck('体积像样', Number(probe.bytes) > 20 * 1024 * 1024, probe.bytes);
  } else {
    console.log('  （本机 bin/ 里没有 ffmpeg，跳过——发布包必须内置）');
    ck('没有 ffmpeg 时给出可读原因', /ffmpeg/.test(probe.message || ''), probe.message);
  }

  mock.close();
  S.stop();
  console.log('\nv0.8 插图与渲染: ' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('审计崩了：' + (e && e.stack || e)); process.exit(1); });
