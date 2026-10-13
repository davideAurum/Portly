/**
 * Provider failures of the in-browser backend become `provider` events: provider, host, status, a
 * reason code, the error's name and the time taken — never the URL (coordinates, place names,
 * search text), the token or the provider's error text. A caller's own abort is not a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeatherUnits } from '@homebase/shared';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { createFakeFetch, failingFetch } from './__fixtures__/fakeFetch.ts';
import { tokenError } from './__fixtures__/microsoft.ts';
import { berlinForecast } from './__fixtures__/openMeteo.ts';
import { hostOf, recordProviderFailure, statusFailureCode, transportFailureCode } from './diagnostics.ts';
import { MICROSOFT_TOKEN_ENDPOINT, requestToken } from './microsoftAuth.ts';
import { fetchForecast, fetchGeocode } from './openMeteo.ts';
import { fetchSuggestions } from './suggest.ts';
import { createTodoistClient } from './todoistClient.ts';

const events = () => getClientEvents().map((entry) => entry.event);
const UNITS: WeatherUnits = { temperature: 'C', wind: 'kmh', precip: 'mm' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider events', () => {
  it('Open-Meteo: no answer, an error status, an unusable answer — host only, never the query', async () => {
    await expect(fetchForecast(52.52, 13.41, UNITS, { fetch: failingFetch })).rejects.toMatchObject({ code: 'provider_error' });
    const fake = createFakeFetch([{ match: 'geocoding-api', respond: { status: 503, text: 'busy' } }, { match: 'api.open-meteo.com', respond: { json: { nonsense: true } } }]);
    await expect(fetchGeocode('Secret Street 12', { fetch: fake.fetch })).rejects.toMatchObject({ code: 'provider_error' });
    await expect(fetchForecast(52.52, 13.41, UNITS, { fetch: fake.fetch })).rejects.toMatchObject({ code: 'provider_error' });
    expect(events().map((event) => [event.level, event.cat, event.msg, event.fields])).toEqual([
      ['warn', 'provider', 'provider request failed', { provider: 'open-meteo', host: 'api.open-meteo.com', status: null, code: 'network', errName: 'TypeError', ms: expect.any(Number) }],
      ['warn', 'provider', 'provider request failed', { provider: 'open-meteo', host: 'geocoding-api.open-meteo.com', status: 503, code: 'http_5xx', errName: null, ms: expect.any(Number) }],
      ['warn', 'provider', 'provider request failed', { provider: 'open-meteo', host: 'api.open-meteo.com', status: 200, code: 'parse_error', errName: null, ms: expect.any(Number) }],
    ]);
    const text = JSON.stringify(events());
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('52.52');
  });

  it('Open-Meteo: a good answer records nothing', async () => {
    const fake = createFakeFetch([{ match: 'api.open-meteo.com', respond: { json: berlinForecast() } }]);
    await fetchForecast(52.52, 13.41, UNITS, { fetch: fake.fetch });
    expect(events()).toEqual([]);
  });

  it('a caller abort is not a failure', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(fetchForecast(52.52, 13.41, UNITS, { fetch: failingFetch, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events()).toEqual([]);
  });

  it('Wikipedia suggestions: info, never the search text', async () => {
    const fake = createFakeFetch([{ match: 'wikipedia.org', respond: { status: 429, text: 'slow down' } }]);
    await expect(fetchSuggestions('wikipedia', 'my private search', { fetch: fake.fetch })).rejects.toThrow();
    expect(events()).toEqual([expect.objectContaining({ level: 'info', fields: expect.objectContaining({ provider: 'wikipedia', host: 'en.wikipedia.org', status: 429, code: 'rate_limited' }) })]);
    expect(JSON.stringify(events())).not.toContain('private');
  });

  it('Todoist: a rejected token is a warning (info while a new one is checked); a bad filter is info', async () => {
    const fake = createFakeFetch([
      { match: '/tasks/filter', respond: { status: 400, json: { error: 'Invalid filter: secret project' } }, times: 1 },
      { match: '/tasks', respond: { status: 401, text: 'Unauthorized' } },
      { match: '/user', respond: { status: 403, text: 'Forbidden' } },
    ]);
    const client = createTodoistClient({ fetch: fake.fetch });
    await expect(client.request('tok_secret', { path: '/tasks/filter', query: { query: 'p:secret' }, purpose: 'filter' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(client.request('tok_secret', { path: '/tasks', purpose: 'list' })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(client.request('tok_secret', { path: '/user', purpose: 'validate' })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(events().map((event) => [event.level, event.fields.status, event.fields.code, event.fields.host])).toEqual([
      ['info', 400, 'http_4xx', 'api.todoist.com'],
      ['warn', 401, 'token_rejected', 'api.todoist.com'],
      ['info', 403, 'token_rejected', 'api.todoist.com'],
    ]);
    const text = JSON.stringify(events());
    expect(text).not.toContain('secret');
  });

  it("Microsoft token requests: the OAuth error code, never Microsoft's description or the request", async () => {
    const fake = createFakeFetch([{ match: MICROSOFT_TOKEN_ENDPOINT, respond: tokenError('invalid_grant') }]);
    vi.stubGlobal('fetch', fake.fetch);
    const result = await requestToken({ client_id: 'c', grant_type: 'refresh_token', refresh_token: 'refresh-secret' });
    expect(result).toEqual({ ok: false, failure: 'invalid_grant', status: 400 });
    expect(events()).toEqual([
      expect.objectContaining({ level: 'warn', fields: { provider: 'microsoft', host: 'login.microsoftonline.com', status: 400, code: 'invalid_grant', errName: null, ms: expect.any(Number) } }),
    ]);
    vi.stubGlobal('fetch', failingFetch);
    expect(await requestToken({ client_id: 'c', grant_type: 'refresh_token', refresh_token: 'refresh-secret' })).toEqual({ ok: false, failure: 'unreachable', status: null });
    expect(events().at(-1)?.fields).toMatchObject({ status: null, code: 'unreachable', errName: 'TypeError' });
    const text = JSON.stringify(events());
    expect(text).not.toContain('refresh-secret');
    expect(text).not.toContain('script');
  });

  it('helpers: codes, hosts, and an invalid code is never kept', () => {
    expect([429, 404, 400, 503].map(statusFailureCode)).toEqual(['rate_limited', 'not_found', 'http_4xx', 'http_5xx']);
    expect(transportFailureCode(new DOMException('t', 'TimeoutError'))).toBe('timeout');
    expect(transportFailureCode(new DOMException('a', 'AbortError'))).toBeNull();
    expect(transportFailureCode(new TypeError('Failed to fetch'))).toBe('network');
    expect(hostOf('https://api.todoist.com/api/v1/tasks?filter=x')).toBe('api.todoist.com');
    expect(hostOf('not a url')).toBe('unknown');
    recordProviderFailure('todoist', 'api.todoist.com', { code: 'has spaces <b>' });
    expect(events().at(-1)?.fields.code).toBe('error');
  });
});
