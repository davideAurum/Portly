/**
 * ServerOnlyNotice in a hybrid Pages build (`localServer/config.ts` mocked with a local server
 * origin) on its in-browser backend: the "needs Homebase running on this PC" wording and the one
 * next step from the local server store (Look for it, Pair this browser — also for a different
 * Homebase than the paired one —, Switch now, Check again),
 * in a widget frame and for a hidden settings section; the plain notice without a controller or
 * inside a frame.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { WidgetFrame } from '../grid/WidgetFrame.tsx';
import { setLocalServerController } from '../localServer/store.ts';
import { SettingsShell } from '../settings/SettingsShell.tsx';
import { fakeLocalServer } from '../test/hybrid.ts';
import { renderWithProviders } from '../test/render.tsx';
import { NEEDS_LOCAL_SERVER_NOTICE, ServerOnlyNotice } from './ServerOnlyNotice.tsx';

vi.mock('../localServer/config.ts', () => ({ LOCAL_SERVER_ORIGIN: 'http://127.0.0.1:5757', HYBRID_ENABLED: true }));

const MAIL_INSTANCE = { id: 'w1', type: 'mail', x: 0, y: 0, w: 4, h: 6, config: {}, frame: { showHeader: true, transparent: false } };

function plug(state: Parameters<typeof fakeLocalServer>[0] = {}) {
  const fake = fakeLocalServer(state);
  act(() => setLocalServerController(fake.controller));
  return fake;
}

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

describe('ServerOnlyNotice (hybrid mode, in-browser backend)', () => {
  it('before the first check: offers to look for Homebase on this PC (a user gesture)', async () => {
    const fake = plug({ status: 'idle' });
    renderWithProviders(<ServerOnlyNotice feature="Calendar" hint="Remove it in edit mode." />, { toaster: false });
    expect(screen.getByText('Calendar needs Homebase running on this PC')).toBeInTheDocument();
    expect(screen.getByText(`${NEEDS_LOCAL_SERVER_NOTICE} Remove it in edit mode.`)).toBeInTheDocument();
    expect(screen.queryByText(/browser-only build/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Look for it' }));
    expect(fake.actions.lookForServer).toHaveBeenCalledTimes(1);
    expect(fake.actions.checkNow).not.toHaveBeenCalled();
  });

  it('follows the controller: Check again when absent, busy while checking, Pair when found but not paired, Switch now when only waiting', async () => {
    const fake = plug({ status: 'absent', checkedAt: 1 });
    renderWithProviders(<ServerOnlyNotice feature="Mail" />, { toaster: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(fake.actions.checkNow).toHaveBeenCalledTimes(1);

    act(() => fake.set({ status: 'checking' }));
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveAttribute('aria-busy', 'true');
    act(() => fake.set({ status: 'waiting-permission' }));
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();

    act(() => fake.set({ status: 'unpaired' }));
    await user.click(screen.getByRole('button', { name: 'Pair this browser' }));
    expect(fake.actions.startPairing).toHaveBeenCalledTimes(1);
    act(() => fake.set({ status: 'revoked' }));
    expect(screen.getByRole('button', { name: 'Pair this browser' })).toBeInTheDocument();
    // A different Homebase (e.g. reinstalled) never becomes the paired one again: only pairing helps.
    act(() => fake.set({ status: 'other-server', paired: true }));
    await user.click(screen.getByRole('button', { name: 'Pair this browser' }));
    expect(fake.actions.startPairing).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    // Still Check again where a later check can succeed.
    for (const status of ['blocked', 'incompatible'] as const) {
      act(() => fake.set({ status }));
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    }

    act(() => fake.set({ status: 'connected', paired: true, pendingSwitch: { target: 'server', reason: 'connected' } }));
    await user.click(screen.getByRole('button', { name: 'Switch now' }));
    expect(fake.actions.switchNow).toHaveBeenCalledTimes(1);
  });

  it('is the plain notice without a controller or inside a frame (no server to find)', () => {
    const { unmount } = renderWithProviders(<ServerOnlyNotice feature="Calendar" />, { toaster: false });
    expect(screen.getByText('Calendar needs the Homebase server')).toBeInTheDocument();
    expect(screen.getByText('Not available in the browser-only build.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();

    plug({ status: 'framed' });
    renderWithProviders(<ServerOnlyNotice feature="Calendar" />, { toaster: false });
    expect(screen.getByText('Calendar needs the Homebase server')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stands in for a server-only widget in a layout, keeping the frame and the edit-mode hint', async () => {
    const fake = plug({ status: 'absent' });
    renderWithProviders(<WidgetFrame instance={MAIL_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    const frame = screen.getByRole('region', { name: 'Mail' });
    expect(within(frame).getByText('Mail needs Homebase running on this PC')).toBeInTheDocument();
    expect(within(frame).getByText(`${NEEDS_LOCAL_SERVER_NOTICE} Remove it in edit mode.`)).toBeInTheDocument();
    expect(within(frame).queryByRole('button', { name: 'Mail settings' })).not.toBeInTheDocument();
    await userEvent.setup().click(within(frame).getByRole('button', { name: 'Check again' }));
    expect(fake.actions.checkNow).toHaveBeenCalledTimes(1);
  });

  it('answers a hidden settings section opened by URL', async () => {
    const fake = plug({ status: 'idle' });
    renderWithProviders(<SettingsShell section="calendars" />);
    expect(await screen.findByText('Calendars needs Homebase running on this PC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Calendars' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Look for it' }));
    expect(fake.actions.lookForServer).toHaveBeenCalledTimes(1);
  });
});
