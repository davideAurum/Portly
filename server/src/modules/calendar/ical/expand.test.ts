import { describe, expect, it } from 'vitest';
import { withLogContext } from '../../../lib/log-context.ts';
import { createTestLogger } from '../../../lib/logger.ts';
import { HOURLY_FEED, MIXED_FEED, RECURRING_FEED, SECONDLY_FEED, SIMPLE_FEED, WINDOW, ics, manyVevents } from '../__fixtures__/ics.ts';
import { expandCalendar, type ExpandJob, type ExpandedEvent } from './expand.ts';
import { createExpandRunner, expandFailureCode, runExpandJob } from './run.ts';

function job(data: string | string[], extra: Partial<ExpandJob> = {}): ExpandJob {
  const sources = (Array.isArray(data) ? data : [data]).map((d) => ({ data: d }));
  return { sources, window: WINDOW, localTz: 'Europe/Berlin', ...extra };
}

function ok(result: ReturnType<typeof expandCalendar>): ExpandedEvent[] {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.events;
}

describe('expandCalendar — recurrence', () => {
  it('expands a weekly series with EXDATE, a moved and a cancelled RECURRENCE-ID, using the VTIMEZONE', () => {
    const result = expandCalendar(job(RECURRING_FEED));
    const events = ok(result);
    expect(result.ok && result.name).toBe('Team');
    expect(result.ok && result.color).toBe('#FF2968');
    // COUNT=4: Oct 26, (Nov 2 EXDATE), Nov 9 moved, (Nov 16 cancelled)
    expect(events.map((e) => [e.title, e.start, e.end, e.instanceKey])).toEqual([
      // 09:00 EDT (UTC-4) — before the US DST change on Nov 1
      ['Planning', '2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z', '2026-10-26T13:00:00.000Z'],
      // moved to 14:00 EST (UTC-5); the instance key stays the original start
      ['Planning (moved)', '2026-11-09T19:00:00.000Z', '2026-11-09T20:00:00.000Z', '2026-11-09T14:00:00.000Z'],
    ]);
    const first = events[0]!;
    expect(first).toMatchObject({
      remoteId: 'weekly-1@example.com',
      recurring: true,
      seriesId: 'weekly-1@example.com',
      editable: false,
      allDay: false,
      timezone: 'America/New_York',
      location: 'Room 1',
      description: 'Agenda at https://example.com/agenda\nSecond line',
      htmlUrl: 'https://example.com/planning',
      meetingUrl: 'https://meet.google.com/xyz-abcd-efg',
      status: 'confirmed',
    });
  });

  it('includes an override moved into the window from an occurrence outside it', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:s1',
      'DTSTART:20270920T100000Z',
      'DTEND:20270920T110000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Late series',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:s1',
      'RECURRENCE-ID:20271004T100000Z',
      'DTSTART:20270921T100000Z',
      'DTEND:20270921T110000Z',
      'SUMMARY:Pulled forward',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const events = ok(expandCalendar(job(feed)));
    expect(events.map((e) => [e.title, e.start, e.instanceKey])).toEqual([
      ['Late series', '2027-09-20T10:00:00.000Z', '2027-09-20T10:00:00.000Z'],
      ['Pulled forward', '2027-09-21T10:00:00.000Z', '2027-10-04T10:00:00.000Z'],
    ]);
  });

  it('handles overrides of occurrences long before the window (moved in, or left outside)', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:weekly-old',
      'DTSTART:20200106T100000Z',
      'DTEND:20200106T110000Z',
      'RRULE:FREQ=WEEKLY;UNTIL=20260910T000000Z',
      'SUMMARY:Old weekly',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:weekly-old',
      'RECURRENCE-ID:20200113T100000Z',
      'DTSTART:20261015T100000Z',
      'DTEND:20261015T110000Z',
      'SUMMARY:Moved into the window',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:weekly-old',
      'RECURRENCE-ID:20200120T100000Z',
      'DTSTART:20200121T100000Z',
      'DTEND:20200121T110000Z',
      'SUMMARY:Still in 2020',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const events = ok(expandCalendar(job(feed)));
    expect(events.map((e) => [e.title, e.start, e.instanceKey])).toEqual([
      // The regular occurrences inside the window: Aug 31 and Sep 7 (UNTIL Sep 10).
      ['Old weekly', '2026-08-31T10:00:00.000Z', '2026-08-31T10:00:00.000Z'],
      ['Old weekly', '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z'],
      ['Moved into the window', '2026-10-15T10:00:00.000Z', '2020-01-13T10:00:00.000Z'],
    ]);
  });

  it('treats overrides without their master as standalone instances', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:orphan',
      'RECURRENCE-ID:20261005T100000Z',
      'DTSTART:20261005T120000Z',
      'DTEND:20261005T130000Z',
      'SUMMARY:Orphan override',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const [event] = ok(expandCalendar(job(feed)));
    expect(event).toMatchObject({ remoteId: 'orphan', instanceKey: '2026-10-05T10:00:00.000Z', start: '2026-10-05T12:00:00.000Z', recurring: true });
  });

  it('counts DTSTART as the first instance of an RDATE-only set (unless an EXDATE removes it)', () => {
    const feed = (extra: string[]) =>
      ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN', 'BEGIN:VEVENT', 'UID:rdate-1', 'DTSTART:20261001T090000Z', 'DTEND:20261001T100000Z', 'RDATE:20261015T090000Z', ...extra, 'SUMMARY:Checkup', 'END:VEVENT', 'END:VCALENDAR']);
    const events = ok(expandCalendar(job(feed([]))));
    expect(events.map((e) => e.start).sort()).toEqual(['2026-10-01T09:00:00.000Z', '2026-10-15T09:00:00.000Z']);
    expect(events.every((e) => e.recurring && e.seriesId === 'rdate-1')).toBe(true);
    expect(new Set(events.map((e) => e.instanceKey)).size).toBe(2);
    const excluded = ok(expandCalendar(job(feed(['EXDATE:20261001T090000Z']))));
    expect(excluded.map((e) => e.start)).toEqual(['2026-10-15T09:00:00.000Z']);
  });

  it('expands all-day recurrences with date instance keys', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:bday',
      'DTSTART;VALUE=DATE:20000928',
      'DTEND;VALUE=DATE:20000929',
      'RRULE:FREQ=YEARLY',
      'SUMMARY:Birthday',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const events = ok(expandCalendar(job(feed)));
    expect(events.map((e) => [e.start, e.end, e.instanceKey, e.allDay])).toEqual([
      ['2026-09-28', '2026-09-29', '2026-09-28', true],
      ['2027-09-28', '2027-09-29', '2027-09-28', true],
    ].filter(([start]) => (start as string) < WINDOW.toDate));
  });
});

