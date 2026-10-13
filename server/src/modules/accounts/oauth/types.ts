/**
 * Provider-neutral OAuth types. Each provider (google.ts, microsoft.ts) describes its endpoints,
 * scopes, client type, id_token rules and scope → capability mapping; the flow code in
 * flow.ts / token-endpoint.ts is shared.
 */
import type { Capability, OAuthProvider } from '@homebase/shared';

/** A configured OAuth client. `clientSecret` is null for public clients (Microsoft). */
export interface OAuthClient {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string | null;
}

export interface AuthorizeParamsInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/** Stable subject + display email taken from validated id_token claims. */
export interface OAuthIdentity {
  subject: string;
  email: string | null;
}

export type IdentityResult = { ok: true; identity: OAuthIdentity } | { ok: false; reason: string };

export interface OAuthProviderSpec {
  readonly provider: OAuthProvider;
  /** Human name used in status messages. */
  readonly displayName: string;
  /** Label of a new account when the id_token carries no email. */
  readonly defaultLabel: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  /** Token revocation endpoint (best-effort on account deletion), if the provider has one. */
  readonly revokeEndpoint: string | null;
  readonly scopes: readonly string[];
  /** Confidential client (secret sent at the token endpoint) vs public client (PKCE only). */
  readonly usesClientSecret: boolean;
  /** Plausibility check of a pasted client id (catches copy/paste mistakes early). */
  isValidClientId(clientId: string): boolean;
  /** Query parameters of the authorization request (in a stable order). */
  authorizeParams(input: AuthorizeParamsInput): Record<string, string>;
  /** Provider-specific token endpoint parameters (client secret or scope). */
  tokenParams(client: OAuthClient): Record<string, string>;
  /** Validates id_token claims (issuer, audience, expiry, tenant) and extracts the identity. */
  identity(claims: Record<string, unknown>, clientId: string, nowMs: number): IdentityResult;
  /** Granted scopes from the token response's `scope`, normalized; null when it cannot be determined. */
  grantedScopes(scope: string | undefined): string[] | null;
  /** Capabilities unlocked by the granted scopes. */
  capabilities(granted: readonly string[]): Capability[];
}
