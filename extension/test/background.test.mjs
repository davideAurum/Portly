/**
 * Service-worker warm-up (lib/warm-up.js + background.js) with mocked chrome.runtime,
 * chrome.storage.local/.session and fetch: one health check, at most one launcher request, no
 * polling, errors swallowed; new tabs' warm-up requests acknowledged at once and throttled.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLauncher } from '../lib/launcher.js';
import {
  LAST_WARM_UP_KEY,
  WARM_UP_ACK,
  WARM_UP_THROTTLE_MS,
  isRecentWarmUp,
  registerWarmUp,
  warmUp,
} from '../lib/warm-up.js';
import {
  HEALTHY,
  NATIVE_ERRORS,
  OLD_PATH_EXTENSION_ID,
  PINNED_EXTENSION_ID,
  createEvent,
  createFetch,
  createNativeRuntime,
  createStorage,
  createTimers,
  down,
  flush,
  jsonResponse,
  ok,
  readExtensionFile,
} from './helpers.mjs';

const STARTING = { response: { ok: true, state: 'starting' } };

function createLog() {
  const entries = [];
  const log = (level, message) => entries.push({ level, message });
  log.entries = entries;
  return log;
}

/** `session: null` leaves chrome.storage.session out (older browsers, or a failure to expose it). */
function createChrome({ runtime = createNativeRuntime(STARTING), storage = createStorage(), session = createStorage() } = {}) {
  runtime.onStartup = createEvent();
  runtime.onInstalled = createEvent();
  runtime.onMessage = createEvent();
  return { runtime, storage: session === null ? { local: storage } : { local: storage, session } };
}

/**
 * Delivers a runtime message the way Chrome does: to every onMessage listener, with a
 * sendResponse callback. Returns what the listeners answered (synchronously) and returned.
 */
