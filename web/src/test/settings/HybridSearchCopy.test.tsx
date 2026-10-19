/**
 * Settings → Search in a hybrid Pages build (`localServer/config.ts` mocked with a local server
 * origin) on its in-browser backend: the providers only Portly can reach are labelled as needing
 * Portly on this PC (with Wikipedia's suggestions until then, when this browser turned that on)
 * rather than missing from the build, since connecting makes them work. Inside a frame (which never
 * uses the local server) the browser-only wording stays.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import SearchSettings from '../../settings/sections/Search.tsx';
import { WIKIPEDIA_FALLBACK_KEY, writeWikipediaFallback } from '../../widgets/search/wikipediaFallback.ts';
import { createFakeServer } from '../fakeServer.ts';
import { fakeLocalServer } from '../hybrid.ts';
import { renderWithProviders } from '../render.tsx';

vi.mock('../../localServer/config.ts', () => ({ LOCAL_SERVER_ORIGIN: 'http://127.0.0.1:5757', HYBRID_ENABLED: true }));

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));
afterEach(() => window.localStorage.removeItem(WIKIPEDIA_FALLBACK_KEY));

function renderSearch() {
  const server = createFakeServer([]);
  server.settings.bookmarks.autoFetchIcons = false;
  renderWithProviders(<SearchSettings />, { apiMocks: server.mocks });
}

describe('hybrid Pages build, in-browser backend: Settings → Search copy', () => {
  it('says the other suggestion providers need Portly on this PC', async () => {
    act(() => setLocalServerController(fakeLocalServer({ status: 'idle' }).controller));
    renderSearch();
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Google (needs Portly on this PC) suggestions');
    expect(screen.getByText(/YouTube suggestions work while this browser is connected to Portly on this PC\./)).toBeInTheDocument();
    expect(screen.getByText(/While this browser isn’t connected to Portly on this PC, engines whose suggestions need it/)).toBeInTheDocument();
    expect(screen.queryByText(/not available/)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    const options = within(within(dialog).getByRole('combobox', { name: 'Suggestions from' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Default engine’s',
      'Google (needs Portly on this PC)',
      'DuckDuckGo (needs Portly on this PC)',
      'Bing (needs Portly on this PC)',
      'Wikipedia',
      'YouTube (needs Portly on this PC)',
    ]);
  });

  it('with "Wikipedia suggestions instead" on, says Wikipedia’s show until Portly is connected', async () => {
    writeWikipediaFallback(true);
    act(() => setLocalServerController(fakeLocalServer({ status: 'idle' }).controller));
    renderSearch();
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Wikipedia suggestions (Google’s need Portly on this PC)');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    const options = within(within(dialog).getByRole('combobox', { name: 'Suggestions from' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('Google (needs Portly on this PC, else Wikipedia)');
  });

  it('keeps the browser-only wording inside a frame', async () => {
    act(() => setLocalServerController(fakeLocalServer({ status: 'framed' }).controller));
    renderSearch();
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Google (not available in this build) suggestions');
    expect(screen.getByText(/suggestions are not available in the browser-only build\./)).toBeInTheDocument();
  });
});
