/**
 * Pages-build copy in Settings → Search and Settings → Todoist on the in-browser backend
 * (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`): suggestions are described as
 * going straight to Wikipedia with the other providers labelled unavailable (the stored enum is
 * unchanged), the Todoist token is described as living in this browser, Todoist's own token help is
 * linked (the Homebase repository is private) and the vault-locked banner never shows. On the
 * Homebase server on this PC (hybrid mode) the server's copy applies, and a locked vault links to
 * this page's own Accounts settings, where it is reset.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import SearchSettings, { isSuggestProviderAvailable } from '../../settings/sections/Search.tsx';
import TodoistSettingsSection, { TODOIST_TOKEN_HELP_URL } from '../../settings/sections/Todoist.tsx';
import { createFakeServer } from '../fakeServer.ts';
import { health, settings } from '../fixtures.ts';
import { fakeLocalServer } from '../hybrid.ts';
import { renderWithProviders } from '../render.tsx';

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

describe('static build: Settings → Search copy', () => {
  it('describes Wikipedia-only suggestions and labels the other providers unavailable, keeping the enum', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const list = await screen.findByRole('list', { name: 'Search engines' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Google (not available in this build) suggestions');
    expect(items[4]).toHaveTextContent('Wikipedia suggestions');
    expect(items[4]).not.toHaveTextContent('not available');

    expect(screen.getByText(/directly from your browser to Wikipedia; Google, DuckDuckGo, Bing and YouTube suggestions are not available in the browser-only build/)).toBeInTheDocument();
    expect(screen.queryByText(/through Homebase/)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    const select = within(dialog).getByRole('combobox', { name: 'Suggestions from' });
    const options = within(select).getAllByRole('option');
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'google', 'ddg', 'bing', 'wikipedia', 'youtube']);
    expect(options.map((o) => o.textContent)).toEqual([
      'Default engine’s',
      'Google (not available in this build)',
      'DuckDuckGo (not available in this build)',
      'Bing (not available in this build)',
      'Wikipedia',
      'YouTube (not available in this build)',
    ]);
    expect(isSuggestProviderAvailable('wikipedia')).toBe(true);
    expect(isSuggestProviderAvailable('google')).toBe(false);
  });
});

describe('static build: Settings → Todoist copy', () => {
  it('says where the token lives, links the hosted guide and ignores a "locked" vault', async () => {
    renderWithProviders(<TodoistSettingsSection />, {
      apiMocks: {
        'GET /api/health': health('locked'),
        'GET /api/settings': settings(),
        'GET /api/todoist/token': { configured: true },
        'GET /api/todoist/projects': [{ id: 'p1', name: 'Inbox', color: '#b8b8b8' }],
      },
    });
    expect(await screen.findByText(/stored only in this browser on this device, not encrypted, and is sent only to api\.todoist\.com; it is not included in exports/)).toBeInTheDocument();
    expect(screen.queryByText(/stored encrypted on this PC/)).toBeNull();
    const guide = screen.getByRole('link', { name: /Find your API token/ });
    expect(TODOIST_TOKEN_HELP_URL).toBe('https://www.todoist.com/help/articles/find-your-api-token-Jpzx9IIlB');
    expect(guide).toHaveAttribute('href', TODOIST_TOKEN_HELP_URL);
    expect(guide).toHaveAttribute('target', '_blank');
    expect(screen.queryByText(/in the Homebase folder/)).toBeNull();
    // Nothing points into the private Homebase repository (it would 404 for everyone but its owner).
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href') ?? '').not.toContain('github.com');
    // Step 3 still holds: the static backend validates the token with Todoist before storing it.
    expect(screen.getByText(/Homebase checks it with Todoist before storing it/)).toBeInTheDocument();

    // A "locked" health answer is meaningless without a vault: no banner, nothing disabled.
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Saved credentials are locked')).toBeNull();
    expect(screen.queryByText('Locked')).toBeNull();
    expect(screen.getByLabelText('Replace token')).not.toBeDisabled();
    expect(screen.getByText(/1 project found/)).toBeInTheDocument();
  });
});

describe('Pages build on the Homebase server on this PC: Settings → Search and Todoist', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('offers every suggestion provider through Homebase', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Google suggestions');
    expect(screen.queryByText(/not available/)).toBeNull();
    expect(screen.getByText(/through Homebase/)).toBeInTheDocument();
    expect(isSuggestProviderAvailable('google')).toBe(true);
  });

  it('keeps the token in the vault, and a locked vault links to this page’s Accounts settings', async () => {
    const fake = fakeLocalServer({
      backend: 'server',
      status: 'connected',
      paired: true,
      // Whatever page address the server reports, nothing links to it.
      server: { version: '0.1.0', instanceId: 'i1', appUrl: 'https://evil.example/', apiVersion: 1, vault: 'locked' },
    });
    act(() => setLocalServerController(fake.controller));
    renderWithProviders(<TodoistSettingsSection />, {
      apiMocks: {
        'GET /api/health': health('locked'),
        'GET /api/settings': settings(),
        'GET /api/todoist/token': { configured: true },
      },
    });
    expect(await screen.findByText('Saved credentials are locked')).toBeInTheDocument();
    expect(screen.getByText(/stored encrypted on this PC/)).toBeInTheDocument();
    expect(screen.getByText(/Reset credentials in Settings → Accounts, then add your token here again/)).toBeInTheDocument();
    expect(screen.queryByText(/Homebase's own page/)).toBeNull();
    const link = screen.getByRole('link', { name: 'Open Accounts' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(link).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: /Open Homebase on this PC/ })).toBeNull();
    for (const each of screen.queryAllByRole('link')) expect(each.getAttribute('href') ?? '').not.toContain('evil.example');
    expect(screen.getByLabelText('Replace token')).toBeDisabled();
  });
});
