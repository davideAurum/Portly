import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { ExpandError } from '../modules/calendar/ical/expand.ts';
import { DavHttpError } from '../modules/calendar/providers/caldav.ts';
import { DavParseError } from '../modules/calendar/providers/dav-xml.ts';
import { NotAFeedError } from '../modules/feeds/parse.ts';
import { XmlError } from '../modules/feeds/xml.ts';
import { ImapAuthError, ImapOpError } from '../modules/mail/providers/imap-session.ts';
import { SuggestUpstreamError } from '../modules/search/suggest.ts';
import { TodoistRateLimitError } from '../modules/todoist/client.ts';
import { NotPrivateAddressError, SafeFetchError } from '../security/safe-fetch.ts';
import { VaultLockedError } from '../security/vault.ts';
import { HttpError } from './errors.ts';
import {
  HEALTH_RETENTION_MS,
  MAX_OUTCOME_ROWS,
  OUTCOME_RETENTION_MS,
  PERSIST_INTERVAL_MS,
  REMINDER_INTERVAL_MS,
  SHORT_LIVED_RETENTION_MS,
  contextFieldForKey,
  createHealthRecorder,
  outcomeFromError,
  type HealthRecorder,
  type HealthSubject,
} from './health.ts';
import { createMemoryLogger, createTestLogger } from './logger.ts';
import { ProviderHttpError } from './provider-errors.ts';

const T0 = Date.UTC(2026, 9, 11, 8, 0, 0);
const CAL: HealthSubject = { key: 'calendar:c1', area: 'calendar', accountId: 'acc-1', expectEveryMs: 15 * 60_000 };

