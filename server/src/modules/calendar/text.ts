/**
 * Event text at ingest (§4.4): provider HTML descriptions (Google, Graph, HTML in ICS/CalDAV
 * feeds) become plain text with the linear-time converter of `lib/html-scan.ts` (never a DOM,
 * never a whole-document tree: hostile markup such as thousands of unclosed tags cannot stall the
 * server), entities decoded by `entities`; control characters are stripped and every field is
 * length-capped. No regex here backtracks over whitespace runs (line ends are trimmed by index
 * scanning). The UI only ever renders these strings as text and linkifies SafeHttpUrl matches.
 */
import { htmlToPlainText, isLineSpace } from '../../lib/html-scan.ts';

/** Strips C0/C1 controls except TAB/LF, normalizes CRLF and trims. */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, '')
    .trim();
}

/** Caps `value` at `max` UTF-16 code units without splitting a surrogate pair. */
export function capLength(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = max;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return value.slice(0, cut);
}

/** Input read for a field capped at `max` (cleaning only shrinks text, so more is never needed). */
function bounded(value: string, max: number): string {
  const limit = max * 4 + 1024;
  return value.length > limit ? value.slice(0, limit) : value;
}

/** Single-line text (titles, locations): whitespace runs collapse to one space. */
export function singleLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = cleanText(bounded(value, max)).replace(/\s+/g, ' ');
  return text === '' ? null : capLength(text, max);
}

/** Multi-line plain text (descriptions): line ends trimmed, at most one blank line in a row. */
export function multiLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = cleanText(
    cleanText(bounded(value, max))
      .split('\n')
      .map((line) => trimTrailing(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n'),
  );
  return text === '' ? null : capLength(text, max);
}

/** Drops trailing spaces/tabs/NBSPs (index scan; `/[ \t]+$/` is quadratic on long runs). */
function trimTrailing(line: string): string {
  let end = line.length;
  while (end > 0 && isLineSpace(line.charCodeAt(end - 1))) end--;
  return end === line.length ? line : line.slice(0, end);
}

/** Tags that mark a description as HTML. `[^<>]*` keeps every attempt within one tag (linear). */
const HTML_TAG = /<\/?(?:a|b|i|u|p|br|div|span|ul|ol|li|strong|em|html|body|table|tr|td|font|hr|h[1-6])\b[^<>]*>/i;
const HTML_ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;

/**
 * Heuristic: does the string look like HTML (Google descriptions may be either)? With
 * `entities: false` only tags count (ICS text may legitimately contain `&amp;`-like text).
 */
export function looksLikeHtml(value: string, options: { entities?: boolean } = {}): boolean {
  return HTML_TAG.test(value) || ((options.entities ?? true) && HTML_ENTITY.test(value));
}

/**
 * HTML → plain text (linear time, see `htmlToPlainText`): block elements and `<br>` become line
 * breaks, list items get "• ", links keep their text and append the URL when it differs (so the
 * UI can linkify it), script/style content is dropped. Output is bounded to about `maxChars`.
 */
export function htmlToText(html: string, maxChars = 64 * 1024): string {
  return htmlToPlainText(html, { maxChars });
}

/**
 * Description format: `auto` = HTML when it has tags or entities (Google), `auto-tags` = HTML only
 * when it has tags (ICS/CalDAV, whose DESCRIPTION is plain text by the RFC), or fixed.
 */
export type DescriptionFormat = 'auto' | 'auto-tags' | 'html' | 'text';

/** Description at ingest: HTML (when it looks like HTML) → text, cleaned and capped. */
export function descriptionText(value: unknown, max: number, format: DescriptionFormat = 'auto'): string | null {
  if (typeof value !== 'string') return null;
  const isHtml =
    format === 'html' || (format === 'auto' && looksLikeHtml(value)) || (format === 'auto-tags' && looksLikeHtml(value, { entities: false }));
  return multiLine(isHtml ? htmlToText(value, max * 2 + 1024) : value, max);
}
