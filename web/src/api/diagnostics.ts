/**
 * Settings → Diagnostics API (ARCHITECTURE §17): the server's summary (version, health of every
 * synced subject, jobs, log level, hybrid state), its log records, a subject's outcome history,
 * the verbose switch, running a job now, the diagnostic report, and the upload of this browser's
 * events (`diagnostics/upload.ts`). Responses are parsed with the shared contracts, read
 * tolerantly: unknown fields from a newer server are dropped, not fatal (the page and the server
 * may run different versions — the Diagnostics page is where that shows).
 *
 * Nothing here is persisted (`meta: {persist: false}`, and the whole `['diagnostics']` family is in
 * NON_PERSISTED_ROOTS): it must show the server's state now, and on the Pages site localStorage is
 * shared with every project site of the origin. Every route is paired: the Pages site may call
 * them all. A server older than these routes answers the Pages site `403 local_only` and its own
 * page `404`: diagnostics unavailable there.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ClientEventsResponseSchema,
  DiagnosticsSummarySchema,
  HealthHistoryResponseSchema,
  LogLevelStateSchema,
  LogsQuerySchema,
  LogsResponseSchema,
  type ClientEventsRequest,
  type ClientEventsResponse,
  type DiagnosticsSummary,
  type HealthHistoryResponse,
  type LogLevelState,
  type LogsQuery,
  type LogsResponse,
  type SetLogLevelInput,
} from '@homebase/shared';
import { apiGet, apiPath, apiPost, apiPut, apiResponse } from './client.ts';
import { qk } from './keys.ts';

/** Filters of `GET /api/diagnostics/logs` (every one optional; the server fills in the defaults). */
export type DiagnosticsLogsFilters = Partial<LogsQuery>;

/** The diagnostic report as the server sent it, and the file name it suggested. */
export interface DiagnosticsReportFile {
  blob: Blob;
  filename: string;
}

/** The summary refreshes while the page shows it (paused while the tab is hidden). */
export const DIAGNOSTICS_SUMMARY_REFRESH_MS = 30_000;
/** File name of a report whose `Content-Disposition` names none (or nothing plain). */
export const DEFAULT_REPORT_FILENAME = 'homebase-diagnostics.json';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** `schema` with every object, nested ones included, in zod's default mode (unknown keys dropped). */
function loosen(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape)) shape[key] = loosen(value as z.ZodType);
    return z.object(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(loosen(schema.element as z.ZodType));
  if (schema instanceof z.ZodNullable) return loosen(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodOptional) return loosen(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodRecord) return z.record(schema.keyType, loosen(schema.valueType as z.ZodType));
  return schema;
}

/**
 * Tolerant reader of a strict shared DTO: the same fields and checks, the same output type, but
 * fields a newer server adds (at any depth) are dropped instead of failing the parse.
 */
function tolerant<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>> {
  return loosen(schema) as z.ZodType<z.output<T>>;
}

const SummaryReader = tolerant(DiagnosticsSummarySchema);
const LogsReader = tolerant(LogsResponseSchema);
const HistoryReader = tolerant(HealthHistoryResponseSchema);
const LogLevelReader = tolerant(LogLevelStateSchema);
const ClientEventsReader = tolerant(ClientEventsResponseSchema);
/** `POST /api/diagnostics/jobs/:name/run` answers `202 {started: true}`. */
const RunJobReader = z.object({ started: z.boolean() });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The query order of the contract, so that equal filters give equal URLs. */
const LOGS_QUERY_KEYS = Object.keys(LogsQuerySchema.shape) as (keyof LogsQuery)[];

