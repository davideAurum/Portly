import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpandError } from '../modules/calendar/ical/expand.ts';
import { DavHttpError } from '../modules/calendar/providers/caldav.ts';
import { DavParseError } from '../modules/calendar/providers/dav-xml.ts';
import { ProviderHttpError } from '../modules/calendar/providers/http.ts';
import { ImapOpError } from '../modules/mail/providers/imap-session.ts';
import { SuggestUpstreamError } from '../modules/search/suggest.ts';
import { TodoistRateLimitError } from '../modules/todoist/client.ts';
import { BlockedAddressError, NotPrivateAddressError, SafeFetchError } from '../security/safe-fetch.ts';
import { HttpError } from './errors.ts';
import { getLogContext, withLogContext, type LogContext } from './log-context.ts';
import {
  createLogger,
  createMemoryLogger,
  createSilentLogger,
  createTestLogger,
  errorFields,
  formatLine,
  isLogHub,
  maskHomeDir,
  pathForLog,
  scrub,
  type LogRecordOut,
} from './logger.ts';

describe('scrub', () => {
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
  ])('redacts %s', (input, secret) => {
    const out = scrub(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('keeps ordinary text and error codes', () => {
    expect(scrub('connect ECONNREFUSED 127.0.0.1:993')).toBe('connect ECONNREFUSED 127.0.0.1:993');
    expect(scrub('{"code":"ETIMEDOUT"}')).toBe('{"code":"ETIMEDOUT"}');
  });

  it('is idempotent', () => {
    const once = scrub('password=a access_token=b');
    expect(scrub(once)).toBe(once);
  });
});

describe('log formatting', () => {
  it('strips query strings from paths', () => {
    expect(pathForLog('/api/search/suggest?q=secret')).toBe('/api/search/suggest');
    expect(pathForLog('/a#frag')).toBe('/a');
  });

  it('formats one scrubbed line with fields', () => {
    const line = formatLine('info', 'token refresh', { url: 'https://x/?access_token=abc', n: 1 }, new Date(0));
    expect(line).toBe('1970-01-01T00:00:00.000Z INFO  token refresh {"url":"https://x/?access_token=[REDACTED]","n":1}');
    expect(formatLine('warn', 'a\nb', undefined, new Date(0))).not.toContain('\n');
  });

  it('formatLine scrubs string fields individually (escaped JSON quotes cannot hide a secret)', () => {
    const line = formatLine('info', 'x', { errMessage: 'provider said {"access_token":"abc123"}' }, new Date(0));
    expect(line).not.toContain('abc123');
  });

  it('errorFields keeps name/code and scrubs the message', () => {
    const err = Object.assign(new Error('invalid_grant refresh_token=abc'), { code: 'E_AUTH' });
    expect(errorFields(err)).toEqual({ errName: 'Error', errMessage: 'invalid_grant refresh_token=[REDACTED]', errCode: 'E_AUTH' });
  });
});

describe('file logger', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
    vi.restoreAllMocks();
  });

  const readLines = (file: string): Record<string, unknown>[] =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('writes lines at or above the level and rotates at maxBytes keeping `keep` files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-log-'));
    const file = path.join(dir, 'logs', 'server.log');
    const log = createLogger({ file, level: 'info', console: false, maxBytes: 300, keep: 3 });
    log.debug('hidden');
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    log.child({ module: 'test' }).warn('child line');
    log.close();
    const files = fs.readdirSync(path.join(dir, 'logs')).sort();
    expect(files).toEqual(['server.log', 'server.log.1', 'server.log.2', 'server.log.3']);
    const current = readLines(file);
    expect(current.at(-1)).toMatchObject({ lvl: 'warn', msg: 'child line', area: 'test', module: 'test' });
    expect(fs.statSync(file).size).toBeLessThanOrEqual(300);
    const all = files.flatMap((f) => readLines(path.join(dir, 'logs', f)));
    expect(all.some((l) => l.msg === 'hidden')).toBe(false);
  });

  it('writes valid JSON Lines in the documented shape', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-log-'));
    const file = path.join(dir, 'server.log');
    const log = createLogger({ file, level: 'debug', console: false });
    withLogContext({ rid: 'abc123def4', area: 'calendar', job: 'calendar:sync' }, () => {
      log.child({ component: 'fetch' }).info('outbound', { host: 'www.googleapis.com', status: 200, password: 'pw' });
    });
    log.child({ src: 'client' }).warn('client: x', { tEvent: Date.parse('2026-10-11T10:00:00Z'), cf: { a: 1 } });
    log.error('weird', { errMessage: 'login failed: password: "se\\"cret" rejected' });
    log.close();
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(3);
    const [a, b, c] = raw.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(Object.keys(a ?? {})).toEqual(['t', 'lvl', 'msg', 'area', 'tags', 'rid', 'job', 'component', 'host', 'status', 'password']);
    expect(a).toMatchObject({
      lvl: 'info',
      msg: 'outbound',
      area: 'calendar',
      tags: ['calendar', 'fetch'],
      rid: 'abc123def4',
      password: '[REDACTED]',
    });
    expect(Object.keys(b ?? {}).slice(0, 7)).toEqual(['t', 'lvl', 'msg', 'src', 'area', 'tags', 'tEvent']);
    expect(b).toMatchObject({ src: 'client', area: 'client', tEvent: '2026-10-11T10:00:00.000Z', cf: { a: 1 } });
    expect(String(c?.errMessage)).not.toContain('cret');
  });

  it('writes fields named like Object.prototype members (file and memory agree)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-log-'));
    const file = path.join(dir, 'server.log');
    const log = createLogger({ file, level: 'info', console: false });
    const fields = { toString: 'a', valueOf: 1, hasOwnProperty: true, isPrototypeOf: 2, ok: 3 };
    log.info('x', fields);
    log.close();
    const [line] = readLines(file);
    expect(line).toMatchObject(fields);
    expect(log.query({}).records[0]?.fields).toEqual(fields);
  });

  it('reopens instead of rotating when another process rotated the file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-log-'));
    const file = path.join(dir, 'server.log');
    const log = createLogger({ file, level: 'info', console: false, maxBytes: 400, keep: 3 });
    log.info(`first ${'a'.repeat(150)}`);
    log.info(`second ${'b'.repeat(150)}`);
    // Another process rotates: our descriptor now points at server.log.1.
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, '{"msg":"other process"}\n');
    log.info(`third ${'c'.repeat(150)}`);
    log.close();
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toContain('other process');
    expect(current).toContain('third');
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('second');
  });

  it('a failed rotation stops at the failing rename and is retried only after a back-off', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-log-'));
    const file = path.join(dir, 'server.log');
    let t = 1_000_000;
    const log = createLogger({ file, level: 'info', console: false, maxBytes: 300, keep: 3, now: () => t });
    for (let i = 0; i < 40; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    const rotated = (): string[] => [1, 2, 3].map((n) => fs.readFileSync(`${file}.${n}`, 'utf8'));
    const before = rotated();
    // A reader holds the oldest file open (a log scan): on Windows renaming onto it fails with EPERM.
    const realRename = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === `${file}.3`) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      realRename(from, to);
    });
    for (let i = 0; i < 20; i++) log.info(`pinned ${i} ${'y'.repeat(40)}`);
    // One attempt, not one per line; nothing renamed onto `.2` (still taken) or `.1`.
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rotated()).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).toContain('pinned 19');

    // Still inside the back-off: no attempt.
    t += 4_999;
    log.info('still pinned');
    expect(rename).toHaveBeenCalledTimes(1);

    // The reader let go: the next line after the back-off rotates.
    rename.mockRestore();
    t += 1;
    log.info('after');
    log.close();
    expect(fs.readFileSync(`${file}.3`, 'utf8')).toBe(before[1]);
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('still pinned');
    expect(readLines(file).map((l) => l.msg)).toEqual(['after']);
  });
});

