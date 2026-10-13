import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStorage, copyLegacyStaticDatabase, openStaticDatabase } from './idb.ts';

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

describe("copying Homebase's in-browser database (before the rename to Portly)", () => {
  it('copies every record of both stores the first time the new database opens', async () => {
    const factory = new IDBFactory();
    await seed(factory, 'homebase-static:/', { settings: { general: { userName: 'Dana' } }, profiles: [{ id: 'p1' }] });
    const storage = await IndexedDbStorage.open(factory, 'portly-static:/');
    try {
      expect(await storage.getJson('settings')).toEqual({ general: { userName: 'Dana' } });
      expect(await storage.getJson('profiles')).toEqual([{ id: 'p1' }]);
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
