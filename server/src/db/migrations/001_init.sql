-- 001_init — all v1 tables (§5).
-- Conventions: *_at columns are INTEGER epoch ms; booleans are INT 0/1; JSON columns are TEXT
-- validated with zod on read. Reserved migration ranges: 000–099 foundation/accounts/core,
-- 100–199 bookmarks+search, 200–299 weather, 300–399 todoist, 400–499 calendar, 500–599 mail.

CREATE TABLE settings (
  namespace  TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  layout     TEXT NOT NULL,
  theme      TEXT NULL, -- reserved (per-profile themes, deferred)
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE bookmark_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  color      TEXT NULL,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE bookmarks (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES bookmark_groups(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  icon_mode    TEXT NOT NULL DEFAULT 'auto' CHECK (icon_mode IN ('auto', 'custom', 'letter')),
  icon_id      TEXT NULL,
  letter_color TEXT NULL,
  created_at   INTEGER,
  updated_at   INTEGER
);
CREATE INDEX bookmarks_group_sort ON bookmarks (group_id, sort);

CREATE TABLE icons (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('favicon', 'upload')),
  source_host  TEXT NULL,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  width        INTEGER NULL,
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE secrets (
  id          TEXT PRIMARY KEY,
  key_version INTEGER NOT NULL DEFAULT 1,
  alg         TEXT NOT NULL DEFAULT 'aes-256-gcm',
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE oauth_clients (
  provider   TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  has_secret INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  account_id    TEXT NULL,
  return_to     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('google', 'microsoft', 'yahoo', 'caldav', 'imap')),
  label                TEXT NOT NULL,
  email                TEXT NULL,
  external_id          TEXT NULL,
  config               TEXT NOT NULL DEFAULT '{}',
  capabilities         TEXT NOT NULL DEFAULT '[]',
  enabled_capabilities TEXT NOT NULL DEFAULT '[]',
  granted_scopes       TEXT NULL,
  color                TEXT NULL,
  sort                 INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'reauth')),
  status_message       TEXT NULL,
  created_at           INTEGER,
  updated_at           INTEGER,
  UNIQUE (kind, external_id)
);

CREATE TABLE calendars (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('google', 'microsoft', 'caldav', 'ics')),
  remote_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  color             TEXT NULL,
  color_override    TEXT NULL,
  provider_writable INTEGER NOT NULL DEFAULT 0,
  user_read_only    INTEGER NOT NULL DEFAULT 0,
  visible           INTEGER NOT NULL DEFAULT 1,
  is_primary        INTEGER NOT NULL DEFAULT 0,
  sort              INTEGER NOT NULL DEFAULT 0,
  display_url       TEXT NULL, -- host-only display for ICS; full URL is vault secret ics:<id>
  collection_url    TEXT NULL, -- CalDAV collection href
  sync_state        TEXT NULL,
  last_synced_at    INTEGER NULL,
  last_error        TEXT NULL,
  UNIQUE (account_id, remote_id)
);

CREATE TABLE events (
  id           TEXT PRIMARY KEY, -- `${calendarId}:${sha1(remoteId + '|' + (instanceKey ?? ''))}`
  calendar_id  TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  remote_id    TEXT NOT NULL,
  instance_key TEXT NULL,
  etag         TEXT NULL,
  title        TEXT NOT NULL,
  location     TEXT NULL,
  description  TEXT NULL,
  start        TEXT NOT NULL,
  "end"        TEXT NOT NULL,
  all_day      INTEGER NOT NULL,
  timezone     TEXT NULL,
  status       TEXT NULL,
  recurring    INTEGER NOT NULL DEFAULT 0,
  series_id    TEXT NULL,
  html_url     TEXT NULL,
  meeting_url  TEXT NULL,
  editable     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX events_calendar_start ON events (calendar_id, start);
CREATE INDEX events_all_day_start_end ON events (all_day, start, "end");

-- Non-sensitive data only (weather, suggestions).
CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
