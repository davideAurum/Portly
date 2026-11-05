/**
 * Provider-neutral OAuth types. Each provider (google.ts, microsoft.ts, spotify.ts) describes its endpoints,
 * scopes (the identity scopes every sign-in asks for, plus the scopes of each service it offers),
 * client type, id_token rules and scope → capability mapping; the flow code in flow.ts /
 * token-endpoint.ts is shared.
 */
import type { Capability, OAuthProvider } from '@portly/shared';
import type { Logger } from '../../../lib/logger.ts';
import type { SafeFetch } from '../../../security/safe-fetch.ts';

/** A configured OAuth client. `clientSecret` is null for public clients (Microsoft, Spotify). */
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
  /** The scopes to ask for (`scopesFor`: the base scopes plus those of the services picked). */
  scopes: readonly string[];
}

/** Stable subject + display email, from validated id_token claims or the provider's profile. */
export interface OAuthIdentity {
  subject: string;
  email: string | null;
  /** The name of a new account when there is no email to name it by. */
  label?: string | null;
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
  /** Every scope Portly may ask for (the base scopes and every service's). */
  readonly scopes: readonly string[];
  /** Asked for on every sign-in: the identity scopes (and whatever the provider needs besides). */
  readonly baseScopes: readonly string[];
  /**
   * The scopes each service needs. Its keys are the services this provider offers; they must match
   * `OAUTH_PROVIDER_CAPABILITIES` in shared/src/accounts.ts.
   */
  readonly capabilityScopes: Readonly<Partial<Record<Capability, readonly string[]>>>;
  /** Confidential client (secret sent at the token endpoint) vs public client (PKCE only). */
  readonly usesClientSecret: boolean;
  /** Plausibility check of a pasted client id (catches copy/paste mistakes early). */
  isValidClientId(clientId: string): boolean;
  /** Says what a client id looks like, when {@link isValidClientId} refuses one. */
  readonly clientIdHint: string;
  /** Query parameters of the authorization request (in a stable order). */
  authorizeParams(input: AuthorizeParamsInput): Record<string, string>;
  /**
   * Provider-specific token endpoint parameters (client secret or scope). `scopes` are the ones the
   * sign-in asked for (code exchange) or the account's granted services need (refresh).
   */
  tokenParams(client: OAuthClient, scopes: readonly string[]): Record<string, string>;
  /** Validates id_token claims (issuer, audience, expiry, tenant) and extracts the identity. */
  identity(claims: Record<string, unknown>, clientId: string, nowMs: number): IdentityResult;
  /**
   * A provider without OpenID Connect (Spotify) issues no id_token: who signed in is asked with the
   * new access token instead, and {@link identity} is never called. Reason `not_allowed` means the
   * provider refuses this account for this app (the `not_allowed` sign-in result).
   */
  fetchIdentity?(accessToken: string, fetch: SafeFetch, log: Logger): Promise<IdentityResult>;
  /**
   * Granted scopes from the token response's `scope`, normalized; null when it cannot be determined.
   * `requested` is what the request asked for (what an absent `scope` means, where the provider says so).
   */
  grantedScopes(scope: string | undefined, requested: readonly string[]): string[] | null;
  /** Capabilities unlocked by the granted scopes. */
  capabilities(granted: readonly string[]): Capability[];
}
