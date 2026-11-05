-- portly:foreign-keys-off
-- 007_account_kinds — accounts.kind stops being a fixed list, so that a new provider (Spotify is the
-- first) needs no migration of its own. ACCOUNT_KINDS in shared/src/accounts.ts stays the list of
-- kinds this build knows; the CHECK keeps only the shape of the value.
--
-- SQLite cannot change a CHECK in place, so this rebuilds the table the documented way
-- (https://www.sqlite.org/lang_altertable.html, section 7): create the new table, copy the rows,
-- drop the old one, rename the new one. Dropping `accounts` with foreign keys on would delete every
-- row first and cascade into calendars and events: the first line above makes migrate.ts run this
-- file with foreign keys off, in its own transaction, and check them before it commits.
-- The table has no indexes, triggers or views of its own to carry over. Nothing else changes.

CREATE TABLE accounts_new (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32 AND kind NOT GLOB '*[^a-z0-9_-]*'),
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

INSERT INTO accounts_new (
  id, kind, label, email, external_id, config, capabilities, enabled_capabilities, granted_scopes,
  color, sort, status, status_message, created_at, updated_at
)
SELECT
  id, kind, label, email, external_id, config, capabilities, enabled_capabilities, granted_scopes,
  color, sort, status, status_message, created_at, updated_at
FROM accounts;

DROP TABLE accounts;

ALTER TABLE accounts_new RENAME TO accounts;
