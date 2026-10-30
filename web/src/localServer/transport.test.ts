/**
 * The Pages build's transport: a browser-backend page answers from the in-browser backend; a
 * server-backend page waits for the controller, then calls the Portly server on this PC as a
 * credential-less CORS request carrying `X-Portly` and the pairing token, with no timeout of its
 * own, and tells the controller what it learned (any response, a network failure, a revoked
 * pairing — never an abort or the end of server mode). The browser's own backups never reach it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { ORIGIN, TOKEN, jsonResponse, pairingRequired } from './__fixtures__/fakes.ts';
import { ServerModeEndedError, setAppLocalServerController, type HybridController, type ServerLink } from './controller.ts';
import type { FetchLike } from './probe.ts';
import { createServerFetch, localServerFetch, pagesFetch } from './transport.ts';

const staticFetch = vi.hoisted(() => vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"from":"browser"}', { headers: { 'Content-Type': 'application/json' } })));
vi.mock('../static/backend.ts', () => ({ staticFetch }));

afterEach(() => {
  setAppLocalServerController(null);
});

function fakeController(overrides: Partial<HybridController> = {}) {
  const controller = {
    getState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    actions: { checkNow: vi.fn(), lookForServer: vi.fn(), startPairing: vi.fn(), disconnect: vi.fn(async () => {}), switchNow: vi.fn() },
    start: vi.fn(),
    stop: vi.fn(),
    whenServerReady: vi.fn(async (_signal?: AbortSignal | null) => {}),
    reportResponse: vi.fn(),
    reportNetworkFailure: vi.fn(),
    reportUnpaired: vi.fn(),
    token: vi.fn((): string | null => TOKEN),
    link: vi.fn((): ServerLink | null => ({ origin: ORIGIN, remote: false, token: TOKEN })),
    ...overrides,
  };
  return controller satisfies HybridController;
}

function transport(controller: HybridController | null, answer: FetchLike = async () => jsonResponse({ ok: true })) {
  const fetch = vi.fn<FetchLike>(answer);
  return { fetch, serverFetch: createServerFetch({ fetch, controller: () => controller }) };
}

describe('server transport', () => {
  it('waits until the server is ready, then sends a paired CORS request to the server on this PC', async () => {
    const controller = fakeController();
    const { fetch, serverFetch } = transport(controller);
    const abort = new AbortController();
    const res = await serverFetch('/api/settings', {
      method: 'PATCH',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json', 'X-Portly': '1' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(controller.whenServerReady).toHaveBeenCalledWith(abort.signal);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/settings`);
    expect(init).toMatchObject({
      method: 'PATCH',
      body: '{"a":1}',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      targetAddressSpace: 'loopback',
      signal: abort.signal,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Portly')).toBe('1');
    expect(headers.get('X-Portly-Token')).toBe(TOKEN);
    expect(controller.reportResponse).toHaveBeenCalledTimes(1);
  });

  it('sends a request for Portly on another PC to its address, with the device secret and no loopback options', async () => {
    const remote = 'https://desk.tail1234.ts.net';
    const controller = fakeController({ link: () => ({ origin: remote, remote: true, token: TOKEN }) });
    const { fetch, serverFetch } = transport(controller, async () =>
      jsonResponse({ error: { code: 'login_required', message: 'This device is not connected to Portly' } }, 401),
    );
    const res = await serverFetch('/api/settings', { method: 'GET' });
    expect(res.status).toBe(401);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${remote}/api/settings`);
    expect(init).toMatchObject({ mode: 'cors', credentials: 'omit' });
    expect((init as { targetAddressSpace?: unknown }).targetAddressSpace).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Portly-Device')).toBe(TOKEN);
    expect(headers.get('X-Portly-Token')).toBeNull();
    // The device secret refused: the controller probes and decides.
    expect(controller.reportUnpaired).toHaveBeenCalledWith(TOKEN);
  });

  it('adds X-Portly itself (image loads call it directly)', async () => {
    const { fetch, serverFetch } = transport(fakeController());
    await serverFetch('/api/icons/abc', { method: 'GET', cache: 'default' });
    const [, init] = fetch.mock.calls[0]!;
    expect(new Headers(init?.headers).get('X-Portly')).toBe('1');
    expect(init?.cache).toBe('default');
  });

  it('does not send anything before the controller says the server is ready', async () => {
    let ready: () => void = () => {};
    const controller = fakeController({ whenServerReady: vi.fn(() => new Promise<void>((resolve) => (ready = resolve))) });
    const { fetch, serverFetch } = transport(controller);
    const pending = serverFetch('/api/profiles');
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    ready();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports every response, error statuses included', async () => {
    const controller = fakeController();
    const { serverFetch } = transport(controller, async () => jsonResponse({ error: { code: 'internal', message: 'x' } }, 500));
    expect((await serverFetch('/api/weather')).status).toBe(500);
    expect(controller.reportResponse).toHaveBeenCalledTimes(1);
    expect(controller.reportNetworkFailure).not.toHaveBeenCalled();
  });

  it('reports a network failure and rethrows it', async () => {
    const controller = fakeController();
    const failure = new TypeError('Failed to fetch');
    const { serverFetch } = transport(controller, async () => {
      throw failure;
    });
    await expect(serverFetch('/api/settings')).rejects.toBe(failure);
    expect(controller.reportNetworkFailure).toHaveBeenCalledTimes(1);
    expect(controller.reportResponse).not.toHaveBeenCalled();
  });

  it('never reports an abort or the end of server mode', async () => {
    const aborted = fakeController();
    const { serverFetch } = transport(aborted, async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(serverFetch('/api/settings')).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.reportNetworkFailure).not.toHaveBeenCalled();

    const ending = fakeController({ whenServerReady: vi.fn(async () => Promise.reject(new ServerModeEndedError())) });
    const second = transport(ending);
    await expect(second.serverFetch('/api/settings')).rejects.toBeInstanceOf(ServerModeEndedError);
    expect(second.fetch).not.toHaveBeenCalled();
    expect(ending.reportNetworkFailure).not.toHaveBeenCalled();

    const abortedWait = fakeController({ whenServerReady: vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))) });
    const third = transport(abortedWait);
    await expect(third.serverFetch('/api/settings')).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedWait.reportNetworkFailure).not.toHaveBeenCalled();
  });

  it('a 401 pairing_required reports the token as revoked and still returns the response', async () => {
    const controller = fakeController();
    const { serverFetch } = transport(controller, async () => pairingRequired());
    const res = await serverFetch('/api/settings');
    expect(controller.reportUnpaired).toHaveBeenCalledWith(TOKEN);
    expect(await res.json()).toMatchObject({ error: { code: 'pairing_required' } });

    const other = fakeController();
    await transport(other, async () => jsonResponse({ error: { code: 'unauthorized', message: 'x' } }, 401)).serverFetch('/api/settings');
    expect(other.reportUnpaired).not.toHaveBeenCalled();
  });

  it('answers the browser backups 404 without contacting anything', async () => {
    const controller = fakeController();
    const { fetch, serverFetch } = transport(controller);
    for (const path of ['/api/backups', '/api/backups/b-1', '/api/backups?limit=5']) {
      const res = await serverFetch(path, { method: 'GET' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(controller.whenServerReady).not.toHaveBeenCalled();
    // Not a prefix match on other routes.
    await serverFetch('/api/backupsx');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails like a network error without a controller or a pairing token', async () => {
    await expect(transport(null).serverFetch('/api/settings')).rejects.toBeInstanceOf(ServerModeEndedError);
    const unpaired = transport(fakeController({ token: () => null, link: () => null }));
    await expect(unpaired.serverFetch('/api/settings')).rejects.toBeInstanceOf(ServerModeEndedError);
    expect(unpaired.fetch).not.toHaveBeenCalled();
  });
});

describe('pagesFetch', () => {
  it('a browser-backend page answers from the in-browser backend', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const res = await pagesFetch('/api/settings', { method: 'GET' });
    expect(await res.json()).toEqual({ from: 'browser' });
    expect(staticFetch).toHaveBeenCalledWith('/api/settings', { method: 'GET' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a server-backend page goes to the page's controller and the server", async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const controller = fakeController();
    setAppLocalServerController(controller);
    const fetch = vi.fn(async () => jsonResponse({ from: 'server' }));
    vi.stubGlobal('fetch', fetch);
    staticFetch.mockClear();
    expect(await (await pagesFetch('/api/settings')).json()).toEqual({ from: 'server' });
    expect(await (await localServerFetch('/api/profiles')).json()).toEqual({ from: 'server' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(staticFetch).not.toHaveBeenCalled();
    expect(controller.reportResponse).toHaveBeenCalledTimes(2);
  });

  it('a server-backend page without a running controller fails like a network error', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    await expect(pagesFetch('/api/settings')).rejects.toBeInstanceOf(TypeError);
  });
});
