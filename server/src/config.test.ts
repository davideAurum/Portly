import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, nativeHostLogPath, resolveDataDir, startupWarnings } from './config.ts';

const base = { HOMEBASE_DATA_DIR: path.resolve('/tmp/homebase-config-test') };

describe('loadConfig', () => {
  it('applies the §3 defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.port).toBe(5757);
    expect(c.vitePort).toBe(5173);
    expect(c.bindAddresses).toEqual(['127.0.0.1', '::1']);
    expect(c.origin).toBe('http://localhost:5757');
    expect(c.dev).toBe(false);
    expect(c.appOrigin).toBe('http://localhost:5757');
    expect(c.dataDir).toBe(base.HOMEBASE_DATA_DIR);
    expect(c.paths.db).toBe(path.join(base.HOMEBASE_DATA_DIR, 'homebase.db'));
    expect(c.paths.logFile).toBe(path.join(base.HOMEBASE_DATA_DIR, 'logs', 'server.log'));
    expect(c.paths.supervisorLog).toBe(path.join(base.HOMEBASE_DATA_DIR, 'logs', 'supervisor.log'));
    expect(c.logLevel).toBe('info');
    expect(path.isAbsolute(c.paths.webDist)).toBe(true);
    expect(c.paths.webDist.endsWith(path.join('web', 'dist'))).toBe(true);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults the data dir to %LOCALAPPDATA%\\Homebase on Windows', () => {
    const c = loadConfig({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    if (process.platform === 'win32') expect(c.dataDir).toBe('C:\\Users\\x\\AppData\\Local\\Homebase');
    else expect(c.dataDir.endsWith('homebase')).toBe(true);
  });

  it('derives host/origin allowlists and redirect URIs from the port', () => {
    const c = loadConfig({ ...base, HOMEBASE_PORT: '5790' });
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
    const c = loadConfig({ ...base, HOMEBASE_DEV: '1', HOMEBASE_VITE_PORT: '5191', HOMEBASE_PORT: '5790' });
    expect(c.dev).toBe(true);
    expect(c.appOrigin).toBe('http://localhost:5191');
    expect(c.allowedHosts.has('localhost:5191')).toBe(true);
    expect(c.allowedOrigins.has('http://localhost:5191')).toBe(true);
    expect(c.redirectUris.google).toBe('http://localhost:5790/api/oauth/google/callback');
  });

  it('adds a custom origin host (future multi-device)', () => {
    const c = loadConfig({ ...base, HOMEBASE_ORIGIN: 'https://homebase.lan:8443/', HOMEBASE_BIND: '0.0.0.0' });
    expect(c.origin).toBe('https://homebase.lan:8443');
    expect(c.allowedHosts.has('homebase.lan:8443')).toBe(true);
    expect(c.allowedOrigins.has('https://homebase.lan:8443')).toBe(true);
    expect(c.bindAddresses).toEqual(['0.0.0.0']);
    expect(c.registrationRedirectUris.microsoft).toBe('https://homebase.lan:8443/api/oauth/microsoft/callback');
  });

  it.each([
    [{ HOMEBASE_PORT: 'abc' }],
    [{ HOMEBASE_PORT: '0' }],
    [{ HOMEBASE_PORT: '70000' }],
    [{ HOMEBASE_BIND: 'localhost' }],
    [{ HOMEBASE_BIND: ' , ' }],
    [{ HOMEBASE_ORIGIN: 'ftp://x' }],
    [{ HOMEBASE_ORIGIN: 'http://localhost:5757/app' }],
    [{ HOMEBASE_ORIGIN: 'http://user:pw@localhost:5757' }],
    [{ HOMEBASE_DEV: 'maybe' }],
    [{ HOMEBASE_DEV: '1', HOMEBASE_VITE_PORT: '5757' }],
  ])('rejects invalid env %j', (env) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(ConfigError);
  });

  it('accepts bracketed IPv6 bind addresses', () => {
    expect(loadConfig({ ...base, HOMEBASE_BIND: '127.0.0.1, [::1]' }).bindAddresses).toEqual(['127.0.0.1', '::1']);
  });
});

