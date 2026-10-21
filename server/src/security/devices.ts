/**
 * Device store (other PCs, shared/src/devices.ts): the PCs allowed to use this server through the
 * configured HTTPS reverse proxy (`PORTLY_REMOTE_ORIGIN`), and the requests waiting to be approved.
 *
 * - A request is made by the other PC (`createRequest`): it gets a display code and an enrollment
 *   secret (32 random bytes, base64url, handed out once as a cookie); only its SHA-256 (hex) is
 *   stored. At most {@link MAX_PENDING_DEVICE_REQUESTS} wait at once, each for
 *   {@link DEVICE_REQUEST_TTL_MS}.
 * - The main PC approves or denies it (`approve`, `deny`). The device itself is made when the other
 *   PC next polls with its enrollment secret (`claim`): a new device secret is minted then, so no
 *   secret is ever stored in clear, and the request row is marked `claimed` with the device's id.
 *   While that device has never been used (the answer carrying its cookie may have been lost), the
 *   same enrollment secret claims again and gets a fresh device secret for the same device. At most
 *   {@link MAX_DEVICES} devices exist; one more removes the least recently used.
 * - `verify(secret)` checks the format first, then answers from an in-memory map of hashes that is
 *   rebuilt after every write. A device not used within {@link DEVICE_IDLE_TTL_MS} is expired on
 *   the spot (its row stays, marked `expired`). `explain(secret)` tells the gate why a cookie is
 *   refused: malformed, never issued, or revoked/expired/evicted/disconnected (and when).
 * - `touch(id)` records use at most once per {@link TOUCH_INTERVAL_MS} and says whether it did
 *   (the gate renews the cookie then). Every write and listing first expires the devices idle for
 *   longer than {@link DEVICE_IDLE_TTL_MS} (so the list and the device cap never count them) and
 *   purges revoked rows older than {@link REVOKED_RETENTION_MS} and requests expired for more than
 *   {@link REQUEST_RETENTION_MS}.
 *
 * Logs (§17) carry device and request ids only: never a label, a code or a secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  DEVICE_CODE_ALPHABET,
  DEVICE_IDLE_TTL_MS,
  DEVICE_LABEL_MAX,
  DEVICE_REQUEST_TTL_MS,
  DeviceSecretSchema,
  MAX_DEVICES,
  MAX_PENDING_DEVICE_REQUESTS,
} from '@portly/shared';
import { asNullableString, asNumber, asString } from '../db/helpers.ts';
import type { Db } from '../db/open.ts';
import { newId, newToken } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';

/** Last-use timestamps are written (and the cookie renewed) at most this often per device. */
export const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
/** A revoked device's row is kept this long (so its cookie is refused as revoked, not unknown). */
export const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** An expired request's row is kept this long (so the other PC's next poll can say "expired"). */
export const REQUEST_RETENTION_MS = 60 * 60 * 1000;
/** Longest browser summary stored. */
export const MAX_BROWSER_SUMMARY = 200;

/** Why a device stopped working. */
export type DeviceRemoval = 'revoked' | 'expired' | 'evicted' | 'disconnected';
const REMOVALS: ReadonlySet<string> = new Set<DeviceRemoval>(['revoked', 'expired', 'evicted', 'disconnected']);

export interface DeviceRecord {
  id: string;
  label: string;
  browser: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last recorded use (see {@link TOUCH_INTERVAL_MS}), or null. */
  lastUsedAt: number | null;
  /** Set once the device no longer works. */
  revokedAt: number | null;
  revokedBy: DeviceRemoval | null;
}

/** A request's state: waiting, decided on the main PC, or already turned into a device (`claimed`). */
export type DeviceRequestState = 'pending' | 'approved' | 'denied' | 'claimed';

export interface DeviceRequestRecord {
  id: string;
  code: string;
  label: string;
  browser: string;
  createdAt: number;
  expiresAt: number;
  status: DeviceRequestState;
}

/** What a presented device secret is (`explain`): the gate logs why a remote request was refused. */
export type DeviceCheck =
  | { status: 'ok'; record: DeviceRecord }
  | { status: 'malformed' }
  | { status: 'unknown' }
  | { status: 'removed'; deviceId: string; removedBy: DeviceRemoval; removedAt: number };