describe('console sink', () => {
  it('writes text lines through the stdout/stderr writers captured at creation', () => {
    const out = vi.fn((_chunk: string | Uint8Array) => true);
    const err = vi.fn((_chunk: string | Uint8Array) => true);
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const log = (() => {
      process.stdout.write = out as unknown as typeof process.stdout.write;
      process.stderr.write = err as unknown as typeof process.stderr.write;
      try {
        return createLogger({ level: 'info' });
      } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
      }
    })();
    withLogContext({ rid: 'r123456789' }, () => log.info('hello', { n: 1 }));
    log.warn('careful');
    log.debug('hidden');
    log.close();
    expect(out).toHaveBeenCalledTimes(1);
    expect(String(out.mock.calls[0]?.[0])).toMatch(/^\S+Z INFO {2}hello \{"rid":"r123456789","n":1\}\n$/);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('WARN  careful');
  });
});

describe('records', () => {
  it('merges context < bindings < call, lifts rid/src/area and renames reserved keys', () => {
    const log = createTestLogger();
    withLogContext({ rid: 'ctxrid0000', area: 'mail', accountId: 'ctx', job: 'mail:poll', quiet: false }, () => {
      log.child({ module: 'accounts', accountId: 'binding', op: 'b' }).info('m', {
        op: 'call',
        t: 1,
        tEvent: 'x',
        level: 'l',
        lvl: 2,
        msg: 'm2',
        seq: 3,
        tags: ['t'],
        ring: true,
        repeatSig: 's',
      });
    });
    const [rec] = log.lines();
    expect(rec).toMatchObject({ rid: 'ctxrid0000', src: 'server', area: 'accounts', tags: ['accounts', 'mail'], tEvent: null });
    expect(rec?.fields).toEqual({
      accountId: 'binding',
      job: 'mail:poll',
      module: 'accounts',
      op: 'call',
      f_t: 1,
      f_tEvent: 'x',
      f_level: 'l',
      f_lvl: 2,
      f_msg: 'm2',
      f_seq: 3,
      f_tags: ['t'],
    });
  });

  it('a call rid beats the context rid and is removed from the fields', () => {
    const log = createTestLogger();
    withLogContext({ rid: 'ctxrid0000' }, () => log.warn('request still running', { rid: 'callrid000', ms: 15000 }));
    expect(log.lines()[0]).toMatchObject({ rid: 'callrid000', fields: { ms: 15000 } });
  });

  it('area precedence: call > binding area > module > context > component > server (normalized)', () => {
    const log = createTestLogger();
    const area = (fn: () => void): string | undefined => {
      fn();
      return log.lines().at(-1)?.area;
    };
    withLogContext({ area: 'calendar' }, () => {
      expect(area(() => log.child({ module: 'oauth' }).info('a', { area: 'Mail' }))).toBe('mail');
      expect(area(() => log.child({ area: 'pairings', module: 'x' }).info('a'))).toBe('pairing');
      expect(area(() => log.child({ module: 'oauth', component: 'fetch' }).info('a'))).toBe('accounts');
      expect(area(() => log.child({ component: 'fetch' }).info('a'))).toBe('calendar');
    });
    expect(area(() => log.child({ component: 'health' }).info('a'))).toBe('health');
    expect(area(() => log.info('a'))).toBe('server');
    expect(area(() => log.info('a', { area: 'icons' }))).toBe('core');
    expect(area(() => log.info('a', { area: 'not an area!' }))).toBe('server');
    expect(log.lines().every((r) => !('area' in r.fields))).toBe(true);
  });

  it('client events: src client, tEvent lifted, client tag', () => {
    const log = createTestLogger();
    const recs = (): LogRecordOut[] => log.query({}).records;
    withLogContext({ area: 'client', rid: undefined }, () =>
      log.child({ module: 'diagnostics' }).warn('client: x', { src: 'client', tEvent: '2026-10-11T10:00:00+02:00', area: 'client' }),
    );
    expect(recs()[0]).toMatchObject({
      src: 'client',
      area: 'client',
      tags: ['client', 'diagnostics'],
      rid: null,
      tEvent: '2026-10-11T08:00:00.000Z',
      fields: { module: 'diagnostics' },
    });
    // Relayed by the diagnostics module inside its request: still area `client`.
    withLogContext({ area: 'diagnostics', rid: 'upload0000' }, () =>
      log.child({ module: 'diagnostics' }).info('client: y', { src: 'client', tEvent: 'not a date', uploadRid: 'upload0000' }),
    );
    expect(recs()[1]).toMatchObject({ area: 'client', tags: ['client', 'diagnostics'], tEvent: null, rid: 'upload0000' });
    // `tEvent` is a client-event key only; elsewhere it is renamed.
    log.info('server', { tEvent: 1 });
    expect(recs()[2]).toMatchObject({ tEvent: null, fields: { f_tEvent: 1 } });
  });

  it('client events reach the file only at warn+ unless verbose covers them', () => {
    for (const bootLevel of ['info', 'debug'] as const) {
      const log = createTestLogger(bootLevel);
      const relay = (level: 'debug' | 'info' | 'warn', msg: string): void =>
        withLogContext({ area: 'client' }, () => log.child({ module: 'diagnostics' })[level](msg, { src: 'client', cf: { status: 504 } }));
      relay('debug', 'client: d');
      relay('info', 'client: slow request');
      relay('warn', 'client: network error');
      log.info('server info');
      expect(log.query({ src: 'client' }).records.map((r) => r.msg)).toEqual(['client: d', 'client: slow request', 'client: network error']);
      expect(log.lines().map((r) => r.msg)).toEqual(['client: network error', 'server info']);

      log.setVerbose({ until: null, areas: ['client'] });
      relay('debug', 'client: d2');
      relay('info', 'client: i2');
      expect(log.lines().map((r) => r.msg).slice(-2)).toEqual(['client: d2', 'client: i2']);
    }
  });

  it('scrubs fields and message, escapes control characters and caps the message', () => {
    // Not this PC's home: the generic user-path rule is under test (a home of C:\Users\riley is masked whole, first).
    vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\someone');
    const log = createTestLogger();
    log.info(`bad\nline\u202Eend password=x ${'y'.repeat(600)}`, {
      url: 'https://user:pw@calendar.example.com/cal/secret?token=1',
      err: Object.assign(new Error('boom C:\\Users\\riley\\x'), { code: 'EBOOM' }),
      authorization: 'Bearer abc',
    });
    const rec = log.lines()[0];
    expect(rec?.msg.startsWith('bad\\u000aline\\u202eend password=[REDACTED] ')).toBe(true);
    expect(rec?.msg).toHaveLength(500);
    expect(rec?.fields).toEqual({
      url: 'https://calendar.example.com/…',
      err: { errName: 'Error', errMessage: 'boom C:\\Users\\~\\x', errCode: 'EBOOM' },
      authorization: '[REDACTED]',
    });
  });

  it('masks the home directory outside C:\\Users', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\dgold');
    const log = createTestLogger();
    log.info('open D:\\Profiles\\dgold\\data', { dir: 'D:/Profiles/dgold/x', json: 'D:\\\\Profiles\\\\dgold\\\\y' });
    expect(log.lines()[0]).toMatchObject({ msg: 'open ~\\data', fields: { dir: '~/x', json: '~\\\\y' } });
  });

  it('masks the home directory before the generic user-path rule (which would mask only part of it)', () => {
    // The generic rule masks the first name after `Users` (`Shared`) and leaves `dgold`; the home rule must run first.
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\Shared\\dgold');
    const log = createTestLogger();
    log.warn('open C:\\Users\\Shared\\dgold\\x failed', {
      dir: 'C:\\Users\\Shared\\dgold\\y',
      list: ['C:/Users/Shared/dgold/z'],
      err: new Error('cannot read C:\\Users\\Shared\\dgold\\w'),
      thrown: { nested: new Error('at C:\\Users\\Shared\\dgold\\v') },
    });
    const rec = log.lines()[0];
    expect(rec?.msg).toBe('open ~\\x failed');
    expect(rec?.fields).toMatchObject({ dir: '~\\y', list: ['~/z'], err: { errMessage: 'cannot read ~\\w' } });
    expect(JSON.stringify(rec)).not.toContain('dgold');
    expect(formatLine('info', 'C:\\Users\\Shared\\dgold\\q', { p: 'C:\\Users\\Shared\\dgold\\r' })).not.toContain('dgold');
  });

  it('escapes controls, separators and bidi characters in every field string (JSON leaves them raw)', () => {
    const ch = (cp: number): string => String.fromCharCode(cp);
    const esc = (cp: number): string => `\\u${cp.toString(16).padStart(4, '0')}`;
    const log = createTestLogger();
    const odd = `a${ch(0x202e)}b${ch(0x85)}c${ch(0x2028)}d${ch(0x2066)}e${ch(0x7)}f`;
    log.warn('provider said no', { errMessage: odd, nested: { [`k${ch(0x202d)}`]: [odd] }, stack: 'at a\nat b\tc' });
    const fields = log.lines()[0]?.fields ?? {};
    const want = `a${esc(0x202e)}b${esc(0x85)}c${esc(0x2028)}d${esc(0x2066)}e${esc(0x7)}f`;
    expect(fields.errMessage).toBe(want);
    expect(fields.nested).toEqual({ [`k${esc(0x202d)}`]: [want] });
    // Newlines and tabs stay (JSON escapes them; stack frames are joined with \n).
    expect(fields.stack).toBe('at a\nat b\tc');
    expect(formatLine('info', `x${ch(0x202e)}y`, { v: odd })).not.toMatch(/[\u0080-\u009f\u2028\u202e\u2066]/);
  });

  it('masks the home directory first in odd values too (class instances, maps, sets, cycles, deep data)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\Shared\\dgold');
    const home = 'C:\\Users\\Shared\\dgold';
    class Box {
      path: string;
      constructor(path: string) {
        this.path = path;
      }
    }
    const cyclic: Record<string, unknown> = { at: `${home}\\c` };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: `${home}\\deep` };
    for (let i = 0; i < 12; i++) deep = { deep };
    const log = createTestLogger();
    log.info('odd values', {
      box: new Box(`${home}\\b`),
      cyclic,
      deep,
      when: new Date(0),
      map: new Map([['k', `${home}\\m`]]),
      set: new Set([`${home}\\s`]),
    });
    const fields = log.lines()[0]?.fields ?? {};
    expect(fields.box).toEqual({ path: '~\\b' });
    expect(fields.cyclic).toEqual({ at: '~\\c', self: '[Circular]' });
    expect(fields.when).toBe('1970-01-01T00:00:00.000Z');
    expect(fields.map).toEqual({ k: '~\\m' });
    expect(fields.set).toEqual(['~\\s']);
    expect(JSON.stringify(fields)).not.toContain('dgold');
  });

  it('maskHomeDir handles every spelling and ignores root-like homes', () => {
    expect(maskHomeDir('a /home/dg/x b', '/home/dg')).toBe('a ~/x b');
    expect(maskHomeDir('C:\\Users\\dg and c:/users/DG/x and C:\\\\Users\\\\dg', 'C:\\Users\\dg')).toBe('~ and ~/x and ~');
    expect(maskHomeDir('C:\\Users\\dgx\\y', 'C:\\Users\\dg')).toBe('C:\\Users\\dgx\\y');
    expect(maskHomeDir('/x/y', '/')).toBe('/x/y');
  });

  it('keeps the record when fields or bindings are hostile (throwing getters, __proto__, cycles)', () => {
    const log = createTestLogger();
    const hostile = (key: string): Record<string, unknown> => {
      const value = { ok: 1 };
      Object.defineProperty(value, key, {
        enumerable: true,
        get() {
          throw new Error('getter');
        },
      });
      return value;
    };
    log.info('x', hostile('boom'));
    expect(log.lines().at(-1)).toMatchObject({ msg: 'x', fields: { ok: 1, boom: '[unreadable]' } });
    // A throwing lifted key falls back to its default.
    log.info('lifted', hostile('src'));
    expect(log.lines().at(-1)).toMatchObject({ msg: 'lifted', src: 'server', fields: { ok: 1 } });
    // Hostile bindings: child() never throws either.
    log.child(hostile('module')).warn('bound');
    expect(log.lines().at(-1)).toMatchObject({ msg: 'bound', area: 'server', fields: { ok: 1, module: '[unreadable]' } });
    // An error-like value whose properties throw.
    const errLike = { name: 'Error' } as Record<string, unknown>;
    Object.defineProperty(errLike, 'message', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    log.info('err', { e: errLike });
    expect(log.lines().at(-1)).toMatchObject({ msg: 'err', fields: { e: '[unreadable]' } });
    // `__proto__` stays data (and is dropped); nothing is polluted, no lifted key is spoofed.
    log.info('proto', JSON.parse('{"__proto__":{"src":"client","polluted":true},"n":1}') as Record<string, unknown>);
    expect(log.lines().at(-1)).toMatchObject({ msg: 'proto', src: 'server', fields: { n: 1 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.info('y', { cyclic, big: 10n });
    expect(log.lines().at(-1)?.fields).toEqual({ cyclic: { self: '[Circular]' }, big: '10' });
  });
});

describe('levels and verbose', () => {
  it('verbose areas match any tag (a fetch line inside a calendar job)', () => {
    const log = createTestLogger('info');
    const fetchLog = log.child({ component: 'fetch' });
    log.setVerbose({ until: null, areas: ['fetch'] });
    withLogContext({ area: 'calendar' }, () => {
      fetchLog.debug('outbound', { host: 'a.example' });
      log.child({ module: 'calendar' }).debug('calendar synced');
    });
    log.child({ module: 'mail' }).debug('mail listed');
    expect(log.lines().map((r) => r.msg)).toEqual(['log level changed', 'outbound']);
    expect(log.levelState()).toEqual({ level: 'debug', verbose: true, until: null, areas: ['fetch'], bootLevel: 'info' });
    log.setVerbose(null);
    fetchLog.debug('quiet again');
    expect(log.lines().at(-1)).toMatchObject({ msg: 'log level changed', fields: { verbose: false, until: null, areas: null } });
  });

  it('a scoped request whose areas are all unknown never becomes global', () => {
    const log = createTestLogger('info');
    log.setVerbose({ until: null, areas: ['Not An Area!'] });
    expect(log.levelState()).toMatchObject({ verbose: true, areas: [] });
    log.child({ module: 'mail' }).debug('mail listed');
    expect(log.lines().map((r) => r.msg)).toEqual(['log level changed']);
    expect(log.lines()[0]?.fields).toMatchObject({ verbose: true, areas: [] });
    log.setVerbose({ until: null, areas: ['Mail', 'oauth'] });
    expect(log.levelState().areas).toEqual(['mail', 'accounts']);
  });

  it('timed verbose ends lazily: state first, one line outside the caller context, no recursion', () => {
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const log = createLogger({ level: 'info', console: false, now: () => clock });
    log.setVerbose({ until: clock + 60_000, areas: null });
    log.debug('during');
    clock += 60_000;
    withLogContext({ rid: 'reqrid0000', area: 'mail' }, () => log.debug('after'));
    const recs = log.query({}).records;
    expect(recs.map((r) => [r.level, r.msg])).toEqual([
      ['info', 'log level changed'],
      ['debug', 'during'],
      ['info', 'verbose logging ended'],
      ['debug', 'after'],
    ]);
    const ended = recs[2];
    expect(ended).toMatchObject({ rid: null, area: 'diagnostics', fields: { reason: 'expired' } });
    expect(log.levelState().verbose).toBe(false);
    log.close();
  });

  it('levelState() also ends an expired period', () => {
    let clock = 1_000_000;
    const log = createLogger({ level: 'warn', console: false, now: () => clock });
    log.setVerbose({ until: clock + 10, areas: ['calendar'] });
    expect(log.levelState()).toMatchObject({ verbose: true, until: clock + 10, areas: ['calendar'], level: 'debug', bootLevel: 'warn' });
    clock += 10;
    expect(log.levelState()).toEqual({ level: 'warn', verbose: false, until: null, areas: null, bootLevel: 'warn' });
    expect(log.query({ q: 'verbose logging ended' }).records).toHaveLength(1);
    log.close();
  });
});

describe('rings and queries', () => {
  it('keeps debug records per area so a chatty area cannot evict a rare one', () => {
    const log = createLogger({ console: false, level: 'warn', flightPerArea: 3, mainSize: 2 });
    for (let i = 0; i < 10; i++) log.child({ module: 'mail' }).debug(`mail ${i}`);
    log.child({ module: 'calendar' }).debug('calendar once');
    for (let i = 0; i < 3; i++) log.info(`info ${i}`);
    const msgs = log.query({}).records.map((r) => r.msg);
    expect(msgs).toEqual(['mail 7', 'mail 8', 'mail 9', 'calendar once', 'info 1', 'info 2']);
    expect(log.size).toBe(6);
    log.close();
  });

  it('client ring holds browser events of any level; ring:false and quiet debug skip the rings', () => {
    const log = createTestLogger('debug');
    const clientLog = log.child({ src: 'client' });
    clientLog.debug('client: d');
    clientLog.error('client: e');
    log.info('not in memory', { ring: false });
    withLogContext({ quiet: true }, () => {
      log.debug('quiet debug');
      log.warn('quiet warn');
    });
    expect(log.query({ src: 'client' }).records.map((r) => r.msg)).toEqual(['client: d', 'client: e']);
    expect(log.query({}).records.map((r) => r.msg)).toEqual(['client: d', 'client: e', 'quiet warn']);
    // The sink (file) still gets them.
    expect(log.lines().map((r) => r.msg)).toContain('not in memory');
    expect(log.lines().find((r) => r.msg === 'quiet debug')?.fields).toEqual({});
  });

  it('filters by seq, time, level, tag, source, rid, fields and text; newest `limit` win', () => {
    let clock = 1_000;
    const log = createLogger({ console: false, now: () => clock });
    withLogContext({ rid: 'aaaaaaaaaa', area: 'calendar', job: 'calendar:sync', run: 'r1' }, () => {
      log.child({ component: 'fetch' }).debug('outbound', { host: 'x.example', status: 503 });
      clock = 2_000;
      log.child({ module: 'calendar' }).warn('calendar failing', { calendarId: 'c1', code: 'http_5xx' });
    });
    clock = 3_000;
    log.error('boom', { accountId: 'a1', n: 7 });
    const msgs = (q: Parameters<typeof log.query>[0]): string[] => log.query(q).records.map((r) => r.msg);
    expect(msgs({ after: 1 })).toEqual(['calendar failing', 'boom']);
    expect(msgs({ since: 2_000, before: 3_000 })).toEqual(['calendar failing']);
    expect(msgs({ level: 'warn' })).toEqual(['calendar failing', 'boom']);
    expect(msgs({ area: 'fetch' })).toEqual(['outbound']);
    expect(msgs({ area: 'calendar' })).toEqual(['outbound', 'calendar failing']);
    expect(msgs({ rid: 'aaaaaaaaaa' })).toEqual(['outbound', 'calendar failing']);
    expect(msgs({ fieldEquals: { job: 'calendar:sync', run: 'r1' } })).toEqual(['outbound', 'calendar failing']);
    expect(msgs({ fieldEquals: { calendarId: 'c1' } })).toEqual(['calendar failing']);
    expect(msgs({ fieldEquals: { n: '7' } })).toEqual(['boom']);
    expect(msgs({ fieldEquals: { rid: 'aaaaaaaaaa' } })).toEqual(['outbound', 'calendar failing']);
    expect(msgs({ q: 'X.EXAMPLE' })).toEqual(['outbound']);
    expect(msgs({ src: 'client' })).toEqual([]);
    const limited = log.query({ limit: 2 });
    expect(limited.records.map((r) => r.msg)).toEqual(['calendar failing', 'boom']);
    expect(limited).toMatchObject({ truncated: true, lastSeq: 3 });
    log.close();
  });

  it('counts warnings and errors since a time and remembers the last record of each run', () => {
    let clock = 0;
    const log = createLogger({ console: false, now: () => clock });
    log.warn('old');
    clock = 10_000;
    log.warn('w1');
    log.warn('w1');
    log.error('e1');
    log.child({ src: 'client' }).warn('client: w');
    log.child({ src: 'client' }).error('client: e');
    withLogContext({ run: 'run001', area: 'calendar' }, () => {
      log.info('starting');
      log.debug('fetched page 2');
    });
    log.warn('job still running', { run: 'run001' });
    expect(log.counts(5_000)).toEqual({ server: { warn: 3, error: 1 }, client: { warn: 1, error: 1 }, warnKeys: 5 });
    expect(log.lastRecordFor('run001')).toEqual({ msg: 'fetched page 2', t: 10_000, area: 'calendar' });
    expect(log.lastRecordFor('nope')).toBeNull();
    log.close();
  });
});

describe('repeat suppression', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the first occurrence, collapses repeats for 30 min, then reports them', () => {
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const log = createLogger({ console: false, level: 'info', now: () => clock });
    const fail = (sig = '503|') => log.child({ module: 'calendar' }).warn('outbound failed', { repeatKey: 'x.example sync 503', repeatSig: sig });
    fail();
    clock += 1_000;
    fail();
    clock += 1_000;
    fail();
    let recs = log.query({}).records;
    expect(recs.map((r) => [r.level, r.fields.repeats])).toEqual([
      ['warn', undefined],
      ['debug', 1],
      ['debug', 2],
    ]);
    expect(recs.every((r) => !('repeatKey' in r.fields) && !('repeatSig' in r.fields))).toBe(true);
    // The repeats of a warning say so, and a level filter still sees them as warnings.
    expect(recs[2]?.fields).toMatchObject({ repeatOf: 'warn', repeatSince: '2026-10-11T10:00:00.000Z' });
    expect(log.query({ level: 'warn' }).records.map((r) => r.level)).toEqual(['warn', 'debug', 'debug']);

    clock += 30 * 60 * 1000;
    withLogContext({ rid: 'someone000' }, () => fail());
    recs = log.query({ level: 'info' }).records;
    expect(recs.map((r) => r.msg)).toEqual(['outbound failed', 'outbound failed', 'outbound failed', 'repeated', 'outbound failed']);
    expect(recs[3]).toMatchObject({
      level: 'info',
      area: 'calendar',
      rid: null,
      fields: {
        repeatKey: 'x.example sync 503',
        count: 2,
        since: '2026-10-11T10:00:00.000Z',
        repeatOf: 'warn',
        repeatMsg: 'outbound failed',
      },
    });
    // The summary (info) matches a warn filter too; the next window starts with a warning again.
    expect(log.query({ level: 'warn' }).records.map((r) => [r.level, r.msg])).toEqual([
      ['warn', 'outbound failed'],
      ['debug', 'outbound failed'],
      ['debug', 'outbound failed'],
      ['info', 'repeated'],
      ['warn', 'outbound failed'],
    ]);

    // A different signature starts a new window at the call's level.
    clock += 1_000;
    fail('500|');
    expect(log.query({}).records.at(-1)).toMatchObject({ level: 'warn', msg: 'outbound failed' });
    log.close();
  });

  it('counts the collapsed repeats of a warning: an open window by its count, a closed one by its summary', () => {
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const log = createLogger({ console: false, level: 'info', now: () => clock });
    const hour = 60 * 60 * 1000;
    const warn = (): void => log.child({ module: 'feeds' }).warn('feed failed', { repeatKey: 'feed abc timeout', code: 'timeout' });
    warn();
    clock += 1_000;
    warn();
    clock += 1_000;
    warn();
    const none = { warn: 0, error: 0 };
    expect(log.counts(clock - hour)).toEqual({ server: { warn: 3, error: 0 }, client: none, warnKeys: 1 });

    clock += 30 * 60 * 1000;
    warn(); // closes the window (its summary stands for 2) and opens the next one
    expect(log.counts(clock - hour)).toEqual({ server: { warn: 4, error: 0 }, client: none, warnKeys: 1 });
    expect(log.query({ q: 'repeated' }).records.map((r) => r.fields)).toEqual([
      { repeatKey: 'feed abc timeout', count: 2, since: '2026-10-11T10:00:00.000Z', repeatOf: 'warn', repeatMsg: 'feed failed', code: 'timeout' },
    ]);
    // Only the last hour: the first warning has left it; the summary (written at the window's close) has not.
    clock += 50 * 60 * 1000;
    expect(log.counts(clock - hour)).toEqual({ server: { warn: 3, error: 0 }, client: none, warnKeys: 1 });

    // Repeats of info lines are no warnings, and their summary names nothing to repeat.
    log.info('slow', { repeatKey: 'slow' });
    log.info('slow', { repeatKey: 'slow' });
    expect(log.query({ level: 'debug', q: 'slow' }).records.at(-1)?.fields).toEqual({ repeats: 1 });
    expect(log.counts(clock - hour).server.warn).toBe(3);
    log.close();
  });

  it('the hourly sweep timer is created outside any context and reports windows that closed quietly', async () => {
    const realSetInterval = globalThis.setInterval;
    const created: { ms: number | undefined; ctx: LogContext | undefined }[] = [];
    const fired: (LogContext | undefined)[] = [];
    let sweep: (() => void) | null = null;
    // Real timer (10 ms instead of an hour): the callback runs in the context active where the logger created it.
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      created.push({ ms, ctx: getLogContext() });
      sweep = fn;
      return realSetInterval(() => fired.push(getLogContext()), 10);
    }) as unknown as typeof setInterval);
    let clock = Date.parse('2026-10-11T10:00:00Z');
    let log: ReturnType<typeof createLogger>;
    try {
      log = withLogContext({ rid: 'creator000' }, () => createLogger({ console: false, level: 'info', now: () => clock }));
    } finally {
      spy.mockRestore();
    }
    expect(created).toEqual([{ ms: 60 * 60 * 1000, ctx: undefined }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((ctx) => ctx === undefined)).toBe(true);

    for (let i = 0; i < 3; i++) log.info('request', { repeatKey: 'GET /api/x 404 not_found' });
    clock += 60 * 60 * 1000;
    withLogContext({ rid: 'someone000' }, () => (sweep as (() => void) | null)?.());
    const repeated = log.query({ q: 'repeated', level: 'info' }).records;
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ rid: null, fields: { repeatKey: 'GET /api/x 404 not_found', count: 2 } });
    log.close();
  });

  it('a summary keeps its window level, ring flag and source (quiet and debug traffic stays quiet)', () => {
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const log = createLogger({ console: false, level: 'info', now: () => clock });
    const request = (route: string, extra: Record<string, unknown> = {}): void =>
      log.child({ module: 'calendar' }).debug('request', { route, status: 200, repeatKey: `GET ${route} 200 `, ...extra });
    const clientWarn = (): void =>
      withLogContext({ area: 'client' }, () =>
        log.child({ module: 'diagnostics' }).warn('client: request failed', { src: 'client', repeatKey: 'api request failed /api/x 502' }),
      );
    for (let i = 0; i < 5; i++) {
      request('/api/calendar/events');
      request('/api/diagnostics/logs', { ring: false });
      clientWarn();
    }
    clock += 31 * 60 * 1000;
    request('/api/calendar/events');
    request('/api/diagnostics/logs', { ring: false });
    clientWarn();

    const repeated = log.query({ q: 'repeated' }).records.filter((r) => r.msg === 'repeated');
    expect(repeated.map((r) => [r.level, r.src, r.fields.repeatKey, r.fields.count])).toEqual([
      ['debug', 'server', 'GET /api/calendar/events 200 ', 4],
      ['info', 'client', 'api request failed /api/x 502', 4],
    ]);
    // Nothing reached the main ring at info, and the browser summary sits in the client ring.
    expect(log.query({ level: 'info', src: 'server' }).records).toEqual([]);
    expect(log.query({ src: 'client', q: 'repeated' }).records).toHaveLength(1);
    expect(log.counts(0).server).toEqual({ warn: 0, error: 0 });
    log.close();

    // The quiet window's summary went to the file only (verbose), never to a ring.
    const verboseLog = createTestLogger('debug');
    verboseLog.debug('request', { repeatKey: 'GET /api/health 200 ', ring: false });
    verboseLog.debug('request', { repeatKey: 'GET /api/health 200 ', ring: false });
    verboseLog.debug('request', { repeatKey: 'GET /api/health 200 ', ring: false, repeatSig: 'other' });
    expect(verboseLog.lines().map((r) => [r.level, r.msg])).toEqual([
      ['debug', 'request'],
      ['debug', 'request'],
      ['debug', 'repeated'],
      ['debug', 'request'],
    ]);
    expect(verboseLog.query({}).records).toEqual([]);
  });

  it('a higher-level record of a key starts a new window; lower ones are written uncounted', () => {
    const log = createTestLogger('info');
    const tick = (level: 'debug' | 'info'): void =>
      log[level]('request', { repeatKey: 'GET /api/feeds 200 ', ms: level === 'info' ? 4000 : 20 });
    tick('debug');
    tick('debug');
    tick('info'); // slow: written at info, closes the debug window (debug summary)
    tick('debug'); // fast: written as debug, not counted
    tick('info'); // slow again: collapsed
    tick('info');
    const recs = log.query({}).records.map((r) => [r.level, r.msg, r.fields.repeats ?? r.fields.count]);
    expect(recs).toEqual([
      ['debug', 'request', undefined],
      ['debug', 'request', 1],
      ['debug', 'repeated', 1],
      ['info', 'request', undefined],
      ['debug', 'request', undefined],
      ['debug', 'request', 1],
      ['debug', 'request', 2],
    ]);
    expect(log.lines().map((r) => [r.level, r.msg])).toEqual([['info', 'request']]);
  });
});

