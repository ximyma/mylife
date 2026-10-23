# 更新日志 · Changelog

格式参考「Keep a Changelog」；版本号：主.次.修订。

## v0.3.5 · 2026-10-23 —— 录音回放 + 转写失败的真因

### 修复（都是"只有安卓端才错"的 bug，网页端一直正常）

- **转文字在手机上一定失败，根因是 `JSON null` 被当成了字符串 `"null"`。**
  前端 `DB.transcribe` 发的是 `{ model: null, language: null }`（没指定模型时就是这样）；
  Android 的 `org.json` 里 `optString(name, "")` 的实现是 `JSON.toString(opt(name))`，
  而 `JSONObject.NULL.toString()` 返回字符串 `"null"` —— 于是
  `if (model.length() == 0)` 判断失效，请求里带上了 `model=null`，
  转写接口回 `400 Model does not exist`。
  Node 端写的是 `body.model || profile.default_model`，`null` 是 falsy 直接跳过，
  所以同一个接口电脑上一直好好的。
  修法：`Json.sv()` 把 JSON null / 缺失 / 字面 `"null"` / `"undefined"` 一律当成"没给"，
  `Ai.java` 里所有 `optString` 全部替换掉。
- **照片不显示、录音点不动：`/files/` 鉴权方式两端不一致。**
  `<img src>` 和 `<audio src>` 是标签自己去取文件，发不了 `Authorization` 头。
  Node 端登录时 `Set-Cookie`，浏览器自动带上，所以网页端正常；
  安卓本地服务只认 `Authorization`，这些请求一律 401。
  修法：本地服务登录/注册成功时同样 `Set-Cookie`，`/files/` 接受
  `Authorization` → `Cookie` → `?token=` 三种来源；前端统一走 `fsrc()` 带 token。
- **multipart 上传用 chunked 编码**：`setChunkedStreamingMode(0)` 会发
  `Transfer-Encoding: chunked`，不少 OpenAI 兼容网关（nginx / 云 WAF 前置）直接拒。
  改成固定长度，和浏览器 `fetch(FormData)` 发出去的东西完全一致。
- **请求体可能被截断**：本地服务原来靠 `in.available() == 0` 判断"读完了"，
  这个值只表示内核缓冲区此刻有多少字节，请求体分多段到达时会误判。
  小 JSON 平时一整包到达所以看不出来，传照片（几 MB base64）就会随机失败。
  改成先读到 `\r\n\r\n` 拿到 `Content-Length`，再精确读那么多字节。

### 新增

- **录音回放**：补内容页每条讲述都有「试听」按钮（全页共用一个播放器，
  点到哪段就挪到哪段下面）；**刚录完也会立刻出现播放条** —— 先确认录音本身没问题，
  再谈转文字，把"平台问题还是程序问题"分开。
- **转写失败详情**：失败后页面展开一块红色面板，列出 HTTP 状态、接口地址、
  用的配置、模型名、音频文件与大小、服务端原话。以后不用猜，也不会再把
  「网络不通」和「模型不存在」混成一句"转不出来"。
- `test/audit-android.js`：34 项静态审计，把上面这些坑钉死防回归。

## v0.3.4 · 2026-10-23 —— 配置改不动 / 转写模型报 20012

### 修复
- **安卓端「改」配置按钮点了没反应（删了重加才行）**：安卓 SQLite 读出来的每一列都是字符串
  （`Cursor.getString`），电脑端 `node:sqlite` 给的是数字。于是 `profiles[i].id === 1` 在手机上
  永远为 false，点了什么都不会发生。现在在 `API.query` 这唯一入口把数值列还原成数字，两端数据
  形状一致；比较也改为比字符串兜底。**同一个坑还压着「删除整本档案」**（`list[li].id === did`
  不中 → 直接 return），一并修好。
- **语音转文字报 `HTTP 400 {"code":20012,"message":"Model does not exist"}`**：硅基流动的
  `Qwen/Qwen3-ASR-1.7B` 确实挂在模型列表里，但 `/v1/audio/transcriptions` 只收
  `FunAudioLLM/SenseVoiceSmall` 和 `TeleAI/TeleSpeechASR`——自动配环节时按关键词选中了前者，
  于是怎么点都转不出来。现在：
  - 转写遇到"模型不存在"会自动在同一家配置里换一个能用的转写模型重试一次，并在提示里说明换成了哪个；
  - 设置页对这类模型直接显示红字警告 + 「改用 SenseVoice（免费）」一键按钮；
  - 自动配环节的语音候选顺序改成按"转写接口真能收"来排，Qwen3-ASR 垫底。
