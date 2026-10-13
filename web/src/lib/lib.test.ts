import { DEFAULT_ACCENT } from '@homebase/shared';
import { describe, expect, it } from 'vitest';
import { SWATCHES, colorFromString, contrastRatio, parseHexColor, readableTextColor, relativeLuminance, safeColor, toOpaqueHex } from './color.ts';
import { createFormatters, formatRelative, formatTime, hourCycleFor, resolveLocale, uses12Hour } from './format.ts';
import { applyMergePatch, combineMergePatches } from './mergePatch.ts';

describe('color', () => {
  it('parses only #rrggbb / #rrggbbaa', () => {
    expect(parseHexColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseHexColor('#ff800080')?.a).toBeCloseTo(0.502, 2);
    for (const bad of ['#fff', 'red', 'rgb(0,0,0)', '#gggggg', '', null, 12]) expect(parseHexColor(bad)).toBeNull();
    expect(safeColor('javascript:alert(1)', '#000000')).toBe('#000000');
    expect(safeColor('#123456', '#000000')).toBe('#123456');
    expect(toOpaqueHex('#11223344')).toBe('#112233');
  });

  it('picks the more readable text color (WCAG contrast)', () => {
    expect(readableTextColor('#ffffff')).toBe('#111827');
    // The default accent takes white text on primary buttons (VIS-1).
    expect(readableTextColor(DEFAULT_ACCENT)).toBe('#ffffff');
    expect(readableTextColor('#fde047')).toBe('#111827');
    expect(readableTextColor('#1e3a8a')).toBe('#ffffff');
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('not a color')).toBe('#111827');
    expect(contrastRatio(relativeLuminance(parseHexColor('#ffffff')!), relativeLuminance(parseHexColor('#000000')!))).toBeCloseTo(21, 0);
  });

  it('derives stable palette colors', () => {
    expect(colorFromString('GitHub')).toBe(colorFromString('GitHub'));
    expect(SWATCHES).toContain(colorFromString('anything'));
    expect(SWATCHES).toHaveLength(12);
  });
});

describe('format', () => {
  const at = new Date('2026-09-25T14:05:09Z');

  it('respects the time format preference', () => {
    expect(hourCycleFor('12h')).toBe('h12');
    expect(hourCycleFor('24h')).toBe('h23');
    expect(hourCycleFor('system')).toBeUndefined();
    expect(formatTime(at, { locale: 'en-US', timeFormat: '24h' }, { timeZone: 'UTC' })).toBe('14:05');
    expect(formatTime(at, { locale: 'en-US', timeFormat: '12h' }, { timeZone: 'UTC' })).toMatch(/^2:05\sPM$/);
    expect(formatTime(at, { locale: 'en-GB', timeFormat: '24h' }, { timeZone: 'UTC', seconds: true })).toBe('14:05:09');
    expect(uses12Hour({ locale: 'en-US', timeFormat: 'system' })).toBe(true);
    expect(uses12Hour({ locale: 'de-DE', timeFormat: 'system' })).toBe(false);
    expect(uses12Hour({ locale: 'de-DE', timeFormat: '12h' })).toBe(true);
  });

  it('respects the locale and falls back for invalid tags', () => {
    expect(resolveLocale('system')).toBeUndefined();
    expect(resolveLocale('en-us')).toBe('en-US');
    expect(resolveLocale('not a locale!')).toBeUndefined();
    const de = createFormatters({ locale: 'de-DE', timeFormat: 'system', weekStartsOn: 1 });
    expect(de.date(at, 'long', 'UTC')).toBe('25. September 2026');
    expect(formatTime('garbage', { locale: 'en-US', timeFormat: '24h' })).toBe('');
  });

  it('formats relative times', () => {
    const prefs = { locale: 'en-US' };
    expect(formatRelative(at, at, prefs)).toBe('now');
    expect(formatRelative(new Date(at.getTime() - 5 * 60_000), at, prefs)).toBe('5 min. ago');
    expect(formatRelative(new Date(at.getTime() + 3 * 3600_000), at, prefs)).toBe('in 3 hr.');
    expect(formatRelative(new Date(at.getTime() - 24 * 3600_000), at, prefs)).toBe('yesterday');
  });
});

describe('merge patch', () => {
  it('merges objects, replaces arrays and deletes on null', () => {
    const target = { a: { b: 1, c: 2 }, list: [1, 2], keep: true };
    expect(applyMergePatch(target, { a: { b: 9, c: null }, list: [3] })).toEqual({ a: { b: 9 }, list: [3], keep: true });
    expect(target).toEqual({ a: { b: 1, c: 2 }, list: [1, 2], keep: true });
  });

  it('ignores prototype-polluting keys', () => {
    const patched = applyMergePatch({}, JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "ok": 1}'));
    expect(patched).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('combines patches so applying the result equals applying both', () => {
    const base = { appearance: { accent: '#000000', radius: 4, background: { type: 'color', color: '#111111' } } };
    const a = { appearance: { accent: '#ff0000' } };
    const b = { appearance: { radius: 8, background: { color: '#222222' } } };
    expect(applyMergePatch(base, combineMergePatches(a, b))).toEqual(applyMergePatch(applyMergePatch(base, a), b));
  });
});
