import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PORT,
  DEFAULT_TARGET,
  MAX_PAGES_URL_LENGTH,
  TARGET,
  WARM_UP_MESSAGE_TYPE,
  checkHealth,
  clearPagesUrl,
  describeFailure,
  googleSearchUrl,
  healthUrl,
  isValidPort,
  isWarmUpMessage,
  newTabUrl,
  parsePagesUrl,
  parsePort,
  parseServerSite,
  readPagesUrl,
  readPort,
  readSettings,
  readTarget,
  rememberServerSite,
  resolveNewTab,
  serverSiteFor,
  writePagesUrl,
  writePort,
  writeTarget,
} from '../lib/homebase.js';
import { HEALTHY, createFetch, createStorage, createTimers, down, jsonResponse, ok } from './helpers.mjs';

describe('parsePort / isValidPort', () => {
  const valid = [
    ['1024', 1024],
    ['5757', 5757],
    ['65535', 65535],
    [' 5800 ', 5800],
    ['08080', 8080],
    [5800, 5800],
  ];
  for (const [input, expected] of valid) {
    it(`accepts ${JSON.stringify(input)}`, () => assert.equal(parsePort(input), expected));
  }

  const invalid = ['', ' ', '1023', '65536', '99999', '0', '-5757', '+5757', '5757.0', '5757.5', '1e4', '0x1F90',
    '57 57', '５７５７', 'abc', '123456', 1023, 65536, 5757.5, Number.NaN, null, undefined, {}, [5757], true];
  for (const input of invalid) {
    it(`rejects ${typeof input === 'string' ? JSON.stringify(input) : String(input)}`, () => {
      assert.equal(parsePort(input), null);
    });
  }

  it('isValidPort only accepts integers in range', () => {
    assert.equal(isValidPort(5757), true);
    assert.equal(isValidPort('5757'), false);
    assert.equal(isValidPort(80), false);
    assert.equal(isValidPort(5757.1), false);
  });
});

describe('readPort / writePort', () => {
  it('defaults to 5757 when nothing is stored', async () => {
    assert.equal(await readPort(createStorage()), DEFAULT_PORT);
  });

  it('returns a valid stored port', async () => {
    assert.equal(await readPort(createStorage({ port: 5800 })), 5800);
  });

  for (const stored of [80, 70000, '5800', 5800.5, null, 'x']) {
    it(`falls back to the default for stored ${JSON.stringify(stored)}`, async () => {
      assert.equal(await readPort(createStorage({ port: stored })), DEFAULT_PORT);
    });
  }

  it('falls back to the default when storage throws or is missing', async () => {
    assert.equal(await readPort(createStorage({ port: 5800 }, { failGet: true })), DEFAULT_PORT);
    assert.equal(await readPort(null), DEFAULT_PORT);
    assert.equal(await readPort(undefined), DEFAULT_PORT);
  });

  it('writes validated ports as numbers', async () => {
    const storage = createStorage();
    assert.equal(await writePort(storage, ' 6000 '), 6000);
    assert.deepEqual(storage.data, { port: 6000 });
  });

  it('refuses to write invalid ports', async () => {
    const storage = createStorage();
    await assert.rejects(writePort(storage, '80'), RangeError);
    await assert.rejects(writePort(storage, 'abc'), RangeError);
    assert.deepEqual(storage.calls.set, []);
  });
});

describe('target (what a new tab opens)', () => {
  it('defaults to following Homebase on this PC', async () => {
    assert.equal(DEFAULT_TARGET, TARGET.auto);
    assert.equal(await readTarget(createStorage()), 'auto');
    assert.equal(await readTarget(null), 'auto');
    assert.equal(await readTarget(createStorage({ target: 'local' }, { failGet: true })), 'auto');
  });

  it('returns a valid stored target and ignores anything else', async () => {
    assert.equal(await readTarget(createStorage({ target: 'local' })), 'local');
    assert.equal(await readTarget(createStorage({ target: 'pages' })), 'pages');
    assert.equal(await readTarget(createStorage({ target: 'auto' })), 'auto');
    for (const stored of ['LOCAL', 'server', '', 1, null, { target: 'local' }]) {
      assert.equal(await readTarget(createStorage({ target: stored })), 'auto', JSON.stringify(stored));
    }
  });

  it('writes only valid targets', async () => {
    const storage = createStorage();
    assert.equal(await writeTarget(storage, 'local'), 'local');
    assert.deepEqual(storage.data, { target: 'local' });
    assert.equal(await writeTarget(storage, 'auto'), 'auto');
    await assert.rejects(writeTarget(storage, 'remote'), RangeError);
    await assert.rejects(writeTarget(storage, undefined), RangeError);
    assert.equal(storage.calls.set.length, 2);
  });
});

