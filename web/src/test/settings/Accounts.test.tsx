/**
 * Settings → Accounts in the server build: "Connected accounts" (Manage, Reconnect, Test, Remove,
 * Todoist), the "Add a connection" tiles and their connect dialogs (app registration when needed,
 * services, sign-in or credential form), the "App registrations" line, deep links to Todoist and
 * the vault reset.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountsSettings from '../../settings/sections/Accounts.tsx';
import { account, health, settings } from '../fixtures.ts';
import { mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../render.tsx';

const GOOGLE_CLIENT = { clientId: null, hasSecret: false, redirectUri: 'http://localhost:5757/api/oauth/google/callback' };
const MS_CLIENT = { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'http://localhost/api/oauth/microsoft/callback' };
const TOKEN = '0123456789abcdef0123456789abcdef01234567';

function baseMocks(overrides: Record<string, ApiMock> = {}): Record<string, ApiMock> {
  return {
    'GET /api/health': health(),
    'GET /api/accounts': [],
    'GET /api/oauth-clients/google': GOOGLE_CLIENT,
    'GET /api/oauth-clients/microsoft': MS_CLIENT,
    'GET /api/todoist/token': { configured: false },
    ...overrides,
  };
}

async function renderAccounts(overrides: Record<string, ApiMock> = {}, route = '#/settings/accounts') {
  const result = renderWithProviders(<AccountsSettings />, { apiMocks: baseMocks(overrides), route });
  await screen.findByRole('list', { name: 'Add a connection' });
  return { ...result, user: userEvent.setup() };
}

/** Clicks a tile and returns its dialog. */
async function openTile(user: ReturnType<typeof userEvent.setup>, tile: string | RegExp, dialog: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: tile }));
  return screen.findByRole('dialog', { name: dialog });
}

/** Tracks `location.assign` (the sign-in navigates in the same tab). */
function trackAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
  return assign;
}

afterEach(() => vi.restoreAllMocks());

