/**
 * This browser's diagnostic events: the ring and its localStorage mirror (per-build key, 300
 * entries, 256 KB, 7-day drop on load, a full quota, debug events never persisted and kept beside
 * the ring, other tabs' writes merged and followed), the per-category field allowlists and
 * scrubbing (no secrets, URLs, query strings or user paths), the session id and page info, what is
 * uploaded, when it counts as uploaded, and the lock that keeps two tabs from sending it twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientEventSchema, ClientEventsRequestSchema, type ClientEventCategory } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import {
  CLIENT_EVENT_FIELDS,
  CLIENT_LOG_DEBUG_SIZE,
  CLIENT_LOG_MAX_CHARS,
  CLIENT_LOG_SIZE,
  clearClientEvents,
  clientEventsStorageKey,
  clientPageInfo,
  clientSessionId,
  getClientEvents,
  isUploadable,
  markUploaded,
  pendingUpload,
  recordClientEvent,
  resetClientLogForTests,
  subscribeClientEvents,
  withUploadLock,
} from './clientLog.ts';

const KEY = 'portly:diagnostics:events';
const START = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function stored(): { v: number; entries: { id: string; uploaded: boolean; event: { level: string; msg: string } }[] } | null {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** A new page load: memory forgotten, localStorage kept. */
function reload(): void {
  const raw = window.localStorage.getItem(KEY);
  resetClientLogForTests();
  if (raw !== null) window.localStorage.setItem(KEY, raw);
}

function messages(): string[] {
  return getClientEvents().map((entry) => entry.event.msg);
}

function fieldsOf(cat: ClientEventCategory, fields: Record<string, unknown>, level: 'info' | 'warn' = 'warn') {
  const entry = recordClientEvent(level, cat, 'event', fields);
  expect(entry).not.toBeNull();
  return entry!.event.fields;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('recording', () => {
  it('records events with the session, page info and time, oldest first', () => {
    vi.useFakeTimers({ now: START });
    const first = recordClientEvent('warn', 'api', 'request failed', { method: 'GET', status: 502 });
    vi.setSystemTime(START + 1000);
    const second = recordClientEvent('info', 'hybrid', 'status changed', { from: 'connected', to: 'reconnecting' });
    const session = clientSessionId();
    expect(session).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(first).toEqual({
      id: `${session}-1`,
      uploaded: false,
      event: {
        t: '2026-10-11T12:00:00.000Z',
        level: 'warn',
        cat: 'api',
        msg: 'request failed',
        fields: { method: 'GET', status: 502 },
        session,
        page: { build: 'server', backend: 'server', version: '0.0.0-test' },
      },
    });
    expect(second?.id).toBe(`${session}-2`);
    expect(getClientEvents()).toEqual([first, second]);
    // Entries are immutable snapshots.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.event.fields)).toBe(true);
  });

  it('gives every page load its own session id', () => {
    const before = clientSessionId();
    resetClientLogForTests();
    expect(clientSessionId()).not.toBe(before);
  });

  it('describes the page load: build, backend and version', () => {
    expect(clientPageInfo()).toEqual({ build: 'server', backend: 'server', version: '0.0.0-test' });
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(clientPageInfo()).toEqual({ build: 'pages', backend: 'browser', version: '0.0.0-test' });
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    expect(recordClientEvent('error', 'backend', 'start failed')?.event.page).toEqual({ build: 'pages', backend: 'server', version: '0.0.0-test' });
  });

  it('keeps the array between changes and tells subscribers about each one', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeClientEvents(listener);
    const before = getClientEvents();
    expect(getClientEvents()).toBe(before);
    recordClientEvent('info', 'app', 'one');
    expect(listener).toHaveBeenCalledTimes(1);
    const after = getClientEvents();
    expect(after).not.toBe(before);
    expect(getClientEvents()).toBe(after);
    unsubscribe();
    recordClientEvent('info', 'app', 'two');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never throws: unknown levels or categories, broken fields and broken subscribers', () => {
    expect(recordClientEvent('fatal' as never, 'api', 'x')).toBeNull();
    expect(recordClientEvent('warn', 'secret' as never, 'x')).toBeNull();
    subscribeClientEvents(() => {
      throw new Error('broken subscriber');
    });
    const fields = Object.defineProperty({ status: 500 }, 'code', {
      enumerable: true,
      get() {
        throw new Error('broken getter');
      },
    });
    const entry = recordClientEvent('warn', 'api', 'still recorded', fields);
    expect(entry?.event.fields).toEqual({ status: 500 });
    expect(messages()).toEqual(['still recorded']);
  });

  it('keeps the message one safe line of at most 200 characters', () => {
    expect(recordClientEvent('info', 'app', 'line one\nline two\ttabbed')?.event.msg).toBe('line one line two tabbed');
    expect(recordClientEvent('info', 'app', 'bell\u0007 rtl\u202E')?.event.msg).toBe('bell\\u0007 rtl\\u202e');
    expect(recordClientEvent('info', 'app', '  ')?.event.msg).toBe('(no message)');
    const long = recordClientEvent('info', 'app', 'x'.repeat(500))?.event.msg ?? '';
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(recordClientEvent('warn', 'app', 'auth failed: Bearer abc.def-123 at C:\\Users\\riley\\x')?.event.msg).toBe(
      'auth failed: Bearer [REDACTED] at C:\\Users\\~\\x',
    );
    expect(recordClientEvent('warn', 'app', 'could not load https://user:pw@example.com/a?token=x#y')?.event.msg).toBe(
      'could not load https://example.com/…',
    );
  });

  it('only records what the server accepts', () => {
    recordClientEvent('warn', 'api', 'request failed', { method: 'GET', path: '/api/feeds?url=https://x', status: 0, errMessage: 'm'.repeat(999) });
    recordClientEvent('error', 'app', 'uncaught error', { errName: 'TypeError', stack: `TypeError: x\n${'    at f (https://h/a.js:1:2)\n'.repeat(20)}` });
    recordClientEvent('debug', 'hybrid', 'probe', { kind: 'reachable', ms: 12, timedOut: false });
    for (const entry of getClientEvents()) expect(ClientEventSchema.safeParse(entry.event).success).toBe(true);
    const batch = { sentAt: new Date().toISOString(), events: pendingUpload(true).map((entry) => entry.event) };
    expect(ClientEventsRequestSchema.safeParse(batch).success).toBe(true);
  });
});

