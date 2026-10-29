# CLAUDE.md

Guidance for coding agents in this repository. The binding design contract is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): read the section for the subsystem you touch
(section 4, security, always applies).

## What Portly is
A single-user browser home page for Windows 11. A Node 24 server bound to loopback (Hono,
`node:sqlite`, DPAPI-protected vault) serves a React 19 + Vite 8 app. A Manifest V3 extension
makes it the New Tab page and starts the server through a native messaging host and a per-user
scheduled task. The same app also builds as a browser-only static site (GitHub Pages) that can
use a paired local server ("hybrid mode", ARCHITECTURE section 16). Portly was previously named
Homebase; see "Renamed from Homebase".

## Layout
| Path | What |
| --- | --- |
| `shared/` | `@portly/shared`: API contract types + zod 4 schemas |
| `server/` | `@portly/server`: runs from TypeScript source, no bundling; features in `server/src/modules/<name>` |
| `web/` | `@portly/web`: React app; `web/src/static/` is the in-browser backend of the Pages build |
| `extension/` | MV3 new-tab extension, plain JS, no build step |
| `native-host/` | `com.portly.launcher` (`launcher.mjs` + `launcher.cmd` template) |
| `scripts/` | PowerShell install/start/status/release/publish scripts; helpers in `scripts/lib/Common.ps1` |
| `site/` | Static home/privacy/terms pages for OAuth consent screens |
| `docs/` | `ARCHITECTURE.md`, `SETUP.md`, `setup/*.md` |

## Commands
- Install: `npm ci` only. `.npmrc` sets `ignore-scripts`, `min-release-age=7`, `engine-strict`
  (Node 24 only, `>=24 <25`; npm >= 11.10). Do not add or upgrade dependencies unless asked.
- `npm run typecheck`
- `npm test`: vitest (projects `server`, `web`, `static`), extension tests, native host tests,
  then `npm audit --omit=dev --audit-level=high`.
  - Scoped: `npx vitest run <files>`; one project:
    `node node_modules/vitest/vitest.mjs run --project static`.
  - `node scripts/check-extension.mjs`, `node scripts/check-native-host.mjs`.
- `npm run build` (`web/dist`) and `npm run build:static` (`web/dist-static`).
- After any change under `scripts/`, `native-host/` or `.github/workflows/`:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-scripts.ps1`
  (several minutes; runs Windows PowerShell 5.1 and PowerShell 7 passes).
- After release/install changes: `.\scripts\check-release.ps1` (temporary folder only).
- Before committing, run what CI runs (`.github/workflows/ci.yml`): typecheck, `npm test`, both
  builds, `check-scripts.ps1`, `check-release.ps1`.
- Before a release, check both production builds for CSP violations by hand (serve `web/dist`
  from a scratch server and `web/dist-static` with `npm run preview:static`, DevTools open): no
  automated step covers it (ARCHITECTURE section 13, ROADMAP 2.5).
- Never run the full test suite in several sessions at once. Tests that start processes get
  busy-machine timeouts (today the DPAPI and vault tests; give any new one, such as the
  supervisor's, the same).

## Code conventions
- TypeScript is strict with `noUncheckedIndexedAccess`. Relative imports include `.ts`/`.tsx`.
  No enums, namespaces or parameter properties (use `as const`). Use `import type` for types.
  Zod 4 nested defaults use `.prefault({})`.
- Security (ARCHITECTURE section 4) is mandatory:
  - loopback only;
  - Host check, plus `X-Portly: 1` and same-origin fetch metadata on API calls;
  - strict CSP;
  - all outbound requests through `server/src/security/safe-fetch.ts`;
  - secrets are write-only and never returned to the browser;
  - treat mail, calendar, ICS, favicon and imported files as hostile.
- Logs never contain secrets, message/event titles, search terms, full URLs or user names in
  paths (section 17).
- Tests make no live network calls. Server: `createTestContext()`, `testRequest()`,
  `createFakeFetch()` in `server/src/testing/`. Web: `renderWithProviders()`. Fixtures go in
  `<module>/__fixtures__/`.
- Widgets meet the definition of done in section 10.7.

## PowerShell
- ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI, so no em dashes, smart
  quotes or arrows.
- CRLF endings for `.ps1`, `.cmd`, `.bat`; LF for everything else (`.gitattributes`). Some
  editors and `sed` silently write LF; `check-scripts.ps1` catches it.
- Must run in Windows PowerShell 5.1 and PowerShell 7 under `Set-StrictMode -Version 3.0`.
- A function returning `return , $array` must be assigned, never wrapped in `@(...)`.
- Helpers keep their `Hb` prefix (`Get-HbRepoRoot`, ...) from before the rename. This is
  intentional.
- Every script that changes the machine has a side-effect-free `-DryRun`. Self-checks use only
  dry runs and fakes, and must never register a task, write the registry or start a real server.
- Run as `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\<name>.ps1`.

## GitHub Actions
- Pin every action to a full commit SHA with a `# vX.Y.Z` comment (`check-scripts.ps1`
  enforces this). Prefer releases older than 7 days.
