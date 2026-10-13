import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ProfilesSettings from '../../settings/sections/Profiles.tsx';
import { createFakeServer } from '../fakeServer.ts';
import { profile, widget } from '../fixtures.ts';
import { renderWithProviders } from '../render.tsx';

function setup() {
  const server = createFakeServer([
    profile('p1', 'Home', [widget('w1', 'clock', 0, 0, 4, 3)], 0),
    profile('p2', 'Work', [], 1),
  ]);
  const result = renderWithProviders(<ProfilesSettings />, { apiMocks: server.mocks });
  return { ...result, server, user: userEvent.setup() };
}

describe('Profiles settings', () => {
  it('lists profiles with the active one marked', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Profiles' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Home'), expect.stringContaining('Work')]);
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('1 widget')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Make active' })).toBeInTheDocument();
  });

  it('creates a profile as a copy, validating the name', async () => {
    const { user, requestsTo, server } = setup();
    const form = await screen.findByRole('form', { name: 'Create a profile' });
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(await within(form).findByText('Use 1–64 characters.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Name/), 'home');
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(await within(form).findByText('A profile with this name already exists.')).toBeInTheDocument();

    await user.clear(within(form).getByLabelText(/^Name/));
    await user.type(within(form).getByLabelText(/^Name/), 'Weekend');
    await user.selectOptions(within(form).getByLabelText('Start from'), 'A copy of Home');
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    await waitFor(() => expect(requestsTo('POST /api/profiles')).toHaveLength(1));
    expect(requestsTo('POST /api/profiles')[0]!.body).toEqual({ name: 'Weekend', copyFromId: 'p1' });
    expect(await screen.findByText('Weekend created.')).toBeInTheDocument();
    expect(server.profiles).toHaveLength(3);
  });

  it('renames, reorders, activates and deletes', async () => {
    const { user, requestsTo, server } = setup();
    const list = await screen.findByRole('list', { name: 'Profiles' });

    await user.click(within(list).getByRole('button', { name: 'Rename Work' }));
    const input = within(list).getByRole('textbox', { name: 'Profile name' });
    await user.clear(input);
    await user.type(input, 'Office{Enter}');
    await waitFor(() => expect(server.profiles[1]!.name).toBe('Office'));

    await user.click(await within(list).findByRole('button', { name: 'Move Office up' }));
    await waitFor(() => expect(requestsTo('PATCH /api/profiles/p2').length).toBeGreaterThan(1));
    await waitFor(() => expect(server.profiles.find((p) => p.id === 'p2')!.sort).toBe(0));
    expect(server.profiles.find((p) => p.id === 'p1')!.sort).toBe(1);

    await user.click(within(list).getByRole('button', { name: 'Make active' }));
    await waitFor(() => expect(server.settings.activeProfileId).toBe('p2'));

    await user.click(within(list).getByRole('button', { name: 'Delete Office' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Office?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(server.profiles.map((p) => p.id)).toEqual(['p1']));
    // The last profile cannot be deleted.
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Delete Home' })).toBeDisabled());
  });
});
