/**
 * The upload of this browser's diagnostic events to the server: every 15 s and when the tab is
 * hidden, one at a time, under the upload lock; only uploadable events (server backend, not an API
 * event the server answered), debug ones only while the server accepts them; marked uploaded after
 * a 2xx only (only those taken when the server's limit dropped some); paced under the server's
 * per-minute limits by every tab together; stopped by the answers that mean "no diagnostics here",
 * events another version refuses dropped, and retried after the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientEventsRequestSchema, type ClientEventsRequest, type ClientEventsResponse } from '@portly/shared';
import { ApiError } from '../api/client.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { getClientEvents, recordClientEvent } from './clientLog.ts';
import {
  DEBUG_ASK_INTERVAL_MS,
  UPLOAD_BYTES_PER_MINUTE,
  UPLOAD_INTERVAL_MS,
  UPLOAD_TIMEOUT_MS,
  startClientEventUpload,
  uploadPacingKey,
  type ClientEventUpload,
  type ClientEventUploadDeps,
} from './upload.ts';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

type Post = (body: ClientEventsRequest, signal?: AbortSignal) => Promise<ClientEventsResponse>;

function answer(acceptDebug = false): Post {
  return async (body) => ({ accepted: body.events.length, dropped: 0, acceptDebug });
}

/** A document whose visibility the test sets. */
function fakeDocument() {
  const target = new EventTarget();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    hide() {
      doc.visibilityState = 'hidden';
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
  return doc;
}

/** Every upload a test started (several: tabs of one site). */
let uploads: ClientEventUpload[] = [];

function start(post: Post, deps: Partial<ClientEventUploadDeps> = {}) {
  const spy = vi.fn(post);
  const doc = fakeDocument();
  const signals: (number | undefined)[] = [];
  const upload = startClientEventUpload({
    post: spy,
    document: doc as unknown as ClientEventUploadDeps['document'],
    timeoutSignal: (ms) => {
      signals.push(ms);
      return new AbortController().signal;
    },
    ...deps,
  });
  uploads.push(upload);
  return { post: spy, doc, signals, upload };
}

const record = (n: number, level: 'info' | 'warn' | 'debug' = 'warn') => {
  for (let i = 0; i < n; i++) recordClientEvent(level, 'hybrid', `event ${i}`, { reason: 'test' });
};
const uploadedCount = () => getClientEvents().filter((entry) => entry.uploaded).length;
const uploadedMessages = () => getClientEvents().filter((entry) => entry.uploaded).map((entry) => entry.event.msg);
const sentSizes = (...posts: { mock: { calls: [ClientEventsRequest, AbortSignal?][] } }[]) => posts.flatMap((post) => post.mock.calls.map(([body]) => body.events.length));

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  for (const upload of uploads) upload.stop();
  uploads = [];
  vi.useRealTimers();
});

