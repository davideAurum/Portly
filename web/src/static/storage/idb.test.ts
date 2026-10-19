import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { IndexedDbStorage, LEGACY_COPY_ATTEMPTS, LEGACY_COPY_PENDING_KEY, copyLegacyStaticDatabase, openStaticDatabase } from './idb.ts';

/** Writes `kv` records and one blob into a database named `name` the way Homebase did. */
async function seed(factory: IDBFactory, name: string, kv: Record<string, unknown>): Promise<void> {
  const db = await openStaticDatabase(factory, name);
  const tx = db.transaction(['kv', 'blobs'], 'readwrite');
  for (const [key, value] of Object.entries(kv)) tx.objectStore('kv').put(value, key);
  tx.objectStore('blobs').put({ id: 'img1', kind: 'upload', type: 'image/png', bytes: new Uint8Array([1, 2, 3]), width: 1, createdAt: 5 });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** A `name` database with only the `kv` store: reading it as Homebase's fails, as a copy can. */
async function unreadable(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function remove(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** The pending-copy marker in `name` (undefined when there is none). */
async function pendingMarker(factory: IDBFactory, name: string): Promise<unknown> {
  const db = await openStaticDatabase(factory, name);
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(LEGACY_COPY_PENDING_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

describe("copying Homebase's in-browser database (before the rename to Portly)", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('copies every record of both stores the first time the new database opens', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'homebase-static:/', { settings: { general: { userName: 'Dana' } }, profiles: [{ id: 'p1' }] });
    const storage = await IndexedDbStorage.open(factory, 'portly-static:/');
    try {
      expect(await storage.getJson('settings')).toEqual({ general: { userName: 'Dana' } });
      expect(await storage.getJson('profiles')).toEqual([{ id: 'p1' }]);
      expect(await storage.listJsonKeys(), 'no pending marker is left').toEqual(['profiles', 'settings']);
      const blob = await storage.getBlob('img1');
      expect(blob?.type).toBe('image/png');
      expect([...(blob?.bytes ?? [])]).toEqual([1, 2, 3]);
    } finally {
      storage.close();
    }
    const names = (await factory.databases()).map((info) => info.name).sort();
    expect(names, 'the old database stays').toEqual(['homebase-static:/', 'portly-static:/']);
  });

  it('copies nothing once Portly has its own database, nor when there is no old one', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'homebase-static:/', { settings: { old: true } });
    await seed(factory, 'portly-static:/', { settings: { new: true } });
    expect(await copyLegacyStaticDatabase(factory, 'portly-static:/')).toBe(false);
    const storage = await IndexedDbStorage.open(factory, 'portly-static:/');
    try {
      expect(await storage.getJson('settings')).toEqual({ new: true });
    } finally {
      storage.close();
    }

    const fresh = new IDBFactory();
    expect(await copyLegacyStaticDatabase(fresh, 'portly-static:/homebase-pages/')).toBe(false);
    expect(await copyLegacyStaticDatabase(fresh, 'some-other-name')).toBe(false);
  });

  it('tries again on the next load when the copy failed, replacing what was written meanwhile', async () => {
    const factory = new IDBFactory();
    await unreadable(factory, 'homebase-static:/');
    const first = await IndexedDbStorage.open(factory, 'portly-static:/');
    try {
      expect(await first.getJson('settings'), 'nothing was copied').toBeUndefined();
      await first.setJson('slice:settings', { written: 'meanwhile' });
    } finally {
      first.close();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await pendingMarker(factory, 'portly-static:/'), 'the copy is still due').toEqual({ attempts: 1 });

    await remove(factory, 'homebase-static:/');
    await seed(factory, 'homebase-static:/', { settings: { general: { userName: 'Dana' } } });
    const second = await IndexedDbStorage.open(factory, 'portly-static:/');
    try {
      expect(await second.listJsonKeys(), "exactly Homebase's records").toEqual(['settings']);
      expect(await second.getJson('settings')).toEqual({ general: { userName: 'Dana' } });
      expect((await second.getBlob('img1'))?.type).toBe('image/png');
    } finally {
      second.close();
    }

    // Copied: later loads leave the database alone.
    await seed(factory, 'homebase-static:/', { settings: { changed: true } });
    expect(await copyLegacyStaticDatabase(factory, 'portly-static:/')).toBe(false);
  });

  it('tries again after a load that stopped before the records were written (a closed tab)', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'homebase-static:/', { settings: { site: 'old' } });
    // What the first attempt leaves when the tab closes right after creating the database.
    const cut = await openStaticDatabase(factory, 'portly-static:/', (tx) => tx.objectStore('kv').put({ attempts: 1 }, LEGACY_COPY_PENDING_KEY));
    cut.close();
    expect(await copyLegacyStaticDatabase(factory, 'portly-static:/')).toBe(true);
    expect(await pendingMarker(factory, 'portly-static:/')).toBeUndefined();
  });

  it(`gives up after ${LEGACY_COPY_ATTEMPTS} loads and keeps the database as it is`, async () => {
    const factory = new IDBFactory();
    await unreadable(factory, 'homebase-static:/');
    for (let i = 0; i < LEGACY_COPY_ATTEMPTS; i += 1) expect(await copyLegacyStaticDatabase(factory, 'portly-static:/')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(LEGACY_COPY_ATTEMPTS);
    expect(await pendingMarker(factory, 'portly-static:/')).toEqual({ attempts: LEGACY_COPY_ATTEMPTS });

    await remove(factory, 'homebase-static:/');
    await seed(factory, 'homebase-static:/', { settings: { old: true } });
    expect(await copyLegacyStaticDatabase(factory, 'portly-static:/')).toBe(false);
    expect(warn, 'no attempt was made').toHaveBeenCalledTimes(LEGACY_COPY_ATTEMPTS);
  });

  it('keeps deployments apart: each base path copies its own old database', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'homebase-static:/a/', { settings: { site: 'a' } });
    await seed(factory, 'homebase-static:/b/', { settings: { site: 'b' } });
    expect(await copyLegacyStaticDatabase(factory, 'portly-static:/b/')).toBe(true);
    const storage = await IndexedDbStorage.open(factory, 'portly-static:/b/');
    try {
      expect(await storage.getJson('settings')).toEqual({ site: 'b' });
    } finally {
      storage.close();
    }
  });
});
