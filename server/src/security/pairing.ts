/**
 * Pairing store (hybrid mode, shared/src/pairing.ts): the browsers allowed to use this server from
 * the configured Pages site, and the server's instance id.
 *
 * - A pairing is created on Homebase's own page (`POST /api/pairings`). Its token (32 random bytes,
 *   base64url) is handed to the browser once; only its SHA-256 (hex) is stored, with the Pages
 *   origin it was made for. A token stops working when that origin is no longer the configured one.
 * - `verify(token)` checks the format first, then answers from an in-memory map of hashes that is
 *   rebuilt from the database after every create/revoke/purge.
 * - `touch(id)` records use at most once per {@link TOUCH_INTERVAL_MS}; at most {@link MAX_PAIRINGS}
 *   pairings exist (creating one more removes the least recently used), and pairings never used
 *   within {@link UNUSED_PAIRING_TTL_MS} of their creation are purged on create/list.
 * - `instanceId()` is random (16 bytes, base64url), created once and kept in `server_meta`. It tells
 *   the Pages site which server it paired with; it is a mismatch guard, not a secret.
 * - Tombstones (§17): every removed pairing leaves `{pairingId, removedAt, removedBy}`
 *   under its token hash — the last {@link MAX_TOMBSTONES} in memory, the last
 *   {@link PERSISTED_TOMBSTONES} also in `server_meta` (`pairing.tombstones`) — so `explain(token)`
 *   lets the gate tell a token removed on this PC (revoked, unpaired itself, evicted, never used)
 *   from one this server never issued. Tombstones hold hashes of dead tokens only.
 */
import { createHash } from 'node:crypto';
import { InstanceIdSchema, MAX_PAIRINGS, PairingTokenSchema } from '@homebase/shared';
import { asNullableString, asNumber, asString } from '../db/helpers.ts';
import type { Db } from '../db/open.ts';
import { newId, newToken } from '../lib/ids.ts';
import { errorFields, type Logger } from '../lib/logger.ts';

/** Last-use timestamps are written at most this often per pairing. */
export const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
/** A pairing nobody used within this long after its creation is removed. */
export const UNUSED_PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest label stored (the API contract allows 200 characters). */
export const MAX_PAIRING_LABEL = 200;

const INSTANCE_ID_KEY = 'instance_id';
const TOMBSTONES_KEY = 'pairing.tombstones';
/** Tombstones kept in memory / persisted in `server_meta`. */
export const MAX_TOMBSTONES = 50;
export const PERSISTED_TOMBSTONES = 20;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** Why a pairing was removed: on Homebase's side, by the browser itself, to make room, or never used. */
export type PairingRemoval = 'revoked' | 'unpaired-itself' | 'evicted' | 'unused';
const REMOVALS: ReadonlySet<string> = new Set<PairingRemoval>(['revoked', 'unpaired-itself', 'evicted', 'unused']);

/** What a presented token is (`explain`): the gate logs why a Pages request was refused. */
export type TokenCheck =
  | { status: 'ok'; record: PairingRecord }
  | { status: 'malformed' }
  | { status: 'unknown' }
  | { status: 'removed'; pairingId: string; removedBy: PairingRemoval; removedAt: number };

export interface PairingRecord {
  id: string;
  label: string;
  /** The Pages origin the pairing was made for (the configured one at the time). */
  origin: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last recorded use (see {@link TOUCH_INTERVAL_MS}), or null. */
  lastUsedAt: number | null;
}

export interface PairingStore {
  /** This installation's id (created on first use). */
  instanceId(): string;
  /** A new pairing and its token (the only time the token exists in clear). */
  create(input: { label: string; origin: string }): { token: string; record: PairingRecord };
  /** The pairing a token belongs to, or null (malformed, unknown or revoked). */
  verify(token: string): PairingRecord | null;
  /** Like {@link verify}, but says why a token is not valid: malformed, never issued, or removed (and how). */
  explain(token: string): TokenCheck;
  /** Records a use of the pairing (written at most once per {@link TOUCH_INTERVAL_MS}). */
  touch(id: string): void;
  /** Every pairing, newest first. */
  list(): PairingRecord[];
  /** Removes a pairing (`removedBy` default `revoked`); false when there was none with that id. */
  revoke(id: string, removedBy?: PairingRemoval): boolean;
  /** Removes the pairing of a token (`removedBy` default `unpaired-itself`); false when the token matches none. */
  revokeByToken(token: string, removedBy?: PairingRemoval): boolean;
}

