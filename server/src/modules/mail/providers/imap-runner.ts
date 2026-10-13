/**
 * Runs IMAP sessions (§8 Generic IMAP) where a hostile server cannot stall Portly.
 *
 * imapflow tokenizes every server response synchronously, and its tokenizer is super-linear on
 * some inputs (e.g. long runs of `[`), reachable from the greeting — before authentication and,
 * for STARTTLS accounts, before the TLS upgrade. {@link runImapJobInWorker} therefore runs the
 * whole session (connect, STATUS, lock, search/fetch or action, logout) in a `worker_threads`
 * worker with `resourceLimits` and a wall-clock cap, terminated on expiry or when the caller's
 * AbortSignal fires. Only plain job data goes in and only mapped-down results, phase reports,
 * connection-error codes or a sanitized error come out (imap-session.ts). {@link inProcessImapRunner}
 * runs the same job on the calling thread with an injected client factory (tests use the fake IMAP
 * server).
 *
 * Diagnostics (§17): the worker is spawned in the caller's log context (log-context rule 4),
 * so its lifecycle lines carry the request/job and account. A worker that cannot start, crashes
 * (`error`, e.g. ERR_WORKER_OUT_OF_MEMORY) or exits without a result is logged as a warning with
 * the phase it was in and the error's name/code only (never its message or stack: server text,
 * user paths), and rejects with an {@link ImapWorkerError} — Portly's failure, not the server's.
 */
import { Worker } from 'node:worker_threads';
import { errorFields, type Logger } from '../../../lib/logger.ts';
import {
  deserializeImapError,
  imapErrorFields,
  isImapPhase,
  runImapJob,
  runImapSession,
  type ImapClientFactory,
  type ImapConnectionParams,
  type ImapJob,
  type ImapJobOutput,
  type ImapPhase,
  type SerializedImapError,
} from './imap-session.ts';

export interface ImapRunOptions {
  signal: AbortSignal;
  /** Connection-level 'error' events (debug logging only; from a worker: codes and flags only). */
  onConnectionError?: ((err: Error) => void) | undefined;
  /** Each session phase as it is entered (stage of a failure or a timeout). */
  onPhase?: ((phase: ImapPhase) => void) | undefined;
  /** Worker lifecycle lines (start failure, crash, exit without a result, cancellation). */
  log?: Logger | undefined;
}

/**
 * Runs `job` on one short-lived connection. Rejects with the raw session error (an
 * `ImapOpError`, `ImapAuthError`, an imapflow-like error or an {@link ImapWorkerError}) —
 * imap.ts maps it.
 */
export type ImapSessionRunner = (params: ImapConnectionParams, job: ImapJob, options: ImapRunOptions) => Promise<ImapJobOutput>;

/** Same thread, injected client factory (tests). */
export function inProcessImapRunner(connect: ImapClientFactory): ImapSessionRunner {
  return (params, job, options) =>
    runImapSession(
      connect,
      params,
      { signal: options.signal, onConnectionError: options.onConnectionError, onPhase: options.onPhase },
      (client, report) => runImapJob(client, job, report),
    );
}

/** The session worker failed itself — it could not start, crashed, or exited without a result. */
export class ImapWorkerError extends Error {
  override name = 'ImapWorkerError';
  readonly reason: 'start' | 'error' | 'exit';

