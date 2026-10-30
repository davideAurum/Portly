/**
 * Connecting this Pages site to Portly on another PC: the main PC, reached through its HTTPS
 * proxy (Tailscale Serve, ARCHITECTURE §20), so that every PC opens the same site. The connect page
 * (`app/RemoteConnectPage.tsx`, `#/connect`) uses this module:
 *
 * 1. {@link checkRemoteServer}: the address the user typed answers as Portly, speaks this site's
 *    API version and takes the request as another PC's (`remote: true`; `false` means the proxy
 *    points at the main port, and nothing here would work).
 * 2. {@link createRemoteConnectClient}: the same requests as the server build's connect screen,
 *    as CORS requests to that address. A browser sends no `SameSite=Strict` cookie cross-site, so
 *    the request's secret comes back in the answer and is sent as `X-Portly-Enroll` while the page
 *    waits (kept in sessionStorage, so a reload in this tab picks the wait up again); the approved
 *    answer carries the device secret, which {@link saveRemoteConnection} keeps as this browser's
 *    pairing record (with the address). The next page load then starts on that server
 *    (`boot.ts`), with what only the main PC can do turned off.
 *
 * Whatever the address answers is untrusted input: every answer is read with the shared schemas,
 * and secrets are never logged.
 */
import {
  DEVICE_ENROLL_HEADER,
  DeviceNameSuggestionResponseSchema,
  DeviceRequestCreateResponseSchema,
  DeviceRequestStatusResponseSchema,
  DeviceSecretSchema,
  DeviceSelfSchema,
  PORTLY_API_VERSION,
  isErrorCode,
  type DeviceRequestCreateResponse,
  type DeviceRequestStatusResponse,
} from '@portly/shared';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { createPairingStore, readItem, removeItem, saveRemoteConnection, writeItem, type StorageLike } from './pairing.ts';
import { REMOTE_REQUEST_INIT, probeHealth, type FetchLike, type LoopbackRequestInit } from './probe.ts';

// Tolerant readers: a newer server may add optional fields.
const CreateReader = z.object(DeviceRequestCreateResponseSchema.shape);
const StatusReader = z.object({ ...DeviceRequestStatusResponseSchema.shape, device: z.object(DeviceSelfSchema.shape).nullable() });
const SuggestionReader = z.object(DeviceNameSuggestionResponseSchema.shape);
const PendingReader = z.object({ origin: z.string(), secret: DeviceSecretSchema });

/** sessionStorage: the request this tab is waiting on (`{origin, secret}`), so a reload picks it up. */
export const REMOTE_ENROLL_KEY = 'portly:remote-enroll';

/** localStorage key of the last address this browser connected to (prefills the form; not a secret). */
export function remoteAddressKey(base: string = import.meta.env.BASE_URL): string {
  return `portly:remote-address:${base}`;
}

export type RemoteCheckResult =
  /** Portly on another PC answered, as another PC's request. */
  | { kind: 'ok'; instanceId: string; version: string }
  /** Nothing answered this site: offline, Tailscale not running, a wrong address, the browser's permission, or a server that does not take this site. */
  | { kind: 'unreachable' }
  /** Something answered that is not Portly. */
  | { kind: 'not-portly' }
  /** Portly, but another API version (or too old to say which instance it is). */
  | { kind: 'incompatible' }
  /** Portly took the request as its own PC's: the proxy points at its main port. */
  | { kind: 'not-remote' };

/** Step 1: does `origin` answer as Portly on another PC that this site can use? */
export async function checkRemoteServer(origin: string, options: { fetch: FetchLike; signal?: AbortSignal }): Promise<RemoteCheckResult> {
  const result = await probeHealth(origin, { fetch: options.fetch, signal: options.signal, remote: true });
  if (result.kind === 'aborted') throw new DOMException('The operation was aborted.', 'AbortError');
  if (result.kind !== 'ok') return { kind: result.kind };
  const { health } = result;
  if (health.apiVersion !== PORTLY_API_VERSION || health.instanceId === undefined) return { kind: 'incompatible' };
  if (health.remote !== true) return { kind: 'not-remote' };
  return { kind: 'ok', instanceId: health.instanceId, version: health.version };
}

