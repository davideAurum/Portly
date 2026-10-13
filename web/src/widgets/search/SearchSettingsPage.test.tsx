import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchEngine } from '@homebase/shared';
import SearchSettings from '../../settings/sections/Search.tsx';
import { createFakeServer } from '../../test/fakeServer.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { profile, widget } from '../../test/fixtures.ts';

function setup() {
  const server = createFakeServer([]);
  server.settings.bookmarks.autoFetchIcons = false;
  const result = renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
  return { ...result, server, user: userEvent.setup() };
}

const patches = (requestsTo: (k: string) => { body: unknown }[]) => requestsTo('PATCH /api/settings').map((r) => r.body as { search: Record<string, unknown> });

describe('Settings → Search', () => {
  it('lists engines with keywords and makes another engine the default', async () => {
    const { user, requestsTo, server } = setup();
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(within(list).getByText('Default')).toBeInTheDocument();
    const bing = within(list).getAllByRole('listitem')[2]!;
    await user.click(within(bing).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(patches(requestsTo)).toEqual([{ search: { defaultEngineId: 'bing' } }]));
    expect(server.settings.search.defaultEngineId).toBe('bing');
  });

  it('reorders engines', async () => {
    const { user, requestsTo, server } = setup();
    await user.click(await screen.findByRole('button', { name: 'Move Google down' }));
    await waitFor(() => expect(patches(requestsTo)).toHaveLength(1));
    const engines = patches(requestsTo)[0]!.search.engines as SearchEngine[];
    expect(engines.map((e) => e.id).slice(0, 3)).toEqual(['duckduckgo', 'google', 'bing']);
    expect(server.settings.search.engines[1]!.id).toBe('google');
    expect(screen.getByRole('button', { name: 'Move DuckDuckGo up' })).toBeDisabled();
  });

  it('validates %s and keyword uniqueness, then adds a custom engine', async () => {
    const { user, requestsTo, server } = setup();
    await user.click(await screen.findByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Docs');
    await user.type(within(dialog).getByRole('textbox', { name: /Search address/ }), 'https://docs.example.com/search?q=');
    expect(await within(dialog).findByText(/Put %s where the search terms go/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Search address/ }), '%s');
    expect(within(dialog).getByText(/Searching “hello world” opens https:\/\/docs\.example\.com\/search\?q=hello%20world/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /Keyword/ }), 'G');
    expect(within(dialog).getByText(/“G” is already used by Google/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add engine' }));
    expect(requestsTo('PATCH /api/settings')).toHaveLength(0);

    await user.clear(within(dialog).getByRole('textbox', { name: /Keyword/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Keyword/ }), 'doc');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Suggestions from' }), 'wikipedia');
    await user.click(within(dialog).getByRole('button', { name: 'Add engine' }));
    await waitFor(() => expect(patches(requestsTo)).toHaveLength(1));
    const added = (patches(requestsTo)[0]!.search.engines as SearchEngine[]).at(-1)!;
    expect(added).toMatchObject({ name: 'Docs', urlTemplate: 'https://docs.example.com/search?q=%s', keyword: 'doc', suggest: 'wikipedia', iconId: null });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.settings.search.engines).toHaveLength(7);
  });

  it('deleting the default engine makes the first remaining one the default', async () => {
    const { user, requestsTo } = setup();
    await user.click(await screen.findByRole('button', { name: 'Delete Google' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(patches(requestsTo)).toHaveLength(1));
    const patch = patches(requestsTo)[0]!.search;
    expect((patch.engines as SearchEngine[]).map((e) => e.id)).not.toContain('google');
    expect(patch.defaultEngineId).toBe('duckduckgo');
  });

  it('toggles suggestions and bookmark matches, and resets to presets', async () => {
    const { user, requestsTo } = setup();
    await user.click(await screen.findByRole('switch', { name: 'Search suggestions' }));
    await waitFor(() => expect(patches(requestsTo)).toEqual([{ search: { suggestionsEnabled: false } }]));
    await user.click(screen.getByRole('switch', { name: 'Matching bookmarks' }));
    await waitFor(() => expect(patches(requestsTo)[1]).toEqual({ search: { showBookmarkMatches: false } }));
    await user.click(screen.getByRole('button', { name: 'Reset to presets' }));
    await user.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(patches(requestsTo)[2]).toEqual({ search: { engines: null, defaultEngineId: null } }));
  });

  it('adds a preset engine from the menu', async () => {
    const { user, requestsTo } = setup();
    // Radix menus open on keyboard activation as well as pointer down.
    (await screen.findByRole('button', { name: 'Add preset' })).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: /Claude/ }));
    await waitFor(() => expect(patches(requestsTo)).toHaveLength(1));
    expect((patches(requestsTo)[0]!.search.engines as SearchEngine[]).at(-1)).toMatchObject({ id: 'claude', urlTemplate: 'https://claude.ai/new?q=%s', keyword: 'c' });
  });

  it('turns "focus the search box on a new tab" on and off for the active profile’s search widgets', async () => {
    const server = createFakeServer([profile('p1', 'Home', [widget('s1', 'search', 0, 0, 8, 2, { config: { autofocus: true } }), widget('c1', 'clock', 8, 0, 4, 3)])]);
    server.settings.bookmarks.autoFetchIcons = false;
    const { requestsTo } = renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    const user = userEvent.setup();
    const focus = await screen.findByRole('switch', { name: /Focus the search box on a new tab/ });
    await waitFor(() => expect(focus).toBeChecked());
    await user.click(focus);
    await waitFor(() => expect(requestsTo('PATCH /api/profiles/p1/widgets/s1')).toHaveLength(1));
    expect(requestsTo('PATCH /api/profiles/p1/widgets/s1')[0]!.body).toMatchObject({ config: { autofocus: false } });
    await waitFor(() => expect(focus).not.toBeChecked());
  });

  it('disables the focus switch when the profile has no search box', async () => {
    const server = createFakeServer([profile('p1', 'Home', [widget('c1', 'clock', 0, 0, 4, 3)])]);
    server.settings.bookmarks.autoFetchIcons = false;
    renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
    await waitFor(() => expect(screen.getByRole('switch', { name: /Focus the search box/ })).toBeDisabled());
  });
});
