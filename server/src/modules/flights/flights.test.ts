import { afterEach, describe, expect, it } from 'vitest';
import type { FlightStatus } from '@portly/shared';
import type { FakeRequest } from '../../testing/fake-fetch.ts';
import { flightWindow, mapFlight, text } from './aeroapi.ts';
import { FLIGHTS_URL, KEY, NOW, OTHER_KEY, USAGE_URL, flightsAnswer, flightsTestbed, upstreamFlight, type FlightsTestbed } from './__fixtures__/aeroapi.ts';
import { KEY_SECRET_ID } from './index.ts';

type ErrorBody = { error: { code: string; message: string; details?: { reason?: string; retryAfterSeconds?: number } } };

let t: FlightsTestbed;
afterEach(() => t?.close());

const calls = (): FakeRequest[] => t.ctx.fakeFetch?.calls ?? [];
const health = () => t.ctx.health.get('flightaware');
const usageOk = { match: USAGE_URL, respond: { json: { total_cost: 0 } } };
const found = { match: FLIGHTS_URL, respond: { json: flightsAnswer([upstreamFlight()]) } };

function withKey(extra: Parameters<typeof flightsTestbed>[0] = {}): FlightsTestbed {
  return flightsTestbed({ secrets: { [KEY_SECRET_ID]: KEY }, ...extra });
}

