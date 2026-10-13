import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SUGGEST_PROVIDERS, type SuggestProvider } from '@homebase/shared';
import { createApp } from '../../app.ts';
import { createMemoryLogger } from '../../lib/logger.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import { createTestContext, type TestContext } from '../../testing/test-context.ts';
import { testRequest } from '../../testing/test-request.ts';
import { prefixes, register } from './index.ts';
import { normalizeQuery, parseSuggestions, suggestUrl } from './suggest.ts';

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

describe('search: suggestion parsing', () => {
  it('takes index 1, strings only, trimmed, de-duplicated, at most 8', () => {
    expect(parseSuggestions(['q', [' a ', 'A', 'b', 3, null, '', 'c\u0000d', 'e', 'f', 'g', 'h', 'i', 'j']])).toEqual([
      'a',
      'b',
      'c d',
      'e',
      'f',
      'g',
      'h',
      'i',
    ]);
    expect(parseSuggestions({ not: 'an array' })).toEqual([]);
    expect(parseSuggestions(['q', 'not a list'])).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
  });

  it('builds provider URLs with the query URI-encoded', () => {
    expect(suggestUrl('google', 'a&b c')).toBe('https://suggestqueries.google.com/complete/search?client=firefox&q=a%26b%20c');
    expect(suggestUrl('wikipedia', 'x/y')).toContain('search=x%2Fy');
  });

  it('normalizes queries: trimmed, ≤ 200 characters', () => {
    expect(normalizeQuery('  hi  ')).toBe('hi');
    expect(Array.from(normalizeQuery('😀'.repeat(300)))).toHaveLength(200);
    expect(normalizeQuery(undefined)).toBe('');
  });
});

