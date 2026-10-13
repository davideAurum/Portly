/**
 * Server log: filters become the logs query (level, area, source, debounced text), chips filter
 * by request/job/run/account/calendar (accounts and calendars by name) and can be removed, rows
 * expand to their fields, Live polls `after=<last seq>` every 2 s and appends to the list (one
 * query per filter set; no first-page refetch when the tab is shown again; a poll that skipped
 * records says so) and starts over when the server restarted, "Show older" reads the log files from
 * the newest record memory shows (leaving out what it shows) until the list holds 2 000 rows,
 * Timeline merges this browser's events, and a server without diagnostics gets the update notice.
 */
import { useState } from 'react';
import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordClientEvent } from '../clientLog.ts';
import { settings } from '../../test/fixtures.ts';
import { createTestQueryClient, mockError, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { DEFAULT_LOG_FILTERS, type LogFilters } from './logs.ts';
import { ServerLogPanel, type LogNames } from './ServerLogPanel.tsx';
import { logRecord, logsResponse } from './testing.ts';

const NAMES: LogNames = {
  account: (id) => (id === 'acc-1' ? 'Work' : null),
  calendar: (id) => (id === 'cal-1' ? 'Personal' : null),
};

function Harness({ initial = DEFAULT_LOG_FILTERS, boot }: { initial?: LogFilters; boot?: string }) {
  const [filters, setFilters] = useState(initial);
  const [timeline, setTimeline] = useState(false);
  return <ServerLogPanel filters={filters} setFilters={setFilters} timeline={timeline} setTimeline={setTimeline} names={NAMES} boot={boot} />;
}

function query(req: MockRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.search));
}

