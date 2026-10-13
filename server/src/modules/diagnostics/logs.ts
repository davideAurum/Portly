/**
 * `GET /api/diagnostics/logs` (ARCHITECTURE §17): log records from memory (the log hub's
 * rings, `scope=memory`, polled with `after=<lastSeq>`) or from the log files (`scope=files`,
 * "Show older"). Both take the same filters: time window, minimum level, area (any tag), source,
 * request id, the context fields `job`/`run`/`accountId`/`calendarId`/`feed`/`pairingId`, a
 * health `key` (mapped to the field its unit of work sets, `contextFieldForKey`) and a text search.
 */
import type { LogsQuery, LogsResponse } from '@homebase/shared';
import { contextFieldForKey } from '../../lib/health.ts';
import type { LogHub, LogQuery, LogRecordOut } from '../../lib/logger.ts';
import { readLogRecords, type RecordFilter, type ScanOptions } from './log-files.ts';

/** Query keys that filter on a context field of the same name. */
const FIELD_FILTERS = ['job', 'run', 'accountId', 'calendarId', 'feed', 'pairingId'] as const;
/** The hub returns at most this many records per query. */
const HUB_QUERY_LIMIT = 5000;

/** The filters of a query resolved; null when they contradict each other (nothing can match). */
export function resolveLogFilter(query: LogsQuery): RecordFilter | null {
  const fieldEquals: Record<string, string> = {};
  for (const name of FIELD_FILTERS) {
    const value = query[name];
    if (value !== undefined) fieldEquals[name] = value;
  }
  let area = query.area?.toLowerCase();
  let alsoArea: string | undefined;
  if (query.key !== undefined) {
    const mapped = contextFieldForKey(query.key);
    if ('field' in mapped) {
      const given = fieldEquals[mapped.field];
      if (given !== undefined && given !== mapped.value) return null;
      fieldEquals[mapped.field] = mapped.value;
    } else if (area === undefined) {
      area = mapped.area;
    } else if (area !== mapped.area) {
      alsoArea = mapped.area;
    }
  }
  const filter: RecordFilter = { level: query.level, fieldEquals };
  if (query.since !== undefined) filter.since = Date.parse(query.since);
  if (query.before !== undefined) filter.before = Date.parse(query.before);
  if (area !== undefined) filter.area = area;
  if (alsoArea !== undefined) filter.alsoArea = alsoArea;
  if (query.src !== undefined) filter.src = query.src;
  if (query.rid !== undefined) filter.rid = query.rid;
  if (query.q !== undefined && query.q !== '') filter.q = query.q;
  return filter;
}

/** The newest seq the hub has written (for `after=` polling). */
function hubLastSeq(logs: LogHub): number {
  return logs.query({ after: Number.MAX_SAFE_INTEGER, limit: 1 }).lastSeq;
}

/** `scope=memory`: the newest `limit` matches in the rings, oldest first. */
export function queryMemoryLogs(logs: LogHub, query: LogsQuery): LogsResponse {
  const filter = resolveLogFilter(query);
  if (filter === null) return { records: [], lastSeq: hubLastSeq(logs), truncated: false, scope: 'memory' };
  const hubQuery: LogQuery = { level: filter.level, fieldEquals: filter.fieldEquals, limit: query.limit };
  if (query.after !== undefined) hubQuery.after = query.after;
  if (filter.since !== undefined) hubQuery.since = filter.since;
  if (filter.before !== undefined) hubQuery.before = filter.before;
  if (filter.area !== undefined) hubQuery.area = filter.area;
  if (filter.src !== undefined) hubQuery.src = filter.src;
  if (filter.rid !== undefined) hubQuery.rid = filter.rid;
  if (filter.q !== undefined) hubQuery.q = filter.q;
  if (filter.alsoArea === undefined) {
    const result = logs.query(hubQuery);
    return { records: result.records, lastSeq: result.lastSeq, truncated: result.truncated, scope: 'memory' };
  }
  // Two areas: the hub filters one, the second is applied to everything it has.
  const alsoArea = filter.alsoArea;
  const result = logs.query({ ...hubQuery, limit: HUB_QUERY_LIMIT });
  const matches: LogRecordOut[] = result.records.filter((rec) => rec.tags.includes(alsoArea));
  return {
    records: matches.slice(-query.limit),
    lastSeq: result.lastSeq,
    truncated: result.truncated || matches.length > query.limit,
    scope: 'memory',
  };
}

/** `scope=files`: the newest `limit` matches in `file` and its rotations, oldest first (`after` does not apply). */
export async function queryFileLogs(file: string, logs: LogHub, query: LogsQuery, options: ScanOptions = {}): Promise<LogsResponse> {
  const filter = resolveLogFilter(query);
  const lastSeq = hubLastSeq(logs);
  if (filter === null) return { records: [], lastSeq, truncated: false, scope: 'files' };
  const { records, truncated } = await readLogRecords(file, filter, query.limit, options);
  return { records, lastSeq, truncated, scope: 'files' };
}
