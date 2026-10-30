/**
 * Connecting the Pages site to Portly on another PC: the address the user types, the check of
 * what answers there, and the connect requests with their secrets in bodies and headers (never a
 * cookie), ending in a pairing record that names the address.
 */
import { describe, expect, it, vi } from 'vitest';
import { isApiError } from '../api/client.ts';
import { INSTANCE, START, healthBody, jsonResponse, memoryStorage } from './__fixtures__/fakes.ts';
import { REMOTE_SERVER_CSP_SOURCE, parseRemoteServerAddress } from './origin.ts';
import { createPairingStore } from './pairing.ts';
import { REMOTE_ENROLL_KEY, checkRemoteServer, createRemoteConnectClient, remoteAddressKey } from './remote.ts';
import type { FetchLike } from './probe.ts';

const REMOTE = 'https://desk.tail1234.ts.net';
const ENROLL = 'E'.repeat(43);
const DEVICE = 'D'.repeat(43);

describe('parseRemoteServerAddress', () => {
  it('accepts a Tailscale Serve address, with or without https:// and a trailing slash', () => {
    for (const raw of ['desk.tail1234.ts.net', ' https://desk.tail1234.ts.net ', 'https://desk.tail1234.ts.net/', 'HTTPS://Desk.Tail1234.TS.NET', 'https://desk.tail1234.ts.net:443']) {
      expect(parseRemoteServerAddress(raw), raw).toBe(REMOTE);
    }
  });

  it('refuses anything else: http, other hosts, ports, paths, credentials, one label', () => {
    for (const raw of [
      '',
      'http://desk.tail1234.ts.net',
      'https://example.com',
      'https://ts.net',
      'https://tail1234.ts.net',
      'https://desk.tail1234.ts.net:8443',
      'https://desk.tail1234.ts.net/portly',
      'https://desk.tail1234.ts.net/?x=1',
      'https://desk.tail1234.ts.net/#/',
      'https://user:pw@desk.tail1234.ts.net',
      'https://desk.tail1234.ts.net.evil.example',
      'https://desk_pc.tail1234.ts.net',
      'desk tail1234.ts.net',
    ]) {
      expect(parseRemoteServerAddress(raw), raw).toBeNull();
    }
  });

  it('matches the Pages CSP source', () => {
    expect(REMOTE_SERVER_CSP_SOURCE).toBe('https://*.ts.net');
  });
});

describe('the pairing record for another PC', () => {
  it('keeps the address, and refuses a record whose address the connect page would not accept', () => {
    const local = memoryStorage();
    const store = createPairingStore(local, '/');
    expect(store.save({ token: DEVICE, instanceId: INSTANCE, pairedAt: START, remoteOrigin: REMOTE })).toBe(true);
    expect(store.read()).toEqual({ token: DEVICE, instanceId: INSTANCE, pairedAt: START, remoteOrigin: REMOTE });
    for (const remoteOrigin of ['https://example.com', `${REMOTE}/`, 'http://desk.tail1234.ts.net', 42]) {
      local.setItem('portly:pairing:/', JSON.stringify({ token: DEVICE, instanceId: INSTANCE, pairedAt: START, remoteOrigin }));
      expect(store.read(), String(remoteOrigin)).toBeNull();
    }
  });
});

