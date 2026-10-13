import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Calendar } from '@homebase/shared';
import CalendarsSettings from '../../settings/sections/Calendars.tsx';
import { account, settings } from '../../test/fixtures.ts';
import { mockError, mockResponse, renderWithProviders, type MockRequest } from '../../test/render.tsx';

function cal(id: string, patch: Partial<Calendar> = {}): Calendar {
  return {
    id,
    accountId: 'g1',
    source: 'google',
    name: id,
    color: '#3b82f6',
    writable: true,
    providerWritable: true,
    userReadOnly: false,
    visible: true,
    isPrimary: false,
    sort: 0,
    displayUrl: null,
    lastSyncedAt: '2026-09-25T10:00:00.000Z',
    lastError: null,
    ...patch,
  };
}

const CALENDARS = [
  cal('Personal', { isPrimary: true, color: '#aa00bb', colorOverride: '#aa00bb' }),
  cal('Holidays', { providerWritable: false, writable: false, lastError: 'Google Calendar returned an error (503)' }),
  cal('Proton', { accountId: null, source: 'ics', providerWritable: false, writable: false, displayUrl: 'calendar.proton.me' }),
  cal('Team', {
    accountId: null,
    source: 'ics',
    providerWritable: false,
    writable: false,
    displayUrl: 'feeds.example.com',
    lastError: 'Warning: Some repeating events were shortened: 1 event repeats too often, so only the first occurrences are shown.',
  }),
];

function renderSection(extra: Record<string, unknown> = {}) {
  return renderWithProviders(<CalendarsSettings />, {
    apiMocks: {
      'GET /api/settings': settings(),
      'GET /api/accounts': [account({ id: 'g1', label: 'Personal Gmail' }), account({ id: 'i1', kind: 'imap', label: 'Mail only', capabilities: ['mail'], enabledCapabilities: ['mail'] })],
      'GET /api/calendar/calendars': CALENDARS,
      ...extra,
    },
  });
}

describe('Settings › Calendars deep link (UX-10)', () => {
  it('"Add an ICS feed" (#/settings/calendars?focus=ics) starts in the link field', async () => {
    window.history.replaceState(null, '', '/#/settings/calendars?focus=ics');
    renderSection();
    const link = await screen.findByRole('textbox', { name: /Calendar link/ });
    await waitFor(() => expect(link).toHaveFocus());
    expect(window.location.hash).toBe('#/settings/calendars');
  });
});