describe('expandCalendar — time zones', () => {
  it('maps Windows TZIDs via CLDR, reads floating/unknown zones in the local zone, keeps all-day dates', () => {
    const events = ok(expandCalendar(job(MIXED_FEED, { localTz: 'America/Chicago' })));
    const byUid = new Map(events.map((e) => [e.remoteId, e]));
    // W. Europe Standard Time → Europe/Berlin (CET, UTC+1 in December)
    expect(byUid.get('win-1')).toMatchObject({ start: '2026-12-01T08:00:00.000Z', end: '2026-12-01T09:30:00.000Z', timezone: 'Europe/Berlin' });
    // floating → server zone (America/Chicago, CST = UTC-6)
    expect(byUid.get('floating-1')).toMatchObject({ start: '2026-12-02T14:00:00.000Z', end: '2026-12-02T15:00:00.000Z', timezone: null });
    expect(byUid.get('unknown-zone')).toMatchObject({ start: '2026-12-03T14:00:00.000Z', end: '2026-12-03T14:30:00.000Z', timezone: null });
    expect(byUid.get('allday-1')).toMatchObject({ start: '2026-12-24', end: '2026-12-27', allDay: true, recurring: false, instanceKey: null });
    expect(byUid.get('allday-2')).toMatchObject({ start: '2026-12-31', end: '2027-01-01', allDay: true });
    expect(byUid.has('old-1')).toBe(false);
  });

  it('prefers an embedded VTIMEZONE over the Intl zone of the same name', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Custom Zone',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0300',
      'TZOFFSETTO:+0300',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:c1',
      'DTSTART;TZID=Custom Zone:20261010T120000',
      'DTEND;TZID=Custom Zone:20261010T130000',
      'SUMMARY:Custom',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const [event] = ok(expandCalendar(job(feed)));
    expect(event?.start).toBe('2026-10-10T09:00:00.000Z');
  });
});

