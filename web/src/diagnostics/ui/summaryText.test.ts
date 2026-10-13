/**
 * Copy summary: at most 40 lines in the template's order — generated-at with the UTC offset, the
 * server, this page (with version skew), log level, vault, modules down, Pages origin and foreign
 * origins, overdue/stuck jobs, health counts and every subject that is not OK (a stale one's last
 * error only while it lasts), the last distinct server warnings/errors with their counts, the last
 * browser warnings/errors — and redactable with the sharing dictionary.
 */
import { redactForSharing } from '@homebase/shared';
import { describe, expect, it } from 'vitest';
import { getClientEvents, recordClientEvent } from '../clientLog.ts';
import { sharingDictionary } from './report.ts';
import { SUMMARY_MAX_LINES, buildSummaryText, type SummaryTextInput } from './summaryText.ts';
import { diagnosticsSummary, healthEntry, jobInfo, logRecord } from './testing.ts';

const NOW = new Date(2026, 9, 11, 14, 32, 5);

function input(patch: Partial<SummaryTextInput> = {}): SummaryTextInput {
  return {
    now: NOW,
    summary: diagnosticsSummary({
      server: {
        ...diagnosticsSummary().server,
        version: '0.2.0',
        supervised: true,
        restart: { attempt: 2, lastExit: JSON.stringify({ code: 1, signal: null, failure: { phase: 'db', errName: 'Error', message: 'database is locked' } }) },
      },
      logLevel: { level: 'debug', verbose: true, until: null, areas: ['calendar', 'mail'], bootLevel: 'info', persisted: false },
      modules: [
        { name: 'core', ok: true },
        { name: 'mail', ok: false },
      ],
      hybrid: { pagesOrigin: 'https://dana.github.io', pairings: 1, lastPairedRequestAt: null, foreignOrigins: [{ origin: 'https://other.github.io', firstAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T11:00:00.000Z', count: 3 }], foreignOriginRequests: 0 },
      jobs: [jobInfo('calendar:sync', { overdue: true }), jobInfo('core:backup', { running: true, stuckForMs: 300_000 })],
      health: [
        healthEntry('account:acc-1', { accountId: 'acc-1', label: 'dana@example.com', status: 'failing', lastCode: 'invalid_grant', lastStatus: 400, failingSince: '2026-10-11T10:00:00.000Z', consecutiveFailures: 3, lastMessage: 'Sign-in expired' }),
        healthEntry('calendar:cal-1', { accountId: 'acc-1', label: 'Soccer Club', status: 'failing', lastCode: 'account_unavailable', causeKey: 'account:acc-1' }),
        healthEntry('weather'),
      ],
    }),
    page: { build: 'pages', version: '0.0.0-test', backend: 'server' },
    hybrid: { status: 'connected', permission: 'granted' },
    serverRecords: [
      logRecord({ level: 'warn', area: 'calendar', msg: 'calendar failing', t: '2026-10-11T11:00:00.000Z', fields: { code: 'account_unavailable' } }),
      logRecord({ level: 'warn', area: 'calendar', msg: 'calendar failing', t: '2026-10-11T11:05:00.000Z', fields: { code: 'account_unavailable', repeats: 2 } }),
      logRecord({ level: 'error', area: 'accounts', msg: 'accounts failing', t: '2026-10-11T11:10:00.000Z' }),
      logRecord({ level: 'info', area: 'server', msg: 'request', t: '2026-10-11T11:20:00.000Z' }),
    ],
    browserEvents: [],
    ...patch,
  };
}

describe('buildSummaryText', () => {
  it('follows the template', () => {
    recordClientEvent('warn', 'api', 'request failed', { method: 'GET', path: '/api/mail/summary', status: 503, code: 'module_unavailable' });
    recordClientEvent('info', 'hybrid', 'probe result', { kind: 'healthy' });
    const lines = buildSummaryText(input({ browserEvents: getClientEvents() })).split('\n');
    expect(lines[0]).toMatch(/^Homebase diagnostics, 2026-10-11 14:32:05 UTC[+-]\d{2}:\d{2}$/);
    expect(lines[1]).toBe('Server: 0.2.0 · boot b1x2 · up 3 h 12 min · Node v24.21.0 · win32 · supervised, restart 2 (exit code 1, start-up failed (db): Error: database is locked)');
    expect(lines[2]).toBe('Page: Pages site 0.0.0-test · data from Homebase on this PC · hybrid: connected (permission: granted) · version differs from the server (0.2.0)');
    expect(lines[3]).toBe('Log level: Verbose (debug) until turned off, areas: calendar, mail');
    expect(lines[4]).toBe('Vault: ready');
    expect(lines[5]).toBe('Modules down: mail');
    expect(lines[6]).toMatch(/^Pages origin: https:\/\/dana\.github\.io · 1 paired browser · foreign origins: https:\/\/other\.github\.io \(3×, last 2026-10-11 \d\d:00\)$/);
    expect(lines[7]).toBe('Jobs: calendar:sync overdue; core:backup stuck for 5 min');
    expect(lines[8]).toBe('Health: 1 OK, 0 degraded, 2 failing, 0 stale, 0 not checked');
    expect(lines[9]).toMatch(/^- failing account:acc-1 \(dana@example\.com\): invalid_grant, HTTP 400, since 2026-10-11 \d\d:00, 3× — Sign-in expired$/);
    expect(lines[10]).toBe('- failing calendar:cal-1 (Soccer Club): account_unavailable; because account:acc-1');
    expect(lines[11]).toBe('Recent server warnings and errors:');
    expect(lines[12]).toBe('- 1× error [accounts] accounts failing');
    expect(lines[13]).toBe('- 3× warn [calendar] calendar failing (account_unavailable)');
    expect(lines[14]).toBe('Recent browser warnings and errors:');
    expect(lines[15]).toMatch(/^- \d\d:\d\d:\d\d\.\d{3} warn api: request failed \(method=GET path=\/api\/mail\/summary status=503 code=module_unavailable\)$/);
    expect(lines).toHaveLength(16);
  });

  it('counts the repeats the server collapsed: each window by the largest count seen for it', () => {
    const since1 = '2026-10-11T09:00:00.000Z';
    const since2 = '2026-10-11T09:40:00.000Z';
    const repeat = (t: string, repeats: number, repeatSince: string) =>
      logRecord({ level: 'debug', area: 'feeds', msg: 'feed failed', t, fields: { code: 'timeout', repeats, repeatOf: 'warn', repeatSince } });
    const serverRecords = [
      // Window 1: the warning, two repeats (running count 1, 2), then its summary (count 2).
      logRecord({ level: 'warn', area: 'feeds', msg: 'feed failed', t: since1, fields: { code: 'timeout' } }),
      repeat('2026-10-11T09:05:00.000Z', 1, since1),
      repeat('2026-10-11T09:10:00.000Z', 2, since1),
      logRecord({ level: 'info', area: 'feeds', msg: 'repeated', t: '2026-10-11T09:40:00.000Z', fields: { repeatKey: 'k', count: 2, since: since1, repeatOf: 'warn', repeatMsg: 'feed failed', code: 'timeout' } }),
      // Window 2, still open: the warning and three repeats, the first of which already left memory.
      logRecord({ level: 'warn', area: 'feeds', msg: 'feed failed', t: since2, fields: { code: 'timeout' } }),
      repeat('2026-10-11T09:50:00.000Z', 2, since2),
      repeat('2026-10-11T09:55:00.000Z', 3, since2),
      // A summary of info lines (no repeatOf) and the repeats of an info line count for nothing.
      logRecord({ level: 'info', area: 'server', msg: 'repeated', t: '2026-10-11T09:56:00.000Z', fields: { repeatKey: 'r', count: 9, since: since1 } }),
      logRecord({ level: 'debug', area: 'server', msg: 'request', t: '2026-10-11T09:57:00.000Z', fields: { repeats: 4 } }),
    ];
    const lines = buildSummaryText(input({ serverRecords })).split('\n');
    const start = lines.indexOf('Recent server warnings and errors:');
    expect(lines.slice(start + 1, start + 2)).toEqual(['- 7× warn [feeds] feed failed (timeout)']);
    expect(lines.filter((line) => line.includes('[server]'))).toEqual([]);
  });

  it('gives a stale subject its last check, and its last error only while it was failing when it went stale', () => {
    const health = [
      healthEntry('feed:abc', { label: 'blog', status: 'stale', lastCheckedAt: '2026-10-10T08:00:00.000Z', lastCode: 'rate_limited', lastStatus: 429, lastMessage: 'Rate limited', failingSince: null }),
      healthEntry('ics:ics-1', { label: 'School', status: 'stale', lastCode: 'http_error', lastStatus: 503, lastMessage: 'The server answered 503', failingSince: '2026-10-10T07:00:00.000Z', consecutiveFailures: 2 }),
    ];
    const lines = buildSummaryText(input({ summary: diagnosticsSummary({ health }) })).split('\n');
    expect(lines).toContainEqual(expect.stringMatching(/^- stale feed:abc \(blog\): last checked 2026-10-10 \d\d:00$/));
    expect(lines).toContainEqual(expect.stringMatching(/^- stale ics:ics-1 \(School\): http_error, HTTP 503, since 2026-10-10 \d\d:00, 2× — The server answered 503$/));
  });

  it('never exceeds 40 lines: subjects beyond the budget are counted', () => {
    const health = Array.from({ length: 60 }, (_, i) => healthEntry(`feed:f${i}`, { status: 'failing', lastCode: 'not_a_feed' }));
    const text = buildSummaryText(input({ summary: diagnosticsSummary({ health }) }));
    const lines = text.split('\n');
    expect(lines).toHaveLength(SUMMARY_MAX_LINES);
    expect(lines.some((line) => /^- … and \d+ more$/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe('Recent browser warnings and errors: none');
  });

  it('says why there is no server part', () => {
    const text = buildSummaryText(input({ summary: null, summaryProblem: 'Update Homebase on this PC to see its diagnostics', serverRecords: null, hybrid: null }));
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^Homebase diagnostics, /),
      'Server: Update Homebase on this PC to see its diagnostics',
      'Page: Pages site 0.0.0-test · data from Homebase on this PC',
      'Recent browser warnings and errors: none',
    ]);
  });

  it('can be redacted for sharing with the page’s dictionary', () => {
    const base = input();
    const dict = sharingDictionary({ summary: base.summary, accounts: [{ label: 'Dana Work', email: 'dana@example.com' }], pagesOrigin: 'https://dana.github.io' });
    const shared = String(redactForSharing(buildSummaryText(base), dict));
    expect(shared).not.toContain('dana');
    expect(shared).not.toContain('other.github.io');
    expect(shared).not.toContain('Soccer Club');
    expect(shared).toMatch(/email#1/);
    expect(shared).toContain('invalid_grant');
  });
});

