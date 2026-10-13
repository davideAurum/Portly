/**
 * Outbound HTTP (§4.8).
 *
 * `safeFetch(url, {method?, headers?, body?, policy, timeoutMs = 10000, maxBytes?, as, redirect?})
 *   → Promise<{status, headers, url, data}>`
 *
 * Policies:
 * - `provider`    fixed vendor endpoints (Google, Graph, Todoist, Open-Meteo, suggestion
 *                 providers, favicon services): global `fetch`; timeouts and size caps only.
 * - `public`      untrusted/discovered URLs (bookmark pages, icon & manifest hrefs, site meta,
 *                 ICS feeds): `fetch` **and** `Agent` from the pinned `undici` package (never mixed
 *                 with global fetch) with `connect: {lookup: guardedLookup}` — every address a
 *                 hostname resolves to must be outside the deny list, IP-literal hosts (decimal,
 *                 octal, hex forms as normalized by `new URL`, bracketed IPv6) are checked before
 *                 dispatch, and each redirect hop is re-validated. No env proxies.
 * - `user-server` user-entered CalDAV endpoints: private addresses allowed; plain `http` targets
 *                 must be (or resolve only to) private addresses on every request (§8 insecureLan:
 *                 checked at connect time, so a LAN name that later resolves to a public address
 *                 never receives the Basic credentials in cleartext); requests and manual
 *                 redirects are restricted to `allowedOrigins` (the account's `credentialOrigins`),
 *                 which is required. undici `fetch` + a plain `Agent` (no env proxies).
 *
 * Every hop: scheme http/https, no URL credentials, no "bad port" (the Fetch standard's list),
 * `redirect: 'manual'` followed by hand (≤ 5 hops), `Authorization`/`Cookie` never forwarded
 * across origins (except between `user-server` allowed origins). Size caps count **decoded**
 * bytes while streaming and abort past the cap (Content-Length is never trusted). Honest
 * `User-Agent: Portly/<version> (personal dashboard)`.
 *
 * Non-2xx statuses are returned, not thrown. Transport problems throw {@link SafeFetchError}
 * (an HttpError: 504 `upstream_timeout` or 502 `provider_error`) with a machine `reason` and the
 * transport error as `cause` (`NotPrivateAddressError`/`BlockedAddressError` for refused
 * addresses), so health outcomes can tell DNS, refused, reset, TLS and not-LAN failures apart.
 *
 * Logging (§3, §17): hosts, never URLs. One `outbound` record per call
 * `{method, host, policy, purpose?, status, ms, bytes, redirects?, finalHost?, retryAfter?,
 * rateLimitRemaining?}` — debug, or info for a provider/user-server status ≥ 400 (repeat-collapsed
 * per host, purpose and status); a failure logs `outbound failed {…, reason, cause, causeCode, hops,
 * blockedHost?}` (warn, debug for `public`); a caller's abort `debug 'outbound aborted'`. Calls in
 * progress are listed by {@link inflightOutbound} with the caller's job run / request id.
 *
 * Also exported: {@link decodeDataImage} (`data:` icon hrefs, decoded locally, sniffed, capped),
 * {@link isLocalLookingHost} (skip third-party favicon fallbacks), {@link isBlockedAddress},
 * {@link createGuardedLookup}.
 */
import dns from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ImageContentType } from '@portly/shared';
import { HttpError } from '../lib/errors.ts';
import { sniffImageType } from '../lib/image-sniff.ts';
import { getLogContext } from '../lib/log-context.ts';
import { errorFields, type LogFields, type Logger } from '../lib/logger.ts';
import { isPrivateAddress } from './private-address.ts';

export type FetchPolicy = 'provider' | 'public' | 'user-server';
export type ResponseKind = 'json' | 'text' | 'bytes';

export type SafeFetchData<A extends ResponseKind> = A extends 'json' ? unknown : A extends 'text' ? string : Buffer;

export interface SafeFetchOptions<A extends ResponseKind = ResponseKind> {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams;
  policy: FetchPolicy;
  /** Default 10 000 ms, covering the whole exchange including redirects and the body. */
  timeoutMs?: number;
  /** Cap on decoded body bytes (default: json 5 MB, text/HTML 2 MB, bytes/image 1 MB; ICS callers pass 10 MB). */
  maxBytes?: number;
  as: A;
  /** `follow` (default): up to 5 hops, followed manually and re-validated; `manual`: return the 3xx; `error`: throw on 3xx. */
  redirect?: 'follow' | 'manual' | 'error';
  /** Required for `user-server`: the only origins requests (and redirects) may go to. */
  allowedOrigins?: readonly string[];
  signal?: AbortSignal;
  /** What the call is for (`calendar-sync`, `token-refresh`, `favicon` …): a short machine word logged with the host. */
  purpose?: string;
}

