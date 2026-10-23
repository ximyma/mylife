# 我的人生档案 · The Story of My Life

**当前版本 v0.4.0 · 里程碑 2**（2026-10-23）

变更明细见 [CHANGELOG.md](CHANGELOG.md)｜里程碑存档见 [docs/MILESTONE-2.md](docs/MILESTONE-2.md)

> **里程碑 1（v0.2）**：一个人在一台电脑上把档案做出来。>   
> **里程碑 2（v0.4）**：换到手机上也能完整走完，而且一家人各用各的 —— **已在小米 9、荣耀 50 两台真机全链路实测通过。**

一个人，一本档案。老人把一生讲出来，系统自动排成有封面、有目录、有时间轴的卷宗。

**一个 SQLite 文件 + 一套纯 JS 前端 + 两种宿主（浏览器 / 安卓 WebView）。零 npm 依赖，零构建。**

## 现在能做什么

- **手机号注册登录**，每个账号一个独立数据库（`data/users/<uid>/archive.db`），**数据物理隔离**，换账号看不到别人的
- 讲述、照片、条目、章、整本档案**全可改可删**
- **录音 → 试听 → 转文字**：安卓走原生 `AudioRecord`（绕开 WebView 权限问题），网页走 `getUserMedia`；    
  转写走免费语音模型，模型不存在会**自动换一个**
- 一键**导出 / 导入**：整本档案装进一个 `.mylife.json`，换机、备份、分享都靠它
- 每段后面可**传**图片 / 视频 / 录音，直接排进卷宗
- 模型配置**按能力过滤**：填一个 Key 自动配好三个基础环节，免费/付费一目了然
- Windows 版**单文件分发**：`MyLife.exe` 拷给别人就能用

## 直接跑起来

### Windows（不想装 Node）

用打包好的单文件版：

```
dist/win/
├── MyLife.exe        双击即可，自动开浏览器；黑窗口关掉就退出
├── resources/        可选覆盖层（想临时改界面时放新文件，不用重打包）
├── data/             你的档案、照片、录音全在这，只有这个目录要备份
└── 使用说明.txt
```

**分发给别人：只拷 `MyLife.exe` 一个文件就能用**（界面已内置）。  
端口被占时换一个：`set PORT=4401 && MyLife.exe`。卸载就是删文件夹。

### 安卓

装 `dist/MyLife-v0.4.0-android.apk`（认准版本号，`dist/archive/` 里的是旧包）。  
首次打开会申请麦克风权限；登录后一切在本地跑，不联网也能用（除了调模型）。

### 改代码

```bash
node server/server.js        # → http://127.0.0.1:4321
```

需要 Node 22+（用内置的 `node:sqlite`，**不用装任何依赖**）。

重新打包：

```bat
node tools/build-exe.js      :: Windows 单文件 + 冒烟测试
build-apk.bat                :: 安卓 APK
python tools/make-backup.py  :: 全量备份包（源码 + EXE + APK）
```

---

## 和旧版的区别

旧版（`D:\works\mystory`）是 Node 服务端渲染；这一版照 `D:\myapps\foread` 的骨架重建：

|      | 旧版             | 这一版                                    |
| ---- | -------------- | -------------------------------------- |
| 后端接口 | 30+ 个业务接口      | **4 个**（query / exec / ai / file）      |
| 业务逻辑 | Node 里         | **全在 `web/db.js`，一份**                  |
| 界面   | 服务端拼 HTML      | 前端渲染，两端同一份                             |
| 安卓   | 没做（Node 跑不进手机） | **Java + WebView，一条命令出 APK**           |
| 账号   | 无              | **手机号注册 + 每用户独立库**                     |
| 出包   | 无              | `build-apk.bat` / `tools/build-exe.js` |

---

## 目录

