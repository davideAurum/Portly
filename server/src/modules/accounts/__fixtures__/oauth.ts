/**
 * Test fixtures for the accounts module: unsigned id_tokens, token-endpoint responders for the
 * fake transport, and a harness wiring the real AccountService into a test context/app.
 * All credentials here are fake test values.
 */
import type { Hono } from 'hono';
import { MICROSOFT_CONSUMER_TENANT_ID, type AccountKind, type Capability } from '@portly/shared';
import { createApp } from '../../../app.ts';
import type { AccountService, AppEnv } from '../../../context.ts';
import type { Logger } from '../../../lib/logger.ts';
import type { SafeFetch, SafeFetchOptions } from '../../../security/safe-fetch.ts';
import type { FakeFetch, FakeFetchRoute, FakeRequest, FakeResponseSpec } from '../../../testing/fake-fetch.ts';
import { createTestContext, type TestContext } from '../../../testing/test-context.ts';
import { prefixes, register } from '../index.ts';
import type { LookupFn } from '../net.ts';
import { GOOGLE_REVOKE_ENDPOINT, GOOGLE_SCOPES, GOOGLE_TOKEN_ENDPOINT } from '../oauth/google.ts';
import { MICROSOFT_ISSUER, MICROSOFT_SCOPES, MICROSOFT_TOKEN_ENDPOINT } from '../oauth/microsoft.ts';
import { accountsCoreOf, createAccountService, type AccountsCore } from '../service.ts';
import { accountSecretId, insertAccountRow, passwordSecret, refreshTokenSecret } from '../store.ts';

export const GOOGLE_CLIENT_ID = '123456789012-testclient.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
export const MICROSOFT_CLIENT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
export const T0 = Date.parse('2026-09-25T12:00:00.000Z');

export { GOOGLE_REVOKE_ENDPOINT, GOOGLE_SCOPES, GOOGLE_TOKEN_ENDPOINT, MICROSOFT_SCOPES, MICROSOFT_TOKEN_ENDPOINT };

// ---------------------------------------------------------------------------
// id_tokens
// ---------------------------------------------------------------------------

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Compact JWS with a dummy signature (the server never verifies it; see id-token.ts). */
export function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

export function googleIdToken(nowMs: number, overrides: Record<string, unknown> = {}): string {
  return unsignedJwt({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    sub: 'google-subject-1',
    email: 'alice@gmail.com',
    email_verified: true,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 3600,
    ...overrides,
  });
}

export function microsoftIdToken(nowMs: number, overrides: Record<string, unknown> = {}): string {
  return unsignedJwt({
    iss: MICROSOFT_ISSUER,
    aud: MICROSOFT_CLIENT_ID,
    tid: MICROSOFT_CONSUMER_TENANT_ID,
    oid: '00000000-0000-0000-aaaa-bbbbccccdddd',
    sub: 'pairwise-subject',
    preferred_username: 'bob@outlook.com',
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 3600,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Token endpoint responders
// ---------------------------------------------------------------------------

export function formOf(req: FakeRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body ?? ''));
}

export function tokenOk(fields: Record<string, unknown>): FakeResponseSpec {
  return { status: 200, json: { token_type: 'Bearer', expires_in: 3599, ...fields } };
}

export function tokenError(error: string, status = 400): FakeResponseSpec {
  return { status, json: { error, error_description: `<script>alert(1)</script> ${error} from provider` } };
}

export function route(
  url: string,
  respond: FakeFetchRoute['respond'],
  extra: Partial<Pick<FakeFetchRoute, 'times' | 'method'>> = {},
): FakeFetchRoute {
  return { match: url, method: 'POST', respond, ...extra };
}

/** Requests the fake transport received for `url`, with parsed form bodies. */
export function formsSentTo(fake: FakeFetch, url: string): Record<string, string>[] {
  return fake.calls.filter((c) => c.url === url).map(formOf);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Clock {
  now: number;
  advance(ms: number): void;
}

export interface AccountsHarness {
  ctx: TestContext;
  service: AccountService;
  core: AccountsCore;
  app: Hono<AppEnv>;
  clock: Clock;
  fake: FakeFetch;
}

/**
 * Test context whose `accounts` is the real service (fixed clock, the context's health tracker),
 * plus an app with only this module.
 */
export function createAccountsHarness(
  opts: { lookup?: LookupFn; log?: Logger; onFetch?: (url: string, options: SafeFetchOptions) => void } = {},
): AccountsHarness {
  const ctx = createTestContext(opts.log ? { log: opts.log } : {});
  const clock: Clock = {
    now: T0,
    advance(ms) {
      this.now += ms;
    },
  };
  const onFetch = opts.onFetch;
  const fetch: SafeFetch = onFetch
    ? (url, options) => {
        onFetch(String(url), options);
        return ctx.fetch(url, options);
      }
    : ctx.fetch;
  const service = createAccountService({
    config: ctx.config,
    db: ctx.db,
    vault: ctx.vault,
    log: ctx.log,
    fetch,
    health: ctx.health,
    now: () => clock.now,
    lookup: opts.lookup,
  });
  ctx.accounts = service;
  const core = accountsCoreOf(service);
  if (!core || !ctx.fakeFetch) throw new Error('harness setup failed');
  const { app } = createApp(ctx, { modules: [{ name: 'accounts', prefixes, register }], webDist: null });
  return { ctx, service, core, app, clock, fake: ctx.fakeFetch };
}

/** Stores both OAuth clients (Google with its secret). */
export function configureClients(h: AccountsHarness): void {
  h.ctx.db.run('INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES (?, ?, 1, ?)', ['google', GOOGLE_CLIENT_ID, T0]);
  h.ctx.db.run('INSERT INTO oauth_clients (provider, client_id, has_secret, updated_at) VALUES (?, ?, 0, ?)', ['microsoft', MICROSOFT_CLIENT_ID, T0]);
  h.ctx.vault.put('oauth-client:google', GOOGLE_CLIENT_SECRET);
}

export interface SeedAccount {
  id: string;
  kind: AccountKind;
  label?: string;
  email?: string | null;
  externalId?: string;
  capabilities?: Capability[];
  config?: Record<string, unknown>;
  refreshToken?: string;
  password?: string;
}

/** Inserts an account row directly (and its secret). */
export function seedAccount(h: AccountsHarness, seed: SeedAccount): void {
  insertAccountRow(h.ctx.db, {
    id: seed.id,
    kind: seed.kind,
    label: seed.label ?? `${seed.kind} account`,
    email: seed.email ?? null,
    externalId: seed.externalId ?? `${seed.kind}-subject-${seed.id}`,
    config: seed.config ?? {},
    capabilities: seed.capabilities ?? ['calendar', 'mail'],
    grantedScopes: null,
    statusMessage: null,
    now: h.clock.now,
  });
  if (seed.refreshToken !== undefined) h.ctx.vault.put(accountSecretId(seed.id), refreshTokenSecret(seed.refreshToken));
  if (seed.password !== undefined) h.ctx.vault.put(accountSecretId(seed.id), passwordSecret(seed.password));
}

export function storedRefreshToken(h: AccountsHarness, id: string): string | null {
  const raw = h.ctx.vault.get(accountSecretId(id));
  return raw === null ? null : (JSON.parse(raw) as { refreshToken?: string }).refreshToken ?? null;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
