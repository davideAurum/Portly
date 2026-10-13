import fs from 'node:fs';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Feed } from '@homebase/shared';
import type { AppEnv } from '../../context.ts';
import { createErrorHandler } from '../../lib/errors.ts';
import { contextFieldForKey } from '../../lib/health.ts';
import { RouteTable } from '../../lib/routes.ts';
import { createGate } from '../../security/gate.ts';
import { createSecurityHeaders } from '../../security/headers.ts';
import { SafeFetchError } from '../../security/safe-fetch.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../testing/test-context.ts';
import { testRequest } from '../../testing/test-request.ts';
import { FEED_MAX_BYTES, FEED_TTL_MS, feedCacheKey, feedHealthKey, feedId, register } from './index.ts';
import { decodeFeedBytes, discoverFeedUrl, looksLikeHtml, parseFeed } from './parse.ts';
import { MAX_DEPTH, parseXml, XmlError } from './xml.ts';

const NOW = new Date('2026-10-11T12:00:00Z');

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Example &amp; Co News</title>
    <link>https://example.com/</link>
    <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Older story</title>
      <link>https://example.com/older</link>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
      <pubDate>Fri, 09 Oct 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b> <script>alert(1)</script>and more.</p>]]></description>
      <dc:creator>Ada</dc:creator>
    </item>
    <item>
      <title>Newer &lt;em&gt;story&lt;/em&gt;</title>
      <link>/newer</link>
      <pubDate>Sat, 10 Oct 2026 09:30:00 +0200</pubDate>
    </item>
    <item>
      <title>Unsafe link</title>
      <link>javascript:alert(1)</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atom Blog</title>
  <link href="https://blog.example.org/"/>
  <link rel="self" href="https://blog.example.org/atom.xml"/>
  <author><name>Grace</name></author>
  <entry>
    <title type="html">A &lt;b&gt;bold&lt;/b&gt; post</title>
    <link rel="alternate" type="text/html" href="posts/1"/>
    <id>urn:uuid:1</id>
    <updated>2026-10-10T10:00:00Z</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Rich <i>content</i></p></div></content>
  </entry>
  <entry>
    <title>Second</title>
    <link href="https://blog.example.org/posts/2"/>
    <id>urn:uuid:2</id>
    <published>2026-10-11T08:00:00Z</published>
    <summary>Plain &lt;not a tag&gt; text</summary>
    <author><name>Linus</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/"><title>RDF Feed</title><link>https://rdf.example/</link></channel>
  <item rdf:about="https://rdf.example/a"><title>A</title><link>https://rdf.example/a</link><dc:date>2026-10-01T00:00:00Z</dc:date></item>
