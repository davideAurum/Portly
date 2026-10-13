import { describe, expect, it } from 'vitest';
import {
  ClientEventSchema,
  ClientEventsRequestSchema,
  DIAGNOSTIC_AREAS,
  DiagnosticsSummarySchema,
  HEALTH_CODES,
  LOG_LEVEL_ORDER,
  LogRecordSchema,
  LogsQuerySchema,
  REASON_TOKEN,
  REDACTED,
  REQUEST_ID_REGEX,
  SCRUB_PATTERNS,
  SetLogLevelSchema,
  maskUserPaths,
  redactForSharing,
  scrub,
  scrubFields,
} from './index.ts';

describe('scrub: secret patterns', () => {
  it('has exactly the seven rules', () => {
    expect(SCRUB_PATTERNS).toHaveLength(7);
  });

  // Every redact case of the regex prototype (scratchpad/prototype-scrub.mjs) and of the old logger tests.
  it.each([
    ['Authorization: Bearer ya29.a0AfH6SMB-secret_token', 'ya29'],
    ['bearer abc123', 'abc123'],
    ['Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['refresh_token=1//0gAbCdEf&x=1', '1//0gAbCdEf'],
    ['{"access_token":"ya29.xyz","expires_in":3599}', 'ya29.xyz'],
    ['{"id_token": "eyJhbGciOi.payload.sig"}', 'eyJhbGciOi'],
    ['GET /api/oauth/google/callback?code=4/0AX4XfWh&state=abc', '4/0AX4XfWh'],
    ['password: hunter2', 'hunter2'],
    ['"appPassword":"abcd efgh"', 'efgh'],
    ['client_secret=GOCSPX-123', 'GOCSPX-123'],
    ['PassphraseKey=zzz', 'zzz'],
    ['CacheKey: qqq', 'qqq'],
    ['Cookie: SID=abc; HSID=def', 'def'],
    ["{ accessToken: 'tok123' }", 'tok123'],
    ['nextPageToken=CgkI', 'CgkI'],
    ['code_verifier=VER123', 'VER123'],
    ['returnTo=%2F%3Faccess_token%3DSECRETX', 'SECRETX'],
    ['https://user:pw@host/x', 'pw'],
    ['#/paired?token=TTT&nonce=NNN', 'TTT'],
    ['#/paired?token=TTT&nonce=NNN', 'NNN'],
    ['X-Portly-Token: abcdef', 'abcdef'],
    ['{"token":"abc"}', 'abc'],
    ['$deltatoken=DLT', 'DLT'],
    ['err ya29.SOMETOKEN here', 'SOMETOKEN'],
  ])('redacts %s (hides %s)', (input, secret) => {
    const out = scrub(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it.each([
    'token refresh',
    'tokenType: bearer',
    'connect ECONNREFUSED 127.0.0.1:993',
    '{"code":"ETIMEDOUT"}',
    'pairing token: missing',
    'secret: the ICS address is not set',
    'reason token_missing',
    'errCode=E1',
    '{"code":"token_rejected"}',
  ])('keeps %s unchanged', (input) => {
    expect(scrub(input)).toBe(input);
  });

  it('is idempotent', () => {
    const once = scrub('password=a access_token=b Cookie: x=1; y=2');
    expect(scrub(once)).toBe(once);
    const old = scrub('password=a access_token=b');
    expect(scrub(old)).toBe(old);
  });

  it('keeps quotes balanced around a redacted quoted value', () => {
    expect(scrub('{"password":"se\\"cret","n":1}')).toBe('{"password":"[REDACTED]","n":1}');
    expect(scrub("password='x y'")).toBe("password='[REDACTED]'");
  });

  it('redacts a JWT and Google refresh tokens by shape', () => {
    expect(scrub('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh')).toBe(`jwt ${REDACTED}`);
    expect(scrub('rt 1//0gAbCdEfGhIjKlMnOpQrStUv')).toBe(`rt ${REDACTED}`);
  });

  it('redacts URL credentials after any run of scheme characters', () => {
    expect(scrub('git+https://u:p@h.example/x')).toBe(`git+https://${REDACTED}@h.example/x`);
    expect(scrub('x_https://u:p@h.example')).toBe(`x_https://${REDACTED}@h.example`);
    expect(scrub('...https://u:p@h.example')).toBe(`...https://${REDACTED}@h.example`);
    expect(scrub(`https://${REDACTED}@h.example`)).toBe(`https://${REDACTED}@h.example`);
  });

  it.each([
    ['a-', 'a-'.repeat(8192)],
    ['a.', 'a.'.repeat(8192)],
    ['a1.', 'a1.'.repeat(5461)],
    ['ya29.', 'ya29.'.repeat(3276)],
    ['x@ab.', `x@${'ab.'.repeat(5461)}`],
    ["/Users/a'", `/Users/${"a'".repeat(8192)}:`],
    ['/Users/%41', `/Users/${'%41'.repeat(5461)}:`],
  ])('scrubs a 16 KB %j run in linear time', (_name, text) => {
    const t0 = performance.now();
    scrub(text);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('scrub: paths, JSON.parse snippets, webcal URLs', () => {
  it('masks user paths', () => {
    expect(scrub("ENOENT: no such file or directory, open 'C:\\Users\\riley\\AppData\\x.db'")).toBe(
      "ENOENT: no such file or directory, open 'C:\\Users\\~\\AppData\\x.db'",
    );
  });

  it.each([
    ['Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON', 'Unexpected token \'<\', "…" is not valid JSON'],
    ['Unexpected token \'h\', "hello world" is not valid JSON', 'Unexpected token \'h\', "…" is not valid JSON'],
    ['Unexpected token \'x\', "{"a":x}" is not valid JSON', 'Unexpected token \'x\', "…" is not valid JSON'],
    ['Unexpected token \'a\', "abc\ndef" is not valid JSON', 'Unexpected token \'a\', "…" is not valid JSON'],
    ['Unexpected token \'x\', ..."mail from "...', 'Unexpected token \'x\', "…"'],
    ['"undefined" is not valid JSON', '"…" is not valid JSON'],
    ['bad answer: Unexpected token \'<\', "<html>secret</html>" is not valid JSON', 'bad answer: Unexpected token \'<\', "…" is not valid JSON'],
  ])('removes the quoted input of %j', (input, want) => {
    expect(scrub(input)).toBe(want);
    expect(scrub(want)).toBe(want);
  });

  it('keeps V8 JSON messages without a snippet', () => {
    const msg = 'Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)';
    expect(scrub(msg)).toBe(msg);
  });

  it('reduces webcal URLs to their host', () => {
    expect(scrub('fetch webcal://p01-caldav.icloud.com/published/2/SECRETPATH failed')).toBe(
      'fetch webcal://p01-caldav.icloud.com/… failed',
    );
    expect(scrub("'webcals://user:pw@cal.example.org:8443/x.ics?k=v'")).toBe("'webcals://cal.example.org:8443/…'");
    expect(scrub(scrub('webcal://h.example/a/b'))).toBe('webcal://h.example/…');
  });

  it('is idempotent over a mixed line', () => {
    const once = scrub(
      'token="abc" is not valid JSON; open C:\\Users\\riley\\x; webcal://h.example/secret; Authorization: Bearer abc; https://u:p@x.example/',
    );
    expect(scrub(once)).toBe(once);
    expect(once).not.toContain('riley');
    expect(once).not.toContain('secret');
  });
});

describe('maskUserPaths', () => {
  // All cases of the regex prototype (scratchpad/prototype-paths.mjs).
  it.each([
    ['C:\\Users\\riley\\AppData\\Local\\Portly', 'C:\\Users\\~\\AppData\\Local\\Portly'],
    ['C:\\\\Users\\\\riley\\\\AppData', 'C:\\\\Users\\\\~\\\\AppData'],
    ['c:/users/riley/x', 'c:/users/~/x'],
    ['/c/Users/riley/x', '/c/Users/~/x'],
    ['\\\\?\\C:\\Users\\riley\\x', '\\\\?\\C:\\Users\\~\\x'],
    ['C:\\Users\\RILEY~1\\AppData\\Local\\Temp', 'C:\\Users\\~\\AppData\\Local\\Temp'],
    ['C:\\Users\\Riley Hollis\\OneDrive - Personal', 'C:\\Users\\~\\OneDrive - Personal'],
    ['file:///C:/Users/riley/x', 'file:///C:/Users/~/x'],
    ['file:///C:/Users/Riley%20Hollis/x', 'file:///C:/Users/~/x'],
    ['C%3A%5CUsers%5Criley%5Cx', 'C%3A%5CUsers%5C~%5Cx'],
    ['C:\\Users\\Public\\x', 'C:\\Users\\Public\\x'],
    ['/home/riley/.config', '/home/~/.config'],
    ['/Users/riley/Library', '/Users/~/Library'],
    ["open 'C:\\Users\\riley'", "open 'C:\\Users\\~'"],
    ['dataDir C:\\Users\\riley', 'dataDir C:\\Users\\~'],
    ['\\\\fileserver\\Users\\riley\\docs', '\\\\fileserver\\Users\\~\\docs'],
    ['C:\\Users\\riley.CONTOSO\\x', 'C:\\Users\\~\\x'],
    ['/api/users/abc', '/api/users/abc'],
    ['GET /api/users/abc', 'GET /api/users/abc'],
    // Names with an apostrophe or a percent-escape (file URLs encode non-ASCII), and quotes that close the path.
    ["ENOENT: open 'C:\\Users\\O'Brien\\AppData\\x'", "ENOENT: open 'C:\\Users\\~\\AppData\\x'"],
    ["C:\\Users\\D'Angelo", 'C:\\Users\\~'],
    ["/home/o'brien/.config", '/home/~/.config'],
    ["file:///C:/Users/O'Brien/x", 'file:///C:/Users/~/x'],
    ['file:///C:/Users/O%27Brien/x', 'file:///C:/Users/~/x'],
    ['file:///C:/Users/Jos%C3%A9/x', 'file:///C:/Users/~/x'],
    ['file:///C:/Users/%C3%89mile%20Zola/x', 'file:///C:/Users/~/x'],
    ["C%3A%5CUsers%5CO'Brien%5Cx", 'C%3A%5CUsers%5C~%5Cx'],
    ["open 'C:\\Users\\riley' failed", "open 'C:\\Users\\~' failed"],
    ["open 'C:\\Users\\riley', 'C:\\Users\\bob'.", "open 'C:\\Users\\~', 'C:\\Users\\~'."],
  ])('%j → %j (idempotent)', (input, want) => {
    const got = maskUserPaths(input);
    expect(got).toBe(want);
    expect(maskUserPaths(got)).toBe(got);
  });
});

describe('scrubFields', () => {
  it('redacts secret keys whatever the value type', () => {
    expect(
      scrubFields({
        password: 'x',
        access_token: { nested: 1 },
        refreshToken: 42,
        Authorization: 'Bearer x',
        'set-cookie': ['a=1', 'b=2'],
        nonce: 'n',
        apiKey: 'k',
        nextPageToken: 'p',
        clientSecret: 's',
        code_verifier: 'v',
        tokenType: 'bearer',
      }),
    ).toEqual({
      password: REDACTED,
      access_token: REDACTED,
      refreshToken: REDACTED,
      Authorization: REDACTED,
      'set-cookie': REDACTED,
      nonce: REDACTED,
      apiKey: REDACTED,
      nextPageToken: REDACTED,
      clientSecret: REDACTED,
      code_verifier: REDACTED,
      tokenType: 'bearer',
    });
  });

  it('keeps error codes under `code` but redacts OAuth codes', () => {
    expect(scrubFields({ code: 'ECONNREFUSED' })).toEqual({ code: 'ECONNREFUSED' });
    expect(scrubFields({ code: 'provider_error' })).toEqual({ code: 'provider_error' });
    expect(scrubFields({ code: 'http_5xx' })).toEqual({ code: 'http_5xx' });
    expect(scrubFields({ code: 1 })).toEqual({ code: 1 });
    expect(scrubFields({ code: '4/0AX4XfWh-abc' })).toEqual({ code: REDACTED });
    expect(scrubFields({ code: 'M.C507_BAY.2.U.1234' })).toEqual({ code: REDACTED });
  });

  it('redacts a secret nested inside a string value (escaped JSON never reaches the patterns)', () => {
    const out = scrubFields({ errMessage: 'provider said {"access_token":"abc123"}' }) as Record<string, string>;
    expect(out.errMessage).not.toContain('abc123');
    expect(out.errMessage).toContain(REDACTED);
  });

  it('always yields a line JSON.parse accepts', () => {
    const fields = { errMessage: 'login failed: password: "se\\"cret" rejected', text: 'password="a"b"' };
    const line = JSON.stringify(scrubFields(fields));
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed.errMessage).not.toContain('se\\"cret');
    expect(parsed.errMessage).not.toContain('cret');
    expect(line).not.toMatch(/password[^,]*"a"b/);
  });

  it('reduces URLs to scheme://host/…', () => {
    expect(
      scrubFields({
        url: 'https://user:pw@www.googleapis.com/calendar/v3/calendars/a%40b/events?syncToken=x',
        feedUrl: 'http://example.org/feed.xml',
        icsUrl: 'webcal://p01-caldav.icloud.com/published/2/SECRET',
        location: '/api/oauth/callback?code=abc',
        note: 'wss://push.example.com/socket?ticket=1',
        dir: 'file:///C:/Users/riley/AppData/Local/Portly?x=1',
        plain: 'see https://example.com/a?b for details',
      }),
    ).toEqual({
      url: 'https://www.googleapis.com/…',
      feedUrl: 'http://example.org/…',
      icsUrl: 'webcal://p01-caldav.icloud.com/…',
      location: '/api/oauth/callback',
      note: 'wss://push.example.com/…',
      dir: 'file:///C:/Users/~/AppData/Local/Portly',
      plain: 'see https://example.com/a?b for details',
    });
    expect(scrubFields({ link: 'https://[::1]:5757/x' })).toEqual({ link: 'https://[::1]:5757/…' });
  });

  it('keeps null, undefined and booleans under secret-named keys (they hold no secret)', () => {
    expect(scrubFields({ code: null, token: false, password: true, access_token: undefined, secret: 0, nonce: 'abc' })).toEqual({
      code: null,
      token: false,
      password: true,
      secret: '[REDACTED]',
      nonce: '[REDACTED]',
    });
  });

  it('keeps bare origins as they are (nothing past the host to hide)', () => {
    expect(scrubFields({ pagesOrigin: 'https://pages.example', pagesUrl: 'http://localhost:5173/', url: 'HTTPS://User:pw@Pages.Example/' })).toEqual({
      pagesOrigin: 'https://pages.example',
      pagesUrl: 'http://localhost:5173/',
      url: 'https://pages.example/',
    });
    expect(scrubFields({ url: 'https://pages.example/?token=x' })).toEqual({ url: 'https://pages.example/…' });
    expect(scrubFields({ url: 'https://pages.example#frag' })).toEqual({ url: 'https://pages.example/…' });
  });

  it('scrubs and caps strings, masks paths in keys and values', () => {
    const out = scrubFields({ msg: 'x'.repeat(5000), 'C:\\Users\\riley\\a': 'C:\\Users\\riley\\b' }, { maxString: 100 }) as Record<
      string,
      string
    >;
    expect(out.msg).toHaveLength(100);
    expect(out.msg?.endsWith('…')).toBe(true);
    expect(out['C:\\Users\\~\\a']).toBe('C:\\Users\\~\\b');
    expect((scrubFields('y'.repeat(3000)) as string).length).toBe(2048);
  });

  it('converts Errors, bigint, dates and drops functions and symbols', () => {
    const err = Object.assign(new Error('open C:\\Users\\riley\\x password=hunter2'), { code: 'ENOENT' });
    expect(
      scrubFields({ err, big: 12n, when: new Date(0), fn: () => 1, sym: Symbol('s'), u: undefined, nan: Number.NaN, list: [undefined, 1] }),
    ).toEqual({
      err: { errName: 'Error', errMessage: `open C:\\Users\\~\\x password=${REDACTED}`, errCode: 'ENOENT' },
      big: '12',
      when: '1970-01-01T00:00:00.000Z',
      nan: 'NaN',
      list: [null, 1],
    });
    expect((scrubFields(new Error('m'.repeat(1000))) as { errMessage: string }).errMessage).toHaveLength(300);
  });

  it('handles cycles, depth, long arrays, Maps, Sets, binary and prototype keys', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const shared = { v: 1 };
    expect(scrubFields({ cyclic, x: shared, y: shared })).toEqual({ cyclic: { a: 1, self: '[Circular]' }, x: { v: 1 }, y: { v: 1 } });

    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: 1 } } } } } } } };
    expect(JSON.stringify(scrubFields(deep))).toBe('{"l1":{"l2":{"l3":{"l4":{"l5":{"l6":{"l7":"[…]"}}}}}}}');

    const arr = scrubFields(Array.from({ length: 60 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(51);
    expect(arr[49]).toBe(49);
    expect(arr[50]).toBe('[… 10 more]');

    expect(scrubFields({ m: new Map([['k', 'v']]), s: new Set([1, 2]), b: new Uint8Array(4) })).toEqual({
      m: { k: 'v' },
      s: [1, 2],
      b: '[binary 4 bytes]',
    });

    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"ok":3}') as unknown;
    const out = scrubFields(hostile) as Record<string, unknown>;
    expect(out).toEqual({ ok: 3 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('uses toJSON (URL objects are reduced like strings)', () => {
    expect(scrubFields({ target: new URL('https://example.com/a?token=x') })).toEqual({ target: 'https://example.com/…' });
  });

  it('is idempotent on its own output', () => {
    const once = scrubFields({ a: 'password=x', url: 'https://h.example/p?q', e: new Error('C:\\Users\\riley') });
    expect(scrubFields(once)).toEqual(once);
  });
});

describe('redactForSharing', () => {
  const report = {
    accounts: [{ id: 'a1', label: 'Family Google', email: 'Riley.H@example.com', status: 'ok' }],
    calendars: [{ id: 'c1', name: 'Soccer team' }, { id: 'c2', name: 'Calendar' }],
    summary: { hybrid: { pagesOrigin: 'https://rileyh.github.io' }, server: { dataDir: 'C:\\Users\\~\\AppData\\Local\\Portly' } },
    logs: [
      { msg: 'outbound', fields: { host: 'nas.home.arpa', finalHost: 'cdn.example.net', status: 200 } },
      { msg: 'calendar synced', fields: { calendar: 'soccer TEAM', note: 'mail to riley.h@example.com and bob@corp.example' } },
      { msg: 'request from a site', fields: { origin: 'https://evil.example.org', ips: '192.168.1.20 and 127.0.0.1 and fe80::1' } },
      { msg: 'ics', fields: { text: 'GET https://p01-caldav.icloud.com/… → http://localhost:5757/x and https://rileyh.github.io/portly/' } },
      { msg: 'DESKTOP-9QX on rileyh pages' },
    ],
    [`nas.home.arpa`]: 'key too',
  };

  it('replaces dictionary terms, collected hosts and pattern matches with stable placeholders', () => {
    const out = JSON.stringify(
      redactForSharing(report, {
        labels: ['Family Google'],
        emails: ['riley.h@example.com'],
        names: ['Soccer team', 'Calendar', 'ab', 'riley'],
        hosts: ['DESKTOP-9QX'],
      }),
    );
    for (const leaked of [
      'Family Google',
      'example.com',
      'Soccer',
      'soccer',
      'rileyh',
      'nas.home.arpa',
      'cdn.example.net',
      'corp.example',
      'evil.example.org',
      '192.168.1.20',
      'fe80::1',
      'p01-caldav',
      'DESKTOP-9QX',
    ]) {
      expect(out).not.toContain(leaked);
    }
    // Stable within the report (case-insensitive), kinds by source.
    expect(out).toContain('"label":"label#1"');
    expect(out.match(/email#1/g)?.length).toBe(2);
    expect(out).toContain('"name":"name#1"');
    expect(out).toContain('"calendar":"name#1"');
    // Generic and loopback terms survive.
    expect(out).toContain('"name":"Calendar"');
    expect(out).toContain('calendar synced');
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('http://localhost:5757/x');
    expect(out).toContain('https://host#');
    expect(out).toMatch(/"ips":"ip#\d and 127\.0\.0\.1 and ip#\d"/);
    // Keys are redacted too.
    expect(out).not.toMatch(/"nas\.home\.arpa":/);
  });

  it('keeps words that only contain a name, terms in `keep`, and is a pure function', () => {
    const value = { text: 'network work Worker', host: 'imap.gmail.com', other: 'imap.gmail.com and smtp.example.org' };
    const before = JSON.stringify(value);
    const out = redactForSharing(value, { names: ['Work'], keep: ['imap.gmail.com'] }) as Record<string, string>;
    expect(out.text).toBe('network work Worker');
    expect(out.host).toBe('imap.gmail.com');
    expect(JSON.stringify(value)).toBe(before);
    expect(redactForSharing({ t: 'team alpha meets' }, { names: ['Team Alpha'] })).toEqual({ t: 'name#1 meets' });
  });

  it('numbers hosts found only by pattern consistently', () => {
    const out = redactForSharing(['https://a.example/x', 'https://A.example/y', 'https://b.example/z']) as string[];
    expect(out).toEqual(['https://host#1/x', 'https://host#1/y', 'https://host#2/z']);
    expect(redactForSharing(out)).toEqual(out);
  });

  it('finds emails anywhere, glued ones included', () => {
    expect(redactForSharing('to a.b+c@mail.example.com, x@y.org; a@b.com-z@c.org and @nope.org, name@host')).toBe(
      'to email#1, email#2; email#3email#4 and @nope.org, name@host',
    );
    expect(redactForSharing({ s: 'repeat d@e.org', t: 'repeat d@e.org', u: 'D@E.org' })).toEqual({
      s: 'repeat email#1',
      t: 'repeat email#1',
      u: 'email#1',
    });
  });

  it('redacts the authority after any run of scheme characters', () => {
    expect(redactForSharing('id_https://evil.example/x and 2https://b.example')).toBe('id_https://host#1/x and 2https://host#2');
  });

  it.each([
    ['a-…@', `${'a-'.repeat(8192)}@`],
    ['a…@', `${'a'.repeat(16383)}@`],
    ['aB_…@', `${'aB_'.repeat(5461)}@`],
    ['a-…://', `${'a-'.repeat(8192)}://`],
    ['a.…://', `${'a.'.repeat(8192)}://`],
    ['https://a…', `https://${'a'.repeat(16384)}`],
    ['a:', 'a:'.repeat(8192)],
  ])('redacts a 16 KB %j run in linear time', (_name, text) => {
    const t0 = performance.now();
    redactForSharing(text, { names: ['Soccer team'] });
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('redacts a report-sized value (30 000 ring records) well within a second and a half', () => {
    const records = Array.from({ length: 30_000 }, (_, i) => ({
      t: new Date(1_760_000_000_000 + i * 1000).toISOString(),
      level: 'debug',
      msg: 'outbound',
      area: 'calendar',
      tags: ['calendar', 'fetch'],
      fields: { host: `h${i % 40}.example.com`, status: 200, accountId: `acc-${i % 5}`, note: 'synced Soccer team for riley' },
    }));
    const t0 = performance.now();
    const out = redactForSharing({ records }, { names: ['Soccer team', 'riley'], hosts: ['caldav.example.org'] }) as {
      records: { fields: { host: string; note: string } }[];
    };
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out.records[0]?.fields).toMatchObject({ host: 'host#1', note: 'synced name#1 for name#2' });
    expect(out.records[40]?.fields.host).toBe('host#1');
    expect(out.records[29_999]?.fields.note).toBe('synced name#1 for name#2');
  });
});

describe('diagnostics constants and DTOs', () => {
  it('constants', () => {
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info);
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error);
    expect(REQUEST_ID_REGEX.test('abc123xyz0')).toBe(true);
    expect(REQUEST_ID_REGEX.test('ABC123xyz0')).toBe(false);
    expect(DIAGNOSTIC_AREAS).toContain('client');
    for (const code of HEALTH_CODES) expect(REASON_TOKEN.test(code)).toBe(true);
    expect(REASON_TOKEN.test('has space')).toBe(false);
  });

  it('LogRecordSchema is strict', () => {
    const record = {
      seq: 1,
      t: '2026-10-11T10:00:00.000Z',
      tEvent: null,
      level: 'info',
      msg: 'request',
      src: 'server',
      area: 'calendar',
      tags: ['calendar'],
      rid: 'abc123xyz0',
      fields: { status: 200 },
    };
    expect(LogRecordSchema.parse(record)).toEqual(record);
    expect(LogRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
  });

  it('LogsQuerySchema coerces strings and applies defaults', () => {
    expect(LogsQuerySchema.parse({ after: '12', limit: '50' })).toEqual({ scope: 'memory', after: 12, level: 'debug', limit: 50 });
    expect(LogsQuerySchema.parse({})).toEqual({ scope: 'memory', level: 'debug', limit: 500 });
    expect(LogsQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('SetLogLevelSchema defaults to 60 minutes for every area', () => {
    expect(SetLogLevelSchema.parse({ verbose: true })).toEqual({ verbose: true, minutes: 60, areas: null });
    expect(SetLogLevelSchema.parse({ verbose: true, minutes: null, areas: ['calendar'] })).toEqual({
      verbose: true,
      minutes: null,
      areas: ['calendar'],
    });
    expect(SetLogLevelSchema.safeParse({ verbose: true, areas: [] }).success).toBe(false);
    expect(SetLogLevelSchema.safeParse({ verbose: true, areas: ['nope'] }).success).toBe(false);
  });

  it('ClientEventSchema accepts one-line messages and bounded fields only', () => {
    const event = {
      t: '2026-10-11T10:00:00.000Z',
      level: 'warn',
      cat: 'api',
      msg: 'request failed',
      session: 's1',
      page: { build: 'pages', backend: 'server', version: '1.2.3' },
    };
    expect(ClientEventSchema.parse(event).fields).toEqual({});
    expect(ClientEventSchema.safeParse({ ...event, fields: { status: 502, path: '/api/x', list: [1, 'a', null] } }).success).toBe(true);
    expect(ClientEventSchema.safeParse({ ...event, msg: 'a\nb' }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ ...event, msg: 'a\u202Eb' }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ ...event, fields: { 'bad key': 1 } }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ ...event, fields: { o: { nested: 1 } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, i]));
    expect(ClientEventSchema.safeParse({ ...event, fields: many }).success).toBe(false);
    expect(ClientEventsRequestSchema.safeParse({ sentAt: event.t, events: [] }).success).toBe(false);
  });

  it('DiagnosticsSummarySchema parses a Pages-request summary', () => {
    const summary = {
      generatedAt: '2026-10-11T10:00:00.000Z',
      server: {
        version: '0.1.0',
        boot: 'b1',
        pid: null,
        startedAt: '2026-10-11T09:00:00.000Z',
        uptimeMs: 3_600_000,
        node: 'v24.21.0',
        platform: 'win32',
        memory: null,
        supervised: true,
        restart: { attempt: 1, lastExit: null },
        dataDir: '',
        logDir: '',
      },
      logLevel: { level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info', persisted: false },
      modules: [{ name: 'calendar', ok: true }],
      vault: 'ready',
      hybrid: { pagesOrigin: null, pairings: 0, lastPairedRequestAt: null, foreignOrigins: [], foreignOriginRequests: 0 },
      inFlight: { count: 0, oldestMs: null, routes: [], outbound: [] },
      jobs: [],
      health: [],
      counts: { server: { warn: 0, error: 0 }, client: { warn: 0, error: 0 }, warnKeysLastHour: 0, memoryRecords: 3 },
    };
    expect(DiagnosticsSummarySchema.parse(summary)).toEqual(summary);
  });
});
