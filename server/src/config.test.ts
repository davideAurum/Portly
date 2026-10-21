import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, nativeHostLogPath, resolveDataDir, startupWarnings } from './config.ts';

const base = { PORTLY_DATA_DIR: path.resolve('/tmp/portly-config-test') };

describe('loadConfig', () => {
  it('applies the §3 defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.port).toBe(5757);
    expect(c.vitePort).toBe(5173);
    expect(c.bindAddresses).toEqual(['127.0.0.1', '::1']);
    expect(c.origin).toBe('http://localhost:5757');
    expect(c.dev).toBe(false);
    expect(c.appOrigin).toBe('http://localhost:5757');
    expect(c.dataDir).toBe(base.PORTLY_DATA_DIR);
    expect(c.paths.db).toBe(path.join(base.PORTLY_DATA_DIR, 'portly.db'));
    expect(c.paths.logFile).toBe(path.join(base.PORTLY_DATA_DIR, 'logs', 'server.log'));
    expect(c.paths.supervisorLog).toBe(path.join(base.PORTLY_DATA_DIR, 'logs', 'supervisor.log'));
    expect(c.logLevel).toBe('info');
    expect(path.isAbsolute(c.paths.webDist)).toBe(true);
    expect(c.paths.webDist.endsWith(path.join('web', 'dist'))).toBe(true);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults the data dir to %LOCALAPPDATA%\\Portly on Windows', () => {
    const c = loadConfig({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    if (process.platform === 'win32') expect(c.dataDir).toBe('C:\\Users\\x\\AppData\\Local\\Portly');
    else expect(c.dataDir.endsWith('portly')).toBe(true);
  });

  it('derives host/origin allowlists and redirect URIs from the port', () => {
    const c = loadConfig({ ...base, PORTLY_PORT: '5790' });
    expect([...c.allowedHosts].sort()).toEqual(['127.0.0.1:5790', '[::1]:5790', 'localhost:5790']);
    expect(c.allowedOrigins.has('http://localhost:5790')).toBe(true);
    expect(c.allowedOrigins.has('http://127.0.0.1:5790')).toBe(true);
    expect(c.allowedOrigins.has('http://[::1]:5790')).toBe(true);
    expect(c.allowedOrigins.has('http://localhost:5173')).toBe(false);
    expect(c.redirectUris).toEqual({
      google: 'http://localhost:5790/api/oauth/google/callback',
      microsoft: 'http://localhost:5790/api/oauth/microsoft/callback',
    });
    expect(c.registrationRedirectUris.microsoft).toBe('http://localhost/api/oauth/microsoft/callback');
    expect(c.registrationRedirectUris.google).toBe('http://localhost:5790/api/oauth/google/callback');
  });

  it('dev mode points appOrigin at Vite and allows its host/origin', () => {
    const c = loadConfig({ ...base, PORTLY_DEV: '1', PORTLY_VITE_PORT: '5191', PORTLY_PORT: '5790' });
    expect(c.dev).toBe(true);
    expect(c.appOrigin).toBe('http://localhost:5191');
    expect(c.allowedHosts.has('localhost:5191')).toBe(true);
    expect(c.allowedOrigins.has('http://localhost:5191')).toBe(true);
    expect(c.redirectUris.google).toBe('http://localhost:5790/api/oauth/google/callback');
  });

  it('adds a custom origin host (future multi-device)', () => {
    const c = loadConfig({ ...base, PORTLY_ORIGIN: 'https://portly.lan:8443/', PORTLY_BIND: '0.0.0.0' });
    expect(c.origin).toBe('https://portly.lan:8443');
    expect(c.allowedHosts.has('portly.lan:8443')).toBe(true);
    expect(c.allowedOrigins.has('https://portly.lan:8443')).toBe(true);
    expect(c.bindAddresses).toEqual(['0.0.0.0']);
    expect(c.registrationRedirectUris.microsoft).toBe('https://portly.lan:8443/api/oauth/microsoft/callback');
  });

  it.each([
    [{ PORTLY_PORT: 'abc' }],
    [{ PORTLY_PORT: '0' }],
    [{ PORTLY_PORT: '70000' }],
    [{ PORTLY_BIND: 'localhost' }],
    [{ PORTLY_BIND: ' , ' }],
    [{ PORTLY_ORIGIN: 'ftp://x' }],
    [{ PORTLY_ORIGIN: 'http://localhost:5757/app' }],
    [{ PORTLY_ORIGIN: 'http://user:pw@localhost:5757' }],
    [{ PORTLY_DEV: 'maybe' }],
    [{ PORTLY_DEV: '1', PORTLY_VITE_PORT: '5757' }],
  ])('rejects invalid env %j', (env) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(ConfigError);
  });

  it('accepts bracketed IPv6 bind addresses', () => {
    expect(loadConfig({ ...base, PORTLY_BIND: '127.0.0.1, [::1]' }).bindAddresses).toEqual(['127.0.0.1', '::1']);
  });
});

