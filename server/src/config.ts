/**
 * Runtime configuration (§3). Everything comes from the environment with defaults; the host
 * allowlist, origin allowlist, OAuth redirect URIs and the app origin are *derived* here and
 * must never be hard-coded elsewhere. The optional Pages site (`PORTLY_PAGES_URL`, hybrid mode)
 * is kept apart from the origin allowlist: it is trusted only together with a pairing token.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { LogLevel, OAuthProvider } from '@portly/shared';

export interface ConfigPaths {
  /** `<dataDir>/portly.db` */
  db: string;
  /** `<dataDir>/vault.key` */
  vaultKey: string;
  /** `<dataDir>/logs` */
  logsDir: string;
  /** `<dataDir>/logs/server.log` */
  logFile: string;
  /** `<dataDir>/logs/supervisor.log` (written by the supervisor process). */
  supervisorLog: string;
  /** `<dataDir>/backups` */
  backupsDir: string;
  /** Absolute path of the built SPA (`web/dist`), computed from this file's location. */
  webDist: string;
}

export interface Config {
  /** App version (root package.json). */
  version: string;
  port: number;
  /** Listener addresses, e.g. `['127.0.0.1', '::1']`. */
  bindAddresses: readonly string[];
  /** Public origin of the server, e.g. `http://localhost:5757` (no trailing slash). */
  origin: string;
  dataDir: string;
  dev: boolean;
  vitePort: number;
  /** Origin the browser app runs on: `origin`, or the Vite dev server in dev. OAuth callbacks redirect here. */
  appOrigin: string;
  /** Lower-case `host[:port]` values accepted in the Host header (§4.2 step 2). */
  allowedHosts: ReadonlySet<string>;
  /** Exact origins accepted in the Origin header (§4.2 step 4). */
  allowedOrigins: ReadonlySet<string>;
  /**
   * The published Pages site allowed to use this server once a browser is paired with it
   * (`PORTLY_PAGES_URL`, hybrid mode), e.g. `https://user.github.io/portly/`: absolute, path
   * starting and ending with `/`. Null when unset (pairing off; nothing else changes).
   */
  pagesUrl: string | null;
  /** Origin of {@link pagesUrl} (no trailing slash), or null. Never part of {@link allowedOrigins}. */
  pagesOrigin: string | null;
  /**
   * The HTTPS origin other PCs reach this server through (`PORTLY_REMOTE_ORIGIN`: a reverse proxy
   * on this PC such as Tailscale Serve, e.g. `https://pc.tailnet.ts.net`), or null when unset, in
   * which case the server behaves as before (loopback hosts only). Never part of
   * {@link allowedHosts} or {@link allowedOrigins}: a request with its Host is a remote request
   * and needs a device cookie (§4.2, security/gate.ts). The listener itself stays on loopback.
   */
  remoteOrigin: string | null;
  /** Lower-case `host[:port]` of {@link remoteOrigin} as a Host header carries it, or null. */
  remoteHost: string | null;
  /**
   * The loopback port the reverse proxy forwards other PCs to (`PORTLY_REMOTE_PORT`, default
   * {@link port} + 1), or null without a remote origin. Every request arriving on it is a remote
   * request, whatever its Host header says, so a proxy that rewrites the Host cannot make another
   * PC look like this one. The listener is bound to {@link bindAddresses} like the main one.
   */
  remotePort: number | null;
  /** Host headers accepted on the remote port: {@link remoteHost} and the loopback forms of {@link remotePort}. */
  remoteHosts: ReadonlySet<string>;
  /** redirect_uri sent to each provider (token exchange must use the same value). */
  redirectUris: Readonly<Record<OAuthProvider, string>>;
  /** Redirect URI to register with each provider (Entra ignores the port for localhost). */
  registrationRedirectUris: Readonly<Record<OAuthProvider, string>>;
  /** Boot log level (`PORTLY_LOG_LEVEL`: debug | info | warn; default debug in dev, else info). */
  logLevel: LogLevel;
  paths: ConfigPaths;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const DEFAULT_PORT = 5757;
export const DEFAULT_VITE_PORT = 5173;
export const DEFAULT_BIND = '127.0.0.1,::1';

const SERVER_SRC_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SERVER_SRC_DIR, '..', '..');

let cachedVersion: string | null = null;