- **语音环节的「试一下」永远报 400**：以前拿 `/chat/completions` 去测 ASR 模型，接口本身就接不了。
  改为真发 1 秒静音 WAV 到 `/audio/transcriptions`，HTTP 200 即通过；失败时给出可照做的建议。

### 新增
- 平台预设增加 **智谱 bigmodel**（`glm-asr-2512`，≤30 秒/25MB）与 **Groq**（`whisper-large-v3-turbo`，免费 8 小时/天）；
- 语音转文字提示里直接写明哪几个模型能走转写接口。

## v0.3.3 · 2026-10-23 —— 安卓录音改走原生，麦克风"没权限"根治

### 修复
- **安卓录音（荣耀 50 实机）**：系统权限明明给了「仅使用期间允许」，App 仍然提示
  「没有拿到麦克风权限」。两个原因叠在一起：
  1. 前端把 `getUserMedia` 的所有失败一律写成「没有权限」，把设备不可用、被占用、
     WebView 不放行全糊成一句，误导了排查方向；
  2. WebView 里的录音要过两道门，系统权限是第二道，`onPermissionRequest` 是第一道——
     国产 ROM 上这道经常直接拒，系统权限给了也没用。
  现在前端**优先走原生 `AudioRecord` 录音**（新增 `MicRec.java` + `NativeRec` 桥），
  完全绕开 WebView；原生也开不了才回退 `getUserMedia`，并把真实错误名（NotAllowedError /
  NotFoundError / NotReadableError / OverconstrainedError）显示出来。
- **权限申请拆批**：麦克风单独一批请求。原来和存储权限混在同一个批次里，批次里带着已废弃的
  `WRITE_EXTERNAL_STORAGE`（Manifest 里根本没声明），部分 ROM 会把整批判成失败，
  麦克风系统弹窗从头到尾没出现过。
- **安卓 `/files/` 静态服务少一层目录**：`users/<uid>/<rel>` 应为 `users/<uid>/files/<rel>`，
  导致照片、录音回放全 404；`/api/asr` 读音频是同一个错（v0.3 之后录的音一律"找不到这个音频文件"），一并修好。
- 录音落盘按用户分流：原生录音直接写 `users/<uid>/files/audio/`，与 `API.file` 的 kind=audio 完全一致。

### 新增
- **设置 → 麦克风诊断**：输出权限状态、Android 版本与机型、三种采样率下 `AudioRecord`
  能否初始化、系统可见的输入设备清单、WebView 版本。出问题截个图就能定位是系统层还是 WebView 层。

### 质量
- 审计回归：主功能 52 / 多用户隔离 21 / 生成逻辑 13 / 档案管理 9 / UI 38，全部通过
- 产物内容校验：APK 内 `assets/web/app.js` 为 v0.3.3，`classes.dex` 含 `NativeRec` / `MicRec`

## v0.3.2 · 2026-10-23 —— 安卓写入修复

### 修复
- 安卓端所有"保存"失败（新建档案 / 添加配置 / 任何含空字段的写入）：
  `SQLiteDatabase.execSQL` 的绑定数组里有 Java null 会直接抛异常，而业务字段
  （死亡年份、籍贯、default_model……）本来就允许空。
  改为 `compileStatement + bindNull/bindDouble/bindString` 正确绑定。
  网页端 Node 支持 null 绑定，所以只有安卓炸——又是两端差异。

## v0.3.1 · 2026-10-23 —— 安卓兼容补丁

### 修复
- 首页打不开（no such function: json_object）：`listArchives` 用了 SQLite JSON1 函数，
  **安卓系统内置 SQLite 没有编译 JSON 扩展**（Node 端有，所以电脑正常）。
  改为普通 SQL；编辑档案时的照片清单改为打开编辑态时按需查询
- 同版本教训：**两端共用的 SQL 只能用 SQLite 通用函数子集**

## v0.3.0 · 2026-10-23 —— 里程碑：用户权限管理与数据隔离

### 新增
- **注册 / 登录**：手机号 + 密码 + 短信验证码（v0.3 演示版固定 `1234`，
  `server/sms.js` 预留真实短信通道）；密码 scrypt 哈希（Node）/ PBKDF2（安卓），永不存明文
