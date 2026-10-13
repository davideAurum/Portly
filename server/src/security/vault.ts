/**
 * Credential vault (§4.6).
 *
 * - Master key: 32 random bytes, protected at rest by a {@link KeyProtector} (DPAPI CurrentUser on
 *   Windows, raw file mode 0600 elsewhere) and stored in `vault.key` as
 *   `{"v":1,"alg":"dpapi-cu","blob":"<base64>"}`, written atomically (temp file + rename).
 * - Secrets: rows of the `secrets` table, AES-256-GCM with a fresh 12-byte IV per encryption,
 *   AAD = `${secretId}|v${keyVersion}`, 16-byte tags only. `PRAGMA secure_delete=ON`.
 * - Startup: (a) no key file and no secrets → create a key and the `canary` secret;
 *   (b) key file missing while secrets exist, or DPAPI/parse/canary-decrypt failure → **never
 *   regenerate automatically**: the unreadable file is renamed to `vault.key.unreadable-<ts>` and
 *   the vault is `locked`. {@link Vault.reset} (`POST /api/vault/reset`) deletes every secret and
 *   creates a new key; a reset that fails part-way leaves the key file and the secrets as they were.
 *   If DPAPI is never reached (PowerShell cannot start, times out or is blocked by policy — see
 *   `DpapiError.transient`), the vault is locked for this run but the key file stays in place for
 *   the next start.
 *
 * Contract:
 * - `state` is `'ready'` or `'locked'`. While locked, `get`/`put` throw {@link VaultLockedError}
 *   (409 `reauth_required`); `delete`/`has`/`list` keep working (they need no key).
 * - Values are strings (JSON for structured secrets). Secret ids: `account:<accountId>`,
 *   `todoist:token`, `oauth-client:<provider>`, `ics:<calendarId>`; `canary` is reserved.
 * - A stored secret that fails authentication (tampered row, wrong AAD) reads as missing (`null`)
 *   and is logged, so callers fall into their "reconnect" path.
 * - Operations are synchronous so they can run inside `db.tx(...)` next to related row changes.
 * - The key never leaves the module; secrets are never returned to the client.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { VaultState } from '@portly/shared';
import type { ConfigPaths } from '../config.ts';
import type { Db } from '../db/open.ts';
import { fileTimestamp } from '../lib/backups.ts';
import { HttpError } from '../lib/errors.ts';
import { errorFields, type Logger } from '../lib/logger.ts';
import { DpapiError, defaultKeyProtector, type KeyProtector } from './dpapi.ts';

export type { VaultState };

export interface Vault {
  readonly state: VaultState;
  get(id: string): string | null;
  put(id: string, value: string): void;
  delete(id: string): void;
  has(id: string): boolean;
  /** Ids starting with `prefix` (e.g. `'account:'`), sorted; the internal canary is never listed. */
  list(prefix?: string): string[];
  /** `POST /api/vault/reset`: deletes every secret and creates a fresh key → `ready`. */
  reset(): Promise<void>;
}

export class VaultLockedError extends HttpError {
  override name = 'VaultLockedError';
  constructor() {
    super(409, 'reauth_required', 'The credential vault is locked; reset credentials in Settings');
  }
}

export const SECRET_ID_REGEX = /^[a-z][a-z-]*:[A-Za-z0-9._:@-]{0,200}$|^canary$/;

export function assertSecretId(id: string): void {
  if (!SECRET_ID_REGEX.test(id)) throw new TypeError(`Invalid secret id "${id}"`);
}

export const CANARY_ID = 'canary';
/** Key version bound into every secret's AAD (bumped only by a future key-rotation scheme). */
export const KEY_VERSION = 1;
export const SECRET_ALG = 'aes-256-gcm';
export const KEY_FILE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Named before the app was renamed Portly; kept, since every existing vault holds it encrypted.
const CANARY_VALUE = 'homebase-vault-canary-v1';
const MAX_KEY_FILE_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export interface SecretRecord {
  id: string;
  keyVersion: number;
  alg: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  updatedAt: number;
}

