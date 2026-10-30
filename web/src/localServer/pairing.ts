/**
 * This browser's pairing with the Portly server on this PC (hybrid mode), and the two hints the
 * next page load uses to pick its backend ({@link decideBootBackend}). All of it lives in
 * localStorage under the Pages base path, because every project site of a `<user>.github.io`
 * origin shares that storage:
 *
 * - `portly:pairing:<base>`: the pairing record `{token, instanceId, pairedAt}`, or — for Portly on
 *   another PC, reached through its HTTPS proxy (ARCHITECTURE §20) — `{token, instanceId,
 *   pairedAt, remoteOrigin}`, where `token` is that PC's device secret (one server per browser);
 * - `portly:backend-mode:<base>`: the backend the last decision chose (`lastMode`);
 * - `portly:server-seen:<base>`: when a probe last reached the paired server (`lastServerSeenAt`).
 *
 * Every access is guarded (storage can be missing or throw: private modes, blocked site data) and
 * whatever is read back is validated, since another tab, build or program may have written it.
 * Clearing the record is compare-and-clear, so a tab acting on an old token never wipes a newer
 * pairing made meanwhile in another tab.
 *
 * Pairing itself: `startPairing` keeps a fresh nonce in sessionStorage and sends this tab to the
 * server's own page (`<appUrl>#/pair?nonce=…`); after the user approves there, the server
 * redirects back to `#/paired?token=…&nonce=…&instance=…`, and `consumePairingReturn` (the first
 * thing `main.tsx` does) checks the nonce (one use), saves the record and strips the token from
 * the address. Connecting to Portly on another PC happens on this site instead (`remote.ts`), which
 * saves the record with {@link saveRemoteConnection}.
 */
import { InstanceIdSchema, PAIRING_RETURN_ROUTE, PairingTokenSchema, buildPairingRequestUrl, parsePairingReturn } from '@portly/shared';
import type { Backend } from '../capabilities.ts';
import { safeHref } from '../lib/openUrl.ts';
import { parseRemoteServerAddress } from './origin.ts';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** What this browser keeps of a pairing: the token it sends, and the server it was made with. */
export interface PairingRecord {
  /** The pairing token for Portly on this PC; the device secret for Portly on another PC. */
  token: string;
  instanceId: string;
  /** When the pairing was saved (epoch ms). */
  pairedAt: number;
  /** Set for Portly on another PC: its address (`https://<pc>.<tailnet>.ts.net`). Absent: Portly on this PC. */
  remoteOrigin?: string;
}

export interface HybridStorageKeys {
  pairing: string;
  mode: string;
  seen: string;
}

/** localStorage keys of hybrid mode for a Pages base path (default: this build's). */
export function hybridStorageKeys(base: string = import.meta.env.BASE_URL): HybridStorageKeys {
  return {
    pairing: `portly:pairing:${base}`,
    mode: `portly:backend-mode:${base}`,
    seen: `portly:server-seen:${base}`,
  };
}

/** sessionStorage: the nonce of the pairing this tab asked for (one use). */
export const PAIRING_NONCE_KEY = 'portly:pairing-nonce';

/** sessionStorage: the backend switch to announce after the reload that applied it (`<target>:<reason>`). */
export const MODE_SWITCH_TOAST_KEY = 'portly:mode-switch-toast';

export function browserLocalStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserSessionStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readItem(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** True when the value was written. */
export function writeItem(storage: StorageLike | null, key: string, value: string): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(storage: StorageLike | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to remove from storage that cannot be used.
  }
}

function parseRecord(raw: string | null): PairingRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const token = PairingTokenSchema.safeParse(fields.token);
  const instanceId = InstanceIdSchema.safeParse(fields.instanceId);
  const pairedAt = fields.pairedAt;
  if (!token.success || !instanceId.success || typeof pairedAt !== 'number' || !Number.isFinite(pairedAt)) return null;
  if (fields.remoteOrigin === undefined) return { token: token.data, instanceId: instanceId.data, pairedAt };
  // Only an address the connect page itself would accept (and the CSP allows).
  const remoteOrigin = typeof fields.remoteOrigin === 'string' ? parseRemoteServerAddress(fields.remoteOrigin) : null;
  if (remoteOrigin === null || remoteOrigin !== fields.remoteOrigin) return null;
  return { token: token.data, instanceId: instanceId.data, pairedAt, remoteOrigin };
}

