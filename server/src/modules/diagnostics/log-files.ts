/**
 * Reading the log files (`GET /api/diagnostics/logs?scope=files`, the report; §17): `server.log`
 * and its rotations `.1`…`.5` (or `supervisor.log`, `launcher.log`), newest line first.
 *
 * - Every file is opened before the first read: the descriptors pin them, so a rotation during
 *   the scan cannot make a file be read twice or skipped.
 * - Read backwards in 64 KB chunks with `fs.promises`, yielding to the event loop between chunks;
 *   the scan stops once the caller has enough lines or after 20 MB. A line longer than 1 MB is
 *   skipped.
 * - Lines are JSON Lines records (`{t, lvl, msg, src?, area, tags, rid?, tEvent?, ...fields}`, the
 *   logger's file format) or, from before it, text lines `<ISO> <LEVEL> <message> {json}` (read
 *   best-effort, area `server`); anything else is skipped. Every record is scrubbed again
 *   (`scrubFields`, `scrub`, this PC's home directory): the files may predate the current rules.
 */
import fs from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  LOG_LEVEL_ORDER,
  LOG_LEVELS,
  LOG_SOURCES,
  type LogLevel,
  type LogSource,
} from '@homebase/shared';
import { levelForFilter, scrubText, scrubValue, type LogRecordOut } from '../../lib/logger.ts';
import { isoOrNull } from './summary.ts';

export const LOG_FILE_CHUNK_BYTES = 64 * 1024;
/** At most this much is read per scan (all files together). */
export const LOG_FILE_SCAN_BYTES = 20 * 1024 * 1024;
/** Rotated files next to the live one (`.1` … `.5`, the logger's `keep`). */
export const ROTATED_LOG_FILES = 5;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_MESSAGE = 500;
const NEWLINE = 0x0a;
const AREA_VALUE = /^[a-z0-9_.:-]{1,32}$/;
/** `2026-10-11T09:15:02.123Z INFO  message {"json":1}` (the console/old file format). */
const TEXT_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (DEBUG|INFO|WARN|ERROR) +(.*)$/;

/** `file`, then `file.1` … `file.<rotated>` (newest first). */
export function logFileCandidates(file: string, rotated = ROTATED_LOG_FILES): string[] {
  const out = [file];
  for (let i = 1; i <= rotated; i++) out.push(`${file}.${i}`);
  return out;
}

export interface ScanOptions {
  /** Default {@link LOG_FILE_SCAN_BYTES}. */
  maxBytes?: number;
  /** Default {@link LOG_FILE_CHUNK_BYTES}. */
  chunkBytes?: number;
}

export interface ScanResult {
  /** False when the byte budget ran out before the start of the oldest file. */
  complete: boolean;
  /** At least one of the files exists. */
  found: boolean;
}

async function readFully(handle: fs.promises.FileHandle, buffer: Buffer, position: number): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

function lineText(parts: readonly Buffer[]): string {
  const text = (parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts)).toString('utf8');
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * Calls `onLine` with every non-empty line of `files` (each newest line first, files in the order
 * given) until it returns false, the files end or the byte budget runs out. Files that do not
 * exist are skipped; read errors end that file.
 */
