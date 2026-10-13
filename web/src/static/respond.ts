/**
 * Response helpers for the static backend, producing exactly what the server produces (§7a
 * errors.ts): JSON bodies, `204` for deletes, and `{error: {code, message, details?}}` with the
 * canonical status for every error code.
 */
import { ERROR_STATUS, type ApiErrorBody, type ErrorCode, type ValidationIssue } from '@homebase/shared';
import type { ZodError } from 'zod';

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** Throw this from a handler; `staticFetch` turns it into the matching error response. */
export class StaticApiError extends Error {
  override name = 'StaticApiError';
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly accountId: string | undefined;

  constructor(code: ErrorCode, message: string, details?: unknown, accountId?: string) {
    super(message);
    this.code = code;
    this.details = details;
    this.accountId = accountId;
  }

  toResponse(): Response {
    return apiError(this.code, this.message, this.details, this.accountId);
  }
}

export function apiError(code: ErrorCode, message: string, details?: unknown, accountId?: string): Response {
  const error: ApiErrorBody['error'] = { code, message };
  if (details !== undefined) error.details = details;
  if (accountId !== undefined) error.accountId = accountId;
  return json({ error } satisfies ApiErrorBody, ERROR_STATUS[code]);
}

export function validationIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'symbol' ? p.description ?? '' : String(p))).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** `422 validation_failed` with the server's `details` shape. */
export function validationError(err: ZodError, message = 'Validation failed'): Response {
  return apiError('validation_failed', message, validationIssues(err));
}

export function notFound(what = 'Not found'): Response {
  return apiError('not_found', what);
}

/**
 * The answer for every server-only route in the static build. `not_configured` (409) is the
 * server's own convention for stubbed features; being a 4xx it is never retried by the query
 * client, and ErrorState renders it as "Not set up yet" with this message.
 */
export function unavailable(feature = 'This feature'): Response {
  return apiError('not_configured', `${feature} is not available in the browser-only build.`);
}

/** Parses a JSON request body; a missing or malformed body is `400 bad_request`. */
export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new StaticApiError('bad_request', 'Content-Type must be application/json');
  }
  try {
    return await req.json();
  } catch {
    throw new StaticApiError('bad_request', 'Malformed JSON body');
  }
}

/** Parses a multipart body; anything else is `400 bad_request`. */
export async function readFormData(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new StaticApiError('bad_request', 'Expected a multipart/form-data body');
  }
}
