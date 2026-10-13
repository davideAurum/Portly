/**
 * Microsoft sign-in fixtures for static-backend tests: unsigned id_tokens and token-endpoint
 * answers (the static counterpart of server/src/modules/accounts/__fixtures__/oauth.ts). All
 * credentials here are fake test values.
 */
import { MICROSOFT_CONSUMER_TENANT_ID } from '@homebase/shared';
import { encodeBase64 } from '../../lib/base64.ts';
import { toBase64Url } from '../../lib/ids.ts';
import { MICROSOFT_ISSUER } from '../microsoftAuth.ts';
import type { FakeRequest, FakeResponseSpec } from './fakeFetch.ts';

export const MICROSOFT_CLIENT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
export const SUBJECT = '00000000-0000-0000-aaaa-bbbbccccdddd';
export const OTHER_SUBJECT = '00000000-0000-0000-aaaa-eeeeffff0000';

const b64url = (value: unknown): string => toBase64Url(encodeBase64(new TextEncoder().encode(JSON.stringify(value))));

/** Compact JWS with a dummy signature (never verified; see microsoftAuth.ts). */
export function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

export function microsoftIdToken(nowMs: number, overrides: Record<string, unknown> = {}): string {
  return unsignedJwt({
    iss: MICROSOFT_ISSUER,
    aud: MICROSOFT_CLIENT_ID,
    tid: MICROSOFT_CONSUMER_TENANT_ID,
    oid: SUBJECT,
    sub: 'pairwise-subject',
    preferred_username: 'bob@outlook.com',
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 3600,
    ...overrides,
  });
}

export function tokenOk(fields: Record<string, unknown>): FakeResponseSpec {
  return { status: 200, json: { token_type: 'Bearer', expires_in: 3599, ...fields } };
}

export function tokenError(error: string, status = 400): FakeResponseSpec {
  return { status, json: { error, error_description: `<script>alert(1)</script> ${error} from provider` } };
}

export function formOf(req: FakeRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body ?? ''));
}
