/**
 * Reading the synced file and its icons (design section 8): a valid file round-trips; hostile,
 * oversized, newer, broken and badly stamped files are refused with a problem code; icon bytes are
 * sniffed, capped and checked against their SHA-256.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SYNC_GROUPS, normalizeLaunchpad, serializeSyncFile, type SyncIcon } from '@portly/shared';
import { PNG_BYTES } from '../test/harness.ts';
import { ICON_ID, T, bytesOf, deeplyNested, group, sampleLaunchpad, sampleRaw } from './__fixtures__/launchpads.ts';
import { MAX_SYNC_FILE_BYTES, MAX_SYNC_ICON_BYTES, checkSyncIcon, readSyncFile, sha256Hex } from './format.ts';

const NOW = T + 60_000;
const read = (raw: unknown) => readSyncFile(bytesOf(typeof raw === 'string' ? raw : JSON.stringify(raw)), NOW);
const problemOf = (raw: unknown) => {
  const result = read(raw);
  return result.ok ? 'ok' : result.problem;
};

describe('readSyncFile', () => {
  it('reads a valid file back as the same launch pad, with or without a BOM', () => {
    const sample = sampleLaunchpad();
    const result = read(serializeSyncFile(sample));
    expect(result).toEqual({ ok: true, doc: normalizeLaunchpad(sample) });
    expect(read(`﻿${serializeSyncFile(sample)}`).ok).toBe(true);
  });

  it('refuses a file over 25 MB before reading it', () => {
    expect(readSyncFile(new Uint8Array(MAX_SYNC_FILE_BYTES + 1), NOW)).toEqual({ ok: false, problem: 'too_large' });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['bytes that are not UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ])('refuses %s', (_what, input) => {
    const bytes = typeof input === 'string' ? bytesOf(input) : input;
    expect(readSyncFile(bytes, NOW)).toEqual({ ok: false, problem: 'not_json' });
  });

  it('refuses prototype keys and deep nesting anywhere', () => {
    const raw = sampleRaw();
    expect(problemOf(JSON.stringify(raw).replace('"title":"Mail"', '"title":"Mail","__proto__":{"polluted":true}'))).toBe('unsafe_json');
    expect(problemOf(JSON.stringify(raw).replace('"name":"Work"', '"name":"Work","constructor":1'))).toBe('unsafe_json');
    expect(problemOf(deeplyNested(70))).toBe('unsafe_json');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses other files: an export, another format, no format', () => {
    expect(problemOf({ format: 'portly-export', version: 1, data: {} })).toBe('not_sync_file');
    expect(problemOf({ ...sampleRaw(), format: 'something-else' })).toBe('not_sync_file');
    expect(problemOf([1, 2, 3])).toBe('not_sync_file');
  });

  it('stops at a file from a newer Portly instead of calling it broken', () => {
    expect(problemOf({ ...sampleRaw(), version: 2, groups: 'a shape this build does not know' })).toBe('newer_version');
    expect(problemOf({ ...sampleRaw(), version: 0 })).toBe('invalid');
  });

  it.each([
    ['a javascript: address', (raw: Record<string, unknown>) => ((raw.bookmarks as { url: string }[])[0]!.url = 'javascript:alert(1)')],
    ['an address with credentials', (raw: Record<string, unknown>) => ((raw.bookmarks as { url: string }[])[0]!.url = 'https://user:pw@mail.example/')],
    ['an icon id that is a path', (raw: Record<string, unknown>) => ((raw.icons as { id: string }[])[0]!.id = '../launchpad.json')],
    ['an icon id that is not a UUIDv4', (raw: Record<string, unknown>) => ((raw.icons as { id: string }[])[0]!.id = ICON_ID.replace('-4c11-', '-1c11-'))],
    ['an icon id on an automatic icon', (raw: Record<string, unknown>) => ((raw.bookmarks as { iconId: string | null }[])[0]!.iconId = ICON_ID)],
    ['a group name too long', (raw: Record<string, unknown>) => ((raw.groups as { name: string }[])[0]!.name = 'x'.repeat(101))],
    ['a fractional sort', (raw: Record<string, unknown>) => ((raw.groups as { sort: number }[])[0]!.sort = 0.5)],
    ['a bad color', (raw: Record<string, unknown>) => ((raw.groups as { color: string }[])[0]!.color = 'red')],
    ['an unknown field', (raw: Record<string, unknown>) => ((raw.groups as Record<string, unknown>[])[0]!.extra = 1)],
    ['a stamp from before 2020', (raw: Record<string, unknown>) => ((raw.groups as { updatedAt: number }[])[0]!.updatedAt = Date.UTC(2019, 0, 1))],
    ['a bad epoch', (raw: Record<string, unknown>) => (raw.epoch = 'a b')],
    ['a short checksum', (raw: Record<string, unknown>) => ((raw.icons as { sha256: string }[])[0]!.sha256 = 'abc')],
    ['too many groups', (raw: Record<string, unknown>) => (raw.groups = Array.from({ length: MAX_SYNC_GROUPS + 1 }, (_, i) => group(`g${i}`, T)))],
  ])('refuses %s', (_what, breakIt) => {
    const raw = sampleRaw();
    breakIt(raw);
    expect(problemOf(raw)).toBe('invalid');
  });

  it('refuses a stamp more than a year ahead of this PC', () => {
    const raw = sampleRaw();
    (raw.deleted as { at: number }[])[0]!.at = NOW + 400 * 24 * 60 * 60 * 1000;
    expect(problemOf(raw)).toBe('stamp_ahead');
    // A few minutes ahead is only clock skew.
    (raw.deleted as { at: number }[])[0]!.at = NOW + 5 * 60_000;
    expect(problemOf(raw)).toBe('ok');
  });
});

describe('checkSyncIcon', () => {
  const entry = async (bytes: Uint8Array, extra: Partial<SyncIcon> = {}): Promise<SyncIcon> => ({
    id: ICON_ID,
    contentType: 'image/png',
    sha256: await sha256Hex(bytes),
    width: 16,
    ...extra,
  });

  it('accepts an image whose checksum matches, typed from its bytes', async () => {
    const png = new Uint8Array(PNG_BYTES);
    expect(await checkSyncIcon(png, await entry(png))).toEqual({ ok: true, contentType: 'image/png' });
    // The type the file lists is not trusted.
    expect(await checkSyncIcon(png, await entry(png, { contentType: 'image/gif' }))).toEqual({ ok: true, contentType: 'image/png' });
  });

  it('refuses a checksum mismatch, bytes that are not an image, and an oversized file', async () => {
    const png = new Uint8Array(PNG_BYTES);
    expect(await checkSyncIcon(png, await entry(png, { sha256: '0'.repeat(64) }))).toEqual({ ok: false, problem: 'checksum' });
    const html = bytesOf('<html><script>alert(1)</script></html>');
    expect(await checkSyncIcon(html, await entry(html))).toEqual({ ok: false, problem: 'not_an_image' });
    expect(await checkSyncIcon(new Uint8Array(0), await entry(new Uint8Array(0)))).toEqual({ ok: false, problem: 'not_an_image' });
    const big = new Uint8Array(MAX_SYNC_ICON_BYTES + 1);
    expect(await checkSyncIcon(big, await entry(png))).toEqual({ ok: false, problem: 'too_large' });
  });
});
