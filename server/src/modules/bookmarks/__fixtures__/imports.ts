/**
 * Import fixtures: a Chrome/Edge `Bookmarks` JSON file (as written by Chromium, trimmed), a
 * `Local State` file, and a Netscape bookmark HTML export (as written by Chrome/Firefox).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let counter = 0;
const url = (u: string, name: string) => ({ date_added: '13300000000000000', guid: `g${++counter}`, id: String(counter), name, type: 'url', url: u });
const folder = (name: string, children: unknown[]) => ({
  children,
  date_added: '13300000000000000',
  date_modified: '0',
  guid: `f${++counter}`,
  id: String(counter),
  name,
  type: 'folder',
});

/** Chromium `Bookmarks` file: bar links, a nested folder, a bookmarklet, other + synced roots. */
export function chromeBookmarksFile() {
  return {
    checksum: '0123456789abcdef',
    roots: {
      bookmark_bar: folder('Bookmarks bar', [
        url('https://news.example.com/', 'News'),
        url('javascript:(function(){alert(1)})()', 'Bookmarklet'),
        folder('Dev', [
          url('https://github.com/', 'GitHub'),
          folder('Tools', [url('https://regex101.com/', 'regex101'), url('chrome://settings/', 'Settings')]),
        ]),
        url('https://mail.example.com/', '  Mail   inbox '),
      ]),
      other: folder('Other bookmarks', [url('https://recipes.example.org/', 'Recipes'), url('file:///C:/secret.txt', 'Local file')]),
      synced: folder('Mobile bookmarks', []),
    },
    version: 1,
  };
}

export function localState(names: Record<string, string>) {
  return {
    browser: { enabled_labs_experiments: [] },
    profile: { info_cache: Object.fromEntries(Object.entries(names).map(([dir, name]) => [dir, { name, avatar_icon: 'x' }])) },
  };
}

/** Creates a fake `%LOCALAPPDATA%` with Chrome (Default + Profile 2) and Edge (Default) profiles. */
export function makeLocalAppData(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-lad-'));
  const chrome = path.join(root, 'Google', 'Chrome', 'User Data');
  const edge = path.join(root, 'Microsoft', 'Edge', 'User Data');
  for (const dir of [path.join(chrome, 'Default'), path.join(chrome, 'Profile 2'), path.join(chrome, 'System Profile'), path.join(edge, 'Default')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(chrome, 'Default', 'Bookmarks'), JSON.stringify(chromeBookmarksFile()));
  fs.writeFileSync(
    path.join(chrome, 'Profile 2', 'Bookmarks'),
    JSON.stringify({ roots: { bookmark_bar: folder('Bookmarks bar', [url('https://work.example/', 'Work')]), other: folder('Other bookmarks', []) } }),
  );
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify(localState({ Default: 'Personal', 'Profile 2': 'Work' })));
  fs.writeFileSync(
    path.join(edge, 'Default', 'Bookmarks'),
    JSON.stringify({ roots: { bookmark_bar: folder('Favorites bar', [url('https://bing.com/', 'Bing')]), other: folder('Other favorites', []) } }),
  );
  // No Local State for Edge: the directory name is shown.
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Netscape bookmark file (Chrome export shape) with nesting, entities and non-http entries. */
export const NETSCAPE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1700000000" ICON="data:image/png;base64,iVBORw0KGgo=">Tom &amp; Jerry &lt;3</A>
        <DT><H3 ADD_DATE="1700000000">Dev</H3>
        <DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub</A>
            <DT><A HREF="javascript:void(document.body.style.background='red')">Bookmarklet</A>
            <DT><H3>Deep</H3>
            <DL><p>
                <DT><A HREF="https://deep.example/">Deep link</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
        <DD>A description line
        <DT><A HREF="place:sort=8&maxResults=10">Recently tagged</A>
    </DL><p>
    <DT><A HREF="https://top-level.example/">Top level</A>
    <DT><H3>Empty folder</H3>
    <DL><p>
    </DL><p>
</DL><p>
`;
