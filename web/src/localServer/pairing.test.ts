/**
 * This browser's pairing record and the mode hints (keys, validation, guarded storage,
 * compare-and-clear), the pairing request (nonce in sessionStorage, same-tab navigation through the
 * safe-href gate) and the return from the server's page (nonce checked once, token out of the
 * address at once).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPairingReturnUrl } from '@portly/shared';
import { APP_URL, INSTANCE, NEW_TOKEN, START, TOKEN, memoryStorage, pairingRecord, throwingStorage } from './__fixtures__/fakes.ts';
import {
  PAIRING_NONCE_KEY,
  consumePairingReturn,
  createPairingStore,
  hybridStorageKeys,
  randomNonce,
  startPairing,
  subscribePairingChanges,
  type PairingReturnEnv,
} from './pairing.ts';

const NONCE = 'n'.repeat(43);

describe('pairing store', () => {
  it('namespaces its keys by the Pages base path', () => {
    expect(hybridStorageKeys('/portly/')).toEqual({
      pairing: 'portly:pairing:/portly/',
      mode: 'portly:backend-mode:/portly/',
      seen: 'portly:server-seen:/portly/',
    });
    expect(hybridStorageKeys().pairing).toBe('portly:pairing:/');
  });

  it('saves and reads the record, the last mode and when the server was last seen', () => {
    const local = memoryStorage();
    const store = createPairingStore(local, '/');
    expect(store.read()).toBeNull();
    expect(store.save(pairingRecord())).toBe(true);
    expect(store.read()).toEqual(pairingRecord());
    store.setLastMode('server');
    store.setLastServerSeenAt(START);
    expect(store.lastMode()).toBe('server');
    expect(store.lastServerSeenAt()).toBe(START);
    store.setLastMode(null);
    store.setLastServerSeenAt(null);
    expect(local.items.has('portly:backend-mode:/')).toBe(false);
    expect(local.items.has('portly:server-seen:/')).toBe(false);
  });

  it('tells which backend the next page load would start on, from what it holds now', () => {
    const local = memoryStorage();
    const store = createPairingStore(local, '/');
    store.setLastMode('server');
    expect(store.nextBootBackend(START)).toBe('browser');
    store.save(pairingRecord());
    expect(store.nextBootBackend(START)).toBe('server');
    store.setLastMode(null);
    store.setLastServerSeenAt(START - 60_000);
    expect(store.nextBootBackend(START)).toBe('server');
    expect(store.nextBootBackend(START + 3_600_000)).toBe('browser');
    store.setLastMode('browser');
    expect(store.nextBootBackend(START)).toBe('browser');
  });

  it('treats malformed values as absent (another tab, build or program may have written them)', () => {
    const bad = [
      'not json',
      'null',
      '"string"',
      JSON.stringify({ token: 'short', instanceId: INSTANCE, pairedAt: 1 }),
      JSON.stringify({ token: TOKEN, instanceId: 'bad id!', pairedAt: 1 }),
      JSON.stringify({ token: TOKEN, instanceId: INSTANCE, pairedAt: 'yesterday' }),
      JSON.stringify({ token: TOKEN, instanceId: INSTANCE }),
    ];
    for (const raw of bad) expect(createPairingStore(memoryStorage({ 'portly:pairing:/': raw }), '/').read()).toBeNull();
    const hints = createPairingStore(memoryStorage({ 'portly:backend-mode:/': 'remote', 'portly:server-seen:/': 'soon' }), '/');
    expect(hints.lastMode()).toBeNull();
    expect(hints.lastServerSeenAt()).toBeNull();
  });

  it('survives storage that throws or is missing', () => {
    for (const storage of [throwingStorage(), null]) {
      const store = createPairingStore(storage, '/');
      expect(store.read()).toBeNull();
      expect(store.save(pairingRecord())).toBe(false);
      expect(store.clear(TOKEN)).toBe(false);
      expect(() => store.setLastMode('server')).not.toThrow();
      expect(() => store.setLastServerSeenAt(START)).not.toThrow();
      expect(store.lastMode()).toBeNull();
      expect(store.lastServerSeenAt()).toBeNull();
    }
  });

  it('clears only the record holding the expected token', () => {
    const store = createPairingStore(memoryStorage(), '/');
    store.save(pairingRecord({ token: NEW_TOKEN }));
    expect(store.clear(TOKEN)).toBe(false);
    expect(store.read()?.token).toBe(NEW_TOKEN);
    expect(store.clear(NEW_TOKEN)).toBe(true);
    expect(store.read()).toBeNull();
  });
});

describe('subscribePairingChanges', () => {
  it("follows other tabs' changes to the record (and a cleared storage) only", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const keys = hybridStorageKeys('/');
    const off = subscribePairingChanges(listener, target as unknown as Window, keys);
    target.dispatchEvent(new StorageEvent('storage', { key: keys.mode }));
    expect(listener).not.toHaveBeenCalled();
    target.dispatchEvent(new StorageEvent('storage', { key: keys.pairing }));
    target.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    target.dispatchEvent(new StorageEvent('storage', { key: keys.pairing }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('startPairing', () => {
  it('keeps a fresh 43-character nonce for this tab and goes to the server page to approve', () => {
    const session = memoryStorage();
    const assign = vi.fn();
    expect(startPairing(APP_URL, { session, assign })).toBe(true);
    const nonce = session.getItem(PAIRING_NONCE_KEY);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(assign).toHaveBeenCalledWith(`${APP_URL}#/pair?nonce=${nonce}`);
    // Every attempt gets its own nonce.
    startPairing(APP_URL, { session, assign });
    expect(session.getItem(PAIRING_NONCE_KEY)).not.toBe(nonce);
  });

  it('does not navigate when the nonce cannot be kept or the address is not a web page', () => {
    const assign = vi.fn();
    expect(startPairing(APP_URL, { session: throwingStorage(), assign })).toBe(false);
    expect(startPairing('javascript:alert(1)//', { session: memoryStorage(), assign })).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('encodes random bytes as unpadded base64url', () => {
    expect(randomNonce((bytes) => bytes.fill(0xff))).toBe(`${'_'.repeat(42)}8`);
    expect(randomNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('consumePairingReturn', () => {
  function env(hash: string, overrides: Partial<PairingReturnEnv> = {}) {
    const local = memoryStorage({ 'portly:backend-mode:/': 'browser' });
    const session = memoryStorage({ [PAIRING_NONCE_KEY]: NONCE });
    const replaceState = vi.fn();
    const value: PairingReturnEnv = {
      location: { hash, pathname: '/', search: '' },
      history: { replaceState, state: { kept: true } },
      local,
      session,
      now: () => START,
      accept: true,
      base: '/',
      ...overrides,
    };
    return { env: value, local, session: value.session as typeof session, replaceState };
  }

  const returned = (nonce = NONCE) => new URL(buildPairingReturnUrl('https://user.github.io/', { token: TOKEN, nonce, instanceId: INSTANCE })).hash;

  it('ignores every other address', () => {
    const { env: e, replaceState, session } = env('#/settings/about');
    expect(consumePairingReturn(e)).toBe('none');
    expect(replaceState).not.toHaveBeenCalled();
    expect(session.getItem(PAIRING_NONCE_KEY)).toBe(NONCE);
  });

  it('saves the pairing for the nonce this tab asked with, once, and takes the token out of the address', () => {
    const { env: e, local, session, replaceState } = env(returned());
    expect(consumePairingReturn(e)).toBe('paired');
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, '', '/#/');
    const store = createPairingStore(local, '/');
    expect(store.read()).toEqual({ token: TOKEN, instanceId: INSTANCE, pairedAt: START });
    // Just seen: this page load starts on the server; the old mode decision is gone.
    expect(store.lastServerSeenAt()).toBe(START);
    expect(store.lastMode()).toBeNull();
    // One use.
    expect(session.getItem(PAIRING_NONCE_KEY)).toBeNull();
    expect(consumePairingReturn(e)).toBe('refused');
  });

  it('refuses an answer for another nonce, a malformed one, or when hybrid mode is off (still cleaning the address)', () => {
    for (const [hash, overrides] of [
      [returned('m'.repeat(43)), {}],
      ['#/paired?token=short&nonce=x&instance=y', {}],
      [returned(), { accept: false }],
      [returned(), { session: memoryStorage() }],
    ] as const) {
      const { env: e, local, replaceState, session } = env(hash, overrides);
      expect(consumePairingReturn(e)).toBe('refused');
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(createPairingStore(local, '/').read()).toBeNull();
      expect(session.getItem(PAIRING_NONCE_KEY)).toBeNull();
    }
  });

  it('keeps the path and query of the page when cleaning the address', () => {
    const { env: e, replaceState } = env(returned(), { location: { hash: returned(), pathname: '/portly/', search: '?x=1' } });
    consumePairingReturn(e);
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, '', '/portly/?x=1#/');
  });

  it('refuses when the record cannot be saved', () => {
    const { env: e } = env(returned(), { local: throwingStorage() });
    expect(consumePairingReturn(e)).toBe('refused');
  });

  it('still checks the answer when the address cannot be rewritten', () => {
    const { env: e, local } = env(returned(), {
      history: {
        state: null,
        replaceState: () => {
          throw new DOMException('denied', 'SecurityError');
        },
      },
    });
    expect(consumePairingReturn(e)).toBe('paired');
    expect(createPairingStore(local, '/').read()?.token).toBe(TOKEN);
  });
});
