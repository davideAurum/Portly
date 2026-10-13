/**
 * Error model (§6, §7a errors.ts): handlers `throw new HttpError(status, code, message, details?)`;
 * the app's `onError` maps everything to `{error: {code, message, details?, accountId?}}`.
 * Unknown errors become 500 `internal` with a generic message (never leaking internals).
 *
 * Logging (§17): `errorResponse()` and the error handler put the answer's code on the
 * request (`errorCode`, logged on the request line). Unexpected errors log `error 'request failed'`
 * with `errorFields` and the stack's frame lines (masked, never its header); expected ones ≥ 500
 * `warn 'request failed'` (repeat-collapsed per route and code); 4xx `debug 'request rejected'`
 * with the code and, for validation errors, the issue count and first five field paths (never
 * the values).
 */
import type { Context, ErrorHandler, Handler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ERROR_STATUS, type ApiErrorBody, type ErrorCode, type ValidationIssue } from '@portly/shared';
import { errorFields, pathForLog, type LogFields, type Logger } from './logger.ts';

export interface HttpErrorOptions {
  message?: string;
  details?: unknown;
  accountId?: string;
  /** The underlying error (standard `Error.cause`; logged as a cause chain, never sent to clients). */
  cause?: unknown;
}

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly accountId: string | undefined;

  /**
   * `new HttpError(404, 'not_found', 'Bookmark not found')`,
   * `new HttpError(422, 'validation_failed', 'Invalid body', issues)` or
   * `new HttpError(409, 'reauth_required', {accountId})` (options form).
   */
  constructor(status: number, code: ErrorCode, message?: string | HttpErrorOptions, details?: unknown) {
    const opts: HttpErrorOptions = typeof message === 'object' && message !== null ? message : { message, details };
    super(opts.message ?? defaultMessage(code), opts.cause === undefined ? undefined : { cause: opts.cause });
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.accountId = opts.accountId;
  }

  /** HttpError with the canonical status for `code` (§7a mapping). */
  static of(code: ErrorCode, message?: string | HttpErrorOptions, details?: unknown): HttpError {
    return new HttpError(ERROR_STATUS[code], code, message, details);
  }

  toBody(): ApiErrorBody {
    return errorBody(this.code, this.message, { details: this.details, accountId: this.accountId });
  }
}

/**
 * Thrown by provider calls inside `AccountService.withToken(fn)` when the provider answered 401,
 * so the service can force a token refresh and retry once.
 */
export class ProviderUnauthorizedError extends Error {
  override name = 'ProviderUnauthorizedError';
}

/** Raised while streaming a request body past its limit (§4.2 step 5). */
export class PayloadTooLargeError extends Error {
  override name = 'PayloadTooLargeError';
  readonly limit: number;
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.limit = limit;
  }
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'Bad request',
  validation_failed: 'Validation failed',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  not_configured: 'Not configured',
  reauth_required: 'Reconnect required',
  provider_error: 'The provider returned an error',
  rate_limited: 'Rate limited',
  upstream_timeout: 'The provider timed out',
  payload_too_large: 'Payload too large',
  module_unavailable: 'Module unavailable',
  internal: 'Internal server error',
  pairing_required: 'This browser is not paired with Portly on this PC',
  local_only: "Only available on Portly's own page on this PC",
};

