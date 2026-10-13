import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import GeneralSettings from '../../settings/sections/General.tsx';
import { createFakeServer } from '../fakeServer.ts';
import { renderWithProviders } from '../render.tsx';

async function renderGeneral(setup: (server: ReturnType<typeof createFakeServer>) => void = () => {}) {
  const server = createFakeServer([]);
  setup(server);
  const result = renderWithProviders(<GeneralSettings />, { apiMocks: server.mocks });
  await screen.findByRole('form', { name: 'General settings' });
  return { ...result, server, user: userEvent.setup() };
}

const patches = (requestsTo: (key: string) => { body: unknown }[]) =>
  requestsTo('PATCH /api/settings').map((r) => (r.body as { general: Record<string, unknown> }).general);

describe('General settings (saved as you go, UX-5)', () => {
  it('saves each choice on its own, without a Save button', async () => {
    const { user, requestsTo, server } = await renderGeneral();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language and region' }), 'de-DE');
    await user.click(screen.getByRole('radio', { name: '24-hour' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Week starts on' }), '0');
    await user.click(screen.getByRole('radio', { name: '°F' }));
    await user.click(screen.getByRole('radio', { name: 'mph' }));
    await user.click(screen.getByRole('radio', { name: 'in' }));
    await user.click(screen.getByRole('switch', { name: /Open bookmarks and searches in a new tab/ }));

    await waitFor(() => expect(server.settings.general).toMatchObject({ openLinksInNewTab: true }));
    expect(server.settings.general).toMatchObject({
      locale: 'de-DE',
      timeFormat: '24h',
      weekStartsOn: 0,
      temperatureUnit: 'F',
      windUnit: 'mph',
      precipUnit: 'in',
      openLinksInNewTab: true,
    });
    // Quick successive changes are folded into few requests.
    expect(requestsTo('PATCH /api/settings').length).toBeLessThanOrEqual(7);
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
  });

  it('saves the name when the field loses focus or on Enter (trimmed)', async () => {
    const { user, requestsTo, server } = await renderGeneral();
    const name = screen.getByRole('textbox', { name: 'Your name' });
    await user.type(name, '  Alex  ');
    expect(requestsTo('PATCH /api/settings')).toHaveLength(0);
    await user.tab();
    await waitFor(() => expect(server.settings.general.userName).toBe('Alex'));
    expect(patches(requestsTo)).toEqual([{ userName: 'Alex' }]);

    await user.clear(name);
    await user.type(name, 'Sam{Enter}');
    await waitFor(() => expect(server.settings.general.userName).toBe('Sam'));
  });

  it('keeps what was typed when you switch sections before leaving the field', async () => {
    const { user, server, unmount } = await renderGeneral();
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Riley');
    unmount();
    await waitFor(() => expect(server.settings.general.userName).toBe('Riley'));
  });

  it('resets an emptied name to the default with null', async () => {
    const { user, requestsTo, server } = await renderGeneral((s) => {
      s.settings.general.userName = 'Sam';
    });
    const name = screen.getByRole('textbox', { name: 'Your name' });
    expect(name).toHaveValue('Sam');
    await user.clear(name);
    await user.tab();
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(patches(requestsTo)[0]).toEqual({ userName: null });
    expect(server.settings.general.userName).toBeUndefined();
  });

  it('validates the name length and does not save it', async () => {
    const { user, requestsTo } = await renderGeneral();
    const name = screen.getByRole('textbox', { name: 'Your name' });
    await user.click(name);
    await user.paste('x'.repeat(70));
    await user.tab();
    expect(await screen.findByText('Keep your name to 64 characters or fewer.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Keep your name to 64 characters or fewer.');
    await new Promise((r) => setTimeout(r, 400));
    expect(requestsTo('PATCH /api/settings')).toHaveLength(0);
  });

  it('validates a custom language tag and saves its canonical form', async () => {
    const { user, requestsTo } = await renderGeneral();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language and region' }), 'Other…');
    const tag = screen.getByRole('textbox', { name: /Language tag/ });
    await user.type(tag, 'not a tag');
    await user.tab();
    expect(await screen.findByText('Enter a language tag such as en-US, de or pt-BR.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(requestsTo('PATCH /api/settings')).toHaveLength(0);

    await user.clear(tag);
    await user.type(tag, 'fr-ca');
    expect(screen.queryByText('Enter a language tag such as en-US, de or pt-BR.')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(requestsTo('PATCH /api/settings')).toHaveLength(1));
    expect(patches(requestsTo)[0]).toEqual({ locale: 'fr-CA' });
  });

  it('previews the date and time format live', async () => {
    const { user } = await renderGeneral();
    const preview = screen.getByText(/^Preview:/);
    await user.click(screen.getByRole('radio', { name: '24-hour' }));
    expect(within(preview).getAllByText(/\d{1,2}:\d{2}/)[0]!.textContent).not.toMatch(/AM|PM/);
    await user.click(screen.getByRole('radio', { name: '12-hour' }));
    expect(within(preview).getAllByText(/\d{1,2}:\d{2}/)[0]!.textContent).toMatch(/AM|PM/);
  });
});
