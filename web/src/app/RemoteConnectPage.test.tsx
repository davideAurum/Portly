/**
 * The Pages site's connect page: the address typed once (checked, with a reason when it cannot be
 * used), then the connect screen against that address, ending in a saved connection and a reload;
 * a browser that already uses a Portly is told so instead.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PORTLY_API_VERSION } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { memoryStorage } from '../localServer/__fixtures__/fakes.ts';
import { createPairingStore } from '../localServer/pairing.ts';
import type { FetchLike } from '../localServer/probe.ts';
import { setLocalServerController } from '../localServer/store.ts';
import type { LocalServerState } from '../localServer/types.ts';
import { renderWithProviders } from '../test/render.tsx';
import { RemoteConnectPage } from './RemoteConnectPage.tsx';

const REMOTE = 'https://desk.tail1234.ts.net';

function plug(state: Partial<LocalServerState>) {
  const full: LocalServerState = {
    backend: 'browser',
    status: 'absent',
    server: null,
    paired: false,
    checkedAt: null,
    pendingSwitch: null,
    permission: 'granted',
    manual: false,
    ...state,
  };
  setLocalServerController({
    getState: () => full,
    subscribe: () => () => {},
    actions: { checkNow: vi.fn(), lookForServer: vi.fn(), startPairing: vi.fn(), disconnect: vi.fn(async () => {}), switchNow: vi.fn() },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const health = (overrides: Record<string, unknown> = {}) =>
  json({ ok: true, version: '0.2.0', vault: 'ready', app: 'portly', apiVersion: PORTLY_API_VERSION, instanceId: 'instance-A', remote: true, ...overrides });

describe('RemoteConnectPage', () => {
  it('checks the address, asks to connect, waits for approval, saves the connection and reloads', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    plug({});
    const local = memoryStorage();
    const session = memoryStorage();
    let approved = false;
    const fetch = vi.fn<FetchLike>(async (url, init = {}) => {
      if (url === `${REMOTE}/api/health`) return health();
      if (url === `${REMOTE}/api/devices/requests/suggestion`) return json({ label: 'DESK-LAPTOP' });
      if (url === `${REMOTE}/api/devices/requests` && init.method === 'POST') {
        return json({ id: 'req-1', code: 'K7Q-4MP', expiresAt: new Date(Date.now() + 600_000).toISOString(), secret: 'E'.repeat(43) }, 201);
      }
      if (url === `${REMOTE}/api/devices/requests/current`) {
        return approved
          ? json({ status: 'approved', id: 'req-1', code: 'K7Q-4MP', expiresAt: new Date().toISOString(), device: { id: 'd-1', label: 'DESK-LAPTOP', createdAt: new Date().toISOString() }, secret: 'D'.repeat(43) })
          : json({ status: 'pending', id: 'req-1', code: 'K7Q-4MP', expiresAt: new Date(Date.now() + 600_000).toISOString(), device: null });
      }
      return json({ error: { code: 'not_found', message: 'x' } }, 404);
    });
    const reload = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<RemoteConnectPage fetch={fetch} local={local} session={session} reload={reload} pollMs={20} />);

    const field = screen.getByRole('textbox', { name: 'Address of Portly on the main PC' });
    await user.type(field, 'example.com');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Enter the address Settings → Devices shows/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, 'desk.tail1234.ts.net');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const name = await screen.findByRole('textbox', { name: 'Name of this PC' });
    await vi.waitFor(() => expect(name).toHaveValue('DESK-LAPTOP'));
    await user.click(screen.getByRole('button', { name: 'Ask to connect' }));
    expect(await screen.findByLabelText('Code to compare')).toHaveTextContent('K7Q-4MP');

    approved = true;
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(createPairingStore(local).read()).toMatchObject({ remoteOrigin: REMOTE, token: 'D'.repeat(43), instanceId: 'instance-A' });
  });

  it('says why an address cannot be used', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    plug({});
    const user = userEvent.setup();
    renderWithProviders(<RemoteConnectPage fetch={async () => health({ remote: false })} local={memoryStorage()} session={memoryStorage()} />);
    await user.type(screen.getByRole('textbox', { name: 'Address of Portly on the main PC' }), REMOTE);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/tailscale serve --bg 5758/)).toBeInTheDocument();
  });

  it('tells a browser paired with Portly on this PC to disconnect first', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    plug({ backend: 'server', status: 'connected', paired: true });
    renderWithProviders(<RemoteConnectPage local={memoryStorage()} session={memoryStorage()} />);
    expect(screen.getByRole('heading', { name: 'This browser uses Portly on this PC' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('names the address a connected browser uses', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server', true));
    plug({ backend: 'server', status: 'connected', paired: true, remoteOrigin: REMOTE });
    renderWithProviders(<RemoteConnectPage local={memoryStorage()} session={memoryStorage()} />);
    expect(screen.getByRole('heading', { name: 'Already connected' })).toBeInTheDocument();
    expect(screen.getByText('desk.tail1234.ts.net')).toBeInTheDocument();
  });
});
