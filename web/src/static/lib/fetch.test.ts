import { describe, expect, it, vi } from 'vitest';
import { StaticApiError } from '../respond.ts';
import {
  UpstreamPayloadTooLargeError,
  classifyFetchError,
  fetchTextCapped,
  fetchWithTimeout,
  readTextCapped,
  upstreamFailure,
  withTimeout,
  type FetchLike,
} from './fetch.ts';

/** A transport that never answers but honours the signal (rejects with its reason), like fetch. */
const hanging: FetchLike = (_url, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Answers at once with a body that stays open until the signal aborts. */
const slowBody: FetchLike = (_url, init) => {
  const signal = init?.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('fetchWithTimeout', () => {
  it('resolves with the response and disarms the timer', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<FetchLike>(async () => new Response('ok', { status: 200 }));
      const res = await fetchWithTimeout('https://api.example/x', { headers: { Accept: 'application/json' } }, { timeoutMs: 1000, fetch: transport });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
      const init = transport.mock.calls[0]?.[1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ Accept: 'application/json' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with a TimeoutError when the deadline passes', async () => {
    const err = await rejection(fetchWithTimeout('https://api.example/x', {}, { timeoutMs: 10, fetch: hanging }));
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(classifyFetchError(err)).toBe('timeout');
  });

  it('propagates the caller abort as an AbortError and reports it as aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const err = await rejection(fetchWithTimeout('https://api.example/x', {}, { timeoutMs: 1000, signal: controller.signal, fetch: hanging }));
    expect((err as DOMException).name).toBe('AbortError');
    expect(classifyFetchError(err)).toBe('aborted');
    // The caller's reason object is passed through when it is a DOMException.
    const own = new DOMException('mine', 'AbortError');
    const c2 = new AbortController();
    setTimeout(() => c2.abort(own), 5);
    expect(await rejection(fetchWithTimeout('https://api.example/x', {}, { timeoutMs: 1000, signal: c2.signal, fetch: hanging }))).toBe(own);
  });

  it('does not call the transport when the caller signal is already aborted', async () => {
    const transport = vi.fn<FetchLike>(hanging);
    const err = await rejection(fetchWithTimeout('https://api.example/x', {}, { timeoutMs: 1000, signal: AbortSignal.abort(), fetch: transport }));
    expect((err as DOMException).name).toBe('AbortError');
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes transport errors through unchanged and validates the deadline', async () => {
    const boom = new TypeError('fetch failed');
    expect(await rejection(fetchWithTimeout('https://api.example/x', {}, { timeoutMs: 1000, fetch: () => Promise.reject(boom) }))).toBe(boom);
    expect(await rejection(withTimeout({ timeoutMs: 0 }, async () => 1))).toBeInstanceOf(RangeError);
    expect(await rejection(withTimeout({ timeoutMs: Number.NaN }, async () => 1))).toBeInstanceOf(RangeError);
  });
});

describe('classifyFetchError / upstreamFailure', () => {
  it('maps timeouts to 504, network and payload problems to 502, and rethrows caller aborts', () => {
    const timeout = upstreamFailure(new DOMException('t', 'TimeoutError'), 'the weather service');
    expect(timeout).toBeInstanceOf(StaticApiError);
    expect(timeout).toMatchObject({ code: 'upstream_timeout', message: 'Request to the weather service timed out' });
    expect(timeout.toResponse().status).toBe(504);

    const network = upstreamFailure(new TypeError('Failed to fetch'), 'api.todoist.com');
    expect(network).toMatchObject({ code: 'provider_error', message: 'Could not reach api.todoist.com' });
    expect(network.toResponse().status).toBe(502);

    const other = upstreamFailure(new Error('boom'), 'Wikipedia');
    expect(other).toMatchObject({ code: 'provider_error', message: 'Wikipedia returned an unexpected response' });

    const big = upstreamFailure(new UpstreamPayloadTooLargeError(256), 'the suggestion service');
    expect(big).toMatchObject({ code: 'provider_error', message: 'Response from the suggestion service exceeds 256 bytes' });

    const abort = new DOMException('x', 'AbortError');
    expect(() => upstreamFailure(abort, 'svc')).toThrow(abort);

    const own = new StaticApiError('rate_limited', 'slow down');
    expect(upstreamFailure(own, 'svc')).toBe(own);

    expect(classifyFetchError(null)).toBe('network');
    expect(classifyFetchError('string')).toBe('network');
    expect(classifyFetchError({ name: 'TimeoutError' })).toBe('timeout');
    // AbortSignal.timeout() produces the same TimeoutError name.
    expect(classifyFetchError(AbortSignal.abort(new DOMException('t', 'TimeoutError')).reason)).toBe('timeout');
  });
});

describe('readTextCapped', () => {
  it('reads small bodies, empty bodies and multi-byte text split across chunks', async () => {
    expect(await readTextCapped(new Response('hello'), 10)).toBe('hello');
    expect(await readTextCapped(new Response(null), 10)).toBe('');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.close();
      },
    });
    expect(await readTextCapped(new Response(stream), 10)).toBe('café');
    expect(await readTextCapped(new Response('x'.repeat(10)), 10)).toBe('x'.repeat(10));
  });

  it('throws UpstreamPayloadTooLargeError past the cap and on a too-large Content-Length', async () => {
    const err = await rejection(readTextCapped(new Response('x'.repeat(20)), 10));
    expect(err).toBeInstanceOf(UpstreamPayloadTooLargeError);
    expect(err).toMatchObject({ limit: 10 });

    const declared = new Response('ab', { headers: { 'content-length': '999' } });
    expect(await rejection(readTextCapped(declared, 10))).toBeInstanceOf(UpstreamPayloadTooLargeError);

    // Streams are cancelled, not drained: a never-ending body still fails fast.
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect(await rejection(readTextCapped(new Response(endless), 4096))).toBeInstanceOf(UpstreamPayloadTooLargeError);
    expect(pulls).toBeLessThan(20);
  });
});

