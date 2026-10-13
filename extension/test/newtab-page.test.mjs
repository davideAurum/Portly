import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createLauncher } from '../lib/launcher.js';
import {
  HELP,
  STARTING_SLOW_TEXT,
  STARTING_TEXT,
  WARM_UP_ACK_TIMEOUT_MS,
  createNewTabPage,
  describeLaunchEnd,
} from '../lib/newtab-page.js';
import {
  HEALTHY,
  NATIVE_ERRORS,
  OLD_PATH_EXTENSION_ID,
  PINNED_EXTENSION_ID,
  createFetch,
  createLocation,
  createNativeRuntime,
  createStorage,
  createTimers,
  down,
  flush,
  jsonResponse,
  loadPage,
  ok,
} from './helpers.mjs';

/** chrome.storage.local with the "Portly on this PC" target (plus `items`). */
function localTarget(items = {}, options = {}) {
  return createStorage({ target: 'local', ...items }, options);
}

/**
 * Builds the controller against newtab.html in jsdom with fakes for every browser API. Pass
 * `runtime` (createNativeRuntime) to give the page a launcher; without one it never tries to
 * start Portly. The storage defaults to the local target; `sendMessage` stands in for
 * chrome.runtime.sendMessage (the Pages target's warm-up request).
 */
function setup({
  storage = localTarget(),
  fetch = createFetch(ok),
  autoRetryMaxAttempts,
  runtime = null,
  sendMessage = undefined,
  hash = undefined,
} = {}) {
  const window = loadPage('newtab.html');
  const document = window.document;
  const location = createLocation();
  const timers = createTimers();
  const page = createNewTabPage({
    document,
    location,
    storage,
    fetch,
    launcher: createLauncher(runtime, timers),
    extensionId: runtime?.id ?? null,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...(sendMessage === undefined ? {} : { sendMessage }),
    ...(hash === undefined ? {} : { hash }),
    ...(autoRetryMaxAttempts === undefined ? {} : { autoRetryMaxAttempts }),
  });
  cleanups.push(() => {
    page.destroy();
    window.close();
  });
  const $ = (id) => document.getElementById(id);
  const state = () => document.documentElement.dataset.state;
  const visibleHelp = () =>
    [...document.querySelectorAll('[data-help]')].filter((node) => !node.hidden).map((node) => node.dataset.help);
  return { window, document, location, timers, page, fetch, storage, runtime, $, state, visibleHelp };
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

function submitSearch(t) {
  const event = new t.window.Event('submit', { bubbles: true, cancelable: true });
  t.$('search-form').dispatchEvent(event);
  return event;
}

describe('new tab: Portly running', () => {
  it('redirects to http://localhost:5757/?src=newtab by default (local target)', async () => {
    const t = setup();
    assert.equal(t.state(), 'checking', 'starts in the checking state');
    const result = await t.page.start();
    assert.equal(result.ok, true);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.deepEqual(t.location.assigned, []);
    assert.equal(t.state(), 'redirecting');
    assert.equal(t.fetch.calls[0].url, 'http://localhost:5757/api/health');
    assert.equal(t.timers.pending, 0, 'no timers left behind');
  });

  it('uses the port from chrome.storage.local', async () => {
    const t = setup({ storage: localTarget({ port: 5800 }) });
    await t.page.start();
    assert.equal(t.fetch.calls[0].url, 'http://localhost:5800/api/health');
    assert.deepEqual(t.location.replaced, ['http://localhost:5800/?src=newtab']);
  });

  it('falls back to 5757 when the stored port is invalid', async () => {
    for (const storage of [localTarget({ port: 80 }), localTarget({ port: '5800' })]) {
      const t = setup({ storage });
      await t.page.start();
      assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    }
  });

  it('reads every setting in one storage call', async () => {
    const storage = localTarget({ port: 5800 });
    const t = setup({ storage });
    await t.page.start();
    assert.equal(storage.calls.get.length, 1);
    assert.deepEqual([...storage.calls.get[0]].sort(), ['pagesUrl', 'port', 'serverSite', 'target']);
  });

  it('still redirects when the vault is locked (Portly shows its own banner)', async () => {
    const t = setup({ fetch: createFetch(() => jsonResponse({ ok: true, version: '0.1.0', vault: 'locked' })) });
    await t.page.start();
    assert.equal(t.location.replaced.length, 1);
  });
});

/**
 * chrome.runtime.sendMessage stand-in (promise form). Modes: 'ack' (answers at once), 'hang'
 * (answers when the test calls `ack()`), 'reject' (no worker listening) and 'throw'.
 */
function createSendMessage(mode = 'ack') {
  const calls = [];
  const waiting = [];
  const send = (message) => {
    calls.push(structuredClone(message));
    if (mode === 'throw') throw new Error('Extension context invalidated.');
    if (mode === 'reject') return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    if (mode === 'hang') return new Promise((resolve) => waiting.push(() => resolve({ ok: true })));
    return Promise.resolve({ ok: true });
  };
  send.calls = calls;
  send.ack = () => waiting.shift()();
  return send;
}

const WARM_UP = { type: 'portly:warm-up' };

/** The Pages site Portly on this PC reports in these tests (PORTLY_PAGES_URL). */
const SITE = 'https://me.github.io/';

/** chrome.storage.local where Portly on port 5757 has already named SITE (plus `items`). */
function siteKnown(items = {}, options = {}) {
  return createStorage({ serverSite: { port: 5757, pagesUrl: SITE }, ...items }, options);
}

/** A health answer from a Portly that names `pagesUrl` (null: hybrid mode off). */
const healthNaming = (pagesUrl) => () => jsonResponse({ ...HEALTHY, pagesUrl });

describe('new tab: the Pages site', () => {
  it('auto (the default): asks the service worker for a warm-up, then opens the site Portly reported', async () => {
    const sendMessage = createSendMessage('ack');
    const runtime = createNativeRuntime({ response: { ok: true, state: 'starting' } });
    const t = setup({ storage: siteKnown(), fetch: createFetch(down), runtime, sendMessage });
    const result = await t.page.start();
    assert.equal(result, null, 'no health check on this page');
    assert.equal(t.page.target, 'auto');
    assert.equal(t.page.opens, 'pages');
    assert.deepEqual(sendMessage.calls, [WARM_UP]);
    assert.deepEqual(t.location.replaced, [SITE]);
    assert.deepEqual(t.location.assigned, []);
    assert.equal(t.state(), 'redirecting');
    assert.equal(t.fetch.calls.length, 0, 'the tab itself never contacts Portly on this PC');
    assert.equal(t.runtime.calls.length, 0, 'nor the launcher (the service worker does)');
    assert.equal(t.timers.pending, 0, 'the acknowledgement timer is cleared');
  });

  it('opens the stored Pages site address (pages target)', async () => {
    for (const [stored, expected] of [
      ['https://me.github.io/portly-pages/', 'https://me.github.io/portly-pages/'],
      ['http://localhost:4173/', 'http://localhost:4173/'],
      ['https://home.example.org', 'https://home.example.org/'],
    ]) {
      const t = setup({ storage: siteKnown({ target: 'pages', pagesUrl: stored }), sendMessage: createSendMessage() });
      await t.page.start();
      assert.deepEqual(t.location.replaced, [expected]);
    }
  });

  it('pages target without a stored address: the site Portly reported', async () => {
    const t = setup({ storage: siteKnown({ target: 'pages' }), sendMessage: createSendMessage() });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [SITE]);
  });

  it('ignores an invalid stored address or target (auto follows Portly)', async () => {
    for (const storage of [
      siteKnown({ pagesUrl: 'http://example.com/' }),
      siteKnown({ pagesUrl: 'javascript:alert(1)' }),
      siteKnown({ pagesUrl: 42 }),
      siteKnown({ target: 'elsewhere' }),
      siteKnown({ target: 'pages', pagesUrl: 'http://example.com/' }),
    ]) {
      const t = setup({ storage, sendMessage: createSendMessage() });
      await t.page.start();
      assert.deepEqual(t.location.replaced, [SITE]);
      assert.equal(t.fetch.calls.length, 0);
    }
  });

  it('a site reported for another port does not count', async () => {
    const t = setup({ storage: siteKnown({ port: 6001 }), sendMessage: createSendMessage() });
    await t.page.start();
    assert.equal(t.page.opens, 'local');
    assert.equal(t.fetch.calls[0].url, 'http://localhost:6001/api/health');
    assert.deepEqual(t.location.replaced, ['http://localhost:6001/?src=newtab']);
  });

  it(`waits at most ${WARM_UP_ACK_TIMEOUT_MS} ms for the acknowledgement`, async () => {
    const sendMessage = createSendMessage('hang');
    const t = setup({ storage: siteKnown(), sendMessage });
    const started = t.page.start();
    await flush();
    assert.equal(t.state(), 'redirecting', 'only the backdrop while it waits');
    await t.timers.advance(WARM_UP_ACK_TIMEOUT_MS - 1);
    assert.deepEqual(t.location.replaced, []);
    await t.timers.advance(1);
    await started;
    assert.deepEqual(t.location.replaced, [SITE]);
    sendMessage.ack(); // a late acknowledgement changes nothing
    await flush();
    assert.deepEqual(t.location.replaced, [SITE]);
    assert.equal(t.timers.pending, 0);
  });

  it('opens the site as soon as the acknowledgement arrives', async () => {
    const sendMessage = createSendMessage('hang');
    const t = setup({ storage: siteKnown(), sendMessage });
    const started = t.page.start();
    await t.timers.advance(50);
    assert.deepEqual(t.location.replaced, []);
    sendMessage.ack();
    await started;
    assert.deepEqual(t.location.replaced, [SITE]);
    assert.equal(t.timers.pending, 0);
  });

  it('still opens the site when the request fails or messaging is unavailable', async () => {
    for (const sendMessage of [createSendMessage('reject'), createSendMessage('throw'), null]) {
      const t = setup({ storage: siteKnown(), sendMessage });
      await t.page.start();
      assert.deepEqual(t.location.replaced, [SITE]);
      assert.equal(t.timers.pending, 0);
    }
  });

  it('checks, retries and launches nothing afterwards', async () => {
    const runtime = createNativeRuntime({ response: { ok: true, state: 'starting' } });
    const t = setup({ storage: siteKnown(), fetch: createFetch(down), runtime, sendMessage: createSendMessage() });
    await t.page.start();
    assert.equal(await t.page.check({ manual: true }), null);
    assert.equal(await t.page.launch(), null);
    assert.equal(t.fetch.calls.length, 0);
    assert.equal(t.runtime.calls.length, 0);
  });

  it('destroy() while waiting for the acknowledgement: no navigation', async () => {
    const sendMessage = createSendMessage('hang');
    const t = setup({ storage: siteKnown(), sendMessage });
    const started = t.page.start();
    await flush();
    t.page.destroy();
    sendMessage.ack();
    await started;
    assert.deepEqual(t.location.replaced, []);
  });

  it('the local target never sends the warm-up message (it checks and starts Portly itself)', async () => {
    const sendMessage = createSendMessage();
    const t = setup({ storage: localTarget({ serverSite: { port: 5757, pagesUrl: SITE } }), sendMessage });
    await t.page.start();
    assert.equal(t.page.target, 'local');
    assert.equal(t.page.opens, 'local');
    assert.deepEqual(sendMessage.calls, []);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
  });
});

