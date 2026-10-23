/**
 * 安卓端静态审计：把"只有手机上才会错"的那些坑钉死，防止回归。
 *
 * 背景（都是实测踩出来的）：
 *   ① org.json 的 optString 会把 JSON null 变成字符串 "null"，
 *      前端发 {model:null} 就变成了 model=null 去请求转写接口 → 400。
 *      Node 端是 `body.model || default`，null 是 falsy，所以网页端一直正常。
 *   ② <img src>/<audio src> 发不了 Authorization 头，只认 cookie。
 *      安卓本地服务原来只读 Authorization → 照片不显示、录音点不动。
 *   ③ Transfer-Encoding: chunked 的 multipart 上传，不少网关不收。
 *   ④ 读请求体靠 in.available()==0 判断结束，大请求会被截断。
 *
 * 用法： node test/audit-android.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? ' << ' + d : '')); }
};

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const JAVA = 'android/app/src/main/java/com/mylife/archive/';

const ai = read(JAVA + 'Ai.java');
const json = read(JAVA + 'Json.java');
const srv = read(JAVA + 'LocalServer.java');
const act = read(JAVA + 'MainActivity.java');
const appJs = read('web/app.js');
const serverJs = read('server/server.js');

console.log('\n== 一、JSON null 被当成字符串 "null" ==');

ck('Ai.java 不再直接用 optString（一律走 Json.sv）',
  !/\.optString\(/.test(ai),
  '还有 ' + (ai.match(/\.optString\(/g) || []).length + ' 处');

ck('Json.sv 存在，且把 "null"/"undefined" 当没给',
  /public static String sv\(/.test(json) && /"null"\.equals\(s\)/.test(json));

ck('Json.str 走 sv（不再 optString(key, null)）',
  /return sv\(obj\(json\), key, null\)/.test(json));

ck('Ai.asr 读 model 用 null 安全取值',
  /String model = Json\.sv\(in, "model"\);/.test(ai));

ck('Node 端也有同样的兜底（body.model 为 null 时用默认模型）',
  /const useModel = body\.model \|\| model \|\| profile\.default_model;/.test(serverJs));

console.log('\n== 二、/files 鉴权（图片、录音回放的前提）==');

ck('本地服务登录后 Set-Cookie',
  /Set-Cookie:\s*" \+ COOKIE_NAME/.test(srv), '没有种 cookie，<img>/<audio> 会 401');

ck('本地服务解析 Cookie 头',
  /cookieHeader/.test(srv) && /COOKIE_NAME\.equals/.test(srv));

ck('/files 接受 ?token= 兜底',
  /"token"\.equals\(qs\[i\]\.substring\(0, eq\)\)/.test(srv));

ck('WebView 允许收 cookie',
  /CookieManager/.test(act) && /setAcceptCookie\(true\)/.test(act));

ck('Node 端也认 ?token=（两端行为一致）',
  /function queryToken\(req\)/.test(serverJs) && /cookieToken\(req\) \|\| queryToken\(req\)/.test(serverJs));

ck('前端不再手拼 /files/ 地址（统一走 fsrc 带 token）',
  (appJs.match(/"\/files\/' \+/g) || []).length === 0 && /function fsrc\(/.test(appJs),
  '仍有 ' + (appJs.match(/"\/files\/' \+/g) || []).length + ' 处手拼');

console.log('\n== 三、上传与请求读取 ==');

ck('multipart 不再用 chunked 上传',
  !/conn\.setChunkedStreamingMode/.test(ai), '部分网关拒收 chunked POST');

ck('multipart 用固定长度',
  /setFixedLengthStreamingMode/.test(ai));

ck('请求体按 Content-Length 精确读',
  /contentLength\(hb, hb\.length\)/.test(srv) && /Math\.min\(need, max\)/.test(srv));

ck('不再靠 available() 判断请求读完',
  !/if \(in\.available\(\) == 0\) break;/.test(srv));

console.log('\n== 四、录音回放（本次新增）==');

ck('补内容页有试听按钮', /data-play="/.test(appJs));
ck('录完立刻能听', /function showRecPlay\(/.test(appJs) && /recPlayRow/.test(appJs));
ck('原生录音停下后调 showRecPlay', /showRecPlay\(out\.path\)/.test(appJs));
ck('网页录音存盘后调 showRecPlay', /showRecPlay\(rec\.path\)/.test(appJs));
ck('试听地址带 token', /ap\.src = want;/.test(appJs) && /fsrc\(src\)/.test(appJs));

console.log('\n== 五、转写失败要能看见原因 ==');

ck('安卓返回 diag（模型/接口/状态/响应体）', /private static JSONObject diag\(/.test(ai));
ck('安卓区分网络失败与 4xx/5xx', /msgForStatus\(/.test(ai));
ck('Node 端也返回 diag', /diag: diagOf\(/.test(serverJs));
ck('前端有失败详情面板', /function showDiag\(/.test(appJs) && /trDiag/.test(appJs));
ck('失败时把 diag 存下来并展示', /lastDiag = r\.diag/.test(appJs) && /showDiag\(lastDiag\)/.test(appJs));

console.log('\n== 六、资源完整性 ==');

const html = read('web/index.html');
['app.js', 'api.js', 'db.js', 'style.css'].forEach((f) => {
  ck('index.html 引用 ' + f, html.indexOf(f) >= 0);
  ck('web/' + f + ' 存在', fs.existsSync(path.join(ROOT, 'web', f)));
});
ck('样例录音格式为 wav（ASR 兼容性最好）', /\.wav/.test(ai));

console.log('\n' + (fail === 0 ? '全部通过' : '有 ' + fail + ' 项没过') +
  '：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
