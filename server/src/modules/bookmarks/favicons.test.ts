import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark, BookmarkGroup, SiteMeta } from '@homebase/shared';
import { IMAGE_SAMPLES } from '../../lib/__fixtures__/images.ts';
import { IMAGE_CACHE_CONTROL, IMAGE_CSP } from '../../security/headers.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { createMemoryLogger } from '../../lib/logger.ts';
import type { FakeFetchRoute } from '../../testing/fake-fetch.ts';
import { createSafeFetch, type SafeFetch } from '../../security/safe-fetch.ts';
import { createFakeFetch } from '../../testing/fake-fetch.ts';
import {
  HTML_HEADERS,
  SVG_ICON,
  bookmarksTestbed,
  fileForm,
  html,
  ico,
  png,
  type BookmarksTestbed,
  type BookmarksTestbedOptions,
} from './__fixtures__/setup.ts';
import { DAY_MS, candidateScore, createFaviconService, rankCandidates, resolveFavicon, traceFavicon } from './favicons.ts';
import { brandFromUrl, cleanTitle, parseManifest, parsePage, parseSizes } from './html.ts';
import { imageSize } from './image-size.ts';

const silent = createMemoryLogger();

function resolverDeps(routes: FakeFetchRoute[]) {
  const fake = createFakeFetch(routes);
  return { fake, deps: { fetch: createSafeFetch({ version: 'test', log: silent, fetchImpl: fake }), log: silent } };
}

