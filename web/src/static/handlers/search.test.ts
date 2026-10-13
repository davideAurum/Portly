/**
 * Static backend: search suggestions (`GET /api/search/suggest`). Port of
 * server/src/modules/search/search.test.ts with the browser twist: only Wikipedia is asked (with
 * `origin=*`), the other providers answer `[]` without a request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUGGEST_PROVIDERS, type SuggestProvider } from '@homebase/shared';
import { createFakeFetch, failingFetch, hangingFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { browserSuggestUrl, isBrowserSuggestProvider, normalizeQuery, parseSuggestions, suggestUrl } from '../providers/suggest.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import { getSettings } from '../slices.ts';
import * as core from './core.ts';
import * as search from './search.ts';
import * as todoist from './todoist.ts';
import * as weather from './weather.ts';

/** Provider response shapes as documented (OpenSearch suggestions: `[query, [suggestions], ...]`). */
const FIXTURES: Record<SuggestProvider, { match: RegExp; body: unknown }> = {
  google: {
    match: /^https:\/\/suggestqueries\.google\.com\/complete\/search\?client=firefox&q=/,
    body: ['cats', ['cats', 'cats musical', 'cat food', 'cats the jellicle ball'], [], { 'google:suggestsubtypes': [[512], [512]] }],
  },
  youtube: {
    match: /^https:\/\/suggestqueries\.google\.com\/complete\/search\?client=firefox&ds=yt&q=/,
    body: ['cats', ['cats funny', 'cats compilation']],
  },
  ddg: { match: /^https:\/\/duckduckgo\.com\/ac\/\?type=list&q=/, body: ['cats', ['cats', 'catsby', 'cats movie']] },
  bing: { match: /^https:\/\/api\.bing\.com\/osjson\.aspx\?query=/, body: ['cats', ['cats', 'cats the musical', 'cats protection']] },
  wikipedia: {
    match: /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?action=opensearch&format=json&namespace=0&limit=8&search=/,
    body: ['cats', ['Cats (musical)', 'Cats (2019 film)'], ['', ''], ['https://en.wikipedia.org/wiki/Cats_(musical)', 'https://en.wikipedia.org/wiki/Cats_(2019_film)']],
  },
};

const WIKI_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

describe('search: suggestion parsing (copied server logic)', () => {
  it('takes index 1, strings only, trimmed, de-duplicated, at most 8', () => {
    expect(parseSuggestions(['q', [' a ', 'A', 'b', 3, null, '', 'c\u0000d', 'e', 'f', 'g', 'h', 'i', 'j']])).toEqual(['a', 'b', 'c d', 'e', 'f', 'g', 'h', 'i']);
    expect(parseSuggestions({ not: 'an array' })).toEqual([]);
    expect(parseSuggestions(['q', 'not a list'])).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
  });

  it('builds provider URLs with the query URI-encoded', () => {
    expect(suggestUrl('google', 'a&b c')).toBe('https://suggestqueries.google.com/complete/search?client=firefox&q=a%26b%20c');
    expect(suggestUrl('wikipedia', 'x/y')).toContain('search=x%2Fy');
  });

  it('adds origin=* for Wikipedia only (MediaWiki CORS) and knows which providers a browser can call', () => {
    expect(browserSuggestUrl('wikipedia', 'cats')).toBe(`${suggestUrl('wikipedia', 'cats')}&origin=*`);
    expect(browserSuggestUrl('google', 'cats')).toBe(suggestUrl('google', 'cats'));
    expect(SUGGEST_PROVIDERS.filter(isBrowserSuggestProvider)).toEqual(['wikipedia']);
  });

  it('normalizes queries: trimmed, ≤ 200 characters', () => {
    expect(normalizeQuery('  hi  ')).toBe('hi');
    expect(Array.from(normalizeQuery('😀'.repeat(300)))).toHaveLength(200);
    expect(normalizeQuery(undefined)).toBe('');
  });
});

