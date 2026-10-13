/**
 * The verbose switch (`PUT /api/diagnostics/level`; ARCHITECTURE §3, §17): Normal logs at
 * the boot level, Verbose at debug for every area or the chosen ones, for a while or until
 * turned off.
 *
 * Persistence (`server_meta`):
 * - timed verbose → `diagnostics.verbose` = `{"until": <epoch ms>, "areas": [...] | null}`; a restart
 *   before `until` keeps it on ({@link restoreLogLevel}; index.ts may restore it earlier with
 *   {@link readPersistedVerbose}, then this does nothing);
 * - "until turned off" (`minutes: null`) is not persisted: it ends at the next restart. The marker
 *   `diagnostics.verbose.untilOff` lets that start log `verbose logging ended {reason: 'restart'}`;
 * - turning verbose off deletes both.
 * The logger itself logs `log level changed` and, when a timed period runs out, `verbose logging
 * ended {reason: 'expired'}`.
 */
import { DIAGNOSTIC_AREAS, type LogLevelState, type SetLogLevel } from '@homebase/shared';
import type { AppContext } from '../../context.ts';
import type { Db } from '../../db/open.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { toLogLevelState } from './summary.ts';

export const VERBOSE_META_KEY = 'diagnostics.verbose';
export const UNTIL_OFF_META_KEY = 'diagnostics.verbose.untilOff';

const AREA_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_AREAS);

/** A timed verbose period as stored in `server_meta`. */
export interface PersistedVerbose {
  /** Epoch ms. */
  until: number;
  /** null = every area. */
  areas: string[] | null;
}

function readMeta(db: Db, key: string): string | null {
  const row = db.get<{ value: unknown }>('SELECT value FROM server_meta WHERE key = ?', [key]);
  return typeof row?.value === 'string' ? row.value : null;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.run('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}

function deleteMeta(db: Db, key: string): void {
  db.run('DELETE FROM server_meta WHERE key = ?', [key]);
}

/** Known areas of a stored list; null for "every area" (and for anything that is not a list). */
function storedAreas(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const areas = value.filter((a): a is string => typeof a === 'string' && AREA_SET.has(a));
  return areas.length > 0 ? [...new Set(areas)] : null;
}

/**
 * The persisted timed verbose period, whether or not it has ended (null when there is none or it
 * is unreadable). `until` may also be stored as ISO text.
 */
export function readPersistedVerbose(db: Db): PersistedVerbose | null {
  const text = readMeta(db, VERBOSE_META_KEY);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const until = typeof record.until === 'number' ? record.until : typeof record.until === 'string' ? Date.parse(record.until) : Number.NaN;
    if (!Number.isFinite(until)) return null;
    return { until, areas: storedAreas(record.areas) };
  } catch {
    return null;
  }
}

/** Applies `PUT /api/diagnostics/level` and returns the new state. */
export function applyLogLevel(ctx: Pick<AppContext, 'db' | 'logs'>, body: SetLogLevel, now: number): LogLevelState {
  const { db, logs } = ctx;
  if (!body.verbose) {
    db.tx(() => {
      deleteMeta(db, VERBOSE_META_KEY);
      deleteMeta(db, UNTIL_OFF_META_KEY);
    });
    logs.setVerbose(null);
  } else if (body.minutes === null) {
    db.tx(() => {
      deleteMeta(db, VERBOSE_META_KEY);
      writeMeta(db, UNTIL_OFF_META_KEY, JSON.stringify({ since: now, areas: body.areas }));
    });
    logs.setVerbose({ until: null, areas: body.areas });
  } else {
    const until = now + body.minutes * 60_000;
    db.tx(() => {
      writeMeta(db, VERBOSE_META_KEY, JSON.stringify({ until, areas: body.areas } satisfies PersistedVerbose));
      deleteMeta(db, UNTIL_OFF_META_KEY);
    });
    logs.setVerbose({ until, areas: body.areas });
  }
  return toLogLevelState(logs.levelState());
}

/**
 * At start-up (module registration): logs the end of an "until turned off" period that the
 * restart ended, turns a persisted timed period back on unless something already did (index.ts)
 * and deletes an expired one. Never throws.
 */
export function restoreLogLevel(ctx: Pick<AppContext, 'db' | 'logs'>, log: Logger, now: number): void {
  const { db, logs } = ctx;
  try {
    if (readMeta(db, UNTIL_OFF_META_KEY) !== null) {
      deleteMeta(db, UNTIL_OFF_META_KEY);
      log.info('verbose logging ended', { reason: 'restart' });
    }
    const persisted = readPersistedVerbose(db);
    if (persisted === null) {
      if (readMeta(db, VERBOSE_META_KEY) !== null) deleteMeta(db, VERBOSE_META_KEY);
    } else if (persisted.until <= now) {
      deleteMeta(db, VERBOSE_META_KEY);
    } else if (!logs.levelState().verbose) {
      logs.setVerbose({ until: persisted.until, areas: persisted.areas });
    }
  } catch (err) {
    log.warn('could not restore the log level', errorFields(err));
  }
}

/** Deletes a persisted timed period that has ended (daily purge). Never throws. */
export function clearExpiredVerbose(db: Db, now: number): void {
  try {
    const persisted = readPersistedVerbose(db);
    if (persisted !== null && persisted.until <= now) deleteMeta(db, VERBOSE_META_KEY);
  } catch {
    // The next start-up deletes it.
  }
}
