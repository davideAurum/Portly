import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_SAMPLES } from '../lib/__fixtures__/images.ts';
import { outcomeFromError } from '../lib/health.ts';
import { withLogContext } from '../lib/log-context.ts';
import { createMemoryLogger, createSilentLogger } from '../lib/logger.ts';
import { createFakeFetch } from '../testing/fake-fetch.ts';
import {
  BlockedAddressError,
  NotPrivateAddressError,
  SafeFetchError,
  createGuardedLookup,
  createSafeFetch,
  decodeDataImage,
  inflightOutbound,
  isBlockedAddress,
  isLocalLookingHost,
  stripTrailingDots,
  userAgent,
  type Resolver,
} from './safe-fetch.ts';

const make = (routes: Parameters<typeof createFakeFetch>[0]) => {
  const fake = createFakeFetch(routes);
  return { fake, fetch: createSafeFetch({ version: '1.2.3', log: createSilentLogger(), fetchImpl: fake }) };
};

describe('isBlockedAddress (§4.8 deny list)', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::8.8.8.8',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2002:7f00:1::1',
    '2002:c0a8:101::',
    'not-an-ip',
    '',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.32.0.1', '192.0.1.1', '198.20.0.1', '223.255.255.255', '2606:4700::6810:85e5', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::1'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('guardedLookup', () => {
  const resolverOf =
    (answers: Record<string, LookupAddress[]>): Resolver =>
    async (hostname) => {
      const found = answers[hostname];
      if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      return found;
    };
  const lookup = (resolve: Resolver, hostname: string, options: object) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((done) => {
      createGuardedLookup(resolve)(hostname, options, (err, address, family) => done({ err, address, family }));
    });

  const resolve = resolverOf({
    'public.test': [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ],
    'mixed.test': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
    'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'nat64.test': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    'empty.test': [],
  });

  it('returns validated addresses in both callback forms', async () => {
    expect(await lookup(resolve, 'public.test', { all: true })).toEqual({
      err: null,
      address: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
      family: undefined,
    });
    expect(await lookup(resolve, 'public.test', {})).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect(await lookup(resolve, 'public.test', { family: 6 })).toEqual({ err: null, address: '2606:2800:220:1::1', family: 6 });
  });

  it('fails when ANY resolved address is private (public then private)', async () => {
    for (const options of [{ all: true }, {}, { family: 4 }]) {
      const { err } = await lookup(resolve, 'mixed.test', options);
      expect(err).toBeInstanceOf(BlockedAddressError);
    }
  });

  it('fails for IPv4-mapped and NAT64 forms of private addresses', async () => {
    expect((await lookup(resolve, 'mapped.test', { all: true })).err).toBeInstanceOf(BlockedAddressError);
    expect((await lookup(resolve, 'nat64.test', { all: true })).err).toBeInstanceOf(BlockedAddressError);
  });

  it('propagates resolver errors and treats empty answers as not found', async () => {
    expect((await lookup(resolve, 'nope.test', {})).err?.code).toBe('ENOTFOUND');
    expect((await lookup(resolve, 'empty.test', {})).err?.code).toBe('ENOTFOUND');
    expect((await lookup(resolve, 'public.test', { family: 5 })).err).toBeNull();
  });
});

describe('safeFetch policies (fake transport)', () => {
  it('public: refuses IP-literal private hosts in every notation before dispatch', async () => {
    const { fake, fetch } = make([]);
    for (const url of [
      'http://127.0.0.1/',
      'http://2130706433/', // decimal
      'http://0177.0.0.1/', // octal
      'http://0x7f.0.0.1/', // hex
      'http://0x7f000001/',
      'http://127.1/',
      'http://0/',
      'http://[::1]/',
      'http://[0:0:0:0:0:0:0:1]/',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped
      'http://[::ffff:a9fe:a9fe]/latest/meta-data',
      'http://169.254.169.254/latest/meta-data',
      'http://10.1.2.3:8080/',
      'http://192.168.0.1./',
      'http://[fe80::1]/',
      'http://localhost:5757/api/health',
      'http://LOCALHOST./',
      'http://app.localhost/',
    ]) {
      await expect(fetch(url, { policy: 'public', as: 'text' }), url).rejects.toMatchObject({ reason: 'blocked', status: 502 });
    }
    expect(fake.calls).toEqual([]);
  });

  it('public: a 302 to 127.0.0.1 (or a private name) is re-validated and refused', async () => {
    const { fake, fetch } = make([
      { match: 'https://a.example/to-loopback', respond: { status: 302, headers: { location: 'http://127.0.0.1:5757/api/settings' } } },
      { match: 'https://a.example/to-decimal', respond: { status: 301, headers: { location: 'http://2130706433/' } } },
      { match: 'https://a.example/to-metadata', respond: { status: 307, headers: { location: 'http://[::ffff:169.254.169.254]/' } } },
      { match: 'https://a.example/to-localhost', respond: { status: 308, headers: { location: '//localhost/' } } },
    ]);
    for (const p of ['to-loopback', 'to-decimal', 'to-metadata', 'to-localhost']) {
      await expect(fetch(`https://a.example/${p}`, { policy: 'public', as: 'text' }), p).rejects.toMatchObject({ reason: 'blocked' });
    }
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://a.example/to-loopback',
      'https://a.example/to-decimal',
      'https://a.example/to-metadata',
      'https://a.example/to-localhost',
    ]);
  });

  it('refuses the Fetch standard bad ports for every policy, on every hop', async () => {
    const { fake, fetch } = make([{ match: 'https://a.example/smtp', respond: { status: 302, headers: { location: 'http://mail.example:25/' } } }]);
    await expect(fetch('http://a.example:25/', { policy: 'provider', as: 'text' })).rejects.toMatchObject({ reason: 'blocked' });
    await expect(fetch('http://a.example:6667/', { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'blocked' });
    await expect(fetch('https://a.example/smtp', { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'blocked' });
    expect(fake.calls).toHaveLength(1);
  });

  it('user-server: requires allowedOrigins; private addresses are fine inside them', async () => {
    const { fake, fetch } = make([{ match: 'http://192.168.1.10:5232/dav/', respond: { text: 'ok' } }]);
    await expect(fetch('http://192.168.1.10:5232/dav/', { policy: 'user-server', as: 'text' })).rejects.toMatchObject({ reason: 'blocked' });
    const res = await fetch('http://192.168.1.10:5232/dav/', { policy: 'user-server', as: 'text', allowedOrigins: ['http://192.168.1.10:5232'] });
    expect(res.data).toBe('ok');
    expect(fake.calls).toHaveLength(1);
  });

  it('user-server: keeps credentials between allowed origins, never beyond them', async () => {
    const { fake, fetch } = make([
      { match: 'https://dav.example/.well-known/caldav', respond: { status: 301, headers: { location: 'https://caldav.dav.example/' } } },
      { match: 'https://caldav.dav.example/', respond: { text: 'dav' } },
    ]);
    const res = await fetch('https://dav.example/.well-known/caldav', {
      policy: 'user-server',
      as: 'text',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      allowedOrigins: ['https://dav.example', 'https://caldav.dav.example'],
    });
    expect(res.url).toBe('https://caldav.dav.example/');
    expect(fake.calls.map((c) => c.headers.get('authorization'))).toEqual(['Basic dXNlcjpwYXNz', 'Basic dXNlcjpwYXNz']);
  });

  it('public: never forwards Authorization/Cookie across origins', async () => {
    const { fake, fetch } = make([
      { match: 'https://feeds.example/cal.ics', respond: { status: 302, headers: { location: 'https://cdn.example/cal.ics' } } },
      { match: 'https://cdn.example/cal.ics', respond: { text: 'BEGIN:VCALENDAR' } },
    ]);
    await fetch('https://feeds.example/cal.ics', { policy: 'public', as: 'text', headers: { Cookie: 'sid=1', Authorization: 'Bearer x' } });
    expect(fake.calls[1]?.headers.get('cookie')).toBeNull();
    expect(fake.calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('redirect: error throws on any 3xx', async () => {
    const { fetch } = make([{ match: '/moved', respond: { status: 301, headers: { location: '/new' } } }]);
    await expect(fetch('https://a.example/moved', { policy: 'provider', as: 'json', redirect: 'error' })).rejects.toMatchObject({ reason: 'redirect' });
  });
});

describe('data: URLs and local-looking hosts', () => {
  const png = IMAGE_SAMPLES.png;

  it('decodes base64 and percent-encoded image data URLs, sniffing the type', () => {
    expect(decodeDataImage(`data:image/png;base64,${png.toString('base64')}`)).toEqual({ contentType: 'image/png', bytes: png });
    // The declared type is ignored in favour of the bytes.
    expect(decodeDataImage(`data:text/html;base64,${png.toString('base64')}`)?.contentType).toBe('image/png');
    expect(decodeDataImage('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E')).toMatchObject({
      contentType: 'image/svg+xml',
    });
    expect(decodeDataImage("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>")?.contentType).toBe('image/svg+xml');
    expect(decodeDataImage(`  DATA:image/png;BASE64,${png.toString('base64url')}`)?.bytes).toEqual(png);
  });

  it('rejects non-images, malformed and oversized data URLs', () => {
    expect(decodeDataImage('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(decodeDataImage('data:image/png;base64,***')).toBeNull();
    expect(decodeDataImage('data:image/png;base64')).toBeNull();
    expect(decodeDataImage('https://example.com/icon.png')).toBeNull();
    expect(decodeDataImage('data:image/svg+xml,<!DOCTYPE svg><svg/>')).toBeNull();
    const big = Buffer.concat([png, Buffer.alloc(2048)]);
    expect(decodeDataImage(`data:image/png;base64,${big.toString('base64')}`, 1024)).toBeNull();
    expect(decodeDataImage(`data:image/svg+xml,<svg>${'a'.repeat(4096)}</svg>`, 1024)).toBeNull();
  });

  it('flags hosts that must not go to third-party favicon services', () => {
    for (const host of ['localhost', 'router', 'nas.local', 'printer.lan', 'nas.home.arpa', 'svc.internal', 'x.localhost', '192.168.1.1', '8.8.8.8', '[::1]', '::1', '2130706433', '0x7f.1', 'nas.local.', 'nas:8080']) {
      expect(isLocalLookingHost(host), host).toBe(true);
    }
    for (const host of ['example.com', 'www.github.com', 'example.com:8443', 'local.example.com', 'lan.party.org']) {
      expect(isLocalLookingHost(host), host).toBe(false);
    }
    // Trailing dots are stripped by index scanning: a long dot run that is not at the end must not
    // make the check quadratic (the old trailing-dots regex took ~0.3 s for 20k dots).
    const started = performance.now();
    expect(isLocalLookingHost(`${'.'.repeat(200_000)}x.example.com`)).toBe(false);
    expect(stripTrailingDots('nas.local...')).toBe('nas.local');
    // Linear: a few ms. Quadratic, 200k dots would take ~30 s. The margin absorbs a loaded machine.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('safeFetch over the real undici transport (loopback test server)', () => {
  let server: http.Server;
  let origin: string;
  const connections: string[] = [];
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0x61);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      connections.push(req.url ?? '');
      switch (req.url) {
        case '/gzip-bomb':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          res.end(gzipSync(bomb));
          return;
        case '/br-bomb':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
          res.end(brotliCompressSync(bomb));
          return;
        case '/chunked-big':
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          for (let i = 0; i < 64; i++) res.write(Buffer.alloc(32 * 1024));
          res.end();
          return;
        case '/lying-length':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(4096) });
          res.end(Buffer.alloc(4096, 0x62));
          return;
        case '/gzip-small':
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
          res.end(gzipSync(JSON.stringify({ ok: true })));
          return;
        case '/stall':
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('partial');
          return; // never ends
        case '/redirect':
          res.writeHead(302, { location: '/gzip-small' });
          res.end();
          return;
        case '/ua':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ua: req.headers['user-agent'] }));
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const real = (resolver?: Resolver) => createSafeFetch({ version: '9.9.9', log: createSilentLogger(), resolver });
  const opts = () => ({ policy: 'user-server' as const, allowedOrigins: [origin] });

  it('decompresses and parses, sends the honest User-Agent, follows redirects manually', async () => {
    const fetch = real();
    expect((await fetch(`${origin}/gzip-small`, { ...opts(), as: 'json' })).data).toEqual({ ok: true });
    expect((await fetch(`${origin}/ua`, { ...opts(), as: 'json' })).data).toEqual({ ua: userAgent('9.9.9') });
    const redirected = await fetch(`${origin}/redirect`, { ...opts(), as: 'json' });
    expect(redirected).toMatchObject({ status: 200, url: `${origin}/gzip-small`, data: { ok: true } });
    const manual = await fetch(`${origin}/redirect`, { ...opts(), as: 'text', redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe('/gzip-small');
  });

  it('caps decoded bytes: gzip and brotli bombs abort past the cap', async () => {
    const fetch = real();
    await expect(fetch(`${origin}/gzip-bomb`, { ...opts(), as: 'text', maxBytes: 1024 * 1024 })).rejects.toMatchObject({ reason: 'too_large' });
    await expect(fetch(`${origin}/br-bomb`, { ...opts(), as: 'text', maxBytes: 1024 * 1024 })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('caps streamed bytes without Content-Length and ignores an honest-looking one', async () => {
    const fetch = real();
    await expect(fetch(`${origin}/chunked-big`, { ...opts(), as: 'bytes' })).rejects.toMatchObject({ reason: 'too_large' });
    await expect(fetch(`${origin}/lying-length`, { ...opts(), as: 'text', maxBytes: 1000 })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('times out a stalled body with 504 upstream_timeout', async () => {
    const fetch = real();
    const started = Date.now();
    await expect(fetch(`${origin}/stall`, { ...opts(), as: 'text', timeoutMs: 300 })).rejects.toMatchObject({
      reason: 'timeout',
      status: 504,
      code: 'upstream_timeout',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('public: a hostname resolving to a private address never connects (guarded lookup in the undici Agent)', async () => {
    const port = (server.address() as AddressInfo).port;
    const before = connections.length;
    const fetch = real(async (hostname) =>
      hostname === 'rebind.test'
        ? [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]
        : [{ address: '127.0.0.1', family: 4 }],
    );
    await expect(fetch(`http://rebind.test:${port}/ua`, { policy: 'public', as: 'json' })).rejects.toMatchObject({ reason: 'blocked' });
    await expect(fetch(`http://loopback.test:${port}/ua`, { policy: 'public', as: 'json' })).rejects.toMatchObject({ reason: 'blocked' });
    expect(connections.length).toBe(before);
  });

  it('user-server over plain http: only while the host resolves to local-network addresses, checked at every connect (HARD-2)', async () => {
    const port = (server.address() as AddressInfo).port;
    let answer = [{ address: '127.0.0.1', family: 4 }];
    const fetch = real(async () => answer);
    const lan = { policy: 'user-server' as const, allowedOrigins: [`http://dav.home.lan:${port}`], as: 'json' as const };

    expect((await fetch(`http://dav.home.lan:${port}/ua`, lan)).data).toEqual({ ua: userAgent('9.9.9') });

    // Dynamic DNS / a different network: the same name now points at a public address.
    answer = [{ address: '93.184.216.34', family: 4 }];
    const before = connections.length;
    await expect(fetch(`http://dav.home.lan:${port}/ua`, lan)).rejects.toMatchObject({
      reason: 'blocked',
      message: expect.stringContaining('local network'),
    });
    // A mix of private and public answers is refused too.
    answer = [
      { address: '192.168.1.20', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ];
    await expect(fetch(`http://dav.home.lan:${port}/ua`, lan)).rejects.toMatchObject({ reason: 'blocked' });
    expect(connections.length).toBe(before);
  });
});

describe('user-server plain-http IP literals (HARD-2)', () => {
  it('refuses public IP literals over http (DNS is skipped for literals), allows private ones and https', async () => {
    const { fake, fetch } = make([{ match: /./, respond: { json: { ok: true } } }]);
    const call = (url: string) => fetch(url, { policy: 'user-server', allowedOrigins: [new URL(url).origin], as: 'json' });
    await expect(call('http://93.184.216.34:8008/dav/')).rejects.toMatchObject({ reason: 'blocked', message: expect.stringContaining('local network') });
    await expect(call('http://[2606:2800:220:1::1]/dav/')).rejects.toMatchObject({ reason: 'blocked' });
    await expect(call('http://192.168.1.20:8008/dav/')).resolves.toMatchObject({ status: 200 });
    await expect(call('https://93.184.216.34/dav/')).resolves.toMatchObject({ status: 200 });
    expect(fake.calls.map((c) => c.url)).toEqual(['http://192.168.1.20:8008/dav/', 'https://93.184.216.34/dav/']);
  });

  it('re-checks every redirect hop', async () => {
    const { fake, fetch } = make([{ match: 'http://192.168.1.20/', respond: { status: 302, headers: { location: 'http://93.184.216.34/' } } }]);
    await expect(
      fetch('http://192.168.1.20/', { policy: 'user-server', allowedOrigins: ['http://192.168.1.20', 'http://93.184.216.34'], as: 'text' }),
    ).rejects.toMatchObject({ reason: 'blocked' });
    expect(fake.calls).toHaveLength(1);
  });
});

describe('safeFetch (base behavior)', () => {
  it('parses JSON, sends the honest User-Agent and returns non-2xx without throwing', async () => {
    const { fake, fetch } = make([
      { match: 'api.example/ok', respond: { json: { a: 1 } } },
      { match: 'api.example/missing', respond: { status: 404, json: { error: 'x' } } },
    ]);
    const ok = await fetch('https://api.example/ok', { policy: 'provider', as: 'json' });
    expect(ok).toMatchObject({ status: 200, url: 'https://api.example/ok', data: { a: 1 } });
    expect(fake.calls[0]?.headers.get('user-agent')).toBe(userAgent('1.2.3'));
    expect(fake.calls[0]?.headers.get('accept')).toBe('application/json');
    const missing = await fetch('https://api.example/missing', { policy: 'provider', as: 'json' });
    expect(missing.status).toBe(404);
  });

  it('returns text and bytes', async () => {
    const { fetch } = make([
      { match: '/page', respond: { text: '<title>x</title>' } },
      { match: '/icon', respond: { body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/png' } } },
    ]);
    expect((await fetch('https://a.example/page', { policy: 'public', as: 'text' })).data).toBe('<title>x</title>');
    const bytes = await fetch('https://a.example/icon', { policy: 'public', as: 'bytes' });
    expect(Buffer.isBuffer(bytes.data)).toBe(true);
    expect([...bytes.data]).toEqual([1, 2, 3]);
  });

  it('enforces the size cap on streamed bytes (ignoring Content-Length)', async () => {
    const { fetch } = make([{ match: '/big', respond: { body: new Uint8Array(2048), headers: { 'content-length': '10' } } }]);
    await expect(fetch('https://a.example/big', { policy: 'public', as: 'bytes', maxBytes: 1024 })).rejects.toMatchObject({
      reason: 'too_large',
      status: 502,
      code: 'provider_error',
    });
  });

  it('counts decoded bytes (gzip bomb is capped after decompression)', async () => {
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const decoded = new Response(new Blob([bomb]).stream().pipeThrough(new DecompressionStream('gzip')));
    const fakeFetch = async (): Promise<Response> => decoded;
    const fetch = createSafeFetch({ version: '1', log: createSilentLogger(), fetchImpl: fakeFetch as typeof globalThis.fetch });
    await expect(fetch('https://a.example/bomb', { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('times out with 504 upstream_timeout', async () => {
    const hanging = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const log = createMemoryLogger();
    const fetch = createSafeFetch({ version: '1', log, fetchImpl: hanging as typeof globalThis.fetch });
    const err = await fetch('https://slow.example/x?token=secret', { policy: 'provider', as: 'json', timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ status: 504, code: 'upstream_timeout', reason: 'timeout' });
    expect(JSON.stringify(log.lines)).not.toContain('secret');
    expect(log.lines.at(-1)?.fields).toMatchObject({ method: 'GET', host: 'slow.example', reason: 'timeout' });
  });

  it('maps transport failures to 502 provider_error', async () => {
    const failing = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const fetch = createSafeFetch({ version: '1', log: createSilentLogger(), fetchImpl: failing as typeof globalThis.fetch });
    await expect(fetch('https://down.example/', { policy: 'provider', as: 'json' })).rejects.toMatchObject({ status: 502, reason: 'network' });
  });

  it('rejects non-http(s) and credentialed URLs before any request', async () => {
    const { fake, fetch } = make([]);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@a.example/', 'not a url']) {
      await expect(fetch(url, { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'bad_url' });
    }
    expect(fake.calls).toEqual([]);
  });

  it('follows redirects manually, strips credentials across origins and re-validates schemes', async () => {
    const { fake, fetch } = make([
      { match: 'https://a.example/start', respond: { status: 302, headers: { location: '/same' } } },
      { match: 'https://a.example/same', respond: { status: 301, headers: { location: 'https://b.example/other' } } },
      { match: 'https://b.example/other', respond: { json: { done: true } } },
      { match: 'https://a.example/evil', respond: { status: 302, headers: { location: 'file:///etc/passwd' } } },
    ]);
    const res = await fetch('https://a.example/start', {
      policy: 'provider',
      as: 'json',
      headers: { Authorization: 'Bearer t', Cookie: 'c=1' },
    });
    expect(res).toMatchObject({ status: 200, url: 'https://b.example/other', data: { done: true } });
    expect(fake.calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer t', 'Bearer t', null]);
    expect(fake.calls[2]?.headers.get('cookie')).toBeNull();
    await expect(fetch('https://a.example/evil', { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'redirect' });
  });

  it('caps redirect hops and supports redirect: manual', async () => {
    const { fetch } = make([{ match: /loop/, respond: { status: 302, headers: { location: 'https://a.example/loop' } } }]);
    await expect(fetch('https://a.example/loop', { policy: 'public', as: 'text' })).rejects.toMatchObject({ reason: 'redirect' });
    const manual = await fetch('https://a.example/loop', { policy: 'public', as: 'text', redirect: 'manual' });
    expect(manual.status).toBe(302);
  });

  it('user-server: requests and redirects stay within allowedOrigins', async () => {
    const { fetch } = make([
      { match: 'https://dav.example/start', respond: { status: 302, headers: { location: 'https://elsewhere.example/' } } },
    ]);
    const opts = { policy: 'user-server' as const, as: 'text' as const, allowedOrigins: ['https://dav.example'] };
    await expect(fetch('https://other.example/', opts)).rejects.toMatchObject({ reason: 'blocked' });
    await expect(fetch('https://dav.example/start', opts)).rejects.toMatchObject({ reason: 'blocked' });
  });

  it('follows only the Fetch redirect statuses (not 300/305/306 with a Location)', async () => {
    const { fake, fetch } = make([
      { match: 'https://a.example/choices', respond: { status: 300, headers: { location: 'https://b.example/' } } },
      { match: 'https://a.example/use-proxy', respond: { status: 305, headers: { location: 'http://proxy.example:3128/' } } },
    ]);
    expect((await fetch('https://a.example/choices', { policy: 'public', as: 'text' })).status).toBe(300);
    expect((await fetch('https://a.example/use-proxy', { policy: 'public', as: 'text' })).status).toBe(305);
    expect(fake.calls.map((c) => c.url)).toEqual(['https://a.example/choices', 'https://a.example/use-proxy']);
  });

  it('turns POST into GET on 303', async () => {
    const { fake, fetch } = make([
      { match: 'https://a.example/form', method: 'POST', respond: { status: 303, headers: { location: '/result' } } },
      { match: 'https://a.example/result', method: 'GET', respond: { json: [] } },
    ]);
    await fetch('https://a.example/form', { policy: 'provider', as: 'json', method: 'POST', body: '{"x":1}', headers: { 'Content-Type': 'application/json' } });
    expect(fake.calls.map((c) => `${c.method} ${c.body ?? ''}`)).toEqual(['POST {"x":1}', 'GET ']);
  });

  it('reports invalid JSON as a provider error', async () => {
    const { fetch } = make([{ match: '/bad', respond: { text: '{nope' } }]);
    await expect(fetch('https://a.example/bad', { policy: 'provider', as: 'json' })).rejects.toMatchObject({ reason: 'invalid_json' });
  });
});

describe('safeFetch: diagnostics', () => {
  const withLog = (routes: Parameters<typeof createFakeFetch>[0]) => {
    const log = createMemoryLogger();
    const fake = createFakeFetch(routes);
    return { log, fake, fetch: createSafeFetch({ version: '1', log, fetchImpl: fake }) };
  };
  const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code });

  it('logs one outbound record per call: host, purpose, status, bytes, redirects, final host, rate headers', async () => {
    const { log, fetch } = withLog([
      { match: 'https://a.example/start', respond: { status: 302, headers: { location: 'https://b.example/end?token=secret' } } },
      { match: 'https://b.example/end', respond: { json: { ok: true }, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '7' } } },
    ]);
    const res = await fetch('https://a.example/start?q=private', { policy: 'provider', as: 'json', purpose: 'calendar-sync' });
    expect(res.redirects).toBe(1);
    expect(log.lines.map((l) => [l.level, l.message])).toEqual([['debug', 'outbound']]);
    expect(log.lines[0]?.fields).toMatchObject({
      method: 'GET',
      host: 'a.example',
      policy: 'provider',
      purpose: 'calendar-sync',
      status: 200,
      bytes: 11,
      redirects: 1,
      finalHost: 'b.example',
      retryAfter: 30,
      rateLimitRemaining: 7,
    });
    expect(JSON.stringify(log.lines)).not.toMatch(/private|secret|\/start|\/end/);
  });

  it('non-2xx from a provider or user server is info (repeat-collapsed per host, purpose and status); public stays debug', async () => {
    const { log, fetch } = withLog([
      { match: 'https://api.example/', respond: { status: 429, json: {}, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } } },
      { match: 'https://page.example/', respond: { status: 404, text: 'nope' } },
    ]);
    await fetch('https://api.example/x', { policy: 'provider', as: 'json', purpose: 'todoist' });
    await fetch('https://page.example/x', { policy: 'public', as: 'text' });
    expect(log.lines.map((l) => [l.level, l.fields?.status, l.fields?.repeatKey])).toEqual([
      ['info', 429, 'api.example todoist 429'],
      ['debug', 404, undefined],
    ]);
    // An HTTP date is not a number of seconds.
    expect(log.lines[0]?.fields?.retryAfter).toBeUndefined();
    // A purpose that is not a short machine word is dropped, not logged.
    await fetch('https://api.example/x', { policy: 'provider', as: 'json', purpose: 'search for "my secret"' });
    expect(log.lines.at(-1)?.fields?.purpose).toBeUndefined();
  });

  it('transport failures carry the transport error as cause and log its chain (warn; debug for public)', async () => {
    const refused = async (): Promise<Response> => {
      throw new TypeError('fetch failed', { cause: errnoError('ECONNREFUSED') });
    };
    const log = createMemoryLogger();
    const fetch = createSafeFetch({ version: '1', log, fetchImpl: refused as typeof globalThis.fetch });
    const err = await fetch('https://down.example/x', { policy: 'provider', as: 'json', purpose: 'token-refresh' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).cause).toBeInstanceOf(TypeError);
    expect(outcomeFromError(err).code).toBe('refused');
    expect(log.lines.at(-1)).toMatchObject({
      level: 'warn',
      message: 'outbound failed',
      fields: {
        host: 'down.example',
        policy: 'provider',
        purpose: 'token-refresh',
        reason: 'network',
        cause: 'TypeError <- Error[ECONNREFUSED]',
        causeCode: 'ECONNREFUSED',
        hops: [],
        repeatKey: 'down.example token-refresh network',
      },
    });

    await fetch('https://down.example/x', { policy: 'public', as: 'text' }).catch(() => {});
    expect(log.lines.at(-1)).toMatchObject({ level: 'debug', message: 'outbound failed', fields: { policy: 'public', reason: 'network' } });
  });

  it('a timeout keeps its cause; status and hops are logged when known', async () => {
    const hanging = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const log = createMemoryLogger();
    const fetch = createSafeFetch({ version: '1', log, fetchImpl: hanging as typeof globalThis.fetch });
    const err = await fetch('https://slow.example/x', { policy: 'provider', as: 'json', timeoutMs: 20 }).catch((e: unknown) => e);
    expect((err as SafeFetchError).cause).toBeInstanceOf(DOMException);
    expect(log.lines.at(-1)?.fields).toMatchObject({ reason: 'timeout', cause: expect.stringMatching(/^AbortError/) });

    const { log: log2, fetch: fetch2 } = withLog([{ match: '/bad', respond: { text: '{nope' } }]);
    await fetch2('https://a.example/bad', { policy: 'provider', as: 'json' }).catch(() => {});
    expect(log2.lines.at(-1)?.fields).toMatchObject({ reason: 'invalid_json', status: 200, cause: 'SyntaxError' });
  });

  it('a redirect to a private address names the blocked hop and the hops followed', async () => {
    const { log, fetch } = withLog([
      { match: 'https://feed.example/cal.ics', respond: { status: 302, headers: { location: 'https://cdn.example/cal.ics' } } },
      { match: 'https://cdn.example/cal.ics', respond: { status: 301, headers: { location: 'http://192.168.1.1/cal.ics' } } },
    ]);
    const err = await fetch('https://feed.example/cal.ics', { policy: 'public', as: 'text', purpose: 'ics' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'blocked', host: '192.168.1.1' });
    expect(outcomeFromError(err).code).toBe('blocked');
    expect(log.lines.at(-1)?.fields).toMatchObject({
      host: 'feed.example',
      reason: 'blocked',
      hops: ['cdn.example'],
      blockedHost: '192.168.1.1',
      cause: 'BlockedAddressError[EHOMEBASE_BLOCKED]',
    });
  });

  it('a plain-http user server that is not on the LAN fails as not_lan (a health code), with its cause', async () => {
    const { log, fetch } = withLog([]);
    const err = await fetch('http://93.184.216.34:8008/dav/', { policy: 'user-server', allowedOrigins: ['http://93.184.216.34:8008'], as: 'text' }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ reason: 'blocked' });
    expect((err as SafeFetchError).cause).toBeInstanceOf(NotPrivateAddressError);
    expect(outcomeFromError(err).code).toBe('not_lan');
    expect(log.lines.at(-1)).toMatchObject({ level: 'warn', fields: { reason: 'not_lan', blockedHost: '93.184.216.34:8008' } });
  });

  it('a caller abort is debug "outbound aborted" and rethrows the abort', async () => {
    const hanging = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const log = createMemoryLogger();
    const fetch = createSafeFetch({ version: '1', log, fetchImpl: hanging as typeof globalThis.fetch });
    const controller = new AbortController();
    const pending = fetch('https://slow.example/x', { policy: 'provider', as: 'json', signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(DOMException);
    expect(log.lines.map((l) => [l.level, l.message])).toEqual([['debug', 'outbound aborted']]);
  });

  it('lists calls in flight with the caller job run / request id, and forgets them when done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (): Promise<Response> => {
      await gate;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    const fetch = createSafeFetch({ version: '1', log: createSilentLogger(), fetchImpl: slow as typeof globalThis.fetch });
    const pending = withLogContext({ job: 'calendar:sync', run: 'abc123', rid: 'r123456789' }, () =>
      fetch('https://graph.example/x', { policy: 'provider', as: 'json', purpose: 'calendar-sync' }),
    );
    await Promise.resolve();
    expect(inflightOutbound()).toEqual([{ host: 'graph.example', purpose: 'calendar-sync', ms: expect.any(Number), run: 'abc123', rid: 'r123456789' }]);
    release();
    await pending;
    expect(inflightOutbound()).toEqual([]);
  });
});
