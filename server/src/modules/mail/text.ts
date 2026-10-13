/**
 * Plain-text normalization for mail content (§4.4). Everything a provider sends is attacker
 * controlled (senders, subjects, snippets): it is turned into bounded plain text here, at ingest,
 * and the UI renders it as React text only.
 *
 * - Gmail snippets arrive HTML-entity-encoded (`&#39;`, `&amp;`); they are decoded with
 *   `entities` `decodeHTML` — never with a DOM — and are never parsed as HTML: a literal `<b>` in
 *   a snippet stays the text `<b>`.
 * - Control characters, bidi overrides/isolates (sender/subject spoofing) and the invisible
 *   padding characters bulk mailers stuff into previews are removed; whitespace is collapsed.
 * - Length caps (subject 500, snippet 500) count code points and never split a surrogate pair.
 */
import { decodeHTML } from 'entities';
import { MAIL_TEXT_LIMITS, type MailAddress } from '@portly/shared';

/** Cap for sender names and addresses (not in the contract; generous for real-world values). */
export const MAX_NAME_LENGTH = 200;
export const MAX_ADDRESS_LENGTH = 320;

// C0/C1 controls except TAB/LF/CR (turned into spaces below), DEL.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// Bidi embeddings/overrides/isolates and marks; zero-width and invisible formatting characters
// (ZWSP/ZWNJ/ZWJ, word joiner, invisible operators, BOM, soft hyphen, combining grapheme joiner,
// Hangul fillers, Mongolian vowel separator) that are used to pad or disguise previews.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0]/g;
const WHITESPACE = /[\s\u2028\u2029]+/g;

/** Truncates to at most `max` code points (never splitting a surrogate pair), adding an ellipsis. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/** Plain single-line text: controls/invisibles removed, whitespace collapsed, trimmed, capped. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(WHITESPACE, ' ').trim();
  return capText(text, max);
}

/** Subject (≤ 500). */
export function cleanSubject(value: unknown): string {
  return cleanText(value, MAIL_TEXT_LIMITS.subject);
}

/** A provider preview that is already plain text (Graph `bodyPreview`); empty → null. */
export function cleanPreview(value: unknown): string | null {
  const text = cleanText(value, MAIL_TEXT_LIMITS.snippet);
  return text === '' ? null : text;
}

/**
 * Gmail snippet: HTML entities decoded with `entities` (strict-free "legacy" mode, like a browser
 * reading text content), then normalized as plain text. Empty → null.
 */
export function decodeSnippet(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Decode before capping so an entity is never cut in half; bound the work on huge inputs first.
  const bounded = value.length > 20_000 ? value.slice(0, 20_000) : value;
  return cleanPreview(decodeHTML(bounded));
}

/** Normalized address (no display text, no whitespace), or ''. */
export function cleanAddress(value: unknown): string {
  const text = cleanText(value, MAX_ADDRESS_LENGTH).replace(/\s+/g, '');
  return text;
}

/** `{name, address}` from separate provider fields. */
export function mailAddress(name: unknown, address: unknown): MailAddress {
  const addr = cleanAddress(address);
  let display = cleanText(name, MAX_NAME_LENGTH);
  // Strip one level of surrounding quotes ("Jane Doe").
  if (display.length >= 2 && display.startsWith('"') && display.endsWith('"')) display = display.slice(1, -1).trim();
  return { name: display, address: addr };
}

/**
 * Splits a header into display text (quoted strings unquoted and unescaped) and the first
 * angle-addr that is **outside** quoted strings. Text inside quotes is never an address: a
 * hostile `"PayPal <service@paypal.com>" <attacker@evil.example>` has the address
 * `attacker@evil.example`.
 */
function scanMailbox(header: string): { display: string; unquoted: string; angle: string | null } {
  let display = '';
  let unquoted = '';
  let inQuote = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i] as string;
    if (inQuote) {
      if (ch === '\\' && i + 1 < header.length) {
        display += header[++i];
      } else if (ch === '"') {
        inQuote = false;
      } else {
        display += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === '<') {
      const end = header.indexOf('>', i + 1);
      if (end === -1) break;
      return { display, unquoted, angle: header.slice(i + 1, end) };
    }
    display += ch;
    unquoted += ch;
  }
  return { display, unquoted, angle: null };
}

/**
 * Parses an RFC 5322 `From` header value as Gmail returns it (already MIME-decoded):
 * `Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`, `<jane@example.com>` or
 * `jane@example.com`. Only the first mailbox of a list is used; quoted display names are
 * display text only (never a source of the address).
 */
export function parseFromHeader(value: unknown): MailAddress {
  if (typeof value !== 'string') return { name: '', address: '' };
  const header = value.length > 2000 ? value.slice(0, 2000) : value;
  const { display, unquoted, angle } = scanMailbox(header);
  if (angle !== null) return mailAddress(display, angle);
  // Bare address outside quotes (possibly followed by a comment or further addresses).
  const bare = /[^\s<>,;"()]+@[^\s<>,;"()]+/.exec(unquoted);
  if (bare) {
    const rest = display.replace(bare[0], '').replace(/[()]/g, ' ');
    return mailAddress(rest, bare[0]);
  }
  return mailAddress(display, '');
}

/** ISO date-time from provider values (epoch ms number/string, ISO or RFC 2822 text, Date). */
export function toIsoDate(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    let ms: number | null = null;
    if (candidate instanceof Date) ms = candidate.getTime();
    else if (typeof candidate === 'number') ms = candidate;
    else if (typeof candidate === 'string' && candidate.trim() !== '') {
      ms = /^\d{10,16}$/.test(candidate.trim()) ? Number(candidate.trim()) : Date.parse(candidate);
    }
    // Plausible range only (1990 … 2200): garbage dates are ignored rather than shown.
    if (ms !== null && Number.isFinite(ms) && ms > 631_152_000_000 && ms < 7_258_118_400_000) return new Date(ms).toISOString();
  }
  return null;
}
