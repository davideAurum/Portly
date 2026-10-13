import { describe, expect, it } from 'vitest';
import { EVENT_TEXT_LIMITS } from '@homebase/shared';
import { descriptionText, looksLikeHtml, multiLine, singleLine } from './text.ts';

const MAX = EVENT_TEXT_LIMITS.description;

function ms(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('event text at ingest', () => {
  it('converts HTML descriptions (auto/html) and keeps plain text as text', () => {
    expect(descriptionText('<p>Agenda</p><ul><li>One</li><li>Two</li></ul>', MAX, 'auto')).toBe('Agenda\n• One\n• Two');
    expect(descriptionText('Fish &amp; chips', MAX, 'auto')).toBe('Fish & chips');
    // ICS: only tags make it HTML; entity-like text and line breaks stay as they are.
    expect(descriptionText('R&amp;D\nnext line', MAX, 'auto-tags')).toBe('R&amp;D\nnext line');
    expect(descriptionText('<b>Bold</b><br>next', MAX, 'auto-tags')).toBe('Bold\nnext');
    expect(descriptionText('<b>not html</b>', MAX, 'text')).toBe('<b>not html</b>');
    expect(descriptionText('   ', MAX)).toBeNull();
    expect(descriptionText(42, MAX)).toBeNull();
  });

  it('caps descriptions at 8 KB and collapses blank-line runs', () => {
    const text = descriptionText(`<p>${'x'.repeat(20_000)}</p>`, MAX, 'html');
    expect(text).toHaveLength(MAX);
    expect(multiLine('a  \n\n\n\n\nb\t \n', MAX)).toBe('a\n\nb');
    expect(singleLine('  a \n b\u0000c  ', 100)).toBe('a bc');
  });

  it('detects HTML without backtracking across unterminated tags', () => {
    expect(looksLikeHtml('<a href="x">y</a>')).toBe(true);
    expect(looksLikeHtml('a < b')).toBe(false);
    expect(looksLikeHtml('&amp;')).toBe(true);
    expect(looksLikeHtml('&amp;', { entities: false })).toBe(false);
    // 150 KB of `<a ` without a `>`: the old `[^>]*>` pattern needed about six seconds.
    expect(ms(() => looksLikeHtml('<a '.repeat(50_000)))).toBeLessThan(200);
  });

  it('handles hostile descriptions in linear time (10k unclosed tags < 200 ms)', () => {
    let out: string | null = null;
    expect(ms(() => (out = descriptionText(`<b>x</b>${'<div>'.repeat(10_000)}end`, MAX, 'auto')))).toBeLessThan(200);
    expect(out).toBe('x\nend');

    const hostile: [string, 'auto' | 'html' | 'text'][] = [
      [`${'<div>'.repeat(200_000)}`, 'html'],
      [`<p>${' '.repeat(200_000)}x</p>`, 'html'],
      [`${' '.repeat(200_000)}x\n`, 'text'], // trailing-space trim used to be quadratic
      [`${'\n'.repeat(200_000)}x`, 'text'],
      [`${'<br>'.repeat(100_000)}x`, 'html'],
      [`<a ${'<a '.repeat(100_000)}`, 'auto'],
      [`${'<'.repeat(300_000)}`, 'auto'],
    ];
    for (const [value, format] of hostile) {
      expect(ms(() => descriptionText(value, MAX, format)), `${format} ${value.slice(0, 12)}`).toBeLessThan(500);
    }
    expect(ms(() => singleLine(`${' '.repeat(500_000)}x`, EVENT_TEXT_LIMITS.title))).toBeLessThan(200);
  });
});
