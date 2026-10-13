/**
 * The Pages build's boot in hybrid mode: which backend a page load starts on, the cleanup of a
 * server backend's leftovers when this browser is not paired, the controller plugged into the store
 * (and the image source on a server-backend page), the toast after a reload that switched
 * backend, and the diagnostic events (the decision, the controller's `hybrid` events).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { getClientEvents, recordClientEvent } from '../diagnostics/clientLog.ts';
import { loadAssetUrl, setServerAssetSource } from '../static/assets.ts';
import {
  INSTANCE,
  ORIGIN,
  SERVER_CACHE_KEY,
  START,
  TOKEN,
  fakePage,
  fakePermission,
  fakeServer,
  memoryStorage,
  pairingRecord,
  type MemoryStorage,
} from './__fixtures__/fakes.ts';
import { BOOT_SERVER_RECENT_MS, bootPagesBackend, decideBootBackend, lastReportedStatus, takeModeSwitchNotice, type PagesBootOptions } from './boot.ts';
import { getAppLocalServerController, setAppLocalServerController } from './controller.ts';
import { MODE_SWITCH_TOAST_KEY, bootDecisionReason, createPairingStore } from './pairing.ts';
import { getLocalServerState } from './store.ts';

describe('decideBootBackend', () => {
  const base = { enabled: true, framed: false, record: pairingRecord(), lastMode: null, lastServerSeenAt: null, now: START };

  it('starts on the server when paired and the last decision was the server', () => {
    expect(decideBootBackend({ ...base, lastMode: 'server' })).toBe('server');
    expect(decideBootBackend({ ...base, lastMode: 'server', lastServerSeenAt: START - 7 * 86_400_000 })).toBe('server');
  });

  it('starts on the server when paired and the server was seen in the last 10 minutes (no decision yet)', () => {
    expect(decideBootBackend({ ...base, lastServerSeenAt: START - BOOT_SERVER_RECENT_MS + 1 })).toBe('server');
    expect(decideBootBackend({ ...base, lastServerSeenAt: START - BOOT_SERVER_RECENT_MS })).toBe('browser');
    expect(decideBootBackend(base)).toBe('browser');
  });

  it('a browser decision wins over a recent sighting (no reload loop after a grace)', () => {
    expect(decideBootBackend({ ...base, lastMode: 'browser', lastServerSeenAt: START - 1_000 })).toBe('browser');
  });

  it('is always the browser when not paired, framed or with hybrid mode off', () => {
    const server = { ...base, lastMode: 'server' as const, lastServerSeenAt: START };
    expect(decideBootBackend({ ...server, record: null })).toBe('browser');
    expect(decideBootBackend({ ...server, framed: true })).toBe('browser');
    expect(decideBootBackend({ ...server, enabled: false })).toBe('browser');
  });
});

describe('bootDecisionReason', () => {
  const base = { enabled: true, framed: false, record: pairingRecord(), lastMode: null, lastServerSeenAt: null, now: START };

  it('names the rule that decided', () => {
    expect(bootDecisionReason({ ...base, enabled: false })).toBe('hybrid-off');
    expect(bootDecisionReason({ ...base, framed: true })).toBe('framed');
    expect(bootDecisionReason({ ...base, record: null })).toBe('not-paired');
    expect(bootDecisionReason({ ...base, lastMode: 'browser' })).toBe('last-decision');
    expect(bootDecisionReason({ ...base, lastServerSeenAt: START - 1_000 })).toBe('seen-recently');
    expect(bootDecisionReason(base)).toBe('not-seen-recently');
  });
});

describe('bootPagesBackend', () => {
  let local: MemoryStorage;
  let session: MemoryStorage;

  beforeEach(() => {
    local = memoryStorage();
    session = memoryStorage();
  });

  afterEach(() => {
    getAppLocalServerController()?.stop();
    setAppLocalServerController(null);
    setServerAssetSource(null);
  });

  function boot(overrides: Partial<PagesBootOptions> = {}) {
    const server = fakeServer();
    const result = bootPagesBackend({
      serverCacheKey: SERVER_CACHE_KEY,
      enabled: true,
      origin: ORIGIN,
      framed: false,
      localStorage: local,
      sessionStorage: session,
      now: () => START,
      base: '/',
      controllerDeps: {
        fetch: server.fetch,
        permission: fakePermission('granted').source,
        page: fakePage().signals,
        subscribePairing: () => () => {},
        reload: vi.fn(),
        isBusy: () => false,
        assign: vi.fn(),
      },
      ...overrides,
    });
    return { ...result, server };
  }

  it("drops the server backend's leftovers when this browser is not paired", () => {
    local.setItem(SERVER_CACHE_KEY, '{"late":"write"}');
    local.setItem('portly:backend-mode:/', 'server');
    local.setItem('portly:server-seen:/', String(START));
    local.setItem('portly:query-cache:static:/', '{"keep":true}');
    const result = boot();
    expect(result.backend).toBe('browser');
    expect(local.items.has(SERVER_CACHE_KEY)).toBe(false);
    expect(local.items.has('portly:backend-mode:/')).toBe(false);
    expect(local.items.has('portly:server-seen:/')).toBe(false);
    expect(local.getItem('portly:query-cache:static:/')).toBe('{"keep":true}');
  });

  it('keeps them while paired, and starts on the server', () => {
    const store = createPairingStore(local, '/');
    store.save(pairingRecord());
    store.setLastMode('server');
    local.setItem(SERVER_CACHE_KEY, '{"snapshot":true}');
    const result = boot();
    expect(result.backend).toBe('server');
    expect(result.instanceId).toBe(INSTANCE);
    expect(local.getItem(SERVER_CACHE_KEY)).toBe('{"snapshot":true}');
  });

  it('plugs the controller into the store and the transport, idle until started', async () => {
    const result = boot();
    expect(result.controller).not.toBeNull();
    expect(getAppLocalServerController()).toBe(result.controller);
    expect(getLocalServerState()).toMatchObject({ backend: 'browser', status: 'idle', paired: false });
    expect(result.server.fetch).not.toHaveBeenCalled();
    result.start();
    await vi.waitFor(() => expect(getLocalServerState().status).toBe('unpaired'));
  });

  it("records the decision and the controller's events as this browser's hybrid events", async () => {
    const store = createPairingStore(local, '/');
    store.save(pairingRecord());
    store.setLastMode('server');
    const painted: (() => void)[] = [];
    const result = boot({ afterFirstPaint: (run) => painted.push(run) });
    result.server.pairing = () => new Response('{"error":{"code":"internal","message":"x"}}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    // Nothing before the first paint: the first event of a page load reads the stored ones.
    expect(getClientEvents()).toEqual([]);
    result.start();
    expect(painted).toHaveLength(1);
    painted[0]!();
    expect(getClientEvents().map((entry) => entry.event)[0]).toEqual(
      expect.objectContaining({ level: 'debug', cat: 'hybrid', msg: 'page backend chosen', fields: { target: 'server', reason: 'last-decision' }, page: expect.objectContaining({ backend: 'server' }) }),
    );
    await vi.waitFor(() => expect(getLocalServerState().status).toBe('reconnecting'));
    const events = getClientEvents().map((entry) => entry.event);
    expect(events).toContainEqual(expect.objectContaining({ level: 'warn', cat: 'hybrid', msg: 'pairing check failed', fields: expect.objectContaining({ httpStatus: 500 }) }));
    expect(events).toContainEqual(expect.objectContaining({ level: 'warn', cat: 'hybrid', msg: 'reconnect grace started' }));
  });

  it("finds the status reported last in this browser's event log (not debug ones)", () => {
    expect(lastReportedStatus()).toBeNull();
    recordClientEvent('info', 'hybrid', 'hybrid status changed', { from: 'checking', to: 'connected', reason: 'connected' });
    recordClientEvent('info', 'hybrid', 'backend switch requested', { target: 'server', reason: 'connected' });
    recordClientEvent('debug', 'hybrid', 'hybrid status changed', { from: 'connected', to: 'checking', reason: 'manual' });
    expect(lastReportedStatus()).toEqual({ status: 'connected', reason: 'connected' });
  });

  it('a framed page stays on the browser with a framed controller', () => {
    createPairingStore(local, '/').save(pairingRecord());
    createPairingStore(local, '/').setLastMode('server');
    const result = boot({ framed: true });
    expect(result.backend).toBe('browser');
    expect(getLocalServerState().status).toBe('framed');
  });

  it('with hybrid mode off: the browser, no controller, but still the cleanup', () => {
    createPairingStore(local, '/').setLastMode('server');
    local.setItem(SERVER_CACHE_KEY, '{}');
    const painted: (() => void)[] = [];
    const result = boot({ enabled: false, afterFirstPaint: (run) => painted.push(run) });
    expect(result).toMatchObject({ backend: 'browser', instanceId: null, controller: null });
    expect(getAppLocalServerController()).toBeNull();
    expect(local.items.has(SERVER_CACHE_KEY)).toBe(false);
    // The decision is recorded once the page is up, here too.
    result.start();
    painted.forEach((run) => run());
    expect(getClientEvents().map((entry) => [entry.event.msg, entry.event.fields])).toEqual([['page backend chosen', { target: 'browser', reason: 'hybrid-off' }]]);
  });

  it('gives a server-backend page its images from the server, through the transport', async () => {
    const store = createPairingStore(local, '/');
    store.save(pairingRecord());
    store.setLastMode('server');
    const result = boot();
    result.start();
    await vi.waitFor(() => expect(getLocalServerState().status).toBe('connected'));

    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    // The page's transport uses the global fetch and the build's origin ('' in tests).
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await loadAssetUrl('/api/icons/abc')).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/icons/abc');
    expect(new Headers(init?.headers).get('X-Portly-Token')).toBe(TOKEN);
  });
});

describe('takeModeSwitchNotice', () => {
  it('announces the switch the reload applied, once', () => {
    const session = memoryStorage({ [MODE_SWITCH_TOAST_KEY]: 'server:connected' });
    expect(takeModeSwitchNotice('server', session)).toEqual({ tone: 'success', message: 'Connected to Portly on this PC' });
    expect(takeModeSwitchNotice('server', session)).toBeNull();
  });

  it('explains a fall back to the browser by its reason', () => {
    const session = memoryStorage({ [MODE_SWITCH_TOAST_KEY]: 'browser:unreachable' });
    expect(takeModeSwitchNotice('browser', session)).toEqual({ tone: 'info', message: 'Portly on this PC isn’t reachable — using this browser’s copy' });
    for (const reason of ['revoked', 'disconnected', 'other-server', 'incompatible', 'blocked']) {
      session.setItem(MODE_SWITCH_TOAST_KEY, `browser:${reason}`);
      expect(takeModeSwitchNotice('browser', session)?.message).toMatch(/using this browser’s copy$/);
    }
  });

  it('drops (and uses up) a notice for the backend this load did not start on', () => {
    for (const [raw, backend] of [
      ['browser:unreachable', 'server'],
      ['server:connected', 'browser'],
    ] as const) {
      const session = memoryStorage({ [MODE_SWITCH_TOAST_KEY]: raw });
      expect(takeModeSwitchNotice(backend, session)).toBeNull();
      expect(session.getItem(MODE_SWITCH_TOAST_KEY)).toBeNull();
    }
  });

  it('ignores anything else', () => {
    for (const raw of ['browser:toString', 'browser', 'elsewhere:connected', '']) {
      const session = memoryStorage({ [MODE_SWITCH_TOAST_KEY]: raw });
      expect(takeModeSwitchNotice('browser', session)).toBeNull();
      expect(session.getItem(MODE_SWITCH_TOAST_KEY)).toBeNull();
    }
    expect(takeModeSwitchNotice('browser', null)).toBeNull();
  });
});