describe('createTestLogger', () => {
  it('lines() holds what passed the level; query() sees the rings', () => {
    const log = createTestLogger('info');
    log.debug('d');
    log.info('i');
    expect(log.lines().map((r: LogRecordOut) => r.msg)).toEqual(['i']);
    expect(log.query({}).records.map((r) => r.msg)).toEqual(['d', 'i']);
    expect(log.file).toBeNull();
  });
});

describe('hub on children', () => {
  it('children expose the same hub (the scheduler gets a child)', () => {
    const log = createTestLogger();
    const child = log.child({ component: 'scheduler' }).child({ job: 'x' });
    expect(isLogHub(log)).toBe(true);
    expect(isLogHub(child)).toBe(true);
    expect(isLogHub(createMemoryLogger())).toBe(false);
    expect(isLogHub(createSilentLogger())).toBe(false);
    if (!isLogHub(child)) throw new Error('not a hub');
    withLogContext({ run: 'abc123' }, () => child.info('step'));
    expect(child.lastRecordFor('abc123')).toMatchObject({ msg: 'step', area: 'scheduler' });
    expect(child.size).toBe(1);
    log.info('more');
    expect(child.size).toBe(2);
    expect(child.levelState().bootLevel).toBe('debug');
  });

  it('bounds the repeat map, reporting the repeats of an evicted key', () => {
    const log = createTestLogger();
    log.warn('first', { repeatKey: 'k0' });
    log.warn('first', { repeatKey: 'k0' });
    for (let i = 1; i <= 1000; i++) log.debug('other', { repeatKey: `k${i}` });
    const repeated = log.query({ q: 'repeated', level: 'info' }).records;
    expect(repeated.map((r) => r.fields)).toEqual([{ repeatKey: 'k0', count: 1, since: expect.any(String), repeatOf: 'warn', repeatMsg: 'first' }]);
  });
});

