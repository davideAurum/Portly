/**
 * Outbound fetch helpers for the static backend's provider calls (Open-Meteo, Wikipedia,
 * Todoist), standing in for the server's safe-fetch transport layer:
 *
 * - {@link fetchWithTimeout} runs `fetch` under a deadline AND the caller's `AbortSignal`,
 *   combined by hand (`AbortSignal.any` is missing in some runtimes). A deadline rejects with a
 *   `TimeoutError` DOMException, a caller abort with the caller's own `AbortError`.
 * - {@link readTextCapped} reads a body as UTF-8 text and aborts past `maxBytes`
 *   ({@link UpstreamPayloadTooLargeError}), since the browser cannot cap a response up front.
 * - {@link fetchTextCapped} does both under one deadline covering headers and body.
 * - {@link classifyFetchError} / {@link upstreamFailure} map transport failures to the server's
 *   API errors: timeout → `504 upstream_timeout`, network/CORS `TypeError` and oversized bodies →
 *   `502 provider_error`, while the caller's own abort is rethrown so the API client can ignore
 *   it. A handler must never let a raw `TypeError` escape: the client would show "Portly is not
 *   reachable" (`network_error`).
 */
import { StaticApiError } from '../respond.ts';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TimeoutOptions {
  /** Deadline for the whole operation in ms (> 0). */
  timeoutMs: number;
  /** The caller's signal (the API client's); its abort is propagated and rethrown as-is. */
  signal?: AbortSignal | null;
  /** Transport (default `globalThis.fetch`); injectable for tests. */
  fetch?: FetchLike;
}

export interface FetchTextOptions extends TimeoutOptions {
  /** Largest body accepted, in bytes. */
  maxBytes: number;
}

export interface FetchedText {
  status: number;
  headers: Headers;
  /** Final URL after redirects (empty for synthetic responses). */
  url: string;
  text: string;
}

export type FetchFailureKind = 'aborted' | 'timeout' | 'network';

/** Thrown by {@link readTextCapped} when a body exceeds its cap (→ `502 provider_error`). */
export class UpstreamPayloadTooLargeError extends Error {
  override name = 'UpstreamPayloadTooLargeError';
  readonly limit: number;
  constructor(limit: number) {
    super(`Response exceeds ${limit} bytes`);
    this.limit = limit;
  }
}

function abortError(reason: unknown): DOMException {
  if (reason instanceof DOMException) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function timeoutError(timeoutMs: number): DOMException {
  return new DOMException(`Request timed out after ${timeoutMs} ms`, 'TimeoutError');
}

/**
 * Runs `operation` with a signal that aborts on the caller's signal or after `timeoutMs`. Errors
 * are normalized so {@link classifyFetchError} can tell the deadline from the caller's abort even
 * when the transport reported a generic AbortError.
 */
export async function withTimeout<T>(options: TimeoutOptions, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const { timeoutMs, signal: caller } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError(`timeoutMs must be a positive number (got ${timeoutMs})`);
  if (caller?.aborted) throw abortError(caller.reason);

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(caller?.reason);
  caller?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError(timeoutMs));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (timedOut) throw timeoutError(timeoutMs);
    if (caller?.aborted) throw abortError(caller.reason);
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onAbort);
  }
}

/** `fetch` under a deadline (headers only; use {@link fetchTextCapped} to cover the body too). */
export function fetchWithTimeout(url: string | URL, init: RequestInit = {}, options: TimeoutOptions): Promise<Response> {
  const transport = options.fetch ?? globalThis.fetch;
  return withTimeout(options, (signal) => transport(url, { ...init, signal }));
}

/**
 * Reads the body as UTF-8 text, aborting the stream as soon as more than `maxBytes` arrived
 * (also refused up front when `Content-Length` says so). An aborted request rejects with the
 * signal's reason, as `fetch` itself would.
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBytesCapped(res, maxBytes));
}

/** Like {@link readTextCapped}, for bytes (images, files whose text is checked later). */
export async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamPayloadTooLargeError(maxBytes);
  }
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamPayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches and reads a text body under one deadline; non-2xx statuses are returned, not thrown. */
export function fetchTextCapped(url: string | URL, init: RequestInit = {}, options: FetchTextOptions): Promise<FetchedText> {
  const transport = options.fetch ?? globalThis.fetch;
  return withTimeout(options, async (signal) => {
    const res = await transport(url, { ...init, signal });
    const text = await readTextCapped(res, options.maxBytes);
    return { status: res.status, headers: res.headers, url: res.url, text };
  });
}

function errorName(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : undefined;
}

/** Deadline → 'timeout', the caller's abort → 'aborted', everything else (CORS, DNS, TLS…) → 'network'. */
export function classifyFetchError(err: unknown): FetchFailureKind {
  const name = errorName(err);
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  return 'network';
}

/**
 * The API error for a failed provider call, or rethrows the caller's own abort. `serviceLabel`
 * names the service in the message ("the weather service", "api.todoist.com"). A `StaticApiError`
 * passes through unchanged, so a handler can wrap its whole upstream call in one `catch`.
 */
export function upstreamFailure(err: unknown, serviceLabel: string): StaticApiError {
  if (err instanceof StaticApiError) return err;
  if (err instanceof UpstreamPayloadTooLargeError) {
    return new StaticApiError('provider_error', `Response from ${serviceLabel} exceeds ${err.limit} bytes`);
  }
  switch (classifyFetchError(err)) {
    case 'aborted':
      throw err;
    case 'timeout':
      return new StaticApiError('upstream_timeout', `Request to ${serviceLabel} timed out`);
    case 'network':
      return err instanceof TypeError
        ? new StaticApiError('provider_error', `Could not reach ${serviceLabel}`)
        : new StaticApiError('provider_error', `${serviceLabel} returned an unexpected response`);
  }
}