/** A paired page load starts on the server when a probe reached it this recently (even if the last decision was not `server`). */
export const BOOT_SERVER_RECENT_MS = 10 * 60_000;

export interface BootDecisionInput {
  /** Hybrid mode is on (a local server origin is configured). */
  enabled: boolean;
  framed: boolean;
  record: PairingRecord | null;
  lastMode: Backend | null;
  lastServerSeenAt: number | null;
  now: number;
}

/**
 * A page load's backend: `server` when paired and either the last decision was `server` or —
 * when no decision says `browser` — a probe reached the server in the last 10 minutes (right after
 * pairing). Hybrid mode off and framed pages are always `browser`.
 *
 * A `browser` decision wins over a recent sighting: it is written when a server-backend page gave
 * up after its grace, so honouring the sighting would reload into the server again and again.
 */
export function decideBootBackend(input: BootDecisionInput): Backend {
  if (!input.enabled || input.framed || input.record === null) return 'browser';
  if (input.lastMode === 'server') return 'server';
  if (input.lastMode === 'browser') return 'browser';
  const seen = input.lastServerSeenAt;
  return seen !== null && input.now - seen < BOOT_SERVER_RECENT_MS ? 'server' : 'browser';
}

/** Why {@link decideBootBackend} decided as it did (diagnostic events), following the same rules. */
export function bootDecisionReason(input: BootDecisionInput): 'hybrid-off' | 'framed' | 'not-paired' | 'last-decision' | 'seen-recently' | 'not-seen-recently' {
  if (!input.enabled) return 'hybrid-off';
  if (input.framed) return 'framed';
  if (input.record === null) return 'not-paired';
  if (input.lastMode !== null) return 'last-decision';
  const seen = input.lastServerSeenAt;
  return seen !== null && input.now - seen < BOOT_SERVER_RECENT_MS ? 'seen-recently' : 'not-seen-recently';
}

export interface PairingStore {
  readonly keys: HybridStorageKeys;
  /** The saved pairing, or null (none, unreadable or malformed). */
  read(): PairingRecord | null;
  /** Saves a pairing (replacing any other); false when storage refused it. */
  save(record: PairingRecord): boolean;
  /** Forgets the pairing only while it still holds `expectedToken`; true when it did. */
  clear(expectedToken: string): boolean;
  lastMode(): Backend | null;
  /** Null removes the hint. */
  setLastMode(mode: Backend | null): void;
  lastServerSeenAt(): number | null;
  /** Null removes the hint. */
  setLastServerSeenAt(at: number | null): void;
  /** The backend a hybrid page load (not framed) would start on now ({@link decideBootBackend}). */
  nextBootBackend(now: number): Backend;
}

