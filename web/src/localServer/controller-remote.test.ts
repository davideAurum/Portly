/**
 * The local server controller with a connection to Portly on another PC (ARCHITECTURE §20): the
 * record's `remoteOrigin` sends every probe, check and request there with the device secret and no
 * loopback options; the device check's 401 clears the record; disconnecting tells that server; and
 * a record that changes to another server mid-probe makes the probe inconclusive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTANCE, ORIGIN, START, TOKEN, harness, healthBody, jsonResponse, pairingRecord, type Harness } from './__fixtures__/fakes.ts';
import { MODE_SWITCH_TOAST_KEY } from './pairing.ts';

const REMOTE = 'https://desk.tail1234.ts.net';

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** A controller whose record is a connection to {@link REMOTE}; that server answers through `server.other`. */
function remoteHarness(options: { backend?: 'browser' | 'server'; device?: () => Response } = {}): Harness & { remoteCalls(): string[] } {
  const h = harness({ backend: options.backend ?? 'browser', paired: pairingRecord({ remoteOrigin: REMOTE }) });
  h.server.other = (url, init) => {
    if (url === `${REMOTE}/api/health`) return jsonResponse(healthBody({ remote: true, appUrl: undefined }));
    if (url === `${REMOTE}/api/device` && (init.method ?? 'GET') === 'GET') {
      return options.device?.() ?? jsonResponse({ device: { id: 'device-1', label: 'Laptop', createdAt: '2026-10-01T10:00:00.000Z' } });
    }
    if (url === `${REMOTE}/api/device`) return jsonResponse(null, 204);
    return jsonResponse({ ok: true });
  };
  return { ...h, remoteCalls: () => h.server.fetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${input}`) };
}

describe('controller: Portly on another PC', () => {
  it('probes the remote address with the device secret and no loopback options, and connects', async () => {
    const h = remoteHarness();
    expect(h.controller.getState()).toMatchObject({ paired: true, remoteOrigin: REMOTE });
    h.controller.start();
    await flush();
    expect(h.controller.getState().status).toBe('connected');
    expect(h.remoteCalls()).toEqual([`GET ${REMOTE}/api/health`, `GET ${REMOTE}/api/device`]);
    for (const [, init] of h.server.fetch.mock.calls) {
      expect(init).toMatchObject({ mode: 'cors', credentials: 'omit' });
      expect((init as { targetAddressSpace?: unknown }).targetAddressSpace).toBeUndefined();
    }
    const check = new Headers(h.server.fetch.mock.calls[1]?.[1]?.headers);
    expect(check.get('X-Portly-Device')).toBe(TOKEN);
    expect(check.get('X-Portly-Token')).toBeNull();
    // Nothing goes to this PC's loopback address.
    expect(h.remoteCalls().some((call) => call.includes(ORIGIN))).toBe(false);
    expect(h.controller.link()).toEqual({ origin: REMOTE, remote: true, token: TOKEN });
    // A browser-backend page switches to the server like for this PC's Portly.
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.session.getItem(MODE_SWITCH_TOAST_KEY)).toBe('server:connected:remote');
    h.controller.stop();
  });

  it('clears the record when the device check answers login_required, and names the main PC meanwhile', async () => {
    const h = remoteHarness({
      backend: 'server',
      device: () => jsonResponse({ error: { code: 'login_required', message: 'This device is not connected to Portly' } }, 401),
    });
    h.controller.start();
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'revoked', paired: false, remoteOrigin: REMOTE });
    expect(h.store.read()).toBeNull();
    expect(h.session.getItem(MODE_SWITCH_TOAST_KEY)).toBe('browser:revoked:remote');
    h.controller.stop();
  });

  it('tells the remote server to forget this browser on disconnect (DELETE /api/device)', async () => {
    const h = remoteHarness();
    await h.controller.actions.disconnect();
    expect(h.remoteCalls()).toContain(`DELETE ${REMOTE}/api/device`);
    const forget = h.server.fetch.mock.calls.find(([input, init]) => input === `${REMOTE}/api/device` && init?.method === 'DELETE');
    expect(new Headers(forget?.[1]?.headers).get('X-Portly-Device')).toBe(TOKEN);
    expect(h.store.read()).toBeNull();
    expect(h.controller.getState()).toMatchObject({ paired: false, remoteOrigin: null });
  });

  it('never starts pairing with Portly on this PC while connected to another PC', async () => {
    const h = remoteHarness();
    h.controller.start();
    await flush();
    h.controller.actions.startPairing();
    await flush();
    expect(h.assign).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('follows a record another tab saved for another PC: the next probe goes there', async () => {
    const h = harness({ backend: 'browser' });
    h.server.other = (url) => (url === `${REMOTE}/api/health` ? jsonResponse(healthBody({ remote: true })) : jsonResponse({ device: { id: 'd', label: 'L', createdAt: '2026-10-01T10:00:00.000Z' } }));
    h.controller.start();
    await flush();
    h.store.save(pairingRecord({ remoteOrigin: REMOTE, instanceId: INSTANCE }));
    h.pairingChanged();
    await flush();
    expect(h.controller.getState()).toMatchObject({ status: 'connected', remoteOrigin: REMOTE });
    expect(h.server.calls().at(-1)).toBe(`GET ${REMOTE}/api/device`);
    h.controller.stop();
  });
});