- **token 会话**：32B 随机 token，30 天有效，退出即失效；登录错 5 次锁 10 分钟
- **用户数据物理隔离**：每用户独立的 SQLite 库（`data/users/<uid>/archive.db`）与
  媒体目录（`data/users/<uid>/files/`）——业务 SQL 零改动，隔离是文件级的
- **旧数据迁移**：升级后第一个注册的账号自动继承 v0.2 的全部档案（移动，非复制）
- 登录 / 注册页（网页与安卓 WebView 同一份）；设置页显示当前账号与退出

### 架构说明
- Node 端用 AsyncLocalStorage 做请求级上下文（uid → 用户库连接路由），并发请求互不串库
- 安卓端 `LocalServer` 同构实现 auth 接口与用户库路由（Auth.java，PBKDF2WithHmacSHA256）
- `<img>` 标签无法带 Authorization 头，采用 Cookie + Header 双轨鉴权

### 质量
- 新增多用户隔离专项审计 `test/audit-auth.js`（21 项：401 拦截 / 注册校验 / 迁移 /
  双账号隔离 / 登录安全）全部通过
- 全部既有审计适配登录态（起独立实例 + token），回归总量 131 项通过

## v0.2.0 · 2026-10-23 —— 里程碑：内容全可管理 + 录音链路闭环 + 单文件分发

这一版把"能用"升级成"好管、能带走、录音真的能转字"。

### 新增
- **档案级管理**：首页每本档案 [导出 | 改 | 删]——改名/生卒/籍贯/封面一句话/封面照片；
  删除整本时章、条目、照片、录音随外键级联清掉，媒体文件一并清理
- **一键导出 / 导入**：整本档案（文字+照片+录音）打包成单个 `.mylife.json`；
  网页端直接下载，安卓端经原生桥存到 Download 目录；导入全 ID 重分配、引用零断链
- **「传」按钮**：卷宗里每段文字后可传图片/视频/录音，采集页每条讲述同款；
  图片自动压 1600px，媒体上限 80MB，删除连带清文件
- **模型配置按能力分类**：环节下拉只列同能力模型（文本/看图/语音/文生图/视频各自归位），
  免费/付费直接标注；填一个 Key 保存即自动拉模型清单、配好三个基础环节
- **环节配置扩到五项**：起章名 / 看照片 / 语音转文字 + 图片生成（预留）+ 视频生成（预留）
- **麦克风设备选择**：采集页列出全部输入设备（虚拟声卡抢默认位时可手动切换），
  录音中实时显示音量 dB，全程静音的录音直接拒存并提示
- **EXE 真正单文件化**：web 前端与 schema.sql 打进 EXE 内部，分发只拷一个文件；
  磁盘上的 resources/ 仍是可选覆盖层（改界面不用重打包）

### 修复
- 录音转文字为空——五层根因逐一定位并修复：
  1. 浏览器录的 webm 格式转写服务不收 → 改录 WAV（浏览器端采 PCM 自打包）
  2. 分片文件名每次重新生成，一条讲述只留住最后 4 秒 → 文件名一次定型
  3. AudioContext 在异步回调里创建被 Chrome 挂起 → 移入用户手势 + 显式 resume
  4. 系统多输入设备（ToDesk 虚拟声卡抢默认位）→ 麦克风选择下拉 + 实时音量
  5. （环境层）ToDesk 残留驱动已清理
- 安卓 WebView 录音"无权限"：补 `onPermissionRequest` 显式放行（系统权限之外的第二道门）
- 手改内容被生成覆盖：界面改条目时未置 `origin='user'`，二次生成会静默冲掉手改段落
- 单句章永远没有金句：pickQuote 排除首句防重复，唯一候选恰好是首句时退回使用

### 质量
- 可重复审计脚本入库 `test/`：接口安全 15 + 数据层 39 + 生成 13 + 档案管理 8 + UI 35
  = **110 项断言**，全量回归通过

### 基线
- v0.1.0：网页端（Node + SQLite + 纯 JS 前端）与安卓端（WebView 壳 + 本地服务 + TTS）初版

## 未发布 · Unreleased

- 图片生成 / 视频生成功能接入（模型配置已预留）
- 代码签名证书（消除 SmartScreen 提示）