describe('loadConfig: PORTLY_LOG_LEVEL', () => {
  it('defaults to debug in dev and info otherwise', () => {
    expect(loadConfig({ ...base }).logLevel).toBe('info');
    expect(loadConfig({ ...base, PORTLY_LOG_LEVEL: '  ' }).logLevel).toBe('info');
    expect(loadConfig({ ...base, PORTLY_DEV: '1' }).logLevel).toBe('debug');
  });

  it.each([
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
    [' WARN ', 'warn'],
    ['Debug', 'debug'],
  ])('accepts %j', (raw, level) => {
    expect(loadConfig({ ...base, PORTLY_LOG_LEVEL: raw }).logLevel).toBe(level);
    expect(loadConfig({ ...base, PORTLY_DEV: '1', PORTLY_LOG_LEVEL: raw }).logLevel).toBe(level);
  });

  it.each([['error'], ['verbose'], ['trace'], ['1']])('rejects %j', (raw) => {
    expect(() => loadConfig({ ...base, PORTLY_LOG_LEVEL: raw })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORTLY_LOG_LEVEL: raw })).toThrow(/PORTLY_LOG_LEVEL must be debug, info or warn/);
  });
});

describe('resolveDataDir / nativeHostLogPath', () => {
  it('resolveDataDir: the trimmed PORTLY_DATA_DIR, else the platform default, whatever else is invalid', () => {
    expect(resolveDataDir({ PORTLY_DATA_DIR: `  ${base.PORTLY_DATA_DIR}  ` })).toBe(base.PORTLY_DATA_DIR);
    expect(resolveDataDir({ ...base, PORTLY_PORT: 'not a port', PORTLY_LOG_LEVEL: 'nope' })).toBe(base.PORTLY_DATA_DIR);
    expect(() => loadConfig({ ...base, PORTLY_PORT: 'not a port' })).toThrow(ConfigError);
    const local = path.resolve('/tmp/local-app-data');
    const fallback = resolveDataDir({ PORTLY_DATA_DIR: ' ', LOCALAPPDATA: local });
    if (process.platform === 'win32') expect(fallback).toBe(path.join(local, 'Portly'));
    else expect(path.isAbsolute(fallback)).toBe(true);
    expect(resolveDataDir({ ...base })).toBe(loadConfig({ ...base }).dataDir);
  });

  it('nativeHostLogPath: launcher.log in %LOCALAPPDATA%/Portly/native-host (not the data dir)', () => {
    const local = path.resolve('/tmp/local-app-data');
    expect(nativeHostLogPath({ LOCALAPPDATA: local, PORTLY_DATA_DIR: base.PORTLY_DATA_DIR })).toBe(
      path.join(local, 'Portly', 'native-host', 'launcher.log'),
    );
    expect(nativeHostLogPath({ LOCALAPPDATA: '' })).toBe(path.join(os.homedir(), 'AppData', 'Local', 'Portly', 'native-host', 'launcher.log'));
  });
});

