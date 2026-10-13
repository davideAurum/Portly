/**
 * capabilities.ts in the server build (the web project defines `__PORTLY_STATIC__` false): the
 * flags of every build/backend combination, the page load's capabilities and the test override,
 * and widget availability. The Pages build's own defaults (browser backend until `setPageBackend`)
 * are covered by `static/pagesBuild.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as capabilities from './capabilities.ts';
import {
  BROWSER_UNAVAILABLE_WIDGET_TYPES,
  STATIC_BUILD,
  capabilitiesFor,
  getCapabilities,
  isWidgetTypeAvailable,
  setCapabilitiesForTests,
  setPageBackend,
  unavailableWidgetTypes,
  type Capabilities,
} from './capabilities.ts';

const SERVER_FEATURES = ['accounts', 'googleAccounts', 'appPasswordAccounts', 'calendar', 'mail', 'feeds', 'vault', 'browserBookmarkImport', 'siteMetaFetch', 'serverSearchSuggestions'] as const;

function featureFlags(caps: Capabilities): Record<string, boolean> {
  return Object.fromEntries(SERVER_FEATURES.map((name) => [name, caps[name]]));
}

describe('capabilitiesFor', () => {
  it('server build: every feature, icons polled', () => {
    expect(capabilitiesFor(false, 'server')).toEqual({
      pagesBuild: false,
      backend: 'server',
      remoteServer: false,
      accounts: true,
      googleAccounts: true,
      appPasswordAccounts: true,
      calendar: true,
      mail: true,
      feeds: true,
      vault: true,
      browserBookmarkImport: true,
      siteMetaFetch: true,
      serverSearchSuggestions: true,
      browserBackups: false,
      iconPolling: true,
    });
  });

  it('Pages build on the browser backend: no server feature, in-browser backups, Outlook.com accounts set up here', () => {
    expect(capabilitiesFor(true, 'browser')).toEqual({
      pagesBuild: true,
      backend: 'browser',
      remoteServer: false,
      accounts: true,
      googleAccounts: false,
      appPasswordAccounts: false,
      calendar: false,
      mail: false,
      feeds: false,
      vault: false,
      browserBookmarkImport: false,
      siteMetaFetch: false,
      serverSearchSuggestions: false,
      browserBackups: true,
      iconPolling: false,
    });
  });

  it('Pages build on the server backend: every server feature, account setup included, as in the server build', () => {
    const caps = capabilitiesFor(true, 'server');
    expect(caps).toMatchObject({ pagesBuild: true, backend: 'server', remoteServer: true, browserBackups: false, iconPolling: true });
    expect(featureFlags(caps)).toEqual(featureFlags(capabilitiesFor(false, 'server')));
    expect({ ...caps, pagesBuild: false, remoteServer: false }).toEqual(capabilitiesFor(false, 'server'));
    expect(caps).not.toHaveProperty('accountSetupHere');
  });

  it('returns the same frozen object for the same combination', () => {
    const caps = capabilitiesFor(true, 'server');
    expect(capabilitiesFor(true, 'server')).toBe(caps);
    expect(capabilitiesFor(true, 'browser')).not.toBe(caps);
    expect(capabilitiesFor(false, 'server')).not.toBe(caps);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(() => {
      (caps as { accounts: boolean }).accounts = false;
    }).toThrow(TypeError);
    expect(caps.accounts).toBe(true);
  });
});

describe('getCapabilities (server build)', () => {
  it('is the server build, and setPageBackend cannot change it', () => {
    expect(STATIC_BUILD).toBe(false);
    expect(getCapabilities()).toBe(capabilitiesFor(false, 'server'));
    setPageBackend('browser');
    expect(getCapabilities()).toBe(capabilitiesFor(false, 'server'));
  });

  it('setCapabilitiesForTests overrides it (build included) until reset with null', () => {
    const pagesBrowser = capabilitiesFor(true, 'browser');
    setCapabilitiesForTests(pagesBrowser);
    expect(getCapabilities()).toBe(pagesBrowser);
    expect(getCapabilities().pagesBuild).toBe(true);
    setCapabilitiesForTests(null);
    expect(getCapabilities()).toBe(capabilitiesFor(false, 'server'));
  });
});

describe('widget availability', () => {
  it('a browser backend cannot run calendar, mail or feeds; a server backend runs everything', () => {
    expect([...unavailableWidgetTypes(capabilitiesFor(true, 'browser'))]).toEqual(['calendar', 'mail', 'feeds']);
    expect(unavailableWidgetTypes(capabilitiesFor(true, 'server')).size).toBe(0);
    expect(unavailableWidgetTypes(capabilitiesFor(false, 'server')).size).toBe(0);
    expect(isWidgetTypeAvailable('calendar', capabilitiesFor(true, 'browser'))).toBe(false);
    expect(isWidgetTypeAvailable('clock', capabilitiesFor(true, 'browser'))).toBe(true);
    expect(isWidgetTypeAvailable('calendar', capabilitiesFor(true, 'server'))).toBe(true);
  });

  it('defaults to this page load’s capabilities', () => {
    expect(unavailableWidgetTypes().size).toBe(0);
    expect(isWidgetTypeAvailable('mail')).toBe(true);
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(unavailableWidgetTypes()).toBe(unavailableWidgetTypes(capabilitiesFor(true, 'browser')));
    expect(isWidgetTypeAvailable('mail')).toBe(false);
    expect(isWidgetTypeAvailable('weather')).toBe(true);
  });

  it('derives availability from the flags, so hand-made test capabilities work too', () => {
    const noFeeds: Capabilities = { ...capabilitiesFor(false, 'server'), feeds: false };
    expect([...unavailableWidgetTypes(noFeeds)]).toEqual(['feeds']);
    expect(unavailableWidgetTypes(noFeeds)).toBe(unavailableWidgetTypes(noFeeds));
  });

  it('BROWSER_UNAVAILABLE_WIDGET_TYPES is the browser backend’s set whatever the page load', () => {
    expect([...BROWSER_UNAVAILABLE_WIDGET_TYPES]).toEqual(['calendar', 'mail', 'feeds']);
    expect(BROWSER_UNAVAILABLE_WIDGET_TYPES).toBe(unavailableWidgetTypes(capabilitiesFor(true, 'browser')));
  });
});

describe('module surface', () => {
  it('has no build-level aliases left: every reader goes through getCapabilities()', () => {
    expect(Object.keys(capabilities).sort()).toEqual([
      'BROWSER_UNAVAILABLE_WIDGET_TYPES',
      'STATIC_BUILD',
      'capabilitiesFor',
      'getCapabilities',
      'isWidgetTypeAvailable',
      'setCapabilitiesForTests',
      'setPageBackend',
      'unavailableWidgetTypes',
    ]);
  });
});
