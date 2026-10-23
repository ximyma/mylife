# v0.3 升级方案 —— 用户权限管理与数据隔离

> 状态：方案待确认（未开工）
> 目标版本：v0.3.0
> 原则：**v0.3 只做这一件事**——注册 / 登录 / 用户数据隔离。不加任何新功能，不改任何业务行为。

---

## 1. 目标

| 能力 | 说明 |
|---|---|
| 注册 | 手机号 + 密码 + 短信验证码（**验证码暂固定 `1234`**，预留真实短信通道） |
| 登录 / 退出 | 登录后才能用；token 30 天有效 |
| 数据隔离 | 用户 A 看不到也碰不到用户 B 的任何档案、照片、录音 |
| 兼容 | v0.2 的现有数据不丢；两端（网页 EXE / 安卓）行为一致 |
| 不做 | 找回密码、角色权限、云端同步、真实计费短信——全部留给 v0.4+ |

## 2. 现状与差距

| 项 | 现状 | 差距 |
|---|---|---|
| 数据库 | 全程序一个 `archive.db` | 需要按用户分开 |
| 表结构 | `archives.user_id` 字段已预留（默认 1），但从未使用 | 需要真正落位 |
| 接口 | `/api/query` `/api/exec` 由前端发任意 SQL，4 个哑接口 | 服务端必须知道"当前是哪个用户、开哪个库" |
| 媒体文件 | 全部在 `data/files/` 一层 | 需要按用户分目录 |
| 鉴权 | 完全没有 | 需要注册 / 登录 / token 校验 |
| 安卓端 | `LocalServer.java` 同构的 4 接口 + 单库 | 同 Node 端一起改 |

## 3. 核心决策：每用户一个 SQLite 库文件（物理隔离）

三个候选里选这个：

| 方案 | 做法 | 结论 |
|---|---|---|
| A. SQL 改写过滤 | 服务端解析 SQL 强插 `user_id=?` | ✗ SQL 解析改写极脆弱，改不全就是越权 |
| B. 业务接口化 | 4 个哑接口换成 30+ 个业务接口，全部带 user_id | ✗ 推翻项目"业务全在 web/db.js、零接口维护"的哲学，两端工作量翻倍 |
| **C. 每用户一个库文件** | `data/users/<uid>/archive.db`，token 解出 uid 后把连接路由到对应库 | ✓ **选定** |

**选 C 的理由**：

1. **业务 SQL 零改动**——`web/db.js` 里所有语句原样运行，只是落在用户自己的库里；
   子表（chapters/entries/photos/segments/media）全部以 `archive_id` 为根挂在各自库中，
   物理上不存在跨用户数据，不存在"过滤漏了"这一类漏洞。
2. **隔离是文件级的**——备份 / 删除 / 导出一个用户 = 拷走 / 删掉一个目录。
3. **服务端改动集中**：只加 auth 接口 + 连接路由 + 文件根路径替换，约 200 行；
   安卓端同构约 300 行。
4. 单进程本地服务的场景下，"每用户一库"没有连接数压力（连接按需打开 + LRU 缓存 20 个）。

## 4. 数据库设计

