/**
 * Core primitives shared by every contract file: safe URLs, colors, ids, timestamps
 * and the small core API payloads (health, about, uploads).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// URLs (§4.4)
// ---------------------------------------------------------------------------

export const MAX_URL_LENGTH = 2048;

// ASCII control characters (incl. TAB/CR/LF, which `new URL` silently strips).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * True when `value` is an absolute http(s) URL without credentials, at most 2048 chars,
 * that `new URL` accepts. Control characters are rejected outright so that what is stored
 * is exactly what a browser would navigate to.
 */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (CONTROL_CHARS.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.hostname === '') return false;
  return true;
}

/** Returns the trimmed URL when it is a SafeHttpUrl, otherwise null (ingest helper: invalid → null). */
export function toSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isSafeHttpUrl(trimmed) ? trimmed : null;
}

/** http(s) URL, no username/password, ≤ 2048 chars. Leading/trailing whitespace is trimmed. */
export const SafeHttpUrl = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine(isSafeHttpUrl, { message: 'Must be an http(s) URL without credentials' });
export type SafeHttpUrl = z.output<typeof SafeHttpUrl>;

/** Host of a SafeHttpUrl (used for host-only displays), or null. */
export function urlHost(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Colors (§4.5)
// ---------------------------------------------------------------------------

export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** `#rrggbb` or `#rrggbbaa`. Nothing else (no names, no 3-digit form, no CSS functions). */
export const HexColor = z.string().regex(HEX_COLOR_REGEX, { message: 'Must be a #rrggbb or #rrggbbaa color' });
export type HexColor = z.output<typeof HexColor>;

/** Ingest helper for provider/user colors: returns the color lower-cased when valid, else null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Ids & keys
// ---------------------------------------------------------------------------

/** RFC 9562 UUID (server-generated ids are random v4). */
export const Uuid = z.uuid();
export type Uuid = z.output<typeof Uuid>;

/** Opaque entity id as it appears in the API (UUIDs, provider ids, composite event ids). */
export const EntityId = z.string().min(1).max(512);
export type EntityId = z.output<typeof EntityId>;

/** Keys of `z.record` maps and other short machine identifiers (§7a). */
export const RECORD_KEY_REGEX = /^[a-z0-9_-]{1,64}$/;
export const RecordKey = z.string().regex(RECORD_KEY_REGEX, { message: 'Must match ^[a-z0-9_-]{1,64}$' });
export type RecordKey = z.output<typeof RecordKey>;

/** Random UUIDv4 via Web Crypto (available in Node ≥ 19 and in secure browser contexts). */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** ISO-8601 date-time with `Z` or a numeric offset. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.output<typeof IsoDateTime>;

/** `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();
export type IsoDate = z.output<typeof IsoDate>;

/** True when `tz` is an IANA time zone the runtime's Intl implementation knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const IanaTimeZone = z.string().refine(isValidTimeZone, { message: 'Unknown IANA time zone' });
export type IanaTimeZone = z.output<typeof IanaTimeZone>;

/** Epoch ms (DB convention) → ISO string (API convention). */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Nullable variant of {@link msToIso}. */
export function msToIsoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** ISO string → epoch ms; NaN-safe (returns null for unparseable input). */
export function isoToMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Generic shapes
// ---------------------------------------------------------------------------

/** Cursor-paged list (used only where an endpoint pages). */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** Bounded, trimmed single-line label. */
export function label(max: number) {
  return z.string().trim().min(1).max(max);
}

// ---------------------------------------------------------------------------
// Images (§4.3 — sniffed content types, never from headers)
// ---------------------------------------------------------------------------

export const IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/bmp',
  'image/svg+xml',
] as const;
export const ImageContentType = z.enum(IMAGE_CONTENT_TYPES);
export type ImageContentType = z.output<typeof ImageContentType>;

// ---------------------------------------------------------------------------
// Core API payloads (§7 Core)
// ---------------------------------------------------------------------------

export const VAULT_STATES = ['ready', 'locked'] as const;
export const VaultStateSchema = z.enum(VAULT_STATES);
export type VaultState = z.output<typeof VaultStateSchema>;

/**
 * Version of the HTTP API the Pages site speaks to a local server (hybrid mode). Bump it when a
 * change would break a Pages build published earlier (a renamed route, a stricter request schema),
 * so an outdated page shows "Needs update" instead of failing request by request.
 */
export const PORTLY_API_VERSION = 1;

/**
 * `GET /api/health`. The server also identifies itself (`app`, `apiVersion`, `instanceId`,
 * `appUrl`) so the Pages site can tell Portly from another program on the port, and the server
 * it paired with from another one, and names the Pages site it answers (`pagesUrl`) so the new-tab
 * extension can follow it. The in-browser backend of the Pages build omits them.
 */
export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    vault: VaultStateSchema,
    app: z.literal('portly').optional(),
    apiVersion: z.number().int().min(1).optional(),
    instanceId: z.string().min(1).max(64).optional(),
    /** The server's own page, e.g. `http://localhost:5757/` (always ends with `/`). */
    appUrl: z.string().min(1).max(MAX_URL_LENGTH).optional(),
    /** The Pages site this server answers (`PORTLY_PAGES_URL`, ends with `/`); null when hybrid mode is off. */
    pagesUrl: z.string().min(1).max(MAX_URL_LENGTH).nullable().optional(),
  })
  .strict();
export type HealthResponse = z.output<typeof HealthResponseSchema>;

/** `GET /api/about` */
export const AboutResponseSchema = z
  .object({
    version: z.string(),
    dataDir: z.string(),
    logPath: z.string(),
    vault: VaultStateSchema,
  })
  .strict();
export type AboutResponse = z.output<typeof AboutResponseSchema>;

/** `POST /api/uploads` → `{id, url}`; url is always `/api/uploads/${id}`. */
export const UploadResponseSchema = z
  .object({
    id: Uuid,
    url: z.string(),
  })
  .strict();
export type UploadResponse = z.output<typeof UploadResponseSchema>;

/** Builds the only URL form an upload is ever referenced by (§4.5). */
export function uploadUrl(uploadId: string): string {
  return `/api/uploads/${encodeURIComponent(uploadId)}`;
}

/** Builds the URL of a stored icon. */
export function iconUrl(iconId: string): string {
  return `/api/icons/${encodeURIComponent(iconId)}`;
}
