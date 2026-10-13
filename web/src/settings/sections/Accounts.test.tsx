/**
 * Accounts settings on the Pages site using Homebase on this PC: the same page as the server build
 * (there is one Homebase page, with or without the server). Signing in, OAuth app registrations,
 * app-password accounts, Reconnect and the vault reset all happen here, and nothing links out to a
 * page on this PC. (The server build is covered in `src/test/settings/Accounts.test.tsx`.)
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import type { LocalServerState } from '../../localServer/types.ts';
import { account, health } from '../../test/fixtures.ts';
import { mockResponse, renderWithProviders, type ApiMock } from '../../test/render.tsx';
import AccountsSettings from './Accounts.tsx';

const GOOGLE_CLIENT = { clientId: null, hasSecret: false, redirectUri: 'http://localhost:5757/api/oauth/google/callback' };
const MS_CLIENT = { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'http://localhost:5757/api/oauth/microsoft/callback' };

/** The Pages build on the server backend, with a controller reporting the connected server. */
function useHomebaseOnThisPc(): void {
  setCapabilitiesForTests(capabilitiesFor(true, 'server'));
  const state: LocalServerState = {
    backend: 'server',
    status: 'connected',
    server: { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' },
    paired: true,
    checkedAt: 1,
    pendingSwitch: null,
    permission: 'granted',
    manual: false,
  };
  setLocalServerController({
    getState: () => state,
    subscribe: () => () => {},
    actions: { checkNow() {}, lookForServer() {}, startPairing() {}, async disconnect() {}, switchNow() {} },
  });
}

function renderAccounts(mocks: Record<string, ApiMock>) {
  useHomebaseOnThisPc();
  return renderWithProviders(<AccountsSettings />, {
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': [],
      'GET /api/oauth-clients/google': GOOGLE_CLIENT,
      'GET /api/oauth-clients/microsoft': MS_CLIENT,
      ...mocks,
    },
  });
}

/** No link on the page leads to Homebase's own page on this PC. */
function expectNoLinkToThisPc(): void {
  expect(screen.queryByRole('link', { name: /Open Homebase on this PC/ })).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="http://localhost"], a[href^="http://127.0.0.1"]')).toBeNull();
}

describe('Accounts settings with Homebase on this PC', () => {
  it('offers the OAuth app registrations and the account forms here, as the server build does', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const user = userEvent.setup();
    const { requestsTo } = renderAccounts({
      'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
    });
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByText(/or an IMAP mailbox below to see your calendars and mail/)).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Google app registration' })).toBeInTheDocument();
    const outlook = screen.getByRole('form', { name: 'Outlook.com app registration' });
    expect(screen.getByRole('form', { name: 'Add a Yahoo account' })).toBeInTheDocument();
    const accountTypes = screen.getByRole('tablist', { name: 'Account type' });
    expect(within(accountTypes).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Yahoo', 'CalDAV calendar', 'IMAP mail']);
    expect(screen.queryByRole('heading', { name: 'Add or reconnect accounts' })).not.toBeInTheDocument();
    expect(requestsTo('GET /api/oauth-clients/google')).toHaveLength(1);
    expect(requestsTo('GET /api/oauth-clients/microsoft')).toHaveLength(1);
    expectNoLinkToThisPc();

    await user.click(within(outlook).getByRole('button', { name: 'Connect Outlook.com' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1'));
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts' });
  });

  it('accounts that need reconnecting reconnect here via POST /api/oauth/:provider/start', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const user = userEvent.setup();
    const { requestsTo } = renderAccounts({
      'GET /api/accounts': [
        account({ id: 'g1', label: 'Work Gmail', status: 'reauth' }),
        account({ id: 'm1', kind: 'microsoft', label: 'Outlook', sort: 1 }),
        account({ id: 'i1', kind: 'imap', label: 'Fastmail', status: 'reauth', sort: 2 }),
      ],
      'POST /api/accounts/:id/test': { results: { mail: { ok: true } } },
      'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
    });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    const [gmail, outlook, imap] = within(list).getAllByRole('listitem');
    expect(within(outlook!).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(imap!).getByText(/add this account again below with its current password/)).toBeInTheDocument();
    expect(within(imap!).queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expectNoLinkToThisPc();

    await user.click(within(outlook!).getByRole('button', { name: 'Test Outlook' }));
    expect(await screen.findByText('Outlook is working.')).toBeInTheDocument();

    await user.click(within(gmail!).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(requestsTo('POST /api/oauth/google/start')).toHaveLength(1);
    expect(requestsTo('POST /api/oauth/google/start')[0]!.body).toMatchObject({ accountId: 'g1', returnTo: '#/settings/accounts' });
  });

  it('a locked vault is reset from here, behind a confirmation', async () => {
    const user = userEvent.setup();
    const { requestsTo } = renderAccounts({ 'GET /api/health': health('locked'), 'POST /api/vault/reset': mockResponse(204) });
    expect(await screen.findByText("Saved credentials can't be unlocked")).toBeInTheDocument();
    expect(screen.queryByText(/Homebase's own page/)).not.toBeInTheDocument();
    expectNoLinkToThisPc();
    await user.click(screen.getByRole('button', { name: 'Reset credentials' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset all stored credentials?' });
    expect(requestsTo('POST /api/vault/reset')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Reset credentials' }));
    await waitFor(() => expect(requestsTo('POST /api/vault/reset')).toHaveLength(1));
  });
});
