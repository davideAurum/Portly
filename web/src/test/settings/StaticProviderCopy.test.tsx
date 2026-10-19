/**
 * Pages-build copy in Settings → Search and Settings → Todoist on the in-browser backend
 * (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`): suggestions are described as
 * going straight to Wikipedia, and the other providers as not available unless this browser turns
 * on "Wikipedia suggestions instead" (the stored enum is unchanged), the Todoist token is described as living in this browser, Todoist's own token help is
 * linked (the guide in the Portly folder is out of the site's reach) and the vault-locked banner never shows. On the
 * Portly server on this PC (hybrid mode) the server's copy applies, and a locked vault links to
 * this page's own Accounts settings, where it is reset.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import SearchSettings from '../../settings/sections/Search.tsx';
import TodoistSettingsSection, { TODOIST_TOKEN_HELP_URL } from '../../settings/sections/Todoist.tsx';
import { isSuggestProviderAvailable, reachableSuggestProvider } from '../../widgets/search/engines.ts';
import { WIKIPEDIA_FALLBACK_KEY } from '../../widgets/search/wikipediaFallback.ts';
import { createFakeServer } from '../fakeServer.ts';
import { health, settings } from '../fixtures.ts';
import { fakeLocalServer } from '../hybrid.ts';
import { renderWithProviders } from '../render.tsx';

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));
afterEach(() => window.localStorage.removeItem(WIKIPEDIA_FALLBACK_KEY));

describe('static build: Settings → Search copy', () => {
  it('describes Wikipedia-only suggestions and labels the other providers as not available, keeping the enum', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const list = await screen.findByRole('list', { name: 'Search engines' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Google (not available in this build) suggestions');
    expect(items[4]).toHaveTextContent('Wikipedia suggestions');
    expect(items[4]).not.toHaveTextContent('available');

    expect(
      screen.getByText(/For engines with Wikipedia suggestions, sends what you type directly from your browser to Wikipedia\. Google, DuckDuckGo, Bing and YouTube suggestions are not available in the browser-only build\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/through Portly/)).toBeNull();
    // The fallback is this browser's choice, off unless turned on.
    expect(screen.getByRole('switch', { name: 'Wikipedia suggestions instead' })).not.toBeChecked();

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
    expect(reachableSuggestProvider('google', false)).toBeNull();
    expect(reachableSuggestProvider('google', true)).toBe('wikipedia');
    expect(reachableSuggestProvider('wikipedia', false)).toBe('wikipedia');
  });

  it('turning on "Wikipedia suggestions instead" saves it in this browser only and relabels the providers', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    const { requestsTo } = renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const list = await screen.findByRole('list', { name: 'Search engines' });
    const user = userEvent.setup();
    const fallback = screen.getByRole('switch', { name: 'Wikipedia suggestions instead' });
    expect(screen.getByText(/show Wikipedia’s instead, labelled as such\. Sends what you type to Wikipedia/)).toBeInTheDocument();
    await user.click(fallback);

    expect(fallback).toBeChecked();
    expect(window.localStorage.getItem(WIKIPEDIA_FALLBACK_KEY)).toBe('1');
    expect(requestsTo('PATCH /api/settings')).toHaveLength(0);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Wikipedia suggestions (Google’s aren’t available in this build)');

    await user.click(screen.getByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    const options = within(within(dialog).getByRole('combobox', { name: 'Suggestions from' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('Google (Wikipedia in this build)');
  });

  it('greys out "Wikipedia suggestions instead" while suggestions are off', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    server.settings.search.suggestionsEnabled = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    expect(await screen.findByRole('switch', { name: 'Wikipedia suggestions instead' })).toBeDisabled();
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
    expect(screen.queryByText(/in the Portly folder/)).toBeNull();
    // Nothing points into the private Portly repository (it would 404 for everyone but its owner).
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href') ?? '').not.toContain('github.com');
    // Step 3 still holds: the static backend validates the token with Todoist before storing it.
    expect(screen.getByText(/Portly checks it with Todoist before storing it/)).toBeInTheDocument();

    // A "locked" health answer is meaningless without a vault: no banner, nothing disabled.
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Saved credentials are locked')).toBeNull();
    expect(screen.queryByText('Locked')).toBeNull();
    expect(screen.getByLabelText('Replace token')).not.toBeDisabled();
    expect(screen.getByText(/1 project found/)).toBeInTheDocument();
  });
});

describe('Pages build on the Portly server on this PC: Settings → Search and Todoist', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('offers every suggestion provider through Portly', async () => {
    const server = createFakeServer([]);
    server.settings.bookmarks.autoFetchIcons = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Google suggestions');
    expect(screen.queryByText(/not available/)).toBeNull();
    expect(screen.getByText(/through Portly/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Wikipedia suggestions instead' })).toBeNull();
    expect(isSuggestProviderAvailable('google')).toBe(true);
    expect(reachableSuggestProvider('google', false)).toBe('google');
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
    expect(screen.queryByText(/Portly's own page/)).toBeNull();
    const link = screen.getByRole('link', { name: 'Open Accounts' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(link).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: /Open Portly on this PC/ })).toBeNull();
    for (const each of screen.queryAllByRole('link')) expect(each.getAttribute('href') ?? '').not.toContain('evil.example');
    expect(screen.getByLabelText('Replace token')).toBeDisabled();
  });
});
