/**
 * The server's page URL is untrusted input (whatever answers on the port reports it):
 * `validateAppUrl` accepts only the root page of an http(s) loopback origin.
 */
import { describe, expect, it, vi } from 'vitest';
import { validateAppUrl } from './urls.ts';

vi.mock('./config.ts', () => ({ LOCAL_SERVER_ORIGIN: 'http://127.0.0.1:5757', HYBRID_ENABLED: true }));

describe('validateAppUrl', () => {
  it.each([
    ['http://localhost:5757/', 'http://localhost:5757/'],
    ['http://127.0.0.1:5757/', 'http://127.0.0.1:5757/'],
    ['http://[::1]:5757/', 'http://[::1]:5757/'],
    ['https://localhost:8443/', 'https://localhost:8443/'],
    ['http://homebase.localhost:5757/', 'http://homebase.localhost:5757/'],
    ['http://localhost/', 'http://localhost/'],
    // Normalized the way the browser would navigate.
    ['HTTP://LOCALHOST:5757/', 'http://localhost:5757/'],
    ['http://localhost:80/', 'http://localhost/'],
    ['http://localhost:5757', 'http://localhost:5757/'],
  ])('accepts %s', (raw, expected) => {
    expect(validateAppUrl(raw)).toBe(expected);
  });

  it.each([
    // Not http(s).
    'javascript:alert(1)//localhost/',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/',
    'ftp://localhost/',
    'blob:http://localhost:5757/uuid',
    // Not a loopback host.
    'https://evil.example/',
    'http://localhost.evil.example/',
    'http://evil.example/?http://localhost/',
    'http://127.0.0.2:5757/',
    'http://192.168.1.10:5757/',
    'http://localhost.:5757/',
    'http://[::2]:5757/',
    // Credentials.
    'http://user:pass@localhost:5757/',
    'http://user@localhost:5757/',
    // Anything but the root page.
    'http://localhost:5757/settings',
    'http://localhost:5757//evil.example/',
    'http://localhost:5757/?next=https://evil.example',
    'http://localhost:5757/?',
    'http://localhost:5757/#/settings',
    'http://localhost:5757/#',
    // Not a URL at all.
    '//localhost:5757/',
    '/settings',
    'localhost:5757',
    '',
    'http://local\nhost:5757/',
    `http://localhost:5757/${'a'.repeat(2048)}`,
  ])('refuses %s', (raw) => {
    expect(validateAppUrl(raw)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(validateAppUrl(undefined)).toBeNull();
    expect(validateAppUrl(null)).toBeNull();
    expect(validateAppUrl(42)).toBeNull();
    expect(validateAppUrl({ href: 'http://localhost:5757/' })).toBeNull();
  });
});
