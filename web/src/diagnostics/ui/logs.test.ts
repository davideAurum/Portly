/**
 * The server log panel's model: the query its filters make, how the first page, Live's appended
 * records and the older file records combine (no duplicates, file lines told apart by all their
 * fields, ≤ 2 000, newest kept, appended records kept across a refetch of the page), where "Show
 * older" starts (memory's rings reach back unequally far) and what of a file batch memory already
 * shows, the chips' names (stable while no name changes), and the Timeline: this browser's events
 * merged by time, filtered like the server's records, without the uploaded copies of the events it
 * shows (but with those of events it no longer has or does not show).
 */
import { describe, expect, it } from 'vitest';
import { recordClientEvent, type ClientLogEntry } from '../clientLog.ts';
import {
  DEFAULT_LOG_FILTERS,
  MAX_LOG_ROWS,
  UPLOADED_COPY_TOLERANCE_MS,
  addOlderBatch,
  browserEventMatches,
  hasNarrowingFilters,
  isLate,
  logNameSource,
  logNamesFrom,
  logRows,
  logsQueryFor,
  mergeLogRecords,
  newFileRecords,
  nextOlderBefore,
  olderBefore,
  recordChips,
  type LogFilters,
} from './logs.ts';
import { healthEntry, logRecord, T0 } from './testing.ts';

function filters(patch: Partial<LogFilters> = {}): LogFilters {
  return { ...DEFAULT_LOG_FILTERS, ...patch };
}

describe('logsQueryFor', () => {
  it('asks for the memory ring at the chosen level, leaving unset filters out', () => {
    expect(logsQueryFor(DEFAULT_LOG_FILTERS)).toEqual({ scope: 'memory', level: 'info', limit: 500 });
    expect(hasNarrowingFilters(DEFAULT_LOG_FILTERS)).toBe(false);
  });

  it('passes every filter that is set', () => {
    const f = filters({
      level: 'debug',
      area: 'calendar',
      src: 'client',
      q: '  failing ',
      chips: { rid: 'abcdefghij', accountId: 'acc-1' },
      key: 'calendar:cal-1',
      since: '2026-10-11T11:00:00.000Z',
      before: '2026-10-11T13:00:00.000Z',
    });
    expect(logsQueryFor(f)).toEqual({
      scope: 'memory',
      level: 'debug',
      limit: 500,
      area: 'calendar',
      src: 'client',
      q: 'failing',
      rid: 'abcdefghij',
      accountId: 'acc-1',
      key: 'calendar:cal-1',
      since: '2026-10-11T11:00:00.000Z',
      before: '2026-10-11T13:00:00.000Z',
    });
    expect(hasNarrowingFilters(f)).toBe(true);
  });
});