describe('checkRemoteServer', () => {
  const answer = (body: Record<string, unknown>): FetchLike => async () => jsonResponse(healthBody(body));

  it('is ok for Portly that took the request as another PC’s, with no loopback options', async () => {
    const fetch = vi.fn<FetchLike>(answer({ remote: true }));
    expect(await checkRemoteServer(REMOTE, { fetch })).toEqual({ kind: 'ok', instanceId: INSTANCE, version: '0.1.0' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${REMOTE}/api/health`);
    expect(init).toMatchObject({ mode: 'cors', credentials: 'omit', cache: 'no-store' });
    expect((init as { targetAddressSpace?: unknown }).targetAddressSpace).toBeUndefined();
  });

  it('says why it cannot be used', async () => {
    expect(await checkRemoteServer(REMOTE, { fetch: answer({ remote: false }) })).toEqual({ kind: 'not-remote' });
    expect(await checkRemoteServer(REMOTE, { fetch: answer({ remote: true, apiVersion: 999 }) })).toEqual({ kind: 'incompatible' });
    expect(await checkRemoteServer(REMOTE, { fetch: answer({ remote: true, instanceId: undefined }) })).toEqual({ kind: 'incompatible' });
    expect(await checkRemoteServer(REMOTE, { fetch: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) })).toEqual({ kind: 'not-portly' });
    expect(await checkRemoteServer(REMOTE, { fetch: () => Promise.reject(new TypeError('Failed to fetch')) })).toEqual({ kind: 'unreachable' });
  });
});

describe('createRemoteConnectClient', () => {
  function setup(handler: (url: string, init: RequestInit) => Response) {
    const local = memoryStorage();
    const session = memoryStorage();
    const fetch = vi.fn<FetchLike>(async (url, init = {}) => handler(url, init));
    const client = createRemoteConnectClient({ origin: REMOTE, instanceId: INSTANCE, fetch, local, session, now: () => START, base: '/' });
    return { local, session, fetch, client, store: createPairingStore(local, '/') };
  }

  const status = (value: string, extra: Record<string, unknown> = {}) =>
    jsonResponse({ status: value, id: 'req-1', code: 'K7Q-4MP', expiresAt: '2026-10-30T10:10:00.000Z', device: null, ...extra });

  it('asks, keeps the request secret in this tab, waits, then saves the connection once approved', async () => {
    let approved = false;
    const s = setup((url, init) => {
      if (url === `${REMOTE}/api/devices/requests` && init.method === 'POST') {
        return jsonResponse({ id: 'req-1', code: 'K7Q-4MP', expiresAt: '2026-10-30T10:10:00.000Z', secret: ENROLL }, 201);
      }
      if (url === `${REMOTE}/api/devices/requests/current`) {
        return approved ? status('approved', { device: { id: 'device-1', label: 'Laptop', createdAt: '2026-10-30T10:00:00.000Z' }, secret: DEVICE }) : status('pending');
      }
      return jsonResponse({ error: { code: 'not_found', message: 'x' } }, 404);
    });
    expect(await s.client.status()).toBeNull();
    expect(s.fetch).not.toHaveBeenCalled();

    const created = await s.client.create('Laptop');
    expect(created).toMatchObject({ code: 'K7Q-4MP' });
    const [, createInit] = s.fetch.mock.calls[0]!;
    expect(createInit).toMatchObject({ method: 'POST', mode: 'cors', credentials: 'omit', body: '{"label":"Laptop"}' });
    expect(new Headers(createInit?.headers).get('X-Portly')).toBe('1');
    expect(JSON.parse(s.session.getItem(REMOTE_ENROLL_KEY) ?? 'null')).toEqual({ origin: REMOTE, secret: ENROLL });

    expect(await s.client.status()).toMatchObject({ status: 'pending' });
    expect(new Headers(s.fetch.mock.calls[1]?.[1]?.headers).get('X-Portly-Enroll')).toBe(ENROLL);
    expect(s.store.read()).toBeNull();

    approved = true;
    expect(await s.client.status()).toMatchObject({ status: 'approved' });
    expect(s.store.read()).toEqual({ token: DEVICE, instanceId: INSTANCE, pairedAt: START, remoteOrigin: REMOTE });
    expect(s.store.lastServerSeenAt()).toBe(START);
    expect(s.store.lastMode()).toBeNull();
    expect(s.session.getItem(REMOTE_ENROLL_KEY)).toBeNull();
    expect(s.local.getItem(remoteAddressKey('/'))).toBe(REMOTE);
  });

  it('forgets a request the server no longer knows, or one that ended', async () => {
    const s = setup(() => jsonResponse({ error: { code: 'not_found', message: 'gone' } }, 404));
    s.session.setItem(REMOTE_ENROLL_KEY, JSON.stringify({ origin: REMOTE, secret: ENROLL }));
    expect(await s.client.status()).toBeNull();
    expect(s.session.getItem(REMOTE_ENROLL_KEY)).toBeNull();

    const d = setup(() => status('denied'));
    d.session.setItem(REMOTE_ENROLL_KEY, JSON.stringify({ origin: REMOTE, secret: ENROLL }));
    expect(await d.client.status()).toMatchObject({ status: 'denied' });
    expect(d.session.getItem(REMOTE_ENROLL_KEY)).toBeNull();
    expect(d.store.read()).toBeNull();
  });

  it('ignores a waiting request kept for another address', async () => {
    const s = setup(() => status('pending'));
    s.session.setItem(REMOTE_ENROLL_KEY, JSON.stringify({ origin: 'https://other.tail1234.ts.net', secret: ENROLL }));
    expect(await s.client.status()).toBeNull();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('turns refusals and network failures into API errors the connect screen explains', async () => {
    const limited = setup(() => jsonResponse({ error: { code: 'rate_limited', message: 'Too many' } }, 429));
    await expect(limited.client.create('Laptop')).rejects.toSatisfy((error: unknown) => isApiError(error, 'rate_limited'));
    const offline = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(offline.client.create('Laptop')).rejects.toSatisfy((error: unknown) => isApiError(error, 'network_error'));
    // A server too old to hand the secret out is said to need an update.
    const old = setup(() => jsonResponse({ id: 'req-1', code: 'K7Q-4MP', expiresAt: '2026-10-30T10:10:00.000Z' }, 201));
    await expect(old.client.create('Laptop')).rejects.toThrow(/too old/);
    expect(old.session.getItem(REMOTE_ENROLL_KEY)).toBeNull();
  });

  it('asks for the name to suggest, and answers null on any failure', async () => {
    expect(await setup(() => jsonResponse({ label: 'DESK-LAPTOP' })).client.suggestion()).toBe('DESK-LAPTOP');
    expect(await setup(() => jsonResponse({ error: { code: 'internal', message: 'x' } }, 500)).client.suggestion()).toBeNull();
  });
});
