/**
 * Pure helpers of Settings → Diagnostics: formatting (durations, sizes, local time with its
 * offset, the supervisor's last exit), a server without diagnostics, the link to the diagnostics
 * page on this PC, the answers-without-CORS hint with this site's address, whether the server
 * takes debug events, a remedy for every health code, the health grouping and its order, when a
 * last error is still the problem, "Run now" targets and the related-log window.
 */
import { HEALTH_CODES } from '@portly/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.ts';
import {
  answersWithoutCors,
  areaLabel,
  describeLastExit,
  diagnosticsUnavailable,
  escapeUnsafeJson,
  formatBytes,
  formatDuration,
  localDiagnosticsUrl,
  localTimeWithOffset,
  logTime,
  takesDebugEvents,
  thisSiteAddress,
} from './format.ts';
import { countByStatus, groupHealth, jobToRun, lastErrorIsCurrent, relatedLogWindow, skippedReason } from './health.ts';
import { HEALTH_REMEDIES, remedyFor } from './remedies.ts';
import { diagnosticsSummary, healthEntry, jobInfo, T0 } from './testing.ts';

describe('format', () => {
  it('escapes the characters JSON leaves raw that could reorder or hide text (still the same JSON)', () => {
    const odd = ['a', 0x202e, 'b', 0x2066, 'c', 0x85, 'd', 0x2028, 'e', 0x200f, 'f']
      .map((part) => (typeof part === 'number' ? String.fromCharCode(part) : part))
      .join('');
    const json = escapeUnsafeJson(JSON.stringify({ msg: odd, plain: 'é ü 漢字' }));
    expect(json).toBe('{"msg":"a' + ['202e', '2066', '0085', '2028', '200f'].map((hex, i) => `\\u${hex}${'bcdef'[i]}`).join('') + '","plain":"é ü 漢字"}');
    expect(JSON.parse(json)).toEqual({ msg: odd, plain: 'é ü 漢字' });
  });

  it('formats durations with their two largest units', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000 + 5_000)).toBe('3 h 12 min');
    expect(formatDuration(3_600_000)).toBe('1 h');
    expect(formatDuration(2 * 86_400_000 + 5 * 60_000)).toBe('2 d');
    expect(formatDuration(-1)).toBe('');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12_595)).toBe('12.3 KB');
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB');
  });

  it('writes the local time with its UTC offset, and log times to the millisecond', () => {
    const date = new Date(2026, 9, 11, 14, 32, 5, 7);
    const text = localTimeWithOffset(date);
    expect(text).toMatch(/^2026-10-11 14:32:05 UTC[+-]\d{2}:\d{2}$/);
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    expect(text.endsWith(`${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`)).toBe(true);
    expect(logTime(date.toISOString())).toBe('14:32:05.007');
    expect(logTime('not a date')).toBe('');
  });

  it('describes the last exit the supervisor reported (JSON with the start-up failure, or text)', () => {
    expect(describeLastExit(null)).toBeNull();
    expect(describeLastExit(JSON.stringify({ code: 1, signal: null }))).toBe('exit code 1');
    expect(
      describeLastExit(JSON.stringify({ code: 1, signal: null, failure: { type: 'startup-failed', phase: 'db', errName: 'Error', sqliteCode: 'SQLITE_BUSY', message: 'database is locked' } })),
    ).toBe('exit code 1, start-up failed (db): Error [SQLITE_BUSY]: database is locked');
    expect(describeLastExit(JSON.stringify({ code: null, signal: 'SIGKILL' }))).toBe('signal SIGKILL');
    expect(describeLastExit('exited with 3221225786')).toBe('exited with 3221225786');
  });

  it('names areas, and keeps an area a newer server adds', () => {
    expect(areaLabel('client')).toBe('Browser events');
    expect(areaLabel('fetch')).toBe('Outbound requests');
    expect(areaLabel('future-area')).toBe('future-area');
  });

  it('treats a summary answered 403 local_only or 404 as "no diagnostics on this server"', () => {
    expect(diagnosticsUnavailable(new ApiError(403, 'local_only', 'Local only'))).toBe(true);
    expect(diagnosticsUnavailable(new ApiError(404, 'not_found', 'Not found'))).toBe(true);
    expect(diagnosticsUnavailable(new ApiError(403, 'forbidden', 'Forbidden'))).toBe(false);
    expect(diagnosticsUnavailable(new ApiError(0, 'network_error', 'down'))).toBe(false);
    expect(diagnosticsUnavailable(new Error('x'))).toBe(false);
  });

  it('links to the diagnostics page of Portly on this PC (the default origin when the build has none)', () => {
    expect(localDiagnosticsUrl('http://127.0.0.1:5757')).toBe('http://127.0.0.1:5757/#/settings/diagnostics');
    expect(localDiagnosticsUrl('http://localhost:6000/')).toBe('http://localhost:6000/#/settings/diagnostics');
    expect(localDiagnosticsUrl('')).toBe('http://127.0.0.1:5757/#/settings/diagnostics');
  });

  it('reads the answers-without-CORS hint from the local server state', () => {
    expect(answersWithoutCors({ status: 'absent', unreachableReason: 'answers-without-cors' })).toBe(true);
    expect(answersWithoutCors({ status: 'absent', unreachableReason: null })).toBe(false);
    expect(answersWithoutCors({ status: 'absent' })).toBe(false);
    expect(answersWithoutCors({ status: 'connected', unreachableReason: 'answers-without-cors' })).toBe(false);
  });

  it('gives this site’s address with its base path (what PORTLY_PAGES_URL must be)', () => {
    expect(thisSiteAddress('https://dana.github.io', '/portly/')).toBe('https://dana.github.io/portly/');
    expect(thisSiteAddress('https://dana.github.io', '/')).toBe('https://dana.github.io/');
  });

  it('knows when the server keeps debug events from browsers (verbose covering client)', () => {
    expect(takesDebugEvents({ verbose: true, areas: null })).toBe(true);
    expect(takesDebugEvents({ verbose: true, areas: ['client', 'mail'] })).toBe(true);
    expect(takesDebugEvents({ verbose: true, areas: ['mail'] })).toBe(false);
    expect(takesDebugEvents({ verbose: false, areas: null })).toBe(false);
  });
});