describe('new tab: following what Portly on this PC says', () => {
  it('auto, nothing known yet: checks Portly, records its Pages site and opens it', async () => {
    const sendMessage = createSendMessage();
    const storage = createStorage();
    const t = setup({ storage, fetch: createFetch(healthNaming(SITE)), sendMessage });
    const result = await t.page.start();
    assert.equal(result.ok, true);
    assert.equal(t.fetch.calls[0].url, 'http://localhost:5757/api/health');
    assert.deepEqual(t.location.replaced, [SITE]);
    assert.equal(t.page.opens, 'pages');
    assert.deepEqual(storage.data, { serverSite: { port: 5757, pagesUrl: SITE } });
    assert.deepEqual(sendMessage.calls, [], 'Portly already answers: no warm-up needed');
  });

  it('auto: a Portly without a Pages site opens itself, and that is recorded too', async () => {
    const storage = siteKnown();
    storage.data.serverSite = { port: 5757, pagesUrl: null };
    const t = setup({ storage, fetch: createFetch(healthNaming(null)) });
    await t.page.start();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.deepEqual(storage.calls.set, [], 'nothing changed, nothing written');
  });

  it('auto: an older Portly that says nothing opens itself and records nothing', async () => {
    const storage = createStorage();
    const t = setup({ storage });
    await t.page.start();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.deepEqual(storage.data, {});
  });

  it('pages target without any address: checks Portly and opens the site it names', async () => {
    const t = setup({ storage: createStorage({ target: 'pages' }), fetch: createFetch(healthNaming(SITE)) });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [SITE]);
  });

  it('local target: records what Portly says but still opens Portly itself', async () => {
    const storage = localTarget();
    const t = setup({ storage, fetch: createFetch(healthNaming(SITE)) });
    await t.page.start();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.deepEqual(storage.data.serverSite, { port: 5757, pagesUrl: SITE });
  });

  it('auto, Portly not running: starts it and then opens the Pages site it names', async () => {
    const storage = createStorage();
    const t = setup({ storage, fetch: createFetch(down, healthNaming(SITE)), runtime: createNativeRuntime(STARTING) });
    await t.page.start();
    assert.equal(t.state(), 'starting');
    await t.timers.advance(400);
    assert.deepEqual(t.location.replaced, [SITE]);
    assert.equal(t.timers.pending, 0);
    assert.deepEqual(storage.data, { serverSite: { port: 5757, pagesUrl: SITE } });
  });

  it('an "Add this page" request goes along to the site Portly names', async () => {
    const hash = `#/add-bookmark?${new URLSearchParams({ url: 'https://example.com/' }).toString()}`;
    const t = setup({ storage: createStorage(), fetch: createFetch(healthNaming(SITE)), hash });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [`${SITE}${hash}`]);
  });

  it('a failing storage write does not stop the redirect', async () => {
    const t = setup({ storage: createStorage({}, { failSet: true }), fetch: createFetch(healthNaming(SITE)) });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [SITE]);
  });
});

