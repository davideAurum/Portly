/**
 * Launch pad sync in Settings → Accounts (browser backend): the status line with Sync now and
 * details on the connection that syncs (Microsoft or GitHub), the first-sync question, the warning
 * when it is set up twice, moving it between Microsoft connections, refusing a second connection
 * (the Manage switch, the Microsoft connect dialog and the GitHub form), and the permission note
 * before the sign-in that adds it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Account } from '@portly/shared';
import type { LaunchpadSyncInfo } from '../../../api/launchpadSync.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../../capabilities.ts';
import { account, health } from '../../../test/fixtures.ts';
import { renderWithProviders, type ApiMock } from '../../../test/render.tsx';
import AccountsSettings from '../Accounts.tsx';

const OUTLOOK = account({
  id: 'ms-1',
  kind: 'microsoft',
  label: 'Outlook (someone@outlook.example)',
  email: 'someone@outlook.example',
  capabilities: ['calendar', 'launchpadSync'],
  enabledCapabilities: ['calendar', 'launchpadSync'],
});
const SECOND = account({
  id: 'ms-2',
  kind: 'microsoft',
  label: 'Second (other@outlook.example)',
  email: 'other@outlook.example',
  capabilities: ['calendar', 'launchpadSync'],
  enabledCapabilities: ['calendar'],
  sort: 1,
});

function info(overrides: Partial<LaunchpadSyncInfo> = {}): LaunchpadSyncInfo {
  return {
    connection: { kind: 'microsoft', accountId: OUTLOOK.id, label: OUTLOOK.label },
    connections: 1,
    status: 'up_to_date',
    problem: null,
    running: false,
    waiting: false,
    syncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    receivedAt: null,
    sentAt: null,
    retryAt: null,
    ...overrides,
  };
}

function render(options: { accounts?: Account[]; github?: boolean; sync?: LaunchpadSyncInfo; mocks?: Record<string, ApiMock> } = {}) {
  setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
  const state = { accounts: options.accounts ?? [OUTLOOK], sync: options.sync ?? info() };
  const result = renderWithProviders(<AccountsSettings />, {
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': () => state.accounts,
      'GET /api/oauth-clients/microsoft': { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'https://user.github.io/portly/' },
      'GET /api/todoist/token': { configured: false },
      'GET /api/sync/github': { configured: options.github === true },
      'GET /api/sync/launchpad': () => state.sync,
      'POST /api/sync/launchpad/now': () => {
        state.sync = info({ status: 'up_to_date' });
        return state.sync;
      },
      ...options.mocks,
    },
  });
  return { ...result, state, user: userEvent.setup() };
}

describe('Accounts: launch pad sync', () => {
  it('shows the status line on the connection that syncs, with Sync now and details', async () => {
    const { user, requestsTo } = render({ accounts: [OUTLOOK, SECOND], sync: info({ waiting: true, sentAt: new Date().toISOString() }) });
    const line = await screen.findByLabelText('Launch pad sync');
    expect(within(line).getByText('Changes waiting to upload')).toBeInTheDocument();
    expect(within(line).getByText(/Last synced/)).toBeInTheDocument();
    // Only the connection that syncs has one.
    expect(screen.getAllByLabelText('Launch pad sync')).toHaveLength(1);

    await user.click(within(line).getByRole('button', { name: 'Details' }));
    expect(within(line).getByText(/In your OneDrive, under Apps/)).toBeInTheDocument();
    expect(within(line).getByText('Last change sent')).toBeInTheDocument();

    await user.click(within(line).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(requestsTo('POST /api/sync/launchpad/now')).toHaveLength(1));
    expect(requestsTo('POST /api/sync/launchpad/now')[0]!.body).toEqual({});
    expect(await screen.findByText('Launch pad synced.')).toBeInTheDocument();
    expect(await within(line).findByText('Up to date')).toBeInTheDocument();
  });

  it('asks the first-sync question, defaulting to the synced launch pad, and asks again from the status line', async () => {
    const { user, requestsTo } = render({ sync: info({ status: 'needs_choice', syncedAt: null }) });
    const dialog = await screen.findByRole('dialog', { name: 'Which launch pad should this browser use?' });
    expect(within(dialog).getByText(/Outlook \(someone@outlook.example\)’s OneDrive/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const line = screen.getByLabelText('Launch pad sync');
    expect(within(line).getByText('Waiting for your choice')).toBeInTheDocument();
    await user.click(within(line).getByRole('button', { name: 'Choose…' }));
    const again = await screen.findByRole('dialog', { name: 'Which launch pad should this browser use?' });
    await user.click(within(again).getByRole('button', { name: 'Use the synced launch pad' }));
    await waitFor(() => expect(requestsTo('POST /api/sync/launchpad/now')).toHaveLength(1));
    expect(requestsTo('POST /api/sync/launchpad/now')[0]!.body).toEqual({ choice: 'use_synced' });
    expect(await screen.findByText('This browser now uses the synced launch pad.')).toBeInTheDocument();
  });

  it('can replace the synced launch pad instead', async () => {
    const { user, requestsTo } = render({ github: true, accounts: [], sync: info({ connection: { kind: 'github' }, status: 'needs_choice' }) });
    const dialog = await screen.findByRole('dialog', { name: 'Which launch pad should this browser use?' });
    expect(within(dialog).getByText(/your GitHub repository/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Replace the synced launch pad' }));
    await waitFor(() => expect(requestsTo('POST /api/sync/launchpad/now')[0]?.body).toEqual({ choice: 'replace_synced' }));
  });

  it('shows the status line on the GitHub row, with what to do when GitHub refused the token', async () => {
    render({ github: true, accounts: [], sync: info({ connection: { kind: 'github' }, status: 'paused_reauth' }) });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    const line = await within(list).findByLabelText('Launch pad sync');
    expect(within(line).getByText('Paused')).toBeInTheDocument();
    expect(within(line).getByText(/Save a new token under Manage, or make the repository private again/)).toBeInTheDocument();
    expect(within(line).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('warns when it is set up twice, and points errors to Diagnostics', async () => {
    const { user } = render({ github: true, sync: info({ connection: null, connections: 2, status: 'several_sources' }) });
    expect(await screen.findByText('Launch pad sync is set up twice')).toBeInTheDocument();
    expect(screen.queryByLabelText('Launch pad sync')).not.toBeInTheDocument();
    // An error elsewhere links to Diagnostics.
    render({ sync: info({ status: 'error', problem: 'network_error' }) });
    const line = (await screen.findAllByLabelText('Launch pad sync')).at(-1)!;
    expect(within(line).getByText('Portly could not reach the sync storage.')).toBeInTheDocument();
    await user.click(within(line).getByRole('button', { name: 'Details' }));
    expect(within(line).getByRole('link', { name: 'Open Diagnostics' })).toHaveAttribute('href', '#/settings/diagnostics');
  });

  it('moves launch pad sync between Microsoft connections after asking', async () => {
    const { user, requestsTo } = render({
      accounts: [OUTLOOK, SECOND],
      mocks: { 'PATCH /api/accounts/ms-1': () => OUTLOOK, 'PATCH /api/accounts/ms-2': () => SECOND },
    });
    await user.click(await screen.findByRole('button', { name: `Manage ${SECOND.label}` }));
    const manage = await screen.findByRole('dialog', { name: `Manage ${SECOND.label}` });
    await user.click(within(manage).getByRole('switch', { name: /Launch pad sync/ }));
    const confirm = await screen.findByRole('dialog', { name: `Move launch pad sync to ${SECOND.label}?` });
    expect(requestsTo('PATCH /api/accounts/ms-2')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Move launch pad sync' }));
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/ms-2')).toHaveLength(1));
    expect(requestsTo('PATCH /api/accounts/ms-1')[0]!.body).toEqual({ enabledCapabilities: ['calendar'] });
    expect(requestsTo('PATCH /api/accounts/ms-2')[0]!.body).toEqual({ enabledCapabilities: ['calendar', 'launchpadSync'] });
    expect(await screen.findByText(`Launch pad sync now uses ${SECOND.label}.`)).toBeInTheDocument();
  });

  it('keeps a Microsoft connection from syncing while GitHub does', async () => {
    const off = { ...OUTLOOK, enabledCapabilities: ['calendar' as const] };
    const { user } = render({ github: true, accounts: [off], sync: info({ connection: { kind: 'github' } }) });
    await user.click(await screen.findByRole('button', { name: `Manage ${off.label}` }));
    const manage = await screen.findByRole('dialog', { name: `Manage ${off.label}` });
    const toggle = within(manage).getByRole('switch', { name: /Launch pad sync/ });
    expect(toggle).toBeDisabled();
    expect(within(manage).getByText(/uses GitHub in this browser: remove GitHub first/)).toBeInTheDocument();
  });

  it('keeps the GitHub form from saving while a Microsoft connection syncs', async () => {
    const { user, requestsTo } = render();
    await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect GitHub' });
    expect(await within(dialog).findByText(`Launch pad sync already uses ${OUTLOOK.label}`)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Repository (owner/name)'), 'octo-tester/portly-sync');
    await user.type(within(dialog).getByLabelText('Fine-grained token'), 'github_pat_11TESTTOKEN0123456789_abcdefghijklmnopqrstuvwxyz');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(requestsTo('PUT /api/sync/github')).toHaveLength(0);
  });

  it('leaves the service unticked and blocked in the Microsoft dialog while GitHub syncs', async () => {
    const { user } = render({ github: true, accounts: [], sync: info({ connection: { kind: 'github' } }) });
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Microsoft' });
    const box = await within(dialog).findByRole('checkbox', { name: /Launch pad sync/ });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(within(dialog).getByText(/It already uses GitHub in this browser/)).toBeInTheDocument();
  });

  it('says what the permission reaches before signing in again to add the service', async () => {
    const calendarOnly = { ...OUTLOOK, capabilities: ['calendar' as const], enabledCapabilities: ['calendar' as const] };
    const { user, requestsTo } = render({
      accounts: [calendarOnly],
      sync: info({ connection: null, connections: 0, status: 'off', syncedAt: null }),
      mocks: { 'POST /api/oauth/microsoft/start': { authorizeUrl: '#/settings/accounts' } },
    });
    await user.click(await screen.findByRole('button', { name: `Manage ${calendarOnly.label}` }));
    const manage = await screen.findByRole('dialog', { name: `Manage ${calendarOnly.label}` });
    await user.click(within(manage).getByRole('button', { name: 'Add Launch pad sync' }));
    const confirm = await screen.findByRole('dialog', { name: 'Add launch pad sync?' });
    expect(within(confirm).getByText(/Portly can't see anything else in your OneDrive/)).toBeInTheDocument();
    expect(requestsTo('POST /api/oauth/microsoft/start')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Continue to Microsoft' }));
    await waitFor(() => expect(requestsTo('POST /api/oauth/microsoft/start')).toHaveLength(1));
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toMatchObject({ accountId: calendarOnly.id, capabilities: ['launchpadSync'] });
  });
});
