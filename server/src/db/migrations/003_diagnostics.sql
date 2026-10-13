-- 003_diagnostics — health of every synced subject and a short outcome history (Settings → Diagnostics).
-- Machine-local: not exported or imported (core/transfer.ts lists its tables explicitly). *_at = epoch ms.
CREATE TABLE diag_health (
  key TEXT PRIMARY KEY, area TEXT NOT NULL, label TEXT, account_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','degraded','failing','unknown')),
  last_ok_at INTEGER, last_fail_at INTEGER, failing_since INTEGER, last_checked_at INTEGER, expect_every_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_code TEXT, last_status INTEGER, last_message TEXT, last_ms INTEGER, detail TEXT, cause_key TEXT,
  next_attempt_at INTEGER, last_reminder_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX diag_health_account ON diag_health(account_id);
CREATE TABLE diag_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, ok INTEGER NOT NULL, status TEXT NOT NULL, code TEXT, http_status INTEGER,
  message TEXT, ms INTEGER, detail TEXT
);
CREATE INDEX diag_outcomes_key_at ON diag_outcomes(key, at);
