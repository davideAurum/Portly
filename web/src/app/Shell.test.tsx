import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeSchema } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { SEARCH_INPUT_ATTRIBUTE } from '../lib/hotkeys.ts';
import { setLocalServerController } from '../localServer/store.ts';
import type { LocalServerInfo } from '../localServer/types.ts';
import { createFakeServer } from '../test/fakeServer.ts';
import { account, profile, settings, shellMocks, widget } from '../test/fixtures.ts';
import { fakeLocalServer } from '../test/hybrid.ts';
import { createTestQueryClient, mockError, mockResponse, renderWithProviders } from '../test/render.tsx';
import { stubWidgetText } from '../test/stubWidgets.tsx';
import { applyTheme } from '../theme/applyTheme.ts';
import { App } from './App.tsx';
import { Shell } from './Shell.tsx';

// Real widget definitions with stand-in components: these tests are about the shell, not the
// widgets (which render real data and make their own API calls).
vi.mock('../widgets/registry.ts', async (importOriginal) => {
  const { stubWidgetRegistry } = await import('../test/stubWidgets.tsx');
  return stubWidgetRegistry(await importOriginal());
});

/**
 * The lazily loaded footer indicator and pairing page, which a test can make fail the way a chunk
 * that cannot be fetched does (the lazy component throws when React renders it).
 */
const failing = vi.hoisted(() => ({ localServerStatus: false, pairPage: false, thrown: 0 }));

function failToLoad(): never {
  failing.thrown += 1;
  throw new TypeError('Failed to fetch dynamically imported module');
}

vi.mock('./LocalServerStatus.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('./LocalServerStatus.tsx')>();
  return { ...original, LocalServerStatus: () => (failing.localServerStatus ? failToLoad() : <original.LocalServerStatus />) };
});

vi.mock('./PairPage.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('./PairPage.tsx')>();
  return { ...original, PairPage: (props: { nonce: string | null }) => (failing.pairPage ? failToLoad() : <original.PairPage {...props} />) };
});

afterEach(() => {
  failing.localServerStatus = false;
  failing.pairPage = false;
  failing.thrown = 0;
});

const WIDGET_TITLES = ['Launch pad', 'Weather', 'Calendar', 'Todoist', 'Mail'];