export function createPairingStore(storage: StorageLike | null, base?: string): PairingStore {
  const keys = hybridStorageKeys(base);
  const store: PairingStore = {
    keys,
    read: () => parseRecord(readItem(storage, keys.pairing)),
    save: (record) => writeItem(storage, keys.pairing, JSON.stringify(record)),
    clear(expectedToken) {
      if (parseRecord(readItem(storage, keys.pairing))?.token !== expectedToken) return false;
      removeItem(storage, keys.pairing);
      return true;
    },
    lastMode() {
      const value = readItem(storage, keys.mode);
      return value === 'server' || value === 'browser' ? value : null;
    },
    setLastMode(mode) {
      if (mode === null) removeItem(storage, keys.mode);
      else writeItem(storage, keys.mode, mode);
    },
    lastServerSeenAt() {
      const value = Number(readItem(storage, keys.seen) ?? Number.NaN);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    setLastServerSeenAt(at) {
      if (at === null) removeItem(storage, keys.seen);
      else writeItem(storage, keys.seen, String(at));
    },
    nextBootBackend: (now) =>
      decideBootBackend({ enabled: true, framed: false, record: store.read(), lastMode: store.lastMode(), lastServerSeenAt: store.lastServerSeenAt(), now }),
  };
  return store;
}

/**
 * Calls `listener` when another tab changes the pairing record (`storage` events fire only in the
 * other tabs of this origin); returns the unsubscribe function.
 */
export function subscribePairingChanges(
  listener: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  keys: HybridStorageKeys = hybridStorageKeys(),
): () => void {
  const onStorage = (event: StorageEvent) => {
    // A null key means the whole storage was cleared.
    if (event.key === null || event.key === keys.pairing) listener();
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

/** 32 random bytes as base64url without padding (43 characters), like the server's tokens. */
export function randomNonce(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface StartPairingEnv {
  session: StorageLike | null;
  random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;
  /** Navigates this tab (`location.assign`). */
  assign(url: string): void;
}

/**
 * Sends this tab to the server's page (`appUrl`, already validated) to approve pairing, with a
 * fresh nonce kept in sessionStorage for the way back. False (and no navigation) when the nonce
 * cannot be kept or the URL is not one the app may navigate to.
 */
export function startPairing(appUrl: string, env: StartPairingEnv): boolean {
  const nonce = randomNonce(env.random);
  if (!writeItem(env.session, PAIRING_NONCE_KEY, nonce)) return false;
  // Same gate as every other navigation of the app (§4.4).
  const href = safeHref(buildPairingRequestUrl(appUrl, nonce), { allowAppRoutes: false });
  if (href === undefined) return false;
  env.assign(href);
  return true;
}

/**
 * Saves this browser's connection to Portly on another PC (replacing any pairing), marks the
 * server as just seen and forgets the last decision, so the next page load starts on it (like
 * {@link consumePairingReturn} for this PC). False when storage refused the record.
 */
export function saveRemoteConnection(store: PairingStore, connection: { origin: string; secret: string; instanceId: string }, now: number): boolean {
  if (!store.save({ token: connection.secret, instanceId: connection.instanceId, pairedAt: now, remoteOrigin: connection.origin })) return false;
  store.setLastServerSeenAt(now);
  store.setLastMode(null);
  return true;
}

/** What `consumePairingReturn` did: nothing to do, saved a pairing, or refused the answer. */
export type PairingReturnResult = 'none' | 'paired' | 'refused';

export interface PairingReturnEnv {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  local: StorageLike | null;
  session: StorageLike | null;
  now(): number;
  /** False (hybrid mode off, framed page): the address is cleaned up but nothing is saved. */
  accept: boolean;
  base?: string;
}

/**
 * Handles the server's redirect back after pairing (`#/paired?token=…&nonce=…&instance=…`): the
 * token leaves the address bar at once (`history.replaceState` to `#/`), then the pairing is saved
 * only when the nonce is the one this tab asked with (each nonce works once). A saved pairing also
 * records the server as just seen, so this page load starts on the server backend.
 */
export function consumePairingReturn(env: PairingReturnEnv): PairingReturnResult {
  const hash = env.location.hash;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.split('?', 1)[0] !== PAIRING_RETURN_ROUTE) return 'none';
  try {
    env.history.replaceState(env.history.state, '', `${env.location.pathname}${env.location.search}#/`);
  } catch {
    // Keep going: the answer is still checked and the nonce used up.
  }
  const expected = readItem(env.session, PAIRING_NONCE_KEY);
  removeItem(env.session, PAIRING_NONCE_KEY);
  const value = parsePairingReturn(hash);
  if (!env.accept || value === null || expected === null || value.nonce !== expected) return 'refused';
  const store = createPairingStore(env.local, env.base);
  const now = env.now();
  if (!store.save({ token: value.token, instanceId: value.instanceId, pairedAt: now })) return 'refused';
  store.setLastServerSeenAt(now);
  // A new pairing starts from "just seen", not from a mode an older pairing left behind.
  store.setLastMode(null);
  return 'paired';
}
