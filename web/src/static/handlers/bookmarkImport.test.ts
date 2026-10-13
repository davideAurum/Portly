/**
 * Static bookmarks imports: the browser-profile stubs and the Netscape HTML import, ported from the
 * server's imports.test.ts (report counts on the shared fixture, strategies, re-import dedupe,
 * validation) plus the in-memory `writeImport` rules (group reuse, caps, title fallbacks, icons).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BOOKMARKS, MAX_BOOKMARK_GROUPS, type BookmarkGroup, type BookmarkImportReport, type BookmarksResponse } from '@homebase/shared';
import { NETSCAPE_HTML } from '../lib/__fixtures__/netscape.ts';
import { getBookmarks, getSettings, SLICE } from '../slices.ts';
import { createTestBackend, fileForm, type TestBackend } from '../test/harness.ts';
import * as bookmarks from './bookmarks.ts';

interface ErrorBody {
  error: { code: string; message: string };
}

const T0 = 1_700_000_000_000;
const summary = (groups: BookmarkGroup[]) => groups.map((g) => [g.name, g.bookmarks.map((b) => b.title)]);

function bookmarkFile(html: string, extra: Record<string, string> = {}): FormData {
  return fileForm(html, 'bookmarks.html', 'text/html', 'file', extra);
}

describe('static bookmarks imports', () => {
  let t: TestBackend;
  beforeEach(async () => {
    t = await createTestBackend([bookmarks]);
    getSettings(t.ctx).bookmarks.autoFetchIcons = false;
  });
  afterEach(() => t.close());

  const list = async (): Promise<BookmarkGroup[]> => (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
  const importHtml = (form: FormData) => t.json<BookmarkImportReport & ErrorBody>('POST', '/api/bookmarks/import/html', form);

  describe('browser profiles', () => {
    it('offers no sources and refuses the browser import with a clear 404', async () => {
      const sources = await t.call('GET', '/api/bookmarks/import/sources');
      expect(sources.status).toBe(200);
      expect(sources.headers.get('content-type')).toContain('application/json');
      expect(await sources.json()).toEqual([]);
      const res = await t.json<ErrorBody>('POST', '/api/bookmarks/import/browser', { sourceId: 'x', targetGroupStrategy: 'folders' });
      expect(res.status).toBe(404);
      expect(res.body.error).toEqual({ code: 'not_found', message: 'Browser profile import is not available in this build' });
      expect(await list()).toEqual([]);
    });
  });

  describe('Netscape HTML upload', () => {
    it('imports folders as groups, skipping bookmarklets and place: URLs', async () => {
      const res = await importHtml(bookmarkFile(NETSCAPE_HTML));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ groups: 4, bookmarks: 5, skipped: 2 });
      const groups = await list();
      expect(summary(groups)).toEqual([
        ['Imported bookmarks', ['Top level']],
        ['Bookmarks bar', ['Tom & Jerry <3', 'Hacker News']],
        ['Dev', ['GitHub']],
        ['Dev / Deep', ['Deep link']],
      ]);
      expect(groups.map((g) => g.sort)).toEqual([0, 1, 2, 3]);
      expect(groups.flatMap((g) => g.bookmarks.map((b) => b.sort))).toEqual([0, 0, 1, 0, 0]);
      expect(groups[1]!.bookmarks[0]!.url).toBe('https://example.com/?a=1&b=2');
      expect(groups.every((g) => g.color === null && g.collapsed === false)).toBe(true);
      expect(groups.flatMap((g) => g.bookmarks).every((b) => b.iconMode === 'auto' && b.iconId === null && b.letterColor === null)).toBe(true);
      // Persisted in one commit.
      expect(await t.storage.getJson(`slice:${SLICE.bookmarks}`)).toEqual(getBookmarks(t.ctx));
    });

    it('supports the single strategy field and reports duplicates on re-import', async () => {
      const res = await importHtml(bookmarkFile(NETSCAPE_HTML, { targetGroupStrategy: 'single' }));
      expect(res.body).toEqual({ groups: 1, bookmarks: 5, skipped: 2 });
      // Document order: a folder's own links first, then its subfolders.
      expect(summary(await list())).toEqual([['Imported bookmarks', ['Top level', 'Tom & Jerry <3', 'Hacker News', 'GitHub', 'Deep link']]]);
      const again = await importHtml(bookmarkFile(NETSCAPE_HTML, { targetGroupStrategy: 'single' }));
      expect(again.body).toEqual({ groups: 0, bookmarks: 0, skipped: 7 });
      // Re-importing with the folders strategy reuses the fallback group for the top-level link.
      const folders = await importHtml(bookmarkFile(NETSCAPE_HTML, { targetGroupStrategy: 'folders' }));
      expect(folders.body).toEqual({ groups: 3, bookmarks: 4, skipped: 3 });
      const bad = await importHtml(bookmarkFile(NETSCAPE_HTML, { targetGroupStrategy: 'x' }));
      expect(bad.status).toBe(422);
      expect(bad.body.error).toEqual({ code: 'validation_failed', message: 'targetGroupStrategy must be "folders" or "single"' });
    });

    it('reuses existing groups by trimmed, case-insensitive name', async () => {
      const created = await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { name: '  DEV ' });
      expect(created.status).toBe(201);
      const res = await importHtml(bookmarkFile(NETSCAPE_HTML));
      expect(res.body).toEqual({ groups: 3, bookmarks: 5, skipped: 2 });
      const groups = await list();
      expect(summary(groups)).toEqual([
        ['DEV', ['GitHub']],
        ['Imported bookmarks', ['Top level']],
        ['Bookmarks bar', ['Tom & Jerry <3', 'Hacker News']],
        ['Dev / Deep', ['Deep link']],
      ]);
      expect(groups[0]!.id).toBe(created.body.id);
    });

    it('rejects files that are not bookmark exports, empty files and non-multipart bodies', async () => {
      const notBookmarks = await importHtml(bookmarkFile('<html><p>hi</p></html>'));
      expect(notBookmarks.status).toBe(422);
      expect(notBookmarks.body.error).toEqual({ code: 'validation_failed', message: 'This is not a bookmarks export (Netscape bookmark HTML file)' });
      const empty = await importHtml(bookmarkFile(''));
      expect(empty.status).toBe(400);
      expect(empty.body.error.message).toBe('The file is empty');
      const json = await t.json<ErrorBody>('POST', '/api/bookmarks/import/html', { file: NETSCAPE_HTML });
      expect(json.status).toBe(400);
      const noFile = new FormData();
      noFile.append('targetGroupStrategy', 'folders');
      expect((await importHtml(noFile)).status).toBe(400);
      // Nothing was written.
      expect(await list()).toEqual([]);
      expect(await t.storage.getJson(`slice:${SLICE.bookmarks}`)).toBeUndefined();
    });

    it('refuses files over 25 MB with 413', async () => {
      const res = await importHtml(fileForm(new Uint8Array(25 * 1024 * 1024 + 1), 'big.html', 'text/html'));
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('payload_too_large');
    });

    it('assigns synthetic favicon ids to imported bookmarks when automatic icons are on', async () => {
      getSettings(t.ctx).bookmarks.autoFetchIcons = true;
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
        <DL><p>
          <DT><A HREF="https://github.com/">GitHub</A>
          <DT><A HREF="http://nas/">Home NAS</A>
          <DT><A HREF="http://192.168.1.10/">Router</A>
        </DL><p>`;
      expect((await importHtml(bookmarkFile(html))).body).toEqual({ groups: 1, bookmarks: 3, skipped: 0 });
      const [group] = await list();
      expect(group!.bookmarks.map((b) => [b.title, b.iconId])).toEqual([
        ['GitHub', 'fav:github.com'],
        ['Home NAS', null],
        ['Router', null],
      ]);
    });

    it('falls back to the host and then the URL for empty titles, trims and caps long ones', async () => {
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
        <DL><p>
          <DT><A HREF="https://x.example/path"></A>
          <DT><A HREF="  https://y.example/  ">   Spaced    out   </A>
          <DT><A HREF="https://z.example/">${'z'.repeat(400)}</A>
          <DT><A HREF="https://dupe.example/">First</A>
          <DT><A HREF="https://dupe.example/">Second</A>
        </DL><p>`;
      expect((await importHtml(bookmarkFile(html))).body).toEqual({ groups: 1, bookmarks: 4, skipped: 1 });
      const [group] = await list();
      expect(group!.bookmarks.map((b) => b.title)).toEqual(['x.example', 'Spaced out', `${'z'.repeat(299)}…`, 'First']);
      expect(group!.bookmarks[1]!.url).toBe('https://y.example/');
    });

    it('decodes the file as UTF-8', async () => {
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://x.example/">Café — 日本</A></DL><p>`;
      await importHtml(fileForm(new TextEncoder().encode(html), 'b.html', 'text/html'));
      expect((await list())[0]!.bookmarks[0]!.title).toBe('Café — 日本');
    });

    it('counts links past the group cap and the bookmark cap as skipped', async () => {
      const slice = getBookmarks(t.ctx);
      for (let i = 0; i < MAX_BOOKMARK_GROUPS; i++) {
        slice.groups.push({ id: `g${i}`, name: `G${i}`, sort: i, color: null, collapsed: false, createdAt: T0, updatedAt: T0 });
      }
      // No new group can be created: every valid link of every planned group is skipped.
      expect((await importHtml(bookmarkFile(NETSCAPE_HTML))).body).toEqual({ groups: 0, bookmarks: 0, skipped: 7 });
      // An existing group still receives links, up to the bookmark cap. (The import replaced the
      // slice object, so re-read it.)
      const after = getBookmarks(t.ctx);
      after.groups[0]!.name = 'Dev';
      for (let i = 0; i < MAX_BOOKMARKS - 1; i++) {
        after.bookmarks.push({ id: `b${i}`, groupId: 'g1', title: 'x', url: `https://x.example/${i}`, sort: i, iconMode: 'auto', iconId: null, letterColor: null, createdAt: T0, updatedAt: T0 });
      }
      expect((await importHtml(bookmarkFile(NETSCAPE_HTML))).body).toEqual({ groups: 0, bookmarks: 1, skipped: 6 });
      expect(getBookmarks(t.ctx).bookmarks.filter((b) => b.groupId === 'g0').map((b) => b.title)).toEqual(['GitHub']);
    });
  });
});
