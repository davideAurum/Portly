/**
 * The local server controller under fake timers: when it probes (and when it does not), every row
 * of the outcome table for both backends, the grace of a server-backend page, the permission
 * prompt, the probe intervals, the reload policy, `whenServerReady`, what requests report, the
 * pairing record (compare-and-clear, other tabs) and the hints the next page load decides from;
 * the `no-cors` fallback and the diagnostic events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_URL,
  INSTANCE,
  NEW_TOKEN,
  ORIGIN,
  OTHER_INSTANCE,
  SERVER_CACHE_KEY,
  START,
  TOKEN,
  accepted,
  down,
  fullStorage,
  hang,
  harness,
  healthy,
  jsonResponse,
  pairingRecord,
  pairingRequired,
  refusesCors,
  type Handler,
  type Harness,
} from './__fixtures__/fakes.ts';
import {
  BACKOFF_MS,
  CONNECTED_INTERVAL_MS,
  GRACE_MS,
  HIDDEN_PROBE_INTERVAL_MS,
  PERMISSION_WAIT_MS,
  PROBE_TIMEOUT_MS,
  RECONNECT_INTERVAL_MS,
  ServerModeEndedError,
  createLocalServerController,
} from './controller.ts';
import { MODE_SWITCH_TOAST_KEY, PAIRING_NONCE_KEY } from './pairing.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets pending promises (fetches, JSON bodies) settle without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function start(h: Harness): Promise<Harness> {
  h.controller.start();
  await flush();
  return h;
}

/** A handler the test settles by hand. */
function deferred(): { handler: Handler; resolve(res: Response): void; reject(err: unknown): void; signal(): AbortSignal | undefined } {
  let resolve: (res: Response) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  let signal: AbortSignal | undefined;
  return {
    handler: (_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    resolve: (res) => resolve(res),
    reject: (err) => reject(err),
    signal: () => signal,
  };
}

const status = (h: Harness) => h.controller.getState().status;
const toast = (h: Harness) => h.session.getItem(MODE_SWITCH_TOAST_KEY);

describe('when it probes', () => {
  it('never probes with hybrid mode off or inside a frame', async () => {
    const off = await start(harness({ origin: '', paired: true }));
    const framed = await start(harness({ framed: true, paired: true }));
    expect(status(off)).toBe('disabled');
    expect(status(framed)).toBe('framed');
    for (const h of [off, framed]) {
      h.page.emit('focus');
      h.controller.actions.checkNow();
      h.controller.actions.lookForServer();
      await advance(120_000);
      expect(h.server.fetch).not.toHaveBeenCalled();
    }
  });

  it('does not probe an unpaired browser on its own until the permission is granted; Look for it does', async () => {
    const h = await start(harness({ permission: 'prompt' }));
    expect(h.controller.getState()).toMatchObject({ status: 'idle', permission: 'prompt', paired: false });
    h.page.emit('focus');
    h.page.emit('visible');
    await advance(120_000);
    expect(h.server.fetch).not.toHaveBeenCalled();

    h.controller.actions.lookForServer();
    expect(h.controller.getState()).toMatchObject({ status: 'checking', manual: true });
    await flush();
    expect(h.server.calls()).toEqual(['GET /api/health']);
    expect(h.controller.getState()).toMatchObject({ status: 'unpaired', manual: true });
    // Nothing is scheduled for an unpaired browser.
    await advance(300_000);
    expect(h.server.fetch).toHaveBeenCalledTimes(1);
  });

  it('probes an unpaired browser with the permission granted (or no such permission) on boot, focus and visibility only', async () => {
    for (const permission of ['granted', 'unsupported'] as const) {
      const h = await start(harness({ permission }));
      expect(h.server.calls()).toEqual(['GET /api/health']);
      expect(status(h)).toBe('unpaired');
      await advance(300_000);
      expect(h.server.fetch).toHaveBeenCalledTimes(1);
      h.page.emit('focus');
      await flush();
      h.page.emit('visible');
      await flush();
      h.page.emit('online');
      await flush();
      expect(h.server.fetch).toHaveBeenCalledTimes(4);
      h.controller.stop();
    }
  });

  it('starts probing once the permission is granted, and shows a denial', async () => {
    const h = await start(harness({ permission: 'prompt' }));
    h.permission.set('denied');
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'blocked', permission: 'denied' });
    expect(h.server.fetch).not.toHaveBeenCalled();
    h.permission.set('prompt');
    await flush();
    expect(status(h)).toBe('idle');
    h.permission.set('granted');
    await flush();
    expect(h.server.calls()).toEqual(['GET /api/health']);
    expect(status(h)).toBe('unpaired');
  });

  it('a paired browser probes on boot whatever the permission says (while visible for a prompt)', async () => {
    const hidden = await start(harness({ paired: true, permission: 'prompt', visible: false }));
    expect(hidden.server.fetch).not.toHaveBeenCalled();
    hidden.page.emit('visible');
    await flush();
    expect(hidden.server.calls()[0]).toBe('GET /api/health');

    const visible = await start(harness({ paired: true, permission: 'prompt' }));
    expect(visible.server.calls()).toEqual(['GET /api/health', 'GET /api/pairing']);
  });

  it('runs one probe at a time', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.health = hang;
    h.controller.actions.checkNow();
    h.controller.actions.checkNow();
    h.page.emit('focus');
    h.controller.actions.lookForServer();
    await flush();
    // Boot probe (health + pairing), then exactly one more health request.
    expect(h.server.calls()).toEqual(['GET /api/health', 'GET /api/pairing', 'GET /api/health']);
  });

  it('stops every timer and listener on stop()', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.controller.stop();
    const calls = h.server.fetch.mock.calls.length;
    h.page.emit('focus');
    h.permission.set('denied');
    h.pairingChanged();
    await advance(300_000);
    expect(h.server.fetch).toHaveBeenCalledTimes(calls);
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe('outcomes on a browser-backend page', () => {
  it('unreachable or not Portly → absent', async () => {
    const notPortly: Handler[] = [
      down,
      () => new Response('<html>hi</html>', { headers: { 'Content-Type': 'text/html' } }),
      () => jsonResponse({ ...{ ok: true, version: '1', vault: 'ready' }, app: 'other' }),
      () => jsonResponse({ unrelated: true }),
      () => jsonResponse({ error: 'nope' }, 500),
    ];
    for (const health of notPortly) {
      const h = harness({ paired: true });
      h.server.health = health;
      await start(h);
      expect(status(h)).toBe('absent');
      expect(h.reload).not.toHaveBeenCalled();
      h.controller.stop();
    }
  });

  it('permission denied → blocked, without a request', async () => {
    for (const paired of [true, false]) {
      const h = await start(harness({ paired, permission: 'denied' }));
      expect(status(h)).toBe('blocked');
      expect(h.server.fetch).not.toHaveBeenCalled();
      h.controller.stop();
    }
  });

  it('a request failing because the user just blocked the prompt → blocked', async () => {
    const h = harness({ paired: true, permission: 'prompt' });
    h.server.health = () => {
      h.permission.state = 'denied';
      return down('', {});
    };
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'blocked', permission: 'denied' });
  });

  it('another API version (or a Portly from before hybrid mode) → incompatible', async () => {
    for (const overrides of [{ apiVersion: 2 }, { app: undefined, apiVersion: undefined, instanceId: undefined, appUrl: undefined }]) {
      const h = harness({ paired: true });
      h.server.health = healthy(overrides);
      await start(h);
      expect(status(h)).toBe('incompatible');
      expect(h.server.calls()).toEqual(['GET /api/health']);
      h.controller.stop();
    }
  });

  it('healthy, not paired → unpaired, with what the server said about itself', async () => {
    const h = await start(harness());
    expect(h.controller.getState()).toMatchObject({
      status: 'unpaired',
      paired: false,
      checkedAt: START,
      server: { version: '0.1.0', instanceId: INSTANCE, appUrl: APP_URL, apiVersion: 1, vault: 'ready' },
    });
  });

  it("refuses a server's page outside this PC (appUrl is untrusted)", async () => {
    const h = harness();
    h.server.health = healthy({ appUrl: 'https://evil.example/' });
    await start(h);
    expect(h.controller.getState().server?.appUrl).toBeNull();
  });

  it('healthy, paired, another instance → other-server, and the token is never sent', async () => {
    const h = harness({ paired: true });
    h.server.health = healthy({ instanceId: OTHER_INSTANCE });
    await start(h);
    expect(status(h)).toBe('other-server');
    expect(h.server.calls()).toEqual(['GET /api/health']);
    expect(h.store.read()?.token).toBe(TOKEN);
  });

  it('healthy, paired, pairing accepted → connected, and the page switches to the server', async () => {
    const h = await start(harness({ paired: true }));
    expect(status(h)).toBe('connected');
    const [, init] = h.server.fetch.mock.calls[1]!;
    expect(new Headers(init?.headers).get('X-Portly-Token')).toBe(TOKEN);
    expect(new Headers(init?.headers).get('X-Portly')).toBe('1');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
    expect(h.store.lastMode()).toBe('server');
    expect(h.store.lastServerSeenAt()).toBe(START);
  });

  it('pairing refused (401 pairing_required) → revoked, and the record is cleared', async () => {
    const h = harness({ paired: true });
    h.server.pairing = () => pairingRequired();
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'revoked', paired: false });
    expect(h.store.read()).toBeNull();
    expect(h.reload).not.toHaveBeenCalled();
    // "Pairing removed" stays: nothing is scheduled without a pairing.
    await advance(300_000);
    expect(h.server.fetch).toHaveBeenCalledTimes(2);
  });

  it('any other 401 proves nothing about the pairing', async () => {
    const h = harness({ paired: true });
    h.server.pairing = () => jsonResponse({ error: { code: 'unauthorized', message: 'x' } }, 401);
    await start(h);
    expect(status(h)).toBe('absent');
    expect(h.store.read()?.token).toBe(TOKEN);
  });

  it('pairing check failing (network, server error) → absent', async () => {
    for (const pairing of [down, () => jsonResponse({ error: { code: 'internal', message: 'x' } }, 500)]) {
      const h = harness({ paired: true });
      h.server.pairing = pairing;
      await start(h);
      expect(status(h)).toBe('absent');
      expect(h.store.read()).not.toBeNull();
      h.controller.stop();
    }
  });
});

