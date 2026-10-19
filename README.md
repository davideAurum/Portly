# Portly

Portly is a single-user, highly customizable browser home page — a "portal to the internet" that
runs entirely on your own Windows 11 PC. A small Node.js server bound to loopback serves the
dashboard and holds every credential; a tiny browser extension makes it the New Tab page in Chrome
and Edge. There is no cloud service: the only outside traffic is to the providers you connect.

**Get started: [docs/SETUP.md](docs/SETUP.md)**

## Features

- **Search** — multiple engines with keyword switching (`yt cats`), URL detection, suggestions and
  bookmark matches.
- **Launch pad** — bookmark groups with auto-fetched icons, drag-and-drop ordering, and import from
  Chrome, Edge or an HTML bookmarks file.
- **Calendar** — Google and Outlook.com with create/edit/delete; Yahoo and any CalDAV server plus
  ICS/webcal subscriptions read-only. Agenda, week and month views.
- **Mail** — Gmail, Outlook.com and IMAP (Yahoo, iCloud, Fastmail, …): unread counts, recent
  messages, mark read/unread, archive, trash, open in webmail.
- **Todoist** — tasks by filter, natural-language quick add, complete with undo.
- **Weather** (Open-Meteo, no key) and a **clock** with greeting and extra time zones.
- **Customization** — a 12-column widget grid (add, remove, move, resize, several instances of any
  widget), per-widget settings, themes (light/dark, accent, gradient or image background, fonts,
  density, optional frosted glass), named profiles, and config export/import. The page is kept
  light on the graphics card: a photo's blur is prepared once instead of redrawn live, and the
  frosted-glass effect is off unless you turn it on.
- **Diagnostics** — **Settings → Diagnostics** shows the health of every account, calendar, feed
  and background job with what to do about a failure, the server log (short by default, Verbose
  on request), what the browser noticed, and a downloadable report. Secrets, contents and full
  addresses are never logged.

## How it fits together

```text
  Chrome / Edge                     Your PC, loopback only                     Internet
 +--------------------+          +-----------------------------------+      +-----------------+
 | New-tab extension  |--------->| Node server  localhost:5757       |----->| Google, Graph,  |
 | checks /api/health | redirect |  - serves the React app           |      | Yahoo, CalDAV,  |
 | and redirects      |          |  - JSON API /api/*                |      | IMAP, Todoist,  |
 +--------------------+          |  - SQLite + DPAPI-protected vault |      | Open-Meteo, ... |
 | Portly web app     |<-------->|  - sync scheduler, OAuth, fetch   |      +-----------------+
 +--------------------+   /api   +-----------------------------------+
                                   started by Task Scheduler when the
                                   extension's launcher asks (browser
                                   start / new tab) or at sign-in
                                   -> supervisor.ts -> index.ts, shown in
                                   Task Manager as portly-supervisor.exe
                                   and portly-server.exe
```