export interface DeviceStore {
  /**
   * A new pending request and its enrollment secret (the only time it exists in clear), or null
   * when {@link MAX_PENDING_DEVICE_REQUESTS} are already waiting.
   */
  createRequest(input: { label: string; browser: string }): { secret: string; record: DeviceRequestRecord } | null;
  /** The request an enrollment secret belongs to, whatever its status, or null (expired ones included while retained). */
  requestBySecret(secret: string): DeviceRequestRecord | null;
  /** True when the request has passed its expiry time. */
  isExpired(request: DeviceRequestRecord): boolean;
  /** Requests still waiting for approval, oldest first. */
  listRequests(): DeviceRequestRecord[];
  /** Approves a pending, unexpired request; null when there is none with that id in that state. */
  approve(id: string): DeviceRequestRecord | null;
  /** Denies a pending request; false when there is none with that id in that state. */
  deny(id: string): boolean;
  /**
   * Turns an approved, unexpired request into a device: a new device secret (handed out once) and
   * its record; the request is marked claimed. A claimed request whose device was never used
   * claims again with a fresh secret for the same device. Null when the secret matches no such request.
   */
  claim(secret: string): { secret: string; record: DeviceRecord } | null;
  /** The working device a secret belongs to, or null (malformed, unknown, revoked or idle too long). */
  verify(secret: string): DeviceRecord | null;
  /** Like {@link verify}, but says why a secret is not valid. */
  explain(secret: string): DeviceCheck;
  /** Records a use of the device; true when it wrote (at most once per {@link TOUCH_INTERVAL_MS}). */
  touch(id: string): boolean;
  /** Every working device, newest first. */
  list(): DeviceRecord[];
  /** Stops a device (`removedBy` default `revoked`); false when there is no working device with that id. */
  revoke(id: string, removedBy?: DeviceRemoval): boolean;
  /** Stops the device of a secret (`removedBy` default `disconnected`); false when it matches no working device. */
  revokeBySecret(secret: string, removedBy?: DeviceRemoval): boolean;
}

export interface DeviceStoreOptions {
  db: Db;
  log?: Logger;
  now?: () => number;
}

