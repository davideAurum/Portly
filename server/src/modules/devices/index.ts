/**
 * Devices module (other PCs, shared/src/devices.ts): lets a PC on the remote origin
 * (`PORTLY_REMOTE_ORIGIN`, an HTTPS reverse proxy on this PC) ask to be connected, lets this PC
 * approve or deny it, and manages the connected devices. The gate (security/gate.ts) has already
 * classified the request (`remoteClient`) and verified a device cookie (`deviceId`).
 *
 * Routes and responses:
 * - `POST /api/devices/requests {label}` [enrollment] → 201 `DeviceRequestCreateResponse` and the
 *   enrollment cookie (`__Host-portly_enroll`; it outlives the request's 10 minutes by the hour the
 *   request is retained, so the last poll can still say expired). Only from the remote origin (409
 *   `not_configured` without one, 409 `conflict` from this PC's own page); 429 `rate_limited`
 *   while 3 requests wait.
 * - `GET /api/devices/requests/suggestion` [enrollment] → `DeviceNameSuggestionResponse`: the name
 *   the connect screen fills in, from the last `X-Forwarded-For` entry (the sender's tailnet address as
 *   the proxy itself added it; Tailscale Serve replaces a forged header) through `ctx.peerNames` (lib/peer-names.ts:
 *   `tailscale whois` on this PC); `{label: null}` from this PC's own page, without the header, or
 *   when Tailscale cannot say. A convenience only: the other PC may change it, the approval stays the login.
 * - `GET /api/devices/requests/current` [enrollment] → `DeviceRequestStatusResponse` for the
 *   enrollment cookie: `pending` (keep polling), `approved` (the device cookie
 *   `__Host-portly_device`, 30 days, is set and the enrollment cookie cleared; asked again before
 *   the device's first use, the same device gets a fresh cookie, in case the answer was lost),
 *   `denied` or `expired` (the enrollment cookie cleared); 404 without a cookie or for one this
 *   server does not know.
 * - `GET /api/devices` [paired] → `DevicesResponse` (the remote origin, the connected devices with
 *   `current` for the caller's own, the requests waiting).
 * - `POST /api/devices/requests/:id/approve` → `{approved: true}` (this PC's own page only: the
 *   trust starts here; 404 unless pending and unexpired). The device is made when the other PC polls.
 * - `POST /api/devices/requests/:id/deny` → 204 (this PC's own page only; 404 unless pending).
 * - `DELETE /api/devices/:id` [same-pc] → 204 (the device's cookie stops working at once), or 404.
 *   Other PCs are managed from this PC (its own page or the paired Pages site), never from
 *   another PC; a device may only disconnect itself (`DELETE /api/device`).
 * - `GET /api/device` [paired] → `DeviceStatusResponse` for the device the gate verified (a request
 *   the gate attributed to no device, such as a local one with a stray cookie → 409 `not_configured`).
 * - `DELETE /api/device` [paired] → 204: the presenting device disconnects itself (cookie cleared).
 *
 * The Pages site opened on another PC (`remotePages`, set by the gate) calls the same routes as
 * CORS requests, where a browser sends no `SameSite=Strict` cookie: it gets the request's secret in
 * the create answer's `secret` and sends it as `X-Portly-Enroll` while it polls; the approved poll
 * answers with the device secret in `secret`, which it then sends as `X-Portly-Device`. No cookie
 * is set or cleared for it.
 *
 * Logs `info` lines with request and device ids only (`device request created {deviceRequestId}`,
 * `device request approved|denied {deviceRequestId}`, `device removed {deviceId, by}`; the store
 * logs `device connected`): never a label, a code or a cookie (§17).
 */