export interface PairingStoreOptions {
  db: Db;
  log?: Logger;
  now?: () => number;
}

interface Loaded {
  byHash: Map<string, PairingRecord>;
  byId: Map<string, PairingRecord>;
}

interface Tombstone {
  pairingId: string;
  removedAt: number;
  removedBy: PairingRemoval;
}

/** A deleted pairing row (`DELETE … RETURNING id, token_hash`). */
interface RemovedRow {
  id: string;
  hash: string;
}

function removedRows(rows: Record<string, unknown>[]): RemovedRow[] {
  return rows.map((row) => ({ id: asString(row.id), hash: asString(row.token_hash) }));
}

/** Persisted tombstones (`[{hash, pairingId, removedAt, removedBy}]`, oldest first); invalid entries are skipped. */
function parseTombstones(text: string | null): [string, Tombstone][] {
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: [string, Tombstone][] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const { hash, pairingId, removedAt, removedBy } = item as Record<string, unknown>;
    if (typeof hash !== 'string' || !TOKEN_HASH.test(hash)) continue;
    if (typeof pairingId !== 'string' || pairingId === '' || pairingId.length > 64) continue;
    if (typeof removedAt !== 'number' || !Number.isFinite(removedAt)) continue;
    if (typeof removedBy !== 'string' || !REMOVALS.has(removedBy)) continue;
    out.push([hash, { pairingId, removedAt, removedBy: removedBy as PairingRemoval }]);
  }
  return out.slice(-MAX_TOMBSTONES);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toRecord(row: Record<string, unknown>): PairingRecord {
  const lastUsed = row.last_used_at;
  return {
    id: asString(row.id),
    label: asString(row.label),
    origin: asString(row.origin),
    createdAt: asNumber(row.created_at),
    lastUsedAt: lastUsed === null || lastUsed === undefined ? null : asNumber(lastUsed),
  };
}

