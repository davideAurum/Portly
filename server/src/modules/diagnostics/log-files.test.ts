import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogRecordSchema } from '@portly/shared';
import { newId } from '../../lib/ids.ts';
import { writeLines } from './__fixtures__/setup.ts';
import { logFileCandidates, parseLogLine, readLogRecords, readRawTail, scanLinesBackwards, type RecordFilter } from './log-files.ts';

const ALL: RecordFilter = { level: 'debug', fieldEquals: {} };

function jsonLine(t: string, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ t, lvl: 'info', msg, area: 'calendar', tags: ['calendar'], ...extra });
}

describe('log files', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `portly-logfiles-${newId()}`);
    file = path.join(dir, 'server.log');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('scanLinesBackwards', () => {
    it('yields lines newest first across chunk boundaries, then the rotated files', async () => {
      writeLines(file, ['line 3', 'a much longer line number four that spans chunks', 'line 5']);
      writeLines(`${file}.1`, ['line 1', 'line 2']);
      for (const chunkBytes of [1, 3, 7, 64 * 1024]) {
        const lines: string[] = [];
        const result = await scanLinesBackwards(logFileCandidates(file), (l) => (lines.push(l), true), { chunkBytes });
        expect(lines, `chunk ${chunkBytes}`).toEqual(['line 5', 'a much longer line number four that spans chunks', 'line 3', 'line 2', 'line 1']);
        expect(result).toEqual({ complete: true, found: true });
      }
    });

    it('keeps multi-byte characters whole, drops CRs and blank lines, reads a file without a final newline', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, 'ünïcödé ✓\r\n\n\nlast without newline', 'utf8');
      const lines: string[] = [];
      await scanLinesBackwards([file], (l) => (lines.push(l), true), { chunkBytes: 2 });
      expect(lines).toEqual(['last without newline', 'ünïcödé ✓']);
    });

    it('stops when the callback says so, at the byte budget, and skips missing files', async () => {
      writeLines(file, ['a', 'b', 'c', 'd']);
      const lines: string[] = [];
      expect(await scanLinesBackwards([path.join(dir, 'missing.log'), file], (l) => (lines.push(l), lines.length < 2))).toEqual({ complete: true, found: true });
      expect(lines).toEqual(['d', 'c']);

      const budgeted: string[] = [];
      // 5 of 8 bytes: `c\nd\n` and the newline before `c` (a line counts once its start is read).
      const result = await scanLinesBackwards([file], (l) => (budgeted.push(l), true), { maxBytes: 5, chunkBytes: 2 });
      expect(result.complete).toBe(false);
      expect(budgeted).toEqual(['d', 'c']);
      const short: string[] = [];
      await scanLinesBackwards([file], (l) => (short.push(l), true), { maxBytes: 4, chunkBytes: 2 });
      expect(short).toEqual(['d']);

      expect(await scanLinesBackwards([path.join(dir, 'none.log')], () => true)).toEqual({ complete: true, found: false });
    });

    it('skips a line longer than 1 MB and goes on with the lines before it', async () => {
      writeLines(file, ['before', 'x'.repeat(1024 * 1024 + 10), 'after']);
      const lines: string[] = [];
      await scanLinesBackwards([file], (l) => (lines.push(l), true));
      expect(lines.map((l) => l.slice(0, 20))).toEqual(['after', 'before']);
    });
  });

  describe('parseLogLine', () => {
    it('reads a JSON Lines record: lifted keys out, fields re-scrubbed, seq 0', () => {
      // Not this PC's home: the generic user-path rule is under test (a home of C:\Users\riley is masked whole, first).
      vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\someone');
      const rec = parseLogLine(
        JSON.stringify({
          t: '2026-10-11T09:00:00.000Z',
          lvl: 'warn',
          msg: 'calendar failing at C:\\Users\\riley\\AppData',
          src: 'client',
          area: 'client',
          tags: ['client', 'BAD AREA'],
          rid: 'abcdefghij',
          tEvent: '2026-10-11T08:59:59.000Z',
          accountId: 'g1',
          access_token: 'ya29.secret-value',
          url: 'https://example.com/path?token=abc',
        }),
      );
      expect(rec).toEqual({
        seq: 0,
        t: '2026-10-11T09:00:00.000Z',
        tEvent: '2026-10-11T08:59:59.000Z',
        level: 'warn',
        msg: 'calendar failing at C:\\Users\\~\\AppData',
        src: 'client',
        area: 'client',
        tags: ['client'],
        rid: 'abcdefghij',
        fields: { accountId: 'g1', access_token: '[REDACTED]', url: 'https://example.com/…' },
      });
      expect(LogRecordSchema.parse(rec)).toEqual(rec);
    });

    it('reads a text line of the old format best-effort (area server)', () => {
      expect(parseLogLine('2026-09-01T10:00:00.000Z INFO  request {"method":"GET","path":"/api/x","status":200}')).toEqual({
        seq: 0,
        t: '2026-09-01T10:00:00.000Z',
        tEvent: null,
        level: 'info',
        msg: 'request',
        src: 'server',
        area: 'server',
        tags: ['server'],
        rid: null,
        fields: { method: 'GET', path: '/api/x', status: 200 },
      });
      const plain = parseLogLine('2026-09-01T10:00:00Z WARN  token refresh failed with Bearer abc.def.ghi {not json');
      expect(plain).toMatchObject({ level: 'warn', msg: 'token refresh failed with Bearer [REDACTED] {not json', fields: {} });
      expect(LogRecordSchema.parse(plain)).toEqual(plain);
    });

    it('skips lines that are neither format or lack the record keys', () => {
      for (const line of ['', 'random text', '{"t":"2026-10-11T09:00:00.000Z","lvl":"loud","msg":"x"}', '{"lvl":"info","msg":"x"}', '{broken', '[1,2]', '2026-13-45T99:00:00Z INFO x']) {
        expect(parseLogLine(line), line).toBeNull();
      }
    });

    it('drops a tEvent no ISO form can hold, defaults src/area/tags', () => {
      const rec = parseLogLine('{"t":"2026-10-11T09:00:00.000Z","lvl":"debug","msg":"x","tEvent":"+275760-09-13T00:00:00.000Z","area":"NOT VALID"}');
      expect(rec).toMatchObject({ tEvent: null, src: 'server', area: 'server', tags: ['server'], rid: null });
    });
  });

  describe('readLogRecords', () => {
    const lines = [
      jsonLine('2026-10-11T08:00:00.000Z', 'old one', { accountId: 'a1' }),
      jsonLine('2026-10-11T09:00:00.000Z', 'matching one', { accountId: 'a1' }),
      jsonLine('2026-10-11T09:30:00.000Z', 'other account', { accountId: 'a2' }),
      'garbage line',
      jsonLine('2026-10-11T10:00:00.000Z', 'matching two', { accountId: 'a1', lvl: 'warn' }),
    ];

    it('returns the newest matches oldest first, flags truncation at the limit', async () => {
      writeLines(`${file}.1`, lines.slice(0, 2));
      writeLines(file, lines.slice(2));
      const all = await readLogRecords(file, { ...ALL, fieldEquals: { accountId: 'a1' } }, 10);
      expect(all.records.map((r) => r.msg)).toEqual(['old one', 'matching one', 'matching two']);
      expect(all.truncated).toBe(false);
      const two = await readLogRecords(file, { ...ALL, fieldEquals: { accountId: 'a1' } }, 2);
      expect(two.records.map((r) => r.msg)).toEqual(['matching one', 'matching two']);
      expect(two.truncated).toBe(true);
      const warn = await readLogRecords(file, { ...ALL, level: 'warn' }, 10);
      expect(warn.records.map((r) => r.msg)).toEqual(['matching two']);
      expect((await readLogRecords(file, { ...ALL, q: 'OTHER' }, 10)).records.map((r) => r.msg)).toEqual(['other account']);
      expect((await readLogRecords(file, { ...ALL, area: 'mail' }, 10)).records).toEqual([]);
    });

    it('a level filter sees the collapsed repeats of a warning (repeatOf) as warnings', async () => {
      writeLines(file, [
        jsonLine('2026-10-11T09:00:00.000Z', 'feed failed', { lvl: 'warn' }),
        jsonLine('2026-10-11T09:01:00.000Z', 'feed failed', { lvl: 'debug', repeats: 1, repeatOf: 'warn' }),
        jsonLine('2026-10-11T09:30:00.000Z', 'repeated', { count: 1, repeatOf: 'warn', repeatMsg: 'feed failed' }),
        jsonLine('2026-10-11T09:31:00.000Z', 'repeated', { count: 4 }),
        jsonLine('2026-10-11T09:32:00.000Z', 'odd', { lvl: 'error', repeatOf: 'warn' }),
      ]);
      const warn = await readLogRecords(file, { ...ALL, level: 'warn' }, 10);
      expect(warn.records.map((r) => [r.level, r.msg])).toEqual([
        ['warn', 'feed failed'],
        ['debug', 'feed failed'],
        ['info', 'repeated'],
        ['error', 'odd'],
      ]);
      expect((await readLogRecords(file, { ...ALL, level: 'error' }, 10)).records.map((r) => r.msg)).toEqual(['odd']);
    });

    it('honours the time window and stops scanning well before `since`', async () => {
      writeLines(file, lines);
      const since = Date.parse('2026-10-11T09:00:00.000Z');
      const before = Date.parse('2026-10-11T10:00:00.000Z');
      const res = await readLogRecords(file, { ...ALL, since, before }, 10);
      expect(res.records.map((r) => r.msg)).toEqual(['matching one', 'other account']);
      expect(res.truncated).toBe(false);
    });

    it('is empty when no log file exists yet', async () => {
      expect(await readLogRecords(file, ALL, 10)).toEqual({ records: [], truncated: false });
    });
  });

  describe('readRawTail', () => {
    it('returns the last lines scrubbed, oldest first, or null without a file', async () => {
      // Not this PC's home: the generic user-path rule is under test (a home of C:\Users\riley is masked whole, first).
      vi.spyOn(os, 'homedir').mockReturnValue('D:\\Profiles\\someone');
      const launcher = path.join(dir, 'launcher.log');
      expect(await readRawTail(launcher, 2, 1)).toBeNull();
      writeLines(`${launcher}.1`, ['first']);
      writeLines(launcher, ['second password=hunter2', 'third C:\\Users\\riley\\x']);
      expect(await readRawTail(launcher, 2, 1)).toEqual(['second password=[REDACTED]', 'third C:\\Users\\~\\x']);
      expect(await readRawTail(launcher, 10, 1)).toEqual(['first', 'second password=[REDACTED]', 'third C:\\Users\\~\\x']);
    });
  });
});