import type { Context, Hono } from 'hono';
import {
  DEVICE_COOKIE,
  DEVICE_ENROLL_HEADER,
  DEVICE_IDLE_TTL_MS,
  DEVICE_REQUEST_TTL_MS,
  DEVICE_TOKEN_HEADER,
  DeviceRequestCreateSchema,
  ENROLL_COOKIE,
  type DeviceApproveResponse,
  type DeviceNameSuggestionResponse,
  type DeviceRequestCreateResponse,
  type DeviceRequestStatusResponse,
  type DeviceRequestSummary,
  type DeviceSelf,
  type DeviceStatusResponse,
  type DeviceSummary,
  type DevicesResponse,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { msToIso, msToIsoStrict } from '../../db/helpers.ts';
import { HttpError } from '../../lib/errors.ts';
import { enrollment, paired, samePc } from '../../lib/routes.ts';
import { userAgentSummary } from '../../lib/user-agent.ts';
import { parseBody } from '../../lib/validate.ts';
import { clearCookieHeader, cookieHeader, readCookie } from '../../security/cookies.ts';
import { REQUEST_RETENTION_MS, type DeviceRecord, type DeviceRequestRecord } from '../../security/devices.ts';

export const prefixes = ['/api/device', '/api/devices'] as const;

/**
 * The sender's address as the proxy reported it: the last entry of `X-Forwarded-For` (the one the
 * proxy itself added; a proxy that appends to a header the sender forged leaves the forged entries
 * before it), or null.
 */
export function forwardedFor(c: Context<AppEnv>): string | null {
  const last = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? '';
  return last === '' ? null : last;
}

/** Seconds the other PC should wait before asking again while too many requests wait. */
const RETRY_AFTER_SECONDS = 60;

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'devices' });
  const { config, devices, peerNames } = ctx;

  const self = (record: DeviceRecord): DeviceSelf => ({ id: record.id, label: record.label, createdAt: msToIsoStrict(record.createdAt) });

  const summary = (record: DeviceRecord, currentId: string | undefined): DeviceSummary => ({
    id: record.id,
    label: record.label,
    browser: record.browser,
    createdAt: msToIsoStrict(record.createdAt),
    lastUsedAt: msToIso(record.lastUsedAt),
    current: record.id === currentId,
  });

  const requestSummary = (record: DeviceRequestRecord): DeviceRequestSummary => ({
    id: record.id,
    code: record.code,
    label: record.label,
    browser: record.browser,
    createdAt: msToIsoStrict(record.createdAt),
    expiresAt: msToIsoStrict(record.expiresAt),
  });

  const requestStatus = (
    record: DeviceRequestRecord,
    status: DeviceRequestStatusResponse['status'],
    device: DeviceRecord | null = null,
  ): DeviceRequestStatusResponse => ({
    status,
    id: record.id,
    code: record.code,
    expiresAt: msToIsoStrict(record.expiresAt),
    device: device === null ? null : self(device),
  });

  /** The Pages site on another PC: secrets in headers and bodies, no cookies. */
  const fromPages = (c: Context<AppEnv>): boolean => c.get('remotePages') === true;

  /** The device secret the gate verified for this request (cookie, or the Pages site's header), or 409 when it attributed no device. */
  const presentedSecret = (c: Context<AppEnv>): string => {
    const raw = fromPages(c) ? c.req.header(DEVICE_TOKEN_HEADER) : readCookie(c, DEVICE_COOKIE);
    const secret = raw === '' ? undefined : raw;
    if (secret === undefined || c.get('deviceId') === undefined) throw HttpError.of('not_configured', 'This request carries no device cookie');
    return secret;
  };

  /** A pending request's secret: the enrollment cookie, or the Pages site's header. */
  const enrollmentSecret = (c: Context<AppEnv>): string | undefined => {
    const raw = fromPages(c) ? c.req.header(DEVICE_ENROLL_HEADER) : readCookie(c, ENROLL_COOKIE);
    return raw === '' ? undefined : raw;
  };

  /** Clears the enrollment cookie (never for the Pages site, which has none). */
  const clearEnrollment = (c: Context<AppEnv>): void => {
    if (!fromPages(c)) c.header('Set-Cookie', clearCookieHeader(ENROLL_COOKIE), { append: true });
  };

  // ---- the other PC asking to be connected ------------------------------------

  app.post('/api/devices/requests', enrollment(), async (c) => {
    if (config.remoteOrigin === null) throw HttpError.of('not_configured', 'Set PORTLY_REMOTE_ORIGIN to let other PCs connect');
    if (c.get('remoteClient') !== true) throw HttpError.of('conflict', "This is Portly's own page on the main PC; it needs no connecting");
    const { label } = await parseBody(c, DeviceRequestCreateSchema);
    const created = devices.createRequest({ label, browser: userAgentSummary(c.req.header('user-agent')) });
    if (created === null) {
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      throw HttpError.of('rate_limited', 'Too many devices are waiting for approval; approve or deny them on the main PC first');
    }
    log.info('device request created', { deviceRequestId: created.record.id });
    const body: DeviceRequestCreateResponse = {
      id: created.record.id,
      code: created.record.code,
      expiresAt: msToIsoStrict(created.record.expiresAt),
    };
    if (fromPages(c)) body.secret = created.secret;
    else c.header('Set-Cookie', cookieHeader(ENROLL_COOKIE, created.secret, DEVICE_REQUEST_TTL_MS + REQUEST_RETENTION_MS), { append: true });
    return c.json(body, 201);
  });

  app.get('/api/devices/requests/suggestion', enrollment(), async (c) => {
    const address = c.get('remoteClient') === true ? forwardedFor(c) : null;
    const body: DeviceNameSuggestionResponse = { label: address === null ? null : await peerNames.lookup(address) };
    return c.json(body);
  });

  app.get('/api/devices/requests/current', enrollment(), (c) => {
    const secret = enrollmentSecret(c);
    const request = secret === undefined ? null : devices.requestBySecret(secret);
    if (secret === undefined || request === null) {
      if (secret !== undefined) clearEnrollment(c);
      throw new HttpError(404, 'not_found', 'No device request to show');
    }
    if (devices.isExpired(request)) {
      clearEnrollment(c);
      return c.json(requestStatus(request, 'expired'));
    }
    if (request.status === 'denied') {
      clearEnrollment(c);
      return c.json(requestStatus(request, 'denied'));
    }
    if (request.status === 'approved' || request.status === 'claimed') {
      const claimed = devices.claim(secret);
      if (claimed === null) throw new HttpError(404, 'not_found', 'No device request to show');
      const body = requestStatus(request, 'approved', claimed.record);
      if (fromPages(c)) return c.json({ ...body, secret: claimed.secret });
      c.header('Set-Cookie', cookieHeader(DEVICE_COOKIE, claimed.secret, DEVICE_IDLE_TTL_MS), { append: true });
      clearEnrollment(c);
      return c.json(body);
    }
    return c.json(requestStatus(request, 'pending'));
  });

  // ---- managing devices (approving stays with this PC's own page) -------------

  app.get('/api/devices', paired(), (c) => {
    const body: DevicesResponse = {
      remoteOrigin: config.remoteOrigin,
      devices: devices.list().map((d) => summary(d, c.get('deviceId'))),
      requests: devices.listRequests().map(requestSummary),
    };
    return c.json(body);
  });

  app.post('/api/devices/requests/:id/approve', (c) => {
    const id = c.req.param('id');
    const request = devices.approve(id);
    if (request === null) throw new HttpError(404, 'not_found', 'No request waiting with that id');
    log.info('device request approved', { deviceRequestId: request.id });
    const body: DeviceApproveResponse = { approved: true };
    return c.json(body);
  });

  app.post('/api/devices/requests/:id/deny', (c) => {
    const id = c.req.param('id');
    if (!devices.deny(id)) throw new HttpError(404, 'not_found', 'No request waiting with that id');
    log.info('device request denied', { deviceRequestId: id });
    return c.body(null, 204);
  });

  app.delete('/api/devices/:id', samePc(), (c) => {
    const id = c.req.param('id');
    if (!devices.revoke(id, 'revoked')) throw new HttpError(404, 'not_found', 'Device not found');
    log.info('device removed', { deviceId: id, by: 'revoked' });
    return c.body(null, 204);
  });

  // ---- the presenting device ---------------------------------------------------

  app.get('/api/device', paired(), (c) => {
    const record = devices.verify(presentedSecret(c));
    if (record === null) throw HttpError.of('login_required');
    const body: DeviceStatusResponse = { device: self(record) };
    return c.json(body);
  });

  app.delete('/api/device', paired(), (c) => {
    const secret = presentedSecret(c);
    const record = devices.verify(secret);
    if (record === null || !devices.revokeBySecret(secret, 'disconnected')) throw HttpError.of('login_required');
    log.info('device removed', { deviceId: record.id, by: 'disconnected' });
    if (!fromPages(c)) c.header('Set-Cookie', clearCookieHeader(DEVICE_COOKIE), { append: true });
    return c.body(null, 204);
  });
}
