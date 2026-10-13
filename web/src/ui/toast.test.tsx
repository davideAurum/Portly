import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { setLocalServerController } from '../localServer/store.ts';
import { fakeLocalServer } from '../test/hybrid.ts';
import { errorMessage, reserveToastSpace, unreachableCopy, useToastSpaceReserved } from './toast.ts';

describe('errorMessage', () => {
  const network = new ApiError(0, 'network_error', 'Portly is not reachable');

  it('uses the server message, else the fallback', () => {
    expect(errorMessage(new ApiError(502, 'provider_error', 'Google is down'))).toBe('Google is down');
    expect(errorMessage(new Error('boom'), 'Could not save.')).toBe('Could not save.');
  });

  it('words an unreachable backend for this page load’s backend', () => {
    expect(errorMessage(network)).toBe('Portly is not reachable. Is the server running?');
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    expect(errorMessage(network)).toBe("Portly on this PC isn't reachable. Is it running?");
    expect(unreachableCopy().title).toBe("Portly on this PC isn't reachable");
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(errorMessage(network)).toBe("Portly couldn't load its data. Reload the page to try again.");
    expect(unreachableCopy().message).not.toMatch(/server|on this PC/);
  });

  it('on Portly on this PC, says the page is switching once server mode has ended (not that it reconnects)', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeLocalServer({ backend: 'server', status: 'reconnecting', paired: true, permission: 'granted' });
    setLocalServerController(fake.controller);
    // Reconnecting: the page does come back to the server.
    expect(unreachableCopy()).toMatchObject({ title: "Portly on this PC isn't reachable", retry: true });
    expect(unreachableCopy().hint).toMatch(/reconnects when it is back/);

    // The pairing was revoked (or another Portly or API version answers, or the grace ran out):
    // requests fail until the page reloads on the copy in this browser.
    for (const reason of ['revoked', 'other-server', 'incompatible', 'unreachable'] as const) {
      fake.set({ status: reason === 'unreachable' ? 'absent' : reason, pendingSwitch: { target: 'browser', reason } });
      const copy = unreachableCopy();
      expect(copy).toMatchObject({ title: 'This page is switching to the copy saved in this browser', retry: false });
      expect(copy.hint).not.toMatch(/reconnects|running/);
      expect(errorMessage(network)).toBe('This page is switching to the copy saved in this browser.');
    }

    // The switch was withdrawn (the server answered again): back to the reconnect wording.
    fake.set({ status: 'reconnecting', pendingSwitch: null });
    expect(errorMessage(network)).toBe("Portly on this PC isn't reachable. Is it running?");
  });

  it('a pending switch to Portly on this PC leaves the in-browser wording alone', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    setLocalServerController(fakeLocalServer({ status: 'connected', paired: true, pendingSwitch: { target: 'server', reason: 'connected' } }).controller);
    expect(unreachableCopy()).toMatchObject({ title: "Portly couldn't load its data", retry: true });
  });
});

describe('toast space for bottom bars', () => {
  it('is reserved while any bar is shown and released idempotently', () => {
    const { result } = renderHook(() => useToastSpaceReserved());
    expect(result.current).toBe(false);

    let releaseA = () => {};
    let releaseB = () => {};
    act(() => {
      releaseA = reserveToastSpace();
      releaseB = reserveToastSpace();
    });
    expect(result.current).toBe(true);

    act(() => {
      releaseA();
      releaseA(); // a second call must not release the other bar's reservation
    });
    expect(result.current).toBe(true);

    act(() => releaseB());
    expect(result.current).toBe(false);
  });
});
