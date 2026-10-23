# 我的人生档案 · The Story of My Life

**当前版本 v0.2.0**（2026-10-23 里程碑 · 变更明细见 [CHANGELOG.md](CHANGELOG.md)）

一个人，一本档案。老人把一生讲出来，系统自动排成有封面、有目录、有时间轴的卷宗。

**一个 SQLite 文件 + 一套纯 JS 前端 + 两种宿主（浏览器 / 安卓 WebView）。零 npm 依赖，零构建。**

v0.2 能做什么：
- 讲述、照片、条目、章、整本档案**全可改可删**
- 录音 → 转文字（WAV 采集 + 设备选择 + 实时音量），转写走免费语音模型
- 一键**导出 / 导入**：整本档案装进一个 `.mylife.json`，换机、备份、分享都靠它
- 每段后面可**传**图片 / 视频 / 录音，直接排进卷宗
- 模型配置**按能力过滤**：填一个 Key 自动配好三个基础环节，免费/付费一目了然
- Windows 版**单文件分发**：`MyLife.exe` 拷给别人就能用

### 直接跑起来

**不想装 Node** → 用打包好的 Windows 单文件版：

```
dist/win/
├── MyLife.exe        双击即可，自动开浏览器；黑窗口关掉就退出
├── resources/        可选覆盖层（想临时改界面时放新文件，不用重打包）
├── data/             你的档案、照片、录音全在这，只有这个目录要备份
└── 使用说明.txt
```

**分发给别人：只拷 `MyLife.exe` 一个文件就能用**（界面已内置）。
整个文件夹一起拷也行；数据是跟着文件夹走的，卸载就是删文件夹。
端口被占时换一个：`set PORT=4401 && MyLife.exe`

**要在本地改代码** → `node server/server.js`，然后开 `http://127.0.0.1:4321`
（需要 Node 22+，用内置的 `node:sqlite`，不用装任何依赖）

重新打包 exe：`node tools/build-exe.js`（输出到 `dist/win/`）

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
├── build-apk.bat   一条命令出 APK
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

## AI 配置中心

设置 → 模型来源。可以加**任意多条**，每条独立：

| 类型 | 地址示例 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1` | 任何走 `/v1/chat/completions` 的服务 |
| DeepSeek | `https://api.deepseek.com/v1` | 官方接口 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 国内可直连，DeepSeek/千问都能调 |
| 本机 Ollama | `http://127.0.0.1:11434/v1` | 不用 Key，跑在自己电脑上 |
| 自定义 / 内网 | 你自己填 | vLLM、中转站等 |

每条配置的操作：**测试**（发一句"只回两个字：可用"，回显耗时和回复）、**拉模型**（GET `/models`，拉回来存在本地供下拉选择）、**编辑**、**删除**；右上角可**停用/启用**，停用的不参与自动挑选。

> ⚠️ **本机模型的提醒**：标着「本机」的配置（Ollama 等）点「测试」会把模型整个加载进内存——7B 模型约 5–6GB。**没有独立显卡的电脑很慢（单次 20–60 秒）且会把系统压得很卡**，日常建议用云端服务；「拉模型」只读清单，几乎不占资源，可放心点。推理型模型（qwen3、deepseek-r1）会先消耗大量 token 在思考上，属正常现象。

**用途绑定**（各环节用哪个模型）：起章名 / 看照片 / 语音转文字，留空就走第一条可用配置。

**多模态**：`messages` 里带 `image_url`（data URL 或 http 地址）直接透传，不支持的模型会返回明确的错误。

### 免费方案（实测可用，不必先充值）

没配 Key 也能用——章节名会按年份和内容自动生成。想用 AI，这几家都免费：

| 平台 | 免费额度 | 本项目用什么 |
| --- | --- | --- |
| 硅基流动 | 常驻免费档模型 | DeepSeek-OCR 看图、Qwen3-ASR-1.7B 转文字、Hunyuan-MT-7B 写稿、Qwen3-8B 精写 |
| 腾讯云混元 | 首开送 100 万 tokens（1 年），hunyuan-lite 永久免费 | hunyuan-turbos-vision 看图 |
| 智谱 bigmodel | Flash 系列永久免费 | GLM-4.6V-Flash 多模态（能理解照片场景，比纯 OCR 更进一步） |

2026-10 实测（硅基流动免费档，同一份素材）：

| 模型 | 用途 | 耗时 | 结果 |
| --- | --- | --- | --- |
| `tencent/Hunyuan-MT-7B` | 起章名 | **0.5s** | 《九岁天安门》 |
| `Qwen/Qwen3-8B` | 精写 | 11s | 免费但慢：思考占了 319 tokens |
| `deepseek-ai/DeepSeek-OCR` | 看图 | **0.3s** | 描述准确 |
| `Qwen/Qwen3-ASR-1.7B` | 语音转文字 | **0.4s** | 「1958年」→「一九五八年」全对 |
| `PaddlePaddle/PaddleOCR-VL-1.5` | 看图 | 43s | ❌ 慢且答非所问，不推荐 |
| `THUDM/GLM-4.1V-9B-Thinking` | 看图 | — | ❌ 已下线（403） |

API Key 只存在本地 `settings` 表，**永远不下发到前端**；请求由原生侧（Java）或 Node 发出，前端拿不到 Key。

## 语音转文字

录完音不会立刻转——**你点「转成文字」才转**，避免为了一段废话白花钱。转写结果直接回填成讲述原文，并按内容重新识别出年份。

后端 `POST /api/asr {path}`，Node 侧转发到模型服务的 `/v1/audio/transcriptions`；安卓侧同样实现（`Ai.asr` 手写的 multipart 上行）。两者接口一致。

> 语音转写出来的年份常常是**中文数字**（「一九五八年」）。`findYear` 同时认「1958」和「一九五八」，不会出现「转出来有年份、档案里却没编上」的情况。

## 朗读与阅读偏好

- **安卓**：用系统原生 TTS（`Tts.java`），逐句朗读 + 逐句高亮 + 进度条
- **浏览器**：用 `speechSynthesis`，同样的逐句逻辑
- 底部条：慢/快调速（0.6×–1.5×）、当前第几句、停止
- 设置里可调：字号 15–30px、夜间模式、语速

### 关于「老手机能读、新手机没声音」

这是 **Android 11（API 30）的包可见性限制**：App 必须先在 Manifest 里声明

```xml
<queries>
    <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
</queries>
```

否则看不到系统 TTS 引擎，`new TextToSpeech()` 直接返回 ERROR。已补上（`AndroidManifest.xml` 顶部）。

另外还做了三件事防同类问题：
1. `setLanguage` 的返回值逐个判断，`LANG_MISSING_DATA` 会明确提示"去系统设置下载中文语音包"
2. 枚举设备上的所有 TTS 引擎，可通过 `NativeTTS.useEngine(pkg)` 换一个
3. 单句超过 900 字自动切分（TTS 对超长文本不可靠）

## 已知限制

- 网页端在本地跑，不做账号体系（`users` 表只有一条本地用户）；要做多用户/公网部署时再加登录与分享页
- 录音依赖 `MediaRecorder`（Chrome 49+）；老 WebView 会降级为只打字
- ASR（语音转文字）还没接，第一版靠打字或录音原声
- OCR 还没接
