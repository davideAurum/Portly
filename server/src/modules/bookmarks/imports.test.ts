import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkImportReport, BookmarkImportSource, BookmarksResponse } from '@portly/shared';
import { bookmarksTestbed, fileForm, type BookmarksTestbed } from './__fixtures__/setup.ts';
import { NETSCAPE_HTML, chromeBookmarksFile, makeLocalAppData } from './__fixtures__/imports.ts';
import { countImportableLinks, parseBrowserBookmarks, sourceId } from './import-browser.ts';
import { parseNetscapeBookmarks } from './import-html.ts';
import { planGroups, type ImportFolder } from './importer.ts';

type Groups = BookmarksResponse['groups'];
const summary = (groups: Groups) => groups.map((g) => [g.name, g.bookmarks.map((b) => b.title)]);

describe('bookmarks import: parsers', () => {
  it('parses Chromium bookmark JSON into a tree (document order, nested folders)', () => {
    const tree = parseBrowserBookmarks(chromeBookmarksFile());
    expect(tree.children.map((c) => (c.kind === 'folder' ? c.name : c.title))).toEqual(['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks']);
    const bar = tree.children[0]!;
    expect(bar.kind === 'folder' && bar.children.map((c) => (c.kind === 'folder' ? `[${c.name}]` : c.title))).toEqual([
      'News',
      'Bookmarklet',
      '[Dev]',
      '  Mail   inbox ',
    ]);
    expect(countImportableLinks(tree)).toBe(5);
    expect(() => parseBrowserBookmarks({ nope: 1 })).toThrow(/not a Chrome or Edge bookmarks file/);
    expect(() => parseBrowserBookmarks([])).toThrow();
  });

  it('parses Netscape HTML with node-html-parser (entities, attributes, nesting)', () => {
    const tree = parseNetscapeBookmarks(NETSCAPE_HTML);
    const bar = tree.children.find((c) => c.kind === 'folder' && c.name === 'Bookmarks bar');
    expect(bar?.kind).toBe('folder');
    if (bar?.kind !== 'folder') return;
    expect(bar.children[0]).toEqual({ kind: 'link', title: 'Tom & Jerry <3', url: 'https://example.com/?a=1&b=2' });
    const dev = bar.children.find((c) => c.kind === 'folder');
    expect(dev?.kind === 'folder' && dev.name).toBe('Dev');
    expect(tree.children.some((c) => c.kind === 'link' && c.title === 'Top level')).toBe(true);
    expect(() => parseNetscapeBookmarks('<html><body>hello</body></html>')).toThrow(/not a bookmarks export/);
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
    const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
    const shape = (folder: ImportFolder): unknown[] =>
      folder.children.map((c) => (c.kind === 'link' ? [tidy(c.title), c.url] : { [tidy(c.name)]: shape(c) }));
    expect(shape(tree)).toEqual([
      ['Unclosed & fine', 'https://a.example/'],
      ['With bold text', 'https://b.example/?x=1&y=2'],
      { 'Folder one': [['Unquoted', 'https://c.example/c']] },
    ]);
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
    expect(countImportableLinks(trees[0]!)).toBe(60_000);
    expect(trees[3]!.children).toEqual([{ kind: 'link', title: 'y', url: 'https://y.example/' }]);
  });

  it('keeps folders with over-long names and counts over-long URLs as skipped', () => {
    const tree = parseBrowserBookmarks({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'N'.repeat(20_000),
          children: [
            { type: 'url', name: 'ok', url: 'https://ok.example/' },
            { type: 'url', name: 'huge', url: `https://huge.example/${'x'.repeat(200_000)}` },
          ],
        },
      },
    });
    const bar = tree.children[0];
    expect(bar?.kind === 'folder' && bar.children.map((c) => (c.kind === 'link' ? c.title : '')).join()).toBe('ok,huge');
    const planned = planGroups(tree, 'folders', 'Imported', { skipped: 0, seen: 0 });
    expect(planned.map((g) => [g.name.length, g.links.length])).toEqual([[100, 2]]);
  });

  it('survives hostile nesting without recursion problems', () => {
    const deep = `${'<DL><p><DT><H3>x</H3>'.repeat(5000)}<DT><A HREF="https://deep.example/">deep</A>${'</DL>'.repeat(5000)}`;
    expect(() => parseNetscapeBookmarks(`<!DOCTYPE NETSCAPE-Bookmark-file-1>${deep}`)).not.toThrow();
    let node: unknown = { type: 'url', name: 'x', url: 'https://x.example/' };
    for (let i = 0; i < 5000; i++) node = { type: 'folder', name: 'f', children: [node] };
    expect(() => parseBrowserBookmarks({ roots: { bookmark_bar: node } })).not.toThrow();
  });
});

