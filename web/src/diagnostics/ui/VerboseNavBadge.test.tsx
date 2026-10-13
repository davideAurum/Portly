/**
 * The settings navigation shows "Verbose" next to Diagnostics while the server logs verbosely
 * (until a timed verbose ends); never on the in-browser backend, which does not ask any server.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { SettingsShell } from '../../settings/SettingsShell.tsx';
import { settings } from '../../test/fixtures.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { diagnosticsSummary } from './testing.ts';

const ABOUT = { version: '0.0.0-test', dataDir: 'C:\\Data\\Portly', logPath: 'C:\\Data\\Portly\\logs\\server.log', vault: 'ready' };

function renderShell(summary: unknown) {
  return renderWithProviders(<SettingsShell section="about" />, {
    apiMocks: { 'GET /api/diagnostics/summary': summary, 'GET /api/about': ABOUT, 'GET /api/settings': settings(), 'GET /api/pairings': { pagesUrl: null, instanceId: 'i1', pairings: [] } },
  });
}

function diagnosticsLink(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: /^Diagnostics/ });
}

describe('VerboseNavBadge', () => {
  it('marks Diagnostics while verbose logging is on', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    renderShell(diagnosticsSummary({ logLevel: { level: 'debug', verbose: true, until, areas: null, bootLevel: 'info', persisted: true } }));
    await waitFor(() => expect(within(diagnosticsLink()).getByText('Verbose')).toBeInTheDocument());
    expect(diagnosticsLink()).toHaveAttribute('href', '#/settings/diagnostics');
  });

  it('shows nothing at the normal level, or once a timed verbose has ended', async () => {
    const { requestsTo, unmount } = renderShell(diagnosticsSummary());
    await waitFor(() => expect(requestsTo('GET /api/diagnostics/summary')).toHaveLength(1));
    await screen.findByText('Unlocked and ready');
    expect(within(diagnosticsLink()).queryByText('Verbose')).not.toBeInTheDocument();
    unmount();

    const ended = new Date(Date.now() - 1000).toISOString();
    const second = renderShell(diagnosticsSummary({ logLevel: { level: 'debug', verbose: true, until: ended, areas: null, bootLevel: 'info', persisted: true } }));
    await waitFor(() => expect(second.requestsTo('GET /api/diagnostics/summary')).toHaveLength(1));
    await screen.findByText('Unlocked and ready');
    expect(within(diagnosticsLink()).queryByText('Verbose')).not.toBeInTheDocument();
  });

  it('never asks on the in-browser backend', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { requests } = renderShell(diagnosticsSummary());
    expect(diagnosticsLink()).toBeInTheDocument();
    await screen.findByText('Storage');
    expect(requests.filter((r) => r.path.startsWith('/api/diagnostics'))).toEqual([]);
  });
});
