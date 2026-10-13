/**
 * Settings → Diagnostics per build and backend: the server build and the Pages site on Portly
 * on this PC show every panel (the Pages site adds "This site" and the link to the diagnostics
 * page on this PC, and never shows the server's paths); a server older than diagnostics (summary
 * `403 local_only` / `404`) and the in-browser backend show the overview and This browser only,
 * with a notice instead of a broken page; This browser then keeps every event here. Each tab panel
 * is named by its tab. Banners: version skew, a foreign site, and Portly answering on this PC but
 * not to this site (with this site's full address). "Show related log lines" switches to the
 * Server log, filtered to that subject around its last failure.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { recordClientEvent } from '../../diagnostics/clientLog.ts';
import { diagnosticsSummary, healthEntry, jobInfo, logRecord, logsResponse } from '../../diagnostics/ui/testing.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import { settings } from '../../test/fixtures.ts';
import { fakeLocalServer } from '../../test/hybrid.ts';
import { mockError, renderWithProviders } from '../../test/render.tsx';
import DiagnosticsSettings from './Diagnostics.tsx';

/** The page's own requests answered, so that none of them becomes a browser event in these tests. */
const BASE = { 'GET /api/accounts': [], 'GET /api/settings': settings() };

const TABS = ['Overview', 'Connections & sync', 'Logging level', 'Server log', 'This browser', 'Report'];

function tabNames(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '');
}

const RICH = diagnosticsSummary({
  server: {
    ...diagnosticsSummary().server,
    supervised: true,
    restart: { attempt: 2, lastExit: JSON.stringify({ code: 1, signal: null, failure: { phase: 'db', errName: 'Error', message: 'database is locked' } }) },
  },
  modules: [
    { name: 'core', ok: true },
    { name: 'mail', ok: false },
  ],
  counts: { server: { warn: 3, error: 1 }, client: { warn: 0, error: 0 }, warnKeysLastHour: 2, memoryRecords: 120 },
  inFlight: { count: 1, oldestMs: 5000, routes: ['GET /api/mail/summary'], outbound: [{ host: 'graph.microsoft.com', purpose: 'mail.list', ms: 3000 }] },
});

