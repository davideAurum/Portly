import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WIDGET_TYPES, type Layout } from '@homebase/shared';
import { Shell } from '../app/Shell.tsx';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { createFakeServer } from '../test/fakeServer.ts';
import { profile, shellMocks, widget } from '../test/fixtures.ts';
import { createTestQueryClient, mockResponse, renderWithProviders, stubApi } from '../test/render.tsx';
import { createDefaultLayout } from './defaultLayout.ts';
import { SEED_LOCK_NAME, seedHomeProfile, seedLockName } from './seed.ts';

// Real widget definitions with stand-in components: these tests are about the shell, not the
// widgets (which render real data and make their own API calls).
vi.mock('../widgets/registry.ts', async (importOriginal) => {
  const { stubWidgetRegistry } = await import('../test/stubWidgets.tsx');
  return stubWidgetRegistry(await importOriginal());
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('first-run seeding', () => {
  it('creates and activates a "Home" profile from the default layout when there are no profiles', async () => {
    const server = createFakeServer([]);
    const { requestsTo, unmatched } = renderWithProviders(<Shell />, { apiMocks: server.mocks });

    await waitFor(() => expect(requestsTo('POST /api/profiles')).toHaveLength(1));
    const body = requestsTo('POST /api/profiles')[0]!.body as { name: string; layout: Layout };
    expect(body.name).toBe('Home');
    expect(body.layout.items.map((i) => i.type).sort()).toEqual(WIDGET_TYPES.filter((t) => t !== 'feeds' && t !== 'sports').sort());
    // Positions/frames come from defaultLayout.ts; ids are fresh UUIDs.
    const defaults = createDefaultLayout().items;
    for (const item of body.layout.items) {
      expect(item.id).toMatch(UUID);
      const def = defaults.find((d) => d.type === item.type)!;
      expect({ x: item.x, y: item.y, w: item.w, h: item.h, frame: item.frame }).toEqual({ x: def.x, y: def.y, w: def.w, h: def.h, frame: def.frame });
    }

    await waitFor(() => expect(requestsTo('POST /api/profiles/p-new-1/activate')).toHaveLength(1));
    expect(server.settings.activeProfileId).toBe('p-new-1');
    // The seeded profile is now the editable dashboard.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit layout' })).not.toHaveAttribute('aria-disabled'));
    expect(screen.getByRole('button', { name: /Profile: Home/ })).toBeInTheDocument();
    expect(requestsTo('POST /api/profiles')).toHaveLength(1);
    expect(unmatched).toEqual([]);
  });

  it('adds the default widgets one by one when the server ignores the layout', async () => {
    const server = createFakeServer([]);
    const create = server.mocks['POST /api/profiles'] as (req: { body: unknown }) => unknown;
    server.mocks['POST /api/profiles'] = (req: { body: unknown }) => create({ body: { name: (req.body as { name: string }).name } });
    const { requestsTo } = renderWithProviders(<Shell />, { apiMocks: server.mocks });

    await waitFor(() => expect(requestsTo('PUT /api/profiles/p-new-1/positions')).toHaveLength(1));
    expect(requestsTo('POST /api/profiles/p-new-1/widgets').map((r) => (r.body as { type: string }).type)).toEqual(
      createDefaultLayout().items.map((i) => i.type),
    );
    const placed = server.profiles[0]!.layout.items;
    const defaults = createDefaultLayout().items;
    for (const def of defaults) {
      expect(placed.find((p) => p.type === def.type)).toMatchObject({ x: def.x, y: def.y, w: def.w, h: def.h });
    }
  });

  it('serializes seeding across tabs with a Web Lock so only one "Home" is created', async () => {
    const server = createFakeServer([]);
    const { requests } = stubApi(server.mocks);
    // A minimal exclusive LockManager: callbacks for the same name run one after another.
    const queues = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, callback: () => Promise<unknown>) => {
      const run = (queues.get(name) ?? Promise.resolve()).then(() => callback());
      queues.set(name, run.catch(() => undefined));
      return run;
    });
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator) as Navigator, { locks: { request } }));
    try {
      // Two tabs = two QueryClients that both saw an empty profile list.
      const results = await Promise.all([seedHomeProfile(createTestQueryClient()), seedHomeProfile(createTestQueryClient())]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.every(([name]) => name === `${SEED_LOCK_NAME}:server`)).toBe(true);
      expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/profiles')).toHaveLength(1);
      expect(server.profiles.map((p) => p.name)).toEqual(['Home']);
      expect(results).toEqual(['p-new-1', null]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names the lock per backend: a Pages tab on the in-browser dataset never waits for one seeding the server', () => {
    expect(seedLockName()).toBe('homebase:first-run-seed:server');
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(seedLockName()).toBe(`${SEED_LOCK_NAME}:browser`);
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    expect(seedLockName()).toBe(`${SEED_LOCK_NAME}:server`);
  });

  it('sets week start and units from the browser locale, and caches the answers instead of refetching (UX-2, PERF-3)', async () => {
    const server = createFakeServer([]);
    const { requestsTo, queryClient } = renderWithProviders(<Shell />, { apiMocks: server.mocks });
    await waitFor(() => expect(requestsTo('POST /api/profiles/p-new-1/activate')).toHaveLength(1));
    // jsdom's navigator.language is en-US.
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(requestsTo('PATCH /api/settings')[0]!.body).toEqual({ general: { weekStartsOn: 0, temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' } });
    await waitFor(() => expect(queryClient.getQueryData<{ general: { temperatureUnit: string } }>(['settings'])?.general.temperatureUnit).toBe('F'));
    await new Promise((r) => setTimeout(r, 50));
    // Profiles: the dashboard's load plus the pre-seed re-check; settings: the initial load only.
    expect(requestsTo('GET /api/profiles')).toHaveLength(2);
    expect(requestsTo('GET /api/settings')).toHaveLength(1);
  });

  it('does not seed when profiles exist', async () => {
    const { requestsTo } = renderWithProviders(<Shell />, {
      apiMocks: shellMocks([profile('p1', 'Work', [widget('w1', 'clock', 0, 0, 4, 3)])]),
    });
    expect(await screen.findByRole('region', { name: 'Clock' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(requestsTo('POST /api/profiles')).toHaveLength(0);
  });

  it('shows the default layout read-only when seeding fails', async () => {
    const { requestsTo } = renderWithProviders(<Shell />, {
      apiMocks: {
        ...shellMocks([]),
        'POST /api/profiles': mockResponse(503, { error: { code: 'module_unavailable', message: 'down' } }),
      },
    });
    await waitFor(() => expect(screen.getAllByText(/^Stub widget: /)).toHaveLength(7));
    await waitFor(() => expect(requestsTo('POST /api/profiles')).toHaveLength(1));
    const toggle = screen.getByRole('button', { name: 'Edit layout' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-disabled', 'true'));
    // Seeding is attempted once per page load, not in a loop.
    await new Promise((r) => setTimeout(r, 50));
    expect(requestsTo('POST /api/profiles')).toHaveLength(1);
  });
});