describe('loadConfig: HOMEBASE_LOG_LEVEL', () => {
  it('defaults to debug in dev and info otherwise', () => {
    expect(loadConfig({ ...base }).logLevel).toBe('info');
    expect(loadConfig({ ...base, HOMEBASE_LOG_LEVEL: '  ' }).logLevel).toBe('info');
    expect(loadConfig({ ...base, HOMEBASE_DEV: '1' }).logLevel).toBe('debug');
  });

  it.each([
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
    [' WARN ', 'warn'],
    ['Debug', 'debug'],
  ])('accepts %j', (raw, level) => {
    expect(loadConfig({ ...base, HOMEBASE_LOG_LEVEL: raw }).logLevel).toBe(level);
    expect(loadConfig({ ...base, HOMEBASE_DEV: '1', HOMEBASE_LOG_LEVEL: raw }).logLevel).toBe(level);
  });

  it.each([['error'], ['verbose'], ['trace'], ['1']])('rejects %j', (raw) => {
    expect(() => loadConfig({ ...base, HOMEBASE_LOG_LEVEL: raw })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HOMEBASE_LOG_LEVEL: raw })).toThrow(/HOMEBASE_LOG_LEVEL must be debug, info or warn/);
  });
});

describe('resolveDataDir / nativeHostLogPath', () => {
  it('resolveDataDir: the trimmed HOMEBASE_DATA_DIR, else the platform default, whatever else is invalid', () => {
    expect(resolveDataDir({ HOMEBASE_DATA_DIR: `  ${base.HOMEBASE_DATA_DIR}  ` })).toBe(base.HOMEBASE_DATA_DIR);
    expect(resolveDataDir({ ...base, HOMEBASE_PORT: 'not a port', HOMEBASE_LOG_LEVEL: 'nope' })).toBe(base.HOMEBASE_DATA_DIR);
    expect(() => loadConfig({ ...base, HOMEBASE_PORT: 'not a port' })).toThrow(ConfigError);
    const local = path.resolve('/tmp/local-app-data');
    const fallback = resolveDataDir({ HOMEBASE_DATA_DIR: ' ', LOCALAPPDATA: local });
    if (process.platform === 'win32') expect(fallback).toBe(path.join(local, 'Homebase'));
    else expect(path.isAbsolute(fallback)).toBe(true);
    expect(resolveDataDir({ ...base })).toBe(loadConfig({ ...base }).dataDir);
  });

  it('nativeHostLogPath: launcher.log in %LOCALAPPDATA%/Homebase/native-host (not the data dir)', () => {
    const local = path.resolve('/tmp/local-app-data');
    expect(nativeHostLogPath({ LOCALAPPDATA: local, HOMEBASE_DATA_DIR: base.HOMEBASE_DATA_DIR })).toBe(
      path.join(local, 'Homebase', 'native-host', 'launcher.log'),
    );
    expect(nativeHostLogPath({ LOCALAPPDATA: '' })).toBe(path.join(os.homedir(), 'AppData', 'Local', 'Homebase', 'native-host', 'launcher.log'));
  });
});