export interface SafeFetchResponse<T> {
  status: number;
  headers: Headers;
  /** Final URL after redirects. */
  url: string;
  data: T;
  /** Redirects followed (always set by safeFetch; optional for hand-made responses in tests). */
  redirects?: number;
}

export type SafeFetch = <A extends ResponseKind>(
  url: string | URL,
  options: SafeFetchOptions<A>,
) => Promise<SafeFetchResponse<SafeFetchData<A>>>;

export type SafeFetchFailure = 'bad_url' | 'blocked' | 'timeout' | 'too_large' | 'network' | 'invalid_json' | 'redirect';

export class SafeFetchError extends HttpError {
  override name = 'SafeFetchError';
  readonly reason: SafeFetchFailure;
  readonly host: string | null;
  /** `cause`: the transport error behind it (kept as `Error.cause` for logs and health codes). */
  constructor(reason: SafeFetchFailure, message: string, host: string | null, cause?: unknown) {
    super(reason === 'timeout' ? 504 : 502, reason === 'timeout' ? 'upstream_timeout' : 'provider_error', { message, cause });
    this.reason = reason;
    this.host = host;
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES: Readonly<Record<ResponseKind, number>> = Object.freeze({
  json: 5 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  bytes: 1024 * 1024,
});
/** Named caps from §4.8. */
export const SIZE_CAPS = Object.freeze({
  html: 2 * 1024 * 1024,
  image: 1024 * 1024,
  ics: 10 * 1024 * 1024,
  json: 5 * 1024 * 1024,
});

export function userAgent(version: string): string {
  return `Portly/${version} (personal dashboard)`;
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
/** Statuses the Fetch standard treats as redirects (300, 304, 305 and 306 are plain responses). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const DENY_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * IPv6 deny ranges. `::ffff:0:0/96` (IPv4-mapped) is deliberately *not* added to the BlockList:
 * Node's BlockList treats an IPv4-mapped rule as matching every IPv4 address. Mapped (and 6to4)
 * addresses are instead checked through their embedded IPv4 address.
 */
const DENY_IPV6: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // IPv4-compatible (deprecated) addresses, e.g. ::127.0.0.1
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const DENY_LIST = (() => {
  const list = new net.BlockList();
  for (const [address, prefix] of DENY_IPV4) list.addSubnet(address, prefix, 'ipv4');
  for (const [address, prefix] of DENY_IPV6) list.addSubnet(address, prefix, 'ipv6');
  return list;
})();

/** 16 bytes of a valid IPv6 address (already accepted by `net.isIPv6`). */
function ipv6Bytes(ip: string): Uint8Array | null {
  let text = ip;
  const bytes = new Uint8Array(16);
  let tail: number[] | null = null;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!net.isIPv4(last)) return null;
    tail = last.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  if (groups.length !== 8) return null;
  groups.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  });
  if (tail) bytes.set(tail, 12);
  return bytes;
}

/** IPv4 address embedded in an IPv4-mapped (`::ffff:a.b.c.d`) or 6to4 (`2002:aabb:ccdd::/48`) address. */
function embeddedIPv4(bytes: Uint8Array): string | null {
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
  return null;
}

/**
 * True when `address` (an IP literal, optionally bracketed / with an IPv6 zone) is in the §4.8
 * deny list. Anything that is not a valid IP address counts as blocked (fail closed).
 */
export function isBlockedAddress(address: string): boolean {
  let ip = address.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const family = net.isIP(ip);
  if (family === 4) return DENY_LIST.check(ip, 'ipv4');
  if (family !== 6) return true;
  const bytes = ipv6Bytes(ip.toLowerCase());
  if (!bytes) return true;
  const embedded = embeddedIPv4(bytes);
  if (embedded !== null && DENY_LIST.check(embedded, 'ipv4')) return true;
  return DENY_LIST.check(ip, 'ipv6');
}

/** Raised for a plain-http `user-server` host that is not (or no longer) a local-network address. */
export class NotPrivateAddressError extends Error {
  override name = 'NotPrivateAddressError';
  readonly code = 'EPORTLY_NOT_LAN';
  readonly hostname: string;
  constructor(hostname: string) {
    super(`${hostname} does not resolve to a local network address`);
    this.hostname = hostname;
  }
}

