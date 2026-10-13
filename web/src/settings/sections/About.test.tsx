/**
 * Settings → About per build and backend: the server build shows its data folder, log file and
 * vault and lists the paired browsers; the Pages build on Portly on this PC shows both versions,
 * never the server's paths, links a locked vault to Accounts in this page, and has the local server
 * card followed by the paired browsers; the Pages build on its in-browser backend keeps the card
 * only while hybrid mode is on, and never lists paired browsers.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AboutResponse } from '@portly/shared';
import { APP_VERSION } from '../../app/providers.tsx';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import type { LocalServerInfo } from '../../localServer/types.ts';
import { fakeLocalServer } from '../../test/hybrid.ts';
import { renderWithProviders } from '../../test/render.tsx';
import AboutSettings from './About.tsx';

const LOCAL_SERVER: LocalServerInfo = { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' };

function about(patch: Partial<AboutResponse> = {}): AboutResponse {
  return { version: APP_VERSION, dataDir: 'C:\\Data\\Portly', logPath: 'C:\\Data\\Portly\\logs\\server.log', vault: 'ready', ...patch };
}

const PAIRINGS = {
  pagesUrl: 'https://example.github.io/',
  instanceId: 'instance-1',
  pairings: [
    { id: 'p1', label: 'Edge on Windows', origin: 'https://example.github.io', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null, current: true },
  ],
};

describe('About settings', () => {
  it('server build: data folder, log file and vault, then the paired browsers', async () => {
    const { requestsTo } = renderWithProviders(<AboutSettings />, {
      apiMocks: { 'GET /api/about': about(), 'GET /api/pairings': PAIRINGS },
    });
    expect(await screen.findByDisplayValue('C:\\Data\\Portly')).toBeInTheDocument();
    expect(screen.getByDisplayValue('C:\\Data\\Portly\\logs\\server.log')).toBeInTheDocument();
    expect(screen.getByText('Unlocked and ready')).toBeInTheDocument();
    const paired = screen.getByRole('region', { name: 'Paired browsers' });
    expect(await within(paired).findByText('Edge on Windows')).toBeInTheDocument();
    expect(requestsTo('GET /api/pairings')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Portly on this PC' })).not.toBeInTheDocument();
  });

  it('Pages build on Portly on this PC: both versions, no server paths, the local server card, then the paired browsers', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: LOCAL_SERVER, paired: true, permission: 'granted' }).controller);
    const { requestsTo } = renderWithProviders(<AboutSettings />, {
      // A paired request gets empty paths from the server; they must not show as empty fields either.
      apiMocks: { 'GET /api/about': about({ version: '0.2.0', dataDir: '', logPath: '' }), 'GET /api/pairings': PAIRINGS },
    });
    expect(screen.getByText('Your personal start page, with its data from Portly on this PC.')).toBeInTheDocument();
    expect(await screen.findByText('This site')).toBeInTheDocument();
    expect(screen.getByText(APP_VERSION, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('0.2.0')).toBeInTheDocument();
    // No "Page is … — reload" badge: the site and the server are published separately.
    expect(screen.queryByText(/— reload$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Data folder')).not.toBeInTheDocument();
    expect(screen.queryByText('Log file')).not.toBeInTheDocument();
    expect(screen.getByText('Portly on this PC, in its data folder.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open its About page/ })).not.toBeInTheDocument();

    const card = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Connected · v0.1.0')).toBeInTheDocument();
    expect(within(card).getByText('From Portly on this PC')).toBeInTheDocument();
    const paired = screen.getByRole('region', { name: 'Paired browsers' });
    expect(await within(paired).findByText('Edge on Windows')).toBeInTheDocument();
    expect(card.compareDocumentPosition(paired) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requestsTo('GET /api/pairings')).toHaveLength(1);
    // Nothing on this page links out to a page on this PC.
    expect(document.querySelector('a[href^="http://localhost"]')).toBeNull();
  });

  it('Pages build on Portly on this PC: a locked vault links to Accounts in this page, as in the server build', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: LOCAL_SERVER, paired: true, permission: 'granted' }).controller);
    renderWithProviders(<AboutSettings />, {
      apiMocks: { 'GET /api/about': about({ vault: 'locked', dataDir: '', logPath: '' }), 'GET /api/pairings': PAIRINGS },
    });
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Review in Accounts' });
    expect(link).toHaveAttribute('href', '#/settings/accounts');
    expect(link).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: /Review on Portly on this PC/ })).not.toBeInTheDocument();
  });

  it('Pages build, data in this browser: the storage, and the local server card only while hybrid mode is on', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const inert = renderWithProviders(<AboutSettings />, { apiMocks: { 'GET /api/about': about({ dataDir: 'This browser' }) } });
    expect(screen.getByText('Your personal start page, stored in this browser.')).toBeInTheDocument();
    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.queryByText('Credential vault')).not.toBeInTheDocument();
    // The inert store (hybrid mode off): no card, and no paired browsers either.
    expect(screen.queryByRole('region', { name: 'Portly on this PC' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Paired browsers' })).not.toBeInTheDocument();
    inert.unmount();

    setLocalServerController(fakeLocalServer({ status: 'absent', permission: 'granted', checkedAt: Date.now() }).controller);
    renderWithProviders(<AboutSettings />, { apiMocks: { 'GET /api/about': about({ dataDir: 'This browser' }) } });
    const card = await screen.findByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Not detected')).toBeInTheDocument();
    expect(within(card).getByText('Saved in this browser')).toBeInTheDocument();
  });
});