/** Lets the queued microtask flush run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errnoError(code: string, message = `${code} something`): Error {
  return Object.assign(new Error(message), { code });
}

describe('health recorder', () => {
  let db: Db;
  let log: ReturnType<typeof createMemoryLogger>;
  let t: number;
  let health: HealthRecorder;
  const make = (): HealthRecorder => createHealthRecorder({ db, log, now: () => t });
  const lines = (message: string) => log.lines.filter((l) => l.message === message);
  const healthRow = (key: string) => db.get<Record<string, unknown>>('SELECT * FROM diag_health WHERE key = ?', [key]);
  const outcomeRows = (key: string) => db.all<Record<string, unknown>>('SELECT * FROM diag_outcomes WHERE key = ? ORDER BY id', [key]);

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    log = createMemoryLogger();
    t = T0;
    health = make();
  });
  afterEach(() => {
    health.close();
    db.close();
  });

  it('logs a first failure at warn, repeats at debug, a 6-hourly info reminder and the recovery at info', () => {
    health.record(CAL, { ok: true, ms: 120, detail: { mode: 'full', fetched: 3 } });
    expect(lines('calendar ok')).toEqual([
      { level: 'debug', message: 'calendar ok', fields: { area: 'calendar', key: 'calendar:c1', accountId: 'acc-1', ms: 120, mode: 'full', fetched: 3 } },
    ]);

    t += 60_000;
    health.record(CAL, { ok: false, code: 'timeout', status: 504, message: 'Request to www.googleapis.com timed out', ms: 20_000, nextAttemptAt: t + 120_000 });
    const failing = lines('calendar failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      level: 'warn',
      fields: {
        area: 'calendar',
        key: 'calendar:c1',
        accountId: 'acc-1',
        code: 'timeout',
        status: 504,
        message: 'Request to www.googleapis.com timed out',
        consecutive: 1,
        nextAttemptAt: new Date(t + 120_000).toISOString(),
      },
    });

    t += 60_000;
    health.record(CAL, { ok: false, code: 'timeout', status: 504 });
    expect(lines('calendar still failing')).toEqual([
      { level: 'debug', message: 'calendar still failing', fields: { area: 'calendar', key: 'calendar:c1', accountId: 'acc-1', code: 'timeout', consecutive: 2 } },
    ]);
    expect(lines('calendar failing')).toHaveLength(1);

    const firstFailure = T0 + 60_000;
    t = firstFailure + REMINDER_INTERVAL_MS;
    health.record(CAL, { ok: false, code: 'timeout', status: 504 });
    const reminder = lines('calendar still failing').at(-1);
    expect(reminder).toMatchObject({ level: 'info', fields: { code: 'timeout', since: new Date(firstFailure).toISOString(), consecutive: 3 } });
    t += 60_000;
    health.record(CAL, { ok: false, code: 'timeout', status: 504 });
    expect(lines('calendar still failing').at(-1)?.level).toBe('debug');

    t += 60_000;
    health.record(CAL, { ok: true, ms: 80 });
    expect(lines('calendar recovered')).toEqual([
      {
        level: 'info',
        message: 'calendar recovered',
        fields: { area: 'calendar', key: 'calendar:c1', accountId: 'acc-1', downForMs: t - firstFailure, failures: 4, ms: 80 },
      },
    ]);
    t += 60_000;
    health.record(CAL, { ok: true });
    expect(lines('calendar ok').at(-1)?.level).toBe('debug');
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toHaveLength(1);
  });

  it('keeps the state of a subject (epoch ms) and the last failure after recovery', () => {
    health.record({ ...CAL, label: 'ignored-for-calendars' }, { ok: false, code: 'http_5xx', status: 503, message: 'Google returned an error (503)', ms: 40, causeKey: null, detail: { stage: 'list' } });
    const failing = health.get('calendar:c1');
    expect(failing).toEqual({
      key: 'calendar:c1',
      area: 'calendar',
      label: 'ignored-for-calendars',
      accountId: 'acc-1',
      status: 'failing',
      lastOkAt: null,
      lastFailAt: T0,
      failingSince: T0,
      lastCheckedAt: T0,
      expectEveryMs: 900_000,
      consecutiveFailures: 1,
      lastCode: 'http_5xx',
      lastStatus: 503,
      lastMessage: 'Google returned an error (503)',
      lastMs: 40,
      detail: { stage: 'list' },
      causeKey: null,
      nextAttemptAt: null,
      updatedAt: T0,
    });
    t += 1000;
    health.record(CAL, { ok: true, ms: 12 });
    expect(health.get('calendar:c1')).toMatchObject({
      status: 'ok',
      lastOkAt: T0 + 1000,
      lastFailAt: T0,
      failingSince: null,
      consecutiveFailures: 0,
      lastCode: 'http_5xx',
      lastMessage: 'Google returned an error (503)',
      lastMs: 12,
      detail: null,
    });
    expect(health.get('nope')).toBeNull();
  });

  it('treats another code or status as a new failure and honours severity (dependents info, jobs error)', () => {
    health.record(CAL, { ok: false, code: 'dns' });
    t += 1000;
    health.record(CAL, { ok: false, code: 'refused' });
    t += 1000;
    health.record(CAL, { ok: false, code: 'refused', status: 502 });
    expect(lines('calendar failing').map((l) => [l.level, l.fields?.code, l.fields?.consecutive])).toEqual([
      ['warn', 'dns', 1],
      ['warn', 'refused', 2],
      ['warn', 'refused', 3],
    ]);
    expect(health.get('calendar:c1')?.failingSince).toBe(T0);

    health.record(
      { key: 'mail:acc-1', area: 'mail', accountId: 'acc-1' },
      { ok: false, code: 'account_unavailable', causeKey: 'account:acc-1', severity: 'info' },
    );
    expect(lines('mail failing')).toEqual([
      {
        level: 'info',
        message: 'mail failing',
        fields: { area: 'mail', key: 'mail:acc-1', accountId: 'acc-1', code: 'account_unavailable', causeKey: 'account:acc-1', consecutive: 1 },
      },
    ]);
    health.record({ key: 'job:feeds:refresh', area: 'feeds', label: 'feeds:refresh' }, { ok: false, code: 'internal', severity: 'error' });
    expect(lines('feeds failing')[0]?.level).toBe('error');
  });

  it('degraded: info when it starts, then like a failure; recovery from it at info', async () => {
    health.record(CAL, { ok: true, degraded: true, code: 'storage_limit', message: 'Some events were not stored' });
    expect(lines('calendar degraded')).toMatchObject([{ level: 'info', fields: { code: 'storage_limit', message: 'Some events were not stored' } }]);
    expect(health.get('calendar:c1')).toMatchObject({ status: 'degraded', lastCode: 'storage_limit', failingSince: T0, consecutiveFailures: 0, lastOkAt: T0 });
    t += 1000;
    health.record(CAL, { ok: true, degraded: true, code: 'storage_limit' });
    expect(lines('calendar still degraded')[0]?.level).toBe('debug');
    t += 1000;
    health.record(CAL, { ok: false, code: 'timeout' });
    expect(lines('calendar failing')[0]?.level).toBe('warn');
    t += 1000;
    health.record(CAL, { ok: true, degraded: true, code: 'truncated' });
    t += 1000;
    health.record(CAL, { ok: true, degraded: true, code: 'truncated' });
    t += 1000;
    health.record(CAL, { ok: true });
    expect(lines('calendar recovered')).toHaveLength(1);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    await tick();
    expect(outcomeRows('calendar:c1').map((r) => [r.status, r.code, r.ok, r.count])).toEqual([
      ['degraded', 'storage_limit', 1, 2],
      ['failing', 'timeout', 0, 1],
      ['degraded', 'truncated', 1, 2],
      ['ok', null, 1, 1],
    ]);
  });

  it('enforces the content rules: scrubbed message, machine-token codes, safe detail values', () => {
    // Not this PC's home: the generic user-path rule is under test (a home of C:\Users\riley is masked whole, first).
    vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\someone');
    health.record(
      { key: 'feed:0123456789', area: 'feeds', label: 'feeds.example.org' },
      {
        ok: false,
        code: 'not a token!',
        status: 99,
        message: `Bearer ya29.secretvalue failed for C:\\Users\\riley\\AppData\\x\nnext line ${'y'.repeat(400)}`,
        detail: {
          host: 'feeds.example.org',
          finalHost: '[::1]:8443',
          items: 0,
          notModified: false,
          errCode: 'ECONNRESET',
          contentType: 'application/rss+xml',
          path: 'feeds/news.xml',
          withParams: 'text/html; charset=utf-8',
          given: 'Berlin, DE',
          long: 'x'.repeat(65),
          url: 'https://feeds.example.org/rss?token=1',
          nested: { a: 1 } as unknown as number,
          'bad key': 1,
        },
      },
    );
    const state = health.get('feed:0123456789');
    expect(state?.lastCode).toBeNull();
    expect(state?.lastStatus).toBeNull();
    expect(state?.detail).toEqual({
      host: 'feeds.example.org',
      finalHost: '[::1]:8443',
      items: 0,
      notModified: false,
      errCode: 'ECONNRESET',
      contentType: 'application/rss+xml',
    });
    expect(state?.label).toBe('feeds.example.org');
    const message = state?.lastMessage ?? '';
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message).not.toContain('secretvalue');
    expect(message).not.toContain('riley');
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain('C:\\Users\\~\\AppData');
    const dropped = lines('health outcome fields dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ level: 'debug', fields: { key: 'feed:0123456789' } });
    expect(dropped[0]?.fields?.dropped).toEqual(
      expect.arrayContaining([
        'code',
        'status',
        'detail.path',
        'detail.withParams',
        'detail.given',
        'detail.long',
        'detail.url',
        'detail.nested',
        'detail.bad key',
      ]),
    );
    expect(JSON.stringify(log.lines)).not.toContain('Berlin');

    health.record({ key: 'suggest:google', area: 'search', label: 'not a label!', accountId: 'bad id with spaces' }, { ok: true });
    expect(health.get('suggest:google')).toMatchObject({ label: null, accountId: null });
  });

  it('names the subject by its label in transition lines (a feed key is only a hash)', () => {
    const FEED: HealthSubject = { key: 'feed:3fa2bc0011', area: 'feeds', label: 'news.example.org', expectEveryMs: null };
    health.record(FEED, { ok: false, code: 'not_a_feed', message: 'No RSS or Atom feed was found on this page', detail: { contentType: 'text/html' } });
    t += 1000;
    health.record(FEED, { ok: true, ms: 30 });
    expect(lines('feeds failing')).toMatchObject([
      { level: 'warn', fields: { area: 'feeds', key: 'feed:3fa2bc0011', label: 'news.example.org', code: 'not_a_feed', contentType: 'text/html' } },
    ]);
    expect(lines('feeds recovered')).toMatchObject([{ level: 'info', fields: { key: 'feed:3fa2bc0011', label: 'news.example.org' } }]);

    // A label cleanSubject rejects never reaches a line.
    health.record({ key: 'suggest:google', area: 'search', label: 'C:\\Users\\riley\\x' }, { ok: false, code: 'timeout' });
    expect(lines('search failing')[0]?.fields).not.toHaveProperty('label');
  });

  it('drops times a Date cannot hold, so the state and its lines stay convertible to ISO', () => {
    health.record({ key: 'todoist', area: 'todoist' }, { ok: false, code: 'rate_limited', nextAttemptAt: 1e17 });
    expect(health.get('todoist')).toMatchObject({ status: 'failing', lastCode: 'rate_limited', nextAttemptAt: null });
    expect(lines('todoist failing')).toHaveLength(1);
    expect(lines('health outcome fields dropped')[0]?.fields?.dropped).toEqual(['nextAttemptAt']);

    health.touch({ key: 'weather', area: 'weather' }, { skipped: 'backoff', nextAttemptAt: -1e17 });
    expect(health.get('weather')).toMatchObject({ lastCheckedAt: T0, nextAttemptAt: null, detail: { skipped: 'backoff' } });
    expect(lines('health outcome fields dropped')[1]?.fields?.dropped).toEqual(['nextAttemptAt']);
    health.touch(CAL, { skipped: 'backoff', nextAttemptAt: 8.64e15 });
    expect(health.get('calendar:c1')?.nextAttemptAt).toBe(8.64e15);
    expect(lines('health tracker failed')).toEqual([]);

    // Durations beyond 2^53 are capped or dropped: node:sqlite could not read such an INTEGER back,
    // and one unreadable row would lose every subject at the next start.
    health.record({ key: 'job:calendar:sync', area: 'calendar', expectEveryMs: 1e17 }, { ok: true, ms: 1e17 });
    expect(health.get('job:calendar:sync')).toMatchObject({ expectEveryMs: null, lastMs: Number.MAX_SAFE_INTEGER });

    // A stored time out of range (another build, a hand edit) is read back as null.
    health.flush();
    db.run('UPDATE diag_health SET next_attempt_at = ?, last_fail_at = ? WHERE key = ?', [9e15, -9e15, 'todoist']);
    const reloaded = make();
    expect(reloaded.get('todoist')).toMatchObject({ status: 'failing', nextAttemptAt: null, lastFailAt: null });
    expect(reloaded.get('job:calendar:sync')).toMatchObject({ status: 'ok', lastMs: Number.MAX_SAFE_INTEGER });
    expect(reloaded.history('job:calendar:sync')).toMatchObject([{ status: 'ok', ms: Number.MAX_SAFE_INTEGER }]);
    reloaded.close();
    expect(lines('health persistence failed')).toEqual([]);
  });

  it('never throws: invalid input is ignored, persistence errors warn at most once a minute', async () => {
    expect(() => health.record(null as unknown as HealthSubject, null as never)).not.toThrow();
    expect(() => health.record({ key: 'bad\nkey', area: 'x' }, { ok: true })).not.toThrow();
    expect(() => health.touch({ key: '', area: 'x' }, { skipped: 'backoff' })).not.toThrow();
    expect(() => health.forget(undefined as unknown as string)).not.toThrow();
    expect(health.list()).toEqual([]);

    db.exec('DROP TABLE diag_outcomes');
    health.record(CAL, { ok: false, code: 'dns' });
    await tick();
    t += 1000;
    health.record(CAL, { ok: true });
    await tick();
    expect(health.get('calendar:c1')?.status).toBe('ok');
    expect(lines('health persistence failed')).toHaveLength(1);
    t += PERSIST_INTERVAL_MS;
    health.record(CAL, { ok: false, code: 'dns' });
    await tick();
    expect(lines('health persistence failed')).toHaveLength(2);
    expect(lines('health persistence failed')[0]).toMatchObject({ level: 'warn', fields: { errName: 'Error' } });
    expect(health.history('calendar:c1')).toEqual([]);
  });

  it('writes after the caller’s transaction, batched in one microtask flush', async () => {
    db.exec('BEGIN');
    health.record(CAL, { ok: false, code: 'dns' });
    await Promise.resolve();
    await Promise.resolve();
    expect(db.inTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(healthRow('calendar:c1')).toBeUndefined();
    await tick();
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'failing', last_code: 'dns' });

    // Recorded inside a db.tx that rolls back: the health write is not part of it.
    expect(() =>
      db.tx(() => {
        health.record({ key: 'todoist', area: 'todoist' }, { ok: false, code: 'token_rejected', status: 401 });
        throw new Error('caller failed');
      }),
    ).toThrow('caller failed');
    expect(healthRow('todoist')).toBeUndefined();
    await tick();
    expect(healthRow('todoist')).toMatchObject({ status: 'failing', last_code: 'token_rejected', last_status: 401 });
    expect(outcomeRows('todoist')).toHaveLength(1);
  });

  it('rewrites a row on every transition but otherwise at most once a minute; flush() writes now', async () => {
    health.record(CAL, { ok: true, ms: 1 });
    health.flush();
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'ok', last_ms: 1, updated_at: T0 });
    t += 30_000;
    health.record(CAL, { ok: true, ms: 2 });
    await tick();
    expect(healthRow('calendar:c1')).toMatchObject({ last_ms: 1, updated_at: T0 });
    t += 1000;
    health.record(CAL, { ok: false, code: 'dns' });
    await tick();
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'failing', updated_at: T0 + 31_000 });
    t += 1000;
    health.record(CAL, { ok: false, code: 'dns' });
    await tick();
    expect(healthRow('calendar:c1')).toMatchObject({ consecutive_failures: 1 });
    t += PERSIST_INTERVAL_MS;
    health.record(CAL, { ok: false, code: 'dns' });
    await tick();
    expect(healthRow('calendar:c1')).toMatchObject({ consecutive_failures: 3 });
  });

  it('collapses identical consecutive failures into the latest outcome row', async () => {
    health.record(CAL, { ok: true, ms: 5 });
    t += 1000;
    health.record(CAL, { ok: true, ms: 6 });
    for (let i = 0; i < 3; i++) {
      t += 1000;
      health.record(CAL, { ok: false, code: 'http_5xx', status: 503 });
    }
    t += 1000;
    health.record(CAL, { ok: false, code: 'http_5xx', status: 500 });
    t += 1000;
    health.record(CAL, { ok: true });
    await tick();
    const rows = outcomeRows('calendar:c1');
    expect(rows.map((r) => [r.status, r.code, r.http_status, r.count, r.at, r.last_at])).toEqual([
      ['ok', null, null, 1, T0, T0],
      ['failing', 'http_5xx', 503, 3, T0 + 2000, T0 + 4000],
      ['failing', 'http_5xx', 500, 1, T0 + 5000, T0 + 5000],
      ['ok', null, null, 1, T0 + 6000, T0 + 6000],
    ]);
    const history = health.history('calendar:c1');
    expect(history.map((r) => r.status)).toEqual(['ok', 'failing', 'failing', 'ok']);
    expect(history[2]).toEqual({
      id: expect.any(Number),
      key: 'calendar:c1',
      at: T0 + 2000,
      lastAt: T0 + 4000,
      count: 3,
      ok: false,
      status: 'failing',
      code: 'http_5xx',
      httpStatus: 503,
      message: null,
      ms: null,
      detail: null,
    });
    expect(health.history('calendar:c1', 1)).toHaveLength(1);
  });

  it('continues a persisted failure after a restart: info "still failing", same outcome row', async () => {
    health.record(CAL, { ok: false, code: 'dns', message: 'Could not reach www.googleapis.com' });
    t += 1000;
    health.record({ key: 'todoist', area: 'todoist' }, { ok: false, code: 'rate_limited' });
    health.close();
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'failing', last_reminder_at: T0 });

    t += 60 * 60_000;
    log = createMemoryLogger();
    health = make();
    expect(health.get('calendar:c1')).toMatchObject({ status: 'failing', lastCode: 'dns', failingSince: T0, consecutiveFailures: 1 });
    health.record(CAL, { ok: false, code: 'dns' });
    expect(lines('calendar failing')).toEqual([]);
    expect(lines('calendar still failing')).toMatchObject([{ level: 'info', fields: { code: 'dns', since: new Date(T0).toISOString(), consecutive: 2 } }]);
    t += 1000;
    health.record(CAL, { ok: false, code: 'dns' });
    expect(lines('calendar still failing').at(-1)?.level).toBe('debug');
    health.record({ key: 'todoist', area: 'todoist' }, { ok: false, code: 'token_rejected' });
    expect(lines('todoist failing')).toMatchObject([{ level: 'warn', fields: { code: 'token_rejected' } }]);
    await tick();
    expect(outcomeRows('calendar:c1').map((r) => r.count)).toEqual([3]);
  });

  it('close() flushes pending changes, then later records update memory only', () => {
    health.record(CAL, { ok: true, ms: 1 });
    t += 1000;
    health.record(CAL, { ok: true, ms: 2 });
    health.close();
    expect(healthRow('calendar:c1')).toMatchObject({ last_ms: 2 });
    t += 1000;
    health.record(CAL, { ok: false, code: 'dns' });
    expect(health.get('calendar:c1')?.status).toBe('failing');
    health.flush();
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'ok' });
    health.purge(t + HEALTH_RETENTION_MS);
    expect(healthRow('calendar:c1')).toMatchObject({ status: 'ok' });
    expect(outcomeRows('calendar:c1')).toHaveLength(1);
    expect(() => health.close()).not.toThrow();
  });

  it('close() then db.close() in the same tick: the queued flush leaves the closed database alone', async () => {
    const other = openDb(':memory:');
    migrate(other);
    const tracker = createHealthRecorder({ db: other, log, now: () => t });
    tracker.record(CAL, { ok: false, code: 'dns' });
    tracker.close();
    other.close();
    await tick();
    t += 1000;
    tracker.record(CAL, { ok: true });
    tracker.flush();
    tracker.purge(t + HEALTH_RETENTION_MS);
    await tick();
    expect(tracker.get('calendar:c1')?.status).toBe('ok');
    expect(lines('health persistence failed')).toEqual([]);
    expect(lines('health tracker failed')).toEqual([]);
  });

  it('touch() records skipped work without a transition or an outcome row', async () => {
    health.touch({ key: 'ics:c2', area: 'calendar', accountId: null }, { skipped: 'missing_url' });
    expect(health.get('ics:c2')).toMatchObject({ status: 'unknown', lastCheckedAt: T0, detail: { skipped: 'missing_url' } });
    health.record(CAL, { ok: false, code: 'dns', detail: { stage: 'list' } });
    t += 5000;
    health.touch(CAL, { skipped: 'backoff', nextAttemptAt: t + 60_000 });
    expect(health.get('calendar:c1')).toMatchObject({
      status: 'failing',
      consecutiveFailures: 1,
      lastCheckedAt: T0 + 5000,
      nextAttemptAt: T0 + 65_000,
      detail: { stage: 'list', skipped: 'backoff' },
      updatedAt: T0 + 5000,
    });
    health.touch(CAL, { skipped: 'nonsense' as never });
    expect(health.get('calendar:c1')?.detail).toEqual({ stage: 'list', skipped: 'backoff' });
    expect(lines('calendar skipped').find((l) => l.fields?.key === 'calendar:c1')).toMatchObject({
      level: 'debug',
      fields: { skipped: 'backoff', nextAttemptAt: new Date(T0 + 65_000).toISOString() },
    });
    expect(log.lines.filter((l) => l.level !== 'debug').map((l) => l.message)).toEqual(['calendar failing']);
    await tick();
    expect(outcomeRows('calendar:c1')).toHaveLength(1);
    expect(outcomeRows('ics:c2')).toHaveLength(0);
    t += 1000;
    health.record(CAL, { ok: true });
    expect(health.get('calendar:c1')?.detail).toBeNull();
  });

  it('list() filters by area and account, sorted by key', () => {
    health.record({ key: 'mail:acc-1', area: 'mail', accountId: 'acc-1' }, { ok: true });
    health.record({ key: 'account:acc-1', area: 'accounts', accountId: 'acc-1' }, { ok: true });
    health.record({ key: 'weather', area: 'weather' }, { ok: true });
    health.record(CAL, { ok: true });
    expect(health.list().map((s) => s.key)).toEqual(['account:acc-1', 'calendar:c1', 'mail:acc-1', 'weather']);
    expect(health.list({ accountId: 'acc-1' }).map((s) => s.key)).toEqual(['account:acc-1', 'calendar:c1', 'mail:acc-1']);
    expect(health.list({ area: 'weather' }).map((s) => s.key)).toEqual(['weather']);
    const listed = health.list({ area: 'weather' })[0];
    if (listed) listed.status = 'failing';
    expect(health.get('weather')?.status).toBe('ok');
  });

  it('forget() drops a key or a prefix; forgetAccount() drops the account’s subjects', async () => {
    const subjects: HealthSubject[] = [
      { key: 'account:acc-1', area: 'accounts', accountId: 'acc-1' },
      { key: 'calendar-list:acc-1', area: 'calendar', accountId: 'acc-1' },
      { key: 'mail:acc-1', area: 'mail' },
      CAL,
      { key: 'calendar:c9', area: 'calendar', accountId: 'acc-2' },
      { key: 'ics:i1', area: 'calendar' },
      { key: 'ics:i2', area: 'calendar' },
      { key: 'feed:aaaaaaaaaa', area: 'feeds' },
    ];
    for (const s of subjects) health.record(s, { ok: false, code: 'dns' });
    await tick();

    health.forget('ics:i1');
    health.forget('feed:');
    await tick();
    expect(health.get('ics:i1')).toBeNull();
    expect(health.get('ics:i2')).not.toBeNull();
    expect(healthRow('ics:i1')).toBeUndefined();
    expect(outcomeRows('ics:i1')).toEqual([]);
    expect(healthRow('feed:aaaaaaaaaa')).toBeUndefined();

    health.forgetAccount('acc-1');
    await tick();
    expect(health.list().map((s) => s.key)).toEqual(['calendar:c9', 'ics:i2']);
    expect(db.all<{ key: string }>('SELECT key FROM diag_health ORDER BY key').map((r) => r.key)).toEqual(['calendar:c9', 'ics:i2']);
    expect(db.all<{ key: string }>('SELECT DISTINCT key FROM diag_outcomes ORDER BY key').map((r) => r.key)).toEqual(['calendar:c9', 'ics:i2']);

    // A subject forgotten and recorded again before the flush ends up stored once.
    health.forget('calendar:c9');
    health.record({ key: 'calendar:c9', area: 'calendar', accountId: 'acc-2' }, { ok: true });
    await tick();
    expect(outcomeRows('calendar:c9').map((r) => r.status)).toEqual(['ok']);
    expect(healthRow('calendar:c9')).toMatchObject({ status: 'ok' });

    // An account's subject recorded and forgotten before the flush leaves no outcome row behind.
    health.record({ key: 'calendar:c5', area: 'calendar', accountId: 'acc-3' }, { ok: false, code: 'dns' });
    health.forgetAccount('acc-3');
    await tick();
    expect(health.get('calendar:c5')).toBeNull();
    expect(healthRow('calendar:c5')).toBeUndefined();
    expect(outcomeRows('calendar:c5')).toEqual([]);
    expect(health.history('calendar:c5')).toEqual([]);
  });

  it('purge(): outcome age and count limits, stale subjects (feeds and suggestions sooner)', async () => {
    health.record({ key: 'weather', area: 'weather' }, { ok: false, code: 'dns' });
    health.record({ key: 'feed:bbbbbbbbbb', area: 'feeds', label: 'feeds.example.org' }, { ok: true });
    health.record({ key: 'suggest:ddg', area: 'search' }, { ok: true });
    t += SHORT_LIVED_RETENTION_MS + 1000;
    health.record({ key: 'todoist', area: 'todoist' }, { ok: true });
    await tick();
    health.purge(t);
    expect(health.list().map((s) => s.key)).toEqual(['todoist', 'weather']);
    expect(healthRow('feed:bbbbbbbbbb')).toBeUndefined();
    expect(healthRow('suggest:ddg')).toBeUndefined();

    t = T0 + HEALTH_RETENTION_MS + 1000;
    health.purge(t);
    expect(health.list().map((s) => s.key)).toEqual(['todoist']);
    expect(healthRow('weather')).toBeUndefined();
    expect(outcomeRows('weather')).toHaveLength(0);
    expect(OUTCOME_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);

    db.exec('DELETE FROM diag_outcomes');
    db.tx(() => {
      for (let i = 0; i < MAX_OUTCOME_ROWS + 5; i++) {
        db.run("INSERT INTO diag_outcomes (key, at, last_at, ok, status) VALUES ('todoist', ?, ?, 1, 'ok')", [t, t]);
      }
    });
    const before = db.get<{ first: number; last: number }>('SELECT min(id) AS first, max(id) AS last FROM diag_outcomes');
    health.purge(t);
    const kept = db.get<{ n: number; first: number; last: number }>('SELECT count(*) AS n, min(id) AS first, max(id) AS last FROM diag_outcomes');
    expect(kept).toEqual({ n: MAX_OUTCOME_ROWS, first: (before?.first ?? 0) + 5, last: before?.last });
    expect(lines('health history purged').length).toBeGreaterThan(0);
  });

  it('logs transitions in the subject’s area (tags keep the health component)', () => {
    const hub = createTestLogger('debug');
    const tracker = createHealthRecorder({ db, log: hub.child({ component: 'health' }), now: () => t });
    tracker.record({ key: 'account:acc-9', area: 'accounts', accountId: 'acc-9' }, { ok: false, code: 'invalid_grant' });
    const [rec] = hub.query({ fieldEquals: { key: 'account:acc-9' } }).records;
    expect(rec).toMatchObject({ level: 'warn', msg: 'accounts failing', area: 'accounts', fields: { key: 'account:acc-9', accountId: 'acc-9', code: 'invalid_grant' } });
    expect(rec?.tags).toEqual(expect.arrayContaining(['accounts', 'health']));
    tracker.close();
  });
});

describe('outcomeFromError', () => {
  const NOW = Date.now();
  const withCause = (err: Error, cause: unknown): Error => Object.assign(err, { cause });

  it.each<[string, unknown, string, number | undefined]>([
    [
      'ProviderHttpError api_disabled',
      new ProviderHttpError(403, 'forbidden', { message: 'The Calendar API is not enabled', accountId: 'a', providerReason: 'PERMISSION_DENIED accessNotConfigured SERVICE_DISABLED', denial: 'api_disabled' }),
      'api_disabled',
      undefined,
    ],
    [
      'ProviderHttpError insufficient_scope',
      new ProviderHttpError(403, 'forbidden', { message: 'x', accountId: 'a', providerReason: null, denial: 'insufficient_scope' }),
      'insufficient_scope',
      undefined,
    ],
    ['ProviderHttpError rate_limited', new ProviderHttpError(429, 'rate_limited', { message: 'x', accountId: 'a', providerReason: 'rateLimitExceeded' }), 'rate_limited', undefined],
    [
      'ProviderHttpError provider_error 400',
      new ProviderHttpError(502, 'provider_error', { message: 'Google rejected the request', accountId: 'a', providerReason: null, upstreamStatus: 400 }),
      'http_4xx',
      400,
    ],
    ['Todoist token_rejected (details.reason)', new HttpError(409, 'not_configured', 'Todoist rejected the saved API token.', { reason: 'token_rejected', upstreamStatus: 401 }), 'token_rejected', 401],
    ['SafeFetchError timeout', new SafeFetchError('timeout', 'Request to api.todoist.com timed out', 'api.todoist.com'), 'timeout', undefined],
    ['SafeFetchError dns', new SafeFetchError('network', 'Could not reach x.example', 'x.example', withCause(new TypeError('fetch failed'), errnoError('ENOTFOUND'))), 'dns', undefined],
    ['SafeFetchError EAI_AGAIN', new SafeFetchError('network', 'Could not reach x.example', 'x.example', errnoError('EAI_AGAIN')), 'dns', undefined],
    [
      'SafeFetchError tls',
      new SafeFetchError('network', 'Could not reach x.example', 'x.example', withCause(new TypeError('fetch failed'), errnoError('CERT_HAS_EXPIRED'))),
      'tls',
      undefined,
    ],
    ['SafeFetchError self-signed', new SafeFetchError('network', 'm', 'h', errnoError('DEPTH_ZERO_SELF_SIGNED_CERT')), 'tls', undefined],
    [
      'SafeFetchError untrusted issuer (HTTPS-inspecting proxy)',
      new SafeFetchError('network', 'Could not reach x.example', 'x.example', withCause(new TypeError('fetch failed'), errnoError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))),
      'tls',
      undefined,
    ],
    ['SafeFetchError invalid CA', new SafeFetchError('network', 'm', 'h', withCause(new TypeError('fetch failed'), errnoError('INVALID_CA'))), 'tls', undefined],
    ['SafeFetchError bad certificate date field', new SafeFetchError('network', 'm', 'h', errnoError('ERROR_IN_CERT_NOT_AFTER_FIELD')), 'tls', undefined],
    ['SafeFetchError TLS alert', new SafeFetchError('network', 'm', 'h', errnoError('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION')), 'tls', undefined],
    ['SafeFetchError refused', new SafeFetchError('network', 'm', 'h', withCause(new TypeError('fetch failed'), errnoError('ECONNREFUSED'))), 'refused', undefined],
    ['SafeFetchError reset', new SafeFetchError('network', 'm', 'h', errnoError('ECONNRESET')), 'reset', undefined],
    ['SafeFetchError undici socket', new SafeFetchError('network', 'm', 'h', withCause(new TypeError('fetch failed'), errnoError('UND_ERR_SOCKET'))), 'reset', undefined],
    ['SafeFetchError network', new SafeFetchError('network', 'Could not reach h', 'h'), 'network', undefined],
    ['SafeFetchError not_lan', new SafeFetchError('blocked', 'nas.lan is no longer a local network address', 'nas.lan', new NotPrivateAddressError('nas.lan')), 'not_lan', undefined],
    ['SafeFetchError blocked', new SafeFetchError('blocked', 'Private or reserved addresses cannot be fetched', 'h'), 'blocked', undefined],
    ['SafeFetchError too_large', new SafeFetchError('too_large', 'Response from h exceeds 10 bytes', 'h'), 'too_large', undefined],
    ['SafeFetchError invalid_json', new SafeFetchError('invalid_json', 'Invalid JSON from h', 'h'), 'parse_error', undefined],
    ['SafeFetchError redirect', new SafeFetchError('redirect', 'Too many redirects from h', 'h'), 'redirect', undefined],
    ['VaultLockedError', new VaultLockedError(), 'vault_locked', undefined],
    ['reauth_required', new HttpError(409, 'reauth_required', { message: 'Reconnect required', accountId: 'a' }), 'reauth_required', undefined],
    ['upstream_timeout', new HttpError(504, 'upstream_timeout'), 'timeout', undefined],
    ['not_configured', new HttpError(409, 'not_configured', 'Set up Todoist first'), 'not_configured', undefined],
    ['rate_limited', new HttpError(429, 'rate_limited'), 'rate_limited', undefined],
    ['provider_error 503 (details.status)', new HttpError(502, 'provider_error', 'x', { status: 503 }), 'http_5xx', 503],
    ['provider_error without status', new HttpError(502, 'provider_error', 'The provider returned an unexpected response'), 'internal', undefined],
    ['DavHttpError 404', new DavHttpError(404, 'The CalDAV server could not find the calendar'), 'not_found', 404],
    ['DavHttpError 500', new DavHttpError(500, 'The CalDAV server returned an error'), 'http_5xx', 500],
    ['DavHttpError 401', new DavHttpError(401, 'The CalDAV server rejected the credentials'), 'auth_failed', 401],
    ['TodoistRateLimitError', new TodoistRateLimitError(12), 'rate_limited', undefined],
    ['NotAFeedError', new NotAFeedError('Not a feed'), 'not_a_feed', undefined],
    ['XmlError', new XmlError('Unexpected end'), 'parse_error', undefined],
    ['DavParseError limit', new DavParseError('limit', 'The CalDAV response is too large'), 'too_large', undefined],
    ['DavParseError timeout', new DavParseError('timeout', 'x'), 'timeout', undefined],
    ['ExpandError error', new ExpandError('error', 'The calendar could not be expanded'), 'worker_failed', undefined],
    ['ExpandError invalid', new ExpandError('invalid', 'x'), 'parse_error', undefined],
    ['SuggestUpstreamError', new SuggestUpstreamError(502), 'http_5xx', 502],
    ['ImapAuthError', new ImapAuthError('Login failed for me@example.com'), 'auth_failed', undefined],
    ['ImapOpError not_found', new ImapOpError(404, 'not_found', 'Mailbox missing'), 'not_found', undefined],
    ['plain errno', errnoError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.2:993'), 'refused', undefined],
    ['plain ETIMEDOUT', errnoError('ETIMEDOUT'), 'timeout', undefined],
    ['plain Error', new Error('boom'), 'internal', undefined],
    ['non-error', 'just a string', 'internal', undefined],
  ])('%s → %s', (_name, err, code, status) => {
    const outcome = outcomeFromError(err);
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(code);
    expect(outcome.status).toBe(status);
  });

  it('uses Homebase-authored messages only and the loggable error fields as detail', () => {
    const fromHttp = outcomeFromError(new SafeFetchError('timeout', 'Request to api.todoist.com timed out', 'api.todoist.com'));
    expect(fromHttp.message).toBe('Request to api.todoist.com timed out');
    expect(fromHttp.detail).toEqual({ errCode: 'upstream_timeout', errReason: 'timeout', host: 'api.todoist.com' });

    const fromLibrary = outcomeFromError(new ImapAuthError('Invalid credentials for me@example.com (password=hunter2)'));
    expect(fromLibrary.message).toBe('ImapAuthError');
    expect(JSON.stringify(fromLibrary)).not.toMatch(/example\.com|hunter2/);
    expect(outcomeFromError(new TypeError('fetch failed: token=abc')).message).toBe('TypeError');
    expect(outcomeFromError(new ExpandError('limit', 'Too many instances')).message).toBe('Too many instances');

    const provider = outcomeFromError(
      new ProviderHttpError(403, 'forbidden', { message: 'The Calendar API is not enabled', accountId: 'a', providerReason: 'PERMISSION_DENIED accessNotConfigured <script> SERVICE_DISABLED', denial: 'api_disabled' }),
    );
    expect(provider.detail).toEqual({
      errCode: 'forbidden',
      errReason: 'api_disabled',
      providerReason: 'PERMISSION_DENIED:accessNotConfigured:SERVICE_DISABLED',
    });

    const chained = outcomeFromError(new SafeFetchError('network', 'Could not reach x.example', 'x.example', withCause(new TypeError('fetch failed'), errnoError('ECONNREFUSED'))));
    expect(chained.detail).toEqual({ errCode: 'provider_error', errReason: 'network', host: 'x.example', causeCode: 'ECONNREFUSED' });
  });

  it('turns Retry-After into nextAttemptAt; extra overrides and its detail merges', () => {
    const limited = outcomeFromError(
      new ProviderHttpError(429, 'rate_limited', { message: 'Google is rate limiting requests', accountId: 'a', providerReason: 'rateLimitExceeded', retryAfterSeconds: 30 }),
    );
    expect(limited.detail).toMatchObject({ retryAfterSeconds: 30, providerReason: 'rateLimitExceeded' });
    expect(limited.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 30_000);
    expect(limited.nextAttemptAt).toBeLessThan(Date.now() + 31_000);

    const overridden = outcomeFromError(new SafeFetchError('timeout', 'Request to h timed out', 'h'), {
      code: 'account_unavailable',
      causeKey: 'account:a',
      severity: 'info',
      detail: { stage: 'list' },
      nextAttemptAt: 5,
    });
    expect(overridden).toMatchObject({ ok: false, code: 'account_unavailable', causeKey: 'account:a', severity: 'info', nextAttemptAt: 5 });
    expect(overridden.detail).toEqual({ errCode: 'upstream_timeout', errReason: 'timeout', host: 'h', stage: 'list' });
  });
});

describe('contextFieldForKey', () => {
  it.each<[string, ReturnType<typeof contextFieldForKey>]>([
    ['account:acc-1', { field: 'accountId', value: 'acc-1' }],
    ['mail:acc-1', { field: 'accountId', value: 'acc-1' }],
    ['calendar-list:acc-1', { field: 'accountId', value: 'acc-1' }],
    ['calendar:cal:with:colons', { field: 'calendarId', value: 'cal:with:colons' }],
    ['ics:c2', { field: 'calendarId', value: 'c2' }],
    ['feed:0123456789', { field: 'feed', value: '0123456789' }],
    ['job:calendar:account-sync', { field: 'job', value: 'calendar:account-sync' }],
    ['todoist', { area: 'todoist' }],
    ['weather', { area: 'weather' }],
    ['suggest:google', { area: 'search' }],
    ['something-else', { area: 'server' }],
  ])('%s', (key, expected) => {
    expect(contextFieldForKey(key)).toEqual(expected);
  });
});
