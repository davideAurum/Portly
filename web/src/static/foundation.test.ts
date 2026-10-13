/**
 * Static backend foundation: router matching, response/error shapes, state persistence and
 * cross-tab announcements, IndexedDB storage (over fake-indexeddb), asset URL registry and the
 * dispatch loop with the health route.
 */
import { IDBFactory } from 'fake-indexeddb';
import { ApiErrorBodySchema, HealthResponseSchema, type Profile, type Settings } from '@homebase/shared';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetRegistry, parseAssetUrl } from './assets.ts';
import {
  START_RETRY_BASE_MS,
  configurePageBackendForTests,
  createStaticBackend,
  dispatch,
  ensureStaticBackend,
  getStaticBackendStatus,
  type StaticBackend,
} from './backend.ts';
import type { StaticContext } from './context.ts';
import { onBackendReady, type HandlerModule } from './handlers/index.ts';
import { IMAGE_SAMPLES } from './lib/__fixtures__/images.ts';
import { apiError, json, noContent, readJson, StaticApiError, unavailable, validationError } from './respond.ts';
import { StaticRouter } from './router.ts';
import { SLICE, getIcons, getSettings, getUploads } from './slices.ts';
import { STATIC_CHANNEL_NAME, StaticState, type ChangeChannel } from './state.ts';
import { IndexedDbStorage, STATIC_DB_NAME, STATIC_DB_VERSION } from './storage/idb.ts';
import { MemoryStorage } from './storage/memory.ts';
import { blobOf, type StaticStorage, type StoredBlob } from './storage/types.ts';
import { fileForm } from './test/harness.ts';

function fakeContext(state: StaticState): StaticContext {
  return { state, assets: new AssetRegistry(), version: '0.0.0-test', now: () => 1_700_000_000_000, newId: () => '00000000-0000-4000-8000-000000000001', appUrl: 'http://localhost:5173/' };
}

/** Calls a JSON route the way the API client does. */
async function call<T = unknown>(backend: StaticBackend, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers = new Headers({ 'X-Homebase': '1', Accept: 'application/json' });
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set('Content-Type', 'application/json');
  }
  const res = await backend.fetch(path, { method, headers, body: payload });
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

