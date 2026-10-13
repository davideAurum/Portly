import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsSummarySchema, HealthEntrySchema, LogRecordSchema, OutcomeRowSchema } from '@portly/shared';
import { newId } from '../../lib/ids.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { createLogger } from '../../lib/logger.ts';
import { TEST_PAGES_ORIGIN } from '../../testing/test-request.ts';
import { diagnosticsTestbed, writeLines, type DiagnosticsTestbed } from './__fixtures__/setup.ts';
import { memoryRecords, memoryRings, redactionDictionary, reportFilename, REPORT_MAIN_RECORDS } from './report.ts';

interface Report {
  generatedAt: string;
  summary: unknown;
  accounts: { id: string; kind: string; label: string; status: string; statusMessage: string | null }[];
  calendars: { id: string; accountId: string | null; name: string; source: string }[];
  health: unknown[];
  history: { code: string | null; ok: boolean }[];
  logs: { main: unknown[]; flight: unknown[]; client: unknown[]; files: { msg: string; fields: Record<string, unknown> }[] };
  supervisorLog: { msg: string; src: string }[];
  launcherLog: string[] | null;
  config: { port: number; pagesOrigin: string | null; envSet: string[]; logLevel: unknown };
}

/** The text of `value` as it appears inside JSON (backslashes escaped). */
function inJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