```
mylife1/
├── web/            一套前端（两端共用）
│   ├── index.html
│   ├── style.css
│   ├── api.js      唯一的后端入口（含 token 注入与数值列归一化）
│   ├── db.js       全部 SQL 与生成规则 ★
│   └── app.js      界面与交互
├── server/
│   ├── server.js   网页端宿主（含内联的账号模块，SEA 单文件入口）
│   └── schema.sql  建表，两端共用
├── android/        安卓宿主
│   └── app/src/main/java/com/mylife/archive/
│       ├── MainActivity.java   壳 + 权限 + 原生 TTS + 选图/录音桥
│       ├── LocalServer.java    本地 HTTP（4 个接口 + /files 静态服务）
│       ├── Auth.java           PBKDF2 密码哈希 + 会话令牌
│       ├── Db.java             开库 / query / exec / ensureSchema
│       ├── Ai.java             代理调模型（Key 不进前端）+ 手写 multipart
│       ├── MicRec.java         原生 AudioRecord 录音（WAV）
│       ├── Files.java          base64 落盘
│       └── Json.java           null 安全取值
├── tools/
│   ├── sync.js          把 web/ 同步进安卓 assets
│   ├── build-exe.js     出单文件 EXE + 冒烟测试 + 产物版本命名
│   └── make-backup.py   出全量备份包
├── test/                8 个审计脚本，197 项
├── docs/                升级方案与里程碑存档
└── build-apk.bat        一条命令出 APK
```

---

## 构建环境（已在本机验证）

```
JAVA_HOME    D:\jdk-17.0.19.10-hotspot
ANDROID_HOME D:\androidsdk\android-sdk-windows
GRADLE_HOME  D:\gradle-8.7
```

> 内存紧张时 Gradle 会报 `os::commit_memory failed`。构建期间别同时开无头浏览器审计，>   
> 并给 Gradle 小堆：`-Xmx512m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC`。

---

## 设计要点

### 1. 后端只做「SQLite 和文件的代理」

```
POST /api/query  {sql, params}     -> rows[]
POST /api/exec   {sql, params}     -> {changes, lastId}
POST /api/ai     {messages}        -> {text}
POST /api/asr    {path, model}     -> {ok, text, ms}
POST /api/file   {op, save|read|del|list, ...}
GET  /files/<rel>                  -> 二进制，支持 Range
```

SQL 写死在 `web/db.js` 里，前端只传参数值，全部走 `?` 绑定。后端不懂业务，所以**业务逻辑只有一份**——改需求只改 JS，两端同时生效。

### 2. 安卓里也起 HTTP 服务

`LocalServer.java` 用 `ServerSocket` 起在 `127.0.0.1` 的随机端口，WebView 加载 `http://127.0.0.1:<port>/`。

好处：网页端和安卓端是**同一个 URL 形态**，前端不需要任何 `if (安卓)` 分支；图片视频走 `/files/*` 直链，不用转 base64。

### 3. 数据隔离靠物理分库，不靠 WHERE

每个用户在磁盘上有自己的一套 `archive.db` + `files/`，请求进来先验 token 拿 `uid`，  
再用 `AsyncLocalStorage`（Node）/ `Map<Long, Db>`（安卓）把**当前请求该用哪个库**注入进去。

业务 SQL 里**一句 `WHERE user_id=?` 都没有**——漏写一个条件就把数据串了，靠物理隔离才安全。

### 4. 只有系统能力才走 Bridge

```js
if (window.NativeTTS) window.NativeTTS.speak(text, 0.95);
else speechSynthesis.speak(...);
```

WebView 里的 `speechSynthesis` 在国产机上经常没有中文音色，所以安卓端用原生 `TextToSpeech`。  
录音同理：安卓端优先走 `NativeRec`（原生 `AudioRecord`），开不了才回退 `getUserMedia`。

### 5. 生成同步做，不要任务队列

年份抽取、分章、切条目、照片归位全是规则运算，加起来不到 120 毫秒。只有「AI 起章名」要等几十秒——那一步**异步补上**，失败了就保持规则名，不影响任何事。

### 6. 前端刻意用 ES5

`XMLHttpRequest` 而不是 `fetch`（WebView 老内核没有），不用箭头函数、模板字符串、可选链。目标用户可能是安卓 6/7 的旧机器。

---

## 数据表

