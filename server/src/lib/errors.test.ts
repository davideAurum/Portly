import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES, ERROR_STATUS } from '@portly/shared';
import { HttpError, PayloadTooLargeError, createErrorHandler, errorBody, errorResponse, mapError } from './errors.ts';
import { createMemoryLogger } from './logger.ts';
import { parseBody, parseParams, parseQuery, validate } from './validate.ts';

describe('HttpError', () => {
  it('carries status, code, message and details', () => {
    const err = new HttpError(404, 'not_found', 'Bookmark not found', { id: 'b1' });
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.toBody()).toEqual({ error: { code: 'not_found', message: 'Bookmark not found', details: { id: 'b1' } } });
  });

  it('supports the options form with accountId', () => {
    const err = new HttpError(409, 'reauth_required', { accountId: 'acc-1' });
    expect(err.toBody()).toEqual({ error: { code: 'reauth_required', message: 'Reconnect required', accountId: 'acc-1' } });
  });

  it('HttpError.of uses the canonical §7a status for every code', () => {
    for (const code of ERROR_CODES) expect(HttpError.of(code).status).toBe(ERROR_STATUS[code]);
  });

  it('errorBody omits undefined fields', () => {
    expect(errorBody('internal', 'x')).toEqual({ error: { code: 'internal', message: 'x' } });
  });
});

describe('mapError', () => {
  it('maps HttpError, zod, payload-too-large and Hono exceptions', () => {
    expect(mapError(new HttpError(429, 'rate_limited', 'slow down')).status).toBe(429);

    const zodErr = z.object({ a: z.string() }).safeParse({ a: 1 }).error;
    const mappedZod = mapError(zodErr);
    expect(mappedZod.status).toBe(422);
    expect(mappedZod.body.error.code).toBe('validation_failed');
    expect(mappedZod.body.error.details).toEqual([expect.objectContaining({ path: 'a' })]);

    expect(mapError(new PayloadTooLargeError(10)).status).toBe(413);
    expect(mapError(new TypeError('wrapped', { cause: new PayloadTooLargeError(10) })).body.error.code).toBe('payload_too_large');

    expect(mapError(new HTTPException(404)).body.error.code).toBe('not_found');
    expect(mapError(new HTTPException(400, { message: 'nope' })).body.error).toEqual({ code: 'bad_request', message: 'nope' });
    expect(mapError(new HTTPException(502)).status).toBe(500);
  });

  it('maps unknown errors to 500 internal without leaking the message', () => {
    const mapped = mapError(new Error('SELECT * FROM secrets failed'));
    expect(mapped).toEqual({ status: 500, body: { error: { code: 'internal', message: 'Internal server error' } }, unexpected: true });
    expect(mapError('a string').status).toBe(500);
  });
});

describe('error handler + validation helpers', () => {
  const log = createMemoryLogger();
  const app = new Hono();
  app.onError(createErrorHandler(log));
  app.post('/body', async (c) => c.json(await parseBody(c, z.object({ n: z.number().int() }).strict())));
  app.get('/query', (c) => c.json(parseQuery(c, z.object({ q: z.string().min(2) }))));
  app.get('/params/:id', (c) => c.json(parseParams(c, z.object({ id: z.uuid() }))));
  app.get('/reauth', () => {
    throw new HttpError(409, 'reauth_required', { accountId: 'a1', message: 'Reconnect Google' });
  });
  app.get('/crash', () => {
    throw new Error('Bearer abc.def.ghi leaked');
  });

  const post = (body: string) => app.request('/body', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });

  it('parseBody: valid, empty, malformed and invalid bodies', async () => {
    expect(await (await post('{"n":1}')).json()).toEqual({ n: 1 });
    const empty = await post('');
    expect(empty.status).toBe(422);
    const malformed = await post('{"n":');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    const invalid = await post('{"n":1.5,"x":1}');
    expect(invalid.status).toBe(422);
    const body = (await invalid.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((d) => d.path).sort()).toEqual(['', 'n']);
  });

  it('parseQuery / parseParams', async () => {
    expect((await app.request('/query?q=ab')).status).toBe(200);
    expect((await app.request('/query?q=a')).status).toBe(422);
    expect((await app.request('/params/not-a-uuid')).status).toBe(422);
  });

  it('includes accountId for reauth errors', async () => {
    const res = await app.request('/reauth');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'reauth_required', message: 'Reconnect Google', accountId: 'a1' } });
  });

  it('logs unexpected errors scrubbed, without the query string', async () => {
    const res = await app.request('/crash?token=abc');
    expect(res.status).toBe(500);
    const line = log.lines.find((l) => l.level === 'error');
    expect(line?.fields?.path).toBe('/crash');
    expect(String(line?.fields?.errMessage)).not.toContain('abc.def.ghi');
  });

  it('validate() throws a 422 HttpError', () => {
    expect(() => validate(z.string(), 1)).toThrow(HttpError);
    try {
      validate(z.string(), 1, 'thing');
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).message).toBe('Invalid thing');
    }
  });
});

