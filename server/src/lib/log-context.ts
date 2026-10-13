/**
 * Log context (ARCHITECTURE §3, §17): one `AsyncLocalStorage` carrying the unit of work a log line
 * belongs to — request id, job and run, area, account/calendar/feed ids. The logger merges it into
 * every record, so code deep inside a sync never has to pass ids down for logging.
 *
 * Propagation rules (Node 24):
 * 1. Timers capture the context where they are created: a timer that re-arms or outlives the unit of
 *    work (scheduler `arm()`, job watchdog, request-still-running timer, sweeps, rate-limit resets)
 *    is created inside {@link outsideLogContext}.
 * 2. Promise continuations run in the context where `.then`/`await` was attached. Shared or
 *    single-flight promises run their body in the first caller's context: put
 *    `withLogContext({accountId, …})` inside the shared body.
 * 3. EventEmitter listeners run in the `emit()` context (listeners called synchronously by a request
 *    inherit its rid on purpose).
 * 4. Per-call I/O resources (Worker, child process, socket) run their listeners in the context active
 *    at creation: spawn per-call workers inside the caller's context, never via `outsideLogContext`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface LogContext {
  rid?: string;
  job?: string;
  run?: string;
  area?: string;
  accountId?: string;
  calendarId?: string;
  feed?: string;
  pairingId?: string;
  op?: string;
  /** Debug records of this unit of work skip the memory rings (health checks, the Diagnostics page's own polling). */
  quiet?: boolean;
  [k: string]: string | boolean | undefined;
}

const storage = new AsyncLocalStorage<Readonly<LogContext>>();

/** The current context, or undefined outside any unit of work. */
export function getLogContext(): Readonly<LogContext> | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with the current context extended by `fields`. A key given as `undefined` clears the
 * inherited value (e.g. `{rid: undefined}` inside a request).
 */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(Object.freeze({ ...parent, ...fields }), fn);
}

/** Runs `fn` with no context (timers and sweeps that outlive the unit of work that created them). */
export function outsideLogContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Largest multiple of 36 below 256: bytes at or above it are skipped so every character is equally likely. */
const UNBIASED_LIMIT = 252;

function randomId(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Request id: 10 random characters `[a-z0-9]` (matches `REQUEST_ID_REGEX`). */
export function newRequestId(): string {
  return randomId(10);
}

/** Job run id: 6 random characters `[a-z0-9]`. */
export function newRunId(): string {
  return randomId(6);
}
