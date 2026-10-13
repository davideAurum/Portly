/**
 * The local server panel (card and popover variants) per controller status, driven by a fake
 * controller plugged into the store and the Pages build's capabilities: what each status says,
 * which actions it offers and what they call, the permission help, no link out to a page on this
 * PC (everything happens on this page), the disconnect confirmation, focus staying on the check
 * button while a check runs, and background re-probes not flashing "Checking…".
 */
import { act, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLocalServerController, useLocalServer } from '../localServer/store.ts';
import type { LocalServerActions, LocalServerState } from '../localServer/types.ts';
import { renderWithProviders } from '../test/render.tsx';
import { LocalServerPanel, localServerStatusView, useDisplayedLocalServerStatus } from './LocalServerPanel.tsx';

const SERVER = { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' } as const;

const BROWSER_IDLE: LocalServerState = {
  backend: 'browser',
  status: 'idle',
  server: null,
  paired: false,
  checkedAt: null,
  pendingSwitch: null,
  permission: 'prompt',
  manual: false,
};

/** Plugs a fake controller into the store; `set` changes its state (inside act). */
function plugController(initial: Partial<LocalServerState> = {}) {
  let state: LocalServerState = { ...BROWSER_IDLE, ...initial };
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

function renderPanel(state: Partial<LocalServerState>, variant: 'card' | 'popover' = 'card') {
  setCapabilitiesForTests(capabilitiesFor(true, state.backend ?? 'browser'));
  const controller = plugController(state);
  renderWithProviders(<LocalServerPanel variant={variant} />);
  return controller;
}

describe('status views', () => {
  it('labels every status the footer shows, with the version when connected', () => {
    const labels = {
      idle: 'Not checked',
      checking: 'Checking…',
      absent: 'Not detected',
      'waiting-permission': 'Waiting for permission',
      blocked: 'Blocked by browser',
      unpaired: 'Found, not paired',
      'other-server': 'Paired with another Portly',
      revoked: 'Pairing removed',
      incompatible: 'Needs update',
      reconnecting: 'Reconnecting…',
      connected: 'Connected',
    } as const;
    for (const [status, label] of Object.entries(labels)) expect(localServerStatusView(status as keyof typeof labels, null).label).toBe(label);
    expect(localServerStatusView('connected', SERVER)).toEqual({ label: 'Connected · v0.1.0', tone: 'success' });
  });

  it('keeps the settled status during a background re-probe, but shows a check the user started', () => {
    const controller = plugController({ status: 'absent' });
    const { result } = renderHook(() => useDisplayedLocalServerStatus(useLocalServer()));
    expect(result.current).toBe('absent');
    controller.set({ status: 'checking', manual: false });
    expect(result.current).toBe('absent');
    controller.set({ status: 'unpaired' });
    expect(result.current).toBe('unpaired');
    controller.set({ status: 'checking', manual: true });
    expect(result.current).toBe('checking');
  });

  it('shows the first check after mounting as checking', () => {
    plugController({ status: 'checking', manual: false });
    const { result } = renderHook(() => useDisplayedLocalServerStatus(useLocalServer()));
    expect(result.current).toBe('checking');
  });
});

describe('LocalServerPanel', () => {
  it('renders nothing while hybrid mode is off (the inert store)', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { container } = renderWithProviders(<LocalServerPanel variant="card" />, { toaster: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('not checked yet: explains the permission prompt and looks for Portly on a click', async () => {
    const controller = renderPanel({ status: 'idle', permission: 'prompt' });
    const card = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Not checked')).toBeInTheDocument();
    expect(card).toHaveTextContent('your browser asks whether this site may reach apps on this device: choose Allow');
    expect(card).toHaveTextContent("This page's dataSaved in this browser");
    // What the server adds, and that the two datasets stay apart.
    const adds = within(card).getByText('What Portly on this PC adds').parentElement!;
    expect(within(adds).getAllByRole('listitem').map((item) => item.textContent)).toContain('Calendar, mail and RSS feed widgets');
    expect(adds).toHaveTextContent('The copy saved in this browser stays as it is');
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Look for Portly on this PC' }));
    expect(controller.actions.lookForServer).toHaveBeenCalledOnce();
    expect(controller.actions.checkNow).not.toHaveBeenCalled();
  });

  it('keeps focus on the check button while a check runs and its label changes', async () => {
    const user = userEvent.setup();
    const controller = renderPanel({ status: 'idle' });
    const button = screen.getByRole('button', { name: 'Look for Portly on this PC' });
    await user.click(button);
    expect(button).toHaveFocus();
    controller.set({ status: 'checking', manual: true });
    expect(screen.getByText('Looking for Portly on this PC…')).toBeInTheDocument();
    expect(button).toHaveFocus();
    controller.set({ status: 'absent', manual: true, checkedAt: Date.now() - 5_000 });
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleName('Check again');
    expect(screen.getByText(/isn't running on this PC/)).toBeInTheDocument();
    expect(screen.getByText('Last checked')).toBeInTheDocument();
  });

  it('not detected: Check again looks again (unpaired) or re-checks the paired server', async () => {
    const user = userEvent.setup();
    const controller = renderPanel({ status: 'absent', permission: 'granted' });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(controller.actions.lookForServer).toHaveBeenCalledOnce();
    controller.set({ paired: true });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(controller.actions.checkNow).toHaveBeenCalledOnce();
  });

  it('blocked by the browser: says how to allow local network access', () => {
    renderPanel({ status: 'blocked', permission: 'denied' });
    const card = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Blocked by browser')).toBeInTheDocument();
    expect(card).toHaveTextContent('set Local network access (called Apps on device in some versions) to Allow, then check again');
    expect(within(card).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('waiting for permission: points at the browser prompt', () => {
    renderPanel({ status: 'waiting-permission', permission: 'prompt' });
    expect(screen.getByText(/Choose Allow in its prompt next to the address bar/)).toBeInTheDocument();
    expect(screen.queryByText(/Local network access/)).not.toBeInTheDocument();
  });

  it('found, not paired: pairs this browser from here, with no link out to Portly’s own page', async () => {
    const controller = renderPanel({ status: 'unpaired', server: SERVER, permission: 'granted', checkedAt: Date.now() });
    const card = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Found, not paired')).toBeInTheDocument();
    expect(card).toHaveTextContent('Version0.1.0');
    expect(within(card).queryByRole('link', { name: /Open Portly on this PC/ })).not.toBeInTheDocument();
    expect(card.querySelector('a[href^="http://localhost"]')).toBeNull();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Pair this browser' }));
    expect(controller.actions.startPairing).toHaveBeenCalledOnce();
  });

  it('never links to the page address the server reported', () => {
    renderPanel({ status: 'unpaired', server: { ...SERVER, appUrl: 'https://evil.example/' } });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('pairing removed or another Portly: pair again; a stale pairing can be disconnected', () => {
    const controller = renderPanel({ status: 'revoked', server: SERVER });
    expect(screen.getByText('Pairing removed')).toBeInTheDocument();
    expect(screen.getByText(/its pairing was removed there/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair this browser' })).toBeInTheDocument();
    controller.set({ status: 'other-server', paired: true });
    expect(screen.getByText('Paired with another Portly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair this browser' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect this browser' })).toBeInTheDocument();
  });

  it('needs update: explains the version mismatch', () => {
    renderPanel({ status: 'incompatible', server: { ...SERVER, apiVersion: 2 } });
    expect(screen.getByText('Needs update')).toBeInTheDocument();
    expect(screen.getByText(/versions that can't work together/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('connected on the server backend: where the data comes from, no link out, Disconnect after confirming', async () => {
    const user = userEvent.setup();
    const controller = renderPanel({ backend: 'server', status: 'connected', server: SERVER, paired: true, permission: 'granted' });
    const card = screen.getByRole('region', { name: 'Portly on this PC' });
    expect(within(card).getByText('Connected · v0.1.0')).toBeInTheDocument();
    expect(card).toHaveTextContent("This page's data comes from Portly running on this PC.");
    expect(card).toHaveTextContent("This page's dataFrom Portly on this PC");
    expect(within(card).queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    expect(within(card).queryByText('What Portly on this PC adds')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Open Portly on this PC/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Disconnect this browser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect this browser?' });
    expect(controller.actions.disconnect).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(controller.actions.disconnect).toHaveBeenCalledOnce();
  });

  it('reconnecting: keeps the last saved data and offers Check again', async () => {
    const controller = renderPanel({ backend: 'server', status: 'reconnecting', server: SERVER, paired: true });
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByText(/stopped answering/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }));
    expect(controller.actions.checkNow).toHaveBeenCalledOnce();
  });

  it('a pending switch explains the wait and switches now on request', async () => {
    const controller = renderPanel({ status: 'connected', server: SERVER, paired: true, pendingSwitch: { target: 'server', reason: 'connected' } });
    expect(screen.getByText(/This page switches to Portly on this PC when you're done/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch now' }));
    expect(controller.actions.switchNow).toHaveBeenCalledOnce();
  });

  it('in a frame: says why and offers nothing to do', () => {
    renderPanel({ status: 'framed', permission: null });
    expect(screen.getByText(/Inside a frame, Portly always uses the copy saved in this browser/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('the popover variant has its own title and folds what the server adds into a disclosure', async () => {
    renderPanel({ status: 'absent' }, 'popover');
    expect(screen.queryByRole('region', { name: 'Portly on this PC' })).not.toBeInTheDocument();
    expect(screen.getByText('Portly on this PC')).toBeInTheDocument();
    const summary = screen.getByText('What Portly on this PC adds');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.parentElement).not.toHaveAttribute('open');
  });
});
