import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import {
  DAILY_BACKUPS_KEPT,
  backupDatabase,
  fileTimestamp,
  localDateStamp,
  pruneBackups,
  runDailyBackup,
  runPreImportBackup,
} from './backups.ts';
import { createSilentLogger } from './logger.ts';

describe('backups', () => {
  let dir: string;
  let db: Db;
  const log = createSilentLogger();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-backups-'));
    db = openDb(':memory:');
    migrate(db);
    db.run("INSERT INTO settings (namespace, value, updated_at) VALUES ('general', '{\"userName\":\"Dana\"}', 1)");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('formats local dates and file-safe timestamps', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(fileTimestamp(new Date('2026-09-25T21:30:00.123Z'))).toBe('20260925T213000123Z');
  });

  it('VACUUM INTO writes a consistent, openable copy (and refuses inside a transaction)', () => {
    const file = path.join(dir, 'copy.db');
    backupDatabase(db, file);
    const copy = openDb(file);
    expect(copy.get<{ value: string }>("SELECT value FROM settings WHERE namespace = 'general'")?.value).toContain('Dana');
    copy.close();
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(() => db.tx(() => backupDatabase(db, path.join(dir, 'nested.db')))).toThrow(/transaction/);
  });

  it('writes one daily backup per local day and keeps the last 7', () => {
    for (let day = 1; day <= 9; day++) {
      const written = runDailyBackup({ db, dir, log, now: () => new Date(2026, 8, day, 12) });
      expect(written).toBe(path.join(dir, `homebase-2026-09-${String(day).padStart(2, '0')}.db`));
    }
    expect(runDailyBackup({ db, dir, log, now: () => new Date(2026, 8, 9, 18) })).toBeNull();
    const names = fs.readdirSync(dir).sort();
    expect(names).toHaveLength(DAILY_BACKUPS_KEPT);
    expect(names[0]).toBe('homebase-2026-09-03.db');
    expect(names.at(-1)).toBe('homebase-2026-09-09.db');
  });

  it('pre-import backups never collide and are pruned separately', () => {
    const now = () => new Date('2026-09-25T10:00:00.000Z');
    const a = runPreImportBackup({ db, dir, log, now });
    const b = runPreImportBackup({ db, dir, log, now });
    expect(a).not.toBe(b);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    fs.writeFileSync(path.join(dir, 'homebase-2026-09-01.db'), '');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), '');
    expect(pruneBackups(dir, /^homebase-/, 0)).toEqual(['homebase-2026-09-01.db']);
    expect(fs.existsSync(path.join(dir, 'unrelated.txt'))).toBe(true);
  });
});