describe('parsePagesUrl', () => {
  const valid = [
    ['https://davideaurum.github.io/', 'https://davideaurum.github.io/'],
    ['https://davideaurum.github.io', 'https://davideaurum.github.io/'],
    ['  https://davideaurum.github.io/homebase-pages/  ', 'https://davideaurum.github.io/homebase-pages/'],
    ['https://davideaurum.github.io/homebase-pages', 'https://davideaurum.github.io/homebase-pages/'],
    ['HTTPS://Home.Example.ORG:443/Base/', 'https://home.example.org/Base/'],
    ['https://home.example.org:8443/', 'https://home.example.org:8443/'],
    ['http://localhost:4173/', 'http://localhost:4173/'],
    ['http://127.0.0.1:4173/homebase-pages/', 'http://127.0.0.1:4173/homebase-pages/'],
    ['http://[::1]:4173', 'http://[::1]:4173/'],
    ['https://example.org/a/../b/', 'https://example.org/b/'],
  ];
  for (const [input, expected] of valid) {
    it(`accepts ${JSON.stringify(input)}`, () => assert.equal(parsePagesUrl(input), expected));
  }

  const invalid = [
    '',
    '   ',
    'davideaurum.github.io',
    '//davideaurum.github.io/',
    'http://davideaurum.github.io/',
    'http://localhost.example.com/',
    'http://192.168.1.10/',
    'http://localhost.:4173/',
    'ftp://example.org/',
    'file:///C:/homebase/index.html',
    'chrome-extension://nbaolbakegefnefgojdokagajincnfjj/newtab.html',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user@example.org/',
    'https://user:pass@example.org/',
    'https://example.org/?',
    'https://example.org/?src=newtab',
    'https://example.org/#',
    'https://example.org/#/settings',
    'https://exa mple.org/',
    'https://example.org/a b/',
    'https://example.org/a\nb/',
    'https://exa\tmple.org/',
    'https://',
    `https://example.org/${'a'.repeat(MAX_PAGES_URL_LENGTH)}/`,
    42,
    null,
    undefined,
    {},
  ];
  for (const input of invalid) {
    it(`rejects ${typeof input === 'string' ? JSON.stringify(input.slice(0, 60)) : String(input)}`, () => {
      assert.equal(parsePagesUrl(input), null);
    });
  }
});

describe('readPagesUrl / writePagesUrl / clearPagesUrl', () => {
  it('has no default address (none is built in)', async () => {
    assert.equal(await readPagesUrl(createStorage()), null);
    assert.equal(await readPagesUrl(null), null);
    assert.equal(await readPagesUrl(createStorage({ pagesUrl: 'https://me.github.io/' }, { failGet: true })), null);
  });

  it('returns a valid stored address, normalised, and null for junk', async () => {
    assert.equal(await readPagesUrl(createStorage({ pagesUrl: 'https://me.github.io/x' })), 'https://me.github.io/x/');
    for (const stored of ['http://me.github.io/', 'javascript:alert(1)', 5, null]) {
      assert.equal(await readPagesUrl(createStorage({ pagesUrl: stored })), null, String(stored));
    }
  });

  it('writes validated, normalised addresses only', async () => {
    const storage = createStorage();
    assert.equal(await writePagesUrl(storage, ' https://me.github.io/homebase-pages '), 'https://me.github.io/homebase-pages/');
    assert.deepEqual(storage.data, { pagesUrl: 'https://me.github.io/homebase-pages/' });
    await assert.rejects(writePagesUrl(storage, 'http://me.github.io/'), RangeError);
    assert.equal(storage.calls.set.length, 1);
  });

  it('clears the stored address (remove, or null where storage has no remove)', async () => {
    const storage = createStorage({ pagesUrl: 'https://me.github.io/', port: 6001 });
    await clearPagesUrl(storage);
    assert.deepEqual(storage.data, { port: 6001 });
    const { remove, ...noRemove } = createStorage({ pagesUrl: 'https://me.github.io/' });
    await clearPagesUrl(noRemove);
    assert.equal(await readPagesUrl(noRemove), null);
  });
});

