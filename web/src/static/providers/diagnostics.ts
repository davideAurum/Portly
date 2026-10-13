/**
 * Upstream failures of the in-browser backend's providers (Open-Meteo, Wikipedia suggestions,
 * Todoist, Microsoft sign-in, and ESPN through the sports handler's own fetch in
 * `handlers/sports.ts`) as this browser's `provider` events (ARCHITECTURE §17) — the
 * browser-only build's counterpart of the server's outbound log lines: which provider and host,
 * the HTTP status, a machine reason code (the server's health codes where one fits: `timeout`,
 * `network`, `too_large`, `rate_limited`, `not_found`, `http_4xx`, `http_5xx`, `parse_error`,
 * `token_rejected`, or a provider's own registered code such as an OAuth `error`), the error's name
 * and how long it took. Never the request's URL, query, body or token. The same failure within a
 * minute is counted, not recorded again (`recordCollapsedClientEvent`).
 */
import { REASON_TOKEN, type LogLevel } from '@portly/shared';
import { recordCollapsedClientEvent } from '../../api/client.ts';
import { classifyFetchError, UpstreamPayloadTooLargeError } from '../lib/fetch.ts';

export type ProviderName = 'open-meteo' | 'wikipedia' | 'todoist' | 'microsoft' | 'espn';

export interface ProviderFailure {
  /** The provider's HTTP status; null (or absent) when no answer arrived. */
  status?: number | null;
  /** Machine reason code (see the module comment). */
  code: string;
  errName?: string | null;
  /** From the request to the failure. */
  ms?: number | null;
}

/** Records a provider failure (warn unless `level` says otherwise). Never throws. */
export function recordProviderFailure(provider: ProviderName, host: string, failure: ProviderFailure, level: LogLevel = 'warn'): void {
  const status = failure.status ?? null;
  const code = REASON_TOKEN.test(failure.code) ? failure.code : 'error';
  const fields = { provider, host, status, code, errName: failure.errName ?? null, ms: failure.ms === undefined || failure.ms === null ? null : Math.max(0, Math.round(failure.ms)) };
  recordCollapsedClientEvent('provider', `${provider} ${host} ${String(status)} ${code}`, level, 'provider request failed', fields);
}

/** The host of a request URL (all an event keeps of it). */
export function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/** An error's name (`TypeError`, `TimeoutError`…). */
export function errorName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : typeof err;
}

/** The reason code of a request that got no usable answer; null for the caller's own abort (not a failure). */
export function transportFailureCode(err: unknown): 'timeout' | 'too_large' | 'network' | null {
  if (err instanceof UpstreamPayloadTooLargeError) return 'too_large';
  switch (classifyFetchError(err)) {
    case 'aborted':
      return null;
    case 'timeout':
      return 'timeout';
    case 'network':
      // DNS, TLS, CORS or offline: a browser cannot tell them apart.
      return 'network';
  }
}

/** The reason code of a non-2xx answer. */
export function statusFailureCode(status: number): 'rate_limited' | 'not_found' | 'http_4xx' | 'http_5xx' {
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

/** Milliseconds since the call (a request's duration). */
export function stopwatch(now: () => number = () => Date.now()): () => number {
  const started = now();
  return () => now() - started;
}
