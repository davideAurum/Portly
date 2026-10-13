import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SearchEngine, SearchSettings, Settings } from '@portly/shared';
import { qk } from '../../api/keys.ts';
import { createTestQueryClient, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { useEngineIcons } from './engineIcons.ts';

// Like a real browser fetch, an aborted site-meta request rejects (the test fetch stub ignores signals).
vi.mock('../../api/bookmarks.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api/bookmarks.ts')>();
  return {
    ...real,
    fetchSiteMeta: async (url: string, signal?: AbortSignal) => {
      const meta = await real.fetchSiteMeta(url, signal);
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return meta;
    },
  };
});

const FOUND_ICON = '11111111-1111-4111-8111-111111111111';
const MOVED_ICON = '22222222-2222-4222-8222-222222222222';

function Probe({ search }: { search: SearchSettings }) {
  useEngineIcons(search, true);
  return null;
}

const engine = (id: string, site: string, iconId: string | null = null): SearchEngine => ({
  id,
  name: id,
  urlTemplate: `https://${site}/search?q=%s`,
  keyword: null,
  suggest: null,
  iconId,
});

describe('search engine icons', () => {
  it('survives a remount while lookups are in flight (StrictMode in development, widget remounts)', async () => {
    const base = makeSettings();
    let current: Settings = { ...base, search: { ...base.search, engines: [engine('strict-a', 'strict.example')], defaultEngineId: 'strict-a' } };
    const client = createTestQueryClient();
    client.setQueryData(qk.settings(), current);
    const { rerender, requestsTo } = renderWithProviders(<Probe key="first" search={current.search} />, {
      queryClient: client,
      apiMocks: {
        'GET /api/site-meta': async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { title: null, iconId: FOUND_ICON };
        },
        'PATCH /api/settings': (req: MockRequest) => {
          const patch = req.body as { search: Pick<SearchSettings, 'engines'> };
          current = { ...current, search: { ...current.search, engines: patch.search.engines } };
          return current;
        },
      },
    });
    // Unmount + mount while the first lookup is pending (what StrictMode does on every mount).
    rerender(<Probe key="second" search={current.search} />);
    // Before the fix the aborted first run kept the engine "in flight", so the second run skipped
    // it and the icon was never saved (search engines kept letter tiles in the dev app).
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(current.search.engines[0]!.iconId).toBe(FOUND_ICON);
  });

  it('looks engines up per site: a moved or reset engine is fetched again, a site without an icon is not', async () => {
    const base = makeSettings();
    let current: Settings = {
      ...base,
      search: { ...base.search, engines: [engine('icons-a', 'found.example'), engine('icons-b', 'noicon.example')], defaultEngineId: 'icons-a' },
    };
    const client = createTestQueryClient();
    client.setQueryData(qk.settings(), current);
    const { rerender, requestsTo } = renderWithProviders(<Probe search={current.search} />, {
      queryClient: client,
      apiMocks: {
        'GET /api/site-meta': (req: MockRequest) => {
          const url = new URLSearchParams(req.search).get('url');
          return { title: null, iconId: url === 'https://found.example/' ? FOUND_ICON : url === 'https://moved.example/' ? MOVED_ICON : null };
        },
        'PATCH /api/settings': (req: MockRequest) => {
          const patch = req.body as { search: Pick<SearchSettings, 'engines'> };
          current = { ...current, search: { ...current.search, engines: patch.search.engines } };
          return current;
        },
      },
    });
    const metaUrls = () => requestsTo('GET /api/site-meta').map((r) => new URLSearchParams(r.search).get('url'));

    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(metaUrls()).toEqual(['https://found.example/', 'https://noicon.example/']);
    expect(current.search.engines.map((e) => e.iconId)).toEqual([FOUND_ICON, null]);
    rerender(<Probe search={current.search} />);

    // The engine moves to another site (its icon is cleared by the engine dialog): looked up again.
    // Before the fix the engine id was "settled" for the page load and kept its letter tile.
    current = { ...current, search: { ...current.search, engines: [engine('icons-a', 'moved.example'), engine('icons-b', 'noicon.example')] } };
    client.setQueryData(qk.settings(), current);
    rerender(<Probe search={current.search} />);
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(2));
    expect(metaUrls()).toEqual(['https://found.example/', 'https://noicon.example/', 'https://moved.example/']);
    expect(current.search.engines.map((e) => e.iconId)).toEqual([MOVED_ICON, null]);
    rerender(<Probe search={current.search} />); // the saved icon arrives with the settings

    // "Reset to presets" clears the icon of an engine whose site did not change: fetched again too.
    current = { ...current, search: { ...current.search, engines: [engine('icons-a', 'moved.example'), engine('icons-b', 'noicon.example')] } };
    client.setQueryData(qk.settings(), current);
    rerender(<Probe search={current.search} />);
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(3));
    // The site without an icon was never asked again.
    expect(metaUrls().filter((u) => u === 'https://noicon.example/')).toHaveLength(1);
  });
  it('looks each site up once, a few sites at a time (PERF-3)', async () => {
    const base = makeSettings();
    const engines = [
      engine('pg-google', 'www.google.example'),
      engine('pg-maps', 'www.google.example'),
      engine('pg-ddg', 'ddg.example'),
      engine('pg-bing', 'bing.example'),
      engine('pg-yt', 'yt.example'),
      engine('pg-wiki', 'wiki.example'),
    ];
    let current: Settings = { ...base, search: { ...base.search, engines, defaultEngineId: 'pg-google' } };
    const client = createTestQueryClient();
    client.setQueryData(qk.settings(), current);
    let active = 0;
    let peak = 0;
    const { requestsTo } = renderWithProviders(<Probe search={current.search} />, {
      queryClient: client,
      apiMocks: {
        'GET /api/site-meta': async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active--;
          return { title: null, iconId: FOUND_ICON };
        },
        'PATCH /api/settings': (req: MockRequest) => {
          const patch = req.body as { search: Pick<SearchSettings, 'engines'> };
          current = { ...current, search: { ...current.search, engines: patch.search.engines } };
          return current;
        },
      },
    });
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(requestsTo('GET /api/site-meta')).toHaveLength(5);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(current.search.engines.every((e) => e.iconId === FOUND_ICON)).toBe(true);
  });
});
