/**
 * Bookmarks export (Settings → Bookmarks) as a Netscape bookmark HTML file, the format every
 * browser imports and the one Portly's own HTML import reads. Each group becomes a top-level
 * folder, so importing the file into another Portly with "One group per folder" recreates the
 * groups by name, in order. Only titles, addresses and group names are written: icons, colors and
 * ids stay behind (the full configuration export in Settings → Import & export carries those).
 */
import type { BookmarkGroup } from '@portly/shared';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The bookmark file for `groups` (in their display order); `now` stamps ADD_DATE. */
export function toNetscapeBookmarks(groups: readonly BookmarkGroup[], now: Date = new Date()): string {
  const stamp = String(Math.floor(now.getTime() / 1000));
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const sorted = [...groups].sort((a, b) => a.sort - b.sort);
  for (const group of sorted) {
    lines.push(`    <DT><H3 ADD_DATE="${stamp}" LAST_MODIFIED="${stamp}">${escapeHtml(group.name)}</H3>`);
    lines.push('    <DL><p>');
    for (const bookmark of [...group.bookmarks].sort((a, b) => a.sort - b.sort)) {
      lines.push(`        <DT><A HREF="${escapeHtml(bookmark.url)}" ADD_DATE="${stamp}">${escapeHtml(bookmark.title)}</A>`);
    }
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

/** `portly-bookmarks-2026-10-11.html` (local date). */
export function bookmarksFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `portly-bookmarks-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.html`;
}