describe('new tab: Portly not running', () => {
  it('shows the fallback with the reason, port and auto-retry note', async () => {
    const t = setup({ storage: localTarget({ port: 6001 }), fetch: createFetch(down) });
    const result = await t.page.start();
    assert.deepEqual(result, { ok: false, reason: 'unreachable' });
    assert.equal(t.state(), 'offline');
    assert.deepEqual(t.location.replaced, []);
    assert.equal(t.$('status-title').textContent, "Portly isn't running");
    assert.equal(t.$('status-detail').textContent, 'Nothing is answering on http://localhost:6001.');
    for (const node of t.document.querySelectorAll('[data-portly-url]')) {
      assert.equal(node.textContent, 'http://localhost:6001');
    }
    assert.equal(t.document.title, "Portly isn't running");
    assert.match(t.$('retry-note').textContent, /automatically every 5 seconds/);
    assert.equal(t.$('retry').disabled, false);
    assert.equal(t.$('retry').textContent, 'Retry');
  });

  it('reports a timeout after 1.5 seconds', async () => {
    const t = setup({ fetch: createFetch('hang') });
    const started = t.page.start();
    await flush();
    await t.timers.advance(1500);
    assert.deepEqual(await started, { ok: false, reason: 'timeout' });
    assert.equal(t.$('status-detail').textContent, "Couldn't reach http://localhost:5757 (no answer within 1.5 seconds).");
  });

  it('does not redirect to something else answering on the port', async () => {
    for (const respond of [() => jsonResponse({ error: 'nope' }, 404), () => new Response('<html></html>')]) {
      const t = setup({ fetch: createFetch(respond) });
      await t.page.start();
      assert.equal(t.state(), 'offline');
      assert.deepEqual(t.location.replaced, []);
      assert.match(t.$('status-detail').textContent, /isn't Portly|doesn't look like Portly/);
    }
  });

  it('Retry checks again and redirects once Portly is up', async () => {
    const t = setup({ fetch: createFetch(down, ok) });
    await t.page.start();
    t.$('retry').click();
    await flush();
    assert.equal(t.fetch.calls.length, 2);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.timers.pending, 0, 'the auto-retry timer was cancelled');
  });

  it('shows Retry as busy only while a manual check runs', async () => {
    const t = setup({ fetch: createFetch(down, 'hang') });
    await t.page.start();
    t.$('retry').click();
    await flush();
    assert.equal(t.$('retry').disabled, true);
    assert.equal(t.$('retry').textContent, 'Checking…');
    assert.equal(t.$('retry').getAttribute('aria-busy'), 'true');
    await t.timers.advance(1500);
    assert.equal(t.$('retry').disabled, false);
    assert.equal(t.$('retry').textContent, 'Retry');

    await t.timers.advance(5000); // automatic re-check (hangs again)
    assert.equal(t.fetch.calls.length, 3);
    assert.equal(t.$('retry').disabled, false, 'automatic checks leave the button alone');
    await t.timers.advance(1500);
  });

  it('ignores a second check while one is in flight', async () => {
    const t = setup({ fetch: createFetch('hang') });
    const first = t.page.start();
    await flush();
    assert.equal(await t.page.check({ manual: true }), null);
    await t.timers.advance(1500);
    await first;
    assert.equal(t.fetch.calls.length, 1);
  });

  it('a Retry click during an automatic check shows it as busy and starts the retries over', async () => {
    const t = setup({ fetch: createFetch(down, 'hang'), autoRetryMaxAttempts: 3 });
    await t.page.start();
    await t.timers.advance(5000); // automatic re-check starts and hangs
    assert.equal(t.fetch.calls.length, 2);
    assert.equal(t.page.autoAttempts, 1);
    t.$('retry').click();
    await flush();
    assert.equal(t.fetch.calls.length, 2, 'no second request while one is in flight');
    assert.equal(t.$('retry').disabled, true);
    assert.equal(t.$('retry').textContent, 'Checking…');
    assert.equal(t.page.autoAttempts, 0);
    await t.timers.advance(1500); // the in-flight check times out
    assert.equal(t.$('retry').disabled, false);
    assert.equal(t.$('retry').textContent, 'Retry');
    assert.match(t.$('retry-note').textContent, /automatically every 5 seconds/);
    await t.timers.advance(5000 + 1500); // let the next automatic check finish too
  });

  it('retries automatically every 5 seconds and redirects when the server comes up', async () => {
    const t = setup({ fetch: createFetch(down, down, ok) });
    await t.page.start();
    await t.timers.advance(4999);
    assert.equal(t.fetch.calls.length, 1);
    await t.timers.advance(1);
    assert.equal(t.fetch.calls.length, 2);
    assert.equal(t.state(), 'offline');
    await t.timers.advance(5000);
    assert.equal(t.fetch.calls.length, 3);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.timers.pending, 0);
  });

  it('does not auto-redirect while the user is typing a search', async () => {
    const t = setup({ fetch: createFetch(down, ok) });
    await t.page.start();
    t.$('search-query').value = 'weather';
    await t.timers.advance(15000);
    assert.equal(t.fetch.calls.length, 1, 'no checks while the search box has text');
    assert.deepEqual(t.location.replaced, []);

    t.$('search-query').value = '';
    t.$('search-query').focus();
    await t.timers.advance(5000);
    assert.equal(t.fetch.calls.length, 1, 'no checks while the search box is focused');

    t.$('search-query').blur();
    await t.timers.advance(5000);
    assert.equal(t.fetch.calls.length, 2);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
  });

  it('stops retrying automatically after the attempt limit; Retry starts over', async () => {
    const t = setup({ fetch: createFetch(down), autoRetryMaxAttempts: 2 });
    await t.page.start();
    await t.timers.advance(60000);
    assert.equal(t.fetch.calls.length, 3, 'initial check + 2 automatic retries');
    assert.equal(t.timers.pending, 0);
    assert.match(t.$('retry-note').textContent, /Stopped checking automatically/);

    t.$('retry').click();
    await flush();
    assert.equal(t.fetch.calls.length, 4);
    assert.equal(t.page.autoAttempts, 0);
    assert.equal(t.timers.pending, 1, 'automatic retries resume after a manual retry');
  });
});

