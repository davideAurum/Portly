/**
 * Diagnostics contracts (ARCHITECTURE §3, §17): log levels and areas, the machine codes a health
 * outcome may carry, the scrubbing rules every log line, memory ring, report and browser event
 * passes through, and the DTOs of `/api/diagnostics/*`.
 *
 * Privacy (§17): nothing that leaves these helpers may contain a secret (tokens, passwords, OAuth
 * codes and PKCE verifiers, client secrets, pairing tokens and nonces, cookies, Authorization
 * headers, URL credentials), a full URL (`scheme://host/…` only) or an unmasked user path
 * (`C:\Users\~\…`). Content (mail, events, tasks, titles, search text) must never be passed in.
 * Browser-safe: no `node:` imports — the server's logger and the web app's event log share them.
 */
import { z } from 'zod';
import { IsoDateTime, VaultStateSchema } from './core.ts';

// ---------------------------------------------------------------------------
// Levels, areas, codes
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LogLevelSchema = z.enum(LOG_LEVELS);
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** Response header carrying the server's id for a request (also exposed to the Pages site). */
export const REQUEST_ID_HEADER = 'X-Request-Id';
export const REQUEST_ID_REGEX = /^[a-z0-9]{10}$/;

/** Areas: log filters and verbose scopes (they match any of a record's tags). */
export const DIAGNOSTIC_AREAS = [
  'server',
  'core',
  'accounts',
  'calendar',
  'mail',
  'todoist',
  'feeds',
  'weather',
  'sports',
  'search',
  'bookmarks',
  'pairing',
  'diagnostics',
  'fetch',
  'scheduler',
  'health',
  'vault',
  'settings',
  'console',
  'client',
] as const;
export type DiagnosticArea = (typeof DIAGNOSTIC_AREAS)[number];

/** Machine codes a health outcome may carry (the UI maps each to a remedy and a troubleshooting anchor). */
export const HEALTH_CODES = [
  'rate_limited',
  'account_unavailable',
  'reauth_required',
  'api_disabled',
  'insufficient_scope',
  'denied',
  'not_found',
  'timeout',
  'dns',
  'refused',
  'reset',
  'tls',
  'blocked',
  'not_lan',
  'network',
  'redirect',
  'bad_url',
  'http_4xx',
  'http_5xx',
  'parse_error',
  'not_a_feed',
  'too_large',
  'token_rejected',
  'storage_limit',
  'truncated',
  'vault_locked',
  'not_configured',
  'auth_failed',
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'caldav_password_rejected',
  'imap_password_rejected',
  'credentials_reset',
  'client_rejected',
  'refresh_unreachable',
  'calendar_list_failed',
  'no_credentials',
  'worker_failed',
  'internal',
] as const;
export type HealthCode = (typeof HEALTH_CODES)[number];

/** A provider/library machine token that is safe to log (Todoist `error_tag`, OAuth `error`, Graph `error.code`, IMAP codes …). */
export const REASON_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

// ---------------------------------------------------------------------------
// Scrubbing (free text)
// ---------------------------------------------------------------------------

export const REDACTED = '[REDACTED]';

export type ScrubReplacement = string | ((match: string, ...groups: string[]) => string);

/** A secret value after its key: already redacted, quoted (escapes honoured) or bare up to a delimiter. */
const SECRET_VALUE = String.raw`(\[REDACTED\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'&,;}\]\\]+)`;

/** Compound / camelCase secret keys (`accessToken`, `nextPageToken`, `client_secret`, `appPassword`, `$deltatoken` …). */
const SECRET_KEY_NAMES = String.raw`(?:[A-Za-z0-9]*?(?:access|refresh|id|page|sync|delta|skip|pairing|api|bearer|session|csrf|xsrf)[_-]?token)|(?:[A-Za-z0-9]+[_-]?secret)|(?:code[_-]?verifier)|(?:[A-Za-z0-9]*?password)|(?:passphrase(?:key)?)|cachekey|(?:api[_-]?key)|(?:\$(?:delta|skip)token)`;

/** Keeps the key, the separator and the value's quotes; replaces the value. */
function redactKeyValue(_match: string, key: string, separator: string, value: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
  return `${key}${separator}${quote}${REDACTED}${quote}`;
}

/**
 * Secret-bearing patterns, applied in order by {@link scrub}. Each is idempotent: a value that is
 * already `[REDACTED]` matches again and is replaced by itself.
 */
