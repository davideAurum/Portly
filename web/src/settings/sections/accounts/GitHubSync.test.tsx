/**
 * GitHub (launch pad sync through a private repository) in Settings → Accounts: offered only on the
 * in-browser backend, a write-only repository and token with the steps to create them, its row with
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
const REPOSITORY = 'octo-tester/portly-sync';

function render(state: { configured: boolean }, overrides: Record<string, ApiMock> = {}) {
  const result = renderWithProviders(<AccountsSettings />, {
    apiMocks: {
      'GET /api/health': health(),
      'GET /api/accounts': [],
      'GET /api/oauth-clients/microsoft': { clientId: 'ms-client-id', hasSecret: false, redirectUri: 'https://user.github.io/portly/' },
      'GET /api/todoist/token': { configured: false },
      'GET /api/sync/github': () => ({ configured: state.configured }),
      'PUT /api/sync/github': () => {
        state.configured = true;
        return { configured: true };
      },
      'DELETE /api/sync/github': () => {
        state.configured = false;
        return { configured: false };
      },
      ...overrides,
    },
  });
  return { ...result, user: userEvent.setup() };
}

async function openConnect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
  return screen.findByRole('dialog', { name: 'Connect GitHub' });
}

describe('Accounts: GitHub sync', () => {
  it('is offered only when the data lives in this browser', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const { requestsTo } = render({ configured: false });
    const tiles = within(await screen.findByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).not.toContain('Connect GitHub');
    expect(requestsTo('GET /api/sync/github')).toHaveLength(0);
  });

  it('connects from its tile, saying what to create on GitHub and that every change is a commit', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user, requestsTo } = render({ configured: false });
    expect(within(await screen.findByRole('button', { name: 'Connect GitHub' })).getByText('Launch pad sync (private repository)')).toBeInTheDocument();
    const dialog = await openConnect(user);
    expect(within(dialog).getByText(/Every change is a commit/)).toBeInTheDocument();
    expect(within(dialog).getByText(/not switched on yet/)).toBeInTheDocument();
    const steps = within(dialog).getByRole('list', { name: 'What to create on GitHub' });
    expect(within(steps).getByText('Contents')).toBeInTheDocument();
    expect(within(steps).getByText('Only select repositories')).toBeInTheDocument();
    expect(within(steps).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/new?name=portly-sync&visibility=private',
      'https://github.com/settings/personal-access-tokens/new',
    ]);

    const repo = within(dialog).getByLabelText('Repository (owner/name)');
    const field = within(dialog).getByLabelText('Fine-grained token');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(repo, 'not a repository');
    await user.type(field, 'ghp_TestToken0123456789abcdefghijklmnopq');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Enter the repository as owner\/name/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Classic tokens can reach every repository/)).toBeInTheDocument();
    expect(requestsTo('PUT /api/sync/github')).toHaveLength(0);

    await user.clear(repo);
    await user.type(repo, ` ${REPOSITORY} `);
    await user.clear(field);
    await user.type(field, ` ${TOKEN} `);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestsTo('PUT /api/sync/github')).toHaveLength(1));
    expect(requestsTo('PUT /api/sync/github')[0]!.body).toEqual({ repository: REPOSITORY, token: TOKEN });
    expect(await screen.findByText('GitHub connected.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    expect(within(within(list).getByRole('list', { name: 'GitHub services in use' })).getByText('Launch pad sync')).toBeInTheDocument();
    expect(list.textContent).not.toContain(TOKEN);
    expect(list.textContent).not.toContain(REPOSITORY);
  });

  it("shows GitHub's refusal next to the field it is about", async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    let field = 'repository';
    const { user } = render(
      { configured: false },
      { 'PUT /api/sync/github': () => mockError(422, 'validation_failed', `Refused (${field}).`, { details: { reason: 'token_rejected', field } }) },
    );
    const dialog = await openConnect(user);
    const repo = within(dialog).getByLabelText('Repository (owner/name)');
    const token = within(dialog).getByLabelText('Fine-grained token');
    await user.type(repo, REPOSITORY);
    await user.type(token, TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Refused (repository).')).toBeInTheDocument();
    expect(repo).toHaveAttribute('aria-invalid', 'true');
    expect(token).not.toHaveAttribute('aria-invalid');
    field = 'token';
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Refused (token).')).toBeInTheDocument();
    expect(token).toHaveAttribute('aria-invalid', 'true');
  });

  it('replaces and removes the settings from its row', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user, requestsTo } = render({ configured: true });
    const list = await screen.findByRole('list', { name: 'Connected accounts' });
    await user.click(await within(list).findByRole('button', { name: 'Manage GitHub' }));
    const manage = await screen.findByRole('dialog', { name: 'Manage GitHub' });
    await user.type(within(manage).getByLabelText('Repository (owner/name)'), REPOSITORY);
    await user.type(within(manage).getByLabelText('New token'), TOKEN);
    await user.click(within(manage).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('GitHub sync settings updated.')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Remove GitHub' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove GitHub?' });
    expect(within(confirm).getByText(/The repository stays in your GitHub account/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Remove GitHub' }));
    await waitFor(() => expect(requestsTo('DELETE /api/sync/github')).toHaveLength(1));
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
  });
});
