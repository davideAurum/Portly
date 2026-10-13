import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createMemoryLogger, createTestLogger } from '../lib/logger.ts';
import { createFakeAccountService } from './fake-accounts.ts';
import { createTestContext } from './test-context.ts';

describe('createTestContext: logs, health, runtime', () => {
  it('uses one test logger as log and logs, so the hub sees what modules log', () => {
    const ctx = createTestContext();
    expect(ctx.log).toBe(ctx.logs);
    ctx.log.child({ module: 'weather' }).info('forecast refreshed', { ms: 12 });
    expect(ctx.logs.query({ area: 'weather' }).records.map((r) => r.msg)).toEqual(['forecast refreshed']);
    ctx.close();
  });

  it('only `log` given: logs is a separate hub; only `logs` given: it is log too', () => {
    const memory = createMemoryLogger();
    const a = createTestContext({ log: memory });
    expect(a.log).toBe(memory);
    expect(a.logs).not.toBe(memory);
    expect(typeof a.logs.query).toBe('function');
    a.close();

    const hub = createTestLogger();
    const b = createTestContext({ logs: hub });
    expect(b.log).toBe(hub);
    expect(b.logs).toBe(hub);
    b.close();
  });

  it('has a real health tracker over the test database and a fresh runtime', async () => {
    const ctx = createTestContext();
    ctx.health.record({ key: 'weather', area: 'weather' }, { ok: false, code: 'timeout' });
    expect(ctx.health.get('weather')).toMatchObject({ status: 'failing', lastCode: 'timeout' });
    ctx.health.flush();
    expect(ctx.db.get<{ status: string }>("SELECT status FROM diag_health WHERE key = 'weather'")?.status).toBe('failing');
    expect(ctx.logs.query({ level: 'warn' }).records.map((r) => [r.msg, r.area])).toEqual([['weather failing', 'weather']]);

    expect(ctx.runtime).toMatchObject({ supervised: false, restart: null, modules: [] });
    expect(ctx.runtime.boot).toMatch(/^[a-z0-9]{6}$/);
    expect(ctx.runtime.inflight.count()).toBe(0);
    expect(createTestContext().runtime.inflight).not.toBe(ctx.runtime.inflight);
    // close() closes the tracker before the database: nothing fails afterwards, not even the
    // flush the record queued for the next microtask.
    ctx.health.record({ key: 'weather', area: 'weather' }, { ok: true });
    ctx.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.logs.query({ q: 'health persistence failed' }).records).toEqual([]);
  });

  it('createApp fills runtime.modules (replaced, not appended, per app)', () => {
    const ctx = createTestContext();
    const modules = [
      { name: 'good', prefixes: ['/api/good'], register: () => {} },
      {
        name: 'broken',
        prefixes: ['/api/broken'],
        register: () => {
          throw new Error('boom');
        },
      },
    ];
    createApp(ctx, { modules, webDist: null });
    expect(ctx.runtime.modules).toEqual([
      { name: 'good', ok: true },
      { name: 'broken', ok: false },
    ]);
    createApp(ctx, { modules: modules.slice(0, 1), webDist: null });
    expect(ctx.runtime.modules).toEqual([{ name: 'good', ok: true }]);
    ctx.close();
  });
});

describe('createFakeAccountService: status meta', () => {
  it('records meta in statusChanges only when given', () => {
    const svc = createFakeAccountService([{ id: 'c', kind: 'caldav', password: 'pw' }]);
    svc.setStatus('c', 'reauth', 'The CalDAV server rejected the password', { reason: 'caldav_password_rejected', source: 'calendar' });
    svc.setStatus('c', 'ok');
    expect(svc.statusChanges).toEqual([
      { id: 'c', status: 'reauth', message: 'The CalDAV server rejected the password', meta: { reason: 'caldav_password_rejected', source: 'calendar' } },
      { id: 'c', status: 'ok' },
    ]);
    expect(svc.get('c')?.status).toBe('ok');
  });
});