  constructor(reason: 'start' | 'error' | 'exit', message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Hard cap on one session, whatever the caller's signal (all callers also pass a shorter one). */
export const IMAP_WORKER_TIMEOUT_MS = 30_000;
export const IMAP_WORKER_MAX_OLD_GENERATION_MB = 96;
/** After the result is in, the worker may finish its polite LOGOUT for this long. */
export const IMAP_WORKER_LOGOUT_GRACE_MS = 5_000;

const WORKER_URL = new URL('./imap-worker.ts', import.meta.url);

export interface WorkerRunnerOptions {
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
  /** Worker entry (tests); default `./imap-worker.ts`. */
  workerUrl?: URL;
}

type ResultMessage = { ok: true; output: ImapJobOutput } | { ok: false; error: SerializedImapError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isResultMessage(value: unknown): value is ResultMessage {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isRecord(value.output);
  return value.ok === false && isRecord(value.error);
}

/** `{connectionError: fields}` → an Error carrying only those codes and flags (re-checked here). */
function connectionErrorOf(value: unknown): Error | null {
  if (!isRecord(value) || !isRecord(value.connectionError)) return null;
  return Object.assign(new Error('IMAP connection error'), imapErrorFields(value.connectionError));
}

/** Error the mapper reports as `upstream_timeout`. */
function timeoutError(): Error {
  return Object.assign(new Error('IMAP session timed out'), { code: 'ETIMEOUT' });
}

/** Name and code of a worker failure — never its message or stack. */
function failureCodes(err: unknown): { errName?: unknown; errCode?: unknown } {
  const { errName, errCode } = errorFields(err);
  return errCode === undefined ? { errName } : { errName, errCode };
}

export function createWorkerImapRunner(options: WorkerRunnerOptions = {}): ImapSessionRunner {
  const timeoutMs = options.timeoutMs ?? IMAP_WORKER_TIMEOUT_MS;
  return (params, job, runOptions) =>
    new Promise<ImapJobOutput>((resolve, reject) => {
      const { signal, log } = runOptions;
      if (signal.aborted) {
        reject(timeoutError());
        return;
      }
      const started = Date.now();
      let phase: ImapPhase | null = null;
      const facts = (): Record<string, unknown> => ({ op: job.op, phase, ms: Date.now() - started });

      let worker: Worker;
      try {
        // Created in the caller's log context on purpose: its listeners log with the caller's ids.
        worker = new Worker(options.workerUrl ?? WORKER_URL, {
          workerData: { params, job },
          resourceLimits: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? IMAP_WORKER_MAX_OLD_GENERATION_MB },
          stdout: true,
          stderr: true,
        });
      } catch (err) {
        log?.warn('imap worker could not start', { op: job.op, ...failureCodes(err) });
        reject(new ImapWorkerError('start', 'The IMAP worker could not start'));
        return;
      }
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        void worker.terminate().catch(() => {});
      };
      const settle = (outcome: () => void, terminateNow: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (terminateNow) {
          stop();
        } else {
          // Let the worker send LOGOUT, but never keep it around for long.
          graceTimer = setTimeout(stop, IMAP_WORKER_LOGOUT_GRACE_MS);
          graceTimer.unref();
        }
        outcome();
      };
      const cancel = (by: 'caller' | 'cap'): void => {
        if (settled) return;
        log?.[by === 'cap' ? 'info' : 'debug']('imap session cancelled', { by, ...facts() });
        settle(() => reject(timeoutError()), true);
      };
      const onAbort = (): void => cancel('caller');
      timer = setTimeout(() => cancel('cap'), timeoutMs);
      timer.unref();
      signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (message: unknown) => {
        if (settled) return;
        // Other messages can share the port (e.g. `node --watch` posts {'watch:import': …}).
        if (isResultMessage(message)) {
          if (message.ok) settle(() => resolve(message.output), false);
          else settle(() => reject(deserializeImapError(message.error)), false);
          return;
        }
        if (isRecord(message) && isImapPhase(message.phase)) {
          phase = message.phase;
          runOptions.onPhase?.(message.phase);
          return;
        }
        const connectionError = connectionErrorOf(message);
        if (connectionError) runOptions.onConnectionError?.(connectionError);
      });
      worker.once('error', (err: unknown) => {
        if (!settled) log?.warn('imap worker failed', { ...facts(), ...failureCodes(err) });
        settle(() => reject(new ImapWorkerError('error', 'The IMAP worker failed')), true);
      });
      worker.once('exit', (exitCode: number) => {
        clearTimeout(graceTimer);
        if (!settled) log?.warn('imap worker stopped unexpectedly', { ...facts(), exitCode });
        settle(() => reject(new ImapWorkerError('exit', 'The IMAP worker stopped unexpectedly')), false);
      });
    });
}

export const runImapJobInWorker: ImapSessionRunner = createWorkerImapRunner();