describe('loadConfig: HOMEBASE_PAGES_URL', () => {
  it('is off by default (unset or blank) and never touches the origin allowlist', () => {
    for (const env of [{}, { HOMEBASE_PAGES_URL: '' }, { HOMEBASE_PAGES_URL: '   ' }]) {
      const c = loadConfig({ ...base, ...env });
      expect(c.pagesUrl).toBeNull();
      expect(c.pagesOrigin).toBeNull();
      expect(startupWarnings(c)).toEqual([]);
    }
    const on = loadConfig({ ...base, HOMEBASE_PAGES_URL: 'https://user.github.io/' });
    const off = loadConfig({ ...base });
    expect([...on.allowedOrigins].sort()).toEqual([...off.allowedOrigins].sort());
    expect(on.allowedOrigins.has('https://user.github.io')).toBe(false);
  });

  it.each([
    ['https://user.github.io/', 'https://user.github.io/', 'https://user.github.io'],
    ['https://user.github.io', 'https://user.github.io/', 'https://user.github.io'],
    [' https://User.GitHub.io/homebase ', 'https://user.github.io/homebase/', 'https://user.github.io'],
    ['https://user.github.io/homebase/', 'https://user.github.io/homebase/', 'https://user.github.io'],
    ['https://home.example:8443/a/b/', 'https://home.example:8443/a/b/', 'https://home.example:8443'],
    ['https://home.example:443/', 'https://home.example/', 'https://home.example'],
    ['http://localhost:4173/pages/', 'http://localhost:4173/pages/', 'http://localhost:4173'],
    ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/', 'http://127.0.0.1:4173'],
    ['http://[::1]:4173/', 'http://[::1]:4173/', 'http://[::1]:4173'],
  ])('accepts %s', (raw, pagesUrl, pagesOrigin) => {
    const c = loadConfig({ ...base, HOMEBASE_PAGES_URL: raw });
    expect(c.pagesUrl).toBe(pagesUrl);
    expect(c.pagesOrigin).toBe(pagesOrigin);
  });

  it.each([
    ['*'],
    ['null'],
    ['NULL'],
    ['user.github.io'],
    ['/homebase/'],
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
    // Homebase's own page (any of its allowed origins) is not a Pages site.
    ['http://localhost:5757/'],
    ['http://127.0.0.1:5757/pages/'],
    ['http://[::1]:5757/'],
  ])('rejects %s', (raw) => {
    expect(() => loadConfig({ ...base, HOMEBASE_PAGES_URL: raw })).toThrow(ConfigError);
  });

  it('rejects the dev server and a custom HOMEBASE_ORIGIN as Pages sites', () => {
    expect(() => loadConfig({ ...base, HOMEBASE_DEV: '1', HOMEBASE_PAGES_URL: 'http://localhost:5173/' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, HOMEBASE_ORIGIN: 'https://homebase.lan:8443', HOMEBASE_PAGES_URL: 'https://homebase.lan:8443/pages/' }),
    ).toThrow(ConfigError);
    expect(loadConfig({ ...base, HOMEBASE_PAGES_URL: 'http://localhost:5173/' }).pagesOrigin).toBe('http://localhost:5173');
  });

  it('echoes only the origin of a rejected URL in the error (never user name, password, path, query or fragment)', () => {
    const cases: [Record<string, string>, string | null][] = [
      [{ HOMEBASE_PAGES_URL: 'https://me:pw@user.github.io/secret-path/' }, 'https://user.github.io'],
      [{ HOMEBASE_PAGES_URL: 'https://user.github.io/?token=abc' }, 'https://user.github.io'],
      [{ HOMEBASE_PAGES_URL: 'https://user.github.io/#token=abc' }, 'https://user.github.io'],
      [{ HOMEBASE_PAGES_URL: 'http://user.github.io/private/' }, 'http://user.github.io'],
      [{ HOMEBASE_PAGES_URL: 'not a url with token=abc' }, null],
      [{ HOMEBASE_ORIGIN: 'http://me:pw@localhost:5757' }, 'http://localhost:5757'],
      [{ HOMEBASE_ORIGIN: 'http://localhost:5757/private?token=abc' }, 'http://localhost:5757'],
      [{ HOMEBASE_ORIGIN: 'ftp://me:pw@x/private' }, 'ftp://x'],
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
    expect(startupWarnings(loadConfig({ ...base, HOMEBASE_PAGES_URL: 'https://user.github.io/' }))).toEqual([]);
    const warnings = startupWarnings(loadConfig({ ...base, HOMEBASE_PAGES_URL: 'http://localhost:4173/pages/' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/plain http/);
    expect(warnings[0]?.fields).toEqual({ pagesOrigin: 'http://localhost:4173' });
  });
});
