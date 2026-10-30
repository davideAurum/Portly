import type { ReactNode } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarEvent, EventsResponse } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { account, settings } from '../../test/fixtures.ts';
import { mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { calendarConfigSchema, type CalendarConfig } from './index.ts';
import CalendarSettings from './Settings.tsx';
import CalendarWidget from './Widget.tsx';

/** Local wall time (tests do not depend on the machine's zone). */
function at(d: number, h: number, m = 0): string {
  return new Date(2026, 8, d, h, m).toISOString();
}

const NOW = new Date(2026, 8, 25, 12, 0);

function cal(id: string, patch: Partial<Calendar> = {}): Calendar {
  return {
    id,
    accountId: 'g1',
    source: 'google',
    name: id === 'work' ? 'Work' : 'Personal',
    color: id === 'work' ? '#ef4444' : '#3b82f6',
    writable: true,
    providerWritable: true,
    userReadOnly: false,
    visible: true,
    isPrimary: id !== 'work',
    sort: 0,
    displayUrl: null,
    lastSyncedAt: '2026-09-25T09:55:00.000Z',
    lastError: null,
    ...patch,
  };
}

function ev(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    calendarId: 'personal',
    title: id,
    location: null,
    description: null,
    start: at(25, 15),
    end: at(25, 16),
    allDay: false,
    timezone: 'Europe/Berlin',
    status: 'confirmed',
    recurring: false,
    seriesId: null,
    htmlUrl: null,
    meetingUrl: null,
    editable: true,
    ...patch,
  };
}

const EVENTS: CalendarEvent[] = [
  ev('Standup', {
    calendarId: 'work',
    start: at(25, 9),
    end: at(25, 9, 15),
    recurring: true,
    seriesId: 's1',
    htmlUrl: 'https://www.google.com/calendar/event?eid=abc',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
  }),
  ev('Dentist', {
    location: 'Hauptstraße 1',
    description: 'Bring card. Portal: https://example.com/portal, not javascript:alert(1)',
    htmlUrl: 'javascript:alert(1)',
  }),
  ev('Vacation', { allDay: true, start: '2026-09-26', end: '2026-09-29' }),
  ev('Declined thing', { start: at(26, 10), end: at(26, 11), status: 'declined' }),
];

