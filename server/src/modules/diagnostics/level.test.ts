import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogLevelStateSchema } from '@portly/shared';
import { migrate } from '../../db/migrate.ts';
import { openDb, type Db } from '../../db/open.ts';
import { createTestLogger } from '../../lib/logger.ts';
import {
  UNTIL_OFF_META_KEY,
  VERBOSE_META_KEY,
  applyLogLevel,
  clearExpiredVerbose,
  readPersistedVerbose,
  restoreLogLevel,
} from './level.ts';

// The logger ends a period by its own clock: times are relative to now.
const NOW = Date.now();

function meta(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM server_meta WHERE key = ?', [key])?.value ?? null;
}

describe('log level switch (PUT /api/diagnostics/level)', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('timed verbose is persisted; until-off leaves a marker; off deletes both', () => {
    const logs = createTestLogger('info');
    const timed = applyLogLevel({ db, logs }, { verbose: true, minutes: 30, areas: ['calendar', 'client'] }, NOW);
    expect(timed).toEqual({
      level: 'debug',
      verbose: true,
      until: new Date(NOW + 30 * 60_000).toISOString(),
      areas: ['calendar', 'client'],
      bootLevel: 'info',
      persisted: true,
    });
    expect(LogLevelStateSchema.parse(timed)).toEqual(timed);
    expect(readPersistedVerbose(db)).toEqual({ until: NOW + 30 * 60_000, areas: ['calendar', 'client'] });
    expect(meta(db, UNTIL_OFF_META_KEY)).toBeNull();

    const untilOff = applyLogLevel({ db, logs }, { verbose: true, minutes: null, areas: null }, NOW);
    expect(untilOff).toMatchObject({ verbose: true, until: null, areas: null, persisted: false });
    expect(meta(db, VERBOSE_META_KEY)).toBeNull();
    expect(meta(db, UNTIL_OFF_META_KEY)).not.toBeNull();

    const off = applyLogLevel({ db, logs }, { verbose: false, minutes: 60, areas: null }, NOW);
    expect(off).toEqual({ level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info', persisted: false });
    expect(meta(db, VERBOSE_META_KEY)).toBeNull();
    expect(meta(db, UNTIL_OFF_META_KEY)).toBeNull();
    // The logger reports each change itself.
    expect(logs.lines().filter((l) => l.msg === 'log level changed')).toHaveLength(3);
  });

  it('a restart keeps a timed period until it ends and logs that until-off verbose ended', () => {
    const before = createTestLogger('info');
    applyLogLevel({ db, logs: before }, { verbose: true, minutes: 60, areas: ['mail'] }, NOW);

    const after = createTestLogger('info');
    restoreLogLevel({ db, logs: after }, after.child({ module: 'diagnostics' }), NOW + 10 * 60_000);
    expect(after.levelState()).toMatchObject({ verbose: true, until: NOW + 60 * 60_000, areas: ['mail'] });

    // Until turned off: not restored, its end is logged once.
    applyLogLevel({ db, logs: after }, { verbose: true, minutes: null, areas: null }, NOW);
    const restarted = createTestLogger('info');
    restoreLogLevel({ db, logs: restarted }, restarted.child({ module: 'diagnostics' }), NOW);
    expect(restarted.levelState().verbose).toBe(false);
    expect(restarted.lines()).toEqual([
      expect.objectContaining({ level: 'info', msg: 'verbose logging ended', area: 'diagnostics', fields: expect.objectContaining({ reason: 'restart' }) }),
    ]);
    expect(meta(db, UNTIL_OFF_META_KEY)).toBeNull();
    const again = createTestLogger('info');
    restoreLogLevel({ db, logs: again }, again, NOW);
    expect(again.lines()).toEqual([]);
  });

  it('leaves a level already restored at start-up alone and deletes an ended period', () => {
    applyLogLevel({ db, logs: createTestLogger('info') }, { verbose: true, minutes: 60, areas: null }, NOW);
    const logs = createTestLogger('info');
    logs.setVerbose({ until: NOW + 5 * 60_000, areas: ['feeds'] });
    restoreLogLevel({ db, logs }, logs, NOW);
    expect(logs.levelState()).toMatchObject({ until: NOW + 5 * 60_000, areas: ['feeds'] });

    const later = createTestLogger('info');
    restoreLogLevel({ db, logs: later }, later, NOW + 61 * 60_000);
    expect(later.levelState().verbose).toBe(false);
    expect(meta(db, VERBOSE_META_KEY)).toBeNull();
  });

  it('reads a stored period tolerantly (ISO until, unknown areas) and ignores garbage', () => {
    db.run('INSERT INTO server_meta (key, value) VALUES (?, ?)', [VERBOSE_META_KEY, JSON.stringify({ until: '2026-10-11T13:00:00.000Z', areas: ['mail', 'nope', 7] })]);
    expect(readPersistedVerbose(db)).toEqual({ until: Date.parse('2026-10-11T13:00:00.000Z'), areas: ['mail'] });
    db.run('UPDATE server_meta SET value = ? WHERE key = ?', ['{not json', VERBOSE_META_KEY]);
    expect(readPersistedVerbose(db)).toBeNull();
    const logs = createTestLogger('info');
    restoreLogLevel({ db, logs }, logs, NOW);
    expect(logs.levelState().verbose).toBe(false);
    expect(meta(db, VERBOSE_META_KEY)).toBeNull();
  });

  it('the daily purge deletes an ended period only', () => {
    applyLogLevel({ db, logs: createTestLogger('info') }, { verbose: true, minutes: 60, areas: null }, NOW);
    clearExpiredVerbose(db, NOW + 59 * 60_000);
    expect(meta(db, VERBOSE_META_KEY)).not.toBeNull();
    clearExpiredVerbose(db, NOW + 60 * 60_000);
    expect(meta(db, VERBOSE_META_KEY)).toBeNull();
  });
});