/** Version from the root package.json (read once). */
export function appVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) throw new ConfigError(`${name} must be an integer 1-65535 (got "${raw}")`);
  const port = Number(trimmed);
  if (port < 1 || port > 65535) throw new ConfigError(`${name} must be an integer 1-65535 (got "${raw}")`);
  return port;
}

function parseBool(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  throw new ConfigError(`${name} must be 0 or 1 (got "${raw}")`);
}

function parseBind(raw: string | undefined): string[] {
  const list = (raw ?? DEFAULT_BIND)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s));
  if (list.length === 0) throw new ConfigError('PORTLY_BIND must list at least one address');
  for (const addr of list) {
    if (isIP(addr) === 0) throw new ConfigError(`PORTLY_BIND entries must be IP addresses (got "${addr}")`);
  }
  return [...new Set(list)];
}

/**
 * How a URL-valued variable is echoed in a ConfigError: its origin (`scheme://host[:port]`) only,
 * never the user name, password, path, query or fragment (the error is logged and shown); a value
 * that is not a URL at all is not echoed.
 */
function echoUrl(url: URL | null): string {
  if (url === null) return 'a value that is not an absolute URL';
  const origin = url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
  return `"${origin}"`;
}

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseOrigin(raw: string | undefined, port: number): string {
  const value = raw === undefined || raw.trim() === '' ? `http://localhost:${port}` : raw.trim();
  const url = tryUrl(value);
  if (url === null) throw new ConfigError(`PORTLY_ORIGIN must be an absolute http(s) origin (got ${echoUrl(null)})`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`PORTLY_ORIGIN must use http or https (got ${echoUrl(url)})`);
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ConfigError(`PORTLY_ORIGIN must be a bare origin like http://localhost:${port} (got ${echoUrl(url)} with more after it)`);
  }
  return url.origin;
}

/** Hosts for which `PORTLY_PAGES_URL` may use plain http (a Pages build served on this PC). */
const LOOPBACK_PAGES_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

interface PagesSite {
  pagesUrl: string | null;
  pagesOrigin: string | null;
}

/**
 * `PORTLY_PAGES_URL`: the Pages site's address. `https:` (or `http:` on a loopback host), no
 * credentials, query or fragment; a missing trailing slash is added. The origin must not be one
 * this server already trusts as its own page.
 */
function parsePagesUrl(raw: string | undefined, ownOrigins: ReadonlySet<string>): PagesSite {
  const value = raw?.trim() ?? '';
  if (value === '') return { pagesUrl: null, pagesOrigin: null };
  const name = 'PORTLY_PAGES_URL';
  if (value === '*' || value.toLowerCase() === 'null') {
    throw new ConfigError(`${name} must be the address of one site, like https://user.github.io/ (got "${value}")`);
  }
  const url = tryUrl(value);
  if (url === null) throw new ConfigError(`${name} must be an absolute https URL (got ${echoUrl(null)})`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_PAGES_HOSTS.has(url.hostname))) {
    throw new ConfigError(`${name} must use https (http only for localhost, 127.0.0.1 or [::1]) (got ${echoUrl(url)})`);
  }
  if (url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new ConfigError(`${name} must not contain a user name, password, query or fragment (got one for ${echoUrl(url)})`);
  }
  if (ownOrigins.has(url.origin)) {
    throw new ConfigError(`${name} must be another site than Portly's own page (got ${echoUrl(url)})`);
  }
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return { pagesUrl: `${url.origin}${pathname}`, pagesOrigin: url.origin };
}

/**
 * `PORTLY_REMOTE_ORIGIN`: the address other PCs use. `https:` (the device cookie is `Secure`), a
 * bare origin (no path, query, fragment or credentials), and neither one of this server's own
 * hosts nor the Pages site. A loopback host on another port is accepted with a start-up warning,
 * over https or plain http (browsers treat `localhost` as secure, cookies included): a local proxy
 * to try the connect flow on this PC before any second PC exists.
 */
