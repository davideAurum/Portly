/**
 * Fetching and reading untrusted web pages for site meta and favicons (§4.8, §8).
 *
 * - Pages are fetched with safe-fetch policy `public` (guarded DNS, manual re-validated
 *   redirects), capped at 2 MB of decoded bytes, and decoded with the charset from the
 *   `Content-Type` header or a `<meta charset>` in the first bytes (default UTF-8).
 * - Parsing never uses a DOM and never builds a tree of the whole (hostile) page: a linear tag
 *   scanner ({@link scanTags}) finds `<base>`, `<title>` (outside `<svg>`), `<meta og:title>` and
 *   `<link>` tags, and only those tags are parsed, one at a time, by node-html-parser. The title
 *   (`<title>`, else `og:title`) is entity-decoded, whitespace-collapsed, trimmed and capped;
 *   `<link rel~=icon|apple-touch-icon>` give icon candidates and `rel=manifest` the web manifest.
 *   Every href is resolved against `<base href>` / the final response URL; only http(s) and
 *   `data:` hrefs survive.
 */
import { getDomainWithoutSuffix } from 'tldts';
import { decodeHTML } from 'entities';
import { z } from 'zod';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { SIZE_CAPS, type SafeFetch } from '../../security/safe-fetch.ts';
import { MAX_RAW_TEXT, parseTag, scanTags } from '../../lib/html-scan.ts';

export const PAGE_TIMEOUT_MS = 8_000;
export const MAX_TITLE_LENGTH = 300;
const MAX_CANDIDATES = 24;
/** At most this many `<link>` (and, separately, `<meta>`) tags are parsed per page. */
const MAX_PARSED_TAGS = 400;

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Decoded HTML, or null when the response was not a 2xx HTML document. */
  html: string | null;
}

function charsetOf(contentType: string | null, head: Buffer): string {
  const fromHeader = contentType ? /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] : undefined;
  if (fromHeader) return fromHeader;
  const sniff = head.toString('latin1', 0, Math.min(head.length, 2048));
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(sniff)?.[1];
  return meta ?? 'utf-8';
}