- In `pwsh` steps use one command per step, because only the last exit code counts.
- `release.yml` and `static-pages.yml` are manual and publish publicly.
- Pushes to main start no CI run in this repository (a fault on GitHub's side, ROADMAP 5.7).
  After pushing, start one with `gh workflow run ci.yml --ref main` and check that it passes.

## Docs and commits
- Update README, `docs/SETUP.md`, `docs/setup/*.md`, ARCHITECTURE and the README of the folder
  you change (`scripts/`, `extension/`, `native-host/`, `web/src/static/`) in the same change as
  the code. Write in plain English for the user.
- Examples use placeholders (`<user>`, `<user>.github.io`, `$env:USERPROFILE\Coding\Portly`,
  `C:\Users\you`). Test fixtures use fictional people. Never put a real name, local path,
  email or employer in code, tests, docs or commit messages. The one exception is Portly's own
  repository and Pages site (`davideAurum/Portly`, `davideaurum.github.io`), which the install
  commands and the release defaults must name.
- Commit messages:
  - a summary line under about 75 characters ("Area: what" or imperative);
  - a blank line, then a short paragraph on the user-visible effect;
  - `- file/area: change` bullets and a `Docs: ...` line;
  - an honest note on what was and wasn't tested, its "Not tested" part copied into the
    "Checks never run for real" table of `docs/ROADMAP.md` in the same commit;
  - wrap at about 72 columns.
- Versions come from `package.json`. A release tags the exact commit it was built from, and a
  version can be published once.

## Renamed from Homebase (ARCHITECTURE section 19)
Everything user-facing and internal is Portly. A legacy layer copies an existing Homebase
install over:
- `server/src/lib/legacy-homebase.ts`;
- `web/src/legacyStorage.ts`;
- `copyLegacyStaticDatabase` in `web/src/static/storage/idb.ts`;
- `Get-HbLegacyPlan`, `Invoke-HbLegacyEnvCopy`, `Suspend-`/`Resume-HbLegacyServer`,
  `Remove-HbLegacyInstall` and the `*HomebaseCopy*` helpers in `scripts/lib/Common.ps1`;
- import of `homebase-export` files and acceptance of `homebase-build` publishes.

Do not rename:
- the vault canary `homebase-vault-canary-v1`;
- the bookmark import source seed;
- the published `homebase-site` URLs;
- the `--hb-*` CSS custom properties and `hb-*` classes in `web/src`. They keep the old prefix
  on purpose, like the PowerShell `Hb` helpers;
- the legacy code above.

Never change the extension `key` in `extension/manifest.json`. Its ID is pinned in the
extension, the native host and the docs.

## Running things by hand
- The developer's machine may already run an installed Portly or Homebase on port 5757. For
  manual runs set `PORTLY_PORT`, `PORTLY_VITE_PORT` and `PORTLY_DATA_DIR=<scratch>\data`, never
  the defaults, and stop whatever you start.
- Also clear `PORTLY_PAGES_URL` for manual runs (it may be set as a user variable). With it set,
  the server's own page forwards to the real Pages site (`web/src/app/pagesForward.ts`).
- A scratch `PORTLY_DATA_DIR` is not optional: the default folder is the user's real data. It is
  also where the switch-over leaves its `copy-from-homebase.json` request (section 19), and any
  server started there would carry out that copy.
- Do not run `install-autostart.ps1`, `uninstall-autostart.ps1`, `setup.ps1`, `install.ps1`,
  `update.ps1`, `install-cli.ps1` or `try-branch.ps1` for real unless asked. They change the
  scheduled task, registry, PATH and user environment, and remove an existing Homebase install.
  Use `-DryRun`.

## Ask first
- Pushing; creating, renaming or archiving repositories; publishing releases
  (`publish-release.ps1`, `release.yml`) or the Pages site (`publish-static.ps1`,
  `static-pages.yml`).
- Force-pushing or rewriting history.
- Adding dependencies.
- Anything that makes content public.
