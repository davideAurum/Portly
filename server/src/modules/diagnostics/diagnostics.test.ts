import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  ClientEventsResponseSchema,
  DiagnosticsSummarySchema,
  HealthHistoryResponseSchema,
  LogLevelStateSchema,
  LogsResponseSchema,
  type ClientEventsRequest,
  type DiagnosticsSummary,
  type HealthHistoryResponse,
  type LogsResponse,
} from '@homebase/shared';
import { withLogContext } from '../../lib/log-context.ts';
import { foreignOrigins } from '../../security/foreign-origins.ts';
import { TEST_PAGES_ORIGIN } from '../../testing/test-request.ts';
import { diagnosticsTestbed, writeLines, type DiagnosticsTestbed } from './__fixtures__/setup.ts';
import { PURGE_INITIAL_DELAY_MS, PURGE_INTERVAL_MS, PURGE_JOB } from './index.ts';

const T = '2026-10-11T09:00:00.000Z';

function clientBatch(fields: Record<string, string | number> = {}): ClientEventsRequest {
  const now = new Date().toISOString();
  return {
    sentAt: now,
    events: [
      {
        t: now,
        level: 'warn',
        cat: 'api',
        msg: 'request failed',
        fields: { method: 'GET', route: '/api/mail/summary', status: 0, code: 'network_error', ...fields },
        session: 'sess1',
        page: { build: 'pages', backend: 'server', version: '1.0.0' },
      },
    ],
  };
}

