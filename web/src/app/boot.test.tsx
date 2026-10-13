/**
 * PERF-1: a new tab paints last-known content in its first frame — the persisted cache is
 * restored before the first render and the visible widgets' code is loaded, so neither an empty
 * page nor the widgets' Suspense skeletons are ever committed when the data is cached.
 */
import { Suspense } from 'react';
import { QueryClient, dehydrate, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { qk } from '../api/keys.ts';
import { WidgetFrame } from '../grid/WidgetFrame.tsx';
import { profile, settings, widget } from '../test/fixtures.ts';
import { renderWithProviders } from '../test/render.tsx';
import { lazyWithPreload } from '../widgets/lazyWidget.ts';
import { getWidgetDefinition } from '../widgets/registry.ts';
import { initialWidgetTypes, prepareFirstRender } from './boot.ts';
import { APP_VERSION, AppProviders, QUERY_CACHE_STORAGE_KEY, createQueryClient, persistOptionsFor, persistOptionsOf } from './providers.tsx';

const work = profile('p-work', 'Work', [widget('w-clock', 'clock', 0, 0, 4, 3), widget('w-mail', 'mail', 4, 0, 4, 4)]);

function persistSnapshot(): void {
  const source = new QueryClient();
  source.setQueryData(qk.settings(), settings({ activeProfileId: 'p-work' }));
  source.setQueryData(qk.profiles(), [profile('p-home', 'Home'), work]);
  const snapshot = { buster: APP_VERSION, timestamp: Date.now(), clientState: dehydrate(source) };
  window.localStorage.setItem(QUERY_CACHE_STORAGE_KEY, JSON.stringify(snapshot));
}

afterEach(() => window.localStorage.clear());

describe('lazyWithPreload', () => {
  const fallback = (
    <p role="status" aria-label="Loading">
      loading
    </p>
  );

  it('suspends on the first render until loaded, but not once preloaded', async () => {
    const Cold = lazyWithPreload(async () => ({ default: () => <p>cold content</p> }));
    const cold = render(<Suspense fallback={fallback}>{<Cold />}</Suspense>);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByText('cold content')).toBeInTheDocument();
    cold.unmount();

    const Warm = lazyWithPreload(async () => ({ default: () => <p>warm content</p> }));
    await Warm.preload();
    render(<Suspense fallback={fallback}>{<Warm />}</Suspense>);
    // Synchronously after the first render: no fallback was committed.
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(screen.getByText('warm content')).toBeInTheDocument();
  });

  it('a failed load can be retried', async () => {
    let attempts = 0;
    const Flaky = lazyWithPreload(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk failed');
      return { default: () => <p>ok</p> };
    });
    await expect(Flaky.preload()).rejects.toThrow('chunk failed');
    await expect(Flaky.preload()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});

describe('WidgetFrame first render', () => {
  it('commits no Suspense skeleton for a preloaded widget', async () => {
    await getWidgetDefinition('clock')!.Component.preload?.();
    renderWithProviders(<WidgetFrame instance={widget('w-clock', 'clock', 0, 0, 4, 3)} profileId="p1" editMode={false} />, {
      apiMocks: { 'GET /api/settings': settings() },
    });
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
  });
});

describe('prepareFirstRender', () => {
  it('restores the persisted cache before the first render, marked stale for a refetch', async () => {
    persistSnapshot();
    const client = createQueryClient();
    await prepareFirstRender(client, undefined, 50);
    expect(client.getQueryData(qk.profiles())).toHaveLength(2);
    expect(client.getQueryState(qk.settings())?.isInvalidated).toBe(true);

    function Probe() {
      const profiles = useQuery({ queryKey: qk.profiles(), queryFn: () => new Promise<unknown[]>(() => {}) });
      return <p>{profiles.data ? `cached: ${profiles.data.length}` : 'nothing yet'}</p>;
    }
    render(
      <AppProviders client={client}>
        <Probe />
      </AppProviders>,
    );
    // The very first commit already has the restored data.
    expect(screen.getByText('cached: 2')).toBeInTheDocument();
  });

  it("restores the given backend's snapshot and keeps those options for the client", async () => {
    persistSnapshot();
    // Pages build, server backend: its own snapshot, never the other backend's.
    const remote = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage: window.localStorage });
    const source = new QueryClient();
    source.setQueryData(qk.profiles(), [work]);
    window.localStorage.setItem(remote.key, JSON.stringify({ buster: remote.buster, timestamp: Date.now(), clientState: dehydrate(source) }));

    const client = createQueryClient();
    await prepareFirstRender(client, remote, 50);
    expect(client.getQueryData(qk.profiles())).toEqual([work]);
    expect(persistOptionsOf(client)).toBe(remote);
  });

  it("preloads the active profile's widget types (the default layout's on first run)", () => {
    const client = createQueryClient();
    expect(new Set(initialWidgetTypes(client))).toEqual(new Set(['search', 'clock', 'weather', 'launchpad', 'calendar', 'todoist', 'mail']));
    client.setQueryData(qk.settings(), settings({ activeProfileId: 'p-work' }));
    client.setQueryData(qk.profiles(), [profile('p-home', 'Home'), work]);
    expect(initialWidgetTypes(client)).toEqual(['clock', 'mail']);
  });

  it('never blocks the first render on a slow chunk for longer than the cap', async () => {
    const client = createQueryClient();
    const started = performance.now();
    await prepareFirstRender(client, undefined, 30);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
