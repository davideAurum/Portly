/**
 * Settings → Devices: the setup steps without a remote origin, the requests with Approve and Deny
 * (on Portly's own page on the main PC only), the connected PCs with Remove, and the note on a
 * page load whose data lives in this browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DevicesResponse } from '@portly/shared';
import { DEVICES_POLL_MS } from '../../api/devices.ts';
import { qk } from '../../api/keys.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { mockError, mockResponse, renderWithProviders } from '../../test/render.tsx';
import DevicesSettings from './Devices.tsx';

const NOW = Date.now();

function devices(overrides: Partial<DevicesResponse> = {}): DevicesResponse {
  return {
    remoteOrigin: 'https://pc.tailnet.example',
    devices: [
      { id: 'd1', label: 'Laptop', browser: 'Edge on Windows', createdAt: new Date(NOW - 86_400_000).toISOString(), lastUsedAt: new Date(NOW - 60_000).toISOString(), current: false },
      { id: 'd2', label: 'Desk', browser: 'Chrome on Windows', createdAt: new Date(NOW - 3_600_000).toISOString(), lastUsedAt: null, current: true },
    ],
    requests: [
      { id: 'r1', code: 'K7Q-4MP', label: 'Tablet', browser: 'Safari on iOS', createdAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW + 570_000).toISOString() },
    ],
    ...overrides,
  };
}

describe('Devices settings', () => {
  it('lists the address, the request with its code and the connected PCs; approves a request', async () => {
    const user = userEvent.setup();
    const t = renderWithProviders(<DevicesSettings />, {
      apiMocks: {
        'GET /api/devices': () => devices(),
        'POST /api/devices/requests/:id/approve': { approved: true },
      },
    });
    expect(await screen.findByText('https://pc.tailnet.example')).toBeInTheDocument();
    // Polled while the page is open, and only while the tab is visible; never persisted.
    const query = t.queryClient.getQueryCache().find({ queryKey: qk.devices(), exact: true });
    expect(query?.observers[0]?.options.refetchInterval).toBe(DEVICES_POLL_MS);
    expect(query?.observers[0]?.options.refetchIntervalInBackground).toBe(false);
    expect(query?.meta).toEqual({ persist: false });
    const requests = screen.getByRole('list', { name: 'Requests waiting for approval' });
    expect(within(requests).getByText('Tablet')).toBeInTheDocument();
    expect(within(requests).getByText('K7Q-4MP')).toBeInTheDocument();
    expect(within(requests).getByText('Safari on iOS')).toBeInTheDocument();
    const connected = screen.getByRole('list', { name: 'Connected PCs' });
    expect(within(connected).getAllByRole('listitem').map((li) => li.textContent?.slice(0, 4))).toEqual(['Lapt', 'Desk']);
    expect(within(connected).getByText('This PC')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve Tablet' }));
    await waitFor(() => expect(t.requestsTo('POST /api/devices/requests/r1/approve')).toHaveLength(1));
    expect((await screen.findAllByText('Tablet was approved. It connects by itself.')).length).toBeGreaterThan(0);
    // The list is asked again after the decision.
    await waitFor(() => expect(t.requestsTo('GET /api/devices').length).toBeGreaterThanOrEqual(2));
  });

  it('shows an error with Retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let failing = true;
    renderWithProviders(<DevicesSettings />, { apiMocks: { 'GET /api/devices': () => (failing ? mockError(500, 'internal') : devices()) } });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    failing = false;
    await user.click(retry);
    expect(await screen.findByText('https://pc.tailnet.example')).toBeInTheDocument();
  });

  it('takes a request already decided elsewhere (404) as denied, and a device already gone as removed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesSettings />, {
      apiMocks: {
        'GET /api/devices': () => devices(),
        'POST /api/devices/requests/:id/deny': mockError(404, 'not_found'),
        'DELETE /api/devices/:id': mockError(404, 'not_found'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Deny Tablet' }));
    expect((await screen.findAllByText('Tablet was denied.')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Remove Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Laptop?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await screen.findAllByText('Laptop was removed.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not be/)).not.toBeInTheDocument();
  });

  it('says so when a request cannot be approved', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesSettings />, {
      apiMocks: { 'GET /api/devices': () => devices(), 'POST /api/devices/requests/:id/approve': mockError(500, 'internal', '') },
    });
    await user.click(await screen.findByRole('button', { name: 'Approve Tablet' }));
    expect((await screen.findAllByText('The request could not be approved.')).length).toBeGreaterThan(0);
  });

  it('denies a request', async () => {
    const user = userEvent.setup();
    const t = renderWithProviders(<DevicesSettings />, {
      apiMocks: { 'GET /api/devices': () => devices(), 'POST /api/devices/requests/:id/deny': mockResponse(204) },
    });
    await user.click(await screen.findByRole('button', { name: 'Deny Tablet' }));
    await waitFor(() => expect(t.requestsTo('POST /api/devices/requests/r1/deny')).toHaveLength(1));
    expect((await screen.findAllByText('Tablet was denied.')).length).toBeGreaterThan(0);
  });

  it('removes a connected PC after confirming', async () => {
    const user = userEvent.setup();
    const t = renderWithProviders(<DevicesSettings />, {
      apiMocks: { 'GET /api/devices': () => devices(), 'DELETE /api/devices/:id': mockResponse(204) },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Laptop?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(t.requestsTo('DELETE /api/devices/d1')).toHaveLength(1));
    expect((await screen.findAllByText('Laptop was removed.')).length).toBeGreaterThan(0);
  });

  it('shows the setup steps while other PCs are not set up', async () => {
    renderWithProviders(<DevicesSettings />, { apiMocks: { 'GET /api/devices': () => devices({ remoteOrigin: null, devices: [], requests: [] }) } });
    expect(await screen.findByText(/PORTLY_REMOTE_ORIGIN/)).toBeInTheDocument();
    expect(screen.getByText(/tailscale serve --bg 5758/)).toBeInTheDocument();
    expect(screen.getByText('No other PC is connected')).toBeInTheDocument();
  });

  it('on another PC lists everything but leaves approving to the main PC', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    renderWithProviders(<DevicesSettings />, { apiMocks: { 'GET /api/devices': () => devices() } });
    expect(await screen.findByText('Tablet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Tablet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny Tablet' })).not.toBeInTheDocument();
    expect(screen.getByText('Approve on the main PC')).toBeInTheDocument();
    // Other PCs are managed on the main PC; this PC may only disconnect itself.
    expect(screen.queryByRole('button', { name: 'Remove Laptop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect this PC' })).toBeInTheDocument();
  });

  it('on another PC, Disconnect this PC removes its own device and reloads', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    const user = userEvent.setup();
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    const t = renderWithProviders(<DevicesSettings />, { apiMocks: { 'GET /api/devices': () => devices(), 'DELETE /api/device': mockResponse(204) } });
    await user.click(await screen.findByRole('button', { name: 'Disconnect this PC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect this PC?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(t.requestsTo('DELETE /api/device')).toHaveLength(1));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('on the paired Pages site lists everything but leaves approving to Portly’s own page', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    renderWithProviders(<DevicesSettings />, { apiMocks: { 'GET /api/devices': () => devices() } });
    expect(await screen.findByText('Tablet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Tablet' })).not.toBeInTheDocument();
  });

  it('on a page whose data lives in this browser only says where to set other PCs up', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const t = renderWithProviders(<DevicesSettings />);
    expect(screen.getByText(/nothing for another PC to connect to here/)).toBeInTheDocument();
    expect(t.requests).toHaveLength(0);
  });
});
