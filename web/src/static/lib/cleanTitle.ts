/**
 * Title normalization for imported bookmarks and group names (copy of `cleanTitle` from
 * server/src/modules/bookmarks/html.ts, which cannot be imported: that module pulls in the
 * server's safe-fetch).
 */

export const MAX_TITLE_LENGTH = 300;

/** Collapses whitespace, trims and caps a title at a code-point boundary; empty → null. */
export function cleanTitle(value: string | undefined | null, max = MAX_TITLE_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  // Bounded work for hostile input: nothing past the first 64 K characters can reach the result.
  const bounded = value.length > 65_536 ? value.slice(0, 65_536) : value;
  const collapsed = bounded.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (collapsed === '') return null;
  const chars = Array.from(collapsed);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : collapsed;
}