</rdf:RDF>`;

describe('feeds: parsing', () => {
  it('reads RSS 2.0: plain-text titles and summaries, resolved links, newest first', () => {
    const feed = parseFeed(RSS, 'https://example.com/feed.xml', 'https://example.com/feed.xml', NOW);
    expect(feed.title).toBe('Example & Co News');
    expect(feed.siteUrl).toBe('https://example.com/');
    expect(feed.fetchedAt).toBe(NOW.toISOString());
    expect(feed.items.map((i) => i.title)).toEqual(['Newer story', 'Older story', 'Unsafe link']);
    const [newer, older, unsafe] = feed.items;
    expect(newer).toMatchObject({ url: 'https://example.com/newer', published: '2026-10-10T07:30:00.000Z', summary: null });
    expect(older).toMatchObject({
      id: 'tag:example.com,2026:1',
      url: 'https://example.com/older',
      author: 'Ada',
      summary: 'Hello world and more.',
    });
    expect(unsafe!.url).toBeNull();
  });

  it('reads Atom: alternate links, text constructs, feed author fallback', () => {
    const feed = parseFeed(ATOM, 'https://blog.example.org/atom.xml');
    expect(feed.title).toBe('Atom Blog');
    expect(feed.siteUrl).toBe('https://blog.example.org/');
    expect(feed.items).toHaveLength(2);
    const [second, first] = feed.items;
    expect(second).toMatchObject({ id: 'urn:uuid:2', title: 'Second', author: 'Linus', summary: 'Plain <not a tag> text' });
    expect(first).toMatchObject({
      id: 'urn:uuid:1',
      title: 'A bold post',
      url: 'https://blog.example.org/posts/1',
      author: 'Grace',
      summary: 'Rich content',
    });
  });

  it('reads RSS 1.0 (RDF)', () => {
    const feed = parseFeed(RDF, 'https://rdf.example/rss');
    expect(feed.title).toBe('RDF Feed');
    expect(feed.items).toEqual([
      { id: 'https://rdf.example/a', title: 'A', url: 'https://rdf.example/a', published: '2026-10-01T00:00:00.000Z', author: null, summary: null },
    ]);
  });

  it('makes duplicate ids unique and caps the item count', () => {
    const items = Array.from({ length: 80 }, () => '<item><title>Same</title><guid>dup</guid></item>').join('');
    const feed = parseFeed(`<rss><channel><title>T</title>${items}</channel></rss>`, 'https://x.example/f');
    expect(feed.items).toHaveLength(50);
    expect(new Set(feed.items.map((i) => i.id)).size).toBe(50);
    expect(feed.items[1]!.id).toBe('dup#1');
  });

  it('rejects documents that are not feeds and DOCTYPE internal subsets', () => {
    expect(() => parseFeed('<html><body>hi</body></html>', 'https://x.example/')).toThrow(/not an RSS or Atom feed/);
    expect(() => parseXml('<!DOCTYPE rss [<!ENTITY a "aaaa">]><rss/>')).toThrow(XmlError);
  });

  it('is tolerant of broken markup and stays fast on hostile nesting', () => {
    const feed = parseFeed('<rss><channel><title>Broken</b></title><item><title>x < y</title></item></channel>', 'https://x.example/');
    expect(feed.title).toBe('Broken');
    expect(feed.items[0]!.title).toBe('x < y');

    const deep = '<a>'.repeat(200_000);
    const started = performance.now();
    const doc = parseXml(`<rss><channel>${deep}</channel></rss>`.replace('<a>'.repeat(200_000), '<a>'.repeat(50_000)));
    expect(performance.now() - started).toBeLessThan(2000);
    let depth = 0;
    for (let el = doc.children[0]; el; el = el.children[0]) depth++;
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH + 2);
    const quotes = `<rss ${'<x "'.repeat(100_000)}`;
    const t2 = performance.now();
    parseXml(quotes);
    expect(performance.now() - t2).toBeLessThan(2000);
  });

  it('decodes bytes by BOM, Content-Type charset or XML declaration', () => {
    const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\xe9</title></channel></rss>', 'latin1');
    expect(parseFeed(decodeFeedBytes(latin1, 'application/xml'), 'https://x.example/').title).toBe('Café');
    expect(decodeFeedBytes(Buffer.from('caf\xe9', 'latin1'), 'text/xml; charset=windows-1252')).toBe('café');
    expect(decodeFeedBytes(Buffer.from('﻿café', 'utf8'), 'text/xml; charset=latin1')).toBe('café');
  });

  it('finds the feed a web page advertises', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/s.css">
      <link rel="alternate" type="application/atom+xml" title="Feed" href="/atom.xml">
      </head><body><link rel="alternate" type="application/rss+xml" href="/late.xml"></body></html>`;
    expect(looksLikeHtml(html)).toBe(true);
    expect(looksLikeHtml(RSS)).toBe(false);
    expect(discoverFeedUrl(html, 'https://site.example/blog/')).toBe('https://site.example/atom.xml');
    expect(discoverFeedUrl('<html><head></head><body></body></html>', 'https://site.example/')).toBeNull();
  });
});

