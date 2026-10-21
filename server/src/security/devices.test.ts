import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_CODE_REGEX, DEVICE_IDLE_TTL_MS, DEVICE_REQUEST_TTL_MS, MAX_DEVICES, MAX_PENDING_DEVICE_REQUESTS } from '@portly/shared';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { createMemoryLogger } from '../lib/logger.ts';
import { REQUEST_RETENTION_MS, REVOKED_RETENTION_MS, TOUCH_INTERVAL_MS, createDeviceStore, newDeviceCode, type DeviceStore } from './devices.ts';

const T0 = Date.parse('2026-10-21T10:00:00Z');

describe('device store', () => {
  let db: Db;
  let store: DeviceStore;
  let log: ReturnType<typeof createMemoryLogger>;
  let now = T0;

  beforeEach(() => {
    now = T0;
    db = openDb(':memory:');
    migrate(db);
    log = createMemoryLogger();
    store = createDeviceStore({ db, log, now: () => now });
  });
  afterEach(() => db.close());

  /** A connected device: request, approve, claim. */
  function connect(label = 'Laptop'): { secret: string; id: string } {
    const created = store.createRequest({ label, browser: 'Chrome on Windows' });
    if (!created) throw new Error('limit');
    store.approve(created.record.id);
    const claimed = store.claim(created.secret);
    if (!claimed) throw new Error('claim');
    return { secret: claimed.secret, id: claimed.record.id };
  }

  it('makes display codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(newDeviceCode()).toMatch(DEVICE_CODE_REGEX);
    expect(new Set(Array.from({ length: 50 }, newDeviceCode)).size).toBeGreaterThan(40);
  });

  it('creates a pending request with a code, storing only the hash of its secret', () => {
    const created = store.createRequest({ label: 'Laptop', browser: 'Chrome on Windows' });
    expect(created).not.toBeNull();
    const { secret, record } = created!;
    expect(record).toMatchObject({ label: 'Laptop', browser: 'Chrome on Windows', createdAt: T0, expiresAt: T0 + DEVICE_REQUEST_TTL_MS, status: 'pending' });
    expect(record.code).toMatch(DEVICE_CODE_REGEX);
    const row = db.get('SELECT secret_hash, code FROM device_requests WHERE id = ?', [record.id]);
    expect(row?.secret_hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(db.all('SELECT * FROM device_requests'))).not.toContain(secret);
    expect(store.requestBySecret(secret)).toEqual(record);
    expect(store.requestBySecret('nope')).toBeNull();
    expect(store.listRequests()).toEqual([record]);
  });

  it('refuses a fourth pending request and frees the slot when one is decided or expires', () => {
    const made = Array.from({ length: MAX_PENDING_DEVICE_REQUESTS }, (_, i) => store.createRequest({ label: `PC ${i}`, browser: 'x' }));
    expect(made.every((m) => m !== null)).toBe(true);
    expect(new Set(made.map((m) => m?.record.code)).size).toBe(MAX_PENDING_DEVICE_REQUESTS);
    expect(store.createRequest({ label: 'one more', browser: 'x' })).toBeNull();
    expect(store.deny(made[0]!.record.id)).toBe(true);
    expect(store.createRequest({ label: 'fits now', browser: 'x' })).not.toBeNull();
    expect(store.createRequest({ label: 'too many', browser: 'x' })).toBeNull();
    now += DEVICE_REQUEST_TTL_MS + 1;
    expect(store.listRequests()).toEqual([]);
    expect(store.createRequest({ label: 'after expiry', browser: 'x' })).not.toBeNull();
  });

  it('approves and claims: the device gets a fresh secret, the request row goes away', () => {
    const created = store.createRequest({ label: 'Laptop', browser: 'Chrome on Windows' })!;
    expect(store.claim(created.secret)).toBeNull(); // not approved yet
    expect(store.approve('nope')).toBeNull();
    expect(store.approve(created.record.id)).toMatchObject({ id: created.record.id, status: 'approved' });
    expect(store.approve(created.record.id)).toBeNull(); // only once
    expect(store.deny(created.record.id)).toBe(false);
    expect(store.listRequests()).toEqual([]); // no longer waiting
    expect(store.requestBySecret(created.secret)?.status).toBe('approved');

    now += 1000;
    const claimed = store.claim(created.secret)!;
    expect(claimed).not.toBeNull();
    expect(claimed.secret).not.toBe(created.secret);
    expect(claimed.record).toMatchObject({ label: 'Laptop', browser: 'Chrome on Windows', createdAt: T0 + 1000, lastUsedAt: null, revokedAt: null });
    expect(store.requestBySecret(created.secret)?.status).toBe('claimed');
    expect(store.listRequests()).toEqual([]);
    expect(store.verify(claimed.secret)?.id).toBe(claimed.record.id);
    expect(store.verify(created.secret)).toBeNull();
    // Claimed again before any use: the same device, a fresh secret, the old one dead.
    const again = store.claim(created.secret)!;
    expect(again.record.id).toBe(claimed.record.id);
    expect(again.secret).not.toBe(claimed.secret);
    expect(store.verify(claimed.secret)).toBeNull();
    expect(store.verify(again.secret)?.id).toBe(claimed.record.id);
    expect(store.list()).toHaveLength(1);
    // Used once, the request is spent.
    expect(store.touch(claimed.record.id)).toBe(true);
    expect(store.claim(created.secret)).toBeNull();
    expect(store.verify(again.secret)?.id).toBe(claimed.record.id);
    const row = db.get('SELECT secret_hash FROM devices WHERE id = ?', [claimed.record.id]);
    expect(row?.secret_hash).toBe(createHash('sha256').update(again.secret).digest('hex'));
    expect(log.lines.map((l) => [l.message, l.fields?.deviceId, l.fields?.deviceRequestId])).toEqual([
      ['device connected', claimed.record.id, created.record.id],
      ['device connected again', claimed.record.id, created.record.id],
    ]);
    expect(JSON.stringify(log.lines)).not.toMatch(/Laptop|Chrome|K7Q|secret/);
    expect(JSON.stringify(log.lines)).not.toContain(created.record.code);
  });

  it('does not claim an approved request after it expired', () => {
    const created = store.createRequest({ label: 'Laptop', browser: 'x' })!;
    store.approve(created.record.id);
    now += DEVICE_REQUEST_TTL_MS + 1;
    expect(store.isExpired(created.record)).toBe(true);
    expect(store.claim(created.secret)).toBeNull();
    // Retained for a while so a poll can say "expired", then purged.
    expect(store.requestBySecret(created.secret)?.id).toBe(created.record.id);
    now += REQUEST_RETENTION_MS + 1;
    store.listRequests();
    expect(store.requestBySecret(created.secret)).toBeNull();
  });

  it('explains a presented secret: ok, malformed, unknown, or removed with the reason', () => {
    const device = connect();
    expect(store.explain(device.secret)).toMatchObject({ status: 'ok', record: { id: device.id } });
    expect(store.explain('short')).toEqual({ status: 'malformed' });
    expect(store.explain('A'.repeat(43))).toEqual({ status: 'unknown' });
    expect(store.revoke(device.id)).toBe(true);
    expect(store.revoke(device.id)).toBe(false);
    expect(store.explain(device.secret)).toEqual({ status: 'removed', deviceId: device.id, removedBy: 'revoked', removedAt: now });
    expect(store.verify(device.secret)).toBeNull();
    expect(store.list()).toEqual([]);

    const other = connect('Desk');
    expect(store.revokeBySecret(other.secret)).toBe(true);
    expect(store.revokeBySecret(other.secret)).toBe(false);
    expect(store.revokeBySecret('short')).toBe(false);
    expect(store.explain(other.secret)).toMatchObject({ status: 'removed', removedBy: 'disconnected' });
  });

  it('expires idle devices on every listing and write, not only when they present their cookie', () => {
    const idle = connect('Idle');
    const fresh = connect('Fresh');
    store.touch(fresh.id);
    now += DEVICE_IDLE_TTL_MS + 1;
    store.touch(fresh.id);
    expect(store.list().map((d) => d.id)).toEqual([fresh.id]);
    expect(log.lines.find((l) => l.message === 'idle devices expired')?.fields).toMatchObject({ count: 1, deviceIds: [idle.id] });
    expect(store.explain(idle.secret)).toMatchObject({ status: 'removed', removedBy: 'expired' });
    expect(store.touch(idle.id)).toBe(false);
    // The device cap counts working devices only.
    for (let i = 0; i < MAX_DEVICES - 1; i++) {
      now += 1000;
      connect(`PC ${i}`);
    }
    expect(store.list()).toHaveLength(MAX_DEVICES);
    expect(store.verify(fresh.secret)).not.toBeNull();
  });

  it('reissues no display code still shown on another screen (approved, denied or expired but retained)', () => {
    const approved = store.createRequest({ label: 'A', browser: 'x' })!;
    store.approve(approved.record.id);
    const denied = store.createRequest({ label: 'B', browser: 'x' })!;
    store.deny(denied.record.id);
    const codes = new Set([approved.record.code, denied.record.code]);
    for (let i = 0; i < 30; i++) {
      const next = store.createRequest({ label: `C${i}`, browser: 'x' })!;
      expect(codes.has(next.record.code)).toBe(false);
      store.deny(next.record.id);
    }
  });

  it('expires a device idle for 30 days and forgets revoked rows after a while', () => {
    const device = connect();
    now += DEVICE_IDLE_TTL_MS;
    expect(store.verify(device.secret)?.id).toBe(device.id); // exactly at the limit still works
    expect(store.touch(device.id)).toBe(true);
    now += DEVICE_IDLE_TTL_MS;
    expect(store.verify(device.secret)?.id).toBe(device.id); // use renewed it
    now += DEVICE_IDLE_TTL_MS + 1;
    expect(store.explain(device.secret)).toEqual({ status: 'removed', deviceId: device.id, removedBy: 'expired', removedAt: now });
    expect(log.lines.find((l) => l.message === 'device expired')?.fields).toEqual({ deviceId: device.id });
    expect(store.list()).toEqual([]);
    now += REVOKED_RETENTION_MS + 1;
    store.list();
    expect(store.explain(device.secret)).toEqual({ status: 'unknown' });
  });

  it('records use at most every 10 minutes', () => {
    const device = connect();
    expect(store.touch(device.id)).toBe(true);
    expect(store.verify(device.secret)?.lastUsedAt).toBe(now);
    now += TOUCH_INTERVAL_MS - 1;
    expect(store.touch(device.id)).toBe(false);
    now += 1;
    expect(store.touch(device.id)).toBe(true);
    expect(store.touch('nope')).toBe(false);
    store.revoke(device.id);
    expect(store.touch(device.id)).toBe(false);
  });

  it('keeps at most 20 devices, removing the least recently used', () => {
    const devices = Array.from({ length: MAX_DEVICES }, (_, i) => {
      now += 1000;
      return connect(`PC ${i}`);
    });
    expect(store.list()).toHaveLength(MAX_DEVICES);
    // The oldest device is used now, so the second oldest goes first.
    store.touch(devices[0]!.id);
    now += 1000;
    const extra = connect('one more');
    expect(store.list()).toHaveLength(MAX_DEVICES);
    expect(store.verify(devices[0]!.secret)).not.toBeNull();
    expect(store.explain(devices[1]!.secret)).toMatchObject({ status: 'removed', removedBy: 'evicted' });
    expect(store.verify(extra.secret)).not.toBeNull();
    expect(log.lines.find((l) => l.message === 'least recently used devices removed to make room')?.fields).toMatchObject({
      count: 1,
      deviceIds: [devices[1]!.id],
    });
  });
});
