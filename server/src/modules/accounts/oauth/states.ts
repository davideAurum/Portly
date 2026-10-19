/**
 * Pending OAuth authorizations (`oauth_states`, §4.7): random 32-byte base64url `state`, PKCE S256
 * `code_verifier`, optional account being reconnected, the SPA route to return to and the services
 * (capabilities) the sign-in asked for. Rows expire
 * after 10 minutes, at most 20 are pending (oldest deleted first), and a state is consumed
 * atomically (`DELETE … RETURNING`) before any token exchange, so it can be used at most once.
 */
import { createHash } from 'node:crypto';
import { CAPABILITIES, type Capability, type OAuthProvider } from '@portly/shared';
import type { Db } from '../../../db/open.ts';
import { newToken } from '../../../lib/ids.ts';

export const STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_STATES = 20;

/** Shape of the values we generate (32 bytes → 43 base64url chars); anything else is never looked up. */
export const STATE_PARAM_REGEX = /^[A-Za-z0-9_-]{43}$/;

export interface PkcePair {
  /** 43-char base64url verifier (RFC 7636 §4.1). */
  verifier: string;
  /** `BASE64URL(SHA256(verifier))` (S256). */
  challenge: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkcePair(): PkcePair {
  const verifier = newToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export interface NewOAuthState {
  provider: OAuthProvider;
  codeVerifier: string;
  accountId: string | null;
  returnTo: string;
  /** The services the sign-in asks for. */
  capabilities: readonly Capability[];
  now: number;
}

/** Stores a pending authorization and trims the table to the newest {@link MAX_PENDING_STATES}. */
export function createOAuthState(db: Db, input: NewOAuthState): string {
  const state = newToken(32);
  db.tx(() => {
    db.run('DELETE FROM oauth_states WHERE expires_at <= ?', [input.now]);
    db.run(
      `INSERT INTO oauth_states (state, provider, code_verifier, account_id, return_to, capabilities, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state,
        input.provider,
        input.codeVerifier,
        input.accountId,
        input.returnTo,
        JSON.stringify(input.capabilities),
        input.now,
        input.now + STATE_TTL_MS,
      ],
    );
    db.run(
      `DELETE FROM oauth_states WHERE rowid IN (
         SELECT rowid FROM oauth_states ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      [MAX_PENDING_STATES],
    );
  });
  return state;
}

export interface ConsumedOAuthState {
  codeVerifier: string;
  accountId: string | null;
  returnTo: string;
  /** The services the sign-in asked for; null for a row stored before they were recorded (or unreadable). */
  capabilities: Capability[] | null;
}

/** The stored capabilities column: a JSON list of known capabilities, else null. */
function parseRequested(raw: string | null): Capability[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0) return null;
    if (!value.every((c) => (CAPABILITIES as readonly unknown[]).includes(c))) return null;
    return CAPABILITIES.filter((c) => value.includes(c));
  } catch {
    return null;
  }
}

/**
 * Consumes a pending authorization for `provider` in one statement. Returns null when the state is
 * unknown, already used, expired, or belongs to another provider (the row is then left alone).
 */
export function consumeOAuthState(db: Db, input: { state: string; provider: OAuthProvider; now: number }): ConsumedOAuthState | null {
  const row = db.get<{ code_verifier: string; account_id: string | null; return_to: string; capabilities: string | null }>(
    `DELETE FROM oauth_states WHERE state = ? AND provider = ? AND expires_at > ?
     RETURNING code_verifier, account_id, return_to, capabilities`,
    [input.state, input.provider, input.now],
  );
  if (!row) return null;
  return {
    codeVerifier: row.code_verifier,
    accountId: row.account_id,
    returnTo: row.return_to,
    capabilities: parseRequested(row.capabilities),
  };
}

/** Deletes expired rows (hourly job); returns how many were removed. */
export function purgeExpiredStates(db: Db, now: number): number {
  return db.run('DELETE FROM oauth_states WHERE expires_at <= ?', [now]).changes;
}