describe('search: GET /api/search/suggest', () => {
  let t: TestBackend;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    t?.close();
  });

  const setup = async (routes: FakeFetchRoute[]) => {
    const fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([search]);
    const get = async (query: string) => {
      const res = await t.call('GET', `/api/search/suggest?${query}`);
      return { status: res.status, body: (await res.json()) as unknown, res };
    };
    return { get, fake };
  };

  it('asks Wikipedia from the browser with origin=* and no custom headers (a simple CORS request)', async () => {
    const { get, fake } = await setup([{ match: FIXTURES.wikipedia.match, respond: { json: FIXTURES.wikipedia.body, headers: WIKI_HEADERS } }]);
    const res = await get('provider=wikipedia&q=cats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Cats (musical)', 'Cats (2019 film)']);
    expect(res.res.headers.get('content-type')).toContain('application/json');
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe('https://en.wikipedia.org/w/api.php');
    expect(url.searchParams.get('origin')).toBe('*');
    expect(url.searchParams.get('search')).toBe('cats');
    expect(url.searchParams.get('limit')).toBe('8');
    expect([...call.headers.keys()]).toEqual([]);
    expect(call.init.credentials).toBe('omit');
  });

  it.each(SUGGEST_PROVIDERS.filter((p) => p !== 'wikipedia'))('answers [] for %s without any request (no CORS from a browser)', async (provider) => {
    const { get, fake } = await setup([{ match: FIXTURES[provider].match, respond: { json: FIXTURES[provider].body } }]);
    const res = await get(`provider=${provider}&q=cats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('caches answers for 5 minutes per provider and lower-cased query', async () => {
    const { get, fake } = await setup([{ match: FIXTURES.wikipedia.match, respond: { json: FIXTURES.wikipedia.body } }]);
    await get('provider=wikipedia&q=cats');
    await get('provider=wikipedia&q=%20Cats%20');
    expect(fake.calls).toHaveLength(1);
    expect(search.suggestCache(t.ctx).get('search:suggest:wikipedia:cats')).toEqual(['Cats (musical)', 'Cats (2019 film)']);
    t.tick(search.SUGGEST_CACHE_TTL_MS - 1);
    await get('provider=wikipedia&q=cats');
    expect(fake.calls).toHaveLength(1);
    t.tick(2);
    await get('provider=wikipedia&q=cats');
    expect(fake.calls).toHaveLength(2);
  });

  it('answers [] without any request for an empty query or when suggestions are disabled', async () => {
    const { get, fake } = await setup([]);
    expect((await get('provider=wikipedia&q=')).body).toEqual([]);
    expect((await get('provider=wikipedia&q=%20%20')).body).toEqual([]);
    expect((await get('provider=wikipedia')).body).toEqual([]);
    getSettings(t.ctx).search.suggestionsEnabled = false;
    expect((await get('provider=wikipedia&q=cats')).body).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('caps the query at 200 characters', async () => {
    const { get, fake } = await setup([{ match: FIXTURES.wikipedia.match, respond: { json: ['x', []] } }]);
    await get(`provider=wikipedia&q=${'a'.repeat(500)}`);
    const sent = new URL(fake.calls[0]!.url).searchParams.get('search');
    expect(sent).toBe('a'.repeat(200));
  });

  it('rejects unknown providers and over-long raw queries (422 validation_failed, "Invalid query")', async () => {
    const { get, fake } = await setup([]);
    const res = await get('provider=altavista&q=cats');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed', message: 'Invalid query', details: [{ path: 'provider' }] } });
    const missing = await get('q=cats');
    expect(missing.status).toBe(422);
    const huge = await get(`provider=wikipedia&q=${'a'.repeat(10_001)}`);
    expect(huge.status).toBe(422);
    expect(fake.calls).toHaveLength(0);
  });

  it('turns upstream failures (non-2xx, bad JSON) into [] and does not cache them', async () => {
    const { get, fake } = await setup([
      { match: FIXTURES.wikipedia.match, respond: { status: 503, text: 'unavailable' }, times: 1 },
      { match: FIXTURES.wikipedia.match, respond: { text: 'not json' }, times: 1 },
      { match: FIXTURES.wikipedia.match, respond: { json: FIXTURES.wikipedia.body } },
    ]);
    expect(await get('provider=wikipedia&q=cats')).toMatchObject({ status: 200, body: [] });
    expect(await get('provider=wikipedia&q=cats')).toMatchObject({ status: 200, body: [] });
    expect((await get('provider=wikipedia&q=cats')).body).toEqual(['Cats (musical)', 'Cats (2019 film)']);
    expect(fake.calls).toHaveLength(3);
  });

  it('answers [] on a network/CORS failure (never a thrown TypeError, never network_error)', async () => {
    vi.stubGlobal('fetch', failingFetch);
    t = await createTestBackend([search]);
    const res = await t.call('GET', '/api/search/suggest?provider=wikipedia&q=cats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('answers [] when Wikipedia does not answer within 4 s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch);
    t = await createTestBackend([search]);
    const pending = t.call('GET', '/api/search/suggest?provider=wikipedia&q=cats');
    await vi.advanceTimersByTimeAsync(3_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  describe('one caller cancelling the shared lookup (server parity: the lookup takes no caller signal)', () => {
    const PATH = '/api/search/suggest?provider=wikipedia&q=cats';
    const LIST = ['Cats (musical)', 'Cats (2019 film)'];

    /** Wikipedia answering only when released and, like fetch, honouring its signal meanwhile. */
    const gatedSetup = async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { fake } = await setup([
        {
          match: FIXTURES.wikipedia.match,
          respond: (req) =>
            new Promise((resolve, reject) => {
              const signal = req.init.signal;
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
              void gate.then(() => resolve({ json: FIXTURES.wikipedia.body }));
            }),
        },
      ]);
      return { fake, release };
    };

    it('aborting one request never turns the others into [] (and the answer is cached)', async () => {
      const { fake, release } = await gatedSetup();
      const first = new AbortController();
      const abandoned = t.fetch(PATH, { method: 'GET', signal: first.signal });
      const waiting = t.fetch(PATH, { method: 'GET', signal: new AbortController().signal });
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      first.abort();
      release();
      expect(await (await waiting).json()).toEqual(LIST);
      // The abandoned request is answered too; its caller (a superseded keystroke) no longer listens.
      expect(await (await abandoned).json()).toEqual(LIST);
      expect(fake.calls).toHaveLength(1);
      expect(search.suggestCache(t.ctx).get('search:suggest:wikipedia:cats')).toEqual(LIST);
    });

    it('a request issued right after an aborted one for the same query gets the suggestions', async () => {
      const { fake, release } = await gatedSetup();
      const cancelled = new AbortController();
      const abandoned = t.fetch(PATH, { method: 'GET', signal: cancelled.signal });
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      cancelled.abort();
      const retry = t.fetch(PATH, { method: 'GET', signal: new AbortController().signal });
      release();
      expect(await (await retry).json()).toEqual(LIST);
      expect((await abandoned).status).toBe(200);
      expect(fake.calls).toHaveLength(1);
    });
  });

  it('registers next to the other provider modules without route conflicts', async () => {
    t = await createTestBackend([core, search, weather, todoist]);
    expect(t.router.list()).toEqual(
      expect.arrayContaining([
        'GET /api/health',
        'GET /api/search/suggest',
        'GET /api/weather',
        'GET /api/weather/geocode',
        'GET /api/todoist/token',
        'PUT /api/todoist/token',
        'DELETE /api/todoist/token',
        'GET /api/todoist/tasks',
        'POST /api/todoist/tasks',
        'POST /api/todoist/tasks/:id/close',
        'POST /api/todoist/tasks/:id/reopen',
        'PATCH /api/todoist/tasks/:id',
        'GET /api/todoist/projects',
      ]),
    );
    // A wrong method on a known path is 400, an unknown path 404 (dispatch loop semantics).
    expect((await t.call('POST', '/api/weather')).status).toBe(400);
    expect((await t.call('GET', '/api/todoist/nope')).status).toBe(404);
  });
});