describe('bookmarks import: browser profiles', () => {
  let t: BookmarksTestbed;
  let lad: ReturnType<typeof makeLocalAppData>;
  beforeEach(() => {
    lad = makeLocalAppData();
    t = bookmarksTestbed({ localAppData: lad.root });
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
  });
  afterEach(() => {
    t.close();
    lad.cleanup();
  });

  it('lists Chrome and Edge profiles with opaque ids, Local State names and counts', async () => {
    const res = await t.json<BookmarkImportSource[]>('GET', '/api/bookmarks/import/sources');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: sourceId('chrome', 'Default'), browser: 'chrome', profileName: 'Personal', bookmarkCount: 5 },
      { id: sourceId('chrome', 'Profile 2'), browser: 'chrome', profileName: 'Work', bookmarkCount: 1 },
      { id: sourceId('edge', 'Default'), browser: 'edge', profileName: 'Default', bookmarkCount: 1 },
    ]);
    for (const source of res.body) {
      expect(source.id).not.toMatch(/[\\/:]|Default|Profile/);
    }
  });

  it('answers [] when no browser data exists', async () => {
    const empty = bookmarksTestbed({ localAppData: path.join(os.tmpdir(), 'portly-no-such-dir') });
    expect((await empty.json('GET', '/api/bookmarks/import/sources')).body).toEqual([]);
    empty.close();
  });

  it('imports with the folders strategy (folders → groups, non-http(s) skipped and counted)', async () => {
    const res = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/browser', {
      body: { sourceId: sourceId('chrome', 'Default'), targetGroupStrategy: 'folders' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 4, bookmarks: 5, skipped: 3 });
    const groups = (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
    expect(summary(groups)).toEqual([
      ['Bookmarks bar', ['News', 'Mail inbox']],
      ['Dev', ['GitHub']],
      ['Dev / Tools', ['regex101']],
      ['Other bookmarks', ['Recipes']],
    ]);
    expect(groups.flatMap((g) => g.bookmarks.map((b) => b.sort))).toEqual([0, 1, 0, 0, 0]);

    // Re-import: groups are reused and URLs already present are skipped.
    const again = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/browser', {
      body: { sourceId: sourceId('chrome', 'Default'), targetGroupStrategy: 'folders' },
    });
    expect(again.body).toEqual({ groups: 0, bookmarks: 0, skipped: 8 });
  });

  it('imports with the single strategy into one group named after the profile', async () => {
    const res = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/browser', {
      body: { sourceId: sourceId('chrome', 'Default'), targetGroupStrategy: 'single' },
    });
    expect(res.body).toEqual({ groups: 1, bookmarks: 5, skipped: 3 });
    const groups = (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
    expect(summary(groups)).toEqual([['Chrome — Personal', ['News', 'Mail inbox', 'GitHub', 'regex101', 'Recipes']]]);
  });

  it('rejects unknown ids, bad bodies, oversized and invalid files', async () => {
    expect((await t.req('POST', '/api/bookmarks/import/browser', { body: { sourceId: 'C:\\Users\\x\\Bookmarks', targetGroupStrategy: 'folders' } })).status).toBe(404);
    expect((await t.req('POST', '/api/bookmarks/import/browser', { body: { sourceId: 'x', targetGroupStrategy: 'merge' } })).status).toBe(422);

    const file = path.join(lad.root, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
    fs.writeFileSync(file, '{not json');
    const invalid = await t.json<{ error: { code: string } }>('POST', '/api/bookmarks/import/browser', {
      body: { sourceId: sourceId('edge', 'Default'), targetGroupStrategy: 'folders' },
    });
    expect(invalid.status).toBe(422);

    fs.writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
    const big = await t.json<{ error: { code: string } }>('POST', '/api/bookmarks/import/browser', {
      body: { sourceId: sourceId('edge', 'Default'), targetGroupStrategy: 'folders' },
    });
    expect(big.status).toBe(413);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks')?.n).toBe(0);
  });

  it('answers 404 when the file system refuses the bookmarks file, logging the error code with paths masked', async () => {
    const busy = Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks'"), {
      code: 'EBUSY',
      errno: -4082,
      syscall: 'open',
    });
    const realOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('Bookmarks')) throw busy;
      return realOpen(file, ...rest);
    });
    try {
      const res = await t.json<{ error: { code: string; message: string } }>('POST', '/api/bookmarks/import/browser', {
        body: { sourceId: sourceId('chrome', 'Default'), targetGroupStrategy: 'folders' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toEqual({ code: 'not_found', message: 'The bookmarks file could not be read' });
      const line = t.ctx.logs.query({ q: 'browser bookmarks file could not be read' }).records[0];
      expect(line).toMatchObject({ level: 'warn', fields: { browser: 'chrome', errName: 'Error', errCode: 'EBUSY' } });
      expect(String(line?.fields.errMessage)).toContain('C:\\Users\\~\\AppData');
      expect(JSON.stringify(line)).not.toContain('alice');
      // Listing skips the unreadable profile (debug only) instead of failing.
      const sources = await t.json<BookmarkImportSource[]>('GET', '/api/bookmarks/import/sources');
      expect(sources.status).toBe(200);
      expect(sources.body.map((s) => s.browser)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('never logs profile names from an unreadable Local State', async () => {
    const localStatePath = path.join(lad.root, 'Google', 'Chrome', 'User Data', 'Local State');
    // V8 quotes the start of the input here: `Unexpected token 'S', "Secret Per"... is not valid JSON`.
    fs.writeFileSync(localStatePath, 'Secret Person {"profile":{}}');
    const res = await t.json<BookmarkImportSource[]>('GET', '/api/bookmarks/import/sources');
    expect(res.body.find((s) => s.id === sourceId('chrome', 'Default'))?.profileName).toBe('Default');
    const line = t.ctx.logs.query({ q: 'could not read browser Local State' }).records[0];
    expect(line).toMatchObject({ level: 'debug', fields: { browser: 'chrome', errName: 'SyntaxError' } });
    expect(String(line?.fields.errMessage)).toContain('is not valid JSON');
    expect(String(line?.fields.errMessage)).not.toContain('Secret Per');
    expect(JSON.stringify(t.ctx.logs.query({}).records)).not.toContain('Secret Per');
  });

  it('never follows junctioned profile directories or symlinked files out of the browser data directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-outside-'));
    fs.writeFileSync(path.join(outside, 'Bookmarks'), JSON.stringify(chromeBookmarksFile()));
    const userData = path.join(lad.root, 'Google', 'Chrome', 'User Data');
    const created: string[] = [];
    try {
      // A junctioned profile directory is not a profile: not listed, not importable.
      try {
        fs.symlinkSync(outside, path.join(userData, 'Evil'), 'junction');
        created.push(path.join(userData, 'Evil'));
      } catch {
        // junctions unavailable on this system
      }
      // A symlinked Bookmarks file inside a real profile fails the realpath check (403).
      fs.mkdirSync(path.join(userData, 'Profile 9'));
      try {
        fs.symlinkSync(path.join(outside, 'Bookmarks'), path.join(userData, 'Profile 9', 'Bookmarks'), 'file');
      } catch {
        // file symlinks need Developer Mode / admin on Windows
      }
      const sources = (await t.json<BookmarkImportSource[]>('GET', '/api/bookmarks/import/sources')).body;
      expect(sources.some((s) => s.id === sourceId('chrome', 'Evil'))).toBe(false);

      const viaJunction = await t.req('POST', '/api/bookmarks/import/browser', { body: { sourceId: sourceId('chrome', 'Evil'), targetGroupStrategy: 'folders' } });
      expect(viaJunction.status).toBe(404);
      const viaSymlink = await t.json<{ error: { code: string } }>('POST', '/api/bookmarks/import/browser', {
        body: { sourceId: sourceId('chrome', 'Profile 9'), targetGroupStrategy: 'folders' },
      });
      expect([403, 404]).toContain(viaSymlink.status);
      if (fs.existsSync(path.join(userData, 'Profile 9', 'Bookmarks'))) expect(viaSymlink.body.error.code).toBe('forbidden');
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bookmarks')?.n).toBe(0);
    } finally {
      for (const p of created) fs.rmSync(p, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('bookmarks import: Netscape HTML upload', () => {
  let t: BookmarksTestbed;
  beforeEach(() => {
    t = bookmarksTestbed();
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
  });
  afterEach(() => t.close());

  it('imports folders as groups, skipping bookmarklets and place: URLs', async () => {
    const res = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/html', { body: fileForm(NETSCAPE_HTML, 'bookmarks.html') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: 4, bookmarks: 5, skipped: 2 });
    const groups = (await t.json<BookmarksResponse>('GET', '/api/bookmarks')).body.groups;
    expect(summary(groups)).toEqual([
      ['Imported bookmarks', ['Top level']],
      ['Bookmarks bar', ['Tom & Jerry <3', 'Hacker News']],
      ['Dev', ['GitHub']],
      ['Dev / Deep', ['Deep link']],
    ]);
    expect(groups[1]!.bookmarks[0]!.url).toBe('https://example.com/?a=1&b=2');
  });

  it('supports the single strategy field and reports duplicates on re-import', async () => {
    const res = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/html', {
      body: fileForm(NETSCAPE_HTML, 'bookmarks.html', { targetGroupStrategy: 'single' }),
    });
    expect(res.body).toEqual({ groups: 1, bookmarks: 5, skipped: 2 });
    const again = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/html', {
      body: fileForm(NETSCAPE_HTML, 'bookmarks.html', { targetGroupStrategy: 'single' }),
    });
    expect(again.body).toEqual({ groups: 0, bookmarks: 0, skipped: 7 });
    expect((await t.req('POST', '/api/bookmarks/import/html', { body: fileForm(NETSCAPE_HTML, 'b.html', { targetGroupStrategy: 'x' }) })).status).toBe(422);
  });

  it('rejects files that are not bookmark exports and non-multipart bodies', async () => {
    const res = await t.json<{ error: { code: string } }>('POST', '/api/bookmarks/import/html', { body: fileForm('<html><p>hi</p></html>', 'x.html') });
    expect(res.status).toBe(422);
    expect((await t.req('POST', '/api/bookmarks/import/html', { body: { file: NETSCAPE_HTML } })).status).toBe(400);
  });

  it('queues favicon resolution for imported bookmarks when auto-fetch is on', async () => {
    t.close();
    t = bookmarksTestbed({ fetchRoutes: [{ match: /./, respond: { status: 404, text: '' } }] });
    const res = await t.json<BookmarkImportReport>('POST', '/api/bookmarks/import/html', { body: fileForm(NETSCAPE_HTML, 'b.html') });
    expect(res.body.bookmarks).toBe(5);
    await t.favicons.idle();
    const hosts = new Set(t.ctx.fakeFetch!.calls.map((c) => new URL(c.url).hostname));
    expect(hosts.has('github.com')).toBe(true);
    expect(hosts.has('deep.example')).toBe(true);
  });
});
