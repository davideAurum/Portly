/**
 * Requests the Pages site sends to the Portly server on this PC to find out whether it is there
 * and whether it still accepts this browser (hybrid mode). Whatever answers on the port is
 * untrusted input: answers are validated with the shared schemas, and the server's `appUrl` only
 * survives as a loopback root page (`validateAppUrl`). The published site and the server are
 * updated separately, so the readers drop fields they do not know instead of refusing the answer
 * (`apiVersion` is what says whether the two can work together).
 *
 * Every request is a CORS request with no credentials, no HTTP cache and
 * `targetAddressSpace: 'loopback'` (Local Network Access: the browser asks for the permission when
 * the request reaches the port). The health probe sends no custom header, so it needs no
 * preflight; the pairing check sends the token and `X-Portly`.
 *
 * The `…Detailed` variants also say what the request showed besides its verdict
 * ({@link ProbeDetails}: time, HTTP status, error name), for the controller's diagnostic events
 * (ARCHITECTURE §17). After a failed CORS probe, {@link probeHealthWithoutCors} tells a server
 * that answers without accepting this site from nothing answering at all; it carries nothing (no
 * token, no header, no credentials) and its opaque answer cannot be read.
 */
import {
  HealthResponseSchema,
  PAIRING_TOKEN_HEADER,
  PairingStatusResponseSchema,
  type HealthResponse,
  type PairingStatusResponse,
} from '@portly/shared';
import { z } from 'zod';
import { validateAppUrl } from './urls.ts';

// Tolerant readers of the shared (strict) schemas: a newer server may add optional fields.
const HealthReader = z.object(HealthResponseSchema.shape);
const PairingStatusReader = z.object(PairingStatusResponseSchema.shape);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `RequestInit` plus Local Network Access' `targetAddressSpace` (not in TypeScript's DOM types yet). */
export type LoopbackRequestInit = RequestInit & { targetAddressSpace?: 'loopback' | 'local' | 'public' };

/** What every request to the local server carries besides its own options. */
export const LOOPBACK_REQUEST_INIT: Readonly<LoopbackRequestInit> = Object.freeze({
  mode: 'cors',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  targetAddressSpace: 'loopback',
});

export type HealthProbeResult =
  /** Portly answered; `appUrl` is the validated page URL it reported (null when missing or refused). */
  | { kind: 'ok'; health: HealthResponse; appUrl: string | null }
  /** Nothing answered (connection refused, CORS refused, permission denied: the browser cannot tell them apart). */
  | { kind: 'unreachable' }
  /** Something answered that is not Portly. */
  | { kind: 'not-portly' }
  | { kind: 'aborted' };

/** What a request to the local server showed besides its verdict (diagnostic events only). */
export interface ProbeDetails {
  /** From the request to its answer (body read) or its failure, in ms. */
  ms: number;
  /** HTTP status of the answer; null when none arrived (or it was opaque). */
  httpStatus: number | null;
  /** Name of the error the request (or reading its body) failed with, e.g. `TypeError`; else null. */
  errName: string | null;
}

export interface ProbeOptions {
  fetch: FetchLike;
  signal?: AbortSignal;
  /** Clock for {@link ProbeDetails.ms} (default `Date.now`). */
  now?: () => number;
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError');
}

/** An error's name when it is a plain identifier (`TypeError`, `AbortError`), else `Error`. */
function errorName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}

/** Collects {@link ProbeDetails} while one request runs. */
function detailsRecorder(options: ProbeOptions): { details: ProbeDetails; done(): void; failed(err: unknown): void } {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const details: ProbeDetails = { ms: 0, httpStatus: null, errName: null };
  return {
    details,
    done: () => {
      details.ms = Math.max(0, now() - started);
    },
    failed: (err) => {
      details.errName = errorName(err);
      details.ms = Math.max(0, now() - started);
    },
  };
}

/** {@link probeHealth} and what the request showed. */
export async function probeHealthDetailed(origin: string, options: ProbeOptions): Promise<{ result: HealthProbeResult; details: ProbeDetails }> {
  const { signal } = options;
  const recorder = detailsRecorder(options);
  const finish = (result: HealthProbeResult) => ({ result, details: recorder.details });
  let res: Response;
  try {
    const init: LoopbackRequestInit = { ...LOOPBACK_REQUEST_INIT, method: 'GET', cache: 'no-store', signal };
    res = await options.fetch(`${origin}/api/health`, init);
  } catch (err) {
    recorder.failed(err);
    return finish(isAbort(err, signal) ? { kind: 'aborted' } : { kind: 'unreachable' });
  }
  recorder.details.httpStatus = res.status;
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
    recorder.done();
    return finish({ kind: 'not-portly' });
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    recorder.failed(err);
    return finish(isAbort(err, signal) ? { kind: 'aborted' } : { kind: 'not-portly' });
  }
  recorder.done();
  const health = HealthReader.safeParse(body);
  // A Portly from before hybrid mode omits `app` (and `apiVersion`): it reads as an incompatible Portly.
  if (!health.success || (health.data.app !== undefined && health.data.app !== 'portly')) return finish({ kind: 'not-portly' });
  return finish({ kind: 'ok', health: health.data, appUrl: validateAppUrl(health.data.appUrl) });
}