function parseRemoteOrigin(
  raw: string | undefined,
  own: { allowedHosts: ReadonlySet<string>; allowedOrigins: ReadonlySet<string>; pagesOrigin: string | null },
): { remoteOrigin: string | null; remoteHost: string | null } {
  const value = raw?.trim() ?? '';
  if (value === '') return { remoteOrigin: null, remoteHost: null };
  const name = 'PORTLY_REMOTE_ORIGIN';
  const url = tryUrl(value);
  if (url === null) throw new ConfigError(`${name} must be an absolute https origin like https://pc.tailnet.ts.net (got ${echoUrl(null)})`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_PAGES_HOSTS.has(url.hostname))) {
    throw new ConfigError(`${name} must use https (http only for localhost, 127.0.0.1 or [::1]) (got ${echoUrl(url)})`);
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ConfigError(`${name} must be a bare origin like https://pc.tailnet.ts.net (got ${echoUrl(url)} with more after it)`);
  }
  const host = url.host.toLowerCase();
  if (own.allowedHosts.has(host) || own.allowedOrigins.has(url.origin)) {
    throw new ConfigError(`${name} must be the address other PCs use, not one of this server's own (got ${echoUrl(url)})`);
  }
  if (own.pagesOrigin !== null && url.origin === own.pagesOrigin) {
    throw new ConfigError(`${name} must be another address than the Pages site (got ${echoUrl(url)})`);
  }
  return { remoteOrigin: url.origin, remoteHost: host };
}

export interface StartupWarning {
  message: string;
  fields: Record<string, string>;
}

/** Configuration that is valid but worth a warning in the log at startup. */
export function startupWarnings(config: Pick<Config, 'pagesOrigin' | 'remoteOrigin'>): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  if (config.pagesOrigin !== null && config.pagesOrigin.startsWith('http:')) {
    warnings.push({
      message: 'PORTLY_PAGES_URL uses plain http: paired browsers on this origin can use Portly',
      fields: { pagesOrigin: config.pagesOrigin },
    });
  }
  if (config.remoteOrigin !== null && LOOPBACK_PAGES_HOSTS.has(new URL(config.remoteOrigin).hostname)) {
    warnings.push({
      message: 'PORTLY_REMOTE_ORIGIN is a loopback address: other PCs cannot reach it (fine for trying the connect flow on this PC)',
      fields: { remoteOrigin: config.remoteOrigin },
    });
  }
  return warnings;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return path.join(localAppData(env), 'Portly');
  const xdg = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== '' ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'portly');
}

/** `%LOCALAPPDATA%`, or `~/AppData/Local` when it is unset. */
function localAppData(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA && env.LOCALAPPDATA.trim() !== '' ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
}

/**
 * The data directory `loadConfig` would use (trimmed `PORTLY_DATA_DIR`, else the platform
 * default), without validating anything else: start-up failures are written to its `logs/` even
 * when the rest of the configuration is invalid. Never throws (falls back to `<tmp>/portly`
 * when not even the home directory can be read).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const raw = env.PORTLY_DATA_DIR;
    return path.resolve(typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : defaultDataDir(env));
  } catch {
    return path.join(os.tmpdir(), 'portly');
  }
}

/**
 * The browser extension's native-messaging launcher log (`native-host/launcher.mjs` writes
 * `launcher.log` next to itself; `scripts/` install it to `%LOCALAPPDATA%\Portly\native-host`,
 * whatever `PORTLY_DATA_DIR` says). Never throws.
 */
export function nativeHostLogPath(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return path.join(localAppData(env), 'Portly', 'native-host', 'launcher.log');
  } catch {
    return path.join('Portly', 'native-host', 'launcher.log');
  }
}

const LOG_LEVEL_VALUES: readonly LogLevel[] = ['debug', 'info', 'warn'];

/** `PORTLY_LOG_LEVEL`: debug | info | warn (any case); unset/blank → debug in dev, else info. */
function parseLogLevel(raw: string | undefined, dev: boolean): LogLevel {
  if (raw === undefined || raw.trim() === '') return dev ? 'debug' : 'info';
  const value = raw.trim().toLowerCase();
  const level = LOG_LEVEL_VALUES.find((l) => l === value);
  if (level === undefined) throw new ConfigError(`PORTLY_LOG_LEVEL must be debug, info or warn (got "${raw}")`);
  return level;
}

