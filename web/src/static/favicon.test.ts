/**
 * favicon.ts: which bookmark hosts get a synthetic `fav:<host>` id, and the DuckDuckGo icon URL an
 * id resolves to (directly and through `resolveAssetUrl`, which the static project runs with
 * `__HOMEBASE_STATIC__` on). The host rules mirror the server's `isLocalLookingHost` (§4.8):
 * nothing that looks like a home-network name may ever reach the third-party service.
 */
import { describe, expect, it } from 'vitest';
import { resolveAssetUrl } from './assets.ts';
import { faviconIdFor, faviconServiceUrl, hostKeyOf, hostnameOf, isFaviconId, isLocalLookingHost } from './favicon.ts';

const DDG = 'https://icons.duckduckgo.com/ip3/';

describe('hostnameOf', () => {
  it('drops the port, IPv6 brackets and trailing dots, and lower-cases', () => {
    expect(hostnameOf('Example.COM:8443')).toBe('example.com');
    expect(hostnameOf('  example.com  ')).toBe('example.com');
    expect(hostnameOf('[::1]:8080')).toBe('::1');
    expect(hostnameOf('[fe80::1')).toBe('fe80::1');
    expect(hostnameOf('nas.')).toBe('nas');
    expect(hostnameOf('NAS..:8080')).toBe('nas');
    expect(hostnameOf('example.com.')).toBe('example.com');
  });
});

describe('isLocalLookingHost', () => {
  it.each([
    '',
    'localhost',
    'localhost.',
    'LOCALHOST:3000',
    'nas',
    'nas.',
    'nas:5000',
    'printer.local',
    'printer.local.',
    'router.lan',
    'box.home.arpa',
    'svc.internal',
    'app.localhost',
    'pc.localdomain',
    '192.168.1.10',
    '192.168.1.10:8080',
    '10.0.0.1.',
    '127.1',
    '0x7f.1',
    '[::1]',
    '[::1]:8080',
    '[fe80::1%25eth0]',
  ])('%j is local-looking', (host) => {
    expect(isLocalLookingHost(host)).toBe(true);
  });

  it.each(['example.com', 'example.com.', 'github.com:443', 'xn--bcher-kva.example', '10.0.0.1.nip.io', '0xabc.com', 'a.b.c.example'])('%j is public', (host) => {
    expect(isLocalLookingHost(host)).toBe(false);
  });
});

describe('faviconIdFor', () => {
  it.each<[string, string | null]>([
    ['https://github.com/', 'fav:github.com'],
    ['https://GitHub.COM/path?q=1#x', 'fav:github.com'],
    ['https://example.com:8443/', 'fav:example.com:8443'],
    ['https://example.com:443/', 'fav:example.com'], // the default port is not part of the host
    ['https://bücher.example/', 'fav:xn--bcher-kva.example'], // IDN → punycode
    ['http://10.0.0.1.nip.io/', 'fav:10.0.0.1.nip.io'],
    ['http://example.com./', 'fav:example.com.'], // keeps the server's hostKey; the URL drops the dot
    // Local-looking hosts, including fully-qualified spellings with a trailing dot.
    ['http://nas/', null],
    ['http://nas./', null],
    ['http://localhost./', null],
    ['http://printer.local./', null],
    ['http://NAS.:8080/', null],
    ['http://192.168.1.10:8080/', null],
    ['http://0x7f.1/', null], // the URL parser makes it 127.0.0.1
    ['http://[::1]:8080/', null],
    ['http://[2001:db8::1]/', null],
    // Not a URL.
    ['not a url', null],
    ['', null],
  ])('%j → %j', (url, id) => {
    expect(faviconIdFor(url)).toBe(id);
  });

  it('keys by the server’s hostKey (lower-cased host with port)', () => {
    expect(hostKeyOf('https://Example.com:8443/x')).toBe('example.com:8443');
    expect(hostKeyOf('http://nas./')).toBe('nas.');
    expect(hostKeyOf('nope')).toBeNull();
  });
});

describe('faviconServiceUrl', () => {
  it('maps a synthetic id to DuckDuckGo’s icon URL for the bare hostname', () => {
    expect(faviconServiceUrl('fav:github.com')).toBe(`${DDG}github.com.ico`);
    expect(faviconServiceUrl('fav:EXAMPLE.com:8443')).toBe(`${DDG}example.com.ico`);
    expect(faviconServiceUrl('fav:example.com.')).toBe(`${DDG}example.com.ico`);
    expect(faviconServiceUrl('fav:xn--bcher-kva.example')).toBe(`${DDG}xn--bcher-kva.example.ico`);
  });

  it('never sends a local-looking host, whatever the spelling', () => {
    for (const id of ['fav:nas', 'fav:nas.', 'fav:localhost.', 'fav:printer.local.', 'fav:192.168.1.10', 'fav:[::1]:8080', 'fav:0x7f.1', 'fav:', 'fav:.', 'fav:EXAMPLE.com:80:90']) {
      expect(faviconServiceUrl(id), id).toBeNull();
    }
  });

  it('is null for ids that are not synthetic favicon ids', () => {
    expect(isFaviconId('fav:')).toBe(false);
    expect(isFaviconId('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(faviconServiceUrl('00000000-0000-4000-8000-000000000001')).toBeNull();
    expect(faviconServiceUrl('github.com')).toBeNull();
  });

  it('keeps crafted ids on the icon service origin with a percent-encoded path', () => {
    for (const id of ['fav:evil.com/..', 'fav:evil.com/../../x', 'fav:evil.com?x#y', 'fav:x.example\u0000y', 'fav:a b.example', 'fav:x.example@evil.com', 'fav:x.example\\evil.com']) {
      const url = faviconServiceUrl(id);
      expect(url, id).not.toBeNull();
      const parsed = new URL(url!);
      expect(parsed.origin, id).toBe('https://icons.duckduckgo.com');
      expect(parsed.pathname.startsWith('/ip3/'), id).toBe(true);
      // One encoded path segment: no '/', '?', '#' or raw control characters survive.
      expect(parsed.pathname.slice('/ip3/'.length), id).not.toMatch(/[/?#\s\u0000]/);
      expect(parsed.search + parsed.hash, id).toBe('');
    }
    expect(faviconServiceUrl('fav:evil.com/../x')).toBe(`${DDG}evil.com%2F..%2Fx.ico`);
  });
});

describe('resolveAssetUrl (static build) for favicon ids', () => {
  it('resolves a percent-encoded synthetic id to the icon service URL', () => {
    expect(resolveAssetUrl('/api/icons/fav%3Aexample.com%3A8080')).toBe(`${DDG}example.com.ico`);
    expect(resolveAssetUrl('/api/icons/fav%3Agithub.com')).toBe(`${DDG}github.com.ico`);
  });

  it('keeps the original URL for a local-looking id (the <img> then errors and shows the letter tile)', () => {
    expect(resolveAssetUrl('/api/icons/fav%3Anas')).toBe('/api/icons/fav%3Anas');
    expect(resolveAssetUrl('/api/icons/fav%3Anas.')).toBe('/api/icons/fav%3Anas.');
    expect(resolveAssetUrl('/api/icons/fav%3Alocalhost.')).toBe('/api/icons/fav%3Alocalhost.');
  });
});
