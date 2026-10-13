import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StaticApiError } from '../respond.ts';
import { parseJsonBody, parseQuery, readMultipartFile, readSafeJson, validate } from './validate.ts';

const URL_BASE = 'http://portly.static/api/things';

function jsonRequest(body: string | undefined, type: string | null = 'application/json'): Request {
  const headers = new Headers({ 'X-Portly': '1' });
  if (type !== null) headers.set('content-type', type);
  return new Request(URL_BASE, { method: 'POST', body, headers });
}

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<StaticApiError> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (err) {
    if (err instanceof StaticApiError) return err;
    throw err;
  }
  throw new Error('expected a StaticApiError');
}

const Body = z.object({ name: z.string().trim().min(1), count: z.number().int().optional() }).strict();

describe('validate / parseJsonBody', () => {
  it('parses valid bodies and treats an empty body as {}', async () => {
    expect(await parseJsonBody(jsonRequest('{"name":" a ","count":2}'), Body)).toEqual({ name: 'a', count: 2 });
    const Optional = z.object({ name: z.string().optional() });
    expect(await parseJsonBody(new Request(URL_BASE, { method: 'POST' }), Optional)).toEqual({});
    expect(await parseJsonBody(jsonRequest('   '), Optional)).toEqual({});
    expect(await parseJsonBody(jsonRequest('{"name":"x"}', 'application/json; charset=utf-8'), Optional)).toEqual({ name: 'x' });
    // A body without an explicit header gets `text/plain` from the Request constructor, which is refused.
    expect(await failure(parseJsonBody(jsonRequest('{"name":"x"}', null), Optional))).toMatchObject({ code: 'bad_request' });
  });

  it('answers 400 for malformed JSON, a wrong content type or forbidden keys', async () => {
    expect(await failure(parseJsonBody(jsonRequest('{'), Body))).toMatchObject({ code: 'bad_request', message: 'Malformed JSON body' });
    expect(await failure(parseJsonBody(jsonRequest('{"name":"x"}', 'text/plain'), Body))).toMatchObject({
      code: 'bad_request',
      message: 'Content-Type must be application/json',
    });
    expect(await failure(parseJsonBody(jsonRequest('{"name":"x","__proto__":{"a":1}}'), Body))).toMatchObject({
      code: 'bad_request',
      message: 'Request body contains a forbidden key (__proto__)',
    });
    expect(await failure(readSafeJson(jsonRequest('{"a":{"constructor":1}}'), 'Settings patch'))).toMatchObject({
      message: 'Settings patch contains a forbidden key (a.constructor)',
    });
  });

  it('answers 422 "Invalid request body" with the server detail shape', async () => {
    const err = await failure(parseJsonBody(jsonRequest('{"name":"","count":1.5,"extra":1}'), Body));
    expect(err.code).toBe('validation_failed');
    expect(err.message).toBe('Invalid request body');
    expect(err.toResponse().status).toBe(422);
    const details = err.details as { path: string; message: string; code: string }[];
    expect(details.map((d) => d.path).sort()).toEqual(['', 'count', 'name']);
    expect(details.every((d) => typeof d.message === 'string' && typeof d.code === 'string')).toBe(true);
    // Non-object JSON is a schema failure (422), not a parse failure.
    expect((await failure(parseJsonBody(jsonRequest('[1,2]'), Body))).code).toBe('validation_failed');
    expect((await failure(parseJsonBody(jsonRequest('null'), Body))).code).toBe('validation_failed');
  });

  it('validate() names what was invalid', async () => {
    expect(validate(z.number(), 1)).toBe(1);
    expect((await failure(() => validate(z.number(), 'x'))).message).toBe('Invalid request');
    expect((await failure(() => validate(z.number(), 'x', 'path parameters'))).message).toBe('Invalid path parameters');
  });
});

describe('parseQuery', () => {
  const Query = z.object({ q: z.string().min(1), limit: z.coerce.number().int().optional() });

  it('validates the query string, taking the first value of repeated keys', () => {
    expect(parseQuery(new URL(`${URL_BASE}?q=hello&limit=3`), Query)).toEqual({ q: 'hello', limit: 3 });
    expect(parseQuery(new URL(`${URL_BASE}?q=first&q=second`), Query)).toEqual({ q: 'first' });
    expect(parseQuery(new URL(`${URL_BASE}?q=caf%C3%A9+x`), Query)).toEqual({ q: 'café x' });
  });

  it('answers 422 "Invalid query" and 400 for forbidden keys', async () => {
    const err = await failure(() => parseQuery(new URL(`${URL_BASE}?limit=x`), Query));
    expect(err).toMatchObject({ code: 'validation_failed', message: 'Invalid query' });
    expect((err.details as { path: string }[]).map((d) => d.path).sort()).toEqual(['limit', 'q']);
    expect(await failure(() => parseQuery(new URL(`${URL_BASE}?q=a&__proto__=1`), Query))).toMatchObject({
      code: 'bad_request',
      message: 'Query contains a forbidden key (__proto__)',
    });
  });
});

describe('readMultipartFile', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const form = (field = 'file', ...files: (File | string)[]): FormData => {
    const f = new FormData();
    for (const file of files) f.append(field, file);
    return f;
  };
  const file = (data: Uint8Array | string, name = 'pic.png', type = 'image/png') => new File([typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)], name, { type });

  it('returns the one file with its bytes and a capped name', async () => {
    const result = await readMultipartFile(form('file', file(bytes)), undefined, 1024);
    expect(result.bytes).toEqual(bytes);
    expect(result.name).toBe('pic.png');
    expect(result.file.size).toBe(5);
    const long = await readMultipartFile(form('file', file(bytes, 'x'.repeat(500))), 'file', 1024);
    expect(long.name).toHaveLength(200);
    const other = await readMultipartFile(form('image', file('abc')), 'image', 1024);
    expect(new TextDecoder().decode(other.bytes)).toBe('abc');
  });

  it('uses the server messages for missing, repeated, non-file and empty parts', async () => {
    expect(await failure(readMultipartFile(form('other', file(bytes)), undefined, 1024))).toMatchObject({ code: 'bad_request', message: 'Missing "file" file' });
    expect(await failure(readMultipartFile(form('file', file(bytes), file(bytes)), undefined, 1024))).toMatchObject({
      code: 'bad_request',
      message: 'Send exactly one "file" file',
    });
    expect(await failure(readMultipartFile(form('file', 'just text'), undefined, 1024))).toMatchObject({ code: 'bad_request', message: '"file" must be a file' });
    expect(await failure(readMultipartFile(form('file', file(new Uint8Array(0))), undefined, 1024))).toMatchObject({ code: 'bad_request', message: 'The file is empty' });
    expect(await failure(readMultipartFile(form('upload'), 'upload', 1024))).toMatchObject({ message: 'Missing "upload" file' });
  });

  it('answers 413 payload_too_large before reading an over-limit file', async () => {
    const err = await failure(readMultipartFile(form('file', file(bytes)), undefined, 4));
    expect(err).toMatchObject({ code: 'payload_too_large', message: 'File exceeds 4 bytes' });
    expect(err.toResponse().status).toBe(413);
    // Exactly at the limit is fine.
    expect((await readMultipartFile(form('file', file(bytes)), undefined, 5)).bytes).toHaveLength(5);
  });
});
