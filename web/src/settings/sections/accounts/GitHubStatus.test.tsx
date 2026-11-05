/**
 * GitHub repositories in Settings → Accounts: offered everywhere, separate from launch pad sync, a
 * write-only read-only token with the steps to create it, and its row with Manage, Test and Remove.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../../capabilities.ts';
import { health } from '../../../test/fixtures.ts';
import { mockError, renderWithProviders, type ApiMock } from '../../../test/render.tsx';
import AccountsSettings from '../Accounts.tsx';
import { GITHUB_STATUS_TOKEN_URL } from './GitHubStatus.tsx';

const TOKEN = 'github_pat_11TESTTOKEN0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
const BOARD = { login: 'octo-tester', repos: [], total: 25, truncated: false, skipped: 0 };

function render(state: { configured: boolean }, overrides: Record<string, ApiMock> = {}, route?: string) {
  const result = renderWithProviders(<AccountsSettings />, {
    ...(route ? { route } : {}),
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': [],
      'GET /api/oauth-clients/microsoft': { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'https://user.github.io/portly/' },
      'GET /api/oauth-clients/google': { clientId: '', hasSecret: false, redirectUri: 'http://localhost:5757/' },
      'GET /api/todoist/token': { configured: false },
      'GET /api/sync/github': { configured: false },
      'GET /api/github/token': () => ({ configured: state.configured }),
      'GET /api/github/repos': BOARD,
      'PUT /api/github/token': () => {
        state.configured = true;
        return { configured: true };
      },
      'DELETE /api/github/token': () => {
        state.configured = false;
        return { configured: false };
      },
      ...overrides,
    },
  });
  return { ...result, user: userEvent.setup() };
}

async function openConnect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Connect GitHub repositories' }));
  return screen.findByRole('dialog', { name: 'Connect GitHub repositories' });
}

describe('Accounts: GitHub repositories', () => {
  it.each([
    ['Portly’s own page', capabilitiesFor(false, 'server')],
    ['the paired site', capabilitiesFor(true, 'server')],
    ['another PC', capabilitiesFor(true, 'server', true)],
    ['the browser-only site', capabilitiesFor(true, 'browser')],
  ])('is offered on %s', async (_, caps) => {
    setCapabilitiesForTests(caps);
    render({ configured: false });
    expect(within(await screen.findByRole('button', { name: 'Connect GitHub repositories' })).getByText('Status board of your repositories')).toBeInTheDocument();
  });

  it('asks for a read-only token, with a link that fills in the permissions', async () => {
    const { user } = render({ configured: false });
    const dialog = await openConnect(user);
    const steps = within(dialog).getByRole('list', { name: 'What to create on GitHub' });
    const link = within(steps).getByRole('link', { name: /open it directly/ });
    expect(link).toHaveAttribute('href', GITHUB_STATUS_TOKEN_URL);
    for (const permission of ['contents=read', 'issues=read', 'pull_requests=read', 'statuses=read']) expect(GITHUB_STATUS_TOKEN_URL).toContain(permission);
    expect(GITHUB_STATUS_TOKEN_URL).not.toContain('=write');
    expect(within(steps).getByText('All repositories')).toBeInTheDocument();
    expect(within(dialog).getByText(/can read all of your repositories, private code included/)).toBeInTheDocument();
  });

  it('says where the token lives on each backend', async () => {
    const first = render({ configured: false });
    expect(within(await openConnect(first.user)).getByText(/stored encrypted on this PC/)).toBeInTheDocument();
    first.unmount();
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const second = render({ configured: false });
    expect(within(await openConnect(second.user)).getByText(/only in this browser on this device, not encrypted/)).toBeInTheDocument();
  });

  it('saves a token and shows the connection', async () => {
    const state = { configured: false };
    const { user, requestsTo } = render(state);
    const dialog = await openConnect(user);
    await user.type(within(dialog).getByLabelText('Fine-grained token'), TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('GitHub repositories connected.')).toBeInTheDocument();
    expect(requestsTo('PUT /api/github/token')).toHaveLength(1);
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(within(list).getByRole('list', { name: 'GitHub repositories services in use' })).getByText('Status board')).toBeInTheDocument();
    expect(await within(list).findByText('Connected')).toBeInTheDocument();
  });

  it('refuses a classic token before asking GitHub', async () => {
    const { user, requestsTo } = render({ configured: false });
    const dialog = await openConnect(user);
    await user.type(within(dialog).getByLabelText('Fine-grained token'), `ghp_${'a'.repeat(36)}`);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    expect(await within(dialog).findByText(/^Classic tokens can also change/)).toBeInTheDocument();
    expect(requestsTo('PUT /api/github/token')).toHaveLength(0);
  });

  it('shows GitHub\'s refusal next to the field', async () => {
    const { user } = render({ configured: false }, { 'PUT /api/github/token': mockError(422, 'validation_failed', 'GitHub accepted the token, but it may not read Issues.') });
    const dialog = await openConnect(user);
    await user.type(within(dialog).getByLabelText('Fine-grained token'), TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    expect(await within(dialog).findByText(/may not read Issues/)).toBeInTheDocument();
  });

  it('tests the saved token', async () => {
    const { user } = render({ configured: true });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(await within(list).findByRole('button', { name: 'Test GitHub repositories' }));
    expect(await screen.findByText('GitHub is working.')).toBeInTheDocument();
    expect(await screen.findByText('25 repositories found.')).toBeInTheDocument();
  });

  it('shows a token GitHub stopped accepting, and replaces it under Manage', async () => {
    const { user, requestsTo } = render(
      { configured: true },
      { 'GET /api/github/repos': mockError(409, 'not_configured', 'GitHub rejected the saved token.', { details: { reason: 'token_rejected' } }) },
    );
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(await within(list).findByText('Token refused')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Manage GitHub repositories' }));
    const manage = await screen.findByRole('dialog', { name: 'Manage GitHub repositories' });
    expect(within(manage).getByText('GitHub refused the saved token')).toBeInTheDocument();
    await user.type(within(manage).getByLabelText('Replace token'), TOKEN);
    await user.click(within(manage).getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText('GitHub token updated.')).toBeInTheDocument();
    expect(requestsTo('PUT /api/github/token')).toHaveLength(1);
  });

  it('removes the token after asking', async () => {
    const state = { configured: true };
    const { user, requestsTo } = render(state);
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(await within(list).findByRole('button', { name: 'Remove GitHub repositories' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove GitHub repositories?' });
    expect(within(confirm).getByText(/revoke the token there too/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('GitHub repositories removed.')).toBeInTheDocument();
    expect(requestsTo('DELETE /api/github/token')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove GitHub repositories' })).not.toBeInTheDocument());
  });

  it('the widget\'s link opens the connect dialog, or Manage once connected', async () => {
    const first = render({ configured: false }, {}, '#/settings/accounts?focus=github-status');
    expect(await screen.findByRole('dialog', { name: 'Connect GitHub repositories' })).toBeInTheDocument();
    first.unmount();
    render({ configured: true }, {}, '#/settings/accounts?focus=github-status');
    expect(await screen.findByRole('dialog', { name: 'Manage GitHub repositories' })).toBeInTheDocument();
  });
});
