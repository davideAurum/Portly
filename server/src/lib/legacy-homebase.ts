/**
 * Moving over from Homebase, Portly's name before the rename (ARCHITECTURE §19). Portly copies
 * Homebase's database and vault key into its own data folder only when asked to: a request file
 * `copy-from-homebase.json` in Portly's data folder, written by `scripts/install-autostart.ps1` (the
 * switch-over) or `portly --copy-from-homebase`. A plain first start (`npm start`, a dev server)
 * never copies, so it cannot freeze an early snapshot. Homebase's folder is left exactly as it was.
 *
 * - Where: `homebase.db` in Portly's data folder itself (PORTLY_DATA_DIR naming a folder Homebase
 *   used, as when `scripts/install-autostart.ps1` carried HOMEBASE_DATA_DIR over), else - only while
 *   PORTLY_DATA_DIR is unset - Homebase's default folder (`%LOCALAPPDATA%\Homebase`, or
 *   `$XDG_DATA_HOME/homebase`).
 * - How: `VACUUM INTO` a temporary file (a consistent copy even while an old Homebase still has the
 *   database open; busy and locked errors are retried), then `vault.key` (when the database comes
 *   from another folder; the key is protected for this Windows user wherever the file lives, and the
 *   vault canary kept its old value, so saved accounts keep working), then the temporary file is
 *   renamed to `portly.db`. With `"replace": true` an existing `portly.db` is first moved aside to
 *   `portly.db.before-homebase-<time>`; without it, an existing database is kept and nothing copied.
 * - Afterwards: the request is removed and `migrated-from-homebase.json` records the outcome
 *   (`copied`, `kept-portly-database` or `failed`).
 * - A copy that cannot be made fails start-up (the request stays, so the next start tries again)
 *   rather than starting with an empty database that would hide Homebase's for good. A missing or
 *   unreadable Homebase database is a permanent failure; `portly --copy-from-homebase --cancel`
 *   withdraws the request.
 * - Never: overwrite Portly's key, change Homebase's files, or leave a partial `portly.db`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE } from './exit-codes.ts';
import { errorFields, type Logger } from './logger.ts';
import { StartupError } from './startup.ts';

export const LEGACY_DB_FILE = 'homebase.db';
export const LEGACY_KEY_FILE = 'vault.key';
export const MIGRATION_MARKER = 'migrated-from-homebase.json';
export const COPY_REQUEST = 'copy-from-homebase.json';
/** Copy attempts while Homebase's database is busy or a file is locked, and the wait before each retry. */
export const COPY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface LegacyPaths {
  dataDir: string;
  /** Portly's database (`<dataDir>/portly.db`). */
  db: string;
  /** Portly's vault key (`<dataDir>/vault.key`). */
  vaultKey: string;
}

export interface LegacyMigration {
  /** The folder the data came from. */
  from: string;
  /** What was copied, e.g. `['homebase.db -> portly.db', 'vault.key']`. */
  copied: string[];
  /** Where an existing `portly.db` was moved (a `"replace": true` request). */
  replaced?: string;
}

export interface CopyRequest {
  /** Move an existing `portly.db` aside and copy Homebase's anyway. */
  replace: boolean;
}

export interface MigrateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: Logger;
  now?: () => Date;
  /** Waits between attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the `VACUUM INTO` copy (tests). */
  copyDatabase?: (source: string, target: string) => void;
}

/** Homebase's default data folder, the one it used without HOMEBASE_DATA_DIR. */
export function legacyDefaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() !== '' ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Homebase');
  }
  const xdg = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'homebase');
}

/** The Homebase database to copy from, or null: see the file comment for the order. */
export function findLegacyDatabase(dataDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const candidates = [path.join(dataDir, LEGACY_DB_FILE)];
  const custom = env.PORTLY_DATA_DIR;
  if (typeof custom !== 'string' || custom.trim() === '') candidates.push(path.join(legacyDefaultDataDir(env, platform), LEGACY_DB_FILE));
  return candidates.find((file) => isFile(file)) ?? null;
}

/** The pending copy request in `dataDir`, or null. An unreadable request still counts (without `replace`). */
export function readCopyRequest(dataDir: string): CopyRequest | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, COPY_REQUEST), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return { replace: typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).replace === true };
  } catch {
    return { replace: false };
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `VACUUM INTO target` from `source`: read-only first, so nothing is written next to Homebase's file. */
function vacuumInto(source: string, target: string): void {
  const attempt = (readOnly: boolean): void => {
    const db = new DatabaseSync(source, { readOnly });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(target);
    } finally {
      db.close();
    }
  };
  try {
    attempt(true);
  } catch {
    // A read-only connection cannot open a WAL database whose -shm file is missing; a normal one can
    // (it reads only: VACUUM INTO writes nothing but the target).
    fs.rmSync(target, { force: true });
    attempt(false);
  }
}

