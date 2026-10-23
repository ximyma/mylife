# 里程碑 2 · 两端全链路打通

**版本 v0.4.0** ｜ 2026-10-23 ｜ 前一个里程碑：v0.2（里程碑 1，档案管理与单文件分发）

---

## 一、里程碑目标

里程碑 1 解决了「一个人在一台电脑上把档案做出来」。
里程碑 2 要解决的是「**换到手机上也能完整做完，而且一家人各用各的**」。

所以验收标准不是「代码写完」，而是**两台真机跑通全链路**：

```
注册 → 登录 → 设置模型 → 新建档案 → 录音 → 试听 → 转文字 → 生成卷宗 → 朗读 → 导出
```

任何一环在真机上不通，这个里程碑就不算完成。

---

## 二、验收清单（实测结果）

### 真机

| 设备 | 系统 | WebView | 结果 |
| --- | --- | --- | --- |
| 小米 9 | Android 11 | 系统 WebView | ✅ 全链路通过 |
| 荣耀 50 | Android 14 | WebView 99 | ✅ 全链路通过 |
| Windows 11 笔记本 | Chrome / Edge | — | ✅ 网页端同套前端通过 |

### 功能逐项

| # | 项目 | 状态 | 备注 |
| --- | --- | --- | --- |
| 1 | 手机号注册（密码 + 验证码） | ✅ | 演示期验证码固定 `1234` |
| 2 | 登录 / 登出 / 令牌续期 | ✅ | token 30 天，5 次失败锁 10 分钟 |
| 3 | 每用户独立数据库 | ✅ | `data/users/<uid>/archive.db`，物理隔离 |
| 4 | 首个用户接管旧数据 | ✅ | v0.2 的库与 `files/` 自动搬进 `users/<uid>/` |
| 5 | 新建 / 编辑 / 删除档案 | ✅ | 删除级联清理条目、照片、素材、录音 |
| 6 | 录音（安卓原生） | ✅ | `AudioRecord` 16k，写 WAV 到 `users/<uid>/files/audio/` |
| 7 | 录音（网页端） | ✅ | `getUserMedia` + `ScriptProcessor`，可选麦克风设备 |
| 8 | 录音试听 | ✅ | 补内容页每段一个「试听」，全页单例播放器 |
| 9 | 语音转文字 | ✅ | 硅基流动 `FunAudioLLM/SenseVoiceSmall`（免费、≤50MB / 1h） |
| 10 | 照片 / 视频 / 录音附件 | ✅ | `/files/` 三通道鉴权，两端都能显示与回放 |
| 11 | 生成卷宗 | ✅ | 年份抽取、分章、切条目、照片归位，<120ms |
| 12 | 朗读 | ✅ | 安卓原生 TTS（逐句高亮），浏览器 `speechSynthesis` |
| 13 | 导出 / 导入 `.mylife.json` | ✅ | 单文件搬整本档案 |
| 14 | 单文件 EXE 分发 | ✅ | 空目录可跑，构建期冒烟测试守着 |

### 自动化回归

| 脚本 | 项数 | 覆盖 |
| --- | --- | --- |
| `test/audit.js` | 52 | 主功能（档案 / 章节 / 条目 / 素材 / 查询写入） |
| `test/audit-auth.js` | 21 | 注册登录、令牌、双账号隔离、旧数据迁移 |
| `test/audit-generate.js` | 13 | 生成规则（年份、分章、照片归位） |
| `test/audit-archive-mgmt.js` | 9 | 档案级改 / 删 / 级联 |
| `test/audit-asr.js` | 12 | 转写契约、模型不存在自动换 |
| `test/audit-files.js` | 18 | `/files` 三通道鉴权、路径穿越、`model:null` 契约 |
| `test/audit-android.js` | 34 | 安卓静态审计（把下面那些坑钉死） |
| `test/audit-ui.js` | 38 | 无头浏览器界面审计 |
| **合计** | **197** | 全绿 |

---

## 三、这一段真正学到的东西

里程碑 2 从 v0.3.0 走到 v0.4.0，中间六个版本几乎全是在处理**同一类问题**：
「网页端好好的，手机上就是不行」。

根因是一个结构性事实：**安卓端不是浏览器**。它有自己的一套 SQLite、自己的 JSON、
自己的权限模型、自己决定要不要接受你上传的请求。下面六条，每一条都是真机撞出来的。

### 1. 安卓系统 SQLite 没有 JSON1 扩展

`json_group_array` / `json_object` 在桌面版 SQLite 是内置的，在安卓系统库里**没编译进去**。
首页档案列表原来靠它拼计数，装到手机上直接 `no such function: json_object`。

