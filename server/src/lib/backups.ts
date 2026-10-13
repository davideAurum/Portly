/**
 * Database backups (§3): a daily `VACUUM INTO backups/portly-<YYYY-MM-DD>.db` (local date, the
 * last 7 kept) and a `pre-import-<timestamp>.db` snapshot before every config import.
 *
 * Each backup is written to a temporary name and renamed into place, so a crash mid-way never
 * leaves a truncated file that looks like a finished backup. `VACUUM INTO` cannot run inside a
 * transaction; callers invoke these helpers outside `db.tx`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.ts';
import { errorFields, type Logger } from './logger.ts';

export const DAILY_BACKUPS_KEPT = 7;
export const PRE_IMPORT_BACKUPS_KEPT = 5;
export const DAILY_BACKUP_REGEX = /^portly-\d{4}-\d{2}-\d{2}\.db$/;
export const PRE_IMPORT_BACKUP_REGEX = /^pre-import-\d{8}T\d{9}Z(-\d+)?\.db$/;

/** `YYYY-MM-DD` in local time. */
export function localDateStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Compact UTC timestamp usable in Windows file names, e.g. `20260925T213000123Z`. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

/** Writes a consistent copy of the database to `file` (which must not exist yet). */
export function backupDatabase(db: Db, file: string): void {
  if (db.inTransaction) throw new Error('backupDatabase cannot run inside a transaction');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    db.run('VACUUM INTO ?', [tmp]);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Deletes all but the newest `keep` files in `dir` whose names match `pattern` (names sort by date). */
export function pruneBackups(dir: string, pattern: RegExp, keep: number, log?: Logger): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => pattern.test(n));
  } catch {
    return [];
  }
  names.sort();
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  const removed: string[] = [];
  for (const name of doomed) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch (err) {
      log?.warn('could not delete old backup', { file: name, ...errorFields(err) });
    }
  }
  return removed;
}

export interface BackupOptions {
  db: Db;
  dir: string;
  log: Logger;
  now?: () => Date;
}

/**
 * Creates today's backup if it does not exist yet, then prunes to the last 7.
 * Returns the file written, or null when today's backup already existed.
 */
export function runDailyBackup(options: BackupOptions): string | null {
  const { db, dir, log } = options;
  const today = (options.now ?? (() => new Date()))();
  const file = path.join(dir, `portly-${localDateStamp(today)}.db`);
  let written: string | null = null;
  if (!fs.existsSync(file)) {
    const started = Date.now();
    backupDatabase(db, file);
    written = file;
    log.info('database backup written', { file: path.basename(file), ms: Date.now() - started });
  }
  const removed = pruneBackups(dir, DAILY_BACKUP_REGEX, DAILY_BACKUPS_KEPT, log);
  if (removed.length > 0) log.info('old backups removed', { count: removed.length });
  return written;
}

/** Snapshot taken before an import replaces data; keeps the last 5. Returns the file written. */
export function runPreImportBackup(options: BackupOptions): string {
  const { db, dir, log } = options;
  const stamp = fileTimestamp((options.now ?? (() => new Date()))());
  let file = path.join(dir, `pre-import-${stamp}.db`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `pre-import-${stamp}-${i}.db`);
  backupDatabase(db, file);
  log.info('pre-import backup written', { file: path.basename(file) });
  pruneBackups(dir, PRE_IMPORT_BACKUP_REGEX, PRE_IMPORT_BACKUPS_KEPT, log);
  return file;
}
