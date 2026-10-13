/**
 * The static-backend render helper: `api()` reaches the real in-browser backend through the
 * stubbed `fetch` (health answers, errors map to ApiError like the server build), state can be
 * seeded before the first render, and the backend is closed when the test ends.
 */
import { useQuery } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useHealth } from '../api/about.ts';
import { apiGet, isApiError } from '../api/client.ts';
import { MemoryStorage } from '../static/storage/memory.ts';
import { renderWithStaticBackend, stubFetchWithStaticBackend } from './renderWithStaticBackend.tsx';

function HealthProbe() {
  const health = useHealth();
  if (health.isPending) return <p>loading</p>;
  if (health.isError) return <p>health failed: {String(health.error)}</p>;
  return (
    <p>
      version {health.data.version}, vault {health.data.vault}
    </p>
  );
}

function MissingRouteProbe() {
  const query = useQuery({ queryKey: ['probe', 'missing'], queryFn: () => apiGet<unknown>('/api/no-such-route?x=1'), retry: false });
  if (query.isPending) return <p>loading</p>;
  if (query.isError) {
    const err = query.error;
    return (
      <p>
        {isApiError(err) ? `${err.code} ${err.status}` : 'not an ApiError'} — {err instanceof Error ? err.message : '?'}
      </p>
    );
  }
  return <p>unexpected success</p>;
}

describe('renderWithStaticBackend', () => {
  it('answers GET /api/health through the real static backend', async () => {
    const { requests, requestsTo, backend } = await renderWithStaticBackend(<HealthProbe />, { version: '1.2.3' });
    expect(await screen.findByText('version 1.2.3, vault ready')).toBeInTheDocument();
    expect(requestsTo('GET /api/health')).toHaveLength(1);
    expect(requests[0]).toEqual({ method: 'GET', path: '/api/health', search: '', status: 200 });
    // The same backend answers direct calls.
    const direct = await backend.fetch('/api/health');
    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual({ ok: true, version: '1.2.3', vault: 'ready' });
  });

  it('maps backend errors through ApiError exactly as the server build does', async () => {
    const { requests } = await renderWithStaticBackend(<MissingRouteProbe />, { toaster: false });
    expect(await screen.findByText(/not_found 404/)).toBeInTheDocument();
    expect(screen.getByText(/No such API route: GET \/api\/no-such-route/)).toBeInTheDocument();
    expect(requests).toEqual([{ method: 'GET', path: '/api/no-such-route', search: '?x=1', status: 404 }]);
  });

  it('seeds state after the handlers are ready and persists it to the storage', async () => {
    const seen: string[] = [];
    const { ctx, storage } = await renderWithStaticBackend(<p>ready</p>, {
      seed: async (c) => {
        seen.push(c.version);
        c.state.set('probe', { greeting: 'hello' });
        await c.state.commit('probe');
      },
    });
    expect(seen).toEqual(['0.0.0-test']);
    expect(ctx.state.get('probe', () => null)).toEqual({ greeting: 'hello' });
    expect(await storage.getJson('slice:probe')).toEqual({ greeting: 'hello' });
    expect(ctx.now()).toBe(1_700_000_000_000);
    expect(ctx.newId()).toBe('00000000-0000-4000-8000-000000000001');
    expect(ctx.newId()).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('loads a pre-filled storage before the handlers run', async () => {
    const storage = new MemoryStorage();
    await storage.setJson('slice:probe', ['from', 'storage']);
    const { ctx } = await renderWithStaticBackend(<p>ready</p>, { storage, now: () => 42 });
    expect(ctx.state.has('probe')).toBe(true);
    expect(ctx.state.get('probe', () => [])).toEqual(['from', 'storage']);
    expect(ctx.now()).toBe(42);
  });

  it('works without rendering (plain api() calls) and closes idempotently', async () => {
    const { requests, close, backend } = await stubFetchWithStaticBackend({ version: '9.9.9' });
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    await expect(apiGet('/api/health')).resolves.toEqual({ ok: true, version: '9.9.9', vault: 'ready' });
    await expect(apiGet('/api/nothing')).rejects.toMatchObject({ name: 'ApiError', code: 'not_found', status: 404 });
    expect(requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['GET /api/health 200', 'GET /api/nothing 404']);
    close();
    close();
    // Closing only releases asset URLs and the change channel; dispatch still works.
    expect((await backend.fetch('/api/health')).status).toBe(200);
  });
});