/** Busy or locked: worth another attempt. node:sqlite errors carry `errcode` (5 SQLITE_BUSY, 6 SQLITE_LOCKED). */
export function isTransientCopyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown };
  const primary = typeof e.errcode === 'number' ? e.errcode & 0xff : null;
  return primary === 5 || primary === 6 || e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
}

function writeMarker(dataDir: string, record: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dataDir, MIGRATION_MARKER), `${JSON.stringify(record, null, 2)}\n`);
}

/** Moves `portly.db` and its -wal/-shm files to `<db>.before-homebase-<stamp>[-wal|-shm]`; returns the new name. */
function moveAside(db: string, stamp: string): string {
  const aside = `${db}.before-homebase-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (isFile(`${db}${suffix}`)) fs.renameSync(`${db}${suffix}`, `${aside}${suffix}`);
  }
  return aside;
}

/**
 * Carries out a pending copy request (see the file comment). Returns what was copied, or null when
 * nothing was requested or Portly's own database was kept. Throws a {@link StartupError} when the
 * requested copy cannot be made.
 */
export async function migrateFromHomebase(paths: LegacyPaths, options: MigrateOptions = {}): Promise<LegacyMigration | null> {
  const request = readCopyRequest(paths.dataDir);
  if (request === null) return null;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const copy = options.copyDatabase ?? vacuumInto;
  const requestFile = path.join(paths.dataDir, COPY_REQUEST);

  if (isFile(paths.db) && !request.replace) {
    writeMarker(paths.dataDir, { status: 'kept-portly-database', at: now().toISOString() });
    fs.rmSync(requestFile, { force: true });
    options.log?.warn('Portly already has its own database, so the data of Homebase was not copied (portly --copy-from-homebase --replace copies it over)');
    return null;
  }

  const fail = (code: string, message: string, exitCode: number, fields: Record<string, unknown>): never => {
    writeMarker(paths.dataDir, { status: 'failed', at: now().toISOString(), code, ...fields });
    throw new StartupError(code, message, { exitCode, fields });
  };

  const source = findLegacyDatabase(paths.dataDir, env, options.platform);
  if (source === null) {
    return fail(
      'homebase_not_found',
      'a copy of the data of Homebase was requested, but no homebase.db was found; run `portly --copy-from-homebase --cancel` to start without it',
      EXIT_PERMANENT_FAILURE,
      {},
    );
  }
  const from = path.dirname(source);
  const temporary = `${paths.db}.from-homebase`;
  const copied: string[] = [];
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      fs.rmSync(temporary, { force: true });
      copy(source, temporary);
      break;
    } catch (err) {
      fs.rmSync(temporary, { force: true });
      const transient = isTransientCopyError(err);
      if (transient && attempts < COPY_ATTEMPTS) {
        options.log?.warn('could not copy the data of Homebase yet; trying again', { from, attempts, ...errorFields(err) });
        await sleep(RETRY_DELAY_MS * attempts);
        continue;
      }
      return fail(
        transient ? 'homebase_copy_busy' : 'homebase_copy_failed',
        transient
          ? 'could not copy the data of Homebase: its database stayed busy or locked; start Portly again to retry'
          : 'could not copy the data of Homebase: its database could not be read; run `portly --copy-from-homebase --cancel` to start without it',
        transient ? EXIT_STARTUP_FAILURE : EXIT_PERMANENT_FAILURE,
        { from, attempts, ...errorFields(err) },
      );
    }
  }
  copied.push(`${LEGACY_DB_FILE} -> ${path.basename(paths.db)}`);

  let replaced: string | undefined;
  try {
    const legacyKey = path.join(from, LEGACY_KEY_FILE);
    if (path.resolve(from) !== path.resolve(paths.dataDir) && isFile(legacyKey) && !isFile(paths.vaultKey)) {
      fs.copyFileSync(legacyKey, paths.vaultKey, fs.constants.COPYFILE_EXCL);
      copied.push(LEGACY_KEY_FILE);
    }
    if (request.replace && isFile(paths.db)) replaced = moveAside(paths.db, now().toISOString().replace(/[:.]/g, '-'));
    fs.renameSync(temporary, paths.db);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    return fail(
      'homebase_copy_failed',
      'could not put the copy of the data of Homebase in place; start Portly again to retry',
      EXIT_STARTUP_FAILURE,
      { from, copied, ...errorFields(err) },
    );
  }

  const result: LegacyMigration = { from, copied, ...(replaced === undefined ? {} : { replaced }) };
  writeMarker(paths.dataDir, { status: 'copied', at: now().toISOString(), ...result });
  fs.rmSync(requestFile, { force: true });
  options.log?.info('copied the data of Homebase (the name before Portly)', { ...result });
  return result;
}