describe('error handler: logging', () => {
  const setup = () => {
    const log = createMemoryLogger();
    const app = new Hono<{ Variables: { errorCode: string | undefined } }>();
    const codes: (string | undefined)[] = [];
    app.use('*', async (c, next) => {
      await next();
      codes.push(c.get('errorCode'));
    });
    app.onError(createErrorHandler(log));
    app.get('/items/:id', () => {
      throw new HttpError(409, 'reauth_required', { accountId: 'acc-1', message: 'Reconnect Google' });
    });
    app.post('/items', async (c) => c.json(await parseBody(c, z.object({ name: z.string(), size: z.number() }).strict())));
    app.get('/upstream/:id', () => {
      throw new HttpError(502, 'provider_error', 'Google answered HTTP 503', { status: 503, reason: 'backendError' });
    });
    app.get('/crash', () => {
      throw new Error('crashed reading C:\\Users\\someone\\AppData\\secret.txt');
    });
    app.get('/answered', (c) => errorResponse(c, 'not_configured'));
    return { log, app, codes };
  };

  it('notes the answer code on the request (errorResponse and the handler)', async () => {
    const { app, codes } = setup();
    await app.request('/items/a1');
    await app.request('/answered');
    await app.request('/crash');
    expect(codes).toEqual(['reauth_required', 'not_configured', 'internal']);
  });

  it('4xx: debug "request rejected" with the code, account and validation paths, never values', async () => {
    const { app, log } = setup();
    await app.request('/items/a1');
    await app.request('/items', { method: 'POST', body: '{"name":"private title","size":"big","x":1}', headers: { 'Content-Type': 'application/json' } });
    const rejected = log.lines.filter((l) => l.message === 'request rejected');
    expect(rejected.map((l) => l.level)).toEqual(['debug', 'debug']);
    expect(rejected[0]?.fields).toMatchObject({ method: 'GET', path: '/items/a1', status: 409, code: 'reauth_required', accountId: 'acc-1' });
    expect(rejected[1]?.fields).toMatchObject({ status: 422, code: 'validation_failed', issues: 2 });
    expect([...((rejected[1]?.fields?.paths as string[]) ?? [])].sort()).toEqual(['', 'size']);
    expect(JSON.stringify(log.lines)).not.toContain('private title');
  });

  it('expected ≥ 500: warn "request failed" with the error fields, repeat-collapsed per route and code', async () => {
    const { app, log } = setup();
    await app.request('/upstream/a1');
    const line = log.lines.find((l) => l.message === 'request failed');
    expect(line?.level).toBe('warn');
    expect(line?.fields).toMatchObject({
      errName: 'HttpError',
      upstreamStatus: 503,
      errReason: 'backendError',
      code: 'provider_error',
      status: 502,
      repeatKey: 'request failed /upstream/:id provider_error',
    });
  });

  it('unexpected: error "request failed" with frame-only stack lines, the user path masked', async () => {
    const { app, log } = setup();
    await app.request('/crash');
    const line = log.lines.find((l) => l.message === 'request failed');
    expect(line?.level).toBe('error');
    const stack = String(line?.fields?.stack ?? '');
    expect(stack.split('\n').every((frame) => frame.startsWith('at '))).toBe(true);
    expect(stack).not.toContain('crashed reading');
    expect(String(line?.fields?.errMessage)).not.toContain('someone');
  });
});