/** Fails the chosen single writes like a full disk (MemoryStorage.applyBatch then rolls back). */
class FlakyStorage extends MemoryStorage {
  failOn: ((key: string) => boolean) | null = null;
  override async setJson(key: string, value: unknown): Promise<void> {
    if (this.failOn?.(key)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return super.setJson(key, value);
  }
  override async putBlob(entry: StoredBlob): Promise<void> {
    if (this.failOn?.(`blob:${entry.id}`)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return super.putBlob(entry);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An AssetRegistry with predictable object URLs. */
function testAssets(): AssetRegistry {
  let n = 0;
  return new AssetRegistry({ createObjectUrl: () => `blob:test/${++n}`, revokeObjectUrl: () => {} });
}

/** Two fake channels wired to each other, like two tabs. */
function channelPair(): [ChangeChannel, ChangeChannel] {
  const listeners: [((e: MessageEvent) => void)[], ((e: MessageEvent) => void)[]] = [[], []];
  const make = (mine: 0 | 1): ChangeChannel => ({
    postMessage: (message) => {
      for (const l of listeners[mine === 0 ? 1 : 0]) l({ data: message } as MessageEvent);
    },
    addEventListener: (_type, listener) => {
      listeners[mine].push(listener);
    },
    close: () => {},
  });
  return [make(0), make(1)];
}

describe('StaticRouter', () => {
  it('matches literal and param segments, decoding params', () => {
    const router = new StaticRouter();
    const handler = () => json({});
    router.get('/api/bookmarks', handler).patch('/api/bookmarks/:id', handler).post('/api/profiles/:id/widgets/:wid', handler);
    expect(router.match('GET', '/api/bookmarks')?.params).toEqual({});
    expect(router.match('PATCH', '/api/bookmarks/a%2Fb')?.params).toEqual({ id: 'a/b' });
    expect(router.match('POST', '/api/profiles/p1/widgets/w%201')?.params).toEqual({ id: 'p1', wid: 'w 1' });
    expect(router.match('GET', '/api/bookmarks/x')).toBeUndefined();
    expect(router.match('DELETE', '/api/bookmarks/x')).toBeUndefined();
    expect(router.hasPath('/api/bookmarks/x')).toBe(true);
    expect(router.hasPath('/api/nope')).toBe(false);
    expect(router.match('HEAD', '/api/bookmarks')).toBeDefined();
  });

  it('rejects empty params and duplicate routes', () => {
    const router = new StaticRouter();
    router.get('/api/x/:id', () => json({}));
    expect(router.match('GET', '/api/x/')).toBeUndefined();
    expect(() => router.get('/api/x/:id', () => json({}))).toThrow(/Duplicate/);
  });
});

describe('respond helpers', () => {
  it('produces the server error body and status', async () => {
    const res = apiError('not_found', 'Nope', { x: 1 });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(ApiErrorBodySchema.parse(await res.json())).toEqual({ error: { code: 'not_found', message: 'Nope', details: { x: 1 } } });
    expect(unavailable('Mail').status).toBe(409);
    expect(noContent().status).toBe(204);
    expect(new StaticApiError('conflict', 'c').toResponse().status).toBe(409);
  });

  it('maps zod issues to validation details', async () => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = validationError(parsed.error);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { path: string; message: string; code: string }[] } };
    expect(body.error.details[0]?.path).toBe('name');
  });

  it('readJson requires a JSON content type and valid JSON', async () => {
    const ok = new Request('http://x/api', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(await readJson(ok)).toEqual({ a: 1 });
    const bad = new Request('http://x/api', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    await expect(readJson(bad)).rejects.toMatchObject({ code: 'bad_request' });
    const text = new Request('http://x/api', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    await expect(readJson(text)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('StaticState', () => {
  it('initializes, commits, reloads and announces slices', async () => {
    const storage = new MemoryStorage();
    const [a, b] = channelPair();
    const stateA = new StaticState(storage, { channel: a, instanceId: 'A' });
    const stateB = new StaticState(storage, { channel: b, instanceId: 'B' });
    const changed: string[][] = [];
    stateB.onExternalChange((keys) => changed.push([...keys]));

    const list = stateA.get<string[]>('things', () => []);
    list.push('one');
    await stateA.commit('things');
    expect(await storage.getJson('slice:things')).toEqual(['one']);
    // B received the announcement and reloaded the slice from storage.
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toEqual([['things']]);
    expect(stateB.get<string[]>('things', () => ['never'])).toEqual(['one']);

    await stateA.remove('things');
    expect(stateA.has('things')).toBe(false);
    expect(await storage.getJson('slice:things')).toBeUndefined();

    const fresh = new StaticState(storage, { channel: null });
    await stateA.set('other', { n: 1 });
    await stateA.commit('other');
    await fresh.loadAll();
    expect(fresh.get('other', () => null)).toEqual({ n: 1 });
  });
});

describe('IndexedDbStorage', () => {
  it('round-trips JSON and blobs in an isolated database', async () => {
    const storage = await IndexedDbStorage.open(new IDBFactory(), 'homebase-static-test');
    expect(storage.kind).toBe('indexeddb');
    await storage.setJson('a', { x: [1, 2], u: undefined });
    await storage.setJson('b', 'str');
    expect(await storage.getJson('a')).toEqual({ x: [1, 2] });
    expect(await storage.listJsonKeys()).toEqual(['a', 'b']);
    await storage.deleteJson('a');
    expect(await storage.getJson('a')).toBeUndefined();

    const bytes = new TextEncoder().encode('png-bytes');
    await storage.putBlob({ id: 'i1', kind: 'icon', type: 'image/png', bytes, width: 32, createdAt: 2 });
    await storage.putBlob({ id: 'i0', kind: 'upload', type: 'image/png', bytes, width: null, createdAt: 1 });
    const listed = await storage.listBlobs();
    expect(listed.map((b) => b.id)).toEqual(['i0', 'i1']);
    const read = await storage.getBlob('i1');
    expect(new TextDecoder().decode(read?.bytes)).toBe('png-bytes');
    expect(read?.width).toBe(32);
    expect(await blobOf(read!).text()).toBe('png-bytes');
    await storage.deleteBlob('i1');
    expect(await storage.getBlob('i1')).toBeUndefined();
    await storage.clear();
    expect(await storage.listJsonKeys()).toEqual([]);
    expect(await storage.listBlobs()).toEqual([]);
    storage.close();
  });
});

describe('AssetRegistry', () => {
  it('parses asset URLs and maps ids to object or external URLs', () => {
    expect(parseAssetUrl('/api/icons/abc%2Fd')).toEqual({ kind: 'icons', id: 'abc/d' });
    expect(parseAssetUrl('/api/uploads/u1')).toEqual({ kind: 'uploads', id: 'u1' });
    expect(parseAssetUrl('/api/other/u1')).toBeNull();
    expect(parseAssetUrl('/api/icons/u1/x')).toBeNull();

    const created: string[] = [];
    const revoked: string[] = [];
    const registry = new AssetRegistry({
      createObjectUrl: (b) => {
        const url = `blob:${b.size}-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectUrl: (u) => revoked.push(u),
    });
    const url = registry.registerBlob('icons', 'i1', new Blob(['abc']));
    expect(registry.resolve('icons', 'i1')).toBe(url);
    registry.registerExternal('icons', 'i2', 'https://icons.duckduckgo.com/ip3/example.com.ico');
    expect(registry.resolve('icons', 'i2')).toMatch(/duckduckgo/);
    registry.registerBlob('icons', 'i1', new Blob(['abcd']));
    expect(revoked).toEqual([url]);
    registry.clear();
    expect(registry.resolve('icons', 'i2')).toBeUndefined();
    expect(revoked).toHaveLength(2);
  });
});

describe('dispatch', () => {
  it('answers health, 404s unknown routes and 400s wrong methods', async () => {
    const backend = await createStaticBackend({ storage: new MemoryStorage(), channel: null, version: '1.2.3' });
    const health = await backend.fetch('/api/health');
    expect(health.status).toBe(200);
    expect(HealthResponseSchema.parse(await health.json())).toEqual({ ok: true, version: '1.2.3', vault: 'ready' });

    const missing = await backend.fetch('/api/nothing-here');
    expect(missing.status).toBe(404);
    const wrongMethod = await backend.fetch('/api/health', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(400);
    backend.close();
  });

  it('turns thrown StaticApiError into its response and other errors into 500', async () => {
    const router = new StaticRouter();
    router.get('/api/boom', () => {
      throw new StaticApiError('conflict', 'taken');
    });
    router.get('/api/crash', () => {
      throw new Error('kaboom');
    });
    const ctx = fakeContext(new StaticState(new MemoryStorage(), { channel: null }));
    expect((await dispatch(router, ctx, '/api/boom')).status).toBe(409);
    const crash = await dispatch(router, ctx, '/api/crash');
    expect(crash.status).toBe(500);
    expect(((await crash.json()) as { error: { message: string } }).error.message).toMatch(/kaboom/);
  });

  it('answers 400 (not a network error) when the request itself cannot be built', async () => {
    const backend = await createStaticBackend({ storage: new MemoryStorage(), channel: null });
    const res = await backend.fetch('/api/health', { method: 'GET', body: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
    backend.close();
  });

  it('answers requests only after reloads that another tab asked for', async () => {
    let release: () => void = () => {};
    class SlowReads extends MemoryStorage {
      gate: Promise<void> | null = null;
      override async getJson(key: string): Promise<unknown> {
        if (this.gate) await this.gate;
        return super.getJson(key);
      }
    }
    const storage = new SlowReads();
    const [a, b] = channelPair();
    const tabA = await createStaticBackend({ storage, channel: a });
    const tabB = await createStaticBackend({ storage, channel: b });
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect((await call(tabA, 'PATCH', '/api/settings', { general: { userName: 'From A' } })).status).toBe(200);
    // B's reload of `settings` is waiting on the storage read: its GET must wait for it too.
    const pending = call<Settings>(tabB, 'GET', '/api/settings');
    await flush();
    storage.gate = null;
    release();
    expect((await pending).body.general.userName).toBe('From A');
    tabA.close();
    tabB.close();
  });
});

describe('storage names', () => {
  it('namespaces the database and the cross-tab channel by the base path', () => {
    expect(STATIC_DB_NAME).toBe(`homebase-static:${import.meta.env.BASE_URL}`);
    expect(STATIC_CHANNEL_NAME).toBe(`homebase-static:${import.meta.env.BASE_URL}`);
    expect(STATIC_DB_NAME).not.toBe('homebase-static');
  });
});

describe('atomic storage batches', () => {
  const blob = (id: string): StoredBlob => ({ id, kind: 'upload', type: 'image/png', bytes: IMAGE_SAMPLES.png, width: null, createdAt: 1 });

  async function dump(storage: StaticStorage): Promise<unknown> {
    const json: Record<string, unknown> = {};
    for (const key of await storage.listJsonKeys()) json[key] = await storage.getJson(key);
    return { json, blobs: await storage.listBlobIds() };
  }

  it('MemoryStorage: a failing write rolls back every other write of the batch', async () => {
    const storage = new FlakyStorage();
    await storage.setJson('a', 1);
    await storage.putBlob(blob('old'));
    const before = await dump(storage);
    storage.failOn = (key) => key === 'c';
    await expect(
      storage.applyBatch({ json: new Map<string, unknown>([['a', 2], ['b', 3], ['c', 4]]), deleteBlobs: ['old'], putBlobs: [blob('new')] }),
    ).rejects.toThrow(/quota/);
    expect(await dump(storage)).toEqual(before);
    storage.failOn = null;
    await storage.applyBatch({ json: new Map<string, unknown>([['a', undefined], ['b', 3]]), deleteBlobs: ['old'], putBlobs: [blob('new')] });
    expect(await dump(storage)).toEqual({ json: { b: 3 }, blobs: ['new'] });
  });

  it('IndexedDbStorage: one transaction over both stores — a failing request rolls everything back', async () => {
    const storage = await IndexedDbStorage.open(new IDBFactory(), 'homebase-static-batch-test');
    await storage.setJson('a', 1);
    await storage.putBlob(blob('old'));
    const before = await dump(storage);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if ((value as { id?: string } | null)?.id === 'new') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    await expect(
      storage.applyBatch({ json: new Map<string, unknown>([['a', 2], ['b', 3]]), deleteBlobs: ['old'], putBlobs: [blob('new')] }),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    spy.mockRestore();
    expect(await dump(storage)).toEqual(before);
    await storage.applyBatch({ json: new Map<string, unknown>([['a', undefined], ['b', { x: 1, u: undefined }]]), deleteBlobs: ['old'], putBlobs: [blob('new')] });
    expect(await dump(storage)).toEqual({ json: { b: { x: 1 } }, blobs: ['new'] });
    storage.close();
  });
});

describe('a failed commit leaves memory as storage has it', () => {
  it('settings: 500, then GET still answers the stored value', async () => {
    const storage = new FlakyStorage();
    const backend = await createStaticBackend({ storage, channel: null });
    await call(backend, 'PATCH', '/api/settings', { general: { userName: 'Before' } });
    storage.failOn = (key) => key === 'slice:settings';
    const failed = await call<{ error: { code: string; message: string } }>(backend, 'PATCH', '/api/settings', { general: { userName: 'After' } });
    storage.failOn = null;
    expect(failed.status).toBe(500);
    expect(failed.body.error.message).toMatch(/storage is full/);
    expect((await call<Settings>(backend, 'GET', '/api/settings')).body.general.userName).toBe('Before');
    expect(((await storage.getJson('slice:settings')) as Settings).general.userName).toBe('Before');
    backend.close();
  });

  it('profiles + settings are one commit: a failed first profile leaves neither behind', async () => {
    const storage = new FlakyStorage();
    const backend = await createStaticBackend({ storage, channel: null });
    storage.failOn = (key) => key === 'slice:settings';
    expect((await call(backend, 'POST', '/api/profiles', { name: 'Home' })).status).toBe(500);
    storage.failOn = null;
    expect((await call<Profile[]>(backend, 'GET', '/api/profiles')).body).toEqual([]);
    expect((await call<Settings>(backend, 'GET', '/api/settings')).body.activeProfileId).toBeNull();
    expect(await storage.getJson('slice:profiles')).toBeUndefined();
    // And the retry works.
    expect((await call(backend, 'POST', '/api/profiles', { name: 'Home' })).status).toBe(201);
    expect((await call<Profile[]>(backend, 'GET', '/api/profiles')).body.map((p) => p.name)).toEqual(['Home']);
    backend.close();
  });

  it('an upload whose write fails leaves neither bytes nor metadata', async () => {
    const storage = new FlakyStorage();
    const backend = await createStaticBackend({ storage, channel: null });
    storage.failOn = (key) => key.startsWith('blob:');
    expect((await call(backend, 'POST', '/api/uploads', fileForm(IMAGE_SAMPLES.png))).status).toBe(500);
    storage.failOn = null;
    expect(getUploads(backend.ctx)).toEqual([]);
    expect(await storage.listBlobIds()).toEqual([]);
    expect(backend.ctx.assets.blobIds('uploads')).toEqual([]);
    backend.close();
  });

  it('works without reading storage back (a closed IndexedDB connection)', async () => {
    const storage = await IndexedDbStorage.open(new IDBFactory(), 'homebase-static-closed-test');
    const backend = await createStaticBackend({ storage, channel: null });
    await call(backend, 'PATCH', '/api/settings', { general: { userName: 'Before' } });
    storage.close();
    expect((await call(backend, 'PATCH', '/api/settings', { general: { userName: 'After' } })).status).toBe(500);
    expect((await call<Settings>(backend, 'GET', '/api/settings')).body.general.userName).toBe('Before');
    backend.close();
  });

  it('snapshots every slice before writing: a reload during the write does not change what is stored', async () => {
    let state: StaticState | null = null;
    class Interfering extends MemoryStorage {
      override async setJson(key: string, value: unknown): Promise<void> {
        // Another tab's reload replaces `b` while `a` is being written.
        if (key === 'slice:a') state?.set('b', ['reloaded']);
        return super.setJson(key, value);
      }
    }
    const storage = new Interfering();
    state = new StaticState(storage, { channel: null });
    state.set('a', ['mine']);
    state.set('b', ['mine too']);
    await state.commit('a', 'b');
    expect(await storage.getJson('slice:b')).toEqual(['mine too']);
  });
});

describe('startup never fails on bad stored data', () => {
  it('an empty or over-long activeProfileId becomes null; other settings are kept', async () => {
    for (const activeProfileId of ['', 'x'.repeat(513)]) {
      const storage = new MemoryStorage();
      await storage.setJson('slice:settings', { general: { userName: 'X' }, activeProfileId });
      const backend = await createStaticBackend({ storage, channel: null });
      const settings = await call<Settings>(backend, 'GET', '/api/settings');
      expect(settings.status).toBe(200);
      expect(settings.body.activeProfileId).toBeNull();
      expect(settings.body.general.userName).toBe('X');
      expect(getSettings(backend.ctx).activeProfileId).toBeNull();
      backend.close();
    }
  });

  it('slices of the wrong shape (another build, corruption) are repaired instead of throwing', async () => {
    const storage = new MemoryStorage();
    await storage.setJson('slice:uploads', { not: 'an array' });
    await storage.setJson('slice:profiles', 'garbage');
    await storage.setJson('slice:bookmarks', [1, 2, 3]);
    await storage.setJson('slice:icons', [{ id: 'ok', type: 'image/png', width: null, createdAt: 1, orphanedAt: null }, 'bad']);
    await storage.setJson('slice:todoist-token', { token: 42, generation: 7 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = await createStaticBackend({ storage, channel: null });
    expect((await call(backend, 'GET', '/api/health')).status).toBe(200);
    expect((await call<Profile[]>(backend, 'GET', '/api/profiles')).body).toEqual([]);
    expect((await call<{ groups: unknown[] }>(backend, 'GET', '/api/bookmarks')).body.groups).toEqual([]);
    expect(getUploads(backend.ctx)).toEqual([]);
    expect(getIcons(backend.ctx).every((i) => typeof i.id === 'string')).toBe(true);
    expect((await call(backend, 'GET', '/api/todoist/token')).status).toBe(200);
    backend.close();
  });

  it('a module whose ready() throws is logged and the others still start', async () => {
    const ran: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const modules: HandlerModule[] = [
      { register: () => {}, ready: () => void ran.push('first') },
      {
        register: () => {},
        ready: () => {
          throw new Error('broken');
        },
      },
      { register: () => {}, ready: async () => void ran.push('third') },
    ];
    await onBackendReady(fakeContext(new StaticState(new MemoryStorage(), { channel: null })), modules);
    expect(ran).toEqual(['first', 'third']);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('the page backend', () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  class BrokenStorage extends MemoryStorage {
    closed = 0;
    override async listJsonKeys(): Promise<string[]> {
      throw new Error('cannot read');
    }
    close(): void {
      this.closed++;
    }
  }

  it('retries a failed start with backoff instead of on every call, and reports it', async () => {
    let now = 1_000;
    let opens = 0;
    let broken = true;
    const brokenStorage = new BrokenStorage();
    restore = configurePageBackendForTests({
      now: () => now,
      openStorage: async () => {
        opens++;
        return broken ? brokenStorage : new MemoryStorage();
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureStaticBackend()).rejects.toThrow('cannot read');
    expect(opens).toBe(1);
    expect(brokenStorage.closed).toBe(1);
    expect(getStaticBackendStatus()).toMatchObject({ state: 'failed', message: 'cannot read', retryAt: 1_000 + START_RETRY_BASE_MS });
    // Within the delay no new attempt is made (no IndexedDB reopen per API call).
    await expect(ensureStaticBackend()).rejects.toThrow('cannot read');
    expect(opens).toBe(1);
    // After it, a new attempt; a second failure doubles the delay.
    now += START_RETRY_BASE_MS;
    await expect(ensureStaticBackend()).rejects.toThrow('cannot read');
    expect(opens).toBe(2);
    expect(getStaticBackendStatus()).toMatchObject({ state: 'failed', retryAt: now + 2 * START_RETRY_BASE_MS });
    now += 2 * START_RETRY_BASE_MS;
    broken = false;
    const backend = await ensureStaticBackend();
    expect(opens).toBe(3);
    expect(getStaticBackendStatus()).toEqual({ state: 'ready', storage: 'memory' });
    expect(await ensureStaticBackend()).toBe(backend);
  });

  it("reports when another tab upgrades or deletes the database (writes then fail, memory stays consistent)", async () => {
    const factory = new IDBFactory();
    const name = 'homebase-static-versionchange-test';
    restore = configurePageBackendForTests({ openStorage: () => IndexedDbStorage.open(factory, name) });
    const backend = await ensureStaticBackend();
    expect(getStaticBackendStatus()).toEqual({ state: 'ready', storage: 'indexeddb' });
    await call(backend, 'PATCH', '/api/settings', { general: { userName: 'Before' } });

    // A newer build opens the database at a higher version in another tab.
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(name, STATIC_DB_VERSION + 1);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    expect(getStaticBackendStatus()).toEqual({ state: 'closed', storage: 'indexeddb' });
    const failed = await call<{ error: { message: string } }>(backend, 'PATCH', '/api/settings', { general: { userName: 'After' } });
    expect(failed.status).toBe(500);
    expect(failed.body.error.message).toMatch(/another tab/);
    expect((await call<Settings>(backend, 'GET', '/api/settings')).body.general.userName).toBe('Before');
  });
});

describe('cross-tab images', () => {
  it('registers images another tab added before telling the app, and revokes removed ones', async () => {
    const storage = new MemoryStorage();
    const [a, b] = channelPair();
    const tabA = await createStaticBackend({ storage, channel: a, assets: testAssets() });
    const tabB = await createStaticBackend({ storage, channel: b, assets: testAssets() });
    const seen: { keys: string[]; upload: string | undefined; icon: string | undefined }[] = [];
    let uploadId = '';
    let iconId = '';
    tabB.onExternalChange((keys) => {
      seen.push({ keys: [...keys], upload: tabB.ctx.assets.resolve('uploads', uploadId), icon: iconId ? tabB.ctx.assets.resolve('icons', iconId) : undefined });
    });

    // A background image: uploaded (not shown yet), then referenced by the settings.
    uploadId = (await call<{ id: string }>(tabA, 'POST', '/api/uploads', fileForm(IMAGE_SAMPLES.jpeg))).body.id;
    await call(tabA, 'PATCH', '/api/settings', {
      appearance: { background: { type: 'image', uploadId, blur: 0, dim: 0, angle: null, stops: null } },
    });
    await flush();
    const settingsChange = seen.find((s) => s.keys.includes(SLICE.settings));
    expect(settingsChange?.upload).toMatch(/^blob:test\//);

    // A custom bookmark icon.
    const group = (await call<{ id: string }>(tabA, 'POST', '/api/bookmark-groups', { name: 'G' })).body;
    const bookmark = (await call<{ id: string }>(tabA, 'POST', '/api/bookmarks', { groupId: group.id, title: 'Site', url: 'https://example.com/' })).body;
    const withIcon = await call<{ iconId: string }>(tabA, 'POST', `/api/bookmarks/${bookmark.id}/icon`, fileForm(IMAGE_SAMPLES.png));
    expect(withIcon.status).toBe(200);
    iconId = getIcons(tabA.ctx)[0]!.id;
    await flush();
    const iconChange = seen.find((s) => s.keys.includes(SLICE.icons));
    expect(iconChange).toBeDefined();
    expect(tabB.ctx.assets.resolve('icons', iconId)).toMatch(/^blob:test\//);

    // Removed in A (e.g. by the icon/upload garbage collection): revoked in B.
    tabA.ctx.state.set(SLICE.icons, []);
    tabA.ctx.state.set(SLICE.uploads, []);
    await tabA.ctx.state.commit(SLICE.icons, SLICE.uploads);
    await flush();
    expect(tabB.ctx.assets.resolve('icons', iconId)).toBeUndefined();
    expect(tabB.ctx.assets.resolve('uploads', uploadId)).toBeUndefined();
    tabA.close();
    tabB.close();
  });
});