describe('new tab: fallback search', () => {
  it('searches Google with an encodeURIComponent-ed query', async () => {
    const t = setup({ fetch: createFetch(down) });
    await t.page.start();
    t.$('search-query').value = '  cats & dogs #1 ü  ';
    const event = submitSearch(t);
    assert.equal(event.defaultPrevented, true, 'the form never submits natively');
    assert.deepEqual(t.location.assigned, ['https://www.google.com/search?q=cats%20%26%20dogs%20%231%20%C3%BC']);
    assert.equal(t.timers.pending, 0, 'auto-retry is cancelled once the user searches');
  });

  it('does nothing for an empty query', async () => {
    const t = setup({ fetch: createFetch(down) });
    await t.page.start();
    t.$('search-query').value = '   ';
    const event = submitSearch(t);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(t.location.assigned, []);
    assert.equal(t.document.activeElement, t.$('search-query'));
  });
});

describe('new tab: lifecycle', () => {
  it('destroy() clears the retry timer and detaches handlers', async () => {
    const t = setup({ fetch: createFetch(down) });
    await t.page.start();
    assert.equal(t.timers.pending, 1);
    t.page.destroy();
    assert.equal(t.timers.pending, 0);
    t.$('search-query').value = 'x';
    submitSearch(t);
    assert.deepEqual(t.location.assigned, []);
  });

  it('fails loudly if newtab.html loses a required element', () => {
    const window = loadPage('newtab.html');
    window.document.getElementById('retry').remove();
    assert.throws(
      () => createNewTabPage({ document: window.document, location: createLocation(), storage: null, fetch: createFetch(ok) }),
      /missing #retry/,
    );
    window.close();
  });

  it('fails loudly if newtab.html loses a help section', () => {
    const window = loadPage('newtab.html');
    window.document.querySelector('[data-help="reinstall"]').remove();
    assert.throws(
      () => createNewTabPage({ document: window.document, location: createLocation(), storage: null, fetch: createFetch(ok) }),
      /missing \[data-help="reinstall"\]/,
    );
    window.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Starting Portly through the launcher (native messaging).
// ---------------------------------------------------------------------------------------------

const STARTING = { response: { ok: true, state: 'starting' } };

/** A fetch whose behaviour the test switches: 'down', 'ok', 'hang' (until aborted) or 'deferred'. */
function switchableFetch(initial = 'down') {
  let mode = initial;
  const deferred = [];
  const fetch = createFetch((init) => {
    if (mode === 'ok') return ok();
    if (mode === 'down') return down();
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      if (mode === 'deferred') deferred.push(() => resolve(ok()));
    });
  });
  fetch.set = (next) => {
    mode = next;
  };
  fetch.release = () => deferred.shift()();
  return fetch;
}

describe('new tab: starting Portly', () => {
  it('does not call the launcher when Portly already answers', async () => {
    const t = setup({ runtime: createNativeRuntime(STARTING) });
    await t.page.start();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.runtime.calls.length, 0);
  });

  it('asks the launcher once, shows "Starting Portly…", polls every 400 ms and redirects', async () => {
    const t = setup({ fetch: createFetch(down, down, ok), runtime: createNativeRuntime(STARTING) });
    const result = await t.page.start();
    assert.deepEqual(result, { ok: false, reason: 'unreachable' });
    assert.equal(t.state(), 'starting');
    assert.equal(t.document.title, 'Starting Portly…');
    assert.equal(t.$('starting-detail').textContent, STARTING_TEXT);
    assert.deepEqual(t.runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'start', port: 5757 } }]);

    await flush(); // the launcher answers "starting"
    assert.equal(t.state(), 'starting');
    await t.timers.advance(399);
    assert.equal(t.fetch.calls.length, 1);
    await t.timers.advance(1);
    assert.equal(t.fetch.calls.length, 2);
    assert.equal(t.fetch.calls[1].url, 'http://localhost:5757/api/health');
    assert.equal(t.state(), 'starting');
    await t.timers.advance(400);
    assert.equal(t.fetch.calls.length, 3);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.state(), 'redirecting');
    assert.equal(t.timers.pending, 0, 'poll, deadline and slow-note timers are cleared');
    assert.equal(t.runtime.calls.length, 1);
  });

  it('starts on the configured port and accepts "running"', async () => {
    const t = setup({
      storage: localTarget({ port: 6001 }),
      fetch: createFetch(down, ok),
      runtime: createNativeRuntime({ response: { ok: true, state: 'running' } }),
    });
    await t.page.start();
    assert.deepEqual(t.runtime.calls[0].message, { action: 'start', port: 6001 });
    await t.timers.advance(400);
    assert.equal(t.fetch.calls[1].url, 'http://localhost:6001/api/health');
    assert.deepEqual(t.location.replaced, ['http://localhost:6001/?src=newtab']);
  });

  it('launcher not installed: stops waiting and shows the install instructions', async () => {
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime({ error: NATIVE_ERRORS.notFound }) });
    await t.page.start();
    await flush();
    assert.equal(t.state(), 'offline');
    assert.equal(t.document.title, "Portly isn't running");
    assert.equal(t.$('status-detail').textContent, 'Nothing is answering on http://localhost:5757.');
    assert.equal(t.$('launch-status').hidden, false);
    assert.equal(t.$('launch-status').textContent, "New tabs can't start Portly yet: the Portly launcher isn't installed.");
    assert.deepEqual(t.visibleHelp(), [HELP.install]);
    const help = t.document.querySelector('[data-help="install"]').textContent;
    assert.match(help, /powershell -NoProfile -ExecutionPolicy Bypass -File \.\\scripts\\install-autostart\.ps1/);
    assert.match(help, /docs\\setup\\autostart\.md/);
    assert.equal(t.$('launch').hidden, false);
    assert.equal(t.$('launch').textContent, 'Try starting again');
    assert.equal(t.timers.pending, 1, 'polling stopped; only the 5-second re-check is left');
    await t.timers.advance(4999);
    assert.equal(t.fetch.calls.length, 1);
  });

  it('forbidden (ID mismatch): shows the re-install instructions with this extension ID', async () => {
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime({ error: NATIVE_ERRORS.forbidden }) });
    await t.page.start();
    await flush();
    assert.equal(t.state(), 'offline');
    assert.match(t.$('launch-status').textContent, /doesn't accept this extension's ID/);
    assert.deepEqual(t.visibleHelp(), [HELP.reinstall]);
    const help = t.document.querySelector('[data-help="reinstall"]');
    assert.equal(help.querySelector('[data-extension-id]').textContent, PINNED_EXTENSION_ID);
    assert.match(help.textContent, /install-autostart\.ps1/);
    assert.equal(t.timers.pending, 1);
  });

  it('bad_origin from the host is the same ID mismatch', async () => {
    const reply = { response: { ok: false, state: 'error', error: 'bad_origin', detail: 'origin not allowed' } };
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime(reply) });
    await t.page.start();
    await flush();
    assert.deepEqual(t.visibleHelp(), [HELP.reinstall]);
  });

  it('task missing: shows the install instructions', async () => {
    const reply = { response: { ok: false, state: 'error', error: 'task_missing', detail: 'no such task' } };
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime(reply) });
    await t.page.start();
    await flush();
    assert.equal(t.state(), 'offline');
    assert.match(t.$('launch-status').textContent, /Portly Server scheduled task isn't registered/);
    assert.deepEqual(t.visibleHelp(), [HELP.install]);
  });

  it('schtasks failed: says so with the detail and shows the manual steps', async () => {
    const reply = { response: { ok: false, state: 'error', error: 'schtasks_failed', detail: 'ERROR: Access is denied.' } };
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime(reply) });
    await t.page.start();
    await flush();
    assert.equal(t.state(), 'offline');
    assert.equal(t.$('launch-status').textContent, "Windows couldn't start the Portly Server task: ERROR: Access is denied.");
    assert.deepEqual(t.visibleHelp(), [HELP.manual]);
  });

  for (const error of [NATIVE_ERRORS.exited, NATIVE_ERRORS.failedToStart]) {
    it(`"${error}" may still have started the task: keeps polling and redirects`, async () => {
      const t = setup({ fetch: createFetch(down, down, down, ok), runtime: createNativeRuntime({ error }) });
      await t.page.start();
      await flush();
      assert.equal(t.state(), 'starting');
      await t.timers.advance(800);
      assert.equal(t.state(), 'starting');
      assert.equal(t.fetch.calls.length, 3);
      await t.timers.advance(400);
      assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
      assert.equal(t.runtime.calls.length, 1);
    });
  }

  it('redirects even if the launcher never answers, and ignores its late answer', async () => {
    const runtime = createNativeRuntime('hang');
    const t = setup({ fetch: createFetch(down, ok), runtime });
    await t.page.start();
    await t.timers.advance(400);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    runtime.answer({ error: NATIVE_ERRORS.notFound });
    await flush();
    assert.equal(t.state(), 'redirecting');
    assert.equal(t.$('launch-status').hidden, true);
  });

  it('times out after 30 s with the fallback, then "Try starting again" asks the launcher again', async () => {
    const fetch = switchableFetch('down');
    const t = setup({ fetch, runtime: createNativeRuntime(STARTING) });
    await t.page.start();
    await flush();
    await t.timers.advance(9999);
    assert.equal(t.$('starting-detail').textContent, STARTING_TEXT);
    await t.timers.advance(1);
    assert.equal(t.$('starting-detail').textContent, STARTING_SLOW_TEXT);
    await t.timers.advance(19999);
    assert.equal(t.state(), 'starting');
    await t.timers.advance(1);

    assert.equal(t.state(), 'offline');
    assert.equal(t.$('launch-status').textContent, "Portly didn't answer within 30 seconds of being started.");
    assert.deepEqual(t.visibleHelp(), [HELP.manual]);
    assert.equal(t.$('launch').hidden, false);
    assert.equal(t.$('retry').classList.contains('primary'), false, 'Try starting again is the main action');
    assert.match(t.$('retry-note').textContent, /automatically every 5 seconds/);
    const polls = fetch.calls.length - 1;
    assert.ok(polls >= 70 && polls <= 75, `about one poll per 400 ms (got ${polls})`);
    assert.equal(t.runtime.calls.length, 1);
    assert.equal(t.timers.pending, 1, 'only the 5-second re-check is left');

    // Second attempt.
    fetch.set('ok');
    t.$('launch').click();
    assert.equal(t.state(), 'starting');
    assert.equal(t.$('starting-detail').textContent, STARTING_TEXT);
    assert.equal(t.runtime.calls.length, 2);
    assert.equal(t.page.launchCount, 2);
    await flush();
    await t.timers.advance(400);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.timers.pending, 0);
  });

  it('mentions what the launcher reported when it gave no clear answer and nothing came up', async () => {
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime({ error: NATIVE_ERRORS.exited }) });
    await t.page.start();
    await t.timers.advance(30000);
    assert.equal(t.state(), 'offline');
    assert.equal(
      t.$('launch-status').textContent,
      "Portly didn't answer within 30 seconds of being started. The launcher reported: Native host has exited.",
    );
  });

  it('a check still in flight at the deadline gets to finish (and may redirect)', async () => {
    const fetch = switchableFetch('down');
    const t = setup({ fetch, runtime: createNativeRuntime(STARTING) });
    await t.page.start();
    await t.timers.advance(29599);
    fetch.set('deferred');
    await t.timers.advance(1); // the poll at 29.6 s waits for an answer
    await t.timers.advance(400); // the deadline passes
    assert.equal(t.state(), 'starting');
    fetch.release();
    await flush();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
  });

  it('sends one launcher request per attempt, however often it is asked', async () => {
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime('hang') });
    await t.page.start();
    assert.equal(await t.page.launch(), null);
    t.$('launch').click();
    await flush();
    assert.equal(t.runtime.calls.length, 1);
    assert.equal(t.page.launchCount, 1);
    assert.equal(t.page.launching, true);
  });

  it('a background re-check finishing during a new attempt leaves the starting card alone', async () => {
    const fetch = switchableFetch('down');
    const t = setup({ fetch, runtime: createNativeRuntime({ error: NATIVE_ERRORS.notFound }, 'hang') });
    await t.page.start();
    await flush();
    assert.equal(t.state(), 'offline');
    fetch.set('hang');
    await t.timers.advance(5000); // automatic re-check starts and hangs
    t.$('launch').click(); // the user installed the launcher meanwhile
    assert.equal(t.state(), 'starting');
    await t.timers.advance(1500); // the re-check times out
    assert.equal(t.state(), 'starting');
    fetch.set('ok');
    await t.timers.advance(2000);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.runtime.calls.length, 2);
  });

  it('without native messaging: the plain fallback, no "Try starting again"', async () => {
    const t = setup({ fetch: createFetch(down) });
    await t.page.start();
    assert.equal(t.state(), 'offline');
    assert.equal(t.$('launch').hidden, true);
    assert.equal(t.$('launch-status').hidden, true);
    assert.deepEqual(t.visibleHelp(), [HELP.manual]);
    assert.equal(t.$('retry').classList.contains('primary'), true);
  });

  it('the fallback search still works after a failed start', async () => {
    const t = setup({ fetch: createFetch(down), runtime: createNativeRuntime({ error: NATIVE_ERRORS.notFound }) });
    await t.page.start();
    await flush();
    t.$('search-query').value = 'weather';
    submitSearch(t);
    assert.deepEqual(t.location.assigned, ['https://www.google.com/search?q=weather']);
  });

  it('a health check that succeeds just after the attempt ended still redirects', async () => {
    // The launcher says "not installed" while a poll is in flight, and the user had meanwhile
    // started Portly by hand: the successful answer must not be thrown away.
    const fetch = switchableFetch('down');
    const runtime = createNativeRuntime('hang');
    const t = setup({ fetch, runtime });
    await t.page.start();
    fetch.set('deferred');
    await t.timers.advance(400); // the first poll is now waiting for an answer
    runtime.answer({ error: NATIVE_ERRORS.notFound });
    await flush();
    assert.equal(t.state(), 'offline');
    fetch.release();
    await flush();
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
    assert.equal(t.state(), 'redirecting');
    assert.equal(t.timers.pending, 0);
  });

  it('a stale poll from an earlier attempt that fails changes nothing', async () => {
    const fetch = switchableFetch('down');
    const runtime = createNativeRuntime('hang', STARTING);
    const t = setup({ fetch, runtime });
    await t.page.start();
    fetch.set('hang');
    await t.timers.advance(400); // poll #1 hangs
    runtime.answer({ error: NATIVE_ERRORS.notFound });
    await flush();
    assert.equal(t.state(), 'offline');
    fetch.set('down');
    t.$('launch').click(); // attempt #2
    await flush();
    assert.equal(t.state(), 'starting');
    await t.timers.advance(1500); // poll #1 times out (1.5 s after it began)
    assert.equal(t.state(), 'starting', 'the old poll does not end the new attempt');
    fetch.set('ok');
    await t.timers.advance(2000);
    assert.deepEqual(t.location.replaced, ['http://localhost:5757/?src=newtab']);
  });

  it('destroy() during an attempt clears every timer and ignores the late answer', async () => {
    const runtime = createNativeRuntime('hang');
    const t = setup({ fetch: createFetch(down), runtime });
    await t.page.start();
    assert.ok(t.timers.pending >= 3);
    t.page.destroy();
    assert.equal(t.timers.pending, 0);
    runtime.answer({ error: NATIVE_ERRORS.notFound });
    await flush();
    assert.equal(t.state(), 'starting');
  });
});

