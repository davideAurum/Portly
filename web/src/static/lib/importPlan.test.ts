import { describe, expect, it } from 'vitest';
import { NETSCAPE_HTML } from './__fixtures__/netscape.ts';
import { parseNetscapeBookmarks } from './importHtml.ts';
import { MAX_FOLDER_DEPTH, MAX_IMPORT_ENTRIES, countLinks, groupName, planGroups, type ImportFolder, type ImportLink } from './importPlan.ts';

const link = (title: string, url = `https://${title.toLowerCase().replace(/\W+/g, '-')}.example/`): ImportLink => ({ kind: 'link', title, url });
const folder = (name: string, children: (ImportFolder | ImportLink)[]): ImportFolder => ({ kind: 'folder', name, children });
const summary = (groups: { name: string; links: ImportLink[] }[]) => groups.map((g) => [g.name, g.links.map((l) => l.title)]);

describe('planGroups', () => {
  it('folders strategy: top-level links → fallback, depth-1 folders keep their name, deeper → path below the top', () => {
    const counter = { skipped: 0, seen: 0 };
    const planned = planGroups(parseNetscapeBookmarks(NETSCAPE_HTML), 'folders', 'Imported bookmarks', counter);
    expect(summary(planned)).toEqual([
      ['Imported bookmarks', ['Top level']],
      ['Bookmarks bar', ['Tom & Jerry <3', 'Hacker News', 'Recently tagged']],
      ['Dev', ['GitHub', 'Bookmarklet']],
      ['Dev / Deep', ['Deep link']],
    ]);
    // URLs are not filtered here (the writer skips bookmarklets and `place:` entries).
    expect(planned[2]!.links[1]!.url.startsWith('javascript:')).toBe(true);
    expect(counter).toEqual({ skipped: 0, seen: 11 });
  });

  it('single strategy: everything into the fallback group in document order', () => {
    const counter = { skipped: 0, seen: 0 };
    const planned = planGroups(parseNetscapeBookmarks(NETSCAPE_HTML), 'single', 'Chrome — Personal', counter);
    expect(summary(planned)).toEqual([['Chrome — Personal', ['Top level', 'Tom & Jerry <3', 'Hacker News', 'Recently tagged', 'GitHub', 'Bookmarklet', 'Deep link']]]);
  });

  it('mirrors the Chromium tree shape: "Bookmarks bar/Dev/Tools" becomes "Dev / Tools"', () => {
    const tree = folder('', [
      folder('Bookmarks bar', [link('News'), link('Bookmarklet', 'javascript:1'), folder('Dev', [link('GitHub'), folder('Tools', [link('regex101')])]), link('  Mail   inbox ')]),
      folder('Other bookmarks', [link('Recipes')]),
      folder('Mobile bookmarks', []),
    ]);
    const planned = planGroups(tree, 'folders', 'Imported', { skipped: 0, seen: 0 });
    // Depth-first like the server: a top-level folder's subtree is planned before its siblings
    // (imports.test.ts expects Bookmarks bar, Dev, Dev / Tools, Other bookmarks).
    expect(summary(planned)).toEqual([
      ['Bookmarks bar', ['News', 'Bookmarklet', '  Mail   inbox ']],
      ['Dev', ['GitHub']],
      ['Dev / Tools', ['regex101']],
      ['Other bookmarks', ['Recipes']],
    ]);
  });

  it('merges groups whose names differ only by case and cleans folder labels', () => {
    const tree = folder('', [folder('Dev', [link('A')]), folder('  dev ', [link('B')]), folder('\u0000', [link('C')]), folder('x', [folder('  Inner\n  Space ', [link('D')])])]);
    const planned = planGroups(tree, 'folders', 'Imported', { skipped: 0, seen: 0 });
    expect(summary(planned)).toEqual([
      ['Dev', ['A', 'B']],
      ['Untitled folder', ['C']],
      ['Inner Space', ['D']],
    ]);
  });

  it('keeps folders with over-long names (capped to 100 chars) and uses the fallback for unusable names', () => {
    const tree = folder('', [folder('N'.repeat(20_000), [link('ok'), link('huge', `https://huge.example/${'x'.repeat(200_000)}`)])]);
    const planned = planGroups(tree, 'folders', 'Imported', { skipped: 0, seen: 0 });
    expect(planned.map((g) => [g.name.length, g.links.length])).toEqual([[100, 2]]);
    expect(planned[0]!.name.endsWith('…')).toBe(true);
    // A fallback name that is itself invalid is passed through (the caller sanitizes it, like the server).
    expect(groupName('', 'Imported bookmarks')).toBe('Imported bookmarks');
  });

  it('skips links below MAX_FOLDER_DEPTH and counts them', () => {
    let deep: ImportFolder = folder('f65', [link('too deep'), folder('f66', [link('deeper')])]);
    for (let i = 64; i >= 1; i--) deep = folder(`f${i}`, i === 64 ? [link('at 64'), deep] : [deep]);
    const counter = { skipped: 0, seen: 0 };
    const planned = planGroups(folder('', [deep]), 'folders', 'Imported', counter);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.links.map((l) => l.title)).toEqual(['at 64']);
    expect(planned[0]!.name.startsWith('f2 / f3 / f4')).toBe(true);
    expect(planned[0]!.name).toHaveLength(100);
    expect(counter.skipped).toBe(2);
    expect(MAX_FOLDER_DEPTH).toBe(64);
  });

  it('stops examining entries past MAX_IMPORT_ENTRIES and counts the rest as skipped', () => {
    const many = folder('', Array.from({ length: MAX_IMPORT_ENTRIES + 3 }, (_, i) => link(`L${i}`, `https://l${i}.example/`)));
    const counter = { skipped: 0, seen: 0 };
    const planned = planGroups(many, 'single', 'All', counter);
    expect(planned[0]!.links).toHaveLength(MAX_IMPORT_ENTRIES);
    expect(counter).toEqual({ skipped: 3, seen: MAX_IMPORT_ENTRIES + 3 });
  });

  it('countLinks counts every link below a folder, iteratively', () => {
    expect(countLinks(folder('', []))).toBe(0);
    let nested: ImportFolder = folder('leaf', [link('x')]);
    for (let i = 0; i < 20_000; i++) nested = folder('n', [nested, link('y')]);
    expect(countLinks(nested)).toBe(20_001);
  });
});

describe('groupName', () => {
  it('cleans whitespace and control characters, caps at 100 code points and falls back when empty', () => {
    expect(groupName('  My   Folder ', 'x')).toBe('My Folder');
    expect(groupName('a\u0000b\tc\n', 'x')).toBe('a b c');
    expect(groupName('', 'Fallback')).toBe('Fallback');
    expect(groupName('\u0001\u0002', 'Fallback')).toBe('Fallback');
    const long = groupName('😀'.repeat(150), 'x');
    expect(Array.from(long)).toHaveLength(100);
    expect(long.endsWith('…')).toBe(true);
    expect(groupName('x'.repeat(100), 'f')).toBe('x'.repeat(100));
  });
});
