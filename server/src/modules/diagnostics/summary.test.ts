import { describe, expect, it } from 'vitest';
import { HealthEntrySchema, JobInfoSchema, LogLevelStateSchema, OutcomeRowSchema, type Account } from '@portly/shared';
import type { HealthState } from '../../lib/health.ts';
import type { JobStats, ManualJobInfo } from '../../lib/scheduler.ts';
import {
  healthEntries,
  healthStatus,
  isoOr,
  isoOrNull,
  jobLateness,
  resolveLabel,
  subjectJob,
  toJobInfo,
  toLogLevelState,
  toOutcomeRow,
  withAccountStatusEntries,
  type LabelSources,
} from './summary.ts';

const T0 = Date.parse('2026-10-11T09:00:00.000Z');
const MIN = 60_000;

function state(patch: Partial<HealthState> = {}): HealthState {
  return {
    key: 'calendar:c1',
    area: 'calendar',
    label: null,
    accountId: null,
    status: 'ok',
    lastOkAt: T0,
    lastFailAt: null,
    failingSince: null,
    lastCheckedAt: T0,
    expectEveryMs: 30 * MIN,
    consecutiveFailures: 0,
    lastCode: null,
    lastStatus: null,
    lastMessage: null,
    lastMs: 12.4,
    detail: { mode: 'delta', fetched: 3 },
    causeKey: null,
    nextAttemptAt: null,
    updatedAt: T0,
    ...patch,
  };
}

function job(patch: Partial<JobStats> = {}): JobStats {
  return {
    name: 'calendar:sync',
    intervalMs: 10 * MIN,
    nextRunAt: T0 + 10 * MIN,
    running: false,
    runningSince: null,
    stuckForMs: null,
    overdue: false,
    runs: 3,
    failures: 1,
    consecutiveFailures: 0,
    lastStartedAt: T0 - MIN,
    lastFinishedAt: T0,
    lastMs: 250,
    lastOk: true,
    lastError: null,
    ...patch,
  };
}

const SOURCES: LabelSources = {
  accounts: new Map([['g1', 'Work Google']]),
  calendars: new Map([['c1', 'Family planner']]),
};

