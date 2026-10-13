/**
 * ErrorState per backend: what an unreachable backend (`network_error`) says on the server build,
 * the Pages build with its data in this browser, and the Pages build using Portly on this PC
 * (reconnecting, or switching to the copy in this browser once server mode has ended);
 * and `reauth_required` on the Pages build using Portly on this PC, which reconnects in place as the
 * server build does.
 * (The server build's mapping of every code is covered in `ui.test.tsx`.)
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLocalServerController } from '../localServer/store.ts';
import type { LocalServerState } from '../localServer/types.ts';
import { account } from '../test/fixtures.ts';
import { fakeLocalServer } from '../test/hybrid.ts';
import { renderWithProviders } from '../test/render.tsx';
import { ErrorState } from './ErrorState.tsx';

const NETWORK = new ApiError(0, 'network_error', 'Portly is not reachable');

/** Plugs a controller that only reports a connected server (actions do nothing). */
function plugConnected(): void {
  const state: LocalServerState = {
    backend: 'server',
    status: 'connected',
    server: { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://127.0.0.1:5757/', apiVersion: 1, vault: 'ready' },
    paired: true,
    checkedAt: 1,
    pendingSwitch: null,
    permission: 'granted',
    manual: false,
  };
  setLocalServerController({
    getState: () => state,
    subscribe: () => () => {},
    actions: { checkNow() {}, lookForServer() {}, startPairing() {}, async disconnect() {}, switchNow() {} },
  });
}

describe('ErrorState network_error per backend', () => {
  it('server build: the Portly server', () => {
    renderWithProviders(<ErrorState error={NETWORK} />, { toaster: false });
    expect(screen.getByText('Portly is not reachable')).toBeInTheDocument();
    expect(screen.getByText('Check that the Portly server is running.')).toBeInTheDocument();
  });

  it('Pages build, data in this browser: never mentions a server', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    renderWithProviders(<ErrorState error={NETWORK} />, { toaster: false });
    expect(screen.getByText("Portly couldn't load its data")).toBeInTheDocument();
    expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument();
    expect(screen.queryByText(/server|on this PC/)).not.toBeInTheDocument();
  });

  it('Pages build using Portly on this PC', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    renderWithProviders(<ErrorState error={NETWORK} />, { toaster: false });
    expect(screen.getByText("Portly on this PC isn't reachable")).toBeInTheDocument();
    expect(screen.getByText(/Check that Portly is running on this PC/)).toBeInTheDocument();
  });

  it('Pages build using Portly on this PC, once server mode ended: switching, without a Retry that cannot help', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeLocalServer({ backend: 'server', status: 'reconnecting', paired: true, permission: 'granted' });
    act(() => setLocalServerController(fake.controller));
    renderWithProviders(<ErrorState error={NETWORK} onRetry={() => {}} />, { toaster: false });
    expect(screen.getByText("Portly on this PC isn't reachable")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // The pairing was revoked while a dialog kept the page busy: it follows the store.
    act(() => fake.set({ status: 'revoked', paired: false, pendingSwitch: { target: 'browser', reason: 'revoked' } }));
    expect(screen.getByText('This page is switching to the copy saved in this browser')).toBeInTheDocument();
    expect(screen.queryByText(/isn't reachable|reconnects|Is it running/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    // Withdrawn (the server answered again before the reload).
    act(() => fake.set({ status: 'reconnecting', pendingSwitch: null }));
    expect(screen.getByText("Portly on this PC isn't reachable")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('ErrorState reauth_required on the Pages build using Portly on this PC', () => {
  it('starts the sign-in here, as the server build does', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    plugConnected();
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/', assign } as Location);
    const { requestsTo } = renderWithProviders(<ErrorState error={new ApiError(409, 'reauth_required', 'Reconnect', undefined, 'acc-1')} />, {
      apiMocks: {
        'GET /api/accounts': [account({ id: 'acc-1', kind: 'google', label: 'Work Gmail', status: 'reauth' })],
        'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      },
      toaster: false,
    });
    expect(await screen.findByText('Reconnect Work Gmail')).toBeInTheDocument();
    expect(screen.getByText('Portly lost access to this account. Sign in again to keep things in sync.')).toBeInTheDocument();
    expect(screen.queryByText(/Portly's own page/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Portly on this PC/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(requestsTo('POST /api/oauth/google/start')).toHaveLength(1);
  });
});
