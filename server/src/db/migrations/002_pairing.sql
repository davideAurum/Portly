-- 002_pairing — browsers paired with this server through the Pages site (hybrid mode,
-- security/pairing.ts), and small facts about this server installation (its instance id).
-- Only the SHA-256 (hex) of each pairing token is stored; *_at columns are INTEGER epoch ms.

CREATE TABLE pairings (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  origin       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE server_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