describe('diagnostics summary helpers', () => {
  it('isoOrNull keeps times a 4-digit-year ISO string can show', () => {
    expect(isoOrNull(T0)).toBe('2026-10-11T09:00:00.000Z');
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(Number.NaN)).toBeNull();
    expect(isoOrNull(-1)).toBeNull();
    expect(isoOrNull(8.64e15)).toBeNull();
    expect(isoOrNull(253_402_300_799_999)).toBe('9999-12-31T23:59:59.999Z');
    expect(isoOr(null, T0)).toBe('2026-10-11T09:00:00.000Z');
  });

  it('resolves labels at read time: account label, calendar name, job or league name, else the stored label', () => {
    expect(resolveLabel('sports:epl', null, SOURCES)).toBe('Premier League');
    expect(resolveLabel('sports:nfl', 'NFL', SOURCES)).toBe('NFL');
    expect(resolveLabel('sports:gone', 'stored', SOURCES)).toBe('stored');
    expect(resolveLabel('account:g1', null, SOURCES)).toBe('Work Google');
    expect(resolveLabel('mail:g1', null, SOURCES)).toBe('Work Google');
    expect(resolveLabel('calendar-list:g1', null, SOURCES)).toBe('Work Google');
    expect(resolveLabel('account:gone', 'stored', SOURCES)).toBe('stored');
    expect(resolveLabel('calendar:c1', null, SOURCES)).toBe('Family planner');
    expect(resolveLabel('ics:c1', 'ics.example.net', SOURCES)).toBe('Family planner');
    expect(resolveLabel('ics:gone', 'ics.example.net', SOURCES)).toBe('ics.example.net');
    expect(resolveLabel('job:calendar:sync', null, SOURCES)).toBe('calendar:sync');
    expect(resolveLabel('feed:0123456789', 'blog.example.org', SOURCES)).toBe('blog.example.org');
    expect(resolveLabel('todoist', null, SOURCES)).toBeNull();
    expect(resolveLabel('account:', 'x', SOURCES)).toBe('x');
  });

  describe('stale', () => {
    const NO_JOBS = jobLateness([]);

    it('a job-driven subject is stale once no check came within expectEveryMs', () => {
      const s = state();
      expect(healthStatus(s, T0 + 30 * MIN, NO_JOBS)).toBe('ok');
      expect(healthStatus(s, T0 + 30 * MIN + 1, NO_JOBS)).toBe('stale');
      expect(healthStatus(state({ status: 'failing' }), T0 + 31 * MIN, NO_JOBS)).toBe('stale');
      expect(healthStatus(state({ status: 'degraded' }), T0 + MIN, NO_JOBS)).toBe('degraded');
    });

    it('maps each subject to the job that checks it, by area only when the area has one job', () => {
      const lateness = jobLateness([
        job(),
        job({ name: 'calendar:ics', overdue: true }),
        job({ name: 'mail:poll', stuckForMs: 5 * MIN }),
        job({ name: 'core:backup' }),
        job({ name: 'core:uploads-gc' }),
      ]);
      expect([...lateness.late]).toEqual(['calendar:ics', 'mail:poll']);
      const of = (key: string, area: string) => subjectJob(key, area, lateness.byArea);
      expect(of('job:calendar:ics', 'calendar')).toBe('calendar:ics');
      expect(of('job:core:backup', 'core')).toBe('core:backup');
      expect(of('calendar:c1', 'calendar')).toBe('calendar:sync');
      expect(of('calendar-list:g1', 'calendar')).toBe('calendar:sync');
      expect(of('ics:c2', 'calendar')).toBe('calendar:ics');
      expect(of('mail:g1', 'mail')).toBe('mail:poll');
      expect(of('core-thing', 'core')).toBeNull();
      expect(of('constructor:x', 'weather')).toBeNull();
      expect(of('job:', 'calendar')).toBeNull();
    });

    it('a late job makes only its own ok subjects stale', () => {
      const lateness = jobLateness([job(), job({ name: 'calendar:ics', overdue: true })]);
      expect(healthStatus(state({ key: 'ics:c2' }), T0 + MIN, lateness)).toBe('stale');
      expect(healthStatus(state(), T0 + MIN, lateness)).toBe('ok');
      // Failing and degraded subjects keep their status: the code says more than "stale".
      expect(healthStatus(state({ key: 'ics:c2', status: 'failing' }), T0 + MIN, lateness)).toBe('failing');
      expect(healthStatus(state({ key: 'ics:c2', status: 'degraded' }), T0 + MIN, lateness)).toBe('degraded');
    });

    it('on-demand subjects are never stale and unchecked ones stay unknown', () => {
      const lateness = jobLateness([job({ name: 'weather', overdue: true }), job({ stuckForMs: 5 * MIN })]);
      expect(healthStatus(state({ key: 'weather', area: 'weather', expectEveryMs: null }), T0 + 1e9, lateness)).toBe('ok');
      expect(healthStatus(state({ status: 'unknown', lastCheckedAt: null }), T0 + 1e9, lateness)).toBe('unknown');
    });
  });

  it('converts health states to schema-valid entries with labels and derived status', () => {
    const entries = healthEntries(
      [
        state(),
        state({ key: 'account:g1', area: 'accounts', accountId: 'g1', status: 'failing', lastCode: 'invalid_grant', failingSince: T0, lastFailAt: T0, consecutiveFailures: 2, expectEveryMs: null, detail: null }),
        state({ key: 'job:calendar:sync', label: 'calendar:sync', lastCheckedAt: T0 - 31 * MIN, expectEveryMs: 30 * MIN }),
      ],
      SOURCES,
      [job()],
      T0 + MIN,
    );
    expect(entries.map((e) => [e.key, e.label, e.status])).toEqual([
      ['calendar:c1', 'Family planner', 'ok'],
      ['account:g1', 'Work Google', 'failing'],
      ['job:calendar:sync', 'calendar:sync', 'stale'],
    ]);
    expect(entries[0]).toMatchObject({ lastMs: 12, lastOkAt: '2026-10-11T09:00:00.000Z', detail: { mode: 'delta', fetched: 3 } });
    for (const entry of entries) expect(HealthEntrySchema.parse(entry)).toEqual(entry);
  });

  it('leaves out feeds and suggestion providers nothing checked for a day (e.g. a feed removed from its widget)', () => {
    const DAY = 24 * 60 * MIN;
    const failingFeed = { area: 'feeds', status: 'failing' as const, lastCode: 'not_a_feed', expectEveryMs: null };
    const entries = healthEntries(
      [
        state({ key: 'feed:aaaaaaaaaa', ...failingFeed, lastCheckedAt: T0 - DAY - MIN }),
        state({ key: 'feed:bbbbbbbbbb', ...failingFeed, lastCheckedAt: T0 - DAY + MIN }),
        state({ key: 'suggest:google', area: 'search', expectEveryMs: null, lastCheckedAt: null, updatedAt: T0 - 2 * DAY }),
        state({ key: 'account:g1', area: 'accounts', accountId: 'g1', status: 'failing', expectEveryMs: null, lastCheckedAt: T0 - 9 * DAY }),
      ],
      SOURCES,
      [],
      T0,
    );
    // An account in reauth is not re-checked until the user acts: it must stay listed however old.
    expect(entries.map((e) => e.key)).toEqual(['feed:bbbbbbbbbb', 'account:g1']);
  });

  it('lists accounts that need attention but have no subject of their own from their stored status', () => {
    const account = (patch: Partial<Account>): Account => ({
      id: 'g1',
      kind: 'google',
      label: 'Work Google',
      email: null,
      color: null,
      capabilities: [],
      enabledCapabilities: [],
      status: 'ok',
      statusMessage: null,
      sort: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...patch,
    });
    const recorded = healthEntries([state({ key: 'account:a0', area: 'accounts', accountId: 'a0' }), state({ key: 'mail:g1', area: 'mail', accountId: 'g1' })], SOURCES, [], T0);
    const accounts = [
      account({ id: 'a0', status: 'reauth' }), // has a subject: left alone
      account({ id: 'g1', status: 'reauth', statusMessage: `Reconnect\n${String.fromCharCode(0x202e)}now`, updatedAt: 'not a date' }),
      account({ id: 'k1' }), // ok: nothing to say
    ];
    expect(withAccountStatusEntries(recorded, accounts, 'ready', T0).map((e) => [e.key, e.status, e.lastCode])).toEqual([
      ['account:a0', 'ok', null],
      ['account:g1', 'failing', 'reauth_required'],
      ['mail:g1', 'ok', null],
    ]);
    const locked = withAccountStatusEntries(recorded, accounts, 'locked', T0);
    expect(locked[1]).toMatchObject({ lastCode: 'vault_locked', lastMessage: 'Reconnect now', updatedAt: '2026-10-11T09:00:00.000Z', area: 'accounts', accountId: 'g1' });
    for (const entry of locked) expect(HealthEntrySchema.parse(entry)).toEqual(entry);
    expect(withAccountStatusEntries(recorded, [account({ id: 'k1' })], 'ready', T0)).toEqual(recorded);
  });

  it('a stuck job of an area with two jobs leaves the other job and its subjects alone', () => {
    const checked = T0 + 39 * MIN;
    const entries = healthEntries(
      [
        state({ lastCheckedAt: checked }),
        state({ key: 'calendar:c2', status: 'failing', lastCode: 'reauth_required', failingSince: T0, lastFailAt: checked, lastCheckedAt: checked }),
        state({ key: 'calendar-list:g1', accountId: 'g1', lastCheckedAt: checked }),
        state({ key: 'ics:c3', lastCheckedAt: checked, expectEveryMs: 90 * MIN }),
        state({ key: 'job:calendar:sync', label: 'calendar:sync', lastCheckedAt: checked }),
        state({ key: 'job:calendar:ics', label: 'calendar:ics', lastCheckedAt: T0, expectEveryMs: 90 * MIN }),
      ],
      SOURCES,
      [job({ lastFinishedAt: checked }), job({ name: 'calendar:ics', intervalMs: 30 * MIN, running: true, runningSince: T0, stuckForMs: 40 * MIN, nextRunAt: null })],
      T0 + 40 * MIN,
    );
    expect(entries.map((e) => [e.key, e.status])).toEqual([
      ['calendar:c1', 'ok'],
      ['calendar:c2', 'failing'],
      ['calendar-list:g1', 'ok'],
      ['ics:c3', 'stale'],
      ['job:calendar:sync', 'ok'],
      ['job:calendar:ics', 'stale'],
    ]);
  });

  it('converts jobs (manual scheduler extras dropped), outcome rows and the level state', () => {
    const manual: ManualJobInfo = { ...job({ lastError: { name: 'HttpError', code: null, message: 'Google answered HTTP 500' } }), dueAt: 5, stopped: false };
    const info = toJobInfo(manual);
    expect(info).not.toHaveProperty('dueAt');
    expect(info.lastError).toEqual({ name: 'HttpError', code: null, message: 'Google answered HTTP 500' });
    expect(JobInfoSchema.parse(info)).toEqual(info);

    const row = toOutcomeRow({ id: 7, key: 'todoist', at: T0, lastAt: T0 + MIN, count: 2, ok: false, status: 'failing', code: 'token_rejected', httpStatus: 401, message: 'Todoist rejected the token', ms: 80, detail: { errReason: 'AUTH_INVALID_TOKEN' } });
    expect(row).toMatchObject({ at: '2026-10-11T09:00:00.000Z', lastAt: '2026-10-11T09:01:00.000Z', count: 2 });
    expect(OutcomeRowSchema.parse(row)).toEqual(row);

    const timed = toLogLevelState({ level: 'debug', verbose: true, until: T0, areas: ['calendar'], bootLevel: 'info' });
    expect(timed).toEqual({ level: 'debug', verbose: true, until: '2026-10-11T09:00:00.000Z', areas: ['calendar'], bootLevel: 'info', persisted: true });
    expect(LogLevelStateSchema.parse(timed)).toEqual(timed);
    expect(toLogLevelState({ level: 'debug', verbose: true, until: null, areas: null, bootLevel: 'info' }).persisted).toBe(false);
    expect(toLogLevelState({ level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info' }).persisted).toBe(false);
  });
});