describe('Diagnostics settings', () => {
  it('server build: every panel, the server at a glance, no link elsewhere', async () => {
    const { requestsTo } = renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': RICH, ...BASE } });
    expect(tabNames()).toEqual(TABS);
    // Radix labels each panel by its tab.
    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText('pid 4242 · Node v24.21.0 · win32 · 120 MB memory')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Portly server' });
    expect(within(card).getByText(/Supervised · restarted 2 times/)).toBeInTheDocument();
    expect(within(card).getByText('exit code 1, start-up failed (db): Error: database is locked')).toBeInTheDocument();
    expect(within(card).getByText('mail is down')).toBeInTheDocument();
    expect(within(card).getByText('Server: 3 warnings, 1 error · Browsers: 0 warnings, 0 errors')).toBeInTheDocument();
    expect(within(card).getByText('1 request (oldest 5 s): GET /api/mail/summary · outbound: graph.microsoft.com (mail.list) 3 s')).toBeInTheDocument();
    expect(within(card).getByText('Normal (info)')).toBeInTheDocument();
    expect(within(card).getByDisplayValue('C:\\Users\\~\\AppData\\Local\\Portly\\logs')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'This site' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open diagnostics on this PC/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requestsTo('GET /api/diagnostics/summary')).toHaveLength(1);
  });

  it('warns about version skew and a foreign site that tried to use this server', async () => {
    const summary = diagnosticsSummary({
      server: { ...diagnosticsSummary().server, version: '0.2.0' },
      hybrid: { pagesOrigin: null, pairings: 0, lastPairedRequestAt: null, foreignOrigins: [{ origin: 'https://dana.github.io', firstAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T11:00:00.000Z', count: 4 }], foreignOriginRequests: 0 },
    });
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': summary, ...BASE } });
    expect(await screen.findByText('This page is version 0.0.0-test; Portly is 0.2.0')).toBeInTheDocument();
    expect(screen.getByText('A page at https://dana.github.io tried to use this server, but PORTLY_PAGES_URL is not set')).toBeInTheDocument();
    // The server knows the origin only: the setting is the site's full address, which may have a path.
    expect(screen.getByText(/to its full address \(it starts with/)).toHaveTextContent('set PORTLY_PAGES_URL to its full address (it starts with https://dana.github.io/; a project site adds its path).');
    // A plain restart keeps the old environment: how to make Portly read the new value.
    expect(screen.getByText(/a plain restart keeps the old value/)).toHaveTextContent(/re-run scripts\/install-autostart\.ps1 .*-Trigger Logon.*sign out of Windows and back in/);
    expect(screen.getByText('This page: 0.0.0-test')).toBeInTheDocument();
  });

  it('names the configured Pages site when another site tried to use this server', async () => {
    const summary = diagnosticsSummary({
      hybrid: { pagesOrigin: 'https://me.github.io', pairings: 1, lastPairedRequestAt: null, foreignOrigins: [{ origin: 'https://dana.github.io', firstAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T11:00:00.000Z', count: 1 }], foreignOriginRequests: 2 },
    });
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': summary, ...BASE } });
    expect(await screen.findByText('A page at https://dana.github.io tried to use this server, but PORTLY_PAGES_URL is set to https://me.github.io')).toBeInTheDocument();
  });

  it('Pages site on Portly on this PC: every panel, this site’s card and the link to diagnostics on this PC, no paths', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', paired: true, permission: 'granted', server: { version: '0.0.0-test', instanceId: 'i1', appUrl: 'http://127.0.0.1:5757/', apiVersion: 1, vault: 'ready' } }).controller);
    const summary = diagnosticsSummary({ server: { ...diagnosticsSummary().server, pid: null, memory: null, dataDir: '', logDir: '' } });
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': summary, ...BASE } });
    expect(tabNames()).toEqual(TABS);
    expect(await screen.findByText('Node v24.21.0 · win32')).toBeInTheDocument();
    const server = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(server).queryByText('Log folder')).not.toBeInTheDocument();
    const site = screen.getByRole('region', { name: 'This site' });
    expect(within(site).getByText('From Portly on this PC')).toBeInTheDocument();
    expect(within(site).getByText('Connected · v0.0.0-test')).toBeInTheDocument();
    expect(within(site).getByText('Allowed')).toBeInTheDocument();
    const link = within(site).getByRole('link', { name: /Open diagnostics on this PC/ });
    expect(link).toHaveAttribute('href', 'http://127.0.0.1:5757/#/settings/diagnostics');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it.each([
    ['the Pages site (403 local_only)', true, mockError(403, 'local_only', 'This request is only allowed from Portly itself')],
    ['its own page (404)', false, mockError(404, 'not_found', 'Not found')],
  ])('a server without diagnostics answering %s: the update notice, the overview and This browser only', async (_label, pages, answer) => {
    if (pages) setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': answer, ...BASE } });
    expect(await screen.findByText('Update Portly on this PC to see its diagnostics')).toBeInTheDocument();
    expect(tabNames()).toEqual(['Overview', 'This browser']);
    if (pages) expect(screen.getByRole('link', { name: /Open diagnostics on this PC/ })).toBeInTheDocument();
    recordClientEvent('warn', 'app', 'uncaught error', { errName: 'TypeError' });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'This browser' }));
    expect(await screen.findByRole('region', { name: 'This browser' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'This browser' })).toBeInTheDocument();
    // That server refuses browser events: they stay here.
    expect(within(screen.getByText('uncaught error').closest('button')!).getByText('This browser only')).toBeInTheDocument();
  });

  it('marks debug events as sent once verbose logging covers browser events', async () => {
    recordClientEvent('debug', 'hybrid', 'probe result', { kind: 'healthy' });
    const verbose = diagnosticsSummary({ logLevel: { level: 'debug', verbose: true, until: null, areas: ['client'], bootLevel: 'info', persisted: false } });
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': verbose, ...BASE } });
    await screen.findByText('pid 4242 · Node v24.21.0 · win32 · 120 MB memory');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'This browser' }));
    expect(within(screen.getByText('probe result').closest('button')!).getByText('Not sent yet')).toBeInTheDocument();
  });

  it('any other summary error is a notice with Retry, never a crash', async () => {
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: { 'GET /api/diagnostics/summary': mockError(500, 'internal', 'Boom'), ...BASE } });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(tabNames()).toEqual(TABS);
  });

  it('in-browser backend: this site, the hybrid state and This browser; never asks a server', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    setLocalServerController(fakeLocalServer({ status: 'absent', permission: 'denied', checkedAt: Date.now() }).controller);
    recordClientEvent('warn', 'hybrid', 'probe result', { kind: 'unreachable', timedOut: true });
    const { requests } = renderWithProviders(<DiagnosticsSettings />, { apiMocks: BASE });
    expect(tabNames()).toEqual(['Overview', 'This browser']);
    const site = screen.getByRole('region', { name: 'This site' });
    expect(within(site).getByText('Saved in this browser')).toBeInTheDocument();
    expect(within(site).getByText('Not detected')).toBeInTheDocument();
    expect(within(site).getByText('Blocked')).toBeInTheDocument();
    expect(within(site).getByText('1 warning, 0 errors')).toBeInTheDocument();
    expect(within(site).getByRole('link', { name: /Open diagnostics on this PC/ })).toHaveAttribute('href', 'http://127.0.0.1:5757/#/settings/diagnostics');
    expect(screen.queryByText(/does not accept this site/)).not.toBeInTheDocument();
    await waitFor(() => expect(requests.filter((r) => r.path.startsWith('/api/diagnostics'))).toEqual([]));
  });

  it('explains PORTLY_PAGES_URL when Portly answers on this PC but not to this site', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    setLocalServerController(fakeLocalServer({ status: 'absent', permission: 'granted', checkedAt: Date.now(), unreachableReason: 'answers-without-cors' }).controller);
    renderWithProviders(<DiagnosticsSettings />, { apiMocks: BASE });
    expect(screen.getByText('Portly runs on this PC but does not accept this site')).toBeInTheDocument();
    // The site's address with its base path, not just its origin.
    expect(screen.getByText(`PORTLY_PAGES_URL=${new URL(import.meta.env.BASE_URL, window.location.origin).href}`)).toBeInTheDocument();
    expect(screen.getByText(/a plain restart keeps the old value/)).toHaveTextContent(/install-autostart\.ps1/);
    // The answer may also come from a Portly older than this site.
    expect(screen.getByText(/If it already is this address/)).toHaveTextContent(/a Portly older than this site .*scripts\/update\.ps1/);
  });

  it('"Show related log lines" switches to the Server log, filtered to the subject around its last failure', async () => {
    const summary = diagnosticsSummary({
      jobs: [jobInfo('calendar:sync')],
      health: [healthEntry('calendar:cal-1', { accountId: null, label: 'Personal', status: 'failing', lastFailAt: '2026-10-11T12:00:00.000Z', failingSince: '2026-10-11T12:00:00.000Z', lastCode: 'rate_limited', lastStatus: 429 })],
    });
    const { requestsTo } = renderWithProviders(<DiagnosticsSettings />, {
      apiMocks: {
        'GET /api/diagnostics/summary': summary,
        ...BASE,
        'GET /api/diagnostics/logs': logsResponse([logRecord({ level: 'debug', area: 'calendar', msg: 'calendar sync started', fields: { calendarId: 'cal-1' } })]),
        'GET /api/diagnostics/health/:key/history': { key: 'calendar:cal-1', rows: [] },
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Connections & sync' }));
    const row = await screen.findByRole('listitem', { name: 'Personal' });
    await user.click(within(row).getByRole('button', { name: 'Details: Personal' }));
    await user.click(await within(row).findByRole('button', { name: 'Show related log lines' }));

    expect(screen.getByRole('tab', { name: 'Server log' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Server log' })).toHaveFocus());
    expect(await screen.findByText('calendar sync started')).toBeInTheDocument();
    const query = new URLSearchParams(requestsTo('GET /api/diagnostics/logs')[0]!.search);
    expect(Object.fromEntries(query)).toEqual({
      scope: 'memory',
      since: '2026-10-11T11:00:00.000Z',
      before: '2026-10-11T13:00:00.000Z',
      level: 'debug',
      key: 'calendar:cal-1',
      limit: '500',
    });
    expect(screen.getByRole('button', { name: 'Remove filter Subject: Personal' })).toBeInTheDocument();
  });
});