function deliver(chrome, message, sender = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/newtab.html` }) {
  const responses = [];
  const returned = chrome.runtime.onMessage.listeners.map((listener) => listener(message, sender, (response) => responses.push(response)));
  return { responses, returned };
}

const WARM_UP = { type: 'portly:warm-up' };

/** A clock the test moves by hand. */
function createClock(start = 1_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

describe('warmUp', () => {
  it('does nothing more when Portly already answers', async () => {
    const runtime = createNativeRuntime(STARTING);
    const fetch = createFetch(ok);
    const log = createLog();
    const result = await warmUp({ storage: createStorage(), fetch, launcher: createLauncher(runtime), log });
    assert.deepEqual(result, { port: 5757, action: 'already-running', outcome: null });
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, 'http://localhost:5757/api/health');
    assert.equal(runtime.calls.length, 0, 'no launcher request');
    assert.equal(log.entries[0].level, 'info');
  });

  it('records what a healthy Portly says about its Pages site (the "auto" new tab follows it)', async () => {
    const storage = createStorage({ port: 6001, serverSite: { port: 6001, pagesUrl: null } });
    const fetch = createFetch(() => jsonResponse({ ...HEALTHY, pagesUrl: 'https://me.github.io/portly' }));
    await warmUp({ storage, fetch, launcher: null });
    assert.deepEqual(storage.data.serverSite, { port: 6001, pagesUrl: 'https://me.github.io/portly/' });
    await warmUp({ storage, fetch, launcher: null });
    assert.equal(storage.calls.set.length, 1, 'an unchanged answer writes nothing');
  });

  it('records nothing when Portly is down or says nothing about a Pages site', async () => {
    for (const fetch of [createFetch(down), createFetch(ok)]) {
      const storage = createStorage();
      await warmUp({ storage, fetch, launcher: null });
      assert.deepEqual(storage.calls.set, []);
    }
  });

  it('asks the launcher to start Portly on the stored port, once, without polling', async () => {
    const runtime = createNativeRuntime(STARTING);
    const fetch = createFetch(down);
    const timers = createTimers();
    const result = await warmUp({
      storage: createStorage({ port: 6001 }),
      fetch,
      launcher: createLauncher(runtime, timers),
      ...timers,
    });
    assert.deepEqual(result, { port: 6001, action: 'requested-start', outcome: { kind: 'starting', code: null, detail: '' } });
    assert.deepEqual(runtime.calls, [{ host: 'com.portly.launcher', message: { action: 'start', port: 6001 } }]);
    assert.equal(fetch.calls.length, 1, 'one health check only');
    assert.equal(timers.pending, 0, 'nothing scheduled afterwards');
  });

  it('gives the health check only a short timeout before asking the launcher', async () => {
    const runtime = createNativeRuntime(STARTING);
    const timers = createTimers();
    const pending = warmUp({ storage: createStorage(), fetch: createFetch('hang'), launcher: createLauncher(runtime), ...timers });
    await flush(); // the port is read; the health check starts
    await timers.advance(1499);
    assert.equal(runtime.calls.length, 0);
    await timers.advance(1);
    const result = await pending;
    assert.equal(result.action, 'requested-start');
    assert.equal(runtime.calls.length, 1);
  });

  it('logs and swallows launcher errors', async () => {
    for (const [reply, kind] of [
      [{ error: NATIVE_ERRORS.notFound }, 'not_installed'],
      [{ error: NATIVE_ERRORS.forbidden }, 'mismatch'],
      [{ error: NATIVE_ERRORS.exited }, 'maybe'],
      [{ response: { ok: false, state: 'error', error: 'task_missing', detail: 'no task' } }, 'task_missing'],
      ['throw', 'maybe'],
    ]) {
      const log = createLog();
      const result = await warmUp({
        storage: createStorage(),
        fetch: createFetch(down),
        launcher: createLauncher(createNativeRuntime(reply)),
        log,
        trigger: 'browser start',
      });
      assert.equal(result.action, 'requested-start');
      assert.equal(result.outcome.kind, kind);
      const last = log.entries.at(-1);
      assert.equal(last.level, 'warn');
      assert.match(last.message, /\(browser start\)/);
    }
  });

  it('falls back to port 5757 when storage fails, and copes without a launcher', async () => {
    const fetch = createFetch(down);
    const result = await warmUp({ storage: createStorage({}, { failGet: true }), fetch, launcher: null, log: createLog() });
    assert.deepEqual(result, { port: 5757, action: 'no-launcher', outcome: null });
    assert.equal(fetch.calls[0].url, 'http://localhost:5757/api/health');
  });

  it('never rejects, even when a dependency throws', async () => {
    const log = createLog();
    const launcher = {
      start() {
        throw new Error('boom');
      },
    };
    const result = await warmUp({ storage: createStorage(), fetch: createFetch(down), launcher, log });
    assert.deepEqual(result, { port: 5757, action: 'error', outcome: null });
    assert.match(log.entries.at(-1).message, /boom/);
  });
});

describe('registerWarmUp', () => {
  it('registers onStartup and onInstalled listeners synchronously', () => {
    const chrome = createChrome();
    registerWarmUp(chrome, { fetch: createFetch(ok) });
    assert.equal(chrome.runtime.onStartup.listeners.length, 1);
    assert.equal(chrome.runtime.onInstalled.listeners.length, 1);
  });

  it('browser start: checks health and starts Portly when it is down', async () => {
    const chrome = createChrome({ storage: createStorage({ port: 5800 }) });
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch, log: createLog() });
    chrome.runtime.onStartup.dispatch();
    await flush();
    assert.equal(fetch.calls[0].url, 'http://localhost:5800/api/health');
    assert.deepEqual(chrome.runtime.calls.map((c) => c.message), [{ action: 'start', port: 5800 }]);
  });

  it('install/update/reload: the same warm-up', async () => {
    const chrome = createChrome();
    const log = createLog();
    registerWarmUp(chrome, { fetch: createFetch(down), log });
    chrome.runtime.onInstalled.dispatch({ reason: 'update' });
    await flush();
    assert.equal(chrome.runtime.calls.length, 1);
    assert.match(log.entries.at(-1).message, /extension update/);
  });

  it('overlapping triggers share one warm-up; a later trigger runs again', async () => {
    const chrome = createChrome();
    const fetch = createFetch(down);
    const { run } = registerWarmUp(chrome, { fetch, log: createLog() });
    chrome.runtime.onStartup.dispatch();
    chrome.runtime.onInstalled.dispatch({ reason: 'chrome_update' });
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.equal(chrome.runtime.calls.length, 1);
    await run('again');
    assert.equal(chrome.runtime.calls.length, 2);
  });

  it('works without native messaging (no sendNativeMessage)', async () => {
    const chrome = createChrome({ runtime: { id: 'x' } });
    const log = createLog();
    const { run } = registerWarmUp(chrome, { fetch: createFetch(down), log });
    const result = await run('test');
    assert.equal(result.action, 'no-launcher');
  });
});

describe('registerWarmUp: warm-up requests from new tabs', () => {
  it('registers an onMessage listener synchronously', () => {
    const chrome = createChrome();
    registerWarmUp(chrome, { fetch: createFetch(ok) });
    assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  });

  it('acknowledges at once, then checks health and starts Portly on the stored port', async () => {
    const chrome = createChrome({ storage: createStorage({ port: 5800 }) });
    const fetch = createFetch(down);
    const log = createLog();
    registerWarmUp(chrome, { fetch, log });
    const { responses, returned } = deliver(chrome, WARM_UP);
    assert.deepEqual(responses, [WARM_UP_ACK], 'answered before the listener returned');
    assert.deepEqual(WARM_UP_ACK, { ok: true });
    assert.deepEqual(returned, [false], 'no asynchronous response is kept open');
    await flush();
    assert.equal(fetch.calls[0].url, 'http://localhost:5800/api/health');
    assert.deepEqual(chrome.runtime.calls.map((c) => c.message), [{ action: 'start', port: 5800 }]);
    assert.match(log.entries.at(-1).message, /\(new tab\)/);
  });

  it('does nothing more when Portly already answers', async () => {
    const chrome = createChrome();
    const fetch = createFetch(ok);
    registerWarmUp(chrome, { fetch, log: createLog() });
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.equal(chrome.runtime.calls.length, 0);
  });

  it('ignores messages from anything but this extension, and other messages', async () => {
    const chrome = createChrome();
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch, log: createLog() });
    for (const [message, sender] of [
      [WARM_UP, { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html' }],
      [WARM_UP, { url: 'https://davideaurum.github.io/' }],
      [WARM_UP, {}],
      [WARM_UP, null],
      [{ type: 'portly:start' }, { id: PINNED_EXTENSION_ID }],
      ['portly:warm-up', { id: PINNED_EXTENSION_ID }],
      [null, { id: PINNED_EXTENSION_ID }],
    ]) {
      const { responses, returned } = deliver(chrome, message, sender);
      assert.deepEqual(responses, [], `no answer for ${JSON.stringify([message, sender])}`);
      assert.deepEqual(returned, [false]);
    }
    await flush();
    assert.equal(fetch.calls.length, 0);
    assert.equal(chrome.runtime.calls.length, 0);
  });

  it('refuses every sender when its own ID is unknown', async () => {
    const runtime = createNativeRuntime(STARTING);
    runtime.id = undefined;
    const chrome = createChrome({ runtime });
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch });
    const { responses } = deliver(chrome, WARM_UP, { id: undefined });
    assert.deepEqual(responses, []);
    await flush();
    assert.equal(fetch.calls.length, 0);
  });

  it(`warms up at most once per ${WARM_UP_THROTTLE_MS / 1000} s (every request is still acknowledged)`, async () => {
    const session = createStorage();
    const chrome = createChrome({ session });
    const fetch = createFetch(down);
    const now = createClock();
    registerWarmUp(chrome, { fetch, log: createLog(), now });
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(session.data, { [LAST_WARM_UP_KEY]: now() });

    now.advance(WARM_UP_THROTTLE_MS - 1);
    const { responses } = deliver(chrome, WARM_UP);
    assert.deepEqual(responses, [WARM_UP_ACK]);
    await flush();
    assert.equal(fetch.calls.length, 1, 'throttled');
    assert.equal(chrome.runtime.calls.length, 1);

    now.advance(1);
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 2, 'a minute later it warms up again');
    assert.equal(chrome.runtime.calls.length, 2);
    assert.equal(session.data[LAST_WARM_UP_KEY], now());
  });

  it('two requests arriving together share one warm-up', async () => {
    const chrome = createChrome();
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch, log: createLog() });
    deliver(chrome, WARM_UP);
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.equal(chrome.runtime.calls.length, 1);
  });

  it('keeps the throttle across a stopped and restarted worker (chrome.storage.session)', async () => {
    const session = createStorage();
    const now = createClock();
    const first = createChrome({ session });
    const fetch = createFetch(down);
    registerWarmUp(first, { fetch, log: createLog(), now });
    deliver(first, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1);

    // The worker was stopped; a new instance registers its listeners afresh.
    now.advance(30_000);
    const second = createChrome({ session });
    registerWarmUp(second, { fetch, log: createLog(), now });
    deliver(second, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1, 'the stamp in storage.session still throttles');

    now.advance(30_000);
    deliver(second, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 2);
  });

  it('falls back to an in-memory throttle without chrome.storage.session', async () => {
    for (const session of [null, createStorage({}, { failGet: true, failSet: true })]) {
      const chrome = createChrome({ session });
      const fetch = createFetch(down);
      const now = createClock();
      registerWarmUp(chrome, { fetch, log: createLog(), now });
      deliver(chrome, WARM_UP);
      await flush();
      now.advance(1000);
      const { responses } = deliver(chrome, WARM_UP);
      assert.deepEqual(responses, [WARM_UP_ACK]);
      await flush();
      assert.equal(fetch.calls.length, 1, 'throttled in memory');
      now.advance(WARM_UP_THROTTLE_MS);
      deliver(chrome, WARM_UP);
      await flush();
      assert.equal(fetch.calls.length, 2);
    }
  });

  it('a session area whose set throws synchronously does not break the warm-up', async () => {
    const session = {
      async get() {
        return {};
      },
      set() {
        throw new Error('storage.session is not available');
      },
    };
    const chrome = createChrome({ session });
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch, log: createLog() });
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(chrome.runtime.calls.length, 1);
  });

  it('a stamp from the future (the clock was set back) does not block warm-ups', async () => {
    const now = createClock();
    const session = createStorage({ [LAST_WARM_UP_KEY]: now() + 10 * 60_000 });
    const chrome = createChrome({ session });
    const fetch = createFetch(down);
    registerWarmUp(chrome, { fetch, log: createLog(), now });
    deliver(chrome, WARM_UP);
    await flush();
    assert.equal(fetch.calls.length, 1);
  });

  it('a warm-up at browser start counts: a new tab right after it does not repeat it', async () => {
    const chrome = createChrome();
    const fetch = createFetch(down);
    const now = createClock();
    registerWarmUp(chrome, { fetch, log: createLog(), now });
    chrome.runtime.onStartup.dispatch();
    deliver(chrome, WARM_UP); // joins the warm-up in flight
    await flush();
    assert.equal(fetch.calls.length, 1);
    now.advance(5000);
    deliver(chrome, WARM_UP); // within the minute
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.equal(chrome.runtime.calls.length, 1);
  });

  it('browser start and extension reloads always warm up, whatever the throttle says', async () => {
    const chrome = createChrome();
    const fetch = createFetch(down);
    const { run } = registerWarmUp(chrome, { fetch, log: createLog() });
    deliver(chrome, WARM_UP);
    await flush();
    chrome.runtime.onInstalled.dispatch({ reason: 'update' });
    await flush();
    assert.equal(fetch.calls.length, 2);
    await run('again');
    assert.equal(fetch.calls.length, 3);
  });

  it('runIfDue reports a throttled request as null', async () => {
    const chrome = createChrome();
    const { runIfDue } = registerWarmUp(chrome, { fetch: createFetch(ok), log: createLog() });
    assert.equal((await runIfDue('new tab')).action, 'already-running');
    assert.equal(await runIfDue('new tab'), null);
  });
});

describe('isRecentWarmUp', () => {
  it('is true only for a finite stamp less than a minute in the past', () => {
    assert.equal(isRecentWarmUp(1000, 1000), true);
    assert.equal(isRecentWarmUp(1000, 1000 + WARM_UP_THROTTLE_MS - 1), true);
    assert.equal(isRecentWarmUp(1000, 1000 + WARM_UP_THROTTLE_MS), false);
    assert.equal(isRecentWarmUp(2000, 1000), false, 'a future stamp');
    for (const stamp of [null, undefined, '1000', Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isRecentWarmUp(stamp, 1000), false, String(stamp));
    }
  });
});

describe('background.js', () => {
  it('registers the listeners at the top level and warms up with the global fetch', async () => {
    const chrome = createChrome({ storage: createStorage({ port: 6100 }) });
    const fetch = createFetch(down);
    const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, warn: console.warn, info: console.info };
    const logged = [];
    globalThis.chrome = chrome;
    globalThis.fetch = fetch;
    console.warn = (...args) => logged.push(['warn', ...args]);
    console.info = (...args) => logged.push(['info', ...args]);
    try {
      await import('../background.js');
      assert.equal(chrome.runtime.onStartup.listeners.length, 1, 'onStartup registered during module evaluation');
      assert.equal(chrome.runtime.onInstalled.listeners.length, 1, 'onInstalled registered during module evaluation');
      assert.equal(chrome.runtime.onMessage.listeners.length, 1, 'onMessage registered during module evaluation');
      chrome.runtime.onStartup.dispatch();
      await flush();
      assert.equal(fetch.calls[0].url, 'http://localhost:6100/api/health');
      assert.deepEqual(chrome.runtime.calls.map((c) => c.message), [{ action: 'start', port: 6100 }]);
      assert.deepEqual(logged.at(-1).slice(0, 1), ['info']);
      assert.match(logged.at(-1)[1], /^\[Portly\] Asked the launcher to start Portly on port 6100/);
    } finally {
      globalThis.chrome = original.chrome;
      globalThis.fetch = original.fetch;
      console.warn = original.warn;
      console.info = original.info;
    }
  });

  it('has no polling loops or timers of its own', () => {
    for (const file of ['background.js', 'lib/warm-up.js', 'lib/add-page.js']) {
      assert.doesNotMatch(readExtensionFile(file), /setInterval|importScripts|while\s*\(/, file);
    }
  });

  it('every module the service worker loads is service-worker safe', () => {
    // Walk the static import graph from background.js, so a new import is checked too.
    const seen = new Set();
    const queue = ['background.js'];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readExtensionFile(file);
      // Comments (including JSDoc `import('./x').Type`) don't run; strip them before checking.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      // A module service worker can't use import() (registration fails) or top-level await
      // (Chrome refuses it in service workers, and it would delay the listeners past the event
      // that woke the worker).
      assert.doesNotMatch(code, /\bimport\s*\(/, `${file}: dynamic import()`);
      assert.doesNotMatch(code, /^(?:await\b|for\s+await\b|(?:const|let|var)\s[^=\n]*=\s*await\b)/m, `${file}: top-level await`);
      // No DOM or page-only globals in a worker.
      assert.doesNotMatch(code, /\b(window|document|localStorage|sessionStorage|XMLHttpRequest)\b/, `${file}: page-only global`);
      for (const match of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const resolved = new URL(match[1], new URL(file, 'file:///ext/')).pathname.replace(/^\/ext\//, '');
        queue.push(resolved);
      }
    }
    assert.deepEqual([...seen].sort(), ['background.js', 'lib/add-page.js', 'lib/launcher.js', 'lib/portly.js', 'lib/warm-up.js']);
  });
});

describe('warm-up: stale extension ID', () => {
  it('says why the launcher refuses an extension still running under its old ID', async () => {
    const runtime = createNativeRuntime({ error: NATIVE_ERRORS.forbidden });
    runtime.id = OLD_PATH_EXTENSION_ID;
    const chrome = createChrome({ runtime });
    const log = createLog();
    const { run } = registerWarmUp(chrome, { fetch: createFetch(down), log });
    const result = await run('browser start');
    assert.equal(result.outcome.kind, 'mismatch');
    const last = log.entries.at(-1);
    assert.equal(last.level, 'warn');
    assert.match(last.message, new RegExp(`old ID ${OLD_PATH_EXTENSION_ID}, not ${PINNED_EXTENSION_ID}: Remove it and Load unpacked again`));
  });

  it('adds nothing when the ID is the pinned one', async () => {
    const chrome = createChrome({ runtime: createNativeRuntime({ error: NATIVE_ERRORS.forbidden }) });
    const log = createLog();
    const { run } = registerWarmUp(chrome, { fetch: createFetch(down), log });
    await run('browser start');
    assert.doesNotMatch(log.entries.at(-1).message, /old ID/);
  });
});