describe('new tab: extension still running under its old ID', () => {
  for (const [name, reply] of [
    ['forbidden', { error: NATIVE_ERRORS.forbidden }],
    ['bad_origin', { response: { ok: false, state: 'error', error: 'bad_origin', detail: 'origin not allowed' } }],
    ['not found', { error: NATIVE_ERRORS.notFound }],
  ]) {
    it(`${name}: says Remove + Load unpacked (running the installer again can't fix it)`, async () => {
      const runtime = createNativeRuntime(reply);
      runtime.id = OLD_PATH_EXTENSION_ID;
      const t = setup({ fetch: createFetch(down), runtime });
      await t.page.start();
      await flush();
      assert.equal(t.state(), 'offline');
      assert.match(t.$('launch-status').textContent, /still runs this extension under its old ID/);
      assert.deepEqual(t.visibleHelp(), [HELP.reload]);
      const help = t.document.querySelector('[data-help="reload"]');
      assert.equal(help.querySelector('[data-extension-id]').textContent, OLD_PATH_EXTENSION_ID);
      assert.equal(help.querySelector('[data-pinned-id]').textContent, PINNED_EXTENSION_ID);
      assert.match(help.textContent, /Remove/);
      assert.match(help.textContent, /Load unpacked/);
      assert.match(help.textContent, /install-autostart\.ps1/);
    });
  }

  it('other outcomes are unaffected by the old ID', async () => {
    const runtime = createNativeRuntime({ response: { ok: false, state: 'error', error: 'task_missing', detail: 'x' } });
    runtime.id = OLD_PATH_EXTENSION_ID;
    const t = setup({ fetch: createFetch(down), runtime });
    await t.page.start();
    await flush();
    assert.deepEqual(t.visibleHelp(), [HELP.install]);
  });

  it('newtab.html carries the pinned ID even before the script fills it in', () => {
    const window = loadPage('newtab.html');
    assert.equal(window.document.querySelector('[data-pinned-id]').textContent, PINNED_EXTENSION_ID);
    window.close();
  });
});

