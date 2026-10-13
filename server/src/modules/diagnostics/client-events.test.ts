import { describe, expect, it } from 'vitest';
import { ClientEventsResponseSchema, LogRecordSchema, type ClientEventInput, type ClientEventsRequest } from '@homebase/shared';
import { withLogContext } from '../../lib/log-context.ts';
import { createTestLogger } from '../../lib/logger.ts';
import {
  CLIENT_EVENT_BYTES_PER_MINUTE,
  CLIENT_EVENTS_PER_MINUTE,
  createClientEventIntake,
} from './client-events.ts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const RID = 'abcdefghij';

function event(patch: Partial<ClientEventInput> = {}): ClientEventInput {
  return {
    t: new Date(NOW - 1000).toISOString(),
    level: 'warn',
    cat: 'api',
    msg: 'request failed',
    fields: { method: 'GET', route: '/api/mail/summary', status: 0, code: 'network_error' },
    session: 's1',
    page: { build: 'server', backend: 'server', version: '1.2.3' },
    ...patch,
  };
}

function batch(events: ClientEventInput[], sentAt = NOW): ClientEventsRequest {
  return { sentAt: new Date(sentAt).toISOString(), events: events.map((e) => ({ ...e, fields: e.fields ?? {} })) };
}

function setup() {
  const logs = createTestLogger('info');
  const intake = createClientEventIntake({ logs, log: logs.child({ module: 'diagnostics' }), clientLog: logs.child({ src: 'client' }) });
  const clientRecords = () => logs.query({ src: 'client', limit: 5000 }).records.filter((r) => r.msg.startsWith('client: '));
  return { logs, intake, clientRecords };
}

