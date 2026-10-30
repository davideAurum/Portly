import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTION_IDS } from '../settings/nav.ts';
import { clearHashFocus, hashFocus, navigate, parseHash, routeHref, useRoute } from './router.ts';

const NONCE = 'N0nce_-abcdefghijklmnopqrstuvwxyz0123456789';

describe('hash router', () => {
  it('parses the dashboard and settings routes', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/nope')).toEqual({ name: 'home' });
    expect(parseHash('#/settings')).toEqual({ name: 'settings', section: 'general' });
    expect(parseHash('#/settings/accounts')).toEqual({ name: 'settings', section: 'accounts' });
    expect(parseHash('#/settings/unknown')).toEqual({ name: 'settings', section: 'general' });
    expect(parseHash('#/settings/import-export?x=1')).toEqual({ name: 'settings', section: 'import-export' });
  });

  it('parses pairing requests, keeping a malformed or missing nonce as null', () => {
    expect(NONCE).toHaveLength(43);
    expect(parseHash(`#/pair?nonce=${NONCE}`)).toEqual({ name: 'pair', nonce: NONCE });
    expect(parseHash(`#/pair?nonce=${NONCE}&extra=1`)).toEqual({ name: 'pair', nonce: NONCE });
    expect(parseHash('#/pair')).toEqual({ name: 'pair', nonce: null });
    expect(parseHash('#/connect')).toEqual({ name: 'connect' });
    expect(parseHash('#/connect/more')).toEqual({ name: 'home' });
    expect(routeHref({ name: 'connect' })).toBe('#/connect');
    expect(parseHash('#/pair?nonce=short')).toEqual({ name: 'pair', nonce: null });
    expect(parseHash(`#/pair?nonce=${NONCE}x`)).toEqual({ name: 'pair', nonce: null });
    expect(parseHash(`#/pair?nonce=${NONCE.slice(0, 42)}!`)).toEqual({ name: 'pair', nonce: null });
    // Only the exact route: deeper paths and the Pages site's return route are the dashboard.
    expect(parseHash(`#/pair/x?nonce=${NONCE}`)).toEqual({ name: 'home' });
    expect(parseHash(`#/paired?token=${NONCE}&nonce=${NONCE}&instance=abc`)).toEqual({ name: 'home' });
  });

  it('reads the field a deep link asks to start in', () => {
    expect(hashFocus('#/settings/calendars?focus=ics')).toBe('ics');
    expect(hashFocus('#/settings/calendars')).toBeNull();
    expect(hashFocus('#/settings/calendars?focus=<script>')).toBeNull();
  });

  it('opens a moved section in its new home: #/settings/todoist is Todoist in Accounts', () => {
    expect(SETTINGS_SECTION_IDS).not.toContain('todoist');
    expect(parseHash('#/settings/todoist')).toEqual({ name: 'settings', section: 'accounts' });
    expect(hashFocus('#/settings/todoist')).toBe('todoist');
    expect(hashFocus('#/settings/accounts?focus=todoist')).toBe('todoist');
    expect(parseHash('#/settings/constructor')).toEqual({ name: 'settings', section: 'general' });
    expect(hashFocus('#/settings/constructor')).toBeNull();

    window.history.replaceState(null, '', '/#/settings/todoist');
    clearHashFocus();
    expect(window.location.hash).toBe('#/settings/accounts');
    window.history.replaceState(null, '', '/#/settings/accounts?focus=todoist');
    clearHashFocus();
    expect(window.location.hash).toBe('#/settings/accounts');
  });

  it('round-trips every section through routeHref', () => {
    for (const section of SETTINGS_SECTION_IDS) {
      expect(parseHash(routeHref({ name: 'settings', section }))).toEqual({ name: 'settings', section });
    }
    expect(routeHref({ name: 'home' })).toBe('#/');
    expect(routeHref({ name: 'pair', nonce: NONCE })).toBe(`#/pair?nonce=${NONCE}`);
    expect(parseHash(routeHref({ name: 'pair', nonce: NONCE }))).toEqual({ name: 'pair', nonce: NONCE });
    expect(routeHref({ name: 'pair', nonce: null })).toBe('#/pair');
  });

  it('useRoute follows navigation', async () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'home' });
    act(() => navigate({ name: 'settings', section: 'profiles' }, { replace: true }));
    expect(result.current).toEqual({ name: 'settings', section: 'profiles' });
    expect(window.location.hash).toBe('#/settings/profiles');
    act(() => navigate({ name: 'home' }, { replace: true }));
    expect(result.current).toEqual({ name: 'home' });
  });
});
