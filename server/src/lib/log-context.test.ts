import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_REGEX } from '@portly/shared';
import { getLogContext, newRequestId, newRunId, outsideLogContext, withLogContext } from './log-context.ts';
import { createTestLogger } from './logger.ts';

/** Resolves with the context a real timer callback sees. */
function contextInTimer(ms = 5): Promise<ReturnType<typeof getLogContext>> {
  return new Promise((resolve) => setTimeout(() => resolve(getLogContext()), ms));
}

describe('log context', () => {
  it('is undefined outside any unit of work', () => {
    expect(getLogContext()).toBeUndefined();
  });

  it('extends the current context; undefined clears an inherited key', () => {
    withLogContext({ rid: 'r1', area: 'mail' }, () => {
      withLogContext({ accountId: 'a1', area: 'accounts' }, () => {
        expect(getLogContext()).toEqual({ rid: 'r1', area: 'accounts', accountId: 'a1' });
        withLogContext({ rid: undefined }, () => expect(getLogContext()?.rid).toBeUndefined());
      });
      expect(getLogContext()).toEqual({ rid: 'r1', area: 'mail' });
    });
    expect(getLogContext()).toBeUndefined();
  });

  it('returns what fn returns and the context is read-only', () => {
    expect(withLogContext({ job: 'j' }, () => 42)).toBe(42);
    withLogContext({ job: 'j' }, () => {
      expect(Object.isFrozen(getLogContext())).toBe(true);
    });
  });

  it('follows awaits and promise continuations', async () => {
    const seen = await withLogContext({ rid: 'r2' }, async () => {
      await sleep(1);
      const inner = await Promise.resolve().then(() => getLogContext()?.rid);
      return [getLogContext()?.rid, inner];
    });
    expect(seen).toEqual(['r2', 'r2']);
  });

  it('real timers capture the context where they are created', async () => {
    const inside = withLogContext({ rid: 'r3', job: 'calendar:sync' }, () => contextInTimer());
    const outside = withLogContext({ rid: 'r3' }, () => outsideLogContext(() => contextInTimer()));
    expect(await inside).toEqual({ rid: 'r3', job: 'calendar:sync' });
    expect(await outside).toBeUndefined();
  });

  it('an interval re-armed from a timer created outside the context never carries a request id', async () => {
    const seen: (string | undefined)[] = [];
    await withLogContext({ rid: 'req0000001' }, async () => {
      const timer = outsideLogContext(() =>
        setInterval(() => {
          seen.push(getLogContext()?.rid);
        }, 2),
      );
      await sleep(15);
      clearInterval(timer);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((rid) => rid === undefined)).toBe(true);
  });

  it('EventEmitter listeners run in the emit() context', () => {
    const emitter = new EventEmitter();
    let seen: string | undefined;
    withLogContext({ rid: 'registered' }, () => emitter.on('x', () => (seen = getLogContext()?.rid)));
    withLogContext({ rid: 'emitted' }, () => emitter.emit('x'));
    expect(seen).toBe('emitted');
  });

  it('the logger reads it: rid, area and context fields on every record', async () => {
    const log = createTestLogger();
    await withLogContext({ rid: 'abcdefghij', area: 'feeds', feed: '0123456789', op: 'fetch' }, async () => {
      await sleep(1);
      log.child({ component: 'fetch' }).debug('outbound', { host: 'example.org' });
    });
    expect(log.lines()[0]).toMatchObject({
      rid: 'abcdefghij',
      area: 'feeds',
      tags: ['feeds', 'fetch'],
      fields: { feed: '0123456789', op: 'fetch', component: 'fetch', host: 'example.org' },
    });
  });
});

describe('ids', () => {
  it('request ids are 10 random [a-z0-9] characters', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(REQUEST_ID_REGEX.test(id)).toBe(true);
  });

  it('run ids are 6 random [a-z0-9] characters', () => {
    const ids = Array.from({ length: 200 }, () => newRunId());
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{6}$/);
    expect(new Set(ids).size).toBeGreaterThan(190);
  });

  it('uses the whole alphabet', () => {
    const chars = new Set(Array.from({ length: 300 }, () => newRequestId()).join(''));
    expect(chars.size).toBe(36);
  });
});