describe('outcomes on a server-backend page', () => {
  it('unreachable or pairing check failing → reconnecting (no switch yet)', async () => {
    for (const [health, pairing] of [
      [down, accepted()],
      [healthy(), down],
    ] as const) {
      const h = harness({ paired: true, backend: 'server' });
      h.server.health = health;
      h.server.pairing = pairing;
      await start(h);
      expect(status(h)).toBe('reconnecting');
      expect(h.reload).not.toHaveBeenCalled();
      h.controller.stop();
    }
  });

  it('permission denied → blocked, switch to the browser', async () => {
    const h = await start(harness({ paired: true, backend: 'server', permission: 'denied' }));
    expect(status(h)).toBe('blocked');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:blocked');
    expect(h.store.lastMode()).toBe('browser');
  });

  it('another API version → switch to the browser', async () => {
    const h = harness({ paired: true, backend: 'server' });
    h.server.health = healthy({ apiVersion: 99 });
    await start(h);
    expect(status(h)).toBe('incompatible');
    expect(toast(h)).toBe('browser:incompatible');
  });

  it('another instance → switch to the browser, without sending the token', async () => {
    const h = harness({ paired: true, backend: 'server' });
    h.server.health = healthy({ instanceId: OTHER_INSTANCE });
    await start(h);
    expect(status(h)).toBe('other-server');
    expect(toast(h)).toBe('browser:other-server');
    expect(h.server.calls()).toEqual(['GET /api/health']);
  });

  it('pairing accepted → connected, no reload', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    expect(status(h)).toBe('connected');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.store.lastMode()).toBe('server');
  });

  it('pairing refused → revoked, cleared, switch to the browser', async () => {
    const h = harness({ paired: true, backend: 'server' });
    h.server.pairing = () => pairingRequired();
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'revoked', paired: false });
    expect(h.store.read()).toBeNull();
    expect(toast(h)).toBe('browser:revoked');
    expect(h.store.lastMode()).toBe('browser');
  });
});

