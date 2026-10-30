-- 岁月记录助手 · 数据库结构
-- 两端共用：安卓（Db.java 读 assets/schema.sql）与网页端（server.js 读同一份）
-- 规则：一句一行、以分号结尾、语句内不得出现分号（注释里也不行）

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  archive_no TEXT,
  subject_name TEXT NOT NULL,
  birth_year INTEGER,
  death_year INTEGER,
  hometown TEXT,
  intro TEXT,
  facts_json TEXT,
  cover_photo_id INTEGER,
  visibility INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  year_from INTEGER,
  year_to INTEGER,
  stage TEXT,
  quote TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  audio_path TEXT,
  raw_text TEXT,
  year_hint INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  taken_year INTEGER NOT NULL,
  taken_month INTEGER,
  taken_day INTEGER,
  place TEXT NOT NULL,
  event TEXT NOT NULL,
  chapter_id INTEGER,
  match_score REAL,
  match_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  caption TEXT,
  duration_ms INTEGER,
  poster TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  chapter_id INTEGER,
  seq INTEGER NOT NULL DEFAULT 10,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  photo_id INTEGER,
  media_id INTEGER,
  segment_id INTEGER,
  origin TEXT NOT NULL DEFAULT 'ai',
  edited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  expires_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE INDEX IF NOT EXISTS ix_chapters_archive ON chapters(archive_id, seq);
CREATE INDEX IF NOT EXISTS ix_entries_archive ON entries(archive_id, seq);
CREATE INDEX IF NOT EXISTS ix_entries_chapter ON entries(chapter_id);
CREATE INDEX IF NOT EXISTS ix_photos_archive ON photos(archive_id, taken_year);
CREATE INDEX IF NOT EXISTS ix_segments_archive ON segments(archive_id);
CREATE INDEX IF NOT EXISTS ix_arches ON archives(user_id, deleted_at);

INSERT OR IGNORE INTO users (id, phone, name) VALUES (1, 'local', '我');
INSERT OR IGNORE INTO settings (k, v) VALUES ('schema_version', '1');

-- ===== AI 配置中心 =====
-- 一条配置 = 一个可用的模型来源。可以无限添加。
CREATE TABLE IF NOT EXISTS ai_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai',
  base_url TEXT NOT NULL,
  api_key TEXT,
  models_json TEXT,
  default_model TEXT,
  vision_model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 用途绑定：哪个环节用哪个配置的哪个模型。一条用途一行。
CREATE TABLE IF NOT EXISTS ai_slots (
  slot TEXT PRIMARY KEY,
  profile_id INTEGER,
  model TEXT
);

INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('title', NULL, NULL);
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('vision', NULL, NULL);
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('asr', NULL, NULL);
-- 图片生成 / 视频生成：功能接入前先把模型配置留着
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('img', NULL, NULL);
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('vid', NULL, NULL);
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('tts', NULL, NULL);
INSERT OR IGNORE INTO ai_slots (slot, profile_id, model) VALUES ('music', NULL, NULL);

-- ===== v0.5 基座：派生素材 / 任务队列 / 用量记账 =====

CREATE TABLE IF NOT EXISTS derivations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  source_path TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  out_path TEXT NOT NULL,
  bytes INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_deriv ON derivations(source_path, params_hash);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  stage TEXT,
  result_json TEXT,
  error TEXT,
  cancel_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  capability TEXT NOT NULL,
  model TEXT,
  units REAL NOT NULL DEFAULT 0,
  unit TEXT,
  cost REAL NOT NULL DEFAULT 0,
  ref TEXT,
  at TEXT DEFAULT (datetime('now'))
);

-- ===== v0.6 导出记录 =====

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  archive_id INTEGER,
  kind TEXT NOT NULL,
  path TEXT,
  bytes INTEGER,
  params_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== v0.7 版本 / 剧本 / 分镜 / 素材 / 对话 =====

