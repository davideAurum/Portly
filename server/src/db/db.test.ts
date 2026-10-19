import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT,
  LayoutSchema,
  ThemeSchema,
  defaultThemeBackground,
  emptyLayout,
  upgradeLegacyThemeDefaults,
  type Theme,
} from '@portly/shared';
import { createMemoryLogger } from '../lib/logger.ts';
import { camelize, fromBool, msToIso, parseJsonColumn, toBool } from './helpers.ts';
import { listMigrations, migrate } from './migrate.ts';
import { openDb, type Db } from './open.ts';

describe('openDb', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, b BLOB, s TEXT)');
  });
  afterEach(() => db.close());

  it('applies the required pragmas', () => {
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete).toBe(1);
  });

  it('uses WAL for file databases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-db-'));
    const fileDb = openDb(path.join(dir, 'nested', 'portly.db'));
    try {
      expect(fileDb.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    } finally {
      fileDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns plain objects with Buffer BLOBs', () => {
    db.run('INSERT INTO t (id, n, b, s) VALUES (?, ?, ?, ?)', ['a', 1, Buffer.from([1, 2, 3]), 'x']);
    const row = db.get('SELECT * FROM t WHERE id = ?', ['a']);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Buffer.isBuffer(row?.b)).toBe(true);
    expect([...(row?.b as Buffer)]).toEqual([1, 2, 3]);
    expect(row).toEqual({ id: 'a', n: 1, b: Buffer.from([1, 2, 3]), s: 'x' });
  });

  it('supports named parameters and all()', () => {
    db.run('INSERT INTO t (id, n) VALUES (:id, :n)', { id: 'a', n: 1 });
    db.run('INSERT INTO t (id, n) VALUES ($id, $n)', { id: 'b', n: 2 });
    expect(db.all<{ id: string }>('SELECT id FROM t ORDER BY n').map((r) => r.id)).toEqual(['a', 'b']);
    expect(db.get('SELECT id FROM t WHERE id = ?', ['zzz'])).toBeUndefined();
    expect(db.run('DELETE FROM t WHERE n > ?', [0]).changes).toBe(2);
  });

  it('treats values as data (no SQL injection through params)', () => {
    const evil = "x'); DROP TABLE t; --";
    db.run('INSERT INTO t (id, s) VALUES (?, ?)', [evil, evil]);
    expect(db.get<{ s: string }>('SELECT s FROM t WHERE id = ?', [evil])?.s).toBe(evil);
    expect(db.all('SELECT * FROM t').length).toBe(1);
  });

  it('tx commits on success and rolls back on throw', () => {
    db.tx(() => db.run('INSERT INTO t (id) VALUES (?)', ['ok']));
    expect(() =>
      db.tx(() => {
        db.run('INSERT INTO t (id) VALUES (?)', ['rolled-back']);
        throw new Error('fail');
      }),
    ).toThrow('fail');
    expect(db.all<{ id: string }>('SELECT id FROM t').map((r) => r.id)).toEqual(['ok']);
    expect(db.inTransaction).toBe(false);
  });

  it('nested tx uses savepoints (inner failure keeps outer work)', () => {
    db.tx(() => {
      db.run('INSERT INTO t (id) VALUES (?)', ['outer']);
      expect(() =>
        db.tx(() => {
          db.run('INSERT INTO t (id) VALUES (?)', ['inner']);
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.tx(() => db.run('INSERT INTO t (id) VALUES (?)', ['inner-ok']));
    });
    expect(db.all<{ id: string }>('SELECT id FROM t ORDER BY id').map((r) => r.id)).toEqual(['inner-ok', 'outer']);
  });

  it('tx rejects async callbacks and rolls back', () => {
    expect(() =>
      db.tx(async () => {
        db.run('INSERT INTO t (id) VALUES (?)', ['async']);
      }),
    ).toThrow(/synchronous/);
    expect(db.all('SELECT * FROM t')).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });
});

describe('migrations', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('applies 001_init once and records it', () => {
    expect(migrate(db)).toContain('001_init.sql');
    expect(migrate(db)).toEqual([]);
    const rows = db.all<{ name: string; applied_at: number }>('SELECT * FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_init.sql');
  });

  it('applies 002_pairing after 001_init', () => {
    expect(migrate(db)).toEqual(expect.arrayContaining(['001_init.sql', '002_pairing.sql']));
    const cols = db.all<{ name: string; notnull: number; pk: number }>('PRAGMA table_info(pairings)');
    expect(cols.map((c) => c.name)).toEqual(['id', 'token_hash', 'label', 'origin', 'created_at', 'last_used_at']);
    expect(cols.find((c) => c.name === 'last_used_at')?.notnull).toBe(0);
    db.run("INSERT INTO pairings (id, token_hash, label, origin, created_at) VALUES ('p1', 'h', 'l', 'https://o', 1)");
    expect(() => db.run("INSERT INTO pairings (id, token_hash, label, origin, created_at) VALUES ('p2', 'h', 'l', 'https://o', 1)")).toThrow();
    expect(db.all<{ name: string }>('PRAGMA table_info(server_meta)').map((c) => c.name)).toEqual(['key', 'value']);
  });

  it('applies 003_diagnostics after 002_pairing: diag_health and diag_outcomes with their indexes', () => {
    expect(migrate(db)).toEqual(expect.arrayContaining(['001_init.sql', '002_pairing.sql', '003_diagnostics.sql']));
    const names = db.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').map((r) => r.name);
    expect(names.indexOf('003_diagnostics.sql')).toBe(names.indexOf('002_pairing.sql') + 1);
    expect(db.all<{ name: string }>('PRAGMA table_info(diag_health)').map((c) => c.name)).toEqual([
      'key', 'area', 'label', 'account_id', 'status', 'last_ok_at', 'last_fail_at', 'failing_since', 'last_checked_at',
      'expect_every_ms', 'consecutive_failures', 'last_code', 'last_status', 'last_message', 'last_ms', 'detail', 'cause_key',
      'next_attempt_at', 'last_reminder_at', 'updated_at',
    ]);
    expect(db.all<{ name: string }>('PRAGMA table_info(diag_outcomes)').map((c) => c.name)).toEqual([
      'id', 'key', 'at', 'last_at', 'count', 'ok', 'status', 'code', 'http_status', 'message', 'ms', 'detail',
    ]);
    const indexes = db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'diag_%'");
    expect(indexes.find((i) => i.name === 'diag_health_account')?.sql).toMatch(/diag_health\(account_id\)/);
    expect(indexes.find((i) => i.name === 'diag_outcomes_key_at')?.sql).toMatch(/diag_outcomes\(key, at\)/);
    db.run("INSERT INTO diag_health (key, area, status, updated_at) VALUES ('todoist', 'todoist', 'failing', 1)");
    expect(db.get<{ consecutive_failures: number }>("SELECT consecutive_failures FROM diag_health WHERE key = 'todoist'")?.consecutive_failures).toBe(0);
    // 'stale' is derived at read time, never stored.
    expect(() => db.run("INSERT INTO diag_health (key, area, status, updated_at) VALUES ('weather', 'weather', 'stale', 1)")).toThrow();
    expect(() => db.run("INSERT INTO diag_health (key, area, status) VALUES ('w2', 'weather', 'ok')")).toThrow();
    db.run("INSERT INTO diag_outcomes (key, at, last_at, ok, status) VALUES ('todoist', 1, 1, 0, 'failing')");
    expect(db.get<{ count: number }>('SELECT count FROM diag_outcomes')?.count).toBe(1);
  });

  it('creates every §5 table with its indexes', () => {
    migrate(db);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(
      [
        'accounts',
        'bookmark_groups',
        'bookmarks',
        'cache',
        'calendars',
        'diag_health',
        'diag_outcomes',
        'events',
        'icons',
        'oauth_clients',
        'oauth_states',
        'pairings',
        'profiles',
        'schema_migrations',
        'secrets',
        'server_meta',
        'settings',
        'uploads',
      ].sort(),
    );
    const indexes = db.all<{ tbl_name: string; sql: string | null }>("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL");
    expect(indexes.find((i) => i.tbl_name === 'bookmarks')?.sql).toMatch(/\(group_id, sort\)/);
    const eventIndexes = indexes.filter((i) => i.tbl_name === 'events').map((i) => i.sql);
    expect(eventIndexes.some((s) => /\(calendar_id, start\)/.test(s ?? ''))).toBe(true);
    expect(eventIndexes.some((s) => /\(all_day, start, "end"\)/.test(s ?? ''))).toBe(true);
    const cols = db.all<{ name: string }>('PRAGMA table_info(events)').map((c) => c.name);
    expect(cols).toEqual([
      'id', 'calendar_id', 'remote_id', 'instance_key', 'etag', 'title', 'location', 'description', 'start', 'end',
      'all_day', 'timezone', 'status', 'recurring', 'series_id', 'html_url', 'meeting_url', 'editable', 'updated_at',
    ]);
  });

  it('enforces CHECK, UNIQUE and FK constraints', () => {
    migrate(db);
    db.run("INSERT INTO bookmark_groups (id, name) VALUES ('g1', 'G')");
    expect(() => db.run("INSERT INTO bookmarks (id, group_id, title, url, icon_mode) VALUES ('b1', 'g1', 't', 'https://x', 'emoji')")).toThrow();
    expect(() => db.run("INSERT INTO bookmarks (id, group_id, title, url) VALUES ('b1', 'missing', 't', 'https://x')")).toThrow();
    db.run("INSERT INTO bookmarks (id, group_id, title, url) VALUES ('b1', 'g1', 't', 'https://x')");
    db.run("DELETE FROM bookmark_groups WHERE id = 'g1'");
    expect(db.all('SELECT * FROM bookmarks')).toEqual([]);

    expect(() => db.run("INSERT INTO accounts (id, kind, label) VALUES ('a1', 'aol', 'x')")).toThrow();
    db.run("INSERT INTO accounts (id, kind, label, external_id) VALUES ('a1', 'google', 'x', 'sub-1')");
    expect(() => db.run("INSERT INTO accounts (id, kind, label, external_id) VALUES ('a2', 'google', 'y', 'sub-1')")).toThrow();
    expect(() => db.run("INSERT INTO accounts (id, kind, label, status) VALUES ('a3', 'imap', 'x', 'weird')")).toThrow();

    db.run("INSERT INTO calendars (id, account_id, source, remote_id, name) VALUES ('c1', 'a1', 'google', 'primary', 'Cal')");
    db.run("INSERT INTO events (id, calendar_id, remote_id, title, start, \"end\", all_day, updated_at) VALUES ('e1', 'c1', 'r', 'T', '2026-01-01', '2026-01-02', 1, 0)");
    db.run("DELETE FROM accounts WHERE id = 'a1'");
    expect(db.all('SELECT * FROM calendars')).toEqual([]);
    expect(db.all('SELECT * FROM events')).toEqual([]);
  });

  it('applies module migrations in filename order and rejects bad names/duplicates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-mig-'));
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, '001_first.sql'), 'CREATE TABLE one (x INTEGER);');
    fs.writeFileSync(path.join(b, '100_second.sql'), 'CREATE TABLE two (x INTEGER); INSERT INTO one VALUES (1);');
    try {
      expect(listMigrations([b, a]).map((m) => m.name)).toEqual(['001_first.sql', '100_second.sql']);
      const log = createMemoryLogger();
      expect(migrate(db, { dirs: [b, a], log })).toEqual(['001_first.sql', '100_second.sql']);
      expect(db.get<{ x: number }>('SELECT x FROM one')?.x).toBe(1);

      fs.writeFileSync(path.join(b, '001_clash.sql'), 'SELECT 1;');
      expect(() => listMigrations([a, b])).toThrow(/Duplicate/);
      fs.rmSync(path.join(b, '001_clash.sql'));
      fs.writeFileSync(path.join(b, 'bad-name.sql'), 'SELECT 1;');
      expect(() => listMigrations([a, b])).toThrow(/Invalid migration file name/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back every pending migration when one fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-mig-'));
    fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
    fs.writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE broken (;');
    try {
      expect(() => migrate(db, { dirs: [dir] })).toThrow(/Migration 002_bad.sql failed/);
      expect(db.get("SELECT name FROM sqlite_master WHERE name = 'ok'")).toBeUndefined();
      expect(db.all('SELECT * FROM schema_migrations')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies 005_oauth_state_capabilities: a nullable capabilities column on oauth_states', () => {
    expect(migrate(db)).toContain('005_oauth_state_capabilities.sql');
    const cols = db.all<{ name: string; notnull: number }>('PRAGMA table_info(oauth_states)');
    expect(cols.map((c) => c.name)).toEqual(['state', 'provider', 'code_verifier', 'account_id', 'return_to', 'created_at', 'expires_at', 'capabilities']);
    expect(cols.find((c) => c.name === 'capabilities')?.notnull).toBe(0);
  });

  describe('004_beacon_defaults', () => {
    /** Migrates up to 003 only, stores `appearance`, then runs every remaining migration. */
    function upgradeFrom003(appearance: unknown): Theme {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-mig-'));
      try {
        for (const m of listMigrations().filter((m) => m.number < 4)) fs.copyFileSync(m.file, path.join(dir, m.name));
        migrate(db, { dirs: [dir] });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      db.run("INSERT INTO settings (namespace, value, updated_at) VALUES ('appearance', ?, 1)", [JSON.stringify(appearance)]);
      expect(migrate(db)).toContain('004_beacon_defaults.sql');
      const row = db.get<{ value: string }>("SELECT value FROM settings WHERE namespace = 'appearance'");
      return ThemeSchema.parse(JSON.parse(row?.value ?? 'null'));
    }

    it('moves the old default accent and gradient to the Beacon defaults and keeps everything else', () => {
      const stored = ThemeSchema.parse({
        mode: 'dark',
        accent: '#2563EB',
        background: { type: 'gradient', angle: 160, stops: [{ color: '#1E3A8A', at: 0 }, { color: '#6d28d9', at: 100 }] },
      });
      const upgraded = upgradeFrom003(stored);
      expect(upgraded.accent).toBe(DEFAULT_ACCENT);
      expect(upgraded.background).toEqual(defaultThemeBackground());
      expect(upgraded.mode).toBe('dark');
      expect(upgraded).toEqual(upgradeLegacyThemeDefaults(stored));
    });

    it('leaves a chosen accent and a different gradient alone', () => {
      const stored = ThemeSchema.parse({
        accent: '#e11d48',
        background: { type: 'gradient', angle: 135, stops: [{ color: '#1e3a8a', at: 0 }, { color: '#6d28d9', at: 100 }] },
      });
      expect(upgradeFrom003(stored)).toEqual(stored);
      expect(upgradeLegacyThemeDefaults(stored)).toBe(stored);
    });
  });
});

describe('db helpers', () => {
  it('converts booleans, timestamps and keys', () => {
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(fromBool(true)).toBe(1);
    expect(msToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(msToIso(null)).toBeNull();
    expect(camelize({ account_id: 'a', last_synced_at: 1, id: 'x' })).toEqual({ accountId: 'a', lastSyncedAt: 1, id: 'x' });
  });

  it('parseJsonColumn validates and falls back', () => {
    const log = createMemoryLogger();
    expect(parseJsonColumn(LayoutSchema, '{"version":1,"items":[]}', emptyLayout())).toEqual({ version: 1, items: [] });
    expect(parseJsonColumn(LayoutSchema, 'nope', emptyLayout(), log, 'x')).toEqual({ version: 1, items: [] });
    expect(parseJsonColumn(LayoutSchema, '{"version":9}', emptyLayout(), log, 'x')).toEqual({ version: 1, items: [] });
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});