describe('grace of a server-backend page', () => {
  async function reconnectingPage(): Promise<Harness> {
    const h = await start(harness({ paired: true, backend: 'server' }));
    expect(status(h)).toBe('connected');
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await flush();
    expect(status(h)).toBe('reconnecting');
    return h;
  }

  it('re-probes every 2 s and switches to the browser after 45 s', async () => {
    const h = await reconnectingPage();
    const before = h.server.fetch.mock.calls.length;
    await advance(RECONNECT_INTERVAL_MS);
    expect(h.server.fetch.mock.calls.length).toBe(before + 1);
    await advance(GRACE_MS - 2 * RECONNECT_INTERVAL_MS);
    expect(h.reload).not.toHaveBeenCalled();
    await advance(2 * RECONNECT_INTERVAL_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:unreachable');
    // Last seen at START, more than the grace ago: the next load starts on the browser.
    expect(h.store.lastMode()).toBe('browser');
  });

  it('keeps reconnecting while another tab saw the server within the grace, then switches for good', async () => {
    const h = await reconnectingPage();
    const ready = vi.fn();
    const failed = vi.fn();
    void h.controller.whenServerReady().then(ready, failed);
    await advance(GRACE_MS - RECONNECT_INTERVAL_MS);
    // Another tab connected 10 s ago: no reload that would only land on the server again.
    const seenAt = Date.now() - 10_000;
    h.store.setLastServerSeenAt(seenAt);
    await advance(2 * RECONNECT_INTERVAL_MS);
    expect(h.reload).not.toHaveBeenCalled();
    expect(toast(h)).toBeNull();
    expect(h.controller.getState()).toMatchObject({ status: 'reconnecting', pendingSwitch: null });
    expect(failed).not.toHaveBeenCalled();
    expect(h.store.lastMode()).toBe('server');
    // Nobody has seen it for the grace: the switch, its toast and the next load agree.
    await advance(seenAt + GRACE_MS - Date.now() - 1);
    expect(h.reload).not.toHaveBeenCalled();
    await advance(RECONNECT_INTERVAL_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:unreachable');
    expect(h.store.lastMode()).toBe('browser');
    expect(h.store.nextBootBackend(Date.now())).toBe('browser');
    expect(failed).toHaveBeenCalledWith(expect.any(ServerModeEndedError));
  });

  it('a hidden tab back after the grace keeps reconnecting too while another tab saw the server', async () => {
    const h = await reconnectingPage();
    h.page.emit('hidden');
    await advance(GRACE_MS + 30_000);
    h.store.setLastServerSeenAt(Date.now() - 5_000);
    h.page.emit('visible');
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    expect(status(h)).toBe('reconnecting');
    h.server.health = healthy();
    await advance(RECONNECT_INTERVAL_MS);
    expect(status(h)).toBe('connected');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('is over as soon as the server answers again', async () => {
    const h = await reconnectingPage();
    await advance(30_000);
    h.server.health = healthy();
    await advance(RECONNECT_INTERVAL_MS);
    expect(status(h)).toBe('connected');
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await advance(GRACE_MS - 5_000);
    // A new spell: its own 45 s.
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a hidden tab re-probes once it is visible before switching', async () => {
    const h = await reconnectingPage();
    h.page.emit('hidden');
    await advance(GRACE_MS + 30_000);
    expect(h.reload).not.toHaveBeenCalled();
    expect(status(h)).toBe('reconnecting');
    const before = h.server.fetch.mock.calls.length;
    h.page.emit('visible');
    await flush();
    expect(h.server.fetch.mock.calls.length).toBe(before + 1);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:unreachable');
  });

  it('a hidden tab that finds the server again stays', async () => {
    const h = await reconnectingPage();
    h.page.emit('hidden');
    await advance(GRACE_MS + 30_000);
    h.server.health = healthy();
    h.page.emit('visible');
    await flush();
    expect(status(h)).toBe('connected');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('does not count the time spent waiting for the permission prompt', async () => {
    const h = harness({ paired: true, backend: 'server', permission: 'unsupported' });
    h.server.health = down;
    await start(h);
    expect(status(h)).toBe('reconnecting');
    await advance(9_000);
    const slow = deferred();
    h.server.health = slow.handler;
    await advance(1_000);
    await advance(PERMISSION_WAIT_MS);
    expect(status(h)).toBe('waiting-permission');
    await advance(200_000);
    // Never aborted, nothing else scheduled, no switch.
    expect(slow.signal()?.aborted).toBe(false);
    expect(h.reload).not.toHaveBeenCalled();
    slow.reject(new TypeError('Failed to fetch'));
    h.server.health = down;
    await flush();
    expect(status(h)).toBe('reconnecting');
    // 13 s of grace used before the wait.
    await advance(GRACE_MS - 13_000 - 2 * RECONNECT_INTERVAL_MS);
    expect(h.reload).not.toHaveBeenCalled();
    await advance(3 * RECONNECT_INTERVAL_MS);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe('the permission prompt', () => {
  it('never aborts a probe while the prompt may be open; says so after 3 s; schedules nothing else', async () => {
    const h = harness({ paired: true, permission: 'prompt' });
    const slow = deferred();
    h.server.health = slow.handler;
    await start(h);
    await advance(PERMISSION_WAIT_MS - 100);
    expect(status(h)).toBe('checking');
    await advance(100);
    expect(status(h)).toBe('waiting-permission');
    await advance(300_000);
    expect(slow.signal()?.aborted).toBe(false);
    expect(h.server.fetch).toHaveBeenCalledTimes(1);

    // The user allows: the request goes through.
    h.permission.set('granted');
    slow.resolve(jsonResponse({ ok: true, version: '0.1.0', vault: 'ready', app: 'portly', apiVersion: 1, instanceId: INSTANCE, appUrl: APP_URL }));
    await flush();
    expect(status(h)).toBe('connected');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('once granted, a hanging probe times out after 5 s', async () => {
    const h = harness({ paired: true, permission: 'prompt' });
    const slow = deferred();
    h.server.health = (url, init) => {
      void slow.handler(url, init);
      return hang(url, init);
    };
    await start(h);
    await advance(PERMISSION_WAIT_MS);
    expect(status(h)).toBe('waiting-permission');
    h.permission.set('granted');
    await advance(PROBE_TIMEOUT_MS - 1);
    expect(slow.signal()?.aborted).toBe(false);
    await advance(1);
    expect(slow.signal()?.aborted).toBe(true);
    expect(status(h)).toBe('absent');
  });

  it('a block while waiting → blocked (server backend: switch to the browser)', async () => {
    const h = harness({ paired: true, backend: 'server', permission: 'prompt' });
    const slow = deferred();
    h.server.health = slow.handler;
    await start(h);
    await advance(PERMISSION_WAIT_MS);
    h.permission.set('denied');
    slow.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(status(h)).toBe('blocked');
    expect(toast(h)).toBe('browser:blocked');
  });

  it('with the permission granted a probe gives up after 5 s and counts as unreachable', async () => {
    const h = harness({ paired: true });
    h.server.health = hang;
    await start(h);
    await advance(PROBE_TIMEOUT_MS);
    expect(status(h)).toBe('absent');
  });

  it('a timeout right after a server response is inconclusive: the status stays, and it retries', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    expect(status(h)).toBe('connected');
    await advance(10_000);
    h.controller.reportResponse();
    h.server.health = hang;
    h.controller.actions.checkNow();
    await advance(PROBE_TIMEOUT_MS);
    expect(status(h)).toBe('connected');
    const before = h.server.fetch.mock.calls.length;
    h.server.health = healthy();
    await advance(BACKOFF_MS[0]!);
    expect(h.server.fetch.mock.calls.length).toBeGreaterThan(before);
    expect(status(h)).toBe('connected');
  });

  it('a timeout with no recent response means reconnecting on a server-backend page', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    await advance(CONNECTED_INTERVAL_MS - 1);
    h.server.health = hang;
    await advance(1);
    await advance(PROBE_TIMEOUT_MS);
    expect(status(h)).toBe('reconnecting');
  });
});

describe('probe intervals', () => {
  it('connected: every 30 s, skipped while the server answered requests in the last 30 s', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    expect(h.server.fetch).toHaveBeenCalledTimes(2);
    await advance(CONNECTED_INTERVAL_MS);
    expect(h.server.fetch).toHaveBeenCalledTimes(4);
    await advance(20_000);
    h.controller.reportResponse();
    await advance(10_000);
    // Due now, but a response came 10 s ago: postponed to 30 s after it.
    expect(h.server.fetch).toHaveBeenCalledTimes(4);
    await advance(20_000);
    expect(h.server.fetch).toHaveBeenCalledTimes(6);
  });

  it('other states: backs off 5 → 10 → 20 → 30 → 60 s, reset by focus, visibility, online and checkNow', async () => {
    const h = harness({ paired: true });
    h.server.health = down;
    await start(h);
    const times: number[] = [];
    h.server.fetch.mockImplementation(async () => {
      times.push(Date.now() - START);
      throw new TypeError('Failed to fetch');
    });
    await advance(5_000 + 10_000 + 20_000 + 30_000 + 60_000 + 60_000);
    expect(times).toEqual([5_000, 15_000, 35_000, 65_000, 125_000, 185_000]);

    for (const reset of [() => h.page.emit('focus'), () => h.page.emit('visible'), () => h.page.emit('online'), () => h.controller.actions.checkNow()]) {
      times.length = 0;
      await advance(1_000);
      const at = Date.now() - START;
      reset();
      await flush();
      await advance(5_000);
      expect(times).toEqual([at, at + 5_000]);
    }
  });

  it('a hidden tab probes at most once a minute (reconnecting too), and at once when visible again (then the grace decides)', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    const times: number[] = [];
    h.server.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/health')) times.push(Date.now() - START);
      throw new TypeError('Failed to fetch');
    });
    h.page.emit('hidden');
    // The probe armed while visible still comes; from then on, once a minute.
    await advance(CONNECTED_INTERVAL_MS + 3 * HIDDEN_PROBE_INTERVAL_MS);
    const at = CONNECTED_INTERVAL_MS;
    expect(times).toEqual([at, at + HIDDEN_PROBE_INTERVAL_MS, at + 2 * HIDDEN_PROBE_INTERVAL_MS, at + 3 * HIDDEN_PROBE_INTERVAL_MS]);
    expect(status(h)).toBe('reconnecting');
    expect(h.reload).not.toHaveBeenCalled();
    times.length = 0;
    await advance(10_000);
    h.page.emit('visible');
    await flush();
    expect(times).toEqual([Date.now() - START]);
    // Gone since the first failed probe, more than the grace ago: the page switches now.
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:unreachable');
  });

  it('a permission or pairing change resets the backoff too', async () => {
    const h = harness({ paired: true });
    h.server.health = down;
    await start(h);
    await advance(5_000 + 10_000 + 20_000);
    const before = h.server.fetch.mock.calls.length;
    h.permission.set('granted');
    await flush();
    expect(h.server.fetch.mock.calls.length).toBe(before + 1);
    await advance(5_000);
    expect(h.server.fetch.mock.calls.length).toBe(before + 2);
  });
});

describe('reload policy', () => {
  it('a hidden tab waits until it is visible, checks once more, then reloads and announces it', async () => {
    const h = await start(harness({ paired: true, visible: false }));
    expect(status(h)).toBe('connected');
    expect(h.reload).not.toHaveBeenCalled();
    // The next page load already starts on the server (in case this tab is closed meanwhile).
    expect(h.store.nextBootBackend(Date.now())).toBe('server');
    expect(h.controller.getState().pendingSwitch).toBeNull();
    await advance(10 * 60_000);
    expect(h.reload).not.toHaveBeenCalled();
    const before = h.server.calls().length;
    h.page.emit('visible');
    expect(h.reload).not.toHaveBeenCalled();
    await flush();
    expect(h.server.calls().slice(before)).toEqual(['GET /api/health', 'GET /api/pairing']);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
  });

  it('a hidden tab drops a switch that no longer holds once it is visible again', async () => {
    const h = await start(harness({ paired: true, visible: false }));
    expect(h.reload).not.toHaveBeenCalled();
    h.server.health = down;
    await advance(10 * 60_000);
    h.page.emit('visible');
    await flush();
    expect(status(h)).toBe('absent');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.controller.getState().pendingSwitch).toBeNull();
    await advance(60_000);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a hidden tab that cannot check again applies the switch as it was requested', async () => {
    // Another tab disconnected: not paired any more, and the permission does not allow a look.
    const h = await start(harness({ paired: true, backend: 'server', permission: 'prompt' }));
    expect(status(h)).toBe('connected');
    h.page.emit('hidden');
    h.local.removeItem(h.store.keys.pairing);
    h.pairingChanged();
    expect(h.reload).not.toHaveBeenCalled();
    const before = h.server.calls().length;
    h.page.emit('visible');
    expect(h.server.calls().length).toBe(before);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:disconnected');
  });

  it('a visible, idle tab reloads now and announces it after the reload', async () => {
    const h = await start(harness({ paired: true }));
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
    expect(h.controller.getState().pendingSwitch).toBeNull();
  });

  it('a busy tab waits (pendingSwitch), checks every 2 s, and reloads once idle', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.controller.getState().pendingSwitch).toEqual({ target: 'server', reason: 'connected' });
    await advance(10_000);
    expect(h.reload).not.toHaveBeenCalled();
    h.busy.value = false;
    await advance(2_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
  });

  it('Switch now reloads a busy tab', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.controller.actions.switchNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
    // Nothing more happens after the reload was asked for.
    h.controller.actions.switchNow();
    await advance(60_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('Switch now without a pending switch does nothing', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.controller.actions.switchNow();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a busy tab that gets hidden waits too (no idle checks while hidden)', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.page.emit('hidden');
    h.busy.value = false;
    await advance(60_000);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a busy tab coming back idle checks once more and reloads', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.page.emit('hidden');
    h.busy.value = false;
    h.page.emit('visible');
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
  });

  it('a busy tab coming back still busy keeps waiting (pendingSwitch) until it is idle', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.page.emit('hidden');
    h.page.emit('visible');
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.controller.getState().pendingSwitch).toEqual({ target: 'server', reason: 'connected' });
    h.busy.value = false;
    await advance(2_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('withdraws a pending switch to the server that went away', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.server.health = down;
    await advance(CONNECTED_INTERVAL_MS);
    expect(status(h)).toBe('absent');
    expect(h.controller.getState().pendingSwitch).toBeNull();
    h.busy.value = false;
    await advance(4_000);
    expect(h.reload).not.toHaveBeenCalled();
  });
});

describe('when storage refuses the hints (full)', () => {
  const keys = { pairing: 'portly:pairing:/', mode: 'portly:backend-mode:/', seen: 'portly:server-seen:/' };
  /** A full localStorage that already holds this browser's pairing. */
  const full = (items: Record<string, string> = {}) => fullStorage({ [keys.pairing]: JSON.stringify(pairingRecord()), ...items });

  it('a switch to the browser still lands on the browser (the hints go), and that load does not switch again', async () => {
    // `browser` is one character longer than `server`: refused.
    const local = full({ [keys.mode]: 'server', [keys.seen]: String(START) });
    const h = harness({ backend: 'server', local });
    h.server.health = healthy({ apiVersion: 99 });
    await start(h);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:incompatible');
    expect(local.items.has(keys.mode)).toBe(false);
    expect(local.items.has(keys.seen)).toBe(false);
    const backend = h.store.nextBootBackend(Date.now());
    expect(backend).toBe('browser');

    const next = harness({ backend, local });
    next.server.health = healthy({ apiVersion: 99 });
    await start(next);
    expect(status(next)).toBe('incompatible');
    expect(next.reload).not.toHaveBeenCalled();
  });

  it('a switch to the server the next load would not make waits (no reload loop); Switch now still reloads', async () => {
    const local = full();
    const h = await start(harness({ local }));
    expect(status(h)).toBe('connected');
    expect(h.store.nextBootBackend(Date.now())).toBe('browser');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.controller.getState().pendingSwitch).toEqual({ target: 'server', reason: 'connected' });
    await advance(30_000);
    expect(h.reload).not.toHaveBeenCalled();
    h.page.emit('hidden');
    h.page.emit('visible');
    expect(h.reload).not.toHaveBeenCalled();
    // The user asked: reload, but announce nothing that will not happen.
    h.controller.actions.switchNow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBeNull();
  });

  it('…and goes ahead once storage takes the hints again', async () => {
    const local = full();
    const h = await start(harness({ local }));
    expect(h.reload).not.toHaveBeenCalled();
    local.full = false;
    await advance(2_000);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
    expect(h.store.nextBootBackend(Date.now())).toBe('server');
  });

  it('a switch to the server goes ahead when a fresh sighting makes the next load pick it anyway', async () => {
    // An old sighting: rewriting it does not grow storage, unlike adding the mode key.
    const local = full({ [keys.seen]: String(START - 86_400_000) });
    const h = await start(harness({ local }));
    expect(local.items.has(keys.mode)).toBe(false);
    expect(h.store.lastServerSeenAt()).toBe(START);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('server:connected');
    expect(h.store.nextBootBackend(Date.now())).toBe('server');
  });
});

describe('whenServerReady', () => {
  it('rejects on a browser-backend page', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    await expect(h.controller.whenServerReady()).rejects.toBeInstanceOf(ServerModeEndedError);
  });

  it('waits while checking, then resolves once connected', async () => {
    const h = harness({ paired: true, backend: 'server' });
    const ready = vi.fn();
    void h.controller.whenServerReady().then(ready);
    await flush();
    expect(ready).not.toHaveBeenCalled();
    await start(h);
    expect(ready).toHaveBeenCalledTimes(1);
    // Connected: resolves at once.
    await expect(h.controller.whenServerReady()).resolves.toBeUndefined();
  });

  it('waits through a reconnect and while waiting for the permission', async () => {
    const h = harness({ paired: true, backend: 'server', permission: 'unsupported' });
    h.server.health = down;
    await start(h);
    expect(status(h)).toBe('reconnecting');
    const ready = vi.fn();
    const failed = vi.fn();
    void h.controller.whenServerReady().then(ready, failed);
    const slow = deferred();
    h.server.health = slow.handler;
    await advance(RECONNECT_INTERVAL_MS + PERMISSION_WAIT_MS);
    expect(status(h)).toBe('waiting-permission');
    expect(ready).not.toHaveBeenCalled();
    slow.resolve(jsonResponse({ ok: true, version: '0.1.0', vault: 'ready', app: 'portly', apiVersion: 1, instanceId: INSTANCE, appUrl: APP_URL }));
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('rejects with ServerModeEndedError once a switch to the browser is requested, even before the reload', async () => {
    const h = harness({ paired: true, backend: 'server', busy: true });
    h.server.pairing = () => pairingRequired();
    const pending = h.controller.whenServerReady();
    pending.catch(() => {});
    await start(h);
    await expect(pending).rejects.toBeInstanceOf(ServerModeEndedError);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.controller.getState().pendingSwitch).toEqual({ target: 'browser', reason: 'revoked' });
    await expect(h.controller.whenServerReady()).rejects.toBeInstanceOf(ServerModeEndedError);
  });

  it('rejects after the grace', async () => {
    const h = harness({ paired: true, backend: 'server' });
    h.server.health = down;
    await start(h);
    const pending = h.controller.whenServerReady();
    pending.catch(() => {});
    await advance(GRACE_MS + RECONNECT_INTERVAL_MS);
    await expect(pending).rejects.toBeInstanceOf(ServerModeEndedError);
  });

  it("rejects with the signal's reason when it aborts, and stops listening", async () => {
    const h = harness({ paired: true, backend: 'server' });
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = h.controller.whenServerReady(abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    // Already aborted: rejects at once.
    await expect(h.controller.whenServerReady(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops listening to the signal once settled', async () => {
    const h = harness({ paired: true, backend: 'server' });
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = h.controller.whenServerReady(abort.signal);
    await start(h);
    await expect(pending).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects once the controller stops', async () => {
    const h = harness({ paired: true, backend: 'server' });
    const pending = h.controller.whenServerReady();
    h.controller.stop();
    await expect(pending).rejects.toBeInstanceOf(ServerModeEndedError);
  });
});

describe('what requests report', () => {
  it('a network failure makes a server-backend page probe now (reconnecting if it fails)', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await flush();
    expect(h.server.calls().at(-1)).toBe('GET /api/health');
    expect(status(h)).toBe('reconnecting');
  });

  it('nothing is reported on a browser-backend page', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    const calls = h.server.fetch.mock.calls.length;
    h.controller.reportNetworkFailure();
    h.controller.reportResponse();
    h.controller.reportUnpaired(TOKEN);
    await flush();
    expect(h.server.fetch).toHaveBeenCalledTimes(calls);
    expect(h.store.read()).not.toBeNull();
  });

  it('a response while reconnecting confirms the server right away', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await flush();
    h.server.health = healthy();
    h.controller.reportResponse();
    await flush();
    expect(status(h)).toBe('connected');
  });

  it('a 401 pairing_required makes it check; the paired server refusing → revoked, cleared, switch to the browser', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    const calls = h.server.fetch.mock.calls.length;
    h.server.pairing = () => pairingRequired();
    h.controller.reportUnpaired(TOKEN);
    // Not cleared on the request's word alone.
    expect(h.store.read()?.token).toBe(TOKEN);
    await flush();
    expect(h.server.calls().slice(calls)).toEqual(['GET /api/health', 'GET /api/pairing']);
    expect(h.controller.getState()).toMatchObject({ status: 'revoked', paired: false });
    expect(h.store.read()).toBeNull();
    expect(toast(h)).toBe('browser:revoked');
    expect(h.store.lastMode()).toBe('browser');
  });

  it('a 401 pairing_required from another Portly now on the port keeps the pairing (and the token stays home)', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    const calls = h.server.fetch.mock.calls.length;
    h.server.health = healthy({ instanceId: OTHER_INSTANCE });
    h.server.pairing = () => pairingRequired();
    h.controller.reportUnpaired(TOKEN);
    await flush();
    expect(h.server.calls().slice(calls)).toEqual(['GET /api/health']);
    expect(h.controller.getState()).toMatchObject({ status: 'other-server', paired: true });
    expect(h.store.read()?.token).toBe(TOKEN);
    expect(toast(h)).toBe('browser:other-server');
  });

  it('a 401 pairing_required the paired server does not confirm changes nothing', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.controller.reportUnpaired(TOKEN);
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'connected', paired: true, pendingSwitch: null });
    expect(h.store.read()?.token).toBe(TOKEN);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it("a 401 for a token another tab already replaced keeps the new pairing and checks it", async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.store.save(pairingRecord({ token: NEW_TOKEN }));
    const calls = h.server.fetch.mock.calls.length;
    h.controller.reportUnpaired(TOKEN);
    await flush();
    expect(h.store.read()?.token).toBe(NEW_TOKEN);
    expect(h.controller.token()).toBe(NEW_TOKEN);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.server.fetch.mock.calls.length).toBe(calls + 2);
    const [, init] = h.server.fetch.mock.calls.at(-1)!;
    expect(new Headers(init?.headers).get('X-Portly-Token')).toBe(NEW_TOKEN);
  });
});