describe('fetchTextCapped', () => {
  it('returns status, headers, url and text under one deadline', async () => {
    const transport: FetchLike = async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'x-test': '1' } });
    const result = await fetchTextCapped('https://api.example/x', {}, { timeoutMs: 1000, maxBytes: 1024, fetch: transport });
    expect(result.status).toBe(201);
    expect(result.text).toBe('{"ok":true}');
    expect(result.headers.get('x-test')).toBe('1');
    expect(typeof result.url).toBe('string');
  });

  it('returns non-2xx statuses instead of throwing', async () => {
    const transport: FetchLike = async () => new Response('nope', { status: 429 });
    const result = await fetchTextCapped('https://api.example/x', {}, { timeoutMs: 1000, maxBytes: 1024, fetch: transport });
    expect(result.status).toBe(429);
    expect(result.text).toBe('nope');
  });

  it('times out while the body is still streaming', async () => {
    const err = await rejection(fetchTextCapped('https://api.example/x', {}, { timeoutMs: 10, maxBytes: 1024, fetch: slowBody }));
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(upstreamFailure(err, 'svc')).toMatchObject({ code: 'upstream_timeout' });
  });

  it('caps the body and the caller can abort mid-stream', async () => {
    const big: FetchLike = async () => new Response('y'.repeat(5000));
    const capped = await rejection(fetchTextCapped('https://api.example/x', {}, { timeoutMs: 1000, maxBytes: 100, fetch: big }));
    expect(capped).toBeInstanceOf(UpstreamPayloadTooLargeError);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const aborted = await rejection(fetchTextCapped('https://api.example/x', {}, { timeoutMs: 1000, maxBytes: 1024, signal: controller.signal, fetch: slowBody }));
    expect((aborted as DOMException).name).toBe('AbortError');
    expect(() => upstreamFailure(aborted, 'svc')).toThrow();
  });
});