export const SCRUB_PATTERNS: readonly (readonly [RegExp, ScrubReplacement])[] = [
  // 1. Authorization schemes (token68 charset only, so it never eats a `\` or `"`).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`],
  // 2. Header dumps: the whole value up to the end of the line or the closing quote (multi-cookie headers).
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-homebase-token)(["']?\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\r\n"']+)/gi,
    redactKeyValue,
  ],
  // 3. Compound / camelCase secret keys with any separator (`password: x`, `"accessToken":"…"`, `nextPageToken=…`).
  [new RegExp(String.raw`\b(${SECRET_KEY_NAMES})(["']?\s*[:=]\s*)` + SECRET_VALUE, 'gi'), redactKeyValue],
  // 4. Bare generic words only as `k=v` or a quoted key `"k": v` (never prose such as `token: missing`);
  //    `code` only as `code=…` (`"code":"ETIMEDOUT"` is an error code).
  [
    new RegExp(String.raw`(?<![A-Za-z0-9_-])(token|secret|nonce|code)(=|["']\s*:\s*)` + SECRET_VALUE, 'gi'),
    (match, key, separator, value) =>
      key.toLowerCase() === 'code' && separator !== '=' ? match : redactKeyValue(match, key, separator, value),
  ],
  // 5. URL-encoded `=` (a query string inside another parameter, e.g. `returnTo=%2F%3Faccess_token%3D…`).
  [
    /(?<=^|[^A-Za-z0-9_]|%[0-9A-Fa-f]{2})(access_token|refresh_token|id_token|client_secret|code_verifier|code|token|nonce)(%3D)((?:(?!%26)[^\s"'&])+)/gi,
    `$1$2${REDACTED}`,
  ],
  // 6. URL credentials (`https://user:pw@host`). The scheme is matched from the start of its run of
  //    scheme characters only (the prototype's `\b[a-z]…` restarts inside every `a-a-a…` run:
  //    quadratic on long strings); any run before `://` counts, so this redacts a superset.
  [/(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)[^\s/@"']+@/gi, `$1${REDACTED}@`],
  // 7. Well-known token shapes: Google access/refresh tokens and client secrets, JWTs.
  [/\bya29\.[A-Za-z0-9._-]+|\b1\/\/[A-Za-z0-9._-]{20,}|\bGOCSPX-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
];

// User paths: `C:\Users\<name>\…` in every spelling Node, Windows and URLs produce (`\`, `\\`, `/`,
// `%5C`, `%2F`, `file:///C:/…`, `C%3A`, `/c/Users`, `\\?\C:`, UNC `\\host\Users`), plus POSIX `/home`
// and `/Users`. The name may contain spaces, dots and `~` (`Riley Hollis`, `riley.CONTOSO`, `RILEY~1`),
// percent-escapes other than a separator (file URLs: `Riley%20G`, `O%27Brien`, `Jos%C3%A9`) and an inner
// apostrophe (`O'Brien`). A `'` followed by a space, punctuation or the end closes a quoted path instead
// (`open 'C:\Users\riley' failed`).
const PATH_SEP = String.raw`(?:\\\\|\\|\/|%5[Cc]|%2[Ff])`;
const PROFILE_NAME_UNIT = String.raw`(?:[^\\\/:*?"<>|'\r\n%]|%(?!5[Cc]|2[Ff])[0-9A-Fa-f]{2})`;
const PROFILE_NAME = String.raw`${PROFILE_NAME_UNIT}+(?:'(?![\s,;.)\]}])${PROFILE_NAME_UNIT}+)*`;
const PATH_ANCHOR = String.raw`(?:\b[A-Za-z]:|\b[A-Za-z]%3[Aa]|(?:^|(?<=[\s"'(=,:\[]))\/[A-Za-z](?=\/)|(?:\\\\|\\)[A-Za-z0-9.$_-]+|(?:^|(?<=[\s"'(=,:\[])))`;
const USER_PATH_RE = new RegExp(
  String.raw`(${PATH_ANCHOR}${PATH_SEP}(?:Users|home)${PATH_SEP})(${PROFILE_NAME})(?=${PATH_SEP}|$|["'\s,;)\]}])`,
  'gi',
);
/** Shared profile folders that name nobody. */
const KEEP_PROFILE_NAMES = new Set(['public', 'default', 'default user', 'all users', '~']);

/** Replaces the user name in every user-profile path with `~` (`C:\Users\riley\x` → `C:\Users\~\x`). Idempotent. */
export function maskUserPaths(text: string): string {
  return text.replace(USER_PATH_RE, (match: string, prefix: string, name: string) =>
    KEEP_PROFILE_NAMES.has(name.toLowerCase()) ? match : `${prefix}~`,
  );
}

// V8 `JSON.parse` errors quote the start of the input, which is a response body:
// `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, `"undefined" is not valid JSON`.
const JSON_SNIPPET_RE = /(?:\.\.\.)?"[\s\S]{0,80}?"(?:\.\.\.)?(?= is not valid JSON)/g;
// The same message cut before its ` is not valid JSON` tail.
const JSON_TOKEN_SNIPPET_RE = /(Unexpected token '[^\r\n]{1,2}', )(?!"…" is not valid JSON)(?:\.\.\.)?"[^\r\n]*/g;
// ICS subscription URLs carry their secret in the path.
const WEBCAL_RE = /\b(webcals?):\/\/([^\s"'<>]*)/gi;

/** Host (and port) of the authority at the start of `rest` (`user@host:1/x` → `host:1`). */
function authorityHost(rest: string): string {
  const end = rest.search(/[/?#\\]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  return authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
}

function scrubPatterns(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB_PATTERNS) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Makes free text safe to log: secret patterns ({@link SCRUB_PATTERNS}), user paths
 * ({@link maskUserPaths}), quoted `JSON.parse` input (→ `"…"`) and `webcal(s)://` URLs
 * (→ `webcal(s)://<host>/…`, the path holds the subscription secret). Idempotent.
 */
export function scrub(text: string): string {
  let out = scrubPatterns(typeof text === 'string' ? text : String(text));
  out = maskUserPaths(out);
  out = out.replace(JSON_SNIPPET_RE, '"…"').replace(JSON_TOKEN_SNIPPET_RE, '$1"…"');
  return out.replace(WEBCAL_RE, (_match, scheme: string, rest: string) => `${scheme.toLowerCase()}://${authorityHost(rest)}/…`);
}

// ---------------------------------------------------------------------------
// Scrubbing (values)
// ---------------------------------------------------------------------------

/** Keys whose value is a secret whatever its type. */
const SECRET_KEY_RE =
  /^(refresh_?token|access_?token|id_?token|client_?secret|app_?password|password|passphrase(key)?|cache_?key|token|nonce|secret|api_?key|x-homebase-token|cookie|set-cookie|authorization|code_?verifier|code)$/i;
/** The compound keys of {@link SCRUB_PATTERNS} rule 3 as whole keys (`nextPageToken`, `clientSecret`, `syncToken` …). */
const COMPOUND_SECRET_KEY_RE = new RegExp(String.raw`^(?:${SECRET_KEY_NAMES})$`, 'i');
/** A `code` value that is an error code (`ECONNREFUSED`, `provider_error`), not an OAuth code. */
const ERROR_CODE_VALUE = /^[A-Za-z_]{2,40}$/;
const HEALTH_CODE_SET: ReadonlySet<string> = new Set(HEALTH_CODES);
/** Keys whose string value is a URL (reduced to `scheme://host/…` even when relative or malformed). */
const URL_KEYS = new Set(['url', 'href', 'uri', 'link', 'feedurl', 'icsurl', 'deltalink', 'nextlink', 'location', 'redirecturl']);
const ABSOLUTE_URL = /^\s*(https?|webcals?|wss?|file):\/\//i;
const URL_PREFIX = /^\s*([a-z][a-z0-9+.-]*):\/\/([^/?#\\\s]*)/i;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_MAX_STRING = 2048;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 200;
const MAX_ERROR_MESSAGE = 300;

export interface ScrubFieldsOptions {
  /** Longest string kept (longer ones end with `…`); default 2048. */
  maxString?: number;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || COMPOUND_SECRET_KEY_RE.test(key);
}

/** `code` values kept under a secret key: error codes (letters/underscores, health codes) and numbers (exit codes). */
function isErrorCodeValue(value: unknown): boolean {
  if (typeof value === 'number') return true;
  return typeof value === 'string' && (ERROR_CODE_VALUE.test(value) || HEALTH_CODE_SET.has(value));
}

/** Cuts `text` to at most `max` characters, ending with `…` when cut. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * `scheme://host/…` for an absolute URL (`file:` → its masked path); a bare origin (`scheme://host`,
 * optionally with a lone `/`) has nothing to hide and stays as it is; a relative one loses its query
 * and fragment.
 */
function reduceUrl(value: string): string {
  const m = URL_PREFIX.exec(value);
  if (!m) {
    const cut = value.search(/[?#]/);
    return cut === -1 ? value : value.slice(0, cut);
  }
  const scheme = (m[1] ?? '').toLowerCase();
  if (scheme === 'file') {
    const trimmed = value.trim();
    const cut = trimmed.search(/[?#]/);
    return maskUserPaths(cut === -1 ? trimmed : trimmed.slice(0, cut));
  }
  const origin = `${scheme}://${authorityHost(m[2] ?? '')}`;
  const rest = value.slice(m[0].length).trimEnd();
  if (rest === '' || rest === '/') return `${origin}${rest}`;
  return `${origin}/…`;
}

function scrubString(value: string, key: string | null, maxString: number): string {
  // Bound the regex work on huge strings; whatever is cut here lies past the final cap.
  let out = value.length > maxString * 8 ? value.slice(0, maxString * 8) : value;
  if ((key !== null && URL_KEYS.has(key.toLowerCase())) || ABSOLUTE_URL.test(out)) out = reduceUrl(out);
  return cap(scrub(out), maxString);
}

/** `{errName, errMessage, errCode?}` of an Error value (the server's `errorFields` is richer). */
function errorSummary(err: Error): Record<string, string | number> {
  const out: Record<string, string | number> = {
    errName: cap(scrub(String(err.name)), 100),
    errMessage: cap(scrub(String(err.message).slice(0, MAX_ERROR_MESSAGE * 8)), MAX_ERROR_MESSAGE),
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') out.errCode = cap(scrub(code), 100);
  else if (typeof code === 'number') out.errCode = code;
  return out;
}

/**
 * Makes any value safe to log; the result is plain JSON data (never run {@link scrub} over
 * `JSON.stringify(...)` output — escaped quotes defeat the patterns and redaction can break the JSON).
 *
 * - keys naming a secret (`password`, `access_token`, `cookie`, `nextPageToken` …) → `[REDACTED]`
 *   whatever the value's type; `code` keeps error codes (`ECONNREFUSED`, `provider_error`, numbers);
 * - strings: URL-valued keys (`url`, `href`, `feedUrl`, `location` …) and absolute URLs are reduced to
 *   `scheme://host/…` (`file:` → masked path), then {@link scrub}, then capped at `maxString`;
 * - Errors → `{errName, errMessage (≤ 300), errCode?}`; bigint → string; functions/symbols/undefined
 *   dropped (`null` in arrays); cycles → `'[Circular]'`; deeper than 6 levels → `'[…]'`; arrays keep
 *   50 items (+ a `'[… n more]'` marker), objects 200 keys; `__proto__`/`constructor`/`prototype` dropped.
 */
export function scrubFields(value: unknown, opts: ScrubFieldsOptions = {}): unknown {
  const maxString = Math.max(16, opts.maxString ?? DEFAULT_MAX_STRING);
  const ancestors = new Set<object>();

  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    switch (typeof v) {
      case 'string':
        return scrubString(v, key, maxString);
      case 'number':
        return Number.isFinite(v) ? v : String(v);
      case 'boolean':
        return v;
      case 'bigint':
        return v.toString();
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
      default:
        break;
    }
    if (v === null) return null;
    const obj = v as object;
    if (ancestors.has(obj)) return '[Circular]';
    if (depth > MAX_DEPTH) return '[…]';
    if (obj instanceof Error) return errorSummary(obj);
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`;
    ancestors.add(obj);
    try {
      if (obj instanceof Map) {
        const entries: Record<string, unknown> = {};
        for (const [k, item] of obj) if (!PROTOTYPE_KEYS.has(String(k))) entries[String(k)] = item;
        return walkObject(entries, depth);
      }
      if (obj instanceof Set) return walkArray([...obj], key, depth);
      if (Array.isArray(obj)) return walkArray(obj, key, depth);
      const toJSON = (obj as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        const json: unknown = toJSON.call(obj, key ?? '');
        if (json !== obj) return walk(json, key, depth);
      }
      return walkObject(obj as Record<string, unknown>, depth);
    } catch {
      return '[unreadable]';
    } finally {
      ancestors.delete(obj);
    }
  };

  const walkArray = (items: readonly unknown[], key: string | null, depth: number): unknown[] => {
    const out = items.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, key, depth + 1) ?? null);
    if (items.length > MAX_ARRAY_ITEMS) out.push(`[… ${items.length - MAX_ARRAY_ITEMS} more]`);
    return out;
  };

  const walkObject = (obj: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    let kept = 0;
    for (const k of keys) {
      if (PROTOTYPE_KEYS.has(k)) continue;
      if (kept === MAX_OBJECT_KEYS) {
        out['[…]'] = `${keys.length - MAX_OBJECT_KEYS} more keys`;
        break;
      }
      let item: unknown;
      try {
        item = obj[k];
      } catch {
        item = '[unreadable]';
      }
      const safeKey = cap(scrub(k), 200);
      // null, undefined and booleans hold no secret (a request line's `code: null`, `token: false`).
      const holdsNothing = item === null || item === undefined || typeof item === 'boolean';
      if (isSecretKey(k) && !holdsNothing && !(k.toLowerCase() === 'code' && isErrorCodeValue(item))) {
        out[safeKey] = REDACTED;
      } else {
        const scrubbed = walk(item, k, depth + 1);
        if (scrubbed === undefined) continue;
        out[safeKey] = scrubbed;
      }
      kept++;
    }
    return out;
  };

  return walk(value, null, 0);
}

// ---------------------------------------------------------------------------
// Redaction for sharing (report `redact=1`, "Copy summary")
// ---------------------------------------------------------------------------

/**
 * What {@link redactForSharing} replaces besides its regex fallbacks. The report builder fills it
 * (server: account labels/emails/usernames, IMAP/CalDAV/webmail/ICS/feed hosts, calendar names,
 * `os.hostname()`, `os.userInfo().username`; web: the same for what it adds). Values of
 * `host`/`hostname`/`finalHost`/`blockedHost`/`imapHost`/`origin`/`pagesOrigin` keys and `hops`
 * arrays found in the value are added automatically, plus the first DNS label of a `pagesOrigin`.
 */
export interface RedactionDictionary {
  /** → `host#n` */
  hosts?: Iterable<string | null | undefined>;
  /** → `email#n` */
  emails?: Iterable<string | null | undefined>;
  /** Account labels → `label#n` */
  labels?: Iterable<string | null | undefined>;
  /** Calendar names, user names, profile names → `name#n` */
  names?: Iterable<string | null | undefined>;
  /** Terms never replaced (e.g. well-known provider hosts the reader may see). */
  keep?: Iterable<string | null | undefined>;
}

type RedactionKind = 'host' | 'email' | 'label' | 'name' | 'ip';

/** Keys whose values are hosts or origins (collected from the value itself). */
const HOST_KEYS = new Set(['host', 'hostname', 'finalhost', 'blockedhost', 'imaphost', 'origin', 'pagesorigin']);
const HOST_LIST_KEYS = new Set(['hops']);
/** Generic words that identify nobody: never treated as a name or label (a calendar called "Calendar"). */
const GENERIC_TERMS: ReadonlySet<string> = new Set([
  ...DIAGNOSTIC_AREAS,
  ...LOG_LEVELS,
  'ok',
  'degraded',
  'failing',
  'stale',
  'unknown',
  'host',
  'email',
  'label',
  'name',
  'calendar',
  'calendars',
  'personal',
  'work',
  'home',
  'family',
  'birthdays',
  'holidays',
  'tasks',
  'reminders',
  'events',
  'default',
  'primary',
  'main',
  'other',
  'inbox',
  'contacts',
  'shared',
  'private',
  'public',
  'test',
  'google',
  'microsoft',
  'outlook',
  'yahoo',
  'icloud',
  'gmail',
  'caldav',
  'imap',
  'homebase',
  'localhost',
  'www',
  'app',
  'api',
  'web',
  'pages',
  'github',
  'user',
  'admin',
  'null',
  'none',
  'undefined',
]);
const MIN_TERM_LENGTH = 3;
const TOKEN_RE = /^(?:host|email|label|name|ip)#\d+/;
/**
 * Emails, as a tokenizer that consumes the text run by run: a run of local-part characters with an
 * optional `@domain` (group 2 set = an email), or a run of other characters. An unanchored email
 * pattern restarts inside every run (quadratic on long runs); this finds the same emails linearly.
 */
const EMAIL_TOKEN_RE = /([A-Za-z0-9._%+-]+)(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})?|[^A-Za-z0-9._%+-]+/g;
/**
 * `scheme://authority` unless the authority is already a placeholder (`https://host#1`); the
 * scheme starts at the start of its run of scheme characters (linear, see SCRUB_PATTERNS rule 6).
 */
const AUTHORITY_RE = /(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)(?!(?:[^/?#\s"'<>\\@]*@)?(?:host|email|label|name|ip)#\d)([^/?#\s"'<>\\]+)/gi;
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g;
const IPV6_RE = /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])/g;
const DIGIT_DOT_DIGIT = /\d\.\d/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Memo of {@link redactForSharing}'s text pass: strings up to this length, at most this many. */
const MAX_CACHED_TEXT = 512;
const MAX_CACHE_ENTRIES = 50_000;

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0' || /^127\./.test(h);
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || (h.includes(':') && /^[0-9A-Fa-f:.]+$/.test(h));
}

/** Hostname of `host[:port]`, `[v6]:port` or `scheme://host[:port]/…`; null when there is none. */
function hostOf(value: string): string | null {
  let rest = value.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  const end = rest.search(/[/?#\\\s]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    return close === -1 ? null : authority.slice(0, close + 1).toLowerCase();
  }
  const colon = authority.indexOf(':');
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  return host === '' ? null : host;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Replaces hosts, emails and names in every key and string of `value` (a scrubbed report) with
 * stable placeholders: dictionary terms case-insensitively, longest first (whole words for names
 * and labels) → `host#n`, `email#n`, `label#n`, `name#n`; then the rest by pattern: emails →
 * `email#n`, URL authorities → `scheme://host#n`, non-loopback IP literals → `ip#n`. Loopback hosts
 * and terms shorter than 3 characters or generic ("Calendar", "Work") are kept. Numbering is stable
 * within one call. Returns new plain data; the input is not modified.
 */
export function redactForSharing(value: unknown, dict: RedactionDictionary = {}): unknown {
  const keep = new Set<string>();
  for (const term of dict.keep ?? []) if (typeof term === 'string' && term.trim() !== '') keep.add(term.trim().toLowerCase());

  /** lower-cased term → kind (dictionary and collected terms). */
  const kinds = new Map<string, RedactionKind>();
  const addTerm = (raw: unknown, kind: RedactionKind): void => {
    if (typeof raw !== 'string') return;
    const term = raw.trim();
    const lower = term.toLowerCase();
    if (term.length < MIN_TERM_LENGTH || keep.has(lower) || kinds.has(lower) || TOKEN_RE.test(lower)) return;
    if (kind === 'host' && isLoopbackHost(term)) return;
    // A single word ("Calendar", a host called "mail") would hit areas, keys and messages everywhere.
    if (kind !== 'email' && GENERIC_TERMS.has(lower)) return;
    kinds.set(lower, kind);
  };
  const addHost = (raw: unknown, firstLabelAsName = false): void => {
    if (typeof raw !== 'string') return;
    const host = hostOf(raw);
    if (host === null || isLoopbackHost(host)) return;
    addTerm(host, isIpLiteral(host) ? 'ip' : 'host');
    if (firstLabelAsName && !isIpLiteral(host)) {
      const first = host.split('.')[0] ?? '';
      if (host.includes('.') && !/^\d+$/.test(first)) addTerm(first, 'name');
    }
  };

  for (const email of dict.emails ?? []) addTerm(email, 'email');
  for (const host of dict.hosts ?? []) addHost(host);
  for (const label of dict.labels ?? []) addTerm(label, 'label');
  for (const name of dict.names ?? []) addTerm(name, 'name');

  // Hosts and origins found in the value itself.
  const seen = new Set<object>();
  const collect = (v: unknown, key: string | null): void => {
    if (typeof v === 'string') {
      const k = key?.toLowerCase() ?? '';
      if (HOST_KEYS.has(k) || HOST_LIST_KEYS.has(k)) addHost(v, k === 'pagesorigin');
      return;
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) collect(item, key);
      return;
    }
    for (const [k, item] of Object.entries(v)) collect(item, k);
  };
  collect(value, null);

  const counters: Record<RedactionKind, number> = { host: 0, email: 0, label: 0, name: 0, ip: 0 };
  /** lower-cased term → placeholder, assigned on first use. */
  const tokens = new Map<string, string>();
  const tokenFor = (term: string, kind: RedactionKind): string => {
    const lower = term.toLowerCase();
    let token = tokens.get(lower);
    if (token === undefined) {
      counters[kind]++;
      token = `${kind}#${counters[kind]}`;
      tokens.set(lower, token);
    }
    return token;
  };

  const terms = [...kinds.keys()].sort((a, b) => b.length - a.length);
  const termRe =
    terms.length === 0
      ? null
      : new RegExp(
          terms
            .map((term) => {
              const before = WORD_CHAR.test(term[0] ?? '') ? String.raw`(?<![\p{L}\p{N}_])` : '';
              const after = WORD_CHAR.test(term[term.length - 1] ?? '') ? String.raw`(?![\p{L}\p{N}_])` : '';
              return `${before}${escapeRegExp(term)}${after}`;
            })
            .join('|'),
          'giu',
        );

  const redactUncached = (text: string): string => {
    let out = text;
    // Each pass only when its anchor character is present (most strings are areas, levels, ids, times).
    if (out.includes('@')) {
      out = out.replace(EMAIL_TOKEN_RE, (match, _local: string | undefined, domain: string | undefined) =>
        domain === undefined || keep.has(match.toLowerCase()) ? match : tokenFor(match, 'email'),
      );
    }
    if (out.includes('://')) {
      out = out.replace(AUTHORITY_RE, (match, scheme: string, authority: string) => {
        const host = hostOf(authority);
        if (host === null || isLoopbackHost(host) || keep.has(host)) return match;
        return `${scheme}${tokenFor(host, kinds.get(host) ?? (isIpLiteral(host) ? 'ip' : 'host'))}`;
      });
    }
    if (termRe !== null) out = out.replace(termRe, (match) => tokenFor(match, kinds.get(match.toLowerCase()) ?? 'name'));
    if (DIGIT_DOT_DIGIT.test(out)) out = out.replace(IPV4_RE, (ip) => (isLoopbackHost(ip) || keep.has(ip) ? ip : tokenFor(ip, 'ip')));
    if (!out.includes(':')) return out;
    return out.replace(IPV6_RE, (ip) => {
      const doubleColons = ip.split('::').length - 1;
      const looksLikeIp = (doubleColons === 1 && /[0-9A-Fa-f]/.test(ip)) || (doubleColons === 0 && ip.split(':').length === 8);
      return !looksLikeIp || isLoopbackHost(ip) || keep.has(ip.toLowerCase()) ? ip : tokenFor(ip, 'ip');
    });
  };

  // Reports repeat the same keys and values (areas, messages, hosts, ids) thousands of times. A
  // cached result is what a second pass would give: its placeholders are already numbered.
  const cache = new Map<string, string>();
  const redactText = (text: string): string => {
    if (text.length > MAX_CACHED_TEXT) return redactUncached(text);
    let out = cache.get(text);
    if (out === undefined) {
      out = redactUncached(text);
      if (cache.size < MAX_CACHE_ENTRIES) cache.set(text, out);
    }
    return out;
  };

  const ancestors = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v);
    if (v === null || typeof v !== 'object') return v;
    if (ancestors.has(v)) return '[Circular]';
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) {
        if (PROTOTYPE_KEYS.has(k)) continue;
        out[redactText(k)] = walk(item);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  return walk(value);
}

// ---------------------------------------------------------------------------
// Log records and queries (`GET /api/diagnostics/logs`)
// ---------------------------------------------------------------------------

export const LOG_SOURCES = ['server', 'client', 'supervisor'] as const;
export const LogSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.output<typeof LogSourceSchema>;

export const LogRecordSchema = z
  .object({
    /** Per process, increasing; 0 for records read from log files. */
    seq: z.number().int(),
    /** When the server recorded it. */
    t: IsoDateTime,
    /** Browser events: the event time corrected for clock skew; otherwise null. */
    tEvent: IsoDateTime.nullable(),
    level: LogLevelSchema,
    msg: z.string(),
    src: LogSourceSchema,
    /** Primary area (the module that wrote the line, or the unit of work's area for shared infrastructure). */
    area: z.string(),
    /** Every area the record belongs to (filters and verbose scopes match any of them). */
    tags: z.array(z.string()),
    rid: z.string().nullable(),
    /** Scrubbed; includes context fields such as job, run, accountId, calendarId, feed. */
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();
export type LogRecord = z.output<typeof LogRecordSchema>;

/** Query of `GET /api/diagnostics/logs` (strings are coerced). */
export const LogsQuerySchema = z.object({
  scope: z.enum(['memory', 'files']).default('memory'),
  /** memory: records with `seq > after`. */
  after: z.coerce.number().int().optional(),
  /** Time window (files and memory). */
  before: IsoDateTime.optional(),
  since: IsoDateTime.optional(),
  level: LogLevelSchema.default('debug'),
  /** Matches any of a record's tags. */
  area: z.string().max(32).optional(),
  src: LogSourceSchema.optional(),
  rid: z.string().max(32).optional(),
  job: z.string().max(64).optional(),
  run: z.string().max(16).optional(),
  accountId: z.string().max(64).optional(),
  calendarId: z.string().max(512).optional(),
  feed: z.string().max(16).optional(),
  pairingId: z.string().max(64).optional(),
  /** A health key; mapped to the context field it corresponds to. */
  key: z.string().max(600).optional(),
  /** Case-insensitive substring of the message or the JSON of the fields. */
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export type LogsQuery = z.output<typeof LogsQuerySchema>;
export type LogsQueryInput = z.input<typeof LogsQuerySchema>;

export const LogsResponseSchema = z
  .object({
    records: z.array(LogRecordSchema),
    lastSeq: z.number().int(),
    truncated: z.boolean(),
    scope: z.enum(['memory', 'files']),
  })
  .strict();
export type LogsResponse = z.output<typeof LogsResponseSchema>;

// ---------------------------------------------------------------------------
// Health (`GET /api/diagnostics/summary`, `GET /api/diagnostics/health/:key/history`)
// ---------------------------------------------------------------------------

export const HEALTH_STATUSES = ['ok', 'degraded', 'failing', 'stale', 'unknown'] as const;
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.output<typeof HealthStatusSchema>;

export const HealthEntrySchema = z
  .object({
    key: z.string(),
    area: z.string(),
    /** Resolved at read time (account label, calendar name, host, job name). */
    label: z.string().nullable(),
    accountId: z.string().nullable(),
    /** `stale` is derived at read time. */
    status: HealthStatusSchema,
    lastOkAt: IsoDateTime.nullable(),
    lastFailAt: IsoDateTime.nullable(),
    failingSince: IsoDateTime.nullable(),
    lastCheckedAt: IsoDateTime.nullable(),
    expectEveryMs: z.number().int().nullable(),
    consecutiveFailures: z.number().int(),
    lastCode: z.string().nullable(),
    lastStatus: z.number().int().nullable(),
    lastMessage: z.string().nullable(),
    lastMs: z.number().int().nullable(),
    detail: z.record(z.string(), z.unknown()).nullable(),
    /** The subject this one fails because of, e.g. `account:<id>`. */
    causeKey: z.string().nullable(),
    nextAttemptAt: IsoDateTime.nullable(),
    updatedAt: IsoDateTime,
  })
  .strict();
export type HealthEntry = z.output<typeof HealthEntrySchema>;

export const OutcomeRowSchema = z
  .object({
    id: z.number().int(),
    key: z.string(),
    at: IsoDateTime,
    lastAt: IsoDateTime,
    count: z.number().int(),
    ok: z.boolean(),
    status: HealthStatusSchema,
    code: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    message: z.string().nullable(),
    ms: z.number().int().nullable(),
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type OutcomeRow = z.output<typeof OutcomeRowSchema>;

export const HealthHistoryResponseSchema = z.object({ key: z.string(), rows: z.array(OutcomeRowSchema) }).strict();
export type HealthHistoryResponse = z.output<typeof HealthHistoryResponseSchema>;

// ---------------------------------------------------------------------------
// Jobs, log level, summary
// ---------------------------------------------------------------------------

export const JobInfoSchema = z
  .object({
    name: z.string(),
    intervalMs: z.number().int(),
    nextRunAt: IsoDateTime.nullable(),
    running: z.boolean(),
    runningSince: IsoDateTime.nullable(),
    stuckForMs: z.number().int().nullable(),
    overdue: z.boolean(),
    runs: z.number().int(),
    failures: z.number().int(),
    consecutiveFailures: z.number().int(),
    lastStartedAt: IsoDateTime.nullable(),
    lastFinishedAt: IsoDateTime.nullable(),
    lastMs: z.number().int().nullable(),
    lastOk: z.boolean().nullable(),
    lastError: z.object({ name: z.string(), code: z.string().nullable(), message: z.string() }).strict().nullable(),
  })
  .strict();
export type JobInfo = z.output<typeof JobInfoSchema>;

export const LogLevelStateSchema = z
  .object({
    level: LogLevelSchema,
    verbose: z.boolean(),
    until: IsoDateTime.nullable(),
    areas: z.array(z.string()).nullable(),
    bootLevel: LogLevelSchema,
    /** Survives a restart (timed verbose only). */
    persisted: z.boolean(),
  })
  .strict();
export type LogLevelState = z.output<typeof LogLevelStateSchema>;

/** `PUT /api/diagnostics/level` */
export const SetLogLevelSchema = z
  .object({
    verbose: z.boolean(),
    /** null = until turned off (or the next restart). */
    minutes: z.number().int().min(1).max(10080).nullable().default(60),
    areas: z.array(z.enum(DIAGNOSTIC_AREAS)).min(1).max(DIAGNOSTIC_AREAS.length).nullable().default(null),
  })
  .strict();
export type SetLogLevel = z.output<typeof SetLogLevelSchema>;
export type SetLogLevelInput = z.input<typeof SetLogLevelSchema>;

export const ForeignOriginSchema = z
  .object({ origin: z.string(), firstAt: IsoDateTime, lastAt: IsoDateTime, count: z.number().int() })
  .strict();
export type ForeignOrigin = z.output<typeof ForeignOriginSchema>;

/**
 * `GET /api/diagnostics/summary`. For a Pages request only `dataDir`/`logDir` are `''` (as
 * `/api/about`); pid, memory and the in-flight routes/outbound are shown.
 */
export const DiagnosticsSummarySchema = z
  .object({
    generatedAt: IsoDateTime,
    server: z
      .object({
        version: z.string(),
        boot: z.string(),
        pid: z.number().int().nullable(),
        startedAt: IsoDateTime,
        uptimeMs: z.number().int(),
        node: z.string(),
        platform: z.string(),
        memory: z.object({ rssBytes: z.number().int(), heapUsedBytes: z.number().int() }).strict().nullable(),
        supervised: z.boolean(),
        restart: z.object({ attempt: z.number().int(), lastExit: z.string().nullable() }).strict().nullable(),
        dataDir: z.string(),
        logDir: z.string(),
      })
      .strict(),
    logLevel: LogLevelStateSchema,
    modules: z.array(z.object({ name: z.string(), ok: z.boolean() }).strict()),
    vault: VaultStateSchema,
    hybrid: z
      .object({
        pagesOrigin: z.string().nullable(),
        pairings: z.number().int(),
        lastPairedRequestAt: IsoDateTime.nullable(),
        foreignOrigins: z.array(ForeignOriginSchema),
        foreignOriginRequests: z.number().int(),
      })
      .strict(),
    inFlight: z
      .object({
        count: z.number().int(),
        oldestMs: z.number().int().nullable(),
        routes: z.array(z.string()),
        outbound: z.array(z.object({ host: z.string(), purpose: z.string().nullable(), ms: z.number().int() }).strict()),
      })
      .strict(),
    jobs: z.array(JobInfoSchema),
    health: z.array(HealthEntrySchema),
    counts: z
      .object({
        /** Last hour. */
        server: z.object({ warn: z.number().int(), error: z.number().int() }).strict(),
        client: z.object({ warn: z.number().int(), error: z.number().int() }).strict(),
        warnKeysLastHour: z.number().int(),
        memoryRecords: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type DiagnosticsSummary = z.output<typeof DiagnosticsSummarySchema>;

// ---------------------------------------------------------------------------
// Browser events (`POST /api/diagnostics/client-events`)
// ---------------------------------------------------------------------------

export const CLIENT_EVENT_CATEGORIES = ['api', 'hybrid', 'backend', 'provider', 'widget', 'app'] as const;
export const ClientEventCategorySchema = z.enum(CLIENT_EVENT_CATEGORIES);
export type ClientEventCategory = z.output<typeof ClientEventCategorySchema>;

const CLIENT_FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ClientPrimitive = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);

export const ClientEventSchema = z
  .object({
    t: IsoDateTime,
    level: LogLevelSchema,
    cat: ClientEventCategorySchema,
    /** One line: no control, line-separator or bidi-override characters. */
    msg: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u),
    fields: z
      .record(z.string().regex(CLIENT_FIELD_KEY), z.union([ClientPrimitive, z.array(ClientPrimitive).max(10)]))
      .refine((o) => Object.keys(o).length <= 20, { message: 'At most 20 fields' })
      .default({}),
    /** Random per page load. */
    session: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    page: z
      .object({ build: z.enum(['server', 'pages']), backend: z.enum(['server', 'browser']), version: z.string().max(40) })
      .strict(),
  })
  .strict();
export type ClientEvent = z.output<typeof ClientEventSchema>;
export type ClientEventInput = z.input<typeof ClientEventSchema>;

export const ClientEventsRequestSchema = z
  .object({ sentAt: IsoDateTime, events: z.array(ClientEventSchema).min(1).max(100) })
  .strict();
export type ClientEventsRequest = z.output<typeof ClientEventsRequestSchema>;

export const ClientEventsResponseSchema = z
  .object({ accepted: z.number().int(), dropped: z.number().int(), acceptDebug: z.boolean() })
  .strict();
export type ClientEventsResponse = z.output<typeof ClientEventsResponseSchema>;
