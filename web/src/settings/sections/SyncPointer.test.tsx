/** The launch pad's side of Settings: one line on whether launch pad sync keeps it in step, linking to Accounts. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LaunchpadSyncInfo } from '../../api/launchpadSync.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SyncPointer } from './SyncPointer.tsx';

function info(overrides: Partial<LaunchpadSyncInfo>): LaunchpadSyncInfo {
  return {
    connection: null,
    connections: 0,
    status: 'off',
    problem: null,
    running: false,
    waiting: false,
    syncedAt: null,
    receivedAt: null,
    sentAt: null,
    retryAt: null,
    ...overrides,
  };
}

describe('SyncPointer', () => {
  it('names the connection that syncs', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    renderWithProviders(<SyncPointer />, {
      apiMocks: { 'GET /api/sync/launchpad': info({ connection: { kind: 'microsoft', accountId: 'a', label: 'someone@outlook.example' }, connections: 1 }) },
    });
    expect(await screen.findByText(/Synced through someone@outlook.example \(OneDrive\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch pad sync in Accounts' })).toHaveAttribute('href', '#/settings/accounts');
  });

  it('says when it is not synced, and points to setting it up', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    renderWithProviders(<SyncPointer />, { apiMocks: { 'GET /api/sync/launchpad': info({}) } });
    expect(await screen.findByText(/Not synced\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up launch pad sync in Accounts' })).toBeInTheDocument();
  });

  it('shows nothing where the launch pad cannot sync', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const { requestsTo } = renderWithProviders(<SyncPointer />, { apiMocks: {} });
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    expect(requestsTo('GET /api/sync/launchpad')).toHaveLength(0);
  });
});