/** `GET <origin>/api/health`: is Portly there, which one, and which API version does it speak? */
export async function probeHealth(origin: string, options: ProbeOptions): Promise<HealthProbeResult> {
  return (await probeHealthDetailed(origin, options)).result;
}

/**
 * What a `no-cors` health request found: `answers` (an opaque answer arrived: something listens on
 * the port), `unreachable` (it failed like the CORS probe) or `aborted`.
 */
export type NoCorsProbeResult = 'answers' | 'unreachable' | 'aborted';

/**
 * `GET <origin>/api/health` as a `no-cors` request, for after a CORS probe failed: an (opaque)
 * answer shows that something listens on the port but does not accept this site's CORS requests —
 * Portly on this PC without this site as its `PORTLY_PAGES_URL`, or one from before hybrid
 * mode. Only with the local network permission granted (or none in this browser): it must never
 * be the request that shows the permission prompt. It carries nothing — no token, no header, no
 * credentials, no referrer — and nothing of the answer is read.
 */
export async function probeHealthWithoutCors(origin: string, options: ProbeOptions): Promise<{ result: NoCorsProbeResult; details: ProbeDetails }> {
  const { signal } = options;
  const recorder = detailsRecorder(options);
  try {
    const init: LoopbackRequestInit = {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      targetAddressSpace: 'loopback',
      signal,
    };
    await options.fetch(`${origin}/api/health`, init);
    recorder.done();
    return { result: 'answers', details: recorder.details };
  } catch (err) {
    recorder.failed(err);
    return { result: isAbort(err, signal) ? 'aborted' : 'unreachable', details: recorder.details };
  }
}

export type PairingCheckResult =
  | { kind: 'ok'; pairing: PairingStatusResponse }
  /** 401 `pairing_required`: the server no longer accepts this token. */
  | { kind: 'unpaired' }
  /** Network failure or any other answer: nothing is known about the pairing. */
  | { kind: 'error' }
  | { kind: 'aborted' };

/** The headers of every paired request: the CSRF header and the pairing token. */
export function pairedHeaders(token: string, headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  out.set('X-Portly', '1');
  out.set(PAIRING_TOKEN_HEADER, token);
  return out;
}

/** True for a 401 whose body is the `pairing_required` error (reads a clone: `res` stays readable). */
export async function isPairingRequired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === 'pairing_required';
  } catch {
    return false;
  }
}

/** {@link checkPairing} and what the request showed. */
export async function checkPairingDetailed(origin: string, token: string, options: ProbeOptions): Promise<{ result: PairingCheckResult; details: ProbeDetails }> {
  const { signal } = options;
  const recorder = detailsRecorder(options);
  const finish = (result: PairingCheckResult) => ({ result, details: recorder.details });
  try {
    const headers = pairedHeaders(token, { Accept: 'application/json' });
    const init: LoopbackRequestInit = { ...LOOPBACK_REQUEST_INIT, method: 'GET', cache: 'no-store', headers, signal };
    const res = await options.fetch(`${origin}/api/pairing`, init);
    recorder.details.httpStatus = res.status;
    // Only the server's own verdict clears a pairing; any other 401 proves nothing.
    if (await isPairingRequired(res)) {
      recorder.done();
      return finish({ kind: 'unpaired' });
    }
    if (!res.ok) {
      recorder.done();
      return finish({ kind: 'error' });
    }
    const pairing = PairingStatusReader.safeParse(await res.json());
    recorder.done();
    return finish(pairing.success ? { kind: 'ok', pairing: pairing.data } : { kind: 'error' });
  } catch (err) {
    recorder.failed(err);
    return finish(isAbort(err, signal) ? { kind: 'aborted' } : { kind: 'error' });
  }
}

/** `GET <origin>/api/pairing` with the token: does the server still accept this browser? */
export async function checkPairing(origin: string, token: string, options: ProbeOptions): Promise<PairingCheckResult> {
  return (await checkPairingDetailed(origin, token, options)).result;
}
