/**
 * The Pages build's page-load capabilities (`capabilities.ts`, which the static project runs with
 * `__PORTLY_STATIC__` on): the browser backend until `main.tsx` calls `setPageBackend`, the
 * server backend after it, the test reset, the static handlers' fixed widget refusal list, and
 * hybrid mode off while the build has no local server origin (the static project defines it `''`).
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_UNAVAILABLE_WIDGET_TYPES,
  STATIC_BUILD,
  capabilitiesFor,
  getCapabilities,
  isWidgetTypeAvailable,
  setCapabilitiesForTests,
  setPageBackend,
} from '../capabilities.ts';
import { HYBRID_ENABLED, LOCAL_SERVER_ORIGIN } from '../localServer/config.ts';

describe('Pages build capabilities', () => {
  it('uses the browser backend until the page load picks one', () => {
    expect(STATIC_BUILD).toBe(true);
    expect(getCapabilities()).toBe(capabilitiesFor(true, 'browser'));
    expect(isWidgetTypeAvailable('calendar')).toBe(false);
  });

  it('follows setPageBackend, and the test reset goes back to the browser backend', () => {
    setPageBackend('server');
    expect(getCapabilities()).toBe(capabilitiesFor(true, 'server'));
    expect(getCapabilities().remoteServer).toBe(true);
    expect(getCapabilities().calendar).toBe(true);
    expect(isWidgetTypeAvailable('calendar')).toBe(true);
    setCapabilitiesForTests(null);
    expect(getCapabilities()).toBe(capabilitiesFor(true, 'browser'));
  });

  it('a test override wins over the page backend', () => {
    setPageBackend('server');
    setCapabilitiesForTests(capabilitiesFor(false, 'server'));
    expect(getCapabilities().pagesBuild).toBe(false);
  });

  it('the static handlers refuse calendar, mail and feeds whatever the page backend', () => {
    setPageBackend('server');
    expect([...BROWSER_UNAVAILABLE_WIDGET_TYPES]).toEqual(['calendar', 'mail', 'feeds']);
  });

  it('turns hybrid mode off without a local server origin', () => {
    expect(LOCAL_SERVER_ORIGIN).toBe('');
    expect(HYBRID_ENABLED).toBe(false);
  });
});
