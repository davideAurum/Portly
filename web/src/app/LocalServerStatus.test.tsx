/**
 * The footer's local server indicator, driven by a fake controller plugged into the store: when it
 * shows at all, its labels and accessible name, the polite live region (silent on load and during
 * background re-probes, announcing real changes), the keyboard-operable popover with the panel,
 * and "Disconnect this browser" confirmed after the popover closed.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLocalServerController } from '../localServer/store.ts';
import type { LocalServerActions, LocalServerState } from '../localServer/types.ts';
import { renderWithProviders } from '../test/render.tsx';
import { LocalServerStatus } from './LocalServerStatus.tsx';

const SERVER = { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' } as const;

const ABSENT: LocalServerState = {
  backend: 'browser',
  status: 'absent',
  server: null,
  paired: false,
  checkedAt: 1_700_000_000_000,
  pendingSwitch: null,
  permission: 'granted',
  manual: false,
};

/** Plugs a fake controller into the store; `set` changes its state (inside act). */
function plugController(initial: Partial<LocalServerState> = {}) {
  let state: LocalServerState = { ...ABSENT, ...initial };
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

function renderStatus(state: Partial<LocalServerState> = {}) {
  setCapabilitiesForTests(capabilitiesFor(true, state.backend ?? 'browser'));
  const controller = plugController(state);
  const result = renderWithProviders(<LocalServerStatus />, { toaster: false });
  return { ...result, controller };
}

/** The indicator's live region (the only polite status region it renders). */
function liveRegion(): HTMLElement {
  return screen.getByRole('status');
}

describe('LocalServerStatus', () => {
  it('renders nothing in the server build, while hybrid mode is off, or in a frame', () => {
    plugController({ status: 'connected', server: SERVER });
    const server = renderWithProviders(<LocalServerStatus />, { toaster: false });
    expect(server.container).toBeEmptyDOMElement();
    server.unmount();

    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    setLocalServerController(null);
    const inert = renderWithProviders(<LocalServerStatus />, { toaster: false });
    expect(inert.container).toBeEmptyDOMElement();
    inert.unmount();

    const framed = renderStatus({ status: 'framed' });
    expect(framed.container).toBeEmptyDOMElement();
  });

  it('shows a dot and the label on a button named for Homebase on this PC', () => {
    const { controller } = renderStatus({ backend: 'server', status: 'connected', server: SERVER, paired: true });
    const button = screen.getByRole('button', { name: 'Homebase on this PC: Connected · v0.1.0' });
    expect(button).toHaveAttribute('data-tone', 'success');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    controller.set({ status: 'reconnecting' });
    expect(button).toHaveAccessibleName('Homebase on this PC: Reconnecting…');
    expect(button).toHaveAttribute('data-tone', 'warning');
  });

  it('announces real status changes only: nothing on load or for a background re-probe', () => {
    const { controller } = renderStatus({ status: 'absent' });
    expect(liveRegion()).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion()).toBeEmptyDOMElement();

    controller.set({ status: 'checking', manual: false });
    expect(screen.getByRole('button', { name: 'Homebase on this PC: Not detected' })).toBeInTheDocument();
    expect(liveRegion()).toBeEmptyDOMElement();
    controller.set({ status: 'absent', checkedAt: 1_700_000_030_000 });
    expect(liveRegion()).toBeEmptyDOMElement();

    controller.set({ status: 'unpaired', server: SERVER });
    expect(liveRegion()).toHaveTextContent('Homebase on this PC: Found, not paired');

    // A check the user started is shown (and announced).
    controller.set({ status: 'checking', manual: true });
    expect(screen.getByRole('button', { name: 'Homebase on this PC: Checking…' })).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Homebase on this PC: Checking…');
  });

  it("stays silent while the page's first background check settles, then announces changes", () => {
    const { controller } = renderStatus({ backend: 'server', status: 'checking', paired: true, checkedAt: null });
    expect(screen.getByRole('button', { name: 'Homebase on this PC: Checking…' })).toBeInTheDocument();
    controller.set({ status: 'connected', server: SERVER, checkedAt: 1_700_000_000_000 });
    expect(screen.getByRole('button', { name: 'Homebase on this PC: Connected · v0.1.0' })).toBeInTheDocument();
    expect(liveRegion()).toBeEmptyDOMElement();

    controller.set({ status: 'reconnecting' });
    expect(liveRegion()).toHaveTextContent('Homebase on this PC: Reconnecting…');
  });

  it('opens the panel in a popover from the keyboard and closes it with Esc, returning focus', async () => {
    const user = userEvent.setup();
    renderStatus({ status: 'unpaired', server: SERVER });
    const button = screen.getByRole('button', { name: 'Homebase on this PC: Found, not paired' });
    button.focus();
    await user.keyboard('{Enter}');
    const popover = await screen.findByRole('dialog', { name: 'Homebase on this PC' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(within(popover).getByText(/this browser isn't paired with it yet/)).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: 'Pair this browser' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it('the popover shows the same status as the indicator during a background re-probe', async () => {
    const user = userEvent.setup();
    const { controller } = renderStatus({ status: 'absent' });
    controller.set({ status: 'checking', manual: false });
    await user.click(screen.getByRole('button', { name: /Homebase on this PC/ }));
    const popover = await screen.findByRole('dialog', { name: 'Homebase on this PC' });
    expect(within(popover).getByText('Not detected')).toBeInTheDocument();
    expect(within(popover).queryByText('Looking for Homebase on this PC…')).not.toBeInTheDocument();
  });

  it('Disconnect this browser closes the popover and confirms before disconnecting', async () => {
    const user = userEvent.setup();
    const { controller } = renderStatus({ backend: 'server', status: 'connected', server: SERVER, paired: true });
    await user.click(screen.getByRole('button', { name: /Homebase on this PC/ }));
    const popover = await screen.findByRole('dialog', { name: 'Homebase on this PC' });
    await user.click(within(popover).getByRole('button', { name: 'Disconnect this browser' }));
    const confirm = await screen.findByRole('dialog', { name: 'Disconnect this browser?' });
    expect(screen.queryByRole('dialog', { name: 'Homebase on this PC' })).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(controller.actions.disconnect).toHaveBeenCalledOnce();
  });
});
