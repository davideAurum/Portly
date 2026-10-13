import type { ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailAccountSummary, MailMessage } from '@portly/shared';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { account, settings } from '../../test/fixtures.ts';
import type { QueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys.ts';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { createTestQueryClient, mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { mailConfigSchema, type MailConfig } from './index.ts';
import MailSettings from './Settings.tsx';
import MailWidget from './Widget.tsx';

const NOW = new Date('2026-09-25T12:00:00Z').getTime();

function msg(id: string, accountId: string, minutesAgo: number, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    accountId,
    from: { name: `Sender ${id}`, address: `${id}@example.com` },
    subject: `Subject ${id}`,
    snippet: null,
    date: new Date(NOW - minutesAgo * 60_000).toISOString(),
    unread: false,
    webUrl: null,
    ...extra,
  };
}

const GMAIL: MailAccountSummary = {
  accountId: 'g1',
  label: 'Personal Gmail',
  email: 'me@gmail.com',
  color: '#ea4335',
  unread: 7,
  canArchive: true,
  webmailUrl: 'https://mail.google.com/mail/u/?authuser=me%40gmail.com',
  messages: [
    msg('g-new', 'g1', 5, {
      unread: true,
      subject: '<img src=x onerror=alert(1)>Quarterly report',
      snippet: 'Numbers are in & looking good',
      webUrl: 'https://mail.google.com/mail/u/?authuser=me%40gmail.com#inbox/abc',
    }),
    msg('g-old', 'g1', 600, { webUrl: 'javascript:alert(1)' }),
  ],
};

const YAHOO: MailAccountSummary = {
  accountId: 'y1',
  label: 'Yahoo',
  email: 'me@yahoo.com',
  color: null,
  unread: 2,
  canArchive: false,
  webmailUrl: 'https://mail.yahoo.com/',
  messages: [msg('y-mid', 'y1', 30, { unread: true, from: { name: '', address: 'news@shop.example' }, subject: '' })],
};

const OUTLOOK_REAUTH: MailAccountSummary = {
  accountId: 'm1',
  label: 'Outlook',
  email: 'me@outlook.com',
  color: null,
  unread: 0,
  canArchive: false,
  webmailUrl: 'https://outlook.live.com/mail/',
  messages: [],
  error: { code: 'reauth_required', message: 'Access expired or was revoked; reconnect the account', accountId: 'm1' },
};

const BROKEN_IMAP: MailAccountSummary = {
  ...OUTLOOK_REAUTH,
  accountId: 'i1',
  label: 'Work IMAP',
  error: { code: 'upstream_timeout', message: 'The mail server did not respond in time', accountId: 'i1' },
};

function config(patch: Partial<MailConfig> = {}): MailConfig {
  return { ...mailConfigSchema.parse({}), ...patch };
}

function Frame({ children, actionsTarget, openSettings }: { children: ReactNode; actionsTarget: HTMLElement; openSettings?: () => void }) {
  const value: WidgetFrameContextValue = {
    instanceId: 'w-mail',
    title: 'Mail',
    openSettings: openSettings ?? (() => {}),
    canOpenSettings: true,
    actionsTarget,
  };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function renderMail(
  summaries: MailAccountSummary[] | ApiMock,
  opts: { config?: Partial<MailConfig>; mocks?: Record<string, ApiMock>; openSettings?: () => void; queryClient?: QueryClient } = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const header = document.createElement('div');
  header.setAttribute('data-testid', 'header-actions');
  document.body.append(header);
  const result = renderWithProviders(
    <Frame actionsTarget={header} openSettings={opts.openSettings}>
      <MailWidget instanceId="w-mail" config={config(opts.config)} setConfig={async () => {}} size={{ w: 4, h: 7 }} editMode={false} />
    </Frame>,
    {
      apiMocks: {
        'GET /api/settings': settings(),
        'GET /api/accounts': [account({ id: 'm1', kind: 'microsoft', label: 'Outlook' }), account({ id: 'g1', label: 'Personal Gmail' })],
        'GET /api/mail/summary': Array.isArray(summaries) ? summaries : summaries,
        ...opts.mocks,
      },
      ...(opts.queryClient ? { queryClient: opts.queryClient } : {}),
    },
  );
  return { ...result, header };
}

const rows = () => within(screen.getByRole('list', { name: 'Recent messages' })).getAllByRole('listitem');

describe('MailWidget: no mail account (PERF-2)', () => {
  afterEach(() => vi.useRealTimers());

  it('knows from the (persisted) account list that there is nothing to load: no summary request, no 409', async () => {
    const calendarOnly = [account({ id: 'c1', kind: 'caldav', label: 'Calendar only', capabilities: ['calendar'], enabledCapabilities: ['calendar'] })];
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.accounts(), calendarOnly);
    const { requestsTo } = renderMail([GMAIL], { mocks: { 'GET /api/accounts': calendarOnly }, queryClient });
    expect(await screen.findByText('Connect your mail')).toBeInTheDocument();
    expect(requestsTo('GET /api/mail/summary')).toHaveLength(0);
  });

  it('uses the one-line state at its 3×4 minimum (narrow, not only short; UX-4)', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.accounts(), []);
    const { container } = renderWithProviders(
      <Frame actionsTarget={document.createElement('div')}>
        <MailWidget instanceId="w-mail" config={config()} setConfig={async () => {}} size={{ w: 3, h: 4 }} editMode={false} />
      </Frame>,
      { apiMocks: { 'GET /api/settings': settings(), 'GET /api/accounts': [] }, queryClient },
    );
    expect(await screen.findByText('Connect your mail')).toBeInTheDocument();
    expect(container.querySelector('[data-compact="true"]')).not.toBeNull();
  });
});