describe('the pairing record', () => {
  it('is cleared compare-and-clear: a newer pairing saved meanwhile survives a revoke', async () => {
    const h = harness({ paired: true });
    h.server.pairing = () => {
      // Another tab re-paired while this check was on its way.
      h.store.save(pairingRecord({ token: NEW_TOKEN }));
      return pairingRequired();
    };
    await start(h);
    expect(h.store.read()?.token).toBe(NEW_TOKEN);
    expect(h.controller.getState().paired).toBe(true);
  });

  it('another tab pairing makes an unpaired page check (and switch)', async () => {
    const h = await start(harness());
    expect(status(h)).toBe('unpaired');
    h.store.save(pairingRecord());
    h.pairingChanged();
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'connected', paired: true });
    expect(toast(h)).toBe('server:connected');
  });

  it('another tab disconnecting sends a server-backend page to the browser', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.local.removeItem(h.store.keys.pairing);
    h.pairingChanged();
    expect(h.controller.getState()).toMatchObject({ status: 'unpaired', paired: false });
    expect(toast(h)).toBe('browser:disconnected');
  });

  it('another tab pairing with another server sends a server-backend page to the browser', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.store.save(pairingRecord({ token: NEW_TOKEN, instanceId: OTHER_INSTANCE }));
    h.pairingChanged();
    expect(toast(h)).toBe('browser:other-server');
  });

  it("a busy server-backend page never adopts the other server another tab paired with (it switches once idle)", async () => {
    for (const resetFirst of [false, true]) {
      const h = await start(harness({ paired: true, backend: 'server', busy: true }));
      h.server.health = healthy({ instanceId: OTHER_INSTANCE });
      h.server.pairing = accepted(OTHER_INSTANCE);
      if (resetFirst) {
        // The server came back as another instance first: that switch is already pending.
        h.controller.actions.checkNow();
        await flush();
        expect(status(h)).toBe('other-server');
      }
      h.store.save(pairingRecord({ token: NEW_TOKEN, instanceId: OTHER_INSTANCE }));
      h.pairingChanged();
      expect(h.controller.getState().pendingSwitch).toEqual({ target: 'browser', reason: 'other-server' });
      // The new pairing is accepted by the new server: connected, but not with this page's data.
      await advance(CONNECTED_INTERVAL_MS);
      expect(h.server.calls().at(-1)).toBe('GET /api/pairing');
      expect(h.controller.getState()).toMatchObject({ status: 'connected', pendingSwitch: { target: 'browser', reason: 'other-server' } });
      await expect(h.controller.whenServerReady()).rejects.toBeInstanceOf(ServerModeEndedError);
      expect(h.reload).not.toHaveBeenCalled();
      h.busy.value = false;
      await advance(2_000);
      expect(h.reload).toHaveBeenCalledTimes(1);
      expect(toast(h)).toBe('browser:other-server');
      // Written again at the reload, over the connected probe's `server`.
      expect(h.store.nextBootBackend(Date.now())).toBe('browser');
      h.controller.stop();
    }
  });

  it("a pending switch is withdrawn when the page's own server answers again", async () => {
    const h = await start(harness({ paired: true, backend: 'server', busy: true }));
    h.server.health = healthy({ instanceId: OTHER_INSTANCE });
    h.controller.actions.checkNow();
    await flush();
    expect(h.controller.getState().pendingSwitch).toEqual({ target: 'browser', reason: 'other-server' });
    h.server.health = healthy();
    await advance(BACKOFF_MS[0]!);
    expect(h.controller.getState()).toMatchObject({ status: 'connected', pendingSwitch: null });
    await expect(h.controller.whenServerReady()).resolves.toBeUndefined();
    h.busy.value = false;
    await advance(4_000);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('a storage event that changes nothing is ignored', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    const calls = h.server.fetch.mock.calls.length;
    h.pairingChanged();
    await flush();
    expect(h.server.fetch).toHaveBeenCalledTimes(calls);
  });
});

