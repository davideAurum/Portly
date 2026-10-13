/**
 * Hand-rolled hash router (§10.1, §10.5): `#/` (dashboard), `#/settings/<section>` and
 * `#/pair?nonce=…` (the server's page approving a browser for the Pages site, hybrid mode).
 * Unknown hashes resolve to the dashboard; unknown settings sections to `general`; a pairing
 * request without a well-formed nonce keeps the `pair` route with `nonce: null` (the page explains).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { PAIRING_REQUEST_ROUTE, parsePairingRequest } from '@portly/shared';
import { DEFAULT_SETTINGS_SECTION, isSettingsSectionId, type SettingsSectionId } from '../settings/nav.ts';

export type Route = { name: 'home' } | { name: 'settings'; section: SettingsSectionId } | { name: 'pair'; nonce: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const pathPart = raw.split('?', 1)[0] ?? '';
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments[0] === 'settings') {
    const section = segments[1];
    return { name: 'settings', section: isSettingsSectionId(section) ? section : DEFAULT_SETTINGS_SECTION };
  }
  if (segments.length === 1 && segments[0] === 'pair') return { name: 'pair', nonce: parsePairingRequest(raw) };
  return { name: 'home' };
}

/** `#/settings/calendars?focus=ics` → `ics`: the field a settings page should start in. */
export function hashFocus(hash: string = typeof window === 'undefined' ? '' : window.location.hash): string | null {
  const query = hash.split('?')[1];
  if (!query) return null;
  const focus = new URLSearchParams(query).get('focus');
  return focus && /^[a-z0-9-]{1,32}$/.test(focus) ? focus : null;
}

/** Drops `?focus=…` from the address once it has been acted on (a reload must not jump again). */
export function clearHashFocus(): void {
  const url = new URL(window.location.href);
  const [path] = url.hash.split('?');
  if (path === undefined || path === url.hash) return;
  url.hash = path;
  window.history.replaceState(window.history.state, '', url);
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'settings':
      return `#/settings/${route.section}`;
    case 'pair':
      return route.nonce === null ? `#${PAIRING_REQUEST_ROUTE}` : `#${PAIRING_REQUEST_ROUTE}?${new URLSearchParams({ nonce: route.nonce }).toString()}`;
    default:
      return '#/';
  }
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = routeHref(route);
  if (options.replace) {
    const url = new URL(window.location.href);
    url.hash = href;
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

const getHash = (): string => window.location.hash;

/** The current route; re-renders on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}