describe('flights: key', () => {
  it('checks a key with the free usage call, stores it, and never returns it', async () => {
    t = flightsTestbed({ fetchRoutes: [usageOk] });
    expect((await t.json('GET', '/api/flights/key')).body).toEqual({ configured: false });
    const saved = await t.json('PUT', '/api/flights/key', { body: { key: ` x-apikey: ${KEY}\n` } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect(saved.text).not.toContain(KEY);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.url).toBe(USAGE_URL);
    expect(calls()[0]!.headers.get('x-apikey')).toBe(KEY);
    expect(t.ctx.vault.get(KEY_SECRET_ID)).toBe(KEY);
    expect(health()?.status).toBe('ok');

    const removed = await t.json('DELETE', '/api/flights/key');
    expect(removed.body).toEqual({ configured: false });
    expect(t.ctx.vault.has(KEY_SECRET_ID)).toBe(false);
  });

  it('refuses a malformed key without calling FlightAware', async () => {
    t = flightsTestbed();
    const res = await t.json<ErrorBody>('PUT', '/api/flights/key', { body: { key: 'not a key' } });
    expect(res.status).toBe(422);
    expect(calls()).toHaveLength(0);
  });

  it('does not store a key FlightAware refuses, nor echo its error text', async () => {
    t = flightsTestbed({ fetchRoutes: [{ match: USAGE_URL, respond: { status: 401, json: { title: 'Unauthorized', reason: 'secret-detail', detail: 'x', status: 401 } } }] });
    const res = await t.json<ErrorBody>('PUT', '/api/flights/key', { body: { key: OTHER_KEY } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation_failed', details: { reason: 'token_rejected' } });
    expect(res.text).not.toContain('secret-detail');
    expect(t.ctx.vault.has(KEY_SECRET_ID)).toBe(false);
  });
});

describe('flights: status', () => {
  it('is not configured without a key', async () => {
    t = flightsTestbed();
    const res = await t.json<ErrorBody>('GET', '/api/flights/status?ident=UA123&date=2026-12-03');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_configured');
  });

  it('asks for the flight number in a window around the date and maps the answer', async () => {
    t = withKey({ fetchRoutes: [found] });
    const res = await t.json<FlightStatus>('GET', '/api/flights/status?ident=ua%20123&date=2026-12-03');
    expect(res.status).toBe(200);
    const url = new URL(calls()[0]!.url);
    expect(url.pathname).toBe('/aeroapi/flights/UA123');
    expect(Object.fromEntries(url.searchParams)).toEqual({ ident_type: 'designator', start: '2026-12-02T10:00:00Z', end: '2026-12-04T12:00:00Z', max_pages: '1' });
    expect(calls()[0]!.headers.get('x-apikey')).toBe(KEY);
    expect(res.body).toMatchObject({ ident: 'UA123', date: '2026-12-03', state: 'found' });
    expect(res.body.flight).toMatchObject({
      ident: 'UA123',
      operator: 'UA',
      origin: { code: 'DEN', city: 'Denver', timezone: 'America/Denver' },
      destination: { code: 'SFO', timezone: 'America/Los_Angeles' },
      departure: { scheduled: '2026-12-03T22:00:00.000Z', estimated: '2026-12-03T22:10:00.000Z', actual: null, gate: 'B32', terminal: null },
      arrival: { gate: 'F12', terminal: '3' },
      phase: 'scheduled',
      departureDelayMin: 10,
      arrivalDelayMin: 5,
      url: 'https://www.flightaware.com/live/flight/id/UAL123-1764700000-airline-0042',
    });
    expect(health()?.status).toBe('ok');
  });

  it('serves repeat requests from memory until the flight is due another look', async () => {
    t = withKey({ fetchRoutes: [found] });
    await t.json('GET', '/api/flights/status?ident=UA123&date=2026-12-03');
    await t.json('GET', '/api/flights/status?ident=UA123&date=2026-12-03');
    expect(calls()).toHaveLength(1);
  });

  it('picks the departure on the local date asked for', async () => {
    const yesterday = upstreamFlight({ fa_flight_id: 'UAL123-a', scheduled_out: '2026-12-03T02:00:00Z' }); // Dec 2 in Denver
    const today = upstreamFlight({ fa_flight_id: 'UAL123-b' });
    t = withKey({ fetchRoutes: [{ match: FLIGHTS_URL, respond: { json: flightsAnswer([yesterday, today]) } }] });
    const res = await t.json<FlightStatus>('GET', '/api/flights/status?ident=UA123&date=2026-12-03');
    expect(res.body.flight?.url).toMatch(/UAL123-b$/);
    const other = await t.json<FlightStatus>('GET', '/api/flights/status?ident=UA123&date=2026-12-02');
    expect(other.body.flight?.url).toMatch(/UAL123-a$/);
  });

  it('says not_found when no flight departs that day', async () => {
    t = withKey({ fetchRoutes: [{ match: FLIGHTS_URL, respond: { json: flightsAnswer([]) } }] });
    const res = await t.json<FlightStatus>('GET', '/api/flights/status?ident=UA999&date=2026-12-03');
    expect(res.body).toMatchObject({ state: 'not_found', flight: null });
  });

  it('answers a date beyond the lookahead without spending a call', async () => {
    t = withKey({ fetchRoutes: [found] });
    const res = await t.json<FlightStatus>('GET', '/api/flights/status?ident=UA123&date=2026-12-20');
    expect(res.body).toMatchObject({ state: 'too_early', availableFrom: '2026-12-17T10:00:00Z' });
    expect(calls()).toHaveLength(0);
  });

  it('maps a refused key, a rate limit (with cooldown) and server errors', async () => {
    t = withKey({ fetchRoutes: [{ match: FLIGHTS_URL, respond: { status: 403, json: {} }, times: 1 }] });
    const refused = await t.json<ErrorBody>('GET', '/api/flights/status?ident=UA1&date=2026-12-03');
    expect(refused.status).toBe(409);
    expect(refused.body.error.details?.reason).toBe('token_rejected');

    t.ctx.fakeFetch?.add({ match: FLIGHTS_URL, respond: { status: 429, headers: { 'Retry-After': '30' } }, times: 1 });
    const limited = await t.json<ErrorBody>('GET', '/api/flights/status?ident=UA2&date=2026-12-03');
    expect(limited.status).toBe(429);
    expect(limited.res.headers.get('retry-after')).toBe('30');
    const before = calls().length;
    const cooled = await t.json<ErrorBody>('GET', '/api/flights/status?ident=UA3&date=2026-12-03');
    expect(cooled.status).toBe(429);
    expect(calls()).toHaveLength(before);

    t.clock.now = NOW + 31_000;
    t.ctx.fakeFetch?.add({ match: FLIGHTS_URL, respond: { status: 503, text: 'down' } });
    const down = await t.json<ErrorBody>('GET', '/api/flights/status?ident=UA4&date=2026-12-03');
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('provider_error');
    expect(health()?.status).toBe('failing');
  });

  it('refuses bad flight numbers and dates', async () => {
    t = withKey();
    expect((await t.json('GET', '/api/flights/status?ident=hello&date=2026-12-03')).status).toBe(422);
    expect((await t.json('GET', '/api/flights/status?ident=UA1&date=tomorrow')).status).toBe(422);
  });
});

describe('aeroapi mapping', () => {
  it('derives the phase from the actual times', () => {
    expect(mapFlight(upstreamFlight({ actual_out: '2026-12-03T22:05:00Z' }), 'UA1')?.phase).toBe('taxiing');
    expect(mapFlight(upstreamFlight({ actual_off: '2026-12-03T22:20:00Z' }), 'UA1')?.phase).toBe('airborne');
    expect(mapFlight(upstreamFlight({ actual_on: '2026-12-04T00:20:00Z' }), 'UA1')?.phase).toBe('landed');
    expect(mapFlight(upstreamFlight({ actual_in: '2026-12-04T00:30:00Z' }), 'UA1')?.phase).toBe('arrived');
    expect(mapFlight(upstreamFlight({ cancelled: true }), 'UA1')?.phase).toBe('cancelled');
  });

  it('treats the answer as hostile: plain short text, valid zones and links only', () => {
    const f = mapFlight(
      upstreamFlight({
        status: `En Route\u0000‮<script>${'x'.repeat(200)}`,
        gate_origin: 'B32 and a very long gate name',
        fa_flight_id: '../../evil',
        origin: { code: 'KDEN', code_iata: 'DEN', timezone: 'Not/A Zone!', name: 'Denver' },
        progress_percent: 250,
      }),
      'UA1',
    );
    expect(f?.statusText.length).toBeLessThanOrEqual(80);
    expect(f?.statusText).not.toMatch(/[\u0000‮]/);
    expect(f?.departure.gate?.length).toBeLessThanOrEqual(12);
    expect(f?.url).toBeNull();
    expect(f?.origin?.timezone).toBeNull();
    expect(f?.progressPercent).toBe(100);
    expect(text('   ')).toBeNull();
  });

  it('covers every zone on the date and stays inside what AeroAPI accepts', () => {
    expect(flightWindow('2026-12-03', NOW)).toEqual({ kind: 'ok', start: '2026-12-02T10:00:00Z', end: '2026-12-04T12:00:00Z' });
    expect(flightWindow('2026-12-05', NOW)).toEqual({ kind: 'ok', start: '2026-12-04T10:00:00Z', end: '2026-12-05T11:59:00Z' });
    // Dec 6 is partly in range (departures in far-east zones); Dec 7 is not.
    expect(flightWindow('2026-12-06', NOW)).toEqual({ kind: 'ok', start: '2026-12-05T10:00:00Z', end: '2026-12-05T11:59:00Z' });
    expect(flightWindow('2026-12-07', NOW).kind).toBe('too_early');
    expect(flightWindow('2026-11-01', NOW).kind).toBe('too_old');
  });
});
