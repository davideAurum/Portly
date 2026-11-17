import type { ReactNode } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, FlightInfo, FlightStatus } from '@portly/shared';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { mockError, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { flightsConfigSchema, type FlightsConfig } from './index.ts';
import FlightsWidget from './Widget.tsx';

const NOW = Date.parse('2026-12-03T18:00:00Z');

function info(patch: Partial<FlightInfo> = {}): FlightInfo {
  const end = { scheduled: null, estimated: null, actual: null, runway: null, gate: null, terminal: null };
  return {
    ident: 'UA123',
    operator: 'UA',
    origin: { code: 'DEN', name: 'Denver Intl', city: 'Denver', timezone: 'America/Denver' },
    destination: { code: 'SFO', name: 'San Francisco Intl', city: 'San Francisco', timezone: 'America/Los_Angeles' },
    departure: { ...end, scheduled: '2026-12-03T22:00:00.000Z', estimated: '2026-12-03T22:40:00.000Z', gate: 'B32' },
    arrival: { ...end, scheduled: '2026-12-04T00:30:00.000Z', terminal: '3', gate: 'F12' },
    phase: 'scheduled',
    statusText: 'Scheduled / Delayed',
    progressPercent: 0,
    departureDelayMin: 40,
    arrivalDelayMin: 30,
    baggageClaim: null,
    aircraftType: 'B739',
    url: 'https://www.flightaware.com/live/flight/id/UAL123-1',
    ...patch,
  };
}

function status(ident: string, date: string, flight: FlightInfo | null, extra: Partial<FlightStatus> = {}): FlightStatus {
  return { ident, date, state: flight ? 'found' : 'not_found', flight, availableFrom: null, fetchedAt: new Date(NOW).toISOString(), ...extra };
}

function event(title: string, start: string): CalendarEvent {
  return {
    id: `e-${title}`,
    calendarId: 'cal-1',
    title,
    location: null,
    description: null,
    start,
    end: start,
    allDay: false,
    timezone: 'America/Denver',
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    editable: false,
  };
}

let actionsHost: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  actionsHost = document.createElement('div');
  document.body.appendChild(actionsHost);
});
afterEach(() => {
  actionsHost.remove();
  vi.useRealTimers();
});

