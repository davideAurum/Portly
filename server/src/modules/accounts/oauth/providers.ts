/** Registry of the OAuth provider specs, and the services → scopes mapping they share. */
import { CAPABILITIES, isOAuthProvider, type AccountKind, type Capability, type OAuthProvider } from '@portly/shared';
import { HttpError } from '../../../lib/errors.ts';
import { google } from './google.ts';
import { microsoft } from './microsoft.ts';
import type { OAuthProviderSpec } from './types.ts';

export const OAUTH_PROVIDER_SPECS: Readonly<Record<OAuthProvider, OAuthProviderSpec>> = Object.freeze({ google, microsoft });

export function providerSpec(provider: OAuthProvider): OAuthProviderSpec {
  return OAUTH_PROVIDER_SPECS[provider];
}

/** Spec for an OAuth account kind; 400 for app-password kinds. */
export function specForKind(kind: AccountKind): OAuthProviderSpec {
  if (!isOAuthProvider(kind)) throw new HttpError(400, 'bad_request', 'This account does not use OAuth');
  return OAUTH_PROVIDER_SPECS[kind];
}

/** The services a provider offers (the keys of its `capabilityScopes`), in capability order. */
export function offeredCapabilities(spec: OAuthProviderSpec): Capability[] {
  return CAPABILITIES.filter((c) => spec.capabilityScopes[c] !== undefined);
}

/**
 * The scopes a sign-in (or refresh) for these services asks for: the base scopes, then each
 * service's in capability order, without repeats. Services the provider does not offer add nothing.
 */
export function scopesFor(spec: OAuthProviderSpec, capabilities: readonly Capability[]): string[] {
  const scopes: string[] = [...spec.baseScopes];
  for (const capability of CAPABILITIES) {
    if (!capabilities.includes(capability)) continue;
    for (const scope of spec.capabilityScopes[capability] ?? []) if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/** Provider from a route parameter; 404 for anything else. */
export function providerParam(value: string | undefined): OAuthProvider {
  if (!isOAuthProvider(value)) throw new HttpError(404, 'not_found', 'Unknown OAuth provider');
  return value;
}