function aad(id: string, keyVersion: number): Buffer {
  return Buffer.from(`${id}|v${keyVersion}`, 'utf8');
}

export function encryptSecret(key: Buffer, id: string, value: string, now: number): SecretRecord {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(id, KEY_VERSION));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { id, keyVersion: KEY_VERSION, alg: SECRET_ALG, iv, tag: cipher.getAuthTag(), ciphertext, updatedAt: now };
}

/** Decrypts a record; throws on any mismatch (algorithm, version, IV/tag length, authentication). */
export function decryptSecret(key: Buffer, record: SecretRecord): string {
  if (record.alg !== SECRET_ALG) throw new Error(`unsupported secret algorithm "${record.alg}"`);
  if (record.keyVersion !== KEY_VERSION) throw new Error(`unsupported key version ${record.keyVersion}`);
  if (record.iv.length !== IV_BYTES) throw new Error('invalid IV length');
  if (record.tag.length !== TAG_BYTES) throw new Error('invalid authentication tag length');
  const decipher = createDecipheriv(SECRET_ALG, key, record.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(record.id, record.keyVersion));
  decipher.setAuthTag(record.tag);
  return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8');
}

function canDecrypt(key: Buffer, record: SecretRecord): boolean {
  try {
    decryptSecret(key, record);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Secret stores (SQLite `secrets` table, or memory for tests)
// ---------------------------------------------------------------------------

export interface SecretStore {
  get(id: string): SecretRecord | undefined;
  has(id: string): boolean;
  put(record: SecretRecord): void;
  delete(id: string): void;
  /** All ids, sorted. */
  ids(): string[];
  count(): number;
  /** Every record except `exceptId`, most recently updated first. */
  others(exceptId: string): SecretRecord[];
  /** Atomically deletes every secret and stores `records`. */
  replaceAll(records: SecretRecord[]): void;
}

interface SecretRow {
  id: string;
  key_version: number;
  alg: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
  updated_at: number;
}

function fromRow(row: SecretRow): SecretRecord {
  return {
    id: row.id,
    keyVersion: Number(row.key_version),
    alg: row.alg,
    iv: Buffer.from(row.iv),
    tag: Buffer.from(row.tag),
    ciphertext: Buffer.from(row.ciphertext),
    updatedAt: Number(row.updated_at),
  };
}

export function createSqliteSecretStore(db: Db): SecretStore {
  const insert = (r: SecretRecord): void => {
    db.run(
      `INSERT INTO secrets (id, key_version, alg, iv, tag, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key_version = excluded.key_version, alg = excluded.alg, iv = excluded.iv,
         tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      [r.id, r.keyVersion, r.alg, r.iv, r.tag, r.ciphertext, r.updatedAt],
    );
  };
  return {
    get(id) {
      const row = db.get<SecretRow>('SELECT id, key_version, alg, iv, tag, ciphertext, updated_at FROM secrets WHERE id = ?', [id]);
      return row ? fromRow(row) : undefined;
    },
    has(id) {
      return db.get('SELECT 1 AS present FROM secrets WHERE id = ?', [id]) !== undefined;
    },
    put: insert,
    delete(id) {
      db.run('DELETE FROM secrets WHERE id = ?', [id]);
    },
    ids() {
      return db.all<{ id: string }>('SELECT id FROM secrets ORDER BY id').map((r) => r.id);
    },
    count() {
      return Number(db.get<{ n: number }>('SELECT count(*) AS n FROM secrets')?.n ?? 0);
    },
    others(exceptId) {
      return db
        .all<SecretRow>('SELECT id, key_version, alg, iv, tag, ciphertext, updated_at FROM secrets WHERE id <> ? ORDER BY updated_at DESC, id', [
          exceptId,
        ])
        .map(fromRow);
    },
    replaceAll(records) {
      db.tx(() => {
        db.run('DELETE FROM secrets');
        for (const r of records) insert(r);
      });
    },
  };
}

function createMemorySecretStore(): SecretStore {
  const rows = new Map<string, SecretRecord>();
  return {
    get: (id) => rows.get(id),
    has: (id) => rows.has(id),
    put: (record) => void rows.set(record.id, record),
    delete: (id) => void rows.delete(id),
    ids: () => [...rows.keys()].sort(),
    count: () => rows.size,
    others(exceptId) {
      return [...rows.values()].filter((r) => r.id !== exceptId).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    replaceAll(records) {
      rows.clear();
      for (const r of records) rows.set(r.id, r);
    },
  };
}

// ---------------------------------------------------------------------------
// Vault engine (shared by the persistent and the memory vault)
// ---------------------------------------------------------------------------

interface VaultEngine {
  vault: Vault;
  unlock(key: Buffer): void;
  lock(): void;
}

/** A fresh key that is protected and staged, but not yet the vault's key on disk. */
interface PreparedKey {
  key: Buffer;
  /** Makes the key durable (renames the staged key file over `vault.key`). */
  install(): void;
  /** Drops a staged key that will not be used. */
  discard(): void;
}

interface EngineOptions {
  store: SecretStore;
  log: Logger;
  now: () => number;
  /** Creates and stages a fresh key for `reset()`. */
  newKey: () => Promise<PreparedKey>;
}

function assertValue(value: string): void {
  if (typeof value !== 'string') throw new TypeError('Vault values must be strings');
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) throw new TypeError('Vault value is too large');
}

function assertNotReserved(id: string): void {
  if (id === CANARY_ID) throw new TypeError(`Secret id "${CANARY_ID}" is reserved`);
}

function createVaultEngine(options: EngineOptions): VaultEngine {
  const { store, log, now } = options;
  let key: Buffer | null = null;
  let resetQueue: Promise<void> = Promise.resolve();

  const requireKey = (): Buffer => {
    if (!key) throw new VaultLockedError();
    return key;
  };

  const vault: Vault = {
    get state(): VaultState {
      return key ? 'ready' : 'locked';
    },
    get(id) {
      assertSecretId(id);
      const k = requireKey();
      const record = store.get(id);
      if (!record) return null;
      try {
        return decryptSecret(k, record);
      } catch (err) {
        log.error('vault: stored secret failed authentication; treating it as missing', { secretId: id, ...errorFields(err) });
        return null;
      }
    },
    put(id, value) {
      assertSecretId(id);
      assertNotReserved(id);
      assertValue(value);
      store.put(encryptSecret(requireKey(), id, value, now()));
    },
    delete(id) {
      assertSecretId(id);
      assertNotReserved(id);
      store.delete(id);
    },
    has(id) {
      assertSecretId(id);
      return store.has(id);
    },
    list(prefix = '') {
      return store.ids().filter((id) => id !== CANARY_ID && id.startsWith(prefix));
    },
    reset() {
      // Resets run one after another; each produces a complete, consistent key + table. The new
      // key is staged first and installed only after the secrets were replaced, so a failure
      // before that point changes nothing (neither the key file nor the stored secrets).
      const run = async (): Promise<void> => {
        const prepared = await options.newKey();
        try {
          store.replaceAll([encryptSecret(prepared.key, CANARY_ID, CANARY_VALUE, now())]);
        } catch (err) {
          prepared.discard();
          throw err;
        }
        try {
          prepared.install();
        } catch (err) {
          // The table now needs a key that could not be stored: lock rather than write secrets
          // nobody can read after a restart (the next start quarantines the old key file).
          key = null;
          log.error('vault: the new key could not be stored; vault locked — reset credentials again', errorFields(err));
          throw err;
        }
        key = prepared.key;
        log.warn('vault: credentials reset; all secrets deleted and a new key created');
      };
      const next = resetQueue.then(run);
      resetQueue = next.catch(() => {});
      return next;
    },
  };

  return {
    vault,
    unlock(k) {
      key = k;
    },
    lock() {
      key = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Key file
// ---------------------------------------------------------------------------

const KeyFileSchema = z
  .object({
    v: z.literal(KEY_FILE_VERSION),
    alg: z.enum(['dpapi-cu', 'raw']),
    blob: z.base64().min(1).max(MAX_KEY_FILE_BYTES),
  })
  .strict();

type KeyFileRead = { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'ok'; alg: string; blob: Buffer };

function readKeyFile(file: string): KeyFileRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: `stat failed (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  if (!stat.isFile()) return { kind: 'unreadable', reason: 'not a regular file' };
  if (stat.size > MAX_KEY_FILE_BYTES) return { kind: 'unreadable', reason: 'file too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { kind: 'unreadable', reason: 'not valid JSON' };
  }
  const result = KeyFileSchema.safeParse(parsed);
  if (!result.success) return { kind: 'unreadable', reason: 'unexpected key file format' };
  return { kind: 'ok', alg: result.data.alg, blob: Buffer.from(result.data.blob, 'base64') };
}

/** Writes the key file body to an exclusive temp file next to `file` (fsynced); returns its path. */
function stageKeyFile(file: string, alg: string, blob: Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const body = JSON.stringify({ v: KEY_FILE_VERSION, alg, blob: blob.toString('base64') });
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return tmp;
}

/** Atomically replaces `file` with the staged temp file (rename). */
function installKeyFile(tmp: string, file: string): void {
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

/** Removes key files staged by a run that crashed before installing them (never `vault.key` itself). */
function removeStaleStagedKeys(file: string, log: Logger): void {
  const prefix = `${path.basename(file)}.tmp-`;
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(file));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(path.dirname(file), name), { force: true });
      log.warn('vault: removed a key file left over from an interrupted write', { file: name });
    } catch (err) {
      log.warn('vault: could not remove a leftover key file', { file: name, ...errorFields(err) });
    }
  }
}

/** Moves an unreadable key file aside (`vault.key.unreadable-<ts>`); never deletes it. */
function quarantineKeyFile(file: string, now: number, log: Logger): void {
  if (!fs.existsSync(file)) return;
  const base = `${file}.unreadable-${fileTimestamp(new Date(now))}`;
  let target = base;
  for (let i = 1; fs.existsSync(target); i++) target = `${base}-${i}`;
  try {
    fs.renameSync(file, target);
    log.warn('vault: unreadable key file moved aside', { file: path.basename(target) });
  } catch (err) {
    log.error('vault: could not move the unreadable key file aside', { ...errorFields(err) });
  }
}

// ---------------------------------------------------------------------------
// openVault (runtime) and createMemoryVault (tests)
// ---------------------------------------------------------------------------

export interface MemoryVault extends Vault {
  /** Test helper: switch between ready and locked. */
  setState(state: VaultState): void;
}

export interface OpenVaultOptions {
  config: { paths: Pick<ConfigPaths, 'vaultKey'> };
  db: Db;
  log: Logger;
  /** Key protection (default: DPAPI on Windows, raw elsewhere). Tests pass a fake. */
  protector?: KeyProtector;
  now?: () => number;
}

/**
 * Opens the runtime vault (bootstrap step after migrations; §6). Never throws for key problems —
 * those leave the vault `locked` (see module docs).
 */
export async function openVault(options: OpenVaultOptions): Promise<Vault> {
  const { db } = options;
  const log = options.log;
  const now = options.now ?? Date.now;
  const keyFile = options.config.paths.vaultKey;
  const protector = options.protector ?? defaultKeyProtector();

  db.exec('PRAGMA secure_delete = ON');
  const store = createSqliteSecretStore(db);
  // Only one instance runs per data dir (index.ts exits early when the port is taken).
  removeStaleStagedKeys(keyFile, log);

  const prepareKey = async (): Promise<PreparedKey> => {
    const key = randomBytes(KEY_BYTES);
    const blob = await protector.protect(key);
    const tmp = stageKeyFile(keyFile, protector.alg, blob);
    return {
      key,
      install: () => installKeyFile(tmp, keyFile),
      discard: () => fs.rmSync(tmp, { force: true }),
    };
  };
  const engine = createVaultEngine({ store, log, now, newKey: prepareKey });
  const lockedWithQuarantine = (reason: string, fields: Record<string, unknown> = {}): Vault => {
    log.error('vault: key is unreadable; vault locked — reset credentials in Settings', { reason, ...fields });
    quarantineKeyFile(keyFile, now(), log);
    engine.lock();
    return engine.vault;
  };

  const secretCount = store.count();
  const file = readKeyFile(keyFile);

  if (file.kind === 'missing') {
    if (secretCount > 0) {
      log.error('vault: key file is missing but encrypted secrets exist; vault locked — reset credentials in Settings', {
        secrets: secretCount,
      });
      return engine.vault;
    }
    try {
      // Key file first: a crash before the canary is written leaves a key and no secrets, which
      // the next start simply reuses.
      const prepared = await prepareKey();
      prepared.install();
      const key = prepared.key;
      store.put(encryptSecret(key, CANARY_ID, CANARY_VALUE, now()));
      engine.unlock(key);
      log.info('vault: new key created', { alg: protector.alg });
    } catch (err) {
      log.error('vault: could not create a key; vault locked', errorFields(err));
    }
    return engine.vault;
  }

  if (file.kind === 'unreadable') return lockedWithQuarantine(file.reason);
  if (file.alg !== protector.alg) return lockedWithQuarantine(`key protected with "${file.alg}", expected "${protector.alg}"`);

  let key: Buffer;
  try {
    key = await protector.unprotect(file.blob);
  } catch (err) {
    if (err instanceof DpapiError && err.transient) {
      // PowerShell never ran or hung: the file is not known to be bad, so keep it for the next start.
      log.error('vault: DPAPI is unavailable; vault locked for this run (key file kept)', errorFields(err));
      return engine.vault;
    }
    return lockedWithQuarantine('key could not be unprotected', errorFields(err));
  }
  if (key.length !== KEY_BYTES) return lockedWithQuarantine('unexpected key length');

  if (process.platform !== 'win32') {
    try {
      if ((fs.statSync(keyFile).mode & 0o077) !== 0) log.warn('vault: key file is readable by other users; expected mode 0600');
    } catch {
      // ignore
    }
  }

  // Verify the key with the canary; if the canary row is gone, any stored secret that decrypts
  // proves the key (and the canary is recreated).
  const canary = store.get(CANARY_ID);
  if (canary) {
    let value: string | null = null;
    try {
      value = decryptSecret(key, canary);
    } catch (err) {
      return lockedWithQuarantine('the key does not decrypt the canary', errorFields(err));
    }
    if (value !== CANARY_VALUE) return lockedWithQuarantine('canary mismatch');
  } else {
    const others = store.others(CANARY_ID);
    if (others.length > 0 && !others.some((record) => canDecrypt(key, record))) {
      return lockedWithQuarantine('the key does not decrypt any stored secret');
    }
    store.put(encryptSecret(key, CANARY_ID, CANARY_VALUE, now()));
  }

  engine.unlock(key);
  log.info('vault: ready');
  return engine.vault;
}

/** Fixed key of the in-memory test vault (never used for real data). */
const TEST_VAULT_KEY = createHash('sha256').update('portly test vault key').digest();

/**
 * In-memory vault for tests: the same AES-256-GCM engine over a Map, keyed with a fixed test key
 * (no DPAPI, nothing persisted). `setState('locked')` simulates a locked vault.
 */
export function createMemoryVault(initial: Record<string, string> = {}, state: VaultState = 'ready'): MemoryVault {
  const store = createMemorySecretStore();
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  const engine = createVaultEngine({
    store,
    log,
    now: Date.now,
    newKey: async () => ({ key: TEST_VAULT_KEY, install: () => {}, discard: () => {} }),
  });
  engine.unlock(TEST_VAULT_KEY);
  store.put(encryptSecret(TEST_VAULT_KEY, CANARY_ID, CANARY_VALUE, Date.now()));
  for (const [id, value] of Object.entries(initial)) engine.vault.put(id, value);
  if (state === 'locked') engine.lock();

  const vault = engine.vault;
  return {
    get state() {
      return vault.state;
    },
    get: vault.get,
    put: vault.put,
    delete: vault.delete,
    has: vault.has,
    list: vault.list,
    reset: vault.reset,
    setState(next) {
      if (next === 'ready') engine.unlock(TEST_VAULT_KEY);
      else engine.lock();
    },
  };
}
