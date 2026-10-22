-- 我的人生档案 · 数据库结构
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
