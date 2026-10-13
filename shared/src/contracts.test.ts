import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CONFIG_SCHEMAS,
  ApiErrorBodySchema,
  CaldavAccountCreateSchema,
  ERROR_CODES,
  ERROR_STATUS,
  EventInputSchema,
  EventUpdateSchema,
  EventsQuerySchema,
  ExportSchema,
  PORTLY_API_VERSION,
  HealthResponseSchema,
  buildPairingRequestUrl,
  buildPairingReturnUrl,
  parsePairingRequest,
  parsePairingReturn,
  GeneralSettingsSchema,
  HexColor,
  IcsCreateSchema,
  LayoutSchema,
  OAuthStartSchema,
  SEARCH_ENGINE_PRESETS,
  SUGGEST_PROVIDERS,
  SafeHttpUrl,
  SearchSettingsSchema,
  SettingsSchema,
  ThemeSchema,
  WMO_CODES,
  WEATHER_ICON_NAMES,
  WidgetInstanceSchema,
  buildSearchUrl,
  defaultSettings,
  isSafeHttpUrl,
  normalizeHexColor,
  settingsNamespaceSchema,
  toSafeHttpUrl,
  weatherCodeInfo,
  type ExportFileInput,
} from './index.ts';

describe('SettingsSchema defaults', () => {
  it('parse({}) yields complete defaults for every namespace', () => {
    const s = SettingsSchema.parse({});
    expect(s.general).toEqual({
      locale: 'system',
      timeFormat: 'system',
      weekStartsOn: 1,
      temperatureUnit: 'C',
      windUnit: 'kmh',
      precipUnit: 'mm',
      openLinksInNewTab: false,
    });
    expect(s.appearance.mode).toBe('system');
    expect(s.appearance.background.type).toBe('gradient');
    expect(s.search.engines.length).toBeGreaterThan(0);
    expect(s.search.engines.some((e) => e.id === s.search.defaultEngineId)).toBe(true);
    expect(s.search.suggestionsEnabled).toBe(true);
    expect(s.bookmarks).toEqual({ defaultGroupId: null, ungroupedGroupId: null, autoFetchIcons: true });
    expect(s.weather).toEqual({ defaultLocation: null });
    expect(s.calendar).toEqual({ syncIntervalMin: 5, defaultCalendarId: null });
    expect(s.todoist).toEqual({ defaultFilter: 'today | overdue' });
    expect(s.activeProfileId).toBeNull();
  });

  it('fills defaults inside a partially specified namespace', () => {
    const s = SettingsSchema.parse({ general: { userName: 'Dana' }, appearance: { mode: 'dark' } });
    expect(s.general.userName).toBe('Dana');
    expect(s.general.timeFormat).toBe('system');
    expect(s.appearance.mode).toBe('dark');
    expect(s.appearance.accent).toBe('#137a85');
  });

  it('returns fresh objects (defaults are never shared)', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.search.engines.pop();
    a.appearance.background = { type: 'color', color: '#000000' };
    expect(b.search.engines.length).toBe(defaultSettings().search.engines.length);
    expect(defaultSettings().appearance.background.type).toBe('gradient');
  });

  it('exposes per-namespace schemas', () => {
    expect(settingsNamespaceSchema('calendar').parse({})).toEqual({ syncIntervalMin: 5, defaultCalendarId: null });
    expect(settingsNamespaceSchema('activeProfileId').parse(undefined)).toBeNull();
  });
});

