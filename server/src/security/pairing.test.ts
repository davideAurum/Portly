import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceIdSchema, MAX_PAIRINGS, PairingTokenSchema } from '@homebase/shared';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { createMemoryLogger } from '../lib/logger.ts';
import {
  MAX_PAIRING_LABEL,
  MAX_TOMBSTONES,
  PERSISTED_TOMBSTONES,
  TOUCH_INTERVAL_MS,
  UNUSED_PAIRING_TTL_MS,
  createPairingStore,
  type PairingStore,
} from './pairing.ts';

const ORIGIN = 'https://pages.example';
const MINUTE = 60 * 1000;

describe('pairing store', () => {
  let db: Db;
  let clock: number;
  let store: PairingStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    clock = Date.UTC(2026, 9, 11, 12);
    store = createPairingStore({ db, now: () => clock });
  });
  afterEach(() => db.close());

  it('creates the instance id once and keeps it across store instances', () => {
    const id = store.instanceId();
    expect(InstanceIdSchema.safeParse(id).success).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(store.instanceId()).toBe(id);
    expect(createPairingStore({ db }).instanceId()).toBe(id);
    expect(db.get<{ value: string }>("SELECT value FROM server_meta WHERE key = 'instance_id'")?.value).toBe(id);
  });

  it('replaces a malformed stored instance id', () => {
    db.run("INSERT INTO server_meta (key, value) VALUES ('instance_id', 'not valid!')");
    const id = createPairingStore({ db }).instanceId();
    expect(id).not.toBe('not valid!');
    expect(InstanceIdSchema.safeParse(id).success).toBe(true);
  });

  it('creates a pairing with a 43-character token and stores only its SHA-256', () => {
    const { token, record } = store.create({ label: 'Chrome on Windows', origin: ORIGIN });
    expect(PairingTokenSchema.safeParse(token).success).toBe(true);
    expect(record).toMatchObject({ label: 'Chrome on Windows', origin: ORIGIN, createdAt: clock, lastUsedAt: null });
    const row = db.get<Record<string, unknown>>('SELECT * FROM pairings WHERE id = ?', [record.id]);
    expect(row?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db.all('SELECT * FROM pairings'))).not.toContain(token);
  });

  it('verifies tokens (format first) and returns copies', () => {
    const { token, record } = store.create({ label: 'A', origin: ORIGIN });
    const other = store.create({ label: 'B', origin: ORIGIN });
    expect(store.verify(token)).toEqual(record);
    expect(store.verify(other.token)?.id).toBe(other.record.id);
    for (const bad of ['', 'short', `${token}x`, token.replace(/.$/, '!'), 'A'.repeat(43)]) expect(store.verify(bad), bad).toBeNull();
    const copy = store.verify(token);
    if (copy) copy.label = 'changed';
    expect(store.verify(token)?.label).toBe('A');
  });

  it('truncates long labels', () => {
    const { record } = store.create({ label: 'x'.repeat(500), origin: ORIGIN });
    expect(record.label).toHaveLength(MAX_PAIRING_LABEL);
  });

  it('revokes by id and by token, and verify() forgets them at once', () => {
    const a = store.create({ label: 'A', origin: ORIGIN });
    const b = store.create({ label: 'B', origin: ORIGIN });
    expect(store.verify(a.token)).not.toBeNull(); // loads the in-memory map
    expect(store.revoke(a.record.id)).toBe(true);
    expect(store.revoke(a.record.id)).toBe(false);
    expect(store.verify(a.token)).toBeNull();
    expect(store.revokeByToken('malformed')).toBe(false);
    expect(store.revokeByToken(b.token)).toBe(true);
    expect(store.revokeByToken(b.token)).toBe(false);
    expect(store.verify(b.token)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('touch() writes the last use at most once per 10 minutes', () => {
    const { token, record } = store.create({ label: 'A', origin: ORIGIN });
    const lastUsed = (): unknown => db.get<{ last_used_at: unknown }>('SELECT last_used_at FROM pairings WHERE id = ?', [record.id])?.last_used_at;
    store.touch(record.id);
    expect(lastUsed()).toBe(clock);
    const first = clock;
    clock += TOUCH_INTERVAL_MS - 1;
    store.touch(record.id);
    expect(lastUsed()).toBe(first);
    expect(store.verify(token)?.lastUsedAt).toBe(first);
    clock += 1;
    store.touch(record.id);
    expect(lastUsed()).toBe(clock);
    expect(store.verify(token)?.lastUsedAt).toBe(clock);
    store.touch('no-such-id'); // ignored
  });

  it('lists newest first and purges pairings never used within 24 h', () => {
    const used = store.create({ label: 'used', origin: ORIGIN });
    store.touch(used.record.id);
    const unused = store.create({ label: 'unused', origin: ORIGIN });
    clock += MINUTE;
    const fresh = store.create({ label: 'fresh', origin: 'https://old.example' });
    expect(store.list().map((p) => p.label)).toEqual(['fresh', 'unused', 'used']);
    clock = unused.record.createdAt + UNUSED_PAIRING_TTL_MS + 1;
    expect(store.list().map((p) => p.label)).toEqual(['fresh', 'used']);
    expect(store.verify(unused.token)).toBeNull();
    expect(store.list().find((p) => p.label === 'fresh')).toMatchObject({ origin: 'https://old.example', lastUsedAt: null });
    clock += MINUTE;
    expect(store.list().map((p) => p.label)).toEqual(['used']);
    expect(store.verify(fresh.token)).toBeNull();
  });

  it(`keeps at most MAX_PAIRINGS (${MAX_PAIRINGS}): a new one replaces the least recently used`, () => {
    const created = [];
    for (let i = 0; i < MAX_PAIRINGS; i++) {
      created.push(store.create({ label: `p${i}`, origin: ORIGIN }));
      clock += MINUTE;
    }
    // p0 was used recently; p1 is now the least recently used.
    clock += TOUCH_INTERVAL_MS;
    store.touch(created[0]!.record.id);
    clock += MINUTE;
    const extra = store.create({ label: 'extra', origin: ORIGIN });
    const labels = store.list().map((p) => p.label);
    expect(labels).toHaveLength(MAX_PAIRINGS);
    expect(labels).toContain('p0');
    expect(labels).toContain('extra');
    expect(labels).not.toContain('p1');
    expect(store.verify(created[1]!.token)).toBeNull();
    expect(store.verify(extra.token)?.label).toBe('extra');
  });
});

describe('pairing store: explain() and tombstones (diagnostics)', () => {
  let db: Db;
  let clock: number;
  let log: ReturnType<typeof createMemoryLogger>;
  let store: PairingStore;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    clock = Date.UTC(2026, 9, 11, 12);
    log = createMemoryLogger();
    store = createPairingStore({ db, log, now: () => clock });
  });
  afterEach(() => db.close());

  it('tells valid, malformed, never-issued and removed tokens apart, with how they were removed', () => {
    const live = store.create({ label: 'live', origin: ORIGIN });
    const revoked = store.create({ label: 'revoked', origin: ORIGIN });
    const unpaired = store.create({ label: 'unpaired', origin: ORIGIN });
    clock += MINUTE;
    store.revoke(revoked.record.id);
    store.revokeByToken(unpaired.token);

    expect(store.explain(live.token)).toEqual({ status: 'ok', record: live.record });
    expect(store.explain('short')).toEqual({ status: 'malformed' });
    expect(store.explain('C'.repeat(43))).toEqual({ status: 'unknown' });
    expect(store.explain(revoked.token)).toEqual({ status: 'removed', pairingId: revoked.record.id, removedBy: 'revoked', removedAt: clock });
    expect(store.explain(unpaired.token)).toEqual({ status: 'removed', pairingId: unpaired.record.id, removedBy: 'unpaired-itself', removedAt: clock });
    // The caller may name the reason.
    const other = store.create({ label: 'other', origin: ORIGIN });
    store.revokeByToken(other.token, 'revoked');
    expect(store.explain(other.token)).toMatchObject({ removedBy: 'revoked' });
  });

  it('records evicted and never-used pairings, logging their ids', () => {
    const unused = store.create({ label: 'unused', origin: ORIGIN });
    clock = unused.record.createdAt + UNUSED_PAIRING_TTL_MS + 1;
    store.list();
    expect(store.explain(unused.token)).toMatchObject({ status: 'removed', removedBy: 'unused', pairingId: unused.record.id });
    expect(log.lines.find((l) => l.message === 'unused pairings removed')?.fields).toEqual({ count: 1, pairingIds: [unused.record.id] });

    const created = [];
    for (let i = 0; i < MAX_PAIRINGS; i++) {
      created.push(store.create({ label: `p${i}`, origin: ORIGIN }));
      clock += MINUTE;
    }
    store.create({ label: 'extra', origin: ORIGIN });
    const first = created[0]!;
    expect(store.explain(first.token)).toMatchObject({ status: 'removed', removedBy: 'evicted', pairingId: first.record.id });
    expect(log.lines.find((l) => l.message === 'least recently used pairings removed to make room')?.fields).toEqual({
      count: 1,
      pairingIds: [first.record.id],
    });
  });

  it(`keeps the last ${PERSISTED_TOMBSTONES} across restarts (hashes only) and at most ${MAX_TOMBSTONES} in memory`, () => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_TOMBSTONES + 5; i++) {
      const { token } = store.create({ label: `t${i}`, origin: ORIGIN });
      store.revokeByToken(token);
      tokens.push(token);
      clock += 1;
    }
    // Memory: the oldest five are forgotten.
    expect(store.explain(tokens[0]!)).toEqual({ status: 'unknown' });
    expect(store.explain(tokens[5]!)).toMatchObject({ status: 'removed' });

    const stored = db.get<{ value: string }>("SELECT value FROM server_meta WHERE key = 'pairing.tombstones'")?.value ?? '';
    for (const token of tokens) expect(stored).not.toContain(token);
    expect((JSON.parse(stored) as unknown[]).length).toBe(PERSISTED_TOMBSTONES);

    const restarted = createPairingStore({ db, now: () => clock });
    expect(restarted.explain(tokens.at(-1)!)).toMatchObject({ status: 'removed', removedBy: 'unpaired-itself' });
    expect(restarted.explain(tokens.at(-PERSISTED_TOMBSTONES)!)).toMatchObject({ status: 'removed' });
    expect(restarted.explain(tokens.at(-PERSISTED_TOMBSTONES - 1)!)).toEqual({ status: 'unknown' });
  });

  it('skips invalid persisted tombstones and keeps the valid ones', () => {
    // Well-formed tokens with known hashes: each entry below differs from a valid one in one field.
    const [valid, badRemoval, badId, badTime, badHash] = ['D', 'E', 'F', 'G', 'H'].map((c) => c.repeat(43)) as [string, string, string, string, string];
    const sha256 = (token: string): string => createHash('sha256').update(token).digest('hex');
    const entry = { pairingId: 'p1', removedAt: 1, removedBy: 'revoked' };
    db.run("INSERT INTO server_meta (key, value) VALUES ('pairing.tombstones', ?)", [
      JSON.stringify([
        null,
        'text',
        { ...entry, hash: 'x' },
        { ...entry, hash: sha256(valid) },
        { ...entry, hash: sha256(badRemoval), removedBy: 'stolen' },
        { ...entry, hash: sha256(badId), pairingId: '' },
        { ...entry, hash: sha256(badTime), removedAt: 'yesterday' },
        { ...entry, hash: sha256(badHash).toUpperCase() },
      ]),
    ]);
    const restarted = createPairingStore({ db, now: () => clock });
    expect(restarted.explain(valid)).toEqual({ status: 'removed', pairingId: 'p1', removedBy: 'revoked', removedAt: 1 });
    for (const token of [badRemoval, badId, badTime, badHash]) expect(restarted.explain(token), token[0]).toEqual({ status: 'unknown' });
    // The next removal persists the valid entries only.
    const { token, record } = restarted.create({ label: 'A', origin: ORIGIN });
    restarted.revoke(record.id);
    const stored = JSON.parse(db.get<{ value: string }>("SELECT value FROM server_meta WHERE key = 'pairing.tombstones'")?.value ?? '') as { hash: string }[];
    expect(stored.map((t) => t.hash)).toEqual([sha256(valid), sha256(token)]);
  });

  it('starts over from an unreadable persisted value (and replaces it on the next removal)', () => {
    for (const value of ['{not json', '{"hash":"x"}']) {
      db.run("INSERT INTO server_meta (key, value) VALUES ('pairing.tombstones', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [value]);
      const fresh = createPairingStore({ db, now: () => clock });
      expect(fresh.explain('D'.repeat(43))).toEqual({ status: 'unknown' });
      const { token, record } = fresh.create({ label: 'A', origin: ORIGIN });
      fresh.revoke(record.id);
      expect(fresh.explain(token)).toMatchObject({ status: 'removed', pairingId: record.id });
      const stored = JSON.parse(db.get<{ value: string }>("SELECT value FROM server_meta WHERE key = 'pairing.tombstones'")?.value ?? '') as unknown[];
      expect(stored).toEqual([{ hash: createHash('sha256').update(token).digest('hex'), pairingId: record.id, removedAt: clock, removedBy: 'revoked' }]);
    }
  });

  it('logs the creation of the instance id, and whether it replaced an invalid one', () => {
    store.instanceId();
    expect(log.lines.filter((l) => l.message === 'instance id created').map((l) => l.fields)).toEqual([{ replacedInvalid: false }]);
    db.run("UPDATE server_meta SET value = 'not valid!' WHERE key = 'instance_id'");
    createPairingStore({ db, log }).instanceId();
    expect(log.lines.filter((l) => l.message === 'instance id created').map((l) => l.fields)).toEqual([{ replacedInvalid: false }, { replacedInvalid: true }]);
  });
});
