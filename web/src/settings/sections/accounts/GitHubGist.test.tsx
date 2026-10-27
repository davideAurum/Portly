/**
 * GitHub (launch pad sync through secret gists) in Settings → Accounts: offered only on the
 * in-browser backend, a write-only token with a line on which token to create, its row with
 * Manage and Remove.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../../capabilities.ts';
import { health } from '../../../test/fixtures.ts';
import { mockError, renderWithProviders, type ApiMock } from '../../../test/render.tsx';
import AccountsSettings from '../Accounts.tsx';

const TOKEN = 'github_pat_11TESTTOKEN0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';

function render(state: { configured: boolean }, overrides: Record<string, ApiMock> = {}) {
  const result = renderWithProviders(<AccountsSettings />, {
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': [],
      'GET /api/oauth-clients/microsoft': { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'https://user.github.io/portly/' },
      'GET /api/todoist/token': { configured: false },
      'GET /api/sync/gist/token': () => ({ configured: state.configured }),
      'PUT /api/sync/gist/token': () => {
        state.configured = true;
        return { configured: true };
      },
      'DELETE /api/sync/gist/token': () => {
        state.configured = false;
        return { configured: false };
      },
      ...overrides,
    },
  });
  return { ...result, user: userEvent.setup() };
}

describe('Accounts: GitHub gist token', () => {
  it('is offered only when the data lives in this browser', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const { requestsTo } = render({ configured: false });
    const tiles = within(await screen.findByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).not.toContain('Connect GitHub');
    expect(requestsTo('GET /api/sync/gist/token')).toHaveLength(0);
  });

  it('connects from its tile, saying which token to create and that the gists are unlisted, not private', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user, requestsTo } = render({ configured: false });
    const tile = await screen.findByRole('button', { name: 'Connect GitHub' });
    expect(within(tile).getByText('Launch pad sync (secret gist)')).toBeInTheDocument();
    await user.click(tile);
    const dialog = await screen.findByRole('dialog', { name: 'Connect GitHub' });
    expect(within(dialog).getByText(/unlisted, not private/)).toBeInTheDocument();
    expect(within(dialog).getByText(/not switched on yet/)).toBeInTheDocument();
    const steps = within(dialog).getByRole('list', { name: 'Which token to create' });
    expect(within(steps).getByText('Gists')).toBeInTheDocument();
    expect(within(steps).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/settings/personal-access-tokens/new',
      'https://github.com/settings/tokens/new?scopes=gist&description=Portly%20launch%20pad%20sync',
    ]);

    const field = within(dialog).getByLabelText('Personal access token');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'nonsense');
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    expect(await within(dialog).findByText(/doesn't look like a GitHub personal access token/)).toBeInTheDocument();
    expect(requestsTo('PUT /api/sync/gist/token')).toHaveLength(0);

    await user.clear(field);
    await user.type(field, ` ${TOKEN} `);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(requestsTo('PUT /api/sync/gist/token')).toHaveLength(1));
    expect(requestsTo('PUT /api/sync/gist/token')[0]!.body).toEqual({ token: TOKEN });
    expect(await screen.findByText('GitHub connected.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(within(list).getByRole('list', { name: 'GitHub services in use' })).getByText('Launch pad sync')).toBeInTheDocument();
    expect(list.textContent).not.toContain(TOKEN);
  });

  it("shows GitHub's refusal next to the field", async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user } = render(
      { configured: false },
      { 'PUT /api/sync/gist/token': mockError(422, 'validation_failed', 'This token can do more than Portly needs (repo).', { details: { reason: 'token_rejected' } }) },
    );
    await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect GitHub' });
    await user.type(within(dialog).getByLabelText('Personal access token'), TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Save token' }));
    expect(await within(dialog).findByText('This token can do more than Portly needs (repo).')).toBeInTheDocument();
  });

  it('replaces and removes the token from its row', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user, requestsTo } = render({ configured: true });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(await within(list).findByRole('button', { name: 'Manage GitHub' }));
    const manage = await screen.findByRole('dialog', { name: 'Manage GitHub' });
    await user.type(within(manage).getByLabelText('Replace token'), TOKEN);
    await user.click(within(manage).getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText('GitHub token updated.')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Remove GitHub' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove GitHub?' });
    expect(within(confirm).getByText(/The gists stay in your GitHub account/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove GitHub' }));
    await waitFor(() => expect(requestsTo('DELETE /api/sync/gist/token')).toHaveLength(1));
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
  });
});
