/**
 * Diagnostics API helpers: requests (paths, query strings, encoded keys, `X-Portly`), tolerant
 * parsing with the shared contracts (a newer server's extra fields are dropped at any depth, a
 * malformed answer is refused), the report download (Blob + file name from `Content-Disposition`),
 * the event upload, and that nothing of the family is persisted.
 */
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClientEventsRequestSchema, type DiagnosticsSummary } from '@portly/shared';
import { shouldPersistQuery } from '../app/providers.tsx';
import { pendingUpload, recordClientEvent } from '../diagnostics/clientLog.ts';
import { createTestQueryClient, mockError, mockResponse, stubApi } from '../test/render.tsx';
import { ApiError } from './client.ts';
import {
  DEFAULT_REPORT_FILENAME,
  DIAGNOSTICS_GC_MS,
  downloadReport,
  getDiagnosticsLogs,
  getDiagnosticsSummary,
  getHealthHistory,
  logsQueryString,
  postClientEvents,
  reportFilename,
  runJob,
  setLogLevel,
  useDiagnosticsLogs,
  useDiagnosticsSummary,
  useHealthHistory,
  useSetLogLevel,
} from './diagnostics.ts';
import { qk } from './keys.ts';

const T = '2026-10-11T12:00:00.000Z';

const LOG_LEVEL = { level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info', persisted: false } as const;

function summary(): DiagnosticsSummary {
  return {
    generatedAt: T,
    server: {
      version: '0.1.0',
      boot: 'b1',
      pid: 42,
      startedAt: T,
      uptimeMs: 1000,
      node: 'v24.21.0',
      platform: 'win32',
      memory: { rssBytes: 1, heapUsedBytes: 2 },
      supervised: true,
      restart: { attempt: 1, lastExit: null },
      dataDir: 'C:\\Users\\~\\AppData\\Local\\Portly',
      logDir: 'C:\\Users\\~\\AppData\\Local\\Portly\\logs',
    },
    logLevel: { ...LOG_LEVEL },
    modules: [{ name: 'calendar', ok: true }],
    vault: 'ready',
    hybrid: { pagesOrigin: null, pairings: 0, lastPairedRequestAt: null, foreignOrigins: [{ origin: 'https://x.github.io', firstAt: T, lastAt: T, count: 2 }], foreignOriginRequests: 3 },
    inFlight: { count: 1, oldestMs: 5, routes: ['GET /api/mail/summary'], outbound: [{ host: 'graph.microsoft.com', purpose: 'mail', ms: 5 }] },
    jobs: [
      {
        name: 'calendar:sync',
        intervalMs: 300000,
        nextRunAt: T,
        running: false,
        runningSince: null,
        stuckForMs: null,
        overdue: false,
        runs: 3,
        failures: 1,
        consecutiveFailures: 0,
        lastStartedAt: T,
        lastFinishedAt: T,
        lastMs: 120,
        lastOk: true,
        lastError: { name: 'HttpError', code: null, message: 'x' },
      },
    ],
    health: [
      {
        key: 'calendar:cal-1',
        area: 'calendar',
        label: 'Personal',
        accountId: 'acc-1',
        status: 'failing',
        lastOkAt: null,
        lastFailAt: T,
        failingSince: T,
        lastCheckedAt: T,
        expectEveryMs: 900000,
        consecutiveFailures: 2,
        lastCode: 'rate_limited',
        lastStatus: 429,
        lastMessage: 'Rate limited',
        lastMs: 80,
        detail: { mode: 'delta' },
        causeKey: null,
        nextAttemptAt: null,
        updatedAt: T,
      },
    ],
    counts: { server: { warn: 1, error: 0 }, client: { warn: 0, error: 0 }, warnKeysLastHour: 1, memoryRecords: 10 },
  };
}

function wrapper(client = createTestQueryClient()) {
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}

describe('readers', () => {
  it('parses the summary and drops fields a newer server adds, at any depth', async () => {
    const extra = summary() as unknown as Record<string, unknown> & { server: Record<string, unknown>; health: Record<string, unknown>[]; jobs: { lastError: Record<string, unknown> }[] };
    extra.future = 1;
    extra.server.future = 'x';
    extra.health[0]!.future = true;
    extra.jobs[0]!.lastError.future = 2;
    const { requests } = stubApi({ 'GET /api/diagnostics/summary': extra });
    expect(await getDiagnosticsSummary()).toEqual(summary());
    expect(requests[0]?.headers.get('X-Portly')).toBe('1');
  });

  it('refuses an answer that is not a summary', async () => {
    const broken = { ...summary(), health: [{ ...summary().health[0], status: 'on fire' }] };
    stubApi({ 'GET /api/diagnostics/summary': broken });
    await expect(getDiagnosticsSummary()).rejects.toThrow();
    stubApi({ 'GET /api/diagnostics/summary': mockError(403, 'local_only', 'Only on this PC') });
    await expect(getDiagnosticsSummary()).rejects.toMatchObject({ status: 403, code: 'local_only' });
  });
});

describe('requests', () => {
  it('sends only the log filters that are set, in the contract order', async () => {
    expect(logsQueryString({})).toBe('');
    expect(logsQueryString({ q: 'token refresh', level: 'warn', scope: 'memory', after: 0, area: '', rid: undefined, limit: 200 })).toBe(
      '?scope=memory&after=0&level=warn&q=token+refresh&limit=200',
    );
    const record = { seq: 3, t: T, tEvent: null, level: 'warn', msg: 'calendar failing', src: 'server', area: 'calendar', tags: ['calendar'], rid: null, fields: { key: 'calendar:cal-1' }, future: 1 };
    const { requests } = stubApi({ 'GET /api/diagnostics/logs': { records: [record], lastSeq: 3, truncated: false, scope: 'memory' } });
    const { future: _future, ...expected } = record;
    expect(await getDiagnosticsLogs({ level: 'warn', key: 'calendar:cal-1' })).toEqual({ records: [expected], lastSeq: 3, truncated: false, scope: 'memory' });
    expect(requests[0]?.search).toBe('?level=warn&key=calendar%3Acal-1');
  });

  it('encodes health keys and job names into the path', async () => {
    const row = { id: 1, key: 'ics:a/b', at: T, lastAt: T, count: 2, ok: false, status: 'failing', code: 'dns', httpStatus: null, message: 'x', ms: 3, detail: null };
    const { requests } = stubApi({
      'GET /api/diagnostics/health/:key/history': { key: 'ics:a/b', rows: [row] },
      'POST /api/diagnostics/jobs/:name/run': mockResponse(202, { started: true }),
    });
    expect(await getHealthHistory('ics:a/b', { limit: 50 })).toEqual({ key: 'ics:a/b', rows: [row] });
    expect(requests[0]?.path).toBe('/api/diagnostics/health/ics%3Aa%2Fb/history');
    expect(requests[0]?.search).toBe('?limit=50');
    expect(await runJob('calendar:sync')).toEqual({ started: true });
    expect(requests[1]?.path).toBe('/api/diagnostics/jobs/calendar%3Async/run');
    expect(requests[1]?.method).toBe('POST');
  });

  it('switches the log level', async () => {
    const state = { ...LOG_LEVEL, level: 'debug', verbose: true, until: T, persisted: true };
    const { requests } = stubApi({ 'PUT /api/diagnostics/level': state });
    expect(await setLogLevel({ verbose: true, minutes: 30 })).toEqual(state);
    expect(requests[0]?.body).toEqual({ verbose: true, minutes: 30 });
  });

  it('uploads recorded events as the contract wants them', async () => {
    recordClientEvent('warn', 'api', 'request failed', { method: 'GET', path: '/api/feeds?url=x', status: 0, code: 'network_error' });
    recordClientEvent('info', 'hybrid', 'status changed', { from: 'connected', to: 'reconnecting' });
    const { requests } = stubApi({ 'POST /api/diagnostics/client-events': { accepted: 2, dropped: 0, acceptDebug: false } });
    const body = { sentAt: T, events: pendingUpload(false).map((entry) => entry.event) };
    expect(await postClientEvents(body)).toEqual({ accepted: 2, dropped: 0, acceptDebug: false });
    expect(ClientEventsRequestSchema.safeParse(requests[0]?.body).success).toBe(true);
  });
});

describe('downloadReport', () => {
  function stubReport(response: () => Response) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns the report as sent and the file name the server suggests', async () => {
    const fetchMock = stubReport(
      () =>
        new Response('{"generatedAt":"x"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="portly-diagnostics-20261011-1432.json"' },
        }),
    );
    const report = await downloadReport({ redact: true });
    expect(report.filename).toBe('portly-diagnostics-20261011-1432.json');
    expect(await report.blob.text()).toBe('{"generatedAt":"x"}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/diagnostics/report?redact=1');
    expect(new Headers(init?.headers).get('X-Portly')).toBe('1');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    await downloadReport({ redact: false });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/diagnostics/report?redact=0');
  });

  it('falls back to a plain file name', async () => {
    stubReport(() => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await downloadReport({ redact: false })).filename).toBe(DEFAULT_REPORT_FILENAME);
    expect(reportFilename(null)).toBe(DEFAULT_REPORT_FILENAME);
    expect(reportFilename('attachment; filename=portly-diagnostics-20261011-1432.json')).toBe('portly-diagnostics-20261011-1432.json');
    expect(reportFilename("attachment; filename=\"x.json\"; filename*=UTF-8''portly-diagnostics-1.json")).toBe('portly-diagnostics-1.json');
    for (const unsafe of ['attachment; filename="../../evil.json"', 'attachment; filename="report.exe"', 'attachment; filename=".json"', "attachment; filename*=UTF-8''%E0%A4%A.json", 'attachment']) {
      expect(reportFilename(unsafe), unsafe).toBe(DEFAULT_REPORT_FILENAME);
    }
  });

  it('reports errors like every other API call', async () => {
    stubReport(() => new Response(JSON.stringify({ error: { code: 'local_only', message: 'Only on this PC' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    await expect(downloadReport({ redact: false })).rejects.toMatchObject({ status: 403, code: 'local_only', message: 'Only on this PC' });
    stubReport(() => new Response('<html>', { status: 404 }));
    await expect(downloadReport({ redact: false })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const error = await downloadReport({ redact: false }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('caching', () => {
  it('never persists the diagnostics family', () => {
    const client = createTestQueryClient();
    client.setQueryData(qk.diagnostics.summary(), summary());
    client.setQueryData(qk.diagnostics.logs({ level: 'warn' }), { records: [], lastSeq: 0, truncated: false, scope: 'memory' });
    client.setQueryData(qk.settings(), { theme: 'light' });
    const cache = client.getQueryCache();
    expect(shouldPersistQuery(cache.find({ queryKey: qk.diagnostics.summary() })!)).toBe(false);
    expect(shouldPersistQuery(cache.find({ queryKey: qk.diagnostics.logs({ level: 'warn' }) })!)).toBe(false);
    expect(shouldPersistQuery(cache.find({ queryKey: qk.settings() })!)).toBe(true);
  });

  it('forgets a log page and a history a minute after nothing shows them (not after the app’s 24 h)', async () => {
    stubApi({
      'GET /api/diagnostics/logs': { records: [], lastSeq: 0, truncated: false, scope: 'memory' },
      'GET /api/diagnostics/health/:key/history': { key: 'feed:abc', rows: [] },
    });
    const { client, wrapper: Wrapper } = wrapper();
    const hook = renderHook(() => ({ logs: useDiagnosticsLogs({ level: 'warn' }), history: useHealthHistory('feed:abc') }), { wrapper: Wrapper });
    await waitFor(() => expect(hook.result.current.logs.data).toBeDefined());
    await waitFor(() => expect(hook.result.current.history.data).toBeDefined());
    vi.useFakeTimers();
    try {
      hook.unmount();
      const cache = client.getQueryCache();
      expect(cache.find({ queryKey: qk.diagnostics.logs({ level: 'warn' }) })).toBeDefined();
      vi.advanceTimersByTime(DIAGNOSTICS_GC_MS);
      expect(cache.find({ queryKey: qk.diagnostics.logs({ level: 'warn' }) })).toBeUndefined();
      expect(cache.find({ queryKey: qk.diagnostics.history('feed:abc') })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks its queries not to persist; a log level change shows in the summary', async () => {
    let logLevel: DiagnosticsSummary['logLevel'] = { ...LOG_LEVEL };
    const { requests } = stubApi({
      'GET /api/diagnostics/summary': () => ({ ...summary(), logLevel }),
      'PUT /api/diagnostics/level': () => {
        logLevel = { ...LOG_LEVEL, level: 'debug', verbose: true };
        return logLevel;
      },
    });
    const { client, wrapper: Wrapper } = wrapper();
    const hook = renderHook(() => ({ summary: useDiagnosticsSummary({ refetchInterval: false }), setLevel: useSetLogLevel() }), { wrapper: Wrapper });
    await waitFor(() => expect(hook.result.current.summary.data).toEqual(summary()));
    expect(client.getQueryCache().find({ queryKey: qk.diagnostics.summary() })?.meta).toEqual({ persist: false });
    await act(async () => {
      await hook.result.current.setLevel.mutateAsync({ verbose: true, minutes: null });
    });
    expect(client.getQueryData<DiagnosticsSummary>(qk.diagnostics.summary())?.logLevel).toEqual({ ...LOG_LEVEL, level: 'debug', verbose: true });
    expect(requests.filter((r) => r.method === 'GET' && r.path === '/api/diagnostics/summary')).toHaveLength(2);
  });
});
