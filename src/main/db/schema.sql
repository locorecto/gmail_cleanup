PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  from_email      TEXT NOT NULL,
  from_domain     TEXT NOT NULL,
  to_emails       TEXT NOT NULL DEFAULT '[]',
  cc_emails       TEXT NOT NULL DEFAULT '[]',
  subject         TEXT,
  snippet         TEXT,
  size_bytes      INTEGER,
  internal_date   INTEGER NOT NULL,
  labels          TEXT NOT NULL DEFAULT '[]',
  has_list_unsub  INTEGER NOT NULL DEFAULT 0,
  list_id         TEXT,
  is_unread       INTEGER NOT NULL DEFAULT 0,
  category_id     TEXT,
  confidence      REAL,
  fetched_at      INTEGER NOT NULL,
  body_cached     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_from_domain ON messages(from_domain);
CREATE INDEX IF NOT EXISTS idx_messages_category    ON messages(category_id);
CREATE INDEX IF NOT EXISTS idx_messages_date        ON messages(internal_date);
CREATE INDEX IF NOT EXISTS idx_messages_thread      ON messages(thread_id);

CREATE TABLE IF NOT EXISTS senders (
  email           TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  display_name    TEXT,
  total_count     INTEGER NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  replied_count   INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER,
  last_seen       INTEGER,
  has_list_unsub  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT,
  priority        INTEGER NOT NULL,
  default_action  TEXT NOT NULL DEFAULT 'trash',
  enabled         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS action_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  performed_at    INTEGER NOT NULL,
  category_id     TEXT,
  action          TEXT NOT NULL,
  message_ids     TEXT NOT NULL,
  dry_run         INTEGER NOT NULL DEFAULT 0,
  undone          INTEGER NOT NULL DEFAULT 0,
  undone_at       INTEGER,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_email   TEXT PRIMARY KEY,
  last_history_id TEXT,
  last_full_sync  INTEGER,
  last_sync       INTEGER
);

CREATE TABLE IF NOT EXISTS bodies (
  message_id      TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mime_type       TEXT,
  text_body       TEXT,
  html_body       TEXT,
  fetched_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
