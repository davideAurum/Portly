/**
 * Failure lines of the module's per-call workers (§3, §17): the iCalendar parse/expand worker
 * (`ical/run.ts`) and the CalDAV XML worker (`providers/dav-xml.ts`). The parent logs why a worker
 * gave no result — `{worker, reason, exitCode?, errName?, errCode?, ms, bytes}`, codes only, never
 * the worker's error message (it may quote the data being parsed). Workers are spawned inside the
 * caller's log context, so the line carries the sync's job/run, account and calendar.
 *
 * Crashes (`error`) are warnings; hitting the heap or time limit (`limit`, `timeout`) is a property
 * of the data and is logged at info — the calendar's health records the failure either way.
 * Repeats of the same failure collapse in the logger (`repeatKey`).
 */
import type { Logger } from '../../lib/logger.ts';

export type CalendarWorker = 'expand' | 'dav-xml';

export interface WorkerFailure {
  /** The failure reported to the caller (`limit`, `timeout`, `error`). */
  reason: string;
  /** Exit code when the worker exited without a result. */
  exitCode?: number;
  /** The worker's error (`error` event, or the failure to start it): name and code only. */
  err?: unknown;
  /** Wall-clock time since the job started. */
  ms: number;
  /** Size of the job's input (UTF-8 bytes). */
  bytes: number;
}

function errorCodes(err: unknown): { errName?: string; errCode?: string | number } {
  if (err === null || typeof err !== 'object') return {};
  const e = err as { name?: unknown; code?: unknown };
  const out: { errName?: string; errCode?: string | number } = {};
  if (typeof e.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.name)) out.errName = e.name;
  if (typeof e.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(e.code)) out.errCode = e.code;
  else if (typeof e.code === 'number' && Number.isFinite(e.code)) out.errCode = e.code;
  return out;
}

export function logWorkerFailure(log: Logger | undefined, worker: CalendarWorker, failure: WorkerFailure): void {
  if (!log) return;
  const level = failure.reason === 'error' ? 'warn' : 'info';
  const codes = errorCodes(failure.err);
  log[level]('calendar worker failed', {
    worker,
    reason: failure.reason,
    ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
    ...codes,
    ms: failure.ms,
    bytes: failure.bytes,
    repeatKey: `calendar worker ${worker} ${failure.reason}`,
    repeatSig: `${failure.exitCode ?? ''}|${codes.errCode ?? codes.errName ?? ''}`,
  });
}