describe('loadConfig: PORTLY_PAGES_URL', () => {
  it('is off by default (unset or blank) and never touches the origin allowlist', () => {
    for (const env of [{}, { PORTLY_PAGES_URL: '' }, { PORTLY_PAGES_URL: '   ' }]) {
      const c = loadConfig({ ...base, ...env });
      expect(c.pagesUrl).toBeNull();
      expect(c.pagesOrigin).toBeNull();
      expect(startupWarnings(c)).toEqual([]);
    }
    const on = loadConfig({ ...base, PORTLY_PAGES_URL: 'https://user.github.io/' });
    const off = loadConfig({ ...base });
    expect([...on.allowedOrigins].sort()).toEqual([...off.allowedOrigins].sort());
    expect(on.allowedOrigins.has('https://user.github.io')).toBe(false);
  });

  it.each([
    ['https://user.github.io/', 'https://user.github.io/', 'https://user.github.io'],
    ['https://user.github.io', 'https://user.github.io/', 'https://user.github.io'],
    [' https://User.GitHub.io/portly ', 'https://user.github.io/portly/', 'https://user.github.io'],
    ['https://user.github.io/portly/', 'https://user.github.io/portly/', 'https://user.github.io'],
    ['https://home.example:8443/a/b/', 'https://home.example:8443/a/b/', 'https://home.example:8443'],
    ['https://home.example:443/', 'https://home.example/', 'https://home.example'],
    ['http://localhost:4173/pages/', 'http://localhost:4173/pages/', 'http://localhost:4173'],
    ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/', 'http://127.0.0.1:4173'],
    ['http://[::1]:4173/', 'http://[::1]:4173/', 'http://[::1]:4173'],
  ])('accepts %s', (raw, pagesUrl, pagesOrigin) => {
    const c = loadConfig({ ...base, PORTLY_PAGES_URL: raw });
    expect(c.pagesUrl).toBe(pagesUrl);
    expect(c.pagesOrigin).toBe(pagesOrigin);
  });

  it.each([
    ['*'],
    ['null'],
    ['NULL'],
    ['user.github.io'],
    ['/portly/'],
    ['http://user.github.io/'],
    ['http://192.168.1.10:4173/'],
    ['http://localhost.evil.example/'],
    ['ftp://user.github.io/'],
    ['file:///C:/pages/'],
    ['https://me:pw@user.github.io/'],
    ['https://user.github.io/?x=1'],
    ['https://user.github.io/?'],
    ['https://user.github.io/#/paired'],
    ['https://user.github.io/#'],
    // Portly's own page (any of its allowed origins) is not a Pages site.
    ['http://localhost:5757/'],
    ['http://127.0.0.1:5757/pages/'],
    ['http://[::1]:5757/'],
  ])('rejects %s', (raw) => {
    expect(() => loadConfig({ ...base, PORTLY_PAGES_URL: raw })).toThrow(ConfigError);
  });

  it('rejects the dev server and a custom PORTLY_ORIGIN as Pages sites', () => {
    expect(() => loadConfig({ ...base, PORTLY_DEV: '1', PORTLY_PAGES_URL: 'http://localhost:5173/' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, PORTLY_ORIGIN: 'https://portly.lan:8443', PORTLY_PAGES_URL: 'https://portly.lan:8443/pages/' }),
    ).toThrow(ConfigError);
    expect(loadConfig({ ...base, PORTLY_PAGES_URL: 'http://localhost:5173/' }).pagesOrigin).toBe('http://localhost:5173');
  });

  it('echoes only the origin of a rejected URL in the error (never user name, password, path, query or fragment)', () => {
    const cases: [Record<string, string>, string | null][] = [
      [{ PORTLY_PAGES_URL: 'https://me:pw@user.github.io/secret-path/' }, 'https://user.github.io'],
      [{ PORTLY_PAGES_URL: 'https://user.github.io/?token=abc' }, 'https://user.github.io'],
      [{ PORTLY_PAGES_URL: 'https://user.github.io/#token=abc' }, 'https://user.github.io'],
      [{ PORTLY_PAGES_URL: 'http://user.github.io/private/' }, 'http://user.github.io'],
      [{ PORTLY_PAGES_URL: 'not a url with token=abc' }, null],
      [{ PORTLY_ORIGIN: 'http://me:pw@localhost:5757' }, 'http://localhost:5757'],
      [{ PORTLY_ORIGIN: 'http://localhost:5757/private?token=abc' }, 'http://localhost:5757'],
      [{ PORTLY_ORIGIN: 'ftp://me:pw@x/private' }, 'ftp://x'],
    ];
    for (const [env, origin] of cases) {
      let message = '';
      try {
        loadConfig({ ...base, ...env });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(env)).not.toMatch(/me:pw|pw@|private|token|abc|secret/);
      if (origin !== null) expect(message).toContain(`"${origin}"`);
    }
  });

  it('warns at startup about a plain-http (loopback) Pages origin, naming it', () => {
    expect(startupWarnings(loadConfig({ ...base, PORTLY_PAGES_URL: 'https://user.github.io/' }))).toEqual([]);
    const warnings = startupWarnings(loadConfig({ ...base, PORTLY_PAGES_URL: 'http://localhost:4173/pages/' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/plain http/);
    expect(warnings[0]?.fields).toEqual({ pagesOrigin: 'http://localhost:4173' });
  });
});

describe('loadConfig: PORTLY_REMOTE_ORIGIN', () => {
  it('is off by default (unset or blank) and changes nothing else', () => {
    for (const env of [{}, { PORTLY_REMOTE_ORIGIN: '' }, { PORTLY_REMOTE_ORIGIN: '   ' }]) {
      const c = loadConfig({ ...base, ...env });
      expect(c.remoteOrigin).toBeNull();
      expect(c.remoteHost).toBeNull();
      expect(c.remotePort).toBeNull();
      expect(c.remoteHosts.size).toBe(0);
    }
    const on = loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net' });
    const off = loadConfig({ ...base });
    expect([...on.allowedHosts].sort()).toEqual([...off.allowedHosts].sort());
    expect([...on.allowedOrigins].sort()).toEqual([...off.allowedOrigins].sort());
    expect(on.allowedHosts.has('pc.tailnet.ts.net')).toBe(false);
    expect(on.allowedOrigins.has('https://pc.tailnet.ts.net')).toBe(false);
    expect(on.bindAddresses).toEqual(['127.0.0.1', '::1']);
  });

  it.each([
    ['https://pc.tailnet.ts.net', 'https://pc.tailnet.ts.net', 'pc.tailnet.ts.net'],
    ['https://pc.tailnet.ts.net/', 'https://pc.tailnet.ts.net', 'pc.tailnet.ts.net'],
    [' https://PC.Tailnet.ts.net ', 'https://pc.tailnet.ts.net', 'pc.tailnet.ts.net'],
    ['https://pc.tailnet.ts.net:443', 'https://pc.tailnet.ts.net', 'pc.tailnet.ts.net'],
    ['https://home.example:8443', 'https://home.example:8443', 'home.example:8443'],
  ])('accepts %s', (raw, remoteOrigin, remoteHost) => {
    const c = loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: raw });
    expect(c.remoteOrigin).toBe(remoteOrigin);
    expect(c.remoteHost).toBe(remoteHost);
  });

  it.each([
    ['pc.tailnet.ts.net'],
    ['http://pc.tailnet.ts.net'],
    ['ftp://pc.tailnet.ts.net'],
    ['https://me:pw@pc.tailnet.ts.net'],
    ['https://pc.tailnet.ts.net/portly'],
    ['https://pc.tailnet.ts.net/?x=1'],
    ['https://pc.tailnet.ts.net/#/'],
    // This server's own hosts are local, never remote.
    ['https://localhost:5757'],
    ['https://127.0.0.1:5757'],
    ['https://[::1]:5757'],
  ])('rejects %s', (raw) => {
    expect(() => loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: raw })).toThrow(ConfigError);
  });

  it('accepts a loopback address on another port (a local HTTPS proxy, to try the flow on this PC) with a warning', () => {
    for (const [raw, host] of [
      ['https://localhost:8443', 'localhost:8443'],
      ['https://127.0.0.1:8443', '127.0.0.1:8443'],
      ['https://[::1]:8443', '[::1]:8443'],
      ['https://localhost', 'localhost'],
    ]) {
      const c = loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: raw });
      expect(c.remoteHost, raw).toBe(host);
      expect(c.allowedHosts.has(host!), raw).toBe(false);
      const warnings = startupWarnings(c);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toMatch(/loopback/);
      expect(warnings[0]?.fields).toEqual({ remoteOrigin: c.remoteOrigin });
    }
    expect(startupWarnings(loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net' }))).toEqual([]);
    // The dev server's host is local too.
    expect(() => loadConfig({ ...base, PORTLY_DEV: '1', PORTLY_REMOTE_ORIGIN: 'https://localhost:5173' })).toThrow(ConfigError);
  });

  it('listens for other PCs on the port after the main one unless PORTLY_REMOTE_PORT says otherwise', () => {
    const c = loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net' });
    expect(c.remotePort).toBe(5758);
    expect([...c.remoteHosts].sort()).toEqual(['127.0.0.1:5758', '[::1]:5758', 'localhost:5758', 'pc.tailnet.ts.net']);
    expect(c.allowedHosts.has('localhost:5758')).toBe(false);
    const explicit = loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net', PORTLY_REMOTE_PORT: '6000' });
    expect(explicit.remotePort).toBe(6000);
    expect(explicit.remoteHosts.has('localhost:6000')).toBe(true);
    expect(() => loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net', PORTLY_REMOTE_PORT: '5757' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net', PORTLY_REMOTE_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORTLY_DEV: '1', PORTLY_VITE_PORT: '5758', PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net' })).toThrow(ConfigError);
    // The port alone makes no sense.
    expect(() => loadConfig({ ...base, PORTLY_REMOTE_PORT: '5758' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, PORTLY_REMOTE_PORT: '' }).remotePort).toBeNull();
  });

  it('rejects a custom PORTLY_ORIGIN host and the Pages site as the remote origin', () => {
    expect(() => loadConfig({ ...base, PORTLY_ORIGIN: 'https://portly.lan:8443', PORTLY_REMOTE_ORIGIN: 'https://portly.lan:8443' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORTLY_PAGES_URL: 'https://user.github.io/', PORTLY_REMOTE_ORIGIN: 'https://user.github.io' })).toThrow(ConfigError);
    const both = loadConfig({ ...base, PORTLY_PAGES_URL: 'https://user.github.io/', PORTLY_REMOTE_ORIGIN: 'https://pc.tailnet.ts.net' });
    expect(both.pagesOrigin).toBe('https://user.github.io');
    expect(both.remoteOrigin).toBe('https://pc.tailnet.ts.net');
  });

  it('echoes only the origin of a rejected address in the error', () => {
    for (const raw of ['https://me:pw@pc.tailnet.ts.net/secret?token=abc', 'http://pc.tailnet.ts.net/private']) {
      let message = '';
      try {
        loadConfig({ ...base, PORTLY_REMOTE_ORIGIN: raw });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        message = (err as Error).message;
      }
      expect(message).not.toMatch(/me:pw|pw@|private|token|abc|secret/);
      expect(message).toContain('pc.tailnet.ts.net');
    }
  });
});
