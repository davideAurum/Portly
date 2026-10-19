/**
 * Settings → Search in a hybrid Pages build (`localServer/config.ts` mocked with a local server
 * origin) on its in-browser backend: the providers only Portly can reach are labelled as needing
 * Portly on this PC (Wikipedia's suggestions until then) rather than missing from the build, since
 * connecting makes them work. Inside a frame (which never uses the local server) the browser-only
 * wording stays.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import SearchSettings from '../../settings/sections/Search.tsx';
import { createFakeServer } from '../fakeServer.ts';
import { fakeLocalServer } from '../hybrid.ts';
import { renderWithProviders } from '../render.tsx';

vi.mock('../../localServer/config.ts', () => ({ LOCAL_SERVER_ORIGIN: 'http://127.0.0.1:5757', HYBRID_ENABLED: true }));

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

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
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Wikipedia suggestions (Google’s need Portly on this PC)');
    expect(
      screen.getByText(/YouTube suggestions work while this browser is connected to Portly on this PC; until then, engines that use them show Wikipedia’s, labelled as such/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not available/)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Custom engine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a search engine' });
    const options = within(within(dialog).getByRole('combobox', { name: 'Suggestions from' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Default engine’s',
      'Google (needs Portly on this PC, else Wikipedia)',
      'DuckDuckGo (needs Portly on this PC, else Wikipedia)',
      'Bing (needs Portly on this PC, else Wikipedia)',
      'Wikipedia',
      'YouTube (needs Portly on this PC, else Wikipedia)',
    ]);
  });

  it('keeps the browser-only wording inside a frame', async () => {
    act(() => setLocalServerController(fakeLocalServer({ status: 'framed' }).controller));
    renderSearch();
    const list = await screen.findByRole('list', { name: 'Search engines' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Wikipedia suggestions (Google’s aren’t available in this build)');
    expect(screen.getByText(/suggestions are not available in the browser-only build, so engines that use them show Wikipedia’s/)).toBeInTheDocument();
  });
});
