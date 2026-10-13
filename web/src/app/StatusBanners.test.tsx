/**
 * The shell's status banners per backend (capabilities set with `setCapabilitiesForTests`, the
 * in-browser backend's status hook mocked, the local server store driven by a fake controller):
 *
 * - Pages build, browser backend: a backend that could not start, a database another tab closed,
 *   memory-only storage, and the browser wording of an unreachable backend;
 * - Pages build, server backend: no browser-storage banners, reconnecting, a pending switch with
 *   Switch now, and a locked vault linking to Settings → Accounts in this page, as in the server build;
 * - the server build's wording. Plus the cross-tab refetch mapping.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLocalServerController } from '../localServer/store.ts';
import type { LocalServerActions, LocalServerState } from '../localServer/types.ts';
import { renderWithProviders } from '../test/render.tsx';
import { StatusBanners } from './StatusBanners.tsx';
import type { StaticBackendStatus } from './staticStatus.ts';

let status: StaticBackendStatus | null = null;

vi.mock('./staticStatus.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStaticBackendStatus: () => status,
}));

const HEALTHY = { 'GET /api/health': { ok: true, version: '0.0.0-test', vault: 'ready' } };
const LOCKED = { 'GET /api/health': { ok: true, version: '0.0.0-test', vault: 'locked' } };
const unreachable = () => {
  throw new TypeError('Failed to fetch');
};

const CONNECTED: LocalServerState = {
  backend: 'server',
  status: 'connected',
  server: { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' },
  paired: true,
  checkedAt: 1_700_000_000_000,
  pendingSwitch: null,
  permission: 'granted',
  manual: false,
};

/** Plugs a fake controller into the store; `set` changes its state (inside act). */
function plugController(initial: Partial<LocalServerState> = {}) {
  let state: LocalServerState = { ...CONNECTED, ...initial };
  const listeners = new Set<() => void>();
  const actions = {
    checkNow: vi.fn(),
    lookForServer: vi.fn(),
    startPairing: vi.fn(),
    disconnect: vi.fn(async () => {}),
    switchNow: vi.fn(),
  } satisfies LocalServerActions;
  setLocalServerController({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  });
  return {
    actions,
    set(next: Partial<LocalServerState>) {
      state = { ...state, ...next };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** Lets pending queries settle (the banners have nothing to wait for). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Pages build, browser backend', () => {
  const pagesBrowser = () => setCapabilitiesForTests(capabilitiesFor(true, 'browser'));

  it('a backend that could not load the stored data: danger banner with Reload', async () => {
    pagesBrowser();
    status = { state: 'failed', message: 'cannot read', retryAt: 0 };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    expect(await screen.findByText("Portly couldn't load its saved data")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('a database closed by another tab asks for a reload', async () => {
    pagesBrowser();
    status = { state: 'closed', storage: 'indexeddb' };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    expect(await screen.findByText('Reload to keep saving changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('memory-only storage warns that nothing is saved', async () => {
    pagesBrowser();
    status = { state: 'ready', storage: 'memory' };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    expect(await screen.findByText('Nothing can be saved in this browser')).toBeInTheDocument();
  });

  it('an unreachable backend never mentions a server', async () => {
    pagesBrowser();
    status = { state: 'ready', storage: 'indexeddb' };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: { 'GET /api/health': unreachable } });
    expect(await screen.findByText("Portly couldn't load its data")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByText(/server|on this PC/)).not.toBeInTheDocument();
  });

  it('shows nothing when the backend is ready on IndexedDB', async () => {
    pagesBrowser();
    status = { state: 'ready', storage: 'indexeddb' };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY, toaster: false });
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('a switch to Portly on this PC waiting for the page to be idle offers Switch now', async () => {
    pagesBrowser();
    status = { state: 'ready', storage: 'indexeddb' };
    const controller = plugController({ backend: 'browser', pendingSwitch: { target: 'server', reason: 'connected' } });
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Portly on this PC is ready');
    expect(banner).toHaveTextContent("This page switches to Portly on this PC when you're done");
    // Every reason the page counts as busy: a text field with typed text defers the switch too.
    expect(banner).toHaveTextContent("it waits while a dialog is open, you're editing the layout or typing.");
    await userEvent.setup().click(within(banner).getByRole('button', { name: 'Switch now' }));
    expect(controller.actions.switchNow).toHaveBeenCalledOnce();
  });
});

describe('Pages build, server backend (Portly on this PC)', () => {
  const pagesServer = () => setCapabilitiesForTests(capabilitiesFor(true, 'server'));

  it('never shows the browser-storage banners', async () => {
    pagesServer();
    plugController();
    status = { state: 'failed', message: 'cannot read', retryAt: 0 };
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY, toaster: false });
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText("Portly couldn't load its saved data")).not.toBeInTheDocument();
  });

  it('reconnecting shows the last saved data without a Reload button, and goes away when connected again', async () => {
    pagesServer();
    status = null;
    const controller = plugController({ status: 'reconnecting' });
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    expect(screen.getByRole('alert')).toHaveTextContent('Reconnecting to Portly on this PC — showing the last saved data');
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    controller.set({ status: 'connected' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a switch back to this browser’s copy names the reason and offers Switch now', async () => {
    pagesServer();
    const controller = plugController({ status: 'revoked', paired: false, pendingSwitch: { target: 'browser', reason: 'revoked' } });
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY });
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Portly on this PC no longer accepts this browser');
    expect(banner).toHaveTextContent('switches to the copy saved in this browser');
    await userEvent.setup().click(within(banner).getByRole('button', { name: 'Switch now' }));
    expect(controller.actions.switchNow).toHaveBeenCalledOnce();
  });

  it('an unreachable backend names Portly on this PC', async () => {
    pagesServer();
    plugController();
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: { 'GET /api/health': unreachable } });
    expect(await screen.findByText("Can't reach Portly on this PC")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('a locked vault links to the Accounts settings in this page, as in the server build, except on that page', async () => {
    pagesServer();
    plugController({ server: { ...CONNECTED.server!, appUrl: 'javascript:alert(1)' } });
    const { unmount } = renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: LOCKED });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Saved credentials are locked');
    expect(banner).toHaveTextContent("Portly couldn't unlock its credential store, so connected accounts and Todoist are paused.");
    expect(banner).not.toHaveTextContent("Portly's own page");
    // One in-app link; nothing built from the page address the server reported.
    expect(within(banner).getAllByRole('link')).toHaveLength(1);
    const link = within(banner).getByRole('link', { name: 'Review in settings' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(link).not.toHaveAttribute('target');
    expect(within(banner).queryByRole('link', { name: /Open Portly on this PC/ })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<StatusBanners onAccountsPage />, { apiMocks: LOCKED, toaster: false });
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('server build', () => {
  it('an unreachable server names the Portly server', async () => {
    status = null;
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: { 'GET /api/health': unreachable } });
    expect(await screen.findByText("Can't reach the Portly server")).toBeInTheDocument();
  });

  it('a locked vault links to the Accounts settings here, except on that page', async () => {
    status = null;
    const { unmount } = renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: LOCKED });
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByRole('link', { name: 'Review in settings' })).toHaveAttribute('href', '#/settings/accounts');
    unmount();
    renderWithProviders(<StatusBanners onAccountsPage />, { apiMocks: LOCKED, toaster: false });
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores the local server store (it is inert in this build)', async () => {
    status = null;
    plugController({ status: 'reconnecting', pendingSwitch: { target: 'browser', reason: 'unreachable' } });
    renderWithProviders(<StatusBanners onAccountsPage={false} />, { apiMocks: HEALTHY, toaster: false });
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('cross-tab refetch mapping', () => {
  it('maps changed slices to the query families that show them', async () => {
    const { queryKeysForSlices } = await vi.importActual<typeof import('./staticStatus.ts')>('./staticStatus.ts');
    expect(queryKeysForSlices(['profiles'])).toEqual([['profiles']]);
    expect(queryKeysForSlices(['bookmarks', 'icons'])).toEqual([['bookmarks'], ['icons']]);
    expect(queryKeysForSlices(['todoist-token'])).toEqual([['todoist']]);
    expect(queryKeysForSlices(['uploads', 'settings'])).toEqual([['settings'], ['search'], ['weather']]);
    expect(queryKeysForSlices(['accounts'])).toEqual([['accounts'], ['calendar'], ['mail']]);
    // A token refresh in another tab refetches nothing.
    expect(queryKeysForSlices(['account-tokens', 'oauth-states'])).toEqual([]);
    // Anything unknown refetches everything.
    expect(queryKeysForSlices(['profiles', 'something-new'])).toBeNull();
  });

  it('knows every slice the static backend has', async () => {
    const { queryKeysForSlices } = await vi.importActual<typeof import('./staticStatus.ts')>('./staticStatus.ts');
    const { SLICE } = await import('../static/slices.ts');
    for (const name of Object.values(SLICE)) expect(queryKeysForSlices([name]), name).not.toBeNull();
  });
});