describe('remedies', () => {
  it('has a one-line remedy and a troubleshooting anchor for every health code', () => {
    for (const code of HEALTH_CODES) {
      const remedy = remedyFor(code);
      expect(remedy, code).not.toBeNull();
      expect(remedy!.anchor).toBe(`troubleshooting.md#${code}`);
      expect(remedy!.remedy).not.toContain('\n');
      expect(remedy!.remedy.length).toBeLessThanOrEqual(160);
    }
    expect(Object.keys(HEALTH_REMEDIES).sort()).toEqual([...HEALTH_CODES].sort());
  });

  it('has none for a code this version does not know', () => {
    expect(remedyFor('some_provider_tag')).toBeNull();
    expect(remedyFor(null)).toBeNull();
  });

  it('fits the subject: a rejected token is Todoist’s API token, or an account to reconnect', () => {
    expect(remedyFor('token_rejected', 'todoist')!.remedy).toMatch(/Settings → Todoist/);
    for (const key of ['account:g1', 'calendar-list:g1', 'calendar:cal-1', 'mail:m1']) {
      const remedy = remedyFor('token_rejected', key)!;
      expect(remedy.remedy, key).toMatch(/Reconnect the account in Settings → Accounts/);
      expect(remedy.remedy, key).not.toMatch(/Todoist/);
      expect(remedy.anchor).toBe('troubleshooting.md#token_rejected');
      expect(remedy.remedy.length).toBeLessThanOrEqual(160);
    }
    // Other codes read the same everywhere.
    expect(remedyFor('rate_limited', 'account:g1')!.remedy).toBe(HEALTH_REMEDIES.rate_limited);
  });
});

