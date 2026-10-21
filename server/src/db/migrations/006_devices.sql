-- 006_devices: other PCs connected to this server through the configured HTTPS reverse proxy
-- (security/devices.ts, shared/src/devices.ts). Only the SHA-256 (hex) of each cookie value is
-- stored; *_at columns are INTEGER epoch ms. A revoked device keeps its row (revoked_at set) for
-- a while, so the gate can say that its cookie was revoked rather than never issued. A claimed
-- request keeps its row (status 'claimed', device_id) until it expires, so the other PC can ask
-- for its device cookie again when the answer that carried it was lost.

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  secret_hash   TEXT NOT NULL UNIQUE,
  browser       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  revoked_by    TEXT
);

CREATE TABLE device_requests (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  secret_hash   TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  browser       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'claimed')),
  device_id     TEXT
);