/** What the connect screen (`app/ConnectPage.tsx`) calls: the server build's own requests, or these. */
export interface ConnectClient {
  /** The state of this browser's request, or null when there is none. */
  status(signal?: AbortSignal): Promise<DeviceRequestStatusResponse | null>;
  create(label: string, signal?: AbortSignal): Promise<DeviceRequestCreateResponse>;
  /** The name to fill in (the PC's computer name, when the main PC can tell), or null. */
  suggestion(signal?: AbortSignal): Promise<string | null>;
}

export interface RemoteConnectEnv {
  origin: string;
  /** The server `checkRemoteServer` found (the record names it). */
  instanceId: string;
  fetch: FetchLike;
  local: StorageLike | null;
  session: StorageLike | null;
  now(): number;
  base?: string;
}

/** The answer's error as an {@link ApiError} (the connect screen's messages read its code). */
async function errorOf(res: Response): Promise<ApiError> {
  let code: unknown;
  let message = `Portly answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    code = body?.error?.code;
    if (typeof body?.error?.message === 'string') message = body.error.message.slice(0, 300);
  } catch {
    // Not a Portly error body.
  }
  return new ApiError(res.status, isErrorCode(code) ? code : 'internal', message);
}

/** Step 2: the connect screen's requests, against Portly on another PC. */
export function createRemoteConnectClient(env: RemoteConnectEnv): ConnectClient {
  const call = async (path: string, init: { method?: string; body?: unknown; enroll?: string; signal?: AbortSignal }): Promise<Response> => {
    const headers = new Headers({ 'X-Portly': '1', Accept: 'application/json' });
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    if (init.enroll !== undefined) headers.set(DEVICE_ENROLL_HEADER, init.enroll);
    const request: LoopbackRequestInit = {
      ...REMOTE_REQUEST_INIT,
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    };
    try {
      return await env.fetch(`${env.origin}${path}`, request);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network_error', 'Portly on your main PC could not be reached.');
    }
  };

  const pending = (): string | null => {
    const raw = readItem(env.session, REMOTE_ENROLL_KEY);
    if (raw === null) return null;
    try {
      const value = PendingReader.parse(JSON.parse(raw));
      return value.origin === env.origin ? value.secret : null;
    } catch {
      return null;
    }
  };
  const forget = (): void => removeItem(env.session, REMOTE_ENROLL_KEY);

  return {
    async status(signal) {
      const secret = pending();
      if (secret === null) return null;
      const res = await call('/api/devices/requests/current', { enroll: secret, signal });
      if (res.status === 404) {
        forget();
        return null;
      }
      if (!res.ok) throw await errorOf(res);
      const answer = StatusReader.parse(await res.json());
      if (answer.status === 'pending') return answer;
      forget();
      if (answer.status !== 'approved') return answer;
      const device = DeviceSecretSchema.safeParse(answer.secret);
      if (!device.success) throw new ApiError(res.status, 'internal', 'Portly on your main PC approved this browser but sent no login for it. Update Portly there, then ask again.');
      const store = createPairingStore(env.local, env.base);
      if (!saveRemoteConnection(store, { origin: env.origin, secret: device.data, instanceId: env.instanceId }, env.now())) {
        throw new ApiError(0, 'internal', 'This browser could not save the connection (its site data may be blocked). Allow this site to keep data, then ask again.');
      }
      writeItem(env.local, remoteAddressKey(env.base), env.origin);
      return answer;
    },
    async create(label, signal) {
      const res = await call('/api/devices/requests', { method: 'POST', body: { label }, signal });
      if (!res.ok) throw await errorOf(res);
      const created = CreateReader.parse(await res.json());
      const secret = DeviceSecretSchema.safeParse(created.secret);
      if (!secret.success) throw new ApiError(res.status, 'internal', 'Portly on your main PC is too old to connect from this site. Update it, then try again.');
      if (!writeItem(env.session, REMOTE_ENROLL_KEY, JSON.stringify({ origin: env.origin, secret: secret.data }))) {
        throw new ApiError(0, 'internal', 'This browser could not keep the request (its site data may be blocked). Allow this site to keep data, then try again.');
      }
      return created;
    },
    async suggestion(signal) {
      try {
        const res = await call('/api/devices/requests/suggestion', { signal });
        if (!res.ok) return null;
        return SuggestionReader.parse(await res.json()).label;
      } catch {
        return null;
      }
    },
  };
}