describe('fields', () => {
  it('keeps each category to its allowlist (plus repeats)', () => {
    expect(CLIENT_EVENT_FIELDS).toEqual({
      api: ['method', 'route', 'path', 'status', 'code', 'ms', 'rid', 'transport', 'errName', 'errMessage', 'repeats'],
      widget: ['accountId', 'code', 'status', 'widget', 'repeats'],
      provider: ['provider', 'host', 'status', 'code', 'errName', 'ms', 'repeats'],
      hybrid: ['from', 'to', 'reason', 'kind', 'httpStatus', 'ms', 'timedOut', 'errName', 'permission', 'target', 'attempt', 'graceMs', 'repeats'],
      backend: ['errName', 'attempt', 'op', 'repeats'],
      app: ['errName', 'errMessage', 'source', 'stack', 'repeats'],
    });
    const content = { url: 'https://example.com/x', title: 'Dinner with Ann', body: '{"a":1}', query: 'my search', subject: 'Hi', lat: 52.1 };
    expect(fieldsOf('api', { ...content, method: 'GET', route: '/api/feeds', status: 502, code: 'provider_error', ms: 12, transport: 'server', repeats: 3 })).toEqual({
      method: 'GET',
      route: '/api/feeds',
      status: 502,
      code: 'provider_error',
      ms: 12,
      transport: 'server',
      repeats: 3,
    });
    expect(fieldsOf('widget', { ...content, accountId: 'acc-1', code: 'reauth_required', status: 409, widget: 'mail', host: 'imap.example.com' })).toEqual({
      accountId: 'acc-1',
      code: 'reauth_required',
      status: 409,
      widget: 'mail',
    });
    expect(fieldsOf('provider', { ...content, provider: 'todoist', host: 'api.todoist.com', status: 401, code: 'token_rejected', errName: 'HttpError', ms: 80, filter: 'today' })).toEqual({
      provider: 'todoist',
      host: 'api.todoist.com',
      status: 401,
      code: 'token_rejected',
      errName: 'HttpError',
      ms: 80,
    });
    const hybrid = { from: 'connected', to: 'reconnecting', reason: 'network', kind: 'unreachable', httpStatus: null, ms: 5, timedOut: true, errName: 'TypeError', permission: 'granted', target: 'browser', attempt: 2, graceMs: 30000 };
    expect(fieldsOf('hybrid', { ...content, ...hybrid, token: 'T'.repeat(43) })).toEqual(hybrid);
    expect(fieldsOf('backend', { ...content, errName: 'QuotaExceededError', attempt: 1, op: 'open', stack: 'at x' })).toEqual({ errName: 'QuotaExceededError', attempt: 1, op: 'open' });
    expect(fieldsOf('app', { ...content, errName: 'TypeError', errMessage: 'x is undefined', source: 'window.error', rid: 'abcdefghij' })).toEqual({
      errName: 'TypeError',
      errMessage: 'x is undefined',
      source: 'window.error',
    });
  });

  it('strips query strings from API paths and keeps error messages for 5xx and network failures only', () => {
    expect(fieldsOf('api', { path: '/api/search/suggest?q=private+words#x', route: '/api/search/suggest?q=1' })).toEqual({ path: '/api/search/suggest', route: '/api/search/suggest' });
    expect(fieldsOf('api', { status: 404, code: 'not_found', errMessage: 'Feed not found' })).toEqual({ status: 404, code: 'not_found' });
    expect(fieldsOf('api', { status: 503, errMessage: 'Mail is unavailable' }).errMessage).toBe('Mail is unavailable');
    expect(fieldsOf('api', { status: 0, code: 'network_error', errMessage: 'Portly is not reachable' })).toEqual({ status: 0, code: 'network_error', errMessage: 'Portly is not reachable' });
    const long = fieldsOf('api', { code: 'network_error', errMessage: 'e'.repeat(400) }).errMessage as string;
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('scrubs every value: secrets, URLs past their host, user paths, long strings, non-primitive values', () => {
    const fields = fieldsOf('app', {
      errName: 'Error',
      errMessage: 'GET https://api.example.com/v1/items?access_token=abc123&q=words failed for C:\\Users\\riley\\AppData\\x password=hunter2',
      source: { nested: 'object' },
    });
    expect(fields).toEqual({ errName: 'Error', errMessage: 'GET https://api.example.com/… failed for C:\\Users\\~\\AppData\\x password=[REDACTED]' });
    expect(fieldsOf('provider', { host: 'https://api.todoist.com/rest/v2/tasks?filter=today', code: '4/0AbCdEf-oauth-code' })).toEqual({
      host: 'https://api.todoist.com/…',
      code: '[REDACTED]',
    });
    expect(fieldsOf('provider', { code: 'ECONNREFUSED', errName: 'x'.repeat(400) }).errName).toHaveLength(300);
    expect(fieldsOf('hybrid', { reason: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], ms: Number.NaN, attempt: Number.POSITIVE_INFINITY })).toEqual({
      reason: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      ms: 'NaN',
      attempt: 'Infinity',
    });
    expect(fieldsOf('backend', { errName: Symbol('x'), op: () => 1, attempt: 10n })).toEqual({ attempt: '10' });
    // Not an object: no fields.
    expect(recordClientEvent('warn', 'app', 'x', 'text' as never)?.event.fields).toEqual({});
    // Nothing planted above reached storage.
    const raw = window.localStorage.getItem(KEY) ?? '';
    for (const planted of ['hunter2', 'abc123', 'riley', 'words', '4/0AbCdEf', 'rest/v2', 'filter=today']) expect(raw).not.toContain(planted);
  });

  it('keeps 5 stack frames with file names only, never the header line', () => {
    const v8 = [
      'TypeError: Cannot read properties of undefined (reading \'x\') at C:\\Users\\riley',
      '    at render (https://user.github.io/portly/assets/index-1a2b.js:10:20)',
      '    at https://user.github.io/portly/assets/Widget-3c4d.js?v=1#frag:3:4',
      '    at eval (eval at f (http://127.0.0.1:5757/assets/a.js:1:2), <anonymous>:1:1)',
      '    at file:///C:/Users/riley/dev/main.js:5:6',
      '    at blob:https://user.github.io/0b6d1c2e-uuid:7:8',
      '    at sixth (https://h/x.js:1:1)',
    ].join('\n');
    expect(fieldsOf('app', { stack: v8 }).stack).toEqual([
      'at render (https://user.github.io/…/index-1a2b.js:10:20)',
      'at https://user.github.io/…/Widget-3c4d.js:3:4',
      'at eval (eval at f (http://127.0.0.1:5757/…/a.js:1:2), <anonymous>:1:1)',
      'at file:///…/main.js:5:6',
      'at blob:https://user.github.io/…/0b6d1c2e-uuid:7:8',
    ]);
    const firefox = 'render@https://user.github.io/portly/assets/index.js?x=1:10:20\n@https://user.github.io/portly/assets/main.js:1:2\n';
    expect(fieldsOf('app', { stack: firefox }).stack).toEqual(['render@https://user.github.io/…/index.js:10:20', '@https://user.github.io/…/main.js:1:2']);
    const safari = 'forEach@[native code]\nasync*load@https://user.github.io/portly/assets/a.js:5:6\nglobal code@https://user.github.io/portly/assets/main.js:3:4';
    expect(fieldsOf('app', { stack: safari }).stack).toEqual([
      'forEach@[native code]',
      'async*load@https://user.github.io/…/a.js:5:6',
      'global code@https://user.github.io/…/main.js:3:4',
    ]);
    expect(fieldsOf('app', { errName: 'Error', stack: 'Error: no frames here' })).toEqual({ errName: 'Error' });
    // A header-only stack (Chromium errors made by native code) has no frames, even with an '@' in it.
    expect(fieldsOf('app', { errName: 'TypeError', stack: 'TypeError: Failed to fetch for anne@example.com' })).toEqual({ errName: 'TypeError' });
    expect(fieldsOf('app', { stack: 'QuotaExceededError: The quota has been exceeded.\nkey=portly@x\nlogin user@imap.example.com:993:1' })).toEqual({});
  });
});

describe('storage mirror', () => {
  it('uses one key per build: the Pages build under its base path', () => {
    expect(clientEventsStorageKey()).toBe(KEY);
    expect(clientEventsStorageKey(false, '/portly/')).toBe(KEY);
    expect(clientEventsStorageKey(true, '/portly/')).toBe('portly:diagnostics:events:/portly/');
    expect(clientEventsStorageKey(true)).toBe('portly:diagnostics:events:/');
  });

  it('persists events across page loads, but never debug events', () => {
    recordClientEvent('warn', 'api', 'kept', { status: 500 });
    recordClientEvent('debug', 'hybrid', 'debug only', { kind: 'reachable' });
    recordClientEvent('error', 'app', 'also kept');
    expect(messages()).toEqual(['kept', 'debug only', 'also kept']);
    expect(stored()?.entries.map((entry) => entry.event.msg)).toEqual(['kept', 'also kept']);
    expect(window.localStorage.getItem(KEY)).not.toContain('debug');
    const session = clientSessionId();
    reload();
    expect(messages()).toEqual(['kept', 'also kept']);
    expect(clientSessionId()).not.toBe(session);
    expect(getClientEvents()[0]?.event.session).toBe(session);
  });

  it('drops entries older than 7 days when it reads them', () => {
    vi.useFakeTimers({ now: START });
    recordClientEvent('warn', 'app', 'eight days old');
    vi.setSystemTime(START + 2 * DAY);
    recordClientEvent('warn', 'app', 'six days old');
    vi.setSystemTime(START + 7 * DAY);
    reload();
    expect(messages()).toEqual(['eight days old', 'six days old']);
    vi.setSystemTime(START + 8 * DAY + 1);
    reload();
    expect(messages()).toEqual(['six days old']);
  });

  it('keeps the last 300 events', () => {
    for (let i = 0; i < CLIENT_LOG_SIZE + 10; i++) recordClientEvent('info', 'app', `event ${i}`);
    expect(getClientEvents()).toHaveLength(CLIENT_LOG_SIZE);
    expect(messages()[0]).toBe('event 10');
    expect(stored()?.entries).toHaveLength(CLIENT_LOG_SIZE);
    reload();
    expect(messages().at(-1)).toBe(`event ${CLIENT_LOG_SIZE + 9}`);
  });

  it('stays under 256 KB, dropping the oldest events', () => {
    const big = Object.fromEntries(CLIENT_EVENT_FIELDS.hybrid.filter((key) => key !== 'repeats').map((key) => [key, `${key}-${'v'.repeat(290)}`]));
    for (let i = 0; i < 200; i++) recordClientEvent('warn', 'hybrid', `big ${i}`, big);
    const raw = window.localStorage.getItem(KEY) ?? '';
    expect(raw.length).toBeLessThanOrEqual(CLIENT_LOG_MAX_CHARS);
    const kept = stored()?.entries ?? [];
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(200);
    expect(kept.at(-1)?.event.msg).toBe('big 199');
  });

  it('ignores what it did not write: bad JSON, another version, invalid or debug entries', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(getClientEvents()).toEqual([]);
    resetClientLogForTests();
    window.localStorage.setItem(KEY, JSON.stringify({ v: 2, entries: [] }));
    expect(getClientEvents()).toEqual([]);
    resetClientLogForTests();
    const good = { id: 'abc-1', uploaded: false, event: { t: new Date().toISOString(), level: 'warn', cat: 'app', msg: 'good', fields: {}, session: 'abc', page: { build: 'server', backend: 'server', version: '1' } } };
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          good,
          { ...good, id: 'abc-2', event: { ...good.event, level: 'debug', msg: 'debug' } },
          { ...good, id: 'abc-3', event: { ...good.event, msg: 'extra key', extra: 1 } },
          { ...good, id: 'abc-4', event: { ...good.event, msg: 'bad\nmsg' } },
          { ...good, id: '../x', event: { ...good.event, msg: 'bad id' } },
          { ...good, id: 'abc-5', uploaded: 'yes' },
          { ...good, event: { ...good.event, msg: 'duplicate id' } },
          null,
        ],
      }),
    );
    expect(messages()).toEqual(['good']);
  });

  it('keeps this page load’s last 100 debug events beside the ring: they never push a stored event out', () => {
    vi.useFakeTimers({ now: START });
    const failed = recordClientEvent('warn', 'api', 'request failed', { method: 'GET', status: 0, code: 'network_error' });
    for (let i = 0; i < CLIENT_LOG_SIZE; i++) {
      vi.setSystemTime(START + 1 + i);
      recordClientEvent('debug', 'hybrid', `probe ${i}`, { kind: 'reachable' });
    }
    expect(getClientEvents()).toHaveLength(1 + CLIENT_LOG_DEBUG_SIZE);
    expect(getClientEvents()[0]).toEqual(failed);
    expect(messages()[1]).toBe(`probe ${CLIENT_LOG_SIZE - CLIENT_LOG_DEBUG_SIZE}`);
    expect(messages().at(-1)).toBe(`probe ${CLIENT_LOG_SIZE - 1}`);
    expect(pendingUpload(false)).toEqual([failed]);
    expect(pendingUpload(true)[0]).toEqual(failed);
  });

  it('works without storage, in memory for the page load', () => {
    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      recordClientEvent('warn', 'app', 'one');
      recordClientEvent('warn', 'app', 'two');
      markUploaded([getClientEvents()[0]!.id]);
      expect(getClientEvents().map((entry) => [entry.event.msg, entry.uploaded])).toEqual([
        ['one', true],
        ['two', false],
      ]);
      clearClientEvents();
      expect(getClientEvents()).toEqual([]);
    } finally {
      blocked.mockRestore();
    }
  });

  /** localStorage with a quota: `setItem` throws QuotaExceededError for a value longer than `quota.chars`. */
  function quotaStorage() {
    const items = new Map<string, string>();
    const quota = { chars: Number.POSITIVE_INFINITY };
    const setItem = vi.fn((key: string, value: string) => {
      if (value.length > quota.chars) throw new DOMException('full', 'QuotaExceededError');
      items.set(key, value);
    });
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem, removeItem: (key: string) => void items.delete(key) };
    const spy = vi.spyOn(window, 'localStorage', 'get').mockReturnValue(storage as unknown as Storage);
    const storedMessages = (): string[] =>
      items.has(KEY) ? JSON.parse(items.get(KEY)!).entries.map((entry: { event: { msg: string } }) => entry.event.msg) : [];
    return { items, quota, setItem, spy, storedMessages };
  }

  it('stores the newest events, and their upload marks, when the quota is nearly full', () => {
    const storage = quotaStorage();
    try {
      for (let i = 0; i < 4; i++) recordClientEvent('warn', 'app', `event ${i}`);
      // No room to grow: the mirror may keep its size, no more.
      storage.quota.chars = storage.items.get(KEY)!.length;
      recordClientEvent('warn', 'app', 'event 4');
      expect(messages()).toEqual(['event 0', 'event 1', 'event 2', 'event 3', 'event 4']);
      expect(storage.storedMessages()).toEqual(['event 3', 'event 4']);
      markUploaded(getClientEvents().map((entry) => entry.id));
      expect(getClientEvents().every((entry) => entry.uploaded)).toBe(true);
      storage.quota.chars = Number.POSITIVE_INFINITY;
      reload();
      // The next page load does not send them again.
      expect(messages()).toEqual(['event 3', 'event 4']);
      expect(pendingUpload(true)).toEqual([]);
    } finally {
      storage.spy.mockRestore();
    }
  });

  it('keeps events in memory when not even one fits, until Clear frees the key', () => {
    const storage = quotaStorage();
    try {
      recordClientEvent('warn', 'app', 'stored');
      storage.quota.chars = 0;
      recordClientEvent('warn', 'app', 'memory only');
      recordClientEvent('warn', 'app', 'memory too');
      expect(messages()).toEqual(['stored', 'memory only', 'memory too']);
      // Both events, then the newest alone; after that storage is not tried again in this page load.
      expect(storage.setItem).toHaveBeenCalledTimes(3);
      expect(storage.storedMessages()).toEqual(['stored']);
      // Clear still removes the mirror, and the ring is stored again after it.
      clearClientEvents();
      expect(storage.items.has(KEY)).toBe(false);
      storage.quota.chars = Number.POSITIVE_INFINITY;
      recordClientEvent('warn', 'app', 'after clear');
      expect(storage.storedMessages()).toEqual(['after clear']);
      // The cleared events do not come back with the next page load.
      reload();
      expect(messages()).toEqual(['after clear']);
    } finally {
      storage.spy.mockRestore();
    }
  });
});

