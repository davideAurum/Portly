import { describe, expect, it } from 'vitest';
import { StaticApiError } from '../respond.ts';
import { NETSCAPE_HTML } from './__fixtures__/netscape.ts';
import { MAX_HTML_IMPORT_BYTES, looksLikeBookmarkFile, parseNetscapeBookmarks } from './importHtml.ts';
import { countLinks, type ImportFolder } from './importPlan.ts';

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const shape = (folder: ImportFolder): unknown[] => folder.children.map((c) => (c.kind === 'link' ? [tidy(c.title), c.url] : { [tidy(c.name)]: shape(c) }));

describe('parseNetscapeBookmarks', () => {
  it('parses Netscape HTML with node-html-parser (entities, attributes, nesting)', () => {
    const tree = parseNetscapeBookmarks(NETSCAPE_HTML);
    const bar = tree.children.find((c) => c.kind === 'folder' && c.name === 'Bookmarks bar');
    expect(bar?.kind).toBe('folder');
    if (bar?.kind !== 'folder') return;
    expect(bar.children[0]).toEqual({ kind: 'link', title: 'Tom & Jerry <3', url: 'https://example.com/?a=1&b=2' });
    const dev = bar.children.find((c) => c.kind === 'folder');
    expect(dev?.kind === 'folder' && dev.name).toBe('Dev');
    expect(tree.children.some((c) => c.kind === 'link' && c.title === 'Top level')).toBe(true);
    expect(shape(tree)).toEqual([
      {
        'Bookmarks bar': [
          ['Tom & Jerry <3', 'https://example.com/?a=1&b=2'],
          {
            Dev: [
              ['GitHub', 'https://github.com/'],
              ['Bookmarklet', "javascript:void(document.body.style.background='red')"],
              { Deep: [['Deep link', 'https://deep.example/']] },
            ],
          },
          ['Hacker News', 'https://news.ycombinator.com/'],
          ['Recently tagged', 'place:sort=8&maxResults=10'],
        ],
      },
      ['Top level', 'https://top-level.example/'],
      { 'Empty folder': [] },
    ]);
    expect(countLinks(tree)).toBe(7);
  });

  it('rejects files that are not bookmark exports with 422 validation_failed', () => {
    let caught: unknown;
    try {
      parseNetscapeBookmarks('<html><body>hello</body></html>');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaticApiError);
    expect(caught).toMatchObject({ code: 'validation_failed', message: 'This is not a bookmarks export (Netscape bookmark HTML file)' });
    expect((caught as StaticApiError).toResponse().status).toBe(422);
    expect(MAX_HTML_IMPORT_BYTES).toBe(25 * 1024 * 1024);
  });

  it('looksLikeBookmarkFile accepts the DOCTYPE in the head or a <dl> with <a href>', () => {
    expect(looksLikeBookmarkFile('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(looksLikeBookmarkFile('<!doctype netscape-bookmark-file-1><p>')).toBe(true);
    expect(looksLikeBookmarkFile('<dl><dt><a href="https://x/">x</a></dl>')).toBe(true);
    expect(looksLikeBookmarkFile('<DL><DT><A HREF = "x">x</A></DL>')).toBe(true);
    expect(looksLikeBookmarkFile('<dl></dl>')).toBe(false);
    expect(looksLikeBookmarkFile('<a href="x">no list</a>')).toBe(false);
    expect(looksLikeBookmarkFile(`${' '.repeat(5000)}<!DOCTYPE NETSCAPE-Bookmark-file-1>`)).toBe(false);
    expect(looksLikeBookmarkFile('')).toBe(false);
  });

  it('reads sloppy Netscape markup: unclosed <A>/<H3>, inline tags, comments', () => {
    const tree = parseNetscapeBookmarks(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <TITLE>Bookmarks</TITLE>
      <DL><p>
        <!-- <DT><A HREF="https://commented.example/">Commented</A> -->
        <DT><A HREF="https://a.example/" ADD_DATE="1">Unclosed &amp; fine
        <DT><A HREF='https://b.example/?x=1&amp;y=2'>With <b>bold</b> text</A>
        <DT><H3>Folder <i>one</i>
        <DL><p>
          <DT><A HREF=https://c.example/c>Unquoted</A>
        </DL><p>
      </DL>`);
    expect(shape(tree)).toEqual([
      ['Unclosed & fine', 'https://a.example/'],
      ['With bold text', 'https://b.example/?x=1&y=2'],
      { 'Folder one': [['Unquoted', 'https://c.example/c']] },
    ]);
  });

  it('names a <DL> without a heading "Untitled folder" and gives a hrefless <A> an empty url', () => {
    const tree = parseNetscapeBookmarks('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DL><p><DT><A>No href</A></DL></DL>');
    expect(shape(tree)).toEqual([{ 'Untitled folder': [['No href', '']] }]);
  });

  it('parses hostile Netscape files in linear time', () => {
    // The previous parser searched for each element's end tag from scratch (quadratic): 20 000
    // unclosed <A>s took about 2 s, and a 25 MB upload could hang the server for hours.
    const head = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>';
    const hostile = [
      `${head}${'<DT><A HREF="https://x.example/">x'.repeat(60_000)}`,
      `${head}${'<DT><H3>x'.repeat(60_000)}`,
      `${head}${'<a '.repeat(500_000)}`,
      `${head}<DT><A HREF="https://y.example/">y</A>${'<!--'.repeat(300_000)}`,
    ];
    const started = performance.now();
    const trees = hostile.map((doc) => parseNetscapeBookmarks(doc));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(countLinks(trees[0]!)).toBe(60_000);
    expect(trees[3]!.children).toEqual([{ kind: 'link', title: 'y', url: 'https://y.example/' }]);
  });

  it('survives hostile nesting without recursion problems and drops links past the depth cap', () => {
    const deep = `${'<DL><p><DT><H3>x</H3>'.repeat(5000)}<DT><A HREF="https://deep.example/">deep</A>${'</DL>'.repeat(5000)}`;
    let tree: ImportFolder | undefined;
    expect(() => {
      tree = parseNetscapeBookmarks(`<!DOCTYPE NETSCAPE-Bookmark-file-1>${deep}`);
    }).not.toThrow();
    expect(countLinks(tree!)).toBe(0);
    // Links at depth 64 are still kept; the overflow folders close cleanly so later links land at the root.
    const edge = `${'<DL><p>'.repeat(65)}<DT><A HREF="https://kept.example/">kept</A>${'</DL>'.repeat(65)}<DL><p><DT><A HREF="https://after.example/">after</A></DL>`;
    const kept = parseNetscapeBookmarks(`<!DOCTYPE NETSCAPE-Bookmark-file-1>${edge}`);
    expect(countLinks(kept)).toBe(2);
  });
});