→ 改用相关子查询 `(SELECT COUNT(*) FROM ... WHERE ...)`。这是标准 SQL，两头都有。

### 2. `execSQL` 的绑定数组里有 Java `null` 会直接抛异常

原来用一个 `Object[]` 拼参数，Java 的 `null` 传进去不是「绑 NULL」，是**崩**。
症状极具迷惑性：接口返回成功、提示「已保存」，但库里什么都没有。

→ 改用 `compileStatement` + 显式 `bindNull / bindLong / bindDouble / bindString`。
每一个位置的值类型都必须自己判断，不能指望框架猜。

### 3. 迁移来的旧库缺新表

`Db.open()` 原来只在**新建库**时执行 `initSchema()`。旧库搬过来之后结构还是 v0.1 的，
新表一个都没有，于是「保存成功但读不到」。

→ `ensureSchema()`，每次打开库都跑一遍（全部 `IF NOT EXISTS` / `INSERT OR IGNORE`，
幂等）。代价是几十毫秒，换来的是**任何版本的库都能被当前版本打开**。

### 4. 安卓 SQLite 读出来的每一列都是字符串

`Cursor.getString(i)` —— 所有列都当字符串取。桌面端 `node:sqlite` 给的是 JS 数字。
前端写 `profiles[i].id === 1`，在手机上变成 `"1" === 1`，永远 false。

症状：**配置的「改」点了完全没反应，删了重加才行**；「删除整本档案」同样静默失败
（不中就 `return`，什么都不发生）。

→ 在 `API.query` 这唯一入口加 `normalizeRows()`，按列名把数值列还原成数字，
让两端数据形状一致。这是体系性修法，不是给某个按钮打补丁。

### 5. `JSON null` 在安卓里会变成字符串 `"null"`

`org.json` 的 `optString(name, "")` 实现是 `JSON.toString(opt(name))`，
而 `JSONObject.NULL.toString()` 返回的正是**字符串 `"null"`**。

于是前端发 `{ "model": null }`（没指定模型时的正常写法），安卓侧拿到 `"null"`，
`length()` 是 4 不是 0 → 判空失效 → 请求里带上 `model=null`
→ 转写接口回 `400 Model does not exist`。

Node 端写的是 `body.model || profile.default_model`，`null` 是 falsy 直接跳过，所以电脑一直好。

→ 新增 `Json.sv()`：JSON null / 字段缺失 / 字面 `"null"` / `"undefined"` 一律当「没给」。
`Ai.java` 里所有 `optString` 全部替换。

### 6. 标签发不了自定义请求头

`<img src>` 和 `<audio src>` 是浏览器自己去做请求，**带不上 `Authorization`**。
Node 端登录时 `Set-Cookie`，浏览器自动带上，所以网页端照片正常；
安卓本地服务只认 `Authorization`，这些请求一律 401 —— 照片不显示、录音点不动。

→ 本地服务登录时同样 `Set-Cookie`，`/files/` 接受 `Authorization` → `Cookie` → `?token=`
三种来源；前端统一走 `fsrc()` 带 token。

### 附：还有两个与权限无关、但同样只有手机才犯的错

- **`setChunkedStreamingMode(0)`** 会发 `Transfer-Encoding: chunked`，
  不少 OpenAI 兼容网关（nginx / 云 WAF 前置）直接拒收。浏览器 `fetch(FormData)` 是固定长度。
  → 改 `setFixedLengthStreamingMode`。
- **靠 `in.available() == 0` 判断请求读完** —— 这个值只表示内核缓冲区此刻有多少字节。
  小 JSON 平时一整包到达所以看不出来，传照片（几 MB base64）会随机截断。
  → 先读到 `\r\n\r\n` 拿 `Content-Length`，再精确读那么多字节。

### 关于「没有麦克风权限」

这个提示曾经把我们带偏很久。真相是**前端把所有失败都写成这一句**：设备不可用、
被占用、WebView 未放行 `PermissionRequest`、系统权限没给——全糊成「没有权限」。

而 WebView 录音要过**两道门**：系统权限是第一道，`onPermissionRequest` 是第二道。
国产 ROM 上第二道经常直接拒，系统权限给成什么样都没用。

→ 安卓端录音改走**原生 `AudioRecord`**，完全绕开 WebView 这一层；
前端错误文案按 `NotAllowedError / NotFoundError / NotReadableError / OverconstrainedError`
细分；权限申请把麦克风**单独一批**（原来和存储混批，批里带着 Manifest 没声明的
`WRITE_EXTERNAL_STORAGE`，部分 ROM 判整批失败，麦克风弹窗从没出现过）。

