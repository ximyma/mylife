# 我的人生档案 · The Story of My Life

一个人，一本档案。老人把一生讲出来，系统自动排成有封面、有目录、有时间轴的卷宗。

**一个 SQLite 文件 + 一套纯 JS 前端 + 两种宿主（浏览器 / 安卓 WebView）。零 npm 依赖，零构建。**

---

## 和旧版的区别

旧版（`D:\works\mystory`）是 Node 服务端渲染；这一版照 `D:\myapps\foread` 的骨架重建：

| | 旧版 | 这一版 |
| --- | --- | --- |
| 后端接口 | 30+ 个业务接口 | **4 个**（query / exec / ai / file） |
| 业务逻辑 | Node 里 | **全在 `web/db.js`，一份** |
| 界面 | 服务端拼 HTML | 前端渲染，两端同一份 |
| 安卓 | 没做（Node 跑不进手机） | **Java + WebView，一条命令出 APK** |
| 出包 | 无 | `build-apk.bat` |

---

## 目录

```
mylife/
├── web/            一套前端（两端共用）
│   ├── index.html
│   ├── style.css
│   ├── api.js      唯一的后端入口
│   ├── db.js       全部 SQL 与生成规则 ★
│   └── app.js      界面与交互
├── server/
│   ├── server.js   网页端宿主（约 300 行）
│   └── schema.sql  建表，两端共用
├── android/        安卓宿主
│   └── app/src/main/java/com/mylife/archive/
│       ├── MainActivity.java   壳 + 权限 + 原生 TTS
│       ├── LocalServer.java    本地 HTTP（4 个接口 + 文件）
│       ├── Db.java             开库 / query / exec
│       ├── Ai.java             代理调模型（Key 不进前端）
│       ├── Files.java          base64 落盘
│       └── Json.java
├── tools/sync.js   把 web/ 同步进 assets
└── build-apk.bat   一条命令出 APK
```

---

## 跑起来

### 网页版

```bash
node --experimental-sqlite --no-warnings server/server.js
# http://127.0.0.1:4321
```

### 安卓版

```bat
build-apk.bat
```

产物：`android\app\build\outputs\apk\debug\app-debug.apk`

构建环境（已在本机验证）：

```
JAVA_HOME    D:\jdk-17.0.19.10-hotspot
ANDROID_HOME D:\androidsdk\android-sdk-windows
GRADLE_HOME  D:\gradle-8.7
```

---

## 设计要点

### 1. 后端只做「SQLite 和文件的代理」

```
POST /api/query  {sql, params} -> rows[]
POST /api/exec   {sql, params} -> {changes, lastId}
POST /api/ai     {messages}    -> {text}
POST /api/file   {op,save|read|del, ...}
GET  /files/<rel>               -> 二进制，支持 Range
```

SQL 写死在 `web/db.js` 里，前端只传参数值，全部走 `?` 绑定。后端不懂业务，所以**业务逻辑只有一份**——改需求只改 JS。

### 2. 安卓里也起 HTTP 服务

`LocalServer.java` 用 `ServerSocket` 起在 `127.0.0.1` 的随机端口，WebView 加载 `http://127.0.0.1:<port>/`。

好处：网页端和安卓端是**同一个 URL 形态**，前端不需要任何 `if (安卓)` 分支；图片视频走 `/files/*` 直链，不用转 base64。

### 3. 只有系统能力才走 Bridge

```js
if (window.NativeTTS) window.NativeTTS.speak(text, 0.95);
else speechSynthesis.speak(...);
```

WebView 里的 `speechSynthesis` 在国产机上经常没有中文音色，所以安卓端用原生 `TextToSpeech`。

### 4. 生成同步做，不要任务队列

年份抽取、分章、切条目、照片归位全是规则运算，加起来不到 120 毫秒。只有「AI 起章名」要等几十秒——那一步**异步补上**，失败了就保持规则名，不影响任何事。

### 5. 前端刻意用 ES5

`XMLHttpRequest` 而不是 `fetch`（WebView 老内核没有），不用箭头函数、模板字符串、可选链。目标用户可能是安卓 6/7 的旧机器。

---

## 数据表（10 张）

`archives` 档案 · `chapters` 章 · `entries` 条目 · `photos` 照片 ·
`segments` 讲述原文 · `media` 随文素材 · `shares` 分享 · `users` · `settings`

见 `server/schema.sql`。两端共用同一份。

---

## 已知限制

- 网页端在本地跑，不做账号体系（`users` 表只有一条本地用户）；要做多用户/公网部署时再加登录与分享页
- 录音依赖 `MediaRecorder`（Chrome 49+）；老 WebView 会降级为只打字
- ASR（语音转文字）还没接，第一版靠打字或录音原声
- OCR 还没接
