/**
 * Pairing between the Pages site and the Homebase server on the same PC (hybrid mode).
 *
 * The server accepts requests from its configured Pages origin (`HOMEBASE_PAGES_URL`) only when
 * they carry a pairing token in {@link PAIRING_TOKEN_HEADER}. A browser gets a token once: the
 * Pages site sends the tab to the server's own page (`<appUrl>#/pair?nonce=…`), the user approves
 * there, and the server redirects back to the configured Pages URL with the token in the fragment
 * (`#/paired?token=…&nonce=…&instance=…`). Fragments never reach the Pages host, and the nonce ties
 * the answer to the tab that asked. The server stores only a SHA-256 hash of each token.
 */
import { z } from 'zod';
import { IsoDateTime } from './core.ts';

/** Request header carrying the pairing token on every Pages → server call. */
export const PAIRING_TOKEN_HEADER = 'X-Homebase-Token';

/** At most this many browsers can be paired at once; pairing one more replaces the least recently used. */
export const MAX_PAIRINGS = 20;

/** 32 random bytes as base64url (no padding). */
const RANDOM_32 = /^[A-Za-z0-9_-]{43}$/;

export const PairingTokenSchema = z.string().regex(RANDOM_32);
export const PairingNonceSchema = z.string().regex(RANDOM_32);
export const InstanceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `GET /api/pairing` (paired): the presenting browser's own pairing. */
export const PairingStatusResponseSchema = z
  .object({
    paired: z.literal(true),
    pairingId: z.string().min(1).max(64),
    instanceId: InstanceIdSchema,
    label: z.string().max(200),
    createdAt: IsoDateTime,
  })
  .strict();
export type PairingStatusResponse = z.output<typeof PairingStatusResponseSchema>;

export const PairingSummarySchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().max(200),
    origin: z.string().max(2048),
    createdAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
    /** False when the pairing was made for another Pages address than the one configured now (it no longer works). */
    current: z.boolean(),
  })
  .strict();
export type PairingSummary = z.output<typeof PairingSummarySchema>;

/** `GET /api/pairings` (server's own page only). */
export const PairingsResponseSchema = z
  .object({
    /** The configured Pages URL (`HOMEBASE_PAGES_URL`), or null when pairing is off. */
    pagesUrl: z.string().nullable(),
    instanceId: InstanceIdSchema,
    pairings: z.array(PairingSummarySchema),
  })
  .strict();
export type PairingsResponse = z.output<typeof PairingsResponseSchema>;

/** `POST /api/pairings` (server's own page only). */
export const PairingCreateSchema = z.object({ nonce: PairingNonceSchema }).strict();
export type PairingCreate = z.output<typeof PairingCreateSchema>;

export const PairingCreateResponseSchema = z.object({ redirectUrl: z.string() }).strict();
export type PairingCreateResponse = z.output<typeof PairingCreateResponseSchema>;

/** Hash route the server's page uses to ask for approval: `#/pair?nonce=…`. */
export const PAIRING_REQUEST_ROUTE = '/pair';
/** Hash route the Pages site receives the token on: `#/paired?token=…&nonce=…&instance=…`. */
export const PAIRING_RETURN_ROUTE = '/paired';

export interface PairingReturn {
  token: string;
  nonce: string;
  instanceId: string;
}

/** `<pagesUrl>#/paired?token=…&nonce=…&instance=…` (`pagesUrl` ends with `/`). */
export function buildPairingReturnUrl(pagesUrl: string, value: PairingReturn): string {
  const query = new URLSearchParams({ token: value.token, nonce: value.nonce, instance: value.instanceId });
  return `${pagesUrl}#${PAIRING_RETURN_ROUTE}?${query.toString()}`;
}

/** The three values of a `#/paired?…` fragment, or null when `hash` is anything else or malformed. */
export function parsePairingReturn(hash: string): PairingReturn | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [route, query = ''] = raw.split('?', 2);
  if (route !== PAIRING_RETURN_ROUTE) return null;
  const params = new URLSearchParams(query);
  const token = PairingTokenSchema.safeParse(params.get('token'));
  const nonce = PairingNonceSchema.safeParse(params.get('nonce'));
  const instanceId = InstanceIdSchema.safeParse(params.get('instance'));
  if (!token.success || !nonce.success || !instanceId.success) return null;
  return { token: token.data, nonce: nonce.data, instanceId: instanceId.data };
}

/** `<appUrl>#/pair?nonce=…` — where the Pages site sends the tab to ask for a pairing. */
export function buildPairingRequestUrl(appUrl: string, nonce: string): string {
  return `${appUrl}#${PAIRING_REQUEST_ROUTE}?${new URLSearchParams({ nonce }).toString()}`;
}

/** The nonce of a `#/pair?nonce=…` fragment, or null. */
export function parsePairingRequest(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [route, query = ''] = raw.split('?', 2);
  if (route !== PAIRING_REQUEST_ROUTE) return null;
  const nonce = PairingNonceSchema.safeParse(new URLSearchParams(query).get('nonce'));
  return nonce.success ? nonce.data : null;
}
