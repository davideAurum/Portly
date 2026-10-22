/**
 * Portly on the main PC (Pages build): which addresses are accepted, the stored address checked
 * again on read, and when a page load forwards there (unpaired, not framed, no query, `?here`
 * keeps it here and leaves the address).
 */
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage, pairingRecord, throwingStorage } from './__fixtures__/fakes.ts';
import { STAY_HERE_PARAM, createMainPcStore, mainPcKey, mainPcRedirect, parseMainPcOrigin } from './mainPc.ts';
import { hybridStorageKeys } from './pairing.ts';

const PAGES = 'https://example.github.io';
const MAIN = 'https://main-pc.example-tailnet.ts.net';

describe('parseMainPcOrigin', () => {
  it('accepts an https address and keeps only its origin', () => {
    expect(parseMainPcOrigin(MAIN, PAGES)).toBe(MAIN);
    expect(parseMainPcOrigin(`  ${MAIN}/#/settings?x=1  `, PAGES)).toBe(MAIN);
    expect(parseMainPcOrigin(`${MAIN}:8443/some/path`, PAGES)).toBe(`${MAIN}:8443`);
  });

  it('refuses what cannot be the main PC', () => {
    for (const raw of [
      '',
      'main-pc.example-tailnet.ts.net',
      'http://main-pc.example-tailnet.ts.net',
      'javascript:alert(1)',
      'https://user:secret@main-pc.example-tailnet.ts.net',
      'https://localhost:5758',
      'https://127.0.0.1',
      'https://portly.localhost',
      PAGES,
      `${PAGES}/portly/`,
    ]) {
      expect(parseMainPcOrigin(raw, PAGES), raw).toBeNull();
    }
  });
});

describe('main PC store', () => {
  it('namespaces its key by the Pages base path', () => {
    expect(mainPcKey('/portly/')).toBe('portly:main-pc:/portly/');
  });

  it('saves the origin, reads it back and forgets it', () => {
    const local = memoryStorage();
    const store = createMainPcStore(local, PAGES, '/');
    expect(store.read()).toBeNull();
    expect(store.save(`${MAIN}/`)).toBe(true);
    expect(local.getItem(mainPcKey('/'))).toBe(MAIN);
    expect(store.read()).toBe(MAIN);
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('refuses an invalid address and ignores one stored by something else', () => {
    const local = memoryStorage({ [mainPcKey('/')]: 'http://evil.example' });
    const store = createMainPcStore(local, PAGES, '/');
    expect(store.read()).toBeNull();
    expect(store.save('http://main-pc')).toBe(false);
    expect(local.getItem(mainPcKey('/'))).toBe('http://evil.example');
  });

  it('survives storage that throws', () => {
    const store = createMainPcStore(throwingStorage(), PAGES, '/');
    expect(store.read()).toBeNull();
    expect(store.save(MAIN)).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });
});

function page(href: string) {
  const url = new URL(href);
  return {
    location: { href: url.href, origin: url.origin, search: url.search, hash: url.hash },
    history: { state: { kept: true }, replaceState: vi.fn() },
  };
}

describe('mainPcRedirect', () => {
  const saved = () => memoryStorage({ [mainPcKey('/')]: MAIN });

  it('forwards an unpaired page load to the main PC, keeping the hash route', () => {
    const { location, history } = page(`${PAGES}/#/settings/devices`);
    expect(mainPcRedirect({ location, history, storage: saved(), framed: false, base: '/' })).toBe(`${MAIN}/#/settings/devices`);
    expect(mainPcRedirect({ ...page(`${PAGES}/`), storage: saved(), framed: false, base: '/' })).toBe(`${MAIN}/`);
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('stays without a saved address', () => {
    expect(mainPcRedirect({ ...page(`${PAGES}/`), storage: memoryStorage(), framed: false, base: '/' })).toBeNull();
    expect(mainPcRedirect({ ...page(`${PAGES}/`), storage: null, framed: false, base: '/' })).toBeNull();
  });

  it('stays when this browser is paired with Portly on its own PC', () => {
    const storage = saved();
    storage.setItem(hybridStorageKeys('/').pairing, JSON.stringify(pairingRecord()));
    expect(mainPcRedirect({ ...page(`${PAGES}/`), storage, framed: false, base: '/' })).toBeNull();
  });

  it('stays in a frame, and when the address carries a query (a sign-in answer belongs here)', () => {
    expect(mainPcRedirect({ ...page(`${PAGES}/`), storage: saved(), framed: true, base: '/' })).toBeNull();
    expect(mainPcRedirect({ ...page(`${PAGES}/?code=c&state=s`), storage: saved(), framed: false, base: '/' })).toBeNull();
  });

  it('?here keeps this page load here and takes itself out of the address', () => {
    const { location, history } = page(`${PAGES}/portly/?${STAY_HERE_PARAM}=1#/settings/devices`);
    expect(mainPcRedirect({ location, history, storage: saved(), framed: false, base: '/' })).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith({ kept: true }, '', '/portly/#/settings/devices');

    const bare = page(`${PAGES}/?${STAY_HERE_PARAM}&x=1`);
    expect(mainPcRedirect({ ...bare, storage: saved(), framed: false, base: '/' })).toBeNull();
    expect(bare.history.replaceState).toHaveBeenCalledWith({ kept: true }, '', '/?x=1');
  });
});
