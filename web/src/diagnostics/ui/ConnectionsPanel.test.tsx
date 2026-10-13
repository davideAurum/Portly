/**
 * Connections & sync: subjects grouped by account then area with what needs attention first,
 * status pills, the last error with its remedy and troubleshooting anchor while it lasts (not one
 * a stale subject recovered from), "because <account> needs attention" moving focus to that account,
 * jobs with their state and "Run now", the outcome history, and "Show related log lines".
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockError, renderWithProviders } from '../../test/render.tsx';
import { ConnectionsPanel } from './ConnectionsPanel.tsx';
import { diagnosticsSummary, healthEntry, jobInfo, outcomeRow } from './testing.ts';

const SUMMARY = diagnosticsSummary({
  jobs: [jobInfo('calendar:sync'), jobInfo('core:backup', { running: true, stuckForMs: 300_000 }), jobInfo('calendar:ics', { overdue: true })],
  health: [
    healthEntry('account:acc-1', {
      accountId: 'acc-1',
      label: 'Work',
      status: 'failing',
      lastCode: 'invalid_grant',
      lastStatus: 400,
      lastMessage: 'Google refused the refresh token',
      failingSince: '2026-10-11T10:00:00.000Z',
      lastFailAt: '2026-10-11T11:00:00.000Z',
      consecutiveFailures: 4,
    }),
    healthEntry('calendar:cal-1', { accountId: 'acc-1', label: 'Personal', status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:acc-1', lastFailAt: '2026-10-11T11:00:00.000Z' }),
    healthEntry('mail:acc-1', { accountId: 'acc-1', label: 'Work' }),
    // Recovered from a rate limit last week, then went stale: the old error is not its problem.
    healthEntry('feed:abc', {
      label: 'blog.example.org',
      status: 'stale',
      lastCheckedAt: '2026-10-10T08:00:00.000Z',
      expectEveryMs: 3_600_000,
      lastCode: 'rate_limited',
      lastStatus: 429,
      lastMessage: 'The feed host is limiting requests',
      lastFailAt: '2026-10-04T08:00:00.000Z',
      failingSince: null,
    }),
    healthEntry('ics:ics-1', { label: 'School', status: 'stale', lastCheckedAt: '2026-10-10T08:00:00.000Z', lastCode: 'http_error', lastStatus: 503, failingSince: '2026-10-10T07:00:00.000Z' }),
    healthEntry('weather', { status: 'unknown', lastCheckedAt: null, lastOkAt: null, expectEveryMs: null }),
    healthEntry('suggest:google', { expectEveryMs: null }),
  ],
});

function renderPanel(apiMocks: Record<string, unknown> = {}) {
  const onShowLogs = vi.fn();
  const result = renderWithProviders(<ConnectionsPanel summary={SUMMARY} onShowLogs={onShowLogs} />, { apiMocks });
  return { ...result, onShowLogs };
}

describe('ConnectionsPanel', () => {
  it('groups by account then area, attention first, with status pills', () => {
    renderPanel();
    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    // The jobs need attention too (one is stuck, one overdue), so they come before weather and search.
    expect(groups).toEqual(['Work', 'ICS calendars', 'Feeds', 'Scheduled jobs', 'Weather', 'Search suggestions']);
    const work = screen.getByRole('region', { name: 'Work' });
    // Inside the account's group its own subjects are named by what they are.
    expect(within(work).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Account', 'Personal', 'Mail']);
    expect(within(work).getAllByText(/^Failing since /)).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'Feeds' })).getByText(/^Stale — last checked /)).toBeInTheDocument();
    // A job without a health entry: its last run counts as its last check.
    expect(within(screen.getByRole('listitem', { name: 'calendar:ics' })).getByText(/^Stale — last checked /)).toBeInTheDocument();
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByText(/^3 OK · 2 failing · 4 stale · 0 degraded · 1 not checked yet/)).toBeInTheDocument();
  });

  it('shows the last error with its remedy and troubleshooting anchor', () => {
    renderPanel();
    const account = screen.getByRole('listitem', { name: 'Account' });
    expect(within(account).getByText('invalid_grant')).toBeInTheDocument();
    expect(within(account).getByText('HTTP 400')).toBeInTheDocument();
    expect(within(account).getByText('Google refused the refresh token')).toBeInTheDocument();
    expect(within(account).getByText(/The sign-in expired or was revoked at the provider/)).toBeInTheDocument();
    expect(within(account).getByText('troubleshooting.md#invalid_grant')).toBeInTheDocument();
  });

  it('shows a stale subject’s last error only while it was failing when it went stale', () => {
    renderPanel();
    const feed = screen.getByRole('listitem', { name: 'blog.example.org' });
    expect(within(feed).getByText(/^Stale — last checked /)).toBeInTheDocument();
    expect(within(feed).queryByText('rate_limited')).not.toBeInTheDocument();
    expect(within(feed).queryByText('HTTP 429')).not.toBeInTheDocument();
    expect(within(feed).queryByText('The feed host is limiting requests')).not.toBeInTheDocument();
    expect(within(feed).queryByText(/troubleshooting\.md/)).not.toBeInTheDocument();
    const ics = screen.getByRole('listitem', { name: 'School' });
    expect(within(ics).getByText('http_error')).toBeInTheDocument();
    expect(within(ics).getByText('HTTP 503')).toBeInTheDocument();
  });

  it('links a dependent subject to the account it fails because of', async () => {
    renderPanel();
    const personal = screen.getByRole('listitem', { name: 'Personal' });
    expect(within(personal).getByText(/Because/)).toHaveTextContent('Because Work needs attention.');
    await userEvent.setup().click(within(personal).getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('listitem', { name: 'Account' })).toHaveFocus();
  });

  it('lists jobs with their state and runs one now', async () => {
    const { requestsTo } = renderPanel({ 'POST /api/diagnostics/jobs/:name/run': { started: true } });
    const jobs = screen.getByRole('region', { name: 'Scheduled jobs' });
    expect(within(jobs).getByText('Stuck for 5 min')).toBeInTheDocument();
    expect(within(jobs).getByText('Overdue')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(jobs).getByRole('button', { name: 'Run now: calendar:ics' }));
    await waitFor(() => expect(requestsTo('POST /api/diagnostics/jobs/calendar%3Aics/run')).toHaveLength(1));
    expect(await screen.findByText('calendar:ics started.')).toBeInTheDocument();
    // A calendar is synced by calendar:sync, so it can be run from its row too; a feed has no job.
    expect(within(screen.getByRole('listitem', { name: 'Personal' })).getByRole('button', { name: 'Run now: calendar:sync' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'blog.example.org' })).queryByRole('button', { name: /^Run now/ })).not.toBeInTheDocument();
  });

  it('tells when a job cannot be started', async () => {
    renderPanel({ 'POST /api/diagnostics/jobs/:name/run': mockError(404, 'not_found', 'No such job') });
    const jobs = screen.getByRole('region', { name: 'Scheduled jobs' });
    await userEvent.setup().click(within(jobs).getByRole('button', { name: 'Run now: calendar:sync' }));
    expect(await screen.findByText('No such job')).toBeInTheDocument();
  });

  it('expands to the details and the outcome history, and asks for the related log lines', async () => {
    const { onShowLogs, requestsTo } = renderPanel({
      'GET /api/diagnostics/health/:key/history': {
        key: 'calendar:cal-1',
        rows: [outcomeRow({ id: 2, count: 3, code: 'account_unavailable', httpStatus: null, message: 'Work needs attention' }), outcomeRow({ id: 1, ok: true, status: 'ok', code: null, httpStatus: 200, message: null })],
      },
    });
    const user = userEvent.setup();
    const personal = screen.getByRole('listitem', { name: 'Personal' });
    // Named after the subject (its account too): a list of buttons tells them apart.
    const details = within(personal).getByRole('button', { name: 'Details: Work, Personal' });
    expect(screen.getByRole('button', { name: 'Details: Work, Mail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details: blog.example.org' })).toBeInTheDocument();
    expect(details).toHaveAttribute('aria-expanded', 'false');
    // It controls the details only while they exist.
    expect(details).not.toHaveAttribute('aria-controls');
    await user.click(details);
    const hide = within(personal).getByRole('button', { name: 'Hide details: Work, Personal' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(hide.getAttribute('aria-controls')!)).not.toBeNull();
    const table = await within(personal).findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Work needs attention')).toBeInTheDocument();
    expect(within(table).getByText(/\(3×\)$/)).toBeInTheDocument();
    expect(requestsTo('GET /api/diagnostics/health/calendar%3Acal-1/history')).toHaveLength(1);
    await user.click(within(personal).getByRole('button', { name: 'Show related log lines' }));
    expect(onShowLogs).toHaveBeenCalledWith(expect.objectContaining({ key: 'calendar:cal-1', label: 'Personal' }));
  });

  it('says so when nothing has been checked yet', () => {
    renderWithProviders(<ConnectionsPanel summary={diagnosticsSummary({ jobs: [], health: [] })} onShowLogs={() => {}} />);
    expect(screen.getByText('Nothing checked yet')).toBeInTheDocument();
  });
});