describe('new tab: destroyed page', () => {
  it('ignores checks, launches and late health answers after destroy()', async () => {
    const fetch = switchableFetch('deferred');
    const t = setup({ fetch, runtime: createNativeRuntime(STARTING) });
    const started = t.page.start();
    await flush(); // the first check waits for an answer
    t.page.destroy();
    fetch.release();
    await started;
    assert.deepEqual(t.location.replaced, []);
    assert.equal(t.timers.pending, 0);
    assert.equal(await t.page.check({ manual: true }), null);
    assert.equal(await t.page.launch(), null);
    assert.equal(t.runtime.calls.length, 0);
  });
});

describe('describeLaunchEnd', () => {
  it('sends a stale extension ID to the reload help, only for not-installed / mismatch', () => {
    const outcome = (kind) => ({ kind, code: null, detail: '' });
    for (const kind of ['mismatch', 'not_installed']) {
      assert.equal(describeLaunchEnd({ reason: 'launcher', outcome: outcome(kind) }, 30000, OLD_PATH_EXTENSION_ID).help, HELP.reload);
      assert.notEqual(describeLaunchEnd({ reason: 'launcher', outcome: outcome(kind) }, 30000, PINNED_EXTENSION_ID).help, HELP.reload);
      assert.notEqual(describeLaunchEnd({ reason: 'launcher', outcome: outcome(kind) }, 30000, null).help, HELP.reload);
    }
    assert.equal(describeLaunchEnd({ reason: 'timeout', outcome: outcome('maybe') }, 30000, OLD_PATH_EXTENSION_ID).help, HELP.manual);
    assert.equal(describeLaunchEnd({ reason: 'launcher', outcome: outcome('task_missing') }, 30000, OLD_PATH_EXTENSION_ID).help, HELP.install);
  });

  it('words each outcome and picks the help section', () => {
    const outcome = (kind, code = null, detail = '') => ({ kind, code, detail });
    assert.deepEqual(describeLaunchEnd({ reason: 'timeout', outcome: outcome('starting') }), {
      message: "Portly didn't answer within 30 seconds of being started.",
      help: HELP.manual,
    });
    assert.equal(
      describeLaunchEnd({ reason: 'timeout', outcome: null }, 15000).message,
      "Portly didn't answer within 15 seconds of being started.",
    );
    assert.equal(
      describeLaunchEnd({ reason: 'timeout', outcome: outcome('running') }).message,
      "The launcher says Portly is running, but this page couldn't reach it within 30 seconds.",
    );
    assert.equal(describeLaunchEnd({ reason: 'launcher', outcome: outcome('not_installed') }).help, HELP.install);
    assert.equal(describeLaunchEnd({ reason: 'launcher', outcome: outcome('task_missing') }).help, HELP.install);
    assert.equal(describeLaunchEnd({ reason: 'launcher', outcome: outcome('mismatch') }).help, HELP.reinstall);
    assert.deepEqual(describeLaunchEnd({ reason: 'launcher', outcome: outcome('failed', 'bad_request', 'port out of range') }), {
      message: 'The launcher rejected the start request: port out of range.',
      help: HELP.manual,
    });
    assert.equal(
      describeLaunchEnd({ reason: 'launcher', outcome: outcome('failed', 'weird', '') }).message,
      "The launcher couldn't start Portly.",
    );
  });
});

