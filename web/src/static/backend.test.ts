/**
 * The in-browser backend's diagnostic events (`backend`): a start that failed, a database closed
 * under the page, a handler that crashed or found storage full (named by its route pattern, never
 * the request's path or query), and a module whose `ready()` failed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClientEvents } from '../diagnostics/clientLog.ts';
import { AssetRegistry } from './assets.ts';
import { configurePageBackendForTests, dispatch, ensureStaticBackend } from './backend.ts';
import type { StaticContext } from './context.ts';
import { onBackendReady, type HandlerModule } from './handlers/index.ts';
import { StaticRouter } from './router.ts';
import { StaticState } from './state.ts';
import { MemoryStorage } from './storage/memory.ts';

const events = () => getClientEvents().map((entry) => entry.event);

function fakeContext(): StaticContext {
  return {
    state: new StaticState(new MemoryStorage(), { channel: null }),
    assets: new AssetRegistry(),
    version: '0.0.0-test',
    now: () => 1_700_000_000_000,
    newId: () => '00000000-0000-4000-8000-000000000001',
    appUrl: 'http://localhost:5173/',
  };
}

let restore: () => void = () => {};

afterEach(() => {
  restore();
  restore = () => {};
});

describe('backend events', () => {
  it('a start that failed, with its attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restore = configurePageBackendForTests({
      openStorage: async () => {
        throw new DOMException('The user denied permission to access the database.', 'SecurityError');
      },
    });
    await expect(ensureStaticBackend()).rejects.toThrow();
    expect(events()).toEqual([
      expect.objectContaining({ level: 'error', cat: 'backend', msg: 'in-browser backend could not start', fields: { errName: 'SecurityError', attempt: 1, op: 'start' } }),
    ]);
  });

  it('a database closed under the page', async () => {
    let closed: () => void = () => {};
    class ClosableStorage extends MemoryStorage {
      onClosed(listener: () => void): () => void {
        closed = listener;
        return () => {};
      }
    }
    restore = configurePageBackendForTests({ openStorage: async () => new ClosableStorage() });
    await ensureStaticBackend();
    closed();
    expect(events()).toEqual([expect.objectContaining({ level: 'warn', cat: 'backend', fields: { op: 'closed' } })]);
  });

  it('a crashing handler: the route pattern, never the path or the query', async () => {
    const router = new StaticRouter();
    router.get('/api/things/:id', () => {
      throw new RangeError('Invalid array length');
    });
    router.post('/api/things', () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const ctx = fakeContext();
    expect((await dispatch(router, ctx, '/api/things/secret-id?q=private')).status).toBe(500);
    expect((await dispatch(router, ctx, '/api/things', { method: 'POST', body: '{}' })).status).toBe(500);
    expect(events().map((event) => [event.level, event.msg, event.fields])).toEqual([
      ['error', 'in-browser backend request failed', { errName: 'RangeError', op: 'GET /api/things/:id' }],
      ['error', 'browser storage is full', { errName: 'QuotaExceededError', op: 'POST /api/things' }],
    ]);
    expect(JSON.stringify(events())).not.toMatch(/secret|private/);
  });

  it('a module whose ready() failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const modules: HandlerModule[] = [
      {
        register: () => {},
        ready: () => {
          throw new TypeError('x is undefined');
        },
      },
    ];
    await onBackendReady(fakeContext(), modules);
    expect(events()).toEqual([expect.objectContaining({ level: 'error', cat: 'backend', fields: { errName: 'TypeError', op: 'ready module' } })]);
  });
});