describe('server site (what Homebase on this PC says about its Pages site)', () => {
  it('parses a stored record and refuses junk', () => {
    assert.deepEqual(parseServerSite({ port: 5757, pagesUrl: 'https://me.github.io/x' }), { port: 5757, pagesUrl: 'https://me.github.io/x/' });
    assert.deepEqual(parseServerSite({ port: 5757, pagesUrl: null }), { port: 5757, pagesUrl: null });
    for (const value of [
      null,
      'https://me.github.io/',
      { pagesUrl: 'https://me.github.io/' },
      { port: 80, pagesUrl: null },
      { port: 5757 },
      { port: 5757, pagesUrl: 'http://me.github.io/' },
      { port: 5757, pagesUrl: 'javascript:alert(1)' },
    ]) {
      assert.equal(parseServerSite(value), null, JSON.stringify(value));
    }
  });

  it('counts only for the port it was said on', () => {
    const serverSite = { port: 5757, pagesUrl: 'https://me.github.io/' };
    assert.deepEqual(serverSiteFor({ port: 5757, serverSite }), serverSite);
    assert.equal(serverSiteFor({ port: 6001, serverSite }), null);
    assert.equal(serverSiteFor({ port: 5757, serverSite: null }), null);
  });

  it('records what a healthy answer says, only when it changed', async () => {
    const storage = createStorage();
    const health = { ok: true, version: '1', vault: 'ready', pagesUrl: 'https://me.github.io/' };
    assert.deepEqual(await rememberServerSite(storage, 5757, health), { port: 5757, pagesUrl: 'https://me.github.io/' });
    assert.deepEqual(storage.data, { serverSite: { port: 5757, pagesUrl: 'https://me.github.io/' } });
    await rememberServerSite(storage, 5757, health);
    assert.equal(storage.calls.set.length, 1, 'the same answer again writes nothing');
    await rememberServerSite(storage, 5757, { ...health, pagesUrl: null });
    assert.deepEqual(storage.data, { serverSite: { port: 5757, pagesUrl: null } });
    await rememberServerSite(storage, 6001, { ...health, pagesUrl: null });
    assert.deepEqual(storage.data, { serverSite: { port: 6001, pagesUrl: null } });
  });

  it('uses the record it is given instead of reading it again', async () => {
    const storage = createStorage();
    const known = { port: 5757, pagesUrl: 'https://me.github.io/' };
    const health = { ok: true, version: '1', vault: 'ready', pagesUrl: 'https://me.github.io/' };
    assert.equal(await rememberServerSite(storage, 5757, health, known), known);
    assert.deepEqual(storage.calls.get, []);
    assert.deepEqual(storage.calls.set, []);
    await rememberServerSite(storage, 5757, health, null);
    assert.deepEqual(storage.calls.get, []);
    assert.equal(storage.calls.set.length, 1);
  });

  it('changes nothing when Homebase said nothing, failed, or storage fails', async () => {
    const storage = createStorage({ serverSite: { port: 5757, pagesUrl: 'https://me.github.io/' } });
    const known = { port: 5757, pagesUrl: 'https://me.github.io/' };
    assert.equal(await rememberServerSite(storage, 5757, { ok: true, version: '1', vault: 'ready' }, known), known);
    assert.equal(await rememberServerSite(storage, 6001, { ok: true, version: '1', vault: 'ready' }, known), null);
    assert.equal(await rememberServerSite(storage, 5757, { ok: false, reason: 'unreachable' }), null);
    assert.deepEqual(storage.calls.set, []);
    const failing = createStorage({}, { failGet: true, failSet: true });
    const health = { ok: true, version: '1', vault: 'ready', pagesUrl: null };
    assert.deepEqual(await rememberServerSite(failing, 5757, health), { port: 5757, pagesUrl: null });
    assert.deepEqual(await rememberServerSite(null, 5757, health), { port: 5757, pagesUrl: null });
  });
});

