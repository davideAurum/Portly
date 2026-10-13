/**
 * Test doubles for the extension tests (node:test): chrome.storage.local, fetch, manual timers,
 * location, and jsdom documents built from the real HTML pages (scripts are not executed).
 */
import fs from 'node:fs';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { JSDOM } from 'jsdom';

export const EXTENSION_DIR = new URL('../', import.meta.url);

export function readExtensionFile(relativePath) {
  return fs.readFileSync(new URL(relativePath, EXTENSION_DIR), 'utf8');
}

/** jsdom window for newtab.html / options.html (no script execution, no network). */
export function loadPage(file) {
  const dom = new JSDOM(readExtensionFile(file), { url: `chrome-extension://homebase-test/${file}` });
  return dom.window;
}

/** Lets pending promise callbacks and timers-free async work settle. */
export async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await nextMacrotask();
}

/** Minimal chrome.storage.local stand-in. */
export function createStorage(initial = {}, { failGet = false, failSet = false } = {}) {
  const data = { ...initial };
  const calls = { get: [], set: [], remove: [] };
  return {
    data,
    calls,
    async get(keys) {
      calls.get.push(keys);
      if (failGet) throw new Error('storage unavailable');
      const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of wanted) if (Object.hasOwn(data, key)) out[key] = data[key];
      return out;
    },
    async set(items) {
      calls.set.push(items);
      if (failSet) throw new Error('quota exceeded');
      Object.assign(data, items);
    },
    async remove(keys) {
      calls.remove.push(keys);
      if (failSet) throw new Error('quota exceeded');
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
  };
}

/** Deterministic setTimeout/clearTimeout; `advance(ms)` fires due timers in order. */
export function createTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      nextId += 1;
      pending.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        pending.delete(handle);
        now = timer.at;
        timer.fn();
        await flush();
      }
      now = target;
      await flush();
    },
    get pending() {
      return pending.size;
    },
    get now() {
      return now;
    },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const HEALTHY = Object.freeze({ ok: true, version: '0.1.0', vault: 'ready' });

/**
 * Scripted fetch: each call takes the next handler (the last one repeats). A handler is a
 * factory returning a Response (or an Error to reject with), an Error, or 'hang' (settles only
 * when the request's signal aborts).
 */
export function createFetch(...handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }
    if (handler instanceof Error) throw handler;
    const result = await handler(init);
    if (result instanceof Error) throw result;
    return result;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const ok = () => jsonResponse(HEALTHY);
export const down = () => new TypeError('Failed to fetch');

export function createLocation() {
  return {
    replaced: [],
    assigned: [],
    replace(url) {
      this.replaced.push(url);
    },
    assign(url) {
      this.assigned.push(url);
    },
  };
}

/**
 * The ID Chrome/Edge derive from manifest.json's "key" (see tools/extension-id.mjs); the pages use
 * lib/launcher.js's copy, which test/extension-id.test.mjs checks against the key.
 */
export const PINNED_EXTENSION_ID = 'nbaolbakegefnefgojdokagajincnfjj';

/** The folder-derived ID the extension had before 0.2.0 pinned it (what a stale install still uses). */
export const OLD_PATH_EXTENSION_ID = 'daklamdnkmbdeegnkhmpeccgggbgiole';

/** Browser-side native-messaging errors, verbatim from Chromium. */
export const NATIVE_ERRORS = Object.freeze({
  notFound: 'Specified native messaging host not found.',
  forbidden: 'Access to the specified native messaging host is forbidden.',
  exited: 'Native host has exited.',
  failedToStart: 'Failed to start native messaging host.',
});

/**
 * Fake chrome.runtime with the callback form of sendNativeMessage. Like Chrome, it answers
 * asynchronously and sets `lastError` only while the callback runs. Each call takes the next
 * handler (the last one repeats):
 *   { response: <host reply> } | { error: '<lastError message>' } | 'throw' (synchronous throw)
 *   | 'hang' (answer later with runtime.answer(reply)) | (message) => one of these.
 */
export function createNativeRuntime(...handlers) {
  const calls = [];
  const waiting = [];
  const runtime = {
    /** chrome.runtime.id; tests set OLD_PATH_EXTENSION_ID to simulate a stale install. */
    id: PINNED_EXTENSION_ID,
    lastError: undefined,
    calls,
    sendNativeMessage(host, message, callback) {
      calls.push({ host, message: structuredClone(message) });
      let handler = handlers.length === 0 ? 'hang' : handlers[Math.min(calls.length - 1, handlers.length - 1)];
      if (typeof handler === 'function') handler = handler(message);
      if (handler === 'throw') throw new Error('Error in invocation of runtime.sendNativeMessage');
      const deliver = (reply) =>
        setImmediate(() => {
          if (reply && 'error' in reply) {
            runtime.lastError = { message: reply.error };
            try {
              callback(undefined);
            } finally {
              runtime.lastError = undefined;
            }
          } else {
            callback(reply?.response);
          }
        });
      if (handler === 'hang') waiting.push(deliver);
      else deliver(handler);
    },
    /** Answers the oldest request still waiting ('hang'). */
    answer(reply) {
      const deliver = waiting.shift();
      if (!deliver) throw new Error('no native message is waiting for an answer');
      deliver(reply);
    },
    get waiting() {
      return waiting.length;
    },
  };
  return runtime;
}

/** chrome.events.Event stand-in: addListener + dispatch(...args). */
export function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn);
    },
    dispatch(...args) {
      for (const fn of listeners) fn(...args);
    },
  };
}
