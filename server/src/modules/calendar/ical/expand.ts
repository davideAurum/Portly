/**
 * iCalendar parsing and recurrence expansion (§4.9, §8 Recurrence) for ICS feeds and CalDAV
 * collections. Runs inside the parse worker (see `run.ts`); pure apart from ical.js's global
 * TimezoneService, which is reset for every job.
 *
 * - Every VTIMEZONE is registered with `ICAL.TimezoneService.register`. TZIDs without a VTIMEZONE
 *   resolve to an IANA zone (directly, or a Windows id via the bundled CLDR table) backed by
 *   `Intl`; anything else is floating and read in `job.localTz` (the server's zone).
 * - For every master VEVENT an `ICAL.Event` is built and `relateException` is called for every
 *   VEVENT with the same UID and a RECURRENCE-ID; `iterator()` + `getOccurrenceDetails` expand
 *   it until past the window end (EXDATE/RDATE handled by ical.js).
 * - Limits (§4.9): per event ≤ 1,000 instances in the window and ≤ 50,000 iterator steps. An
 *   event over either limit is TRUNCATED (its first instances in the window are kept) and counted
 *   in `truncated`, so one legitimately endless series (e.g. hourly, no end) never fails the feed;
 *   FREQ=SECONDLY/MINUTELY are not expanded (first instance only, recurring; also counted). Feed
 *   limits (≤ 5,000 VEVENTs, ≤ 20,000 instances per job) fail the whole job (the caller keeps the
 *   previously cached rows and records the error), as do the worker's timeout and memory limits.
 * - Text budget (§4.9, §4.1(d)): the limits above count instances, not bytes, and every instance
 *   carries its own copy of the (≤ 8 KB) description. Past `maxTextChars` of instance text per
 *   job, further instances are emitted without their description (counted in
 *   `descriptionsDropped`, reported as a warning); past twice that the job fails as too large.
 * - Speed: long-running DAILY/WEEKLY series (no COUNT, BYSETPOS or RDATE) are iterated from an
 *   occurrence aligned to DTSTART + k×INTERVAL shortly before the window instead of from DTSTART,
 *   so a daily meeting that started in 2005 costs a few hundred steps, not thousands.
 * - Descriptions: DESCRIPTION is plain text by the RFC, but some feeds put HTML in it (Google) or
 *   only in X-ALT-DESC;FMTTYPE=text/html (Outlook); markup becomes plain text in linear time.
 * - Expanded instances: `instanceKey` = the occurrence's original start (RECURRENCE-ID) in UTC
 *   (`YYYY-MM-DD` for all-day), `editable = false`.
 */
import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { descriptionText } from '../text.ts';
import { formatDate, isoUtc, wallToUtcMs } from '../time.ts';
import { resolveTimeZoneName } from '../windows-zones.ts';

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;

export interface ExpandLimits {
  maxVevents: number;
  maxInstancesPerEvent: number;
  maxStepsPerEvent: number;
  maxInstancesTotal: number;
  /**
   * Text (title + location + description + links, in chars) the job's instances may carry: past
   * it descriptions are left out; past twice it the job fails (`limit`).
   */
  maxTextChars: number;
}

export const DEFAULT_LIMITS: Readonly<ExpandLimits> = Object.freeze({
  maxVevents: 5_000,
  maxInstancesPerEvent: 1_000,
  maxStepsPerEvent: 50_000,
  maxInstancesTotal: 20_000,
  maxTextChars: 8 * 1024 * 1024,
});

export interface ExpandSource {
  /** iCalendar text (one VCALENDAR). */
  data: string;
  /** CalDAV object etag. */
  etag?: string | null;
}

export interface ExpandWindow {
  fromDate: string;
  toDate: string;
  fromMs: number;
  toMs: number;
}

export interface ExpandJob {
  sources: ExpandSource[];
  window: ExpandWindow;
  /** Zone floating times are read in (the server's). */
  localTz: string;
  limits?: Partial<ExpandLimits>;
  /** Iterate long-running simple series from an aligned occurrence (default true; tests compare). */
  fastForward?: boolean;
}