describe('errorFields', () => {
  // The server's real error classes: errorFields discriminates by `name` and property names, so a
  // rename or a shape change there must fail here.
  it('HttpError: errStatus, errCode, accountId, details', () => {
    const err = new HttpError(409, 'not_configured', { message: 'Todoist rejected the token', accountId: 'a1', details: { reason: 'token_rejected', upstreamStatus: 401 } });
    expect(errorFields(err)).toEqual({
      errName: 'HttpError',
      errMessage: 'Todoist rejected the token',
      errCode: 'not_configured',
      errStatus: 409,
      upstreamStatus: 401,
      errReason: 'token_rejected',
      accountId: 'a1',
    });
    expect(errorFields(new HttpError(422, 'validation_failed', 'bad', { reason: 'has spaces in it' })).errReason).toBeUndefined();
    // `details.status` is an upstream status too (our own status stays errStatus).
    expect(errorFields(new HttpError(502, 'provider_error', 'Feed answered 404', { status: 404 }))).toMatchObject({
      errStatus: 502,
      upstreamStatus: 404,
    });
  });

  it('SafeFetchError: reason, host and the cause chain', () => {
    const deepest = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
    const err = new SafeFetchError('network', 'www.googleapis.com could not be reached', 'www.googleapis.com');
    // As fetch failures arrive (`cause` set like `new Error(msg, {cause})` does).
    Object.defineProperty(err, 'cause', { value: new TypeError('fetch failed', { cause: deepest }), configurable: true, writable: true });
    expect(errorFields(err)).toEqual({
      errName: 'SafeFetchError',
      errMessage: 'www.googleapis.com could not be reached',
      errCode: 'provider_error',
      errStatus: 502,
      errReason: 'network',
      host: 'www.googleapis.com',
      cause: 'TypeError <- Error[ECONNREFUSED]',
      causeCode: 'ECONNREFUSED',
    });
  });

  it('caps the cause chain at three links and survives cycles', () => {
    const a = new Error('a');
    const b = Object.assign(new Error('b', { cause: a }), { code: 'EB' });
    Object.defineProperty(a, 'cause', { value: b });
    const top = new Error('top', { cause: new RangeError('r', { cause: new SyntaxError('s', { cause: b }) }) });
    expect(errorFields(top)).toMatchObject({ cause: 'RangeError <- SyntaxError <- Error[EB]', causeCode: 'EB' });
    expect(errorFields(new Error('x', { cause: a })).cause).toBe('Error <- Error[EB]');
  });

  it.each<[string, Error, Record<string, unknown>]>([
    [
      'SafeFetchError timeout',
      new SafeFetchError('timeout', 'calendar.example.org did not answer in time', 'calendar.example.org'),
      { errStatus: 504, errCode: 'upstream_timeout', errReason: 'timeout', host: 'calendar.example.org' },
    ],
    [
      'DavHttpError',
      new DavHttpError(401, 'The CalDAV server rejected the credentials'),
      { errStatus: 403, upstreamStatus: 401, errCode: 'forbidden' },
    ],
    [
      'ProviderHttpError',
      new ProviderHttpError(403, 'forbidden', {
        message: 'The Calendar API is not enabled',
        accountId: 'acc-1',
        providerReason: 'PERMISSION_DENIED accessNotConfigured <script> SERVICE_DISABLED',
        denial: 'api_disabled',
      }),
      {
        errStatus: 403,
        errCode: 'forbidden',
        errReason: 'api_disabled',
        providerReason: 'PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED',
        accountId: 'acc-1',
      },
    ],
    ['SuggestUpstreamError', new SuggestUpstreamError(503), { upstreamStatus: 503, errMessage: 'Suggestion provider answered 503' }],
    ['ImapOpError', new ImapOpError(409, 'conflict', 'Mailbox busy'), { errStatus: 409, errCode: 'conflict' }],
    ['DavParseError', new DavParseError('limit', 'The CalDAV response could not be read'), { errReason: 'limit' }],
    ['ExpandError', new ExpandError('limit', 'Too many instances'), { errReason: 'limit' }],
    ['BlockedAddressError', new BlockedAddressError('nas.local'), { host: 'nas.local', errCode: 'EPORTLY_BLOCKED' }],
    ['NotPrivateAddressError', new NotPrivateAddressError('printer.lan'), { host: 'printer.lan', errCode: 'EPORTLY_NOT_LAN' }],
    ['TodoistRateLimitError', new TodoistRateLimitError(12), { errStatus: 429, errCode: 'rate_limited', retryAfterSeconds: 12 }],
  ])('%s', (name, err, expected) => {
    expect(err.name).toBe(name.split(' ')[0]);
    const fields = errorFields(err);
    expect(fields).toMatchObject({ errName: err.name, ...expected });
    if (err.name === 'SuggestUpstreamError') expect(fields.errStatus).toBeUndefined();
    if (err.name === 'ImapOpError') expect(fields.upstreamStatus).toBeUndefined();
  });

  it('retryAfterSeconds as an own property or in details', () => {
    const err = Object.assign(
      new ProviderHttpError(429, 'rate_limited', { message: 'Google is rate limiting requests', accountId: 'acc-1', providerReason: 'rateLimitExceeded' }),
      { retryAfterSeconds: 30 },
    );
    expect(errorFields(err)).toMatchObject({ errStatus: 429, providerReason: 'rateLimitExceeded', retryAfterSeconds: 30 });
    expect(errorFields(new HttpError(503, 'provider_error', 'x', { retryAfterSeconds: 5 })).retryAfterSeconds).toBe(5);
  });

  it('node:sqlite errors carry errcode/errstr', () => {
    const db = new DatabaseSync(':memory:');
    let caught: unknown;
    try {
      db.exec('SELEC 1');
    } catch (err) {
      caught = err;
    } finally {
      db.close();
    }
    const fields = errorFields(caught);
    expect(fields).toMatchObject({ errCode: 'ERR_SQLITE_ERROR', sqliteCode: 1 });
    expect(typeof fields.sqliteError).toBe('string');
  });

  it('stack: frame lines only, never the header (message) line', () => {
    const err = new Error(`${'pad '.repeat(500)}MARKER secret\n    at MARKER (C:\\Users\\riley\\fake.js:1:1)`);
    const fields = errorFields(err, { stack: true });
    const stack = String(fields.stack);
    expect(stack).not.toContain('MARKER');
    // Not bare 'pad': frames carry absolute paths, and a checkout path may contain it ('scratchpad', 'keypad').
    expect(stack).not.toContain('pad pad');
    const frames = stack.split('\n');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(15);
    for (const frame of frames) {
      expect(frame.startsWith('at ')).toBe(true);
      expect(frame.length).toBeLessThanOrEqual(300);
      expect(frame).not.toMatch(/Users[\\/]riley/i);
    }
    expect(String(fields.errMessage)).toHaveLength(300);
    expect(errorFields(err).stack).toBeUndefined();
  });

  it('non-errors and error-like objects', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\someone');
    expect(errorFields('C:\\Users\\riley\\x password=1')).toEqual({ errName: 'string', errMessage: 'C:\\Users\\~\\x password=[REDACTED]' });
    expect(errorFields({ name: 'AbortError', message: 'aborted' })).toEqual({ errName: 'AbortError', errMessage: 'aborted' });
  });
});