interface Loaded {
  /** Every device row, working or not, by secret hash. */
  byHash: Map<string, DeviceRecord>;
  byId: Map<string, DeviceRecord>;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Largest multiple of the alphabet size below 256: bytes at or above it are skipped (no bias). */
const CODE_UNBIASED_LIMIT = 256 - (256 % DEVICE_CODE_ALPHABET.length);

/** A display code like `K7Q-4MP`. */
export function newDeviceCode(): string {
  let out = '';
  while (out.length < 6) {
    for (const byte of randomBytes(12)) {
      if (byte >= CODE_UNBIASED_LIMIT) continue;
      out += DEVICE_CODE_ALPHABET[byte % DEVICE_CODE_ALPHABET.length];
      if (out.length === 6) break;
    }
  }
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

function toDevice(row: Record<string, unknown>): DeviceRecord {
  const lastUsed = row.last_used_at;
  const revokedAt = row.revoked_at;
  const revokedBy = asNullableString(row.revoked_by);
  return {
    id: asString(row.id),
    label: asString(row.label),
    browser: asString(row.browser),
    createdAt: asNumber(row.created_at),
    lastUsedAt: lastUsed === null || lastUsed === undefined ? null : asNumber(lastUsed),
    revokedAt: revokedAt === null || revokedAt === undefined ? null : asNumber(revokedAt),
    revokedBy: revokedBy !== null && REMOVALS.has(revokedBy) ? (revokedBy as DeviceRemoval) : null,
  };
}

function toRequest(row: Record<string, unknown>): DeviceRequestRecord {
  const status = asString(row.status);
  return {
    id: asString(row.id),
    code: asString(row.code),
    label: asString(row.label),
    browser: asString(row.browser),
    createdAt: asNumber(row.created_at),
    expiresAt: asNumber(row.expires_at),
    status: status === 'approved' || status === 'denied' || status === 'claimed' ? status : 'pending',
  };
}

const DEVICE_COLUMNS = 'id, label, secret_hash, browser, created_at, last_used_at, revoked_at, revoked_by';
const REQUEST_COLUMNS = 'id, code, label, browser, created_at, expires_at, status';

export function createDeviceStore(options: DeviceStoreOptions): DeviceStore {
  const { db, log } = options;
  const now = options.now ?? Date.now;
  let loaded: Loaded | null = null;

  const load = (): Loaded => {
    if (loaded) return loaded;
    const byHash = new Map<string, DeviceRecord>();
    const byId = new Map<string, DeviceRecord>();
    for (const row of db.all(`SELECT ${DEVICE_COLUMNS} FROM devices`)) {
      const record = toDevice(row);
      byHash.set(asString(row.secret_hash), record);
      byId.set(record.id, record);
    }
    loaded = { byHash, byId };
    return loaded;
  };

  const invalidate = (): void => {
    loaded = null;
  };

  const working = (record: DeviceRecord): boolean => record.revokedAt === null;

  /** Marks a working device as stopped; false when it was not working. */
  const stop = (id: string, removedBy: DeviceRemoval, at: number): boolean => {
    const changed = db.run('UPDATE devices SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', [at, removedBy, id]).changes;
    if (changed === 0) return false;
    invalidate();
    return true;
  };

  /** Expires the devices idle too long (the same rule as {@link check}), then forgets old rows. */
  const purge = (): void => {
    const at = now();
    const idle = db
      .all(
        `UPDATE devices SET revoked_at = ?, revoked_by = 'expired'
         WHERE revoked_at IS NULL AND COALESCE(last_used_at, created_at) < ? RETURNING id`,
        [at, at - DEVICE_IDLE_TTL_MS],
      )
      .map((r) => asString(r.id));
    if (idle.length > 0) log?.info('idle devices expired', { count: idle.length, deviceIds: idle });
    const forgotten = db.run('DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at < ?', [at - REVOKED_RETENTION_MS]).changes;
    if (idle.length > 0 || forgotten > 0) invalidate();
    db.run('DELETE FROM device_requests WHERE expires_at < ?', [at - REQUEST_RETENTION_MS]);
  };

  /** A working device, expiring it first when it has been idle too long. */
  const check = (record: DeviceRecord): DeviceCheck => {
    if (!working(record)) {
      return { status: 'removed', deviceId: record.id, removedBy: record.revokedBy ?? 'revoked', removedAt: record.revokedAt ?? 0 };
    }
    const at = now();
    if (at - (record.lastUsedAt ?? record.createdAt) > DEVICE_IDLE_TTL_MS) {
      stop(record.id, 'expired', at);
      log?.info('device expired', { deviceId: record.id });
      return { status: 'removed', deviceId: record.id, removedBy: 'expired', removedAt: at };
    }
    return { status: 'ok', record: { ...record } };
  };

  const pendingRequests = (): DeviceRequestRecord[] =>
    db
      .all(`SELECT ${REQUEST_COLUMNS} FROM device_requests WHERE status = 'pending' AND expires_at >= ? ORDER BY created_at, rowid`, [now()])
      .map(toRequest);

  const explain = (secret: string): DeviceCheck => {
    if (!DeviceSecretSchema.safeParse(secret).success) return { status: 'malformed' };
    const record = load().byHash.get(hashSecret(secret));
    return record ? check(record) : { status: 'unknown' };
  };

  return {
    createRequest(input) {
      purge();
      const pending = pendingRequests();
      if (pending.length >= MAX_PENDING_DEVICE_REQUESTS) return null;
      const secret = newToken(32);
      const at = now();
      // Unique among every retained request, so a code still on another PC's screen is not reissued.
      const taken = new Set(db.all('SELECT code FROM device_requests').map((r) => asString(r.code)));
      let code = newDeviceCode();
      while (taken.has(code)) code = newDeviceCode();
      const record: DeviceRequestRecord = {
        id: newId(),
        code,
        label: input.label.slice(0, DEVICE_LABEL_MAX),
        browser: input.browser.slice(0, MAX_BROWSER_SUMMARY),
        createdAt: at,
        expiresAt: at + DEVICE_REQUEST_TTL_MS,
        status: 'pending',
      };
      db.run(
        `INSERT INTO device_requests (id, code, secret_hash, label, browser, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [record.id, record.code, hashSecret(secret), record.label, record.browser, record.createdAt, record.expiresAt],
      );
      return { secret, record: { ...record } };
    },

    requestBySecret(secret) {
      if (!DeviceSecretSchema.safeParse(secret).success) return null;
      const row = db.get(`SELECT ${REQUEST_COLUMNS} FROM device_requests WHERE secret_hash = ?`, [hashSecret(secret)]);
      return row ? toRequest(row) : null;
    },

    isExpired(request) {
      return request.expiresAt < now();
    },

    listRequests() {
      purge();
      return pendingRequests();
    },

    approve(id) {
      const changed = db.run(`UPDATE device_requests SET status = 'approved' WHERE id = ? AND status = 'pending' AND expires_at >= ?`, [id, now()]).changes;
      if (changed === 0) return null;
      const row = db.get(`SELECT ${REQUEST_COLUMNS} FROM device_requests WHERE id = ?`, [id]);
      return row ? toRequest(row) : null;
    },

    deny(id) {
      return db.run(`UPDATE device_requests SET status = 'denied' WHERE id = ? AND status = 'pending' AND expires_at >= ?`, [id, now()]).changes > 0;
    },

    claim(secret) {
      if (!DeviceSecretSchema.safeParse(secret).success) return null;
      const at = now();
      const row = db.get(
        `SELECT ${REQUEST_COLUMNS}, device_id FROM device_requests
         WHERE secret_hash = ? AND status IN ('approved', 'claimed') AND expires_at >= ?`,
        [hashSecret(secret), at],
      );
      if (!row) return null;
      const request = toRequest(row);
      const deviceSecret = newToken(32);
      if (request.status === 'claimed') {
        // The answer that carried the cookie may never have arrived: while nothing has used the
        // device, the same request hands it out again with a fresh secret.
        const deviceId = asNullableString(row.device_id);
        if (deviceId === null) return null;
        const changed = db.run('UPDATE devices SET secret_hash = ? WHERE id = ? AND revoked_at IS NULL AND last_used_at IS NULL', [
          hashSecret(deviceSecret),
          deviceId,
        ]).changes;
        if (changed === 0) return null;
        invalidate();
        const again = load().byId.get(deviceId);
        if (!again) return null;
        log?.info('device connected again', { deviceId, deviceRequestId: request.id });
        return { secret: deviceSecret, record: { ...again } };
      }
      const record: DeviceRecord = {
        id: newId(),
        label: request.label,
        browser: request.browser,
        createdAt: at,
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
      };
      db.tx(() => {
        purge();
        const count = asNumber(db.get('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL')?.n);
        const excess = count - MAX_DEVICES + 1;
        if (excess > 0) {
          const evicted = db
            .all(
              `UPDATE devices SET revoked_at = ?, revoked_by = 'evicted' WHERE id IN (
                 SELECT id FROM devices WHERE revoked_at IS NULL ORDER BY COALESCE(last_used_at, created_at), rowid LIMIT ?
               ) RETURNING id`,
              [at, excess],
            )
            .map((r) => asString(r.id));
          log?.info('least recently used devices removed to make room', { count: evicted.length, deviceIds: evicted });
        }
        db.run(
          `INSERT INTO devices (id, label, secret_hash, browser, created_at, last_used_at, revoked_at, revoked_by)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          [record.id, record.label, hashSecret(deviceSecret), record.browser, record.createdAt],
        );
        db.run(`UPDATE device_requests SET status = 'claimed', device_id = ? WHERE id = ?`, [record.id, request.id]);
      });
      invalidate();
      log?.info('device connected', { deviceId: record.id, deviceRequestId: request.id });
      return { secret: deviceSecret, record: { ...record } };
    },

    verify(secret) {
      const verdict = explain(secret);
      return verdict.status === 'ok' ? verdict.record : null;
    },

    explain,

    touch(id) {
      const record = load().byId.get(id);
      if (!record || !working(record)) return false;
      const at = now();
      if (record.lastUsedAt !== null && at - record.lastUsedAt < TOUCH_INTERVAL_MS) return false;
      db.run('UPDATE devices SET last_used_at = ? WHERE id = ?', [at, id]);
      record.lastUsedAt = at;
      return true;
    },

    list() {
      purge();
      return db.all(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`).map(toDevice);
    },

    revoke(id, removedBy = 'revoked') {
      return stop(id, removedBy, now());
    },

    revokeBySecret(secret, removedBy = 'disconnected') {
      if (!DeviceSecretSchema.safeParse(secret).success) return false;
      const record = load().byHash.get(hashSecret(secret));
      if (!record || !working(record)) return false;
      return stop(record.id, removedBy, now());
    },
  };
}
