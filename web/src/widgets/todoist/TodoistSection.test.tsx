/** Settings → Todoist (web/src/settings/sections/Todoist.tsx). */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SettingsPatch } from '@portly/shared';
import TodoistSettingsSection from '../../settings/sections/Todoist.tsx';
import { health, settings } from '../../test/fixtures.ts';
import { mockError, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';

const TOKEN = '0123456789abcdef0123456789abcdef01234567';

function renderSection(options: { configured?: boolean; vault?: 'ready' | 'locked'; mocks?: Record<string, ApiMock> } = {}) {
  const state = { configured: options.configured ?? false, settings: settings() };
  const patches: SettingsPatch[] = [];
  const result = renderWithProviders(<TodoistSettingsSection />, {
    apiMocks: {
      'GET /api/health': health(options.vault ?? 'ready'),
      'GET /api/settings': () => state.settings,
      'PATCH /api/settings': (req: MockRequest) => {
        const patch = req.body as SettingsPatch;
        patches.push(patch);
        const filter = patch.todoist?.defaultFilter;
        state.settings = { ...state.settings, todoist: { defaultFilter: filter === null || filter === undefined ? 'today | overdue' : filter } };
        return state.settings;
      },
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
      ...options.mocks,
    },
  });
  return Object.assign(result, { state, patches });
}

describe('Settings → Todoist: token', () => {
  it('explains where to find the token and saves a trimmed token', async () => {
    const user = userEvent.setup();
    const h = renderSection();
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('Settings → Integrations → Developer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open it directly/ })).toHaveAttribute('href', 'https://app.todoist.com/app/settings/integrations/developer');

    const field = screen.getByLabelText('API token');
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');

    await user.type(field, `  ${TOKEN} `);
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(h.requestsTo('PUT /api/todoist/token')).toHaveLength(1));
    expect(h.requestsTo('PUT /api/todoist/token')[0]!.body).toEqual({ token: TOKEN });
    expect(await screen.findByText('Todoist connected.')).toBeInTheDocument();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(await screen.findByText(/1 project found/)).toBeInTheDocument();
    expect(screen.getByLabelText('Replace token')).toHaveValue('');
  });

  it('catches obviously wrong input before calling the server', async () => {
    const user = userEvent.setup();
    const h = renderSection();
    await user.type(await screen.findByLabelText('API token'), 'not a token');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText(/doesn't look like a Todoist API token/)).toBeInTheDocument();
    expect(h.requestsTo('PUT /api/todoist/token')).toHaveLength(0);
  });

  it('shows the server message when Todoist rejects the token', async () => {
    const user = userEvent.setup();
    renderSection({
      mocks: {
        'PUT /api/todoist/token': mockError(422, 'validation_failed', 'Todoist rejected this token. Copy the API token again.', {
          details: { reason: 'token_rejected' },
        }),
      },
    });
    const field = await screen.findByLabelText('API token');
    await user.type(field, TOKEN);
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('Todoist rejected this token. Copy the API token again.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue(TOKEN);
  });

  it('removes the token after confirmation', async () => {
    const user = userEvent.setup();
    const h = renderSection({ configured: true });
    await user.click(await screen.findByRole('button', { name: 'Remove token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the Todoist token?' });
    expect(h.requestsTo('DELETE /api/todoist/token')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove token' }));
    await waitFor(() => expect(h.requestsTo('DELETE /api/todoist/token')).toHaveLength(1));
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('flags a token Todoist no longer accepts', async () => {
    renderSection({
      configured: true,
      mocks: { 'GET /api/todoist/projects': mockError(409, 'not_configured', 'Todoist rejected the saved API token.', { details: { reason: 'token_rejected' } }) },
    });
    expect(await screen.findByText('Todoist rejected the saved token')).toBeInTheDocument();
    expect(screen.getByText('Token rejected')).toBeInTheDocument();
  });

  it('explains a locked vault and disables saving', async () => {
    renderSection({ configured: true, vault: 'locked' });
    expect(await screen.findByText('Saved credentials are locked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Accounts' })).toHaveAttribute('href', '#/settings/accounts');
    expect(screen.getByLabelText('Replace token')).toBeDisabled();
    // A token that can't be decrypted is not "Connected".
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).toBeNull();
  });
});

describe('Settings → Todoist: default filter', () => {
  it('saves a preset or typed filter and can reset to the default', async () => {
    const user = userEvent.setup();
    const h = renderSection();
    const input = await screen.findByRole('textbox', { name: 'Filter' });
    await waitFor(() => expect(input).toHaveValue('today | overdue'));
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Priority 1' }));
    expect(input).toHaveValue('p1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.patches).toEqual([{ todoist: { defaultFilter: 'p1' } }]));

    await user.clear(input);
    await user.type(input, '  #Work & 7 days ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.patches.at(-1)).toEqual({ todoist: { defaultFilter: '#Work & 7 days' } }));

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(h.patches.at(-1)).toEqual({ todoist: { defaultFilter: null } }));
    await waitFor(() => expect(input).toHaveValue('today | overdue'));
  });

  it('refuses an empty filter', async () => {
    const user = userEvent.setup();
    const h = renderSection();
    const input = await screen.findByRole('textbox', { name: 'Filter' });
    await waitFor(() => expect(input).toHaveValue('today | overdue'));
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a filter, or reset to the default.')).toBeInTheDocument();
    expect(h.patches).toHaveLength(0);
  });
});
