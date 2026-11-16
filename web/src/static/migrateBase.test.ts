import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { hybridStorageKeys, type StorageLike } from '../localServer/pairing.ts';
import { remoteAddressKey } from '../localServer/remote.ts';
import { baseMigratedKey, migrateLegacyBase } from './migrateBase.ts';
import { IndexedDbStorage } from './storage/idb.ts';

const NEW_BASE = '/portly/';

function memoryLocal(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

async function seedOld(factory: IDBFactory): Promise<void> {
  const old = await IndexedDbStorage.open(factory, 'portly-static:/');
  await old.applyBatch({
    json: new Map<string, unknown>([['settings', { theme: 'dark' }], ['accounts', [{ id: 'a1' }]]]),
    putBlobs: [{ id: 'icon1', kind: 'icon', type: 'image/png', bytes: new Uint8Array([1, 2, 3]), width: 16, createdAt: 5 }],
  });
  old.close();
}

describe('migrateLegacyBase', () => {
  it('does nothing when the build is still at the root', async () => {
    const local = memoryLocal();
    expect(await migrateLegacyBase({ base: '/', local, indexedDB: new IDBFactory() })).toBe('skipped');
    expect(local.data.size).toBe(0);
  });

  it('copies the pairing, the remote address and the browser copy once', async () => {
    const factory = new IDBFactory();
    await seedOld(factory);
    const old = hybridStorageKeys('/');
    const local = memoryLocal({ [old.pairing]: 'P', [old.mode]: 'server', [old.seen]: '9', [remoteAddressKey('/')]: 'https://pc.ts.net' });

    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory })).toBe('migrated');

    const next = hybridStorageKeys(NEW_BASE);
    expect(local.data.get(next.pairing)).toBe('P');
    expect(local.data.get(next.mode)).toBe('server');
    expect(local.data.get(next.seen)).toBe('9');
    expect(local.data.get(remoteAddressKey(NEW_BASE))).toBe('https://pc.ts.net');
    expect(local.data.has(baseMigratedKey(NEW_BASE))).toBe(true);
    expect(local.data.has(old.pairing)).toBe(false);
    expect((await factory.databases()).map((d) => d.name)).not.toContain('portly-static:/');

    const copy = await IndexedDbStorage.open(factory, `portly-static:${NEW_BASE}`);
    expect(await copy.getJson('settings')).toEqual({ theme: 'dark' });
    expect(await copy.getJson('accounts')).toEqual([{ id: 'a1' }]);
    expect(Array.from((await copy.getBlob('icon1'))!.bytes)).toEqual([1, 2, 3]);
    copy.close();
  });

  it('runs only once', async () => {
    const factory = new IDBFactory();
    await seedOld(factory);
    const local = memoryLocal();
    await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory });
    const target = await IndexedDbStorage.open(factory, `portly-static:${NEW_BASE}`);
    await target.deleteJson('settings');
    target.close();
    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory })).toBe('skipped');
    const again = await IndexedDbStorage.open(factory, `portly-static:${NEW_BASE}`);
    expect(await again.getJson('settings')).toBeUndefined();
    again.close();
  });

  it('never replaces data the new address already holds', async () => {
    const factory = new IDBFactory();
    await seedOld(factory);
    const existing = await IndexedDbStorage.open(factory, `portly-static:${NEW_BASE}`);
    await existing.setJson('settings', { theme: 'light' });
    existing.close();
    const old = hybridStorageKeys('/');
    const next = hybridStorageKeys(NEW_BASE);
    const local = memoryLocal({ [old.pairing]: 'OLD', [next.pairing]: 'NEW' });

    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory })).toBe('migrated');

    expect(local.data.get(next.pairing)).toBe('NEW');
    const copy = await IndexedDbStorage.open(factory, `portly-static:${NEW_BASE}`);
    expect(await copy.getJson('settings')).toEqual({ theme: 'light' });
    expect(await copy.getJson('accounts')).toBeUndefined();
    copy.close();
  });

  it('does not create an old database that was never there', async () => {
    const factory = new IDBFactory();
    const local = memoryLocal();
    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory })).toBe('migrated');
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).not.toContain('portly-static:/');
    expect(names).not.toContain(`portly-static:${NEW_BASE}`);
  });

  it('leaves the marker unset when a step fails, so the next load tries again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const factory = new IDBFactory();
    vi.spyOn(factory, 'open').mockImplementation(() => {
      throw new Error('boom');
    });
    const local = memoryLocal();
    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: factory })).toBe('failed');
    expect(local.data.has(baseMigratedKey(NEW_BASE))).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it('copies only localStorage when IndexedDB is unavailable', async () => {
    const old = hybridStorageKeys('/');
    const local = memoryLocal({ [old.pairing]: 'P' });
    expect(await migrateLegacyBase({ base: NEW_BASE, local, indexedDB: null })).toBe('migrated');
    expect(local.data.get(hybridStorageKeys(NEW_BASE).pairing)).toBe('P');
  });
});