function Frame({ children, actionsTarget }: { children: ReactNode; actionsTarget: HTMLElement }) {
  const value: WidgetFrameContextValue = { instanceId: 'w-cal', title: 'Calendar', openSettings: () => {}, canOpenSettings: true, actionsTarget };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function config(patch: Partial<CalendarConfig> = {}): CalendarConfig {
  return { ...calendarConfigSchema.parse({}), ...patch };
}

function renderCalendar(opts: { calendars?: Calendar[]; events?: CalendarEvent[]; mocks?: Record<string, ApiMock>; config?: Partial<CalendarConfig>; accounts?: ReturnType<typeof account>[] } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const header = document.createElement('div');
  document.body.append(header);
  const events = opts.events ?? EVENTS;
  const result = renderWithProviders(
    <Frame actionsTarget={header}>
      <CalendarWidget instanceId="w-cal" config={config(opts.config)} setConfig={async () => {}} size={{ w: 4, h: 8 }} editMode={false} />
    </Frame>,
    {
      apiMocks: {
        'GET /api/settings': settings(),
        'GET /api/accounts': opts.accounts ?? [account({ id: 'g1', label: 'Personal Gmail' })],
        'GET /api/calendar/calendars': opts.calendars ?? [cal('personal'), cal('work')],
        'GET /api/calendar/events': (req: MockRequest): EventsResponse => {
          const q = new URLSearchParams(req.search);
          return { events, window: { from: q.get('from')!, to: q.get('to')! } };
        },
        ...opts.mocks,
      },
    },
  );
  return { ...result, header };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarWidget — agenda', () => {
  it('groups events by day with sticky headers, an all-day row and hides declined events', async () => {
    const { requestsTo } = renderCalendar();
    const today = await screen.findByRole('region', { name: /^Today, / });
    expect(within(today).getByRole('button', { name: /^Standup, / })).toBeInTheDocument();
    expect(within(today).getByRole('button', { name: /^Dentist, / })).toBeInTheDocument();
    // Now (12:00) sits between Standup (9:00) and Dentist (15:00).
    const items = within(today).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    const tomorrow = screen.getByRole('region', { name: /^Tomorrow, / });
    expect(within(tomorrow).getByRole('button', { name: /^Vacation, / })).toHaveTextContent('Day 1/3');
    expect(screen.queryByText('Declined thing')).not.toBeInTheDocument();

    const [req] = requestsTo('GET /api/calendar/events');
    const q = new URLSearchParams(req!.search);
    expect(q.get('from')).toBe('2026-09-25');
    expect(q.get('to')).toBe('2026-10-02');
    expect(q.get('tz')).toBeTruthy();
  });

  it('opens a popover with time, calendar, location, linkified description, Join and provider links', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /^Dentist, / }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Dentist' })).toBeInTheDocument();
    expect(within(dialog).getByText('Hauptstraße 1')).toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: 'https://example.com/portal' });
    expect(link).toHaveAttribute('href', 'https://example.com/portal');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(dialog).getAllByRole('link')).toHaveLength(1); // the javascript: htmlUrl and text never become links
    expect(within(dialog).getByText(/Personal/)).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /^Standup, / }));
    const standup = await screen.findByRole('dialog');
    expect(within(standup).getByRole('link', { name: /Open in Google Calendar/ })).toHaveAttribute('href', 'https://www.google.com/calendar/event?eid=abc');
    await user.click(within(standup).getByRole('button', { name: 'Join' }));
    expect(open).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij', '_blank', 'noopener,noreferrer');
  });

  it('shows the not-configured state with links to accounts and calendar settings', async () => {
    renderCalendar({ calendars: [], accounts: [], mocks: { 'GET /api/calendar/events': mockResponse(409, { error: { code: 'not_configured', message: 'No calendars yet.' } }) } });
    expect(await screen.findByText('No calendars yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect an account/ })).toHaveAttribute('href', '#/settings/accounts');
    expect(screen.getByRole('link', { name: /Add an ICS feed/ })).toHaveAttribute('href', '#/settings/calendars?focus=ics');
  });

  it('offers only Outlook.com in the not-configured state of the browser-only build (no ICS feeds there)', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    try {
      renderCalendar({ calendars: [], accounts: [], mocks: { 'GET /api/calendar/events': mockResponse(409, { error: { code: 'not_configured', message: 'No calendars yet.' } }) } });
      expect(await screen.findByText('No calendars yet')).toBeInTheDocument();
      expect(screen.getByText('Connect Outlook.com to see its calendars here.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Connect Outlook\.com/ })).toHaveAttribute('href', '#/settings/accounts');
      expect(screen.queryByRole('link', { name: /Add an ICS feed/ })).not.toBeInTheDocument();
    } finally {
      setCapabilitiesForTests(null);
    }
  });

  it('waits for a connected account’s first sync, then shows its events as soon as its calendars arrive', async () => {
    let calendars: Calendar[] = [];
    const { queryClient } = renderCalendar({
      mocks: {
        'GET /api/calendar/calendars': () => calendars,
        'GET /api/calendar/events': (req: MockRequest) => {
          if (calendars.length === 0) return mockResponse(409, { error: { code: 'not_configured', message: 'No calendars yet.' } });
          const q = new URLSearchParams(req.search);
          return { events: EVENTS, window: { from: q.get('from')!, to: q.get('to')! } };
        },
      },
    });
    expect(await screen.findByText('Waiting for your calendars')).toBeInTheDocument();
    expect(screen.queryByText('No calendars yet')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Calendar settings' })).toHaveAttribute('href', '#/settings/calendars');

    // The first sync finishes: the next calendar poll brings the calendars; events follow.
    calendars = [cal('personal'), cal('work')];
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'calendars'] });
    expect(await screen.findByRole('button', { name: /^Dentist, / })).toBeInTheDocument();
  });

  it('shows Reconnect (not "connect an account") when a calendar account needs reauth before its first sync', async () => {
    renderCalendar({
      calendars: [],
      accounts: [account({ id: 'g1', label: 'Personal Gmail', status: 'reauth' })],
      mocks: { 'GET /api/calendar/events': mockResponse(409, { error: { code: 'not_configured', message: 'No calendars yet.' } }) },
    });
    expect(await screen.findByText(/Reconnect Personal Gmail/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect an account/ })).not.toBeInTheDocument();
  });

  it('keeps cached events visible with a Reconnect banner when every calendar’s account needs reauth', async () => {
    renderCalendar({ accounts: [account({ id: 'g1', label: 'Personal Gmail', status: 'reauth' })] });
    expect(await screen.findByRole('button', { name: /^Dentist, / })).toBeInTheDocument();
    expect(screen.getByText('Reconnect Personal Gmail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('shows Reconnect when every selected calendar belongs to an account that needs reauth', async () => {
    renderCalendar({ events: [], accounts: [account({ id: 'g1', label: 'Personal Gmail', status: 'reauth' })] });
    expect(await screen.findByText('Reconnect Personal Gmail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('flags calendars that could not sync, but not calendars with a non-fatal warning', async () => {
    const warned = cal('personal', { lastError: 'Warning: Some repeating events were shortened: 1 event repeats too often, so only the first occurrences are shown.' });
    const first = renderCalendar({ calendars: [warned, cal('work')] });
    expect(await screen.findByRole('button', { name: /^Dentist, / })).toBeInTheDocument();
    expect(within(first.header).queryByRole('link', { name: /could not sync/ })).not.toBeInTheDocument();
    first.unmount();
    first.header.remove();

    const second = renderCalendar({ calendars: [warned, cal('work', { lastError: 'Google Calendar returned an error (503)' })] });
    expect(await within(second.header).findByRole('link', { name: '1 calendar could not sync. Open calendar settings.' })).toBeInTheDocument();
  });
});

describe('CalendarWidget — month view (VIS-1)', () => {
  afterEach(() => vi.useRealTimers());

  it('month chips name their event on hover (they are too small to show much of the title)', async () => {
    renderCalendar({ config: { view: 'month' } });
    const vacation = (await screen.findAllByRole('button', { name: /Vacation/ }))[0]!;
    expect(vacation).toHaveAttribute('title', 'Vacation');
    const standup = screen.getAllByRole('button', { name: /Standup/ })[0]!;
    expect(standup.getAttribute('title')).toMatch(/\d.*Standup$/);
  });
});

describe('CalendarWidget — writes', () => {
  it('validates the event dialog (end after start) and creates the event optimistically', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    const { header } = renderCalendar({
      mocks: {
        'POST /api/calendar/events': (req: MockRequest) => {
          posted.push(req.body);
          const body = req.body as { title: string; start: string; end: string; calendarId: string };
          return mockResponse(201, ev('created-1', { title: body.title, start: new Date(body.start).toISOString(), end: new Date(body.end).toISOString() }));
        },
      },
    });
    await screen.findByRole('button', { name: /^Dentist, / });
    await user.click(within(header).getByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    await user.type(within(dialog).getByLabelText(/Title/), 'Lunch with Sam');
    expect(within(dialog).getByLabelText(/Calendar/)).toHaveValue('personal'); // primary (no default configured)
    const endTime = within(dialog).getByLabelText('End time');
    await user.clear(endTime);
    await user.type(endTime, '12:30');
    const startTime = within(dialog).getByLabelText('Start time');
    expect(startTime).toHaveValue('13:00');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    expect(await within(dialog).findByText('The event must end after it starts.')).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    await user.clear(endTime);
    await user.type(endTime, '14:15');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ calendarId: 'personal', title: 'Lunch with Sam', allDay: false });
    const body = posted[0] as { start: string; end: string; timezone: string };
    expect(Date.parse(body.start)).toBe(new Date(2026, 8, 25, 13).getTime());
    expect(Date.parse(body.end)).toBe(new Date(2026, 8, 25, 14, 15).getTime());
    expect(body.timezone).toBeTruthy();
    expect(await screen.findByText(/“Lunch with Sam” added/)).toBeInTheDocument();
  });

  it('groups the new-event calendar list by account', async () => {
    const user = userEvent.setup();
    const { header } = renderCalendar({});
    await screen.findByRole('button', { name: /^Dentist, / });
    await user.click(within(header).getByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    const select = within(dialog).getByLabelText(/Calendar/);
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((g) => g.label)).toEqual(['Google: Personal Gmail']);
    expect(within(groups[0]!).getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('edits without re-sending unchanged times (the event keeps its own time zone); Undo restores', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    renderCalendar({
      mocks: {
        'PATCH /api/calendar/events/:id': (req: MockRequest) => {
          patches.push(req.body);
          const body = req.body as { title: string };
          return ev('Dentist', { title: body.title, location: 'Hauptstraße 1', description: 'Bring card. Portal: https://example.com/portal, not javascript:alert(1)' });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: /^Dentist, / }));
    await user.click(await screen.findByRole('button', { name: 'Edit event' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit event' });
    const title = within(dialog).getByLabelText(/Title/);
    await user.clear(title);
    await user.type(title, 'Dentist (Dr. Weber)');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ title: 'Dentist (Dr. Weber)', location: 'Hauptstraße 1', description: 'Bring card. Portal: https://example.com/portal, not javascript:alert(1)' });

    const toastItem = (await screen.findByText('“Dentist (Dr. Weber)” updated')).closest('li')!;
    fireEvent.click(within(toastItem).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ title: 'Dentist', location: 'Hauptstraße 1', description: 'Bring card. Portal: https://example.com/portal, not javascript:alert(1)' });
  });

  it('rolls back a write refused with reauth_required and refreshes the accounts (Reconnect appears)', async () => {
    const user = userEvent.setup();
    let status: 'ok' | 'reauth' = 'ok';
    const { requestsTo } = renderCalendar({
      mocks: {
        'GET /api/accounts': () => [account({ id: 'g1', label: 'Personal Gmail', status })],
        'DELETE /api/calendar/events/:id': () => {
          status = 'reauth';
          return mockResponse(409, { error: { code: 'reauth_required', message: 'Reconnect required', accountId: 'g1' } });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: /^Dentist, / }));
    await user.click(await screen.findByRole('button', { name: 'Delete event' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete “Dentist”?' });
    const before = requestsTo('GET /api/accounts').length;
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requestsTo('GET /api/accounts').length).toBeGreaterThan(before));
    if (screen.queryByRole('dialog', { name: 'Delete “Dentist”?' })) await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: /^Dentist, / })).toBeInTheDocument(); // rolled back
    expect(await screen.findByText('Reconnect Personal Gmail')).toBeInTheDocument();
  });

  it('deletes after confirmation from the popover', async () => {
    const user = userEvent.setup();
    const { requestsTo } = renderCalendar({ mocks: { 'DELETE /api/calendar/events/:id': mockResponse(204) } });
    await user.click(await screen.findByRole('button', { name: /^Dentist, / }));
    await user.click(await screen.findByRole('button', { name: 'Delete event' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete “Dentist”?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requestsTo('DELETE /api/calendar/events/Dentist')).toHaveLength(1));
    expect(await screen.findByText('“Dentist” deleted')).toBeInTheDocument();
  });

  it('notes that editing a recurring instance changes one occurrence and links to the series', async () => {
    const user = userEvent.setup();
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /^Standup, / }));
    await user.click(await screen.findByRole('button', { name: 'Edit event' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit event' });
    expect(within(dialog).getByText('This changes only this occurrence.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Edit series in Google Calendar/ })).toHaveAttribute('href', 'https://www.google.com/calendar/event?eid=abc');
    expect(within(dialog).getByLabelText(/Title/)).toHaveValue('Standup');
  });
});

describe('CalendarSettings (widget)', () => {
  it('switches between visible calendars and an explicit selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<CalendarSettings value={config()} onChange={onChange} />, {
      apiMocks: { 'GET /api/calendar/calendars': [cal('personal'), cal('work', { visible: false })], 'GET /api/accounts': [account({ id: 'g1', label: 'Personal Gmail' })] },
    });
    await user.click(await screen.findByRole('switch', { name: /Use the calendars marked visible/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ calendarIds: ['personal'] }));
  });
});