describe('mergeLogRecords', () => {
  it('keeps the older file records, the first page and the appended records, each once, oldest first', () => {
    const file = logRecord({ seq: 0, t: '2026-10-11T10:00:00.000Z', msg: 'from the file' });
    const a = logRecord({ seq: 10, t: '2026-10-11T11:00:00.000Z' });
    const b = logRecord({ seq: 11, t: '2026-10-11T11:00:01.000Z' });
    const c = logRecord({ seq: 12, t: '2026-10-11T11:00:02.000Z' });
    // The page was refetched (it has b) while Live had appended b and c; two "Show older" batches both brought the file record.
    const older = addOlderBatch([file], addOlderBatch([file], []));
    expect(older).toEqual([file]);
    const merged = mergeLogRecords(older, [a, b], [b, c]);
    expect(merged.map((r) => r.seq)).toEqual([0, 10, 11, 12]);
  });

  it('keeps what Live appended when a refetch of the first page (the tab shown again) no longer reaches it', () => {
    const at = (seq: number) => logRecord({ seq, t: new Date(Date.parse(T0) + seq * 1000).toISOString() });
    const appended = Array.from({ length: 1000 }, (_, i) => at(501 + i));
    expect(mergeLogRecords([], Array.from({ length: 500 }, (_, i) => at(1 + i)), appended)).toHaveLength(1500);
    // The refetched page: the newest 500 (its lastSeq the server's newest).
    const merged = mergeLogRecords([], Array.from({ length: 500 }, (_, i) => at(1001 + i)), appended);
    expect(merged).toHaveLength(1000);
    expect(merged[0]!.seq).toBe(501);
  });

  it('tells file records apart by all their fields (one loop writes a line per calendar in the same millisecond)', () => {
    const t = '2026-10-11T10:00:00.000Z';
    const cal1 = logRecord({ seq: 0, t, area: 'calendar', msg: 'calendar failing', fields: { key: 'calendar:cal-1', calendarId: 'cal-1' } });
    const cal2 = logRecord({ seq: 0, t, area: 'calendar', msg: 'calendar failing', fields: { key: 'calendar:cal-2', calendarId: 'cal-2' } });
    const older = addOlderBatch([cal1, cal2], []);
    expect(mergeLogRecords(older, [], [])).toEqual([cal1, cal2]);
    expect(logRows(older, null, DEFAULT_LOG_FILTERS)).toHaveLength(2);
    // Lines identical in every field are still distinct lines within one batch: kept, with distinct row ids.
    const twice = addOlderBatch([cal1, { ...cal1 }], []);
    expect(twice).toHaveLength(2);
    const rows = logRows(mergeLogRecords(twice, [], []), null, DEFAULT_LOG_FILTERS);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('keeps at most 2 000 older records, the newest', () => {
    const batch = (from: number) => Array.from({ length: 1500 }, (_, i) => logRecord({ seq: 0, t: new Date(Date.parse(T0) - (from + i) * 1000).toISOString() })).reverse();
    const first = batch(0);
    const older = addOlderBatch(batch(1500), first);
    expect(older).toHaveLength(MAX_LOG_ROWS);
    expect(older.at(-1)).toBe(first.at(-1));
  });

  it('keeps the newest 2 000', () => {
    const many = Array.from({ length: MAX_LOG_ROWS + 5 }, (_, i) => logRecord({ seq: i + 1, t: new Date(Date.parse(T0) + i).toISOString() }));
    const merged = mergeLogRecords([], many, []);
    expect(merged).toHaveLength(MAX_LOG_ROWS);
    expect(merged[0]!.seq).toBe(6);
  });

  it('starts "Show older" before the newest record shown from memory, else the window end, else now', () => {
    const r = logRecord({ t: '2026-10-11T10:00:00.000Z' });
    // A browser event sorts by when it happened (tEvent), but the files are scanned by `t`.
    const uploaded = logRecord({ t: '2026-10-11T10:30:00.000Z', tEvent: '2026-10-11T11:00:00.000Z', src: 'client' });
    expect(olderBefore([uploaded, r], DEFAULT_LOG_FILTERS, 0)).toBe('2026-10-11T10:30:00.000Z');
    expect(olderBefore([], filters({ before: '2026-10-11T13:00:00.000Z' }), 0)).toBe('2026-10-11T13:00:00.000Z');
    expect(olderBefore([], DEFAULT_LOG_FILTERS, Date.parse(T0))).toBe(T0);
    // The next batch reads the oldest line's millisecond again (lines it had no room for), unless that is all it had.
    expect(nextOlderBefore([uploaded, r], '2026-10-11T11:00:00.000Z')).toBe('2026-10-11T10:00:00.001Z');
    expect(nextOlderBefore([r, { ...r }], '2026-10-11T10:00:00.001Z')).toBe('2026-10-11T10:00:00.000Z');
    expect(nextOlderBefore([], T0)).toBeNull();
  });

  it('reaches the lines a busy ring dropped although a quiet ring reaches further back (no gap)', () => {
    type Rec = ReturnType<typeof logRecord>;
    const minute = (m: number) => new Date(Date.parse('2026-10-11T08:00:00.000Z') + m * 60_000).toISOString();
    // Every minute an info line (the main ring keeps 5 000) and 10 debug lines (the area's ring keeps 400).
    const file: Rec[] = [];
    for (let m = 0; m < 300; m++) {
      file.push(logRecord({ seq: 0, t: minute(m), area: 'calendar', msg: 'calendar synced' }));
      for (let i = 0; i < 10; i++) file.push(logRecord({ seq: 0, t: minute(m), level: 'debug', area: 'calendar', msg: 'outbound', fields: { n: i } }));
    }
    // The memory page: the newest 400 debug lines (minutes 260–299) and 100 info lines (200–299).
    let seq = 0;
    const memory = [...file.filter((r) => r.level === 'info').slice(-100), ...file.filter((r) => r.level === 'debug').slice(-400)].map((r) => ({ ...r, seq: ++seq }));
    // The server's file read: the newest 500 matching lines before `before`.
    const read = (before: string) => file.filter((r) => Date.parse(r.t) < Date.parse(before)).slice(-500);
    let before = olderBefore(memory, filters({ level: 'debug' }), 0);
    expect(before).toBe(minute(299));
    let older: Rec[] = [];
    for (let i = 0; i < 3; i++) {
      const batch = read(before);
      older = addOlderBatch(newFileRecords(batch, memory, older), older);
      before = nextOlderBefore(batch, before)!;
    }
    // The debug lines of minutes 200–259, beside info lines memory still shows, are all there…
    expect(older.filter((r) => r.level === 'debug' && r.t >= minute(200) && r.t < minute(260))).toHaveLength(600);
    // …and nothing memory shows comes again from the files.
    const shown = new Set(memory.map((r) => `${r.t}|${r.msg}|${JSON.stringify(r.fields)}`));
    expect(older.filter((r) => shown.has(`${r.t}|${r.msg}|${JSON.stringify(r.fields)}`))).toEqual([]);
    expect(mergeLogRecords(older, memory, [])).toHaveLength(older.length + memory.length);
  });
});

describe('logNameSource', () => {
  it('names accounts (the accounts list first) and calendars, and changes only when a name does', () => {
    const health = [
      healthEntry('account:acc-1', { label: 'Dana Work' }),
      healthEntry('calendar:cal-1', { label: 'Soccer' }),
      healthEntry('ics:ics-1', { label: 'School' }),
      healthEntry('feed:abc', { label: 'blog.example.org' }),
    ];
    const accounts = [{ id: 'acc-1', label: 'Work' }];
    const source = logNameSource(health, accounts);
    const names = logNamesFrom(source);
    expect([names.account('acc-1'), names.calendar('cal-1'), names.calendar('ics-1'), names.account('acc-2')]).toEqual(['Work', 'Soccer', 'School', null]);
    expect(logNamesFrom(logNameSource(health, [])).account('acc-1')).toBe('Dana Work');
    // A refetched summary (new times, the same names) gives the same source: the names keep their identity.
    expect(logNameSource(health.map((entry) => ({ ...entry, lastCheckedAt: '2026-10-11T12:30:00.000Z' })), accounts)).toBe(source);
    expect(logNameSource([...health.slice(0, 1), healthEntry('calendar:cal-1', { label: 'Football' })], accounts)).not.toBe(source);
  });
});

describe('records', () => {
  it('offers request, job, run, account and calendar chips', () => {
    const r = logRecord({ rid: 'abcdefghij', fields: { job: 'calendar:sync', run: 'r1x2y3', accountId: 'acc-1', calendarId: 'cal-1', host: 'x' } });
    expect(recordChips(r)).toEqual([
      ['rid', 'abcdefghij'],
      ['job', 'calendar:sync'],
      ['run', 'r1x2y3'],
      ['accountId', 'acc-1'],
      ['calendarId', 'cal-1'],
    ]);
  });

  it('marks uploaded browser events the server received late', () => {
    expect(isLate(logRecord({ src: 'client', fields: { client: { late: true } } }))).toBe(true);
    expect(isLate(logRecord({ src: 'client', fields: { client: { late: false } } }))).toBe(false);
    expect(isLate(logRecord({ src: 'server', fields: { client: { late: true } } }))).toBe(false);
  });
});

describe('timeline', () => {
  function event(level: 'debug' | 'info' | 'warn' | 'error', fields: Record<string, unknown> = {}): ClientLogEntry {
    const entry = recordClientEvent(level, 'api', 'request failed', { method: 'GET', path: '/api/mail/summary', status: 503, ...fields });
    if (entry === null) throw new Error('not recorded');
    return entry;
  }

  it('filters browser events like the server records (level, source, area, key, chips, window, text)', () => {
    const warn = event('warn', { rid: 'abcdefghij' });
    expect(browserEventMatches(warn, DEFAULT_LOG_FILTERS)).toBe(true);
    expect(browserEventMatches(warn, filters({ level: 'error' }))).toBe(false);
    expect(browserEventMatches(warn, filters({ src: 'server' }))).toBe(false);
    expect(browserEventMatches(warn, filters({ src: 'client', area: 'client' }))).toBe(true);
    expect(browserEventMatches(warn, filters({ area: 'calendar' }))).toBe(false);
    expect(browserEventMatches(warn, filters({ key: 'calendar:cal-1' }))).toBe(false);
    expect(browserEventMatches(warn, filters({ chips: { rid: 'abcdefghij' } }))).toBe(true);
    expect(browserEventMatches(warn, filters({ chips: { rid: 'zzzzzzzzzz' } }))).toBe(false);
    expect(browserEventMatches(warn, filters({ q: 'MAIL/SUMMARY' }))).toBe(true);
    expect(browserEventMatches(warn, filters({ q: 'calendar' }))).toBe(false);
    expect(browserEventMatches(warn, filters({ before: '2000-01-01T00:00:00.000Z' }))).toBe(false);
  });

  /** The server's record of an uploaded event (`client: <msg>`, `tEvent` = its time plus the clock skew). */
  function uploaded(entry: ClientLogEntry, skewMs: number, session = entry.event.session): ReturnType<typeof logRecord> {
    const tEvent = new Date(Date.parse(entry.event.t) + skewMs).toISOString();
    return logRecord({ src: 'client', area: 'client', level: entry.event.level, t: tEvent, tEvent, msg: `client: ${entry.event.msg}`, fields: { client: { cat: entry.event.cat, session, page: entry.event.page, late: false } } });
  }

  it('merges this browser’s events by time, newest first, hiding the uploaded copies of the events it shows', () => {
    const local = event('warn');
    const ownCopy = uploaded(local, 800);
    const otherBrowser = uploaded(local, 1000, 'someone-else');
    const old = logRecord({ t: '2000-01-01T00:00:00.000Z' });
    const timeline = logRows([old, ownCopy, otherBrowser], [local], DEFAULT_LOG_FILTERS);
    expect(timeline.map((row) => (row.kind === 'server' ? row.record.seq : row.entry.id))).toEqual([otherBrowser.seq, local.id, old.seq]);
    // Without the Timeline, every server record shows.
    expect(logRows([old, ownCopy, otherBrowser], null, DEFAULT_LOG_FILTERS)).toHaveLength(3);
  });

  it('keeps the uploaded copies of events this browser no longer has or does not show', () => {
    const kept = event('warn');
    const evicted = event('warn', { status: 500 });
    // The evicted event happened long before the one the ring still has (same session, category and message).
    const evictedCopy = { ...uploaded(evicted, 0), t: '2026-10-01T00:00:00.000Z', tEvent: '2026-10-01T00:00:00.000Z' };
    const keptCopy = uploaded(kept, 500);
    const rows = logRows([evictedCopy, keptCopy], [kept], DEFAULT_LOG_FILTERS);
    expect(rows.map((row) => (row.kind === 'server' ? row.record.seq : row.entry.id))).toEqual([kept.id, evictedCopy.seq]);
    // A clock skew beyond the tolerance: both copies show.
    expect(logRows([uploaded(kept, UPLOADED_COPY_TOLERANCE_MS + 1)], [kept], DEFAULT_LOG_FILTERS)).toHaveLength(2);
    // The local entry does not match the filters although its copy does (the server searched its `client: ` message): the copy stays.
    const onlyCopy = logRows([keptCopy], [kept], filters({ q: 'client:' }));
    expect(onlyCopy.map((row) => row.kind)).toEqual(['server']);
  });

  it('sorts an uploaded event by when it happened (tEvent)', () => {
    const late = logRecord({ seq: 50, t: '2026-10-11T12:10:00.000Z', tEvent: '2026-10-11T11:00:00.000Z', src: 'client' });
    const middle = logRecord({ seq: 40, t: '2026-10-11T11:30:00.000Z' });
    expect(logRows([middle, late], null, DEFAULT_LOG_FILTERS).map((row) => (row.kind === 'server' ? row.record.seq : 0))).toEqual([40, 50]);
  });
});
