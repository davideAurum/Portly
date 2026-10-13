/**
 * Request validation for static handlers, mirroring server/src/lib/validate.ts and
 * server/src/lib/multipart.ts: schema failures are `422 validation_failed` with
 * `details: ValidationIssue[]` and the server's `Invalid <what>` message; a malformed JSON body or
 * a forbidden key is `400 bad_request`; multipart problems are 400, an over-limit file 413.
 * Everything throws `StaticApiError`, which the dispatch loop turns into the response.
 */
import type { z } from 'zod';
import { StaticApiError, validationIssues } from '../respond.ts';
import { assertSafeJson } from './safeJson.ts';

/** Parses `value` with `schema` or throws 422 `validation_failed` ("Invalid <what>"). */
export function validate<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new StaticApiError('validation_failed', `Invalid ${what}`, validationIssues(result.error));
  return result.data;
}

/**
 * Reads the request's JSON body (an empty body is `{}`, like the server) and rejects forbidden
 * keys / deep nesting (400). A non-empty body must be JSON; a declared non-JSON content type is
 * refused.
 */
export async function readSafeJson(req: Request, what = 'Request body'): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new StaticApiError('bad_request', 'Could not read request body');
  }
  let data: unknown = {};
  if (text.trim() !== '') {
    const type = req.headers.get('content-type') ?? '';
    if (type !== '' && !type.toLowerCase().includes('application/json')) {
      throw new StaticApiError('bad_request', 'Content-Type must be application/json');
    }
    try {
      data = JSON.parse(text);
    } catch {
      throw new StaticApiError('bad_request', 'Malformed JSON body');
    }
  }
  assertSafeJson(data, what);
  return data;
}

/** JSON body → 400 on malformed/forbidden-key input, then 422 "Invalid request body" via `schema`. */
export async function parseJsonBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  return validate(schema, await readSafeJson(req), 'request body');
}

/** Validates the query string (first value of each key) → 422 "Invalid query". */
export function parseQuery<S extends z.ZodType>(url: URL, schema: S): z.output<S> {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push([key, value]);
  }
  const query = Object.fromEntries(entries);
  assertSafeJson(query, 'Query');
  return validate(schema, query, 'query');
}

export interface UploadedFile {
  file: File;
  bytes: Uint8Array;
  /** Client-supplied file name, capped (display/logging only; never used for paths or types). */
  name: string;
}

/**
 * The one file in a multipart form (server/src/lib/multipart.ts): exactly one `field` part that
 * is a file, non-empty and at most `maxBytes` (413 `payload_too_large` beyond that). The client's
 * file type is never trusted — sniff the bytes. `field` defaults to `'file'` (pass `undefined`).
 */
export async function readMultipartFile(form: FormData, field: string | undefined = 'file', maxBytes: number): Promise<UploadedFile> {
  const entries = form.getAll(field);
  if (entries.length !== 1) {
    throw new StaticApiError('bad_request', entries.length === 0 ? `Missing "${field}" file` : `Send exactly one "${field}" file`);
  }
  const entry = entries[0];
  if (typeof entry === 'string' || entry === undefined) throw new StaticApiError('bad_request', `"${field}" must be a file`);
  if (entry.size > maxBytes) throw new StaticApiError('payload_too_large', `File exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(await entry.arrayBuffer());
  if (bytes.length === 0) throw new StaticApiError('bad_request', 'The file is empty');
  return { file: entry, bytes, name: entry.name.slice(0, 200) };
}
