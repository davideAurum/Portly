import { describe, expect, it } from 'vitest';
import { defaultSearchEngines, type BookmarkGroup, type SearchSettings } from '@portly/shared';
import { defaultEngine, engineForKeyword, matchBookmarks, suggestProviderFor, widgetEngines } from './engines.ts';
import { addressCandidate, detectUrl, normalizeTypedUrl } from './url.ts';

describe('detectUrl', () => {
  it.each([
    ['https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['HTTP://Example.com', 'http://example.com/'],
    ['example.com', 'https://example.com/'],
    ['docs.example.co.uk/guide?x=1#top', 'https://docs.example.co.uk/guide?x=1#top'],
    ['sub.example.com:8443/path', 'https://sub.example.com:8443/path'],
    ['bücher.de', 'https://xn--bcher-kva.de/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:5173/settings', 'http://localhost:5173/settings'],
    ['192.168.1.10', 'http://192.168.1.10/'],
    ['10.0.0.2:8080/admin', 'http://10.0.0.2:8080/admin'],
    ['  example.org  ', 'https://example.org/'],
  ])('navigates %j → %j', (input, expected) => {
    expect(detectUrl(input)).toBe(expected);
  });

  it.each([
    'cats',
    'how to cook rice',
    'example .com',
    'v1.2',
    '3.14',
    'e.g',
    'javascript:alert(1)',
    'ftp://example.com/',
    'file:///C:/x',
    'mailto:me@example.com',
    'me@example.com',
    'https://user:pw@example.com/',
    'localhost',
    '',
    '   ',
  ])('searches %j', (input) => {
    expect(detectUrl(input)).toBeNull();
  });

  it.each(['next.js', 'node.js', 'vue.js', 'index.html', 'file.txt', 'app.tsx', 'config.yaml', 'photo.jpg'])(
    'searches %j first (not a real top-level domain) and offers the address second (FUNC-2)',
    (input) => {
      expect(detectUrl(input)).toBeNull();
      expect(addressCandidate(input)).toBe(`https://${input}/`);
    },
  );

  it.each([
    ['intranet.corp/wiki', 'https://intranet.corp/wiki'],
    ['intranet.lan:8080', 'https://intranet.lan:8080/'],
    ['nas.lan', 'https://nas.lan/'],
    ['docs.example.co.uk/x', 'https://docs.example.co.uk/x'],
    ['example.dev', 'https://example.dev/'],
    ['EXAMPLE.COM', 'https://example.com/'],
    ['例え.テスト', null],
    ['пример.рф', 'https://xn--e1afmkfd.xn--p1ai/'],
  ])('still navigates %j directly (port, path, local name or real TLD)', (input, expected) => {
    expect(detectUrl(input)).toBe(expected);
  });

  it('a real ccTLD stays an address even when it looks like a file (readme.md: .md is Moldova)', () => {
    expect(detectUrl('readme.md')).toBe('https://readme.md/');
    expect(addressCandidate('readme.md')).toBeNull();
    expect(addressCandidate('example.com')).toBeNull();
    expect(addressCandidate('cats')).toBeNull();
  });

  it('normalizes typed bookmark URLs', () => {
    expect(normalizeTypedUrl('example.com')).toBe('https://example.com/');
    // An address field takes any host-like text as an address.
    expect(normalizeTypedUrl('next.js')).toBe('https://next.js/');
    expect(normalizeTypedUrl('https://example.com/x y')).toBe('https://example.com/x%20y');
    expect(normalizeTypedUrl('localhost:8080')).toBe('http://localhost:8080/');
    expect(normalizeTypedUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeTypedUrl('data:text/html,hi')).toBeNull();
    expect(normalizeTypedUrl('not a url')).toBeNull();
  });
});

const search = (overrides: Partial<SearchSettings> = {}): SearchSettings => ({
  engines: defaultSearchEngines(),
  defaultEngineId: 'google',
  suggestionsEnabled: true,
  showBookmarkMatches: true,
  ...overrides,
});

describe('engine helpers', () => {
  it('filters engines per widget and falls back to all', () => {
    const s = search();
    expect(widgetEngines(s, 'all').map((e) => e.id)).toEqual(['google', 'duckduckgo', 'bing', 'youtube', 'wikipedia', 'google-maps']);
    expect(widgetEngines(s, ['youtube', 'bing']).map((e) => e.id)).toEqual(['bing', 'youtube']);
    expect(widgetEngines(s, ['gone'])).toHaveLength(6);
    expect(defaultEngine(widgetEngines(s, ['youtube', 'bing']), 'google')?.id).toBe('bing');
  });

  it('finds engines by keyword (case-insensitive)', () => {
    const engines = search().engines;
    expect(engineForKeyword(engines, 'YT')?.id).toBe('youtube');
    expect(engineForKeyword(engines, 'zz')).toBeUndefined();
    expect(engineForKeyword(engines, '')).toBeUndefined();
  });

  it("picks the engine's provider, else the default engine's, else none when disabled", () => {
    const s = search();
    const [google, , , youtube] = s.engines;
    expect(suggestProviderFor(s, youtube, google)).toBe('youtube');
    expect(suggestProviderFor(s, { ...youtube!, suggest: null }, google)).toBe('google');
    expect(suggestProviderFor(search({ suggestionsEnabled: false }), youtube, google)).toBeNull();
  });

  it("falls back to the global default engine's provider, then the widget's default", () => {
    const s = search();
    const [, , , youtube, wikipedia] = s.engines;
    // A widget offering only YouTube (without its own provider) and Wikipedia: §10.8 says
    // "engine provider → default engine's", i.e. Google's, not the widget's first engine's.
    expect(suggestProviderFor(s, { ...youtube!, suggest: null }, wikipedia)).toBe('google');
    const noGlobalProvider = search({ engines: s.engines.map((e) => (e.id === 'google' ? { ...e, suggest: null } : e)) });
    expect(suggestProviderFor(noGlobalProvider, { ...youtube!, suggest: null }, wikipedia)).toBe('wikipedia');
  });

  it('matches bookmarks by title prefix, word start, substring and host (≤ 4, best first)', () => {
    const b = (id: string, title: string, url: string) => ({ id, groupId: 'g', title, url, sort: 0, iconMode: 'auto' as const, iconId: null, letterColor: null });
    const groups: BookmarkGroup[] = [
      {
        id: 'g',
        name: 'G',
        sort: 0,
        color: null,
        collapsed: false,
        bookmarks: [
          b('1', 'My GitHub stars', 'https://github.com/stars'),
          b('2', 'GitHub', 'https://github.com/'),
          b('3', 'Legit news', 'https://news.example/'),
          b('4', 'Docs', 'https://git-scm.com/doc'),
          b('5', 'Recipes', 'https://recipes.example/'),
          b('6', 'Gitea', 'https://gitea.example/'),
        ],
      },
    ];
    expect(matchBookmarks(groups, 'git').map((x) => x.title)).toEqual(['Gitea', 'GitHub', 'Docs', 'My GitHub stars']);
    expect(matchBookmarks(groups, '  ')).toEqual([]);
    expect(matchBookmarks(undefined, 'git')).toEqual([]);
  });
});