describe('strict unknown-key rejection', () => {
  it.each([
    ['top level', { bogus: 1 }],
    ['general', { general: { bogus: 1 } }],
    ['appearance', { appearance: { bogus: 1 } }],
    ['appearance.background', { appearance: { background: { type: 'color', color: '#112233', extra: 1 } } }],
    ['gradient stop', { appearance: { background: { type: 'gradient', angle: 0, stops: [{ color: '#000000', at: 0, x: 1 }, { color: '#ffffff', at: 100 }] } } }],
    ['search', { search: { bogus: true } }],
    ['search engine', { search: { engines: [{ id: 'x', name: 'X', urlTemplate: 'https://x.test/?q=%s', evil: 1 }], defaultEngineId: 'x' } }],
    ['bookmarks', { bookmarks: { bogus: 1 } }],
    ['weather', { weather: { bogus: 1 } }],
    ['weather.defaultLocation', { weather: { defaultLocation: { name: 'X', lat: 1, lon: 2, bogus: 1 } } }],
    ['calendar', { calendar: { bogus: 1 } }],
    ['todoist', { todoist: { bogus: 1 } }],
  ])('rejects an unknown key at %s', (_where, input) => {
    expect(SettingsSchema.safeParse(input).success).toBe(false);
  });

  it('rejects prototype keys as unknown keys', () => {
    const payload = JSON.parse('{"general":{"__proto__":{"polluted":true}}}') as unknown;
    expect(SettingsSchema.safeParse(payload).success).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('general settings bounds', () => {
  it('rejects out-of-range values', () => {
    expect(GeneralSettingsSchema.safeParse({ weekStartsOn: 3 }).success).toBe(false);
    expect(GeneralSettingsSchema.safeParse({ locale: 'en_US; drop' }).success).toBe(false);
    expect(GeneralSettingsSchema.safeParse({ userName: 'x'.repeat(65) }).success).toBe(false);
    expect(GeneralSettingsSchema.safeParse({ locale: 'zh-Hant-TW' }).success).toBe(true);
  });
});

describe('SafeHttpUrl', () => {
  it.each([
    'https://example.com',
    'http://localhost:8080/path?q=1#frag',
    'https://sub.example.co.uk/a%20b',
    '  https://trimmed.example/  ',
  ])('accepts %s', (url) => {
    expect(SafeHttpUrl.safeParse(url).success).toBe(true);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript: with embedded newline', 'java\nscript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///C:/Windows/win.ini'],
    ['ftp:', 'ftp://example.com/'],
    ['credentials', 'https://user:pass@example.com/'],
    ['username only', 'https://user@example.com/'],
    ['relative', '/api/settings'],
    ['protocol-relative', '//evil.example/'],
    ['control char', 'https://example.com/\u0000'],
    ['tab', 'https://exa\tmple.com/'],
    ['too long', `https://example.com/${'a'.repeat(2048)}`],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(SafeHttpUrl.safeParse(url).success).toBe(false);
    expect(isSafeHttpUrl(url)).toBe(false);
  });

  it('toSafeHttpUrl returns null for unsafe input and the trimmed URL otherwise', () => {
    expect(toSafeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(toSafeHttpUrl(42)).toBeNull();
    expect(toSafeHttpUrl(' https://a.example ')).toBe('https://a.example');
  });
});

describe('HexColor', () => {
  it('accepts #rrggbb and #rrggbbaa only', () => {
    expect(HexColor.safeParse('#a1B2c3').success).toBe(true);
    expect(HexColor.safeParse('#a1b2c3d4').success).toBe(true);
    for (const bad of ['#abc', 'red', 'rgb(0,0,0)', '#12345', '#1234567', '#gggggg', ' #123456', '#123456 ']) {
      expect(HexColor.safeParse(bad).success).toBe(false);
    }
  });

  it('normalizeHexColor lower-cases valid colors and nulls the rest', () => {
    expect(normalizeHexColor('#AABBCC')).toBe('#aabbcc');
    expect(normalizeHexColor('blue')).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
  });
});

describe('Theme safety', () => {
  const injections = [
    'red; background: url(https://evil.example/x.png)',
    '#123456; } body { display:none',
    '#123456)',
    'expression(alert(1))',
    'var(--x)',
    '#123456\n',
    'url(javascript:alert(1))',
  ];

  it.each(injections)('rejects accent %j', (value) => {
    expect(ThemeSchema.safeParse({ accent: value }).success).toBe(false);
  });

  it.each(injections)('rejects background color %j', (value) => {
    expect(ThemeSchema.safeParse({ background: { type: 'color', color: value } }).success).toBe(false);
  });

  it('rejects non-enum fonts and CSS in font values', () => {
    expect(ThemeSchema.safeParse({ font: 'Comic Sans' }).success).toBe(false);
    expect(ThemeSchema.safeParse({ font: "system; } * { color: red" }).success).toBe(false);
  });

  it('rejects image backgrounds that are not upload UUIDs', () => {
    for (const uploadId of ['../etc/passwd', 'https://evil.example/a.png', 'x) url(javascript:1)', '']) {
      expect(ThemeSchema.safeParse({ background: { type: 'image', uploadId } }).success).toBe(false);
    }
    const ok = ThemeSchema.parse({ background: { type: 'image', uploadId: '3f1c2b6e-8a0d-4c55-9b1e-2f7a9d1c0e42' } });
    expect(ok.background).toEqual({ type: 'image', uploadId: '3f1c2b6e-8a0d-4c55-9b1e-2f7a9d1c0e42', blur: 0, dim: 0.2 });
  });

  it('bounds numbers and gradient stops', () => {
    expect(ThemeSchema.safeParse({ radius: 25 }).success).toBe(false);
    expect(ThemeSchema.safeParse({ radius: Number.NaN }).success).toBe(false);
    expect(ThemeSchema.safeParse({ widgetOpacity: 0.2 }).success).toBe(false);
    expect(ThemeSchema.safeParse({ widgetOpacity: Number.POSITIVE_INFINITY }).success).toBe(false);
    const stop = { color: '#000000', at: 0 };
    expect(ThemeSchema.safeParse({ background: { type: 'gradient', angle: 0, stops: [stop] } }).success).toBe(false);
    expect(
      ThemeSchema.safeParse({ background: { type: 'gradient', angle: 0, stops: Array.from({ length: 6 }, () => stop) } })
        .success,
    ).toBe(false);
    expect(ThemeSchema.safeParse({ background: { type: 'gradient', angle: 361, stops: [stop, stop] } }).success).toBe(
      false,
    );
    expect(ThemeSchema.safeParse({ background: { type: 'image', uploadId: '3f1c2b6e-8a0d-4c55-9b1e-2f7a9d1c0e42', dim: 0.95 } }).success).toBe(false);
  });

  it('rejects unknown background types', () => {
    expect(ThemeSchema.safeParse({ background: { type: 'css', value: 'red' } }).success).toBe(false);
  });
});

describe('search settings', () => {
  it('every preset has a valid template, keyword and suggest provider', () => {
    expect(SEARCH_ENGINE_PRESETS.map((p) => p.name)).toEqual([
      'Google',
      'DuckDuckGo',
      'Bing',
      'YouTube',
      'Wikipedia',
      'Google Maps',
      'GitHub',
      'Amazon',
      'Reddit',
      'Perplexity',
      'ChatGPT',
      'Claude',
    ]);
    const keywords = new Set<string>();
    for (const p of SEARCH_ENGINE_PRESETS) {
      expect(isSafeHttpUrl(p.urlTemplate)).toBe(true);
      expect(p.urlTemplate).toContain('%s');
      expect(SUGGEST_PROVIDERS).toContain(p.suggest);
      expect(p.keyword.length).toBeGreaterThan(0);
      keywords.add(p.keyword);
    }
    expect(keywords.size).toBe(SEARCH_ENGINE_PRESETS.length);
    expect(SEARCH_ENGINE_PRESETS.find((p) => p.id === 'claude')?.urlTemplate).toBe('https://claude.ai/new?q=%s');
  });

  it('requires %s in templates and a SafeHttpUrl', () => {
    const base = { defaultEngineId: 'x' };
    expect(
      SearchSettingsSchema.safeParse({ ...base, engines: [{ id: 'x', name: 'X', urlTemplate: 'https://x.test/' }] }).success,
    ).toBe(false);
    expect(
      SearchSettingsSchema.safeParse({ ...base, engines: [{ id: 'x', name: 'X', urlTemplate: 'javascript:%s' }] }).success,
    ).toBe(false);
  });

  it('requires the default engine to exist and ids/keywords to be unique', () => {
    const engine = (id: string, keyword: string | null) => ({ id, name: id, urlTemplate: 'https://x.test/?q=%s', keyword });
    expect(SearchSettingsSchema.safeParse({ engines: [engine('a', 'a')], defaultEngineId: 'b' }).success).toBe(false);
    expect(SearchSettingsSchema.safeParse({ engines: [engine('a', 'k'), engine('a', 'j')], defaultEngineId: 'a' }).success).toBe(false);
    expect(SearchSettingsSchema.safeParse({ engines: [engine('a', 'k'), engine('b', 'K')], defaultEngineId: 'a' }).success).toBe(false);
    expect(SearchSettingsSchema.safeParse({ engines: [engine('a', null), engine('b', null)], defaultEngineId: 'b' }).success).toBe(true);
    expect(SearchSettingsSchema.safeParse({ engines: [engine('a', 'has space')], defaultEngineId: 'a' }).success).toBe(false);
  });

  it('buildSearchUrl URI-component-encodes the query', () => {
    expect(buildSearchUrl('https://x.test/?q=%s&again=%s', 'a b&c/d')).toBe('https://x.test/?q=a%20b%26c%2Fd&again=a%20b%26c%2Fd');
  });
});

describe('weather code map', () => {
  it('covers the documented WMO codes with known lucide icons', () => {
    for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
      const info = WMO_CODES[code];
      expect(info, `code ${code}`).toBeDefined();
      expect(WEATHER_ICON_NAMES).toContain(info?.icon);
    }
  });

  it('uses night icons at night and falls back for unknown codes', () => {
    expect(weatherCodeInfo(0, true).icon).toBe('Sun');
    expect(weatherCodeInfo(0, false).icon).toBe('Moon');
    expect(weatherCodeInfo(3, false).icon).toBe('Cloud');
    expect(weatherCodeInfo(1234)).toEqual({ label: 'Unknown', icon: 'Cloud' });
  });
});

describe('layouts', () => {
  const item = { id: 'w1', type: 'clock', x: 0, y: 0, w: 4, h: 3, config: {} };

  it('fills frame defaults and keeps unknown widget types parseable', () => {
    const parsed = WidgetInstanceSchema.parse({ ...item, type: 'future-widget' });
    expect(parsed.frame).toEqual({ showHeader: true, transparent: false });
  });

  it('rejects widgets that overflow the 12-column grid', () => {
    expect(WidgetInstanceSchema.safeParse({ ...item, x: 10, w: 4 }).success).toBe(false);
    expect(WidgetInstanceSchema.safeParse({ ...item, w: 0 }).success).toBe(false);
    expect(WidgetInstanceSchema.safeParse({ ...item, x: 1.5 }).success).toBe(false);
  });

  it('rejects duplicate widget ids and too many widgets', () => {
    expect(LayoutSchema.safeParse({ version: 1, items: [item, item] }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ ...item, id: `w${i}` }));
    expect(LayoutSchema.safeParse({ version: 1, items: many }).success).toBe(false);
    expect(LayoutSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
  });
});

describe('calendar payloads', () => {
  const base = { calendarId: 'cal1', title: 'Lunch', timezone: 'Europe/Berlin' };

  it('accepts timed events with offsets and all-day events with dates', () => {
    expect(
      EventInputSchema.safeParse({ ...base, allDay: false, start: '2026-09-25T12:00:00+02:00', end: '2026-09-25T13:00:00+02:00' })
        .success,
    ).toBe(true);
    expect(EventInputSchema.safeParse({ ...base, allDay: true, start: '2026-09-25', end: '2026-09-26' }).success).toBe(true);
  });

  it('rejects mismatched formats, inverted ranges and unknown zones', () => {
    expect(EventInputSchema.safeParse({ ...base, allDay: true, start: '2026-09-25T12:00:00Z', end: '2026-09-26' }).success).toBe(false);
    expect(EventInputSchema.safeParse({ ...base, allDay: false, start: '2026-09-25', end: '2026-09-26' }).success).toBe(false);
    expect(EventInputSchema.safeParse({ ...base, allDay: true, start: '2026-09-25', end: '2026-09-25' }).success).toBe(false);
    expect(
      EventInputSchema.safeParse({ ...base, timezone: 'Mars/Olympus', allDay: true, start: '2026-09-25', end: '2026-09-26' }).success,
    ).toBe(false);
  });

  it('requires allDay/start/end together on update', () => {
    expect(EventUpdateSchema.safeParse({ title: 'x' }).success).toBe(true);
    expect(EventUpdateSchema.safeParse({ start: '2026-09-25' }).success).toBe(false);
  });

  it('validates event queries', () => {
    expect(EventsQuerySchema.safeParse({ from: '2026-09-01', to: '2026-10-01', tz: 'America/New_York' }).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ from: '2026-10-01', to: '2026-09-01', tz: 'UTC' }).success).toBe(false);
  });

  it('rewrites webcal:// ICS URLs to https:// and rejects credentials', () => {
    expect(IcsCreateSchema.parse({ url: 'webcal://calendar.example/feed.ics', name: 'Holidays' }).url).toBe(
      'https://calendar.example/feed.ics',
    );
    expect(IcsCreateSchema.safeParse({ url: 'webcal://u:p@calendar.example/feed.ics', name: 'x' }).success).toBe(false);
    expect(IcsCreateSchema.safeParse({ url: 'file:///etc/passwd', name: 'x' }).success).toBe(false);
  });
});

describe('accounts & oauth payloads', () => {
  it('validates returnTo against the hash-route pattern', () => {
    expect(OAuthStartSchema.safeParse({ returnTo: '#/settings/accounts' }).success).toBe(true);
    expect(OAuthStartSchema.safeParse({ returnTo: 'https://evil.example/' }).success).toBe(false);
    expect(OAuthStartSchema.safeParse({ returnTo: '#/settings/../x?y' }).success).toBe(false);
  });

  it('requires a SafeHttpUrl CalDAV server', () => {
    const base = { label: 'Cal', username: 'u', password: 'p' };
    expect(CaldavAccountCreateSchema.safeParse({ ...base, serverUrl: 'https://dav.example/' }).success).toBe(true);
    expect(CaldavAccountCreateSchema.safeParse({ ...base, serverUrl: 'https://u:p@dav.example/' }).success).toBe(false);
  });

  it('keeps probe-discovered config fields (loose config objects)', () => {
    const cfg = ACCOUNT_CONFIG_SCHEMAS.imap.parse({
      username: 'me',
      imap: { host: 'imap.example.com', port: 993, security: 'tls', specialUse: { archive: 'Archive' } },
    });
    expect(cfg.imap.webmailUrl).toBeNull();
    expect((cfg.imap as Record<string, unknown>).specialUse).toEqual({ archive: 'Archive' });
  });
});

describe('errors', () => {
  it('maps every code to the §7a status', () => {
    expect(ERROR_CODES.map((c) => ERROR_STATUS[c])).toEqual([400, 422, 403, 404, 409, 409, 409, 502, 429, 504, 413, 503, 500, 401, 403]);
  });

  it('parses API error bodies', () => {
    expect(ApiErrorBodySchema.safeParse({ error: { code: 'not_found', message: 'x' } }).success).toBe(true);
    expect(ApiErrorBodySchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false);
  });
});

describe('ExportSchema', () => {
  const upload = '3f1c2b6e-8a0d-4c55-9b1e-2f7a9d1c0e42';
  const file = (): ExportFileInput => ({
    format: 'portly-export',
    version: 1,
    exportedAt: '2026-09-25T10:00:00.000Z',
    data: {
      settings: {},
      profiles: [{ id: 'p1', name: 'Home', sort: 0, layout: { version: 1, items: [] } }],
      bookmarkGroups: [{ id: 'g1', name: 'Dev', sort: 0, color: null, collapsed: false }],
      bookmarks: [
        { id: 'b1', groupId: 'g1', title: 'Docs', url: 'https://example.com', sort: 0, iconMode: 'auto', iconId: null, letterColor: null },
      ],
      uploads: [{ id: upload, contentType: 'image/png', data: 'iVBORw0KGgo=' }],
      customIcons: [],
    },
  });

  it('accepts a well-formed file and applies settings defaults', () => {
    const parsed = ExportSchema.parse(file());
    expect(parsed.data.settings.general.timeFormat).toBe('system');
  });

  it('rejects unsafe bookmark URLs, unknown keys, bad versions and bad base64', () => {
    const bad1 = file();
    bad1.data.bookmarks[0]!.url = 'javascript:alert(1)';
    expect(ExportSchema.safeParse(bad1).success).toBe(false);

    const bad2 = file() as Record<string, unknown>;
    bad2.accounts = [];
    expect(ExportSchema.safeParse(bad2).success).toBe(false);

    expect(ExportSchema.safeParse({ ...file(), version: 2 }).success).toBe(false);

    const bad3 = file();
    bad3.data.uploads[0]!.data = 'not base64!';
    expect(ExportSchema.safeParse(bad3).success).toBe(false);

    const bad4 = file();
    bad4.data.uploads[0]!.contentType = 'text/html' as never;
    expect(ExportSchema.safeParse(bad4).success).toBe(false);
  });
});

describe('pairing', () => {
  const token = 'A'.repeat(43);
  const nonce = 'b_-'.repeat(14) + 'c';

  it('round-trips the pairing return fragment', () => {
    const url = buildPairingReturnUrl('https://example.github.io/', { token, nonce, instanceId: 'inst_1' });
    expect(url.startsWith('https://example.github.io/#/paired?')).toBe(true);
    expect(parsePairingReturn(new URL(url).hash)).toEqual({ token, nonce, instanceId: 'inst_1' });
  });

  it('rejects other routes and malformed values', () => {
    expect(parsePairingReturn('#/')).toBeNull();
    expect(parsePairingReturn(`#/paired?token=short&nonce=${nonce}&instance=x`)).toBeNull();
    expect(parsePairingReturn(`#/paired?token=${token}&nonce=${nonce}`)).toBeNull();
    expect(parsePairingReturn(`#/pairedx?token=${token}&nonce=${nonce}&instance=x`)).toBeNull();
  });

  it('round-trips the pairing request fragment', () => {
    const url = buildPairingRequestUrl('http://localhost:5757/', nonce);
    expect(url).toBe(`http://localhost:5757/#/pair?nonce=${nonce}`);
    expect(parsePairingRequest(new URL(url).hash)).toBe(nonce);
    expect(parsePairingRequest('#/pair?nonce=bad')).toBeNull();
    expect(parsePairingRequest('#/settings')).toBeNull();
  });

  it('accepts the identity fields on health and keeps them optional', () => {
    expect(HealthResponseSchema.safeParse({ ok: true, version: '1', vault: 'ready' }).success).toBe(true);
    expect(
      HealthResponseSchema.safeParse({ ok: true, version: '1', vault: 'ready', app: 'portly', apiVersion: PORTLY_API_VERSION, instanceId: 'x', appUrl: 'http://localhost:5757/' }).success,
    ).toBe(true);
    expect(HealthResponseSchema.safeParse({ ok: true, version: '1', vault: 'ready', app: 'other' }).success).toBe(false);
  });

  it('accepts the Pages site on health as an address or null', () => {
    const base = { ok: true, version: '1', vault: 'ready' };
    expect(HealthResponseSchema.safeParse({ ...base, pagesUrl: 'https://me.github.io/' }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ ...base, pagesUrl: null }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ ...base, pagesUrl: '' }).success).toBe(false);
  });
});