describe('client events intake', () => {
  it('logs each event as a client record: cf nested, rid lifted only when it is a request id, uploadRid', () => {
    const { intake, clientRecords } = setup();
    const res = withLogContext({ rid: 'uploadreq1', area: 'diagnostics', quiet: true }, () =>
      intake.ingest(
        batch([
          event({ fields: { method: 'GET', route: '/api/x', status: 502, rid: RID } }),
          event({ level: 'error', cat: 'app', msg: 'unhandled error', fields: { errName: 'TypeError', rid: 'not a request id' } }),
        ]),
        { caller: 'local', uploadRid: 'uploadreq1', now: NOW },
      ),
    );
    expect(res).toEqual({ accepted: 2, dropped: 0, acceptDebug: false });
    expect(ClientEventsResponseSchema.parse(res)).toEqual(res);

    const [api, app] = clientRecords();
    expect(api).toMatchObject({
      level: 'warn',
      msg: 'client: request failed',
      src: 'client',
      area: 'client',
      tags: ['client'],
      rid: RID,
      tEvent: new Date(NOW - 1000).toISOString(),
      fields: {
        client: { cat: 'api', session: 's1', page: { build: 'server', backend: 'server', version: '1.2.3' }, late: false },
        cf: { method: 'GET', route: '/api/x', status: 502 },
        uploadRid: 'uploadreq1',
      },
    });
    // Browser fields never spread among the server's keys.
    expect(api?.fields).not.toHaveProperty('method');
    expect(app).toMatchObject({ level: 'error', rid: null, fields: { cf: { errName: 'TypeError' } } });
    for (const rec of [api, app]) expect(LogRecordSchema.parse(rec)).toEqual(rec);
  });

  it('strips query strings from path and route, in the record and its repeat key', () => {
    const { logs, intake, clientRecords } = setup();
    const fields = { method: 'GET', route: '/api/search/suggest?q=secret', path: '/api/search/suggest?q=secret&lat=51.5#frag', status: 0 };
    // Two warnings open a repeat window; the error closes it, so its `repeated` line names the key.
    intake.ingest(batch([event({ fields }), event({ fields }), event({ level: 'error', fields })]), { caller: 'local', uploadRid: null, now: NOW });
    const [first] = clientRecords();
    expect(first?.fields.cf).toEqual({ method: 'GET', route: '/api/search/suggest', path: '/api/search/suggest', status: 0 });
    const repeated = logs.query({ src: 'client', q: 'repeated', limit: 50 }).records.filter((r) => r.msg === 'repeated');
    expect(repeated.map((r) => r.fields.repeatKey)).toEqual(['api request failed /api/search/suggest 0']);
    // The schema allows arrays of primitives under any key.
    intake.ingest(batch([event({ msg: 'odd', fields: { path: ['/api/weather?lat=51.5', 3] } })]), { caller: 'local', uploadRid: null, now: NOW });
    expect(clientRecords().find((r) => r.msg === 'client: odd')?.fields.cf).toEqual({ path: ['/api/weather', 3] });
    const all = JSON.stringify([...logs.query({ limit: 5000 }).records, ...logs.lines()]);
    expect(all).not.toContain('secret');
    expect(all).not.toContain('51.5');
  });

  it('writes control, line-separator and bidi characters of field values and the page version as \\uXXXX', () => {
    const { logs, intake, clientRecords } = setup();
    const forged = 'x\u2028{"lvl":"error","msg":"forged line"}\u202eevil\u009B2J\r';
    const res = intake.ingest(
      batch([
        event({
          msg: 'odd',
          fields: { errMessage: forged, list: ['a\u2066b\u0085', 1], tab: 'a\tb' },
          page: { build: 'server', backend: 'server', version: '1\u2029' },
        }),
      ]),
      { caller: 'local', uploadRid: null, now: NOW },
    );
    expect(res.accepted).toBe(1);
    const [rec] = clientRecords();
    expect(rec?.fields.cf).toEqual({
      errMessage: 'x\\u2028{"lvl":"error","msg":"forged line"}\\u202eevil\\u009b2J\\u000d',
      list: ['a\\u2066b\\u0085', 1],
      tab: 'a\tb',
    });
    expect(rec?.fields.client).toMatchObject({ page: { version: '1\\u2029' } });
    const all = JSON.stringify([...logs.query({ limit: 5000 }).records, ...logs.lines()]);
    expect(all).not.toMatch(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  });

  it('corrects the event time by the clock skew and marks late events', () => {
    const { intake, clientRecords } = setup();
    // The browser clock is 10 minutes behind: it sent the batch at what it thinks is NOW - 10 min.
    const sentAt = NOW - 10 * 60_000;
    intake.ingest(
      batch([event({ t: new Date(sentAt - 2000).toISOString(), msg: 'recent' }), event({ t: new Date(sentAt - 6 * 60_000).toISOString(), msg: 'old' })], sentAt),
      { caller: 'local', uploadRid: null, now: NOW },
    );
    const [recent, old] = clientRecords();
    expect(recent).toMatchObject({ tEvent: new Date(NOW - 2000).toISOString(), fields: { client: { late: false } } });
    expect(recent?.fields).not.toHaveProperty('uploadRid');
    expect(old).toMatchObject({ tEvent: new Date(NOW - 6 * 60_000).toISOString(), fields: { client: { late: true } } });
  });

  it('clamps an event time no ISO date can show (absurd skew)', () => {
    const { intake, clientRecords } = setup();
    intake.ingest(batch([event({ t: '9999-12-31T00:00:00.000Z' })], Date.parse('0001-01-01T00:00:00.000Z')), { caller: 'local', uploadRid: null, now: NOW });
    const [rec] = clientRecords();
    expect(rec?.tEvent).toBe('9999-12-31T23:59:59.999Z');
    expect(LogRecordSchema.parse(rec)).toEqual(rec);
  });

  it('drops debug events unless verbose covers client, and says so in acceptDebug', () => {
    const { logs, intake, clientRecords } = setup();
    const debug = event({ level: 'debug', msg: 'probe ok', cat: 'hybrid' });
    expect(intake.ingest(batch([debug, event()]), { caller: 'local', uploadRid: null, now: NOW })).toEqual({ accepted: 1, dropped: 1, acceptDebug: false });
    logs.setVerbose({ until: null, areas: ['calendar'] });
    expect(intake.ingest(batch([debug]), { caller: 'local', uploadRid: null, now: NOW }).acceptDebug).toBe(false);
    logs.setVerbose({ until: null, areas: ['client'] });
    // The upload request itself is quiet (its debug lines skip the rings); accepted events are not.
    const quiet = withLogContext({ rid: 'uploadreq1', quiet: true }, () => intake.ingest(batch([debug]), { caller: 'local', uploadRid: null, now: NOW }));
    expect(quiet).toEqual({ accepted: 1, dropped: 0, acceptDebug: true });
    logs.setVerbose({ until: null, areas: null });
    expect(intake.ingest(batch([debug]), { caller: 'local', uploadRid: null, now: NOW }).acceptDebug).toBe(true);
    expect(clientRecords().filter((r) => r.level === 'debug')).toHaveLength(2);
  });

  it(`limits each caller to ${CLIENT_EVENTS_PER_MINUTE} events a minute, warning once per minute`, () => {
    const { logs, intake } = setup();
    const many = (n: number) => batch(Array.from({ length: n }, (_, i) => event({ msg: `event ${i}` })));
    expect(intake.ingest(many(100), { caller: 'p1', uploadRid: null, now: NOW })).toMatchObject({ accepted: 100, dropped: 0 });
    expect(intake.ingest(many(50), { caller: 'p1', uploadRid: null, now: NOW + 1000 })).toMatchObject({ accepted: 20, dropped: 30 });
    expect(intake.ingest(many(10), { caller: 'p1', uploadRid: null, now: NOW + 2000 })).toMatchObject({ accepted: 0, dropped: 10 });
    // Another caller has its own budget.
    expect(intake.ingest(many(10), { caller: 'local', uploadRid: null, now: NOW + 2000 })).toMatchObject({ accepted: 10, dropped: 0 });
    // A new minute, a new budget.
    expect(intake.ingest(many(10), { caller: 'p1', uploadRid: null, now: NOW + 60_000 })).toMatchObject({ accepted: 10, dropped: 0 });

    const warnings = logs.lines().filter((l) => l.msg === 'client events dropped');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', area: 'diagnostics', fields: { caller: 'p1', dropped: 30 } });
  });

  it('limits each caller to 64 KB of event fields a minute', () => {
    const { intake } = setup();
    const big = (i: number) => event({ msg: `big ${i}`, fields: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`f${k}`, 'x'.repeat(300)])) });
    const size = Buffer.byteLength(JSON.stringify(big(0).fields));
    const fits = Math.floor(CLIENT_EVENT_BYTES_PER_MINUTE / size);
    const res = intake.ingest(batch(Array.from({ length: fits + 3 }, (_, i) => big(i))), { caller: 'local', uploadRid: null, now: NOW });
    expect(res).toMatchObject({ accepted: fits, dropped: 3 });
  });
});