`archives` 档案 · `chapters` 章 · `entries` 条目 · `photos` 照片 ·  
`segments` 讲述原文 · `media` 随文素材 · `shares` 分享 · `settings` · `ai_profiles` · `ai_slots` ·  
`users` · `sessions`

见 `server/schema.sql`。两端共用同一份，每次打开库都幂等执行一遍（`ensureSchema`），  
所以**任何旧版本的库都能被当前版本打开**。

---

## 账号与数据隔离

| 项    | 做法                                                                 |
| ---- | ------------------------------------------------------------------ |
| 密码   | Node 用 `scrypt`，安卓用 `PBKDF2WithHmacSHA256`（65536 迭代），都不存明文         |
| 会话   | 32 字节随机 token，存 `sessions` 表，有效期 30 天                              |
| 防爆破  | 同一账号连续失败 5 次锁 10 分钟                                                |
| 验证码  | 演示期固定 `1234`（接口形态已就位，接短信服务商只需换实现）                                  |
| 存储   | `data/users/<uid>/archive.db` + `data/users/<uid>/files/`          |
| 旧数据  | **第一个注册的账号**自动接管 v0.2 的 `data/archive.db` 与 `files/`               |
| 鉴权通道 | `Authorization` 头 / `Cookie` / `?token=`（后两个给 `<img>`、`<audio>` 用） |

---

## AI 配置中心

设置 → 模型来源。可以加**任意多条**，每条独立：

| 类型          | 地址                                     | 说明                                |
| ----------- | -------------------------------------- | --------------------------------- |
| OpenAI 兼容   | `https://api.openai.com/v1`            | 任何走 `/v1/chat/completions` 的服务    |
| DeepSeek    | `https://api.deepseek.com/v1`          | 官方接口                              |
| 硅基流动        | `https://api.siliconflow.cn/v1`        | 国内可直连，`SenseVoiceSmall` 免费转写      |
| 智谱 bigmodel | `https://open.bigmodel.cn/api/paas/v4` | ⚠️ `glm-asr-2512` 单段 ≤30 秒，长录音会失败 |
| Groq        | `https://api.groq.com/openai/v1`       | ⚠️ 国内被墙，手机端无代理不可用                 |
| 本机 Ollama   | `http://127.0.0.1:11434/v1`            | 不用 Key，跑在自己电脑上                    |
| 自定义 / 内网    | 你自己填                                   | vLLM、中转站等                         |

每条配置的操作：**测试**、**拉模型**（GET `/models`）、**编辑**、**删除**；可停用/启用。  
「测试」对语音环节会**真发 1 秒静音到 `/audio/transcriptions`**，200 才算通——  
用对话接口去测 ASR 模型必然 400，那样测不出真假。

> ⚠️ **本机模型的提醒**：标着「本机」的配置（Ollama 等）点「测试」会把模型整个加载进内存——7B 模型约 5–6GB。**没有独立显卡的电脑很慢（单次 20–60 秒）且会把系统压很卡**，日常建议用云端服务；「拉模型」只读清单，几乎不占资源。

### 免费方案（2026-10 实测）

没配 Key 也能用——章节名会按年份和内容自动生成。想用 AI，这几家都免费：

| 平台          | 免费额度                                      | 本项目用什么                                                                   |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| **硅基流动**    | 常驻免费档模型                                   | `SenseVoiceSmall` 转文字、`DeepSeek-OCR` 看图、`Hunyuan-MT-7B` 写稿、`Qwen3-8B` 精写 |
| 腾讯云混元       | 首开送 100 万 tokens（1 年），`hunyuan-lite` 永久免费 | `hunyuan-turbos-vision` 看图                                               |
| 智谱 bigmodel | Flash 系列永久免费                              | `GLM-4.6V-Flash` 多模态                                                     |

实测（硅基流动免费档，同一份素材）：

