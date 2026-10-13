import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { parseLocalServerOrigin } from './src/localServer/origin.ts';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const rootPackage = JSON.parse(readFileSync(path.join(webDir, '..', 'package.json'), 'utf8')) as { version: string };

/**
 * When this version was last updated (ISO-8601 with offset, e.g. `2026-10-11T08:12:34-05:00`): the
 * last commit's time, or the build time when git is unavailable (e.g. building from a source archive).
 */
function lastUpdated(): string {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: webDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(iso) && Number.isFinite(Date.parse(iso))) return iso;
  } catch {
    // Fall through to the build time.
  }
  return new Date().toISOString();
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer 1-65535`);
  return value;
}

const apiPort = port('HOMEBASE_PORT', 5757);
const vitePort = port('HOMEBASE_VITE_PORT', 5173);

/** Mode `static` (`vite build --mode static`): the browser-only build served as plain files. */
export const STATIC_MODE = 'static';

/**
 * Content-Security-Policy of the static build, injected as a `<meta>` because static hosts send
 * no headers. Mirrors the server's CSP (§4.3) plus the third-party origins the browser now calls
 * directly: Open-Meteo (weather, geocoding), Todoist, Wikipedia (suggestions), ESPN (sports),
 * Microsoft's token endpoint and Graph (Outlook.com sign-in and calendar on the in-browser
 * backend), and DuckDuckGo's favicon service used as `<img src>`. In hybrid mode `connect-src` also
 * allows the Homebase server on this PC (`localServer`); its images reach the page as
 * `blob:`/`data:` URLs, which `img-src` already allows. `frame-ancestors` cannot be expressed in a
 * meta tag.
 */
export function staticCsp(localServer: string): string {
  const connect = [
    "'self'",
    'https://api.open-meteo.com',
    'https://geocoding-api.open-meteo.com',
    'https://api.todoist.com',
    'https://en.wikipedia.org',
    'https://site.api.espn.com',
    'https://login.microsoftonline.com',
    'https://graph.microsoft.com',
  ];
  if (localServer !== '') connect.push(localServer);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://icons.duckduckgo.com https://a.espncdn.com",
    `connect-src ${connect.join(' ')}`,
    "font-src 'self' data:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Base path for a GitHub Pages project site (`/<repo>/`); must start and end with `/`. */
function staticBase(env: Record<string, string>): string {
  const raw = env.HOMEBASE_STATIC_BASE?.trim();
  if (raw === undefined || raw === '') return '/';
  if (!raw.startsWith('/') || !raw.endsWith('/')) throw new Error(`HOMEBASE_STATIC_BASE must start and end with "/" (got "${raw}")`);
  return raw;
}

function staticHtml(localServer: string): Plugin {
  return {
    name: 'homebase-static-html',
    // Build only: the dev server needs plugin-react's inline preamble and the HMR socket, which
    // this CSP would block.
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: staticCsp(localServer) }, injectTo: 'head-prepend' },
        { tag: 'meta', attrs: { name: 'homebase-build', content: 'static' }, injectTo: 'head' },
      ],
    },
  };
}

/**
 * Ships scripts/install.ps1 (install or update from a release package) and scripts/setup.ps1 (a
 * Git checkout, for development) at the site root, so a new PC can run `irm <site>/install.ps1 | iex`.
 * Copied byte for byte: the scripts are ASCII with CRLF endings.
 */
function staticSetupScript(): Plugin {
  return {
    name: 'homebase-static-setup-script',
    apply: 'build',
    generateBundle() {
      for (const fileName of ['install.ps1', 'setup.ps1']) {
        const source = readFileSync(path.join(webDir, '..', 'scripts', fileName));
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}

// §10.1: /api is proxied to the Homebase server with changeOrigin: false (the Host header stays
// `localhost:<vite port>`, which the server allowlists in dev). Never set server.host or cors.
export default defineConfig(({ mode }) => {
  const isStatic = mode === STATIC_MODE;
  const env = loadEnv(mode, webDir, 'HOMEBASE_');
  // Hybrid mode: the Homebase server on this PC the Pages build may use (`HOMEBASE_STATIC_SERVER`,
  // default http://127.0.0.1:5757, `off` disables it; loopback origins only, see
  // src/localServer/origin.ts). The server build never looks for another server: it is the server.
  const localServer = isStatic ? parseLocalServerOrigin(env.HOMEBASE_STATIC_SERVER) : '';
  return {
    root: webDir,
    base: isStatic ? staticBase(env) : '/',
    plugins: isStatic ? [react(), staticHtml(localServer), staticSetupScript()] : [react()],
    define: {
      __APP_VERSION__: JSON.stringify(rootPackage.version),
      __APP_UPDATED__: JSON.stringify(lastUpdated()),
      __HOMEBASE_STATIC__: JSON.stringify(isStatic),
      // Origin of the Homebase server on this PC the Pages build may use (hybrid mode); '' = off.
      __HOMEBASE_LOCAL_SERVER__: JSON.stringify(localServer),
    },
    server: {
      port: vitePort,
      strictPort: true,
      proxy: isStatic
        ? undefined
        : {
            '/api': {
              target: `http://127.0.0.1:${apiPort}`,
              changeOrigin: false,
            },
          },
    },
    preview: {
      port: vitePort,
      strictPort: true,
    },
    build: {
      outDir: path.join(webDir, isStatic ? 'dist-static' : 'dist'),
      emptyOutDir: true,
      assetsDir: 'assets',
      sourcemap: false,
    },
  };
});