/** `?scope=…&level=…` for the filters that are set (`''` and null count as unset). */
export function logsQueryString(filters: DiagnosticsLogsFilters): string {
  const params = new URLSearchParams();
  for (const key of LOGS_QUERY_KEYS) {
    const value: unknown = filters[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** `GET /api/diagnostics/summary`. */
export async function getDiagnosticsSummary(signal?: AbortSignal): Promise<DiagnosticsSummary> {
  return SummaryReader.parse(await apiGet<unknown>('/api/diagnostics/summary', { signal }));
}

/** `GET /api/diagnostics/logs?…`. */
export async function getDiagnosticsLogs(filters: DiagnosticsLogsFilters = {}, signal?: AbortSignal): Promise<LogsResponse> {
  return LogsReader.parse(await apiGet<unknown>(`/api/diagnostics/logs${logsQueryString(filters)}`, { signal }));
}

/** `GET /api/diagnostics/health/:key/history?limit=` (≤ 500 rows). */
export async function getHealthHistory(key: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<HealthHistoryResponse> {
  const query = options.limit === undefined ? '' : `?limit=${encodeURIComponent(String(options.limit))}`;
  return HistoryReader.parse(await apiGet<unknown>(`${apiPath`/api/diagnostics/health/${key}/history`}${query}`, { signal: options.signal }));
}

/** `PUT /api/diagnostics/level`: verbose on (for `minutes`, or until turned off: null) or off. */
export async function setLogLevel(body: SetLogLevelInput): Promise<LogLevelState> {
  return LogLevelReader.parse(await apiPut<unknown>('/api/diagnostics/level', body));
}

/** `POST /api/diagnostics/jobs/:name/run`: starts the job now (the answer does not wait for it). */
export async function runJob(name: string): Promise<{ started: boolean }> {
  return RunJobReader.parse(await apiPost<unknown>(apiPath`/api/diagnostics/jobs/${name}/run`));
}

/** `POST /api/diagnostics/client-events`: this browser's events. */
export async function postClientEvents(body: ClientEventsRequest, signal?: AbortSignal): Promise<ClientEventsResponse> {
  return ClientEventsReader.parse(await apiPost<unknown>('/api/diagnostics/client-events', body, { signal }));
}

/**
 * The file name a report's `Content-Disposition` suggests (`filename*=UTF-8''…` or `filename=`),
 * when it is a plain `.json` name (no path, no unusual characters); else
 * {@link DEFAULT_REPORT_FILENAME}.
 */
export function reportFilename(contentDisposition: string | null): string {
  if (contentDisposition === null) return DEFAULT_REPORT_FILENAME;
  let name: string | null = null;
  const extended = /\bfilename\*\s*=\s*utf-8''([^;\s]+)/i.exec(contentDisposition);
  if (extended?.[1] !== undefined) {
    try {
      name = decodeURIComponent(extended[1]);
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /\bfilename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(contentDisposition);
    name = plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2] ?? null;
  }
  return name !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(name) ? name : DEFAULT_REPORT_FILENAME;
}

/**
 * `GET /api/diagnostics/report?redact=0|1`: the report as sent, and the
 * file name from `Content-Disposition`. `redact` replaces hosts, emails and names (for sharing).
 */
export async function downloadReport(options: { redact: boolean; signal?: AbortSignal }): Promise<DiagnosticsReportFile> {
  const res = await apiResponse(`/api/diagnostics/report?redact=${options.redact ? '1' : '0'}`, { signal: options.signal });
  return { blob: await res.blob(), filename: reportFilename(res.headers.get('Content-Disposition')) };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface DiagnosticsQueryOptions {
  enabled?: boolean;
  /** Polling interval (ms), or false for none. */
  refetchInterval?: number | false;
  /** Refetch when the tab is shown again (unset: the client's default, true in the app). */
  refetchOnWindowFocus?: boolean;
}

/**
 * How long a log page or a subject's history stays cached once nothing shows it. Every filter set
 * and search pause is a key of its own (up to 500 records), and the page that holds them may stay
 * open for days: unlike the app's 24 h default, which serves the persisted cache these never join.
 */
export const DIAGNOSTICS_GC_MS = 60_000;

export function useDiagnosticsSummary(options: DiagnosticsQueryOptions = {}) {
  return useQuery({
    queryKey: qk.diagnostics.summary(),
    queryFn: ({ signal }) => getDiagnosticsSummary(signal),
    staleTime: 5_000,
    refetchInterval: options.refetchInterval ?? DIAGNOSTICS_SUMMARY_REFRESH_MS,
    enabled: options.enabled ?? true,
    meta: { persist: false },
  });
}

/** One query per filter set (Live polling with `after=` belongs in component state, not in new keys). */
export function useDiagnosticsLogs(filters: DiagnosticsLogsFilters, options: DiagnosticsQueryOptions = {}) {
  return useQuery({
    queryKey: qk.diagnostics.logs(filters),
    queryFn: ({ signal }) => getDiagnosticsLogs(filters, signal),
    staleTime: 0,
    gcTime: DIAGNOSTICS_GC_MS,
    refetchInterval: options.refetchInterval ?? false,
    // Unset keeps the client's default (an explicit undefined would replace it).
    ...(options.refetchOnWindowFocus === undefined ? {} : { refetchOnWindowFocus: options.refetchOnWindowFocus }),
    enabled: options.enabled ?? true,
    meta: { persist: false },
  });
}

/** A subject's outcome history; disabled while `key` is null. */
export function useHealthHistory(key: string | null, options: DiagnosticsQueryOptions = {}) {
  return useQuery({
    queryKey: qk.diagnostics.history(key ?? ''),
    queryFn: ({ signal }) => getHealthHistory(key ?? '', { signal }),
    staleTime: 0,
    gcTime: DIAGNOSTICS_GC_MS,
    refetchInterval: options.refetchInterval ?? false,
    enabled: key !== null && (options.enabled ?? true),
    meta: { persist: false },
  });
}

/** Switches verbose logging; the summary shows the new level at once, then everything refetches. */
export function useSetLogLevel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetLogLevelInput) => setLogLevel(body),
    onSuccess: async (logLevel) => {
      client.setQueryData<DiagnosticsSummary>(qk.diagnostics.summary(), (summary) => (summary === undefined ? summary : { ...summary, logLevel }));
      await client.invalidateQueries({ queryKey: qk.diagnostics.all() });
    },
  });
}

/** Runs a job now; the summary refetches (the run itself is reported by the job's own stats). */
export function useRunJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => runJob(name),
    onSettled: () => client.invalidateQueries({ queryKey: qk.diagnostics.summary() }),
  });
}