describe('diagnostics routes', () => {
  let t: DiagnosticsTestbed;
  afterEach(() => {
    t.close();
    foreignOrigins.reset();
    vi.unstubAllEnvs();
  });

  describe('access: every route is paired() (amendment 1)', () => {
    const ROUTES: { method: string; path: string; body?: unknown; status: number; schema: z.ZodType | null }[] = [
      { method: 'GET', path: '/api/diagnostics/summary', status: 200, schema: DiagnosticsSummarySchema },
      { method: 'GET', path: '/api/diagnostics/logs', status: 200, schema: LogsResponseSchema },
      { method: 'GET', path: '/api/diagnostics/logs?scope=files&level=warn', status: 200, schema: LogsResponseSchema },
      { method: 'GET', path: '/api/diagnostics/health/todoist/history', status: 200, schema: HealthHistoryResponseSchema },
      { method: 'PUT', path: '/api/diagnostics/level', body: { verbose: true, minutes: 30 }, status: 200, schema: LogLevelStateSchema },
      { method: 'POST', path: `/api/diagnostics/jobs/${encodeURIComponent(PURGE_JOB)}/run`, status: 202, schema: null },
      { method: 'GET', path: '/api/diagnostics/report?redact=1', status: 200, schema: null },
      { method: 'POST', path: '/api/diagnostics/client-events', body: clientBatch(), status: 200, schema: ClientEventsResponseSchema },
    ];

    it.each(ROUTES)('$method $path answers the paired Pages site with CORS, a valid body', async (route) => {
      t = diagnosticsTestbed();
      const headers = t.pair();
      const res = await t.json(route.method, route.path, { headers, body: route.body });
      expect(res.status).toBe(route.status);
      expect(res.res.headers.get('access-control-allow-origin')).toBe(TEST_PAGES_ORIGIN);
      if (route.schema !== null) expect(route.schema.parse(res.body)).toEqual(res.body);
    });

    it.each(ROUTES)('$method $path refuses the Pages site without a pairing token (401)', async (route) => {
      t = diagnosticsTestbed();
      t.pair();
      const res = await t.json<{ error: { code: string } }>(route.method, route.path, {
        headers: { Origin: TEST_PAGES_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
        body: route.body,
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('pairing_required');
    });

    it.each(ROUTES)('$method $path answers Homebase’s own page', async (route) => {
      t = diagnosticsTestbed();
      const res = await t.json(route.method, route.path, { body: route.body });
      expect(res.status).toBe(route.status);
      if (route.schema !== null) expect(route.schema.parse(res.body)).toEqual(res.body);
    });
  });

  describe('GET /api/diagnostics/summary', () => {
    it('reports the server, level, modules, vault, hybrid state, jobs, health and counts', async () => {
      t = diagnosticsTestbed({ accounts: [{ id: 'g1', kind: 'google', label: 'Work Google', email: 'someone@example.com' }] });
      const { ctx } = t;
      ctx.db.run("INSERT INTO calendars (id, account_id, source, remote_id, name, display_url) VALUES ('cal1', NULL, 'ics', 'r1', 'Family planner', 'ics.example.net')");
      ctx.health.record({ key: 'account:g1', area: 'accounts', accountId: 'g1' }, { ok: false, code: 'invalid_grant', message: 'Google refused the refresh token' });
      ctx.health.record({ key: 'ics:cal1', area: 'calendar', label: 'ics.example.net', expectEveryMs: 90 * 60_000 }, { ok: true, ms: 20 });
      ctx.health.record({ key: 'feed:0123456789', area: 'feeds', label: 'blog.example.org' }, { ok: true });
      ctx.health.record({ key: 'job:calendar:ics', area: 'calendar', label: 'calendar:ics', expectEveryMs: 90 * 60_000 }, { ok: true });
      ctx.log.warn('something to count');
      foreignOrigins.note('https://someone.github.io', { named: true });
      foreignOrigins.note('https://unrelated.example', { named: false });
      t.pair();

      const res = await t.json<DiagnosticsSummary>('GET', '/api/diagnostics/summary');
      expect(res.status).toBe(200);
      const s = DiagnosticsSummarySchema.parse(res.body);
      expect(s.server).toMatchObject({
        version: ctx.config.version,
        boot: ctx.runtime.boot,
        pid: process.pid,
        node: process.version,
        supervised: false,
        restart: null,
        dataDir: ctx.config.dataDir,
        logDir: ctx.config.paths.logsDir,
      });
      expect(s.server.memory?.rssBytes).toBeGreaterThan(0);
      expect(s.logLevel).toEqual({ level: 'debug', verbose: false, until: null, areas: null, bootLevel: 'debug', persisted: false });
      expect(s.modules).toEqual([{ name: 'diagnostics', ok: true }]);
      expect(s.vault).toBe('ready');
      expect(s.hybrid).toMatchObject({
        pagesOrigin: TEST_PAGES_ORIGIN,
        pairings: 1,
        lastPairedRequestAt: null,
        foreignOrigins: [{ origin: 'https://someone.github.io', count: 1 }],
        foreignOriginRequests: 1,
      });
      expect(s.jobs.map((j) => j.name)).toContain(PURGE_JOB);
      expect(s.health.map((h) => [h.key, h.label, h.status, h.lastCode])).toEqual([
        ['account:g1', 'Work Google', 'failing', 'invalid_grant'],
        ['feed:0123456789', 'blog.example.org', 'ok', null],
        ['ics:cal1', 'Family planner', 'ok', null],
        ['job:calendar:ics', 'calendar:ics', 'ok', null],
      ]);
      expect(s.counts.server.warn).toBeGreaterThanOrEqual(1);
      expect(s.counts.memoryRecords).toBeGreaterThan(0);
    });

    it('lists an account that needs attention but has no subject of its own from its stored status, so a cause is never missing', async () => {
      t = diagnosticsTestbed({
        accounts: [
          { id: 'g1', kind: 'google', label: 'Work Google', status: 'reauth', statusMessage: 'Access expired or was revoked; reconnect the account' },
          { id: 'm1', kind: 'microsoft', label: 'Outlook', status: 'reauth' },
          { id: 'y1', kind: 'yahoo', label: 'Yahoo', status: 'error', statusMessage: 'Calendars could not be loaded: Yahoo did not respond' },
          { id: 'i1', kind: 'imap', label: 'Fine' },
        ],
      });
      // g1 went into reauth before diagnostics existed: only its mailbox was recorded since. m1 has a subject of its own.
      t.ctx.health.record(
        { key: 'mail:g1', area: 'mail', accountId: 'g1' },
        { ok: false, code: 'account_unavailable', causeKey: 'account:g1', severity: 'info', message: 'Reconnect required' },
      );
      t.ctx.health.record({ key: 'account:m1', area: 'accounts', accountId: 'm1' }, { ok: false, code: 'invalid_grant', message: 'Access expired' });

      const s = DiagnosticsSummarySchema.parse((await t.json<DiagnosticsSummary>('GET', '/api/diagnostics/summary')).body);
      expect(s.health.map((h) => [h.key, h.label, h.status, h.lastCode, h.causeKey])).toEqual([
        ['account:g1', 'Work Google', 'failing', 'reauth_required', null],
        ['account:m1', 'Outlook', 'failing', 'invalid_grant', null],
        ['account:y1', 'Yahoo', 'failing', null, null],
        ['mail:g1', 'Work Google', 'failing', 'account_unavailable', 'account:g1'],
      ]);
      expect(s.health[0]).toMatchObject({
        lastMessage: 'Access expired or was revoked; reconnect the account',
        detail: { fromStatus: true },
        failingSince: null,
        consecutiveFailures: 0,
      });
      expect(s.health[2]?.lastMessage).toBe('Calendars could not be loaded: Yahoo did not respond');
    });

    it('blanks only the data and log directories for the Pages site', async () => {
      t = diagnosticsTestbed();
      const res = await t.json<DiagnosticsSummary>('GET', '/api/diagnostics/summary', { headers: t.pair() });
      expect(res.status).toBe(200);
      expect(res.body.server).toMatchObject({ dataDir: '', logDir: '', pid: process.pid });
      expect(res.body.server.memory).not.toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(t.ctx.config.dataDir).slice(1, -1));
    });

    it('shows a job-driven subject as stale once its check is overdue', async () => {
      t = diagnosticsTestbed();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        t.ctx.health.record({ key: 'job:calendar:ics', area: 'calendar', label: 'calendar:ics', expectEveryMs: 60_000 }, { ok: true });
        vi.setSystemTime(Date.now() + 61_000);
        const res = await t.json<DiagnosticsSummary>('GET', '/api/diagnostics/summary');
        expect(res.body.health.find((h) => h.key === 'job:calendar:ics')?.status).toBe('stale');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('GET /api/diagnostics/logs', () => {
    function seed(t: DiagnosticsTestbed): void {
      const calendarLog = t.ctx.log.child({ module: 'calendar' });
      withLogContext({ job: 'calendar:sync', run: 'run001', area: 'calendar', accountId: 'g1' }, () => {
        calendarLog.debug('calendar list fetched', { count: 3 });
        calendarLog.warn('calendar failing', { key: 'calendar:cal1', calendarId: 'cal1', code: 'http_5xx' });
      });
      t.ctx.log.child({ module: 'todoist' }).info('todoist recovered', { key: 'todoist' });
      t.ctx.log.child({ module: 'mail' }).info('mail action', { op: 'archive', accountId: 'g2' });
    }
    const msgs = (body: LogsResponse): string[] => body.records.map((r) => r.msg).filter((m) => m !== 'request');

    it('filters memory by level, area, context fields, health key and text; oldest first', async () => {
      t = diagnosticsTestbed();
      seed(t);
      const get = async (query: string): Promise<LogsResponse> => {
        const res = await t.json<LogsResponse>('GET', `/api/diagnostics/logs${query}`);
        expect(res.status, query).toBe(200);
        return LogsResponseSchema.parse(res.body);
      };
      expect(msgs(await get('?job=calendar:sync'))).toEqual(['calendar list fetched', 'calendar failing']);
      expect(msgs(await get('?job=calendar:sync&level=warn'))).toEqual(['calendar failing']);
      expect(msgs(await get('?run=run001&q=LIST'))).toEqual(['calendar list fetched']);
      expect(msgs(await get('?key=account:g1'))).toEqual(['calendar list fetched', 'calendar failing']);
      expect(msgs(await get('?key=calendar:cal1'))).toEqual(['calendar failing']);
      expect(msgs(await get('?key=todoist'))).toEqual(['todoist recovered']);
      expect(msgs(await get('?area=mail&accountId=g2'))).toEqual(['mail action']);
      // A key and an explicit field that contradict each other match nothing.
      expect(msgs(await get('?key=account:g1&accountId=g2'))).toEqual([]);
      // Area and a key of another area: both must hold.
      expect(msgs(await get('?area=calendar&key=todoist'))).toEqual([]);

      const all = await get('?limit=2');
      expect(all.records).toHaveLength(2);
      expect(all.truncated).toBe(true);
      expect(all.scope).toBe('memory');
      const polled = await get(`?after=${all.lastSeq}&src=server&q=nothing-new-here`);
      expect(polled.records).toEqual([]);
    });

    it('validates the query (422)', async () => {
      t = diagnosticsTestbed();
      for (const query of ['?limit=0', '?limit=5000', '?level=loud', '?scope=disk', '?since=yesterday', '?src=browser']) {
        const res = await t.json<{ error: { code: string } }>('GET', `/api/diagnostics/logs${query}`);
        expect(res.status, query).toBe(422);
        expect(res.body.error.code).toBe('validation_failed');
      }
    });

    it('reads the log files (JSON Lines and old text lines), scrubbed again, with seq 0', async () => {
      t = diagnosticsTestbed();
      const file = t.ctx.config.paths.logFile;
      writeLines(`${file}.1`, ['2026-10-11T08:00:00.000Z INFO  request {"method":"GET","path":"/api/x","status":200}']);
      writeLines(file, [
        JSON.stringify({ t: T, lvl: 'warn', msg: 'calendar failing', area: 'calendar', tags: ['calendar'], calendarId: 'cal1', password: 'planted-secret' }),
        JSON.stringify({ t: '2026-10-11T09:01:00.000Z', lvl: 'debug', msg: 'mail ok', area: 'mail', tags: ['mail'], accountId: 'g1' }),
      ]);
      const res = await t.json<LogsResponse>('GET', '/api/diagnostics/logs?scope=files');
      expect(res.status).toBe(200);
      const body = LogsResponseSchema.parse(res.body);
      expect(body.scope).toBe('files');
      expect(body.records.map((r) => [r.seq, r.msg, r.area])).toEqual([
        [0, 'request', 'server'],
        [0, 'calendar failing', 'calendar'],
        [0, 'mail ok', 'mail'],
      ]);
      expect(body.records[1]?.fields).toEqual({ calendarId: 'cal1', password: '[REDACTED]' });
      expect(JSON.stringify(body)).not.toContain('planted-secret');
      // A search runs over the scrubbed records: it cannot probe for what scrubbing removed.
      expect((await t.json<LogsResponse>('GET', '/api/diagnostics/logs?scope=files&q=planted-secret')).body.records).toEqual([]);

      const byKey = await t.json<LogsResponse>('GET', '/api/diagnostics/logs?scope=files&key=calendar:cal1');
      expect(byKey.body.records.map((r) => r.msg)).toEqual(['calendar failing']);
      const windowed = await t.json<LogsResponse>('GET', `/api/diagnostics/logs?scope=files&since=${encodeURIComponent(T)}&level=debug&limit=1`);
      expect(windowed.body.records.map((r) => r.msg)).toEqual(['mail ok']);
      expect(windowed.body.truncated).toBe(true);
    });
  });

  describe('GET /api/diagnostics/health/:key/history', () => {
    it('returns the outcome rows of one (URL-encoded) key, newest first, limited', async () => {
      t = diagnosticsTestbed();
      const subject = { key: 'job:calendar:ics', area: 'calendar' };
      t.ctx.health.record(subject, { ok: false, code: 'timeout', message: 'The provider timed out' });
      t.ctx.health.record(subject, { ok: false, code: 'http_5xx', status: 503 });
      t.ctx.health.record(subject, { ok: true, ms: 40 });
      const res = await t.json<HealthHistoryResponse>('GET', `/api/diagnostics/health/${encodeURIComponent(subject.key)}/history`);
      expect(res.status).toBe(200);
      const body = HealthHistoryResponseSchema.parse(res.body);
      expect(body.key).toBe('job:calendar:ics');
      expect(body.rows.map((r) => [r.status, r.code, r.httpStatus])).toEqual([
        ['ok', null, null],
        ['failing', 'http_5xx', 503],
        ['failing', 'timeout', null],
      ]);
      const limited = await t.json<HealthHistoryResponse>('GET', `/api/diagnostics/health/${encodeURIComponent(subject.key)}/history?limit=1`);
      expect(limited.body.rows).toHaveLength(1);
      expect((await t.json('GET', '/api/diagnostics/health/unknown/history')).body).toEqual({ key: 'unknown', rows: [] });
      expect((await t.json('GET', '/api/diagnostics/health/todoist/history?limit=501')).status).toBe(422);
    });
  });

  describe('PUT /api/diagnostics/level', () => {
    it('switches verbose on for a while, until turned off, and off; the summary follows', async () => {
      t = diagnosticsTestbed();
      const timed = await t.json('PUT', '/api/diagnostics/level', { body: { verbose: true, minutes: 30, areas: ['calendar'] } });
      expect(timed.status).toBe(200);
      expect(LogLevelStateSchema.parse(timed.body)).toMatchObject({ verbose: true, areas: ['calendar'], persisted: true });
      const summary = await t.json<DiagnosticsSummary>('GET', '/api/diagnostics/summary');
      expect(summary.body.logLevel).toMatchObject({ verbose: true, areas: ['calendar'] });

      const untilOff = await t.json('PUT', '/api/diagnostics/level', { body: { verbose: true, minutes: null } });
      expect(untilOff.body).toMatchObject({ verbose: true, until: null, areas: null, persisted: false });
      const off = await t.json('PUT', '/api/diagnostics/level', { body: { verbose: false } });
      expect(off.body).toMatchObject({ verbose: false, until: null, persisted: false });
    });

    it('validates the body (422)', async () => {
      t = diagnosticsTestbed();
      for (const body of [{}, { verbose: true, minutes: 0 }, { verbose: true, minutes: 20000 }, { verbose: true, areas: ['nope'] }, { verbose: true, areas: [] }, { verbose: true, extra: 1 }]) {
        const res = await t.json<{ error: { code: string } }>('PUT', '/api/diagnostics/level', { body });
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(t.ctx.logs.levelState().verbose).toBe(false);
    });
  });

  describe('POST /api/diagnostics/jobs/:name/run', () => {
    it('starts a registered job without waiting for it (202); unknown jobs are 404', async () => {
      t = diagnosticsTestbed();
      let release: () => void = () => {};
      const runs: string[] = [];
      t.ctx.scheduler.every('test:slow', 60_000, async () => {
        runs.push('started');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        runs.push('finished');
      });
      const res = await t.json('POST', `/api/diagnostics/jobs/${encodeURIComponent('test:slow')}/run`);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ started: true });
      expect(runs).toEqual(['started']);
      release();
      await t.ctx.scheduler.idle(1000);
      expect(runs).toEqual(['started', 'finished']);

      const missing = await t.json<{ error: { code: string } }>('POST', '/api/diagnostics/jobs/nope/run');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('not_found');
    });
  });

  describe('POST /api/diagnostics/client-events', () => {
    it('logs the events from the paired Pages site with the pairing as caller', async () => {
      t = diagnosticsTestbed();
      const headers = t.pair();
      const pairingId = t.ctx.pairing.list()[0]?.id;
      if (pairingId === undefined) throw new Error('no pairing');
      const post = (body: ClientEventsRequest, h?: Record<string, string | null>) =>
        t.json<z.output<typeof ClientEventsResponseSchema>>('POST', '/api/diagnostics/client-events', { headers: h, body });
      /** `count` copies of the batch's event (at most 100 per upload). */
      const many = (count: number): ClientEventsRequest => {
        const one = clientBatch();
        return { ...one, events: Array.from({ length: count }, () => one.events[0]!) };
      };

      const res = await post(clientBatch({ rid: 'abcdefghij' }), headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: 1, dropped: 0, acceptDebug: false });
      const [rec] = t.ctx.logs.query({ src: 'client' }).records;
      expect(rec).toMatchObject({
        msg: 'client: request failed',
        rid: 'abcdefghij',
        fields: { cf: { method: 'GET', route: '/api/mail/summary', status: 0, code: 'network_error' }, client: { cat: 'api', late: false } },
      });

      // The pairing has its own budget (CLIENT_EVENTS_PER_MINUTE = 120): using it up leaves Homebase's own page alone.
      expect((await post(many(100), headers)).body).toMatchObject({ accepted: 100, dropped: 0 });
      expect((await post(many(19), headers)).body).toMatchObject({ accepted: 19, dropped: 0 });
      expect((await post(clientBatch())).body).toMatchObject({ accepted: 1, dropped: 0 });
      expect((await post(clientBatch(), headers)).body).toMatchObject({ accepted: 0, dropped: 1 });
      const dropped = t.ctx.logs.query({ q: 'client events dropped' }).records.filter((r) => r.msg === 'client events dropped');
      expect(dropped.map((r) => r.fields.caller)).toEqual([pairingId]);
    });

    it('validates the batch (422) and refuses forbidden keys (400)', async () => {
      t = diagnosticsTestbed();
      const bad = clientBatch();
      const event = bad.events[0];
      if (event === undefined) throw new Error('no event');
      for (const body of [
        { sentAt: bad.sentAt, events: [] },
        { ...bad, events: [{ ...event, msg: 'two\nlines' }] },
        { ...bad, events: [{ ...event, fields: { 'bad key': 1 } }] },
        { ...bad, events: [{ ...event, extra: true }] },
      ]) {
        expect((await t.json('POST', '/api/diagnostics/client-events', { body })).status, JSON.stringify(body)).toBe(422);
      }
      const proto = `{"sentAt":"${bad.sentAt}","events":[{"t":"${event.t}","level":"warn","cat":"api","msg":"x","fields":{"__proto__":{"a":1}},"session":"s","page":{"build":"server","backend":"server","version":"1"}}]}`;
      expect((await t.json('POST', '/api/diagnostics/client-events', { body: proto, headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    });
  });

  describe('diagnostics:purge job', () => {
    it('runs daily and applies the health retention', async () => {
      t = diagnosticsTestbed();
      const job = t.ctx.scheduler.jobs().find((j) => j.name === PURGE_JOB);
      expect(job).toMatchObject({ intervalMs: PURGE_INTERVAL_MS, dueAt: PURGE_INITIAL_DELAY_MS });
      const purge = vi.spyOn(t.ctx.health, 'purge');
      expect(await t.ctx.scheduler.advance(PURGE_INITIAL_DELAY_MS)).toEqual([PURGE_JOB]);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(t.ctx.scheduler.jobs().find((j) => j.name === PURGE_JOB)?.lastOk).toBe(true);
    });
  });
});
