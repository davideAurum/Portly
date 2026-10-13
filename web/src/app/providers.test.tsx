import { QueryObserver, dehydrate, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../api/keys.ts';
import { settings } from '../test/fixtures.ts';
import {
  APP_VERSION,
  LOCAL_SERVER_QUERY_CACHE_KEY,
  LOCAL_SERVER_QUERY_CACHE_MAX_AGE_MS,
  MAX_PERSISTED_QUERY_CHARS,
  PERSIST_DEHYDRATE_OPTIONS,
  QUERY_CACHE_MAX_AGE_MS,
  createQueryClient,
  createQueryPersister,
  persistOptionsFor,
  persistOptionsOf,
  refreshAfterRestore,
  restorePersistedCache,
} from './providers.tsx';

describe('query client (§10.1)', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('keeps talking to the local server while the browser reports offline', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    const query = client.fetchQuery({ queryKey: ['local'], queryFn: async () => 'ok' });
    expect(client.getQueryState(['local'])?.fetchStatus).not.toBe('paused');
    await expect(query).resolves.toBe('ok');

    const mutation = client.getMutationCache().build(client, { mutationFn: async (n: number) => n + 1 });
    await expect(mutation.execute(1)).resolves.toBe(2);
  });

  it('marks restored data stale so a new tab refetches it even inside its staleTime', async () => {
    const client = createQueryClient();
    const queryFn = vi.fn(async () => settings({ activeProfileId: 'from-server' }));
    // Restored from localStorage moments ago (fresh by staleTime), then observed by the app.
    client.setQueryData(qk.settings(), settings({ activeProfileId: 'from-another-tab' }));
    const observer = new QueryObserver(client, { queryKey: qk.settings(), queryFn, staleTime: 60_000 });
    const unsubscribe = observer.subscribe(() => {});
    expect(queryFn).not.toHaveBeenCalled();

    await refreshAfterRestore(client);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<{ activeProfileId: string }>(qk.settings())?.activeProfileId).toBe('from-server');
    unsubscribe();
  });

  it('persists ordinary queries but never mail, opted-out queries or mutations', async () => {
    const client = createQueryClient();
    client.setQueryData(qk.settings(), settings());
    client.setQueryData(qk.mail.summary(), [{ subject: 'Your bank statement' }]);
    await client.fetchQuery({ queryKey: qk.health(), queryFn: async () => ({ vault: 'locked' }), meta: { persist: false } });

    // A mutation carrying a password that got paused (e.g. offline) must not be written out.
    onlineManager.setOnline(false);
    const paused = client.getMutationCache().build(client, { mutationFn: async () => null, networkMode: 'online' });
    void paused.execute({ email: 'me@yahoo.com', appPassword: 'hunter2-app-password' });
    await Promise.resolve();
    expect(paused.state.isPaused).toBe(true);

    const persisted = dehydrate(client, PERSIST_DEHYDRATE_OPTIONS);
    expect(persisted.queries.map((q) => q.queryKey)).toEqual([qk.settings()]);
    expect(persisted.mutations).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain('hunter2');
    expect(JSON.stringify(persisted)).not.toContain('bank statement');
  });
});

