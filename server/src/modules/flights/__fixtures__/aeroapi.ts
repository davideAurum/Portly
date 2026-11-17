/**
 * AeroAPI answers for the flights tests, shaped like the v4 OpenAPI spec (4.17). Fictional
 * flights; the keys are plausible fakes.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import * as flights from '../index.ts';

export const KEY = `test${'a'.repeat(28)}`;
export const OTHER_KEY = `test${'b'.repeat(28)}`;

export const FLIGHTS_URL = /^https:\/\/aeroapi\.flightaware\.com\/aeroapi\/flights\//;
export const USAGE_URL = 'https://aeroapi.flightaware.com/aeroapi/account/usage';

/** 2026-12-03 12:00 UTC: the tests' "now". */
export const NOW = Date.parse('2026-12-03T12:00:00Z');

export function upstreamFlight(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ident: 'UAL123',
    ident_icao: 'UAL123',
    ident_iata: 'UA123',
    fa_flight_id: 'UAL123-1764700000-airline-0042',
    operator: 'UAL',
    operator_iata: 'UA',
    flight_number: '123',
    registration: 'N12345',
    cancelled: false,
    diverted: false,
    origin: { code: 'KDEN', code_icao: 'KDEN', code_iata: 'DEN', timezone: 'America/Denver', name: 'Denver Intl', city: 'Denver', airport_info_url: '/airports/KDEN' },
    destination: { code: 'KSFO', code_icao: 'KSFO', code_iata: 'SFO', timezone: 'America/Los_Angeles', name: 'San Francisco Intl', city: 'San Francisco', airport_info_url: '/airports/KSFO' },
    departure_delay: 600,
    arrival_delay: 300,
    progress_percent: 0,
    status: 'Scheduled / Delayed',
    aircraft_type: 'B739',
    gate_origin: 'B32',
    gate_destination: 'F12',
    terminal_origin: null,
    terminal_destination: '3',
    baggage_claim: null,
    scheduled_out: '2026-12-03T22:00:00Z',
    estimated_out: '2026-12-03T22:10:00Z',
    actual_out: null,
    scheduled_off: '2026-12-03T22:15:00Z',
    estimated_off: '2026-12-03T22:25:00Z',
    actual_off: null,
    scheduled_on: '2026-12-04T00:20:00Z',
    estimated_on: '2026-12-04T00:25:00Z',
    actual_on: null,
    scheduled_in: '2026-12-04T00:30:00Z',
    estimated_in: '2026-12-04T00:35:00Z',
    actual_in: null,
    type: 'Airline',
    ...overrides,
  };
}

export function flightsAnswer(list: unknown[]): unknown {
  return { links: null, num_pages: 1, flights: list };
}

export interface FlightsTestbed {
  ctx: TestContext;
  clock: { now: number };
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response; text: string }>;
  close(): void;
}

export function flightsTestbed(overrides: TestContextOverrides = {}): FlightsTestbed {
  const ctx = createTestContext(overrides);
  const clock = { now: NOW };
  const { app } = createApp(ctx, {
    modules: [{ name: 'flights', prefixes: flights.prefixes, register: (a, c) => flights.register(a, c, { now: () => clock.now }) }],
    webDist: null,
  });
  return {
    ctx,
    clock,
    async json<T>(method: string, path: string, options?: TestRequestOptions) {
      const res = await testRequest(app, method, path, options);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res, text };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}
