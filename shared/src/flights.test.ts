import { describe, expect, it } from 'vitest';
import { FlightStatusQuerySchema, detectFlightsInText, flightRefreshMs, normalizeFlightIdent, type FlightInfo, type FlightStatus } from './flights.ts';

describe('normalizeFlightIdent', () => {
  it('accepts IATA and ICAO flight numbers in the ways people write them', () => {
    expect(normalizeFlightIdent('UA123')).toBe('UA123');
    expect(normalizeFlightIdent(' ua 123 ')).toBe('UA123');
    expect(normalizeFlightIdent('B6-615')).toBe('B6615');
    expect(normalizeFlightIdent('UAL1234')).toBe('UAL1234');
    expect(normalizeFlightIdent('9W1A')).toBe('9W1A');
  });

  it('refuses what is not a flight number', () => {
    for (const bad of ['', '123', 'UA', 'UA12345', '12 34', 'https://x', 'UA 1 2 3 4 5']) expect(normalizeFlightIdent(bad)).toBeNull();
  });

  it('is what the status query validates', () => {
    expect(FlightStatusQuerySchema.parse({ ident: 'dl 42', date: '2026-12-03' })).toEqual({ ident: 'DL42', date: '2026-12-03' });
    expect(FlightStatusQuerySchema.safeParse({ ident: 'DL42', date: '2026-13-03' }).success).toBe(false);
  });
});

describe('detectFlightsInText', () => {
  it('finds flight numbers in typical calendar titles', () => {
    expect(detectFlightsInText('Flight to Denver (UA 123)')).toEqual(['UA123']);
    expect(detectFlightsInText('DL1234 ATL → SEA')).toEqual(['DL1234']);
    expect(detectFlightsInText('United Airlines flight 456 to Chicago')).toEqual(['UA456']);
    expect(detectFlightsInText('JetBlue #615')).toEqual(['B6615']);
    expect(detectFlightsInText('Flight: XQ 77')).toEqual(['XQ77']);
    expect(detectFlightsInText('UA0012')).toEqual(['UA12']);
  });

  it('ignores ordinary text that only looks like a code', () => {
    expect(detectFlightsInText('Q3 2026 planning')).toEqual([]);
    expect(detectFlightsInText('Flight review Q3 2026')).toEqual([]);
    expect(detectFlightsInText('Delta 5 review')).toEqual([]);
    expect(detectFlightsInText('Room XQ 77')).toEqual([]);
    expect(detectFlightsInText('ua 123')).toEqual([]);
    expect(detectFlightsInText('MP3 player 2000')).toEqual([]);
  });
});

function flight(patch: Partial<FlightInfo>): FlightInfo {
  const end = { scheduled: null, estimated: null, actual: null, runway: null, gate: null, terminal: null };
  return {
    ident: 'UA123',
    operator: 'UA',
    origin: null,
    destination: null,
    departure: end,
    arrival: end,
    phase: 'scheduled',
    statusText: '',
    progressPercent: null,
    departureDelayMin: null,
    arrivalDelayMin: null,
    baggageClaim: null,
    aircraftType: null,
    url: null,
    ...patch,
  };
}

describe('flightRefreshMs', () => {
  const now = Date.parse('2026-12-03T12:00:00Z');
  const min = 60_000;
  const found = (f: FlightInfo): Pick<FlightStatus, 'state' | 'flight' | 'availableFrom'> => ({ state: 'found', flight: f, availableFrom: null });
  const leaving = (iso: string) => flight({ departure: { scheduled: iso, estimated: null, actual: null, runway: null, gate: null, terminal: null } });

  it('asks rarely while a flight is far off and often around departure', () => {
    expect(flightRefreshMs(found(leaving('2026-12-05T08:00:00Z')), now)).toBe(180 * min);
    expect(flightRefreshMs(found(leaving('2026-12-03T22:00:00Z')), now)).toBe(60 * min);
    expect(flightRefreshMs(found(leaving('2026-12-03T14:00:00Z')), now)).toBe(15 * min);
    expect(flightRefreshMs(found(leaving('2026-12-03T12:30:00Z')), now)).toBe(5 * min);
  });

  it('asks every 10 minutes in cruise, 5 near arrival, and rarely once it is over', () => {
    const arrival = (iso: string) => ({ scheduled: iso, estimated: null, actual: null, runway: null, gate: null, terminal: null });
    expect(flightRefreshMs(found(flight({ phase: 'airborne', arrival: arrival('2026-12-03T15:00:00Z') })), now)).toBe(10 * min);
    expect(flightRefreshMs(found(flight({ phase: 'airborne', arrival: arrival('2026-12-03T12:30:00Z') })), now)).toBe(5 * min);
    expect(flightRefreshMs(found(flight({ phase: 'arrived' })), now)).toBe(360 * min);
    expect(flightRefreshMs(found(flight({ phase: 'cancelled' })), now)).toBe(360 * min);
  });

  it('waits for the lookahead window before asking about a far-off date', () => {
    expect(flightRefreshMs({ state: 'too_early', flight: null, availableFrom: '2026-12-03T14:00:00Z' }, now)).toBe(120 * min);
    expect(flightRefreshMs({ state: 'too_early', flight: null, availableFrom: '2026-12-20T00:00:00Z' }, now)).toBe(720 * min);
    expect(flightRefreshMs({ state: 'too_early', flight: null, availableFrom: '2026-12-03T11:00:00Z' }, now)).toBe(60 * min);
  });
});
