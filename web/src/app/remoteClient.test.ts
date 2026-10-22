import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '@portly/shared';
import { setLoginReloadForTests } from '../api/client.ts';
import { fetchDeviceSelf } from '../api/devices.ts';
import { getCapabilities, setCapabilitiesForTests, setRemoteClient } from '../capabilities.ts';
import { mockError, stubApi } from '../test/render.tsx';
import { detectRemoteClient, isLoopbackHostname, resolveRemoteClient } from './remoteClient.ts';

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return { ok: true, version: '0.0.0-test', vault: 'ready', app: 'portly', apiVersion: 1, appUrl: 'http://localhost:5757/', ...overrides };
}

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', 'app.localhost'])('%s is loopback', (name) => {
    expect(isLoopbackHostname(name)).toBe(true);
  });
  it.each(['pc.tailnet.ts.net', 'localhost.evil.example', '127.0.0.2', 'portly.lan'])('%s is not', (name) => {
    expect(isLoopbackHostname(name)).toBe(false);
  });
});

describe('detectRemoteClient', () => {
  it('takes a loopback address as this PC when the server does not say otherwise, even unreachable', async () => {
    const fetchHealth = vi.fn(async () => health({ remote: false }));
    expect(await detectRemoteClient({ hostname: 'localhost', origin: 'http://localhost:5757', fetchHealth })).toBe('local');
    expect(fetchHealth).toHaveBeenCalledTimes(1);
    expect(await detectRemoteClient({ hostname: 'localhost', origin: 'http://localhost:5173', fetchHealth: async () => health() })).toBe('local');
    expect(
      await detectRemoteClient({
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:5757',
        fetchHealth: async () => {
          throw new TypeError('down');
        },
      }),
    ).toBe('local');
  });

  it('takes a loopback address as another PC’s when the server says so (a local proxy on another port, to try the flow)', async () => {
    const fetchHealth = vi.fn(async () => health({ remote: true }));
    expect(await detectRemoteClient({ hostname: 'localhost', origin: 'http://localhost:8443', fetchHealth })).toBe('remote');
  });

  it('is remote when the server says it took the request as another PC’s', async () => {
    const fetchHealth = vi.fn(async () => health({ remote: true }));
    expect(await detectRemoteClient({ hostname: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net', fetchHealth })).toBe('remote');
    expect(fetchHealth).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('is misrouted when the server took a page on another address as its own (the proxy points at the main port)', async () => {
    const fetchHealth = vi.fn(async () => health({ remote: false }));
    expect(await detectRemoteClient({ hostname: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net', fetchHealth })).toBe('misrouted');
  });

  it('is local on a custom own origin the server names as its page', async () => {
    const fetchHealth = vi.fn(async () => health({ remote: false, appUrl: 'https://portly.lan:8443/' }));
    expect(await detectRemoteClient({ hostname: 'portly.lan', origin: 'https://portly.lan:8443', fetchHealth })).toBe('local');
  });

  it('is remote when the server cannot be reached or does not say', async () => {
    expect(
      await detectRemoteClient({
        hostname: 'pc.tailnet.ts.net',
        origin: 'https://pc.tailnet.ts.net',
        fetchHealth: async () => {
          throw new TypeError('down');
        },
      }),
    ).toBe('remote');
    expect(await detectRemoteClient({ hostname: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net', fetchHealth: async () => health() })).toBe('remote');
  });
});

describe('resolveRemoteClient', () => {
  afterEach(() => {
    setLoginReloadForTests(null);
    setCapabilitiesForTests(null);
  });

  const deps = (mocks: Parameters<typeof stubApi>[0]) => {
    const { requests } = stubApi(mocks);
    return { requests, hostname: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net', fetchHealth: async () => health({ remote: true }), fetchDeviceSelf, setRemoteClient };
  };

  it('an unconnected PC: the device check’s 401 marks nothing and reloads nothing; the page counts as another PC’s only afterwards', async () => {
    const reload = vi.fn();
    setLoginReloadForTests(reload);
    const d = deps({ 'GET /api/device': mockError(401, 'login_required') });
    expect(await resolveRemoteClient(d)).toEqual({ view: 'remote', connected: false });
    expect(reload).not.toHaveBeenCalled();
    expect(d.requests.map((r) => r.path)).toEqual(['/api/device']);
    expect(getCapabilities().remoteClient).toBe(true);
  });

  it('a connected PC: the app, marked as another PC’s', async () => {
    const d = deps({ 'GET /api/device': { device: { id: 'd1', label: 'Laptop', createdAt: '2026-10-21T10:00:00.000Z' } } });
    expect(await resolveRemoteClient(d)).toEqual({ view: 'remote', connected: true });
    expect(getCapabilities().remoteClient).toBe(true);
  });

  it('a server that cannot answer the device check counts as connected (the app shows its notices)', async () => {
    const d = deps({
      'GET /api/device': () => {
        throw new TypeError('down');
      },
    });
    expect(await resolveRemoteClient(d)).toEqual({ view: 'remote', connected: true });
  });

  it('this PC’s own page asks nothing about devices and is not marked', async () => {
    const d = { ...deps({}), hostname: 'localhost', origin: 'http://localhost:5757', fetchHealth: async () => health() };
    expect(await resolveRemoteClient(d)).toEqual({ view: 'local', connected: true });
    expect(d.requests).toEqual([]);
    expect(getCapabilities().remoteClient).toBe(false);
  });
});