CREATE TABLE IF NOT EXISTS entry_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  archive_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'polish',
  style TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'proposal',
  model TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  chapter_id INTEGER,
  title TEXT,
  json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storyboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  chapter_id INTEGER,
  layout TEXT NOT NULL DEFAULT '4',
  json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER,
  capability TEXT NOT NULL,
  cache_key TEXT,
  path TEXT NOT NULL,
  prompt TEXT,
  model TEXT,
  meta_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER,
  role TEXT NOT NULL DEFAULT 'interviewer',
  title TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  refs_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS ix_usage_at ON ai_usage(at);
CREATE INDEX IF NOT EXISTS ix_versions_entry ON entry_versions(entry_id);
CREATE INDEX IF NOT EXISTS ix_msgs_thread ON ai_messages(thread_id, id);

-- ===== v0.5 字段增量（旧库升级用；新库的 CREATE 里已含，重复执行会被忽略） =====
ALTER TABLE archives ADD COLUMN portrait_photo_id INTEGER;
ALTER TABLE archives ADD COLUMN cover_config_json TEXT;
ALTER TABLE photos ADD COLUMN role TEXT DEFAULT 'inline';
ALTER TABLE photos ADD COLUMN crop_json TEXT;
ALTER TABLE entries ADD COLUMN at_year INTEGER;
ALTER TABLE entries ADD COLUMN at_month INTEGER;
ALTER TABLE entries ADD COLUMN at_day INTEGER;
ALTER TABLE entries ADD COLUMN at_precision TEXT;
ALTER TABLE entries ADD COLUMN at_label TEXT;
ALTER TABLE entries ADD COLUMN sort_key REAL;
ALTER TABLE segments ADD COLUMN at_year INTEGER;
ALTER TABLE segments ADD COLUMN at_month INTEGER;
ALTER TABLE segments ADD COLUMN at_day INTEGER;
ALTER TABLE segments ADD COLUMN at_precision TEXT;
ALTER TABLE segments ADD COLUMN at_label TEXT;
ALTER TABLE media ADD COLUMN at_year INTEGER;
ALTER TABLE media ADD COLUMN at_month INTEGER;
ALTER TABLE media ADD COLUMN at_day INTEGER;
ALTER TABLE media ADD COLUMN at_precision TEXT;
ALTER TABLE media ADD COLUMN at_label TEXT;

-- 时间轴：四类内容按统一字段合成一张视图，前端只查它
CREATE VIEW IF NOT EXISTS v_timeline AS
SELECT 'entry' AS kind, e.id AS id, e.archive_id AS archive_id, e.chapter_id AS chapter_id, e.at_year AS at_year, e.at_month AS at_month, e.at_day AS at_day, e.at_precision AS at_precision, e.at_label AS at_label, COALESCE(e.sort_key, e.seq) AS sort_key, substr(COALESCE(e.text, ''), 1, 90) AS preview FROM entries e
UNION ALL
SELECT 'segment', s.id, s.archive_id, NULL, s.at_year, s.at_month, s.at_day, s.at_precision, s.at_label, s.id, substr(COALESCE(s.raw_text, ''), 1, 90) FROM segments s
UNION ALL
SELECT 'photo', p.id, p.archive_id, p.chapter_id, p.taken_year, p.taken_month, p.taken_day, 'year', NULL, p.id, COALESCE(p.event, '') FROM photos p
UNION ALL
SELECT 'media', m.id, m.archive_id, NULL, m.at_year, m.at_month, m.at_day, m.at_precision, m.at_label, m.id, COALESCE(m.caption, m.kind) FROM media m;

-- v0.9.17 素材箱：随手记 / 随口说 / 随手拍。
-- 先攒进这里，不定档案、不强制编年；AI 归纳后一条条"收进档案"变成正式条目。
CREATE TABLE IF NOT EXISTS quick_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'text',          -- text / audio / photo
  text TEXT,                                   -- 文字本体；audio 存转写结果
  media_path TEXT,                             -- audio/photo 的文件相对路径
  media_seconds INTEGER,                       -- audio 时长（秒）
  status TEXT NOT NULL DEFAULT 'open',         -- open / adopted
  archive_id INTEGER,                          -- 收进哪本档案
  entry_id INTEGER,                            -- 收录后生成的条目
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_quick_status ON quick_notes(status, id DESC);
