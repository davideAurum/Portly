/**
 * Runs an iCalendar parse/expand job in a `worker_threads` worker (§4.9):
 * `resourceLimits: {maxOldGenerationSizeMb: 256}` and a 5 s wall-clock timeout after which the
 * worker is terminated. A fresh worker per job keeps ical.js's global TimezoneService and any
 * memory a hostile feed allocated isolated from every other job.
 *
 * The worker is spawned in the caller's log context (§3); a job that ends without a result
 * (crash, exit, timeout, start failure) is logged by the parent with codes only (`workers.ts`).
 */
import { Worker } from 'node:worker_threads';
import type { Logger } from '../../../lib/logger.ts';
import { logWorkerFailure } from '../workers.ts';
import type { ExpandFailure, ExpandJob, ExpandResult } from './expand.ts';

export const PARSE_TIMEOUT_MS = 5_000;
export const PARSE_MAX_OLD_GENERATION_MB = 256;

export interface RunOptions {
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  /** Worker entry (tests); default `./worker.ts`. */
  workerUrl?: URL;
}

export type ExpandRunner = (job: ExpandJob, options?: RunOptions) => Promise<ExpandResult>;

const WORKER_URL = new URL('./worker.ts', import.meta.url);

/**
 * True for the worker's result message. Other messages can arrive on the same port — under
 * `node --watch` (npm run dev) Node itself posts `{'watch:import': [...]}` from every worker —
 * and must never be mistaken for the result.
 */
export function isExpandResult(value: unknown): value is ExpandResult {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; events?: unknown; reason?: unknown; message?: unknown };
  if (v.ok === true) return Array.isArray(v.events);
  return v.ok === false && typeof v.reason === 'string' && typeof v.message === 'string';
}

/**
 * Health code (for `outcomeFromError`) of a failed job, set as `details.reason` on the HttpError that reports it:
 * unreadable data → `parse_error`, a limit → `too_large`, the time budget → `timeout`, anything
 * else (the worker crashed or stopped) → `worker_failed`.
 */
export function expandFailureCode(reason: ExpandFailure): 'parse_error' | 'too_large' | 'timeout' | 'worker_failed' {
  switch (reason) {
    case 'invalid':
      return 'parse_error';
    case 'limit':
      return 'too_large';
    case 'timeout':
      return 'timeout';
    default:
      return 'worker_failed';
  }
}

function jobBytes(job: ExpandJob): number {
  let bytes = 0;
  for (const source of job.sources ?? []) if (typeof source.data === 'string') bytes += Buffer.byteLength(source.data);
  return bytes;
}

/** An {@link ExpandRunner}; with `log`, jobs that end without a result are logged (`calendar worker failed`). */
export function createExpandRunner(deps: { log?: Logger } = {}): ExpandRunner {
  const { log } = deps;
  return (job, options = {}) => {
    const timeoutMs = options.timeoutMs ?? PARSE_TIMEOUT_MS;
    const started = Date.now();
    return new Promise<ExpandResult>((resolve) => {
      let settled = false;
      let worker: Worker;
      try {
        worker = new Worker(options.workerUrl ?? WORKER_URL, {
          workerData: job,
          resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? PARSE_MAX_OLD_GENERATION_MB },
          stdout: true,
          stderr: true,
        });
      } catch (err) {
        logWorkerFailure(log, 'expand', { reason: 'error', err, ms: Date.now() - started, bytes: jobBytes(job) });
        resolve({ ok: false, reason: 'error', message: 'The calendar parser could not start' });
        return;
      }
      worker.stdout.resume();
      worker.stderr.resume();
      const finish = (result: ExpandResult, failure?: { exitCode?: number; err?: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().catch(() => {});
        if (failure !== undefined && !result.ok) {
          logWorkerFailure(log, 'expand', { reason: result.reason, ...failure, ms: Date.now() - started, bytes: jobBytes(job) });
        }
        resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish({ ok: false, reason: 'timeout', message: 'Reading the calendar took too long (it may have too many long-running repeating events)' }, {}),
        timeoutMs,
      );
      timer.unref();
      worker.on('message', (message: unknown) => {
        if (isExpandResult(message)) finish(message);
      });
      worker.once('error', (err: Error & { code?: string }) => {
        const outOfMemory = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
        finish(
          {
            ok: false,
            reason: outOfMemory ? 'limit' : 'error',
            message: outOfMemory ? 'The calendar is too large to read' : 'The calendar data could not be read',
          },
          { err },
        );
      });
      worker.once('exit', (exitCode: number) =>
        finish({ ok: false, reason: 'error', message: 'The calendar parser stopped unexpectedly' }, { exitCode }),
      );
    });
  };
}

/** Runner without failure logging (tests, callers without a logger). */
export const runExpandJob: ExpandRunner = createExpandRunner();