describe('resolveNewTab', () => {
  const site = (pagesUrl, port = 5757) => ({ port, pagesUrl });
  const settings = (overrides) => ({ target: 'auto', pagesUrl: null, port: 5757, serverSite: null, ...overrides });

  it('auto: the Pages site Homebase reported, else Homebase on this PC', () => {
    assert.deepEqual(resolveNewTab(settings({ serverSite: site('https://me.github.io/') })), { opens: 'pages', url: 'https://me.github.io/' });
    assert.deepEqual(resolveNewTab(settings({ serverSite: site(null) })), { opens: 'local', url: null });
    assert.deepEqual(resolveNewTab(settings({})), { opens: 'local', url: null }, 'not known yet');
    assert.deepEqual(resolveNewTab(settings({ serverSite: site('https://me.github.io/', 6001) })), { opens: 'local', url: null }, 'another port');
    assert.deepEqual(
      resolveNewTab(settings({ pagesUrl: 'https://other.example/', serverSite: site(null) })),
      { opens: 'local', url: null },
      'auto ignores a stored address',
    );
  });

  it('pages: the stored address, else the reported one, else Homebase on this PC', () => {
    const pages = (overrides) => settings({ target: 'pages', ...overrides });
    assert.deepEqual(resolveNewTab(pages({ pagesUrl: 'https://other.example/', serverSite: site('https://me.github.io/') })), {
      opens: 'pages',
      url: 'https://other.example/',
    });
    assert.deepEqual(resolveNewTab(pages({ serverSite: site('https://me.github.io/') })), { opens: 'pages', url: 'https://me.github.io/' });
    assert.deepEqual(resolveNewTab(pages({})), { opens: 'local', url: null });
  });

  it('local: always Homebase on this PC', () => {
    assert.deepEqual(
      resolveNewTab(settings({ target: 'local', pagesUrl: 'https://other.example/', serverSite: site('https://me.github.io/') })),
      { opens: 'local', url: null },
    );
  });
});

describe('readSettings', () => {
  it('reads every setting in one call', async () => {
    const serverSite = { port: 6001, pagesUrl: 'https://me.github.io/' };
    const storage = createStorage({ target: 'local', pagesUrl: 'https://me.github.io/', port: 6001, serverSite });
    assert.deepEqual(await readSettings(storage), { target: 'local', pagesUrl: 'https://me.github.io/', port: 6001, serverSite });
    assert.equal(storage.calls.get.length, 1);
  });

  it('defaults each missing or invalid setting on its own', async () => {
    assert.deepEqual(await readSettings(createStorage({ target: 'x', pagesUrl: 'nope', port: 6001, serverSite: 'x' })), {
      target: 'auto',
      pagesUrl: null,
      port: 6001,
      serverSite: null,
    });
    const defaults = { target: 'auto', pagesUrl: null, port: DEFAULT_PORT, serverSite: null };
    assert.deepEqual(await readSettings(createStorage()), defaults);
    assert.deepEqual(await readSettings(createStorage({ port: 6001 }, { failGet: true })), defaults);
    assert.deepEqual(await readSettings(null), defaults);
  });
});

describe('isWarmUpMessage', () => {
  it('recognises only {type: "homebase:warm-up"}', () => {
    assert.equal(WARM_UP_MESSAGE_TYPE, 'homebase:warm-up');
    assert.equal(isWarmUpMessage({ type: 'homebase:warm-up' }), true);
    for (const message of [null, undefined, 'homebase:warm-up', {}, { type: 'homebase:start' }, { kind: 'homebase:warm-up' }]) {
      assert.equal(isWarmUpMessage(message), false, JSON.stringify(message));
    }
  });
});

