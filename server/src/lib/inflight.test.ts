import { describe, expect, it } from 'vitest';
import { MAX_SNAPSHOT_ROUTES, createInFlightRequests } from './inflight.ts';

describe('in-flight requests', () => {
  it('counts open requests and reports the oldest first', () => {
    let clock = 1000;
    const inflight = createInFlightRequests({ now: () => clock });
    expect(inflight.snapshot()).toEqual({ count: 0, oldestMs: null, routes: [] });
    const doneA = inflight.start('aaaaaaaaaa', 'GET', '/api/calendar/events');
    clock = 1500;
    const doneB = inflight.start('bbbbbbbbbb', 'POST', '/api/mail/actions');
    clock = 4000;
    expect(inflight.count()).toBe(2);
    expect(inflight.snapshot()).toEqual({ count: 2, oldestMs: 3000, routes: ['GET /api/calendar/events', 'POST /api/mail/actions'] });
    doneA();
    expect(inflight.snapshot(5000)).toEqual({ count: 1, oldestMs: 3500, routes: ['POST /api/mail/actions'] });
    doneB();
    expect(inflight.count()).toBe(0);
  });

  it('done() is idempotent and a repeated rid never removes another request', () => {
    const inflight = createInFlightRequests();
    const first = inflight.start('same000000', 'GET', '/api/a');
    const second = inflight.start('same000000', 'GET', '/api/b');
    first();
    first();
    expect(inflight.count()).toBe(1);
    expect(inflight.snapshot().routes).toEqual(['GET /api/b']);
    second();
    expect(inflight.count()).toBe(0);
  });

  it(`lists at most ${MAX_SNAPSHOT_ROUTES} routes`, () => {
    const inflight = createInFlightRequests({ now: () => 0 });
    for (let i = 0; i < 15; i++) inflight.start(`r${i}`, 'GET', `/api/x/${i}`);
    const snap = inflight.snapshot();
    expect(snap.count).toBe(15);
    expect(snap.routes).toHaveLength(MAX_SNAPSHOT_ROUTES);
    expect(snap.routes[0]).toBe('GET /api/x/0');
  });

  it('snapshot leaves out the excluded request (the summary asking about itself)', () => {
    let t = 1000;
    const inflight = createInFlightRequests({ now: () => t });
    inflight.start('slow000000', 'GET', '/api/mail/summary');
    t = 1500;
    inflight.start('self000000', 'GET', '/api/diagnostics/summary');
    expect(inflight.snapshot(2000, 'self000000')).toEqual({ count: 1, oldestMs: 1000, routes: ['GET /api/mail/summary'] });
    expect(inflight.snapshot(2000).count).toBe(2);
    expect(inflight.count()).toBe(2);
  });
});