describe('hints for the next page load', () => {
  it('writes lastServerSeenAt at most once a minute, and lastMode = server', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    expect(h.store.lastServerSeenAt()).toBe(START);
    await advance(CONNECTED_INTERVAL_MS);
    expect(h.store.lastServerSeenAt()).toBe(START);
    await advance(CONNECTED_INTERVAL_MS);
    expect(h.store.lastServerSeenAt()).toBe(START + 60_000);
    expect(h.store.lastMode()).toBe('server');
    // Requests count as sightings too.
    await advance(60_000);
    h.controller.reportResponse();
    expect(h.store.lastServerSeenAt()).toBe(START + 120_000);
  });

  it('writes nothing when the server is not the paired one', async () => {
    const h = harness({ paired: true });
    h.server.health = healthy({ instanceId: OTHER_INSTANCE });
    await start(h);
    expect(h.store.lastServerSeenAt()).toBeNull();
    expect(h.store.lastMode()).toBeNull();
  });
});

describe('actions', () => {
  it('Check again shows Checking… and probes now', async () => {
    const h = harness({ paired: true });
    h.server.health = down;
    await start(h);
    expect(status(h)).toBe('absent');
    h.server.health = hang;
    h.controller.actions.checkNow();
    expect(h.controller.getState()).toMatchObject({ status: 'checking', manual: true });
  });

  it('background re-probes keep the status as it is', async () => {
    const h = harness({ paired: true });
    h.server.health = down;
    await start(h);
    h.server.health = hang;
    await advance(BACKOFF_MS[0]!);
    expect(h.controller.getState()).toMatchObject({ status: 'absent', manual: false });
  });

  it('pairing probes first when needed, then sends the tab to the server with a fresh nonce', async () => {
    const h = await start(harness({ permission: 'prompt' }));
    expect(status(h)).toBe('idle');
    h.controller.actions.startPairing();
    await flush();
    expect(h.server.calls()).toEqual(['GET /api/health']);
    const nonce = h.session.getItem(PAIRING_NONCE_KEY);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.assign).toHaveBeenCalledWith(`${APP_URL}#/pair?nonce=${nonce}`);
  });

  it('pairing uses a recent healthy probe without probing again', async () => {
    const h = await start(harness());
    h.controller.actions.startPairing();
    await flush();
    expect(h.server.fetch).toHaveBeenCalledTimes(1);
    expect(h.assign).toHaveBeenCalledTimes(1);
  });

  it("pairing falls back to the build's origin when the server reports an unsafe page", async () => {
    const h = harness();
    h.server.health = healthy({ appUrl: 'javascript:alert(1)//' });
    await start(h);
    h.controller.actions.startPairing();
    await flush();
    expect(h.assign.mock.calls[0]?.[0]).toMatch(new RegExp(`^${ORIGIN}/#/pair\\?nonce=`));
  });

  it('pairing does nothing while the server is not there', async () => {
    const h = harness();
    h.server.health = down;
    await start(h);
    h.controller.actions.startPairing();
    await flush();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.session.getItem(PAIRING_NONCE_KEY)).toBeNull();
  });

  it('disconnect on a server-backend page forgets the pairing everywhere and reloads, busy or not', async () => {
    const h = await start(harness({ paired: true, backend: 'server', busy: true }));
    h.local.setItem(SERVER_CACHE_KEY, '{"snapshot":true}');
    await h.controller.actions.disconnect();
    const [url, init] = h.server.fetch.mock.calls.at(-1)!;
    expect(url).toBe(`${ORIGIN}/api/pairing`);
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('X-Portly-Token')).toBe(TOKEN);
    expect(new Headers(init?.headers).get('X-Portly')).toBe('1');
    expect(h.store.read()).toBeNull();
    expect(h.local.getItem(SERVER_CACHE_KEY)).toBeNull();
    expect(h.store.lastMode()).toBe('browser');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toast(h)).toBe('browser:disconnected');
  });

  it('disconnect still forgets the pairing here when the server cannot be told (and waits at most 3 s)', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    h.server.forget = hang;
    const done = vi.fn();
    void h.controller.actions.disconnect().then(done);
    await advance(2_999);
    expect(done).not.toHaveBeenCalled();
    await advance(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(h.store.read()).toBeNull();
    expect(h.controller.getState()).toMatchObject({ paired: false, status: 'unpaired', pendingSwitch: null });
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('disconnect never sends the token to another Portly on the port (it forgets the pairing here only)', async () => {
    // Known as another one, or another one took the port since the last probe.
    for (const known of [true, false]) {
      const h = harness({ paired: true, busy: true });
      if (known) h.server.health = healthy({ instanceId: OTHER_INSTANCE });
      await start(h);
      expect(status(h)).toBe(known ? 'other-server' : 'connected');
      h.server.health = healthy({ instanceId: OTHER_INSTANCE });
      const calls = h.server.fetch.mock.calls.length;
      await h.controller.actions.disconnect();
      expect(h.server.calls().slice(calls)).not.toContain('DELETE /api/pairing');
      for (const [, init] of h.server.fetch.mock.calls.slice(calls)) expect(new Headers(init?.headers).has('X-Portly-Token')).toBe(false);
      expect(h.store.read()).toBeNull();
      expect(h.controller.getState()).toMatchObject({ paired: false, status: 'unpaired' });
      h.controller.stop();
    }
  });

  it('disconnect with the permission denied shows Blocked, not Not checked or Found, not paired', async () => {
    // Blocked from the start, and blocked after a healthy probe.
    for (const before of ['denied', 'granted'] as const) {
      const h = await start(harness({ paired: true, busy: true, permission: before }));
      if (before === 'granted') {
        expect(status(h)).toBe('connected');
        h.permission.set('denied');
        await flush();
      }
      expect(status(h)).toBe('blocked');
      await h.controller.actions.disconnect();
      await flush();
      expect(h.controller.getState()).toMatchObject({ paired: false, status: 'blocked', permission: 'denied' });
      h.controller.stop();
    }
  });

  it('disconnect clears only the pairing it knew about', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.forget = () => {
      h.store.save(pairingRecord({ token: NEW_TOKEN }));
      return jsonResponse(null, 204);
    };
    await h.controller.actions.disconnect();
    expect(h.store.read()?.token).toBe(NEW_TOKEN);
  });
});