describe('other tabs', () => {
  function otherTabEntry(msg: string, id = 'othertab-1') {
    return { id, uploaded: false, event: { t: new Date().toISOString(), level: 'warn', cat: 'hybrid', msg, fields: {}, session: 'othertab', page: { build: 'server', backend: 'server', version: '0.0.0-test' } } };
  }

  function writeAsOtherTab(entries: unknown[] | null): void {
    const oldValue = window.localStorage.getItem(KEY);
    const newValue = entries === null ? null : JSON.stringify({ v: 1, entries });
    if (newValue === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, oldValue, newValue, storageArea: window.localStorage }));
  }

  it('follows their writes and keeps their events when this tab writes', () => {
    vi.useFakeTimers({ now: START });
    const listener = vi.fn();
    subscribeClientEvents(listener);
    const mine = recordClientEvent('warn', 'app', 'mine');
    vi.setSystemTime(START + 1);
    writeAsOtherTab([...(stored()?.entries ?? []), otherTabEntry('theirs')]);
    expect(messages()).toEqual(['mine', 'theirs']);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + 2);
    recordClientEvent('warn', 'app', 'mine again');
    expect(stored()?.entries.map((entry) => entry.event.msg)).toEqual(['mine', 'theirs', 'mine again']);
    // Another tab uploaded this one: it is no longer pending here.
    writeAsOtherTab((stored()?.entries ?? []).map((entry) => (entry.id === mine?.id ? { ...entry, uploaded: true } : entry)));
    expect(listener).toHaveBeenCalledTimes(4);
    expect(pendingUpload(false).map((entry) => entry.event.msg)).toEqual(['theirs', 'mine again']);
    // Unrelated keys are ignored.
    window.dispatchEvent(new StorageEvent('storage', { key: 'portly:query-cache', newValue: 'x' }));
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('validates only the entries it has not read before (another tab adds one, marks some)', () => {
    vi.useFakeTimers({ now: START });
    for (let i = 0; i < 50; i++) recordClientEvent('warn', 'app', `mine ${i}`);
    const before = getClientEvents();
    const parse = vi.spyOn(ClientEventSchema, 'safeParse');
    writeAsOtherTab([...(stored()?.entries ?? []), otherTabEntry('theirs')]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(messages()).toHaveLength(51);
    // The entries already read are the same objects.
    expect(getClientEvents()[0]).toBe(before[0]);

    // Another tab uploaded the first ten: the marks are taken up, nothing is validated again.
    parse.mockClear();
    writeAsOtherTab((stored()?.entries ?? []).map((entry, i) => (i < 10 ? { ...entry, uploaded: true } : entry)));
    expect(parse).not.toHaveBeenCalled();
    expect(getClientEvents().filter((entry) => entry.uploaded)).toHaveLength(10);
    expect(Object.isFrozen(getClientEvents()[0])).toBe(true);
    parse.mockRestore();
  });

  it('follows a clear in another tab, debug events included', () => {
    recordClientEvent('warn', 'app', 'persisted');
    recordClientEvent('debug', 'app', 'debug');
    writeAsOtherTab(null);
    expect(getClientEvents()).toEqual([]);
    recordClientEvent('debug', 'app', 'debug again');
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(getClientEvents()).toEqual([]);
  });
});