export function createPairingStore(options: PairingStoreOptions): PairingStore {
  const { db, log } = options;
  const now = options.now ?? Date.now;
  let loaded: Loaded | null = null;
  let instance: string | null = null;
  // Insertion order is removal order (oldest first).
  let tombstones: Map<string, Tombstone> | null = null;

  const load = (): Loaded => {
    if (loaded) return loaded;
    const byHash = new Map<string, PairingRecord>();
    const byId = new Map<string, PairingRecord>();
    for (const row of db.all('SELECT id, token_hash, label, origin, created_at, last_used_at FROM pairings')) {
      const record = toRecord(row);
      byHash.set(asString(row.token_hash), record);
      byId.set(record.id, record);
    }
    loaded = { byHash, byId };
    return loaded;
  };

  const invalidate = (): void => {
    loaded = null;
  };

  const loadTombstones = (): Map<string, Tombstone> => {
    if (tombstones) return tombstones;
    let stored: string | null = null;
    try {
      stored = asNullableString(db.get('SELECT value FROM server_meta WHERE key = ?', [TOMBSTONES_KEY])?.value);
    } catch {
      stored = null;
    }
    tombstones = new Map(parseTombstones(stored));
    return tombstones;
  };

  /** Records removed pairings: in memory, and the newest {@link PERSISTED_TOMBSTONES} in `server_meta`. */
  const bury = (rows: readonly RemovedRow[], removedBy: PairingRemoval): void => {
    if (rows.length === 0) return;
    const map = loadTombstones();
    const at = now();
    for (const row of rows) {
      map.delete(row.hash);
      map.set(row.hash, { pairingId: row.id, removedAt: at, removedBy });
    }
    while (map.size > MAX_TOMBSTONES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    const persisted = [...map].slice(-PERSISTED_TOMBSTONES).map(([hash, t]) => ({ hash, ...t }));
    try {
      db.run('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
        TOMBSTONES_KEY,
        JSON.stringify(persisted),
      ]);
    } catch (err) {
      // Diagnostics only: the pairing is gone either way.
      log?.warn('could not save removed pairings', errorFields(err));
    }
  };

  const purgeUnused = (): void => {
    const removed = removedRows(
      db.all('DELETE FROM pairings WHERE last_used_at IS NULL AND created_at < ? RETURNING id, token_hash', [now() - UNUSED_PAIRING_TTL_MS]),
    );
    if (removed.length > 0) {
      invalidate();
      bury(removed, 'unused');
      log?.info('unused pairings removed', { count: removed.length, pairingIds: removed.map((r) => r.id) });
    }
  };

  return {
    instanceId() {
      if (instance !== null) return instance;
      const stored = asNullableString(db.get('SELECT value FROM server_meta WHERE key = ?', [INSTANCE_ID_KEY])?.value);
      if (stored !== null && InstanceIdSchema.safeParse(stored).success) {
        instance = stored;
      } else {
        instance = newToken(16);
        db.run('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
          INSTANCE_ID_KEY,
          instance,
        ]);
        // A replaced id makes every paired browser see another server (they ask to pair again).
        log?.info('instance id created', { replacedInvalid: stored !== null });
      }
      return instance;
    },

    create(input) {
      const token = newToken(32);
      const record: PairingRecord = {
        id: newId(),
        label: input.label.slice(0, MAX_PAIRING_LABEL),
        origin: input.origin,
        createdAt: now(),
        lastUsedAt: null,
      };
      db.tx(() => {
        purgeUnused();
        const count = asNumber(db.get('SELECT COUNT(*) AS n FROM pairings')?.n);
        const excess = count - MAX_PAIRINGS + 1;
        if (excess > 0) {
          const evicted = removedRows(
            db.all(
              `DELETE FROM pairings WHERE id IN (
                 SELECT id FROM pairings ORDER BY COALESCE(last_used_at, created_at), rowid LIMIT ?
               ) RETURNING id, token_hash`,
              [excess],
            ),
          );
          bury(evicted, 'evicted');
          log?.info('least recently used pairings removed to make room', { count: evicted.length, pairingIds: evicted.map((r) => r.id) });
        }
        db.run('INSERT INTO pairings (id, token_hash, label, origin, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)', [
          record.id,
          hashToken(token),
          record.label,
          record.origin,
          record.createdAt,
        ]);
      });
      invalidate();
      return { token, record: { ...record } };
    },

    verify(token) {
      if (!PairingTokenSchema.safeParse(token).success) return null;
      const record = load().byHash.get(hashToken(token));
      return record ? { ...record } : null;
    },

    explain(token) {
      if (!PairingTokenSchema.safeParse(token).success) return { status: 'malformed' };
      const hash = hashToken(token);
      const record = load().byHash.get(hash);
      if (record) return { status: 'ok', record: { ...record } };
      const tombstone = loadTombstones().get(hash);
      return tombstone ? { status: 'removed', ...tombstone } : { status: 'unknown' };
    },

    touch(id) {
      const record = load().byId.get(id);
      if (!record) return;
      const at = now();
      if (record.lastUsedAt !== null && at - record.lastUsedAt < TOUCH_INTERVAL_MS) return;
      db.run('UPDATE pairings SET last_used_at = ? WHERE id = ?', [at, id]);
      record.lastUsedAt = at;
    },

    list() {
      purgeUnused();
      return db
        .all('SELECT id, label, origin, created_at, last_used_at FROM pairings ORDER BY created_at DESC, rowid DESC')
        .map(toRecord);
    },

    revoke(id, removedBy = 'revoked') {
      const removed = removedRows(db.all('DELETE FROM pairings WHERE id = ? RETURNING id, token_hash', [id]));
      if (removed.length === 0) return false;
      invalidate();
      bury(removed, removedBy);
      return true;
    },

    revokeByToken(token, removedBy = 'unpaired-itself') {
      if (!PairingTokenSchema.safeParse(token).success) return false;
      const removed = removedRows(db.all('DELETE FROM pairings WHERE token_hash = ? RETURNING id, token_hash', [hashToken(token)]));
      if (removed.length === 0) return false;
      invalidate();
      bury(removed, removedBy);
      return true;
    },
  };
}