| 模型                              | 用途    | 耗时       | 结果                                                                    |
| ------------------------------- | ----- | -------- | --------------------------------------------------------------------- |
| `tencent/Hunyuan-MT-7B`         | 起章名   | **0.5s** | 《九岁天安门》                                                               |
| `Qwen/Qwen3-8B`                 | 精写    | 11s      | 免费但慢：思考占了 319 tokens                                                  |
| `deepseek-ai/DeepSeek-OCR`      | 看图    | **0.3s** | 描述准确                                                                  |
| `FunAudioLLM/SenseVoiceSmall`   | 语音转文字 | **0.4s** | 「一九五八年」全对，1 小时以内均可                                                    |
| `Qwen/Qwen3-ASR-1.7B`           | 语音转文字 | —        | ❌ 挂在模型列表里，但 `/audio/transcriptions` 不认它（`20012 Model does not exist`） |
| `PaddlePaddle/PaddleOCR-VL-1.5` | 看图    | 43s      | ❌ 慢且答非所问，不推荐                                                          |

API Key 只存在本地 `settings` 表，**永远不下发到前端**；请求由原生侧（Java）或 Node 发出，前端拿不到 Key。

## 语音转文字

录完音不会立刻转——**你点「转成文字」才转**，避免为了一段废话白花钱。转写结果直接回填成讲述原文，并按内容重新识别出年份。

后端 `POST /api/asr {path, model}`，两端各自实现，接口一致：  
Node 走 `fetch` + `FormData`；安卓走 `Ai.asr` 手写的 multipart（**固定长度，不用 chunked**）。

三条设计：

1. **模型不存在自动换**：命中 `20012 / Model does not exist` 时，在同一家配置里换一个     
   真正支持转写的模型重试，成功后告诉你「已自动改用 XXX」。优先级：     
   `sensevoice > teleasr > whisper > glm-asr > qwen3-asr`。
2. **失败要能看见**：失败后展开红色详情面板，列出 HTTP 状态、接口地址、用的配置、     
   模型名、音频文件与大小、服务端原话。不再把「网络不通」和「模型不存在」混成一句「转不出来」。
3. **录音先能听**：每段都有「试听」，刚录完也立刻弹播放条。先确认录音本身没问题，     
   再谈转文字——把「平台问题还是程序问题」分开。

> 语音转写出来的年份常常是**中文数字**（「一九五八年」）。`findYear` 同时认「1958」和「一九五八」，不会出现「转出来有年份、档案里却没编上」的情况。

## 朗读与阅读偏好

- **安卓**：系统原生 TTS（`Tts`），逐句朗读 + 逐句高亮 + 进度条
- **浏览器**：`speechSynthesis`，同样的逐句逻辑
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

1. `setLanguage` 的返回值逐个判断，`LANG_MISSING_DATA` 会明确提示「去系统设置下载中文语音包」
2. 枚举设备上的所有 TTS 引擎，可通过 `NativeTTS.useEngine(pkg)` 换一个
3. 单句超过 900 字自动切分（TTS 对超长文本不可靠）

## 已知限制

- 验证码固定 `1234`，接真实短信服务商需签名与模板报备（演示期设计）
- 长录音没有自动切段，所以**有单段上限的平台（智谱 30 秒）不能直接用**
- Groq 国内被墙；阿里百炼 `paraformer-v2` 每月 10 小时免费但不兼容 OpenAI 接口，未接
- 公网部署未做——现在只在本机 / 本手机上跑，够用也最安全
- 网页端前端刻意 ES5，因此代码风格偏旧（这是为老 WebView 的取舍，不是疏忽）

---

## 测试

```bash
node test/audit.js                 # 52 项 主功能
node test/audit-auth.js            # 21 项 账号与数据隔离
node test/audit-generate.js        # 13 项 生成规则
node test/audit-archive-mgmt.js    #  9 项 档案级改删
node test/audit-asr.js             # 12 项 转写契约
node test/audit-files.js           # 18 项 文件鉴权与路径穿越
node test/audit-android.js         # 34 项 安卓静态审计（防回归）
node test/audit-ui.js              # 38 项 界面审计（无头浏览器）
```

合计 **197 项**。`audit-android.js` 是纯静态检查，把里程碑 2 期间踩过的每个坑  
（`optString`、chunked、`available()`、cookie、回放、诊断）钉死，改坏了会当场报错。