describe('upload bookkeeping', () => {
  it('offers what the server should get: not uploaded, server backend, no answered API calls, debug on request', () => {
    vi.useFakeTimers({ now: START });
    const network = recordClientEvent('warn', 'api', 'request failed', { method: 'GET', status: 0, code: 'network_error' });
    vi.setSystemTime(START + 1);
    const answered = recordClientEvent('warn', 'api', 'request failed', { method: 'GET', status: 502, rid: 'abcdefghij' });
    vi.setSystemTime(START + 2);
    const debug = recordClientEvent('debug', 'hybrid', 'probe', { kind: 'reachable' });
    vi.setSystemTime(START + 3);
    const hybrid = recordClientEvent('info', 'hybrid', 'status changed');
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    vi.setSystemTime(START + 4);
    const browser = recordClientEvent('error', 'backend', 'start failed');
    expect(isUploadable(network!.event)).toBe(true);
    expect(isUploadable(answered!.event)).toBe(false);
    expect(isUploadable(browser!.event)).toBe(false);
    expect(pendingUpload(false)).toEqual([network, hybrid]);
    expect(pendingUpload(true)).toEqual([network, debug, hybrid]);
    expect(pendingUpload(true, 2)).toEqual([network, debug]);
  });

  it('marks uploaded events, in storage too', () => {
    const one = recordClientEvent('warn', 'app', 'one');
    const two = recordClientEvent('warn', 'app', 'two');
    const debug = recordClientEvent('debug', 'app', 'debug');
    const listener = vi.fn();
    subscribeClientEvents(listener);
    markUploaded([one!.id, debug!.id, 'unknown-1']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getClientEvents().map((entry) => entry.uploaded)).toEqual([true, false, true]);
    expect(pendingUpload(true)).toEqual([two]);
    markUploaded([one!.id]);
    markUploaded([]);
    expect(listener).toHaveBeenCalledTimes(1);
    reload();
    expect(pendingUpload(true).map((entry) => entry.event.msg)).toEqual(['two']);
    expect(getClientEvents().map((entry) => [entry.event.msg, entry.uploaded])).toEqual([
      ['one', true],
      ['two', false],
    ]);
  });

  it('clears everything, in storage too', () => {
    recordClientEvent('warn', 'app', 'one');
    recordClientEvent('debug', 'app', 'two');
    const listener = vi.fn();
    subscribeClientEvents(listener);
    clearClientEvents();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getClientEvents()).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    reload();
    expect(getClientEvents()).toEqual([]);
  });
});