describe('new tab: "Add this page" requests (the toolbar button)', () => {
  const REQUEST = `#/add-bookmark?${new URLSearchParams({ url: 'https://example.com/a?b=1', title: 'A page' }).toString()}`;

  it('passes the request on to the Pages site', async () => {
    const t = setup({ storage: siteKnown(), sendMessage: createSendMessage('ack'), hash: REQUEST });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [`${SITE}${REQUEST}`]);
  });

  it('passes the request on to Portly on this PC', async () => {
    const t = setup({ hash: REQUEST });
    await t.page.start();
    assert.deepEqual(t.location.replaced, [`http://localhost:5757/?src=newtab${REQUEST}`]);
  });

  it('drops any other hash, and rebuilds the request from its validated parameters', async () => {
    for (const [hash, expected] of [
      ['#/settings/accounts', ''],
      ['#anything', ''],
      [`#/add-bookmark?${new URLSearchParams({ url: 'javascript:alert(1)' }).toString()}`, ''],
      [`#/add-bookmark?url=${encodeURIComponent('https://example.com/')}&extra=1`, `#/add-bookmark?url=${encodeURIComponent('https://example.com/')}`],
    ]) {
      const t = setup({ storage: siteKnown(), sendMessage: createSendMessage('ack'), hash });
      await t.page.start();
      assert.deepEqual(t.location.replaced, [`${SITE}${expected}`], hash);
    }
  });
});