### 4.1 全局账号库 `data/auth.db`（新建，与用户库分离）

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,            -- 11 位，1 开头
  password_hash TEXT NOT NULL,           -- scrypt(N=16384,r=8,p=1, 64B) hex
  salt TEXT NOT NULL,                    -- 16B random hex
  nickname TEXT,                         -- 选填
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,                -- 32B random hex
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL               -- 30 天
);
CREATE TABLE IF NOT EXISTS sms_codes (   -- 真实短信上线后启用；固定 1234 模式下不落表
  phone TEXT, code TEXT, expires_at TEXT, used INTEGER DEFAULT 0
);
```

### 4.2 用户库 `data/users/<uid>/archive.db`

- 直接执行现有 `schema.sql` 初始化（全部幂等，无需迁移器）
- **所有业务表结构不变**；`archives.user_id` 依然写入（值为 uid，双保险 + 未来合并多库时可用）

### 4.3 媒体目录

```
data/users/<uid>/files/photo|audio|video/
```

## 5. 接口设计（Node 端与安卓端同构）

### 5.1 新增 auth 接口（免 token）

| 接口 | 入参 | 行为 |
|---|---|---|
| `POST /api/auth/register` | phone, password, code, nickname? | 校验手机号格式 → 校验验证码（固定模式：`code === '1234'`）→ 查重 → scrypt 哈希入库 → 建用户目录与库 → 返回 token |
| `POST /api/auth/login` | phone, password | 校验 → 签发 token；连续失败 5 次锁 10 分钟 |
| `POST /api/auth/sms` | phone | 发验证码。固定模式直接返回 ok（不开真短信）；真实模式走预留的 `sendSms()` 钩子，60 秒限 1 条、每天限 10 条 |
| `POST /api/auth/logout` | —（需 token） | 删 sessions 记录 |
| `GET  /api/auth/me` | —（需 token） | 返回 uid / phone / nickname |

### 5.2 现有接口全部挂鉴权

- `/api/query`、`/api/exec`、`/api/file`、`/api/ai*`、`/api/asr`、`/files/*`：
  请求头 `Authorization: Bearer <token>` → 查 sessions → 得 uid → **该请求的所有 SQL 落在
  `data/users/<uid>/archive.db`，所有文件路径根为 `data/users/<uid>/files/`**
- token 缺失 / 过期 → `401 {"__auth":"需要登录"}`，前端统一跳登录页
- 数据库连接：惰性打开 + LRU 缓存（上限 20 个，超出关最久未用的）

### 5.3 验证码

- **v0.3 固定 `1234`**：`/api/auth/sms` 不真发，注册时只比对 1234
- 预留钩子：`server/sms.js` 暴露 `send(phone, code)`——v0.4 接阿里云 / 腾讯云短信时只实现这一个函数，
  注册逻辑一行不改

## 6. 服务端改动清单（Node 端，预计 ~250 行）

| 文件 | 改动 |
|---|---|
| `server/server.js` | ① 启动开 `auth.db`；② 鉴权中间件（解析 Bearer → uid）；③ 连接路由：`dbForUser(uid)` 惰性开库 + LRU；④ 旧数据迁移引导（见 §8） |
| `server/auth.js`（新） | 注册 / 登录 / 验证码 / scrypt / token 签发校验 / 限速 |
| `server/sms.js`（新） | `send(phone, code)` 空实现（固定 1234 模式），v0.4 替换 |
| 静态服务 | `/files/*` 根路径从 `data/files/` 改为 `data/users/<uid>/files/` |

## 7. 前端改动（预计 ~150 行）

| 文件 | 改动 |
|---|---|
| `web/app.js` | ① 新增登录 / 注册页（手机号+密码+验证码，验证码输入框旁标注"演示版验证码：1234"）；② `api.js` 每个请求带 `Authorization` 头，收到 401 统一跳登录；③ 设置页「关于」区显示当前账号 + 退出按钮；④ 启动时先探测 `/api/auth/me`，未登录进登录页 |
| `web/api.js` | 请求头统一注入 token；401 拦截 |
| token 存储 | `localStorage('mylife.token')`（安卓 WebView 同样支持） |

## 8. 安卓端改动（预计 ~300 行）

| 项 | 改动 |
|---|---|
| `LocalServer.java` | 同构 auth 接口 + token 中间件 + 用户库路由。密码哈希用 `PBKDF2WithHmacSHA256`（Java 标准库）——**两端算法不必一致**：账号库各自独立，密码只在各自端校验 |
| 用户库路径 | `context.getFilesDir()/users/<uid>/archive.db` |
| 登录页 | 复用前端登录页（WebView 加载），无需原生 UI |
| 升级安装 | versionCode 3；首次启动若无 token 进登录页 |

## 9. 旧数据迁移（必须无损）

**规则：升级后第一个注册的账号自动继承 v0.2 的全部数据。**

1. 启动时检测：`data/archive.db` 存在 且 `auth.db` 的 users 表为空 → 进入"待迁移"状态
2. 第一个用户完成注册 → 把 `data/archive.db` **移动**为 `data/users/<uid>/archive.db`，
   `data/files/` **移动**为 `data/users/<uid>/files/`
3. 控制台与前端 toast 明示："已有档案已归属账号 <手机号>"
4. 迁移是移动不是复制——不会出现两份数据分叉
5. 安卓端同理（旧单库移入首个注册用户的目录）

## 10. 安全要点（全部零依赖，用 Node 内置 crypto）

| 项 | 做法 |
|---|---|
| 密码存储 | `crypto.scryptSync(password, salt, 64)`，随机 16B salt，**永不存明文** |
| token | `randomBytes(32)` hex，30 天过期，退出即删 |
| 防爆破 | 登录失败 5 次锁该手机号 10 分钟（内存计数，单进程够用） |
| 验证码防刷 | 同手机号 60s 1 条 / 24h 10 条；固定 1234 模式不适用，真实短信上线后生效 |
| 手机号格式 | `^1[3-9]\d{9}$` |
| SQL 注入 | 不变——全部参数化（`bind()` 已强制转字符串） |
| 越权 | 物理隔离（用户库/目录），不存在跨用户 SQL 路径 |

## 11. 阶段划分

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P1 服务端** | auth.js + sms.js + 鉴权中间件 + 用户库路由 + 文件隔离 + 迁移引导 | `node server/server.js` 可注册登录，SQL 落各自库 |
| **P2 前端** | 登录注册页 + token 注入 + 401 跳转 + 账号显示/退出 | 网页端完整走通注册→登录→使用 |
| **P3 安卓** | LocalServer 同构 + WebView 登录页 + versionCode 3 | APK 行为与网页一致 |
| **P4 测试发布** | 审计脚本扩展（多用户隔离专项）+ 全量回归 + CHANGELOG + tag v0.3.0 | 两端安装包 + 备份包 |

## 12. 验收标准（P4 全部满足才算完成）

1. 未登录访问任何 `/api/*` 与 `/files/*` → 401，前端跳登录页
2. 注册：验证码非 1234 拒绝；手机号格式错拒绝；重复手机号拒绝
3. 登录：密码错 5 次锁定；正确后 30 天内免登录
4. **隔离**：账号 A 建档案/传照片/录音，账号 B 登录后首页为空、文件 404、
   直接对 B 的库发 SQL 也查不到 A 的任何行（物理不同库）
5. **迁移**：v0.2 升级场景，首个注册账号继承全部旧档案且内容一致（数量校验）
6. 退出登录后 token 失效
7. 现有 110 项审计在新登录态下全量通过 + 新增多用户隔离审计 ≥10 项通过
8. 安卓端同 1–6

## 13. 明确不做（v0.3 范围外）

- 找回密码 / 换绑手机（v0.4，需真实短信）
- 多设备会话管理（同一账号多端登录暂共用 token 池，不做踢下线）
- 角色与权限分级（全员普通用户）
- 真实短信计费接入（只留 `server/sms.js` 钩子）
- 云端同步 / 在线服务化（仍是本地程序）

---

## 附：工作量估算

| 阶段 | 估时 |
|---|---|
| P1 服务端 | 半天 |
| P2 前端 | 2–3 小时 |
| P3 安卓 | 半天 |
| P4 测试发布 | 2 小时 |
| **合计** | **约 1.5 个工作日** |
