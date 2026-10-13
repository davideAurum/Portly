/**
 * `PORTLY_STATIC_SERVER` at build time: the default origin, `off`, and loopback-only http(s)
 * origins (anything else fails the build).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_SERVER_ORIGIN, isLoopbackHost, parseLocalServerOrigin } from './origin.ts';

describe('parseLocalServerOrigin', () => {
  it('defaults to http://127.0.0.1:5757 when unset or empty', () => {
    expect(DEFAULT_LOCAL_SERVER_ORIGIN).toBe('http://127.0.0.1:5757');
    expect(parseLocalServerOrigin(undefined)).toBe('http://127.0.0.1:5757');
    expect(parseLocalServerOrigin('   ')).toBe('http://127.0.0.1:5757');
  });

  it('turns hybrid mode off with "off"', () => {
    expect(parseLocalServerOrigin('off')).toBe('');
    expect(parseLocalServerOrigin(' OFF ')).toBe('');
  });

  it('accepts http(s) origins on a loopback host, normalised without the trailing slash', () => {
    expect(parseLocalServerOrigin('http://localhost:5858')).toBe('http://localhost:5858');
    expect(parseLocalServerOrigin('http://127.0.0.1:5757/')).toBe('http://127.0.0.1:5757');
    expect(parseLocalServerOrigin('https://[::1]:8443')).toBe('https://[::1]:8443');
    expect(parseLocalServerOrigin('http://portly.localhost:5757')).toBe('http://portly.localhost:5757');
    expect(parseLocalServerOrigin('HTTP://LOCALHOST:80')).toBe('http://localhost');
  });

  it('rejects everything else', () => {
    for (const value of [
      'localhost:5757',
      'ftp://127.0.0.1:5757',
      'http://192.168.1.10:5757',
      'http://example.com',
      'http://localhost.example.com:5757',
      'http://user:pw@127.0.0.1:5757',
      'http://127.0.0.1:5757/api',
      'http://127.0.0.1:5757/?x',
      'http://127.0.0.1:5757/#',
      'not a url',
    ]) {
      expect(() => parseLocalServerOrigin(value), value).toThrow(/PORTLY_STATIC_SERVER/);
    }
  });
});

describe('isLoopbackHost', () => {
  it('knows the loopback names as URL spells them', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'a.localhost', 'x-y.z.localhost']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['127.0.0.2', '::1', 'localhost.com', 'evil.com', '', '0.0.0.0']) expect(isLoopbackHost(host), host).toBe(false);
  });
});