describe('expandCalendar — limits and bad input', () => {
  it('does not expand FREQ=SECONDLY/MINUTELY (first instance only, recurring; counted as shortened)', () => {
    const result = expandCalendar(job(SECONDLY_FEED));
    const events = ok(result);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.recurring).toBe(true);
      expect(e.start).toBe('2026-10-01T10:00:00.000Z');
    }
    expect(result.ok && result.truncated).toBe(2);
  });

  it('rejects more than 5,000 VEVENTs before parsing (a feed limit fails the feed)', () => {
    const result = expandCalendar(job(manyVevents(5_001)));
    expect(result).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('truncates an event that repeats more than 1,000 times in the window: first instances kept, feed OK', () => {
    // An hourly event without an end is legitimate; it must not fail the other events of the feed.
    const result = expandCalendar(job([HOURLY_FEED, SIMPLE_FEED]));
    const events = ok(result);
    const hourly = events.filter((e) => e.remoteId === 'hourly');
    expect(hourly).toHaveLength(1_000);
    expect(hourly[0]!.start).toBe('2026-10-01T00:00:00.000Z');
    expect(hourly[1]!.start).toBe('2026-10-01T01:00:00.000Z');
    expect(hourly.at(-1)!.start).toBe('2026-11-11T15:00:00.000Z'); // the 1,000th hour
    expect(events.filter((e) => e.remoteId !== 'hourly').map((e) => e.title)).toEqual(['Unity Day', 'Parade']);
    expect(result).toMatchObject({ ok: true, truncated: 1 });
  });

  it('truncates on too many iterator steps (also before the window is reached) without failing the feed', () => {
    const steps = expandCalendar(job(HOURLY_FEED, { limits: { maxStepsPerEvent: 100, maxInstancesPerEvent: 100_000 } }));
    expect(ok(steps)).toHaveLength(100);
    expect(steps).toMatchObject({ ok: true, truncated: 1 });

    // Hourly since 2019: > 50,000 steps before the window starts. Nothing of it is shown, the
    // rest of the feed is.
    const old = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:old-hourly',
      'DTSTART:20190101T000000Z',
      'RRULE:FREQ=HOURLY',
      'SUMMARY:Old ping',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:single',
      'DTSTART:20261010T100000Z',
      'SUMMARY:Single',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const result = expandCalendar(job(old));
    expect(ok(result).map((e) => e.remoteId)).toEqual(['single']);
    expect(result).toMatchObject({ ok: true, truncated: 1 });
  }, 20_000); // CPU-bound (50,000 iterator steps): generous under a parallel test run

  it('keeps overrides before the cut of a truncated series and drops the ones after it', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:h',
      'DTSTART:20261001T000000Z',
      'RRULE:FREQ=HOURLY',
      'SUMMARY:Ping',
      'END:VEVENT',
      // Occurrence #3 renamed (inside the kept part).
      'BEGIN:VEVENT',
      'UID:h',
      'RECURRENCE-ID:20261001T020000Z',
      'DTSTART:20261001T020000Z',
      'SUMMARY:Ping (renamed)',
      'END:VEVENT',
      // An occurrence far past the cut moved to early October: part of the cut-off series.
      'BEGIN:VEVENT',
      'UID:h',
      'RECURRENCE-ID:20270101T000000Z',
      'DTSTART:20261002T103000Z',
      'SUMMARY:Ping (moved from January)',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const result = expandCalendar(job(feed));
    const titles = ok(result).map((e) => e.title);
    expect(titles).toHaveLength(1_000);
    expect(titles[2]).toBe('Ping (renamed)');
    expect(titles).not.toContain('Ping (moved from January)');
    expect(result).toMatchObject({ ok: true, truncated: 1 });
  });

  it('fails the feed on too many instances overall', () => {
    const total = expandCalendar(job(SIMPLE_FEED, { limits: { maxInstancesTotal: 1 } }));
    expect(total).toMatchObject({ ok: false, reason: 'limit' });
    // Truncated events still count towards the feed total.
    const many = expandCalendar(job(HOURLY_FEED, { limits: { maxInstancesTotal: 500 } }));
    expect(many).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('reads descriptions: HTML (only with tags) → text, plain text kept, X-ALT-DESC as a fallback', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:html',
      'DTSTART:20261010T100000Z',
      'SUMMARY:Html',
      'DESCRIPTION:<b>Agenda</b><br>Join: <a href="https://meet.example.com/x">link</a><script>alert(1)</script>',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:plain',
      'DTSTART:20261011T100000Z',
      'SUMMARY:Plain',
      'DESCRIPTION:R&amp;D sync\\nline two',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:alt',
      'DTSTART:20261012T100000Z',
      'SUMMARY:Alt',
      'X-ALT-DESC;FMTTYPE=text/html:<p>From Outlook</p><p>Second</p>',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const byId = new Map(ok(expandCalendar(job(feed))).map((e) => [e.remoteId, e.description] as const));
    expect(byId.get('html')).toBe('Agenda\nJoin: link (https://meet.example.com/x)');
    expect(byId.get('plain')).toBe('R&amp;D sync\nline two');
    expect(byId.get('alt')).toBe('From Outlook\nSecond');
  });

  it('reads hostile HTML descriptions in linear time', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:hostile',
      'DTSTART:20261010T100000Z',
      'SUMMARY:Hostile',
      `DESCRIPTION:<b>x</b>${'<div>'.repeat(10_000)}end`,
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const started = performance.now();
    const events = ok(expandCalendar(job(feed)));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(events[0]!.description).toBe('x\nend');
  });

  it('rejects data that is not iCalendar', () => {
    expect(expandCalendar(job('<!doctype html><html><body>Not a calendar</body></html>'))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(expandCalendar(job(ics(['BEGIN:VCARD', 'VERSION:4.0', 'FN:x', 'END:VCARD'])))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('skips malformed events without failing the feed', () => {
    const feed = ics([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//x//y//EN',
      'BEGIN:VEVENT',
      'UID:nostart',
      'SUMMARY:No start',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:good',
      'DTSTART:20261010T100000Z',
      'SUMMARY:Good',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
    const result = expandCalendar(job(feed));
    expect(ok(result).map((e) => e.remoteId)).toEqual(['good']);
    expect(result.ok && result.skipped).toBe(1);
  });

  it('gives events without a UID a stable synthetic id', () => {
    const feed = ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN', 'BEGIN:VEVENT', 'DTSTART:20261010T100000Z', 'SUMMARY:No UID', 'END:VEVENT', 'END:VCALENDAR']);
    const a = ok(expandCalendar(job(feed)))[0]!.remoteId;
    const b = ok(expandCalendar(job(feed)))[0]!.remoteId;
    expect(a).toMatch(/^nouid:[0-9a-f]{40}$/);
    expect(a).toBe(b);
  });
});

describe('runExpandJob (worker_threads)', () => {
  it('parses in a worker', async () => {
    const result = await runExpandJob(job(SIMPLE_FEED));
    expect(result).toMatchObject({ ok: true, name: 'Holidays' });
    expect(result.ok && result.events.map((e) => e.title)).toEqual(['Unity Day', 'Parade']);
  });

  it('refuses 100k VEVENTs', async () => {
    const result = await runExpandJob(job(manyVevents(100_000)));
    expect(result).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('ignores messages that are not the result (node --watch posts watch:import from workers)', async () => {
    const workerUrl = new URL('../__fixtures__/noisy-worker.ts', import.meta.url);
    const result = await runExpandJob(job(SIMPLE_FEED), { workerUrl });
    expect(result).toMatchObject({ ok: true, name: 'Noisy' });
    const silent = await runExpandJob({ ...job(SIMPLE_FEED), noResult: true } as ExpandJob, { workerUrl, timeoutMs: 3_000 });
    expect(silent).toMatchObject({ ok: false, reason: 'error', message: expect.any(String) });
  });

  it('terminates the worker on the wall-clock timeout', async () => {
    const result = await runExpandJob(job(RECURRING_FEED), { timeoutMs: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout', message: expect.stringContaining('Reading the calendar took too long') });
  });

  it('a job that ends without a result is logged by the parent — codes only, in the caller’s log context', async () => {
    const log = createTestLogger();
    const run = createExpandRunner({ log });
    const workerUrl = new URL('../__fixtures__/failing-worker.ts', import.meta.url);
    const feed = job(SIMPLE_FEED);
    const crashed = await withLogContext({ job: 'calendar:ics', run: 'abc123', calendarId: 'c1' }, () => run(feed, { workerUrl }));
    expect(crashed).toMatchObject({ ok: false, reason: 'error' });
    const exited = await withLogContext({ job: 'calendar:sync', run: 'def456', accountId: 'g1' }, () => run({ ...feed, mode: 'exit' } as ExpandJob, { workerUrl }));
    expect(exited).toMatchObject({ ok: false, reason: 'error', message: 'The calendar parser stopped unexpectedly' });
    expect(await run(job(RECURRING_FEED), { timeoutMs: 1 })).toMatchObject({ ok: false, reason: 'timeout' });
    // A result the worker posts (even a refusal) is not a worker failure.
    expect(await run(job(SIMPLE_FEED))).toMatchObject({ ok: true });

    const lines = log.lines().filter((r) => r.msg === 'calendar worker failed');
    expect(lines.map((r) => [r.level, r.fields.reason])).toEqual([
      ['warn', 'error'],
      ['warn', 'error'],
      ['info', 'timeout'],
    ]);
    expect(lines[0]!.fields).toMatchObject({ worker: 'expand', errName: 'TypeError', job: 'calendar:ics', run: 'abc123', calendarId: 'c1', bytes: Buffer.byteLength(SIMPLE_FEED) });
    expect(lines[0]!.fields.ms).toEqual(expect.any(Number));
    expect(lines[1]!.fields).toMatchObject({ worker: 'expand', exitCode: 3, job: 'calendar:sync', run: 'def456', accountId: 'g1' });
    expect(JSON.stringify(lines)).not.toContain('Dentist');
  });

  it('maps failures to health codes', () => {
    expect([expandFailureCode('invalid'), expandFailureCode('limit'), expandFailureCode('timeout'), expandFailureCode('error')]).toEqual([
      'parse_error',
      'too_large',
      'timeout',
      'worker_failed',
    ]);
  });
});

describe('expandCalendar — long-running series (CAL-2)', () => {
  const since2005 = (rule: string, extra: string[] = [], tz = 'America/Chicago', uid = 'long-1'): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=${tz}:20050103T090000`,
    `DTEND;TZID=${tz}:20050103T093000`,
    `RRULE:${rule}`,
    'SUMMARY:Standup',
    ...extra,
    'END:VEVENT',
  ];
  const calendar = (...vevents: string[][]) => ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN', ...vevents.flat(), 'END:VCALENDAR']);
  const keys = (events: ExpandedEvent[]) => events.map((e) => [e.remoteId, e.instanceKey, e.start, e.end, e.title].join('|'));

  it.each([
    ['daily', 'FREQ=DAILY', []],
    ['every 3 days', 'FREQ=DAILY;INTERVAL=3', []],
    ['weekdays', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', []],
    ['bi-weekly Monday + Thursday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=SU', []],
    ['weekly until mid-window', 'FREQ=WEEKLY;UNTIL=20270115T150000Z', []],
    ['daily that ended years ago', 'FREQ=DAILY;UNTIL=20190101T000000Z', []],
    ['daily with EXDATEs', 'FREQ=DAILY', ['EXDATE;TZID=America/Chicago:20261002T090000,20261225T090000']],
    ['weekly BYDAY without DTSTART weekday (not fast-forwarded)', 'FREQ=WEEKLY;BYDAY=TU,TH', []],
    ['daily BYMONTH (not fast-forwarded)', 'FREQ=DAILY;BYMONTH=1,12', []],
  ])('fast-forwarding yields exactly the same instances: %s', (_label, rule, extra) => {
    const moved = [
      'BEGIN:VEVENT',
      'UID:long-1',
      'RECURRENCE-ID;TZID=America/Chicago:20260801T090000',
      'DTSTART;TZID=America/Chicago:20261001T150000',
      'DTEND;TZID=America/Chicago:20261001T153000',
      'SUMMARY:Moved into the window from before it',
      'END:VEVENT',
    ];
    const cancelled = [
      'BEGIN:VEVENT',
      'UID:long-1',
      'RECURRENCE-ID;TZID=America/Chicago:20261103T090000',
      'DTSTART;TZID=America/Chicago:20261103T090000',
      'STATUS:CANCELLED',
      'SUMMARY:Cancelled',
      'END:VEVENT',
    ];
    const data = calendar(since2005(rule, extra as string[]), moved, cancelled);
    const fast = ok(expandCalendar(job(data, { localTz: 'America/Chicago' })));
    const slow = ok(expandCalendar(job(data, { localTz: 'America/Chicago', fastForward: false })));
    expect(keys(fast)).toEqual(keys(slow));
  });

  it('all-day and floating series too', () => {
    const allDay = ['BEGIN:VEVENT', 'UID:ad', 'DTSTART;VALUE=DATE:20040101', 'RRULE:FREQ=WEEKLY;INTERVAL=2', 'SUMMARY:Bins', 'END:VEVENT'];
    const floating = ['BEGIN:VEVENT', 'UID:fl', 'DTSTART:20060301T233000', 'DTEND:20060302T003000', 'RRULE:FREQ=DAILY', 'SUMMARY:Late', 'END:VEVENT'];
    const data = calendar(allDay, floating);
    expect(keys(ok(expandCalendar(job(data))))).toEqual(keys(ok(expandCalendar(job(data, { fastForward: false })))));
  });

  it('ten daily series since 2005 in a TZID without VTIMEZONE fit comfortably in the worker budget', async () => {
    const data = calendar(...Array.from({ length: 10 }, (_, i) => since2005('FREQ=DAILY', [], 'America/Chicago', `s${i}`)));
    // Deterministic, not wall-clock: from DTSTART each series needs ~7,900 iterator steps (that took
    // ~2.7 s in-process and timed out — 5 s — in the worker); fast-forwarded, a few hundred.
    const limits = { maxStepsPerEvent: 1_000 };
    const result = await runExpandJob(job(data, { localTz: 'America/Chicago', limits }));
    expect(result).toMatchObject({ ok: true, truncated: 0 });
    expect(result.ok && result.events.length).toBeGreaterThan(10 * 390);
    const unaligned = await runExpandJob(job(data, { localTz: 'America/Chicago', limits, fastForward: false }), { timeoutMs: 20_000 });
    expect(unaligned).toMatchObject({ ok: true, truncated: 10 });
  }, 30_000);
});

describe('expandCalendar — text budget (CAL-1, DOS-3)', () => {
  const description = 'x'.repeat(8_000);
  const hourly = (i: number) => [
    'BEGIN:VEVENT',
    `UID:h${i}`,
    'DTSTART:20260901T000000Z',
    'DTEND:20260901T003000Z',
    'RRULE:FREQ=HOURLY',
    `SUMMARY:Hourly ${i}`,
    `DESCRIPTION:${description}`,
    'END:VEVENT',
  ];
  const feed = (n: number) =>
    ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//y//EN', ...Array.from({ length: n }, (_, i) => hourly(i)).flat(), 'END:VCALENDAR']);

  it('a tiny feed cannot expand into hundreds of MB: descriptions stop at the budget', () => {
    // Three lines of RRULE are 3,000 instances; 20 such events (20,000 instances, the job limit)
    // were 160 MB of descriptions. Three are enough to cross the default 8 MiB budget.
    const result = expandCalendar(job(feed(3)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(3_000);
    const descriptions = result.events.reduce((sum, e) => sum + (e.description?.length ?? 0), 0);
    expect(descriptions).toBeLessThanOrEqual(8 * 1024 * 1024);
    // Was 3,000 × 8 KB ≈ 24 MB of descriptions.
    expect(descriptions).toBeGreaterThan(7 * 1024 * 1024);
    expect(result.descriptionsDropped).toBeGreaterThan(1_900);
    // The first instances keep their description.
    expect(result.events[0]!.description).toHaveLength(8_000);
  }, 20_000);

  it('fails the job when even the text without descriptions exceeds twice the budget', () => {
    const result = expandCalendar(job(feed(2), { limits: { maxTextChars: 1_000 } }));
    expect(result).toMatchObject({ ok: false, reason: 'limit' });
  });
});
