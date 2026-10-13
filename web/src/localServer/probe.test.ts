/**
 * The requests that find the Portly server on this PC: the health probe (a simple CORS GET with
 * no custom header, no cache, no credentials, aimed at the loopback address space; answers
 * validated, the server's page URL kept only when it is a loopback root page) and the pairing
 * check (token and `X-Portly`; only `pairing_required` clears a pairing); what each request showed
 * for the diagnostic events; and the `no-cors` fallback, which carries nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { APP_URL, INSTANCE, ORIGIN, TOKEN, healthBody, jsonResponse, pairingBody, pairingRequired } from './__fixtures__/fakes.ts';
import {
  checkPairing,
  checkPairingDetailed,
  isPairingRequired,
  pairedHeaders,
  probeHealth,
  probeHealthDetailed,
  probeHealthWithoutCors,
  type FetchLike,
  type LoopbackRequestInit,
} from './probe.ts';

/** A fetch answering `answer`, or failing with it when it is not a Response. */
function fetchReturning(answer: Response | Error | DOMException): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async () => {
    if (!(answer instanceof Response)) throw answer;
    return answer;
  });
}

describe('probeHealth', () => {
  it('sends a simple, uncached, credential-less CORS GET to the loopback address space', async () => {
    const fetch = fetchReturning(jsonResponse(healthBody()));
    const abort = new AbortController();
    await probeHealth(ORIGIN, { fetch, signal: abort.signal });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/health`);
    expect(init).toMatchObject({
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      targetAddressSpace: 'loopback',
      signal: abort.signal,
    } satisfies LoopbackRequestInit);
    // No custom header: no preflight.
    expect(init?.headers).toBeUndefined();
  });

  it('reads a Portly answer, keeping the reported page only when it is a loopback root page', async () => {
    const ok = await probeHealth(ORIGIN, { fetch: fetchReturning(jsonResponse(healthBody())) });
    expect(ok).toMatchObject({ kind: 'ok', appUrl: APP_URL, health: { instanceId: INSTANCE, apiVersion: 1, vault: 'ready' } });

    for (const appUrl of ['https://evil.example/', 'http://localhost:5757/somewhere', 'http://user:pw@localhost:5757/', 'file:///C:/']) {
      const answer = await probeHealth(ORIGIN, { fetch: fetchReturning(jsonResponse(healthBody({ appUrl }))) });
      expect(answer).toMatchObject({ kind: 'ok', appUrl: null });
    }
  });

  it('a Portly from before hybrid mode (no app field) still reads as Portly', async () => {
    const answer = await probeHealth(ORIGIN, { fetch: fetchReturning(jsonResponse({ ok: true, version: '0.0.9', vault: 'locked' })) });
    expect(answer).toMatchObject({ kind: 'ok', appUrl: null, health: { version: '0.0.9' } });
  });

  it('a newer Portly with fields this page does not know still reads as Portly', async () => {
    const answer = await probeHealth(ORIGIN, { fetch: fetchReturning(jsonResponse({ ...healthBody(), features: ['x'] })) });
    expect(answer).toMatchObject({ kind: 'ok', appUrl: APP_URL, health: { instanceId: INSTANCE, apiVersion: 1 } });
    expect(answer.kind === 'ok' && 'features' in answer.health).toBe(false);
  });

  it('anything else on the port is not Portly', async () => {
    const others = [
      new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      jsonResponse(healthBody(), 500),
      jsonResponse({ ...healthBody(), app: 'something-else' }),
      jsonResponse({ ...healthBody(), vault: 'open-sesame' }),
      new Response('{not json', { headers: { 'Content-Type': 'application/json' } }),
    ];
    for (const res of others) expect(await probeHealth(ORIGIN, { fetch: fetchReturning(res) })).toEqual({ kind: 'not-portly' });
  });

  it('a failed fetch is unreachable; an aborted one is aborted', async () => {
    expect(await probeHealth(ORIGIN, { fetch: fetchReturning(new TypeError('Failed to fetch')) })).toEqual({ kind: 'unreachable' });
    const abort = new AbortController();
    abort.abort();
    const aborted = await probeHealth(ORIGIN, { fetch: fetchReturning(new DOMException('aborted', 'AbortError')), signal: abort.signal });
    expect(aborted).toEqual({ kind: 'aborted' });
  });
});

describe('checkPairing', () => {
  it('sends the token and X-Portly', async () => {
    const fetch = fetchReturning(jsonResponse(pairingBody()));
    const answer = await checkPairing(ORIGIN, TOKEN, { fetch });
    expect(answer).toMatchObject({ kind: 'ok', pairing: { instanceId: INSTANCE } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/pairing`);
    expect(init).toMatchObject({ method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', targetAddressSpace: 'loopback' });
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Portly-Token')).toBe(TOKEN);
    expect(headers.get('X-Portly')).toBe('1');
  });

  it('reads an answer from a newer server with fields this page does not know', async () => {
    const answer = await checkPairing(ORIGIN, TOKEN, { fetch: fetchReturning(jsonResponse({ ...pairingBody(), scope: 'all' })) });
    expect(answer).toMatchObject({ kind: 'ok', pairing: { instanceId: INSTANCE } });
  });

  it('only a 401 pairing_required says the pairing is gone', async () => {
    expect(await checkPairing(ORIGIN, TOKEN, { fetch: fetchReturning(pairingRequired()) })).toEqual({ kind: 'unpaired' });
    const others = [
      jsonResponse({ error: { code: 'unauthorized', message: 'x' } }, 401),
      new Response('nope', { status: 401 }),
      jsonResponse({ error: { code: 'local_only', message: 'x' } }, 403),
      jsonResponse({ paired: true }),
      new TypeError('Failed to fetch'),
    ];
    for (const answer of others) expect(await checkPairing(ORIGIN, TOKEN, { fetch: fetchReturning(answer) })).toEqual({ kind: 'error' });
  });

  it('an abort is reported as such', async () => {
    const abort = new AbortController();
    abort.abort();
    const answer = await checkPairing(ORIGIN, TOKEN, { fetch: fetchReturning(new DOMException('aborted', 'AbortError')), signal: abort.signal });
    expect(answer).toEqual({ kind: 'aborted' });
  });
});

describe('helpers', () => {
  it('pairedHeaders keeps the caller headers and sets the two of hybrid mode', () => {
    const headers = pairedHeaders(TOKEN, { 'Content-Type': 'application/json', 'X-Portly-Token': 'forged' });
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Portly-Token')).toBe(TOKEN);
    expect(headers.get('X-Portly')).toBe('1');
  });

  it('isPairingRequired leaves the response readable', async () => {
    const res = pairingRequired();
    expect(await isPairingRequired(res)).toBe(true);
    expect(await res.json()).toMatchObject({ error: { code: 'pairing_required' } });
    expect(await isPairingRequired(jsonResponse({}, 200))).toBe(false);
  });
});

describe('details for the diagnostic events', () => {
  /** A clock that moves 7 ms per read. */
  function ticking(): () => number {
    let t = 1_000;
    return () => (t += 7);
  }

  it('the health probe says how long it took, the HTTP status and the error name', async () => {
    const ok = await probeHealthDetailed(ORIGIN, { fetch: fetchReturning(jsonResponse(healthBody())), now: ticking() });
    expect(ok).toMatchObject({ result: { kind: 'ok' }, details: { ms: 7, httpStatus: 200, errName: null } });
    const html = await probeHealthDetailed(ORIGIN, { fetch: fetchReturning(new Response('<html>', { status: 404 })) });
    expect(html).toMatchObject({ result: { kind: 'not-portly' }, details: { httpStatus: 404, errName: null } });
    const down = await probeHealthDetailed(ORIGIN, { fetch: fetchReturning(new TypeError('Failed to fetch')) });
    expect(down).toEqual({ result: { kind: 'unreachable' }, details: { ms: expect.any(Number), httpStatus: null, errName: 'TypeError' } });
    const garbled = await probeHealthDetailed(ORIGIN, { fetch: fetchReturning(new Response('{not json', { headers: { 'Content-Type': 'application/json' } })) });
    expect(garbled).toMatchObject({ result: { kind: 'not-portly' }, details: { httpStatus: 200, errName: 'SyntaxError' } });
  });

  it('the pairing check too', async () => {
    expect(await checkPairingDetailed(ORIGIN, TOKEN, { fetch: fetchReturning(pairingRequired()) })).toMatchObject({ result: { kind: 'unpaired' }, details: { httpStatus: 401 } });
    expect(await checkPairingDetailed(ORIGIN, TOKEN, { fetch: fetchReturning(jsonResponse({ error: { code: 'internal', message: 'x' } }, 500)) })).toMatchObject({
      result: { kind: 'error' },
      details: { httpStatus: 500, errName: null },
    });
    expect(await checkPairingDetailed(ORIGIN, TOKEN, { fetch: fetchReturning(new TypeError('Failed to fetch')) })).toMatchObject({
      result: { kind: 'error' },
      details: { httpStatus: null, errName: 'TypeError' },
    });
  });
});

describe('probeHealthWithoutCors', () => {
  it('sends a no-cors GET that carries nothing: no header, no token, no credentials, no referrer', async () => {
    const fetch = fetchReturning(new Response(null, { status: 200 }));
    const abort = new AbortController();
    await probeHealthWithoutCors(ORIGIN, { fetch, signal: abort.signal });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/health`);
    expect(init).toEqual({
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      targetAddressSpace: 'loopback',
      signal: abort.signal,
    } satisfies LoopbackRequestInit);
  });

  it('an (opaque) answer means something answers; a failure that nothing does', async () => {
    expect((await probeHealthWithoutCors(ORIGIN, { fetch: fetchReturning(new Response(null, { status: 200 })) })).result).toBe('answers');
    expect(await probeHealthWithoutCors(ORIGIN, { fetch: fetchReturning(new TypeError('Failed to fetch')) })).toMatchObject({ result: 'unreachable', details: { errName: 'TypeError' } });
    const abort = new AbortController();
    abort.abort();
    expect((await probeHealthWithoutCors(ORIGIN, { fetch: fetchReturning(new DOMException('aborted', 'AbortError')), signal: abort.signal })).result).toBe('aborted');
  });
});