export async function scanLinesBackwards(
  files: readonly string[],
  onLine: (line: string) => boolean,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? LOG_FILE_CHUNK_BYTES));
  let budget = Math.max(0, Math.floor(options.maxBytes ?? LOG_FILE_SCAN_BYTES));
  const handles: { handle: fs.promises.FileHandle; size: number }[] = [];
  try {
    // Open (and size) every file first: the descriptors pin them against a rotation mid-scan.
    for (const file of files) {
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(file, 'r');
      } catch {
        continue;
      }
      try {
        handles.push({ handle, size: (await handle.stat()).size });
      } catch {
        await handle.close().catch(() => {});
      }
    }

    for (const { handle, size } of handles) {
      let position = size;
      /** The end of a line whose start lies before `position` (later chunks first in the list). */
      let carry: Buffer[] = [];
      let carryBytes = 0;
      /** Inside a line longer than MAX_LINE_BYTES: drop bytes until its start. */
      let skipping = false;
      try {
        while (position > 0) {
          if (budget <= 0) return { complete: false, found: true };
          const length = Math.min(chunkBytes, position, budget);
          position -= length;
          budget -= length;
          const chunk = Buffer.allocUnsafe(length);
          const read = await readFully(handle, chunk, position);
          let end = read;
          for (let i = read - 1; i >= 0; i--) {
            if (chunk[i] !== NEWLINE) continue;
            if (!skipping && end - (i + 1) + carryBytes <= MAX_LINE_BYTES) {
              const text = lineText([chunk.subarray(i + 1, end), ...carry]);
              if (text.trim() !== '' && !onLine(text)) return { complete: true, found: true };
            }
            skipping = false;
            carry = [];
            carryBytes = 0;
            end = i;
          }
          if (end > 0 && !skipping) {
            carry.unshift(chunk.subarray(0, end));
            carryBytes += end;
            if (carryBytes > MAX_LINE_BYTES) {
              carry = [];
              carryBytes = 0;
              skipping = true;
            }
          }
          await yieldToEventLoop();
        }
        if (!skipping && carryBytes > 0) {
          const text = lineText(carry);
          if (text.trim() !== '' && !onLine(text)) return { complete: true, found: true };
        }
      } catch {
        // An unreadable file ends here; older files are still read.
      }
    }
    return { complete: true, found: handles.length > 0 };
  } finally {
    await Promise.all(handles.map(({ handle }) => handle.close().catch(() => {})));
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Free text from a file, scrubbed again (home directory, secret patterns, user paths). */
export function rescrubText(text: string, max = MAX_MESSAGE): string {
  return cap(scrubText(text.length > max * 8 ? text.slice(0, max * 8) : text), max);
}

/** Fields read from a file, scrubbed again (`scrubValue`: home directory, `scrubFields`, unsafe characters). */
export function rescrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(fields);
  return scrubbed !== null && typeof scrubbed === 'object' && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A file time → normalized ISO text (null when unparseable or outside 1970…9999). */
function fileTime(value: unknown): string | null {
  return typeof value === 'string' ? isoOrNull(Date.parse(value)) : null;
}

function asLevel(value: unknown): LogLevel | null {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : null;
}

function asSource(value: unknown): LogSource {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value) ? (value as LogSource) : 'server';
}

function asArea(value: unknown): string | null {
  return typeof value === 'string' && AREA_VALUE.test(value) ? value : null;
}

/** A parsed line before its message and fields are scrubbed (filters that need neither run first). */
export interface ParsedLine {
  head: Omit<LogRecordOut, 'msg' | 'fields'>;
  /** The level the level filter compares (`levelForFilter`: a collapsed warning's repeats count as warnings). */
  filterLevel: LogLevel;
  /** The record, message and fields scrubbed again. */
  record(): LogRecordOut;
}

function jsonLine(line: string): ParsedLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { t, lvl, msg, src, area, tags, rid, tEvent, ...rest } = value;
  const time = fileTime(t);
  const level = asLevel(lvl);
  if (time === null || level === null || typeof msg !== 'string') return null;
  const primary = asArea(area) ?? 'server';
  const tagList = Array.isArray(tags) ? [...new Set(tags.map(asArea).filter((tag): tag is string => tag !== null))] : [];
  const head: ParsedLine['head'] = {
    seq: 0,
    t: time,
    tEvent: fileTime(tEvent),
    level,
    src: asSource(src),
    area: primary,
    tags: tagList.length > 0 ? tagList : [primary],
    rid: typeof rid === 'string' && rid !== '' ? cap(rescrubText(rid, 64), 64) : null,
  };
  return { head, filterLevel: levelForFilter(level, rest), record: () => ({ ...head, msg: rescrubText(msg), fields: rescrubFields(rest) }) };
}

/** `<ISO> <LEVEL> <message> {json}`: the JSON is the first ` {` suffix that parses as an object. */
function textLine(line: string): ParsedLine | null {
  const m = TEXT_LINE.exec(line);
  if (!m) return null;
  const time = fileTime(m[1]);
  const level = asLevel((m[2] ?? '').toLowerCase());
  if (time === null || level === null) return null;
  const head: ParsedLine['head'] = { seq: 0, t: time, tEvent: null, level, src: 'server', area: 'server', tags: ['server'], rid: null };
  const body = m[3] ?? '';
  return {
    head,
    filterLevel: level,
    record: () => {
      let msg = body;
      let fields: Record<string, unknown> = {};
      for (let i = body.indexOf(' {'); i !== -1; i = body.indexOf(' {', i + 1)) {
        try {
          const parsed: unknown = JSON.parse(body.slice(i + 1));
          if (isRecord(parsed)) {
            msg = body.slice(0, i);
            fields = parsed;
            break;
          }
        } catch {
          // Not the JSON part yet.
        }
      }
      return { ...head, msg: rescrubText(msg), fields: rescrubFields(fields) };
    },
  };
}