describe('diagnostic report', () => {
  let t: DiagnosticsTestbed;
  let launcherDir: string;
  afterEach(() => {
    t.close();
    fs.rmSync(launcherDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** A testbed with planted secrets, user paths and personal names in every source the report reads. */
  function planted(): DiagnosticsTestbed {
    launcherDir = path.join(os.tmpdir(), `portly-launcher-${newId()}`);
    const launcherLog = path.join(launcherDir, 'launcher.log');
    const bed = diagnosticsTestbed({
      accounts: [
        { id: 'g1', kind: 'google', label: 'Planted Label Account', email: 'planted.person@example.com' },
        {
          id: 'i1',
          kind: 'imap',
          label: 'Mailbox',
          config: { username: 'planteduser', imap: { host: 'imap.planted-host.example', port: 993, security: 'tls', webmailUrl: 'https://webmail.planted-host.example/' } },
        },
      ],
      module: { launcherLogPath: launcherLog },
    });
    const { ctx } = bed;
    vi.stubEnv('PORTLY_PLANTED_SETTING', 'planted-env-value');

    ctx.db.run("INSERT INTO calendars (id, account_id, source, remote_id, name, display_url) VALUES ('cal1', NULL, 'ics', 'r1', 'Planted Calendar Name', 'ics.planted-ics.example')");
    ctx.health.record({ key: 'account:g1', area: 'accounts', accountId: 'g1' }, { ok: false, code: 'invalid_grant', message: 'Google refused the refresh token' });
    ctx.health.record({ key: 'account:g1', area: 'accounts', accountId: 'g1' }, { ok: true });
    ctx.health.record({ key: 'mail:i1', area: 'mail', accountId: 'i1' }, { ok: false, code: 'refused', detail: { host: 'imap.planted-host.example' } });
    ctx.health.record({ key: 'feed:0123456789', area: 'feeds', label: 'blog.planted-feed.example' }, { ok: true });

    // Memory: the logger scrubs at write time; the report scrubs again.
    withLogContext({ job: 'calendar:sync', run: 'run001', area: 'calendar' }, () => {
      ctx.log.info('token refreshed', { refresh_token: 'PLANTED-REFRESH-SECRET', accountId: 'g1' });
      ctx.log.debug('opened C:\\Users\\plantedperson\\file.txt for planted.person@example.com', { host: 'www.googleapis.com' });
    });
    ctx.logs.setVerbose({ until: null, areas: ['client'] });
    ctx.log.child({ src: 'client' }).debug('client: probe', { cf: { host: 'pages.example' } });
    ctx.log.info(`hello ${os.userInfo().username}`);

    // Files: written before the current rules (or by hand): scrubbed on the way out.
    const file = ctx.config.paths.logFile;
    writeLines(`${file}.1`, ['2026-09-01T10:00:00.000Z WARN  refresh failed access_token=PLANTED-TEXT-SECRET at C:\\Users\\plantedperson\\x {"status":401}']);
    writeLines(file, [
      JSON.stringify({ t: '2026-10-11T09:00:00.000Z', lvl: 'warn', msg: 'Bearer PLANTEDBEARER123', area: 'calendar', tags: ['calendar'], password: 'PLANTED-FILE-SECRET' }),
    ]);
    writeLines(ctx.config.paths.supervisorLog, [
      JSON.stringify({ t: '2026-10-11T08:00:00.000Z', lvl: 'warn', msg: 'server exited; restarting', src: 'supervisor', area: 'server', tags: ['server'], stderrTail: ['Error: x at C:\\Users\\plantedperson\\a.js', 'cookie: PLANTED-COOKIE'] }),
    ]);
    writeLines(launcherLog, ['2026-10-11T07:00:00.000Z start password=PLANTED-LAUNCH-SECRET in C:\\Users\\plantedperson\\launcher']);
    return bed;
  }

  it('is a JSON attachment named portly-diagnostics-YYYYMMDD-HHmm.json with every part', async () => {
    t = planted();
    const res = await t.req('GET', '/api/diagnostics/report');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="portly-diagnostics-\d{8}-\d{4}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const report = (await res.json()) as Report;
    expect(Object.keys(report)).toEqual(['generatedAt', 'summary', 'accounts', 'calendars', 'health', 'history', 'logs', 'supervisorLog', 'launcherLog', 'config']);

    expect(DiagnosticsSummarySchema.parse(report.summary)).toEqual(report.summary);
    for (const entry of report.health) expect(HealthEntrySchema.parse(entry)).toEqual(entry);
    for (const row of report.history) expect(OutcomeRowSchema.parse(row)).toEqual(row);
    for (const rec of [...report.logs.main, ...report.logs.flight, ...report.logs.client, ...report.logs.files, ...report.supervisorLog]) {
      expect(LogRecordSchema.parse(rec)).toEqual(rec);
    }

    expect(report.accounts.map((a) => [a.id, a.kind, a.label, a.status])).toEqual([
      ['g1', 'google', 'Planted Label Account', 'ok'],
      ['i1', 'imap', 'Mailbox', 'ok'],
    ]);
    expect(report.calendars).toEqual([{ id: 'cal1', accountId: null, name: 'Planted Calendar Name', source: 'ics' }]);
    // Health and job codes are machine tokens, kept as they are (null included).
    expect(report.history.map((r) => [r.ok, r.code])).toEqual(
      expect.arrayContaining([
        [true, null],
        [false, 'invalid_grant'],
        [false, 'refused'],
      ]),
    );
    expect(report.logs.files.map((r) => r.msg)).toEqual([
      'refresh failed access_token=[REDACTED] at C:\\Users\\~\\x',
      'Bearer [REDACTED]',
    ]);
    expect(report.logs.files[1]?.fields).toEqual({ password: '[REDACTED]' });
    expect(report.supervisorLog.map((r) => [r.src, r.msg])).toEqual([['supervisor', 'server exited; restarting']]);
    expect(report.launcherLog).toEqual(['2026-10-11T07:00:00.000Z start password=[REDACTED] in C:\\Users\\~\\launcher']);
    expect(report.config).toMatchObject({ port: t.ctx.config.port, envSet: expect.arrayContaining(['PORTLY_PLANTED_SETTING']) });
    expect(report.logs.flight.length).toBeGreaterThan(0);
    expect(report.logs.client.length).toBe(1);
  });

  it('contains no planted secret, no user path and no environment value', async () => {
    t = planted();
    const text = await (await t.req('GET', '/api/diagnostics/report')).text();
    for (const secret of [
      'PLANTED-REFRESH-SECRET',
      'PLANTED-TEXT-SECRET',
      'PLANTEDBEARER123',
      'PLANTED-FILE-SECRET',
      'PLANTED-COOKIE',
      'PLANTED-LAUNCH-SECRET',
      'planted-env-value',
      'plantedperson',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The data directory lies in this PC's temp folder, inside the user profile.
    const home = os.homedir();
    for (const spelling of [home, home.replace(/\\/g, '/')]) expect(text).not.toContain(inJson(spelling));
    expect(text).toContain(inJson('C:\\Users\\~\\'));
  });

  it('redact=1 replaces emails, hosts, labels, names, the Pages site and the user name; keeps provider hosts', async () => {
    t = planted();
    const plain = await (await t.req('GET', '/api/diagnostics/report?redact=0')).text();
    expect(plain).toContain('Planted Label Account');
    expect(plain).toContain('pages.example');

    const res = await t.req('GET', '/api/diagnostics/report?redact=1');
    expect(res.status).toBe(200);
    const text = await res.text();
    const lower = text.toLowerCase();
    const username = os.userInfo().username;
    for (const term of [
      'planted.person@example.com',
      'Planted Label Account',
      'imap.planted-host.example',
      'webmail.planted-host.example',
      'planteduser',
      'Planted Calendar Name',
      'ics.planted-ics.example',
      'blog.planted-feed.example',
      new URL(TEST_PAGES_ORIGIN).host,
      ...(username.length >= 3 ? [`hello ${username}`] : []),
    ]) {
      expect(lower, term).not.toContain(term.toLowerCase());
    }
    for (const token of ['email#', 'host#', 'label#', 'name#']) expect(text).toContain(token);
    expect(text).toContain('www.googleapis.com');
    // Still a report: same parts, valid JSON.
    expect(Object.keys(JSON.parse(text) as object)).toContain('summary');
  });

  it('the redaction dictionary names accounts, hosts, calendars, feeds, this PC and its user', () => {
    t = planted();
    const dict = redactionDictionary(t.ctx);
    expect([...(dict.labels ?? [])]).toEqual(['Planted Label Account', 'Mailbox']);
    expect([...(dict.emails ?? [])]).toEqual(['planted.person@example.com']);
    expect([...(dict.hosts ?? [])]).toEqual(
      expect.arrayContaining(['imap.planted-host.example', 'https://webmail.planted-host.example/', 'ics.planted-ics.example', 'blog.planted-feed.example', TEST_PAGES_ORIGIN, os.hostname()]),
    );
    expect([...(dict.names ?? [])]).toEqual(expect.arrayContaining(['planteduser', 'Planted Calendar Name', os.userInfo().username]));
    expect([...(dict.keep ?? [])]).toContain('graph.microsoft.com');
  });

  it('names the file by local date and time', () => {
    expect(reportFilename(new Date(2026, 0, 5, 7, 3))).toBe('portly-diagnostics-20260105-0703.json');
    expect(reportFilename(new Date(2026, 11, 31, 23, 59))).toBe('portly-diagnostics-20261231-2359.json');
  });
});

describe('memory records for the report', () => {
  it('reads every ring in pages past the hub limit, de-duplicated, and splits main/flight/client', () => {
    let clock = Date.parse('2026-10-11T09:00:00.000Z');
    let calls = 0;
    // Three records per millisecond: page boundaries fall inside a millisecond.
    const logs = createLogger({ console: false, now: () => clock + Math.floor(calls++ / 3) });
    try {
      for (let i = 0; i < 4000; i++) logs.info(`info ${i}`);
      for (let a = 0; a < 20; a++) {
        const areaLog = logs.child({ module: `area${a}` });
        for (let i = 0; i < 400; i++) areaLog.debug(`debug ${a}.${i}`);
      }
      const client = logs.child({ src: 'client' });
      for (let i = 0; i < 50; i++) client.warn(`client: event ${i}`);

      const all = memoryRecords(logs);
      expect(all).toHaveLength(4000 + 20 * 400 + 50);
      expect(new Set(all.map((r) => r.seq)).size).toBe(all.length);
      expect(all.map((r) => r.seq)).toEqual([...all.map((r) => r.seq)].sort((a, b) => a - b));

      const rings = memoryRings(logs);
      expect(rings.main).toHaveLength(Math.min(4000, REPORT_MAIN_RECORDS));
      expect(rings.main.at(-1)?.msg).toBe('info 3999');
      expect(rings.flight).toHaveLength(8000);
      expect(rings.client).toHaveLength(50);
    } finally {
      logs.close();
    }
  });
});