describe('client event upload', () => {
  it('sends the pending events every 15 s with sentAt, then marks them uploaded', async () => {
    record(2);
    const { post, signals } = start(answer());
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS - 1);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(1);
    const [body, signal] = post.mock.calls[0]!;
    // Exactly the contract (strict): the events, not the log's entries.
    expect(ClientEventsRequestSchema.safeParse(body).success).toBe(true);
    expect(body.sentAt).toBe(new Date(T0 + UPLOAD_INTERVAL_MS).toISOString());
    expect(body.events.map((event) => event.msg)).toEqual(['event 0', 'event 1']);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signals).toEqual([UPLOAD_TIMEOUT_MS]);
    expect(uploadedCount()).toBe(2);
    // Nothing new: no request.
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('uploads when the tab is hidden', async () => {
    record(1);
    const { post, doc } = start(answer());
    doc.hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('runs one upload at a time (a tick while one is on its way is skipped)', async () => {
    record(1);
    let release: () => void = () => {};
    const { post, upload: handle } = start(
      (body) =>
        new Promise((resolve) => {
          release = () => resolve({ accepted: body.events.length, dropped: 0, acceptDebug: false });
        }),
    );
    void handle.flush();
    await vi.advanceTimersByTimeAsync(3 * UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
    expect(uploadedCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploadedCount()).toBe(1);
  });

  it('never sends what the server already has or must not get', async () => {
    recordClientEvent('info', 'api', 'API request refused', { method: 'GET', path: '/api/x', status: 409, code: 'conflict', rid: 'abcdefghij' });
    recordClientEvent('warn', 'api', 'API request got no answer', { method: 'GET', path: '/api/x', status: 0, code: 'network_error' });
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    recordClientEvent('warn', 'hybrid', 'recorded on the browser backend');
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const { post, upload: handle } = start(answer());
    await handle.flush();
    expect(post.mock.calls[0]![0].events.map((event) => event.msg)).toEqual(['API request got no answer']);
  });

  it('keeps events after a failed upload and sends them again at the next tick', async () => {
    record(1);
    let fail = true;
    const { post, upload: handle } = start(async (body) => {
      if (fail) throw new ApiError(0, 'network_error', 'Portly is not reachable');
      return { accepted: body.events.length, dropped: 0, acceptDebug: false };
    });
    await handle.flush();
    expect(uploadedCount()).toBe(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(2);
    expect(uploadedCount()).toBe(1);
    expect(handle.stopped).toBe(false);
  });

  it.each([
    [400, 'bad_request'],
    [403, 'local_only'],
    [404, 'not_found'],
    [409, 'conflict'],
    // Naming no event: the request as a whole is refused.
    [422, 'validation_failed'],
  ] as const)('stops for this page load on %i', async (status, code) => {
    record(1);
    const { post, upload: handle } = start(async () => {
      throw new ApiError(status, code, 'x');
    });
    await handle.flush();
    expect(handle.stopped).toBe(true);
    record(1);
    await vi.advanceTimersByTimeAsync(5 * UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('drops the events a 422 names (another version refuses them); the others go at the next tick', async () => {
    record(3);
    let refuse = true;
    const { post, upload: handle } = start(async (body) => {
      if (!refuse) return { accepted: body.events.length, dropped: 0, acceptDebug: false };
      refuse = false;
      throw new ApiError(422, 'validation_failed', 'Invalid request body', [{ path: 'events.1.fields.reason', message: 'Invalid input', code: 'custom' }]);
    });
    await handle.flush();
    expect(handle.stopped).toBe(false);
    expect(uploadedMessages()).toEqual(['event 1']);
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post.mock.calls[1]![0].events.map((event) => event.msg)).toEqual(['event 0', 'event 2']);
    expect(uploadedCount()).toBe(3);
  });

  it('keeps trying after a 5xx or 429', async () => {
    record(1);
    const { post, upload: handle } = start(async () => {
      throw new ApiError(503, 'internal', 'x');
    });
    await handle.flush();
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(2);
    expect(handle.stopped).toBe(false);
  });

  it('a 2xx whose answer is not the expected one still took the events', async () => {
    record(1);
    const { upload: handle } = start(async () => {
      throw new SyntaxError('Unexpected token');
    });
    await handle.flush();
    expect(uploadedCount()).toBe(1);
  });

  it('sends debug events only while the server accepts them, asking once a minute', async () => {
    record(3, 'debug');
    let accept = false;
    // As the server answers: debug events it does not want are dropped (never in its log).
    const { post, upload: handle } = start(async (body) => {
      const debug = body.events.filter((event) => event.level === 'debug').length;
      return accept ? { accepted: body.events.length, dropped: 0, acceptDebug: true } : { accepted: body.events.length - debug, dropped: debug, acceptDebug: false };
    });
    const sent = (call: number) => post.mock.calls[call]![0].events.map((event) => event.msg);
    await handle.flush();
    // Only one goes along, to ask; dropped, it stays unsent (This browser must not say "Sent").
    expect(sent(0)).toEqual(['event 0']);
    expect(uploadedCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEBUG_ASK_INTERVAL_MS - UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
    accept = true;
    // A minute later the same one asks again, and is taken this time.
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(sent(1)).toEqual(['event 0']);
    expect(uploadedMessages()).toEqual(['event 0']);
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    // Accepted now: the rest goes at once.
    expect(post).toHaveBeenCalledTimes(3);
    expect(sent(2)).toEqual(['event 1', 'event 2']);
    expect(getClientEvents().every((entry) => entry.uploaded)).toBe(true);
  });

  it.each([
    ['in the shared record', undefined],
    ['in its own record (no storage)', null],
  ] as const)('paces a backlog under 120 events a minute (%s)', async (_where, storage) => {
    record(260);
    const { post, upload: handle } = start(answer(), { storage });
    await handle.flush();
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS * 3);
    expect(post.mock.calls.map(([body]) => body.events.length)).toEqual([100, 20]);
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post.mock.calls.map(([body]) => body.events.length)).toEqual([100, 20, 100]);
  });

  it('shares the budget with the other tabs of this site', async () => {
    record(260);
    const a = start(answer());
    const b = start(answer());
    await a.upload.flush();
    await b.upload.flush();
    expect(sentSizes(a.post, b.post)).toEqual([100, 20]);
    expect(localStorage.getItem(uploadPacingKey())).not.toBeNull();
    // A record it cannot read is none.
    localStorage.setItem(uploadPacingKey(), '{"v":1,"sent":"junk"}');
    a.upload.stop();
    b.upload.stop();
    const c = start(answer(), { storage: localStorage });
    await c.upload.flush();
    expect(sentSizes(c.post)).toEqual([100]);
  });

  it("paces the bytes of the events' fields too (64 KB a minute)", async () => {
    const big = Object.fromEntries(['from', 'to', 'reason', 'kind', 'errName', 'permission', 'target'].map((key) => [key, key[0]!.repeat(300)]));
    for (let i = 0; i < 40; i++) recordClientEvent('warn', 'hybrid', `big ${i}`, big);
    const size = new TextEncoder().encode(JSON.stringify(getClientEvents()[0]!.event.fields)).length;
    const fit = Math.floor(UPLOAD_BYTES_PER_MINUTE / size);
    expect(fit).toBeLessThan(40);
    const { post, upload: handle } = start(answer());
    await handle.flush();
    await vi.advanceTimersByTimeAsync(3 * UPLOAD_INTERVAL_MS);
    expect(sentSizes(post)).toEqual([fit]);
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(sentSizes(post)).toEqual([fit, 40 - fit]);
  });

  it("when the server's limit dropped some, marks only those it took and waits a minute", async () => {
    record(100);
    let first = true;
    const { post, upload: handle } = start(async (body) => {
      if (!first) return { accepted: body.events.length, dropped: 0, acceptDebug: false };
      first = false;
      return { accepted: 30, dropped: body.events.length - 30, acceptDebug: false };
    });
    await handle.flush();
    expect(uploadedMessages()).toEqual(Array.from({ length: 30 }, (_, i) => `event ${i}`));
    await vi.advanceTimersByTimeAsync(3 * UPLOAD_INTERVAL_MS);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPLOAD_INTERVAL_MS);
    expect(post.mock.calls[1]![0].events.map((event) => event.msg)[0]).toBe('event 30');
    expect(uploadedCount()).toBe(100);
  });

  it('skips an upload while another tab holds the lock', async () => {
    record(1);
    vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, _options: unknown, fn: (lock: unknown) => Promise<unknown>) => fn(null) } });
    const { post, upload: handle } = start(answer());
    await handle.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends nothing from a page load on the browser backend', async () => {
    record(1);
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { post, upload: handle } = start(answer());
    await handle.flush();
    expect(post).not.toHaveBeenCalled();
    expect(handle.stopped).toBe(true);
  });

  it('stop() ends the timer and the visibility listener', async () => {
    record(1);
    const { post, doc, upload: handle } = start(answer());
    handle.stop();
    doc.hide();
    await vi.advanceTimersByTimeAsync(5 * UPLOAD_INTERVAL_MS);
    expect(post).not.toHaveBeenCalled();
  });
});
