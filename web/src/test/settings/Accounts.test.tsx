import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountsSettings from '../../settings/sections/Accounts.tsx';
import { account, health } from '../fixtures.ts';
import { mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../render.tsx';

const GOOGLE_CLIENT = { clientId: null, hasSecret: false, redirectUri: 'http://localhost:5757/api/oauth/google/callback' };
const MS_CLIENT = { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'http://localhost/api/oauth/microsoft/callback' };

function baseMocks(overrides: Record<string, ApiMock> = {}): Record<string, ApiMock> {
  return {
    'GET /api/health': health(),
    'GET /api/accounts': [],
    'GET /api/oauth-clients/google': GOOGLE_CLIENT,
    'GET /api/oauth-clients/microsoft': MS_CLIENT,
    ...overrides,
  };
}

async function renderAccounts(overrides: Record<string, ApiMock> = {}) {
  const result = renderWithProviders(<AccountsSettings />, { apiMocks: baseMocks(overrides) });
  await screen.findByRole('form', { name: 'Google app registration' });
  return { ...result, user: userEvent.setup() };
}

describe('Accounts settings — app-password forms', () => {
  it('validates the Yahoo form before sending anything', async () => {
    const { user, requestsTo } = await renderAccounts();
    const form = screen.getByRole('form', { name: 'Add a Yahoo account' });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'not-an-email');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('Enter your Yahoo email address.')).toBeInTheDocument();
    expect(within(form).getByText('Enter the app password.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/Yahoo email/)).toHaveAttribute('aria-invalid', 'true');
    expect(requestsTo('POST /api/accounts/yahoo')).toHaveLength(0);
  });

  it('creates a Yahoo account and shows per-capability results, clearing the password', async () => {
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/yahoo': {
        account: account({ id: 'y1', kind: 'yahoo', label: 'me@yahoo.com', capabilities: ['mail'], enabledCapabilities: ['mail'] }),
        probes: { calendar: { ok: false, code: 'provider_error', message: 'CalDAV login failed' }, mail: { ok: true } },
      },
    });
    const form = screen.getByRole('form', { name: 'Add a Yahoo account' });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'abcd efgh ijkl mnop');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));

    await waitFor(() => expect(requestsTo('POST /api/accounts/yahoo')).toHaveLength(1));
    expect(requestsTo('POST /api/accounts/yahoo')[0]!.body).toEqual({ email: 'me@yahoo.com', appPassword: 'abcd efgh ijkl mnop' });
    expect(await within(form).findByText('Added with problems')).toBeInTheDocument();
    expect(within(form).getByText(/CalDAV login failed/)).toBeInTheDocument();
    expect(within(form).getByText(/working/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/App password/)).toHaveValue('');
  });

  it('shows per-capability errors from a 422 probe failure', async () => {
    const { user } = await renderAccounts({
      'POST /api/accounts/yahoo': mockError(422, 'validation_failed', 'No capability could be verified', {
        details: {
          probes: {
            calendar: { ok: false, code: 'provider_error', message: 'Wrong app password (CalDAV)' },
            mail: { ok: false, code: 'upstream_timeout', message: 'IMAP timed out' },
          },
        },
      }),
    });
    const form = screen.getByRole('form', { name: 'Add a Yahoo account' });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'secret');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('No capability could be verified')).toBeInTheDocument();
    expect(within(form).getByText(/Wrong app password \(CalDAV\)/)).toBeInTheDocument();
    expect(within(form).getByText(/IMAP timed out/)).toBeInTheDocument();
    // The password is kept so the user can correct and retry.
    expect(within(form).getByLabelText(/App password/)).toHaveValue('secret');
  });

  it("shows per-capability errors from the server's ValidationIssue list", async () => {
    const { user } = await renderAccounts({
      'POST /api/accounts/yahoo': mockError(422, 'validation_failed', 'Could not connect with these settings', {
        details: [
          { path: 'calendar', message: 'CalDAV rejected the app password', code: 'provider_error' },
          { path: 'mail', message: 'IMAP login failed', code: 'provider_error' },
        ],
      }),
    });
    const form = screen.getByRole('form', { name: 'Add a Yahoo account' });
    await user.type(within(form).getByLabelText(/Yahoo email/), 'me@yahoo.com');
    await user.type(within(form).getByLabelText(/App password/), 'secret');
    await user.click(within(form).getByRole('button', { name: 'Add Yahoo account' }));
    expect(await within(form).findByText('Could not connect with these settings')).toBeInTheDocument();
    expect(within(form).getByText(/CalDAV rejected the app password/)).toBeInTheDocument();
    expect(within(form).getByText(/IMAP login failed/)).toBeInTheDocument();
  });

  it('requires https for CalDAV unless the local-network option is ticked', async () => {
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/caldav': { account: account({ id: 'c1', kind: 'caldav', label: 'NAS' }), probes: { calendar: { ok: true } } },
    });
    await user.click(screen.getByRole('tab', { name: 'CalDAV calendar' }));
    const form = await screen.findByRole('form', { name: 'Add a CalDAV account' });
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
  });

  it('rejects non-http(s) CalDAV URLs', async () => {
    const { user, requestsTo } = await renderAccounts();
    await user.click(screen.getByRole('tab', { name: 'CalDAV calendar' }));
    const form = await screen.findByRole('form', { name: 'Add a CalDAV account' });
    await user.type(within(form).getByLabelText(/Server URL/), 'javascript:alert(1)');
    await user.click(within(form).getByRole('button', { name: 'Add CalDAV account' }));
    expect(await within(form).findByText('Enter the server address, e.g. https://dav.example.com.')).toBeInTheDocument();
    expect(within(form).getByText('Give the account a name.')).toBeInTheDocument();
    expect(requestsTo('POST /api/accounts/caldav')).toHaveLength(0);
  });

  it('validates IMAP host/port and maps server field errors', async () => {
    const { user, requestsTo } = await renderAccounts({
      'POST /api/accounts/imap': mockError(422, 'validation_failed', 'Invalid request', {
        details: [{ path: 'webmailUrl', message: 'Webmail must be https', code: 'custom' }],
      }),
    });
    await user.click(screen.getByRole('tab', { name: 'IMAP mail' }));
    const form = await screen.findByRole('form', { name: 'Add an IMAP account' });
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

describe('Accounts settings — OAuth', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the exact redirect URI and requires the Google client secret', async () => {
    const { user, requestsTo } = await renderAccounts({ 'PUT /api/oauth-clients/google': mockResponse(204) });
    const form = screen.getByRole('form', { name: 'Google app registration' });
    expect(screen.getAllByDisplayValue('http://localhost:5757/api/oauth/google/callback')).toHaveLength(1);
    expect(within(form).getByRole('button', { name: 'Connect Google' })).toBeDisabled();

    await user.type(within(form).getByLabelText(/^Client ID/), 'abc.apps.googleusercontent.com');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Google requires the client secret.')).toBeInTheDocument();
    expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(0);

    await user.type(within(form).getByLabelText(/^Client secret/), 'shh');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestsTo('PUT /api/oauth-clients/google')).toHaveLength(1));
    expect(requestsTo('PUT /api/oauth-clients/google')[0]!.body).toEqual({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });
  });

  it('checks the client ID format before saving (same rule as the server)', async () => {
    const { user, requestsTo } = await renderAccounts({ 'PUT /api/oauth-clients/microsoft': MS_CLIENT });
    const form = screen.getByRole('form', { name: 'Outlook.com app registration' });
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
  });

  it('asks for a new Google secret when the client ID changes, and shows server field errors inline', async () => {
    const { user, requestsTo } = await renderAccounts({
      'GET /api/oauth-clients/google': { ...GOOGLE_CLIENT, clientId: 'old.apps.googleusercontent.com', hasSecret: true },
      'PUT /api/oauth-clients/google': mockError(422, 'validation_failed', 'The client secret is required', {
        details: [{ path: 'clientSecret', message: 'The client secret is required', code: 'custom' }],
      }),
    });
    const form = screen.getByRole('form', { name: 'Google app registration' });
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

  it('does not offer to connect while the vault is locked (tokens could not be stored)', async () => {
    await renderAccounts({
      'GET /api/health': health('locked'),
      'GET /api/oauth-clients/google': { ...GOOGLE_CLIENT, clientId: 'abc.apps.googleusercontent.com', hasSecret: true },
    });
    const form = screen.getByRole('form', { name: 'Google app registration' });
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Connect Google' })).toBeDisabled());
    // Both providers are configured (Microsoft needs no secret); neither can connect right now.
    expect(screen.getAllByText('Credentials locked')).toHaveLength(2);
  });

  it('connects via POST /api/oauth/:provider/start and a same-tab location.assign', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/settings/accounts', assign } as Location);
    const { user, requestsTo } = await renderAccounts({
      'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
    });
    const form = screen.getByRole('form', { name: 'Outlook.com app registration' });
    await user.click(within(form).getByRole('button', { name: 'Connect Outlook.com' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1'));
    expect(requestsTo('POST /api/oauth/microsoft/start')[0]!.body).toEqual({ returnTo: '#/settings/accounts' });
  });

  it('refuses to navigate to a non-http(s) authorize URL', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    const { user } = await renderAccounts({ 'POST /api/oauth/microsoft/start': { authorizeUrl: 'javascript:alert(1)' } });
    await user.click(within(screen.getByRole('form', { name: 'Outlook.com app registration' })).getByRole('button', { name: 'Connect Outlook.com' }));
    expect(await screen.findByText('Could not start the sign-in.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('Accounts settings — connected accounts', () => {
  it('lists accounts with status and lets the user rename, toggle capabilities, test and remove', async () => {
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

    await user.click(within(list).getByRole('button', { name: 'Rename Personal Gmail' }));
    const name = within(list).getByRole('textbox', { name: 'Account name' });
    await user.clear(name);
    await user.type(name, 'Gmail{Enter}');
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/acc-1')).toHaveLength(1));
    expect(requestsTo('PATCH /api/accounts/acc-1')[0]!.body).toEqual({ label: 'Gmail' });

    await user.click(within(list).getByRole('switch', { name: 'Mail' }));
    await waitFor(() => expect(requestsTo('PATCH /api/accounts/acc-1')).toHaveLength(2));
    expect(requestsTo('PATCH /api/accounts/acc-1')[1]!.body).toEqual({ enabledCapabilities: ['calendar'] });

    await user.click(within(list).getByRole('button', { name: /^Test / }));
    expect(await screen.findByText(/has a problem/)).toBeInTheDocument();
    expect(screen.getByText(/Mail: Sign in again/)).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: /^Remove / }));
    const confirm = await screen.findByRole('dialog', { name: /Remove .*\?/ });
    expect(confirm).toHaveTextContent('revoke access');
    await user.click(within(confirm).getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(requestsTo('DELETE /api/accounts/acc-1')).toHaveLength(1));
  });

  it('does not call an account "working" when no check could run', async () => {
    const imap = account({ id: 'i1', kind: 'imap', label: 'Mailbox', capabilities: ['mail'], enabledCapabilities: ['mail'] });
    const { user } = await renderAccounts({ 'GET /api/accounts': [imap], 'POST /api/accounts/i1/test': { results: {} } });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(within(list).getByRole('button', { name: 'Test Mailbox' }));
    expect(await screen.findByText('There is nothing to test for Mailbox yet.')).toBeInTheDocument();
    expect(screen.queryByText('Mailbox is working.')).not.toBeInTheDocument();
  });

  it('tells how to reconnect a password account (no OAuth Reconnect button)', async () => {
    await renderAccounts({
      'GET /api/accounts': [
        account({ id: 'y1', kind: 'yahoo', label: 'me@yahoo.com', status: 'reauth', statusMessage: 'Credentials were reset' }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(list).getByText('Credentials were reset')).toBeInTheDocument();
    expect(within(list).getByText(/add this account again below with its current password/)).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('offers Reset credentials when the vault is locked, behind a confirmation', async () => {
    const { user, requestsTo } = await renderAccounts({ 'GET /api/health': health('locked'), 'POST /api/vault/reset': mockResponse(204) });
    const banner = await screen.findByText("Saved credentials can't be unlocked");
    expect(banner).toBeInTheDocument();
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
