/**
 * Diagnostics module (ARCHITECTURE §17, diagnostics spec §8): what Settings → Diagnostics shows —
 * health of every synced subject, jobs, hybrid state, log records, the verbose switch, the
 * diagnostic report — and the intake of browser events.
 *
 * Routes and responses (all `paired()`: the paired Pages site is the main UI and may use every
 * one; amendment 1):
 * - `GET /api/diagnostics/summary` → `DiagnosticsSummary` (summary.ts; a Pages request gets the
 *   data and log directories blank, as `/api/about`)
 * - `GET /api/diagnostics/logs?scope=memory|files&…` → `LogsResponse` (logs.ts, log-files.ts)
 * - `GET /api/diagnostics/health/:key/history?limit=` → `HealthHistoryResponse` (≤ 500 rows; the
 *   key URL-encoded — keys never contain `/`, whose encoded form the gate refuses)
 * - `PUT /api/diagnostics/level` `SetLogLevel` → `LogLevelState` (level.ts: timed verbose survives
 *   a restart, "until turned off" does not)
 * - `POST /api/diagnostics/jobs/:name/run` → 202 `{started: true}` (the run is not awaited), 404
 *   `not_found` for an unknown job
 * - `GET /api/diagnostics/report?redact=0|1` → the report as a JSON attachment
 *   `homebase-diagnostics-YYYYMMDD-HHmm.json` (report.ts)
 * - `POST /api/diagnostics/client-events` `ClientEventsRequest` → `ClientEventsResponse`
 *   (client-events.ts)
 *
 * Job: `diagnostics:purge` (daily) — health history retention (`ctx.health.purge()`) and an ended
 * persisted verbose period. At registration the persisted log level is restored (level.ts).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  ClientEventsRequestSchema,
  LogsQuerySchema,
  SetLogLevelSchema,
  redactForSharing,
  type HealthHistoryResponse,
} from '@homebase/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { getLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseSafeBody } from '../../lib/safe-json.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import { createClientEventIntake } from './client-events.ts';
import { applyLogLevel, clearExpiredVerbose, restoreLogLevel } from './level.ts';
import { queryFileLogs, queryMemoryLogs } from './logs.ts';
import { buildReport, redactionDictionary, reportFilename } from './report.ts';
import { buildSummary, toOutcomeRow } from './summary.ts';

export const prefixes = ['/api/diagnostics'] as const;

export const PURGE_JOB = 'diagnostics:purge';
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PURGE_INITIAL_DELAY_MS = 15 * 60 * 1000;
/** Default and largest number of outcome rows of `…/history`. */
export const DEFAULT_HISTORY_ROWS = 50;
export const MAX_HISTORY_ROWS = 500;

const HealthKeyParam = z.string().min(1).max(600);
const JobNameParam = z.string().min(1).max(200);
const HistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(MAX_HISTORY_ROWS).default(DEFAULT_HISTORY_ROWS) });
const ReportQuerySchema = z.object({ redact: z.enum(['0', '1']).default('0') });

export interface DiagnosticsOptions {
  /** The extension launcher's log for the report (default `nativeHostLogPath()`; null: none). Tests. */
  launcherLogPath?: string | null;
}

export function register(app: Hono<AppEnv>, ctx: AppContext, options: DiagnosticsOptions = {}): void {
  const log = ctx.log.child({ module: 'diagnostics' });
  const intake = createClientEventIntake({ logs: ctx.logs, log, clientLog: ctx.log.child({ src: 'client' }) });

  const param = <S extends z.ZodType>(schema: S, value: string | undefined, what: string): z.output<S> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(404, 'not_found', `${what} not found`);
    return parsed.data;
  };

  restoreLogLevel(ctx, log, Date.now());

  // ---- summary, health history ----------------------------------------------

  app.get('/api/diagnostics/summary', paired(), (c) =>
    c.json(buildSummary(ctx, { fromPages: c.get('pagesCors') === true, now: Date.now(), requestId: c.get('requestId') })),
  );

  app.get('/api/diagnostics/health/:key/history', paired(), (c) => {
    const key = param(HealthKeyParam, c.req.param('key'), 'Health subject');
    const { limit } = parseQuery(c, HistoryQuerySchema);
    const body: HealthHistoryResponse = { key, rows: ctx.health.history(key, limit).map(toOutcomeRow) };
    return c.json(body);
  });

  // ---- logs, level ----------------------------------------------------------

  app.get('/api/diagnostics/logs', paired(), async (c) => {
    const query = parseQuery(c, LogsQuerySchema);
    if (query.scope === 'files') return c.json(await queryFileLogs(ctx.config.paths.logFile, ctx.logs, query));
    return c.json(queryMemoryLogs(ctx.logs, query));
  });

  app.put('/api/diagnostics/level', paired(), async (c) => {
    const body = await parseBody(c, SetLogLevelSchema);
    return c.json(applyLogLevel(ctx, body, Date.now()));
  });

  // ---- run a job now --------------------------------------------------------

  app.post('/api/diagnostics/jobs/:name/run', paired(), (c) => {
    const name = param(JobNameParam, c.req.param('name'), 'Job');
    const run = ctx.scheduler.trigger(name);
    if (run === null) throw new HttpError(404, 'not_found', 'Job not found');
    log.debug('job run requested', { job: name });
    // The job records its own outcome (job:<name> health, its log lines); nobody awaits it here.
    void run.catch(() => {});
    return c.json({ started: true }, 202);
  });

  // ---- report ---------------------------------------------------------------

  app.get('/api/diagnostics/report', paired(), async (c) => {
    const { redact } = parseQuery(c, ReportQuerySchema);
    const started = Date.now();
    const report = await buildReport(ctx, { now: started, launcherLogPath: options.launcherLogPath });
    const body = redact === '1' ? redactForSharing(report, redactionDictionary(ctx)) : report;
    const text = JSON.stringify(body);
    log.info('diagnostic report created', { redact: redact === '1', bytes: Buffer.byteLength(text), ms: Date.now() - started });
    return c.body(text, 200, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Disposition': `attachment; filename="${reportFilename(new Date(started))}"`,
    });
  });

  // ---- browser events -------------------------------------------------------

  app.post('/api/diagnostics/client-events', paired(), async (c) => {
    const body = await parseSafeBody(c, ClientEventsRequestSchema);
    const uploadRid = c.get('requestId') ?? getLogContext()?.rid ?? null;
    return c.json(intake.ingest(body, { caller: c.get('pairingId') ?? 'local', uploadRid, now: Date.now() }));
  });

  // ---- daily purge ----------------------------------------------------------

  ctx.scheduler.every(
    PURGE_JOB,
    PURGE_INTERVAL_MS,
    () => {
      ctx.health.purge();
      clearExpiredVerbose(ctx.db, Date.now());
    },
    { initialDelayMs: PURGE_INITIAL_DELAY_MS },
  );
}