describe('Settings › Calendars', () => {
  it('groups calendars by account, shows last errors and the ICS host only', async () => {
    renderSection();
    const gmail = await screen.findByRole('list', { name: 'Personal Gmail calendars' });
    expect(within(gmail).getByText('Personal')).toBeInTheDocument();
    expect(within(gmail).getByText('Google Calendar returned an error (503)')).toBeInTheDocument();
    expect(screen.queryByText('Mail only')).not.toBeInTheDocument();
    const ics = screen.getByRole('list', { name: 'ICS subscriptions' });
    expect(within(ics).getByText('calendar.proton.me')).toBeInTheDocument();
    // Read-only at the provider: no "Read-only here" toggle.
    expect(within(gmail).getAllByRole('checkbox', { name: 'Read-only here' })).toHaveLength(1);
  });

  it('shows a non-fatal sync warning as a warning, not as a failed calendar', async () => {
    renderSection();
    const ics = await screen.findByRole('list', { name: 'ICS subscriptions' });
    const note = within(ics).getByText(/^Some repeating events were shortened/);
    expect(note.closest('p')?.textContent).toMatch(/^Warning: Some repeating events were shortened/);
    // Counted apart from the one real failure (Holidays); the row shows a sync time, not "Never synced".
    expect(screen.getByText(/1 calendar has a sync problem/)).toBeInTheDocument();
    expect(screen.getByText(/1 calendar has a warning/)).toBeInTheDocument();
    expect(within(note.closest('li')!).getByText(/^Synced/)).toBeInTheDocument();
  });

  it('shows whether a color is user-set and resets it to the provider color', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    renderSection({
      'PATCH /api/calendar/calendars/:id': (req: MockRequest) => {
        patches.push({ id: req.params.id, ...(req.body as object) });
        return { ...CALENDARS[0]!, color: '#9fe1e7', colorOverride: null };
      },
    });
    const gmail = await screen.findByRole('list', { name: 'Personal Gmail calendars' });
    expect(within(gmail).getAllByText('Custom color')).toHaveLength(1);
    expect(within(gmail).getByRole('button', { name: 'Personal color (custom): #aa00bb' })).toBeInTheDocument();
    await user.click(within(gmail).getByRole('button', { name: 'Reset Personal to the Google color' }));
    await waitFor(() => expect(patches).toEqual([{ id: 'Personal', colorOverride: null }]));
    await waitFor(() => expect(within(gmail).queryByText('Custom color')).not.toBeInTheDocument());
    expect(within(gmail).getByRole('button', { name: 'Personal color: #9fe1e7' })).toBeInTheDocument();
  });

  it('offers Sync now while a connected account has no calendars yet (a failed first sync can be retried)', async () => {
    const user = userEvent.setup();
    const { requestsTo } = renderSection({ 'GET /api/calendar/calendars': [], 'POST /api/calendar/sync': [] });
    const button = await screen.findByRole('button', { name: 'Sync now' });
    expect(button).toBeEnabled();
    expect(screen.getByText('Waiting for the first sync…')).toBeInTheDocument();
    await user.click(button);
    await waitFor(() => expect(requestsTo('POST /api/calendar/sync')).toHaveLength(1));
  });

  it('toggles visibility and read-only with PATCH', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    renderSection({
      'PATCH /api/calendar/calendars/:id': (req: MockRequest) => {
        patches.push({ id: req.params.id, ...(req.body as object) });
        return { ...CALENDARS[0]!, ...(req.body as object) };
      },
    });
    const gmail = await screen.findByRole('list', { name: 'Personal Gmail calendars' });
    const [visible] = within(gmail).getAllByRole('switch', { name: 'Visible' });
    await user.click(visible!);
    await user.click(within(gmail).getByRole('checkbox', { name: 'Read-only here' }));
    await waitFor(() => expect(patches).toEqual([{ id: 'Personal', visible: false }, { id: 'Personal', userReadOnly: true }]));
  });

  it('adds an ICS subscription and shows the server’s URL error on the field', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let fail = true;
    renderSection({
      'POST /api/calendar/ics': (req: MockRequest) => {
        bodies.push(req.body);
        if (fail) {
          return mockError(422, 'validation_failed', 'This address did not return a calendar', {
            details: [{ path: 'url', message: 'This address did not return a calendar: The data is not a valid iCalendar file', code: 'custom' }],
          });
        }
        return mockResponse(201, cal('New', { accountId: null, source: 'ics', displayUrl: 'example.com' }));
      },
    });
    await screen.findByRole('list', { name: 'ICS subscriptions' });
    const form = screen.getByRole('form', { name: 'Add an ICS subscription' });
    await user.click(within(form).getByRole('button', { name: 'Add subscription' }));
    expect(await within(form).findByText('Enter a name (up to 200 characters).')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);

    await user.type(within(form).getByLabelText(/Name/), 'Team');
    await user.type(within(form).getByLabelText(/Calendar link/), 'webcal://example.com/team.ics');
    await user.click(within(form).getByRole('button', { name: 'Add subscription' }));
    expect(await within(form).findByText(/did not return a calendar: The data is not a valid iCalendar file/)).toBeInTheDocument();
    expect(bodies[0]).toEqual({ name: 'Team', url: 'https://example.com/team.ics', color: null });

    fail = false;
    await user.click(within(form).getByRole('button', { name: 'Add subscription' }));
    expect(await screen.findByText('New added.')).toBeInTheDocument();
  });

  it('changes the sync interval and syncs now', async () => {
    const user = userEvent.setup();
    const { requestsTo } = renderSection({
      'PATCH /api/settings': (req: MockRequest) => ({ ...settings(), calendar: { syncIntervalMin: 15, defaultCalendarId: null, ...(req.body as { calendar: object }).calendar } }),
      'POST /api/calendar/sync': CALENDARS,
    });
    const interval = await screen.findByLabelText('Sync interval');
    await waitFor(() => expect(interval).toBeEnabled());
    await user.selectOptions(interval, '15');
    await waitFor(() => expect(requestsTo('PATCH /api/settings')[0]?.body).toEqual({ calendar: { syncIntervalMin: 15 } }));
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(requestsTo('POST /api/calendar/sync')).toHaveLength(1));
    expect(await screen.findByText(/1 calendar has a problem/)).toBeInTheDocument();
  });
});
