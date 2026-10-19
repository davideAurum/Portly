import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { EXIT_PERMANENT_FAILURE, EXIT_STARTUP_FAILURE } from './exit-codes.ts';
import {
  COPY_ATTEMPTS,
  COPY_REQUEST,
  MIGRATION_MARKER,
  findLegacyDatabase,
  isTransientCopyError,
  legacyDefaultDataDir,
  migrateFromHomebase,
  readCopyRequest,
  type LegacyPaths,
  type MigrateOptions,
} from './legacy-homebase.ts';
import { createTestLogger } from './logger.ts';
import { StartupError } from './startup.ts';

describe('moving over from Homebase', () => {
  let root: string;
  let open: Db[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-legacy-'));
    open = [];
  });
  afterEach(() => {
    for (const db of open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A Homebase data folder: a migrated database with one setting, and a vault key file. */
  function homebaseFolder(dir: string, { key = 'old-key' }: { key?: string | null } = {}): Db {
    fs.mkdirSync(dir, { recursive: true });
    const db = openDb(path.join(dir, 'homebase.db'));
    open.push(db);
    migrate(db);
    db.run("INSERT INTO settings (namespace, value, updated_at) VALUES ('general', '{\"userName\":\"Dana\"}', 1)");
    if (key !== null) fs.writeFileSync(path.join(dir, 'vault.key'), key);
    return db;
  }

  function portlyPaths(dataDir: string): LegacyPaths {
    return { dataDir, db: path.join(dataDir, 'portly.db'), vaultKey: path.join(dataDir, 'vault.key') };
  }

  /** What install-autostart.ps1 and `portly --copy-from-homebase` write. */
  function requestCopy(dataDir: string, request: Record<string, unknown> = {}): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, COPY_REQUEST), JSON.stringify({ requestedAt: '2026-10-12T11:00:00Z', ...request }));
  }

  function marker(dataDir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dataDir, MIGRATION_MARKER), 'utf8')) as Record<string, unknown>;
  }

  /** Runs the migration, expecting it to fail start-up; returns the error. */
  async function failure(paths: LegacyPaths, options: MigrateOptions): Promise<StartupError> {
    const err: unknown = await migrateFromHomebase(paths, options).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StartupError);
    return err as StartupError;
  }

  const noSleep = async (): Promise<void> => {};
  const busy = (): Error => Object.assign(new Error('database is locked'), { errcode: 5 });

  function userName(file: string): string | undefined {
    const db = openDb(file);
    try {
      return db.get<{ value: string }>("SELECT value FROM settings WHERE namespace = 'general'")?.value;
    } finally {
      db.close();
    }
  }

  it("knows Homebase's default folder on Windows and elsewhere", () => {
    expect(legacyDefaultDataDir({ LOCALAPPDATA: 'C:\\Users\\dana\\AppData\\Local' }, 'win32')).toBe(
      path.join('C:\\Users\\dana\\AppData\\Local', 'Homebase'),
    );
    expect(legacyDefaultDataDir({ XDG_DATA_HOME: '/home/dana/.data' }, 'linux')).toBe(path.join('/home/dana/.data', 'homebase'));
  });

  it("copies nothing without a request, even on Portly's very first start", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    expect(await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' })).toBeNull();
    expect(fs.existsSync(paths.dataDir)).toBe(false);
  });

  it("copies the database and the vault key from Homebase's default folder when asked to", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    const log = createTestLogger();
    const result = await migrateFromHomebase(paths, {
      env: { LOCALAPPDATA: local },
      platform: 'win32',
      log,
      now: () => new Date('2026-10-12T12:00:00Z'),
    });
    expect(result).toEqual({ from: path.join(local, 'Homebase'), copied: ['homebase.db -> portly.db', 'vault.key'] });
    expect(userName(paths.db)).toBe('{"userName":"Dana"}');
    expect(fs.readFileSync(paths.vaultKey, 'utf8')).toBe('old-key');
    expect(marker(paths.dataDir)).toEqual({
      status: 'copied',
      at: '2026-10-12T12:00:00.000Z',
      from: path.join(local, 'Homebase'),
      copied: ['homebase.db -> portly.db', 'vault.key'],
    });
    expect(readCopyRequest(paths.dataDir), 'the request is done').toBeNull();
    expect(fs.existsSync(path.join(local, 'Homebase', 'homebase.db')), "Homebase's files stay").toBe(true);
    expect(log.lines().some((line) => line.msg.startsWith('copied the data of Homebase'))).toBe(true);

    // Done once: a later start, or deleting the data folder to start over, copies nothing again.
    fs.rmSync(paths.dataDir, { recursive: true });
    expect(await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' })).toBeNull();
    expect(fs.existsSync(paths.db)).toBe(false);
  });

  it('copies homebase.db that sits in the data folder itself (PORTLY_DATA_DIR naming a Homebase folder)', async () => {
    const custom = path.join(root, 'custom');
    homebaseFolder(custom);
    const paths = portlyPaths(custom);
    requestCopy(custom);
    const result = await migrateFromHomebase(paths, { env: { PORTLY_DATA_DIR: custom }, platform: 'win32' });
    expect(result).toEqual({ from: custom, copied: ['homebase.db -> portly.db'] });
    expect(userName(paths.db)).toBe('{"userName":"Dana"}');
    expect(fs.readFileSync(paths.vaultKey, 'utf8'), 'the key was already in place').toBe('old-key');
  });

  it("keeps Portly's own database unless the request says replace", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    fs.writeFileSync(paths.db, 'portly data');
    const log = createTestLogger();
    expect(await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32', log })).toBeNull();
    expect(fs.readFileSync(paths.db, 'utf8')).toBe('portly data');
    expect(marker(paths.dataDir)).toMatchObject({ status: 'kept-portly-database' });
    expect(readCopyRequest(paths.dataDir)).toBeNull();
    expect(log.lines().some((line) => line.level === 'warn' && line.msg.includes('--replace'))).toBe(true);
  });

  it('moves an existing database aside, with its WAL and its vault key, when the request says replace', async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir, { replace: true });
    fs.writeFileSync(paths.db, 'portly data');
    fs.writeFileSync(`${paths.db}-wal`, 'portly wal');
    fs.writeFileSync(paths.vaultKey, 'portly-key');
    const result = await migrateFromHomebase(paths, {
      env: { LOCALAPPDATA: local },
      platform: 'win32',
      now: () => new Date('2026-10-12T12:00:00Z'),
    });
    const aside = `${paths.db}.before-homebase-2026-10-12T12-00-00-000Z`;
    expect(result?.replaced).toBe(aside);
    expect(fs.readFileSync(aside, 'utf8')).toBe('portly data');
    expect(fs.readFileSync(`${aside}-wal`, 'utf8')).toBe('portly wal');
    expect(fs.existsSync(`${paths.db}-wal`)).toBe(false);
    expect(userName(paths.db)).toBe('{"userName":"Dana"}');
    // The key goes with its database: Homebase's with the copy, Portly's beside its old database.
    const keyAside = `${paths.vaultKey}.before-homebase-2026-10-12T12-00-00-000Z`;
    expect(result?.replacedKey, 'the same time as its database').toBe(keyAside);
    expect(fs.readFileSync(keyAside, 'utf8')).toBe('portly-key');
    expect(fs.readFileSync(paths.vaultKey, 'utf8')).toBe('old-key');
    expect(result?.copied).toEqual(['homebase.db -> portly.db', 'vault.key']);
    expect(marker(paths.dataDir)).toMatchObject({ status: 'copied', replaced: aside, replacedKey: keyAside });
  });

  it("looks in Homebase's default folder only while PORTLY_DATA_DIR is unset", () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const custom = path.join(root, 'custom');
    expect(findLegacyDatabase(custom, { LOCALAPPDATA: local, PORTLY_DATA_DIR: custom }, 'win32')).toBeNull();
    expect(findLegacyDatabase(custom, { LOCALAPPDATA: local, PORTLY_DATA_DIR: '  ' }, 'win32')).toBe(
      path.join(local, 'Homebase', 'homebase.db'),
    );
  });

  it("copies from the folder HOMEBASE_DATA_DIR names into Portly's own folder", async () => {
    const local = path.join(root, 'Local');
    const moved = path.join(root, 'D', 'Homebase data');
    homebaseFolder(moved);
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    const result = await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: ` ${moved} ` }, platform: 'win32' });
    expect(result).toEqual({ from: moved, copied: ['homebase.db -> portly.db', 'vault.key'] });
    expect(userName(paths.db)).toBe('{"userName":"Dana"}');
    expect(fs.readFileSync(paths.vaultKey, 'utf8')).toBe('old-key');
    expect(fs.existsSync(path.join(moved, 'portly.db')), "nothing is written to Homebase's folder").toBe(false);
  });

  it('reads HOMEBASE_DATA_DIR as the only Homebase folder, whatever PORTLY_DATA_DIR says', () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const moved = path.join(root, 'moved');
    const portly = path.join(root, 'portly');
    // Homebase did not use its default folder while HOMEBASE_DATA_DIR was set: an old copy there is not its data.
    expect(findLegacyDatabase(portly, { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: moved }, 'win32')).toBeNull();
    homebaseFolder(moved);
    expect(findLegacyDatabase(portly, { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: moved }, 'win32')).toBe(path.join(moved, 'homebase.db'));
    expect(findLegacyDatabase(portly, { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: moved, PORTLY_DATA_DIR: portly }, 'win32')).toBe(
      path.join(moved, 'homebase.db'),
    );
    expect(findLegacyDatabase(portly, { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: '  ' }, 'win32'), 'blank is unset').toBe(
      path.join(local, 'Homebase', 'homebase.db'),
    );
    // homebase.db in Portly's own folder still comes first (PORTLY_DATA_DIR naming Homebase's folder).
    homebaseFolder(portly);
    expect(findLegacyDatabase(portly, { LOCALAPPDATA: local, HOMEBASE_DATA_DIR: moved, PORTLY_DATA_DIR: portly }, 'win32')).toBe(
      path.join(portly, 'homebase.db'),
    );
  });

  it("puts Homebase's vault key in place of Portly's, which is kept beside it", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    fs.writeFileSync(paths.vaultKey, 'portly-key');
    const result = await migrateFromHomebase(paths, {
      env: { LOCALAPPDATA: local },
      platform: 'win32',
      now: () => new Date('2026-10-12T12:00:00Z'),
    });
    const keyAside = `${paths.vaultKey}.before-homebase-2026-10-12T12-00-00-000Z`;
    expect(result).toEqual({ from: path.join(local, 'Homebase'), copied: ['homebase.db -> portly.db', 'vault.key'], replacedKey: keyAside });
    expect(fs.readFileSync(paths.vaultKey, 'utf8'), 'the key of the database copied in').toBe('old-key');
    expect(fs.readFileSync(keyAside, 'utf8')).toBe('portly-key');
  });

  it("moves Portly's vault key aside even when Homebase has none: it does not belong to the copy", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'), { key: null });
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    fs.writeFileSync(paths.vaultKey, 'portly-key');
    const result = await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' });
    expect(result?.copied).toEqual(['homebase.db -> portly.db']);
    expect(fs.existsSync(paths.vaultKey)).toBe(false);
    expect(fs.readFileSync(result?.replacedKey ?? '', 'utf8')).toBe('portly-key');
  });

  it("keeps a vault key that already is Homebase's (an earlier attempt cut off before the end)", async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    fs.writeFileSync(paths.vaultKey, 'old-key');
    const result = await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' });
    expect(result).toEqual({ from: path.join(local, 'Homebase'), copied: ['homebase.db -> portly.db', 'vault.key'] });
    expect(fs.readdirSync(paths.dataDir).filter((name) => name.includes('before-homebase'))).toEqual([]);
  });

  it('puts the database and the key back as they were when the copy cannot be put in place', async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir, { replace: true });
    fs.writeFileSync(paths.db, 'portly data');
    fs.writeFileSync(`${paths.db}-wal`, 'portly wal');
    fs.writeFileSync(paths.vaultKey, 'portly-key');
    // No temporary file appears, so the last step (renaming it to portly.db) fails.
    const err = await failure(paths, { env: { LOCALAPPDATA: local }, platform: 'win32', copyDatabase: () => {} });
    expect(err.code).toBe('homebase_copy_failed');
    expect(err.exitCode).toBe(EXIT_STARTUP_FAILURE);
    expect(fs.readFileSync(paths.db, 'utf8')).toBe('portly data');
    expect(fs.readFileSync(`${paths.db}-wal`, 'utf8')).toBe('portly wal');
    expect(fs.readFileSync(paths.vaultKey, 'utf8'), "Portly's key stays with Portly's database").toBe('portly-key');
    expect(fs.readdirSync(paths.dataDir).sort()).toEqual([COPY_REQUEST, MIGRATION_MARKER, 'portly.db', 'portly.db-wal', 'vault.key'].sort());
    expect(readCopyRequest(paths.dataDir), 'the next start tries again').not.toBeNull();
    expect(marker(paths.dataDir)).toMatchObject({ status: 'failed', code: 'homebase_copy_failed', copied: ['homebase.db -> portly.db'] });
  });

  it('takes a consistent copy while Homebase still has the database open', async () => {
    const local = path.join(root, 'Local');
    const homebase = homebaseFolder(path.join(local, 'Homebase'));
    // A write still in the WAL (not checkpointed) must be in the copy.
    homebase.run("UPDATE settings SET value = '{\"userName\":\"Riley\"}' WHERE namespace = 'general'");
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    expect(await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' })).not.toBeNull();
    expect(userName(paths.db)).toBe('{"userName":"Riley"}');
  });

  it('retries a busy database, then copies', async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    let calls = 0;
    const result = await migrateFromHomebase(paths, {
      env: { LOCALAPPDATA: local },
      platform: 'win32',
      sleep: noSleep,
      copyDatabase: (source, target) => {
        calls += 1;
        if (calls === 1) throw busy();
        fs.copyFileSync(source, target);
      },
    });
    expect(calls).toBe(2);
    expect(result?.copied).toContain('homebase.db -> portly.db');
  });

  it('fails start-up, keeping the request for the next start, when the database stays busy', async () => {
    const local = path.join(root, 'Local');
    homebaseFolder(path.join(local, 'Homebase'));
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    let calls = 0;
    const err = await failure(paths, {
      env: { LOCALAPPDATA: local },
      platform: 'win32',
      sleep: noSleep,
      copyDatabase: () => {
        calls += 1;
        throw busy();
      },
    });
    expect(calls).toBe(COPY_ATTEMPTS);
    expect(err.code).toBe('homebase_copy_busy');
    expect(err.exitCode, 'the supervisor starts it again').toBe(EXIT_STARTUP_FAILURE);
    expect(fs.existsSync(paths.db), 'no empty database hides the missing copy').toBe(false);
    expect(fs.existsSync(paths.vaultKey)).toBe(false);
    expect(readCopyRequest(paths.dataDir)).not.toBeNull();
    expect(marker(paths.dataDir)).toMatchObject({ status: 'failed', code: 'homebase_copy_busy', attempts: COPY_ATTEMPTS });

    // The next start tries again and succeeds.
    expect(await migrateFromHomebase(paths, { env: { LOCALAPPDATA: local }, platform: 'win32' })).not.toBeNull();
    expect(marker(paths.dataDir)).toMatchObject({ status: 'copied' });
  });

  it('fails start-up for good when the database cannot be read, leaving no partial files', async () => {
    const local = path.join(root, 'Local');
    fs.mkdirSync(path.join(local, 'Homebase'), { recursive: true });
    fs.writeFileSync(path.join(local, 'Homebase', 'homebase.db'), 'this is not a database');
    const paths = portlyPaths(path.join(local, 'Portly'));
    requestCopy(paths.dataDir);
    const err = await failure(paths, { env: { LOCALAPPDATA: local }, platform: 'win32', sleep: noSleep });
    expect(err.code).toBe('homebase_copy_failed');
    expect(err.exitCode).toBe(EXIT_PERMANENT_FAILURE);
    expect(err.message).toContain('--cancel');
    expect(fs.existsSync(paths.db)).toBe(false);
    expect(fs.readdirSync(paths.dataDir).filter((name) => name.includes('.from-homebase'))).toEqual([]);
    expect(readCopyRequest(paths.dataDir)).not.toBeNull();
  });

  it('fails start-up for good when asked to copy but no Homebase database exists', async () => {
    const paths = portlyPaths(path.join(root, 'Local', 'Portly'));
    requestCopy(paths.dataDir);
    const err = await failure(paths, { env: { LOCALAPPDATA: path.join(root, 'Local') }, platform: 'win32' });
    expect(err.code).toBe('homebase_not_found');
    expect(err.exitCode).toBe(EXIT_PERMANENT_FAILURE);
    expect(marker(paths.dataDir)).toMatchObject({ status: 'failed', code: 'homebase_not_found' });
  });

  it('reads the request leniently and knows which errors are worth a retry', () => {
    const dir = path.join(root, 'req');
    expect(readCopyRequest(dir)).toBeNull();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, COPY_REQUEST), '\uFEFF{"replace":true}');
    expect(readCopyRequest(dir)).toEqual({ replace: true });
    fs.writeFileSync(path.join(dir, COPY_REQUEST), 'not json');
    expect(readCopyRequest(dir)).toEqual({ replace: false });

    expect(isTransientCopyError(busy())).toBe(true);
    expect(isTransientCopyError(Object.assign(new Error('locked'), { errcode: 6 }))).toBe(true);
    expect(isTransientCopyError(Object.assign(new Error('busy file'), { code: 'EBUSY' }))).toBe(true);
    expect(isTransientCopyError(Object.assign(new Error('not a database'), { errcode: 26 }))).toBe(false);
    expect(isTransientCopyError(null)).toBe(false);
  });
});