describe('feeds: GET /api/feeds', () => {
  let ctx: TestContext | undefined;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
      ctx = undefined;
    }
  });

  function testbed(overrides: TestContextOverrides) {
    ctx = createTestContext(overrides);
    const app = new Hono<AppEnv>();
    const routes = new RouteTable();
    app.onError(createErrorHandler(ctx.log));
    app.use('*', createSecurityHeaders({ routes }));
    app.use('*', createGate({ config: ctx.config, routes, log: ctx.log }));
    register(app, ctx);
    routes.collect(app);
    return async <T>(path: string) => {
      const res = await testRequest(app, 'GET', path);
      return { status: res.status, body: (await res.json()) as T };
    };
  }

  const q = (url: string) => `/api/feeds?url=${encodeURIComponent(url)}`;

  it('fetches, parses and caches a feed', async () => {
    const get = testbed({ fetchRoutes: [{ match: 'https://example.com/feed.xml', respond: { text: RSS, headers: { 'content-type': 'application/rss+xml' } } }] });
    const first = await get<Feed>(q('https://example.com/feed.xml'));
    expect(first.status).toBe(200);
    expect(first.body.title).toBe('Example & Co News');
    expect(first.body.items).toHaveLength(3);
    await get<Feed>(q('https://example.com/feed.xml'));
    expect(ctx!.fakeFetch!.calls).toHaveLength(1);
    expect(ctx!.cache.get(feedCacheKey('https://example.com/feed.xml'))).toBeDefined();
    expect(FEED_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('follows a page to its advertised feed', async () => {
    const get = testbed({
      fetchRoutes: [
        { match: 'https://blog.example.org/atom.xml', respond: { text: ATOM } },
        {
          match: 'https://blog.example.org/',
          respond: { text: '<!doctype html><html><head><link rel="alternate" type="application/atom+xml" href="atom.xml"></head></html>', headers: { 'content-type': 'text/html' } },
        },
      ],
    });
    const res = await get<Feed>(q('https://blog.example.org/'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: 'https://blog.example.org/', feedUrl: 'https://blog.example.org/atom.xml', title: 'Atom Blog' });
  });

  it('maps failures to API errors', async () => {
    const get = testbed({
      fetchRoutes: [
        { match: 'https://gone.example/', respond: { status: 404, text: 'nope' } },
        { match: 'https://page.example/', respond: { text: '<!doctype html><html><head></head><body>no feed</body></html>' } },
      ],
    });
    expect((await get(q('https://gone.example/'))).status).toBe(502);
    const page = await get<{ error: { code: string; message: string } }>(q('https://page.example/'));
    expect(page.status).toBe(422);
    expect(page.body.error.message).toMatch(/No RSS or Atom feed/);
    expect((await get(q('javascript:alert(1)'))).status).toBe(422);
    expect((await get('/api/feeds')).status).toBe(422);
  });

  describe('health (diagnostics)', () => {
    const FEED_URL = 'https://news.example.com/private/feed-path.xml?token=abc';
    const key = feedHealthKey(FEED_URL);

    it('keys a feed by a hash of its URL, labelled with its host, and describes the document read', async () => {
      const get = testbed({ fetchRoutes: [{ match: 'https://news.example.com/', respond: { text: RSS, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } } }] });
      expect((await get(q(FEED_URL))).status).toBe(200);
      expect(key).toMatch(/^feed:[0-9a-f]{10}$/);
      expect(key).toBe(`feed:${feedId(FEED_URL)}`);
      expect(ctx!.health.get(key)).toMatchObject({
        area: 'feeds',
        label: 'news.example.com',
        status: 'ok',
        expectEveryMs: null,
        detail: { status: 200, bytes: Buffer.byteLength(RSS), items: 3, contentType: 'application/rss+xml' },
      });
      // Cache hits are not checks.
      await get(q(FEED_URL));
      expect(ctx!.health.history(key)).toHaveLength(1);
    });

    it('names the host a page led to', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: 'https://feeds.example.net/blog.atom', respond: { text: ATOM, headers: { 'content-type': 'application/atom+xml' } } },
          {
            match: 'https://blog.example.org/',
            respond: { text: '<!doctype html><html><head><link rel="alternate" type="application/atom+xml" href="https://feeds.example.net/blog.atom"></head></html>', headers: { 'content-type': 'text/html' } },
          },
        ],
      });
      await get(q('https://blog.example.org/'));
      expect(ctx!.health.get(feedHealthKey('https://blog.example.org/'))?.detail).toEqual({
        discovered: true,
        status: 200,
        bytes: Buffer.byteLength(ATOM),
        items: 2,
        finalHost: 'feeds.example.net',
        contentType: 'application/atom+xml',
      });
    });

    it('describes the advertised feed, not the page, when reading that feed fails', async () => {
      const get = testbed({
        fetchRoutes: [
          {
            match: 'https://blog.example.org/',
            respond: { text: '<!doctype html><html><head><link rel="alternate" type="application/atom+xml" href="https://feeds.example.net/blog.atom"></head></html>', headers: { 'content-type': 'text/html' } },
          },
        ],
      });
      const real = ctx!.fetch;
      ctx!.fetch = async (url, options) => {
        if (String(url).startsWith('https://feeds.example.net/')) throw new SafeFetchError('timeout', 'feeds.example.net did not answer in time', 'feeds.example.net');
        return real(url, options);
      };
      expect((await get(q('https://blog.example.org/'))).status).toBe(504);
      const state = ctx!.health.get(feedHealthKey('https://blog.example.org/'));
      expect(state).toMatchObject({ status: 'failing', lastCode: 'timeout', lastStatus: null });
      // Not the page's `200 text/html`: nothing arrived from the feed's host.
      expect(state?.detail).toMatchObject({ discovered: true, host: 'feeds.example.net', errReason: 'timeout' });
      for (const k of ['status', 'bytes', 'contentType', 'finalHost']) expect(state?.detail).not.toHaveProperty(k);
    });

    it.each([
      ['an HTTP error', { status: 404, text: 'nope' }, 'not_found', 404, 'The feed answered HTTP 404'],
      ['a server error', { status: 503, text: 'busy' }, 'http_5xx', 503, 'The feed answered HTTP 503'],
      ['a page without a feed', { text: '<!doctype html><html><head></head><body>x</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } }, 'not_a_feed', 200, 'No RSS or Atom feed was found on this page'],
      ['an XML document that is no feed', { text: '<?xml version="1.0"?><note>hi</note>' }, 'not_a_feed', 200, 'This address is not an RSS or Atom feed'],
      ['a refused document', { text: '<!DOCTYPE rss [<!ENTITY a "aaaa">]><rss/>' }, 'parse_error', 200, 'The feed could not be read: DOCTYPE with an internal subset is not allowed'],
    ])('records %s as %s', async (_name, respond, code, status, message) => {
      const get = testbed({ fetchRoutes: [{ match: 'https://news.example.com/', respond }] });
      await get(q(FEED_URL));
      expect(ctx!.health.get(key)).toMatchObject({ status: 'failing', lastCode: code, lastStatus: status, lastMessage: message });
      expect(ctx!.health.get(key)?.detail).toMatchObject({ status: (respond as { status?: number }).status ?? 200 });
    });

    it('a check (the settings trying an address) records success only, never a failing feed', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: 'https://news.example.com/', respond: { status: 404, text: 'nope' } },
          { match: 'https://good.example.com/', respond: { text: RSS, headers: { 'content-type': 'application/rss+xml' } } },
        ],
      });
      expect((await get(`${q(FEED_URL)}&check=1`)).status).toBe(502);
      expect(ctx!.health.get(key)).toBeNull();
      const good = 'https://good.example.com/feed.xml';
      expect((await get(`${q(good)}&check=1`)).status).toBe(200);
      expect(ctx!.health.get(feedHealthKey(good))).toMatchObject({ status: 'ok' });
      // The widget's own fetch of a failing feed still records it.
      expect((await get(q(FEED_URL))).status).toBe(502);
      expect(ctx!.health.get(key)).toMatchObject({ status: 'failing', lastCode: 'not_found' });
      // Only `check=1` is accepted.
      expect((await get(`${q(good)}&check=yes`)).status).toBe(422);
    });

    it('records transport failures such as an oversized document', async () => {
      const get = testbed({
        fetch: async () => {
          throw new SafeFetchError('too_large', `Response from news.example.com exceeds ${FEED_MAX_BYTES} bytes`, 'news.example.com');
        },
      });
      expect((await get(q(FEED_URL))).status).toBe(502);
      expect(ctx!.health.get(key)).toMatchObject({ status: 'failing', lastCode: 'too_large', detail: { host: 'news.example.com' } });
    });

    it('logs the feed id with its lines (related-log lookup) and never its URL', async () => {
      const get = testbed({ fetchRoutes: [{ match: 'https://news.example.com/', respond: { status: 500, text: 'x' } }] });
      await get(q(FEED_URL));
      const related = contextFieldForKey(key);
      expect(related).toEqual({ field: 'feed', value: feedId(FEED_URL) });
      const { records } = ctx!.logs.query({ fieldEquals: { feed: feedId(FEED_URL) } });
      expect(records.map((r) => r.msg)).toContain('feeds failing');
      expect(records.find((r) => r.msg === 'feeds failing')).toMatchObject({ level: 'warn', area: 'feeds' });
      const everything = JSON.stringify([ctx!.logs.query({}).records, ctx!.health.list(), ctx!.health.history(key)]);
      expect(everything).not.toContain('feed-path');
      expect(everything).not.toContain('token=abc');
    });
  });
});
