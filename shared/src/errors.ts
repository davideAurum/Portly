/**
 * API error contract (§7a errors.ts). Every non-2xx JSON response has the shape
 * `{error: {code, message, details?, accountId?}}`.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'forbidden',
  'not_found',
  'conflict',
  'not_configured',
  'reauth_required',
  'provider_error',
  'rate_limited',
  'upstream_timeout',
  'payload_too_large',
  'module_unavailable',
  'internal',
  /** A request from the Pages site without a valid pairing token (hybrid mode). */
  'pairing_required',
  /** A route the Pages site may not call: only Homebase's own page on this PC can. */
  'local_only',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.output<typeof ErrorCodeSchema>;

/** Canonical HTTP status for each error code. */
export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_configured: 409,
  reauth_required: 409,
  provider_error: 502,
  rate_limited: 429,
  upstream_timeout: 504,
  payload_too_large: 413,
  module_unavailable: 503,
  internal: 500,
  pairing_required: 401,
  local_only: 403,
} as const satisfies Record<ErrorCode, number>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export const ApiErrorInfoSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  accountId: z.string().optional(),
});
export type ApiErrorInfo = z.output<typeof ApiErrorInfoSchema>;

export const ApiErrorBodySchema = z.object({ error: ApiErrorInfoSchema });

/** `{error: {code, message, details?, accountId?}}` */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    accountId?: string;
  };
}

/**
 * Multi-account aggregates return 200 with a per-item `error?` (e.g. `MailAccountSummary.error`).
 */
export type ItemError = ApiErrorBody['error'];

/** Shape of `details` for `validation_failed` responses. */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}
