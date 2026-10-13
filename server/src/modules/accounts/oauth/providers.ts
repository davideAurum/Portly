/** Registry of the OAuth provider specs. */
import { isOAuthProvider, type AccountKind, type OAuthProvider } from '@portly/shared';
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

/** Provider from a route parameter; 404 for anything else. */
export function providerParam(value: string | undefined): OAuthProvider {
  if (!isOAuthProvider(value)) throw new HttpError(404, 'not_found', 'Unknown OAuth provider');
  return value;
}