describe('favicons: HTML parsing', () => {
  it('extracts title, icon links (resolved against <base>/final URL) and the manifest', () => {
    const page = parsePage(
      html(`
        <title>  Example &amp; Co —
          Home </title>
        <base href="/app/">
        <link rel="icon" href="icon-16.png" sizes="16x16">
        <link rel="SHORTCUT ICON" href="/favicon.ico">
        <link rel="icon" type="image/svg+xml" href="https://cdn.example.com/logo.svg">
        <link rel="apple-touch-icon" href="touch.png">
        <link rel="mask-icon" href="mask.svg">
        <link rel="icon" href="javascript:alert(1)">
        <link rel="manifest" href="/site.webmanifest">
      `, '<svg><title>not the page title</title></svg>'),
      'https://www.example.com/start',
    );
    // The part that names the site (UX-1), not the whole "Example & Co — Home".
    expect(page.title).toBe('Example & Co');
    expect(page.manifestUrl).toBe('https://www.example.com/site.webmanifest');
    expect(page.icons).toEqual([
      { url: 'https://www.example.com/app/icon-16.png', size: 16, svg: false, source: 'icon' },
      { url: 'https://www.example.com/favicon.ico', size: null, svg: false, source: 'icon' },
      { url: 'https://cdn.example.com/logo.svg', size: null, svg: true, source: 'icon' },
      { url: 'https://www.example.com/app/touch.png', size: null, svg: false, source: 'apple' },
    ]);
  });

  it.each([
    ['https://github.com/', '<title>GitHub · Change is constant. GitHub keeps you ahead. · GitHub</title>', 'GitHub'],
    ['https://www.bbc.com/news', '<title>BBC News - Breaking news, video and the latest top stories from the U.S. and around the world</title>', 'BBC News'],
    ['https://www.amazon.com/', '<title>Amazon.com. Spend less. Smile more.</title>', 'Amazon.com'],
    ['https://www.wikipedia.org/', '<title>Wikipedia, the free encyclopedia</title>', 'Wikipedia'],
    ['https://docs.example.com/', '<title>Getting started | Example Docs</title>', 'Example Docs'],
    ['https://blog.example.com/', '<title>How we moved to Postgres</title>', 'How we moved to Postgres'],
    ['https://www.youtube.com/', '<title>YouTube</title><meta property="og:site_name" content="YouTube">', 'YouTube'],
    ['https://news.example.com/', '<title>Front page — The Daily Example: all the news</title><meta name="application-name" content="Daily Example">', 'Daily Example'],
    ['https://app.example.com/', '<title>Inbox (3)</title><meta name="apple-mobile-web-app-title" content="A very long application name that is not really a short site name at all">', 'Inbox (3)'],
  ])('names the bookmark after the site: %s (UX-1)', (url, head, expected) => {
    expect(parsePage(html(head), url).title).toBe(expected);
  });

  it('falls back to og:title and caps/cleans titles', () => {
    expect(parsePage(html('<meta property="og:title" content="OG &quot;Title&quot;">'), 'https://e.com/').title).toBe('OG "Title"');
    expect(parsePage(html('<title>   </title>'), 'https://e.com/').title).toBeNull();
    const long = cleanTitle('x'.repeat(500));
    expect(Array.from(long!)).toHaveLength(300);
    expect(long!.endsWith('…')).toBe(true);
    expect(cleanTitle('a\u0000b\n\tc')).toBe('a b c');
  });

  it('ignores commented-out, scripted and raw-text markup', () => {
    const page = parsePage(
      html(`
        <!-- <link rel="icon" href="/commented.png"> <title>commented</title> -->
        <script>document.write('<link rel="icon" href="/scripted.png"><title>scripted</title>')</script>
        <noscript><link rel="icon" href="/noscript.png"></noscript>
        <style>/* <link rel="icon" href="/styled.png"> */</style>
        <title>Real &lt;title&gt; with <b>markup</b> as text</title>
        <link rel=icon href=/real.png>
      `),
      'https://e.com/',
    );
    expect(page.title).toBe('Real <title> with <b>markup</b> as text');
    expect(page.icons.map((i) => i.url)).toEqual(['https://e.com/real.png']);
    // An unterminated comment hides the rest of the document, as in browsers.
    expect(parsePage('<title>t</title><!-- <link rel="icon" href="/x.png">', 'https://e.com/').icons).toEqual([]);
  });

  it('parses hostile pages in linear time (no tree of the whole document)', () => {
    // node-html-parser needed about two minutes for 10 000 unclosed <div>s (50 KB) and was
    // quadratic on unterminated comments/tags: a hostile bookmark page could hang the server.
    const hostile = [
      `<title>Deep</title>${'<div>'.repeat(200_000)}<link rel="icon" href="/deep.png">`,
      `<title>Comments</title><link rel="icon" href="/c.png">${'<!--'.repeat(200_000)}`,
      `<title>Tags</title><link rel="icon" href="/t.png">${'<a '.repeat(300_000)}`,
      `<title>Titles</title><link rel="icon" href="/ti.png">${'<title>'.repeat(200_000)}</title>`,
      `<title>Quotes</title><link rel="icon" href="/q.png">${'<p x="'.repeat(200_000)}`,
    ];
    const started = performance.now();
    const pages = hostile.map((doc) => parsePage(doc, 'https://e.com/'));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(pages.map((p) => p.title)).toEqual(['Deep', 'Comments', 'Tags', 'Titles', 'Quotes']);
    expect(pages.map((p) => p.icons[0]?.url)).toEqual([
      'https://e.com/deep.png',
      'https://e.com/c.png',
      'https://e.com/t.png',
      'https://e.com/ti.png',
      'https://e.com/q.png',
    ]);
  });

  it('parses sizes and manifest icons', () => {
    expect(parseSizes('16x16 32x32 48X48')).toBe(48);
    expect(parseSizes('any')).toBe(Number.POSITIVE_INFINITY);
    expect(parseSizes('bogus')).toBeNull();
    expect(
      parseManifest(
        {
          icons: [
            { src: '/a-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'mono.png', sizes: '512x512', purpose: 'monochrome' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
        'https://e.com/static/manifest.json',
      ),
    ).toEqual([
      { url: 'https://e.com/a-192.png', size: 192, svg: false, source: 'manifest' },
      { url: 'https://e.com/static/icon.svg', size: null, svg: true, source: 'manifest' },
    ]);
    expect(parseManifest({ nope: true }, 'https://e.com/')).toEqual([]);
  });

  it('ranks SVG, then large rasters, unknown sizes, then small ones', () => {
    const ranked = rankCandidates([
      { url: 'a', size: 16, svg: false, source: 'icon' },
      { url: 'b', size: null, svg: false, source: 'icon' },
      { url: 'c', size: 64, svg: false, source: 'icon' },
      { url: 'd', size: 1024, svg: false, source: 'icon' },
      { url: 'e', size: null, svg: true, source: 'icon' },
      { url: 'f', size: null, svg: false, source: 'apple' },
    ]);
    expect(ranked.map((c) => c.url)).toEqual(['e', 'd', 'f', 'c', 'b', 'a']);
    expect(candidateScore({ url: 'x', size: 32, svg: false, source: 'icon' })).toBeGreaterThan(candidateScore({ url: 'y', size: null, svg: false, source: 'icon' }));
  });

  it('reads image sizes from headers', () => {
    expect(imageSize(png(180, 90), 'image/png')).toBe(180);
    expect(imageSize(ico(16, 32, 48), 'image/x-icon')).toBe(48);
    expect(imageSize(ico(256), 'image/x-icon')).toBe(256);
    expect(imageSize(IMAGE_SAMPLES.gif, 'image/gif')).toBe(1);
    expect(imageSize(SVG_ICON, 'image/svg+xml')).toBeNull();
  });
});

describe('favicons: resolver chain', () => {
  it('prefers the largest declared raster ≥ 32 px and stops there', async () => {
    const { fake, deps } = resolverDeps([
      {
        match: /^https:\/\/site\.example\/$/,
        respond: {
          headers: HTML_HEADERS,
          text: html('<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/192.png" sizes="192x192"><link rel="icon" href="/64.png" sizes="64x64">'),
        },
      },
      { match: 'https://site.example/192.png', respond: { body: png(192) } },
    ]);
    const image = await resolveFavicon(deps, 'https://site.example/');
    expect(image).toMatchObject({ contentType: 'image/png', width: 192 });
    expect(fake.calls.map((c) => c.url)).toEqual(['https://site.example/', 'https://site.example/192.png']);
  });

  it('uses the manifest when the links offer nothing good, then keeps the best image seen', async () => {
    const { fake, deps } = resolverDeps([
      {
        match: /^https:\/\/app\.example\/$/,
        respond: { headers: HTML_HEADERS, text: html('<link rel="icon" href="/tiny.ico"><link rel="manifest" href="/m.json">') },
      },
      { match: 'https://app.example/tiny.ico', respond: { body: ico(16) } },
      { match: 'https://app.example/m.json', respond: { json: { icons: [{ src: '/i/512.png', sizes: '512x512' }] } } },
      { match: 'https://app.example/i/512.png', respond: { body: png(512) } },
    ]);
    const image = await resolveFavicon(deps, 'https://app.example/');
    expect(image?.width).toBe(512);
    expect(fake.calls.map((c) => new URL(c.url).pathname)).toEqual(['/', '/tiny.ico', '/m.json', '/i/512.png']);
  });

  it('decodes data: icons locally, sniffing the bytes', async () => {
    const dataUrl = `data:image/png;base64,${png(48).toString('base64')}`;
    const { fake, deps } = resolverDeps([
      { match: 'https://data.example/', respond: { headers: HTML_HEADERS, text: html(`<link rel="icon" href="${dataUrl}" sizes="48x48">`) } },
    ]);
    expect(await resolveFavicon(deps, 'https://data.example/')).toMatchObject({ contentType: 'image/png', width: 48 });
    expect(fake.calls).toHaveLength(1);
  });

  it('falls back to /favicon.ico, then DuckDuckGo, then Google s2 (non-2xx and non-images are misses)', async () => {
    const { fake, deps } = resolverDeps([
      { match: 'https://plain.example/page', respond: { status: 404, text: 'nope' } },
      { match: 'https://plain.example/favicon.ico', respond: { headers: HTML_HEADERS, text: '<html>not an icon</html>' } },
      { match: 'https://icons.duckduckgo.com/ip3/plain.example.ico', respond: { status: 404, body: ico(16) } },
      { match: 'https://www.google.com/s2/favicons?domain=plain.example&sz=128', respond: { body: png(128) } },
    ]);
    expect(await resolveFavicon(deps, 'https://plain.example/page')).toMatchObject({ width: 128 });
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://plain.example/page',
      'https://plain.example/favicon.ico',
      'https://icons.duckduckgo.com/ip3/plain.example.ico',
      'https://www.google.com/s2/favicons?domain=plain.example&sz=128',
    ]);
  });

  it('tells which step gave the kept image, how many downloads were tried, and each request purpose', async () => {
    const { fake, deps } = resolverDeps([
      {
        match: /^https:\/\/app\.example\/$/,
        respond: { headers: HTML_HEADERS, text: html('<link rel="icon" href="/tiny.ico"><link rel="manifest" href="/m.json">') },
      },
      { match: 'https://app.example/tiny.ico', respond: { body: ico(16) } },
      { match: 'https://app.example/m.json', respond: { json: { icons: [{ src: '/i/512.png', sizes: '512x512' }] } } },
      { match: 'https://app.example/i/512.png', respond: { body: png(512) } },
    ]);
    const purposes: (string | undefined)[] = [];
    const spying = { ...deps, fetch: (async (url, options) => (purposes.push(options.purpose), deps.fetch(url, options))) as SafeFetch };
    const found = await traceFavicon(spying, 'https://app.example/');
    expect(found).toMatchObject({ step: 'manifest', attempts: 2, image: { width: 512 } });
    expect(purposes).toEqual(['favicon.page', 'favicon.link', 'favicon.manifest', 'favicon.manifest']);
    expect(fake.calls).toHaveLength(4);

    const fallback = resolverDeps([
      { match: 'https://plain.example/', respond: { status: 404, text: 'nope' } },
      { match: 'https://plain.example/favicon.ico', respond: { status: 404 } },
      { match: 'https://icons.duckduckgo.com/ip3/plain.example.ico', respond: { body: png(64) } },
    ]);
    expect(await traceFavicon(fallback.deps, 'https://plain.example/')).toMatchObject({ step: 'duckduckgo', attempts: 2 });
    expect(await traceFavicon(fallback.deps, 'not a url')).toEqual({ image: null, step: null, attempts: 0 });
  });

  it('never asks DuckDuckGo/Google about local-looking hosts', async () => {
    for (const url of ['https://nas.local/', 'http://router.lan:8080/', 'https://intranet/', 'https://build.corp.internal/', 'http://printer.home.arpa/']) {
      const { fake, deps } = resolverDeps([{ match: /./, respond: { status: 404, text: 'x' } }]);
      expect(await resolveFavicon(deps, url), url).toBeNull();
      expect(fake.calls.some((c) => /duckduckgo|google/.test(c.url)), url).toBe(false);
    }
    // Private IP literals are refused by safe-fetch before any request and are not sent to third parties either.
    const { fake, deps } = resolverDeps([]);
    expect(await resolveFavicon(deps, 'http://192.168.1.10/')).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('favicons: storage, dedupe, site-meta and the icon route', () => {
  let t: BookmarksTestbed;
  afterEach(() => t.close());

  const setup = async (routes: FakeFetchRoute[], options: BookmarksTestbedOptions = {}) => {
    t = bookmarksTestbed({ fetchRoutes: routes, ...options });
    const group = (await t.json<BookmarkGroup>('POST', '/api/bookmark-groups', { body: { name: 'G' } })).body;
    return group;
  };
  const siteRoutes = (host: string, size = 64): FakeFetchRoute[] => [
    { match: new RegExp(`^https://${host.replace('.', '\\.')}/(\\?.*|page.*)?$`), respond: { headers: HTML_HEADERS, text: html(`<title>${host} home</title><link rel="icon" href="/i.png" sizes="${size}x${size}">`) } },
    { match: `https://${host}/i.png`, respond: { body: png(size) } },
  ];

  it('resolves asynchronously after create, dedupes per host and links every bookmark of the host', async () => {
    const group = await setup(siteRoutes('one.example'));
    const created = await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'One', url: 'https://one.example/' } });
    expect(created.status).toBe(201);
    expect(created.body.iconId).toBeNull(); // creation does not wait for the icon
    await t.favicons.idle();
    const after = await t.json<{ groups: BookmarkGroup[] }>('GET', '/api/bookmarks');
    const iconId = after.body.groups[0]!.bookmarks[0]!.iconId;
    expect(iconId).toMatch(/^[0-9a-f-]{36}$/);

    // Same host: linked immediately, no new fetch.
    const calls = t.ctx.fakeFetch!.calls.length;
    const second = await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Two', url: 'https://one.example/page2' } });
    expect(second.body.iconId).toBe(iconId);
    await t.favicons.idle();
    expect(t.ctx.fakeFetch!.calls.length).toBe(calls);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM icons WHERE kind = 'favicon'")?.n).toBe(1);
    expect(t.ctx.db.get<{ source_host: string; width: number }>('SELECT source_host, width FROM icons')).toEqual({ source_host: 'one.example', width: 64 });
  });

  it('logs each resolution at debug: the host, the step that gave the icon, or the miss and its retry time', async () => {
    const group = await setup([
      ...siteRoutes('one.example'),
      { match: /^https:\/\/gone\.example\//, respond: { status: 404, text: 'x' } },
      { match: /duckduckgo|google/, respond: { status: 404, text: 'x' } },
    ]);
    await t.req('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'One', url: 'https://one.example/page/private-path?q=1' } });
    await t.req('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Gone', url: 'https://gone.example/secret-page' } });
    await t.favicons.idle();

    const resolved = t.ctx.logs.query({ q: 'favicon resolved' }).records;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ level: 'debug', area: 'bookmarks', fields: { host: 'one.example', step: 'link', attempts: 1, op: 'favicon' } });
    expect(resolved[0]!.fields.ms).toEqual(expect.any(Number));

    const miss = t.ctx.logs.query({ q: 'favicon miss' }).records;
    expect(miss).toHaveLength(1);
    expect(miss[0]).toMatchObject({ level: 'debug', fields: { host: 'gone.example', attempts: 3 } });
    expect(Date.parse(String(miss[0]!.fields.retryAt))).toBeGreaterThan(Date.now() + DAY_MS - 60_000);

    const everything = JSON.stringify(t.ctx.logs.query({}).records);
    expect(everything).not.toContain('private-path');
    expect(everything).not.toContain('secret-page');
  });

  it('runs each queued resolution in the context of whoever queued it, not of the job before it', async () => {
    t = bookmarksTestbed({ fetchRoutes: [...siteRoutes('one.example'), ...siteRoutes('two.example')] });
    const favicons = createFaviconService({
      db: t.ctx.db,
      fetch: t.ctx.fetch,
      log: t.ctx.log,
      autoFetch: () => true,
      externalReferences: () => [],
      concurrency: 1,
    });
    withLogContext({ rid: 'requesta01' }, () => favicons.enqueue('https://one.example/'));
    // Waits behind the first job (concurrency 1), so that job's completion starts it.
    withLogContext({ area: 'bookmarks', job: 'bookmarks:icons', run: 'run002' }, () => favicons.enqueue('https://two.example/'));
    await favicons.idle();

    const lines = t.ctx.logs.query({}).records.filter((r) => r.msg === 'favicon resolved' || r.msg === 'outbound');
    const contexts = (host: string) => [...new Set(lines.filter((r) => r.fields.host === host).map((r) => [r.rid, r.fields.job, r.fields.run].join('|')))];
    expect(contexts('one.example')).toEqual(['requesta01||']);
    expect(contexts('two.example')).toEqual(['|bookmarks:icons|run002']);
    expect(lines.filter((r) => r.msg === 'favicon resolved')).toHaveLength(2);
  });

  it('serves icons with the sniffed type, sandbox CSP and private cache headers (gate-exempt image route)', async () => {
    const group = await setup(siteRoutes('one.example'));
    await t.req('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'One', url: 'https://one.example/' } });
    await t.favicons.idle();
    const iconId = t.ctx.db.get<{ id: string }>('SELECT id FROM icons')!.id;

    // An <img> load: no X-Homebase header.
    const res = await t.req('GET', `/api/icons/${iconId}`, { headers: { 'X-Homebase': null, 'Sec-Fetch-Site': 'same-origin' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toBe(IMAGE_CSP);
    expect(res.headers.get('cache-control')).toBe(IMAGE_CACHE_CONTROL);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png(64));

    expect((await t.req('GET', `/api/icons/${iconId}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    const missing = await t.req('GET', '/api/icons/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect((await t.req('GET', '/api/icons/not-a-uuid')).status).toBe(404);

    // A row whose bytes no longer match its type is never served.
    t.ctx.db.run("UPDATE icons SET content_type = 'image/gif' WHERE id = ?", [iconId]);
    expect((await t.req('GET', `/api/icons/${iconId}`)).status).toBe(404);
  });

  it('GET /api/site-meta returns the decoded title and the icon (fetching the page once)', async () => {
    await setup(siteRoutes('meta.example', 96));
    const res = await t.json<SiteMeta>('GET', `/api/site-meta?url=${encodeURIComponent('https://meta.example/')}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('meta.example home');
    expect(res.body.iconId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.ctx.fakeFetch!.calls.map((c) => c.url)).toEqual(['https://meta.example/', 'https://meta.example/i.png']);
    // Cached.
    await t.json('GET', `/api/site-meta?url=${encodeURIComponent('https://meta.example/')}`);
    expect(t.ctx.fakeFetch!.calls).toHaveLength(2);

    expect((await t.req('GET', `/api/site-meta?url=${encodeURIComponent('javascript:alert(1)')}`)).status).toBe(422);
    expect((await t.req('GET', '/api/site-meta')).status).toBe(422);
  });

  it('site-meta answers with the title when the icon is slow, and reports the icon once it lands', async () => {
    let release: () => void = () => undefined;
    const iconGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await setup(
      [
        { match: /^https:\/\/slow\.example\/$/, respond: { headers: HTML_HEADERS, text: html('<title>Slow icons</title><link rel="icon" href="/i.png" sizes="64x64">') } },
        { match: 'https://slow.example/i.png', respond: async () => (await iconGate, { body: png(64) }) },
      ],
      { siteMetaIconBudgetMs: 30 },
    );
    const url = `/api/site-meta?url=${encodeURIComponent('https://slow.example/')}`;
    // Before the fix the title waited for the whole favicon chain (up to ~50 s for slow hosts).
    expect((await t.json<SiteMeta>('GET', url)).body).toEqual({ title: 'Slow icons', iconId: null });
    release();
    await vi.waitFor(() => expect(t.favicons.hostIcon('slow.example')).not.toBeNull());
    // The cached answer picks up the icon resolved in the background.
    expect((await t.json<SiteMeta>('GET', url)).body).toEqual({ title: 'Slow icons', iconId: t.favicons.hostIcon('slow.example') });
    expect(t.ctx.fakeFetch!.calls.filter((c) => c.url === 'https://slow.example/')).toHaveLength(1);
  });

  it('refresh-icon answers within its budget and links the icon when it lands', async () => {
    let release: () => void = () => undefined;
    const iconGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const group = await setup(
      [
        { match: /^https:\/\/slowrefresh\.example\/$/, respond: { headers: HTML_HEADERS, text: html('<link rel="icon" href="/i.png" sizes="64x64">') } },
        { match: 'https://slowrefresh.example/i.png', respond: async () => (await iconGate, { body: png(64) }) },
      ],
      { refreshIconBudgetMs: 30 },
    );
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
    const created = (await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'S', url: 'https://slowrefresh.example/' } })).body;
    const refreshed = await t.json<Bookmark>('POST', `/api/bookmarks/${created.id}/refresh-icon`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.iconId).toBeNull();
    release();
    await vi.waitFor(async () => {
      const list = (await t.json<{ groups: BookmarkGroup[] }>('GET', '/api/bookmarks')).body;
      expect(list.groups[0]!.bookmarks[0]!.iconId).toBe(t.favicons.hostIcon('slowrefresh.example'));
      expect(list.groups[0]!.bookmarks[0]!.iconId).not.toBeNull();
    });
  });

  it('brands unreadable pages after their registrable domain', () => {
    expect(brandFromUrl('https://www.netflix.com/browse')).toBe('Netflix');
    expect(brandFromUrl('https://stackoverflow.com/')).toBe('Stackoverflow');
    expect(brandFromUrl('https://news.bbc.co.uk/')).toBe('Bbc');
    expect(brandFromUrl('http://10.0.0.1/')).toBeNull();
    expect(brandFromUrl('http://nas/')).toBeNull();
  });

  it('site-meta decodes legacy charsets and answers nulls when the page is unreachable', async () => {
    const latin1 = Buffer.concat([Buffer.from('<html><head><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></head></html>')]);
    await setup([
      { match: 'https://legacy.example/', respond: { headers: { 'content-type': 'text/html; charset=windows-1252' }, body: latin1 } },
      { match: 'https://legacy.example/favicon.ico', respond: { status: 404, text: '' } },
      { match: 'duckduckgo', respond: { status: 404, text: '' } },
      { match: 'google', respond: { status: 404, text: '' } },
    ]);
    expect((await t.json<SiteMeta>('GET', `/api/site-meta?url=${encodeURIComponent('https://legacy.example/')}`)).body).toEqual({ title: 'Café', iconId: null });
    // A private address is refused by safe-fetch: no request at all.
    const before = t.ctx.fakeFetch!.calls.length;
    expect((await t.json<SiteMeta>('GET', `/api/site-meta?url=${encodeURIComponent('http://10.0.0.1/')}`)).body).toEqual({ title: null, iconId: null });
    expect(t.ctx.fakeFetch!.calls.length).toBe(before);
  });

  it('honours autoFetchIcons=false (no background fetches) while refresh-icon still works', async () => {
    const group = await setup(siteRoutes('off.example'));
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
    const created = await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Off', url: 'https://off.example/' } });
    await t.favicons.idle();
    await t.ctx.scheduler.runAll();
    expect(t.ctx.fakeFetch!.calls).toHaveLength(0);
    const refreshed = await t.json<Bookmark>('POST', `/api/bookmarks/${created.body.id}/refresh-icon`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.iconId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refreshes favicons older than 30 days with a new id and repoints bookmarks (scheduler job)', async () => {
    const group = await setup(siteRoutes('old.example'));
    const created = await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Old', url: 'https://old.example/' } });
    await t.favicons.idle();
    const first = t.ctx.db.get<{ id: string }>('SELECT id FROM icons')!.id;
    // Fresh icons are left alone.
    await t.ctx.scheduler.runAll();
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM icons')?.n).toBe(1);

    t.ctx.db.run('UPDATE icons SET fetched_at = ?', [Date.now() - 31 * DAY_MS]);
    await t.ctx.scheduler.runAll();
    const bookmark = t.ctx.db.get<{ icon_id: string }>('SELECT icon_id FROM bookmarks WHERE id = ?', [created.body.id])!;
    expect(bookmark.icon_id).not.toBe(first);
    // The old row is unreferenced and past its grace period: garbage-collected by the same job.
    expect(t.ctx.db.all<{ id: string }>('SELECT id FROM icons').map((r) => r.id)).toEqual([bookmark.icon_id]);
  });

  it('resolves missing icons in the job (e.g. after an import) and remembers misses', async () => {
    const group = await setup([
      ...siteRoutes('late.example'),
      { match: /^https:\/\/dead\.example\//, respond: { status: 500, text: 'down' } },
      { match: /duckduckgo|google/, respond: { status: 404, text: '' } },
    ]);
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
    await t.req('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Late', url: 'https://late.example/' } });
    await t.req('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Dead', url: 'https://dead.example/' } });
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: true });
    await t.ctx.scheduler.runAll();
    const rows = t.ctx.db.all<{ title: string; icon_id: string | null }>('SELECT title, icon_id FROM bookmarks ORDER BY sort');
    expect(rows[0]!.icon_id).not.toBeNull();
    expect(rows[1]!.icon_id).toBeNull();
    const calls = t.ctx.fakeFetch!.calls.length;
    await t.ctx.scheduler.runAll();
    expect(t.ctx.fakeFetch!.calls.length).toBe(calls); // the miss is not retried right away
  });

  it('uploads custom icons (sniffed, ≤ 10 MB) and keeps them through GC while referenced', async () => {
    const group = await setup([]);
    t.ctx.settings.set('bookmarks', { defaultGroupId: null, autoFetchIcons: false });
    const b = (await t.json<Bookmark>('POST', '/api/bookmarks', { body: { groupId: group.id, title: 'Mine', url: 'https://mine.example/' } })).body;

    const bad = await t.json<{ error: { code: string } }>('POST', `/api/bookmarks/${b.id}/icon`, { body: fileForm('<html></html>', 'x.png') });
    expect(bad.status).toBe(422);
    const noFile = await t.req('POST', `/api/bookmarks/${b.id}/icon`, { body: new FormData() });
    expect(noFile.status).toBe(400);
    const json = await t.req('POST', `/api/bookmarks/${b.id}/icon`, { body: { file: 'x' } });
    expect(json.status).toBe(400); // multipart required

    const res = await t.json<Bookmark>('POST', `/api/bookmarks/${b.id}/icon`, { body: fileForm(IMAGE_SAMPLES.webp, 'evil.html') });
    expect(res.status).toBe(200);
    expect(res.body.iconMode).toBe('custom');
    const icon = await t.req('GET', `/api/icons/${res.body.iconId}`);
    expect(icon.headers.get('content-type')).toBe('image/webp');
    expect(t.ctx.db.get<{ kind: string; source_host: string | null }>('SELECT kind, source_host FROM icons')).toEqual({ kind: 'upload', source_host: null });

    expect(t.favicons.collectGarbage()).toBe(0);
    // Switching to a letter tile orphans the upload; it survives the undo window, then goes.
    await t.req('PATCH', `/api/bookmarks/${b.id}`, { body: { iconMode: 'letter' } });
    expect(t.favicons.collectGarbage()).toBe(0);
    t.ctx.db.run('UPDATE icons SET fetched_at = ?', [Date.now() - 2 * DAY_MS]);
    expect(t.favicons.collectGarbage()).toBe(0); // recently orphaned (in-memory undo window)
  });

  it('keeps icons referenced by search engines', async () => {
    await setup([]);
    const id = t.favicons.storeUpload(png(32));
    t.ctx.db.run('UPDATE icons SET fetched_at = ?', [Date.now() - 2 * DAY_MS]);
    const search = t.ctx.settings.get('search');
    t.ctx.settings.set('search', { ...search, engines: search.engines.map((e, i) => (i === 0 ? { ...e, iconId: id } : e)) });
    expect(t.favicons.collectGarbage()).toBe(0);
    t.ctx.settings.set('search', { ...search });
    expect(t.favicons.collectGarbage()).toBe(1);
  });
});
