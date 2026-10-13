import { describe, expect, it } from 'vitest';
import { MAX_NAMED, MAX_ORIGIN_LENGTH, createForeignOriginTracker, isNamedForeignOrigin, webOrigin } from './foreign-origins.ts';

describe('webOrigin', () => {
  it.each([
    ['https://user.github.io', 'https://user.github.io'],
    ['http://localhost:4173', 'http://localhost:4173'],
    ['http://[::1]:4173', 'http://[::1]:4173'],
    ['https://Pages.Example', 'https://pages.example'],
  ])('accepts %s', (raw, origin) => {
    expect(webOrigin(raw)).toBe(origin);
  });

  it.each([
    [undefined],
    [''],
    ['null'],
    ['chrome-extension://abcdefghijklmnop'],
    ['moz-extension://1234'],
    ['file:///C:/x'],
    ['https://user.github.io/'],
    ['https://user.github.io/path'],
    ['https://u:p@user.github.io'],
    ['not an origin'],
  ])('rejects %s', (raw) => {
    expect(webOrigin(raw)).toBeNull();
  });

  it(`cuts long origins to ${MAX_ORIGIN_LENGTH} characters`, () => {
    const long = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.example`;
    expect(webOrigin(long)).toBe(long.slice(0, MAX_ORIGIN_LENGTH));
  });
});

describe('isNamedForeignOrigin', () => {
  it('names GitHub Pages sites, loopback origins and the configured Pages domain', () => {
    expect(isNamedForeignOrigin('https://someone.github.io', null)).toBe(true);
    expect(isNamedForeignOrigin('http://localhost:4173', null)).toBe(true);
    expect(isNamedForeignOrigin('http://127.0.0.1:8080', null)).toBe(true);
    expect(isNamedForeignOrigin('http://[::1]:8080', null)).toBe(true);
    expect(isNamedForeignOrigin('https://app.localhost', null)).toBe(true);
    expect(isNamedForeignOrigin('https://www.home.example.org', 'https://pages.home.example.org')).toBe(true);
    expect(isNamedForeignOrigin('https://example.org', 'https://pages.home.example.org')).toBe(true);
  });

  it('only counts everything else (third-party sites are never named)', () => {
    expect(isNamedForeignOrigin('https://news.example', null)).toBe(false);
    expect(isNamedForeignOrigin('https://news.example', 'https://pages.home.example.org')).toBe(false);
    expect(isNamedForeignOrigin('https://github.io.evil.example', null)).toBe(false);
    expect(isNamedForeignOrigin('http://192.168.1.20', 'http://192.168.1.10:4173')).toBe(false);
    expect(isNamedForeignOrigin('not a url', null)).toBe(false);
  });

  it('never names other sites on a shared host or under a country suffix the Pages site lives on', () => {
    // Shared static hosts: every site there is someone else's, only the Pages site's own subdomains count.
    expect(isNamedForeignOrigin('https://other.pages.dev', 'https://homebase.pages.dev')).toBe(false);
    expect(isNamedForeignOrigin('https://pages.dev', 'https://homebase.pages.dev')).toBe(false);
    expect(isNamedForeignOrigin('https://preview.homebase.pages.dev', 'https://homebase.pages.dev')).toBe(true);
    expect(isNamedForeignOrigin('https://someone.netlify.app', 'https://home.netlify.app')).toBe(false);
    expect(isNamedForeignOrigin('https://someone.gitlab.io', 'https://me.gitlab.io')).toBe(false);
    // Country suffixes: the registrable domain takes a third label.
    expect(isNamedForeignOrigin('https://news.co.uk', 'https://home.example.co.uk')).toBe(false);
    expect(isNamedForeignOrigin('https://shop.other.co.uk', 'https://home.example.co.uk')).toBe(false);
    expect(isNamedForeignOrigin('https://www.example.co.uk', 'https://home.example.co.uk')).toBe(true);
    expect(isNamedForeignOrigin('https://other.com.au', 'https://example.com.au')).toBe(false);
    // A Pages host that is a bare suffix names nothing beyond the GitHub Pages and loopback rules.
    expect(isNamedForeignOrigin('https://x.co.uk', 'https://co.uk')).toBe(false);
    // An ordinary domain keeps its last two labels.
    expect(isNamedForeignOrigin('https://www.example.com', 'https://pages.example.com')).toBe(true);
  });
});

describe('createForeignOriginTracker', () => {
  it('keeps named origins (most recent first, counts) and only counts the others', () => {
    const tracker = createForeignOriginTracker();
    tracker.note('https://a.github.io', { named: true }, 1);
    tracker.note('https://b.github.io', { named: true }, 2);
    tracker.note('https://a.github.io', { named: true }, 3);
    tracker.note('https://news.example', { named: false }, 4);
    expect(tracker.snapshot()).toEqual({
      origins: [
        { origin: 'https://a.github.io', firstAt: 1, lastAt: 3, count: 2 },
        { origin: 'https://b.github.io', firstAt: 2, lastAt: 2, count: 1 },
      ],
      requests: 1,
    });
    tracker.reset();
    expect(tracker.snapshot()).toEqual({ origins: [], requests: 0 });
  });

  it(`keeps at most ${MAX_NAMED}, dropping the least recently seen`, () => {
    const tracker = createForeignOriginTracker();
    for (let i = 0; i < MAX_NAMED + 2; i++) tracker.note(`https://s${i}.github.io`, { named: true }, i);
    const origins = tracker.snapshot().origins.map((o) => o.origin);
    expect(origins).toHaveLength(MAX_NAMED);
    expect(origins[0]).toBe(`https://s${MAX_NAMED + 1}.github.io`);
    expect(origins).not.toContain('https://s0.github.io');
  });
});