describe('the no-cors fallback (a server that does not accept this site)', () => {
  it('after a failed CORS probe, one no-cors request tells "answers without CORS" from nothing', async () => {
    const h = harness({ noCors: true });
    h.server.health = refusesCors;
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'absent', unreachableReason: 'answers-without-cors' });
    expect(h.server.calls()).toEqual(['GET /api/health', 'GET /api/health']);
    expect(h.server.fetch.mock.calls[1]![1]).toMatchObject({ mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', targetAddressSpace: 'loopback' });

    // Nothing answers at all: no reason.
    h.server.health = down;
    h.controller.actions.checkNow();
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'absent', unreachableReason: null });
  });

  it('never sends the pairing token (or any header) with it', async () => {
    const h = harness({ noCors: true, paired: true, backend: 'server' });
    h.server.health = refusesCors;
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'reconnecting', unreachableReason: 'answers-without-cors' });
    for (const [, init] of h.server.fetch.mock.calls) {
      expect(init?.headers === undefined || !new Headers(init.headers).has('X-Portly-Token')).toBe(true);
    }
    const noCors = h.server.fetch.mock.calls.filter(([, init]) => init?.mode === 'no-cors');
    expect(noCors).toHaveLength(1);
    expect(noCors[0]![1]?.headers).toBeUndefined();
    // The server accepts this site again: connected, and the reason goes.
    h.server.health = healthy();
    await advance(RECONNECT_INTERVAL_MS);
    expect(h.controller.getState()).toMatchObject({ status: 'connected', unreachableReason: null });
  });

  it('only when it cannot show the permission prompt (granted, or no such permission)', async () => {
    for (const permission of ['prompt', 'granted', 'unsupported'] as const) {
      const h = harness({ noCors: true, paired: true, permission });
      h.server.health = down;
      await start(h);
      expect(h.server.calls()).toEqual(permission === 'prompt' ? ['GET /api/health'] : ['GET /api/health', 'GET /api/health']);
      h.controller.stop();
    }
  });

  it('the reason goes with the status it explains (blocked, waiting for the permission)', async () => {
    const h = harness({ noCors: true });
    h.server.health = refusesCors;
    await start(h);
    expect(h.controller.getState()).toMatchObject({ status: 'absent', unreachableReason: 'answers-without-cors' });
    h.permission.set('denied');
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'blocked', unreachableReason: null });

    const prompt = harness({ noCors: true });
    prompt.server.health = refusesCors;
    await start(prompt);
    prompt.permission.set('prompt');
    prompt.server.health = hang;
    prompt.controller.actions.lookForServer();
    await flush();
    // Checking again keeps it until the probe says more…
    expect(prompt.controller.getState()).toMatchObject({ status: 'checking', unreachableReason: 'answers-without-cors' });
    await advance(PERMISSION_WAIT_MS);
    // …but a status it does not explain drops it.
    expect(prompt.controller.getState()).toMatchObject({ status: 'waiting-permission', unreachableReason: null });
    prompt.controller.stop();
  });

  it('not after a timeout or a non-Portly answer', async () => {
    const h = harness({ noCors: true, paired: true });
    h.server.health = hang;
    await start(h);
    await advance(PROBE_TIMEOUT_MS);
    expect(h.server.calls()).toEqual(['GET /api/health']);
    h.server.health = () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    h.controller.actions.checkNow();
    await flush();
    expect(h.server.calls()).toEqual(['GET /api/health', 'GET /api/health']);
    expect(h.controller.getState()).toMatchObject({ status: 'absent', unreachableReason: null });
  });
});