describe('Accounts settings — layout', () => {
  it('keeps Connected accounts on top, then the provider tiles and the app registrations', async () => {
    await renderAccounts();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Connected accounts', 'Add a connection']);
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    const tiles = within(screen.getByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Connect Google',
      'Connect Microsoft',
      'Connect Yahoo',
      'Connect Todoist',
      'Connect another account (CalDAV or IMAP)',
    ]);
    expect(within(tiles[1]!).getByText('Outlook.com calendar and mail')).toBeInTheDocument();
    const registrations = screen.getByRole('list', { name: 'App registrations' });
    expect(await within(registrations).findByText('Setup needed')).toBeInTheDocument();
    expect(within(registrations).getByText('Ready')).toBeInTheDocument();
    // The old cards are gone.
    expect(screen.queryByRole('form', { name: /app registration/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Account type' })).not.toBeInTheDocument();
  });
});

describe('Accounts settings — Google and Microsoft', () => {
  it('Google without a registration: registration, then services, then a sign-in for the services picked', async () => {
    const assign = trackAssign();
    const state = { client: GOOGLE_CLIENT as typeof GOOGLE_CLIENT | { clientId: string; hasSecret: boolean; redirectUri: string } };
    const { user, requestsTo } = await renderAccounts({
      'GET /api/oauth-clients/google': () => state.client,
      'PUT /api/oauth-clients/google': (req: MockRequest) => {
        state.client = { ...GOOGLE_CLIENT, clientId: (req.body as { clientId: string }).clientId, hasSecret: true };
        return state.client;
      },
      'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
    });
    const dialog = await openTile(user, 'Connect Google', 'Connect Google');
    const steps = within(dialog).getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem').map((s) => s.textContent)).toEqual(['1App registration', '2Services', '3Sign in']);

    const form = within(dialog).getByRole('form', { name: 'Google app registration' });
    expect(within(dialog).getByDisplayValue('http://localhost:5757/api/oauth/google/callback')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Client ID/), 'abc.apps.googleusercontent.com');
    await user.click(within(form).getByRole('button', { name: 'Save and continue' }));
    expect(await within(form).findByText('Google requires the client secret.')).toBeInTheDocument();
    expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(0);

    await user.type(within(form).getByLabelText(/^Client secret/), 'shh');
    await user.click(within(form).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(1));
    expect(requestsTo('PUT /api/oauth-clients/google')[0]!.body).toEqual({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });

    // Services: both ticked; untick mail.
    const calendar = await within(dialog).findByRole('checkbox', { name: /Calendar/ });
    expect(calendar).toBeChecked();
    expect(within(dialog).getByText('Unread Gmail at a glance: mark as read, archive or delete.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /Mail/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    const services = within(dialog).getByRole('list', { name: 'Services to allow' });
    expect(within(services).getAllByRole('listitem').map((s) => s.textContent)).toEqual(['Calendar']);
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(requestsTo('POST /api/oauth/google/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts', capabilities: ['calendar'] });
  });

  it('Microsoft already registered: straight to the services; nothing ticked means no Continue', async () => {
    const assign = trackAssign();
    const { user, requestsTo } = await renderAccounts({
      'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
    });
    const dialog = await openTile(user, 'Connect Microsoft', 'Connect Microsoft');
    expect(within(within(dialog).getByRole('list', { name: 'Steps' })).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dialog).queryByRole('form', { name: 'Microsoft app registration' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: /Calendar/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Mail/ }));
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Mail/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts', capabilities: ['mail'] });
  });

  it('refuses to navigate to a non-http(s) authorize URL', async () => {
    const assign = trackAssign();
    const { user } = await renderAccounts({ 'POST /api/oauth/microsoft/start': { authorizeUrl: 'javascript:alert(1)' } });
    const dialog = await openTile(user, 'Connect Microsoft', 'Connect Microsoft');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByText('Could not start the sign-in.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not offer to sign in while the vault is locked (tokens could not be stored)', async () => {
    const { user } = await renderAccounts({
      'GET /api/health': health('locked'),
      'GET /api/oauth-clients/google': { ...GOOGLE_CLIENT, clientId: 'abc.apps.googleusercontent.com', hasSecret: true },
    });
    // Both providers are configured (Microsoft needs no secret); neither can connect right now.
    const registrations = screen.getByRole('list', { name: 'App registrations' });
    await waitFor(() => expect(within(registrations).getAllByText('Credentials locked')).toHaveLength(2));
    const dialog = await openTile(user, 'Connect Google', 'Connect Google');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Saved credentials are locked')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
  });
});

describe('Accounts settings — app registrations', () => {
  it('edits a registration from the line under the tiles, checking the client ID format first', async () => {
    const { user, requestsTo } = await renderAccounts({ 'PUT /api/oauth-clients/microsoft': MS_CLIENT });
    await user.click(screen.getByRole('button', { name: 'Edit the Microsoft app registration' }));
    const dialog = await screen.findByRole('dialog', { name: 'Microsoft app registration' });
    expect(within(dialog).getByText('Mobile and desktop applications')).toBeInTheDocument();
    const form = within(dialog).getByRole('form', { name: 'Microsoft app registration' });
    const input = within(form).getByLabelText(/Application \(client\) ID/);
    await user.clear(input);
    await user.type(input, 'my-app');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/looks like 00000000-0000-0000-0000-000000000000/)).toBeInTheDocument();
    expect(requestsTo('PUT /api/oauth-clients/microsoft')).toHaveLength(0);

    await user.clear(input);
    await user.type(input, '6731de76-14a6-49ae-97bc-6eba6914391e');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestsTo('PUT /api/oauth-clients/microsoft')).toHaveLength(1));
    expect(requestsTo('PUT /api/oauth-clients/microsoft')[0]!.body).toEqual({ clientId: '6731de76-14a6-49ae-97bc-6eba6914391e' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Microsoft app registration' })).not.toBeInTheDocument());
  });

  it('asks for a new Google secret when the client ID changes, and shows server field errors inline', async () => {
    const { user, requestsTo } = await renderAccounts({
      'GET /api/oauth-clients/google': { ...GOOGLE_CLIENT, clientId: 'old.apps.googleusercontent.com', hasSecret: true },
      'PUT /api/oauth-clients/google': mockError(422, 'validation_failed', 'The client secret is required', {
        details: [{ path: 'clientSecret', message: 'The client secret is required', code: 'custom' }],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Edit the Google app registration' }));
    const form = await screen.findByRole('form', { name: 'Google app registration' });
    expect(within(form).getByText('A secret is saved. Leave empty to keep it.')).toBeInTheDocument();
    const input = within(form).getByLabelText(/^Client ID/);
    await user.clear(input);
    await user.type(input, 'new.apps.googleusercontent.com');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Enter the client secret that belongs to the new client ID.')).toBeInTheDocument();
    expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(0);

    await user.type(within(form).getByLabelText(/^Client secret/), 'shh');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(1));
    expect(await within(form).findByText('The client secret is required')).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Client secret/)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Accounts settings — password accounts', () => {
  async function openYahooForm(overrides: Record<string, ApiMock> = {}) {
    const rendered = await renderAccounts(overrides);
    const dialog = await openTile(rendered.user, 'Connect Yahoo', 'Connect Yahoo');
    expect(within(dialog).getByText('Your Yahoo calendars, read-only (CalDAV).')).toBeInTheDocument();
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    return { ...rendered, dialog, form: within(dialog).getByRole('form', { name: 'Add a Yahoo account' }) };
  }

  it('validates the Yahoo form before sending anything', async () => {
    const { user, requestsTo, form } = await openYahooForm();
    await user.type(within(form).getByLabelText(/Yahoo email/), 'not-an-email');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('Enter your Yahoo email address.')).toBeInTheDocument();
    expect(within(form).getByText('Enter the app password.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/Yahoo email/)).toHaveAttribute('aria-invalid', 'true');
    expect(requestsTo('POST /api/accounts/yahoo')).toHaveLength(0);
  });

  it('adds a Yahoo account and shows what each service check found', async () => {
    const { user, requestsTo, dialog, form } = await openYahooForm({
      'POST /api/accounts/yahoo': {
        account: account({ id: 'y1', kind: 'yahoo', label: 'me@yahoo.com', capabilities: ['mail'], enabledCapabilities: ['mail'] }),
        probes: { calendar: { ok: false, code: 'provider_error', message: 'CalDAV login failed' }, mail: { ok: true } },
      },
    });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'abcd efgh ijkl mnop');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));

    await waitFor(() => expect(requestsTo('POST /api/accounts/yahoo')).toHaveLength(1));
    expect(requestsTo('POST /api/accounts/yahoo')[0]!.body).toEqual({ email: 'me@yahoo.com', appPassword: 'abcd efgh ijkl mnop' });
    expect(await within(dialog).findByText('Added with problems')).toBeInTheDocument();
    expect(within(dialog).getByText(/CalDAV login failed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/working/)).toBeInTheDocument();
    // The form (and the password in it) is gone; nothing else changed the account.
    expect(within(dialog).queryByRole('form', { name: 'Add a Yahoo account' })).not.toBeInTheDocument();
    expect(requestsTo('PATCH /api/accounts/y1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Yahoo' })).not.toBeInTheDocument());
  });

  it('switches off the Yahoo services left unticked', async () => {
    const yahoo = account({ id: 'y1', kind: 'yahoo', label: 'me@yahoo.com' });
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/yahoo': { account: yahoo, probes: { calendar: { ok: true }, mail: { ok: true } } },
      'PATCH /api/accounts/y1': (req: MockRequest) => ({ ...yahoo, ...(req.body as object) }),
    });
    const dialog = await openTile(user, 'Connect Yahoo', 'Connect Yahoo');
    await user.click(within(dialog).getByRole('checkbox', { name: /Calendar/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(within(dialog).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(dialog).getByLabelText(/App password/), 'secret');
    await user.click(within(dialog).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(dialog).findByText('Account added')).toBeInTheDocument();
    expect(within(dialog).getByText('Calendar is switched off; turn it on under Manage.')).toBeInTheDocument();
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/y1')).toHaveLength(1));
    expect(requestsTo('PATCH /api/accounts/y1')[0]!.body).toEqual({ enabledCapabilities: ['mail'] });
  });

  it('shows per-capability errors from a 422 probe failure, keeping the password', async () => {
    const { user, form } = await openYahooForm({
      'POST /api/accounts/yahoo': mockError(422, 'validation_failed', 'No capability could be verified', {
        details: {
          probes: {
            calendar: { ok: false, code: 'provider_error', message: 'Wrong app password (CalDAV)' },
            mail: { ok: false, code: 'upstream_timeout', message: 'IMAP timed out' },
          },
        },
      }),
    });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'secret');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('No capability could be verified')).toBeInTheDocument();
    expect(within(form).getByText(/Wrong app password \(CalDAV\)/)).toBeInTheDocument();
    expect(within(form).getByText(/IMAP timed out/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/App password/)).toHaveValue('secret');
  });

  it("shows per-capability errors from the server's ValidationIssue list", async () => {
    const { user, form } = await openYahooForm({
      'POST /api/accounts/yahoo': mockError(422, 'validation_failed', 'Could not connect with these settings', {
        details: [
          { path: 'calendar', message: 'CalDAV rejected the app password', code: 'provider_error' },
          { path: 'mail', message: 'IMAP login failed', code: 'provider_error' },
        ],
      }),
    });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'secret');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('Could not connect with these settings')).toBeInTheDocument();
    expect(within(form).getByText(/CalDAV rejected the app password/)).toBeInTheDocument();
    expect(within(form).getByText(/IMAP login failed/)).toBeInTheDocument();
  });

  it('Other → CalDAV calendar: requires https unless the local-network option is ticked', async () => {
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/caldav': { account: account({ id: 'c1', kind: 'caldav', label: 'NAS' }), probes: { calendar: { ok: true } } },
    });
    const dialog = await openTile(user, /Connect another account/, 'Connect another account');
    expect(within(dialog).getByRole('radio', { name: 'CalDAV calendar' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const form = within(dialog).getByRole('form', { name: 'Add a CalDAV account' });
    await user.type(within(form).getByLabelText(/^Name/), 'NAS');
    await user.type(within(form).getByLabelText(/Server URL/), 'http://192.168.1.10:5232/');
    await user.type(within(form).getByLabelText(/User name/), 'me');
    await user.type(within(form).getByLabelText(/^Password/), 'pw');
    await user.click(within(form).getByRole('button', { name: 'Add CalDAV account' }));
    expect(await within(form).findByText('Use https, or allow http for a server on your local network.')).toBeInTheDocument();
    expect(requestsTo('POST /api/accounts/caldav')).toHaveLength(0);

    await user.click(within(form).getByRole('checkbox', { name: /Allow http/ }));
    await user.click(within(form).getByRole('button', { name: 'Add CalDAV account' }));
    await waitFor(() => expect(requestsTo('POST /api/accounts/caldav')).toHaveLength(1));
    expect(requestsTo('POST /api/accounts/caldav')[0]!.body).toEqual({
      label: 'NAS',
      serverUrl: 'http://192.168.1.10:5232/',
      username: 'me',
      password: 'pw',
      insecureLan: true,
    });
    expect(await within(dialog).findByText('Account added')).toBeInTheDocument();
  });

  it('Other → CalDAV: rejects non-http(s) URLs', async () => {
    const { user, requestsTo } = await renderAccounts();
    const dialog = await openTile(user, /Connect another account/, 'Connect another account');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const form = within(dialog).getByRole('form', { name: 'Add a CalDAV account' });
    await user.type(within(form).getByLabelText(/Server URL/), 'javascript:alert(1)');
    await user.click(within(form).getByRole('button', { name: 'Add CalDAV account' }));
    expect(await within(form).findByText('Enter the server address, e.g. https://dav.example.com.')).toBeInTheDocument();
    expect(within(form).getByText('Give the account a name.')).toBeInTheDocument();
    expect(requestsTo('POST /api/accounts/caldav')).toHaveLength(0);
  });

  it('Other → IMAP mail: validates host and port and maps server field errors', async () => {
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/imap': mockError(422, 'validation_failed', 'Invalid request', {
        details: [{ path: 'webmailUrl', message: 'Webmail must be https', code: 'custom' }],
      }),
    });
    const dialog = await openTile(user, /Connect another account/, 'Connect another account');
    await user.click(within(dialog).getByRole('radio', { name: 'IMAP mail' }));
    expect(within(dialog).getByText('Any IMAP mailbox: unread count and recent messages.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const form = within(dialog).getByRole('form', { name: 'Add an IMAP account' });
    await user.type(within(form).getByLabelText(/^Name/), 'Work');
    await user.type(within(form).getByLabelText(/IMAP server/), 'imap example com');
    await user.clear(within(form).getByLabelText(/^Port/));
    await user.click(within(form).getByRole('button', { name: 'Add IMAP account' }));
    expect(await within(form).findByText('Enter the IMAP server host name, e.g. imap.example.com.')).toBeInTheDocument();
    expect(within(form).getByText('Enter a port between 1 and 65535.')).toBeInTheDocument();
    expect(requestsTo('POST /api/accounts/imap')).toHaveLength(0);

    await user.clear(within(form).getByLabelText(/IMAP server/));
    await user.type(within(form).getByLabelText(/IMAP server/), 'imap.example.com');
    await user.click(within(form).getByRole('radio', { name: 'STARTTLS (143)' }));
    expect(within(form).getByLabelText(/^Port/)).toHaveValue('');
    await user.type(within(form).getByLabelText(/^Port/), '143');
    await user.type(within(form).getByLabelText(/User name/), 'me@example.com');
    await user.type(within(form).getByLabelText(/^Password/), 'pw');
    await user.type(within(form).getByLabelText(/Webmail address/), 'http://mail.example.com/');
    await user.click(within(form).getByRole('button', { name: 'Add IMAP account' }));
    await waitFor(() => expect(requestsTo('POST /api/accounts/imap')).toHaveLength(1));
    expect(requestsTo('POST /api/accounts/imap')[0]!.body).toEqual({
      label: 'Work',
      host: 'imap.example.com',
      port: 143,
      security: 'starttls',
      username: 'me@example.com',
      password: 'pw',
      webmailUrl: 'http://mail.example.com/',
    });
    expect(await within(form).findByText('Webmail must be https')).toBeInTheDocument();
  });
});