/** The Portly server on this PC as the local server controller last saw it (Pages build tests). */
const LOCAL_SERVER: LocalServerInfo = { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' };

describe('Shell', () => {
  it('shows the default layout read-only when the API is unavailable', async () => {
    renderWithProviders(<Shell />, {
      apiMocks: {
        'GET /api/settings': mockError(503, 'module_unavailable', 'down'),
        'GET /api/profiles': mockError(503, 'module_unavailable', 'down'),
        'GET /api/health': mockError(503, 'module_unavailable', 'down'),
      },
    });
    await waitFor(() => expect(screen.getAllByText(/^Stub widget: /)).toHaveLength(7));
    for (const title of WIDGET_TITLES) expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    // Search and clock render without a header in the default layout.
    expect(screen.getByRole('region', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit layout' })).toHaveAttribute('aria-disabled', 'true');
  });

  it("renders the active profile's layout; unknown widget types get a placeholder", async () => {
    const work = profile('p-work', 'Work', [
      widget('w1', 'weather', 0, 0, 4, 4, { frame: { showHeader: true, transparent: false, title: 'Berlin' } }),
      widget('w2', 'stocks', 4, 0, 4, 4),
    ]);
    const home = profile('p-home', 'Home', []);
    const { requests, unmatched } = renderWithProviders(<Shell />, {
      apiMocks: shellMocks([home, work], { settings: settings({ activeProfileId: 'p-work' }) }),
    });

    expect(await screen.findByRole('heading', { name: 'Berlin' })).toBeInTheDocument();
    expect(await screen.findByText('Unknown widget', { selector: 'p' })).toBeInTheDocument();
    expect(await screen.findByText(stubWidgetText('weather'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Profile: Work/ })).toBeInTheDocument();
    expect(unmatched).toEqual([]);
    for (const req of requests) expect(req.headers.get('X-Portly')).toBe('1');
  });

  it('switches profiles from the header menu', async () => {
    const user = userEvent.setup();
    const server = createFakeServer([
      profile('p1', 'Home', [widget('w1', 'clock', 0, 0, 4, 3)]),
      profile('p2', 'Work', [widget('w2', 'mail', 0, 0, 4, 4)], 1),
    ]);
    const { requestsTo } = renderWithProviders(<Shell />, { apiMocks: server.mocks });
    await user.click(await screen.findByRole('button', { name: /Profile: Home/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Work' }));
    expect(await screen.findByRole('region', { name: 'Mail' })).toBeInTheDocument();
    expect(requestsTo('POST /api/profiles/p2/activate')).toHaveLength(1);
    expect(server.settings.activeProfileId).toBe('p2');
  });

  it('toggles edit mode with "e" and leaves it with Esc; "?" opens the shortcut help', async () => {
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home', [widget('w1', 'clock', 0, 0, 4, 3)])]) });
    const toggle = await screen.findByRole('button', { name: 'Edit layout' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));

    fireEvent.keyDown(document.body, { key: 'e' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Edit mode' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(help).getByText('Toggle edit mode (move, resize, add and remove widgets)')).toBeInTheDocument();
    // Esc closes the dialog without toggling anything else.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('"/" focuses the search box, and leaves the key to the browser when there is none', async () => {
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home', [widget('w1', 'clock', 0, 0, 4, 3)])]) });
    await screen.findByRole('region', { name: 'Clock' });
    const withoutSearch = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    document.body.dispatchEvent(withoutSearch);
    expect(withoutSearch.defaultPrevented).toBe(false);

    const input = document.createElement('input');
    input.setAttribute(SEARCH_INPUT_ATTRIBUTE, '');
    document.body.append(input);
    try {
      const withSearch = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
      document.body.dispatchEvent(withSearch);
      expect(withSearch.defaultPrevented).toBe(true);
      expect(input).toHaveFocus();
    } finally {
      input.remove();
    }
  });

  it('shows a banner when the vault is locked (except on the Accounts page)', async () => {
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home')], { vault: 'locked' }) });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Saved credentials are locked');
    expect(within(banner).getByRole('link', { name: 'Review in settings' })).toHaveAttribute('href', '#/settings/accounts');
  });

  it('shows a banner when the server is unreachable', async () => {
    renderWithProviders(<Shell />, {
      apiMocks: {
        ...shellMocks([profile('p1', 'Home')]),
        'GET /api/health': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    expect(await screen.findByText("Can't reach the Portly server")).toBeInTheDocument();
  });

  it('ends the footer with the local server indicator in the Pages build only', async () => {
    // The indicator is lazily loaded: load its code first, so that on a busy machine its first load
    // does not count against the wait below.
    await import('./LocalServerStatus.tsx');
    const fake = fakeLocalServer({ backend: 'server', status: 'connected', server: LOCAL_SERVER, paired: true, permission: 'granted' });
    setLocalServerController(fake.controller);
    const server = renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home')]) });
    const serverFooter = await screen.findByRole('contentinfo');
    expect(within(serverFooter).queryByRole('button', { name: /Portly on this PC/ })).not.toBeInTheDocument();
    server.unmount();

    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home')]) });
    const footer = await screen.findByRole('contentinfo');
    // Loaded on its own (the server build's bundle never carries it).
    expect(await within(footer).findByRole('button', { name: 'Portly on this PC: Connected · v0.1.0' })).toBeInTheDocument();
    expect(within(footer).getByText(/^Version/)).toBeInTheDocument();
  });

  it('a footer indicator that cannot load leaves the rest of the page up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failing.localServerStatus = true;
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: LOCAL_SERVER, paired: true, permission: 'granted' }).controller);
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home')]) });
    await waitFor(() => expect(failing.thrown).toBeGreaterThan(0));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText(/^Version/)).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: /Portly on this PC/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('Pages build on Portly on this PC: banners follow the local server controller', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeLocalServer({ backend: 'server', status: 'reconnecting', server: LOCAL_SERVER, paired: true, permission: 'granted' });
    setLocalServerController(fake.controller);
    renderWithProviders(<Shell />, { apiMocks: shellMocks([profile('p1', 'Home')]) });
    expect(await screen.findByText('Reconnecting to Portly on this PC — showing the last saved data')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();

    act(() => fake.set({ status: 'absent', pendingSwitch: { target: 'browser', reason: 'unreachable' } }));
    expect(await screen.findByText("Portly on this PC isn't reachable")).toBeInTheDocument();
    expect(screen.queryByText(/^Reconnecting to Portly on this PC/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch now' }));
    expect(fake.actions.switchNow).toHaveBeenCalledOnce();
  });

  it('routes #/settings/<section> to the settings shell with all eleven sections', async () => {
    // Settings sections are lazily loaded: load About's code first (see the footer test above).
    await import('../settings/sections/About.tsx');
    renderWithProviders(<Shell />, {
      route: '#/settings/about',
      apiMocks: {
        ...shellMocks([]),
        'GET /api/about': { version: '0.0.0-test', dataDir: 'C:\\Data\\Portly', logPath: 'C:\\Data\\Portly\\logs\\server.log', vault: 'ready' },
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(11);
    expect(within(nav).getByRole('link', { name: 'About' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Import & export' })).toHaveAttribute('href', '#/settings/import-export');
    // Diagnostics comes right before About.
    const links = within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links.slice(-2)).toEqual(['#/settings/diagnostics', '#/settings/about']);
    expect(await screen.findByDisplayValue('C:\\Data\\Portly')).toBeInTheDocument();
    expect(screen.getByText('Unlocked and ready')).toBeInTheDocument();
  });
});

describe('App', () => {
  it('keeps the theme painted from the persisted cache until settings arrive (no flash of the defaults)', async () => {
    // main.tsx paints the last-known theme before React mounts.
    applyTheme({ ...ThemeSchema.parse({}), mode: 'dark', accent: '#123456' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = settings({ activeProfileId: 'p1' });
    s.appearance = { ...s.appearance, mode: 'light', accent: '#654321' };
    renderWithProviders(<App />, {
      apiMocks: {
        ...shellMocks([profile('p1', 'Home')]),
        'GET /api/settings': async () => {
          await gate;
          return s;
        },
      },
    });
    await screen.findByRole('button', { name: 'Keyboard shortcuts' });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#123456');

    release();
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#654321');
  });

  it('says to reload, instead of leaving a blank page, when the pairing page cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failing.pairPage = true;
    renderWithProviders(<App />, { route: `#/pair?nonce=${'n'.repeat(43)}`, apiMocks: shellMocks([]) });
    expect(await screen.findByText('The pairing page could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument();
    expect(failing.thrown).toBeGreaterThan(0);
  });

  it('applies the theme from settings', async () => {
    const s = settings();
    s.appearance = { ...s.appearance, mode: 'dark', accent: '#ff0000' };
    renderWithProviders(<App />, { apiMocks: shellMocks([], { settings: s }) });
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(document.documentElement.style.getPropertyValue('--hb-accent')).toBe('#ff0000');
  });

  it.each([
    ['connected', 'Account connected.'],
    ['reconnected', 'Account reconnected.'],
    ['different_account', 'You signed in with a different account'],
    ['denied', 'Access was not granted'],
    ['expired', 'The sign-in took too long and expired'],
  ])('reports ?oauth=%s once as a toast and strips it from the URL', async (result, text) => {
    window.history.replaceState(null, '', `/?oauth=${result}&keep=1#/settings/accounts`);
    renderWithProviders(<App />, {
      apiMocks: { ...shellMocks([]), 'GET /api/accounts': [account()], 'GET /api/oauth-clients/google': mockResponse(404), 'GET /api/oauth-clients/microsoft': mockResponse(404) },
    });
    expect(await screen.findByText(new RegExp(text.replace(/[.]/g, '\\.')))).toBeInTheDocument();
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#/settings/accounts');
    expect(screen.getAllByText(new RegExp(text.replace(/[.]/g, '\\.')))).toHaveLength(1);
  });

  it('never reflects an unknown ?oauth= value', async () => {
    window.history.replaceState(null, '', '/?oauth=%3Cimg%20src%3Dx%3E#/');
    renderWithProviders(<App />, { apiMocks: shellMocks([]) });
    expect(await screen.findByText('The account could not be connected. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/img/)).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/');
  });

  it('refreshes account data after a successful connection', async () => {
    window.history.replaceState(null, '', '/?oauth=connected#/');
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['accounts'], [account({ status: 'reauth' })]);
    queryClient.setQueryData(['mail', 'summary'], []);
    renderWithProviders(<App />, { queryClient, apiMocks: shellMocks([]) });
    await screen.findByText('Account connected.');
    expect(queryClient.getQueryState(['accounts'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['mail', 'summary'])?.isInvalidated).toBe(true);
  });

  it('opens the Add bookmark dialog for #/add-bookmark (the extension button) and drops the request when it closes', async () => {
    // The dialog is lazily loaded: load its code first (see the footer test above).
    await import('../widgets/launchpad/AddPageDialog.tsx');
    window.history.replaceState(null, '', `/#/add-bookmark?${new URLSearchParams({ url: 'https://example.com/post', title: 'A post' }).toString()}`);
    try {
      renderWithProviders(<Shell />, {
        apiMocks: { ...shellMocks([]), 'GET /api/bookmarks': { groups: [] }, 'GET /api/site-meta': { title: null, iconId: null } },
      });
      const dialog = await screen.findByRole('dialog', { name: 'Add bookmark' });
      expect(within(dialog).getByRole('textbox', { name: /Address/ })).toHaveValue('https://example.com/post');
      expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('A post');
      expect(window.location.hash).toMatch(/^#\/add-bookmark\?/);
      await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add bookmark' })).not.toBeInTheDocument());
      expect(window.location.hash).toBe('#/');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
