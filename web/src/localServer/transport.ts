/**
 * Where the Pages build's API calls go (`api/client.ts` imports this module dynamically, so none
 * of it reaches the server build's bundle). This page load's backend decides:
 *
 * - `browser`: the in-browser backend (`static/backend.ts`), as in the browser-only build;
 * - `server` (hybrid mode): the Portly server on this PC. A request first waits until the
 *   controller is connected (`whenServerReady`: through a reconnect, or until the permission prompt
 *   is answered), then goes to `<LOCAL_SERVER_ORIGIN><path>` as a CORS request without credentials
 *   that carries `X-Portly` and the pairing token. It has no timeout of its own (the server has its upstream
 *   ones). Every response tells the controller the server is alive; a network `TypeError` makes it
 *   probe; a 401 `pairing_required` means the pairing was revoked. The in-browser pre-import
 *   backups (`/api/backups*`) do not exist on this backend: they answer 404 without a request.
 *
 * `api()` maps a failure to `network_error` like any other; aborts and `ServerModeEndedError` (the
 * page is switching to the browser) are never reported to the controller.
 */
import { getCapabilities } from '../capabilities.ts';
import { LOCAL_SERVER_ORIGIN } from './config.ts';
import { ServerModeEndedError, getAppLocalServerController, type HybridController } from './controller.ts';
import { LOOPBACK_REQUEST_INIT, isPairingRequired, pairedHeaders, type FetchLike, type LoopbackRequestInit } from './probe.ts';

/** `/api/backups`, `/api/backups/<id>` (with any query): the browser backend's own backups. */
const BACKUPS_PATH = /^\/api\/backups(?:[/?]|$)/;

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface ServerTransportDeps {
  /** Origin of the Portly server on this PC. */
  origin: string;
  fetch: FetchLike;
  /** The page's controller (null: hybrid mode is not running, so there is no server to call). */
  controller(): HybridController | null;
}

/** `fetch` for a server-backend page: `path` is an app API path such as `/api/settings`. */
export function createServerFetch(deps: ServerTransportDeps): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init = {}) => {
    if (BACKUPS_PATH.test(path)) return notFound();
    const controller = deps.controller();
    if (controller === null) throw new ServerModeEndedError('Portly on this PC is not set up for this page');
    await controller.whenServerReady(init.signal);
    const token = controller.token();
    if (token === null) throw new ServerModeEndedError();
    // `X-Portly` as on every API call (the image cache calls this directly), plus the token.
    const request: LoopbackRequestInit = { ...init, ...LOOPBACK_REQUEST_INIT, headers: pairedHeaders(token, init.headers) };
    let res: Response;
    try {
      res = await deps.fetch(`${deps.origin}${path}`, request);
    } catch (err) {
      // Only a failed fetch says something about the server; a cancelled request does not.
      if (err instanceof TypeError && !(err instanceof ServerModeEndedError) && !isAbortError(err)) controller.reportNetworkFailure();
      throw err;
    }
    controller.reportResponse();
    if (await isPairingRequired(res)) controller.reportUnpaired(token);
    return res;
  };
}

const serverFetch = createServerFetch({
  origin: LOCAL_SERVER_ORIGIN,
  fetch: (input, init) => fetch(input, init),
  controller: getAppLocalServerController,
});

/** The server backend's `fetch` (the server image cache uses it too). */
export function localServerFetch(path: string, init?: RequestInit): Promise<Response> {
  return serverFetch(path, init);
}

/** What `api()` calls in the Pages build: this page load's backend answers `path`. */
export async function pagesFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (getCapabilities().backend === 'server') return serverFetch(path, init);
  // Dynamic: a server-backend page never loads (or opens) the in-browser backend.
  return (await import('../static/backend.ts')).staticFetch(path, init);
}