/** `host:port` form used in Host headers (IPv6 bracketed, default ports omitted like browsers do). */
function hostHeaderFor(hostname: string, port: number, protocol: 'http:' | 'https:' = 'http:'): string {
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const defaultPort = protocol === 'https:' ? 443 : 80;
  return (port === defaultPort ? host : `${host}:${port}`).toLowerCase();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort('PORTLY_PORT', env.PORTLY_PORT, DEFAULT_PORT);
  const vitePort = parsePort('PORTLY_VITE_PORT', env.PORTLY_VITE_PORT, DEFAULT_VITE_PORT);
  const dev = parseBool('PORTLY_DEV', env.PORTLY_DEV);
  const bindAddresses = parseBind(env.PORTLY_BIND);
  const origin = parseOrigin(env.PORTLY_ORIGIN, port);
  const dataDir = resolveDataDir(env);
  if (dev && vitePort === port) throw new ConfigError('PORTLY_VITE_PORT must differ from PORTLY_PORT');
  const logLevel = parseLogLevel(env.PORTLY_LOG_LEVEL, dev);

  const appOrigin = dev ? `http://localhost:${vitePort}` : origin;

  const allowedHosts = new Set<string>([
    hostHeaderFor('localhost', port),
    hostHeaderFor('127.0.0.1', port),
    hostHeaderFor('::1', port),
    new URL(origin).host.toLowerCase(),
  ]);
  if (dev) allowedHosts.add(hostHeaderFor('localhost', vitePort));

  // Every allowed host is this server (or the dev proxy in front of it), so the page origin
  // for each is allowed too; the configured origin may be https.
  const allowedOrigins = new Set<string>([origin, appOrigin]);
  for (const host of allowedHosts) allowedOrigins.add(`http://${host}`);

  const { pagesUrl, pagesOrigin } = parsePagesUrl(env.PORTLY_PAGES_URL, allowedOrigins);
  const { remoteOrigin, remoteHost } = parseRemoteOrigin(env.PORTLY_REMOTE_ORIGIN, { allowedHosts, allowedOrigins, pagesOrigin });
  const remotePortRaw = env.PORTLY_REMOTE_PORT;
  if (remoteOrigin === null && remotePortRaw !== undefined && remotePortRaw.trim() !== '') {
    throw new ConfigError('PORTLY_REMOTE_PORT needs PORTLY_REMOTE_ORIGIN (the address other PCs use)');
  }
  const remotePort = remoteOrigin === null ? null : parsePort('PORTLY_REMOTE_PORT', remotePortRaw, port + 1 <= 65535 ? port + 1 : port - 1);
  if (remotePort !== null && (remotePort === port || (dev && remotePort === vitePort))) {
    throw new ConfigError('PORTLY_REMOTE_PORT must differ from PORTLY_PORT (and PORTLY_VITE_PORT in dev)');
  }
  const remoteHosts = new Set<string>();
  if (remoteHost !== null && remotePort !== null) {
    remoteHosts.add(remoteHost);
    remoteHosts.add(hostHeaderFor('localhost', remotePort));
    remoteHosts.add(hostHeaderFor('127.0.0.1', remotePort));
    remoteHosts.add(hostHeaderFor('::1', remotePort));
  }

  const redirectUris = {
    google: `${origin}/api/oauth/google/callback`,
    microsoft: `${origin}/api/oauth/microsoft/callback`,
  } as const;

  const originUrl = new URL(origin);
  const microsoftRegistration =
    originUrl.hostname === 'localhost' && originUrl.protocol === 'http:'
      ? 'http://localhost/api/oauth/microsoft/callback'
      : redirectUris.microsoft;

  const logsDir = path.join(dataDir, 'logs');
  return Object.freeze({
    version: appVersion(),
    port,
    bindAddresses: Object.freeze(bindAddresses),
    origin,
    dataDir,
    dev,
    vitePort,
    appOrigin,
    allowedHosts,
    allowedOrigins,
    pagesUrl,
    pagesOrigin,
    remoteOrigin,
    remoteHost,
    remotePort,
    remoteHosts,
    redirectUris: Object.freeze({ ...redirectUris }),
    registrationRedirectUris: Object.freeze({ google: redirectUris.google, microsoft: microsoftRegistration }),
    logLevel,
    paths: Object.freeze({
      db: path.join(dataDir, 'portly.db'),
      vaultKey: path.join(dataDir, 'vault.key'),
      logsDir,
      logFile: path.join(logsDir, 'server.log'),
      supervisorLog: path.join(logsDir, 'supervisor.log'),
      backupsDir: path.join(dataDir, 'backups'),
      webDist: path.join(REPO_ROOT, 'web', 'dist'),
    }),
  });
}
