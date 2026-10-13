import { describe, expect, it } from 'vitest';
import { MAX_TITLE_LENGTH, cleanTitle } from './cleanTitle.ts';

describe('cleanTitle', () => {
  it('collapses whitespace and control characters, trims, and returns null for nothing', () => {
    expect(cleanTitle('  Hello \n\t world ')).toBe('Hello world');
    expect(cleanTitle('a\u0000b\u001fc\u007fd')).toBe('a b c d');
    expect(cleanTitle('Tom & Jerry <3')).toBe('Tom & Jerry <3');
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('   \u0000 ')).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle(42 as unknown as string)).toBeNull();
  });

  it('caps at a code-point boundary with an ellipsis, trimming before it', () => {
    expect(cleanTitle('abc def', 5)).toBe('abc…');
    expect(cleanTitle('abcdefgh', 5)).toBe('abcd…');
    expect(cleanTitle('abcde', 5)).toBe('abcde');
    const emoji = cleanTitle('😀'.repeat(10), 5)!;
    expect(Array.from(emoji)).toHaveLength(5);
    expect(emoji).toBe(`${'😀'.repeat(4)}…`);
    expect(Array.from(cleanTitle('x'.repeat(1000))!)).toHaveLength(MAX_TITLE_LENGTH);
    expect(MAX_TITLE_LENGTH).toBe(300);
  });

  it('bounds the work on hostile input (nothing past 64 K characters matters)', () => {
    const hostile = `${' '.repeat(70_000)}tail`;
    expect(cleanTitle(hostile)).toBeNull();
    const started = performance.now();
    expect(cleanTitle(' x'.repeat(5_000_000), 10)).toBe('x x x x x…');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