/** Error raised by the guarded lookup when a hostname resolves to a denied address. */
export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError';
  readonly code = 'EPORTLY_BLOCKED';
  readonly hostname: string;
  constructor(hostname: string) {
    super(`${hostname} resolves to a private or reserved address`);
    this.hostname = hostname;
  }
}

/** Resolves every address of a hostname (default: `dns.lookup(host, {all: true})`). */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type GuardedLookup = (hostname: string, options: LookupOptions | number | undefined, callback: LookupCallback) => void;

function lookupFailure(hostname: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  err.code = 'ENOTFOUND';
  return err;
}

/**
 * `lookup` for `net.connect`/`tls.connect` (via undici's `connect` options): resolves **all**
 * addresses and fails if any of them is denied, so a hostname cannot smuggle a private address
 * next to a public one; the socket then connects only to the addresses validated here.
 */
export function createGuardedLookup(
  resolve: Resolver = defaultResolver,
  deny: (address: string) => boolean = isBlockedAddress,
  denied: (hostname: string) => Error = (hostname) => new BlockedAddressError(hostname),
): GuardedLookup {
  return (hostname, options, callback) => {
    const opts: LookupOptions = typeof options === 'object' && options !== null ? options : {};
    const rawFamily: unknown = typeof options === 'number' ? options : opts.family;
    const family = rawFamily === 4 || rawFamily === 'IPv4' ? 4 : rawFamily === 6 || rawFamily === 'IPv6' ? 6 : 0;
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(lookupFailure(hostname), '');
        if (addresses.some((a) => deny(a.address))) return callback(denied(hostname) as NodeJS.ErrnoException, '');
        const usable = family === 0 ? addresses : addresses.filter((a) => a.family === family);
        const first = usable[0];
        if (!first) return callback(lookupFailure(hostname), '');
        if (opts.all) return callback(null, usable);
        return callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------

/** Ports the Fetch standard refuses ("bad ports"); refused for every policy. */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** `cause`: the lookup's NotPrivateAddressError, or one made here for an IP literal (health code `not_lan`). */
function notLanError(host: string, cause: unknown = new NotPrivateAddressError(host)): SafeFetchError {
  return new SafeFetchError(
    'blocked',
    `${host} is no longer a local network address, so Portly will not send the password to it over plain http`,
    host,
    cause,
  );
}

/** `cause`: the lookup's BlockedAddressError, or one made here for an IP literal / `localhost` name. */
function blockedAddressError(host: string, cause: unknown = new BlockedAddressError(host)): SafeFetchError {
  return new SafeFetchError('blocked', 'Private or reserved addresses cannot be fetched', host, cause);
}

function parseTarget(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new SafeFetchError('bad_url', 'Invalid URL', null);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('bad_url', 'Only http(s) URLs can be fetched', url.host);
  if (url.username || url.password) throw new SafeFetchError('bad_url', 'URLs with credentials cannot be fetched', url.host);
  if (url.hostname === '') throw new SafeFetchError('bad_url', 'URL has no host', null);
  return url;
}

/**
 * `host` without trailing dots. An index scan: `/\.+$/` backtracks quadratically on a long run of
 * dots that is not at the end (hostnames come from hostile redirects and page links).
 */
export function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end--;
  return end === host.length ? host : host.slice(0, end);
}

/** Hostname without IPv6 brackets or trailing dots, lower-cased. */
function bareHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return stripTrailingDots(host);
}

/** Per-hop validation (initial URL and every redirect target). */
function checkTarget(url: URL, policy: FetchPolicy, allowed: ReadonlySet<string> | null): void {
  if (url.port !== '' && BAD_PORTS.has(Number(url.port))) {
    throw new SafeFetchError('blocked', `Port ${url.port} is not allowed`, url.host);
  }
  if (policy === 'public') {
    const host = bareHostname(url.hostname);
    if (net.isIP(host) !== 0) {
      if (isBlockedAddress(host)) throw blockedAddressError(url.host);
    } else if (host === 'localhost' || host.endsWith('.localhost')) {
      throw blockedAddressError(url.host);
    }
  } else if (policy === 'user-server') {
    if (!allowed) throw new SafeFetchError('blocked', 'user-server requests need allowedOrigins', url.host);
    if (!allowed.has(url.origin)) throw new SafeFetchError('blocked', 'Origin is not allowed for this account', url.host);
    // Plain http only to the local network (§8 insecureLan). IP literals skip DNS (and undici's
    // lookup), so they are checked here; names are checked by the LAN agent's lookup.
    const host = bareHostname(url.hostname);
    if (url.protocol === 'http:' && net.isIP(host) !== 0 && !isPrivateAddress(host)) throw notLanError(url.host);
  }
}

