/**
 * Netscape bookmark file import (§7 `POST /api/bookmarks/import/html`), the format every browser
 * exports: `<DL><p>` lists of `<DT><A HREF=…>title</A>` links and `<DT><H3>folder</H3>` headings,
 * each heading followed by the folder's own `<DL>`.
 *
 * The file is untrusted (§4.1 b) and up to 25 MB, and the format relies on unclosed `<DT>`/`<p>`
 * tags that tree builders re-nest in super-linear time, so it is never parsed as one tree. The
 * linear tag scanner ({@link scanTags}) yields the structural tags in order: `<DL>`/`</DL>` open
 * and close folders, an `<H3>`'s text names the next `<DL>`, and an `<A>`'s text is everything up
 * to its `</A>` (or the next structural tag, for sloppy files) with inline markup dropped and
 * entities decoded. Each `<A>` start tag is parsed on its own by node-html-parser (attribute and
 * entity decoding, never a DOM). Total work is linear in the file size.
 */
import { decodeHTML } from 'entities';
import { HttpError } from '../../lib/errors.ts';
import { MAX_FOLDER_DEPTH, MAX_IMPORT_ENTRIES, type ImportFolder } from './importer.ts';
import { MAX_RAW_TEXT, parseTag, scanTags, stripTags, type HtmlTag } from '../../lib/html-scan.ts';

/** Tags that end the text of an open `<A>`/`<H3>` (besides its own end tag). */
const STRUCTURAL = new Set(['dl', 'dt', 'dd', 'h3', 'a', 'p', 'hr']);
/** Raw-text elements of a bookmark file (its `<TITLE>`, stray scripts/styles). */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'noscript']);

/** True when the text looks like a Netscape bookmark file. */
export function looksLikeBookmarkFile(html: string): boolean {
  const head = html.slice(0, 4096);
  // `[^<>]*` keeps each attempt within one tag, so the test is linear even on hostile input.
  return /<!DOCTYPE\s+NETSCAPE-Bookmark-file/i.test(head) || (/<dl\b/i.test(html) && /<a\s[^<>]*href\s*=/i.test(html));
}

function textOf(html: string, from: number, to: number): string {
  return decodeHTML(stripTags(html.slice(from, Math.min(to, from + MAX_RAW_TEXT))));
}

export function parseNetscapeBookmarks(html: string): ImportFolder {
  if (!looksLikeBookmarkFile(html)) {
    throw new HttpError(422, 'validation_failed', 'This is not a bookmarks export (Netscape bookmark HTML file)');
  }
  const root: ImportFolder = { kind: 'folder', name: '', children: [] };
  const stack: ImportFolder[] = [];
  let pendingFolder: string | null = null;
  let entries = 0;
  let overflowDepth = 0;
  /** The `<A>` or `<H3>` whose text is being read. */
  let open: { kind: 'a' | 'h3'; tag: HtmlTag; into: ImportFolder | null } | null = null;

  const finish = (at: number): void => {
    if (!open) return;
    const text = textOf(html, open.tag.end, at);
    if (open.kind === 'h3') {
      pendingFolder = text;
    } else if (open.into) {
      const href = parseTag(open.tag.source)?.getAttribute('href');
      open.into.children.push({ kind: 'link', title: text, url: href ?? '' });
    }
    open = null;
  };

  for (const tag of scanTags(html, RAW_TEXT)) {
    if (open !== null && ((tag.closing && tag.name === open.kind) || STRUCTURAL.has(tag.name))) finish(tag.start);
    if (tag.name !== 'dl' && tag.name !== 'h3' && tag.name !== 'a') continue;
    if (tag.closing && tag.name !== 'dl') continue;
    if (++entries > MAX_IMPORT_ENTRIES * 2) break;

    if (tag.name === 'dl') {
      if (tag.closing) {
        if (overflowDepth > 0) overflowDepth--;
        else if (stack.length > 0) stack.pop();
      } else if (stack.length === 0) {
        stack.push(root);
      } else if (overflowDepth > 0 || stack.length > MAX_FOLDER_DEPTH) {
        overflowDepth++;
      } else {
        const folder: ImportFolder = { kind: 'folder', name: pendingFolder ?? 'Untitled folder', children: [] };
        stack.at(-1)!.children.push(folder);
        stack.push(folder);
      }
      pendingFolder = null;
      continue;
    }
    if (tag.name === 'h3') {
      open = { kind: 'h3', tag, into: null };
      continue;
    }
    pendingFolder = null;
    open = { kind: 'a', tag, into: overflowDepth > 0 ? null : (stack.at(-1) ?? root) };
  }
  finish(html.length);
  return root;
}
