/**
 * Process exit codes and start-up failure reports shared by the server entry point and the
 * autostart supervisor (§3, §17). Kept free of start-up side effects so the
 * supervisor never imports `index.ts` (which starts the server on import).
 *
 * - {@link StartupFailure}: what a supervised server reports over IPC (`{type: 'startup-failed'}`)
 *   right before it exits because start-up failed; the supervisor logs it as `lastFailure` and
 *   hands it to the next attempt in `PORTLY_SUPERVISOR_LAST_EXIT`.
 * - {@link writeBootstrapFailure}: a failure before any logger exists (invalid configuration) is
 *   appended to the log file as one JSON line in the logger's format, best effort.
 * - {@link fatalText}: the stderr text of a fatal error (frame-only stack, scrubbed): a supervised
 *   server writes to stderr only for such output, so the supervisor's stderr tail is the crash cause.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubFields } from '@portly/shared';
import { errorFields, scrubText } from './logger.ts';

/** Clean shutdown. */
export const EXIT_OK = 0;
/** Startup failure (bad config, listener error, uncaught exception). */
export const EXIT_STARTUP_FAILURE = 1;
/** A port is already in use — another Portly is running; the supervisor stops restarting. */
export const EXIT_ALREADY_RUNNING = 3;
/**
 * Start-up cannot succeed until the user acts (`web/dist` is missing): the supervisor stops after
 * three of these in a row.
 */
export const EXIT_PERMANENT_FAILURE = 4;

/** `type` of the IPC message a supervised server sends when start-up failed. */
export const STARTUP_FAILED_TYPE = 'startup-failed';
const MAX_FAILURE_MESSAGE = 200;
const PHASE = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Why start-up failed: codes and our scrubbed message only (no stack, no paths beyond masked ones). */
export interface StartupFailure {
  /** Start-up phase (`config`, `db`, `migrate`, `listen` …). */
  phase: string;
  errName?: string;
  errCode?: string | number;
  /** node:sqlite `errcode`. */
  sqliteCode?: number;
  /** Scrubbed, ≤ 200 characters. */
  message?: string;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** The IPC message reporting `err` as the reason start-up failed in `phase`. */
export function startupFailedMessage(phase: string, err: unknown): { type: typeof STARTUP_FAILED_TYPE } & StartupFailure {
  const f = errorFields(err);
  const out: { type: typeof STARTUP_FAILED_TYPE } & StartupFailure = { type: STARTUP_FAILED_TYPE, phase };
  if (typeof f.errName === 'string') out.errName = f.errName;
  if (typeof f.errCode === 'string' || typeof f.errCode === 'number') out.errCode = f.errCode;
  if (typeof f.sqliteCode === 'number') out.sqliteCode = f.sqliteCode;
  if (typeof f.errMessage === 'string' && f.errMessage !== '') out.message = cap(f.errMessage, MAX_FAILURE_MESSAGE);
  return out;
}

/**
 * A `startup-failed` IPC message, validated and re-scrubbed (it crosses a process boundary);
 * null for any other message.
 */
export function parseStartupFailure(message: unknown): StartupFailure | null {
  if (message === null || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  if (m.type !== STARTUP_FAILED_TYPE || typeof m.phase !== 'string' || !PHASE.test(m.phase)) return null;
  const out: StartupFailure = { phase: m.phase };
  if (typeof m.errName === 'string' && NAME.test(m.errName)) out.errName = m.errName;
  if ((typeof m.errCode === 'string' && NAME.test(m.errCode)) || (typeof m.errCode === 'number' && Number.isFinite(m.errCode))) {
    out.errCode = m.errCode;
  }
  if (typeof m.sqliteCode === 'number' && Number.isFinite(m.sqliteCode)) out.sqliteCode = m.sqliteCode;
  if (typeof m.message === 'string' && m.message !== '') {
    out.message = cap(scrubText(m.message.slice(0, MAX_FAILURE_MESSAGE * 4)).replace(/[\r\n]+/g, ' '), MAX_FAILURE_MESSAGE);
  }
  return out;
}

/**
 * One JSON line in the logger's file format (`{t, lvl, msg, src?, area, tags, ...fields}`) for a
 * start-up failure that happened before the logger existed.
 */
export function bootstrapFailureLine(phase: string, err: unknown, opts: { src?: 'supervisor'; now?: number } = {}): string {
  const f = errorFields(err);
  const record: Record<string, unknown> = {
    t: new Date(opts.now ?? Date.now()).toISOString(),
    lvl: 'error',
    msg: 'startup failed',
  };
  if (opts.src) record.src = opts.src;
  record.area = 'server';
  record.tags = ['server'];
  record.phase = phase;
  for (const key of ['errName', 'errMessage', 'errCode'] as const) if (f[key] !== undefined) record[key] = f[key];
  return JSON.stringify(scrubFields(record));
}

/** Appends {@link bootstrapFailureLine} to `file` (creating its folder); never throws. */
export function writeBootstrapFailure(file: string, phase: string, err: unknown, opts: { src?: 'supervisor' } = {}): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${bootstrapFailureLine(phase, err, opts)}\n`);
  } catch {
    // Best effort: stderr carries the failure too.
  }
}

/**
 * stderr text of a fatal error: `<what>: Name[code]: message (cause …)` and the frame lines of its
 * stack — never the stack's header line, which repeats the (unscrubbed) message.
 */
export function fatalText(what: string, err: unknown): string {
  const f = errorFields(err, { stack: true });
  const code = f.errCode === undefined ? '' : `[${String(f.errCode)}]`;
  const cause = typeof f.cause === 'string' ? ` (cause: ${f.cause})` : '';
  const head = `${what}: ${String(f.errName ?? 'Error')}${code}: ${String(f.errMessage ?? '')}${cause}`.replace(/[\r\n]+/g, ' ');
  const frames = typeof f.stack === 'string' ? f.stack.split('\n').map((line) => `    ${line}\n`).join('') : '';
  return `${head}\n${frames}`;
}
