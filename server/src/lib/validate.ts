/**
 * Request validation helpers. Schema failures become 422 `validation_failed` with
 * `details: ValidationIssue[]`; malformed JSON becomes 400 `bad_request`.
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import { HttpError, formatZodIssues, isPayloadTooLarge } from './errors.ts';

function validationError(error: z.ZodError, what: string): HttpError {
  return new HttpError(422, 'validation_failed', `Invalid ${what}`, formatZodIssues(error));
}

/** Parses `value` with `schema` or throws 422 `validation_failed`. */
export function validate<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error, what);
  return result.data;
}

/** Reads the JSON body (an empty body is treated as `{}`) and validates it. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch (err) {
    if (isPayloadTooLarge(err)) throw err;
    throw new HttpError(400, 'bad_request', 'Could not read request body');
  }
  let data: unknown = {};
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_request', 'Malformed JSON body');
    }
  }
  return validate(schema, data, 'request body');
}

/** Validates the query string (single-valued keys). */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return validate(schema, c.req.query(), 'query');
}

/** Validates the route params. */
export function parseParams<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return validate(schema, c.req.param(), 'path parameters');
}