describe('Accounts settings — connected accounts', () => {
  it('lists accounts with status and services; Manage renames and switches services; Test and Remove', async () => {
    const gmail = account({ status: 'reauth' });
    const { user, requestsTo } = await renderAccounts({
      'GET /api/accounts': [gmail],
      'PATCH /api/accounts/acc-1': (req: MockRequest) => ({ ...gmail, ...(req.body as object) }),
      'POST /api/accounts/acc-1/test': { results: { calendar: { ok: true }, mail: { ok: false, code: 'reauth_required', message: 'Sign in again' } } },
      'DELETE /api/accounts/acc-1': mockResponse(204),
    });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(list).getByText('Reconnect needed')).toBeInTheDocument();
    expect(within(list).getByText(/me@example.com/)).toBeInTheDocument();
    const chips = within(list).getByRole('list', { name: 'Personal Gmail services in use' });
    expect(within(chips).getAllByRole('listitem').map((c) => c.textContent)).toEqual(['Calendar', 'Mail']);

    await user.click(within(list).getByRole('button', { name: 'Manage Personal Gmail' }));
    const manage = await screen.findByRole('dialog', { name: 'Manage Personal Gmail' });
    const name = within(manage).getByRole('textbox', { name: 'Account name' });
    await user.clear(name);
    await user.type(name, 'Gmail{Enter}');
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/acc-1')).toHaveLength(1));
    expect(requestsTo('PATCH /api/accounts/acc-1')[0]!.body).toEqual({ label: 'Gmail' });

    await user.click(within(manage).getByRole('switch', { name: /Mail/ }));
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/acc-1')).toHaveLength(2));
    expect(requestsTo('PATCH /api/accounts/acc-1')[1]!.body).toEqual({ enabledCapabilities: ['calendar'] });
    // Nothing to add: the account has every service Google offers.
    expect(within(manage).queryByRole('button', { name: /^Add / })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(within(list).getByRole('button', { name: /^Test / }));
    expect(await screen.findByText(/has a problem/)).toBeInTheDocument();
    expect(screen.getByText(/Mail: Sign in again/)).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: /^Remove / }));
    const confirm = await screen.findByRole('dialog', { name: /Remove .*\?/ });
    expect(confirm).toHaveTextContent('revoke access');
    await user.click(within(confirm).getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(requestsTo('DELETE /api/accounts/acc-1')).toHaveLength(1));
  });

  it('adds a service the account was not granted by signing in again for it (incremental consent)', async () => {
    const assign = trackAssign();
    const outlook = account({ id: 'm1', kind: 'microsoft', label: 'Outlook', capabilities: ['calendar'], enabledCapabilities: ['calendar'] });
    const { user, requestsTo } = await renderAccounts({
      'GET /api/accounts': [outlook],
      'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
    });
    await user.click(await screen.findByRole('button', { name: 'Manage Outlook' }));
    const manage = await screen.findByRole('dialog', { name: 'Manage Outlook' });
    expect(within(manage).getByRole('switch', { name: /Calendar/ })).toBeChecked();
    expect(within(manage).queryByRole('switch', { name: /Mail/ })).not.toBeInTheDocument();
    await user.click(within(manage).getByRole('button', { name: 'Add Mail' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ accountId: 'm1', capabilities: ['mail'], returnTo: '#/settings/accounts' });
  });

  it('reconnects an OAuth account for the services it has', async () => {
    trackAssign();
    const { user, requestsTo } = await renderAccounts({
      'GET /api/accounts': [account({ id: 'g1', status: 'reauth' })],
      'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
    });
    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(requestsTo('POST /api/oauth/google/start')).toHaveLength(1));
    expect(requestsTo('POST /api/oauth/google/start')[0]!.body).toEqual({ accountId: 'g1', returnTo: '#/settings/accounts' });
  });

  it('does not call an account "working" when no check could run', async () => {
    const imap = account({ id: 'i1', kind: 'imap', label: 'Mailbox', capabilities: ['mail'], enabledCapabilities: ['mail'] });
    const { user } = await renderAccounts({ 'GET /api/accounts': [imap], 'POST /api/accounts/i1/test': { results: {} } });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(within(list).getByRole('button', { name: 'Test Mailbox' }));
    expect(await screen.findByText('There is nothing to test for Mailbox yet.')).toBeInTheDocument();
    expect(screen.queryByText('Mailbox is working.')).not.toBeInTheDocument();
  });

  it('tells how to reconnect a password account (no OAuth Reconnect button) and says when nothing is switched on', async () => {
    await renderAccounts({
      'GET /api/accounts': [
        account({ id: 'y1', kind: 'yahoo', label: 'me@yahoo.com', status: 'reauth', statusMessage: 'Credentials were reset', enabledCapabilities: [] }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(list).getByText('Credentials were reset')).toBeInTheDocument();
    expect(within(list).getByText(/add this account again under “Add a connection” with its current password/)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(within(list).getByText('Nothing switched on. Turn a service on under Manage.')).toBeInTheDocument();
  });

  it('offers Reset credentials when the vault is locked, behind a confirmation', async () => {
    const { user, requestsTo } = await renderAccounts({ 'GET /api/health': health('locked'), 'POST /api/vault/reset': mockResponse(204) });
    expect(await screen.findByText("Saved credentials can't be unlocked")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset credentials' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset all stored credentials?' });
    expect(requestsTo('POST /api/vault/reset')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Reset credentials' }));
    await waitFor(() => expect(requestsTo('POST /api/vault/reset')).toHaveLength(1));
    expect(await screen.findByText(/Credentials were reset/)).toBeInTheDocument();
  });

  it('warns that ICS subscription addresses are deleted by a reset too (UX-1)', async () => {
    const ics = (id: string) => ({ id, source: 'ics', name: id, visible: true });
    const { user } = await renderAccounts({ 'GET /api/health': health('locked'), 'GET /api/calendar/calendars': [ics('a'), ics('b')] });
    expect(await screen.findByText(/re-enter your ICS feed addresses/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset credentials' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reset all stored credentials?' });
    expect(await within(confirm).findByText(/addresses of your 2 ICS calendar subscriptions are deleted too/)).toBeInTheDocument();
  });
});

describe('Accounts settings — Todoist', () => {
  function todoistMocks(state: { configured: boolean }): Record<string, ApiMock> {
    return {
      'GET /api/settings': settings(),
      'GET /api/todoist/token': () => ({ configured: state.configured }),
      'GET /api/todoist/projects': [{ id: 'p1', name: 'Inbox', color: '#b8b8b8' }],
      'PUT /api/todoist/token': () => {
        state.configured = true;
        return { configured: true };
      },
      'DELETE /api/todoist/token': () => {
        state.configured = false;
        return { configured: false };
      },
    };
  }

  it('connects Todoist from its tile; it then shows under Connected accounts', async () => {
    const state = { configured: false };
    const { user, requestsTo } = await renderAccounts(todoistMocks(state));
    expect(screen.queryByRole('button', { name: 'Manage Todoist' })).not.toBeInTheDocument();
    const dialog = await openTile(user, 'Connect Todoist', 'Connect Todoist');
    await user.type(within(dialog).getByLabelText('API token'), `  ${TOKEN} `);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(requestsTo('PUT /api/todoist/token')).toHaveLength(1));
    expect(requestsTo('PUT /api/todoist/token')[0]!.body).toEqual({ token: TOKEN });
    expect(await screen.findByText('Todoist connected.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Todoist' })).not.toBeInTheDocument());

    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(await within(list).findByText('Connected')).toBeInTheDocument();
    expect(within(within(list).getByRole('list', { name: 'Todoist services in use' })).getByText('Tasks')).toBeInTheDocument();
  });

  it('tests and removes Todoist from its row', async () => {
    const state = { configured: true };
    const { user, requestsTo } = await renderAccounts(todoistMocks(state));
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(within(list).getByRole('button', { name: 'Test Todoist' }));
    expect(await screen.findByText('Todoist is working.')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Remove Todoist' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Todoist?' });
    expect(requestsTo('DELETE /api/todoist/token')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Remove Todoist' }));
    await waitFor(() => expect(requestsTo('DELETE /api/todoist/token')).toHaveLength(1));
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
  });

  it('opens Todoist from a deep link: Manage when connected', async () => {
    await renderAccounts(todoistMocks({ configured: true }), '#/settings/accounts?focus=todoist');
    const manage = await screen.findByRole('dialog', { name: 'Manage Todoist' });
    expect(within(manage).getByLabelText('Replace token')).toBeInTheDocument();
    expect(await within(manage).findByRole('textbox', { name: 'Filter' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings/accounts');
  });

  it("opens Todoist's connect dialog from the old Todoist section's address", async () => {
    await renderAccounts(todoistMocks({ configured: false }), '#/settings/todoist');
    expect(await screen.findByRole('dialog', { name: 'Connect Todoist' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings/accounts');
  });
});