describe('diagnostic events', () => {
  const messages = (h: Harness, level?: string) => h.events.filter((event) => level === undefined || event.level === level).map((event) => event.msg);
  const find = (h: Harness, msg: string) => h.events.filter((event) => event.msg === msg);

  it("a page load's first routine status is debug; a later change is info, with the probe that caused it", async () => {
    const h = harness({ paired: true, busy: true });
    h.server.health = down;
    await start(h);
    expect(find(h, 'hybrid status changed').at(-1)).toMatchObject({ level: 'debug', fields: { from: 'checking', to: 'absent', reason: 'unreachable' } });
    h.server.health = healthy();
    await advance(BACKOFF_MS[0]!);
    expect(find(h, 'hybrid status changed').at(-1)).toMatchObject({
      level: 'info',
      fields: { from: 'absent', to: 'connected', reason: 'connected', kind: 'connected', httpStatus: 200, timedOut: false, errName: null, permission: 'granted' },
    });
    // The first probe of a page load is routine; the next one's change is the status event's.
    expect(find(h, 'probe result').map((event) => event.level)).toEqual(['debug', 'debug']);
    // The same result again: debug only, and no status event.
    const before = h.events.length;
    await advance(CONNECTED_INTERVAL_MS);
    expect(h.events.slice(before).map((event) => `${event.level} ${event.msg}`)).toEqual(['debug probe result']);
  });

  it('a changed result that leaves the status as it was is an info probe result', async () => {
    const h = harness({ paired: true, busy: true, noCors: true });
    h.server.health = down;
    await start(h);
    const statusEvents = find(h, 'hybrid status changed').length;
    // Still absent, but now something answers without CORS.
    h.server.health = refusesCors;
    await advance(BACKOFF_MS[0]!);
    expect(status(h)).toBe('absent');
    expect(find(h, 'hybrid status changed')).toHaveLength(statusEvents);
    expect(find(h, 'probe result').map((event) => [event.level, event.fields.reason])).toEqual([
      ['debug', 'unreachable'],
      ['info', 'answers-without-cors'],
    ]);
  });

  it("a page load's first status is compared with the one reported last (earlier page loads)", async () => {
    for (const [lastReported, level] of [
      [{ status: 'absent', reason: 'unreachable' }, 'debug'],
      [{ status: 'connected', reason: 'connected' }, 'info'],
      [{ status: 'absent', reason: 'answers-without-cors' }, 'info'],
    ] as const) {
      const h = harness({ paired: true, busy: true, lastReported });
      h.server.health = down;
      await start(h);
      expect(find(h, 'hybrid status changed').at(-1)).toMatchObject({ level, fields: { from: lastReported.status, to: 'absent', reason: 'unreachable' } });
      h.controller.stop();
    }
  });

  it('a first status that needs the user is info', async () => {
    const h = harness({ paired: true });
    h.server.health = healthy({ apiVersion: 99 });
    await start(h);
    expect(find(h, 'hybrid status changed')).toEqual([expect.objectContaining({ level: 'info', fields: expect.objectContaining({ to: 'incompatible', reason: 'incompatible' }) })]);
  });

  it('a server-backend page: losing the server, the grace, and the switch to the browser', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await flush();
    expect(find(h, 'hybrid status changed').at(-1)).toMatchObject({ level: 'info', fields: { from: 'connected', to: 'reconnecting', reason: 'unreachable', errName: 'TypeError', httpStatus: null } });
    expect(find(h, 'reconnect grace started')).toEqual([expect.objectContaining({ level: 'warn', fields: { reason: 'unreachable', graceMs: GRACE_MS } })]);
    // The status event carries the probe: its own event stays debug.
    expect(find(h, 'probe result').map((event) => event.level)).toEqual(['debug', 'debug']);
    await advance(GRACE_MS + RECONNECT_INTERVAL_MS);
    expect(find(h, 'reconnect grace ended')).toEqual([expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ reason: 'expired' }) })]);
    expect(find(h, 'backend switch requested')).toEqual([expect.objectContaining({ level: 'info', fields: { target: 'browser', reason: 'unreachable' } })]);
    expect(find(h, 'backend switch performed')).toEqual([expect.objectContaining({ level: 'info', fields: { target: 'browser', reason: 'unreachable', kind: 'idle' } })]);
    // Recorded before the reload.
    expect(h.events.at(-1)?.msg).toBe('backend switch performed');
  });

  it('the grace ends when the server answers again', async () => {
    const h = await start(harness({ paired: true, backend: 'server' }));
    h.server.health = down;
    h.controller.reportNetworkFailure();
    await flush();
    h.server.health = healthy();
    await advance(RECONNECT_INTERVAL_MS);
    expect(find(h, 'reconnect grace ended')).toEqual([expect.objectContaining({ level: 'info', fields: { reason: 'connected', graceMs: RECONNECT_INTERVAL_MS } })]);
  });

  it('a failing pairing check is a warning once, then debug while it keeps failing the same way', async () => {
    const h = harness({ paired: true, backend: 'server' });
    h.server.pairing = () => jsonResponse({ error: { code: 'internal', message: 'x' } }, 500);
    await start(h);
    await advance(3 * RECONNECT_INTERVAL_MS);
    expect(find(h, 'pairing check failed').map((event) => event.level)).toEqual(['warn', 'debug', 'debug', 'debug']);
    expect(find(h, 'pairing check failed')[0]?.fields).toMatchObject({ kind: 'pairing-error', reason: 'pairing-error', httpStatus: 500 });
  });

  it('a revoked pairing is a warning', async () => {
    const h = harness({ paired: true, backend: 'server', busy: true });
    h.server.pairing = () => pairingRequired();
    await start(h);
    expect(find(h, 'pairing revoked by Portly on this PC')).toEqual([expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ httpStatus: 401 }) })]);
    expect(find(h, 'backend switch deferred')).toEqual([expect.objectContaining({ fields: { target: 'browser', reason: 'revoked', kind: 'busy' } })]);
  });

  it('a busy page reports a deferred switch once, and a withdrawn one', async () => {
    const h = await start(harness({ paired: true, busy: true }));
    await advance(10_000);
    expect(find(h, 'backend switch deferred')).toHaveLength(1);
    h.server.health = down;
    await advance(CONNECTED_INTERVAL_MS);
    expect(find(h, 'backend switch withdrawn')).toEqual([expect.objectContaining({ fields: { target: 'server', reason: 'connected' } })]);
  });

  it('permission changes, other tabs and disconnecting', async () => {
    const h = await start(harness({ permission: 'prompt', busy: true }));
    h.permission.set('granted');
    await flush();
    expect(find(h, 'local network permission changed')).toEqual([expect.objectContaining({ fields: { from: 'prompt', to: 'granted' } })]);
    h.store.save(pairingRecord());
    h.pairingChanged();
    await flush();
    expect(find(h, 'pairing changed in another tab')).toEqual([expect.objectContaining({ fields: { kind: 'added' } })]);
    await h.controller.actions.disconnect();
    expect(messages(h, 'info')).toContain('disconnecting this browser');
  });

  it('a throwing diag callback never disturbs the controller', async () => {
    const h = harness({ paired: true });
    h.deps.diag = () => {
      throw new Error('broken');
    };
    const controller = createLocalServerController(h.deps);
    controller.start();
    await flush();
    expect(controller.getState().status).toBe('connected');
    controller.stop();
  });
});