describe('upload lock', () => {
  /** Web Locks as far as `withUploadLock` uses them (jsdom has none): exclusive, `ifAvailable`. */
  function stubLocks() {
    const held = new Set<string>();
    const request = vi.fn(async (name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: 'exclusive' } as Lock);
      } finally {
        held.delete(name);
      }
    });
    vi.stubGlobal('navigator', { locks: { request } });
    return request;
  }

  it('lets one tab upload at a time: another skips its turn while the lock is held', async () => {
    const request = stubLocks();
    let release!: () => void;
    const first = withUploadLock(() => new Promise<void>((resolve) => (release = resolve)));
    const second = vi.fn(async () => {});
    await expect(withUploadLock(second)).resolves.toBe(false);
    expect(second).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe(true);
    await expect(withUploadLock(second)).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`${KEY}:upload`, { ifAvailable: true }, expect.any(Function));
    // An upload that fails rejects (and frees the lock).
    await expect(withUploadLock(() => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    await expect(withUploadLock(second)).resolves.toBe(true);
  });

  it('just uploads where Web Locks are missing or refused', async () => {
    const upload = vi.fn(async () => {});
    vi.stubGlobal('navigator', {});
    await expect(withUploadLock(upload)).resolves.toBe(true);
    vi.stubGlobal('navigator', { locks: { request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError')) } });
    await expect(withUploadLock(upload)).resolves.toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
