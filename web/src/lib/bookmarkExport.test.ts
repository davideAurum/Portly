import { describe, expect, it } from 'vitest';
import type { BookmarkGroup } from '@portly/shared';
import { parseNetscapeBookmarks } from '../static/lib/importHtml.ts';
import { planGroups } from '../static/lib/importPlan.ts';
import { bookmarksFilename, toNetscapeBookmarks } from './bookmarkExport.ts';

const bookmark = (id: string, groupId: string, sort: number, title: string, url: string) => ({
  id,
  groupId,
  title,
  url,
  sort,
  iconMode: 'auto' as const,
  iconId: null,
  letterColor: null,
});

const GROUPS: BookmarkGroup[] = [
  {
    id: 'g2',
    name: 'Fun & <Games>',
    sort: 1,
    color: null,
    collapsed: false,
    bookmarks: [bookmark('b3', 'g2', 0, 'Tom\'s "Site"', 'https://example.com/?a=1&b=<2>')],
  },
  {
    id: 'g1',
    name: 'Work',
    sort: 0,
    color: '#3b82f6',
    collapsed: false,
    bookmarks: [bookmark('b2', 'g1', 1, 'Second', 'https://two.example/'), bookmark('b1', 'g1', 0, 'First', 'https://one.example/')],
  },
];

describe('toNetscapeBookmarks', () => {
  it('writes a Netscape bookmark file with escaped text and attributes', () => {
    const html = toNetscapeBookmarks(GROUPS, new Date(1_700_000_000_000));
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('<H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">Fun &amp; &lt;Games&gt;</H3>');
    expect(html).toContain('HREF="https://example.com/?a=1&amp;b=&lt;2&gt;"');
    expect(html).toContain('>Tom&#39;s &quot;Site&quot;</A>');
  });

  it('round-trips through the Portly importer as one group per folder, in order', () => {
    const root = parseNetscapeBookmarks(toNetscapeBookmarks(GROUPS));
    const plan = planGroups(root, 'folders', 'Imported', { skipped: 0, seen: 0 });
    expect(plan).toEqual([
      {
        name: 'Work',
        links: [
          { kind: 'link', title: 'First', url: 'https://one.example/' },
          { kind: 'link', title: 'Second', url: 'https://two.example/' },
        ],
      },
      { name: 'Fun & <Games>', links: [{ kind: 'link', title: 'Tom\'s "Site"', url: 'https://example.com/?a=1&b=<2>' }] },
    ]);
  });

  it('names the file by local date', () => {
    expect(bookmarksFilename(new Date(2026, 9, 1))).toBe('portly-bookmarks-2026-10-01.html');
  });
});
