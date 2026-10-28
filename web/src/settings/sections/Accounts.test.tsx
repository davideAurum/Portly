/**
 * Accounts settings on the Pages site using Portly on this PC: the same page as the server build
 * (there is one Portly page, with or without the server). Every connection tile, signing in, OAuth
 * app registrations, app-password accounts, Reconnect and the vault reset all happen here, and
 * nothing links out to a page on this PC. (The server build is covered in
 * `src/test/settings/Accounts.test.tsx`.)
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
function usePortlyOnThisPc(): void {
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
  usePortlyOnThisPc();
  return renderWithProviders(<AccountsSettings />, {
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': [],
      'GET /api/oauth-clients/google': GOOGLE_CLIENT,
      'GET /api/oauth-clients/microsoft': MS_CLIENT,
      'GET /api/todoist/token': { configured: false },
      ...mocks,
    },
  });
}

/** No link on the page leads to Portly's own page on this PC. */
function expectNoLinkToThisPc(): void {
  expect(screen.queryByRole('link', { name: /Open Portly on this PC/ })).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="http://localhost"], a[href^="http://127.0.0.1"]')).toBeNull();
}

describe('Accounts settings with Portly on this PC', () => {
  it('offers every connection, the app registrations and the account forms here, as the server build does', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const user = userEvent.setup();
    const { requestsTo } = renderAccounts({
      'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
    });
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByText(/or an IMAP mailbox below to see your calendars, mail and tasks/)).toBeInTheDocument();
    const tiles = within(screen.getByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'Connect Google',
      'Connect Microsoft',
      'Connect Yahoo',
      'Connect Todoist',
      'Connect another account (CalDAV or IMAP)',
    ]);
    expect(screen.queryByText(/need the Portly server/)).not.toBeInTheDocument();
    const registrations = screen.getByRole('list', { name: 'App registrations' });
    expect(within(registrations).getByRole('button', { name: 'Edit the Google app registration' })).toBeInTheDocument();
    await waitFor(() => expect(requestsTo('GET /api/oauth-clients/google')).toHaveLength(1));
    expect(requestsTo('GET /api/oauth-clients/microsoft')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Connect Yahoo' }));
    const yahoo = await screen.findByRole('dialog', { name: 'Connect Yahoo' });
    await user.click(within(yahoo).getByRole('button', { name: 'Continue' }));
    expect(within(yahoo).getByRole('form', { name: 'Add a Yahoo account' })).toBeInTheDocument();
    expectNoLinkToThisPc();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Connect Microsoft' }));
    const microsoft = await screen.findByRole('dialog', { name: 'Connect Microsoft' });
    expect(within(microsoft).getByRole('checkbox', { name: /Mail/ })).toBeChecked();
    await user.click(within(microsoft).getByRole('button', { name: 'Continue' }));
    await user.click(within(microsoft).getByRole('button', { name: 'Sign in with Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1'));
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts', capabilities: ['calendar', 'mail'] });
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
    // The rows (each row also holds a list of its services).
    const [gmail, outlook, imap] = Array.from(list.children) as HTMLElement[];
    expect(within(outlook!).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(imap!).getByText(/add this account again under “Add a connection” with its current password/)).toBeInTheDocument();
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
    expect(screen.queryByText(/Portly's own page/)).not.toBeInTheDocument();
    expectNoLinkToThisPc();
    await user.click(screen.getByRole('button', { name: 'Reset credentials' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset all stored credentials?' });
    expect(requestsTo('POST /api/vault/reset')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Reset credentials' }));
    await waitFor(() => expect(requestsTo('POST /api/vault/reset')).toHaveLength(1));
  });
});

describe('Accounts settings on the in-browser backend', () => {
  it('signs in to Microsoft for the calendar only, from this browser', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const user = userEvent.setup();
    const { requestsTo } = renderWithProviders(<AccountsSettings />, {
      apiMocks: {
        'GET /api/health': health(),
        'GET /api/accounts': [],
        'GET /api/oauth-clients/microsoft': { ...MS_CLIENT, redirectUri: 'https://user.github.io/portly/' },
        'GET /api/todoist/token': { configured: false },
        'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Microsoft' });
    expect(within(dialog).getByRole('checkbox', { name: /Calendar/ })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: /Mail/ })).not.toBeInTheDocument();
    // Launch pad sync is offered here, but never ticked for the user.
    expect(within(dialog).getByRole('checkbox', { name: /Launch pad sync/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText(/lasts 24 hours/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts', capabilities: ['calendar'] });
    expect(requestsTo('GET /api/oauth-clients/google')).toHaveLength(0);
  });

  it('asks for launch pad sync when it is ticked', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const user = userEvent.setup();
    const { requestsTo } = renderWithProviders(<AccountsSettings />, {
      apiMocks: {
        'GET /api/health': health(),
        'GET /api/accounts': [],
        'GET /api/oauth-clients/microsoft': { ...MS_CLIENT, redirectUri: 'https://user.github.io/portly/' },
        'GET /api/todoist/token': { configured: false },
        'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Microsoft' });
    await user.click(within(dialog).getByRole('checkbox', { name: /Launch pad sync/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts', capabilities: ['calendar', 'launchpadSync'] });
  });
});

describe('Accounts settings on another PC', () => {
  it('offers Yahoo, Todoist and Other only, no app registrations, no vault reset, and says the rest happens on the main PC', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    const { requestsTo } = renderWithProviders(<AccountsSettings />, {
      apiMocks: {
        'GET /api/health': health('locked'),
        'GET /api/accounts': [account({ id: 'acc-1', kind: 'google', status: 'reauth' })],
        'GET /api/todoist/token': { configured: false },
      },
    });
    const tiles = within(await screen.findByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(['Connect Yahoo', 'Connect Todoist', 'Connect another account (CalDAV or IMAP)']);
    expect(screen.getByText(/Google and Microsoft accounts are connected on the main PC/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'App registrations' })).not.toBeInTheDocument();
    expect(requestsTo('GET /api/oauth-clients/google')).toEqual([]);
    // The reauth account offers no Reconnect here, and the locked vault no reset.
    expect(await screen.findByText('Reconnect it on the main PC, in its Settings → Accounts.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset credentials' })).not.toBeInTheDocument();
    expect(screen.getByText(/Reset them on the main PC/)).toBeInTheDocument();
  });

  it('with no account yet, the empty state names what can be connected from here', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    renderWithProviders(<AccountsSettings />, {
      apiMocks: { 'GET /api/health': health(), 'GET /api/accounts': [], 'GET /api/todoist/token': { configured: false } },
    });
    expect(await screen.findByText(/Connect Yahoo, Todoist, a CalDAV server or an IMAP mailbox below/)).toBeInTheDocument();
  });
});
