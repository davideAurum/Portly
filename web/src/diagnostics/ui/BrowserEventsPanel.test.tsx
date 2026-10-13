/**
 * This browser: the recorded events newest first, live as they are recorded (aria-live count),
 * marked as sent, not sent yet or kept in this browser (debug events while the server does not
 * take them; everything when the server predates diagnostics), expandable to their fields; Clear
 * forgets them.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { getClientEvents, markUploaded, recordClientEvent } from '../clientLog.ts';
import { settings } from '../../test/fixtures.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { BrowserEventsPanel } from './BrowserEventsPanel.tsx';

/** Settings answered, so that no failed request of the page itself becomes an event here. */
const MOCKS = { 'GET /api/settings': settings() };

describe('BrowserEventsPanel', () => {
  it('lists the events newest first, live, with how each one is delivered', async () => {
    const answered = recordClientEvent('info', 'api', 'request rejected', { method: 'POST', path: '/api/bookmarks', status: 422, rid: 'abcdefghij' });
    const sent = recordClientEvent('warn', 'hybrid', 'reconnect grace started', { graceMs: 30000 });
    markUploaded([sent!.id]);
    renderWithProviders(<BrowserEventsPanel />, { apiMocks: MOCKS });
    const status = screen.getByText(/^2 events/);
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('2 events, 1 warning or error');

    act(() => {
      recordClientEvent('error', 'app', 'uncaught error', { errName: 'TypeError' });
    });
    expect(screen.getByText('3 events, 2 warnings or errors')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Browser events' })).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getAllByRole('button')[0]!.textContent)).toEqual([
      expect.stringMatching(/uncaught error.*Not sent yet/),
      expect.stringMatching(/reconnect grace started.*Sent/),
      expect.stringMatching(/request rejected.*This browser only/),
    ]);
    expect(answered).not.toBeNull();
  });

  it('says "Not sent yet" only for what will be sent: debug events while the server takes them, nothing to a server without diagnostics', () => {
    recordClientEvent('debug', 'hybrid', 'probe result', { kind: 'healthy' });
    recordClientEvent('warn', 'app', 'uncaught error', { errName: 'TypeError' });
    const labels = () => within(screen.getByRole('list', { name: 'Browser events' })).getAllByRole('listitem').map((row) => within(row).getAllByRole('button')[0]!.textContent);
    const { rerender } = renderWithProviders(<BrowserEventsPanel />, { apiMocks: MOCKS });
    expect(labels()).toEqual([expect.stringMatching(/uncaught error.*Not sent yet$/), expect.stringMatching(/probe result.*This browser only \(debug\)$/)]);
    expect(screen.getByText('Not sent yet')).toHaveAttribute('title', 'Sent to Homebase on this PC within about 15 seconds');
    expect(screen.getByText('This browser only (debug)')).toHaveAttribute('title', 'Debug events are sent only while verbose logging covers browser events (Logging level)');
    // Verbose logging covers browser events: the debug event goes too.
    rerender(<BrowserEventsPanel acceptDebug />);
    expect(labels()).toEqual([expect.stringMatching(/Not sent yet$/), expect.stringMatching(/Not sent yet$/)]);
    // A server older than diagnostics refuses them all.
    rerender(<BrowserEventsPanel serverRefuses acceptDebug />);
    expect(labels()).toEqual([expect.stringMatching(/This browser only$/), expect.stringMatching(/This browser only$/)]);
    expect(screen.getAllByText('This browser only')[0]).toHaveAttribute('title', 'Homebase on this PC is older than this page and does not take browser events');
  });

  it('expands an event to its fields and page', async () => {
    recordClientEvent('warn', 'provider', 'provider request failed', { provider: 'todoist', host: 'api.todoist.com', status: 502 });
    renderWithProviders(<BrowserEventsPanel />, { apiMocks: MOCKS });
    const head = screen.getByText('provider request failed').closest('button')!;
    await userEvent.setup().click(head);
    const fields = JSON.parse(document.getElementById(head.getAttribute('aria-controls')!)!.textContent!);
    expect(fields).toEqual({ provider: 'todoist', host: 'api.todoist.com', status: 502, page: { build: 'server', backend: 'server', version: '0.0.0-test' } });
  });

  it('keeps events of the in-browser backend in this browser only, and clears them', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    recordClientEvent('warn', 'provider', 'provider request failed', { provider: 'open-meteo', status: 503 });
    renderWithProviders(<BrowserEventsPanel />, { apiMocks: MOCKS });
    expect(screen.getByText(/Kept for 7 days in this browser only/)).toBeInTheDocument();
    expect(screen.getByText('This browser only')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear' }));
    expect(getClientEvents()).toHaveLength(0);
    expect(screen.getByText('No events recorded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });
});