/** A log file line, parsed but not yet scrubbed; null for lines that are neither format. */
export function parseLine(line: string): ParsedLine | null {
  const text = line.trim();
  return text.startsWith('{') ? jsonLine(text) : textLine(text);
}

/** A log file line as a record (`seq` 0, scrubbed again), or null for lines that are neither format. */
export function parseLogLine(line: string): LogRecordOut | null {
  return parseLine(line)?.record() ?? null;
}

// ---------------------------------------------------------------------------
// Filtering and reading
// ---------------------------------------------------------------------------

/** Filters of a log query, resolved (epoch-ms window, field equalities). */
export interface RecordFilter {
  since?: number;
  before?: number;
  level: LogLevel;
  /** Matches any tag. */
  area?: string;
  /** A second area every match must also carry (a health key's area next to an explicit one). */
  alsoArea?: string;
  src?: LogSource;
  rid?: string;
  fieldEquals: Record<string, string>;
  /** Case-insensitive substring of the message or the JSON of the fields. */
  q?: string;
}

/** The filters a record's head can decide: time window, level, areas, source, request id. */
function headMatches(head: ParsedLine['head'], filter: RecordFilter, level: LogLevel = head.level): boolean {
  const ms = Date.parse(head.t);
  if (filter.since !== undefined && ms < filter.since) return false;
  if (filter.before !== undefined && ms >= filter.before) return false;
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[filter.level]) return false;
  if (filter.area !== undefined && !head.tags.includes(filter.area)) return false;
  if (filter.alsoArea !== undefined && !head.tags.includes(filter.alsoArea)) return false;
  if (filter.src !== undefined && head.src !== filter.src) return false;
  return filter.rid === undefined || head.rid === filter.rid;
}

/**
 * The same matching as the log hub's `query()` (lib/logger.ts), on the scrubbed record: a text
 * search never finds what scrubbing removed.
 */
export function recordMatches(rec: LogRecordOut, filter: RecordFilter): boolean {
  if (!headMatches(rec, filter, levelForFilter(rec.level, rec.fields))) return false;
  for (const [k, v] of Object.entries(filter.fieldEquals)) {
    const actual = k === 'rid' || k === 'area' || k === 'src' ? rec[k] : rec.fields[k];
    if (!(actual === v || (typeof actual === 'number' && String(actual) === v))) return false;
  }
  if (filter.q !== undefined && filter.q !== '') {
    const needle = filter.q.toLowerCase();
    if (!rec.msg.toLowerCase().includes(needle) && !JSON.stringify(rec.fields).toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** Records further back than this before `since` end a scan (files are in time order; clocks may step back a little). */
const SINCE_SLACK_MS = 10 * 60 * 1000;

export interface FileRecords {
  /** Oldest first. */
  records: LogRecordOut[];
  /** More matches may exist further back (limit reached or the byte budget ran out). */
  truncated: boolean;
}

/** The newest `limit` matching records of `file` and its rotations, oldest first. */
export async function readLogRecords(file: string, filter: RecordFilter, limit: number, options: ScanOptions = {}): Promise<FileRecords> {
  const newestFirst: LogRecordOut[] = [];
  let more = false;
  const scan = await scanLinesBackwards(
    logFileCandidates(file),
    (line) => {
      const parsed = parseLine(line);
      if (parsed === null) return true;
      if (filter.since !== undefined && Date.parse(parsed.head.t) < filter.since - SINCE_SLACK_MS) return false;
      // Scrubbing is the expensive part: only for lines the cheap filters let through.
      if (!headMatches(parsed.head, filter, parsed.filterLevel)) return true;
      const rec = parsed.record();
      if (!recordMatches(rec, filter)) return true;
      if (newestFirst.length === limit) {
        more = true;
        return false;
      }
      newestFirst.push(rec);
      return true;
    },
    options,
  );
  return { records: newestFirst.reverse(), truncated: more || !scan.complete };
}

/** The last `limit` raw lines of `file` and its rotations (scrubbed, ≤ 500 characters), oldest first; null when none exists. */
export async function readRawTail(file: string, limit: number, rotated: number, options: ScanOptions = {}): Promise<string[] | null> {
  const newestFirst: string[] = [];
  const scan = await scanLinesBackwards(
    logFileCandidates(file, rotated),
    (line) => {
      newestFirst.push(rescrubText(line));
      return newestFirst.length < limit;
    },
    options,
  );
  return scan.found ? newestFirst.reverse() : null;
}