- **server/** — Node 24 + Hono, run directly from TypeScript (no bundling). SQLite via
  `node:sqlite`, credentials encrypted with AES-256-GCM under a DPAPI-protected key, all outbound
  requests through one guarded fetch (SSRF protection, size caps, timeouts).
- **web/** — React 19 + Vite 8 single-page app with TanStack Query; widgets are lazy-loaded
  modules in a registry.
- **shared/** — the API contract: TypeScript types and zod schemas used by both sides.
- **extension/** — Manifest V3 new-tab extension, plain JavaScript, no build step.
- **scripts/** — PowerShell helpers: foreground start, autostart install/remove, status.

The full design, including the security model, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Security in one paragraph

The server only listens on loopback, checks the `Host` header, requires `X-Portly: 1` plus
same-origin fetch metadata on API calls, sends CORS headers to nobody but the one Pages site you
configure (and answers it only for browsers paired on Portly's own page, with a token on every
request; the paired site can do everything Portly's own page does except approve a new pairing —
see [Pages site with Portly on this PC](docs/setup/pages-local-server.md#security-one-site-every-page-on-it)),
serves the app with a strict Content-Security-Policy (no inline or eval'd script), stores
credentials encrypted with a DPAPI-protected key and never returns them to the browser, treats every
email, calendar feed and favicon as hostile input, and fetches untrusted URLs only through a guarded
client that refuses private-network addresses. Details: [ARCHITECTURE §4](docs/ARCHITECTURE.md#4-security-model-mandatory).

## Requirements

- Windows 11 (DPAPI vault, Task Scheduler autostart)
- Chrome or Edge for the new-tab extension
- From the source code: Node.js ≥ 24 and npm ≥ 11.10 (enforced by `engine-strict`). A release
  package brings its own Node.js.

## Install

```powershell
irm https://davideaurum.github.io/install.ps1 | iex
```

installs the latest release package (its own Node.js included; no Git, npm or administrator rights)
into `%LOCALAPPDATA%\Programs\Portly`, with autostart and the `portly` command;
`portly --update` updates it. Details: [docs/SETUP.md](docs/SETUP.md#install); building and
publishing releases: [docs/setup/releases.md](docs/setup/releases.md).

## Quick start (from the source code)

```powershell
npm ci
npm run build
npm start        # http://localhost:5757
```

On a new PC, `scripts\setup.ps1` does all of this plus Node/Git, autostart and the `portly`
command in one go ([one-command setup](docs/SETUP.md#one-command-setup-on-a-new-pc)).

Then [install the extension](docs/setup/extension.md), [turn on autostart](docs/setup/autostart.md)
and [connect your accounts](docs/SETUP.md#connect-your-accounts).

## Browser-only build

Portly can also be built as plain files that run entirely in the browser — no server, hosted on
GitHub Pages — with search, bookmarks, clock, weather, Todoist, themes, profiles and export/import,
and Outlook.com calendars (the browser signs in to Microsoft and syncs them itself). Mail, feeds,
Google and app-password accounts, and ICS links need the server and are left out. Your data lives
in that browser's storage (IndexedDB), moved between computers with export/import.

```powershell
npm run build:static     # web\dist-static; set PORTLY_STATIC_BASE=/<repo>/ for a project site
npm run preview:static   # http://localhost:5173 (localhost only)
```

Publishing goes to a separate **public** repository made for the site (a new, empty one, or your
`<user>.github.io` user site), since every publish replaces its whole content: `scripts\publish-static.ps1`, or the manual GitHub Actions workflow
`.github\workflows\static-pages.yml`. What is and isn't available, where the data lives and the
privacy notes are in [docs/setup/static-build.md](docs/setup/static-build.md).

**Hybrid mode.** When Portly also runs on the PC, the published site can use it: a browser paired
once on Portly's own page gets Portly's data and every feature while it runs, and the site's own
in-browser copy otherwise (two separate datasets, no sync). The new-tab extension follows
Portly on this PC: it opens the Pages site when the server has one. Set-up: [docs/setup/pages-local-server.md](docs/setup/pages-local-server.md)
(server: `PORTLY_PAGES_URL`; build: `PORTLY_STATIC_SERVER`, default `http://127.0.0.1:5757`,
`off` to disable).

## Repository layout

| Path         | Package            | What it is                                                |
| ------------ | ------------------ | --------------------------------------------------------- |
| `shared/`    | `@portly/shared` | API contracts: TypeScript types + zod schemas             |
| `server/`    | `@portly/server` | Hono + `node:sqlite` server, run directly from TypeScript |
| `web/`       | `@portly/web`    | React 19 + Vite 8 single-page app                         |
| `extension/` | —                  | Manifest V3 new-tab extension (plain JS)                  |
| `scripts/`   | —                  | PowerShell start/autostart/status scripts and checks      |
| `native-host/` | —                | Native messaging host the extension uses to start Portly |
| `docs/`      | —                  | Architecture and setup guides                             |

## npm scripts

| Command             | What it does                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `npm ci`            | Install exactly what `package-lock.json` pins (install scripts are disabled in `.npmrc`).        |
| `npm run dev`       | Server with `node --watch` (`PORTLY_DEV=1`) plus the Vite dev server; open the Vite URL.       |
| `npm run build`     | Build the web app to `web/dist` (the server needs no build).                                     |
| `npm run build:static` | Build the browser-only app to `web/dist-static` (`vite build --mode static`; `PORTLY_STATIC_BASE` sets the URL prefix). See [docs/setup/static-build.md](docs/setup/static-build.md). |
| `npm run preview:static` | Serve `web/dist-static` at `http://localhost:5173` to check it (localhost only).           |
| `npm start`         | Run the server (`node server/src/index.ts`), serving `web/dist`; fails clearly if it is missing. |
| `npm run typecheck` | `tsc --noEmit` for shared, server and web.                                                       |
| `npm test`          | `vitest run` (server, web and static projects; one project alone: `node node_modules/vitest/vitest.mjs run --project static`), the extension tests (`npm run test:extension`), the native host tests (`npm run test:native-host`), then `npm audit --omit=dev --audit-level=high`. |

GitHub Actions runs `npm run typecheck`, `npm test`, both builds and `scripts\check-scripts.ps1` on
Windows for every push to `main` and every pull request (`.github\workflows\ci.yml`).

## Other scripts

Run PowerShell scripts as `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\<name>.ps1`.

| Command | What it does |
| --- | --- |
| `scripts\start.ps1` | Foreground run with checks: Node version, builds `web\dist` if missing, refuses to start twice. `-Port`, `-DataDir`, `-Rebuild`. |
| `scripts\install-autostart.ps1` | Registers the **Portly Server** scheduled task and the native messaging host `com.portly.launcher` (Chrome + Edge, per user), so the extension starts Portly when the browser opens or a new tab needs it (`-Trigger Logon`: at sign-in instead). The task runs a copy of `node.exe` named `portly-supervisor.exe`, and the server runs as `portly-server.exe`, so Task Manager shows Portly by name ([details](docs/setup/autostart.md#in-task-manager)). Starts it and waits for `/api/health`. `-DryRun` prints the task, every file and registry value without changing anything. |
| `scripts\uninstall-autostart.ps1` | Stops Portly, removes the task, the native host and Portly's copies of `node.exe`; leaves your data alone. |
| `scripts\status.ps1` | Task state and mode, what it runs as, native host registration, processes (with their program names), health, data folder and logs (`-LogLines N`). |
| `scripts\publish-static.ps1` | Builds the browser-only app and publishes it to a local clone of your public GitHub Pages repository (`-PublicRepoPath`, `-Base`, `-Message`, `-DryRun`, `-NoPush`, `-ReplaceEverything`). It replaces everything in that repository, so use a new, empty one made for the site. |
| `scripts\install.ps1` | Installs a release package, or updates an installed one (what `irm <site>/install.ps1 \| iex` and `portly --update` run): `-Version`, `-ZipPath`, `-PagesUrl`, `-Force`, `-DryRun`. See [releases.md](docs/setup/releases.md). |
| `scripts\build-release.ps1` | Builds `dist-release\portly-<version>-win-x64.zip` and `portly-release.json` (production dependencies, the pinned Node.js runtime). `-NodeExe` and `-AllowDirty` for test builds. |
| `scripts\check-release.ps1` | Builds (or takes `-ZipPath`) a package and checks install, start, update and refusals in a temporary folder. |
| `scripts\publish-release.ps1` | Publishes the built package as a release of this repository with `gh` (`-DryRun`). |
| `scripts\check-scripts.ps1` | Self-checks for the PowerShell scripts (parse in 5.1 and 7, unit checks, dry runs). |
| `node scripts/check-extension.mjs` | The extension's tests (manifest, pages, icons, new-tab and options logic). |
| `node scripts/check-native-host.mjs` | The native host's tests (`native-host/launcher.mjs`: framing, origin and request checks, health check, schtasks mapping, end-to-end through `launcher.cmd`). |
| `node extension/tools/generate-icons.mjs` | Regenerates the extension icons. |

## Configuration

All configuration comes from environment variables (see `server/src/config.ts`):

| Variable             | Default                   | Meaning                                               |
| -------------------- | ------------------------- | ----------------------------------------------------- |
| `PORTLY_PORT`      | `5757`                    | Server port                                           |
| `PORTLY_BIND`      | `127.0.0.1,::1`           | Listener addresses                                    |
| `PORTLY_ORIGIN`    | `http://localhost:<port>` | Public origin (host/origin allowlists derive from it) |
| `PORTLY_DATA_DIR`  | `%LOCALAPPDATA%\Portly` | Database, vault key, logs, backups                    |
| `PORTLY_DEV`       | `0`                       | Dev mode (allows the Vite dev server origin)          |
| `PORTLY_VITE_PORT` | `5173`                    | Vite dev server port                                  |
| `PORTLY_PAGES_URL` | *(unset: off)*            | The Pages site that paired browsers may use Portly from (hybrid mode); `https://`, or `http://` on loopback |
| `PORTLY_LOG_LEVEL` | `info` (`debug` in dev)   | Normal log level: `debug`, `info` or `warn` (Settings → Diagnostics can switch to Verbose for a while) |

Build-time, for `npm run build:static` only: `PORTLY_STATIC_BASE` (URL prefix, default `/`) and
`PORTLY_STATIC_SERVER` (where the site looks for Portly on this PC, default
`http://127.0.0.1:5757`; `off` disables hybrid mode; loopback addresses only).

## Documentation

- [Setup overview and quick start](docs/SETUP.md)
- Accounts: [Google](docs/setup/google.md) · [Outlook.com](docs/setup/microsoft.md) ·
  [Yahoo](docs/setup/yahoo.md) · [CalDAV, IMAP & ICS](docs/setup/caldav-imap.md) ·
  [Todoist](docs/setup/todoist.md)
- [New-tab extension](docs/setup/extension.md) · [Autostart](docs/setup/autostart.md) ·
  [Troubleshooting](docs/setup/troubleshooting.md)
- [Browser-only build on GitHub Pages](docs/setup/static-build.md) ·
  [Pages site with Portly on this PC](docs/setup/pages-local-server.md)
- [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md)

## License

MIT — see [LICENSE](LICENSE).