function defaultMessage(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

export function errorBody(
  code: ErrorCode,
  message: string,
  extra: { details?: unknown; accountId?: string | undefined } = {},
): ApiErrorBody {
  const error: ApiErrorBody['error'] = { code, message };
  if (extra.details !== undefined) error.details = extra.details;
  if (extra.accountId !== undefined) error.accountId = extra.accountId;
  return { error };
}

/** JSON error response with the canonical status for `code` (also noted as the request's `errorCode`). */
export function errorResponse(
  c: Context,
  code: ErrorCode,
  message?: string,
  extra: { details?: unknown; accountId?: string; status?: number } = {},
): Response {
  const status = (extra.status ?? ERROR_STATUS[code]) as ContentfulStatusCode;
  c.set('errorCode', code);
  return c.json(errorBody(code, message ?? defaultMessage(code), extra), status);
}

/**
 * Handler answering 503 `module_unavailable`. Reserved for modules whose `register()` threw
 * (modules/index.ts), so a broken module is never confused with a not-yet-implemented route.
 */
export function moduleUnavailable(message = 'Module unavailable'): Handler {
  return (c) => errorResponse(c, 'module_unavailable', message);
}

/**
 * Handler answering 501 `not_configured` for stub routes that are not implemented yet (§15:
 * "stubs return 501 `not_configured`"). The status is explicitly 501 rather than the canonical
 * 409 of `not_configured` (§7a) so it is distinguishable from a feature the user has not set up.
 */
export function notImplemented(message = 'Not implemented yet'): Handler {
  return (c) => errorResponse(c, 'not_configured', message, { status: 501 });
}

/** True when `err` (or one of its causes) is a {@link PayloadTooLargeError}. */
export function isPayloadTooLarge(err: unknown): boolean {
  return findCause(err, PayloadTooLargeError) !== null;
}

export function formatZodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function findCause<T>(err: unknown, ctor: abstract new (...args: never[]) => T): T | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (current instanceof ctor) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export interface MappedError {
  status: number;
  body: ApiErrorBody;
  /** True when the error is unexpected (logged at error level with details). */
  unexpected: boolean;
}

/** Maps any thrown value to the API error shape. */
export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) return { status: err.status, body: err.toBody(), unexpected: false };

  const tooLarge = findCause(err, PayloadTooLargeError);
  if (tooLarge) {
    return { status: 413, body: errorBody('payload_too_large', tooLarge.message), unexpected: false };
  }

  if (err instanceof z.ZodError) {
    return {
      status: 422,
      body: errorBody('validation_failed', 'Validation failed', { details: formatZodIssues(err) }),
      unexpected: false,
    };
  }

  if (err instanceof HTTPException) {
    const status = err.status;
    const code: ErrorCode =
      status === 413
        ? 'payload_too_large'
        : status === 404
          ? 'not_found'
          : status === 401 || status === 403
            ? 'forbidden'
            : status >= 400 && status < 500
              ? 'bad_request'
              : 'internal';
    const message = status >= 500 ? defaultMessage('internal') : err.message || defaultMessage(code);
    return { status: status >= 500 ? 500 : status, body: errorBody(code, message), unexpected: status >= 500 };
  }

  return { status: 500, body: errorBody('internal', defaultMessage('internal')), unexpected: true };
}

/** Validation issues → `{issues: count, paths: first 5 field paths}` (never the values). */
function issueFields(details: unknown): LogFields {
  if (!Array.isArray(details)) return {};
  const paths = details.slice(0, 5).map((issue: unknown) => {
    const p = issue !== null && typeof issue === 'object' ? (issue as { path?: unknown }).path : undefined;
    return typeof p === 'string' ? p.slice(0, 100) : '';
  });
  return { issues: details.length, paths };
}

/** The route pattern that answered (`/api/accounts/:id`), or null for catch-all handlers. */
function routeOf(c: Context): string | null {
  try {
    const rp = routePath(c);
    return rp === '' || rp === '*' || rp === '/*' || rp === '/api/*' ? null : rp;
  } catch {
    return null;
  }
}

/**
 * Hono `onError` handler. `stacks` (default true) adds the frame lines of unexpected errors' stacks
 * (scrubbed, user paths masked; the header line, which repeats the message, never).
 */
export function createErrorHandler(log: Logger, opts: { stacks?: boolean } = {}): ErrorHandler {
  return (err, c) => {
    const mapped = mapError(err);
    const code = mapped.body.error.code;
    c.set('errorCode', code);
    const path = pathForLog(c.req.path);
    const where = { method: c.req.method, path, status: mapped.status };
    if (mapped.unexpected) {
      log.error('request failed', { ...errorFields(err, { stack: opts.stacks ?? true }), ...where });
    } else if (mapped.status >= 500) {
      log.warn('request failed', { ...errorFields(err), ...where, code, repeatKey: `request failed ${routeOf(c) ?? path} ${code}` });
    } else {
      const fields: LogFields = { ...where, code };
      const accountId = mapped.body.error.accountId;
      if (accountId !== undefined) fields.accountId = accountId;
      if (code === 'validation_failed') Object.assign(fields, issueFields(mapped.body.error.details));
      const loggable = errorFields(err);
      if (loggable.errReason !== undefined) fields.errReason = loggable.errReason;
      if (loggable.upstreamStatus !== undefined) fields.upstreamStatus = loggable.upstreamStatus;
      log.debug('request rejected', fields);
    }
    return c.json(mapped.body, mapped.status as ContentfulStatusCode);
  };
}
