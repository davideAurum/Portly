/**
 * Feed documents → the `Feed` contract. Everything a feed supplies is untrusted (§4.1 b): titles
 * and summaries go through the linear-time {@link htmlToPlainText}, links must be SafeHttpUrls
 * (relative ones are resolved against the feed URL first), dates must parse.
 */
import {
  MAX_FEED_ITEMS,
  MAX_FEED_SUMMARY,
  MAX_FEED_TITLE,
  isSafeHttpUrl,
  type Feed,
  type FeedItem,
} from '@portly/shared';
import { htmlToPlainText, parseTag, scanTags } from '../../lib/html-scan.ts';
import { child, childText, children, parseXml, type XmlElement } from './xml.ts';

export class NotAFeedError extends Error {
  override name = 'NotAFeedError';
}

// ---------------------------------------------------------------------------
// Bytes → text
// ---------------------------------------------------------------------------

function charsetFromContentType(contentType: string | null): string | null {
  const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

function charsetFromDeclaration(head: string): string | null {
  const m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

function decoderFor(label: string | null): InstanceType<typeof TextDecoder> | null {
  if (!label) return null;
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/**
 * Decodes a feed body: a BOM wins, then the Content-Type charset, then the XML declaration's
 * encoding, then UTF-8. Unknown labels fall back to UTF-8 (invalid bytes become U+FFFD).
 */
export function decodeFeedBytes(bytes: Uint8Array, contentType: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  const decoder = decoderFor(charsetFromContentType(contentType)) ?? decoderFor(charsetFromDeclaration(head)) ?? new TextDecoder('utf-8');
  return decoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// HTML pages → advertised feed
// ---------------------------------------------------------------------------

const FEED_TYPES = new Set(['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/feed+xml']);

/** True when `text` reads as an HTML page rather than an XML document. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 1024).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || (/<(head|body|meta)\b/.test(head) && !head.startsWith('<?xml'));
}

/** The first `<link rel="alternate" type="application/rss+xml|atom+xml" href>` of a page, resolved, or null. */
export function discoverFeedUrl(html: string, pageUrl: string): string | null {
  for (const tag of scanTags(html.slice(0, 1024 * 1024))) {
    if (tag.closing) {
      if (tag.name === 'head') break;
      continue;
    }
    if (tag.name === 'body') break;
    if (tag.name !== 'link') continue;
    const el = parseTag(tag.source);
    if (!el) continue;
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const type = (el.getAttribute('type') ?? '').toLowerCase().trim();
    if (!rel.includes('alternate') || !FEED_TYPES.has(type)) continue;
    const href = resolveUrl(el.getAttribute('href') ?? '', pageUrl);
    if (href) return href;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed, base).href;
    return isSafeHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** HTML (or plain text when `plain`) → one line of text, whitespace collapsed. */
function oneLine(value: string, max: number, plain = false): string {
  const text = plain ? value : htmlToPlainText(value, { maxChars: max * 4, linkUrls: false });
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

function toIso(value: string): string | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Atom text construct (`type` text | html | xhtml) → one line. */
function atomText(el: XmlElement | undefined, max: number): string {
  if (!el) return '';
  const type = (el.attrs.type ?? 'text').toLowerCase();
  if (type === 'xhtml') return oneLine(el.inner ?? el.text, max);
  return oneLine(el.text, max, type === 'text' || type === 'text/plain');
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

interface RawFeed {
  title: string;
  siteUrl: string | null;
  items: Omit<FeedItem, 'id'>[];
  ids: string[];
}

function rssItem(item: XmlElement, base: string): { item: Omit<FeedItem, 'id'>; id: string } {
  const link = resolveUrl(childText(item, 'link'), base);
  const guid = child(item, 'guid');
  const guidText = guid?.text.trim() ?? '';
  // A permalink guid is the article URL when there is no <link>.
  const guidLink = !link && guid && (guid.attrs.ispermalink ?? 'true').toLowerCase() !== 'false' ? resolveUrl(guidText, base) : null;
  const url = link ?? guidLink;
  const description = childText(item, 'description', 'content:encoded');
  const title = oneLine(childText(item, 'title'), MAX_FEED_TITLE);
  const summary = description ? oneLine(description, MAX_FEED_SUMMARY) : '';
  return {
    id: guidText || url || title,
    item: {
      title: title || (summary ? clip(summary, 120) : 'Untitled'),
      url,
      published: toIso(childText(item, 'pubdate', 'dc:date', 'a10:updated', 'updated')),
      author: oneLine(childText(item, 'dc:creator', 'author'), 120, true) || null,
      summary: summary || null,
    },
  };
}

function readRss(channel: XmlElement, itemParent: XmlElement, base: string): RawFeed {
  const out: RawFeed = {
    title: oneLine(childText(channel, 'title'), MAX_FEED_TITLE),
    // RSS 2.0 <link> is text; some feeds add <atom:link href> next to it (prefix dropped by the reader).
    siteUrl: resolveUrl(children(channel, 'link').find((l) => l.text.trim())?.text ?? '', base),
    items: [],
    ids: [],
  };
  for (const el of children(itemParent, 'item')) {
    const { item, id } = rssItem(el, base);
    out.items.push(item);
    out.ids.push(id);
  }
  return out;
}

function atomLink(el: XmlElement, base: string): string | null {
  const links = children(el, 'link');
  const alt = links.find((l) => (l.attrs.rel ?? 'alternate').toLowerCase() === 'alternate' && (l.attrs.type ?? 'text/html').toLowerCase().includes('html'))
    ?? links.find((l) => (l.attrs.rel ?? 'alternate').toLowerCase() === 'alternate');
  return alt ? resolveUrl(alt.attrs.href ?? '', el.attrs['xml:base'] ? resolveUrl(el.attrs['xml:base'], base) ?? base : base) : null;
}

function readAtom(feed: XmlElement, base: string): RawFeed {
  const out: RawFeed = { title: atomText(child(feed, 'title'), MAX_FEED_TITLE), siteUrl: atomLink(feed, base), items: [], ids: [] };
  const feedAuthor = childText(child(feed, 'author') ?? feed, 'name');
  for (const entry of children(feed, 'entry')) {
    const url = atomLink(entry, base);
    const title = atomText(child(entry, 'title'), MAX_FEED_TITLE);
    const summary = atomText(child(entry, 'summary') ?? child(entry, 'content'), MAX_FEED_SUMMARY);
    const author = child(entry, 'author');
    out.items.push({
      title: title || (summary ? clip(summary, 120) : 'Untitled'),
      url,
      published: toIso(childText(entry, 'published', 'updated', 'issued', 'modified')),
      author: oneLine(author ? childText(author, 'name') : feedAuthor, 120, true) || null,
      summary: summary || null,
    });
    out.ids.push(childText(entry, 'id') || url || title);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses an RSS 2.0 / 0.9x, RSS 1.0 (RDF) or Atom document fetched from `feedUrl`.
 * Throws {@link NotAFeedError} when the document is none of them (or {@link XmlError} when it is
 * refused outright).
 */
export function parseFeed(text: string, feedUrl: string, requestedUrl: string = feedUrl, now: Date = new Date()): Feed {
  const doc = parseXml(text);
  const root = doc.children.find((c) => c.name === 'rss' || c.name === 'feed' || c.name === 'rdf:rdf');
  let raw: RawFeed;
  if (root?.name === 'feed') {
    raw = readAtom(root, feedUrl);
  } else if (root?.name === 'rss') {
    const channel = child(root, 'channel');
    if (!channel) throw new NotAFeedError('The RSS document has no channel');
    raw = readRss(channel, channel, feedUrl);
  } else if (root) {
    raw = readRss(child(root, 'channel') ?? root, root, feedUrl);
  } else {
    throw new NotAFeedError('The document is not an RSS or Atom feed');
  }

  const seen = new Map<string, number>();
  const items: FeedItem[] = raw.items.map((item, index) => {
    const base = (raw.ids[index] || `item-${index}`).slice(0, 512);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { id: count === 0 ? base : `${base}#${count}`, ...item };
  });
  // Newest first; undated items keep their order after the dated ones (Array.sort is stable).
  items.sort((a, b) => {
    if (a.published && b.published) return b.published.localeCompare(a.published);
    return a.published ? -1 : b.published ? 1 : 0;
  });

  let fallbackTitle = feedUrl;
  try {
    fallbackTitle = new URL(raw.siteUrl ?? feedUrl).hostname.replace(/^www\./, '');
  } catch {
    // keep the URL
  }
  return {
    url: requestedUrl,
    feedUrl,
    title: raw.title || fallbackTitle,
    siteUrl: raw.siteUrl,
    items: items.slice(0, MAX_FEED_ITEMS),
    fetchedAt: now.toISOString(),
  };
}