describe('URL builders', () => {
  it('builds the redirect and health URLs from the port', () => {
    assert.equal(newTabUrl(5757), 'http://localhost:5757/?src=newtab');
    assert.equal(healthUrl(6001), 'http://localhost:6001/api/health');
  });

  it('encodes the Google query with encodeURIComponent', () => {
    assert.equal(googleSearchUrl('a&b=c #x ü/?'), 'https://www.google.com/search?q=a%26b%3Dc%20%23x%20%C3%BC%2F%3F');
    assert.equal(googleSearchUrl('javascript:alert(1)'), 'https://www.google.com/search?q=javascript%3Aalert(1)');
  });
});

describe('checkHealth', () => {
  it('succeeds on a Homebase health body and sends a credential-less, no-cache GET', async () => {
    const fetch = createFetch(ok);
    const timers = createTimers();
    const result = await checkHealth(5757, { fetch, ...timers });
    assert.deepEqual(result, { ok: true, version: '0.1.0', vault: 'ready' });
    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0];
    assert.equal(url, 'http://localhost:5757/api/health');
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(timers.pending, 0, 'the timeout timer is cleared');
  });

  it('reports a locked vault and tolerates missing optional fields', async () => {
    const locked = await checkHealth(5757, { fetch: createFetch(() => jsonResponse({ ...HEALTHY, vault: 'locked' })) });
    assert.deepEqual(locked, { ok: true, version: '0.1.0', vault: 'locked' });
    const bare = await checkHealth(5757, { fetch: createFetch(() => jsonResponse({ ok: true, vault: 'weird' })) });
    assert.deepEqual(bare, { ok: true, version: null, vault: null });
  });

  it('reads the Pages site the server names, null for none, and drops one it would not open', async () => {
    const health = (pagesUrl) => checkHealth(5757, { fetch: createFetch(() => jsonResponse({ ...HEALTHY, pagesUrl })) });
    assert.deepEqual(await health('https://me.github.io/x'), { ...HEALTHY, pagesUrl: 'https://me.github.io/x/' });
    assert.deepEqual(await health(null), { ...HEALTHY, pagesUrl: null });
    for (const bad of ['http://me.github.io/', 'javascript:alert(1)', '', 5, {}]) {
      assert.deepEqual(await health(bad), HEALTHY, JSON.stringify(bad));
    }
  });

  it('maps a network error to unreachable', async () => {
    assert.deepEqual(await checkHealth(5757, { fetch: createFetch(down) }), { ok: false, reason: 'unreachable' });
  });

  it('maps a non-2xx status to http', async () => {
    const result = await checkHealth(5757, { fetch: createFetch(() => jsonResponse({ ok: true }, 503)) });
    assert.deepEqual(result, { ok: false, reason: 'http', status: 503 });
  });

  it('rejects bodies that are not Homebase health JSON', async () => {
    for (const body of ['<html>hi</html>', 'null', '[]', '{"ok":"true"}', '{"status":"ok"}']) {
      const fetch = createFetch(() => new Response(body, { status: 200 }));
      assert.deepEqual(await checkHealth(5757, { fetch }), { ok: false, reason: 'unexpected' }, body);
    }
  });

  it('times out after 1.5 s when the server never answers', async () => {
    const timers = createTimers();
    const pending = checkHealth(5757, { fetch: createFetch('hang'), ...timers });
    await timers.advance(1499);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await timers.advance(0);
    assert.equal(settled, false);
    await timers.advance(1);
    assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  });

  it('also times out when the headers arrive but the body stalls', async () => {
    const timers = createTimers();
    const fetch = createFetch((init) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const pending = checkHealth(5757, { fetch, ...timers, timeoutMs: 1500 });
    await timers.advance(1500);
    assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  });
});

describe('describeFailure', () => {
  it('explains each failure in one line with the URL', () => {
    assert.equal(describeFailure({ ok: false, reason: 'unreachable' }, 5757), 'Nothing is answering on http://localhost:5757.');
    assert.equal(
      describeFailure({ ok: false, reason: 'timeout' }, 5757),
      "Couldn't reach http://localhost:5757 (no answer within 1.5 seconds).",
    );
    assert.match(describeFailure({ ok: false, reason: 'http', status: 404 }, 6000), /localhost:6000.*HTTP 404/);
    assert.match(describeFailure({ ok: false, reason: 'unexpected' }, 5757), /doesn't look like Homebase/);
  });
});
