# The Pages site at /portly/, and two install steps

Decided by the owner on 2026-11-16 (ROADMAP B.9). Nothing in it is built yet. Phase 1 and 2 are
meant to run on the main PC, from a checkout at or after the commit that added this file.

## Decisions

1. **The site moves to `https://davideaurum.github.io/portly/` and the root is freed.** The install
   scripts and the extension download move under `/portly/` too. Nothing stays at the root, not even
   a redirect, so old links to the root (older docs, older releases' install commands, the main PC's
   saved address until it updates) stop working.
2. **Each browser copies its data from the old address once.** Pairing, a connection to another PC,
   the copy kept in the browser and browser-only sign-ins carry over, so nothing needs pairing,
   approving or signing in again.
3. **A PC's role is automatic.** The extension checks whether Portly's launcher (the native messaging
   host) is installed. Installed: new tabs open this PC's Portly. Not installed: new tabs open the
   Pages site, which connects to the main PC. Nothing to set.
4. **Installing has two steps.** Step 1 on every PC: the extension, and connecting to the main PC.
   Step 2 on the main PC only: the server.

## Why a folder, not a repository

GitHub Pages paths are case-sensitive (checked 2026-11-16: `/portly-site/` answers 200,
`/PORTLY-SITE/` 404). The Portly repository's own site would be at `/Portly/`, and a repository named
`portly` cannot exist beside `Portly`. So the site is a `portly/` folder in the user-site repository
`davideAurum/davideAurum.github.io`.

## Phase 1: the site moves (code and docs, no publishing)

- **`scripts/publish-static.ps1`.** For a repository served at `/` (a `<user>.github.io` repository, or
  one with a CNAME), accept `-Base /<name>/` (one path segment) and publish into the `<name>/` folder
  only. Today that combination is refused ("-Base must be /").
  - Only that folder's tracked files are replaced. The folder must be empty or an earlier Portly
    publish (its `index.html` has the `portly-build` marker and it holds only published names),
    otherwise refused unless `-ReplaceEverything`.
  - The root `.nojekyll` and `.gitattributes` stay, and are written as today.
  - Once, when the root `index.html` carries the `portly-build` marker, the earlier root publish is
    removed by name (`Get-PtPublishedNames`: `index.html`, `assets`, the three scripts, the extension
    zip and json, the `web/public` names) and nothing else. Any other root file is never touched.
  - The dry run lists both.
  - Self-checks in `check-scripts.ps1`: publish into a folder, keep foreign root files, one-time root
    cleanup, refuse foreign content in the folder, base validation.
- **Defaults** name `https://davideaurum.github.io/portly/`: the `-SiteUrl` default of
  `get-extension.ps1`, the `irm .../portly/<script> | iex` examples of `install.ps1`, `setup.ps1` and
  `get-extension.ps1`, the docs (README, SETUP, `docs/setup/*.md`, `scripts/README.md`,
  `extension/README.md`), and the extension tests' sample addresses.
- **Browser data copy** (static build only, `web/src`). It runs first thing after `zodConfig.ts` in
  `main.tsx`, before any module reads storage. It runs when `BASE_URL` is not `/` and the marker
  `portly:copied-from-base:/` is not set.
  - localStorage: copy `portly:pairing:/`, `portly:backend-mode:/`, `portly:server-seen:/` and
    `portly:remote-address:/` to the same names under this base, where the target is absent. Not the
    query caches (their buster drops them anyway) or the diagnostics mirror.
  - IndexedDB: copy `portly-static:/` into `portly-static:<base>`, only into a database this copy
    creates. A pending marker is written in the transaction that creates the database and removed in
    the one that writes the records, and there are three attempts in all. The removed
    `copyLegacyStaticDatabase` (`web/src/static/storage/idb.ts` before commit 8c24664) is the
    pattern. Skip `kv` keys starting with `copy:`. Browsers without `indexedDB.databases()` skip the
    copy.
  - Afterwards delete the old base's keys and database, and keys starting with
    `portly:migrated-from-`, so no copy of the old data stays behind.
- **The main PC's saved address.** `install.ps1` (install and update) and `setup.ps1` change
  `PORTLY_PAGES_URL` from exactly `https://davideaurum.github.io/` to
  `https://davideaurum.github.io/portly/`, and never touch any other value. The self-check passes a
  getter and a setter, never the registry. The update restarts the server, which then reads it.
- **Sign-in addresses.** Browser-only sign-ins redirect to `new URL(BASE_URL, origin)`
  (`web/src/static/context.ts`), so the owner adds `https://davideaurum.github.io/portly/` in Spotify,
  Microsoft (SPA) and Google before the site is published.
- **Docs:** ARCHITECTURE 16, 18 and 20, `static-build.md`, `releases.md`, `other-pcs.md`, SETUP and
  README.

## Phase 2: two install steps, automatic role

- **Extension.** With the target `auto`, when no Portly answers on this PC and the launcher reports
  that it is not installed, new tabs open the Pages site instead of "Portly isn't running". The
  address is `https://davideaurum.github.io/portly/` (a release default), or the one the step 1
  script recorded. Options still override it.
- **Step 1** (`get-extension.ps1`, perhaps renamed). It installs the extension into
  `%LOCALAPPDATA%\Programs\Portly\extension`, checks that Tailscale is installed and signed in, and
  opens `<site>#/connect`.
- **Step 2** (`install.ps1`), on the main PC only. It uses the same extension folder as step 1, so a
  PC never holds two copies, and `portly --update` keeps that folder current.
- **Docs:** SETUP and `other-pcs.md` written as step 1 and step 2.

## Phase 3: release 0.2.0-alpha.9

The owner's OK comes before each step. The privacy page's effective date (November 16, 2026 in
`site/`) must match `davideAurum/portly-site`. The site is published from the owner's terminal. This
is also the release the Update button's real test needs (B.8).

## Phase 4: the owner's steps

1. Add the `/portly/` sign-in addresses (before the publish).
2. Run `portly --update` on the main PC right after the publish.
3. On dg-surfacepro, run step 1 again and check the New Tab page.
4. Then close ROADMAP 3.3 and 3.4.