// ---------------------------------------------------------------------------
// data: URLs and host heuristics
// ---------------------------------------------------------------------------

export interface DecodedImage {
  /** Sniffed from the bytes; the declared media type is ignored. */
  contentType: ImageContentType;
  bytes: Buffer;
}

function isHexDigit(byte: number | undefined): boolean {
  return byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));
}

/** Percent-decodes a data URL body to bytes (non-ASCII characters count as their UTF-8 bytes). */
function percentDecode(text: string, maxBytes: number): Buffer | null {
  const input = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(input.length);
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    const byte = input[i] ?? 0;
    if (byte === 0x25 && isHexDigit(input[i + 1]) && isHexDigit(input[i + 2])) {
      out[n++] = Number.parseInt(input.toString('latin1', i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = byte;
    }
    if (n > maxBytes) return null;
  }
  return out.subarray(0, n);
}

/**
 * Decodes a `data:` URL holding an image (favicons, §4.8): base64 or percent-encoded, at most
 * `maxBytes` decoded bytes, content type sniffed from the bytes. Returns null when the URL is
 * malformed, too large or not a supported image.
 */
export function decodeDataImage(href: string, maxBytes: number = SIZE_CAPS.image): DecodedImage | null {
  const trimmed = href.trim();
  if (!/^data:/i.test(trimmed)) return null;
  const comma = trimmed.indexOf(',');
  if (comma === -1) return null;
  const meta = trimmed.slice(5, comma);
  const payload = trimmed.slice(comma + 1);
  const isBase64 = /;\s*base64\s*$/i.test(meta);
  let bytes: Buffer | null;
  if (isBase64) {
    const b64 = payload.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) && !/^[A-Za-z0-9_-]*={0,2}$/.test(b64)) return null;
    if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) return null;
    bytes = Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
    if (bytes.length > maxBytes) return null;
  } else {
    if (payload.length > maxBytes * 3) return null;
    bytes = percentDecode(payload, maxBytes);
  }
  if (!bytes || bytes.length === 0) return null;
  const contentType = sniffImageType(bytes);
  return contentType ? { contentType, bytes: Buffer.from(bytes) } : null;
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost', '.localdomain'];

/**
 * True for hosts that must never be sent to third-party favicon services (§4.8): IP literals,
 * single-label names, `localhost` and `.local`, `.lan`, `.home.arpa`, `.internal` (plus
 * `.localhost`, `.localdomain`). Accepts a hostname or `host:port`.
 */
export function isLocalLookingHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return true; // bracketed IPv6 literal
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && net.isIP(h) === 0) h = h.slice(0, colon);
  h = stripTrailingDots(h);
  if (h === '' || h === 'localhost') return true;
  if (net.isIP(h) !== 0) return true;
  if (!h.includes('.')) return true;
  // All-numeric labels (decimal, octal or hex forms) are IPv4 literals in disguise.
  if (h.split('.').every((label) => /^(0x[0-9a-f]*|\d+)$/.test(label))) return true;
  return LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// In-flight outbound calls (Settings → Diagnostics: what a stuck request or job waits for)
// ---------------------------------------------------------------------------

export interface InflightOutbound {
  host: string;
  purpose: string | null;
  /** Running for this long (ms). */
  ms: number;
  /** Log context of the caller: the scheduler run and/or request it belongs to. */
  run?: string;
  rid?: string;
}

interface InflightEntry {
  /** The host being talked to now (follows redirects). */
  host: string;
  purpose: string | null;
  startedAt: number;
  run?: string;
  rid?: string;
}

/** Process-wide: every safe-fetch instance registers its calls here while they run. */
const inflight = new Set<InflightEntry>();

/** Registers a call with the caller's job run and request id (log context); safeFetch removes it when done. */
function startInflight(host: string, purpose: string | null, startedAt: number): InflightEntry {
  const ctx = getLogContext();
  const entry: InflightEntry = { host, purpose, startedAt };
  if (typeof ctx?.run === 'string') entry.run = ctx.run;
  if (typeof ctx?.rid === 'string') entry.rid = ctx.rid;
  inflight.add(entry);
  return entry;
}

