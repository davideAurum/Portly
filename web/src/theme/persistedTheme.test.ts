/**
 * The first-paint theme from the persisted query cache: read from the snapshot of this page
 * load's backend only, whatever its age, and checked against its buster only on the Homebase
 * server on this PC in the Pages build (another server instance's theme is never shown).
 */
import { describe, expect, it } from 'vitest';
import { ThemeSchema, type Theme } from '@homebase/shared';
import { APP_VERSION, QUERY_CACHE_MAX_AGE_MS, persistOptionsFor } from '../app/providers.tsx';
import { applyPersistedTheme, firstPaintSnapshot } from './persistedTheme.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function theme(overrides: Partial<Theme> = {}): Theme {
  return { ...ThemeSchema.parse({}), ...overrides };
}

function snapshot(appearance: Theme, buster = 'v1+static', timestamp = Date.now() - 1_000): string {
  return JSON.stringify({
    buster,
    timestamp,
    clientState: { mutations: [], queries: [{ queryKey: ['settings'], state: { data: { appearance } } }] },
  });
}

function storageWith(items: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key) => items[key] ?? null };
}

function accent(): string {
  return document.documentElement.style.getPropertyValue('--hb-accent');
}

describe('applyPersistedTheme', () => {
  it("reads the named backend's snapshot, not the other one", () => {
    const storage = storageWith({
      'homebase:query-cache:static:/': snapshot(theme({ mode: 'light', accent: '#111111' })),
      'homebase:query-cache:local-server:/': snapshot(theme({ mode: 'dark', accent: '#222222' }), 'v1+local-server:abc'),
    });
    expect(applyPersistedTheme({ key: 'homebase:query-cache:local-server:/', buster: 'v1+local-server:abc' }, storage)).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(accent()).toBe('#222222');

    expect(applyPersistedTheme('homebase:query-cache:static:/', storage)).toBe(true);
    expect(accent()).toBe('#111111');
  });

  it('ignores a snapshot of another server instance or version when given a buster', () => {
    const storage = storageWith({ k: snapshot(theme({ accent: '#333333' }), 'v1+local-server:old') });
    expect(applyPersistedTheme({ key: 'k', buster: 'v1+local-server:new' }, storage)).toBe(false);
    expect(accent()).not.toBe('#333333');
  });

  it('applies a snapshot however old it is', () => {
    const storage = storageWith({ k: snapshot(theme({ accent: '#444444' }), 'b', Date.now() - 30 * DAY_MS) });
    expect(applyPersistedTheme({ key: 'k', buster: 'b' }, storage)).toBe(true);
    expect(accent()).toBe('#444444');
  });

  it('survives unusable storage', () => {
    const throwing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(applyPersistedTheme('k', throwing)).toBe(false);
    expect(applyPersistedTheme({ key: 'k', buster: 'b' }, storageWith({ k: '{not json' }))).toBe(false);
  });
});

describe('firstPaintSnapshot', () => {
  const OLD = Date.now() - 3 * DAY_MS;

  it("paints the server build's last theme after a day or more away and after an upgrade", () => {
    const persist = persistOptionsFor('server', null, { pagesBuild: false, storage: window.localStorage });
    expect(persist.maxAge).toBe(QUERY_CACHE_MAX_AGE_MS);
    expect(firstPaintSnapshot(persist, 'server', { pagesBuild: false })).toEqual({ key: persist.key });
    window.localStorage.setItem(persist.key, snapshot(theme({ accent: '#555555' }), '0.0.0-older', OLD));
    expect(applyPersistedTheme(firstPaintSnapshot(persist, 'server', { pagesBuild: false }))).toBe(true);
    expect(accent()).toBe('#555555');
  });

  it("paints the Pages in-browser backend's last theme whatever its age or version", () => {
    const persist = persistOptionsFor('browser', null, { pagesBuild: true, storage: window.localStorage });
    expect(firstPaintSnapshot(persist, 'browser', { pagesBuild: true })).toEqual({ key: persist.key });
    window.localStorage.setItem(persist.key, snapshot(theme({ accent: '#666666' }), '0.0.0-older+static', OLD));
    expect(applyPersistedTheme(firstPaintSnapshot(persist, 'browser', { pagesBuild: true }))).toBe(true);
    expect(accent()).toBe('#666666');
  });

  it('on the Homebase server on this PC (Pages build), paints only that instance’s theme, however old', () => {
    const persist = persistOptionsFor('server', 'instance-1', { pagesBuild: true, storage: window.localStorage });
    const ref = firstPaintSnapshot(persist, 'server', { pagesBuild: true });
    expect(ref).toEqual({ key: persist.key, buster: `${APP_VERSION}+local-server:instance-1` });

    window.localStorage.setItem(persist.key, snapshot(theme({ accent: '#777777' }), `${APP_VERSION}+local-server:instance-0`));
    expect(applyPersistedTheme(ref)).toBe(false);
    expect(accent()).not.toBe('#777777');

    window.localStorage.setItem(persist.key, snapshot(theme({ accent: '#888888' }), persist.buster, Date.now() - persist.maxAge - DAY_MS));
    expect(applyPersistedTheme(ref)).toBe(true);
    expect(accent()).toBe('#888888');
  });
});
