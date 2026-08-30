-- NightInk / EroToonX - esquema base reproducible de D1
-- Seguro para una base existente: todas las creaciones usan IF NOT EXISTS.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS comics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'En emisión',
  cover_key TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'single' CHECK (content_type IN ('single', 'series')),
  is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1)),
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comics_published_updated
  ON comics(is_published, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comics_content_type
  ON comics(content_type);
CREATE INDEX IF NOT EXISTS idx_comics_cover_key
  ON comics(cover_key);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comic_id INTEGER NOT NULL,
  chapter_number INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(comic_id, chapter_number),
  FOREIGN KEY (comic_id) REFERENCES comics(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chapters_comic_number
  ON chapters(comic_id, chapter_number);
CREATE INDEX IF NOT EXISTS idx_chapters_published_updated
  ON chapters(is_published, updated_at DESC);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chapter_id, page_number),
  FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_chapter_number
  ON pages(chapter_id, page_number);
CREATE INDEX IF NOT EXISTS idx_pages_object_key
  ON pages(object_key);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  client_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_login_limits (
  client_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS series_group_members (
  chapter_id INTEGER PRIMARY KEY,
  series_comic_id INTEGER NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  source_slug TEXT NOT NULL DEFAULT '',
  source_description TEXT NOT NULL DEFAULT '',
  source_genre TEXT NOT NULL DEFAULT '',
  source_tags TEXT NOT NULL DEFAULT '',
  source_author TEXT NOT NULL DEFAULT '',
  source_status TEXT NOT NULL DEFAULT '',
  source_cover_key TEXT NOT NULL DEFAULT '',
  source_is_published INTEGER NOT NULL DEFAULT 1,
  source_views INTEGER NOT NULL DEFAULT 0,
  source_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY (series_comic_id) REFERENCES comics(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_series_group_members_series
  ON series_group_members(series_comic_id, source_order);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  aliases TEXT NOT NULL DEFAULT '',
  detection_mode TEXT NOT NULL DEFAULT 'manual',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_categories_active_name
  ON categories(is_active, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS category_migrations (
  migration_key TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_memory (
  series_key TEXT PRIMARY KEY,
  series_title TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  rejected_tags TEXT NOT NULL DEFAULT '',
  memory_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Solicitudes enviadas desde Contacto / Privacidad / DMCA.
CREATE TABLE IF NOT EXISTS site_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'privacy', 'security', 'dmca')),
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  content_url TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'closed')),
  client_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_site_messages_status_created
  ON site_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_messages_kind_created
  ON site_messages(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS site_message_limits (
  client_hash TEXT PRIMARY KEY,
  submissions INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