/** Outbound calls currently running, oldest first. */
export function inflightOutbound(now: number = Date.now()): InflightOutbound[] {
  return [...inflight]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ host, purpose, startedAt, run, rid }) => ({ host, purpose, ms: Math.max(0, now - startedAt), run, rid }));
}

const PURPOSE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `purpose` when it is a short machine word (anything else is dropped rather than logged). */
function purposeOf(purpose: string | undefined): string | null {
  return typeof purpose === 'string' && PURPOSE.test(purpose) ? purpose : null;
}

/** A header holding a plain number of seconds/requests (`Retry-After: 30`); null otherwise (HTTP dates included). */
function numericHeader(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  return /^\d{1,10}$/.test(text) ? Number(text) : null;
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

export interface CreateSafeFetchOptions {
  version: string;
  log: Logger;
  /** Transport override (tests use `createFakeFetch`). Used for every policy when given. */
  fetchImpl?: typeof fetch;
  /** DNS resolution behind the `public` policy's guarded lookup (tests substitute a fake). */
  resolver?: Resolver;
}

interface TransportInit {
  method: string;
  headers: Headers;
  body: string | Uint8Array | URLSearchParams | undefined;
  signal: AbortSignal;
}

type Transport = (url: URL, init: TransportInit) => Promise<Response>;

async function readCapped(res: Response, max: number, host: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError('too_large', `Response from ${host} exceeds ${max} bytes`, host);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function findCause<T>(err: unknown, ctor: abstract new (...args: never[]) => T): T | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    if (current instanceof ctor) return current;
    if (current instanceof AggregateError) {
      for (const inner of current.errors) if (inner instanceof ctor) return inner;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createSafeFetch(options: CreateSafeFetchOptions): SafeFetch {
  const { log } = options;
  const ua = userAgent(options.version);

  let publicAgent: Agent | null = null;
  let plainAgent: Agent | null = null;
  let lanAgent: Agent | null = null;
  const guardedLookup = createGuardedLookup(options.resolver ?? defaultResolver);
  // Plain-http CalDAV (insecureLan): every address must be a local-network one, at every connect.
  const lanLookup = createGuardedLookup(options.resolver ?? defaultResolver, (address) => !isPrivateAddress(address), (hostname) => new NotPrivateAddressError(hostname));

  const viaUndici =
    (agent: () => Agent): Transport =>
    (url, init) =>
      undiciFetch(url, {
        method: init.method,
        headers: Object.fromEntries(init.headers),
        body: init.body,
        signal: init.signal,
        redirect: 'manual',
        dispatcher: agent(),
      }) as unknown as Promise<Response>;

  const transports: Record<FetchPolicy, Transport> = options.fetchImpl
    ? (() => {
        const impl = options.fetchImpl;
        const t: Transport = (url, init) => impl(url, { ...init, redirect: 'manual' });
        return { provider: t, public: t, 'user-server': t };
      })()
    : {
        provider: (url, init) => globalThis.fetch(url, { ...init, redirect: 'manual' }),
        public: viaUndici(() => (publicAgent ??= new Agent({ connect: { lookup: guardedLookup } }))),
        'user-server': (url, init) =>
          url.protocol === 'http:'
            ? viaUndici(() => (lanAgent ??= new Agent({ connect: { lookup: lanLookup } })))(url, init)
            : viaUndici(() => (plainAgent ??= new Agent()))(url, init),
      };

  const safeFetch = async <A extends ResponseKind>(
    input: string | URL,
    opts: SafeFetchOptions<A>,
  ): Promise<SafeFetchResponse<SafeFetchData<A>>> => {
    let url = parseTarget(input);
    const policy = opts.policy;
    const allowed = opts.allowedOrigins ? new Set(opts.allowedOrigins) : null;
    const transport = transports[policy];
    if (!transport) throw new SafeFetchError('blocked', 'Unknown fetch policy', url.host);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES[opts.as];
    const redirectMode = opts.redirect ?? 'follow';

    const requestMethod = (opts.method ?? 'GET').toUpperCase();
    let method = requestMethod;
    let body = opts.body;
    const headers = new Headers(opts.headers);
    headers.set('User-Agent', ua);
    if (!headers.has('Accept')) {
      headers.set('Accept', opts.as === 'json' ? 'application/json' : opts.as === 'text' ? 'text/html,text/plain;q=0.9,*/*;q=0.5' : '*/*');
    }

    const firstHost = url.host;
    const purpose = purposeOf(opts.purpose);
    /** Hosts of the redirects followed, in order. */
    const hops: string[] = [];
    let status: number | null = null;
    const started = Date.now();
    const entry = startInflight(firstHost, purpose, started);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let res: Response;
    try {
      checkTarget(url, policy, allowed);
      for (let hop = 0; ; hop++) {
        res = await transport(url, { method, headers, body, signal });
        const location = res.headers.get('location');
        const isRedirect = REDIRECT_STATUSES.has(res.status) && location !== null;
        if (!isRedirect || redirectMode === 'manual') break;
        await res.body?.cancel().catch(() => {});
        if (redirectMode === 'error') throw new SafeFetchError('redirect', `Unexpected redirect from ${url.host}`, url.host);
        if (hop >= MAX_REDIRECTS) throw new SafeFetchError('redirect', `Too many redirects from ${url.host}`, url.host);

        let next: URL;
        try {
          next = parseTarget(new URL(location, url));
        } catch {
          throw new SafeFetchError('redirect', `Invalid redirect from ${url.host}`, url.host);
        }
        checkTarget(next, policy, allowed);
        const trustedHop = policy === 'user-server' && allowed?.has(next.origin) === true;
        if (next.origin !== url.origin && !trustedHop) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          headers.delete('content-type');
        }
        url = next;
        hops.push(next.host);
        entry.host = next.host;
      }

      status = res.status;
      const bytes = await readCapped(res, maxBytes, url.host);

      let data: unknown;
      if (opts.as === 'bytes') data = bytes;
      else {
        const text = bytes.toString('utf8');
        if (opts.as === 'text') data = text;
        else if (text.trim() === '') data = null;
        else {
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            throw new SafeFetchError('invalid_json', `Invalid JSON from ${url.host}`, url.host, parseErr);
          }
        }
      }

      const fields: LogFields = {
        method: requestMethod,
        host: firstHost,
        policy,
        purpose: purpose ?? undefined,
        status,
        ms: Date.now() - started,
        bytes: bytes.length,
      };
      if (hops.length > 0) fields.redirects = hops.length;
      if (url.host !== firstHost) fields.finalHost = url.host;
      const retryAfter = numericHeader(res.headers.get('retry-after'));
      if (retryAfter !== null) fields.retryAfter = retryAfter;
      const remaining = numericHeader(res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining'));
      if (remaining !== null) fields.rateLimitRemaining = remaining;
      if (policy !== 'public' && status >= 400) log.info('outbound', { ...fields, repeatKey: `${firstHost} ${purpose ?? ''} ${status}` });
      else log.debug('outbound', fields);

      return { status, headers: res.headers, url: url.href, data: data as SafeFetchData<A>, redirects: hops.length };
    } catch (err) {
      const base: LogFields = { method: requestMethod, host: firstHost, policy, purpose: purpose ?? undefined, ms: Date.now() - started };
      if (status !== null) base.status = status;
      base.hops = hops.slice(0, MAX_REDIRECTS);

      let failure: SafeFetchError;
      let reason: string;
      if (err instanceof SafeFetchError) {
        failure = err;
        reason = err.reason === 'blocked' && findCause(err.cause, NotPrivateAddressError) ? 'not_lan' : err.reason;
      } else {
        const notLan = findCause(err, NotPrivateAddressError);
        const blocked = notLan ? null : findCause(err, BlockedAddressError);
        if (notLan) {
          failure = notLanError(url.host, notLan);
          reason = 'not_lan';
        } else if (blocked) {
          failure = blockedAddressError(url.host, blocked);
          reason = 'blocked';
        } else if (timeout.aborted) {
          failure = new SafeFetchError('timeout', `Request to ${url.host} timed out`, url.host, err);
          reason = 'timeout';
        } else if (opts.signal?.aborted) {
          log.debug('outbound aborted', base);
          throw err;
        } else {
          failure = new SafeFetchError('network', `Could not reach ${url.host}`, url.host, err);
          reason = 'network';
        }
      }

      const cause = errorFields(failure);
      const line: LogFields = { ...base, reason, cause: cause.cause, causeCode: cause.causeCode };
      if ((reason === 'blocked' || reason === 'not_lan') && failure.host !== null) line.blockedHost = failure.host;
      if (policy === 'public') log.debug('outbound failed', line);
      else log.warn('outbound failed', { ...line, repeatKey: `${firstHost} ${purpose ?? ''} ${reason}` });
      throw failure;
    } finally {
      inflight.delete(entry);
    }
  };
  return safeFetch;
}
