import { describe, expect, it } from 'vitest';
import { ProviderHttpError as ReExported, classifyDenial as reExportedClassify } from '../modules/calendar/providers/http.ts';
import { errorFields } from './logger.ts';
import { ProviderHttpError, classifyDenial, hasRateLimitReason, parseRetryAfter, providerErrorReasons } from './provider-errors.ts';

describe('provider errors', () => {
  it('stay importable from the calendar providers module', () => {
    expect(ReExported).toBe(ProviderHttpError);
    expect(reExportedClassify).toBe(classifyDenial);
  });

  it('ProviderHttpError keeps Retry-After and the upstream status for logs and health', () => {
    const plain = new ProviderHttpError(403, 'forbidden', { message: 'Google denied access', accountId: 'a', providerReason: null, denial: 'denied' });
    expect(plain.retryAfterSeconds).toBeNull();
    expect(plain.httpStatus).toBeNull();
    expect(errorFields(plain).upstreamStatus).toBeUndefined();

    const limited = new ProviderHttpError(429, 'rate_limited', {
      message: 'Google is rate limiting requests',
      accountId: 'a',
      providerReason: 'rateLimitExceeded',
      retryAfterSeconds: 30,
    });
    expect(limited.retryAfterSeconds).toBe(30);
    expect(errorFields(limited)).toMatchObject({ errStatus: 429, retryAfterSeconds: 30, providerReason: 'rateLimitExceeded' });

    const rejected = new ProviderHttpError(502, 'provider_error', { message: 'Google rejected the request', accountId: 'a', providerReason: null, upstreamStatus: 400 });
    expect(errorFields(rejected)).toMatchObject({ errStatus: 502, upstreamStatus: 400 });
    expect(rejected.toBody()).toEqual({ error: { code: 'provider_error', message: 'Google rejected the request', accountId: 'a' } });
  });

  it('classifies reasons: rate limits, disabled API, missing scope', () => {
    const reasons = providerErrorReasons({ error: { status: 'RESOURCE_EXHAUSTED', errors: [{ reason: 'userRateLimitExceeded' }] } });
    expect(reasons).toEqual(['RESOURCE_EXHAUSTED', 'userRateLimitExceeded']);
    expect(hasRateLimitReason(reasons)).toBe(true);
    expect(hasRateLimitReason(['ApplicationThrottled'])).toBe(true);
    expect(hasRateLimitReason(['accessNotConfigured'])).toBe(false);
    expect(classifyDenial(['PERMISSION_DENIED', 'SERVICE_DISABLED'])).toBe('api_disabled');
    expect(classifyDenial(['insufficientPermissions'])).toBe('insufficient_scope');
    expect(classifyDenial(['ErrorAccessDenied'])).toBe('denied');
  });

  it('parseRetryAfter reads delta seconds and HTTP dates (≥ 0, ≤ a day)', () => {
    const now = Date.UTC(2026, 9, 11, 12, 0, 0);
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('999999', now)).toBe(86_400);
    expect(parseRetryAfter(new Date(now + 90_500).toUTCString(), now)).toBe(90);
    expect(parseRetryAfter('Sun, 11 Oct 2026 12:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Sun, 11 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('-5', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