describe('persisted cache size (WEB-1, DOS-3)', () => {
  it('skips oversized queries, site-meta lookups and calendar ranges nobody is showing', () => {
    const client = createQueryClient();
    const range = qk.calendar.events('2026-09-21', '2026-09-28', 'America/Chicago');
    const other = qk.calendar.events('2026-10-05', '2026-10-12', 'America/Chicago');
    client.setQueryData(qk.settings(), settings());
    client.setQueryData(qk.bookmarks.siteMeta('https://example.com/'), { title: 'Example', iconId: null });
    client.setQueryData(range, { events: [], window: { from: '2026-08-27', to: '2027-09-26' } });
    client.setQueryData(other, { events: [], window: { from: '2026-08-27', to: '2027-09-26' } });
    client.setQueryData(['calendar', 'calendars'], [{ description: 'x'.repeat(MAX_PERSISTED_QUERY_CHARS + 1) }]);
    const observer = new QueryObserver(client, { queryKey: range, queryFn: async () => ({ events: [] }), enabled: false });
    const unsubscribe = observer.subscribe(() => {});

    const persisted = dehydrate(client, PERSIST_DEHYDRATE_OPTIONS).queries.map((q) => q.queryKey);
    expect(persisted).toEqual([qk.settings(), range]);
    unsubscribe();
  });

  it('on a storage quota error drops the oldest queries until the snapshot fits', async () => {
    const written: string[] = [];
    const quota = 2_000;
    const storage = {
      setItem: (_key: string, value: string) => {
        if (value.length > quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        written.push(value);
      },
      getItem: () => null,
      removeItem: () => {},
    } as unknown as Storage;
    const persister = createQueryPersister(storage, 0);

    const client = createQueryClient();
    client.setQueryData(['old-and-big'], 'x'.repeat(3_000), { updatedAt: 1 });
    client.setQueryData(qk.settings(), settings(), { updatedAt: 2 });
    await persister.persistClient({ buster: 'b', timestamp: Date.now(), clientState: dehydrate(client, PERSIST_DEHYDRATE_OPTIONS) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(written).toHaveLength(1);
    const saved = JSON.parse(written[0]!) as { clientState: { queries: { queryKey: unknown[] }[] } };
    expect(saved.clientState.queries.map((q) => q.queryKey)).toEqual([qk.settings()]);
  });
});

/** An in-memory Storage that refuses writes past `quota` characters in total (like localStorage). */
function quotaStorage(quota: number) {
  const items = new Map<string, string>();
  const used = (except: string) => [...items].reduce((n, [key, value]) => (key === except ? n : n + value.length), 0);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (used(key) + value.length > quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  } as unknown as Storage;
  return { storage, items };
}

describe('persisted cache per backend (hybrid mode)', () => {
  it("keeps the server build's snapshot as it was", () => {
    const persist = persistOptionsFor('server', null, { pagesBuild: false, storage: quotaStorage(1e6).storage });
    expect(persist.key).toBe('portly:query-cache');
    expect(persist.buster).toBe(APP_VERSION);
    expect(persist.maxAge).toBe(QUERY_CACHE_MAX_AGE_MS);
    expect(persist.dehydrateOptions).toBe(PERSIST_DEHYDRATE_OPTIONS);
  });

  it("gives the Pages build's two backends their own keys, busters and lifetimes", () => {
    const { storage } = quotaStorage(1e6);
    const browser = persistOptionsFor('browser', null, { pagesBuild: true, storage });
    expect(browser.key).toBe('portly:query-cache:static:/');
    expect(browser.buster).toBe(`${APP_VERSION}+static`);
    expect(browser.maxAge).toBe(QUERY_CACHE_MAX_AGE_MS);

    const server = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage });
    expect(server.key).toBe(LOCAL_SERVER_QUERY_CACHE_KEY);
    expect(server.key).toBe('portly:query-cache:local-server:/');
    expect(server.buster).toBe(`${APP_VERSION}+local-server:instance-1`);
    expect(server.maxAge).toBe(LOCAL_SERVER_QUERY_CACHE_MAX_AGE_MS);
    // Another server instance's snapshot is discarded on restore.
    expect(persistOptionsFor('server', 'instance-2', { pagesBuild: true, storage }).buster).not.toBe(server.buster);
  });

  it('hands out one options object per key and buster on the page storage', () => {
    expect(persistOptionsFor('server', 'instance-1', { pagesBuild: true })).toBe(persistOptionsFor('server', 'instance-1', { pagesBuild: true }));
    expect(persistOptionsFor('server', 'instance-1', { pagesBuild: true })).not.toBe(persistOptionsFor('server', 'instance-2', { pagesBuild: true }));
  });

  it('never persists accounts or OAuth clients from a server-backend Pages page (nor mail)', () => {
    const client = createQueryClient();
    client.setQueryData(qk.settings(), settings());
    client.setQueryData(qk.accounts(), [{ id: 'a1', email: 'me@example.com' }]);
    client.setQueryData(qk.oauthClients.all(), [{ provider: 'google', clientId: 'id' }]);
    client.setQueryData(qk.mail.summary(), [{ subject: 'Your bank statement' }]);

    const remote = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage: quotaStorage(1e6).storage });
    expect(dehydrate(client, remote.dehydrateOptions).queries.map((q) => q.queryKey)).toEqual([qk.settings()]);
    // The server build's own origin keeps them.
    const own = persistOptionsFor('server', null, { pagesBuild: false, storage: quotaStorage(1e6).storage });
    expect(dehydrate(client, own.dehydrateOptions).queries.map((q) => q.queryKey)).toEqual([qk.settings(), qk.accounts(), qk.oauthClients.all()]);
  });

  it("on a quota error drops the other backend's snapshot before trimming its own", async () => {
    vi.useFakeTimers();
    const { storage, items } = quotaStorage(3_000);
    items.set('portly:query-cache:static:/', 'b'.repeat(2_000));
    const remote = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage });

    const client = createQueryClient();
    client.setQueryData(['older'], 'x'.repeat(500), { updatedAt: 1 });
    client.setQueryData(qk.settings(), settings(), { updatedAt: 2 });
    await remote.persister.persistClient({ buster: remote.buster, timestamp: Date.now(), clientState: dehydrate(client, remote.dehydrateOptions) });
    // The persister writes at most once a second.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(items.has('portly:query-cache:static:/')).toBe(false);
    const saved = JSON.parse(items.get(LOCAL_SERVER_QUERY_CACHE_KEY)!) as { clientState: { queries: { queryKey: unknown[] }[] } };
    // Both queries kept: freeing the other snapshot was enough.
    expect(saved.clientState.queries.map((q) => q.queryKey)).toEqual([['older'], qk.settings()]);
  });

  it('binds the options to the client on the first restore', async () => {
    const { storage } = quotaStorage(1e6);
    const remote = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage });
    const client = createQueryClient();
    await restorePersistedCache(client, remote);
    expect(persistOptionsOf(client)).toBe(remote);
    // Later callers cannot switch the client to the other backend's snapshot.
    await restorePersistedCache(client, persistOptionsFor('browser', null, { pagesBuild: true, storage }));
    expect(persistOptionsOf(client)).toBe(remote);
    // A client nobody restored uses the build's default (the server build here).
    expect(persistOptionsOf(createQueryClient()).key).toBe('portly:query-cache');
  });
});
