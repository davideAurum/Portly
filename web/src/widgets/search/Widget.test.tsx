import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarksResponse, Settings } from '@portly/shared';
import { focusSearchInput } from '../../lib/hotkeys.ts';
import { renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { searchConfigSchema, type SearchConfig } from './index.ts';
import SearchWidget from './Widget.tsx';

const openUrl = vi.hoisted(() => vi.fn((_url: unknown, _options?: { newTab?: boolean }) => true));
vi.mock('../../lib/openUrl.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/openUrl.ts')>()), openUrl }));

const BOOKMARKS: BookmarksResponse = {
  groups: [
    {
      id: 'g1',
      name: 'Dev',
      sort: 0,
      color: null,
      collapsed: false,
      bookmarks: [
        { id: 'b1', groupId: 'g1', title: 'GitHub', url: 'https://github.com/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null },
        { id: 'b2', groupId: 'g1', title: 'Recipes', url: 'https://recipes.example/', sort: 1, iconMode: 'letter', iconId: null, letterColor: '#ff0000' },
      ],
    },
  ],
};

function setup(options: { settings?: Partial<Settings>; config?: Partial<SearchConfig>; suggest?: ApiMock } = {}) {
  const base = makeSettings();
  const s: Settings = { ...base, ...options.settings };
  const config = searchConfigSchema.parse({ autofocus: false, ...options.config });
  const result = renderWithProviders(<SearchWidget instanceId="w1" config={config} setConfig={async () => {}} size={{ w: 8, h: 2 }} editMode={false} />, {
    apiMocks: {
      'GET /api/settings': s,
      'GET /api/bookmarks': BOOKMARKS,
      'GET /api/site-meta': { title: null, iconId: null },
      'GET /api/search/suggest': options.suggest ?? ((req: MockRequest) => {
        const q = new URLSearchParams(req.search).get('q') ?? '';
        return [`${q} one`, `${q} two`];
      }),
    },
  });
  return { ...result, user: userEvent.setup() };
}

const input = () => screen.findByRole('combobox');

describe('Search widget', () => {
  beforeEach(() => openUrl.mockClear());

  it('switches engine with keyword + Space and reverts with Backspace on an empty input', async () => {
    const { user } = setup();
    const box = await input();
    expect(screen.getByRole('button', { name: /Search engine: Google/ })).toBeInTheDocument();

    await user.type(box, 'yt ');
    expect(box).toHaveValue('');
    expect(screen.getByRole('button', { name: /Search engine: YouTube/ })).toBeInTheDocument();
    expect(box).toHaveAttribute('placeholder', 'Search YouTube');

    await user.type(box, 'lofi beats{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.youtube.com/results?search_query=lofi%20beats', { newTab: false });

    await user.clear(box);
    await user.keyboard('{Backspace}');
    expect(screen.getByRole('button', { name: /Search engine: Google/ })).toBeInTheDocument();
  });

  it('switches engine from the chip menu and puts the cursor back in the box', async () => {
    const { user } = setup();
    const box = await input();
    screen.getByRole('button', { name: /Search engine: Google/ }).focus();
    await user.keyboard('{Enter}');
    // UX-12: the menu explains the keyword switch.
    expect(await screen.findByText(/Type a keyword, then/)).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitemradio', { name: /Wikipedia/ }));
    expect(await screen.findByRole('button', { name: /Search engine: Wikipedia/ })).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, 'Moon{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://en.wikipedia.org/wiki/Special:Search?search=Moon', { newTab: false });
  });

  it('does not switch for words that are not keywords, and searches the default engine', async () => {
    const { user } = setup();
    const box = await input();
    await user.type(box, 'hello world{Enter}');
    expect(screen.getByRole('button', { name: /Search engine: Google/ })).toBeInTheDocument();
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=hello%20world', { newTab: false });
  });

  it('navigates directly to URL-looking input; Ctrl/Shift+Enter and the new-tab preference open a new tab', async () => {
    const { user } = setup();
    const box = await input();
    await user.type(box, 'example.com/docs{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://example.com/docs', { newTab: false });
    await user.clear(box);
    await user.type(box, 'localhost:3000');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(openUrl).toHaveBeenLastCalledWith('http://localhost:3000/', { newTab: true });
    // A new-tab open resets the box.
    expect(box).toHaveValue('');
    await user.type(box, 'cats');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=cats', { newTab: true });
  });

  it('offers a search for text that was only inferred to be an address', async () => {
    const { user } = setup();
    const box = await input();
    await user.type(box, 'example.com');
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Go to https://example.com/', 'Search Google for example.com']);
    // Enter alone still navigates; ↓↓ Enter searches instead.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=example.com', { newTab: false });
    // An explicit scheme is always an address.
    await user.clear(box);
    await user.type(box, 'https://node.js');
    expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Go to https://node.js/']);
  });

  it('searches words like next.js / index.html on Enter and offers the address second (FUNC-2)', async () => {
    const { user } = setup();
    const box = await input();
    await user.type(box, 'node.js');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent).slice(0, 2)).toEqual([
      'Search Google for node.js',
      'Go to https://node.js/',
    ]);
    await user.keyboard('{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=node.js', { newTab: false });
    await user.clear(box);
    await user.type(box, 'next.js');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://next.js/', { newTab: false });
  });

  it('respects general.openLinksInNewTab', async () => {
    const base = makeSettings();
    const { user } = setup({ settings: { general: { ...base.general, openLinksInNewTab: true } } });
    await user.type(await input(), 'cats{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=cats', { newTab: true });
  });

  it('shows bookmark matches then debounced suggestions, with keyboard navigation', async () => {
    const { requestsTo } = setup();
    // Key by key but without pausing between keys: on a busy machine a pause can outlast the
    // 150 ms debounce, which then rightly asks for "gi" as well.
    const user = userEvent.setup({ delay: null });
    const box = await input();
    await user.type(box, 'git');
    const options = await screen.findAllByRole('option');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('GitHub'), 'git one', 'git two']);
    expect(options[0]).toHaveTextContent('github.com');
    // One request for the whole word (debounced), for the default engine's provider.
    const calls = requestsTo('GET /api/search/suggest');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.search).toBe('?provider=google&q=git');
    expect(box).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);
    await user.keyboard('{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://github.com/', { newTab: false });

    // The highlight stays on the bookmark (a same-tab navigation leaves the page).
    await user.keyboard('{ArrowDown}{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=git%20one', { newTab: false });

    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{Control>}{Enter}{/Control}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.google.com/search?q=git%20two', { newTab: true });
  });

  it('never shows suggestions for text that was deleted or replaced (UX-12)', async () => {
    const { user } = setup();
    const box = await input();
    const texts = () => screen.queryAllByRole('option').map((o) => o.textContent);
    await user.type(box, 'weather chic');
    await waitFor(() => expect(texts()).toContain('weather chic one'));
    await user.clear(box);
    await user.type(box, 'w');
    // Before the new suggestions arrive, the old ones are gone.
    expect(texts()).not.toContain('weather chic one');
    await waitFor(() => expect(texts()).toContain('w one'));
    // Typing on keeps the list up while the next suggestions load.
    await user.type(box, 'e');
    expect(texts()).toContain('w one');
    await waitFor(() => expect(texts()).toContain('we one'));
  });

  it('uses the switched engine’s suggestion provider and offers the keyword hint', async () => {
    const { user, requestsTo } = setup();
    const box = await input();
    await user.type(box, 'w');
    expect(await screen.findByText(/to search Wikipedia/)).toBeInTheDocument();
    await user.type(box, ' ');
    await user.type(box, 'moon');
    await waitFor(() => expect(requestsTo('GET /api/search/suggest').some((r) => r.search === '?provider=wikipedia&q=moon')).toBe(true));
  });

  it('closes on Escape and then clears the text', async () => {
    const { user } = setup();
    const box = await input();
    await user.type(box, 'git');
    await screen.findAllByRole('option');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    expect(box).toHaveValue('git');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
  });

  it('never requests suggestions when they are disabled (bookmark matches still show)', async () => {
    const base = makeSettings();
    const { user, requestsTo } = setup({ settings: { search: { ...base.search, suggestionsEnabled: false } } });
    await user.type(await input(), 'git');
    expect(await screen.findByRole('option', { name: /GitHub/ })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 250));
    expect(requestsTo('GET /api/search/suggest')).toHaveLength(0);
  });

  it('hides bookmark matches when turned off', async () => {
    const base = makeSettings();
    const { user, requestsTo } = setup({ settings: { search: { ...base.search, showBookmarkMatches: false } } });
    await user.type(await input(), 'git');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByRole('option', { name: /GitHub/ })).toBeNull();
    expect(requestsTo('GET /api/bookmarks')).toHaveLength(0);
  });

  it('is the "/" target and autofocuses when configured', async () => {
    setup({ config: { autofocus: true } });
    const box = await input();
    expect(box).toHaveAttribute('data-hb-search-input');
    await waitFor(() => expect(box).toHaveFocus());
    box.blur();
    expect(focusSearchInput()).toBe(true);
    expect(box).toHaveFocus();
  });

  it('limits the engines offered to the widget’s selection and can hide the switcher', async () => {
    const { user } = setup({ config: { engineIds: ['bing', 'youtube'], showEngineSwitcher: false } });
    const box = await input();
    // Google is not offered here: the first offered engine is the default.
    await user.type(box, 'cats{Enter}');
    expect(openUrl).toHaveBeenLastCalledWith('https://www.bing.com/search?q=cats', { newTab: false });
    expect(screen.queryByRole('button', { name: /Search engine/ })).toBeNull();
    await user.clear(box);
    await user.type(box, 'yt ');
    expect(screen.getByRole('button', { name: 'Stop searching YouTube' })).toBeInTheDocument();
  });
});
