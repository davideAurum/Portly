/**
 * ReconnectButton: OAuth reconnects start here, on Homebase's own page and on the Pages site
 * paired with it alike; app-password accounts link to Accounts settings.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { account } from '../../test/fixtures.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ReconnectButton } from './ReconnectButton.tsx';

describe('ReconnectButton', () => {
  it('reconnects an OAuth account here, an app-password account in settings', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/', assign } as Location);
    const { requestsTo, unmount } = renderWithProviders(<ReconnectButton accountId="acc-1" />, {
      apiMocks: {
        'GET /api/accounts': [account({ id: 'acc-1', kind: 'google', status: 'reauth' }), account({ id: 'acc-2', kind: 'imap', status: 'reauth' })],
        'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      },
      toaster: false,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(requestsTo('POST /api/oauth/google/start')).toHaveLength(1);
    unmount();

    renderWithProviders(<ReconnectButton accountId="acc-2" />, {
      apiMocks: { 'GET /api/accounts': [account({ id: 'acc-2', kind: 'imap', status: 'reauth' })] },
      toaster: false,
    });
    expect(await screen.findByRole('link', { name: 'Reconnect in settings' })).toHaveAttribute('href', '#/settings/accounts');
  });

  it('the Pages site paired with Homebase on this PC reconnects here too', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/', assign } as Location);
    const { requestsTo } = renderWithProviders(<ReconnectButton accountId="acc-1" />, {
      apiMocks: {
        'GET /api/accounts': [account({ id: 'acc-1', kind: 'microsoft', status: 'reauth' })],
        'POST /api/oauth/microsoft/start': { authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1' },
      },
      toaster: false,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1'));
    expect(requestsTo('POST /api/oauth/microsoft/start')).toHaveLength(1);
  });
});