/** Plain event instance (same shape as the module's EventRecord). */
export interface ExpandedEvent {
  remoteId: string;
  instanceKey: string | null;
  etag: string | null;
  title: string;
  location: string | null;
  description: string | null;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  recurring: boolean;
  seriesId: string | null;
  htmlUrl: string | null;
  meetingUrl: string | null;
  editable: false;
}

export type ExpandFailure = 'limit' | 'invalid' | 'timeout' | 'error';

export type ExpandResult =
  | {
      ok: true;
      events: ExpandedEvent[];
      vevents: number;
      name: string | null;
      color: string | null;
      /** Malformed events that were left out. */
      skipped: number;
      /** Recurring events shortened by the per-event limits (or not expanded: SECONDLY/MINUTELY). */
      truncated: number;
      /** Instances emitted without their description because of the text budget. */
      descriptionsDropped: number;
    }
  | { ok: false; reason: ExpandFailure; message: string };

export class ExpandError extends Error {
  override name = 'ExpandError';
  readonly reason: ExpandFailure;
  constructor(reason: ExpandFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** An ICAL.Timezone whose offsets come from `Intl` for an IANA zone (no VTIMEZONE needed). */
class IntlTimezone extends ICAL.Timezone {
  readonly iana: string;
  /** Offsets by wall time: ical.js asks for the same time several times per occurrence. */
  readonly #offsets = new Map<number, number>();
  constructor(tzid: string, iana: string) {
    super({ tzid });
    this.iana = iana;
  }

  override utcOffset(tt: IcalTime): number {
    const local = Date.UTC(tt.year, tt.month - 1, tt.day, tt.hour, tt.minute, tt.second);
    const cached = this.#offsets.get(local);
    if (cached !== undefined) return cached;
    const wall = { year: tt.year, month: tt.month, day: tt.day, hour: tt.hour, minute: tt.minute, second: tt.second };
    const offset = Math.round((local - wallToUtcMs(wall, this.iana)) / 1000);
    if (this.#offsets.size >= 4096) this.#offsets.clear();
    this.#offsets.set(local, offset);
    return offset;
  }
}

const TIME_PROPS = ['dtstart', 'dtend', 'due', 'recurrence-id', 'exdate', 'rdate'] as const;

function tzidsOf(vevent: IcalComponent): string[] {
  const out: string[] = [];
  for (const name of TIME_PROPS) {
    for (const prop of vevent.getAllProperties(name)) {
      const tzid = prop.getParameter('tzid');
      if (typeof tzid === 'string' && tzid !== '') out.push(tzid);
    }
  }
  return out;
}

/** Registers every VTIMEZONE, then Intl-backed zones for referenced TZIDs that have none. */
function registerTimezones(roots: IcalComponent[], vevents: IcalComponent[]): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  for (const root of roots) {
    for (const vtz of root.getAllSubcomponents('vtimezone')) {
      try {
        const tzid = vtz.getFirstPropertyValue('tzid');
        if (typeof tzid !== 'string' || tzid === '') continue;
        ICAL.TimezoneService.register(vtz);
        resolved.set(tzid, resolveTimeZoneName(tzid));
      } catch {
        // A broken VTIMEZONE is ignored; the TZID is resolved below like a missing one.
      }
    }
  }
  for (const vevent of vevents) {
    for (const tzid of tzidsOf(vevent)) {
      if (resolved.has(tzid) || ICAL.TimezoneService.has(tzid)) continue;
      const iana = resolveTimeZoneName(tzid);
      resolved.set(tzid, iana);
      if (iana) ICAL.TimezoneService.register(new IntlTimezone(tzid, iana), tzid);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

interface Moment {
  allDay: boolean;
  /** `YYYY-MM-DD` (all-day) or ISO UTC. */
  value: string;
  /** Epoch ms (all-day: start of the day in UTC; for ordering only). */
  ms: number;
}

function isFloating(t: IcalTime): boolean {
  return t.zone === ICAL.Timezone.localTimezone || t.zone?.tzid === 'floating';
}

function momentOf(t: IcalTime, localTz: string): Moment {
  if (t.isDate) {
    return { allDay: true, value: formatDate(t.year, t.month, t.day), ms: Date.UTC(t.year, t.month - 1, t.day) };
  }
  const ms = isFloating(t)
    ? wallToUtcMs({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, localTz)
    : t.toUnixTime() * 1000;
  return { allDay: false, value: isoUtc(ms), ms };
}

function dateOfTime(t: IcalTime): string {
  return formatDate(t.year, t.month, t.day);
}

function stringProp(comp: IcalComponent, name: string): string | null {
  try {
    const value = comp.getFirstPropertyValue(name);
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

function statusOf(comp: IcalComponent): ExpandedEvent['status'] {
  const value = stringProp(comp, 'status')?.toUpperCase();
  if (value === 'CANCELLED') return 'cancelled';
  if (value === 'TENTATIVE') return 'tentative';
  return 'confirmed';
}

const MEETING_PROPS = ['x-google-conference', 'x-microsoft-skypeteamsmeetingurl', 'x-microsoft-onlinemeetingconflink'];

function meetingUrlOf(comp: IcalComponent): string | null {
  for (const prop of comp.getAllProperties('conference')) {
    try {
      const value = prop.getFirstValue();
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    } catch {
      // ignore malformed values
    }
  }
  for (const name of MEETING_PROPS) {
    const value = stringProp(comp, name);
    if (value && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

function tzidOf(comp: IcalComponent): string | null {
  const tzid = comp.getFirstProperty('dtstart')?.getParameter('tzid');
  return typeof tzid === 'string' && tzid !== '' ? tzid : null;
}

function syntheticUid(comp: IcalComponent): string {
  const basis = [stringProp(comp, 'summary') ?? '', comp.getFirstProperty('dtstart')?.toICALString() ?? ''].join('\n');
  return `nouid:${createHash('sha1').update(basis).digest('hex')}`;
}

function uidOf(comp: IcalComponent): string {
  return stringProp(comp, 'uid')?.trim().slice(0, 1000) ?? syntheticUid(comp);
}

function recurrenceKey(t: IcalTime, localTz: string): string {
  return t.isDate ? dateOfTime(t) : momentOf(t, localTz).value;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

function textChars(value: string | null): number {
  return value === null ? 0 : value.length;
}

class Collector {
  readonly events: ExpandedEvent[] = [];
  readonly limits: ExpandLimits;
  /** Events shortened by a per-event limit. */
  truncated = 0;
  /** Instances emitted without their description (text budget). */
  descriptionsDropped = 0;
  /** Text carried by the emitted instances so far (chars). */
  textChars = 0;
  constructor(limits: ExpandLimits) {
    this.limits = limits;
  }

  push(event: ExpandedEvent): void {
    if (this.events.length >= this.limits.maxInstancesTotal) {
      throw new ExpandError('limit', `The calendar has more than ${this.limits.maxInstancesTotal.toLocaleString('en-US')} events in the sync window`);
    }
    const base = textChars(event.title) + textChars(event.location) + textChars(event.htmlUrl) + textChars(event.meetingUrl);
    let out = event;
    if (event.description !== null && this.textChars + base + event.description.length > this.limits.maxTextChars) {
      out = { ...event, description: null };
      this.descriptionsDropped++;
    }
    this.textChars += base + textChars(out.description);
    if (this.textChars > this.limits.maxTextChars * 2) {
      throw new ExpandError('limit', 'The calendar’s events carry too much text to store');
    }
    this.events.push(out);
  }
}

interface Occurrence {
  start: Moment;
  end: Moment;
}

function overlaps(o: Occurrence, w: ExpandWindow): boolean {
  if (o.start.allDay) return o.start.value < w.toDate && o.end.value > w.fromDate;
  if (o.start.ms >= w.toMs) return false;
  return o.end.ms > w.fromMs || (o.end.ms === o.start.ms && o.start.ms >= w.fromMs);
}

/** Start/end of an occurrence, keeping all-day ends as dates and ends after starts. */
function occurrence(startTime: IcalTime, endTime: IcalTime | null, localTz: string): Occurrence {
  const start = momentOf(startTime, localTz);
  let end: Moment;
  if (start.allDay) {
    const endDate = endTime ? dateOfTime(endTime) : null;
    let value: string;
    if (endDate !== null && endDate > start.value) {
      value = endDate;
    } else {
      const d = new Date(Date.UTC(startTime.year, startTime.month - 1, startTime.day + 1));
      value = formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    end = { allDay: true, value, ms: Date.parse(`${value}T00:00:00Z`) };
  } else if (endTime && !endTime.isDate) {
    end = momentOf(endTime, localTz);
    if (end.ms < start.ms) end = start;
  } else {
    end = start;
  }
  return { start, end };
}

/**
 * Generous pre-caps (the store applies the real limits, §4.4): text beyond them could never be
 * stored, so it is not carried out of the worker or counted against the text budget.
 */
const MAX_TITLE_CHARS = 2_000;
const MAX_LOCATION_CHARS = 4_000;
/** SafeHttpUrl's limit: longer links are dropped by the store anyway. */
const MAX_URL_CHARS = 2_048;

function capped(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function urlOrNull(value: string | null): string | null {
  return value !== null && value.length <= MAX_URL_CHARS ? value : null;
}

function baseFields(comp: IcalComponent, uid: string, etag: string | null, resolved: Map<string, string | null>) {
  const tzid = tzidOf(comp);
  return {
    remoteId: uid,
    etag,
    title: capped(stringProp(comp, 'summary'), MAX_TITLE_CHARS) ?? '',
    location: capped(stringProp(comp, 'location'), MAX_LOCATION_CHARS),
    description: descriptionOf(comp),
    timezone: tzid ? (resolved.get(tzid) ?? resolveTimeZoneName(tzid)) : null,
    status: statusOf(comp),
    htmlUrl: urlOrNull(stringProp(comp, 'url')),
    meetingUrl: urlOrNull(meetingUrlOf(comp)),
    editable: false as const,
  };
}

/** = EVENT_TEXT_LIMITS.description (not imported: the worker stays free of the shared bundle; the store caps again). */
const MAX_DESCRIPTION = 8 * 1024;

/** DESCRIPTION (read as HTML only when it has tags), else an HTML X-ALT-DESC, as plain text. */
function descriptionOf(comp: IcalComponent): string | null {
  const max = MAX_DESCRIPTION;
  const plain = descriptionText(stringProp(comp, 'description'), max, 'auto-tags');
  if (plain !== null) return plain;
  for (const prop of comp.getAllProperties('x-alt-desc')) {
    try {
      const type = prop.getParameter('fmttype');
      const value = prop.getFirstValue();
      if (typeof type === 'string' && type.toLowerCase() === 'text/html' && typeof value === 'string') {
        const text = descriptionText(value, max, 'html');
        if (text !== null) return text;
      }
    } catch {
      // ignore malformed values
    }
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The master's duration in ms (0 when unknown or negative). */
function durationMs(event: IcalEvent): number {
  try {
    const seconds = event.duration?.toSeconds();
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

/** A DTSTART-aligned place to start iterating a long-running simple series from (see below). */
type IterationStart = { kind: 'dtstart' } | { kind: 'aligned'; start: IcalTime } | { kind: 'ended' };

const FAST_FORWARD_FREQS = new Set(['DAILY', 'WEEKLY']);
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/**
 * For a DAILY or WEEKLY series without COUNT, BYSETPOS, RDATE or BY-rules other than a WEEKLY
 * BYDAY that includes DTSTART's weekday, the occurrence DTSTART + k×INTERVAL (in wall time, so
 * DST is irrelevant) is itself an occurrence and has the same rule phase as DTSTART: iterating
 * from it yields exactly the occurrences the full iteration would from that point on. k is
 * chosen so the aligned start falls at least one period before `beforeMs`. Anything else
 * iterates from DTSTART as before.
 */
function iterationStart(event: IcalEvent, beforeMs: number, localTz: string): IterationStart {
  try {
    const master = event.component;
    if (master.hasProperty('rdate')) return { kind: 'dtstart' };
    const rrules = master.getAllProperties('rrule');
    if (rrules.length !== 1) return { kind: 'dtstart' };
    const recur = rrules[0]!.getFirstValue() as unknown as {
      freq?: string;
      interval?: number;
      count?: number | null;
      until?: IcalTime | null;
      parts?: Record<string, unknown[]>;
    };
    const freq = String(recur.freq ?? '').toUpperCase();
    if (!FAST_FORWARD_FREQS.has(freq) || recur.count) return { kind: 'dtstart' };
    const interval = Number.isInteger(recur.interval) && (recur.interval as number) > 0 ? (recur.interval as number) : 1;
    const start = event.startDate;
    for (const [part, values] of Object.entries(recur.parts ?? {})) {
      if (!Array.isArray(values) || values.length === 0) continue;
      if (freq !== 'WEEKLY' || part.toUpperCase() !== 'BYDAY') return { kind: 'dtstart' };
      // Plain weekdays only (no ordinals), and DTSTART's own weekday must be one of them.
      const days = values.map((v) => String(v).toUpperCase());
      if (days.some((d) => !(WEEKDAY_CODES as readonly string[]).includes(d))) return { kind: 'dtstart' };
      if (!days.includes(WEEKDAY_CODES[start.dayOfWeek() - 1]!)) return { kind: 'dtstart' };
    }
    const periodMs = (freq === 'DAILY' ? interval : 7 * interval) * DAY_MS;
    const startMs = momentOf(start, localTz).ms;
    const periods = Math.floor((beforeMs - startMs) / periodMs) - 1;
    if (periods < 2) return { kind: 'dtstart' };
    const aligned = start.clone();
    aligned.adjust(periods * (periodMs / DAY_MS), 0, 0, 0);
    // ical.js always yields its start as the first occurrence, even past UNTIL.
    if (recur.until && aligned.compare(recur.until) > 0) return { kind: 'ended' };
    return { kind: 'aligned', start: aligned };
  } catch {
    return { kind: 'dtstart' };
  }
}

function freqOf(event: IcalEvent): string | null {
  try {
    const rrule = event.component.getFirstPropertyValue('rrule');
    if (rrule && typeof rrule === 'object' && 'freq' in rrule) return String((rrule as { freq: unknown }).freq).toUpperCase();
  } catch {
    // malformed RRULE: handled by the iterator
  }
  return null;
}

function emitSingle(
  collector: Collector,
  comp: IcalComponent,
  uid: string,
  etag: string | null,
  resolved: Map<string, string | null>,
  job: ExpandJob,
  recurring: boolean,
  instanceKey: string | null,
): void {
  const event = new ICAL.Event(comp);
  const occ = occurrence(event.startDate, event.endDate, job.localTz);
  if (!overlaps(occ, job.window)) return;
  const fields = baseFields(comp, uid, etag, resolved);
  if (recurring && fields.status === 'cancelled') return;
  collector.push({
    ...fields,
    instanceKey,
    start: occ.start.value,
    end: occ.end.value,
    allDay: occ.start.allDay,
    recurring,
    seriesId: recurring ? uid : null,
  });
}

function expandMaster(
  collector: Collector,
  master: IcalComponent,
  exceptions: IcalComponent[],
  uid: string,
  etag: string | null,
  resolved: Map<string, string | null>,
  job: ExpandJob,
): void {
  const event = new ICAL.Event(master, { strictExceptions: false });
  for (const exception of exceptions) {
    try {
      event.relateException(exception);
    } catch {
      // An exception that cannot be related is ignored.
    }
  }

  if (!event.isRecurring()) {
    emitSingle(collector, master, uid, etag, resolved, job, false, null);
    return;
  }

  const freq = freqOf(event);
  if (freq === 'SECONDLY' || freq === 'MINUTELY') {
    // Not expanded (§4.9): the first instance only, marked recurring.
    collector.truncated++;
    emitSingle(collector, master, uid, etag, resolved, job, true, recurrenceKey(event.startDate, job.localTz));
    return;
  }

  const { limits } = collector;
  const w = job.window;
  const emitted = new Set<string>();
  let steps = 0;
  let inWindow = 0;
  let truncated = false;
  /** Original start (ms) of the last occurrence handled before a truncation. */
  let reachedMs = Number.NEGATIVE_INFINITY;
  // Occurrences that end well before the window need no details (half the cost of a step): an
  // override that moves one of them into the window is picked up with the overrides below.
  const skipBeforeMs = w.fromMs - durationMs(event) - 2 * DAY_MS;
  const from: IterationStart = job.fastForward === false ? { kind: 'dtstart' } : iterationStart(event, skipBeforeMs, job.localTz);
  const iterator = from.kind === 'aligned' ? event.iterator(from.start) : event.iterator();
  for (;;) {
    if (from.kind === 'ended') break;
    let next: IcalTime | undefined;
    try {
      next = iterator.next() ?? undefined;
    } catch {
      break; // ical.js gives up on impossible rules ("max tries"); keep what we have.
    }
    if (!next) break;
    if (++steps > limits.maxStepsPerEvent) {
      truncated = true; // per-event limit: keep the instances found so far
      break;
    }
    const original = momentOf(next, job.localTz);
    if (original.allDay ? original.value >= w.toDate : original.ms >= w.toMs) break;
    if (original.ms < skipBeforeMs) {
      reachedMs = original.ms;
      continue;
    }
    if (!emitOccurrence(next)) {
      truncated = true; // per-event limit: the first instances in the window are kept
      break;
    }
    reachedMs = original.ms;
  }
  if (truncated) collector.truncated++;

  // RFC 5545: DTSTART is always the first instance of the recurrence set, but ical.js does not
  // yield it when the set is RDATE-only (no RRULE). Add it unless an EXDATE removes it.
  if (!truncated && !master.hasProperty('rrule')) {
    const key = recurrenceKey(event.startDate, job.localTz);
    if (!emitted.has(key) && !isExcluded(master, key, job.localTz)) emitOccurrence(event.startDate);
  }

  /** Emits one occurrence; false (nothing emitted) once the event's in-window limit is reached. */
  function emitOccurrence(next: IcalTime): boolean {
    const details = event.getOccurrenceDetails(next);
    const key = recurrenceKey(details.recurrenceId, job.localTz);
    const item = details.item ?? event;
    const occ = occurrence(details.startDate, details.endDate, job.localTz);
    if (!overlaps(occ, w)) {
      emitted.add(key);
      return true;
    }
    const fields = baseFields(item.component, uid, etag, resolved);
    if (fields.status === 'cancelled' && item !== event) {
      emitted.add(key);
      return true; // cancelled single occurrence
    }
    if (inWindow >= limits.maxInstancesPerEvent) return false;
    inWindow++;
    emitted.add(key);
    collector.push({
      ...fields,
      instanceKey: key,
      start: occ.start.value,
      end: occ.end.value,
      allDay: occ.start.allDay,
      recurring: true,
      seriesId: uid,
    });
    return true;
  }

  // Overrides moved into the window from an occurrence outside it. After a truncation only those
  // whose original occurrence came before the cut: the rest of the series is not shown.
  for (const exception of exceptions) {
    try {
      const recurrenceId = exception.getFirstPropertyValue('recurrence-id');
      if (!(recurrenceId instanceof ICAL.Time)) continue;
      const key = recurrenceKey(recurrenceId, job.localTz);
      if (emitted.has(key)) continue;
      if (truncated && momentOf(recurrenceId, job.localTz).ms > reachedMs) continue;
      emitted.add(key);
      emitSingle(collector, exception, uid, etag, resolved, job, true, key);
    } catch {
      // ignore malformed overrides
    }
  }
}

/** True when an EXDATE of `master` removes the occurrence whose recurrence key is `key`. */
function isExcluded(master: IcalComponent, key: string, localTz: string): boolean {
  for (const prop of master.getAllProperties('exdate')) {
    try {
      for (const value of prop.getValues()) {
        if (value instanceof ICAL.Time && recurrenceKey(value, localTz) === key) return true;
      }
    } catch {
      // ignore malformed EXDATEs
    }
  }
  return false;
}

function toRoots(parsed: unknown): IcalComponent[] {
  const list = Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed] : Array.isArray(parsed) ? parsed : [];
  return list.map((jcal) => new ICAL.Component(jcal as unknown[]));
}

const VEVENT_REGEX = /^BEGIN:VEVENT\s*$/gim;
const MAX_TEXT_BYTES = 12 * 1024 * 1024;

/** Parses and expands every source into event instances within the window. */
export function expandCalendar(job: ExpandJob): ExpandResult {
  const limits: ExpandLimits = { ...DEFAULT_LIMITS, ...job.limits };
  try {
    ICAL.TimezoneService.reset();

    // Cheap pre-check before parsing: a hostile feed with 100k VEVENTs never reaches ical.js.
    let vevents = 0;
    for (const source of job.sources) {
      if (typeof source.data !== 'string' || source.data.length > MAX_TEXT_BYTES) {
        throw new ExpandError('limit', 'The calendar data is too large');
      }
      vevents += source.data.match(VEVENT_REGEX)?.length ?? 0;
      if (vevents > limits.maxVevents) {
        throw new ExpandError('limit', `The calendar has more than ${limits.maxVevents.toLocaleString('en-US')} events`);
      }
    }

    const parsedSources: { roots: IcalComponent[]; etag: string | null }[] = [];
    for (const source of job.sources) {
      let roots: IcalComponent[];
      try {
        roots = toRoots(ICAL.parse(source.data));
      } catch {
        throw new ExpandError('invalid', 'The data is not a valid iCalendar file');
      }
      if (roots.length === 0 || roots.some((r) => r.name !== 'vcalendar')) {
        throw new ExpandError('invalid', 'The data is not an iCalendar calendar');
      }
      parsedSources.push({ roots, etag: typeof source.etag === 'string' ? source.etag : null });
    }

    const allRoots = parsedSources.flatMap((s) => s.roots);
    const allVevents = allRoots.flatMap((root) => root.getAllSubcomponents('vevent'));
    if (allVevents.length > limits.maxVevents) {
      throw new ExpandError('limit', `The calendar has more than ${limits.maxVevents.toLocaleString('en-US')} events`);
    }
    const resolved = registerTimezones(allRoots, allVevents);

    const collector = new Collector(limits);
    let skipped = 0;
    for (const source of parsedSources) {
      // Group by UID within the source (a CalDAV object or a whole ICS feed).
      const groups = new Map<string, { master: IcalComponent | null; exceptions: IcalComponent[] }>();
      for (const root of source.roots) {
        for (const vevent of root.getAllSubcomponents('vevent')) {
          const uid = uidOf(vevent);
          let group = groups.get(uid);
          if (!group) {
            group = { master: null, exceptions: [] };
            groups.set(uid, group);
          }
          if (vevent.hasProperty('recurrence-id')) group.exceptions.push(vevent);
          else if (group.master === null) group.master = vevent;
        }
      }
      for (const [uid, group] of groups) {
        try {
          if (group.master) {
            expandMaster(collector, group.master, group.exceptions, uid, source.etag, resolved, job);
          } else {
            // Overrides without their master: each is a standalone instance.
            for (const exception of group.exceptions) {
              const recurrenceId = exception.getFirstPropertyValue('recurrence-id');
              const key = recurrenceId instanceof ICAL.Time ? recurrenceKey(recurrenceId, job.localTz) : null;
              emitSingle(collector, exception, uid, source.etag, resolved, job, true, key);
            }
          }
        } catch (err) {
          if (err instanceof ExpandError) throw err;
          skipped++; // one malformed event never breaks the feed
        }
      }
    }

    const first = allRoots[0];
    const name = first ? stringProp(first, 'x-wr-calname') : null;
    const color = first ? (stringProp(first, 'x-apple-calendar-color') ?? stringProp(first, 'color')) : null;
    return {
      ok: true,
      events: collector.events,
      vevents: allVevents.length,
      name,
      color,
      skipped,
      truncated: collector.truncated,
      descriptionsDropped: collector.descriptionsDropped,
    };
  } catch (err) {
    if (err instanceof ExpandError) return { ok: false, reason: err.reason, message: err.message };
    return { ok: false, reason: 'error', message: 'The calendar data could not be read' };
  } finally {
    try {
      ICAL.TimezoneService.reset();
    } catch {
      // ignore
    }
  }
}