export function decodeHtml(bytes: Buffer, contentType: string | null): string {
  const charset = charsetOf(contentType, bytes);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function isHtmlType(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type === '' || type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/plain';
}

export interface FetchPageOptions {
  /** What the page is fetched for (safe-fetch `purpose`, logged with the host): `site-meta`, `favicon.page`. */
  purpose?: string;
  timeoutMs?: number;
}

/** Fetches a page (policy `public`). Transport failures throw (SafeFetchError). */
export async function fetchPage(fetch: SafeFetch, url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const res = await fetch(url, {
    policy: 'public',
    as: 'bytes',
    maxBytes: SIZE_CAPS.html,
    timeoutMs: options.timeoutMs ?? PAGE_TIMEOUT_MS,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    purpose: options.purpose ?? 'page',
  });
  const contentType = res.headers.get('content-type');
  const ok = res.status >= 200 && res.status < 300;
  return { url: res.url, status: res.status, html: ok && isHtmlType(contentType) ? decodeHtml(res.data, contentType) : null };
}

/** Fetches a page, returning null (and logging the error's loggable fields at debug) on any transport failure. */
export async function tryFetchPage(fetch: SafeFetch, url: string, log: Logger, options: FetchPageOptions = {}): Promise<FetchedPage | null> {
  try {
    return await fetchPage(fetch, url, options);
  } catch (err) {
    log.debug('page fetch failed', { purpose: options.purpose ?? 'page', ...errorFields(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Collapses whitespace, trims and caps a title at a code-point boundary; empty → null. */
export function cleanTitle(value: string | undefined | null, max = MAX_TITLE_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  // Bounded work for hostile input: nothing past the first 64 K characters can reach the result.
  const bounded = value.length > 65_536 ? value.slice(0, 65_536) : value;
  const collapsed = bounded.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (collapsed === '') return null;
  const chars = Array.from(collapsed);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : collapsed;
}

export type IconSource = 'icon' | 'apple' | 'manifest';

export interface IconCandidate {
  /** Absolute http(s) URL or a `data:` URL. */
  url: string;
  /** Largest declared size in px (null when not declared). */
  size: number | null;
  svg: boolean;
  source: IconSource;
}

export interface ParsedPage {
  title: string | null;
  icons: IconCandidate[];
  manifestUrl: string | null;
}

/** Resolves `href` against `base`; returns a http(s) or data: URL string, or null. */
export function resolveHref(href: string | undefined, base: string): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed === '') return null;
  if (/^data:/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** `sizes` attribute → largest declared size; `any` → Infinity (scalable). */
export function parseSizes(value: string | undefined | null): number | null {
  if (typeof value !== 'string') return null;
  let best: number | null = null;
  for (const token of value.trim().toLowerCase().split(/\s+/)) {
    if (token === 'any') return Number.POSITIVE_INFINITY;
    const match = /^(\d{1,5})x(\d{1,5})$/.exec(token);
    if (match) best = Math.max(best ?? 0, Number(match[1]), Number(match[2]));
  }
  return best;
}

function looksSvg(url: string, type: string | undefined): boolean {
  if (type?.trim().toLowerCase() === 'image/svg+xml') return true;
  if (/^data:image\/svg\+xml/i.test(url)) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Titles (UX-1): short site names instead of whole marketing <title> strings
// ---------------------------------------------------------------------------

/** Names longer than this are not used as a bookmark's short name. */
const MAX_SITE_NAME = 60;
/** Separators that always split a title ("GitHub · Change is constant… · GitHub"). */
const STRONG_SEPARATORS = / (?:·|\||–|—|-|•|»|::) |: /u;
/** Separators that split only when a part names the site ("Wikipedia, the free encyclopedia"). */
const WEAK_SEPARATORS = /, |\. /u;

function registrableLabel(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname;
    const label = getDomainWithoutSuffix(host, { allowPrivateDomains: false });
    return label ? label.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Letters and digits only, lower-cased ("BBC News" → "bbcnews", "Amazon.com" → "amazoncom"). */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** How well a title part names the site: 3 exact, 2 prefix, 1 contains the label as a word, 0 no. */
function nameScore(part: string, label: string): number {
  const squashed = squash(part);
  if (squashed === label) return 3;
  // A one- or two-letter label ("e.com") would prefix-match almost anything.
  if (label.length >= 3 && squashed.startsWith(label)) return 2;
  return part.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(label) ? 1 : 0;
}

function splitTitle(title: string, separators: RegExp): string[] {
  return title
    .split(separators)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The part of a title that names the site, or null when splitting does not help. */
function siteNamePart(title: string, label: string | null): string | null {
  const best = (parts: string[]): { part: string; score: number } | null => {
    if (parts.length < 2 || label === null) return null;
    let top: { part: string; score: number } | null = null;
    for (const part of parts) {
      const score = nameScore(part, label);
      if (score > 0 && (top === null || score > top.score)) top = { part, score };
    }
    return top;
  };
  const strong = splitTitle(title, STRONG_SEPARATORS);
  const strongBest = best(strong);
  if (strongBest) return strongBest.part;
  if (strong.length > 1) return strong[0] ?? null;
  const weakBest = best(splitTitle(title, WEAK_SEPARATORS));
  return weakBest ? weakBest.part : null;
}

export interface TitleSources {
  title: string | null;
  ogTitle: string | null;
  siteName: string | null;
  applicationName: string | null;
  appleTitle: string | null;
}

/**
 * The name to give a bookmark of `pageUrl`: a short site name (og:site_name, application-name,
 * apple-mobile-web-app-title) when it is shorter than the <title>; otherwise the part of the
 * <title> (or og:title) that names the site ("BBC News - Breaking news…" → "BBC News"); else the
 * whole title.
 */
export function bestTitle(sources: TitleSources, pageUrl: string): string | null {
  const full = sources.title ?? sources.ogTitle;
  for (const name of [sources.siteName, sources.applicationName, sources.appleTitle]) {
    if (name && Array.from(name).length <= MAX_SITE_NAME && (full === null || name.length < full.length)) return name;
  }
  if (full === null) return null;
  return siteNamePart(full, registrableLabel(pageUrl)) ?? full;
}

/**
 * "Netflix" for https://www.netflix.com/… — the registrable domain's label, capitalised; for a
 * page whose HTML could not be read. Null for IP addresses and single-label hosts.
 */
export function brandFromUrl(pageUrl: string): string | null {
  const label = registrableLabel(pageUrl);
  if (!label) return null;
  const chars = Array.from(label);
  return chars.length === 0 ? null : `${chars[0]!.toLocaleUpperCase('en-US')}${chars.slice(1).join('')}`;
}

export function parsePage(html: string, pageUrl: string): ParsedPage {
  let baseHref: string | undefined;
  let title: string | null = null;
  let ogTitle: string | null = null;
  let siteName: string | null = null;
  let applicationName: string | null = null;
  let appleTitle: string | null = null;
  const links: { rel: string[]; href: string | undefined; type: string | undefined; sizes: string | undefined }[] = [];
  let svgDepth = 0;
  let metas = 0;
  let linkTags = 0;

  for (const tag of scanTags(html)) {
    switch (tag.name) {
      case 'svg':
        if (tag.closing) svgDepth = Math.max(0, svgDepth - 1);
        else if (!/\/\s*>$/.test(tag.source)) svgDepth++;
        break;
      case 'title':
        // `<title>` inside inline SVG names the drawing, not the page.
        if (!tag.closing && !title && svgDepth === 0) title = cleanTitle(decodeHTML((tag.text ?? '').slice(0, MAX_RAW_TEXT)));
        break;
      case 'base':
        if (!tag.closing && baseHref === undefined) {
          const href = parseTag(tag.source)?.getAttribute('href');
          if (href !== undefined) baseHref = href;
        }
        break;
      case 'meta': {
        if (tag.closing || metas >= MAX_PARSED_TAGS) break;
        metas++;
        const el = parseTag(tag.source);
        const key = (el?.getAttribute('property') ?? el?.getAttribute('name'))?.trim().toLowerCase();
        if (key === 'og:title') ogTitle ??= cleanTitle(el?.getAttribute('content'));
        else if (key === 'og:site_name') siteName ??= cleanTitle(el?.getAttribute('content'));
        else if (key === 'application-name') applicationName ??= cleanTitle(el?.getAttribute('content'));
        else if (key === 'apple-mobile-web-app-title') appleTitle ??= cleanTitle(el?.getAttribute('content'));
        break;
      }
      case 'link': {
        if (tag.closing || linkTags >= MAX_PARSED_TAGS) break;
        linkTags++;
        const el = parseTag(tag.source);
        const rel = (el?.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        if (el && rel.length > 0) {
          links.push({ rel, href: el.getAttribute('href'), type: el.getAttribute('type'), sizes: el.getAttribute('sizes') });
        }
        break;
      }
      default:
    }
  }

  let base = pageUrl;
  const resolvedBase = resolveHref(baseHref, pageUrl);
  if (resolvedBase && !resolvedBase.startsWith('data:')) base = resolvedBase;

  const icons: IconCandidate[] = [];
  let manifestUrl: string | null = null;
  for (const link of links) {
    if (link.rel.includes('manifest')) {
      if (manifestUrl === null) {
        const url = resolveHref(link.href, base);
        if (url && !url.startsWith('data:')) manifestUrl = url;
      }
      continue;
    }
    const apple = link.rel.includes('apple-touch-icon') || link.rel.includes('apple-touch-icon-precomposed');
    if (!apple && !link.rel.includes('icon')) continue;
    const url = resolveHref(link.href, base);
    if (!url || icons.length >= MAX_CANDIDATES) continue;
    const svg = looksSvg(url, link.type);
    let size = parseSizes(link.sizes);
    if (size === Number.POSITIVE_INFINITY && !svg) size = null;
    icons.push({ url, size: svg ? null : size, svg, source: apple ? 'apple' : 'icon' });
  }
  return { title: bestTitle({ title, ogTitle, siteName, applicationName, appleTitle }, pageUrl), icons, manifestUrl };
}

const ManifestSchema = z.object({
  icons: z
    .array(
      z.object({
        src: z.string().max(4096),
        sizes: z.string().max(200).optional(),
        type: z.string().max(100).optional(),
        purpose: z.string().max(100).optional(),
      }),
    )
    .max(100),
});

/** Icon candidates of a web app manifest (hrefs resolved against the manifest URL). */
export function parseManifest(json: unknown, manifestUrl: string): IconCandidate[] {
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) return [];
  const out: IconCandidate[] = [];
  for (const icon of parsed.data.icons) {
    const purposes = (icon.purpose ?? 'any').toLowerCase().split(/\s+/);
    if (!purposes.includes('any') && !purposes.includes('maskable')) continue;
    const url = resolveHref(icon.src, manifestUrl);
    if (!url || out.length >= MAX_CANDIDATES) continue;
    const svg = looksSvg(url, icon.type);
    const size = parseSizes(icon.sizes);
    out.push({ url, size: svg || size === Number.POSITIVE_INFINITY ? null : size, svg, source: 'manifest' });
  }
  return out;
}