describe('groupHealth', () => {
  const summary = diagnosticsSummary({
    jobs: [jobInfo('calendar:sync'), jobInfo('calendar:ics'), jobInfo('core:backup', { lastOk: null, lastFinishedAt: null, runs: 0 })],
    health: [
      healthEntry('weather'),
      healthEntry('mail:acc-1', { accountId: 'acc-1', label: 'Work' }),
      healthEntry('calendar:cal-1', { accountId: 'acc-1', label: 'Personal', status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:acc-1' }),
      healthEntry('account:acc-1', { accountId: 'acc-1', label: 'Work', status: 'failing', lastCode: 'invalid_grant' }),
      healthEntry('calendar-list:acc-1', { accountId: 'acc-1', label: 'Work' }),
      healthEntry('account:acc-2', { accountId: 'acc-2', label: 'Home' }),
      healthEntry('feed:abc123', { label: 'example.com', status: 'stale' }),
      healthEntry('ics:cal-9', { label: 'Holidays' }),
      healthEntry('job:calendar:sync', { label: 'calendar:sync' }),
      healthEntry('todoist'),
      healthEntry('suggest:google'),
      healthEntry('sports:nfl', { label: 'NFL' }),
      healthEntry('mystery'),
    ],
  });

  it('groups by account (account, calendar list, calendars, mail) then by area, attention first', () => {
    const groups = groupHealth(summary, (id) => (id === 'acc-3' ? 'Other' : null));
    expect(groups.map((g) => g.title)).toEqual(['Work', 'Feeds', 'Home', 'ICS calendars', 'Todoist', 'Weather', 'Search suggestions', 'Sports', 'Scheduled jobs', 'Other']);
    const work = groups[0]!;
    expect(work.attention).toBe(true);
    expect(work.items.map((i) => i.key)).toEqual(['account:acc-1', 'calendar:cal-1', 'calendar-list:acc-1', 'mail:acc-1']);
    expect(groups.find((g) => g.title === 'Feeds')!.attention).toBe(true);
  });

  it('lists every scheduled job, joined with its health entry (never run: not checked yet)', () => {
    const jobs = groupHealth(summary).find((g) => g.title === 'Scheduled jobs')!;
    expect(jobs.items.map((i) => [i.key, i.status, i.entry === null, i.job?.name])).toEqual([
      ['job:core:backup', 'unknown', true, 'core:backup'],
      ['job:calendar:ics', 'ok', true, 'calendar:ics'],
      ['job:calendar:sync', 'ok', false, 'calendar:sync'],
    ]);
  });

  it('names an account without its own entry from the accounts list, else by id', () => {
    const groups = groupHealth(diagnosticsSummary({ jobs: [], health: [healthEntry('mail:acc-3', { accountId: 'acc-3' }), healthEntry('mail:acc-4', { accountId: 'acc-4' })] }), (id) =>
      id === 'acc-3' ? 'Family' : null,
    );
    expect(groups.map((g) => g.title)).toEqual(['acc-4', 'Family']);
  });

  it('counts by status', () => {
    expect(countByStatus(summary.health)).toEqual({ ok: 10, degraded: 0, failing: 2, stale: 1, unknown: 0 });
  });

  it('treats the last error as the problem only while it lasts (not after a recovery, when it went stale)', () => {
    expect(lastErrorIsCurrent(healthEntry('feed:a', { status: 'failing', lastCode: 'http_error' }))).toBe(true);
    expect(lastErrorIsCurrent(healthEntry('feed:a', { status: 'degraded', lastCode: 'partial' }))).toBe(true);
    // Stale while failing: failingSince stays set.
    expect(lastErrorIsCurrent(healthEntry('feed:a', { status: 'stale', lastCode: 'http_error', failingSince: T0 }))).toBe(true);
    // Recovered (failingSince cleared), then stale: the code is history.
    expect(lastErrorIsCurrent(healthEntry('feed:a', { status: 'stale', lastCode: 'rate_limited', failingSince: null }))).toBe(false);
  });
});

describe('jobToRun, skippedReason, relatedLogWindow', () => {
  const jobs = [{ name: 'calendar:sync' }, { name: 'calendar:ics' }, { name: 'accounts:oauth-states-purge' }];

  it('runs a job itself, or the job that syncs a subject — only when the server has that job', () => {
    expect(jobToRun('job:calendar:ics', jobs)).toBe('calendar:ics');
    expect(jobToRun('job:gone', jobs)).toBeNull();
    expect(jobToRun('calendar:cal-1', jobs)).toBe('calendar:sync');
    expect(jobToRun('calendar-list:acc-1', jobs)).toBe('calendar:sync');
    expect(jobToRun('ics:cal-9', jobs)).toBe('calendar:ics');
    expect(jobToRun('ics:cal-9', [{ name: 'calendar:sync' }])).toBeNull();
    // An account is not synced by the OAuth state purge, though both are in the accounts area.
    expect(jobToRun('account:acc-1', jobs)).toBeNull();
    expect(jobToRun('feed:abc', jobs)).toBeNull();
  });

  it('says why a check was skipped', () => {
    expect(skippedReason(healthEntry('ics:1', { detail: { skipped: 'vault_locked' } }))).toBe('saved credentials are locked');
    expect(skippedReason(healthEntry('ics:1', { detail: { skipped: 'something_new' } }))).toBe('something_new');
    expect(skippedReason(healthEntry('ics:1'))).toBeNull();
  });

  it('centers the related-log window on the last failure (± 1 h)', () => {
    expect(relatedLogWindow(healthEntry('x', { lastFailAt: T0 }))).toEqual({ since: '2026-10-11T11:00:00.000Z', before: '2026-10-11T13:00:00.000Z' });
    expect(relatedLogWindow(healthEntry('x'))).toBeNull();
    expect(relatedLogWindow(null)).toBeNull();
  });
});