---

## 四、架构（里程碑 2 定型）

```
              ┌───────────────────────────────────┐
              │        web/  一套前端（ES5）       │
              │  index.html style.css api.js      │
              │  db.js（全部 SQL 与生成规则）★    │
              │  app.js（界面与交互）             │
              └────────────────┬──────────────────┘
                               │ 只认 4 个接口
              ┌────────────────┴──────────────────┐
              │                                   │
   ┌──────────▼──────────┐          ┌─────────────▼─────────────┐
   │  server/server.js   │          │  android/ LocalServer.java │
   │  Node 22 + SEA      │          │  ServerSocket @127.0.0.1  │
   │  node:sqlite        │          │  android.database.sqlite  │
   └──────────┬──────────┘          └─────────────┬─────────────┘
              │                                   │
   data/users/<uid>/archive.db          filesDir/users/<uid>/archive.db
   data/users/<uid>/files/              filesDir/users/<uid>/files/
```

两端接口完全一致：

```
POST /api/query  {sql, params}  -> rows[]
POST /api/exec   {sql, params}  -> {changes, lastId}
POST /api/ai     {messages}     -> {text}         （Key 只在服务端，永不进前端）
POST /api/asr    {path, model}  -> {ok, text}
POST /api/file   {op, ...}      -> 落盘 / 读 / 删 / 列
GET  /files/<rel>               -> 二进制，支持 Range
```

**业务逻辑只有一份**：全在 `web/db.js`。后端不懂业务，只做 SQLite 和文件的代理。
改需求只改 JS，两端同时生效——这是整个项目最重要的结构决定。

---

## 五、遗留与取舍

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 验证码 | 固定 `1234` | 演示期设计。接短信服务商（阿里云 / 腾讯云 SMS）需签名与模板报备，等工作流稳定再上 |
| 智谱 glm-asr-2512 | 已加平台预设但不可用 | 官方硬限 **单段 ≤30 秒 / 25MB**，无长音频接口。要用得在本地做 VAD 切段 |
| Groq whisper | 已加平台预设但不可用 | `api.groq.com` 国内被墙，手机端无代理直接超时 |
| 阿里百炼 paraformer-v2 | 未接 | 每月 10 小时免费，但非 OpenAI 兼容，需独立分支 |
| 长音频自动切段 | 未做 | 做出来能让所有「有单段上限」的平台都可用（WAV 是 PCM16，切段只改 44 字节头） |
| 公网部署 | 未做 | 现在是本机 / 同一台手机上跑，够用且最安全 |

**免费 + 长音频 + 国内直连，目前只有硅基流动 `FunAudioLLM/SenseVoiceSmall` 一家满足。**
转写链路已经做了「模型不存在自动换」，所以即使以后硅基流动下架这个模型，
也不会再出现「点了没反应」。

---

## 六、产物与构建

```
dist/
├── MyLife-v0.4.0-windows.exe        单文件（含界面，空目录可跑）
├── MyLife-v0.4.0-android.apk        安卓调试包（versionCode 9）
├── mylife-v0.4.0-backup-YYYYMMDD.zip  全源码 + EXE + APK 备份
├── win/                              EXE 工作目录（含 data/、resources/、使用说明.txt）
└── archive/                          旧版本归档，别装那些
```

```bat
REM 网页端调试
node server/server.js                 → http://127.0.0.1:4321

REM 出 APK（需 JDK 17 + Android SDK + Gradle）
build-apk.bat

REM 出 EXE + 同步版本命名产物 + 冒烟测试
node tools/build-exe.js

REM 出全量备份包
python tools/make-backup.py
```

> **打包环境的坑**：Gradle 构建时如果同时跑无头 Chrome 审计，会因提交内存不足
> 报 `os::commit_memory failed / 页面文件太小`。构建期间别开浏览器审计；
> 内存紧张时用 `-Xmx512m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC`。

---

## 七、里程碑 2 之后

按重要性排：

1. **长音频自动切段**（让智谱等有单段上限的平台可用，通用能力）
2. **真实短信验证码**（接入服务商，替换固定 `1234`）
3. **分享页**（给家人看，只读链接）
4. **公网部署方案**（一部手机或一台小主机当家里的服务器）

里程碑 1 是「能做完」，里程碑 2 是「在哪都能做完、一家人各做各的」。
下一步该解决的是「做完之后怎么让别人看到」。