describe('search: GET /api/search/suggest', () => {
  let ctx: TestContext;
  afterEach(() => {
    ctx.close();
    fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
  });

  const setup = (routes: FakeFetchRoute[], log = createMemoryLogger()) => {
    ctx = createTestContext({ fetchRoutes: routes, log });
    const { app } = createApp(ctx, { modules: [{ name: 'search', prefixes, register }], webDist: null });
    const get = async (query: string) => {
      const res = await testRequest(app, 'GET', `/api/search/suggest?${query}`);
      return { status: res.status, body: (await res.json()) as unknown, res };
    };
    return { get, log };
  };

  it.each(SUGGEST_PROVIDERS)('parses the %s provider response', async (provider) => {
    const fixture = FIXTURES[provider];
    const { get } = setup([{ match: fixture.match, respond: { json: fixture.body, headers: { 'content-type': 'text/javascript; charset=UTF-8' } } }]);
    const res = await get(`provider=${provider}&q=cats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual((fixture.body as [string, string[]])[1]);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    const call = ctx.fakeFetch!.calls[0]!;
    expect(call.headers.get('user-agent')).toMatch(/^Homebase\//);
  });

  it('caches answers for 5 minutes per provider and query', async () => {
    const { get } = setup([{ match: FIXTURES.ddg.match, respond: { json: FIXTURES.ddg.body } }]);
    await get('provider=ddg&q=cats');
    await get('provider=ddg&q=%20Cats%20');
    expect(ctx.fakeFetch!.calls).toHaveLength(1);
    expect(ctx.cache.get('search:suggest:ddg:cats')).toEqual(['cats', 'catsby', 'cats movie']);
  });

  it('answers [] without any request for an empty query or when suggestions are disabled', async () => {
    const { get } = setup([]);
    expect((await get('provider=google&q=')).body).toEqual([]);
    expect((await get('provider=google&q=%20%20')).body).toEqual([]);
    expect((await get('provider=google')).body).toEqual([]);
    ctx.settings.set('search', { ...ctx.settings.get('search'), suggestionsEnabled: false });
    expect((await get('provider=google&q=cats')).body).toEqual([]);
    expect(ctx.fakeFetch!.calls).toHaveLength(0);
  });

  it('caps the query at 200 characters', async () => {
    const { get } = setup([{ match: FIXTURES.bing.match, respond: { json: ['x', []] } }]);
    await get(`provider=bing&q=${'a'.repeat(500)}`);
    const sent = new URL(ctx.fakeFetch!.calls[0]!.url).searchParams.get('query');
    expect(sent).toBe('a'.repeat(200));
  });

  it('rejects unknown providers (422)', async () => {
    const { get } = setup([]);
    const res = await get('provider=altavista&q=cats');
    expect(res.status).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('turns upstream failures into [] and does not cache them; the provider health logs transitions only', async () => {
    const log = createMemoryLogger();
    const { get } = setup(
      [
        { match: FIXTURES.google.match, respond: { status: 503, text: 'unavailable' }, times: 2 },
        { match: FIXTURES.google.match, respond: { text: 'not json' }, times: 1 },
        { match: FIXTURES.google.match, respond: { json: FIXTURES.google.body } },
      ],
      log,
    );
    expect(await get('provider=google&q=cats')).toMatchObject({ status: 200, body: [] });
    expect(await get('provider=google&q=cat')).toMatchObject({ status: 200, body: [] });
    expect(await get('provider=google&q=cats')).toMatchObject({ status: 200, body: [] });
    // Each keystroke's failure is debug; the health tracker warns once per distinct problem.
    expect(log.lines.filter((l) => l.message === 'suggestions unavailable').map((l) => l.level)).toEqual(['debug', 'debug', 'debug']);
    const transitions = log.lines.filter((l) => l.level !== 'debug' && l.message.startsWith('search '));
    expect(transitions.map((l) => [l.level, l.message, l.fields?.code])).toEqual([
      ['warn', 'search failing', 'http_5xx'],
      ['warn', 'search failing', 'parse_error'],
    ]);
    expect(ctx.health.get('suggest:google')).toMatchObject({ status: 'failing', lastCode: 'parse_error', consecutiveFailures: 3 });
    expect((await get('provider=google&q=cats')).body).toEqual(['cats', 'cats musical', 'cat food', 'cats the jellicle ball']);
    expect(log.lines.filter((l) => l.message === 'search recovered')).toHaveLength(1);
    expect(ctx.health.get('suggest:google')?.status).toBe('ok');
  });

  it('records each provider as suggest:<provider> without the query', async () => {
    const { get } = setup([
      { match: FIXTURES.bing.match, respond: { status: 500, text: 'oops' } },
      { match: FIXTURES.wikipedia.match, respond: { json: FIXTURES.wikipedia.body } },
    ]);
    await get('provider=bing&q=secret%20search%20words');
    await get('provider=wikipedia&q=secret%20search%20words');
    expect(ctx.health.get('suggest:bing')).toMatchObject({
      area: 'search',
      label: 'Bing',
      status: 'failing',
      lastCode: 'http_5xx',
      lastStatus: 500,
      lastMessage: 'Suggestion provider answered 500',
      expectEveryMs: null,
      detail: { host: 'api.bing.com', upstreamStatus: 500 },
    });
    expect(ctx.health.get('suggest:wikipedia')).toMatchObject({ label: 'Wikipedia', status: 'ok', detail: { host: 'en.wikipedia.org' } });
    expect(JSON.stringify([ctx.health.list(), ctx.health.history('suggest:bing')])).not.toContain('secret');
  });

  it('tells safe-fetch which provider a request is for', async () => {
    const { get } = setup([{ match: FIXTURES.ddg.match, respond: { json: FIXTURES.ddg.body } }]);
    const purposes: (string | undefined)[] = [];
    const real = ctx.fetch;
    ctx.fetch = async (url, options) => {
      purposes.push(options.purpose);
      return real(url, options);
    };
    await get('provider=ddg&q=cats');
    expect(purposes).toEqual(['suggest.ddg']);
  });

  it('requires the gate headers like every API route', async () => {
    setup([]);
    const { app } = createApp(ctx, { modules: [{ name: 'search', prefixes, register }], webDist: null });
    const res = await testRequest(app, 'GET', '/api/search/suggest?provider=google&q=x', { headers: { 'X-Homebase': null } });
    expect(res.status).toBe(403);
  });
});