const openSettings = vi.fn();
function frame(children: ReactNode) {
  const value: WidgetFrameContextValue = { instanceId: 'w1', title: 'Flights', openSettings, canOpenSettings: true, actionsTarget: actionsHost };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function renderWidget(options: { config?: Partial<FlightsConfig>; status?: ApiMock; key?: ApiMock; events?: CalendarEvent[]; size?: { w: number; h: number } } = {}) {
  const setConfig = vi.fn(async () => {});
  const config = flightsConfigSchema.parse({ fromCalendar: false, ...options.config });
  const result = renderWithProviders(frame(<FlightsWidget instanceId="w1" config={config} setConfig={setConfig} size={options.size ?? { w: 4, h: 5 }} editMode={false} />), {
    apiMocks: {
      'GET /api/flights/key': options.key ?? { configured: true },
      'GET /api/flights/status': options.status ?? ((req: MockRequest) => {
        const q = new URLSearchParams(req.search);
        return status(q.get('ident')!, q.get('date')!, info({ ident: q.get('ident')! }));
      }),
      'GET /api/calendar/events': { events: options.events ?? [], window: { from: '2026-12-02', to: '2027-01-02' } },
    },
  });
  return Object.assign(result, { setConfig });
}

describe('Flights widget', () => {
  it('asks for the key when FlightAware is not connected, without asking for flights', async () => {
    renderWidget({ key: { configured: false }, config: { flights: [{ ident: 'UA123', date: '2026-12-03' }] } });
    expect(await screen.findByText('Connect FlightAware')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up FlightAware/ })).toHaveAttribute('href', '#/settings/accounts?focus=flightaware');
  });

  it('offers to add a flight when there is none', async () => {
    renderWidget();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Add a flight' }));
    expect(openSettings).toHaveBeenCalledWith({ focus: 'flights-add' });
  });

  it('shows route, status, times in each airport’s zone, gate and terminal', async () => {
    renderWidget({ config: { flights: [{ ident: 'UA123', date: '2026-12-03' }] } });
    const list = await screen.findByRole('list', { name: 'Flights' });
    const row = within(list).getByRole('link', { name: /UA123/ });
    expect(row).toHaveAttribute('href', 'https://www.flightaware.com/live/flight/id/UAL123-1');
    expect(row).toHaveTextContent('DEN → SFO');
    expect(row).toHaveTextContent('Delayed 40m');
    // 22:40 UTC is 3:40 PM in Denver; 00:30 UTC is 4:30 PM in San Francisco.
    expect(row.textContent).toMatch(/3:40\s?PM/);
    expect(row.textContent).toMatch(/4:30\s?PM/);
    expect(row).toHaveTextContent('Gate B32');
    expect(row).toHaveTextContent('Terminal 3 · Gate F12');
  });

  it('shows progress in the air and says when tracking starts for far-off flights', async () => {
    renderWidget({
      config: { flights: [{ ident: 'DL42', date: '2026-12-03' }, { ident: 'BA117', date: '2026-12-20' }] },
      status: (req: MockRequest) => {
        const q = new URLSearchParams(req.search);
        return q.get('ident') === 'DL42'
          ? status('DL42', '2026-12-03', info({ ident: 'DL42', phase: 'airborne', progressPercent: 60, arrivalDelayMin: 0 }))
          : status('BA117', '2026-12-20', null, { state: 'too_early', availableFrom: '2026-12-17T10:00:00Z' });
      },
    });
    expect(await screen.findByRole('progressbar', { name: 'Flight progress' })).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('In the air')).toBeInTheDocument();
    expect(await screen.findByText(/Tracking starts two days before departure/)).toBeInTheDocument();
  });

  it('tracks flight numbers found in calendar events, and hides one when removed', async () => {
    const { setConfig } = renderWidget({ config: { fromCalendar: true }, events: [event('Flight to SFO (UA 123)', '2026-12-03T22:00:00Z'), event('Team sync', '2026-12-04T16:00:00Z')] });
    expect(await screen.findByRole('link', { name: /UA123/ })).toBeInTheDocument();
    expect(screen.getByLabelText('From your calendar')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop tracking UA123 on 2026-12-03' }));
    expect(setConfig).toHaveBeenCalledWith({ dismissed: ['UA123@2026-12-03'] });
  });

  it('removes a typed-in flight from the config', async () => {
    const { setConfig } = renderWidget({ config: { flights: [{ ident: 'UA123', date: '2026-12-03' }] } });
    await screen.findByRole('link', { name: /UA123/ });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop tracking UA123 on 2026-12-03' }));
    expect(setConfig).toHaveBeenCalledWith({ flights: [] });
  });

  it('drops flights that arrived more than six hours ago', async () => {
    renderWidget({
      config: { flights: [{ ident: 'UA9', date: '2026-12-03' }] },
      status: status('UA9', '2026-12-03', info({ ident: 'UA9', phase: 'arrived', arrival: { scheduled: null, estimated: null, actual: '2026-12-03T10:00:00.000Z', runway: null, gate: null, terminal: null } })),
    });
    expect(await screen.findByText('No flights to track')).toBeInTheDocument();
  });

  it('shows a refused key as a setup problem', async () => {
    renderWidget({
      config: { flights: [{ ident: 'UA123', date: '2026-12-03' }] },
      status: mockError(409, 'not_configured', 'FlightAware refused the saved key.', { details: { reason: 'token_rejected' } }),
    });
    expect(await screen.findByText('FlightAware key refused')).toBeInTheDocument();
  });

  it('normalizes typed flight numbers in the config and drops invalid entries', () => {
    const config = flightsConfigSchema.parse({ flights: [{ ident: 'ua 12', date: '2026-12-03' }, { ident: 'nope', date: '2026-12-03' }, 'junk'] });
    expect(config.flights).toEqual([{ ident: 'UA12', date: '2026-12-03' }]);
    expect(flightsConfigSchema.parse({ flights: 'x', dismissed: 5 })).toEqual({ flights: [], fromCalendar: true, dismissed: [] });
  });
});