describe('MailWidget', () => {
  it('merges accounts newest first with the total unread badge; everything is plain text', async () => {
    const { header, requests } = renderMail([GMAIL, YAHOO]);
    await screen.findByText('Sender g-new');

    expect(rows().map((r) => within(r).getAllByText(/Sender|news@/)[0]?.textContent)).toEqual(['Sender g-new', 'news@shop.example', 'Sender g-old']);
    expect(within(header).getByText('9')).toBeInTheDocument();
    expect(within(header).getByText('unread', { exact: false })).toBeInTheDocument();

    // Markup in provider text stays text.
    expect(screen.getByText('<img src=x onerror=alert(1)>Quarterly report')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Numbers are in & looking good')).toBeInTheDocument();
    expect(screen.getByText('(no subject)')).toBeInTheDocument();

    const summaryRequest = requests.find((r) => r.path === '/api/mail/summary') as MockRequest;
    expect(summaryRequest.search).toBe('?maxMessages=10&unreadOnly=false');
    expect(summaryRequest.headers.get('X-Portly')).toBe('1');
  });

  it('rows open the message (or webmail) in a new tab and never render unsafe links', async () => {
    renderMail([GMAIL, YAHOO]);
    await screen.findByText('Sender g-new');
    const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement];

    const link = within(first).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://mail.google.com/mail/u/?authuser=me%40gmail.com#inbox/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName(/Unread, Sender g-new/);

    // IMAP rows (no message link) open the account's webmail.
    expect(within(second).getByRole('link')).toHaveAttribute('href', 'https://mail.yahoo.com/');
    // javascript: webUrl → falls back to the webmail inbox.
    expect(within(third).getByRole('link')).toHaveAttribute('href', 'https://mail.google.com/mail/u/?authuser=me%40gmail.com');
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('shows archive only for accounts that support it', async () => {
    renderMail([GMAIL, YAHOO]);
    await screen.findByText('Sender g-new');
    const [gmailRow, yahooRow] = rows() as [HTMLElement, HTMLElement];
    expect(within(gmailRow).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(within(yahooRow).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(within(yahooRow).getByRole('button', { name: 'Move to trash' })).toBeInTheDocument();
    expect(within(yahooRow).getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
  });

  it('hides trash for accounts whose server cannot trash safely (canTrash: false, §4.10)', async () => {
    renderMail([GMAIL, { ...YAHOO, canTrash: false }]);
    await screen.findByText('Sender g-new');
    const [gmailRow, yahooRow] = rows() as [HTMLElement, HTMLElement];
    // Absent canTrash (older servers) means trash is available.
    expect(within(gmailRow).getByRole('button', { name: 'Move to trash' })).toBeInTheDocument();
    expect(within(yahooRow).queryByRole('button', { name: 'Move to trash' })).toBeNull();
    expect(within(yahooRow).getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
  });

  it('groups by account with per-account unread counts and webmail links', async () => {
    renderMail([GMAIL, YAHOO], { config: { grouping: 'byAccount' } });
    const gmail = await screen.findByRole('region', { name: 'Personal Gmail' });
    const yahoo = screen.getByRole('region', { name: 'Yahoo' });
    expect(within(gmail).getAllByRole('listitem')).toHaveLength(2);
    expect(within(gmail).getByText('7')).toBeInTheDocument();
    expect(within(yahoo).getAllByRole('listitem')).toHaveLength(1);
    expect(within(yahoo).getByRole('link', { name: 'Open Yahoo in webmail' })).toHaveAttribute('href', 'https://mail.yahoo.com/');
  });

  it('shows per-account error rows: Reconnect for reauth_required, Retry otherwise', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderMail(() => {
      calls++;
      return [GMAIL, OUTLOOK_REAUTH, BROKEN_IMAP];
    });
    await screen.findByText('Sender g-new');
    const notices = within(screen.getByRole('list', { name: 'Accounts with problems' })).getAllByRole('listitem');
    expect(notices).toHaveLength(2);
    expect(within(notices[0] as HTMLElement).getByText('Outlook')).toBeInTheDocument();
    expect(await within(notices[0] as HTMLElement).findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(notices[1] as HTMLElement).getByText('The mail server did not respond in time')).toBeInTheDocument();

    await user.click(within(notices[1] as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toBe(2));
    // The healthy account still renders its messages.
    expect(rows()).toHaveLength(2);
  });

  it('by account, a failing account shows its error inside its section', async () => {
    renderMail([GMAIL, OUTLOOK_REAUTH], { config: { grouping: 'byAccount' } });
    const outlook = await screen.findByRole('region', { name: 'Outlook' });
    expect(within(outlook).getByText('Access expired or was revoked; reconnect the account')).toBeInTheDocument();
    expect(await within(outlook).findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('marks read optimistically with an Undo toast that marks it unread again', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const posts: unknown[] = [];
    const { header } = renderMail([GMAIL], {
      mocks: {
        'POST /api/mail/:accountId/messages/:id/read': (req: MockRequest) => {
          posts.push({ ...req.params, body: req.body });
          return new Promise((resolve) => {
            release = () => resolve(mockResponse(204));
          });
        },
      },
    });
    await screen.findByText('Sender g-new');
    const first = rows()[0] as HTMLElement;
    expect(first).toHaveAttribute('data-unread', 'true');

    await user.click(within(first).getByRole('button', { name: 'Mark as read' }));
    // Optimistic: updated before the server answered.
    await waitFor(() => expect(rows()[0]).not.toHaveAttribute('data-unread'));
    expect(within(header).getByText('6')).toBeInTheDocument();
    expect(posts).toEqual([{ accountId: 'g1', id: 'g-new', body: { read: true } }]);

    release();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(screen.getByText('Marked as read')).toBeInTheDocument();
    await user.click(undo);
    await waitFor(() => expect(posts).toHaveLength(2));
    release();
    expect(posts[1]).toEqual({ accountId: 'g1', id: 'g-new', body: { read: false } });
  });

  it('trash is optimistic and rolled back with an error toast when it fails', async () => {
    const user = userEvent.setup();
    let fail: () => void = () => {};
    renderMail([GMAIL], {
      mocks: {
        'POST /api/mail/:accountId/messages/:id/trash': () =>
          new Promise((resolve) => {
            fail = () => resolve(mockError(502, 'provider_error', 'Gmail returned an error (500)', { accountId: 'g1' }));
          }),
      },
    });
    await screen.findByText('Sender g-new');
    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(screen.queryByText('Sender g-new')).toBeNull());
    fail();
    expect(await screen.findByText('Gmail returned an error (500)')).toBeInTheDocument();
    expect(await screen.findByText('Sender g-new')).toBeInTheDocument();
  });

  it('a successful archive shows a toast and refetches the summary', async () => {
    const user = userEvent.setup();
    let summaries = 0;
    const { requestsTo } = renderMail(
      () => {
        summaries++;
        return summaries === 1 ? [GMAIL] : [{ ...GMAIL, messages: GMAIL.messages.slice(1), unread: 6 }];
      },
      { mocks: { 'POST /api/mail/:accountId/messages/:id/archive': mockResponse(204) } },
    );
    await screen.findByText('Sender g-new');
    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    await waitFor(() => expect(summaries).toBe(2));
    expect(requestsTo('POST /api/mail/g1/messages/g-new/archive')).toHaveLength(1);
    expect(screen.queryByText('Sender g-new')).toBeNull();
  });

  it('a stale list (409 conflict) is refreshed with an explanatory toast', async () => {
    const user = userEvent.setup();
    let summaries = 0;
    renderMail(
      () => {
        summaries++;
        return [YAHOO];
      },
      { mocks: { 'POST /api/mail/:accountId/messages/:id/read': mockError(409, 'conflict', 'The mailbox changed', { details: { reason: 'stale_message' } }) } },
    );
    await screen.findByText('news@shop.example');
    await user.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Mark as read' }));
    expect(await screen.findByText(/The list has been refreshed/)).toBeInTheDocument();
    await waitFor(() => expect(summaries).toBe(2));
    expect(rows()[0]).toHaveAttribute('data-unread', 'true');
  });

  it('not configured (no mail accounts) links to Settings › Accounts', async () => {
    renderMail(mockError(409, 'not_configured', 'No mail accounts are connected yet'));
    const link = await screen.findByRole('link', { name: 'Connect an account' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(screen.getByText('Connect your mail')).toBeInTheDocument();
  });

  it('an empty inbox and unread-only mode have their own empty states', async () => {
    renderMail([{ ...GMAIL, messages: [], unread: 0 }], { config: { unreadOnly: true } });
    expect(await screen.findByText('No unread mail')).toBeInTheDocument();
  });

  it('no selected accounts → no request and a button to open the widget settings', async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    const { requestsTo } = renderMail([GMAIL], { config: { accountIds: [] }, openSettings });
    await user.click(screen.getByRole('button', { name: 'Choose accounts' }));
    expect(openSettings).toHaveBeenCalled();
    expect(requestsTo('GET /api/mail/summary')).toHaveLength(0);
  });

  it('first load shows a skeleton; a failed first load shows Retry', async () => {
    renderMail(mockError(500, 'internal', 'Internal server error'));
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('passes the widget selection and options to the server', async () => {
    const { requests } = renderMail([GMAIL], { config: { accountIds: ['g1', 'y1'], maxMessages: 15, unreadOnly: true } });
    await screen.findByText('Sender g-new');
    expect(requests.find((r) => r.path === '/api/mail/summary')?.search).toBe('?maxMessages=15&unreadOnly=true&accountIds=g1%2Cy1');
  });

  it('actions are keyboard reachable from the row link', async () => {
    const user = userEvent.setup();
    renderMail([GMAIL]);
    await screen.findByText('Sender g-new');
    const first = rows()[0] as HTMLElement;
    within(first).getByRole('link').focus();
    await user.tab();
    expect(within(first).getByRole('button', { name: 'Mark as read' })).toHaveFocus();
    await user.tab();
    expect(within(first).getByRole('button', { name: 'Archive' })).toHaveFocus();
  });
});

describe('MailSettings', () => {
  it('edits grouping, message count and unread-only; lists mail accounts', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<MailSettings value={config()} onChange={onChange} />, {
      apiMocks: { 'GET /api/accounts': [account({ id: 'g1', label: 'Personal Gmail' }), account({ id: 'c1', label: 'Cal only', enabledCapabilities: ['calendar'] })] },
    });
    const all = await screen.findByRole('switch', { name: /All accounts/ });

    await user.click(screen.getByRole('radio', { name: 'By account' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ grouping: 'byAccount' }));

    await user.click(screen.getByRole('switch', { name: 'Unread only' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ unreadOnly: true }));

    // Turning "All accounts" off selects the mail-enabled accounts explicitly.
    await user.click(all);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['g1'] }));

    const slider = screen.getByRole('slider', { name: 'Messages to show' });
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '20');
  });

  it('lists only mail-enabled accounts when a subset is selected', async () => {
    renderWithProviders(<MailSettings value={config({ accountIds: ['g1'] })} onChange={() => {}} />, {
      apiMocks: { 'GET /api/accounts': [account({ id: 'g1', label: 'Personal Gmail' }), account({ id: 'c1', label: 'Cal only', enabledCapabilities: ['calendar'] })] },
    });
    expect(await screen.findByRole('checkbox', { name: /Personal Gmail/ })).toBeChecked();
    expect(screen.queryByText('Cal only')).toBeNull();
  });
});

describe('MailWidget: diagnostic events', () => {
  afterEach(() => vi.useRealTimers());

  it('records each failing account once (a widget event), not on every refetch', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderMail(() => {
      calls++;
      return [GMAIL, OUTLOOK_REAUTH, BROKEN_IMAP];
    });
    await screen.findByText('Sender g-new');
    const widgetEvents = () => getClientEvents().filter((entry) => entry.event.cat === 'widget').map((entry) => entry.event.fields);
    await waitFor(() =>
      expect(widgetEvents()).toEqual([
        { widget: 'mail', accountId: 'm1', code: 'reauth_required', status: 409 },
        { widget: 'mail', accountId: 'i1', code: 'upstream_timeout', status: 504 },
      ]),
    );
    const notices = within(screen.getByRole('list', { name: 'Accounts with problems' })).getAllByRole('listitem');
    await user.click(within(notices[1] as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(widgetEvents()).toHaveLength(2);
  });
});