const FIRST = logRecord({ seq: 4, t: '2026-10-11T11:00:00.000Z', level: 'warn', area: 'calendar', msg: 'calendar failing', rid: 'abcdefghij', fields: { accountId: 'acc-1', calendarId: 'cal-1', code: 'rate_limited' } });
const SECOND = logRecord({ seq: 5, t: '2026-10-11T11:01:00.000Z', level: 'info', area: 'accounts', msg: 'account status changed', fields: { accountId: 'acc-1', job: 'calendar:sync', run: 'r1x2y3' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerLogPanel', () => {
  it('lists the records newest first and turns the filters into the query', async () => {
    const { requestsTo } = renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST, SECOND]) } });
    const list = await screen.findByRole('list', { name: 'Log records' });
    expect(within(list).getAllByRole('listitem').map((li) => within(li).getAllByRole('button')[0]!.textContent)).toEqual([
      expect.stringContaining('account status changed'),
      expect.stringContaining('calendar failing'),
    ]);
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    expect(query(requestsTo('GET /api/diagnostics/logs')[0]!)).toEqual({ scope: 'memory', level: 'info', limit: '500' });

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Errors' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Area' }), 'calendar');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'client');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'rate');
    await waitFor(() => expect(query(requestsTo('GET /api/diagnostics/logs').at(-1)!)).toEqual({ scope: 'memory', level: 'error', area: 'calendar', src: 'client', q: 'rate', limit: '500' }));
    // The search is debounced: no request per keystroke.
    expect(requestsTo('GET /api/diagnostics/logs').filter((r) => query(r).q !== undefined)).toHaveLength(1);
  });

  it('filters by a chip (accounts and calendars by name) and removes it again', async () => {
    const { requestsTo } = renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST, SECOND]) } });
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Log records' });
    expect(screen.getAllByRole('button', { name: 'Account Work' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Calendar Personal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request abcdefghij' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job calendar:sync' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run r1x2y3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Calendar Personal' }));
    await waitFor(() => expect(query(requestsTo('GET /api/diagnostics/logs').at(-1)!).calendarId).toBe('cal-1'));
    const active = screen.getByRole('group', { name: 'Active filters' });
    await user.click(within(active).getByRole('button', { name: 'Remove filter Calendar: Personal' }));
    await waitFor(() => expect(query(requestsTo('GET /api/diagnostics/logs').at(-1)!).calendarId).toBeUndefined());
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
  });

  it('expands a row to its fields', async () => {
    renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST]) } });
    const head = (await screen.findByText('calendar failing')).closest('button')!;
    expect(head).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    const fields = document.getElementById(head.getAttribute('aria-controls')!)!;
    expect(JSON.parse(fields.textContent!)).toEqual({ rid: 'abcdefghij', accountId: 'acc-1', calendarId: 'cal-1', code: 'rate_limited' });
  });

  it('Live appends what is new every 2 seconds, asking after the last record seen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const third = logRecord({ seq: 6, t: '2026-10-11T11:02:00.000Z', level: 'warn', area: 'mail', msg: 'mail failing' });
    const fourth = logRecord({ seq: 9, t: '2026-10-11T11:03:00.000Z', level: 'error', area: 'feeds', msg: 'feed failing' });
    const { requestsTo } = renderWithProviders(<Harness />, {
      apiMocks: {
        'GET /api/diagnostics/logs': (req: MockRequest) => {
          const after = query(req).after;
          if (after === undefined) return logsResponse([FIRST, SECOND]);
          return after === '5' ? logsResponse([third], { lastSeq: 7 }) : logsResponse([fourth], { lastSeq: 9 });
        },
      },
    });
    await screen.findByText('account status changed');
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(await screen.findByText('mail failing')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(await screen.findByText('feed failing')).toBeInTheDocument();
    const polls = requestsTo('GET /api/diagnostics/logs').filter((r) => query(r).after !== undefined);
    expect(polls.map((r) => query(r).after)).toEqual(['5', '7']);
    expect(query(polls[0]!)).toEqual({ scope: 'memory', after: '5', level: 'info', limit: '500' });
    expect(screen.getByText('4 rows · live')).toBeInTheDocument();
    // One query per filter set: Live never added cache entries.
    expect(requestsTo('GET /api/diagnostics/logs').filter((r) => query(r).after === undefined)).toHaveLength(1);
  });

  it('Live says when a poll skipped records (more than a page arrived at once)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const burst = logRecord({ seq: 900, t: '2026-10-11T11:02:00.000Z', level: 'warn', area: 'mail', msg: 'mail failing' });
    renderWithProviders(<Harness />, {
      apiMocks: { 'GET /api/diagnostics/logs': (req: MockRequest) => (query(req).after === undefined ? logsResponse([FIRST, SECOND]) : logsResponse([burst], { truncated: true })) },
    });
    await screen.findByText('account status changed');
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(await screen.findByText('mail failing')).toBeInTheDocument();
    expect(screen.getByText('3 rows · live · some records skipped (more than 500 arrived at once)')).toBeInTheDocument();
  });

  it('Live keeps the first page from refetching when the tab is shown again (its cursor would skip what arrived meanwhile)', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, refetchOnWindowFocus: true } });
    const { requestsTo } = renderWithProviders(<Harness />, { queryClient, apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST, SECOND]) } });
    const pages = () => requestsTo('GET /api/diagnostics/logs').filter((r) => query(r).after === undefined).length;
    const showTab = () =>
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
    try {
      await screen.findByText('account status changed');
      showTab();
      await waitFor(() => expect(pages()).toBe(2));
      await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }));
      showTab();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pages()).toBe(2);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it('Live starts over from the new first page when the server restarted (its seqs begin again)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const appendedBefore = logRecord({ seq: 6, t: '2026-10-11T11:02:00.000Z', msg: 'before the restart' });
    const reborn = logRecord({ seq: 3, t: '2026-10-11T11:10:00.000Z', msg: 'server started' });
    const afterRestart = logRecord({ seq: 4, t: '2026-10-11T11:10:05.000Z', msg: 'after the restart' });
    let restarted = false;
    const { requestsTo } = renderWithProviders(<Harness />, {
      apiMocks: {
        'GET /api/diagnostics/logs': (req: MockRequest) => {
          const after = query(req).after;
          if (after === undefined) return restarted ? logsResponse([reborn]) : logsResponse([FIRST, SECOND]);
          if (!restarted) {
            restarted = true;
            return logsResponse([appendedBefore], { lastSeq: 6 });
          }
          // The new process: its newest seq is below the one asked after.
          return after === '6' ? logsResponse([], { lastSeq: 3 }) : logsResponse([afterRestart], { lastSeq: 4 });
        },
      },
    });
    await screen.findByText('account status changed');
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Live' }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(await screen.findByText('before the restart')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    // The first page of the new process replaces the old list (its older records are in the files).
    expect(await screen.findByText('server started')).toBeInTheDocument();
    expect(screen.queryByText('before the restart')).not.toBeInTheDocument();
    expect(screen.queryByText('account status changed')).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(await screen.findByText('after the restart')).toBeInTheDocument();
    const polls = requestsTo('GET /api/diagnostics/logs').filter((r) => query(r).after !== undefined);
    expect(polls.map((r) => query(r).after)).toEqual(['5', '6', '3']);
    expect(screen.getByText('2 rows · live')).toBeInTheDocument();
  });

  it('starts over when the summary reports another boot', async () => {
    let restarted = false;
    const reborn = logRecord({ seq: 2, t: '2026-10-11T11:10:00.000Z', msg: 'server started' });
    const { rerender, requestsTo } = renderWithProviders(<Harness boot="b1" />, {
      apiMocks: { 'GET /api/diagnostics/logs': () => (restarted ? logsResponse([reborn]) : logsResponse([FIRST, SECOND])) },
    });
    await screen.findByText('account status changed');
    rerender(<Harness boot="b1" />);
    expect(requestsTo('GET /api/diagnostics/logs')).toHaveLength(1);
    restarted = true;
    rerender(<Harness boot="b2" />);
    expect(await screen.findByText('server started')).toBeInTheDocument();
    expect(screen.queryByText('account status changed')).not.toBeInTheDocument();
    expect(requestsTo('GET /api/diagnostics/logs')).toHaveLength(2);
  });

  it('shows older records from the log files (not again what memory shows), until there are none', async () => {
    const fileRecord = logRecord({ seq: 0, t: '2026-10-10T09:00:00.000Z', msg: 'from yesterday' });
    const { requestsTo } = renderWithProviders(<Harness />, {
      apiMocks: {
        'GET /api/diagnostics/logs': (req: MockRequest) => {
          const q = query(req);
          if (q.scope !== 'files') return logsResponse([FIRST, SECOND], { truncated: true });
          // The files have memory's records too (read back with seq 0).
          return q.before === SECOND.t ? logsResponse([fileRecord, { ...FIRST, seq: 0 }], { scope: 'files' }) : logsResponse([], { scope: 'files' });
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByText('calendar failing');
    expect(screen.getByText(/the newest 500 records of the server's memory/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show older (log files)' }));
    expect(await screen.findByText('from yesterday')).toBeInTheDocument();
    // From the newest record memory shows: its rings reach back unequally far.
    expect(query(requestsTo('GET /api/diagnostics/logs')[1]!)).toEqual({ scope: 'files', before: SECOND.t, level: 'info', limit: '500' });
    expect(screen.getAllByText('calendar failing')).toHaveLength(1);
    expect(screen.getByText('3 rows')).toBeInTheDocument();
    // The files ran out (fewer records than asked for, and the scan was not cut short).
    expect(screen.getByText('No older records in the log files.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older (log files)' })).not.toBeInTheDocument();
  });

  it('keeps offering older records while the files have more (the scan was cut short)', async () => {
    const at = (s: number) => new Date(Date.parse('2026-10-10T00:00:00.000Z') + s * 1000).toISOString();
    const file = [0, 1, 2, 3].map((i) => logRecord({ seq: 0, t: at(i), msg: `old ${i}` }));
    // The newest two before `before`, cut short while older ones remain.
    const read = (before: string) => {
      const matches = file.filter((r) => r.t < before);
      return logsResponse(matches.slice(-2), { scope: 'files', truncated: matches.length > 2 });
    };
    const { requestsTo } = renderWithProviders(<Harness />, {
      apiMocks: { 'GET /api/diagnostics/logs': (req: MockRequest) => (query(req).scope === 'files' ? read(query(req).before!) : logsResponse([FIRST])) },
    });
    const user = userEvent.setup();
    await screen.findByText('calendar failing');
    await user.click(screen.getByRole('button', { name: 'Show older (log files)' }));
    expect(await screen.findByText('old 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show older (log files)' }));
    expect(await screen.findByText('old 1')).toBeInTheDocument();
    // After the oldest line's millisecond (lines of it the batch had no room for come too).
    expect(query(requestsTo('GET /api/diagnostics/logs')[2]!).before).toBe(new Date(Date.parse(at(2)) + 1).toISOString());
    expect(screen.getByRole('button', { name: 'Show older (log files)' })).toBeInTheDocument();
  });

  it('lets a keyboard user skip the rows to Show older', async () => {
    renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST, SECOND]) } });
    await screen.findByText('calendar failing');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Skip to the end of the log' }));
    expect(screen.getByRole('button', { name: 'Show older (log files)' })).toHaveFocus();
  });

  it('keeps offering older records after a full page (the files may have more)', async () => {
    const page = Array.from({ length: 500 }, (_, i) => logRecord({ seq: 0, t: new Date(Date.parse('2026-10-10T00:00:00.000Z') + i * 1000).toISOString(), msg: `old ${i}` }));
    renderWithProviders(<Harness />, {
      apiMocks: { 'GET /api/diagnostics/logs': (req: MockRequest) => (query(req).scope === 'files' ? logsResponse(page, { scope: 'files', truncated: false }) : logsResponse([FIRST])) },
    });
    // Text queries only: role queries over hundreds of rows are slow.
    await screen.findByText('calendar failing');
    fireEvent.click(screen.getByText('Show older (log files)'));
    expect(await screen.findByText('old 0')).toBeInTheDocument();
    expect(screen.getByText('Show older (log files)')).toBeInTheDocument();
    expect(screen.queryByText('No older records in the log files.')).not.toBeInTheDocument();
  });

  it('stops offering older records once the list holds 2 000 rows (they would fall off at once)', async () => {
    const day = Date.parse('2026-10-10T00:00:00.000Z');
    const batch = (from: number) => Array.from({ length: 500 }, (_, i) => logRecord({ seq: 0, t: new Date(day - (from + 500 - i) * 1000).toISOString(), msg: `old ${from + 500 - i}` }));
    const memory = Array.from({ length: 500 }, (_, i) => logRecord({ seq: i + 1, t: new Date(day + i * 1000).toISOString(), msg: `new ${i}` }));
    let batches = 0;
    const { requestsTo } = renderWithProviders(<Harness />, {
      apiMocks: {
        'GET /api/diagnostics/logs': (req: MockRequest) => (query(req).scope === 'files' ? logsResponse(batch(500 * batches++), { scope: 'files', truncated: true }) : logsResponse(memory)),
      },
    });
    // Text queries only: role queries over 2 000 rows are slow.
    await screen.findByText('500 rows');
    for (let i = 1; i <= 3; i++) {
      fireEvent.click(screen.getByText('Show older (log files)'));
      await screen.findByText(new RegExp(`^${500 * (i + 1)} rows`), undefined, { timeout: 15_000 });
    }
    expect(requestsTo('GET /api/diagnostics/logs')).toHaveLength(4);
    expect(screen.getByText('2000 rows · the newest 2000 are kept')).toBeInTheDocument();
    expect(screen.queryByText('Show older (log files)')).not.toBeInTheDocument();
    expect(screen.getByText('The list keeps 2000 rows: narrow the filters or the time window to look further back.')).toBeInTheDocument();
    // Rendering up to 2 000 rows four times takes seconds, more on a busy machine: above the suite's 20 s.
  }, 60_000);

  it('Timeline merges this browser’s events into the list', async () => {
    recordClientEvent('warn', 'widget', 'mail summary failed', { accountId: 'acc-1', code: 'reauth_required' });
    renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([FIRST]), 'GET /api/settings': settings() } });
    await screen.findByText('calendar failing');
    expect(screen.queryByText('mail summary failed')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('switch', { name: /Timeline/ }));
    const row = screen.getByText('mail summary failed').closest('li')!;
    expect(within(row).getByText('this browser · widget')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Account Work' })).toBeInTheDocument();
  });

  it('starts from the filters it is given (Show related log lines) and says when nothing matches', async () => {
    const { requestsTo } = renderWithProviders(
      <Harness initial={{ ...DEFAULT_LOG_FILTERS, level: 'debug', key: 'feed:abc', keyLabel: 'blog.example.org', since: '2026-10-11T11:00:00.000Z', before: '2026-10-11T13:00:00.000Z' }} />,
      { apiMocks: { 'GET /api/diagnostics/logs': logsResponse([]) } },
    );
    expect(await screen.findByText('No records match these filters.')).toBeInTheDocument();
    expect(query(requestsTo('GET /api/diagnostics/logs')[0]!)).toMatchObject({ key: 'feed:abc', level: 'debug' });
    expect(screen.getByRole('button', { name: 'Remove filter Subject: blog.example.org' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(query(requestsTo('GET /api/diagnostics/logs').at(-1)!)).toEqual({ scope: 'memory', level: 'debug', limit: '500' }));
  });

  it('shows the update notice when the server has no diagnostics', async () => {
    renderWithProviders(<Harness />, { apiMocks: { 'GET /api/diagnostics/logs': mockError(403, 'local_only', 'Local only') } });
    expect(await screen.findByText('Update Portly on this PC to see its diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Live' })).toBeDisabled();
  });
});
