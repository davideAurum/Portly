# Portly — Architecture

Portly is a single-user, highly customizable browser home page ("portal to the internet").
v1 runs entirely on one Windows 11 PC: a small Node server on loopback serves the UI and holds all
credentials; a tiny browser extension makes it the New Tab page. The same app also builds as a
browser-only site for GitHub Pages, which can use the server on the PC it runs on once a browser is
paired with it (*hybrid mode*, §16).

This document is the binding contract for implementation. Anything not specified here is the implementer's
choice, provided it respects §4.

**Contents**
- [1. Scope](#1-scope)
- [2. Repository & toolchain](#2-repository--toolchain)
- [3. Runtime](#3-runtime)
- [4. Security model (mandatory)](#4-security-model-mandatory)
- [5. Data model](#5-data-model)
- [6. Server structure](#6-server-structure)
- [7. API contract](#7-api-contract)
- [8. Provider notes](#8-provider-notes-verified-2026-09-25)
- [9. Sync](#9-sync)
- [10. Web app](#10-web-app)
- [11. Extension](#11-extension-chromium-mv3-chrome--edge)
- [12. Autostart (Windows)](#12-autostart-windows)
- [13. Quality bar & test harness](#13-quality-bar--test-harness)
- [14. Build plan (retired)](#14-build-plan--parallel-rules-retired)
- [15. File ownership (retired)](#15-file-ownership-retired)
- [16. Hybrid mode](#16-hybrid-mode-pages-site--portly-on-this-pc)
- [17. Diagnostics](#17-diagnostics)
- [18. Release packages](#18-release-packages-install-without-a-checkout)
- [19. Moving over from Homebase](#19-moving-over-from-homebase-the-name-before-portly)

---

## 1. Scope

**In v1**
- Search bar: multiple configurable engines, keyword switching, URL detection, suggestions, bookmark matches.
- Launch pad: bookmark groups, drag ordering within/across groups, editing, auto-fetched icons,
  import from Chrome/Edge (local profile files) and HTML bookmark exports, and the page you are on added from
  the extension's toolbar button (§11).
- Calendar: **two-way** (create / edit / delete single instances) for Google and Microsoft personal
  (Outlook.com). **Read-only** in v1: CalDAV (Yahoo preset + generic) and ICS/webcal subscriptions
  (covers Proton Calendar share links, Yahoo public ICS links, Outlook published calendars).
- Mail: unread counts + recent inbox messages, mark read/unread, archive (where supported), trash,
  open in webmail — Gmail (API), Outlook.com (Graph), IMAP (Yahoo preset + generic).
- Todoist: tasks by filter, quick add (natural language), complete (with undo), project chips.
- Weather: current / hourly / daily via Open-Meteo.
- RSS feeds: RSS and Atom feeds merged newest first (server only).
- Sports scores: favorite teams' live, upcoming and final games from ESPN's public API.
- Clock / greeting widget.
- Customization: widget grid (add / remove / move / resize, multiple instances per type), per-widget
  settings, global theme, profiles (named layouts, manual switching), config export/import.
- New Tab extension that starts Portly when the browser opens (§11, §12).
- Browser-only build for GitHub Pages with its data in the browser, and hybrid mode, where a paired
  Pages site uses the server on this PC (§16).
- Diagnostics: the health of every connection and sync, logs, and a shareable report (§17).
- Release packages that install and update Portly without a Git checkout (§18).

**Deferred (design must not preclude):** CalDAV writes (v1.1, after testing reads against the user's
Yahoo account), multi-device access (one server used from several PCs, with a login: `docs/design/multi-pc.md`;
satisfied in v1 only by deriving bind address, origin and port from `config.ts` everywhere), a fantasy sports
widget, automatic profile switching (location / network / time), per-profile themes (`profiles.theme` column
reserved), sending mail.

**Not planned:** Proton Mail (any form); Microsoft work/school accounts (the app is registered for
personal Microsoft accounts only and the `/consumers` authority is hard-coded).

---

## 2. Repository & toolchain

```
/package.json          workspaces ["shared","server","web"]; engines {node:">=24 <25", npm:">=11.10"} (§2a)
/.npmrc                ignore-scripts=true, min-release-age=7, engine-strict=true
/package-lock.json     committed; installs use `npm ci`
/.gitattributes        LF everywhere; CRLF for .ps1, .cmd and .bat
/tsconfig.base.json
/vitest.config.ts      test.projects: server (node: server/**, shared/**), web (jsdom: web/src/** except static/),
                       static (node + fake-indexeddb: web/src/static/**)
/shared                @portly/shared — TS contract types + zod schemas; package.json "exports": {".": "./src/index.ts"}
/server                @portly/server — Node 24, Hono, node:sqlite; runs from TS source (no bundle)
/web                   @portly/web — Vite 8 + React 19 + TypeScript; web/src/static/ = the Pages build's in-browser
                       backend (§16)
/extension             Manifest V3 new-tab extension (plain JS, no build; pinned ID via manifest "key")
/native-host           native messaging host com.portly.launcher (launcher.mjs + launcher.cmd template, §12)
/scripts               PowerShell install, start, status, update, release and publish scripts with lib/Common.ps1, and
                       the node test runners check-extension.mjs / check-native-host.mjs (see scripts/README.md)
/site                  static home, privacy and terms pages for the OAuth consent screens
/.github/workflows     ci.yml (§13); release.yml (§18) and static-pages.yml (§16), both run by hand, publish publicly
/docs                  ARCHITECTURE.md, SETUP.md, ROADMAP.md, setup/*.md (user guides), brand/ (the Beacon mark),
                       design/ (proposals not built yet)
```

### 2a. Dependencies (majors pinned)
Dependencies are added or upgraded only on request. If `min-release-age` blocks the newest version of a range,
use the newest version older than 7 days.
- **shared:** `zod@^4` (zod 4: nested object defaults need `.prefault({})`, not `.default({})`; use `z.email()`/`z.url()`).
- **server:** `hono@^4.13` (floor 4.12.16), `@hono/node-server@^2.1`, `undici@^8` (safe-fetch only),
  `ical.js@^2.2`, `tsdav@^2.3`, `imapflow@2.0.x` (exact pin), `node-html-parser@^9`, `entities` (HTML
  entity decoding), `tldts` (eTLD+1).
- **web:** `react@^19`, `react-dom@^19`, `zod@^4`, `@tanstack/react-query@^5`, `@tanstack/react-query-persist-client`,
  `react-grid-layout@^2.2` + `react-resizable` (direct dep, for CSS), `@dnd-kit/core@^6.3`, `@dnd-kit/sortable@^10`,
  `@dnd-kit/utilities`, `radix-ui@^1.6`, `sonner@^2`, `lucide-react`, `date-fns@^4`, `@date-fns/tz@^1`, `entities`
  and `node-html-parser` (the in-browser backend).
- **root dev:** `typescript@~7.0` (only via `tsc --noEmit`; nothing may import the TS API — if TS 7 blocks
  anything, pin `~6.0` instead), `@types/node@^24`, `@types/react`, `@types/react-dom`, `vite@^8`,
  `@vitejs/plugin-react@^6`, `vitest@^5`, `jsdom`, `fake-indexeddb` (static tests), `@testing-library/react`,
  `@testing-library/user-event`, `@testing-library/jest-dom`, `concurrently`.
- **Not used:** tsup, tsx, esbuild bundling of the server, `@types/react-grid-layout`, `@dnd-kit/react`,
  `@tanstack/query-sync-storage-persister` (`app/providers.tsx` has its own `Persister`), web fonts,
  lodash.merge/deepmerge, googleapis / msgraph SDKs (plain fetch), any native module.
- **Node major pinned:** `engines.node` in the root `package.json` is `>=24 <25`, and `engine-strict` makes `npm ci`
  refuse any other major. The server runs its TypeScript through Node's type stripping and the supervisor starts
  it with `--no-warnings` (§3), so a new Node major can change behaviour that only the `process.on('warning')`
  log line would report. Moving to a new major is a deliberate step that changes three places together:
  `engines.node` here, `version` (with its SHA-256) in `scripts/release/node-runtime.json` (§18) and
  `node-version` in `.github/workflows/ci.yml` (§13); `scripts/check-scripts.ps1` fails when they disagree (or
  when `$PortlyNodeMajor` in `scripts/lib/Common.ps1` or `$SetupNodeMajor` in `scripts/setup.ps1`, which is
  self-contained, does).

### 2b. TypeScript
`tsconfig.base.json`: `strict`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`,
`erasableSyntaxOnly`, `isolatedModules`, `skipLibCheck`, `noUncheckedIndexedAccess`.
server/shared: `module: nodenext`, `types: ["node"]`. web: `module: esnext`, `moduleResolution: bundler`,
`types: ["vite/client"]`, `jsx: react-jsx`. Relative imports include the `.ts`/`.tsx` extension. No enums,
namespaces or parameter properties (use `as const` objects). Type-only imports use `import type`.

### 2c. Scripts (root package.json)
- `dev` — `concurrently` of `dev:server` (`node --watch --env-file=server/dev.env server/src/index.ts`; the file
  sets `PORTLY_DEV=1`) and `dev:web` (`vite` in `@portly/web`).
- `build` — builds web to `web/dist` (server needs no build).
- `build:static` — `vite build --mode static` to `web/dist-static`, the browser-only build (§16).
- `preview:static` — `vite preview --mode static` of `web/dist-static`.
- `start` — `node server/src/index.ts` (serves `web/dist`; fails with a clear message and exit code 4 if missing).
- `typecheck` — `tsc --noEmit -p` for shared, server, web and `web/tsconfig.node.json`.
- `test` — `vitest run`, then `test:extension` (`node scripts/check-extension.mjs`), `test:native-host`
  (`node scripts/check-native-host.mjs`) and `npm audit --omit=dev --audit-level=high`.

---

## 3. Runtime

- **Config (`server/src/config.ts`)**, all from env with defaults: `PORTLY_PORT` (5757),
  `PORTLY_BIND` (`127.0.0.1,::1`), `PORTLY_ORIGIN` (`http://localhost:<port>`), `PORTLY_DATA_DIR`
  (`%LOCALAPPDATA%\Portly`), `PORTLY_DEV` (0/1), `PORTLY_VITE_PORT` (5173), `PORTLY_LOG_LEVEL`
  (`debug`|`info`|`warn`; default `info`, `debug` in dev; see Logging). Host allowlist, origin
  checks, OAuth redirect URIs and the app origin used for redirects are **derived from config** — never
  hard-coded. In dev, `appOrigin` = `http://localhost:<VITE_PORT>` and it is added to the host/origin allowlists.
  `PORTLY_PAGES_URL` (unset = hybrid mode off) → `pagesUrl` (path ends with `/`) and `pagesOrigin`: absolute,
  `https:` (or `http:` on `localhost`/`127.0.0.1`/`[::1]`, with a startup warning naming the origin), no credentials,
  query or fragment, not `*`/`null`, and not one of the server's own origins. Kept apart from the origin allowlist
  and never part of `Settings`. `PORTLY_REMOTE_ORIGIN` (unset = other PCs off, §20) → `remoteOrigin` and `remoteHost`:
  a bare `https:` origin (or `http:` on a loopback host, with a startup warning), no credentials, path, query or
  fragment, neither one of the server's own hosts nor the Pages origin; `PORTLY_REMOTE_PORT` (default `<port> + 1`;
  only with the remote origin; must differ from the main and dev ports) → `remotePort` and `remoteHosts` (the remote
  host and the loopback forms of that port). Never part of `allowedHosts`/`allowedOrigins`.
- **Listeners:** one `serve({fetch: app.fetch, hostname, port})` per bind address, on `PORTLY_PORT` and, with a
  remote origin, on `PORTLY_REMOTE_PORT` too (both probed first; the remote listener is loopback like the main one).
  `EADDRINUSE` on any → log and `process.exit(3)` (EXIT_ALREADY_RUNNING). `EADDRNOTAVAIL`/`EAFNOSUPPORT` on `::1` →
  warn, continue IPv4-only.
- **Static:** `serveStatic({root: <absolute path to web/dist>})` computed from `import.meta.dirname`, never cwd.
  An `/api/*` JSON 404 handler is mounted before the SPA fallback. The SPA fallback serves `index.html`
  only for GET requests whose path is not under `/api/` or `/assets/` and has no file extension.
  Hashed `/assets/*` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`.
- **Data dir:** `portly.db`, `vault.key`, `logs/`, `backups/`.
- **Supervisor (`server/src/supervisor.ts`):** spawns `process.execPath --no-warnings server/src/index.ts` with
  `windowsHide: true`, stdin/stdout ignored, **stderr piped** and an IPC channel, and adds `PORTLY_SUPERVISED=1`
  to the child's environment (on a restart also `PORTLY_SUPERVISOR_ATTEMPT` and `PORTLY_SUPERVISOR_LAST_EXIT`
  = JSON `{code, signal, failure?}`, shown in Settings → Diagnostics). A supervised server has no console and writes
  to stderr only for fatal output (bootstrap failure, `startup failed`, uncaught exception), so the supervisor keeps
  the last 40 lines / 16 KB of it, scrubbed, as the crash cause; Node's own warnings stay off stderr
  (`--no-warnings`; the server logs them as `node warning`). A server whose start-up fails first sends IPC
  `{type:'startup-failed', phase, errName, errCode, sqliteCode, message (scrubbed, ≤ 200)}`, kept as that run's
  `lastFailure`. Restarts on exit with backoff 1 s, 2 s, 5 s, 10 s, 30 s, 60 s (cap) and
  `warn 'server exited; restarting' {code, signal, uptimeMs, delayMs, attempt, lastFailure, stderrTail}` (≤ 10
  lines); backoff resets after 10 min uptime; five runs in a row shorter than a minute log
  `error 'server keeps crashing at start-up' {attempts, lastExit, lastFailure, stderrTail}` once per loop. Exit code
  3 (EXIT_ALREADY_RUNNING) → supervisor exits without restarting; exit code 4 (EXIT_PERMANENT_FAILURE: `web/dist`
  missing) three times in a row → `error 'server cannot start; not restarting'` and the supervisor exits with 4.
  Stopping sends `{type:'shutdown'}` over the channel (Windows cannot deliver signals to a child; `kill()`
  terminates it), so the server's own shutdown runs; forced kill after 10 s. It logs JSON Lines to
  `logs/supervisor.log` (records `src: 'supervisor'`; an invalid configuration is written there as one
  `startup failed {phase: 'config'}` line before it exits 1). SQLite `journal_size_limit` keeps the WAL small after
  checkpoints.
- **Program names (`serverProgram` in `supervisor.ts`, §12):** a supervisor running as `portly-supervisor.exe` (the
  task's copy of node.exe) spawns the server as `portly-server.exe` from the same folder instead of
  `process.execPath`, so Task Manager tells them apart. That file is (re)made from the supervisor's own program — a
  hard link, else a copy keeping the modification time — when it is missing or another build (size differs or
  modification times more than 2 s apart), then `info 'made the server program'`. When it cannot be made
  (`warn 'could not make the server program; the server runs as the supervisor program'`) or cannot be spawned at all
  (`warn 'starting the server with the fallback program from now on'`), the server runs as the supervisor's own
  program. Any other program name (plain node.exe, `npm start`, tests) spawns `process.execPath`.
  `supervisor starting`, `server started` and these lines carry `program` (a file name, never a path).
- **Start-up, process, shutdown (`index.ts`, `lib/startup.ts`, `lib/exit-codes.ts`):** phases `config → logger →
  web-dist check → port-probe → legacy (§19) → db → migrate → health → pairing → vault → settings → accounts → modules → listen`,
  each timed (`debug 'startup phase' {phase, ms}`); right after the logger `info 'starting Portly' {version, dev,
  dataDir, port, pid, boot, node, supervised, restart}`, at the end `info 'Portly ready' {url, app, startupMs,
  phases}` (`boot` = a random id per process start, in every report and summary). A timed Verbose
  period saved by Settings → Diagnostics is switched back on right after `migrate`. The port is probed before the
  database and vault are touched; a taken port logs `port already in use — is Portly already running?` and exits 3.
  An invalid configuration (no logger yet) appends one JSON line `startup failed {phase: 'config', errName,
  errMessage}` to `<data dir>/logs/server.log` and writes it to stderr (ConfigError messages echo URL-valued
  variables as their origin only), exit 1. Any later throw, and any uncaught exception or rejection before the
  server runs, logs `error 'startup failed' {phase, …errorFields, stack frames}`, reports it to a supervisor over IPC
  and exits 1 — 4 for `web/dist` missing (`StartupError web_dist_missing`). While running: `console.*` → log lines
  `console {text}` (`log/info/debug` → debug, `warn`, `error`); `process.on('warning')` → `warn 'node warning'`;
  an unhandled rejection → `error 'unhandled promise rejection'`; an uncaught exception → `error 'uncaught
  exception'` and shutdown with exit 1; `info 'status' {uptimeMs, jobs: {<name>: {runs, failures, overdue}},
  health: {ok, degraded, failing, stale, unknown}, requests: {count, s4xx, s5xx} (since start), rssBytes}` every
  6 h and at shutdown. Shutdown (SIGINT/SIGTERM/SIGBREAK or IPC `shutdown`): `shutting down {signal}` → status →
  stop jobs → close listeners → wait ≤ 5 s for job runs and open requests → health flush/close → database →
  `stopped {exitCode, waitedForJobs, openRequests?}` → close the log. Exit codes: 0 clean, 1 start-up failure or
  uncaught exception, 3 already running, 4 cannot start until fixed.
- **Logging (`lib/logger.ts`, `lib/log-context.ts`; Settings → Diagnostics in §17):** one leveled logger per process
  (`debug < info < warn < error`). **File** `logs/server.log` (the supervisor's: `logs/supervisor.log`) in **JSON
  Lines**, one object per record: `{"t","lvl","msg","src"?,"area","tags","rid"?,"tEvent"?,...fields}` (`src`
  omitted for `server`); rotated at 10 MB, 5 kept (`.1`…`.5`; a file another process rotated is reopened, not
  rotated again). **Console** (not under the supervisor): text `<ISO> <LEVEL> <msg> {json}`, warn/error on stderr.
  **Levels:** *Normal* is the boot level `PORTLY_LOG_LEVEL` (`debug`|`info`|`warn`; default `info`, `debug` with
  `PORTLY_DEV`; anything else → *invalid configuration*): state changes, failures with hosts, statuses and
  provider reason codes, one line per health transition. *Verbose* is `debug` for every area or the chosen ones
  (`DIAGNOSTIC_AREAS`, matched against a record's tags), switched on in Settings → Diagnostics for a time (persisted
  in `server_meta`, survives a restart) or until turned off (ends at the next restart).
  - **Log context:** one `AsyncLocalStorage` carries the unit of work — `rid` (request), `job`/`run` (6-character run
    id), `area`, `accountId`, `calendarId`, `feed`, `pairingId`, `op` — merged into every record (call fields >
    child bindings > context). `area` = the module that wrote the line, or the unit of work's area for shared
    infrastructure (`component: fetch|health|scheduler|console|vault|settings|pairing|devices|peer-names`); `tags` = every area the
    record belongs to. Timers that re-arm or outlive the unit of work are created in `outsideLogContext` (scheduler,
    watchdogs, sweeps); shared single-flight bodies set their own context; per-call workers are spawned inside the
    caller's context.
  - **Memory rings** (the `LogHub` Settings → Diagnostics reads), filled whatever the level: `main` = the last 5,000
    info+ records; the **flight recorder** = the last 400 debug records **per area** (≤ 64 areas, so a chatty area
    cannot evict a rare one); `client` = the last 1,000 browser events (§17). *Quiet* requests stay out of the
    rings (see §17, Request line). `lastRecordFor(run)` feeds the job watchdog.
  - **Repeat suppression:** a call with `repeatKey` (and optional `repeatSig`) is written at its level once per
    30-minute window per key and signature; repeats are written at debug with `repeats: n` and the window closes
    with `info 'repeated' {repeatKey, count, since}` (≤ 1,000 keys). Used by GET request lines, outbound
    non-2xx and failures, 5xx error lines, gate refusals, foreign origins and browser events. The repeats of a
    warning or error also carry `repeatOf` (its level) and `repeatSince` (the window's start), and its summary
    `repeatOf`, `repeatMsg` and the first record's `code`: a level filter (memory and files) matches them at the level
    they repeat, and the warning counts of the last hour include them (a closed window through its summary, an open
    one through its count).
  - **Scrubbing** (`shared/src/diagnostics.ts`, shared with the browser): every field value goes through
    `scrubFields` — secret-named keys (`password`, `access_token`, `nextPageToken`, `cookie`, `code` …) →
    `[REDACTED]` whatever the value (a `code` that is an error code such as `ECONNREFUSED` is kept); URL-valued keys
    and absolute URLs → `scheme://host/…`; strings ≤ 2 KB, depth 6, 50 array items, cycles cut; free text goes
    through `scrub` — Bearer/Basic credentials, header dumps, compound secret keys, `token=`/`code=` pairs,
    URL-encoded secrets, URL credentials, Google token and JWT shapes, quoted `JSON.parse` input → `"…"`,
    `webcal(s)://` paths. User paths are masked in every spelling (`C:\Users\~\…`, plus this PC's home directory →
    `~`, matched before the generic rule so a home outside `C:\Users` is never left half-masked); messages ≤ 500
    characters with control and bidi characters escaped, and field strings with the controls, line separators and bidi
    characters JSON leaves raw escaped as `\uXXXX`; caller keys that clash with record
    keys are renamed `f_<key>`. Errors are logged only through `errorFields` (allowlisted: name, code, our status,
    upstream status, machine reason, host, account id, Retry-After, a cause chain `TypeError <- Error[ECONNREFUSED]`
    with its deepest code, SQLite code; scrubbed message ≤ 300; with `{stack}` the frame lines only, never the
    header).
  - **Never logged** (files, rings, reports, browser events, any level): tokens of any kind, passwords, OAuth codes
    and PKCE verifiers, client secrets, pairing tokens and nonces, cookies, Authorization headers, URL credentials;
    request/response bodies and content — mail subjects/senders/bodies, event titles/descriptions/locations, task
    text and filters, bookmark/page/feed titles, search terms, geocode text, coordinates, browser profile names, user
    names typed into forms; full URLs (hosts plus a `purpose` for outbound calls, route patterns and query-less
    paths for our API; ICS URLs never leave the vault). imapflow always `logger: false`.
- **Backups:** daily `VACUUM INTO backups/portly-<YYYY-MM-DD>.db`, keep the last 7; also before import.
- **Orphaned uploads:** daily core job deletes `uploads` rows older than 24 h whose id appears in neither the stored
  settings JSON (appearance background) nor any profile layout/theme JSON.

---

## 4. Security model (mandatory)

### 4.1 Threats and accepted risks
Threats addressed: (a) any website in the browser can send requests to localhost (CSRF, DNS rebinding,
navigation); (b) attacker-controlled content is rendered in a page that can reach every account — email
subjects/senders, calendar text/links, ICS feeds, favicons, fetched titles, imported bookmark/config files;
(c) credentials at rest; (d) hostile remote servers (ICS, CalDAV, favicon hosts) attempting SSRF, resource
exhaustion or credential capture.

**Accepted risks (v1):** everything running as this Windows user, other local Windows accounts, and
installed browser extensions are trusted — the API does not defend against them. The vault protects
secrets at rest against copies of the data dir only. Port squatting on 5757 while Portly is down is
accepted (OAuth codes are PKCE-bound; Google codes also need the client secret). No service worker in the web app
(the extension has one, §11).

**Hybrid mode (§16) adds one trusted origin:** with `PORTLY_PAGES_URL` set, browsers paired on Portly's own page
may call the routes declared `paired()` from that origin. Trust is per **origin**, and `https://<user>.github.io` is
shared by every Pages site of the account: any script on any page of that origin, in a paired browser, can read the
pairing token (localStorage) and the persisted copy of server data, call every paired route, and use the browser's
local-network permission. Accepted for a single user who controls what the origin publishes (that includes
connecting accounts, OAuth client secrets, the vault reset and listing/revoking pairings: there is one page,
connected to the server or not); mitigations: approving a pairing stays local-only (403 `local_only`), secrets stay
write-only, paths that name the Windows user are blanked for it (see §7, `/api/about`), the Pages site never persists
account lists or OAuth client settings, and the consent page says that the whole origin gets access. A custom domain
used only for the site removes the risk (docs/setup/pages-local-server.md). The page in turn treats every answer from
`127.0.0.1:<port>` as untrusted input (it may be a squatter): responses are parsed with the shared schemas, the
reported `appUrl` is only used when it is a loopback root page, and the server's `instanceId` is a guard against using
the wrong server, not authentication — the token is.

**Other PCs (§20) add trusted devices:** with `PORTLY_REMOTE_ORIGIN` set, a PC approved once from Portly's own page
(its device cookie) may call the routes declared `paired()` through the remote port, as a paired browser may. Each
approved PC is fully trusted, like a paired browser: a stolen PC has that access until it is removed in Settings →
Devices (a 30-day idle expiry bounds a forgotten one; a passkey second factor is a later item). Mitigations: nothing
opens a LAN socket (the proxy is the user's own, documented as Tailscale Serve inside the tailnet, never Funnel); what
is decided on this PC stays here (`samePc()` or untagged: approving and removing devices, every pairing route, the OAuth
client settings, the OAuth start, the vault reset, the browser bookmark import, the diagnostics report); a device may
only disconnect itself; paths are blanked for it as for the Pages site; requests on the main port never count as another
PC's and a proxy's forwarding header there is refused. The listener stays loopback-only.

### 4.2 Request gate (global middleware, `app.use('*', …)`, in this order)
1. Reject (400) if the raw request path (the target as received, query and fragment cut off; an absolute-form target
   is reduced to its path) does not start with `/`, or contains `//`, `\`, `%2f`, `%5c` (case-insensitive), `%00` or
   a raw control byte (0x00–0x1f, 0x7f), or a segment that is `.` or `..` once `%2e` is decoded (`%2e`, `%2e%2e`,
   `.%2e`, `%2e.`, in any case). `rawPathProblem` in `server/src/security/gate.ts`; the query string is not inspected.
2. **Host allowlist** (derived from config): `localhost:PORT`, `127.0.0.1:PORT`, `[::1]:PORT`, origin host;
   dev adds `localhost:VITE_PORT`. Otherwise 403. **Remote port** (§20, only with `PORTLY_REMOTE_ORIGIN` and a device
   store): a request that came in on `PORTLY_REMOTE_PORT` is another PC's whatever its Host says (`remoteClient`),
   and its Host must be the remote origin's or a loopback form of that port (else 403); on the main port the remote
   origin's host is just another unknown host, and a local Host that carries a proxy's forwarding header
   (`Forwarded`, `X-Forwarded-*`, `Via`, `X-Real-IP`, `Tailscale-User-*` …) is refused (403 `proxied_local_host`:
   the proxy points at the wrong port, and must never count as this PC's own request).
3. `/api/*` routes are **non-exempt by default**. Exemptions are declared as metadata when the route is
   registered (a helper records `{method, pattern, kind}`; the gate matches with a Hono router instance —
   never string-prefix checks):
   - `health` — `GET /api/health`
   - `image` — `GET /api/icons/:id`, `GET /api/uploads/:id` (accept `Sec-Fetch-Site` `same-origin`/`none`/absent)
   - `oauth-callback` — `GET /api/oauth/:provider/callback`

   Route **access** is metadata too (`lib/routes.ts`): `paired()` marks a route the paired Pages site (hybrid mode)
   and connected devices (other PCs, §20) may call; `samePc()` one the paired Pages site may call but never another
   PC (the vault reset, the browser bookmark import, the OAuth start, the OAuth client settings, every pairing route
   but `POST /api/pairings`, removing a device, the diagnostics report); `enrollment()` one anyone on the remote port may call without a device
   cookie (asking for and polling a device request, and the name the connect screen fills in; the Pages site may
   not). Default deny — untagged routes are
   local-only: `POST /api/pairings`, approving and denying device requests, the OAuth callback and unknown routes.
   `RouteTable.match` **fails closed**: each registration a request matches lets in the callers its tags name, the
   route lets in only the callers every registration agrees on, and that set must be exactly one level's (so a
   paired pattern over an enrollment route closes it). The 503 handlers of failed modules are tagged `paired()`. A
   test pins the access of every registered route (`ROUTE_ACCESS` in `app.test.ts`).

   **Pages branch** (only with `PORTLY_PAGES_URL` and a pairing store): an `/api` request whose `Origin` equals the
   configured `pagesOrigin` exactly skips step 4 and is marked for CORS (refusals included, so the page can read them):
   - preflight (`OPTIONS` + `Access-Control-Request-Method`): method ∈ GET/HEAD/POST/PUT/PATCH/DELETE and every
     requested header ∈ {content-type, x-portly, x-portly-token} → 204, else 403; never passed on;
   - `GET /api/health` passes as for anyone (no token);
   - anything else: route access must be `paired` or `same-pc` (else 403 `local_only`), `X-Portly: 1`, `Sec-Fetch-Site`
     `cross-site`/`same-site`/absent (the exact Origin match is the real check), a pairing token
     (`X-Portly-Token`) that verifies **and** was issued for that origin (else 401 `pairing_required`), and the
     Content-Type rules of step 4 (image routes too: the page fetches images with the token). The pairing's
     last-used time is touched (at most every 10 min).

   Any other `Origin` (or none) goes through step 4 unchanged.

   **Remote branch** (§20; a request on the remote port): `GET /api/health` passes as for anyone; the OAuth callback
   is refused (403 `local_only`); every other request needs an absent-or-remote `Origin` (exactly `remoteOrigin`),
   `Sec-Fetch-Site` absent or `same-origin` (`image` routes also `none`), `X-Portly: 1` (not for `image` routes) and the
   Content-Type of step 4, then the device cookie `__Host-portly_device` that verifies (else 401 `login_required`, with
   the sub-reason logged) and a route a device may call (else 403 `local_only`). `enrollment()` routes need no cookie
   (a stale one is ignored, a valid one still noted). The device's last use is recorded (at most every 10 min) and the
   cookie's lifetime renewed then, unless the route set or cleared the cookie itself or stopped the device. Never
   CORS headers, never preflights.
4. Non-exempt `/api` requests must have: `X-Portly: 1`; `Origin` absent or in the origin allowlist;
   `Sec-Fetch-Site` absent or `same-origin` (reject `same-site`, `cross-site`, `none`); for bodies,
   `Content-Type: application/json`, except routes declared multipart (uploads, imports).
   Apart from the configured Pages origin (step 3), the server **never** sends CORS headers and never answers
   preflights.
5. **Body limits** enforced on streamed bytes (chunked included): JSON 1 MB; uploads/icons 10 MB; import 25 MB.

### 4.3 Response headers
- **All responses:** `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- **HTML:** `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://a.espncdn.com; connect-src 'self'; font-src 'self' data:; frame-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (`htmlCsp()` in
  `security/headers.ts`). With `PORTLY_PAGES_URL` set, `connect-src` is `'self' <pagesOrigin>`: the server's page checks
  that the Pages site answers before it forwards there (§16). **Invariant:** `script-src` never gains
  `'unsafe-inline'` or `'unsafe-eval'`. Consequence: all third-party traffic goes through the server, except the
  sports widget's team logos (`<img>` from ESPN's image host; the mappers accept no other logo host).
- **Static build** (`staticCsp()` in `web/vite.config.ts`): a `<meta http-equiv>` CSP added at build time, because
  static hosts send no headers. It matches the HTML CSP except: `img-src` also allows `https://icons.duckduckgo.com`
  (favicons as `<img>`); `connect-src` is `'self'` plus the hosts the in-browser backend calls directly,
  `https://api.open-meteo.com`, `https://geocoding-api.open-meteo.com`, `https://nominatim.openstreetmap.org`,
  `https://api.todoist.com`, `https://api.github.com` (launch pad sync through a private repository,
  docs/design/launchpad-sync-github.md; one of the two sync connections, design/launchpad-sync.md 6.10; the repository and token are kept
  like the Todoist token, in the never-exported `github-sync` slice),
  `https://en.wikipedia.org` (suggestions), `https://site.api.espn.com`, `https://login.microsoftonline.com` and
  `https://graph.microsoft.com` (Outlook.com sign-in and calendar, and launch pad sync's OneDrive metadata and
  uploads), `https://my.microsoftpersonalcontent.com` (launch pad sync's OneDrive downloads: the only download host
  seen for a personal account; [design](design/launchpad-sync.md) section 4), and in hybrid mode the local server origin
  (`PORTLY_STATIC_SERVER`, §16); there is no `frame-ancestors` (a meta tag cannot set it). The `script-src` invariant
  applies here too.
- **`/api` JSON:** `Cache-Control: no-store`.
- **`/api/icons/:id`, `/api/uploads/:id`:** `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`,
  `Cache-Control: private, max-age=86400`. IDs are random UUIDv4. Stored content type comes from magic-byte
  sniffing (png, gif, jpeg, webp, avif, ico, bmp; svg only if the root element is `<svg`), never from headers.
- **CORS (hybrid mode only):** any `Access-Control-*` header a handler sets is stripped. Answers to requests the gate
  marked as Pages requests get `Access-Control-Allow-Origin: <pagesOrigin>` (from config, never echoed),
  `Access-Control-Expose-Headers: Retry-After, Content-Disposition, X-Request-Id` (§17); preflights also `Access-Control-Allow-Methods`
  (the requested one), `Access-Control-Allow-Headers: Content-Type, X-Portly, X-Portly-Token`,
  `Access-Control-Max-Age: 600`, `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers` and
  `Access-Control-Allow-Private-Network: true` only when requested. **Never** `Access-Control-Allow-Credentials`
  (the page authenticates with its token; cookies are never involved). With a Pages URL configured every `/api`
  answer carries `Vary: Origin`. CORP/COOP stay `same-origin` (CORP does not apply to CORS-mode fetches).

### 4.4 URL & text policy
- `SafeHttpUrl` (shared zod): `new URL` parses; scheme `http:`/`https:`; no username/password; ≤ 2048 chars.
  Enforced server-side on: bookmark create/update/import (non-http(s) entries skipped and counted in the
  import report), search-engine templates (must contain `%s`; substitution uses `encodeURIComponent`),
  `events.html_url`, `events.meeting_url`, location links, mail `webUrl` (additionally host-allowlisted:
  `mail.google.com`, `outlook.live.com`, `mail.yahoo.com`, or the IMAP account's configured `webmailUrl`).
  Values that fail are stored as null and not rendered as links.
- Web: one `safeHref()` helper (`web/src/lib/openUrl.ts`) used by every `<a href>`, `window.open`,
  `location.assign`. External links: `target="_blank" rel="noopener noreferrer"` (unless the user's
  "open links in same tab" preference applies to launch pad/search).
- `#/add-bookmark?url=&title=` (§10.1, §11) comes from outside the page, so both values are hostile.
  `parseAddBookmarkRequest` (`widgets/launchpad/addRequest.ts`) accepts only an `http:`/`https:` URL of at most 2048
  characters without a username or password, and a title with whitespace collapsed, cut to 300 characters. The request
  only fills in the Add bookmark dialog; saving goes through the bookmark create schema (SafeHttpUrl) like any other
  bookmark. The extension applies the same checks before it passes the hash on.
- **No** `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `DOMParser`, `document.write`.
- Text: Gmail snippets decoded server-side with `entities` `decodeHTML` (never the DOM). Google/Graph HTML
  (and ICS/CalDAV HTML) event descriptions converted to plain text at ingest with the linear-time tag scanner
  (`server/src/lib/html-scan.ts`) — untrusted HTML is never handed whole to a tree-building parser, and no regex
  over untrusted text may backtrack super-linearly. UI linkifies only SafeHttpUrl matches as React
  elements. Length caps at ingest: subject 500, snippet 500, event title 500, description 8 KB.

### 4.5 Theme safety
Theme values are strict zod (see §7a `Theme`): colors match `^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$`; background
is a discriminated union (color | gradient with bounded stops | image by `uploadId` UUID — the URL is always
built as `/api/uploads/${uploadId}`); fonts are an enum of system stacks; numbers bounded. Applied only via
`document.documentElement.style.setProperty(name, value)` for a fixed list of variable names — never by
building CSS text. The only other URL a backdrop can carry is the page's own baked copy of the photo, a `blob:`
URL from `URL.createObjectURL` (anything else passed as one is ignored); `img-src` already allows `blob:`. Provider/user colors (calendars, groups, accounts) are normalized with the same regex at
ingest; invalid → null.

### 4.6 Vault (`server/src/security/vault.ts`)
- Master key: `crypto.randomBytes(32)`. On Windows it is protected with DPAPI (CurrentUser) by spawning
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` **by absolute path** with
  `-NoProfile -NonInteractive -EncodedCommand <script>` and `windowsHide: true`. The script contains no
  secrets; it runs `Add-Type -AssemblyName System.Security`, reads base64 from `[Console]::In.ReadToEnd()`,
  calls `ProtectedData.Protect/Unprotect(..., CurrentUser)`, writes base64 to stdout, exits non-zero on error.
  Key bytes travel only over stdin/stdout. Non-Windows: raw key file, mode 0600.
- `vault.key` written atomically (temp + rename) as `{"v":1,"alg":"dpapi-cu","blob":"..."}`.
- Secrets: AES-256-GCM, fresh `randomBytes(12)` IV per encryption, AAD = `${secretId}|v${keyVersion}`,
  decipher with `{authTagLength: 16}` and reject other tag lengths. `PRAGMA secure_delete=ON`.
- API: `vault.state` (`'ready'|'locked'`), `get(id)`, `put(id, value)`, `delete(id)`. The key never leaves the module.
- Startup: (a) no key file and no secrets → create key + canary secret. (b) key missing while secrets
  exist, or DPAPI/parse/canary-decrypt fails → **never regenerate automatically**: rename the file to
  `vault.key.unreadable-<ts>`, enter `locked`. Locked: non-secret features work, `GET /api/health` reports
  `vault:'locked'`, accounts/Todoist report `reauth`, Settings shows a banner with **Reset credentials**
  → `POST /api/vault/reset` (confirm) deletes all secrets and creates a new key.
- Secret ids: `account:<accountId>` (JSON `{refreshToken}` or `{password}`), `todoist:token`,
  `oauth-client:<provider>` (client secret), `ics:<calendarId>` (full feed URL), `canary`.
- **Secrets are never returned to the client** (APIs return `{configured: true}` / host-only displays).

### 4.7 OAuth (Google, Microsoft) — owned by the accounts module
- `POST /api/oauth/:provider/start {accountId?, returnTo?, capabilities?}` (non-exempt) → `{authorizeUrl}`; the SPA
  does `location.assign(authorizeUrl)` in the same tab (never a popup). `returnTo` must match `^#/[a-z0-9/_-]*$`
  (default `#/settings/accounts`).
- **Scopes follow the services picked (incremental consent).** Each provider spec has `baseScopes` (identity; Microsoft
  also `offline_access User.Read`) and `capabilityScopes` (Google calendar: `calendar.events` +
  `calendar.calendarlist.readonly`, mail: `gmail.modify`; Microsoft calendar: `Calendars.ReadWrite`, mail:
  `Mail.ReadWrite`); its keys are the services it offers (`OAUTH_PROVIDER_CAPABILITIES` in shared). `capabilities` (a
  non-empty list of known capabilities) is checked against them (422 `validation_failed`, path `capabilities`). A new
  connection asks for the services named, or all offered when the field is absent (the behaviour before the field
  existed); a reconnect (`accountId`) asks for the account's granted capabilities plus the ones named. The authorize
  request carries `scopesFor(services)`: base scopes, then each service's, in capability order. Google keeps
  `include_granted_scopes=true` (a new grant includes the earlier ones); Microsoft gets the union explicitly.
- `oauth_states`: random 32-byte base64url `state`, PKCE S256 `code_verifier`, `account_id`, `return_to`, the requested
  `capabilities` (JSON; `005_oauth_state_capabilities.sql`, NULL on older rows = all offered), `expires_at` (+10 min).
  At most 20 pending (oldest deleted); expired rows purged hourly.
- Callback reads only `code`, `state`, `error`. It consumes state atomically:
  `DELETE FROM oauth_states WHERE state=? AND provider=? AND expires_at>? RETURNING code_verifier, account_id, return_to, capabilities`
  before any token exchange; always responds `302` to `${appOrigin}/?oauth=<result>${returnTo}` with
  `Cache-Control: no-store`, never reflecting provider text. `result` ∈
  `connected|reconnected|different_account|denied|expired|error`.
- Identity: claims from the token endpoint's `id_token` (Google `sub`, `email`; Microsoft `oid`,
  `email`/`preferred_username`, and **require** `tid == 9188040d-6c67-4c5b-b112-36a304b66dad`).
  Upsert by `(kind, external_id)`. A reconnect for `accountId` whose subject differs creates a new
  account (`different_account`) and never overwrites the original.
- Granted scopes recorded in `accounts.granted_scopes`; capabilities derived from them (Google: calendar
  if `calendar.events` granted, mail if `gmail.modify` granted; Microsoft: `Calendars.ReadWrite`, `Mail.ReadWrite`; a
  Microsoft token response without `scope` covers the requested scopes). The code is redeemed with the requested scopes
  (Microsoft repeats `scope` at the token endpoint). Only requested services start enabled: a provider may also return
  services granted to this client earlier, which are listed in `capabilities` but stay off in `enabled_capabilities`.
  On an existing account a newly granted service starts enabled only if it was requested, and services the user
  switched off stay off. A new connection whose grant covers none of the requested services → `denied` (nothing
  stored). Switching a service off is `PATCH enabledCapabilities` only; nothing is revoked at the provider.
- Refresh requests (Microsoft) ask for `scopesFor(account.capabilities)`: Microsoft refuses a refresh for more scopes
  than were consented to.
- The in-browser backend (`web/src/static/handlers/accounts.ts`, `static/providers/microsoftAuth.ts`) applies the same
  rules to its Microsoft sign-in, with the calendar as the only service it offers (`capabilities: ['mail']` → 422); its
  pending sign-ins keep the requested services in the `oauth-states` slice.
- `DELETE /api/accounts/:id`: deletes the account, its secrets and (cascade) calendars/events in one
  transaction; Google tokens revoked best-effort via `https://oauth2.googleapis.com/revoke`.
- `AccountService.getAccessToken` is single-flight per account (in-memory `Map<id, Promise>`); access
  tokens live **only in memory**; refresh 5 min before expiry; rotated refresh tokens are persisted
  before resolving; on `invalid_grant` set `reauth` only if the refresh token used is still the stored
  one; network/5xx → `status='error'` (no reauth).

### 4.8 Outbound fetch (`server/src/security/safe-fetch.ts`)
`safeFetch(url, {method?, headers?, body?, policy, timeoutMs = 10000, maxBytes?, as: 'json'|'text'|'bytes', redirect?})
→ Promise<{status, headers, url, data}>`.
- `policy: 'provider'` — fixed vendor endpoints (Google, Graph, Todoist, Open-Meteo, suggestion providers,
  DuckDuckGo/Google favicon services). Uses global fetch; timeouts + size caps only.
- `policy: 'public'` — untrusted/discovered URLs (bookmark pages, icon & manifest hrefs, site-meta, ICS feeds).
  Uses `fetch` **and** `Agent` imported from the pinned `undici` package (never mixed with global fetch) with
  `new Agent({connect: {lookup: guardedLookup}})`. `guardedLookup` does `dns.lookup(host, {all: true})` and
  fails if **any** address is in the deny `net.BlockList`: 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16,
  172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, ::/128, ::1/128, ::ffff:0:0/96 (check the
  embedded IPv4), 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8. IP-literal hostnames (incl. decimal/octal forms
  as normalized by `new URL`, bracketed IPv6) are checked before dispatch. `redirect: 'manual'`; follow ≤ 5
  hops manually, re-validating scheme (http/https), host and port each hop; never forward
  `Authorization`/`Cookie` across origins. Never use env proxies.
- `policy: 'user-server'` — user-entered CalDAV endpoints: private addresses allowed; timeouts + caps; manual
  redirects restricted to the account's `credentialOrigins` (§8). Plain `http` targets (insecureLan) must be, or
  resolve only to, private addresses on **every** connection (a LAN-only lookup guard; IP literals checked per hop),
  so a name that later resolves publicly never receives the Basic credentials in cleartext.
- Size caps count **decoded** bytes while streaming and abort past the cap (never trust Content-Length):
  HTML 2 MB, image 1 MB, ICS 10 MB, JSON 5 MB. Honest `User-Agent: Portly/<version> (personal dashboard)`.
- `data:` icon hrefs are decoded locally, sniffed and size-capped. The DuckDuckGo/Google favicon fallbacks
  are skipped for IP-literal, single-label, `.local`, `.lan`, `.home.arpa`, `.internal` hosts.

### 4.9 Untrusted calendar data limits
- ICS/CalDAV parse + recurrence expansion runs in a `worker_threads` worker with
  `resourceLimits: {maxOldGenerationSizeMb: 256}` and a 5 s wall-clock timeout (worker terminated on expiry).
- Per event ≤ 1,000 instances in the window and ≤ 50,000 iterator steps; per feed/collection ≤ 5,000 VEVENTs
  and ≤ 20,000 instances. `FREQ=SECONDLY/MINUTELY` are not expanded (first instance only, `recurring=1`).
- A **per-event** limit truncates that event (its first instances in the window are kept; SECONDLY/MINUTELY count
  too) and records the non-fatal `last_error` `Warning: Some repeating events were shortened…` — the calendar is not
  failed and the UI shows it as a warning. A **feed** limit (VEVENTs, total instances) or a worker failure/timeout/OOM
  keeps the previous cached rows and sets `calendars.last_error` (an error).
- CalDAV XML containing `<!DOCTYPE` is rejected. tsdav's multistatus parsing (xml-js) also runs in a worker
  (same heap limit and 5 s timeout, nesting depth ≤ 256 checked first); PROPFIND answers are capped at 1 MB, REPORT
  answers at the ICS cap.
- Bytes, not only counts: per job the instances' text (title, location, description, links) is budgeted at 8 M chars —
  past it descriptions are left out (non-fatal warning), past twice that the job fails. Across all calendars and
  feeds the events cache holds at most 100,000 rows / 64 M chars of text; a listing that would pass that changes
  nothing and records an error. Unchanged rows are not rewritten on sync.
- Long-running DAILY/WEEKLY series (no COUNT/BYSETPOS/RDATE, BYDAY only when it includes DTSTART's weekday) are
  iterated from an occurrence aligned to DTSTART + k×INTERVAL shortly before the window (same results, far fewer
  steps). `wallToUtcMs` resolves times in a DST gap with the pre-gap offset (moved forward) in every zone.

### 4.10 Mail action safety
- IMAP message id = base64url(`${mailbox}\n${uidValidity}\n${uid}`). Every action SELECTs the mailbox and
  compares UIDVALIDITY; mismatch → 409 `conflict` (`stale_message`) and the UI refreshes. UID commands only.
  Trash = `UID MOVE` to the RFC 6154 `\Trash` special-use mailbox (fallback exact names: Trash, Deleted Items,
  Deleted Messages, Bin); Archive = `\Archive` (fallback: Archive). Without MOVE: `UID COPY` + `UID STORE
  +FLAGS (\Deleted)` + `UID EXPUNGE` only if UIDPLUS is advertised; otherwise refuse. Never plain EXPUNGE;
  never `\Deleted` without a successful copy. Unresolvable target → 422; UI hides the action.
- Graph: `Prefer: IdType="ImmutableId"` on list and actions. Gmail: `messages.modify` and `messages.trash`
  only — never `delete`/`batchDelete`.
- Actions accept only message ids the server listed for that account (short-lived in-memory allowlist).

---

## 5. Data model

The v1 tables are in `server/src/db/migrations/001_init.sql`; later migrations are listed after them.
Conventions: every `*_at` column is INTEGER epoch ms; booleans INT 0/1; JSON columns TEXT validated with zod
on read; SQL uses single-quoted literals and prepared statements only; PATCH handlers map fields to columns
through static allowlists (never interpolate request keys). Migrations (`NNN_name.sql`, from
`server/src/db/migrations/` and any `server/src/modules/<name>/migrations/`) are applied in filename order inside
a transaction and tracked in `schema_migrations(name TEXT PK, applied_at)`. A number is used once across all
folders (a duplicate fails start-up); a new migration takes the next free number.

```sql
settings(namespace TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
         layout TEXT NOT NULL, theme TEXT NULL /* reserved */, created_at INTEGER, updated_at INTEGER)
bookmark_groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, color TEXT NULL,
         collapsed INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)
bookmarks(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES bookmark_groups(id) ON DELETE CASCADE,
         title TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
         icon_mode TEXT NOT NULL DEFAULT 'auto' CHECK (icon_mode IN ('auto','custom','letter')),
         icon_id TEXT NULL, letter_color TEXT NULL, created_at INTEGER, updated_at INTEGER)
         -- INDEX (group_id, sort)
icons(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('favicon','upload')), source_host TEXT NULL,
         content_type TEXT NOT NULL, bytes BLOB NOT NULL, width INTEGER NULL, fetched_at INTEGER NOT NULL)
uploads(id TEXT PRIMARY KEY, content_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL)
secrets(id TEXT PRIMARY KEY, key_version INTEGER NOT NULL DEFAULT 1, alg TEXT NOT NULL DEFAULT 'aes-256-gcm',
         iv BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL)
oauth_clients(provider TEXT PRIMARY KEY, client_id TEXT NOT NULL, has_secret INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL)
oauth_states(state TEXT PRIMARY KEY, provider TEXT NOT NULL, code_verifier TEXT NOT NULL, account_id TEXT NULL,
         return_to TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
         capabilities TEXT NULL /* 005: JSON list of the services the sign-in asked for */)
accounts(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('google','microsoft','yahoo','caldav','imap')),
         label TEXT NOT NULL, email TEXT NULL, external_id TEXT NULL, config TEXT NOT NULL DEFAULT '{}',
         capabilities TEXT NOT NULL DEFAULT '[]', enabled_capabilities TEXT NOT NULL DEFAULT '[]',
         granted_scopes TEXT NULL, color TEXT NULL, sort INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','reauth')), status_message TEXT NULL,
         created_at INTEGER, updated_at INTEGER, UNIQUE (kind, external_id))
calendars(id TEXT PRIMARY KEY, account_id TEXT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         source TEXT NOT NULL CHECK (source IN ('google','microsoft','caldav','ics')), remote_id TEXT NOT NULL,
         name TEXT NOT NULL, color TEXT NULL, color_override TEXT NULL,
         provider_writable INTEGER NOT NULL DEFAULT 0, user_read_only INTEGER NOT NULL DEFAULT 0,
         visible INTEGER NOT NULL DEFAULT 1, is_primary INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
         display_url TEXT NULL /* host-only display for ICS; full URL is vault secret ics:<id> */,
         collection_url TEXT NULL /* CalDAV collection href */, sync_state TEXT NULL,
         last_synced_at INTEGER NULL, last_error TEXT NULL, UNIQUE (account_id, remote_id))
events(id TEXT PRIMARY KEY /* `${calendarId}:${sha1(remoteId + '|' + (instanceKey ?? ''))}` */,
         calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, remote_id TEXT NOT NULL,
         instance_key TEXT NULL, etag TEXT NULL, title TEXT NOT NULL, location TEXT NULL, description TEXT NULL,
         start TEXT NOT NULL, "end" TEXT NOT NULL, all_day INTEGER NOT NULL, timezone TEXT NULL, status TEXT NULL,
         recurring INTEGER NOT NULL DEFAULT 0, series_id TEXT NULL, html_url TEXT NULL, meeting_url TEXT NULL,
         editable INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)
         -- INDEX (calendar_id, start); INDEX (all_day, start, "end")
cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)   -- non-sensitive only (weather, suggestions)
```
Times in `events`: timed events are ISO-8601 UTC (`...Z`); all-day events are `YYYY-MM-DD` (end exclusive).
Mail content is **never** persisted (in-memory LRU only).

`002_pairing.sql` (hybrid mode, §16):
```sql
pairings(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE /* SHA-256 hex; the token itself is never stored */,
         label TEXT NOT NULL /* "<Browser> on <OS>" */, origin TEXT NOT NULL /* the Pages origin it was made for */,
         created_at INTEGER NOT NULL, last_used_at INTEGER)
server_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- 'instance_id': random 16 bytes base64url, created once
```
`server_meta` also holds `pairing.tombstones` (§17), `diagnostics.verbose` and `diagnostics.verbose.untilOff` (§17).

`006_devices.sql` (other PCs, §20):
```sql
devices(id TEXT PRIMARY KEY, label TEXT NOT NULL /* the name the PC gave itself */, secret_hash TEXT NOT NULL UNIQUE
        /* SHA-256 hex of the device cookie; never the cookie */, browser TEXT NOT NULL /* "<Browser> on <OS>" */,
        created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER /* kept 30 days: the gate then says
        "revoked", not "unknown" */, revoked_by TEXT /* revoked | expired | evicted | disconnected */)
device_requests(id TEXT PRIMARY KEY, code TEXT NOT NULL /* K7Q-4MP: for comparing by eye */, secret_hash TEXT NOT NULL
        UNIQUE /* of the enrollment cookie */, label TEXT NOT NULL, browser TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL /* created + 10 min */, status TEXT NOT NULL /* pending | approved | denied |
        claimed */, device_id TEXT /* the device a claimed request became */)
```

`003_diagnostics.sql` (§17): `diag_health` (one row per health subject) and `diag_outcomes` (its outcome history).
Machine-local: never exported or imported.

`004_beacon_defaults.sql`: no schema change. Moves an `appearance` settings row that still holds the pre-Beacon
defaults (accent `#2563eb`; the `#1e3a8a` to `#6d28d9` gradient at 160 degrees) to the Beacon ones, matching colors
case-insensitively; anything the user chose is kept. Mirrors `upgradeLegacyThemeDefaults()` in `shared/src/theme.ts`;
the browser-only build runs the same upgrade once from its settings `ready()` (marker in the `upgrades` slice).

`005_oauth_state_capabilities.sql`: `ALTER TABLE oauth_states ADD COLUMN capabilities TEXT NULL`, the services a
pending sign-in asked for (§4.7). NULL (a sign-in started before the upgrade) means every service the provider offers.

---

## 6. Server structure

```
server/src/
  index.ts               bootstrap: the start-up phases of §3
  supervisor.ts          autostart supervisor (§3)
  config.ts  app.ts  context.ts
  db/{open,migrate,helpers}.ts, db/migrations/{001_init,002_pairing,003_diagnostics,004_beacon_defaults,
       005_oauth_state_capabilities,006_devices}.sql
  security/{gate,headers,vault,safe-fetch,private-address,dpapi,pairing,foreign-origins,devices,cookies}.ts
  lib/{logger,log-context,health,inflight,provider-errors,exit-codes,startup,ids,errors,cache,scheduler,validate,
       settings,routes,backups,html-scan,image-sniff,ipc,legacy-homebase,merge-patch,multipart,safe-json,user-agent,
       peer-names}.ts
  testing/{test-context,test-request,test-devices,fake-fetch,fake-accounts}.ts
  modules/index.ts       static list of all modules (`MODULES`); each register() wrapped in try/catch — a failing
                         module is logged and its route prefix returns 503 `module_unavailable`
  modules/{core,accounts,bookmarks,search,weather,todoist,calendar,mail,feeds,sports,pairing,devices,diagnostics}/index.ts
```

Each module exports `register(app: Hono<AppEnv>, ctx: AppContext): void`. `lib/routes.ts` provides
`exempt(kind)`, `multipart(kind)` and `paired()` route metadata helpers used by the gate (§4.2).
`ctx.pairing` (`security/pairing.ts`, built after migrations in `index.ts` and `testing/test-context.ts`) is the
pairing store: `instanceId()`, `create({label, origin})` → `{token, record}` (32 random bytes base64url; at
`MAX_PAIRINGS` = 20 the least recently used goes first; never-used pairings older than 24 h are purged on create and
list), `verify(token)` (format check, then an in-memory hash map), `touch(id)`, `list()`, `revoke(id)`,
`revokeByToken(token)`.

```ts
interface AppContext {
  config: Config;
  db: Db;               // run/get/all/exec + tx(fn) (BEGIN IMMEDIATE/COMMIT/ROLLBACK); rows → plain objects
  vault: Vault;         // §4.6
  log: Logger;
  fetch: SafeFetch;     // §4.8
  cache: Cache;         // get<T>(k), set(k, v, ttlMs), getOrSet<T>(k, ttlMs, fn), delPrefix(p) — SQLite `cache`
                        // table, non-sensitive data only; keys '<module>:...'
  memo: MemoryCache;    // same API, in-memory LRU (sensitive data, e.g. mail lists)
  scheduler: Scheduler; // every(name, intervalMs, fn, {initialDelayMs?}) → {reschedule(ms), runNow(), stop()};
                        // no overlapping runs; each run records `job:<name>` health (§17); names '<module>:...';
                        // trigger(name), jobs() (stats), idle(ms)
  settings: SettingsService; // get<K extends keyof Settings>(ns: K): Settings[K]; onChange(ns, cb)
  accounts: AccountService;
  pairing: PairingStore; // hybrid mode, §16
  devices: DeviceStore;  // other PCs, §20
  peerNames: PeerNames; // the name to suggest for a PC that asks to connect (lib/peer-names.ts, §20)
  logs: LogHub;         // the logger's rings, level switch and queries (§3, §17; in production the same object as `log`)
  health: HealthRecorder; // §17
  runtime: RuntimeInfo; // boot id, start time, supervised + restart, in-flight requests, module status (§17)
}

interface AccountService {
  list(f?: {kind?: AccountKind; capability?: Capability}): Account[];
  get(id: string): Account | null;
  getConfig<K extends AccountKind>(id: string): AccountConfigByKind[K];
  getAccessToken(id: string): Promise<string>;           // google|microsoft; §4.7 semantics;
                                                          // throws HttpError(409,'reauth_required',{accountId})
  withToken<T>(id: string, fn: (token: string) => Promise<T>): Promise<T>; // on provider 401: force refresh once, retry once
  getSecret(id: string): Promise<{password: string}>;    // app-password accounts
  setStatus(id: string, status: 'ok'|'error'|'reauth', message?: string,
            meta?: {reason?: string; source?: string}): void;   // reason = health code of `account:<id>` (§17)
  registerProbe(capability: Capability, kinds: AccountKind[],
                probe: (draft: AccountDraft) => Promise<{configPatch?: Record<string, unknown>}>): void;
  onChange(cb: (e: {type: 'created'|'updated'|'deleted'; accountId: string}) => void): void;
}
```
Probes: calendar registers the CalDAV probe for `yahoo`/`caldav`; mail registers the IMAP probe for
`yahoo`/`imap`. Account creation runs the probes for the kind; capabilities = passing probes; if none pass
→ 422 with per-capability errors. With no probe registered, save with `status_message: 'not verified'`.

Errors: `throw new HttpError(status, code, message, details?)` → `{error: {code, message, details?, accountId?}}`.

---

## 7. API contract

All JSON, camelCase. Non-exempt routes require the §4.2 gate. IDs in paths are always `encodeURIComponent`-ed by clients.

**Core** — `GET /api/health` → `{ok, version, vault: 'ready'|'locked', app: 'portly', apiVersion, instanceId,
appUrl: '<appOrigin>/', pagesUrl: <PORTLY_PAGES_URL>|null}` (the last five optional in the schema: older servers lack
them; the new-tab extension follows `pagesUrl`, §11) · `GET /api/settings` → full `Settings`
(defaults applied) · `PATCH /api/settings` — RFC 7396 JSON Merge Patch applied to a `structuredClone`; objects
merge, arrays replace, `null` resets the key to its default; any `__proto__`/`constructor`/`prototype` key at
any depth → 400; result validated with `SettingsSchema.parse`; returns full `Settings` ·
`GET|POST /api/profiles` · `PATCH|DELETE /api/profiles/:id` (name/sort) · `POST /api/profiles/:id/activate` ·
`PUT /api/profiles/:id/positions {items:[{id,x,y,w,h}]}` · `POST /api/profiles/:id/widgets {type, config?, frame?}` ·
`PATCH /api/profiles/:id/widgets/:instanceId {config?, frame?}` · `DELETE /api/profiles/:id/widgets/:instanceId` ·
`POST /api/uploads` (multipart image) → `{id, url}` · `GET /api/uploads/:id` ·
`GET /api/export` → export file · `POST /api/import/preview` (multipart, ≤ 25 MB) → `{previewId, summary}` ·
`POST /api/import/commit {previewId}` · `POST /api/vault/reset` · `GET /api/about` → `{version, dataDir, logPath, vault}`
(`dataDir` and `logPath` are `''` for a paired Pages request: they contain the Windows user name; the diagnostics
summary blanks its directories the same way, §17).

Export file: `{format:'portly-export', version:1, exportedAt, data:{settings, profiles, bookmarkGroups,
bookmarks, uploads[base64], customIcons[base64]}}` built by an explicit per-entity allowlist serializer.
Excluded: accounts, secrets, oauth_*, the Todoist token, calendars/ICS URLs, events, cache, fetched favicons.
Import preview validates with a strict versioned `ExportSchema` reusing the create/update schemas
(SafeHttpUrl, Theme), regenerates all IDs, caps counts (≤ 50 profiles, ≤ 200 groups, ≤ 5,000 bookmarks,
≤ 50 widgets/profile), drops unknown widget types, and returns a summary (counts, search-engine names+hosts,
dropped items). Commit backs up (`VACUUM INTO backups/pre-import-<ts>.db`) then replaces the included
tables in one transaction.

**Bookmarks** — `GET /api/bookmarks` → `{groups: BookmarkGroup[]}` (with bookmarks) · `POST /api/bookmark-groups` ·
`PATCH|DELETE /api/bookmark-groups/:id` · `POST /api/bookmark-groups/reorder {ids}` · `POST /api/bookmarks` ·
`PATCH|DELETE /api/bookmarks/:id` · `POST /api/bookmarks/:id/move {groupId, index}` (atomic) ·
`GET /api/icons/:id` · `POST /api/bookmarks/:id/refresh-icon` · `POST /api/bookmarks/:id/icon` (multipart upload) ·
`GET /api/site-meta?url=` → `{title, iconId|null}` · `GET /api/bookmarks/import/sources` →
`[{id, browser:'chrome'|'edge', profileName, bookmarkCount}]` (opaque ids; server scans only
`%LOCALAPPDATA%\Google\Chrome\User Data\*\Bookmarks` and `%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Bookmarks`) ·
`POST /api/bookmarks/import/browser {sourceId, targetGroupStrategy:'folders'|'single'}` (server re-resolves the
path, `fs.realpath`, checks it is under those roots, caps 20 MB, validates JSON) ·
`POST /api/bookmarks/import/html` (multipart Netscape bookmark file, ≤ 25 MB) → import report `{groups, bookmarks, skipped}`.

**Search** — `GET /api/search/suggest?provider=&q=` → `string[]` (≤ 8).

**Weather** — `GET /api/weather?lat=&lon=` → `WeatherReport` (units from settings) · `GET /api/weather/geocode?q=` → `GeoPlace[]` ·
`GET /api/weather/place?lat=&lon=` → `GeoPlace | null` (the name of the place there, at those rounded coordinates; `null` when
nothing is there).

**Todoist** — `GET /api/todoist/token` → `{configured}` · `PUT /api/todoist/token {token}` (validated upstream first) ·
`DELETE /api/todoist/token` · `GET /api/todoist/tasks?filter=` · `POST /api/todoist/tasks {text}` (quick add) ·
`POST /api/todoist/tasks/:id/close` · `POST /api/todoist/tasks/:id/reopen` · `PATCH /api/todoist/tasks/:id` ·
`GET /api/todoist/projects`.

**Accounts** — `GET /api/accounts` · `PATCH /api/accounts/:id {label?, color?, enabledCapabilities?, sort?}` ·
`DELETE /api/accounts/:id` · `POST /api/accounts/:id/test` · `GET /api/oauth-clients/:provider` →
`{clientId|null, hasSecret, redirectUri}` · `PUT /api/oauth-clients/:provider {clientId, clientSecret?}` ·
`POST /api/oauth/:provider/start {accountId?, returnTo?, capabilities?}` → `{authorizeUrl}` (§4.7) · `GET /api/oauth/:provider/callback` ·
`POST /api/accounts/yahoo {email, appPassword}` · `POST /api/accounts/caldav {label, serverUrl, username, password, insecureLan?}` ·
`POST /api/accounts/imap {label, host, port, security:'tls'|'starttls', username, password, webmailUrl?}`.

**Calendar** — `GET /api/calendar/calendars` · `PATCH /api/calendar/calendars/:id {visible?, colorOverride?, userReadOnly?, sort?}` ·
`POST /api/calendar/ics {url, name, color?}` · `PATCH /api/calendar/ics/:id {url?, name?}` ·
`DELETE /api/calendar/calendars/:id` (ICS only) · `GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA>`
→ `{events, window:{from,to}, truncated?}` (to exclusive; query `(all_day=0 AND start < :toInstant AND ("end" > :fromInstant
OR start = :fromInstant)) OR (all_day=1 AND start < :toDate AND "end" > :fromDate)`, clipped to the synced window;
optional `calendarIds=a,b` (≤ 200) = exactly those calendars, hidden ones included, otherwise the visible calendars;
at most 5,000 events / 4 M chars of event text per response, earliest first, `truncated: true` when cut) ·
`POST /api/calendar/events` · `PATCH|DELETE /api/calendar/events/:id` (single instance) · `POST /api/calendar/sync`.

**Mail** — `GET /api/mail/summary` → `MailAccountSummary[]` · `POST /api/mail/:accountId/messages/:id/read {read}` ·
`POST /api/mail/:accountId/messages/:id/archive` · `POST /api/mail/:accountId/messages/:id/trash`.

**Feeds** — `GET /api/feeds?url=` → `Feed` (`shared/src/feeds.ts`). Fetched with `safeFetch('public')` (≤ 5 MB,
10 s); RSS 2.0/0.9x, RSS 1.0 (RDF) and Atom are read by a linear-time XML reader (`modules/feeds/xml.ts`: no entity
expansion, DOCTYPE internal subsets rejected, depth/element caps). A web page is searched for its advertised feed
(`<link rel="alternate" type="application/rss+xml|atom+xml">`), which is fetched once. Titles and summaries are plain
text (`htmlToPlainText`), links are SafeHttpUrls, ≤ 50 items newest first. Cached 15 min in `cache`. Not a feed → 422.
`&check=1` (the feed settings trying an address before adding it) records the `feed:` health subject only when the
fetch succeeds, so a typo leaves no failing feed behind. Not available in the static build (feeds are cross-origin).

**Sports** — `GET /api/sports/teams?league=` → `SportsTeam[]` · `GET /api/sports/games?league=&team=` →
`SportsTeamGames {team, recent ≤ 10, live, upcoming ≤ 10, fetchedAt}` (`shared/src/sports.ts`; 16 leagues in
`SPORTS_LEAGUES`). ESPN's public site API, `safeFetch('provider')` (no key). The pure mapper `modules/sports/espn.ts` is
copied byte for byte to `web/src/static/providers/espn.ts` (a test checks). A team's games come from its schedule
(cached 5 min; one season phase, so the previous phase is also read when it has < 3 results and the next when nothing
is scheduled; soccer adds `?fixture=true`) with the league scoreboard (cached 20 s) overlaid while a game is around
now (30 min before start to 8 h after). Team lists cached 1 day; the static build reads them from `/standings`
(ESPN's `/teams` sends no CORS header). Plain text only; links https; logos from `a.espncdn.com` only.

**Pairing** (hybrid mode, §16; `shared/src/pairing.ts`; `samePc()` except `POST /api/pairings`, which is untagged
and so local-only: another PC has no say over pairings)
— `GET /api/pairing` → `PairingStatusResponse {paired, pairingId, instanceId, label, createdAt}` for the presenting
`X-Portly-Token` (none → 409 `not_configured`, unknown → 401 `pairing_required`) · `DELETE /api/pairing` → 204 (the
browser unpairs itself) · `GET /api/pairings` → `{pagesUrl|null, instanceId, pairings: {id, label, origin, createdAt,
lastUsedAt|null, current}[]}` (`current` = made for the configured origin) · `POST /api/pairings {nonce}` [local] →
201 `{redirectUrl}` = `<pagesUrl>#/paired?token=…&nonce=…&instance=…` built from config only (409 `not_configured`
without a Pages URL) · `DELETE /api/pairings/:id` → 204 / 404.

**Devices** (other PCs, §20; `shared/src/devices.ts`) — `POST /api/devices/requests {label}` [enrollment] → 201
`{id, code, expiresAt}` and the enrollment cookie (only from the remote port: 409 `not_configured` without a remote
origin, 409 `conflict` from this PC's own page; 429 `rate_limited` with `Retry-After` while 3 requests wait) ·
`GET /api/devices/requests/current` [enrollment] → `{status: pending|approved|denied|expired, id, code, expiresAt,
device|null}` for the enrollment cookie (`approved` sets the device cookie and clears the enrollment one; asked again
before the device's first use, the same device gets a fresh cookie; 404 without a cookie or for one the server does
not know) · `GET /api/devices/requests/suggestion` [enrollment] → `{label|null}`: the name the connect screen fills
in, from the last `X-Forwarded-For` entry through Tailscale on this PC (§20; null from this PC's own page, without
the header, or when Tailscale cannot say) · `GET /api/devices` [paired] → `{remoteOrigin|null, devices: {id, label, browser, createdAt, lastUsedAt|null,
current}[], requests: {id, code, label, browser, createdAt, expiresAt}[]}` · `POST /api/devices/requests/:id/approve`
[local] → `{approved: true}` / 404 · `POST /api/devices/requests/:id/deny` [local] → 204 / 404 ·
`DELETE /api/devices/:id` [same-pc] → 204 / 404 · `GET /api/device` [paired] → `{device: {id, label, createdAt}}` for
the device the gate verified (none → 409 `not_configured`) · `DELETE /api/device` [paired] → 204 (the device
disconnects itself; its cookie cleared). Every other route except those listed `samePc()` or local-only in §4.2 is
`paired()`; `GET /api/about` and the diagnostics summary blank the paths for a device as for the Pages site.

**Diagnostics** (§17; `shared/src/diagnostics.ts`, all [paired]) — `GET /api/diagnostics/summary` ·
`GET /api/diagnostics/logs?scope=memory|files&…` · `GET /api/diagnostics/health/:key/history?limit=` ·
`PUT /api/diagnostics/level` · `POST /api/diagnostics/jobs/:name/run` · `GET /api/diagnostics/report?redact=0|1` ·
`POST /api/diagnostics/client-events`. Every answer (API, static file, error) carries `X-Request-Id`.

### 7a. Shared contracts (`shared/src/*`)
- **errors.ts** — `ErrorCode = 'bad_request'|'validation_failed'|'forbidden'|'not_found'|'conflict'|'not_configured'|
  'reauth_required'|'provider_error'|'rate_limited'|'upstream_timeout'|'payload_too_large'|'module_unavailable'|'internal'`;
  statuses 400/422/403/404/409/409/409/502/429/504/413/503/500; hybrid mode adds `pairing_required` (401) and
  `local_only` (403); other PCs add `login_required` (401). `ApiErrorBody {error:{code,message,details?,accountId?}}`.
  Multi-account aggregates return 200 with a per-item `error?: ApiErrorBody['error']`.
- **core.ts** — `SafeHttpUrl`, `HexColor`, `Uuid`, id/timestamp helpers, `Paged<T>` if needed.
- **profiles.ts** — `WidgetFrame {title?: string; showHeader: boolean; transparent: boolean}`;
  `WidgetInstance {id, type: string, x, y, w, h, config: unknown, frame: WidgetFrame}`;
  `Layout {version: 1, items: WidgetInstance[]}`; `Profile {id, name, sort, layout: Layout}`.
- **settings.ts** — composes namespaces with `.prefault({})` so `SettingsSchema.parse({})` yields full defaults:
  `Settings {general, appearance, search, bookmarks, weather, calendar, todoist, activeProfileId: string|null}`.
  `GeneralSettings {userName?, locale: 'system'|string, timeFormat: 'system'|'12h'|'24h', weekStartsOn: 0|1|6,
  temperatureUnit: 'C'|'F', windUnit: 'kmh'|'mph'|'ms', precipUnit: 'mm'|'in', openLinksInNewTab: boolean}`.
  `appearance: Theme`. Every sub-schema is `.strict()` at every level, bounded strings/arrays; `z.record` keys match
  `^[a-z0-9_-]{1,64}$`. Feature namespaces (search, bookmarks, weather, calendar, todoist) are defined in the
  feature's own shared file and imported here.
- **Theme** — `{mode: 'light'|'dark'|'system', accent: HexColor, background: {type:'color', color} |
  {type:'gradient', angle: 0–360, stops: {color, at: 0–100}[2..5]} | {type:'image', uploadId: Uuid, blur: 0–40, dim: 0–0.9},
  font: 'system'|'serif'|'mono'|'rounded', density: 'comfortable'|'compact', radius: 0–24, widgetOpacity: 0.3–1}`.
  Defaults follow the Beacon brand (`docs/brand/README.md`): accent Tide `#137a85`, background the Harbor `#0b4f63` to
  Deep `#072f3b` gradient at 160 degrees.
- **Theme rendering (performance)** — `web/src/theme/applyTheme.ts`. Live CSS filters make the GPU redo their work on
  every repaint they cover (hover fades, scrolling, animations) at full screen resolution, which can make the cursor
  stutter on 4K or high-DPI screens. So:
  - a photo's dim is a dark `linear-gradient` layer inside `--hb-backdrop`, never a `filter`;
  - a photo's blur is baked once into a small copy (`backdropBake.ts`: drawn on a canvas with `ctx.filter`, a few
    samples per blur sigma, zoomed like the live layer so swapping does not shift the picture, PNG up to 1.5
    megapixels and WebP above) by `useBakedBackdrop` (`useTheme.ts`), which bakes again 150 ms after the image, the
    blur or the window size key (CSS size buckets plus device pixel ratio, so browser zoom counts) changes, swaps in
    a copy only once it is decoded, and revokes replaced `blob:` URLs 2 s later. Until a copy exists (first paint,
    slider drags) or when the browser cannot blur on a canvas, `data-backdrop-filter='live'` keeps a live
    `filter: blur()` (`base.css`). A stored animated image bakes its first frame, so a blurred animated background
    stops moving once the copy is ready;
  - the uploaded image itself is prepared in the browser before it is stored (background uploads, below): a still
    copy whose long edge fits the screen (at most 3840), so no tab decodes a 24-megapixel photo or redraws the window
    for the frames of an animation;
  - glass surfaces get `backdrop-filter` only under `data-glass='frosted'` (`tokens.css`), set when frosted glass is
    on and a photo is on screen. Frosted glass is a setting of the browser, not of the theme
    (`theme/glassPreference.ts`, localStorage `portly:frosted-glass`, per address like other `portly:` keys): its
    cost depends on the PC, and keeping it out of the strict `ThemeSchema` means an older Pages site, server or
    export never meets an unknown field. Widget frames skip the blur even then when `data-opaque-widgets` (widget
    opacity ≥ 0.95), and hover fades use `--hb-hover-duration`, which is 0 under frosted glass;
  - no other always-visible surface blurs (popovers and settings panels follow `--hb-glass-filter`; the dialog
    overlay and the calendar agenda's day headers have none), the animations that could run indefinitely are
    finite (skeleton shimmer, weather location and local-server pulses: 3 runs; no pulse while waiting for the
    browser's permission or on the sports LIVE pill), and react-grid-layout's 200 ms relayout transitions run only
    in edit mode. New CSS must not add `filter`, `backdrop-filter` or infinite animations on always-visible
    surfaces; it uses `--hb-glass-filter` / `--hb-widget-glass-filter` and `--hb-hover-duration`.
- **Theme rendering: background uploads** (`settings/sections/BackgroundImage.tsx`, `theme/prepareBackground.ts`;
  header-only checks in `theme/backgroundImage.ts`, which treat the bytes as hostile: bounded walks, malformed means
  "still" or "size unknown"). Every new tab decodes and draws the background, so an upload is prepared in the browser
  first:
  - the target long edge is the screen's long edge times `devicePixelRatio`, kept within 2560..3840;
  - a still PNG, JPEG, GIF, WebP or AVIF whose header says it fits goes up unchanged, without being decoded;
  - anything else is decoded and redrawn on an `OffscreenCanvas` with its long edge at min(original, target), then
    encoded as WebP at quality 0.85 (PNG where the browser cannot encode WebP). That covers animations (a GIF with a
    second image block, a PNG with `acTL` > 1 frame before `IDAT`, a WebP with a second `ANMF`, an AVIF with the `avis`
    brand), larger photos, BMP and ICO, and SVG. Raster files go through `createImageBitmap` (first frame, EXIF
    orientation applied); an SVG through an `<img>` on a `blob:` URL (no script, no outside loads, `img-src` allows
    `blob:`), drawn at the target size;
  - the original goes up when the APIs are missing, the canvas cannot be read back or the copy is over 10 MB; a file
    the browser cannot decode is refused with a message (`ImagePrepareError`). The picker takes up to 25 MB before
    this step; the server's limit and magic-byte sniffing apply unchanged to what is sent, and bookmark icons are
    uploaded as they are.

  A stored background that would gain from the step (animated, a long edge over 3840, SVG, BMP or ICO; read with
  `GET /api/uploads/:id`, header only, query `['uploads','background-check',id]`, not persisted) gets an **Optimize
  image** offer: it prepares the stored bytes the same way with the target fixed at 3840 (so a copy made while the
  window is on a small monitor still suits a 4K one), uploads the copy and switches `uploadId`, keeping blur and dim.
  The old upload becomes an orphan and is collected after 24 h.
- **accounts.ts** — `AccountKind`, `Capability = 'calendar'|'mail'|'launchpadSync'` (`launchpadSync`: OneDrive sync of
  the launch pad, a Microsoft service of the browser-only build only; no server sign-in offers it, so the server answers
  it with 422), `Account {id, kind, label, email|null, color|null,
  capabilities, enabledCapabilities, status: 'ok'|'error'|'reauth', statusMessage|null, createdAt, updatedAt}`,
  per-kind config types, create payloads, `OAuthProvider = 'google'|'microsoft'`, `OAuthResult`.
- **bookmarks.ts** — `Bookmark {id, groupId, title, url, sort, iconMode, iconId|null, letterColor|null}`,
  `BookmarkGroup {id, name, sort, color|null, collapsed, bookmarks}`, create/update/move schemas,
  `BookmarksSettings`, import report types.
- **search.ts** — `SuggestProvider = 'google'|'ddg'|'bing'|'wikipedia'|'youtube'`;
  `SearchEngine {id, name, urlTemplate /* contains %s */, keyword|null, suggest: SuggestProvider|null, iconId|null}`;
  `SearchSettings {engines, defaultEngineId, suggestionsEnabled, showBookmarkMatches}`; preset list.
- **weather.ts** — `GeoPlace {name, admin1?, country?, lat, lon, timezone?}`; `WeatherReport {place?, units,
  current {time, temp, apparent, humidity, windSpeed, windDir, code, isDay, precip}, hourly[{time, temp, code, precipProb}],
  daily[{date, min, max, code, precipProb, sunrise, sunset}]}`; `WeatherSettings {defaultLocation: GeoPlace|null}`;
  WMO code → `{label, icon}` map.
- **todoist.ts** — `Task {id, content, description, projectId, due: {date, datetime|null, string, isRecurring}|null,
  priority: 1|2|3|4, labels: string[], url}`, `Project {id, name, color}`, `TodoistSettings {defaultFilter}`.
- **calendar.ts** — `Calendar {id, accountId|null, source, name, color /*resolved*/, writable /* provider && !userReadOnly */,
  providerWritable, userReadOnly, visible, isPrimary, sort, displayUrl|null, lastSyncedAt|null, lastError|null,
  colorOverride?: string|null}` (`lastError` starting with `CALENDAR_WARNING_PREFIX` = `"Warning: "` is non-fatal);
  `CalendarEvent {id, calendarId, title, location|null, description|null, start, end, allDay, timezone|null, status,
  recurring, seriesId|null, htmlUrl|null, meetingUrl|null, editable}`; `EventInput {calendarId, title, allDay, start,
  end, timezone, location?, description?}` (timed = ISO with offset; all-day = `YYYY-MM-DD`, end exclusive);
  `CalendarSettings {syncIntervalMin: 5–60, defaultCalendarId: string|null}`.
- **mail.ts** — `MailMessage {id, accountId, from: {name, address}, subject, snippet|null, date, unread, webUrl|null}`;
  `MailAccountSummary {accountId, label, email, color, unread, messages, webmailUrl|null, canArchive, canTrash?, error?}`.
- **feeds.ts** — `Feed {url, feedUrl, title, siteUrl|null, items, fetchedAt}`; `FeedItem {id, title, url|null,
  published|null, author|null, summary|null}` (plain text; caps `MAX_FEED_ITEMS` 50, `MAX_FEED_SUMMARY` 400,
  `MAX_FEED_TITLE` 300); `FeedQuerySchema {url: SafeHttpUrl, check?: '1'}`.
- **sports.ts** — `SPORTS_LEAGUES` (`SportsLeagueInfo {id, sport, league, name, soccer, scoreboardGroups?}`, picker
  order) and the `SportsLeagueId` enum of their ids; `SportsTeamId` (ESPN's numeric id); `SportsTeam {id, league, name,
  shortName, abbreviation, logo|null, logoDark|null, color|null}`; `SportsGame {id, league, date, timeValid,
  state: 'pre'|'in'|'post', completed, detail, situation|null, home, away: SportsCompetitor, note|null, venue|null,
  boxScoreUrl|null, gameUrl|null, espnWatchUrl|null, broadcasts}`; `SportsTeamGames`; the query schemas of both routes.
- **export.ts** — `EXPORT_FORMAT = 'portly-export'`, `EXPORT_VERSION = 1`, `isExportFormat` (also accepts
  `'homebase-export'`, §19); the strict `ExportSchema` of §7 Core (uploads and custom icons embedded as base64, each
  ≤ 10 MB decoded; ≤ 100 uploads); `MAX_IMPORT_BYTES` (25 MB); `ImportSummary`, `ImportPreviewResponse`,
  `ImportCommitSchema {previewId}`.
- **launchpadSync.ts** (launch pad sync, [design](design/launchpad-sync.md)) — the synced file's strict schema
  (`SYNC_FILE_FORMAT = 'portly-sync'`, `SYNC_FILE_VERSION = 1`: groups and bookmarks from the export schemas plus
  `updatedAt`/`placedAt` stamps, tombstones, custom icons by UUIDv4 and SHA-256, the two group pointers, `epoch`,
  `horizon`) and the pure merge: `mergeLaunchpads` (a join of last-writer-wins parts: commutative, associative,
  idempotent), `liveLaunchpad`, `pruneLaunchpad` (90-day tombstones, caps, horizon), `forgetUnsynced`,
  `serializeSyncFile` (canonical JSON).
- **pairing.ts** (hybrid mode) — `PORTLY_API_VERSION` (core.ts; bumped on any change the other side cannot
  ignore), `PAIRING_TOKEN_HEADER = 'X-Portly-Token'`, `MAX_PAIRINGS`, token/nonce schemas (43-char base64url),
  `InstanceIdSchema`, the request/response schemas of §7 Pairing, and the URL helpers `buildPairingRequestUrl` /
  `parsePairingRequest` (`<appUrl>#/pair?nonce=…`) and `buildPairingReturnUrl` / `parsePairingReturn`
  (`<pagesUrl>#/paired?token&nonce&instance`). Response schemas are strict on the server; the Pages site reads
  them with tolerant copies (`z.object(Schema.shape)`), because the published site and the server are updated
  separately — `apiVersion` decides compatibility.
- **devices.ts** (other PCs, §20) — `DEVICE_COOKIE` (`__Host-portly_device`), `ENROLL_COOKIE`
  (`__Host-portly_enroll`), `DEVICE_REQUEST_TTL_MS` (10 min), `MAX_PENDING_DEVICE_REQUESTS` (3), `DEVICE_IDLE_TTL_MS`
  (30 days), `MAX_DEVICES` (20), `DEVICE_CODE_ALPHABET`/`DeviceCodeSchema` (`XXX-XXX` without 0/O/1/I/L),
  `DeviceSecretSchema` (32 random bytes base64url), `DeviceLabelSchema` (one line ≤ 60, no control or bidi
  characters), `DeviceRequestCreateSchema`, the response schemas of §7 Devices.
- **diagnostics.ts** (§17) — log levels, `DIAGNOSTIC_AREAS`, `HEALTH_CODES`, `REQUEST_ID_HEADER`, the scrubbers
  (`scrub`, `maskUserPaths`, `scrubFields`, `redactForSharing`) shared by the server and the browser, and the DTOs of
  `/api/diagnostics/*` (log records and queries, health entries and outcome rows, jobs, log level, summary, browser
  events).
- **Conventions:** API camelCase; DB snake_case; booleans ↔ 0/1; DB timestamps epoch ms, API ISO strings.
- **web/src/api/keys.ts** exports one `qk` object with every query key (settings, profiles, accounts, oauthClients,
  bookmarks, icons, search.suggest, weather, geocode, todoist.token/tasks/projects, calendar.calendars/events,
  mail.summary, pairings, diagnostics — never persisted). Account create/delete/reconnect invalidates `['accounts']`,
  `['calendar']`, `['mail']`.

---

## 8. Provider notes (verified 2026-09-25)

**Google** — OAuth client type *Web application*; redirect `http://localhost:5757/api/oauth/google/callback`
(from config). Scopes (all services; a sign-in asks for `openid email profile` plus those of the services picked,
§4.7): `openid email profile https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/gmail.modify`;
`access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, PKCE S256; `client_secret` required at
token exchange. The consent screen must be **In production** (unverified, personal-use exemption) — "Testing"
expires refresh tokens after 7 days. Handle partial grants via the token response `scope`. Refresh tokens die
after 6 months unused or on password change (Gmail scopes) → `reauth`.
Calendar: `calendarList.list`; `events.list(singleEvents=true, timeMin, timeMax, maxResults=1000, pageToken, prettyPrint=false, fields=<only what
the mapper reads>)` (listing pages capped at 16 MB);
`events.insert/patch/delete` (instance ids edit single occurrences). All-day uses `start.date`/`end.date`.
`meeting_url` from `hangoutLink` or `conferenceData.entryPoints[type=video]`.
Gmail: `users.labels.get(INBOX)` → `messagesUnread`; `messages.list(labelIds=INBOX, maxResults=N)` +
`messages.get(format=metadata, metadataHeaders=[From,Subject,Date])` with concurrency ≤ 5; `modify`
(UNREAD / INBOX labels); `trash`. `webUrl = https://mail.google.com/mail/u/?authuser=<email>#inbox/<threadId>`.

**Microsoft (personal accounts only)** — Prerequisite: the user creates a personal Entra directory via Azure
free-account signup with their personal MSA (identity verification by card; no charges for this use). App
registration: *Personal Microsoft accounts only*; platform **Mobile and desktop applications** (public client,
no secret, 90-day sliding refresh tokens); redirect `http://localhost/api/oauth/microsoft/callback` (Entra ignores
the port for localhost); no Web/SPA redirect on the same path. Authority `https://login.microsoftonline.com/consumers`.
Scopes (all services; a sign-in asks for `openid profile email offline_access User.Read` plus those of the services
picked, a refresh for those of the granted services, §4.7): `openid profile email offline_access User.Read
Calendars.ReadWrite Mail.ReadWrite`. PKCE; no client
secret at the token endpoint (Node fetch sends no Origin header). Persist rotated refresh tokens. Require
id_token `tid` = consumer tenant.
Calendar: `/me/calendars`; `/me/calendars/{id}/calendarView?startDateTime&endDateTime&$top=500` paging via
`@odata.nextLink`, `Prefer: outlook.timezone="UTC"`; create `POST /me/calendars/{id}/events`; `PATCH/DELETE /me/events/{id}`
(occurrence ids edit single instances). When `isAllDay`, take the date part of start/end verbatim (end exclusive).
`meeting_url` from `onlineMeeting.joinUrl`. Mail: `/me/mailFolders/inbox` (`unreadItemCount`);
`/me/mailFolders/inbox/messages?$top=N&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,bodyPreview,webLink`;
`PATCH isRead`; `POST /me/messages/{id}/move {destinationId:'archive'|'deleteditems'}`; always
`Prefer: IdType="ImmutableId"`. Fallback without Azure: publish Outlook.com calendars as ICS (read-only); mail unavailable.

**Yahoo** — no public REST API. App password (Account Security → Generate app password; Yahoo may refuse for
new/low-history accounts — documented in SETUP). CalDAV (read-only in v1): tsdav
`createDAVClient({serverUrl:'https://caldav.calendar.yahoo.com', credentials:{username,password}, authMethod:'Basic',
defaultAccountType:'caldav'})` with a transport built on `safeFetch('user-server')`; `credentialOrigins` fixed to
`https://caldav.calendar.yahoo.com`. IMAP `imap.mail.yahoo.com:993` TLS. The Yahoo create call reports CalDAV and
IMAP results separately; a CalDAV failure still allows a mail-only account. Fallback for calendars: Yahoo
Calendar public ICS link → add as ICS. `webmailUrl` = `https://mail.yahoo.com/`.

**Generic CalDAV** (read-only v1) — https required, TLS verification always on (no ignore-cert option); `http`
only if the host resolves to a private address and the user ticked `insecureLan`. Credentials go only to the
account's `credentialOrigins`: the entered origin plus same-site origins (same eTLD+1 via `tldts`) reached through
`/.well-known/caldav` redirects at account creation (stored in `accounts.config`). Every href in PROPFIND/REPORT
responses is resolved against the request URL and dropped unless inside `credentialOrigins`; event hrefs must be
under their collection path. Runtime redirects are manual and stay within `credentialOrigins`.

**Generic IMAP** — `security:'tls'` (port 993, `secure:true`) or `'starttls'` (`doSTARTTLS:true`); never plaintext or
opportunistic. `tls: {rejectUnauthorized: true, minVersion: 'TLSv1.2'}`. imapflow: `logger:false`; attach
`client.on('error', …)` before `connect()`; every session runs in a `worker_threads` worker (imapflow parses server
responses synchronously and super-linearly on hostile input, reachable before auth/STARTTLS) with a heap limit and a
30 s cap, terminated on abort; lines ≤ 64 KB, literals ≤ 64 KB, responses ≤ 256 KB; `unreadOnly` searches only
the newest 1,000 messages; one short-lived connection per request (connect → lock INBOX →
work → logout) with 15 s timeouts. v1: `STATUS INBOX (UNSEEN)`, latest N messages (ENVELOPE + FLAGS; no
snippets), mark read/unread, trash, archive only when a `\Archive` special-use folder exists (§4.10).

**ICS** — `webcal://` → `https://`; full URL stored as vault secret `ics:<calendarId>`, API/logs show host only;
conditional GET (ETag / Last-Modified) via `safeFetch('public')`; parse/expand in the worker (§4.9).

**Recurrence (ICS/CalDAV)** — for each master build `ICAL.Event` and call `master.relateException(...)` for every
VEVENT with the same UID and a RECURRENCE-ID; iterate `master.iterator()` using `getOccurrenceDetails` until past the
window end. Register every VTIMEZONE with `ICAL.TimezoneService.register`. TZIDs without VTIMEZONE: map Windows zone
names to IANA via a bundled CLDR `windowsZones` table; otherwise floating in the server's local zone. Expanded
instances: `instance_key` = occurrence start (UTC), `editable = 0`.

**Todoist** — `Authorization: Bearer <token>`, base `https://api.todoist.com/api/v1`. Filter: `GET /tasks/filter?query=<q>&limit=200[&cursor=]`
→ `{results, next_cursor}` (loop until null). Quick add: `POST /tasks/quick {text}`. Close: `POST /tasks/{id}/close`
(recurring tasks advance instead of completing — refetch, don't remove). Reopen: `POST /tasks/{id}/reopen`. Update:
`POST /tasks/{id}` (not PATCH). Projects: `GET /projects?limit=200` with cursor paging. IDs are opaque strings.
REST v2 is shut down (410). Token validated with a cheap call before storing.

**Weather** — Open-Meteo `https://api.open-meteo.com/v1/forecast?latitude&longitude&current=...&hourly=...&daily=...&timezone=auto&temperature_unit&wind_speed_unit&precipitation_unit&forecast_days=7`;
geocoding `https://geocoding-api.open-meteo.com/v1/search?name=&count=8&language=en&format=json`. Cache 10 min
(key rounds lat/lon to 2 decimals). No key. Reverse geocoding (the device location's name) uses OpenStreetMap Nominatim
`https://nominatim.openstreetmap.org/reverse?lat=&lon=&format=jsonv2&zoom=10&addressdetails=1&accept-language=en`
(city level; name = `address.city|town|village|hamlet|municipality|suburb|county`, else `name`; `admin1` = `state|region`;
`{"error": ...}` → `null`). Cached 7 days by lat/lon rounded to 2 decimals, `null` included, which keeps a single user far
below the usage policy's 1 request/second; the server sends its `Portly/<version>` User-Agent. No key. Data © OpenStreetMap
contributors (ODbL): the widget credits it while it shows such a name.

**Favicons** — resolver (policy `public`): page HTML (≤ 2 MB) → `<link rel~=icon|apple-touch-icon>` + web manifest
icons, hrefs resolved against the final response URL, prefer largest ≥ 32 px raster or SVG → `/favicon.ico` →
`https://icons.duckduckgo.com/ip3/<host>.ico` → `https://www.google.com/s2/favicons?domain=<host>&sz=128`
(non-2xx = miss; skip for local-looking hosts, §4.8) → client-side letter tile. Stored in `icons`; refreshed after 30 days.

**Search suggestions** (all return `[query, string[], ...]`; take index 1; send the Portly User-Agent):
google `https://suggestqueries.google.com/complete/search?client=firefox&q=` · youtube
`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=` · ddg `https://duckduckgo.com/ac/?type=list&q=` ·
bing `https://api.bing.com/osjson.aspx?query=` · wikipedia
`https://en.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=8&search=`. Cache 5 min.

---

## 9. Sync

In-process scheduler. Calendar: every `settings.calendar.syncIntervalMin` (default 5; rescheduled on change) per
account; window `[today-30d, today+365d]`; per calendar, fetch the full window and in one transaction upsert by
deterministic event id and delete ids no longer returned. ICS: every 30 min with conditional GET. Initial sync 5 s
after startup; `POST /api/calendar/sync` forces one. Writes (Google/Microsoft only) are write-through: provider call →
upsert the cache row from the provider response → return it. Mail: fetched on demand, in-memory LRU 60 s; after an
action the account's entry is invalidated. Auth failures set `status=reauth`; the UI shows Reconnect.

---

## 10. Web app

### 10.1 Structure
React 19 + Vite 8 + TS; TanStack Query (cache persisted to localStorage: maxAge 24 h, buster = app version, so a
new tab paints last-known data instantly, then refetches; the cache is restored and the active profile's widget
chunks are preloaded (≤ 150 ms) *before* the first render, so the first frame shows content, not skeletons; queries
over 512 KB, site-meta lookups and unobserved calendar ranges are not persisted, and a quota error drops the
oldest queries, as few as fit (found by halving); the snapshot is written only after a persisted query got new data
or left it (success, `setQueryData`, removed, failed), at most every 5 s and at once on `visibilitychange` to hidden
and `pagehide` (`subscribePersistedCache`, not TanStack's subscriber, which dehydrates on every cache event): every
write reaches every other tab of the origin; the Pages build keeps one snapshot per backend, §16); hand-rolled hash
router (`web/src/app/router.ts`: home, `#/settings/<section>`, `#/pair?nonce=…`; `#/add-bookmark?url=&title=`, from
the extension's toolbar button (§11), renders home and the shell opens the Add bookmark dialog filled in with that
page, `widgets/launchpad/addRequest.ts`, §4.4; the hash goes back to `#/` when the dialog closes);
CSS custom properties (tokens) + CSS Modules for feature styles; `lucide-react`; `date-fns` + `@date-fns/tz`;
Radix primitives; sonner toasts. Vite dev proxy: `/api` → `PORTLY_PORT`, `changeOrigin: false`; never set
`server.host` or `server.cors: true`.

### 10.2 Grid
12 columns, react-grid-layout v2: `import ReactGridLayout, { useContainerWidth } from 'react-grid-layout'`;
`gridConfig={{cols: 12, rowHeight: 40, margin: [12, 12]}}`, `dragConfig={{enabled: editMode, handle: '.hb-drag-handle',
cancel: 'input,textarea,select,button,a,[data-no-grid-drag]'}}`, `resizeConfig={{enabled: editMode, handles: [all four corners and edges]}}`; import
`react-grid-layout/css/styles.css` and `react-resizable/css/styles.css`. Edit mode: drag handle in each frame header,
Add Widget dialog, remove, per-widget settings dialog (frame options + widget Settings component). Positions saved
via `PUT /positions` (debounced); config via `PATCH /widgets/:instanceId` — never whole-layout overwrites.
Below 768 px: widgets stacked full-width in (y, x) order, edit mode disabled; lists (launch pad, agenda, Todoist,
mail) size to their content up to 70 vh, other widgets keep their row height (`WidgetDefinition.stackSizing`).
First run seeds a "Home" profile from `web/src/grid/defaultLayout.ts`: on the server backend seven widgets (search,
clock, launch pad, weather, calendar, Todoist, mail), on the browser backend five (no mail, and the calendar, which
needs Outlook.com set up first, is left to Add widget). Feeds and sports start empty, so they are never seeded.

### 10.3 Widget registry
Each `web/src/widgets/<type>/index.ts` exports
`definition: WidgetDefinition<C> = {type, title, description, icon, defaultSize: {w, h, minW, minH, maxW?, maxH?},
configSchema /* zod, every field defaulted */, Component: lazyWithPreload(() => import('./Widget.tsx')), Settings?: lazy(() => import('./Settings.tsx')), stackSizing?}`
(`lazyWithPreload` is `React.lazy` plus `preload()`; once preloaded it renders without suspending).
`description` is the "Add widget" text, a string or `(caps: Capabilities) => string` when it depends on the page
load's backend (the calendar names Outlook.com alone on the in-browser backend); read it with `widgetDescription()`.
`web/src/widgets/registry.ts` lists all nine definitions in "Add widget" order (search, launch pad, calendar, mail,
Todoist, weather, feeds, sports, clock) and throws at load when they differ from `WIDGET_TYPES`
(`shared/src/profiles.ts`); `availableWidgetDefinitions()` leaves out the types this page load's backend cannot run
(§16 Capabilities).
`WidgetProps<C> = {instanceId, config: C, setConfig(patch: Partial<C>): Promise<void>, size: {w, h}, editMode: boolean}`;
`WidgetSettingsProps<C> = {value: C, onChange(next: C): void}`. `WidgetFrame` wraps each widget in an ErrorBoundary
+ Suspense (Skeleton fallback), renders the header (icon, title, `<WidgetActions>` slot for widget-specific header
buttons, drag handle in edit mode) and sets `container-type: inline-size` on the body. Config is parsed with
`configSchema` on every read (invalid/old config → defaults). Unknown types render an "Unknown widget" placeholder.
All types allow multiple instances.

### 10.4 UI kit (`web/src/ui/`)
As `web/src/ui/index.ts` exports it: Button (primary|secondary|ghost|danger; sm|md; loading), IconButton (required
aria-label), Input, PasswordInput (show/hide toggle, never autofilled from saved logins), TextArea, Select, Checkbox,
Switch, SegmentedControl, Slider (native range input with a value readout), Field (label/help/error; `useField` and
`useFieldControlProps` wire a control to it), FieldGroup (fieldset + legend), Dialog + ConfirmDialog + DialogClose,
Popover (+ Trigger, Content, Anchor, Close), Menu (+ Trigger, Content, Item, CheckboxItem, RadioGroup, RadioItem,
Group, Label, Separator, Sub, SubTrigger, SubContent), Tooltip, Tabs (+ List, Trigger, Content), toast (sonner;
`toastError`, `toastUndo` with an Undo action, `errorMessage`), ColorPicker + ColorPickerPopover (12 swatches + native
color input + hex field; `normalizeHexInput`), ImageUpload (optional `prepare` step that turns the chosen file into
the one uploaded), Spinner, Skeleton + SkeletonLines + SkeletonList, EmptyState {icon | media, title, body, action},
BrandMark / BrandLockup (the Beacon lighthouse, full drawing at 48 px and up), ErrorState (maps ApiError codes:
`reauth_required` → ReconnectButton, `not_configured` → "Set up" link, `network_error` → what an unreachable backend
means for this page load, else Retry), StaleIndicator ("Updated N min ago" with a warning when a refetch failed but
cached data is still shown), QueryView (renders a TanStack query: skeleton on first load, ErrorState when there is no
data, an optional empty state, otherwise the children), ErrorBoundary (fallback with a reset callback; records the
error as a client event), Badge, Kbd, LetterTile, ExternalLink, RelativeTime, Banner (info / warning / danger /
success notice with actions), CopyField (read-only value with a Copy button), the `Section.tsx` set for settings
pages (SettingsCard, FormFooter, FieldGrid, FactList), plus `ui/accounts/{AccountPicker, AccountBadge + accountColor,
ReconnectButton}` and the account constants `ACCOUNT_KIND_LABELS`, `CAPABILITY_LABELS`, `CAPABILITY_ICONS`.
ServerOnlyNotice (`ui/ServerOnlyNotice.tsx`, imported from its file, not from the index) is what a server-only
feature shows on a page whose data lives in the browser (§16).
Tokens (`web/src/styles/tokens.css`, light + dark): `--hb-bg, --hb-surface, --hb-surface-2, --hb-text, --hb-text-muted,
--hb-border, --hb-accent, --hb-accent-contrast, --hb-danger, --hb-warning, --hb-success, --hb-focus,
--hb-radius-{sm,md,lg}, --hb-space-{1..6}, --hb-font-sans, --hb-font-mono, --hb-text-{xs,sm,md,lg,xl},
--hb-shadow, --hb-widget-opacity`. Rules: features use tokens only; user-data colors go through
`readableTextColor()` (`web/src/lib/color.ts`); global CSS lives only in `web/src/styles/` (`tokens.css`, `base.css`).
Visual direction: calm, modern "glass" widgets over the user's background (color/gradient/image with blur+dim),
generous spacing, clear hierarchy, system font stacks, subtle shadows, excellent dark mode. Glass is translucent
surface color by default; frosted glass is an opt-in setting of the browser. The rules for blur, filters and
animations are in §7a Theme rendering.

### 10.5 Settings
Hash routes `#/settings/<section>`; nav: general, appearance, search, bookmarks, accounts, calendars, profiles,
devices (other PCs using this Portly through the reverse proxy on the main PC: the requests waiting with Approve
and Deny on Portly's own page on the main PC, the connected PCs with Remove; design in docs/design/multi-pc.md,
guide docs/setup/other-pcs.md), import-export, diagnostics (§17), about. About shows the version, data dir, log path and vault state. The Todoist
section moved into Accounts: `#/settings/todoist` still resolves (to `accounts`, with `focus=todoist`;
`MOVED_SETTINGS_SECTIONS` in `settings/nav.ts`), and Todoist links use `#/settings/accounts?focus=todoist`.

**Accounts** (`settings/sections/Accounts.tsx`, parts in `settings/sections/accounts/`) is "connect a main account,
then choose what it is used for":
- *Connected accounts* on top: one row per account (name, email, status, the enabled services as chips; **Manage**,
  **Reconnect** for OAuth kinds, **Test**, **Remove**) plus Todoist while its token is saved (status from
  `GET /api/todoist/token` and the projects query; Test fetches the projects; Remove deletes the token). Todoist is not
  an `accounts` row: the token stays write-only in the vault (server) or the browser slice (in-browser backend).
  **Manage** renames, recolors and switches services (`PATCH enabledCapabilities`); for Google/Microsoft it offers
  **Add** for a service the account was not granted (start with `{accountId, capabilities: [service]}`, §4.7). Todoist's
  Manage holds Replace token and the default filter.
- *Add a connection*: tiles Google, Microsoft, Yahoo, Todoist, Other (`accounts/connections.ts`, data-driven: per
  connection the services it offers with a one-line description; a new service is one entry plus its scopes). A tile
  opens a connect dialog: **App registration** (Google/Microsoft, only while the client is not configured; console
  link, steps, exact redirect URI, client ID/secret) → **Services** (checkboxes; only built services) → **Sign in**
  (start with the services ticked; disabled while the vault is locked) or the credential form (Yahoo app password;
  Other: CalDAV calendar or IMAP mail) with per-service probe results, or the Todoist token. Yahoo services left
  unticked are switched off after creation. *App registrations* under the tiles shows each provider's status (Ready /
  Setup needed / Credentials locked) with **Edit**.
- The vault-locked banner with **Reset credentials** (server vault only).
- What a page load offers follows `getCapabilities()`: on the in-browser backend only Microsoft (calendar, and launch
  pad sync, never ticked for the user; browser sign-in with a single-page-app redirect) and Todoist, with a line saying
  the others need the Portly server. Launch pad sync is offered nowhere else (`launchpadSync`, §16).
The app reads `?oauth=<result>` on load, shows a toast, and strips it from the URL.
Hybrid mode (§16): About in the server build ends with **Paired browsers** (`PairedBrowsersCard`: the configured Pages
address or how to set it, every pairing with label, created and last used, "Old address" when not made for the
current origin, Revoke); in the Pages build it shows the local server panel as a card instead. `#/pair?nonce=…`
renders `PairPage` on its own (no shell, loaded on demand): in the server build the consent page — fetches
`GET /api/pairings`; no Pages URL → setup steps; invalid nonce → error; else "Allow **<origin>** to use Portly on
this PC?" with the warning that every page of that origin gets the access and what it can and cannot do.
**Approve** is enabled only after the page has been visible and focused for 1 s (re-armed on blur / hidden); it
posts the pairing and follows the redirect only when it is exactly `<pagesUrl>#/paired?…` with the same nonce.
Cancel → `#/`. In the Pages build the route only says that pairing happens on Portly's own page.

**Appearance background uploads** (`settings/sections/BackgroundImage.tsx`) are prepared in the browser before they
are stored, and a stored background that would gain from that gets an **Optimize image** offer (see §7a Theme
rendering: background uploads).

### 10.6 Hotkeys & focus
`useHotkey` ignores events from input/textarea/select/contenteditable. `/` focus search; `e` toggle edit mode;
`Esc` close dialog / exit edit mode; `?` shortcut help. When loaded with `?src=newtab` or directly, the (first) search
widget with `autofocus` focuses its input. On a focused launch pad tile, `Shift+F10` or the context-menu key opens
its menu (handled by the tile, `ViewTile` in `widgets/launchpad/Widget.tsx`); the help dialog, and the About page's
copy of the same list, show it under "On a launch pad tile", after the page-wide keys and the search box keys.

### 10.7 Widget definition of done (every widget)
1. Not-configured state with a CTA deep link (e.g. `#/settings/accounts?focus=todoist`, `#/settings/accounts`; weather "Set location" opens widget settings).
2. Skeleton on first load. 3. Error state with Retry; `reauth_required` shows the account and Reconnect.
4. Stale data kept on refetch failure with "Updated N min ago" and a warning indicator.
5. Renders at minW×minH and adapts upward via container queries. 6. Light + dark via tokens only.
7. Keyboard-reachable actions with visible focus. 8. Optimistic mutations with toast (+ Undo where reversible).
Default staleTime: weather 10 min, calendar 60 s, mail 60 s, todoist 30 s; refetch on window focus.

### 10.8 Widget product specs
- **Search** — presets: Google, DuckDuckGo, Bing, YouTube, Wikipedia, Google Maps, GitHub, Amazon, Reddit, Perplexity,
  ChatGPT, Claude (`https://claude.ai/new?q=%s`). Settings: CRUD, reorder, default, keyword, suggest provider.
  Widget: engine chip/menu; typing `<keyword>` + Space switches engine (Backspace on empty reverts); input that parses as a
  URL (scheme, dotted host without spaces whose last label is a real TLD or a local name such as `.lan`, any dotted
  host with a port or path, `localhost:port`, IP literals) navigates directly; a bare dotted word with an unknown TLD
  (`next.js`, `index.html`) searches on Enter and offers "Go to" second; dropdown shows bookmark matches (≤ 4)
  then suggestions (≤ 8; debounced 150 ms; aborted on new input; engine provider → default engine's → none when
  disabled; on the in-browser backend a provider only the server can ask → none, or Wikipedia when this browser
  opted in, §16); ↑/↓ navigate, Enter
  current tab, Ctrl/Shift+Enter new tab. Config `{engineIds: 'all'|string[], showEngineSwitcher, autofocus,
  placeholder}`.
- **Launch pad** — config (`launchpadConfigSchema` in `web/src/widgets/launchpad/index.ts`, fourteen fields)
  `{groupIds: 'all'|string[] (≤ 200), iconSize: 's'|'m'|'l', showLabels, columns: 'auto'|1–12, style: 'tiles'|'list',
  groupLayout: 'stack'|'columns' (groups one under another, or side by side in a grid of group columns),
  groupColumns: 'auto'|1–6, groupSpans: {[groupId]: 1–6} (how many group columns a group spans; fixed `groupColumns`
  only, missing = 1), showGroupHeaders (name, color, count, collapse; when more than one group is shown), listTitle,
  listDetail: 'none'|'domain'|'url', listDetailPlacement: 'inline'|'below', listIcons, listDensity:
  'compact'|'normal'|'roomy'}` (the `list*` fields apply to the list style). Defaults: `all`, `m`, on, `auto`, `tiles`,
  `stack`, `auto`, `{}`, on, on, `domain`, `inline`, on, `normal`.
  Add/edit dialog: URL → debounced `/api/site-meta` fills title/icon; icon modes auto | upload |
  letter (+ color). Group CRUD with color and collapse. Reorder within/across groups with @dnd-kit (pointer + keyboard)
  **in edit mode** via `POST /api/bookmarks/:id/move` (the edit board and the dialogs are separate chunks, preloaded
  when the browser is idle, so the view chunk carries no @dnd-kit). Empty state links to import (`#/settings/bookmarks`).
  Ctrl/middle-click opens a new tab. Bookmarks settings, top to bottom: manage groups; preferences; one import &
  export card (import Chrome/Edge/HTML, export a bookmark HTML file).
- **Calendar** — config `{view: 'agenda'|'week'|'month', days: 1–14, calendarIds: 'visible'|string[], showDeclined}`;
  agenda default; "now" marker, all-day row, multi-day spans. Event popover: time, location, plain-text description,
  Join (meetingUrl), Open in provider, Edit/Delete when editable. "+" opens EventDialog (title, writable calendar default
  `settings.calendar.defaultCalendarId`, all-day, local start/end, location, description); recurring instances edit the
  single occurrence, with "Edit series in Google/Outlook" linking to htmlUrl. Calendars settings: grouped by account,
  visible toggle, color override, mark read-only, add/edit/remove ICS, sync interval, default calendar, Sync now,
  last error per calendar.
- **Mail** — config `{accountIds: 'all'|string[], maxMessages: 5–20, unreadOnly, grouping: 'merged'|'byAccount'}`;
  header shows total unread; rows: account color dot, sender, subject, snippet (when available), relative time,
  unread weight; hover actions read/unread, archive (if `canArchive`), trash — optimistic with toast; click opens webUrl.
- **Todoist** — config `{filter: string (default settings.todoist.defaultFilter = 'today | overdue'), title?, showProject,
  showDue, sort: 'todoist'|'due'|'priority'}`; quick-add input; complete checkbox with Undo (reopen); project color chips;
  overdue styling.
- **Weather** — config `{location: GeoPlace|null, useDeviceLocation, show: {hourly, daily}, units: 'inherit'|'C'|'F'}`;
  location search via `/api/weather/geocode`; device location via `navigator.geolocation` (localhost is a secure context),
  named by `/api/weather/place` ("Boise", with "Idaho, United States" below it in the large tier) and shown as
  "Current location" until that answers or when it finds nothing; the forecast stays at the device coordinates.
  A page load asks the browser only when `permissions.query({name: 'geolocation'})` says `granted`; otherwise it shows
  the position remembered for 6 hours, or "Show weather for your location" with a **Use my location** button. Only that
  button, turning the option on, or Retry may make the browser prompt, so a one-time "Allow this time" does not bring
  the prompt back with every new tab. Without the Permissions API it asks only when no position is remembered.
- **Clock** — config `{format: 'inherit'|'12h'|'24h', showSeconds, showDate, greeting, extraZones: {label, tz}[]}`;
  greeting uses `general.userName` and time of day.
- **RSS feeds** (`feeds`) — config `{feeds: {url, title}[] (≤ 20), maxItems: 3–50, showSummary, showSource}`; one query
  per feed (staleTime 10 min, refetch 15 min), items merged newest first and de-duplicated by URL; failed feeds show a
  notice row with Retry while the rest keep working. Settings add a feed by URL or site address, checked by fetching it
  first (the discovered feed URL is stored). Not in the default layout (it starts empty).
- **Sports scores** (`sports`) — config `{teams: {league, id, name, abbreviation, logo}[] (≤ 16), recentGames: 0–5,
  upcomingGames: 0–5, upcomingDays: 1–30, showRecords}`; one query per team, refetched every 30 s while a game is live,
  60 s from 15 min before a start, else 10 min. Sections Live (LIVE badge, clock, situation) / Upcoming / Final, a
  game shared by two favorites shown once; a row opens the box score (the preview before the start); live and upcoming
  games have a "Where to watch" popover mapping broadcasters to official streaming services (`model.ts`). Works in the
  static build. Not in the default layout (it starts empty).

---

## 11. Extension (Chromium MV3; Chrome + Edge)

`manifest.json`: `chrome_url_overrides.newtab: "newtab.html"`, `options_page`,
`background: {service_worker: "background.js", type: "module"}`, `host_permissions: ["http://localhost/*"]`,
`permissions: ["storage", "nativeMessaging", "activeTab"]` (an unpacked extension gets them without a prompt), `action`
(the "Add this page" toolbar button), and a public
`key` (base64 DER SubjectPublicKeyInfo of an RSA-2048 key; the private key was discarded and is never committed).
The `key` pins the ID in Chrome and Edge alike to **`nbaolbakegefnefgojdokagajincnfjj`** (first 16 bytes of
SHA-256(DER) as hex, digits 0–f mapped to a–p; `extension/tools/extension-id.mjs` prints it, `--origin` prints
`chrome-extension://<id>/`). `lib/launcher.js` exports it as `PINNED_EXTENSION_ID`; `scripts/check-scripts.ps1`
fails when the key, that constant, the installer's computation and the IDs quoted in the docs disagree. The `key` is
never changed. A copy loaded from a manifest without the key gets an ID derived from its folder path; the pages detect
an extension running under any other ID (`isStaleExtensionId`) and say to **Remove + Load unpacked** once (which also
clears `chrome.storage.local`, i.e. the port). No content scripts, no `externally_connectable`; CSP
`script-src 'self'`, `connect-src http://localhost:*`; no inline scripts/handlers.

- **Settings** (`chrome.storage.local`, `lib/portly.js`): `target` (`auto`, the default, `pages` or
  `local`), `pagesUrl` (none by default — no owner's site is built in; `https:`, or `http:` on localhost/127.0.0.1/[::1];
  no credentials, `?` or `#`; normalized with a trailing `/`), `port` (default 5757). Invalid stored values read as
  the default. Next to them, `serverSite` = `{port, pagesUrl|null}`: what Portly last reported as `pagesUrl` in
  `/api/health` (its `PORTLY_PAGES_URL`), written by every healthy check (worker warm-up, new tab, options Test
  connection) only when it changed, and counted only for the port it was said on. It trusts whatever answers on the
  port exactly as the redirect to `localhost:<port>` does (§4.1 accepts port squatting); the address still passes the
  `pagesUrl` rules.
- **Where a new tab goes** (`resolveNewTab`): `local` → Portly on this PC; `pages` → the stored `pagesUrl`, else
  `serverSite`'s; `auto` → `serverSite`'s. No address (`auto` before Portly has ever answered, or a server without a
  Pages site) → Portly on this PC, whose healthy answer still sends the tab on to the `pagesUrl` it names unless the
  target is `local`. So a fresh install needs no extension settings: the server's `PORTLY_PAGES_URL`
  (`scripts/setup.ps1 -PagesUrl`) decides.
- **Service worker** (`background.js` → `lib/warm-up.js`): `runtime.onStartup` (once per profile start, not
  incognito), `runtime.onInstalled` and `runtime.onMessage` listeners are registered synchronously at the top level
  and share one in-flight warm-up: read the port (default 5757) from `chrome.storage.local`, one `GET /api/health`
  (1.5 s timeout; a healthy answer updates `serverSite`), and only if that fails one `{action:"start", port}` to the
  launcher. `onMessage` accepts only
  `{type:'portly:warm-up'}` from the extension itself (`sender.id === runtime.id`), answers `{ok:true}` at once,
  then warms up at most once per 60 s (`chrome.storage.session` key `lastWarmUpAt`, in-memory fallback); browser
  start and install always run. No polling; results are only logged (`[Portly] …`).
- **New tab, Pages site**: sends `{type:'portly:warm-up'}`, waits ≤ 300 ms for the answer
  (failures ignored), then `location.replace(pagesUrl)` — no query parameters, and no request to this PC from the
  tab itself. The Pages site finds Portly on its own (§16).
- **New tab, Portly on this PC** (`newtab.html` → `newtab.js` → `lib/newtab-page.js`): health check; on success
  record `serverSite`, then `location.replace(<its pagesUrl>)` when it names one and the target isn't `local`, else
  `location.replace('http://localhost:<port>/?src=newtab')`. Otherwise, with native messaging available, one
  `start` request, a "Starting Portly…" card, and `/api/health` polled 400 ms after each check finishes until it
  answers (redirect), the launcher reports something that cannot succeed, or 30 s pass ("Still starting…" after
  10 s). Then the fallback: "Portly isn't running", why, the matching help (install the launcher, re-install it
  for this ID, Remove + Load unpacked, or start manually), **Try starting again**, Retry with automatic re-checks
  every 5 s (12×), and a Google search box built with `encodeURIComponent`. Each attempt sends at most one launcher
  request; host text is shown via `textContent` only, one line, ≤ 200 characters.
- **Add this page** (the toolbar `action`, `lib/add-page.js`, registered at the service worker's top level): a click
  reads the tab's address and title, which `activeTab` allows without a `tabs` permission. An `http:`/`https:` address
  without credentials and ≤ 2048 characters opens a new tab next to it at `newtab.html#/add-bookmark?url=…&title=…`
  (title whitespace-collapsed, ≤ 300 characters, left out when it only repeats the address); anything else gets a "!"
  badge and tooltip on that tab. That tab opens Portly as any new tab does and appends the hash, rebuilt from its
  validated values (`forwardedHash`; any other hash is dropped), and Portly shows its Add bookmark dialog (§10.1,
  §4.4). The extension never writes a bookmark itself.
- **Options page** (`options.html` → `lib/options-page.js`): **New tab opens** (whatever Portly on this PC is set
  up for — showing what that currently is | the Pages site | Portly on this PC; saved on change), **Pages site
  address** (Save; empty or **Use the address Portly reports** removes it), integer port 1024–65535, Test
  connection (also records and shows the reported Pages site), the extension ID (with a warning for a stale one)
  and **Test launcher** (`ping`, 10 s timeout). No new permissions: messages between the extension's pages and its
  worker need none, and opening the Pages site is a plain navigation.
- **Launcher contract** (`lib/launcher.js` ↔ `native-host/launcher.mjs`, host name `com.portly.launcher`, one
  message each way via `runtime.sendNativeMessage` (callback form, `lastError` read in the callback)):

  | Request | Response |
  | --- | --- |
  | `{"action":"start","port":<1024–65535>}` | `{"ok":true,"state":"running"}` when `/api/health` on 127.0.0.1 or localhost already answers 200 `{"ok":true,"app":"portly"}`; `{"ok":true,"state":"starting"}` after a successful `schtasks /run` (or one reporting the task already runs) |
  | `{"action":"ping"}` | `{"ok":true,"state":"pong","version":1}` |
  | anything failing | `{"ok":false,"state":"error","error":"task_missing"\|"schtasks_failed"\|"bad_request"\|"bad_origin","detail":"<one short line>"}` |

  Browser-side errors: message containing "not found" → launcher not installed (install help); "forbidden" →
  `allowed_origins` does not list this ID (re-install help, or Remove + Load unpacked when the ID is stale);
  "Native host has exited." / "Failed to start native messaging host." / anything else → it may have started the
  task anyway, keep polling. `task_missing` / `bad_origin` / `schtasks_failed` / `bad_request` stop the attempt.
- Omnibox focus after redirect is a known Chrome limitation; docs/setup/extension.md records the tested behaviour
  and the alternative (`chrome.tabs.getCurrent` → `chrome.tabs.update`), and how to set Homepage/Startup page (the
  New Tab page is preferred for startup, because it waits while Portly starts).
- Tests: `extension/test/*.test.mjs` with `node --test` (`npm run test:extension`), mocked fetch, storage and
  native messaging.

---

## 12. Autostart (Windows)

User guide: `docs/setup/autostart.md` (modes, install options, status, the supervisor's log lines). This section is the
contract: what is registered, how it is started, and what must stay true.

Portly does **not** start at logon by default. It starts when Chrome or Edge opens (service-worker warm-up) and
from a new tab that finds it not running (§11). The server is only ever started by **Task Scheduler**, never as a
child of the browser or the native host: Chrome's isolated-browser mode runs native hosts in a kill-on-job-close job
object, and libuv puts Node's own children in such a job too, so anything the host spawned would die with it. The task
service creates the process outside both. Duplicate starts are harmless: the task has `MultipleInstances IgnoreNew`,
and a second server exits with code 3 when the port is taken (the supervisor then exits too).

**Scheduled task** — `scripts/install-autostart.ps1` registers the per-user task `\Portly Server`:
- `-Trigger Browser` (default): **no trigger** — runs only on demand (`schtasks /run` from the native host, or
  `Start-ScheduledTask`). `-Trigger Logon` (`-LogonDelaySeconds 0–3600`): AtLogOn of the current user (the native
  host is still registered as a fallback).
- Action `Execute = "$env:SystemRoot\System32\conhost.exe"`, `Argument = '--headless "<program>" "<repo>\server\src\supervisor.ts"'`
  with `<program>` = `%LOCALAPPDATA%\Portly\node\portly-supervisor.exe` (below), or the absolute node.exe itself when
  that copy cannot be made or does not run, `WorkingDirectory = <repo>`; principal current user, `-LogonType Interactive -RunLevel Limited` (so it only runs while
  the user is signed in and ends at sign-out); settings `New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -Priority 4
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)` (RestartOnFailure only covers launch failures; crashes are
  handled by the supervisor). On-demand start stays allowed (`AllowDemandStart`).

**Named processes** — Task Manager's Details tab and Resource Monitor name a process after its program file, so
Portly runs as copies of node.exe named for it rather than as two `node.exe` (`scripts/lib/Common.ps1`, "Portly's
copies of Node.js"):
- Folder `%LOCALAPPDATA%\Portly\node\` (`Get-HbRuntimeDir`; fixed per user like `native-host\`, not under
  `PORTLY_DATA_DIR`, and not `bin\`, which is on PATH for the `portly` command): `portly-supervisor.exe` = a byte copy of
  the chosen node.exe (`-NodePath`, a release's `runtime\node.exe`, else PATH) with its modification time, written as
  `<name>.new` and swapped in (setting the time is retried for up to 1.5 s on a sharing violation, `Invoke-HbSharingRetry`:
  Windows PowerShell 5.1 opens the file for writing to set it, and a virus scanner may still be reading the new file;
  other errors and a file still held after that are reported); `portly-server.exe` = a hard link of it (one file on
  disk), else a second copy; `runtime.json` = `{"version":1,"source":"<node.exe>","nodeVersion":"<x.y.z>"}` (ASCII).
  The supervisor starts the server as `portly-server.exe` (§3). The version resource is not changed: the Processes
  tab still says "Node.js JavaScript Runtime", and the Authenticode signature stays valid.
- Same build = same size and modification times at most 2 s apart (`Test-HbSameProgram`). `Update-HbRuntimeCopies`
  makes both current, runs `portly-supervisor.exe -p process.versions.node` (must match the source's version) and writes
  `runtime.json`; it never throws and returns `Ok`, `Usable` (an older copy in use was kept, or only
  `portly-server.exe`/`runtime.json` failed), `Changed`, `Linked`, `Version`, `Error`.
- `install-autostart.ps1` makes or refreshes them before registering the task: not usable (cannot be written, blocked by
  policy, wrong version) → the task runs node.exe itself, with a warning; usable but not current (Portly runs from
  them) → registered with the copy and refreshed again once the running processes are stopped (still not usable then →
  re-registered with node.exe). `Start-HbTask` (`update.ps1` restart, `portly --start`, the `--copy-from-homebase`
  restart, `try-branch.ps1` restore) first runs `Sync-HbTaskRuntime`: when the task's program is
  `portly-supervisor.exe` and the copies are missing or another build than `runtime.json`'s source, it refreshes them
  (quiet when current; a line when it did something or could not; `-DryRun` only says it). A browser start goes
  through `schtasks /run` only, so it does not refresh them; `status.ps1` warns when they are another build than
  their source, or when the task's program is missing. `uninstall-autostart.ps1` deletes the folder (only that one)
  after the task. `try-branch.ps1` leaves it out of its data copy.
- Trust: the folder is the user's own, like the checkout and `native-host\` (§4.1 accepted risk: everything running as
  this user is trusted).

**Native messaging host `com.portly.launcher`** (registered in both modes unless `-NoNativeHost`), per user, no
administrator rights:
- Files in `%LOCALAPPDATA%\Portly\native-host\` (fixed, so the registry never points into the repository):
  `launcher.mjs` (byte copy of `native-host/launcher.mjs`), `launcher.cmd` (from the `native-host/launcher.cmd`
  template: `@echo off` + `"<absolute node.exe>" "%~dp0launcher.mjs" %*`, `%` doubled, CRLF, ASCII or the OEM code
  page; never `start`), `com.portly.launcher.json` and `config.json` (ASCII, no BOM).
- Host manifest: `{"name":"com.portly.launcher","description":"Portly launcher (starts the Portly Server scheduled task)","path":"<absolute path of launcher.cmd>","type":"stdio","allowed_origins":["chrome-extension://nbaolbakegefnefgojdokagajincnfjj/"]}`.
  The ID is computed from the manifest `key` (or `-ExtensionId`); the installer refuses a manifest without `key`.
  `config.json` = `{"version":1,"allowedOrigins":[same origin],"installedFrom":"<repo>"}`.
- Registry: default (REG_SZ) value of `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher` and
  `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher` = absolute path of the host manifest
  (user-level hosts are allowed unless policy `NativeMessagingUserLevelHosts` forbids them).
- Runtime: the browser starts `%ComSpec% /d /s /c ""<launcher.cmd>" chrome-extension://<id>/ --parent-window=<n>"`
  with a hidden console. `launcher.mjs` checks the origin argument against `config.json` before reading stdin
  (`bad_origin`), reads one frame (4-byte little-endian length + UTF-8 JSON, ≤ 64 KB, 5 s), validates it
  (`bad_request`), answers `ping`, probes `/api/health` on 127.0.0.1 and localhost (700 ms), and otherwise runs
  `%SystemRoot%\System32\schtasks.exe /run /tn "\Portly Server"` by absolute path, no shell, fixed arguments,
  hidden window, 10 s timeout. "already running"/`0x8004131F` → `starting`; "cannot find the file specified"/`0x80070002` → `task_missing` (English Windows;
  other languages report `schtasks_failed` with the translated first line); other failures → `schtasks_failed`.
  It writes exactly one frame, appends one line to `launcher.log` (rotated at 64 KB) and exits 0. Nothing from the
  message reaches a command line; the worst a caller can do is start Portly.

**Install and uninstall order:** `install-autostart.ps1` validates first (Node 24+, dependencies, `PORTLY_*` via
`server/src/config.ts`, manifest key; `-DryRun` prints the task, every file with content, both registry values and the
copies' state, and exits 1 if something must be fixed), builds `web/dist` if missing, makes or refreshes the named
copies, registers the task, writes the host files and keys, stops processes started from this repo's supervisor (then
refreshes the copies if they were in use), and unless `-NoStart` starts the task and waits for `/api/health`. Running
it again updates everything. `uninstall-autostart.ps1` removes the host keys and folder **first** (so no browser can
restart the task meanwhile), then stops the task and its processes, unregisters it and deletes
`%LOCALAPPDATA%\Portly\node`; the data folder is never touched. Processes are found by command line (`supervisor.ts`
of this repo, whatever the program; not the `conhost.exe` host) and their children. `status.ps1` reports the task, both
host registrations, the last launcher request, processes and health (autostart.md, "Check on it"). Every Node child
spawn uses `windowsHide: true`. No VBScript, no `-WindowStyle Hidden`.

**Tests never touch Task Scheduler or the registry:** `npm run test:native-host` (`scripts/check-native-host.mjs`) unit-tests
the launcher with injected fakes and runs the generated `launcher.cmd` exactly as Chrome does with
`scripts/tests/schtasks-stub.mjs` preloaded through `NODE_OPTIONS` (it replaces `child_process.execFile` and fails
closed); `scripts/check-scripts.ps1` adds parse/ASCII/CRLF checks, task definitions, installs into a temp folder with a
fake registry, the named copies in a temp folder (made, linked, refreshed, kept while held open, refused when they do
not run), and the `-DryRun` outputs, and asserts the real task, keys and folders are unchanged.

---

## 13. Quality bar & test harness

- `npm run typecheck`, `npm test`, `npm run build` must pass. No live network in tests. No secrets in the repo.
  `.github/workflows/ci.yml` runs them, `npm run build:static`, `scripts/check-scripts.ps1` and
  `scripts/check-release.ps1` (a test package) on `windows-latest` for every push to `main`, every pull request and
  on request (`workflow_dispatch`, from the Actions tab) (Windows because DPAPI, Task Scheduler and the `launcher.cmd`
  tests need it; not on other branch pushes, to spare private-repository minutes).
- Test harness: `server/src/testing/test-context.ts` — `createTestContext(overrides?)` → AppContext with `:memory:`
  DB (migrations applied), in-memory vault (fixed key, no DPAPI), fake fetch, `FakeAccountService` (canned tokens and
  secrets), manual scheduler (`runDue()`), a test logger (`createTestLogger()`: rings and `lines()`, no file or
  console) as both `log` and `logs`, the real health tracker on that database and a fresh `runtime`. `test-request.ts` — `testRequest(app, method, path, {body?, headers?})`
  sets `Host: localhost:5757`, `X-Portly: 1`, `Sec-Fetch-Site: same-origin`, JSON content type. `fake-fetch.ts` —
  `createFakeFetch([{match: string|RegExp, method?, respond: {status, json?|text?|body?, headers?}}])`; unmatched URL
  fails the test. `web/src/test/render.tsx` — `renderWithProviders(ui, {apiMocks})`. Fixtures in `<module>/__fixtures__/`.
- UI tests must also pass in a full run on a busy machine. Waits (`findBy…`, `waitFor`) get 4 s and a test 60 s
  (`web/src/test/setup.ts`). A test that waits for a lazily loaded component (a settings section, a widget's
  settings, a dialog) imports its module first (`await import(…)`), because the first load of that code can take
  longer than 4 s. A test about a debounce types without pauses (`userEvent.setup({ delay: null })`), and one
  about a short real-time window (the launch pad's 400 ms delete guard) checks it right after the action.
- Required server tests: gate (host, header, origin, sec-fetch-site, path normalization, exemptions), headers, vault
  round-trip + locked states (corrupted key, missing key with secrets), migrations, settings merge-patch incl.
  prototype-pollution payloads (`({}).polluted === undefined` afterwards), safe-fetch (lookup returning public then
  private, IPv4-mapped IPv6, decimal/octal literals, 302 → 127.0.0.1, gzip bomb), OAuth state/PKCE/consume/upsert,
  favicon HTML parsing, ICS parse/expand incl. RECURRENCE-ID overrides, Windows TZIDs, FREQ=SECONDLY, the feed cap
  (`maxVevents` 5,000 in `ical/expand.ts`: 5,001 and 100,000 VEVENTs fail the job) and the events-cache cap
  (`MAX_STORED_EVENTS` 100,000 rows / `MAX_STORED_EVENT_CHARS` 64 × 1024 × 1024 characters of text in
  `calendar/store.ts`, recorded as `STORAGE_LIMIT_ERROR`), provider response mappers (fixtures), IMAP id/UIDVALIDITY
  handling, Todoist mapping.
- The production build runs without CSP violations. No automated step covers this: it is checked by hand before
  every release, for both `web/dist` and `web/dist-static` ([Releases](setup/releases.md#cutting-a-release), step 3).
  Last checked 2026-10-28 on the 0.2.0-alpha.1 release branch (6ac3731, and 9240123's Add widget text), in
  Chromium and Edge: zero violations in both builds.

---

## 14. Build plan & parallel rules (retired)

The parallel build plan was for the first build of Portly. That build is finished and the plan is in git history;
the section number is kept so later section numbers stay stable. Rules for working in the repository are in
`CLAUDE.md`.

---

## 15. File ownership (retired)

The file ownership list split the first build between parallel builders. That build is finished and the list is in
git history; the section number is kept so later section numbers stay stable.

---

## 16. Hybrid mode (Pages site + Portly on this PC)

The browser-only build (`npm run build:static`, published on GitHub Pages; in-browser backend in `web/src/static/`,
user guide `docs/setup/static-build.md`) can use the Portly server running on the same PC. Decisions: when this
browser is paired with that server and the server answers, the Pages site uses the server for **everything**, exactly
like the server's own page; otherwise it uses its in-browser copy. The two datasets are separate (no sync). Pairing
happens once, on the server's own page. Everything else, account sign-in, OAuth client setup and the vault reset
included, happens on the Pages site: there is one page. The server's own page forwards to the Pages site (keeping the
query and hash, so the OAuth callback's `?oauth=` result arrives there) unless it is approving a pairing (`#/pair`),
approving other PCs (`#/settings/devices`, §20: the Pages site may not, and on a PC with a Pages site this is the only
way to that section; the site links to it), showing diagnostics (`#/settings/diagnostics`, §17: full diagnostics on
this PC must open even when the Pages site or the connection to it is what is broken) or the Pages site can't be
reached, when it serves the app as the offline
fallback (`web/src/app/pagesForward.ts`; the HTML CSP's `connect-src` allows the Pages origin for that check). User
guide: `docs/setup/pages-local-server.md`.

**One backend per page load.** In the Pages build each page load picks `browser` or `server` before the first render
and keeps it, so no request of one dataset can reach the other and capabilities are per-load constants. When the right
backend changes, the page persists what the next load needs and **reloads**: a hidden tab once it is visible again,
after one more probe that confirms the switch (or withdraws it), so a pairing change does not reload every background
tab at once; a visible idle tab at once, with a toast after the reload (sessionStorage `portly:mode-switch-toast` =
`<target>:<reason>`); a busy tab
— a modal dialog open (`[role="dialog"][aria-modal="true"]`, which `ui/Dialog.tsx` sets, or `dialog[open]`), edit
mode (`<html data-portly-editing="true">`, set by `grid/editMode.tsx`) or a focused text field with text in it (an
empty, autofocused search box is not busy) — exposes `pendingSwitch` (banner with **Switch now**) and re-checks every
2 s. A switch reloads by itself only when the hints it writes make the next load pick its target: if storage refuses
them (quota), it stays pending (**Switch now**) and retries every 2 s instead of reloading into the same backend. The
hints are written again right before the reload (other tabs may have changed them), and the toast only when the
switch takes effect; the next load drops a toast that names the other backend. The server build is always `server`
and never reloads for this.

**Boot (`main.tsx` → `localServer/boot.ts`, Pages build):**
1. `consumePairingReturn()` first: on `#/paired?…` the nonce must equal sessionStorage `portly:pairing-nonce` (one
   use); the record is saved, `lastServerSeenAt = now`, the address is replaced with `#/`.
2. No pairing record → remove the server snapshot key and the mode hints (revoke/disconnect leftovers, including late
   throttled cache writes).
3. Backend = `server` iff hybrid mode is on, the page is not framed, it is paired, and `lastMode === 'server'` or (no
   decision yet and the server was seen in the last 10 min); else `browser`. A `browser` decision written after a
   grace wins over a recent sighting (no reload loop).
4. `setPageBackend()`, create the controller (no module top level reads storage), plug it into the store and the
   transport; a server-backend page also gets the server image source.
5. The browser backend opens IndexedDB (a load that will stay in the browser fetches its code alongside the
   boot chunk), the server backend never does; then paint the persisted theme of that backend's snapshot (whatever its
   age; on the server backend only with that instance's buster), so stored images already resolve to `blob:` URLs;
   restore the snapshot; render; start probing.

**Capabilities (`web/src/capabilities.ts`)** — `getCapabilities()` returns frozen per-load flags: `pagesBuild`,
`backend`, `remoteServer` (Pages + server), `remoteClient` (the server build opened from another PC, §20), `accounts`
and `calendar` (every backend: on the browser backend Outlook.com signs in and its calendars sync from Microsoft Graph
in the page, `web/src/static/handlers/accounts.ts`, `calendar.ts`), `appPasswordAccounts|icsSubscriptions|mail|feeds|
vault|siteMetaFetch|serverSearchSuggestions` (server backend), `googleAccounts` and `browserBookmarkImport` (server
backend on the main PC only: off when `remoteClient` is on), `browserBackups` and `launchpadSync` (browser backend: the
launch pad sync service is offered on Microsoft connections only where the launch pad lives in this browser,
[design/launchpad-sync.md](design/launchpad-sync.md); its state and **Sync now** are `GET`/`POST /api/sync/launchpad[/now]` of the
in-browser backend, one sync connection per browser, design 6.10), `iconPolling` (server backend). UI code reads it at render or call time, never at module top level; "data lives in this browser" is
`backend === 'browser'`, not the build flag. Every settings section shows on every backend. Server-only widgets (mail,
feeds) on a browser-backend page show `ServerOnlyNotice` ("needs Portly running on this PC" + Look for it / Pair this
browser / Switch now / Check again). Without `serverSearchSuggestions` an engine whose suggestions only the server can
ask (Google, DuckDuckGo, Bing, YouTube) shows none and no request is made, unless this browser turned on **Wikipedia
suggestions instead** in Settings → Search (`widgets/search/wikipediaFallback.ts`, localStorage
`portly:wikipedia-suggestions-instead`, off by default, kept out of the strict `SearchSettingsSchema` like
`portly:frosted-glass`). Then the widget asks Wikipedia (the one provider that answers a browser) and labels the list
"Wikipedia suggestions" (`widgets/search/engines.ts` `reachableSuggestProvider`; the stored provider is unchanged, and
Settings → Search says which applies). The browser backend's first-run layout (`grid/defaultLayout.ts`) has no mail or calendar widget and
still fills its 12 × 15 cells: the weather runs down the right-hand side, Todoist sits under the launch pad. Account
setup works the same on the server backend from either build (one page).

**Controller (`localServer/controller.ts`, every side effect injected, unit-tested under fake timers).** State
`{backend, status, server: {version, instanceId, appUrl, apiVersion, vault}|null, paired, checkedAt, pendingSwitch,
permission, manual}`; the UI reads it through `localServer/store.ts` (`useLocalServer()`, `localServerActions`:
`checkNow`, `lookForServer`, `startPairing`, `disconnect`, `switchNow`; an inert `disabled` default in the server
build and tests). Statuses: `disabled` (hybrid off), `framed`, `idle` (not checked), `checking`, `absent`, `blocked`
(permission denied), `waiting-permission`, `unpaired`, `revoked`, `other-server`, `incompatible`, `connected`,
`reconnecting`.
- *Probe*: `GET <origin>/api/health` as a simple CORS request (no custom header, so no preflight; `cache: 'no-store'`,
  `credentials: 'omit'`, `targetAddressSpace: 'loopback'`), then for a paired server with the same `instanceId`
  `GET /api/pairing` with the token. Answers are untrusted (shared schemas, read tolerantly), and `appUrl` survives
  only as an http(s) loopback root page (`localServer/urls.ts`). After a failed CORS probe with the permission
  `granted` (or no permission API), one `GET /api/health` with `mode: 'no-cors'` (same `targetAddressSpace`, carries
  nothing): an opaque answer means something answers on the port but not to this site — state
  `unreachableReason: 'answers-without-cors'` (its `PORTLY_PAGES_URL` names another site, or it predates hybrid
  mode); the status stays `absent`/`reconnecting` and Settings → Diagnostics explains it (§17). Once a `no-cors`
  request found nothing, the probes of the next 5 min skip it (`NO_CORS_RECHECK_MS`; a manual check does not), so a
  stopped server costs one failed request — one error in the browser's console — per probe instead of two; one that
  got an answer is repeated every time (an opaque answer is no console error).
- *When*: never while disabled/framed; not paired → only after the Local Network Access permission (`loopback-network`,
  older `local-network-access`) is `granted`/unsupported, on boot, focus and visibility (while `absent`, at most once
  every 5 min: `ABSENT_EVENT_PROBE_MS`, so a PC without Portly does not log a failed request each time the tab comes
  to the front), or when the user clicks **Look for Portly on this PC**; paired → on boot, then every 30 s while
  connected (skipped while requests got answers in the last 30 s), every 2 s while reconnecting, else backoff
  5→10→20→30→60 s, reset by visibility, focus, `online`, permission or pairing changes and **Check again**; while the
  tab is hidden, scheduled probes come at most once a minute (`HIDDEN_PROBE_INTERVAL_MS`: still often enough for the
  grace to count from when the server went away), and a tab probes at once when it is visible again. One probe at a
  time; with the permission at `prompt` only while visible.
- *Permission prompt*: the browser shows it only after a TCP connection succeeds and the request stays pending while it
  is open, so a probe is never aborted while the permission may be `prompt`: after 3 s the status becomes
  `waiting-permission` (grace paused). Otherwise a probe times out after 5 s, which is inconclusive when the server
  answered anything in the last 30 s.
- *Outcomes* (browser backend / server backend): unreachable → `absent` / `reconnecting`; denied → `blocked` /
  switch to browser; other `apiVersion` → `incompatible` / switch; healthy, not paired → `unpaired` / switch; other instance →
  `other-server` (the token is never sent) / switch; pairing accepted → `connected` and switch to server /
  `connected` (a pending switch is withdrawn only for the instance the page booted with; another instance, paired
  since in another tab, has other data and switches with `other-server`); 401 → `revoked`, compare-and-clear the
  record / and switch. A server-backend page `reconnecting` for 45 s (`GRACE_MS`, permission waits excluded; a hidden
  tab re-probes when visible first) switches to the browser, writing `lastMode = 'browser'`, once no tab has seen the
  server within the grace; while another tab has, it keeps reconnecting. Every healthy probe of the paired server
  writes `lastServerSeenAt` (≤ once a minute) and `lastMode = 'server'`.
- *Pairing*: `startPairing()` needs a fresh healthy probe, stores a new nonce (32 random bytes) in sessionStorage and
  navigates this tab to `<appUrl>#/pair?nonce=…` (§10.5). `disconnect()`: best-effort `DELETE /api/pairing` (3 s in
  all), sent only after `GET /api/health` shows the paired `instanceId` (otherwise the pairing is cleared locally
  only), compare-and-clear, remove the server snapshot, `lastMode = 'browser'`, reload. Other tabs follow through `storage`
  events.

**Transport (`localServer/transport.ts`).** `api()` calls `pagesFetch(path, init)` in the Pages build (dynamic import,
so the server bundle never contains it). Browser backend → `staticFetch`. Server backend → wait for
`whenServerReady(signal)` (resolves when connected, waits while checking/reconnecting/waiting for the permission,
rejects with `ServerModeEndedError extends TypeError` once a switch to the browser is requested — `api()` maps it to
`network_error`), then `fetch(<origin><path>)` with `mode: 'cors'`, `credentials: 'omit'`, `X-Portly: 1`,
`X-Portly-Token` and `targetAddressSpace: 'loopback'`, with no extra timeout. Any response reports liveness; a
`TypeError` from that fetch makes the controller probe; so does 401 `pairing_required`, since another Portly may
answer on the port now: only the paired instance refusing the token (`revoked`) clears the record, another instance
gives `other-server` and keeps it. `/api/backups*` (the
browser backend's own pre-import backups) answer 404 without a request.

**Images (`localServer/assets.ts`, `static/assets.ts`).** `<img src>`/CSS `url()` cannot carry the token, and the raw
`/api/icons|uploads/<id>` path would ask GitHub. A server-backend page fetches each image through the transport
(`cache: 'default'`; the server sends `private, max-age=86400`), at most 3 at once, raster types as `blob:` URLs of the
checked type, SVG only as a `data:` URL (a same-origin SVG document could run script), 404s remembered, other failures
retried (by the next request and by the cache itself, until the page leaves the server). `getAssetUrl` is null and
`resolveAssetUrl` a transparent pixel until loaded; components use `useAssetUrl`. The Pages CSP's `img-src`
needs nothing more for them (`blob:` and `data:`, §4.3); `connect-src` gains the local server origin.

**Storage (all keys namespaced by the Pages base path `<base>`; every access guarded, everything read validated):**

| Where | Key | Content |
| --- | --- | --- |
| localStorage | `portly:pairing:<base>` | `{token, instanceId, pairedAt}` |
| localStorage | `portly:backend-mode:<base>` | `lastMode`: the backend the last decision chose |
| localStorage | `portly:server-seen:<base>` | `lastServerSeenAt` (epoch ms) |
| localStorage | `portly:query-cache:static:<base>` | browser backend snapshot, buster `<version>+static`, 24 h |
| localStorage | `portly:query-cache:local-server:<base>` | server backend snapshot, buster `<version>+local-server:<instanceId>`, 7 days; never `accounts`, `oauth-clients` or mail |
| sessionStorage | `portly:pairing-nonce` | the nonce of this tab's pairing request (one use) |
| sessionStorage | `portly:mode-switch-toast` | the switch to announce after the reload |
| IndexedDB | `portly-static:<base>` | the browser backend's data (never opened by a server-backend page) |
| localStorage | `portly:diagnostics:events:<base>` | this browser's diagnostic events (§17; the server build: `portly:diagnostics:events`) |
| localStorage | `portly:diagnostics:events:<base>:upload-pacing` | the event uploads of the last minute, shared by every tab |

The query client's persist options are per client and decided by the first restore or render; on a quota error the
*other* backend's snapshot is dropped before trimming the active one. The first-run seed lock is per backend.

**Diagnostics (§17).** Every server answer carries `X-Request-Id` (exposed to the Pages origin); `ApiError.requestId`
keeps it, and a failed request's `api` event keeps it as `rid`, so the browser's event and the server's lines of that
request share one id (`transport: 'pages-server'`). The controller (`diag` dependency, wired by `boot.ts`) records
`hybrid` events: `hybrid status changed {from, to, reason}`, probe results `{kind, httpStatus, ms, timedOut, errName,
permission}`, pairing-check failures and `pairing revoked by Portly on this PC`, reconnect grace started/ended,
backend switch requested/deferred/performed/withdrawn `{target, reason}`, permission changes; a page load's first
status is debug when it repeats the one last reported in this browser. The events survive the reload of a switch
(localStorage) and are uploaded only by a page load whose backend is the server; a browser-backend page keeps them
(This browser, the report). The server logs a Pages request's lines with `from: 'pages'` and its `pairingId`, a refused
token with its sub-reason (`token_revoked {pairingId, removedBy}` …), and a GitHub Pages, loopback or same-domain site
it does not answer as a foreign origin (`health check from another site (no CORS answer)`). All diagnostics routes are
`paired()`, so a paired site shows the full Diagnostics page; `#/settings/diagnostics` on Portly's own page never
forwards, and the site links to it ("Open diagnostics on this PC", `<LOCAL_SERVER_ORIGIN>/#/settings/diagnostics`)
once something answers on this PC (a status from `unpaired` to `reconnecting`, or `answers-without-cors`): while
nothing does, the link would open an error page, so it is not shown.

**Build.** `PORTLY_STATIC_SERVER` (default `http://127.0.0.1:5757`; `off` disables; only http(s) origins on
`localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, anything else fails the build) → `__PORTLY_LOCAL_SERVER__`
(`''` in the server build and in both vitest web projects). The footer indicator shows the status's label ("Not
checked", "Connected · v0.1.0", …), except "Browser only" for `absent` (the panel's badge still says "Not detected").
The hybrid-only UI (footer indicator, local server panel,
pairing page) is loaded on demand, so the server build's main chunk does not carry it.

**Extension** (§11): by default new tabs open the Pages site the server reports (`pagesUrl` in `/api/health`) and
only ask the service worker to warm Portly up; the site finds the server itself. A server without `PORTLY_PAGES_URL`
gets Portly's own page instead.

---

## 17. Diagnostics

Goal: find out why something does not connect, sync or update — server start-up, accounts and OAuth, calendar, mail,
Todoist, feeds, weather, search suggestions, sports, favicons, hybrid mode and the browser's own API failures — with
as much detail as possible, but a short log by default (*Normal*) and everything on request (*Verbose*, §3). The
privacy rules of §3 (**Never logged**, scrubbing) apply to every piece below: log files, memory rings, health
entries, the report and browser events. User guide: `docs/setup/troubleshooting.md` (Diagnostics page and logs, and
one section per health code).

**Health tracker (`lib/health.ts`, `003_diagnostics.sql`).** The latest outcome of every synced subject, and the
only source of failure, recovery and reminder lines for them (modules record outcomes and log debug detail only).

| Key | Subject (recorded by) | Stale after |
| --- | --- | --- |
| `account:<accountId>` | the account: status, credentials, token refresh, every kind (`accounts/store.ts` `applyAccountStatus`, the only writer of `accounts.status`; code = the status reason) | never (on demand) |
| `calendar-list:<accountId>` | the account's calendar list (calendar sync) | 3 × sync interval |
| `calendar:<calendarId>` | one provider calendar; detail `{mode, fetched, upserted, deleted}` | 3 × sync interval |
| `ics:<calendarId>` | one ICS subscription; detail `{host, finalHost, blockedHost, status, bytes, notModified, …counts}` | 3 × 30 min |
| `mail:<accountId>` | the inbox listing; detail `{stage, count}` (IMAP: the session phase that failed) | never |
| `todoist` | the Todoist token and API | never |
| `feed:<sha1(url), 10 hex>` | one RSS/Atom feed (a settings check only when it succeeds); label = host; detail `{status, bytes, items, finalHost, contentType}` | never |
| `weather` | Open-Meteo; detail `{op: geocode\|forecast}` | never |
| `weather-place` | Nominatim (the device location's name); detail `{op: reverse}` | never |
| `suggest:<provider>` | a search suggestion provider | never |
| `sports:<league>` | ESPN for one league; detail `{op: teams\|schedule\|scoreboard, status}` | never |
| `job:<name>` | every scheduler job (the scheduler itself) | 3 × job interval |

- **Statuses:** `ok`; `degraded` (ok but partial: `storage_limit`, `truncated`, a failed best-effort sports read);
  `failing`; `unknown` (never checked); `stale`, derived at read time — `expectEveryMs` is set and the subject was not
  checked for longer, or it is `ok` while the job that checks it (`calendar:sync` for `calendar-list:`/`calendar:`,
  `calendar:ics` for `ics:`, the job itself for `job:`, else the only job of its area) is overdue or stuck.
  On-demand subjects (`expectEveryMs` null) are never stale.
- **Outcomes:** `record(subject, outcome)`; failures only through `outcomeFromError(err, extra)`: `code` =
  ProviderHttpError denial (`api_disabled`, `insufficient_scope`, `denied`) → a `details.reason` that is a health
  code → SafeFetchError `reason` refined by its cause chain (`timeout`, `dns`, `refused`, `reset`, `tls`, `blocked`,
  `not_lan`, `too_large`, `parse_error`, `network`, `redirect`, `bad_url`) → `vault_locked` → the HttpError code (`reauth_required`,
  `rate_limited`, `timeout`, `not_configured`, `not_found`, `too_large`, provider errors by upstream status:
  `not_found`, `rate_limited`, `http_4xx`, `http_5xx`) → named errors (`not_a_feed`, `parse_error`, `too_large`,
  `worker_failed`, `auth_failed`, `timeout`) → transport codes → `internal`; `status` = upstream HTTP status;
  `message` = Portly's own text (HttpError/ExpandError/DavParseError), else the error name; `detail` = the loggable
  error fields; `nextAttemptAt` from Retry-After. Codes are `HEALTH_CODES` (each has a remedy in the UI and a section
  in troubleshooting.md) or another machine token (`REASON_TOKEN`; e.g. a provider's
  reason). Content rules, enforced by `record`: message Portly-authored, scrubbed, ≤ 300; code a token;
  detail values numbers, booleans, or ≤ 64-character tokens, hostnames or media types; anything else is dropped and
  the dropped names debug-logged. A subject that fails because its account is unusable records
  `account_unavailable` with `causeKey: 'account:<id>'` at severity info. Skipped work (`touch`: `backoff`,
  `vault_locked`, `missing_url`, `disabled`, `account_unavailable`) updates `lastCheckedAt` without a transition.
  Subjects are forgotten with their calendar or account (`forget`, `forgetAccount`). `record` never throws.
- **Transition lines** (call field `area` = the subject's, plus `key`, `accountId`):

  | Transition | Line | Level |
  | --- | --- | --- |
  | ok/unknown → failing, or a failure with another code or status | `<area> failing {key, code, status, message, consecutive, causeKey, nextAttemptAt, …detail}` | warn (jobs error, dependent subjects info) |
  | failing → failing, same problem | `<area> still failing {key, code, consecutive}` | debug; info at most every 6 h, and for the first record after a restart that matches the stored failure (a restart is not a new failure) |
  | → degraded / still degraded | `<area> degraded {key, code, status, message, causeKey}` | info (repeats as for failing) |
  | failing or degraded → ok | `<area> recovered {key, downForMs, failures}` | info |
  | ok → ok | `<area> ok {key, ms, …detail}` | debug |

- **Persistence:** memory and the line are updated synchronously; writes are queued and flushed in a microtask in one
  transaction, after the caller's own (re-queued while one is open). `diag_health` (one row per key, incl.
  `last_reminder_at`) is upserted on every transition, otherwise at most once a minute per key; `diag_outcomes` gets
  a row per transition and per failure, identical consecutive failures (key, status, code, HTTP status) collapsing
  into the latest row (`count`, `last_at`). Persistence errors → at most one `warn 'health persistence failed'` a
  minute. Shutdown flushes and closes it before the database. **Retention** (daily job `diagnostics:purge`, first run
  15 min after start): outcomes older than 30 days or beyond the newest 5,000; subjects not updated for 30 days
  (`feed:`/`suggest:` 7 days); an ended persisted Verbose period. A `feed:`/`suggest:` subject nothing checked for a
  day is *inactive* (`isInactiveSubject`): the summary and the `status` line leave it out until it is checked again,
  so a feed removed from its widget stops showing "Failing" long before the purge.
- **Related log lines:** `contextFieldForKey(key)` — `account:`, `mail:`, `calendar-list:` → `accountId`;
  `calendar:`, `ics:` → `calendarId`; `feed:` → `feed`; `job:` → `job`; others → their area. Modules run each unit of
  work in `withLogContext({area, accountId?, calendarId?, feed?, op?})` so that filter finds its lines.

**Scheduler (`lib/scheduler.ts`).** Every run is a unit of work `withLogContext({job, run, area: <prefix before
':'>})` (a `runNow()` from a request keeps that request's `rid` for the awaited run only; timers are armed outside any
context). Success → `debug 'job finished' {job, ms}` and `job:<name>` ok; failure → `job:<name>` failing at error with
the next attempt (`debug 'job failed'` with the error fields). `jobs()` → per job: `intervalMs, nextRunAt, running,
runningSince, runs, failures, consecutiveFailures, lastStartedAt, lastFinishedAt, lastMs, lastOk, lastError {name,
code, message}` (message = Portly's own text or the error name), `overdue` (not running and the next run is late by
more than max(60 s, interval / 10)) and `stuckForMs` (running longer than max(2 min, interval)). Watchdog:
`warn 'job still running' {job, run, runningForMs, lastRecord}` after 2 min, then every 10 min (`lastRecord` = the
last line that run logged). `idle(ms)` waits for every run in flight (shutdown); `trigger(name)` runs a job now.

**Requests, errors, gate, outbound.**
- **Request line** (`app.ts`, the outermost middleware): a request id (10 characters `[a-z0-9]`) → `X-Request-Id` on
  every answer; the request runs in `withLogContext({rid, area})` (area = the module owning the path,
  `/api/diagnostics` → `diagnostics`, else `server`) and in `runtime.inflight`; still running after 15 s → one
  `warn 'request still running'`; then one `request {method, route, path, status, ms, code, from: local|pages|remote,
  pairingId, deviceId, aborted}` (`route` = the matched pattern, `path` without query). Levels: 5xx warn; API GET/HEAD below
  400 debug (info past 3 s); other API answers (mutations, any 4xx) info; OPTIONS and non-API debug. *Quiet*
  requests — `GET /api/health`, `GET /api/diagnostics/*`, `POST /api/diagnostics/client-events` — are debug and stay
  out of the rings below 500. GET lines are repeat-collapsed per route, status and code.
- **Errors** (`lib/errors.ts`): the answer's code is noted for the request line; an unexpected error →
  `error 'request failed'` with `errorFields` and the stack's frame lines; an expected one ≥ 500 → `warn 'request
  failed'` (repeat-collapsed per route and code); 4xx → `debug 'request rejected' {code, accountId?, issues, paths
  (first 5 field paths, never values), errReason?, upstreamStatus?}`.
- **Gate refusals** (`security/gate.ts`): `info 'request refused by gate' {method, path, status, reason, origin?,
  secFetchSite?}`, repeat-collapsed per reason and origin. `reason`: `bad_path`, `host_not_allowed`,
  `preflight_refused`, `local_only`, `x_portly_missing`, `cross_site`, `content_type`, `origin_not_allowed`,
  `bad_content_length`, `too_large`, `proxied_local_host` (§20), and for a Pages token `token_missing`,
  `token_malformed`, `token_unknown` (never issued by this server), `token_revoked {pairingId, removedBy}`,
  `token_origin_mismatch {pairingId}` (made for another Pages address) — never the token; for a device cookie (§20)
  `device_missing`, `device_malformed`, `device_unknown`, `device_revoked {deviceId, removedBy}` — never the cookie.
  Origins are logged only when they are ours, the Pages site's, the remote origin or a named foreign one; a browser
  extension's only as its scheme (`chrome-extension:`). A paired Pages request's route runs with `pairingId` in its
  log context, a device's with `deviceId`; the request line says `from: local|pages|remote` with the `deviceId`.
- **Pairing tombstones** (`security/pairing.ts`): a removed pairing leaves `{pairingId, removedAt, removedBy:
  revoked | unpaired-itself | evicted | unused}` under its token hash — 50 in memory, the last 20 in `server_meta`
  `pairing.tombstones` — so `explain(token)` (`ok | malformed | unknown | removed`) tells a token removed on this PC
  from one never issued. Lines: `pairing created {pairingId, label}`, `pairing removed {pairingId, by}`, `unused
  pairings removed {count, pairingIds}`, `least recently used pairings removed to make room {count, pairingIds}`,
  `instance id created {replacedInvalid}`.
- **Devices** (§20; `security/devices.ts`, `modules/devices`): `device request created|approved|denied
  {deviceRequestId}`, `device connected {deviceId, deviceRequestId}`, `device connected again` (a lost answer
  retried), `device removed {deviceId, by: revoked|disconnected}`, `device expired {deviceId}`, `idle devices expired
  {count, deviceIds}`, `least recently used devices removed to make room {count, deviceIds}` — ids only, never the
  name the PC gave itself, the code or a cookie. The log filters accept `deviceId` like `pairingId`. The name
  suggestion (`lib/peer-names.ts`) logs `peer name lookup failed {reason}` and `peer name lookup skipped {reason}` at
  debug and, at start, that Tailscale is not installed; never the address asked about or the name found.
- **Foreign origins** (`security/foreign-origins.ts`): an `/api` request (health included) whose `Origin` is an
  http(s) origin that is neither allowed nor the configured Pages origin. *Named* — a `*.github.io` site, a loopback
  origin, or one under the registrable domain of `PORTLY_PAGES_URL` — it is kept (≤ 5, least recently seen dropped)
  and logged `warn 'request from a site that is not the configured Pages site' {origin, pagesOrigin}`, for
  `/api/health` `warn 'health check from another site (no CORS answer)'` (repeat-collapsed per origin): how a
  missing or wrong `PORTLY_PAGES_URL` shows. Any other origin is only counted (`foreignOriginRequests`), never
  named.
- **Outbound** (`security/safe-fetch.ts`): callers pass a `purpose` (`<provider>.<op>`: `gcal.events.list`,
  `graph.calendars`, `gmail.get`, `oauth.refresh`, `ics.fetch`, `todoist.filter`, `weather.forecast`,
  `suggest.<provider>`, `espn.scoreboard`, `favicon.page` …). One `outbound {method, host, policy, purpose, status,
  ms, bytes, redirects?, finalHost?, retryAfter?, rateLimitRemaining?}` per call: debug, info for a
  provider/user-server status ≥ 400 (repeat-collapsed per host, purpose and status). A transport failure →
  `outbound failed {…, reason, cause, causeCode, hops, blockedHost?}` (warn; `public` calls debug); a caller's abort
  → `debug 'outbound aborted'`. `SafeFetchError` keeps the transport error as `cause`, so health tells DNS, refused,
  reset, TLS and not-LAN failures apart. `inflightOutbound()` lists calls in progress with their run or request id.
- **Modules** add only specific lines: `account status changed {accountId, kind, from, to, reason, source}`,
  `provider rejected a freshly refreshed token`, `calendar event written {op, source, accountId, calendarId, status,
  ms, …}`, `event written by Portly is missing from the provider listing`, `calendar worker failed`, `mail action
  {op, accountId, ms}`, debug `favicon resolved`/`favicon miss`; everything else is health transitions and debug
  detail.

**Diagnostics module (`modules/diagnostics/`; every route `paired()`, so the paired Pages site — the main UI — can use
all of it).**

| Route | Answer |
| --- | --- |
| `GET /api/diagnostics/summary` | `DiagnosticsSummary`: `server {version, boot, pid, startedAt, uptimeMs, node, platform, memory, supervised, restart {attempt, lastExit}, dataDir, logDir}` (the two directories blank for a Pages request, see §7 `/api/about`), `logLevel`, `modules`, `vault`, `hybrid {pagesOrigin, pairings, lastPairedRequestAt, foreignOrigins, foreignOriginRequests}`, `inFlight {count, oldestMs, routes (≤ 10), outbound}`, `jobs`, `health` (labels resolved at read time — account label, calendar name, league name, job name — and `stale` derived), `counts` (warn/error of the last hour, server and browser; distinct warning keys; records in memory) |
| `GET /api/diagnostics/logs?scope=memory\|files&…` | `LogsResponse {records, lastSeq, truncated, scope}`. `memory`: the rings, merged by `seq` (`after=<lastSeq>` for polling). `files`: `server.log` and `.1`…`.5`, all opened first, read backwards in 64 KB chunks (≤ 20 MB per scan); text lines from before JSON Lines are read best-effort; every record is scrubbed again; `seq` 0. Filters: `since`/`before`, `level` (minimum), `area` (any tag), `src`, `rid`, `job`, `run`, `accountId`, `calendarId`, `feed`, `pairingId`, `key` (a health key → its context field), `q` (substring of message or fields), `limit` ≤ 2,000 |
| `GET /api/diagnostics/health/:key/history?limit=` | the subject's outcome rows, newest first (default 50, at most 500) |
| `PUT /api/diagnostics/level` | `{verbose, minutes: 1–10080 \| null, areas: [...] \| null}` → `LogLevelState {level, verbose, until, areas, bootLevel, persisted}`. Timed → `server_meta` `diagnostics.verbose` `{until, areas}`, switched back on after a restart; `minutes: null` (until turned off) → only the marker `diagnostics.verbose.untilOff`, so the next start logs `verbose logging ended {reason: 'restart'}`; `verbose: false` deletes both. The logger logs `log level changed {verbose, until, areas}` and `verbose logging ended {reason: 'expired'}` |
| `POST /api/diagnostics/jobs/:name/run` | 202 `{started: true}` (not awaited; the job records its own outcome); 404 for an unknown job |
| `GET /api/diagnostics/report?redact=0\|1` | JSON attachment `portly-diagnostics-YYYYMMDD-HHmm.json` (below); `info 'diagnostic report created' {redact, bytes, ms}` |
| `POST /api/diagnostics/client-events` | `{sentAt, events (1–100)}` → `{accepted, dropped, acceptDebug}` (below) |

**Report.** `{generatedAt, summary (full; paths masked), accounts [{id, kind, label, status, statusMessage}], calendars
[{id, accountId, name, source}], health, history (the newest 500 outcome rows), logs {main: the last 3,000 info+
records, flight: the whole flight recorder, client: the whole browser ring, files: the last 2,000 server.log records},
supervisorLog (the last 300 records), launcherLog (the last 100 lines of the extension launcher's log, or null),
config {port, bindAddresses, dev, pagesOrigin, logLevel, envSet: the names of the PORTLY_* variables set, never their
values}}`, everything through `scrubFields` and the home-directory mask. The page adds `browser {build, version,
backend, pagesOrigin, userAgent, session, hybrid, events}`. **Redaction** ("Hide hosts, emails and names", off by
default): the server applies `redactForSharing` with a dictionary of account labels, emails and user names, IMAP,
CalDAV, webmail, ICS and feed hosts, calendar names, the Pages origin and its first DNS label, the PC's name and the
Windows user name, plus every `host`/`finalHost`/`blockedHost`/`origin`/`pagesOrigin`/`hops` value found —
replaced case-insensitively, longest first, by `host#n`, `email#n`, `label#n`, `name#n` (stable within one report);
then remaining emails, URL authorities and non-loopback IP literals by pattern. Well-known provider API hosts are kept
(they say which service failed, not who the user is). The page redacts its `browser` section the same way, numbering
`host#b1` … so the two parts never collide; "Copy summary" is redacted with the page's dictionary.

**Browser events (`web/src/diagnostics/clientLog.ts`, `upload.ts`).** `recordClientEvent(level, cat, msg, fields)`
next to the console line it explains; each category keeps only its allowlisted fields (plus `repeats`), every value
through `scrub`/`scrubFields`:

| `cat` | Recorded by | Fields |
| --- | --- | --- |
| `api` | `api/client.ts`: no answer (warn), 5xx (warn), other refusals (info), an answer after more than 5 s (info); never `/api/diagnostics/*` or a request its caller cancelled; the same method, route, status and code within 60 s is one event, then one more with `repeats` | `method, route, path, status, code, ms, rid, transport (server \| pages-server \| pages-browser), errName, errMessage` |
| `hybrid` | the local server controller (§16) | `from, to, reason, kind, httpStatus, ms, timedOut, errName, permission, target, attempt, graceMs` |
| `backend` | the in-browser backend's start failures | `errName, attempt, op` |
| `provider` | the in-browser backend's upstream failures (never URLs or queries) | `provider, host, status, code, errName, ms` |
| `widget` | the mail widget when an account's error changes | `accountId, code, status, widget` |
| `app` | `window` `error`/`unhandledrejection`, the error boundary | `errName, errMessage, source, stack (≤ 5 frames, file names only)` |
| `sync` | launch pad sync (`web/src/static/sync/scheduler.ts`), one event per round on the browser backend: debug for a check that changed nothing, info when something moved or a first-sync choice is needed, warn when it stopped or failed; never names, titles or addresses | `trigger, outcome, source (onedrive \| github), code, ms, received, sent, groups, bookmarks, icons, removed, bytesUp` |

- **Kept:** a ring of the last 300 events mirrored to localStorage (`portly:diagnostics:events`, Pages build
  `…:<base>`; merged across tabs, ≤ 256 KB, entries older than 7 days dropped; when another tab rewrites it, only
  the entries this tab has not read before are validated). **Debug events are never stored**
  (the last 100 stay in memory). Each event carries a session id (random per page load) and `page {build, backend,
  version}`; every storage access is guarded and everything read back is validated.
- **Upload** (only while this page load's backend is the server): every 15 s while the tab is visible (a hidden tab's
  timer stops: the stored events are every tab's) and when the tab is hidden, one upload
  at a time under a Web Lock shared by the tabs, ≤ 100 events per batch with `sentAt`, 10 s timeout, marked only after
  a 2xx; paced across tabs to the server's limit (`…:upload-pacing`). Never uploaded: events recorded on the browser
  backend, and `api` events carrying a `rid` (the server logged that request itself). Debug events go only while the
  server says `acceptDebug` (any answer says it; otherwise one goes along to ask, once per page load, again when the
  tab is visible after a minute or more since the last ask, and right after this page switched Verbose on for
  `client`). 400, 403, 404, 409, 413 and a 422 that names no event
  stop the uploads for the page load (a server older than the page); no answer, 5xx and 429 are retried.
- **Intake** (`client-events.ts`): per caller (`pairingId`, or `local` for Portly's own page) at most 120 events and
  64 KB of fields a minute — the rest is dropped and counted, with one `warn 'client events dropped' {caller,
  dropped, perMinute, bytesPerMinute}` a minute; debug events are dropped unless Verbose covers `client`. Clock skew:
  `tEvent = t + (receivedAt − sentAt)`, `late` when it happened more than 5 min before it arrived. Each event is
  logged as `client: <msg>` with `src: 'client'`, area `client`, `rid` = the event's `rid` when it is a request id, and
  `{tEvent, client {cat, session, page, late}, cf: <its fields, path/route without query>, uploadRid}` — browser
  fields stay nested under `cf`. They always reach the `client` ring, `server.log` only at warn+ unless Verbose
  covers `client`.

**Settings → Diagnostics (`settings/sections/Diagnostics.tsx`, `diagnostics/ui/`).** Six tabs:
- **Overview** — version (warning when the page runs another), uptime and boot, process, supervisor and its last
  restart (`lastExit` with the start-up failure), modules down, vault, warnings/errors of the last hour (server and
  browser), log level, requests and outbound calls in progress, Pages site and pairings; a banner when a named
  foreign origin tried to use this server ("A page at <origin> tried to use this server, but PORTLY_PAGES_URL is
  not set / is set to …"). Pages build: a "This site" card (version, backend, hybrid status, local network
  permission, this browser's counts, **Open diagnostics on this PC** once something answers there) and, for
  `answers-without-cors`, "Portly
  runs on this PC but does not accept this site: set `PORTLY_PAGES_URL=<this site's address>` and restart it".
- **Connections & sync** — health grouped by account (account, calendar list, calendars, mail) and then by area (ICS
  calendars, feeds, Todoist, weather, search suggestions, sports, scheduled jobs — jobs also from the job stats, so a
  job that never ran shows), needing attention first; status pill (OK / Degraded / Failing since … / Stale — last
  checked … / Not checked yet), last OK, current error (code, remedy from `diagnostics/ui/remedies.ts`, the
  `troubleshooting.md#<code>` anchor as text, message, HTTP status), consecutive failures, next attempt, skipped
  reason, `causeKey` link ("because <account> needs attention"); details: outcome history, **Show related log lines**
  (Server log filtered to the subject's context field, level debug, last failure ± 1 h) and **Run now** for `job:*`
  and the subjects `calendar:sync` / `calendar:ics` sync.
- **Logging level** — Normal / Verbose for 30 min, 2 h, 24 h or until turned off (ends at the next restart), all
  areas or ticked ones; while on, the nav shows a "Verbose" badge.
- **Server log** — the rings with level (Errors / Warnings / Info / All), area, source (server / browsers) and text
  filters; chips for request, job, run, account and calendar (by name) filter on click; **Live** polls `after=` every
  2 s; a restart (lower `lastSeq` or a new boot id) starts the list over; **Show older** reads the files; **Timeline**
  merges this browser's events by time (`tEvent ?? t`, late ones marked); ≤ 2,000 rows; rows expand to their JSON.
- **This browser** — this browser's events, live across tabs, each marked sent / not sent yet / kept here; Clear.
- **Report** — **Download diagnostic report** and **Copy summary** (≤ 40 lines: time with UTC offset, server, page and
  hybrid state, log level, vault, modules down, Pages and foreign origins, late jobs, health counts and every subject
  not OK, the last 10 distinct server warnings/errors with counts — collapsed repeats included, each window by the
  largest of its repeats' running `repeats` and its summary's `count` — the last 5 browser ones), both with "Hide hosts,
  emails and names (for sharing publicly)".

Availability follows the page load's backend: the server (Portly's own page, or the Pages site using it) → every
tab; a server from before diagnostics (its summary answers the Pages site `403 local_only`, its own page `404`) →
"Update Portly on this PC to see its diagnostics" with Overview and This browser; the in-browser backend → its own
intro (this site, Portly on this PC, what this browser noticed), Overview (the "This site" card) and This browser
(`static/handlers/unavailable.ts` answers `/api/diagnostics/*` as unavailable). `#/settings/diagnostics` on Portly's
own page never forwards to the Pages site (`app/pagesForward.ts`, like `#/pair`), and the Pages build links to it
(`<LOCAL_SERVER_ORIGIN>/#/settings/diagnostics`) once something answers on this PC (`localServerAnswers` in
`app/LocalServerPanel.tsx`; §16). Every diagnostics query is unpersisted (`qk.diagnostics` in `NON_PERSISTED_ROOTS`);
errors render notices, never a broken section.

---

## 18. Release packages (install without a checkout)

User guide and release steps: `docs/setup/releases.md` (what the package holds, the install and update walkthrough,
cutting a release). This section is the contract. A Git checkout (`scripts/setup.ps1`) stays the development path; a
**release install** runs the same server code from a zip that needs no Git, npm or separate Node.js.

- **Package** (`scripts/build-release.ps1` → `dist-release/portly-<version>-win-x64.zip` + `portly-release.json`
  `{name, version, platform, package, sha256, size, node, commit, builtAt}`): root `package.json` (the version the server
  reports), `release.json` `{name: 'portly', version, platform: 'win-x64', node, nodeSource, extensionVersion, commit,
  dirty, builtAt, releaseRepo}`, `server/` and `shared/` TypeScript sources without `*.test.ts`, `__fixtures__/` and
  `server/src/testing/`, `node_modules/` = `npm ci --omit=dev` of the server and shared workspaces only (no workspace
  links), `web/dist`, `extension/` without `test/` and `tools/`, `native-host/`, the user scripts with `scripts/lib`,
  `docs/`, and `runtime/node.exe` + `LICENSE` from the nodejs.org zip pinned with its SHA-256 in
  `scripts/release/node-runtime.json` (`-NodeExe` substitutes a local one for test builds; `publish-release.ps1`
  refuses those and dirty builds). No bundling: Node runs the sources as in a checkout.
- **`@portly/shared` link:** a zip holds no junction, so `node_modules/@portly/shared` → `<app>/shared` is created
  after the package reaches its final folder (`install.ps1`; `Initialize-HbReleaseLinks` in `install-autostart.ps1` and
  `start.ps1` restores it). Node resolves it to the real path outside `node_modules`, where type stripping is allowed.
  Before a release folder is moved or deleted its junctions are removed first (non-recursive `Directory.Delete`), since
  a moved junction keeps its absolute target.
- **Scripts in a release install** (`Get-HbReleaseInfo` = `release.json` present): `Resolve-HbNode` prefers
  `<root>/runtime/node.exe` over PATH (source of the task's named copies §12, `launcher.cmd`, config check);
  `portly --update` runs a temporary copy of `install.ps1` with `-InstallDir` = the parent of `app`, `--rebuild`
  refuses (it is `update.ps1`, checkout only), `--version` names the install kind; `install-cli.ps1` skips the
  `PORTLY_PAGES_REPO` warning; `status.ps1` shows the release version.
- **Install/update** (`scripts/install.ps1`, self-contained, also `irm | iex`): `portly-release.json` from
  `github.com/<releaseRepo>/releases/latest/download/` is validated (name, platform, version syntax, package name
  pattern, 64-hex SHA-256); the package must match that SHA-256 before it is unpacked into `<InstallDir>/app.new`, which
  is checked (release.json, platform, version, required files) before use. An update stops only what runs from `<app>`:
  the task when its action names `<app>/server/src/supervisor.ts` (also disabled until the folders are swapped, and
  during a rollback, so the extension's launcher cannot start the old copy again and hold its files), every process
  whose executable lives under `<app>` and every named copy (`%LOCALAPPDATA%\Portly\node\*`) whose command line names
  a file under `<app>`. It copies `portly.db` (+ `-wal`/`-shm`) to `<data>/backups/` before anything moves, then
  `app` → `app.previous`, `app.new` → `app` (each one `Directory.Move`, retried for 10 s: all or nothing, where Windows
  PowerShell 5.1's `Move-Item` falls back to moving file by file and stops half way at a file in use; on failure the old
  version is relinked and started again), relinks and runs `install-autostart.ps1 -Trigger <mode> -NodePath <app>/runtime/node.exe`. The mode is
  `install.ps1 -Trigger` when given, otherwise the installed task's (Logon when it has a trigger, else Browser;
  Browser for a new install); `portly --update` never passes `-Trigger`, so it keeps the mode. If that fails, `app` →
  `app.failed`, `app.previous` → `app`, the backup is copied back as `portly.db` (`-wal`/`-shm` with it; the failed
  version's files move to `<data>/backups/portly-failed-<version>-<time>.db`, newest three kept), and the old version's
  `install-autostart.ps1` runs with the same mode. On an
  update, a task that runs another copy (a checkout) is left alone with a warning. The data folder is never moved or
  deleted.
- **Trust:** the SHA-256 comes from the same release as the package, so it detects corruption, not a
  compromised repository; packages are not code-signed (alpha).
- **Checks:** `scripts/check-release.ps1` (`Restore-InstDatabase` on a temporary data folder, install, the installed CLI and autostart dry run, a server started from the
  package on a free port with a temporary data folder, re-install, `-Force` update with backup and `app.previous`,
  an update blocked by a file in use leaving `app` whole, refusals) — in `ci.yml` with a test package and in `release.yml` with the real one.

---

## 19. Moving over from Homebase (the name before Portly)

User guide: `docs/SETUP.md` (Coming from Homebase). Everything was renamed (PORTLY_* variables, `@portly/*`,
`X-Portly` headers, `app: 'portly'` in health, the **Portly Server** task, `com.portly.launcher`,
`%LOCALAPPDATA%\Portly` with `portly.db`, `portly:` browser keys, `portly-export`) except two literals existing
data depends on: the vault canary `homebase-vault-canary-v1` and the bookmark import source seed. The public pages
(`site/`) moved from `davideAurum/homebase-site` to `davideAurum/portly-site` in October 2026; the old repository keeps
redirect pages, because the 0.2.0-alpha.1 footer links there. What an existing Homebase install wrote is carried
over, never moved or deleted:

- **Data** (`server/src/lib/legacy-homebase.ts`, start-up phase `legacy` between `port-probe` and `db`): only on an
  explicit request, `<data dir>/copy-from-homebase.json` (`{requestedAt, replace}`), written by `install-autostart.ps1`
  when Homebase's database exists and Portly has none, or by `portly --copy-from-homebase [--replace]`; a plain first
  start never copies. Source: the first of `<data dir>/homebase.db` and the `homebase.db` in Homebase's own folder: the
  one HOMEBASE_DATA_DIR names (resolved like PORTLY_DATA_DIR), else — only with PORTLY_DATA_DIR unset too — Homebase's
  default folder. HOMEBASE_DATA_DIR is only read as that source; Portly keeps its own folder. `VACUUM INTO` a temporary
  file (consistent while an old server still has it open; read-only connection first, a normal one when WAL needs it;
  SQLITE_BUSY/LOCKED, EBUSY, EPERM and EACCES retried, 3 attempts), then the rename to `portly.db`. An existing
  `portly.db` is kept (marker `kept-portly-database`, request dropped, warning) unless `replace`, which first moves it
  and its `-wal`/`-shm` to `portly.db.before-homebase-<time>`. The vault key travels with the database it encrypts: when
  the database comes from another folder, Homebase's `vault.key` takes the place of Portly's (DPAPI is per user, not per
  path), and a `vault.key` of Portly's own that differs is moved to `vault.key.before-homebase-<time>` (the same time as
  its database; also when Homebase has no key, as it does not fit the copy). A step that fails undoes the earlier ones,
  so a database never ends up with another one's key. On success the request is removed and
  `migrated-from-homebase.json` records `{status: 'copied', at, from, copied, replaced?, replacedKey?}`. A copy that
  cannot be made fails start-up (`StartupError`, marker `status: 'failed'`), keeping the request so no empty `portly.db`
  is created: still busy → `homebase_copy_busy` (exit 1, the supervisor retries); no source or an unreadable one →
  `homebase_not_found` / `homebase_copy_failed` (EXIT_PERMANENT_FAILURE; `--cancel` withdraws the request). A key
  without a database just gets a new canary. The pairing instance id lives in the database, so pairings survive.
- **User environment, task, native host** (`scripts/lib/Common.ps1`, run by `install-autostart.ps1`, listed by
  `-DryRun`): `Get-HbLegacyPlan`; first `Invoke-HbLegacyEnvCopy` (`HOMEBASE_X` user variables copied to unset
  `PORTLY_X`, user scope and this process, before the PORTLY_* settings are read; never `HOMEBASE_DATA_DIR`, which
  `Get-HbHomebaseDataDir` reads for the source; once, see below); `Get-HbHomebaseCopyPlan` /
  `Write-HbHomebaseCopyRequest` after the configuration check; once Portly's task and host are registered,
  `Suspend-HbLegacyServer` stops `\Homebase Server` (and its supervisor processes) without removing it; only when
  `/api/health` answers with `app: 'portly'`, `Remove-HbLegacyInstall` exports the task to
  `<data dir>/homebase-task-backup.xml`, unregisters it and removes the `com.homebase.launcher` HKCU keys. Any other
  outcome (start failure, port taken, an error) runs `Resume-HbLegacyServer` in a `finally`. `-NoStart` leaves Homebase
  alone. The variables are copied once: the first real run that finds any `HOMEBASE_X` writes
  `<data dir>/homebase-variables-copied.json` (`{at, copied}`, the names only), and while it exists
  `Get-HbLegacyPlan -DataDir` copies nothing, so a variable removed since stays removed. `-NoHomebaseCopy` (also on
  `setup.ps1`) starts from scratch: no variable copy (still recorded, with `copied: []`, so a later run without it
  copies none either), no copy request (a waiting one is withdrawn); the task and host are still replaced. Homebase's
  data and native-host folders stay.
- **Health checks:** Homebase answers `/api/health` on the same port with `ok: true` too, so the extension
  (`checkHealth`, `extension/lib/portly.js`) and the native host (`probeHealth`) take an answer for Portly only with
  `app: 'portly'`, like `install-autostart.ps1`; the web app's probe never takes another `app` for Portly either.
- **Command** (`Get-HbLegacyCliPlan`, `install-cli.ps1`): once `portly` is written and on the user PATH (one PATH
  write), `homebase.cmd` / `homebase` in `%LOCALAPPDATA%\Homebase\bin` and that folder's PATH entries are removed, and the
  folder if it is then empty.
- **Browser** (`web/src/legacyStorage.ts`, imported by `main.tsx` right after zod's configuration): once
  (`portly:migrated-from-homebase`), every `homebase:` localStorage key except query caches is copied to its unset
  `portly:` key; `copyLegacyStaticDatabase` (`static/storage/idb.ts`) copies `homebase-static:<base>` into
  `portly-static:<base>` (both stores; needs `indexedDB.databases()`), only into a database it creates itself: the
  transaction that creates it writes the `kv` marker `copy:homebase-pending` (`{attempts}`), and the one that writes the
  copied records removes it. A copy cut off part-way (an error, a full disk, a closed tab) leaves the marker, so later
  loads try again, replacing what the database holds by then, `LEGACY_COPY_ATTEMPTS` (3) loads in all; after that the
  database is kept as it is. A database without the marker is never touched.
- **Files:** import accepts `format: 'homebase-export'` (`isExportFormat`), and `publish-static.ps1` recognises a
  Pages repository holding a `homebase-build` publish.

---

## 20. Other PCs (one server for several PCs)

Portly runs on one PC, the **main PC**, and listens on loopback only (§4). Other PCs use it through an HTTPS
reverse proxy the user runs on the main PC (documented: Tailscale Serve, reachable only inside the user's tailnet,
with a real certificate and no firewall change; never Funnel), after each of them is approved once from Portly's own
page. The design, its decisions and what each phase built are in docs/design/multi-pc.md; the user guide is
docs/setup/other-pcs.md. With `PORTLY_REMOTE_ORIGIN` unset nothing below exists and the server behaves as before.
A "PC" here is any device with a current browser in the tailnet, phones and tablets included: nothing in
the flow is specific to Windows (an untried case, see the guide's phone section and ROADMAP's checks table).

**Two listeners, one door.** `PORTLY_REMOTE_ORIGIN` (`https://<pc>.<tailnet>.ts.net`, the address other PCs use;
`http://localhost:<port>` is accepted with a warning for trying the flow on one PC) makes the server also listen on
`PORTLY_REMOTE_PORT` (default main port + 1, so 5758), on the same loopback addresses. The proxy forwards to that
port, and whatever arrives there is another PC's request, whatever its Host header says (§4.2 step 2): a proxy that
rewrites the Host to its loopback target cannot make another PC look like the main one. On the main port the remote
host is unknown and a forwarding header is refused (`proxied_local_host`), which is how a proxy pointed at the wrong
port shows up. `GET /api/health` answers `remote: true` on the remote port, so a page can tell how it was taken.

**Login by approval** (`security/devices.ts`, `modules/devices`, `shared/src/devices.ts`; the request gate's remote
branch in §4.2 step 3). No passwords: the other PC asks (`POST /api/devices/requests {label}`: a name it gives itself,
one line) and gets a display code (`K7Q-4MP`, letters and digits that are hard to confuse) and an enrollment cookie
(`__Host-portly_enroll`; 10 minutes plus the hour the request is retained, so the last poll can still say expired).
At most 3 requests wait at once (429). The main PC approves or denies from Settings → Devices (`POST
/api/devices/requests/:id/approve|deny`, local-only). The other PC polls `GET /api/devices/requests/current` every 2 s
(10 s hidden): `approved` creates the device on that poll (no secret is ever stored in clear; approval only flips the
request's status) and answers with the device cookie `__Host-portly_device` (32 random bytes, `Secure; HttpOnly;
SameSite=Strict; Path=/`, Max-Age 30 days) while clearing the enrollment cookie. The request row stays, marked
`claimed`, until it expires: while the device has never been used, the same enrollment cookie claims again and gets a
fresh cookie for the same device, so a lost answer strands nobody. Only SHA-256 hashes of both cookies are stored
(`devices`, `device_requests`, §5). A device's last use is recorded at most every 10 minutes and its cookie's
lifetime renewed then (never on an answer that set or cleared the cookie itself, nor for a device the route just
stopped); a device idle for 30 days expires, on its own request, on any listing, and when a request is created or
claimed; at most 20 devices
(the least recently used goes first); revoked and expired rows are kept 30 days so the gate refuses their cookie as
"revoked" with the reason, like pairing tombstones. `DELETE /api/devices/:id` (this PC, own page or paired Pages
site) stops a device at once; `DELETE /api/device` lets a device disconnect itself. Why a cookie and not a token
header like pairing: the page and the API share the remote origin, so an `HttpOnly` cookie cannot be read by injected
script; cross-site forgery is stopped by `SameSite=Strict`, the `X-Portly: 1` requirement (no preflight is ever
answered), the exact `Origin` check and the `Sec-Fetch-Site` rule. The web page on the main PC cannot use the remote
port either: it has no device cookie for it (the cookie is bound to the remote origin's host) and cannot send
`X-Portly` cross-site.

**What a device may do** (§4.2 access levels; `ROUTE_ACCESS` in `app.test.ts` pins every route): everything the
paired Pages site may, except what stays on the main PC: the vault reset, the browser bookmark import, the OAuth
start (its redirect lands on the main PC; accounts connected there work from every PC because the server keeps the
tokens; app-password accounts and Todoist can be connected from any PC), the OAuth client settings, every pairing
route, removing other devices, approving and denying requests, and the diagnostics report (the logs, level and jobs
stay open, as for the Pages site: scrubbed and home-directory-masked). `/api/about` and the diagnostics summary blank
the paths. The later items (design phase 4): the extension's server address, OAuth sign-in from other PCs, a passkey
second factor, an optional `Tailscale-User-Login` identity check as defence in depth (the real check with a second
device showed Serve replaces a forged one from inside the tailnet; any other proxy may pass it through).

**The name the connect screen fills in** (`lib/peer-names.ts`, `GET /api/devices/requests/suggestion`). A browser
cannot tell a page the computer's name, but Tailscale on this PC can tell who is asking: a Serve proxy sets
`X-Forwarded-For` to the sender's tailnet address (and replaces a forged one, as the real check showed; the route
takes the last entry, the one the proxy itself added, so a proxy that appends leaves forged entries unused), and
`tailscale whois --json <address>` answers with that node's computer name (`Hostinfo.Hostname`), its tailnet machine
name (`ComputedName`) and its MagicDNS name. The first that is a usable label (`DeviceLabelSchema`, cut to its
length, never leaving half of a surrogate pair; the schema itself refuses lone surrogates) is the suggestion; the
connect screen asks once the form first shows (so a Retry after an unreachable start still gets it), fills it in once
and never over something the user has typed. It is a convenience, never trust: the other PC may change it, the
approval on the main PC stays the login, and through a proxy that passes `X-Forwarded-For` on, a forged address can
only change the suggested text and cost at most a few processes: only tailnet addresses (100.64.0.0/10,
fd7a:115c:a1e0::/48) are looked up, never anything else; at most 4 lookups run at once (a further address gets null
until one settles); `tailscale.exe` is spawned by its absolute path in `%ProgramFiles%\Tailscale` with an argument
array (no shell), hidden, with a 3 s timeout and a bounded output, like DPAPI's PowerShell; answers (a name or none)
are cached five minutes per address, at most 64 addresses, and callers asking about one address at once share one
process. Without the program there (Tailscale not installed, another proxy) and without a remote origin, every lookup
answers null and nothing is spawned. The lookup runs only for a request on the remote port; this PC's own page gets
null without one.

**The web side** (`web/src/app/remoteClient.ts`, `ConnectPage.tsx`, `settings/sections/Devices.tsx`,
`api/devices.ts`, `capabilities.ts` `remoteClient`). Before the first render the server build asks `GET /api/health`
(never a loopback shortcut): `remote: true` → another PC's page load; `remote: false` → this PC's own when the server
names the page's origin as its own (`appUrl`) or the address is loopback, else `misrouted` (the proxy points at the
main port: a warning page, nothing else). A remote page then asks `GET /api/device` *before* it counts as remote
(`setRemoteClient` comes after, because on a remote page any 401 `login_required` reloads it once, into the connect
screen, and that check's own 401 must not): not connected → the connect screen (the form, the code while waiting,
approved → reload; denied, expired or gone → ask again; Retry when unreachable); connected → the app, with
`remoteClient` on: the Google and Microsoft tiles, Reconnect and Add a service, the vault reset button and the pairing
approval page give way to a line saying "on the main PC"; the browser bookmark import, the paired-browsers card, the
app registrations and the report download are simply not shown; About says the data lives on the main PC. The Pages forward never takes
a remote page load. Settings → Devices (every build; the browser backend shows a note): the address for other PCs or
the setup steps, the requests waiting with Approve and Deny on Portly's own page on the main PC only (a device sees the
list and a note; the paired Pages site sees the list and a link to Portly's own page's Devices section, which never
forwards to the Pages site, like `#/pair`), the connected PCs with "This PC" and Remove (a device may only
"Disconnect this PC"), polled every 5 s while the page is visible, never persisted.

**Setup** (`setup.ps1 -RemoteOrigin <address>`, `off` removes it; or the user variable by hand, then
`install-autostart.ps1` so the task carries it: `PortlyEnvNames` in `scripts/lib/Common.ps1` lists both variables)
and the guide's order: point the proxy at the remote port (`tailscale serve --bg 5758`), set the variable, restart
Portly, approve each PC. `off` removes both variables. Logs (§17) carry device and request ids only.
