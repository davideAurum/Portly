# Roadmap

Where Portly is heading, one phase at a time. Each phase is finished, checked and reviewed before
the next one starts. Anything that makes something public (pushing, releases, the Pages site, the
consent pages) or touches another PC waits for an explicit go-ahead, asked at the moment it is
reached.

Status as of 2026-10-29.

This plan comes from a full review of the code, the docs, the git history and the work sessions on
2026-10-20, with everything CI runs green at cd547e3 (3,691 tests, 317 script checks, 27 release
checks).

| Phase | What | Status |
| --- | --- | --- |
| 0 | Make the move from Homebase safe | Done ([details](#done-before-this-plan)) |
| 1 | Baseline and a truthful public surface | Done (1.8's real run waits for the next `portly --update`, see the checks table) |
| 2 | Prove what is built, on this PC | Done 2026-10-29: 2.1 to 2.7 with real accounts and browsers (Chrome, Edge, Firefox); the open checks rows are re-planned to 6.7 or later |
| 3 | Every PC on Portly, Homebase retired | In progress: 3.1 done 2026-10-29 in scratch folders; 3.5 written. Since 2026-10-29 the other PCs connect to this PC's Portly instead of running their own (F11), so 3.2 to 3.4 were rewritten |
| 4 | Release rehearsal in private | Done (4.3 found and fixed an update bug; 4.4's second run-through, in 5.2 and 5.5, found nothing missing) |
| 5 | Go public and publish 0.2.0-alpha.1 | Done 2026-10-28: the repository is public and 0.2.0-alpha.1 [published](https://github.com/davideAurum/Portly/releases/tag/v0.2.0-alpha.1); 5.6 done 2026-10-29 |
| 6 | Launch pad sync, shipped as 0.2.0-alpha.2 | Released 2026-10-29: [v0.2.0-alpha.2](https://github.com/davideAurum/Portly/releases/tag/v0.2.0-alpha.2), the site and privacy page from its tag, this PC updated. Left: sync on the published site itself (6.7) |

## How this roadmap is used

- One item per short-lived worktree session, started from main and merged straight back to main
  (no pull requests). Every commit keeps its honest *Tested* note.
- An item is done only when its *Done when* line has been met for real and the result is dated
  here. Green tests with fakes are the floor, not the proof. A commit's *Not tested* note is copied
  into the [checks table](#checks-never-run-for-real) in the same commit.
- Items marked *go-ahead* stop before the public or machine-changing step (Pages republish,
  consent pages, dependency change, visibility flip, release, another PC, portal changes) and
  ask once, at that moment, never bundled. Pushing to main always asks (CLAUDE.md, "Ask first")
  and is not marked.
- What gates what: another PC is touched only after 3.1 (the scratch DPAPI rehearsal) and 2.2 (the
  real sign-ins); the release (5.3) waits for 2.1, 2.3, 2.5 and 4.3. Nothing else gates either.
  Phase 4 interleaves with phase 3; 2.2 to 2.7 may run in parallel sessions; 6.1 may be built in a
  parallel worktree as soon as phase 2 closes, but merges to main only after 5.3 has tagged the
  release.
- Effort: **S** hours, **M** a day or two, **L** a week.
- The yardstick: a change counts when it is on main, on this PC's installed Portly (the main
  checkout, brought to origin/main before every `portly --update`) and on the published Pages
  site.
- House rules stay in force: a scratch `PORTLY_PORT` and `PORTLY_DATA_DIR` with `PORTLY_PAGES_URL`
  cleared for every manual server (2.2 and 2.6 are the deliberate exceptions, on the installed
  Portly after an export and a backup copy); installer scripts never run for real unless you say
  so; the CI set before every merge; no full test suites in several sessions at once; Chromium
  (Chrome, Edge) is the supported browser for the alpha.

## Decisions (D) and facts (F) recorded on 2026-10-20

- **D1 Release timing.** Go public right after the release rehearsal (phase 4); launch pad sync
  comes after that and ships as 0.2.0-alpha.2.
- **D2 Visibility and publish route.** Make davideAurum/Portly public; publish from this PC with
  `publish-release.ps1` after one build-only `release.yml` run; `release.yml`'s publish job stays
  the fallback.
- **D3 Hygiene commit.** Yes, one commit (1.7): the npm audit fixes (hono, vite's launch-editor,
  shell-quote via concurrently, source-map-js), drop `@tanstack/query-sync-storage-persister`, pin
  engines to `>=24 <25` in the root `package.json`.
- **D4 Consent pages.** Republish the privacy and terms pages now, with true Portly text and a new
  effective date, at the existing homebase-site URLs (1.5, 1.6). Superseded on 2026-10-29: the
  pages moved to `https://davideaurum.github.io/portly-site/` and homebase-site keeps redirect
  pages (5.7).
- **D5 Pages redirect.** Register `https://davideaurum.github.io/` as a *Single-page application*
  redirect in the Azure app registration now (1.4), the same day as the Pages republish (1.3).
- **D6 What gates what.** Other PCs (phase 3) wait for 3.1 (the scratch DPAPI rehearsal) and 2.2
  (the real sign-ins); the release waits for 2.1, 2.3, 2.5 and 4.3. Nothing else gates either.
- **D7 Sync in the contract.** `launchpadSync` enters the contract by extending the shared
  `Capability` enum in one deliberate contract change; the server marks it unsupported.
- **D8 Sync defaults.** All accepted as the design proposes: OneDrive through an Outlook.com
  account as the only sync, no passphrase encryption, layouts and theme per PC, first sync
  defaults to *Use the synced launch pad* with no *Combine both* option, tombstones kept 90 days,
  one Microsoft connection per browser, a backup slot of its own, Chrome and Edge in scope.
  *Changed 2026-10-27:* OneDrive is no longer the only sync. The owner asked for a GitHub
  backend to be built alongside it, first on secret gists, then (the same day, G.2) on a private
  repository through the contents API (see "Launch pad sync through GitHub" below). "One
  Microsoft connection per browser" became one sync connection per browser, Microsoft or GitHub
  (design section 6.10).
- **D9 Custom domain.** Accept and document the shared-origin risk of the Pages site now; decide
  again before the sync engine (6.5) ships. *Decided again 2026-10-29:* the site stays at
  `https://davideaurum.github.io/` for 0.2.0-alpha.2, risk accepted. Only the owner's own
  repositories publish there. Moving the app under a path such as `/portly-site/` would not help:
  a browser shares storage per origin (scheme, host and port), not per path. Revisit when anyone
  else uses the site.
- **D10 Multi-PC.** One server with an approve-from-the-main-PC login over Tailscale Serve is built
  only after the first public release and an explicit go; fact-finding only when Tailscale and a
  second tailnet device exist.
- **F11 Other PCs.** One or more still run Homebase, so phase 3 stays as written, for each other
  PC. *Changed 2026-10-29:* the other PCs stop running a server of their own. Each removes Homebase
  and connects to this PC's Portly through Tailscale Serve (Track B), so 3.2 to 3.4 were rewritten.
  *Later the same day:* the owner reports that no PC runs Homebase any more, so 3.3 and 3.4 only
  connect each other PC, and 3.6 can archive Homebase's repository.
- **F12 Yahoo.** No Yahoo account is connected on this PC's installed Portly: 2.6 adds the Yahoo
  preset with an app password. *2026-10-29:* the owner has a Yahoo account and makes the app
  password during 2.6.
- **F13 Tailscale.** Not installed, and there is no second tailnet device: the multi-PC probes are
  parked until both exist.
- **F14 Extension privacy text.** A section on `site/privacy.html`, at the URL the consent screens
  already link to (part of 1.5).
- **F15 History rewrite (2026-10-28).** Before going public, the commits from 714fe83 on had a
  weather fixture's real city taken out of their files and messages (`git filter-repo`; older
  commits unchanged). The old repository is kept private as `davideAurum/Portly-private-archive`
  (its CI runs and artifacts included), and a new `davideAurum/Portly` holds the rewritten
  history. Hashes of rewritten commits quoted before that date, here or in the Pages repository's
  commit messages, refer to the archive.

## Phase 1: Baseline and a truthful public surface

Start from main, put this plan in the repository, bring your new tab and the public pages current
and true, and clear the cheap known issues, so that every later check runs on a known state.

Done when:
- The decisions above are taken (done 2026-10-20).
- The roadmap branch and the main checkout (the installed Portly) are at origin/main (cd547e3 or
  later) with clean working trees; the leftover worktree and the two merged branches are gone; the
  memory note matches the repository and the live site.
- `docs/ROADMAP.md` is this plan with a dated checks table; `CLAUDE.md` carries the three new
  rules; SETUP marks the `setup.ps1` one-liner owner-only until phase 5; CI green on main after
  the push.
- The live Pages site serves main's build: `install.ps1` equal to the built file (line endings
  aside, until 1.8 publishes it byte-for-byte), the Pages repository pushed that day, the
  update.ps1-for-real row below dated.
- The live privacy and terms pages say Portly, carry a new effective date and cover the
  browser-only build, the icon fallbacks, the extension and every third party the app talks to.
- The hygiene commit is merged with CI green; `npm audit` lists only advisories whose fix is
  younger than 7 days, each named here; the serveStatic double-encoding answer is recorded; no
  TimeoutOverflowWarning in a vitest run.
- `publish-static.ps1` and `portly --update` behave as decided and `check-scripts.ps1` passes in
  both PowerShell versions; the ARCHITECTURE and README drift is fixed.

Items:

- **1.1 Fast-forward to main and tidy the workspace** (S).
  Bring the roadmap branch up to main (cd547e3: 0.2.0-alpha.1, the CHANGELOG, the releases.md
  versioning rule; its CI run 39537797893 finished green on 2026-10-20). Bring the main checkout,
  which is the installed Portly, to origin/main with a clean `git status`, because `update.ps1`
  deploys that checkout as-is and never pulls. Remove the leftover detached worktree and the merged
  branches `claude/git-closeout-80a501` and `claude/project-status-34878a`. The memory note (the
  assistant's note on this PC's install state, kept outside the repository) already says
  0.2.0-alpha.1 is prepared and unreleased; refresh it after 1.3 and 1.6, when its Pages-site
  (last published 2026-10-13 at 0.1.0) and consent-page lines go stale.

  *Done when:* `git log HEAD..origin/main` is empty and `git status` clean in both the roadmap
  worktree and the main checkout; `git worktree list` shows only the main checkout and the roadmap
  worktree; `git branch --merged main` lists nothing else; the memory note matches. No push
  involved.

  *Status:* done 2026-10-26. On 2026-10-21 the roadmap branch was fast-forwarded to main
  (cd547e3), the main checkout was already at origin/main, and the memory note already recorded
  0.2.0-alpha.1 as prepared but unreleased. The two named branches were gone by 2026-10-26, when a
  git closeout of the main checkout (clean, level with origin/main at c13d868) removed the three
  leftover detached worktrees and deleted the seven merged `claude/*` branches; every item since
  1.2 ran in its own short-lived worktree, so there is no roadmap worktree left to keep.
  `git worktree list` now shows only the main checkout and `git branch` only `main`.

- **1.2 Land this plan in ROADMAP, CLAUDE.md and SETUP** (S; after 1.1).
  Replace `docs/ROADMAP.md` with these six phases and the checks table (one row per open
  *Not tested* note). `CLAUDE.md` gains three rules: the by-hand CSP check before a release, a
  commit's *Not tested* note copied into the checks table in the same commit, and busy-machine
  timeouts for process-spawning tests with no full suites in several sessions at once. SETUP marks
  `irm <site>/setup.ps1 | iex` owner-only until phase 5, because it clones a private repository
  (README only links to that section, so it needs no note). Push to main.

  *Done when:* the roadmap renders on GitHub; every item appears once with its number and the
  checks table has a row per open note; no document still refers to the old phase numbering
  (checked 2026-10-21: multi-pc.md and launchpad-sync.md updated); CI green on main after the
  push.

  *Status:* done: landed 2026-10-21 (ffea286) and pushed to main; CI on main is green at the
  latest push (run 40243167583 at c13d868, 2026-10-25).

- **1.3 Republish the Pages site (your new tab)** (S; go-ahead; after 1.1).
  In the main checkout: `git pull` to cd547e3 or later, `git status` clean,
  `git -C $env:PORTLY_PAGES_REPO fetch` and confirm the Pages repository has not diverged, then
  `portly --update` (`update.ps1` refuses worktrees and deploys the checkout as-is, warning about
  uncommitted changes rather than refusing them; refused since 1.8). This is the first real
  `update.ps1` run under `portly-supervisor.exe` and `portly-server.exe` (the update.ps1 row in the
  checks table).
  GitHub Pages serves the old page for up to 10 minutes after a publish; hard-refresh before
  judging.

  *Done when:* `curl -I https://davideaurum.github.io/install.ps1` reports a Content-Length equal
  to the built file's length (34,106 today; 33,446 while the Pages clone still commits it with LF
  endings, see 1.8);
  `gh repo view davideAurum/davideaurum.github.io --json pushedAt` is today; a hard-refreshed new
  tab shows the Wikipedia switch under Settings > Search; the installed server's `/api/health`
  reports 0.2.0-alpha.1; the update.ps1 row in the checks table is dated.

  *Status:* done 2026-10-21. Pre-checks: the main checkout clean at origin/main (69eac5c), the Pages
  clone level with its origin, the installed server stopped (last started by the extension on
  2026-10-20). `portly --update` ran `npm ci` (the lockfile had changed), the build and the publish
  (Pages commit 2bea990, pushed 17:11Z); `portly --start` then brought the server up and
  `/api/health` reports 0.2.0-alpha.1. The republished site, loaded past the CDN cache, shows the
  **Wikipedia suggestions instead** switch under Settings > Search, and the live `install.ps1` is
  the new one (33,446 bytes: the built file with LF endings, see 1.8). Two findings: the installed
  native-host launcher is the 2026-10-12 version (installed on 2026-10-18, before b5f5cc5 changed
  it on 2026-10-19), so this PC lacked the refusal of a Homebase health answer. Refreshed the same
  day with a real `install-autostart.ps1` run (the install-autostart row in the checks table): the
  installed `launcher.mjs` now matches main. And the Pages clone commits the scripts with LF
  endings (1.8).

- **1.4 Register the Pages origin as a Single-page application redirect** (S; go-ahead; after
  1.3).
  In the Azure app registration add `https://davideaurum.github.io/` as a *Single-page
  application* redirect URI beside the localhost one, as [Outlook.com](setup/microsoft.md)
  describes. You do this in the portal; it unblocks 2.1 and all of phase 6. Do it right after 1.3
  and start 2.1 the same day, because 2.1's renewal check is wall-clock time.

  *Done when:* on the republished site, Settings > Accounts > Outlook.com returns to
  `#/settings/accounts` connected instead of a `redirect_uri` error.

  *Status:* done. The redirect URI was registered on 2026-10-20 (the portal lists
  `https://davideaurum.github.io/` under *Single-page application*), and 2.1's first connect on the
  published site, on 2026-10-25, came back connected with no `redirect_uri` error.

- **1.5 Make site/ privacy and terms true for Portly** (S; after 1.1).
  `site/privacy.html` must say that the browser-only build keeps the Microsoft sign-in in the
  browser's IndexedDB (not DPAPI-encrypted), that bookmark icons may come from
  `icons.duckduckgo.com` and Google's s2 service, that RSS feeds, ESPN, the five search-suggestion
  providers, ICS/webcal subscriptions and Open-Meteo geocoding receive data, and, in a short
  extension section, that the extension talks only to localhost and the launcher. New effective
  date in `privacy.html` and `terms.html`; `site/index.html`'s own-OAuth-client line stays true
  for the alpha.

  *Done when:* checked against the authoritative host lists (the static CSP in
  `web/vite.config.ts`, `server/src/security/headers.ts`, the well-known hosts in
  `server/src/modules/diagnostics/report.ts`, `server/src/modules/bookmarks/favicons.ts` and
  "Who sees what" in [Browser-only build](setup/static-build.md)); every host named; "Homebase"
  appears only in a "formerly" line.

  *Status:* done 2026-10-21 (not published yet; that is 1.6). The three pages were rewritten and
  then reviewed against the code from three sides (facts, coverage of every host the CSPs, the
  well-known-hosts list and the favicon and suggestion code can reach, and plain language). The
  review found and fixed five things the first draft got wrong: hybrid mode was missing, the
  Wikipedia engine asks Wikipedia without the opt-in, the extension's fallback page has a Google
  search box, adding or editing a bookmark fetches the page for its title, and Portly's own page
  keeps the same 24-hour browser snapshot as the site. `site/index.html` now also says Portly
  runs as a browser-only site; its own-OAuth-client line is unchanged.

- **1.6 Republish the consent pages to homebase-site** (S; go-ahead; after 1.5).
  Publish `site/` to the homebase-site repository at its existing URLs (CLAUDE.md keeps them). The
  live privacy page says "Homebase" fifteen times and "Portly" never, and the real sign-ins in 2.2
  reach consent screens that link to it.

  *Done when:* `curl https://davideaurum.github.io/homebase-site/privacy.html` contains "Portly"
  and the new effective date; the Google and Microsoft consent-screen links still resolve.

  *Status:* done 2026-10-21. `site/` was copied into a fresh clone of davideAurum/homebase-site
  (Pages serves its main branch root), committed as 307fbf0 and pushed at 20:56Z; the Pages build
  finished within a minute. The live privacy and terms pages say Portly with "Effective October
  21, 2026", the home page names the browser-only site, "Homebase" appears once (the "formerly"
  line), the three consent-screen URLs answer 200, and the new font file is served. The clone
  gained `*.woff2 binary` in its `.gitattributes`. On 2026-10-29 the pages moved to
  davideAurum/portly-site and homebase-site became redirect pages (5.7).

- **1.7 One hygiene commit: advisories, persister, engine pin** (S; go-ahead; after 1.1).
  One commit that clears the open advisories, drops the unused persister and pins the Node major,
  with the reasons recorded where they belong:
  - `npm audit fix` for hono 4.13.8 (GHSA-5r4p-p66f-jhc7, the only production advisory), vite's
    launch-editor, shell-quote via concurrently and source-map-js. `min-release-age=7` may hold a
    fix back a week, so re-try until hono lands. Keep the exact imapflow 2.0.5 pin unless it has
    an advisory.
  - Before the hono fix, send a double-encoded path through `serveStatic` on a scratch server and
    read `@hono/node-server`'s `tryDecodeURI` in `dist/serve-static.mjs` to settle whether
    Portly's static routes are on the vulnerable path; record the answer here.
  - Drop `@tanstack/query-sync-storage-persister` from `web/package.json` and ARCHITECTURE 2a.
  - Pin engines to `>=24 <25` in the root `package.json` (the only one with an engines field),
    with a `check-scripts.ps1` assertion that `package.json`, `scripts/release/node-runtime.json`
    and `ci.yml` agree on the Node major, and a rationale line in ARCHITECTURE 2a: the server
    runs TypeScript through Node's type stripping and the supervisor's `--no-warnings` hides new
    runtime warnings except through the `process.on('warning')` log line, so a new Node major is
    a deliberate step.

  *Done when:* `npm ci`, typecheck, `npm test` (which includes the production audit gate), both
  builds, `check-scripts.ps1` and `check-release.ps1` green; `npm audit` lists only advisories
  whose fix version is younger than 7 days (`npm view <pkg>@<fixed> time`), each named here; the
  serveStatic double-encoding result recorded; CI green on main.

  *Status:* done 2026-10-21 (CI on main pending the push). `npm audit fix` within the declared
  ranges: hono 4.13.13, vite 8.3.4, concurrently 10.0.6 with shell-quote 1.12.0, source-map-js
  1.2.2, and vitest 5.0.4 for two dev-only advisories that appeared the same day
  (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp); nothing held back, `npm audit` reports 0; imapflow
  stays 2.0.5. The persister is gone; `engines.node` is `>=24 <25` and `check-scripts.ps1`
  fails when `package.json`, `scripts/release/node-runtime.json`, `ci.yml` or Common.ps1's
  minimum disagree on the major (checked in both PowerShell versions). Checked here: `npm ci`,
  typecheck, `npm test` (3,691 passed, 1 skipped; 344 extension and 79 native-host checks; audit
  gate 0), both builds, check-scripts.ps1 319/319 and check-release.ps1 27/27.
  The serveStatic answer (GHSA-5r4p-p66f-jhc7): not exploitable in Portly, checked live against a
  scratch server. Portly's static files go through `@hono/node-server`'s own `serveStatic`, which
  has the same second decode as hono's middleware, but every middleware is mounted on `*` and the
  gate checks the raw path, everything under `web/dist` is public, and traversal attempts are
  refused by the gate or by serveStatic's own post-decode check (the only effect seen: a
  malformed path such as `/%%36%31ssets/<asset>` serves a public asset with `no-cache` instead of
  the immutable cache header). The hono bump only clears the audit entry. The TimeoutOverflowWarning
  still prints (1.9). Found on the way: setup.ps1 would install Node 26 once winget's LTS moves,
  which the pin refuses: 1.11.

- **1.8 Harden publish-static.ps1 and portly --update** (M; after 1.1).
  `publish-static.ps1` merges a diverged Pages repository keeping Portly's files (or prints the
  exact commands) and prints the 10-minute cache note after a publish; `portly --update` refuses a
  dirty working tree unless `-AllowDirty`, instead of building and publishing uncommitted changes
  (say if you would rather it ask); `publish-static.ps1` also publishes `install.ps1` and
  `setup.ps1` byte-for-byte (the Pages clone has `core.autocrlf=true` and no `.gitattributes`, so
  today it commits them with LF endings: 33,446 bytes live against 34,106 built, found in 1.3).
  ASCII, CRLF, PowerShell 5.1 and 7, `-DryRun`;
  `scripts/README.md` and SETUP updated. 1.3 covers itself with the by-hand pre-checks; this lands
  before the next real `portly --update` (5.4 or 6.7).

  *Done when:* `check-scripts.ps1` passes with new fake cases (diverged repository, dirty tree) in
  both PowerShell versions; the next real `portly --update` shows the new messages.

  *Status:* done 2026-10-21, except the real run. `publish-static.ps1` fetches the clone's upstream
  first, fast-forwards a clone that is only behind, refuses a diverged one with the merge command
  (also in `-DryRun`, which now fetches), writes and stages a `.gitattributes` so `install.ps1` and
  `setup.ps1` are committed byte for byte, and prints the 10-minute cache note after a push;
  `update.ps1` refuses a dirty tree unless `-AllowDirty` (`portly --update --allow-dirty`), before
  `npm ci` or the build. check-scripts.ps1 gained the fake cases (behind, ahead, diverged, dirty,
  `-AllowDirty`, `.gitattributes` written and staged) and passes in both PowerShell versions. The
  next real `portly --update` (5.4 or earlier) shows the new messages and fixes the live
  `install.ps1` size: see the checks table.

- **1.9 Attribute and fix the TimeoutOverflowWarning** (S; after 1.1).
  Every vitest run prints, part-way through, "TimeoutOverflowWarning: ~2.25e9 does not fit into a
  32-bit signed integer. Timeout duration was set to 1"; the value tracks wall-clock time, so
  something arms a real `setTimeout` for about 2026-11-16 and it fires at once instead.
  `node --trace-warnings node_modules/vitest/vitest.mjs run` finds the site; clamp like
  `scheduler.ts`'s `MAX_TIMER_MS` if it is app code, otherwise fix the fixture.

  *Done when:* `npx vitest run` prints no TimeoutOverflowWarning; a unit test pins the clamp if app
  code was at fault.

  *Status:* done 2026-10-21. Traced with `NODE_OPTIONS=--trace-warnings` (the flag has to reach the
  worker processes) to a test fixture, not app code: the mail widget test seeded the accounts
  query on the real clock and then faked Date to 2026-09-25, so TanStack Query armed its stale
  timer for "real timestamp + 60 s minus the fake now", about 26 days. The seed now carries the
  test's clock, and the web test setup turns any TimeoutOverflowWarning into a failure that names
  the arming site (checked: the old seeding now fails the run).

- **1.10 Contract and docs drift, review tags, shortcut help** (S; after 1.1).
  ARCHITECTURE: section 13's "100k-VEVENT" becomes the 5,000-VEVENT feed cap and the 100,000-row
  cache, and notes that CI also runs on `workflow_dispatch`; 4.2 step 1 names the `%2e` forms and
  control-byte checks the gate already does; 10.4 lists Banner, CopyField, PasswordInput, Slider,
  FieldGroup, ErrorBoundary, QueryView, StaleIndicator, ServerOnlyNotice and the `Section.tsx` set
  (SettingsCard, FormFooter, FieldGrid, FactList); 10.8 the fourteen launch pad config fields.
  README's `scripts/` line in the layout list (it still names only start, autostart and status);
  README and static-build.md state the supported browsers of the browser-only build (Chromium:
  Chrome and Edge, for the alpha); launchpad-sync.md's "being redesigned in another session"
  lines. Record the UX-/PERF-/A11Y- review tags in a new `docs/design/review-2026-10.md` or strip
  them from the comments; add Shift+F10 / the context-menu key for the launch pad tile menu to the
  `?` shortcuts dialog.

  *Done when:* each changed sentence grepped against the code it cites;
  `grep -rn 'UX-[0-9]' web/src` resolves to the documented list or returns nothing; the shortcuts
  dialog test lists the new entry.

  *Status:* done 2026-10-21. Each changed sentence was read against the code it cites and
  reviewed once more by a second reader (three corrections: a calendar sizing claim, the order of
  the connect dialog's steps, a broken link). ARCHITECTURE 4.2, 10.4, 10.6, 10.8 and 13 match the
  code; README names every script and both README and static-build.md state the alpha's browsers;
  launchpad-sync.md describes the shipped Accounts page; the 16 review tags resolve in
  docs/design/review-2026-10.md; the `?` dialog lists Shift+F10 and the context-menu key for a
  launch pad tile (ViewTile handles both), with a test. ci.yml's header comment now also names
  workflow_dispatch. Checked: typecheck and the two scoped test files; the dialog was not looked
  at in a real browser.

- **1.11 setup.ps1 installs Node.js 24, not whatever LTS winget has** (S; after 1.7).
  With the Node major pinned (1.7), a fresh PC must get Node 24: `setup.ps1` installs winget's
  `OpenJS.NodeJS.LTS`, which moves to Node 26 when that becomes the LTS, and `Resolve-HbNode` in
  `scripts/lib/Common.ps1` accepts 24 or newer. Install `OpenJS.NodeJS.24` (winget lists one id per
  major) and have the checks refuse a major other than the pinned one, with the same wording in
  [SETUP](SETUP.md) and [Autostart](setup/autostart.md). Lands before any other PC is set up (3.3).

  *Done when:* `setup.ps1 -DryRun` on a PC without Node names the 24 package; `check-scripts.ps1`
  passes in both PowerShell versions with a fake for the refused major; CI green on main.

  *Status:* done 2026-10-21, with one fact the item got wrong: winget has no `OpenJS.NodeJS.24` id
  yet (a major gets its own id only once it stops being the LTS; today `OpenJS.NodeJS.LTS` is
  24.20.0). So `setup.ps1` asks winget for whichever of the two installs Node 24 at run time and
  names both in its messages; `Resolve-HbNode` and setup's own check refuse any other major with
  the install hint; `check-scripts.ps1` compares `$PortlyNodeMajor` (Common.ps1) and
  `$SetupNodeMajor` (setup.ps1) with the three places 1.7 pinned, and fakes a v26 and a v22
  `node.exe` (refused) and v24.x (accepted) in both shells. The dry run was checked with `node.exe`
  hidden from PATH on this PC, not on a fresh PC: see the checks table.

## Phase 2: Prove what is built, on this PC

Run once, with real accounts and real browsers, every behaviour that only fakes have exercised, and
date each result here before anything is built on top of it. Start 2.1 first because of its
24-hour wait; 2.2 and 2.6 use the installed Portly's real data on purpose (the one exception to the
scratch rule) after an export and a backup copy; the rest can run in parallel sessions.

Done when:
- Every release-relevant row in the checks table has a dated pass, or a merged fix with a test.
- Outlook.com on the published origin passed: connect, sync, write an event, the page-load
  `prompt=none` renewal after the 24-hour session ended, and the Reconnect fallback with its
  6-hour guard.
- Real Google and Microsoft sign-ins went through the connect dialog including Manage > Add,
  decline-all, Reconnect, Test and Remove; what each consent screen showed is recorded, and the
  "only requested services start enabled" rule is confirmed or re-decided.
- Every status in pages-local-server.md's table was seen in Chrome (pairing once in Edge),
  produced the way 2.3 lists, and a genuinely hidden tab's deferred reload was seen.
- Both production builds showed zero CSP violations, dated in ARCHITECTURE section 13 and
  releases.md.
- The Yahoo CalDAV and IMAP read result is written into ARCHITECTURE section 1 and yahoo.md;
  section 8 carries the verification date and releases.md says it is re-dated at every release.

Items:

- **2.1 Outlook.com on the published site (start first)** (M; after 1.3, 1.4).
  With your Outlook.com account on `https://davideaurum.github.io/`: connect (calendar only), sync,
  create, edit and delete an event and see it in Outlook, and note `sessionExpiresAt` under
  Settings > Diagnostics > This browser. Renewal runs at page load (`planSilentReauth`), not inside
  an open tab: come back after 24 hours, open the site and expect exactly one `prompt=none`
  redirect and no "Reconnect needed"; then withdraw consent at account.live.com/consent/Manage,
  reopen, and expect Reconnect with at most one further silent attempt within 6 hours (the retry
  guard). The scope-memory gap (6.1) is not observable here: `capabilitiesOf` hardcodes calendar,
  so a calendar-only connect refreshes with the right scope set whatever else the account granted.

  *Done when:* a real-account check in Chrome over more than 24 hours: events round-trip to
  Outlook; Diagnostics > This browser shows the renewal and no `reauth_required`; the Reconnect
  fallback and guard seen; a dated line here and in [Outlook.com](setup/microsoft.md).

  *Status:* done 2026-10-26, run by the owner with a real Outlook.com account on
  `https://davideaurum.github.io/` and reported as every step above passing: connected on
  2026-10-25, synced, and created, edited and deleted an event, each seen in Outlook; reopened
  after 2 pm on 2026-10-26, more than 24 hours after the connect, and the sign-in renewed by itself
  with no "Reconnect needed"; then consent withdrawn at account.live.com, and the site fell back
  to Reconnect. The assistant did not watch the browser, so the exact `sessionExpiresAt` and the
  Diagnostics lines were not written down.

- **2.2 Real Google and Microsoft sign-ins on the installed server** (M; after 1.1).
  On this PC's installed Portly, on purpose with real data, with one Google account, one
  Microsoft account and the Todoist row:
  - First Settings > Import & export > Export, and copy the newest file in `backups\`.
  - Google: connect with calendar only, then Manage > Add mail (incremental consent) and record
    what the consent screen lists. Microsoft: the same, recording whether its screen shows only
    the requested services.
  - Decline every scope once (the "denied when none granted" rule); Reconnect; Test (must report
    every enabled service healthy); Remove (revokes at Google and deletes the vault secret, so
    reconnect the Homebase-copied account afterwards).
  - Restart the server and confirm the accounts copied from Homebase unlock, which the
    2026-10-13 switch proved only by a log line.
  - Decide afterwards, if Microsoft's screen lists more than the requested services, whether
    "only requested services start enabled" stays the UI rule. If 5.6 renamed the apps before
    this, this run confirms the new name.

  *Done when:* each flow passes against the real providers; Settings > Accounts shows the right
  services enabled; Diagnostics > Connections healthy; a dated line per flow; any fix lands with a
  fake-provider test; the consent-screen answers and the rule decision recorded here.

  *Status:* done 2026-10-29 on the installed 0.2.0-alpha.1, run by the owner from the paired Pages
  site, each step confirmed in `server.log` and the accounts API. First a consistent copy of the
  database and the day's backup outside the data folder, and an export.
  - **Restart:** Portly's processes stopped and `portly --start`; the vault was ready and the
    Microsoft account copied from Homebase (2026-10-06) and the Google account both passed Test
    for calendar and mail.
  - **Google** (the new Cloud project of 5.6): Remove deleted the account and revoked the token
    at `oauth2.googleapis.com`; a calendar-only connect asked for the two calendar permissions;
    Manage > Mail asked for the Gmail permission only; with every box unticked, `oauth grant
    covers no capability` and no account saved; Reconnect and Test passed. The consent screen
    names Portly, says the app is not verified by Google, and links the portly-site privacy
    policy and terms.
  - **Microsoft:** after the owner withdrew Portly's consent at account.live.com, Cancel gave
    `denied` and no account; the calendar-only consent screen listed only the calendar
    permissions; Manage > Mail reconnected with both; Test passed. Remove deletes the account
    without a revocation: Microsoft keeps the consent until it is withdrawn there.
  - **The rule** "only requested services start enabled" stays: both providers asked for only
    what was ticked.

  Both accounts end connected with calendar and mail, and Diagnostics showed every health subject
  ok. Two findings for later, neither a failure of these flows: the new-event dialog lists the
  writable calendars by name only, so Google's "Calendar" and Outlook's "Calendar" look alike
  and Google's seemed missing; and the owner suggested that each provider's app registration sit
  with its connected accounts in Settings > Accounts rather than in a section of its own (both
  under *Revisit after phase 6* unless fixed sooner).

- **2.3 Hybrid pairing and hidden tabs in a real browser** (S; after 1.3).
  From the published site in Chrome, then pairing once in Edge, produce each status in
  [pages-local-server.md](setup/pages-local-server.md)'s table:
  - "not found" with the server stopped; "Found, not paired" with the server running and no
    pairing (footer and Diagnostics link).
  - Pair (Chrome's Local Network Access prompt for 127.0.0.1, the 1 s visible-and-focused
    arming) and `#/paired` with its nonce check; Disconnect; Revoke from Settings > About.
  - "Old address" via a scratch server (scratch `PORTLY_PORT` and `PORTLY_DATA_DIR`) started with
    a different `PORTLY_PAGES_URL`.
  - Leave a paired tab hidden across a server restart and confirm it reloads only once visible,
    after one more probe.
  - Expected refusals in Settings > Diagnostics > Server log: `pairing_required` before pairing
    and none after, `local_only` on the approval route from the Pages origin; anything else is a
    finding.

  *Done when:* every status seen once with the setup that produced it named; no console errors;
  only the expected refusal reasons in the server log; dated line.

  *Status:* done 2026-10-26 in Chrome, except the Edge pairing, which the owner deferred (checks
  table); the Edge pairing passed on 2026-10-29 (local network prompt, **Approve**, **Connected**). The owner ran the published site against the installed Portly; each server-side step
  was confirmed in its `server.log` and `supervisor.log`:
  - **Disconnect** from the site (`pairing removed`, `unpaired-itself`), then **Found, not
    paired**.
  - Local network access set back to *Ask*: **Not checked**, **Look for Portly on this PC**,
    **Waiting for permission** while Chrome's prompt was open, **Allow**, **Found, not paired**.
  - Portly stopped by hand: **Check again** gave **Browser only** with *Not detected*;
    `portly --start` (a `starting Portly` line), then **Found, not paired** again.
  - **Pair this browser**: the approval page, **Approve** armed after a second, back on the site
    with *This browser is now paired* and **Connected · v0.2.0-alpha.1** (`pairing created`).
  - Hidden tab: with a second tab in front, Portly stopped and restarted after about a minute
    (the page uploaded *reconnect grace started* and *ended*, and a second `starting Portly`);
    switching back to the first tab reloaded it once, and its Diagnostics > This browser showed
    the switch *deferred*, then *performed*.
  - **Revoke** of both Chrome pairings from the site's Settings > About (`pairing removed`,
    `revoked`); the site's next request was refused with `token_revoked` and it showed
    **Pairing removed**; paired again afterwards.
  - **Old address**, on a scratch copy instead of the published site, because the published site
    only looks for port 5757: `build:static` with `PORTLY_STATIC_SERVER` on port 5800,
    `preview:static`, and a scratch server (scratch port and data folder) with
    `PORTLY_PAGES_URL=http://localhost:5173/`, all in the desktop app's browser pane. Paired, then
    the server restarted with `http://localhost:5174/`: its own Settings > About listed the
    pairing as **Old address**, the site went to **Reconnecting…**, the log had `health check
    from another site (no CORS answer)`, and **Revoke** removed the pairing. **Approve** did not
    act while the pane was hidden, as the arming intends. (On 2026-10-29 one click into the
    approval page while the pane was hidden did arm it after a second: the embedded pane then
    reports the page as visible and focused. Only a page nobody has clicked into stays unarmed.)

  Refusals in the installed server's log during the run: only the one `token_revoked`, which the
  revoke step is meant to produce. `pairing_required` and `local_only` never appeared: the site
  sends nothing before it is paired, and nothing called the approval route from the Pages
  origin. The Console showed errors only from other extensions, none
  from Portly. One finding: the approval page's *It won't be able to* list
  (`web/src/app/PairPage.tsx`) says a paired site cannot connect accounts, set up OAuth clients,
  reset the vault or unpair browsers, but those routes are `samePc()`, which the paired site may
  call (the revoke above used one), as [Pages site with Portly](setup/pages-local-server.md)
  says. Only approving a pairing stays on Portly's own page. Fixed the same day: both lists now
  follow the routes' access (`samePc()` and `paired()` open to the site; approving a pairing or
  another PC, reading back a secret and the file paths not).

- **2.4 Real-browser UI and appearance sweep** (S; after 1.3).
  Each with a pass criterion: weather shows no geolocation prompt on page load and prompts only
  after the button; Wikipedia suggestions appear under the Google engine with no request to
  google.com in the Network tab; "Set location" lands focus on the location field within 10 s;
  Settings > Bookmarks shows Groups, Preferences, then Import & export; frosted glass on and off
  changes the DevTools Layers count and the baked blur shows with glass off; an EXIF-rotated JPEG
  uploads upright and a GIF and an SVG background with blur above 0 render (record the SVG
  softness), in Edge and Firefox with a visible window; the animated lighthouse animates as the
  extension's New Tab page and in Firefox; a Firefox smoke run of the browser-only site loads every
  widget.

  *Done when:* one dated line per item with its criterion met; defects become fixes with tests or
  parked lines with a reason.

  *Status:* the checks the desktop app's Chromium browser pane can make passed on 2026-10-29,
  against scratch servers at 8e98986; no defect found. The Wikipedia suggestions passed on
  2026-10-28 in the pre-release CSP check (checks table).
  - **Set location:** focus reached the location field 1.1 s after the click (the pane was hidden,
    so animation frames ran about once a second); when focus was already inside the dialog, the
    field was never focused in the next 12 s.
  - **Settings > Bookmarks:** Groups, Preferences, then Import & export, on the server's page and
    on the static build.
  - **Add widget's Calendar card** on a scratch static build paired with a scratch server: the
    Outlook.com-only text while browser only, then Google, Outlook.com, Yahoo, CalDAV and ICS once
    paired, the same as the server's own page.
  - **A hidden tab** (the pane hides a background tab 30 s after the last tool call on it): the
    local server probe went from about 30 s to 61 s apart, the clock stopped and caught up on
    return, the diagnostics upload stopped and restarted 15 s after the tab came back, and the
    query cache was saved once when the tab was hidden. Chrome's intensive throttling (over
    5 minutes hidden) was not reached.

  The rest, in the owner's browsers the same day, reported as passing: in Edge, no location
  prompt on page load, only *Use my location* asking and *Allow this time* working; frosted glass
  off and on in a visible window with the blurred photo still behind the cards (by eye, not the
  DevTools Layers count); a sideways phone photo upright, a GIF and an SVG background with blur
  rendering in Edge and Firefox (the SVG's softness not written down); the lighthouse animating
  on Chrome's Portly New Tab page and in Firefox. Firefox's smoke run of the published site loaded
  every widget and paired with the installed Portly; Firefox asked once to keep the site's data
  (`navigator.storage.persist()` after the first click, `web/src/main.tsx`), which Chrome and
  Edge decide without asking. Done 2026-10-29.

- **2.5 Production builds without CSP violations** (S; after 1.1).
  Serve `web/dist` from a scratch server (scratch `PORTLY_PORT` and `PORTLY_DATA_DIR`,
  `PORTLY_PAGES_URL` cleared) and `web/dist-static` with `npm run preview:static`; with DevTools
  open visit every widget, every settings section, the Diagnostics report download, a background
  upload and an export/import. Repeat after 1.7 lands and before every release; add the step to
  [Releases](setup/releases.md#cutting-a-release) as a pre-release check (next to the section 8
  re-date from 2.7) as well as `CLAUDE.md` (1.2).

  *Done when:* zero `securitypolicyviolation` entries in both builds; a dated line next to the rule
  in ARCHITECTURE section 13; releases.md carries the step.

  *Status:* done 2026-10-25 at 749ec2f (after 1.7 and 4.5), in the desktop app's Chromium-based
  browser pane, with a `securitypolicyviolation` listener on the page and the console read after
  each step and after a full reload. `web/dist` on a scratch server (scratch `PORTLY_PORT` and
  `PORTLY_DATA_DIR`, `PORTLY_PAGES_URL` cleared): all eleven settings sections, all six
  Diagnostics tabs, the report download, export then import, a background upload with blur 24,
  all nine widgets added and each widget's settings dialog opened. `web/dist-static` with
  `vite preview --mode static`: the same sections, both of its Diagnostics tabs, export then
  import, a background upload with blur 20, its seven widgets with their settings dialogs, a
  weather search (Open-Meteo geocoding and forecast), ESPN scores and logos, DuckDuckGo icons, and
  *Use my location* with a faked position, which named the place through Nominatim. Zero
  violations in both builds. Only expected console errors: 409 "not set up" answers on the empty
  scratch server, and the refused probe of 127.0.0.1:5757 while no Portly ran. Not covered: a
  search-suggestion request (suggestions were off) and a feed with a real URL, plus Edge and
  Firefox.

- **2.6 Yahoo: CalDAV reads and IMAP with an app password** (S; after 1.1).
  Add the Yahoo preset with an app password (no Yahoo account is connected on the installed Portly
  today). Confirm the calendar list and event sync inside the sync window, the capability probes,
  the IMAP listing (ENVELOPE only, no snippets), and archive and trash availability. ARCHITECTURE
  section 1 gates CalDAV writes on this read test and nothing records it; it is also the only
  real-server run of the IMAP worker, and it needs nothing from 2.2 because Yahoo uses an app
  password, not OAuth.

  *Done when:* the calendar and mail widgets show Yahoo data; both health subjects ok in
  Diagnostics; the result and date written into ARCHITECTURE section 1 and
  [Yahoo](setup/yahoo.md).

  *Status:* done 2026-10-29 on the installed Portly with the owner's Yahoo account and a new app
  password, typed in by the owner. The account saved with calendar and mail and passed Test.
  CalDAV found one calendar (read-only, synced, no error), and an event the owner made in Yahoo's
  web app arrived after a sync, not editable, as read-only intends. IMAP listed ten recent
  messages with sender, subject and date and no snippets, with archive and trash offered. The
  account, calendar-list and mail health subjects were ok. Written into ARCHITECTURE section 1
  and yahoo.md. Not tried: archiving or trashing a Yahoo message for real.

- **2.7 Provider-drift sweep and section 8 re-date** (S; after 2.2, 2.6).
  With the real accounts connected, open every widget (Gmail, Graph mail, both calendars, Todoist,
  ESPN, Open-Meteo, feeds, the five suggestion providers) and read Diagnostics; the bar is "every
  health subject ok", since drift that keeps health green is only visible by comparing a live
  response with the fields its mapper reads (the verbose Diagnostics log allows that for one
  provider at a time if you want it). Set ARCHITECTURE section 8's "verified" date to today and
  write the cadence into releases.md's pre-release checklist: section 8 is re-dated at every
  release.

  *Done when:* the Diagnostics overview shows every subject healthy; section 8 carries today's
  date; releases.md names the cadence; fixture changes come with passing tests.

  *Status:* done 2026-10-29, right after 2.2 and 2.6, on the installed Portly: all 44 health
  subjects ok. That covers the Google, Outlook.com and Yahoo accounts with their 13 calendars and
  three mailboxes, Todoist, Open-Meteo weather and its place name, five ESPN leagues, the feed,
  every scheduled job, and the five suggestion providers, each of which answered eight
  suggestions for one word. No field-level comparison of live answers was made (the bar is
  health), so no fixture changed. Section 8 now reads "verified 2026-10-29", and releases.md's
  *Cutting a release* step 3 names the re-date for every release.

## Phase 3: Every PC on Portly, Homebase retired

Prove the switch-over fixes with a real DPAPI key in scratch folders, then move each other PC off
Homebase and archive the Homebase repository. Since 2026-10-29 (F11) the other PCs do not run a
server of their own: each removes Homebase and uses this PC's Portly through Tailscale Serve
([Using Portly from your other PCs](setup/other-pcs.md), Track B). This phase does not gate a
release: another PC is touched only after 3.1 and 2.2. The release package and the failed-update
rehearsal live in 4.3, where a real scheduled task exists on a clean account.

Done when:
- The scratch rehearsal passed with a real DPAPI-protected key and the real data folder untouched.
- Each other PC: Homebase's task, server and New Tab extension gone, an export of its Homebase
  data kept; its browser connected to this PC's Portly through Serve and approved here; the
  widgets load there; Settings > Devices on this PC lists it.
- `docs/setup/other-pcs.md` was followed verbatim at least once, including a new part for a PC
  that ran Homebase, and corrected where a step was missing.
- The browser-side `-NoHomebaseCopy` behaviour is documented (or the opt-out is tested).
- davideAurum/Homebase is archived; the phase 3 row of the status table reads Done with the PC
  count and the date.

Items:

- **3.1 Scratch-folder rehearsal of the switch-over with a real DPAPI key** (M; after 2.2).
  Never the default data folder or `portly --copy-from-homebase`, which act on real data:
  - Start a scratch server (scratch `PORTLY_PORT`, `PORTLY_DATA_DIR` under the scratchpad,
    `PORTLY_PAGES_URL` cleared), save a secret (for example a Todoist token) so a real
    DPAPI-protected `vault.key` exists, and stop it.
  - Copy its `portly.db` to `homebase.db` beside that `vault.key`, because `legacy-homebase.ts`
    only finds a file named `homebase.db` (`LEGACY_DB_FILE`).
  - Point a second scratch data folder at it (`HOMEBASE_DATA_DIR` plus `copy-from-homebase.json`)
    and start a second scratch server.
  - Try the browser-side `homebase:` copy and the IndexedDB retry on a localhost preview.
  - b5f5cc5 (the extension and host refusing a Homebase health answer) cannot run here; 3.3
    exercises it only if Homebase's server is still running when Portly's extension first loads.

  *Done when:* the second folder holds the `MIGRATION_MARKER` file and the log's copied list
  contains `homebase.db -> portly.db` and `vault.key`; no `vault.key.unreadable-*` file; the secret
  decrypts (the Todoist token answers `/api/todoist`, not just "vault unlocked"); the real data
  folder's timestamps unchanged; dated line.

  *Status:* done 2026-10-29 at 8e98986, in scratch folders on ports 5810 to 5812, with the
  installed Portly on 5757 never sent a request. Every Done-when point passed:
  - **The copy.** The second folder's `migrated-from-homebase.json` says `copied` from the scratch
    Homebase folder, with `homebase.db -> portly.db` and `vault.key`; the log has the same list,
    then `vault: ready`. No `vault.key.unreadable-*` file. The server reports Homebase's instance
    id, so pairings keyed by it carry over.
  - **The secret decrypts.** The Todoist route is `GET /api/todoist/tasks` (there is no
    `/api/todoist`). It answered `token_rejected` after Todoist's 401 for the fake token, not
    `reauth_required` or "not connected". Saving a token needs a live Todoist account (the server
    checks it with Todoist first), so the fake token was written with the server's own vault code
    while the server was stopped. A fake Google OAuth client saved through the API also decrypted
    (the sign-in start built its URL).
  - **The key swap** (`"replace": true` over a folder with its own database and key): both moved
    aside with one time stamp, Homebase's key in place, and the moved-aside pair still opened.
  - **In the browser** (a scratch static build with hybrid mode off): the `homebase:` settings
    copied once behind `portly:migrated-from-homebase`, with an existing Portly value kept; the
    IndexedDB copy made to fail part-way tried on three loads and then gave up, and a copy that
    failed once succeeded on the next load.
  - **The real data folder** had the same timestamps before and after.

  Not run, as planned: the extension and host refusing a Homebase health answer (b5f5cc5) and the
  one-time `HOMEBASE_*` variable copy, which need a real Homebase PC and the installer. Two
  findings, both fixed in the same commit's comments and docs: copying leaves an empty
  `homebase.db-wal` and a `-shm` beside a cleanly stopped Homebase's database (the database itself
  unchanged), which three comments in `legacy-homebase.ts` and ARCHITECTURE section 19 denied;
  and a copy that gives up after three loads is reported only in the browser's console, not in
  Diagnostics (parked under *Revisit after phase 6*).

- **3.2 Per-PC checklist page** (S).
  `docs/setup/add-a-pc.md` (not `other-pcs.md`, which multi-pc.md reserves for the Tailscale
  guide): `setup.ps1` or the release installer, what `-NoHomebaseCopy` does and that browsers
  still copy their Homebase data on first visit (3.5), `portly --status`, remove the Homebase New
  Tab extension and Load unpacked Portly's (the one step setup cannot do), pair the Pages site,
  hard-refresh and expect the old page for 10 minutes, confirm Settings > Accounts shows no
  Reconnect and Diagnostics is green. Linked from SETUP; drafted first, then amended during 3.1
  and 3.3.

  *Done when:* followed verbatim on the first other PC and amended where a step was missing.

  *Status:* drafted 2026-10-27 as [Adding a PC](setup/add-a-pc.md), linked from SETUP (one-command
  setup and More) and the README. Its steps: before you start (Homebase or not, `-NoHomebaseCopy`,
  an export from the other PC); install (release or `setup.ps1`); `portly --status` in a new
  terminal; swap the extension and **Test launcher**; a new tab, the pairing, and the 10-minute
  cache; About, Accounts (the same app registrations reused), import, Diagnostics; then clean up
  Homebase. Every step was checked against the scripts and the guides it links, not yet against a
  PC: that is 3.3.

  *Changed 2026-10-29 (F11):* the other PCs connect instead of installing, so Adding a PC is no
  longer followed in this phase; it stays for anyone who wants a second server. This item now
  adds a part to [Using Portly from your other PCs](setup/other-pcs.md) for a PC that ran
  Homebase: export its Homebase data to a file and keep it (this PC's Portly already holds the
  accounts; import only what is missing, after a backup here); stop Homebase's server and remove
  its `\Homebase Server` task and `com.homebase.launcher` keys, the steps Portly's installer takes
  (`Remove-HbLegacyInstall`), as commands that need no Portly on that PC; remove its New Tab
  extension; delete
  `%LOCALAPPDATA%\Homebase` once Portly works there; and what that PC's New Tab shows now, since
  the extension cannot open another PC's Portly yet (B.6). Checked against Homebase's scripts,
  then followed verbatim in 3.3.

  *Status:* written 2026-10-29 as [A PC that ran Homebase](setup/other-pcs.md#a-pc-that-ran-homebase),
  linked from SETUP and Adding a PC; each command was checked against Homebase's and Portly's
  scripts and run read-only in Windows PowerShell 5.1 where it changes nothing. Not yet followed
  on a PC: that is 3.3.

- **3.3 Move the first other PC off Homebase** (S; go-ahead; after 3.1, 3.2, and 2.2 for the
  accounts this PC serves).
  On the PC you use most after this one, with Claude in the session: the new part of other-pcs.md
  verbatim, then connect that PC's browser through Serve and approve it from Portly's own page
  on this PC (checks table: the approval from this PC's own page and the name the connect screen
  fills in).

  *Done when:* Homebase's task and extension are gone there and the export file kept; Settings >
  Devices here lists the PC; its widgets load through Serve; dated line; other-pcs.md corrected
  where a step was missing.

- **3.4 The remaining PCs** (S; go-ahead; after 3.3).
  The same on each remaining PC; fix anything the first one exposed before the next.

  *Done when:* the same checks per PC; the phase 3 row names the count and the date.

- **3.5 Browser-side -NoHomebaseCopy behaviour** (S; after 3.2).
  Document plainly in SETUP that browsers copy `homebase:` localStorage keys and the IndexedDB
  database on first visit regardless of `-NoHomebaseCopy` (the copy is idempotent and marked, and
  the case ends when the last PC is switched). The opt-out marker is parked; say if you want it
  instead.

  *Done when:* the SETUP line is in; a fresh browser profile on the test PC behaves as documented.

  *Status:* the SETUP line is in (2026-10-27). SETUP's *Browsers* bullet says the copy happens
  with `-NoHomebaseCopy` too, and how to start a browser empty: delete the site's data after the
  first visit, which removes Homebase's in-browser data on the same origin as well, or use a new
  profile. [Adding a PC](setup/add-a-pc.md#browsers-keep-their-homebase-data) explains why
  (`web/src/legacyStorage.ts` copies once behind the `portly:migrated-from-homebase` marker, and
  `copyLegacyStaticDatabase` only into a new database, with up to three loads). The fresh-profile
  check is in the checks table, for 3.3.

- **3.6 Archive the Homebase repository** (S; go-ahead; after 3.4).
  After every PC is switched: delete its leftover branches and archive davideAurum/Homebase (it
  stays private). homebase-site is not archived: since 2026-10-29 it holds redirect pages to
  portly-site, which the 0.2.0-alpha.1 footer and old consent-screen links reach (5.7).

  *Done when:* `gh repo view davideAurum/Homebase --json isArchived` is true; the phase 3 row reads
  Done.

## Phase 4: Release rehearsal in private

Prove the shipping path end to end with a locally built package on a Windows account that has
never seen Portly, including the whole failed update and the Reload notice, and ready everything
the visibility flip needs, without publishing anything. Independent of phase 3; interleave it in a
free session.

Done when:
- A package built with the pinned Node download passes `check-release.ps1` and has the right
  `release.json` fields.
- `release.yml`'s build job ran green on the private repository with publish off.
- A clean local account installed from that package in Browser and Logon trigger modes, the new
  tab started the server, a deliberately failed update rolled back (old version serving, database
  restored), a changed extension version printed the Reload notice, and `uninstall-autostart.ps1`
  left no task, registry keys or host folder.
- README and SETUP were followed verbatim on that account and the list of insufficient points was
  empty on the second run.
- Release notes come from the CHANGELOG by script; the extension-store and ID policy is written
  down, including where the extension privacy statement lives.
- A scan of the full git history found nothing that visibility would publish by mistake.

Items:

- **4.1 Build with the pinned runtime download** (S).
  On a clean tree at main: `build-release.ps1` without `-NodeExe` (the nodejs.org download of
  24.21.0 with the SHA-256 check from `scripts/release/node-runtime.json`), a path that has never
  run; CI only uses the runner's `node.exe`. Inspect `release.json` (version, commit,
  extensionVersion 0.5.3) and the leak check.

  *Done when:* the build exits 0 with the download taken; `check-release.ps1` passes against that
  zip; the SHA-256 in `portly-release.json` matches.

  *Status:* done 2026-10-25 on a clean tree at 69e77e8 (Node 24.21.0, npm 11.19.0), output in a
  scratch folder. The build exited 0 and took the download: `node-v24.21.0-win-x64.zip` from
  nodejs.org matched the pinned SHA-256 (158f7685...e541), and `runtime\node.exe` reports
  v24.21.0 with a valid OpenJS Foundation signature. `release.json`: version 0.2.0-alpha.1,
  nodeSource nodejs.org, extensionVersion 0.5.3, commit 69e77e8, dirty false, releaseRepo
  davideAurum/Portly. `check-release.ps1 -ZipPath` passed all 25 checks, the leak check included
  (no tests, fixtures, web sources, dev packages or dev scripts). The zip (40.8 MB) hashes to
  ff7b9d10...3a87, the same as `portly-release.json`. No code change was needed. The scratch copy
  may be gone by 4.3; a rebuild from the same commit differs only in `builtAt` and the hash.

- **4.2 Run release.yml's build job with publish off** (S; go-ahead; after 4.1).
  `workflow_dispatch` on the private repository: runtime download, `check-release.ps1`, artifact
  upload. The publish job stays off; `publish-release.ps1` would refuse the private repository
  anyway. This is the only way to see the Actions path before it matters.

  *Done when:* `gh run list --workflow release.yml` shows one green run with an artifact whose
  `release.json` matches 4.1's version; nothing published.

  *Status:* done 2026-10-26. Run 40449825242 at abff1aa: the build-and-check job passed, the
  publish job was skipped (the run belongs to the repository as it was before the 2026-10-28 history
  rewrite, kept private as `davideAurum/Portly-private-archive`). The artifact's `release.json`
  reads 0.2.0-alpha.1, commit abff1aa,
  extension 0.5.3, not dirty, and the zip matched the SHA-256 in its `portly-release.json`. The
  repository has no releases.

- **4.3 Install, fail an update, and uninstall on a fresh Windows account** (M; go-ahead; after
  4.1).
  On a second local account on this PC or a VM, run the whole shipping path with 4.1's package.
  On this PC the main account's autostart must be removed first (`uninstall-autostart.ps1`, data
  kept; `install-autostart.ps1` afterwards): every account shares port 5757 and the task name
  `\Portly Server`.
  - Install: `install.ps1 -ZipPath` with the real `install-autostart.ps1` (Browser mode, then
    `-Trigger Logon`), `install-cli.ps1`, Load unpacked with Developer mode. A new tab must start
    the server through the native host and the scheduled task; `portly --status` and
    `portly --start` run under the `portly-*.exe` names; `portly --update` must fail with "The
    latest release of davideAurum/Portly was not found" until 5.3 (its success is 5.5's check).
  - Failed update: `install.ps1 -ZipPath -Force` with a package built from a throwaway branch
    whose server exits at start-up (`build-release.ps1 -AllowDirty`). The real task must stop,
    `Restore-InstDatabase` must put the previous database back (`portly-before-*` /
    `portly-failed-*`), `app.previous` must return and the old version must serve again.
  - Reload notice: a good package with a bumped `extensionVersion` in `release.json` must print
    the notice and the extension must still start the server. Watch for the sharing violation
    parked below during the update steps.
  - Finish with `uninstall-autostart.ps1`.

  *Done when:* `portly --status` healthy; `schtasks /query /tn "\Portly Server"` exists; a new tab
  opens Portly inside the launcher timeout; Settings > About shows 0.2.0-alpha.1 and a data folder
  under that user; `/api/health` reports the old version after the failed update and `backups\`
  holds `portly-failed-*`; the Reload notice appears; uninstall leaves no task, keys or host
  folder; dated lines, so the CHANGELOG's rollback sentence is true.

  *Status:* first run 2026-10-27 on a standard local account, Chrome, with packages built from
  abff1aa (the good one, one whose server exits at start-up, and one with extension 0.5.4).
  - Passed: the install (SHA-256, the task in Browser mode, the native host, the CLI, health
    0.2.0-alpha.1); Load unpacked; a new tab starting the stopped server through the launcher;
    Settings > About showing 0.2.0-alpha.1 and the account's own data folder; `portly --status`
    healthy; `portly --update` failing with "not found"; the switch to Logon mode; and
    `portly --start`. Uninstall removed the task, both registry keys and the host folder.
  - Failed: the update. `install.ps1` stopped Portly and copied the database. Then the Portly tab
    still open in Chrome had the launcher start the task again, and a file in `app` was in use.
    Windows PowerShell 5.1's `Move-Item` then moved part of `app` into `app.previous` and stopped.
    The server came back from the half-moved folder as version 0.0.0, the rollback never ran, and
    the next update refused the folder as "not a Portly release install". No sharing violation
    was seen.
  - Fixed in b75af65: the task is disabled while the folders are swapped and during a rollback,
    and each folder is renamed with `Directory.Move`, which moves all or nothing.
    `check-release.ps1` now holds a file in `app` during an update.

  Done 2026-10-27 with the rerun on the same account. `run.ps1` first removed what the first
  run had left, then used b75af65's `install.ps1` and the same three packages, with a Portly tab
  open in Chrome during both updates.
  - The install, a new tab starting the server, and the switch to Logon mode passed again.
  - The update to the package that exits at start-up stopped Portly and copied the database. The
    task was enabled again before the new version's `install-autostart.ps1` ran ("Existing task:
    Ready"). The supervisor gave up after five crashes, the installer reported "did not start"
    and put the database copy back, keeping `portly-failed-0.2.0-alpha.90-*`. It moved the new
    version to `app.failed` and started the old one: "The previous version is back".
    `/api/health` answered 0.2.0-alpha.1 and the open tab kept showing the dashboard.
  - The update to the package with extension 0.5.4 printed "The new-tab extension changed
    (0.5.3 -> 0.5.4)" and "Updated Portly 0.2.0-alpha.1 -> 0.2.0-alpha.91", with health 0.2.0-alpha.91.
    After Reload, a new tab started the stopped server.
  - Uninstall left no task, no registry keys and no host folder.
  - No move was blocked, there was no warning, and no sharing violation.
  - Both installer messages were in the log, but the owner did not notice them on screen; they
    had scrolled past.
  - The main account's autostart was removed for both runs and put back after each:
    `install-autostart.ps1`, health 0.2.0-alpha.1, with the Pages address and the other-PC port.

- **4.4 Newcomer read of README and SETUP** (S; after 4.3).
  Using only the docs on that account, write down every point where README or SETUP were
  insufficient (the Load unpacked path, Chrome 134+ Developer mode, the 15-25 minute app
  registrations, what export/import carries and never carries, the Pages cache) and fix each in a
  commit.

  *Done when:* a written list of insufficient points, each fixed in a commit, and a second
  run-through following the docs verbatim with an empty list.

  *Status:* done 2026-10-28. The second run-through came with 5.2 and 5.5 on a fresh account and
  found nothing missing: in 5.2 the owner followed the installed package's own SETUP from Load
  unpacked on and noted no gap; in 5.5 the one-line command from the README on github.com and the
  installer's own printed steps (Developer mode, Load unpacked, the folder on the clipboard) gave a
  working new tab without SETUP's help. The only confusion came from the session's instruction text,
  not the docs. The list and the fixes landed 2026-10-27. The
  read covered README, SETUP and the extension guide as a newcomer with a release package would
  meet them, plus what the owner missed in 4.3. What was missing, and what changed:
  - **The Reload notice scrolled past.** In 4.3 the owner did not notice it on screen. `install.ps1`
    now ends an update with it, as a yellow warning, and `check-release.ps1` builds a copy of the
    package with another extension version to check that the output ends with the notice.
  - **Keeping Developer mode on (Chrome 134+).** It was only in the extension guide, never on the
    release install's path. SETUP's Install section now says it, along with Chrome's *Keep it*
    prompt.
  - **What to do after the install.** The first look (a new tab, the *Home* layout, **E**,
    **Settings**) was only in the source-code quick start. The release path now has it too, and
    says that the `portly` command needs a new terminal.
  - **The release install's extension folder.** The extension guide named only a checkout path; it
    now names `%LOCALAPPDATA%\Programs\Portly\app\extension` and the clipboard. Its *Let the browser
    start Portly* section no longer sends a release install to run `install-autostart.ps1` again.
  - **The app registrations' time.** It was only in the accounts table. SETUP's three-part overview
    now says that Google and Microsoft each need one (about 15 and 25 minutes) and the others need
    only a password or token.
  - **What export and import carry.** SETUP said "settings, layouts and bookmarks (never accounts or
    credentials)". It now lists, as checked against `shared/src/export.ts` and
    `server/src/modules/core/transfer.ts`, what the file carries (settings, profiles and layouts
    with widget settings and feed addresses, bookmark groups and bookmarks, background images,
    custom icons). It also lists what it never carries (accounts, tokens and sign-ins, calendar
    subscriptions and ICS links, cached events, fetched icons) and the import summary and backup.
  - **The Pages cache.** Already in SETUP's Updating section, and now also in
    [Adding a PC](setup/add-a-pc.md), where a newcomer meets it.

  The question left for the owner, whether people other than the owner may point `-PagesUrl` at
  `https://davideaurum.github.io/`, was answered on 2026-10-28: no. SETUP and the hybrid-mode
  guide now say to pair Portly only with a Pages site you publish yourself, never the developer's
  (hybrid mode trusts the whole origin, D9).

- **4.5 Release notes from the CHANGELOG** (S).
  `publish-release.ps1` defaults `-Notes` to the CHANGELOG section for the version being published
  and `release.yml` passes it through; the `check-release` refusal paths keep passing.

  *Done when:* a dry run prints the 0.2.0-alpha.1 section as the notes; `check-release.ps1` and
  `check-scripts.ps1` green.

  *Status:* done 2026-10-25; merged to main (5213455) and pushed the same day.
  `publish-release.ps1` reads `CHANGELOG.md` at the package's commit (`git cat-file`, as UTF-8),
  takes the `## <version>` section, points relative links at that commit on github.com, prints
  the notes before the `gh` checks and hands them to `gh` with `--notes-file`; it refuses a missing
  or empty section and warns on "not released yet". `release.yml`'s publish job uses that default.
  `check-scripts.ps1` covers the parser with a fixture and the committed CHANGELOG. Checked: a
  dry run on a clean package (`build-release.ps1`, nodejs.org runtime) printed the 0.2.0-alpha.1
  section in Windows PowerShell 5.1 and PowerShell 7, then stopped at "davideAurum/Portly is
  private" as it should; `check-scripts.ps1` (379) and `check-release.ps1` (27, in both versions)
  green. The real `gh` call is in the checks table (5.3).

- **4.6 Write the extension-store and ID policy** (S).
  Store copies cannot keep the pinned ID (the manifest key's private key was discarded; Edge
  assigns its own), the native host allows exactly one origin and `manifest.test` forbids
  `update_url`. The alpha stays Load unpacked (say if you want stores sooner): write that, the
  store prerequisites (multi-origin host, installer and `status.ps1`, an ID per browser, listing
  assets) and where the extension privacy statement lives (the extension section on
  `site/privacy.html` at the kept homebase-site URL, 1.5) into
  [Releases](setup/releases.md) and `extension/README.md`.

  *Done when:* both docs state the policy and the privacy-statement location; the parked list
  below carries the prerequisites.

  *Status:* done 2026-10-25. [Releases](setup/releases.md#the-new-tab-extension-load-unpacked-no-store-listings)
  has a section on the policy, the prerequisites and the privacy statement's address, and
  `extension/README.md` a short "Stores: not for the alpha" section; the parked item below lists
  the prerequisites. Each claim was checked against `extension/manifest.json`,
  `extension/test/manifest.test.mjs` (`key` required, no `update_url`), `native-host/launcher.mjs`
  (it reads a list of origins, but `New-HbNativeHostPlan` in `scripts/lib/Common.ps1` writes
  exactly one) and `status.ps1` (checks the pinned ID only). The manifest `key` is unchanged.

- **4.7 Scan the full history before anything is public** (S).
  Flipping visibility publishes every commit reachable from any branch or tag. Grep
  `git log -p --all` with plain regexes (no new dependency) such as `-----BEGIN`, `client_secret`,
  `AIza`, `ya29\.`, `eyJ[A-Za-z0-9_-]{20,}`, `C:\\Users\\(?!you\b)`, personal e-mail domains and
  the owner's name outside the allowed davideAurum/Portly and davideaurum.github.io mentions;
  check LICENSE, README, CHANGELOG headers and `site/` links.

  *Done when:* the scan is empty or every hit is reviewed and recorded as acceptable; the patterns
  used and the date go here so the scan is reproducible.

  *Status:* done 2026-10-25; every hit reviewed and acceptable, no history rewrite needed. Input:
  `git log -p --all --format='COMMIT %H %s%n%b'` (104 commits: every local branch, no tags or
  stashes; the remote has only `main`), so commit messages are covered too, scanned line by line
  with Node regexes. Patterns: `-----BEGIN`; `client_secret` (any case); `AIza`; `ya29\.`;
  `eyJ[A-Za-z0-9_-]{20,}`; `gh[pousr]_[A-Za-z0-9]{30,}|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-`;
  `C:(\\\\|\\|/)+Users(\\\\|\\|/)+(?!you\b)` (any case, all three slash styles);
  `@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|proton|protonmail|aol|gmx)\.`;
  the owner's name (any case; not written here so this file does not carry it).
  Also checked: author and committer lines (only the GitHub noreply address and
  `noreply@anthropic.com`), file names ever committed (`server/dev.env` holds only a dev flag),
  LICENSE, the README and CHANGELOG headers and every `site/` link. Findings, all acceptable:
  - `-----BEGIN`: PUBLIC KEY wrappers in `extension/test/extension-id.test.mjs` and
    `scripts/check-scripts.ps1` (the manifest key is public by design), and this item.
  - `client_secret`: field names, redaction rules and docs in the accounts, diagnostics and
    logger code and tests, and the fixture constant in `accounts/__fixtures__/oauth.ts` (a
    `test...` value); no Google `GOCSPX-` value other than the short fake in a redaction test.
  - `AIza`: this item only. `ya29.` and `eyJ`: short fakes (27 and 57 characters) in the
    redaction tests of `shared/src/diagnostics.test.ts`, `server/src/lib/logger.test.ts`,
    `health.test.ts` and `log-files.test.ts`.
  - `C:\Users\`: fictional users in tests (riley, Riley Hollis, alice, dana, someone, x, O'Brien,
    D'Angelo, José, Émile Zola, plantedperson, `~`, `<name>`, Public, Shared), plus a two-letter test user in
    `server/src/lib/logger.test.ts` (renamed to `rl` on 2026-10-28); no real profile path.
  - E-mail: fictional test addresses (`me@`, `alice@gmail.com`, `bob@outlook.com`,
    `alex@`, `eve@`, `b@live.com`) and Apple's own `johnappleseed@icloud.com` example in
    `docs/setup/caldav-imap.md`; `pw@me.github.io` and `pass@me.github.io` are URL tests.
  - Owner name: only the GitHub handle `davideAurum`, in LICENSE ("Copyright (c) 2026
    davideAurum"), `site/*.html` (developer credit and the `https://github.com/davideAurum`
    contact link), `web/src/app/Footer.tsx` (same link), the kept `davideAurum/homebase-site`
    repository in this file, and removed lines naming the old `davideAurum/Homebase` defaults
    and a `homebase-pages` example. The handle is public as the repository owner; the surname
    appears nowhere. The README and CHANGELOG headers name no person; `site/` links go only to
    its own pages, the GitHub profile and Google and Microsoft account and policy pages.

## Phase 5: Go public and publish 0.2.0-alpha.1

Make the repository public and publish the first release, installable by anyone with the one-line
installer, as a repeat of the phase 4 rehearsal on the actual release candidate. It runs straight
after phase 4, as decided on 2026-10-20; launch pad sync (phase 6) follows and ships as
0.2.0-alpha.2.

The release is built from the branch `release/0.2.0-alpha.1`, cut from main at 6ac3731 on
2026-10-28 by the owner's decision, so that the sync code of phase 6 could merge to main before
the release while the first alpha still ships without it. A fix that must be in 0.2.0-alpha.1
goes on that branch as well as on main. Until 0.2.0-alpha.2 is released, `portly --update` on
this PC runs with `--skip-publish`, so the Pages site is not republished from main with unreleased
sync code.

Done when:
- davideAurum/Portly is public and a `workflow_dispatch` CI run after the flip is green.
- Release v0.2.0-alpha.1 exists, tagged on the exact commit it was built from, with notes from the
  CHANGELOG; `releases/latest/download/portly-release.json` resolves.
- The one-line installer worked on the clean account from the internet, `portly --update` there
  reported up to date, and the release candidate had been installed there first.
- The Pages site is republished at the released commit; README, SETUP and the CHANGELOG no longer
  say "not released yet"; the memory note is current.
- The consent-screen rename is done or recorded as skipped; the status table points at phase 6 as
  the next slice.

Items:

- **5.1 Make davideAurum/Portly public** (S; go-ahead; after 4.7).
  Flip the existing repository's visibility; every default (`install.ps1`, `build-release.ps1`,
  `release.yml`'s `GITHUB_REPOSITORY`, the docs) already names it, so no code changes. Neither
  phase 3 nor phase 6 holds this back. Flipping visibility starts no CI run, so trigger one by
  `workflow_dispatch`.

  *Done when:* `gh api repos/davideAurum/Portly --jq .private` is false; a `workflow_dispatch` CI
  run after the flip is green.

  *Status:* done 2026-10-28. A review before the flip found the owner's city in a weather fixture,
  so the history was rewritten first (F15): the new `davideAurum/Portly` was created private with
  immutable releases on, given the rewritten `main` and release branch, and made public the same
  evening. `workflow_dispatch` CI after the flip was green on main (run 40803373186, 03081da) and on
  the release branch (40803376165, 1189489). Pushes to main in the new repository started no CI run
  of their own (checks table).

- **5.2 Install the release candidate on the clean account** (S; go-ahead; after 4.3).
  Build the candidate from the tip of `release/0.2.0-alpha.1`, the commit to be tagged (pinned
  download), and install it on the phase 4 account; repeat the failed-update rollback only if
  `install.ps1` changed since 4.3. Needed because code lands between the rehearsal and the
  release.

  *Done when:* `portly --status` healthy; the installed version matches the candidate; dated line.

  The install follows README and SETUP verbatim, as 4.4's second run-through: write down every
  point where they fall short. An empty list closes 4.4. `install.ps1` changed after 4.3 (the
  Reload notice moved to the end in 4.4), so watch an update's last lines here too.

  *Status:* done 2026-10-28 on a fresh standard account (the 4.3 account was gone), with the main
  account's autostart removed first. The candidate was built with the pinned runtime and passed
  `check-release.ps1` (27/27 in both PowerShell versions), a PowerShell 7 install into a scratch
  folder and the `irm | iex` path (it stops at "not found" with the window open). Installed with its
  own `install.ps1 -ZipPath`, then:
  - SETUP followed from Load unpacked on; no point noted where it fell short.
  - A new tab started the stopped server.
  - A failed update (a 0.2.0-alpha.90 copy whose server exits with code 4) rolled back: "The
    previous version is back", `portly-failed-0.2.0-alpha.90-*` kept, 0.2.0-alpha.1 answering, the
    open tab on the dashboard.
  - An update to a copy with extension 0.5.4 ended with the yellow Reload warning as its last line
    in a visible window; after Reload a new tab started Portly.
  - `portly --settings` on the release install showed "Other PCs : not set".

  After the history rewrite and two documentation commits, `finish-5.2.ps1` installed the final
  build over it: installed commit 1189489, the tagged one, health OK.

- **5.3 Release-day commit, build and publish** (S; go-ahead; after 5.1, 5.2, and the release
  gates 2.1, 2.3, 2.5 and 4.3).
  One commit on `release/0.2.0-alpha.1`, not on main: the CHANGELOG entry gets its date, README
  and SETUP lose "No release is published yet", and SETUP loses the `setup.ps1` owner-only note.
  Work in a checkout of that branch outside `.claude\worktrees` (for example
  `git worktree add ..\Portly-release release/0.2.0-alpha.1`, then `npm ci` there). Push the
  branch, build from that clean commit, run `check-release.ps1` on it, then `publish-release.ps1`
  from that checkout (notes from the CHANGELOG via 4.5, `--target` that commit, `--latest` so
  `install.ps1` resolves it); `release.yml`'s publish job, run on the release branch, stays the
  fallback. A version is published once. Afterwards merge the release branch into main, which
  brings main the dated CHANGELOG and the README and SETUP lines, and delete the branch; the tag
  keeps the commit.

  *Done when:* `gh release view v0.2.0-alpha.1` lists the zip and `portly-release.json` with
  matching SHA-256; the tag points at the built commit on the release branch;
  `releases/latest/download/portly-release.json` resolves; main contains the tagged commit.

  *Status:* done 2026-10-28. On the release branch:
  - 09304f6, the release-day commit: dated CHANGELOG, an Other PCs bullet, a true known limit, no
    "not released yet" lines, the CSP check's results;
  - 9240123: the Calendar card in Add widget names Outlook.com alone in the browser-only build;
  - d7790ab and 1189489: the README's outside-traffic sentence, the "your own Pages site" note,
    fewer personal details, and `LICENSE` plus `THIRD_PARTY_NOTICES.md` in the package.

  Built from 1189489 (SHA-256 6ace3a5c...6351), `check-release.ps1` 27/27 in both versions, CI
  green. `publish-release.ps1` created the release as a draft, but its 41 MB zip upload stalled at
  about 4 KB/s (the CLI's HTTP/2 path to uploads.github.com; other uploads from this PC ran at
  1.6 MB/s). `gh release upload` with `GODEBUG=http2client=0` sent it in 12 minutes, GitHub's
  digest equal to the build, and `gh release edit --draft=false --latest` published it at
  2026-10-29T02:43Z (21:43 local) as immutable. The tag v0.2.0-alpha.1 is 1189489;
  `releases/latest/download/portly-release.json` resolves and the zip downloaded from the release
  hashes the same; the notes come from the CHANGELOG with links pinned to 1189489 and the arrow
  intact. Merged into main as cc0c348.

- **5.4 Republish the Pages site at the released commit** (S; go-ahead; after 5.3).
  `publish-static.ps1` from the release checkout of 5.3, at the tag, so the site's `install.ps1`
  and `setup.ps1` are the released ones and the footer shows the version. Not `portly --update`:
  `update.ps1` deploys the main checkout as-is, and main already carries the sync code of phase
  6. Until 0.2.0-alpha.2 is released, republish the site only this way and keep running
  `portly --update --skip-publish` on this PC.

  *Done when:* the live `install.ps1` is byte-equal to the tagged file; the footer reads
  0.2.0-alpha.1; the Pages repository's publish commit names the tagged commit.

  *Status:* done 2026-10-28. `publish-static.ps1` ran from the release checkout at the tag (HEAD
  equal to the tag, clean tree) and pushed Pages commit 39ae62c "Publish Portly 0.2.0-alpha.1
  (2026-10-28) from v0.2.0-alpha.1 1189489". The live `install.ps1` and `setup.ps1` hash equal to
  the tagged files (CRLF), the live page loads the bundle that was built, and the footer reads
  "Version 0.2.0-alpha.1 · Last updated Oct 28, 2026, 8:23 PM".

- **5.5 One-line installer from the internet on the clean account** (S; go-ahead; after 5.4).
  First, before anything is installed, open `https://davideaurum.github.io/` in that account's
  Chrome as a newcomer would. No item has looked at the published site on an account that never
  ran Portly. Expect the **Browser only** footer, every widget the browser-only build offers,
  Outlook.com connecting with your own app registration, and an export and import. Then remove
  the 5.2 install, and run `irm https://davideaurum.github.io/install.ps1 | iex` exactly as README
  says: the first install of Portly from a published release. Afterwards
  `portly --update` on that release install must report up to date, which closes the one
  `portly --update`-on-a-release-install check 4.3 could not run; watch again for the parked
  sharing violation.

  *Done when:* `portly --status` healthy; the new tab works; `portly --update` reports up to date;
  a dated line here as the date of the first install from a release.

  *Status:* done 2026-10-28, the first install of Portly from a published release, on the 5.2
  account after its install was removed.
  - **The published site:** the footer said **Not checked**, not **Browser only**: a browser that
    has not been allowed onto the local network does not look for Portly until **Look for Portly
    on this PC**. Add widget offered seven widgets. Outlook.com connected with the owner's own
    registration and showed events. Export then import worked.
  - **The install:** `irm https://davideaurum.github.io/install.ps1 | iex`, typed from the README
    on github.com, downloaded 0.2.0-alpha.1, checked its SHA-256 and set up the task, the native
    host and the `portly` command; the installer's printed steps loaded the extension and a new tab
    showed Portly. `portly --status` was healthy, and `portly --update` answered "Portly
    0.2.0-alpha.1 is already installed ... (-Force reinstalls it)". No sharing-violation retry
    appeared.
  - Uninstalled afterwards. This PC's own Portly (until now the main checkout) is off, and the
    owner plans to move it to a release install with the same one-line command. Its data folder
    works as is: the release and main have the same six migrations and extension 0.5.3.

- **5.6 Rename the app on the consent screens (optional)** (S; go-ahead; after 1.6).
  Google Cloud and Azure portals: app name Portly, privacy and terms links to the republished
  pages, redirect URIs unchanged; [google.md](setup/google.md) and
  [microsoft.md](setup/microsoft.md) updated. Any time after 1.6; if done before 2.2, that run
  confirms the new name and no separate sign-in is needed, otherwise one real sign-in per provider
  shows it.

  *Done when:* both consent screens show Portly during a real connect (2.2 or a later sign-in).

  *Status:* the docs need no change (checked 2026-10-27). [google.md](setup/google.md) already
  names the app `Portly` with the kept homebase-site links, and [microsoft.md](setup/microsoft.md)
  asks for no name or links of its own. The Azure registration has been named Portly since
  2026-10-20. What is left happens in the portals:
  - Google Cloud console, **Google Auth platform → Branding**: the app name and the home, privacy
    and terms links;
  - Azure, **Branding & properties**: the name.

  2.2's sign-ins then confirm both.

  *Skipped for phase 5* on 2026-10-28 (5.7): it is optional and nothing in the release depends on
  it. The two portal steps above stay open; do them whenever you like, and 2.2's sign-ins confirm
  them.

  *Google half done* on 2026-10-29. Rather than rename, the owner made a new Cloud project, since
  the old project's ID (with the old name in it) cannot be changed. The new project has the app
  name Portly, the three portly-site links and the same redirect URI. Its client went from
  1Password straight into the installed Portly (`PUT /api/oauth-clients/google`, the secret in
  neither a command nor its output), and the one Google account was reconnected: status `ok`,
  Portly's account test ok for calendar and mail. The owner shut the old project down the same
  day (Google deletes it after 30 days).

  *Done* on 2026-10-29. The Azure registration was already named Portly (since 2026-10-20):
  Microsoft's sign-in page for it gives the display name Portly (`oClientAppProperties`, read
  with `curl` from the authorize URL, without signing in). No Microsoft sign-in ran today.

- **5.7 Close the loop** (S; after 5.5).
  Roadmap statuses, an "Unreleased" CHANGELOG section, the memory note, and Known limits still true
  (unsigned packages, unpacked extension, own app registrations, Windows 11 x64). The next slice is
  phase 6; the post-alpha candidates (multi-PC build, first-run checklist, default sign-in apps,
  store listings, CalDAV writes, custom domain, the published release on a secondary PC)
  are listed under [Revisit after phase 6](#revisit-after-phase-6) and get a go or no-go each once
  phase 6 ships. Announcing anywhere is your call and not part of this plan.

  *Done when:* docs on main; CI green; the phase 5 row reads Done and the phase 6 row In progress.

  *Status:* done 2026-10-28. The status table reads Done for phase 5 and In progress for phase 6;
  the CHANGELOG has an "Unreleased" section for the sync code on main ([releases.md](setup/releases.md)
  says how it becomes the next version's); the Known limits are still true on main (no signing step
  in the build, Load unpacked, own app registrations, `win-x64` only); 5.6 is recorded as skipped;
  the memory note is current. The three rows the release left in the checks table:
  - **Pushes to main start no CI run.** Not caused by anything in the repository: GitHub received
    every push (other apps got their checks), the workflows are registered and active, Actions is
    on with all actions allowed, no commit carries a skip marker, the settings match the old
    repository's apart from visibility, and GitHub reported no incident at the time. GitHub
    Actions simply created no run, not even a skipped one. The likely cause is state on GitHub's
    side from creating the repository under a name that had been renamed away minutes before.
    Another session's push (084dee4, after the rulesets went on) started none either. The CI
    workflow was then disabled and enabled again at 04:47Z on 2026-10-29 (23:47 local), in case
    GitHub's record of it was stale, and the 5.7 commit (f6a5152) was pushed: no run either. What
    is left is GitHub's to fix, through GitHub Support if you want it fixed (the checks table has
    the evidence). Until then, start CI by hand after each push to main (CLAUDE.md). f6a5152's
    `workflow_dispatch` run 40820053201 was green.
  - **Public-repository settings** (the owner's go-ahead, 2026-10-28): private vulnerability
    reporting, secret scanning and push protection on; rulesets "Protect main" (no force push, no
    deletion) and "Protect release tags" (`v*`: no move, no deletion), with no bypass. Approval for
    outside contributors' runs stays at GitHub's default (first-time contributors), the owner's
    choice.
  - **The consent pages moved** (the owner's choice and go-ahead, 2026-10-29). The owner asked
    why they still lived at the homebase-site address. They now live in a new public repository,
    davideAurum/portly-site, served at `https://davideaurum.github.io/portly-site/` (Pages from
    main, root; a3e1892, a copy of `site/` at 61e589f). homebase-site kept its name and history
    and got redirect pages (79c351d): `index.html`, `privacy.html` and `terms.html` each refresh
    to the same page at the new address and link to it, and a `404.html` sends anything else to
    the new home page. A new repository rather than a rename, because reusing a renamed-away
    name is the likely cause of the missing push CI runs above. The footer (`SITE_URL`),
    google.md and the other docs name the new address. The Google console's Branding links are
    the owner's to change (checks table).

## Phase 6: Launch pad sync, shipped as 0.2.0-alpha.2

Fix the account-scope gap, build the sync design's phases 1-5 on the verified Outlook.com-on-Pages
flow, and ship the result as 0.2.0-alpha.2 by repeating the phase 5 release steps. 6.1 may be built
in a parallel worktree as soon as phase 2 closes and needs no decision. It was to merge to main
only after 5.3 had tagged 0.2.0-alpha.1; on 2026-10-28 the owner cut `release/0.2.0-alpha.1`
from main instead (phase 5) and merged 6.1 to 6.6 and G.1 to G.3 to main, so the first alpha
still ships without sync code; 6.2 writes the
decisions taken on 2026-10-20 into the design doc before any other sync code lands. Design:
[design/launchpad-sync.md](design/launchpad-sync.md).

Done when:
- The design doc carries the sync decisions and no sync code beyond 6.1 was written before it did.
- Browser-only accounts remember the scopes their last sign-in asked for: unit-proven in 6.1 (the
  stored set a strict subset of the grants), proven for real in 6.6 with a calendar-only connect,
  an added sync service and a withdrawn consent, with no `invalid_grant` loop.
- Merge tests prove the merge commutative, idempotent and convergent across three simulated PCs;
  engine tests cover the 412 race, first-upload 404, hostile, newer, oversized and missing files.
- Two browsers on one account converge on the published site, including a delete, a forced
  conflict and an offline edit; the static CSP lists only the download hosts actually observed as
  new, and the download ETag/cTag comparison is recorded.
- static-build.md, microsoft.md, ARCHITECTURE sections 1, 4.1, 10.5, 16 and 17 and the README
  describe sync; the site is republished.
- Release v0.2.0-alpha.2 is published and installed on the clean account the way phase 5 did it.

Items:

- **6.1 Remember the scopes each sign-in asked for** (M; after 2.1).
  `StoredAccount` keeps the services and scopes the last sign-in requested; capabilities, refresh
  (the `refresh` function in `web/src/static/handlers/accounts.ts`) and `planSilentReauth` use
  that set instead of Microsoft's reported grants (which list every grant the account ever made);
  a one-time upgrade fills existing rows; tests for connect, reconnect, incremental add and
  renewal. Today `capabilitiesOf` hardcodes `['calendar']`, so the gap is latent and becomes live
  the moment `launchpadSync` exists, which is why this lands before 6.2 adds that value; the
  requested list is already in hand in `connect()`.

  *Done when:* static project tests where the stored requested set is a strict subset of the grants
  and the refresh and silent-renewal request bodies use the stored set; the real check is deferred
  to 6.6 (connect calendar-only, add sync, withdraw one consent at account.live.com/consent/Manage,
  reload, expect the right Reconnect prompt and no `invalid_grant` loop).

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged (waits for 5.3). Account rows
  keep `requestedScopes`; services are what the sign-in asked for and was granted; the refresh,
  the reconnect and `planSilentReauth` ask for those only; the `account-requested-scopes` upgrade
  fills older rows with the calendar's scopes. Static tests cover connect, reconnect, adding a
  service by a sign-in that names it, renewal and the upgrade, with Microsoft reporting a wider
  grant (mail and the app folder) than was asked for. The real check stays with 6.6.

  *Real check:* passed 2026-10-29 on `preview:static` (6.6): consent withdrawn at
  account.live.com, then one failed refresh, **Reconnect needed** and no `invalid_grant` loop.

- **6.2 Write the decisions into the design doc and add launchpadSync to the contract** (M;
  after 2.1, 6.1).
  Write D7 to D9 into [design/launchpad-sync.md](design/launchpad-sync.md) (the shared enum as
  the contract route, every default listed under D8, the shared-origin risk accepted for now and
  decided again before 6.5 ships) and mark the Accounts-redesign lines shipped. Then extend the
  shared `Capability` enum (`CAPABILITY_NAMES`, `capabilitiesOf`, `PAGE_SUPPORT` and `OFFERED`;
  the shared `OAUTH_PROVIDER_CAPABILITIES` in `shared/src/accounts.ts` leaves it out for both
  providers, so the server's `unsupportedCapabilities` refuses it) and add a `launchpadSync`
  per-load capability that is true only on the browser backend.

  *Done when:* `npm run typecheck` over shared, server and web; the server oauth tests refuse the
  capability; `isCapabilityList` keeps rows carrying it; the Microsoft tile offers it only on the
  browser backend.

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged. The design doc has a new
  section 0 with D7 to D9 (D8's "only sync" line points at this roadmap's D8), the first-sync
  dialog down to two choices and sync's own backup slot; the Accounts lines were already marked
  shipped. `launchpadSync` is a shared `Capability` (`Files.ReadWrite.AppFolder` in the browser
  build); the server refuses it with 422 for both providers; the per-load `launchpadSync` flag is
  true on the browser backend only; the Microsoft tile offers it there, unticked. A sign-in that
  names no service asks for the calendar only, and `OAuthStartSchema` now refuses a service named
  twice (it relied on the list's length before). Typecheck and the shared, server oauth, static
  and settings tests pass.

- **6.3 Bookmarks slice groundwork (design phase 1)** (M; after 6.2).
  A hybrid logical clock in sync state, `placedAt` for sort and `groupId` so `renumber()` and
  moves stop bumping `updatedAt`, lasting tombstones `{kind, id, at}` written in the same commit by
  every removing path (group delete with cascade, bookmark delete, import and backup restore),
  `BackupEntry.reason`, the one-time upgrade setting `placedAt = updatedAt`, and a test that
  enumerates the removing paths.

  *Done when:* static tests including the removing-paths enumeration; the export/import round trip
  is unchanged; `staticParity` untouched.

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged. The clock lives in a new
  `launchpad-sync` slice (`sync/clock.ts`) and stamps every bookmarks write; `renumber()`, reorder
  and move stamp `placedAt` only; group delete (with its bookmarks), bookmark delete and a config
  import or backup restore write tombstones in the same commit (`sync/tombstones.ts`, 90 days);
  the `bookmarks-sync-fields` upgrade sets `placedAt = updatedAt`; `BackupEntry.reason` and
  `keepBackups()` give sync a slot of its own (D8). `tombstones.test.ts` lists the removing paths
  from the source. The export file is unchanged (no stamps or tombstones in it) and
  `staticParity` was not touched. The settings pointers (`defaultGroupId`, `ungroupedGroupId`)
  get their stamps with the engine's commit hook in 6.5.

- **6.4 File format and merge in shared/ (design phase 2)** (M; after 6.3).
  A strict versioned zod schema (`portly-sync` version 1) from the export schemas plus timestamps
  and tombstones with caps; validation through `parseImportFile`, `assertSafeJson` and
  `decodeImage` with the 25 MB and 10 MB limits; a pure merge function with fixtures under
  `web/src/static/sync/__fixtures__/`.

  *Done when:* tests prove the merge commutative, idempotent and convergent across three simulated
  PCs; hostile and oversized fixtures are rejected.

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged. `shared/src/launchpadSync.ts`
  has the `portly-sync` v1 schema and a pure merge; `web/src/static/sync/format.ts` reads the file
  and icons as hostile input. `merge.test.ts` runs 120 seeded random cases each for commutativity
  and idempotence, all six merge orders of three PCs, and three PCs syncing through one file in
  random order (a mutation of the tie rule or the tombstone join makes them fail);
  `format.test.ts` refuses oversized, non-JSON, prototype-key, deeply nested, foreign, newer,
  schema-breaking and far-future files and bad icons. Two refinements of the design, written into
  it (sections 6.3, 6.4, 6.8): the file keeps a removed row's content until its tombstone expires
  (so every sync order gives the same file), and two "No group" groups are not folded together
  (a limit; the first sync replaces one side, D8). Missing groups and icons are repaired by the
  browser applying the file, in 6.5.

- **6.5 Drive client and sync engine (design phase 3)** (L; after 6.1, 6.4).
  The engine as the design describes it, with its download hosts verified before the allowlist is
  final:
  - `providers/graphDrive.ts`: approot via `select=`, download through
    `@microsoft.graph.downloadUrl` with a host allowlist, no credentials, byte cap and timeout;
    PUT with `If-Match` or `conflictBehavior=fail`; create-only icon uploads.
  - The eTag loop with three retries then "busy", the triggers with a 60 s shared throttle, a Web
    Lock like `withAccountLock`, a lasting changes-waiting flag from a `StaticState` commit hook,
    calendar-style backoff with `Retry-After`, safety backups, and `connect-src` additions for
    the download hosts.
  - Before the allowlist is final: observe which download host a second sign-in returns (a second
    Outlook.com account if you have one, otherwise the same account from Edge); if
    `*.files.1drv.com` is never seen, leave it out rather than allowlist an unverified host;
    compare the download's ETag/cTag with Graph's once and record both answers in the design doc.
  - Before this ships, decide again on the custom domain (the shared-origin risk accepted on
    2026-10-20). Run `/code-review` at high effort on it before merging.

  *Done when:* `createFakeFetch` tests for the 412 race, first-upload 404, hostile, newer, oversized
  and missing files; no dependency added; the download-host and ETag/cTag findings recorded; the
  CSP check (2.5) repeated on `preview:static`.

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged; the parts that need you are
  open. Built: the `SyncStore` interface (shared with the gist store), `providers/graphDrive.ts`,
  `sync/engine.ts`, `sync/local.ts`, `sync/hook.ts` (a new `StaticState` commit hook),
  `sync/scheduler.ts` started by the page's backend, and `my.microsoftpersonalcontent.com` in the
  static CSP. Tests with `createFakeFetch()` and a fake OneDrive (no network): the 412 race, busy
  after three, the first upload's 404 and create-only write, hostile, newer, oversized and missing
  files, the first-sync choice both ways, a new epoch, deletes, custom icons (and a bad one), a
  bookmark whose group is gone, a local change during a round, a config import; the store's
  requests, download host check, 401 retry and failure codes; the hook and the scheduler. No
  dependency added. Waiting for you: (1) a real second sign-in (a second Outlook.com account, or
  the same one from Edge) to see which download host it gets, and once the download's
  `ETag`/`cTag` compared with Graph's; `*.files.1drv.com` stays out of the allowlist until then;
  (2) the CSP check on `preview:static`, which needs a connected account with sync on to make the
  new requests (6.6 adds the switch; for now `enabledCapabilities` would have to be set by hand);
  (3) the D9 custom-domain decision before this ships (decided 2026-10-29: the site stays at
  davideaurum.github.io).

  *2026-10-29:* (1) a second sign-in to the same account from Edge downloaded from
  `my.microsoftpersonalcontent.com`, the same host as Chrome; `*.files.1drv.com` was never seen
  and stays out. The `ETag`/`cTag` comparison was not made (checks table). (2) The CSP check
  on `preview:static` with sync running found no violation in Chrome or Edge. (3) Decided.

- **6.6 Accounts and UI for sync (design phase 4)** (M; after 6.5).
  The service checkbox and status line on the Microsoft connection card, the incremental-consent
  step (explain, reconnect with the larger set, back to `#/settings/accounts`), the first-sync
  dialog defaulting to *Use the synced launch pad*, the Settings > Bookmarks pointer, the import
  warning and a "sync" client event category. This is where 6.1 gets its real check.
  For GitHub as well (G.3): the status line and **Sync now** on the GitHub row, the first-sync
  dialog for either source, the `several_sources` status ("Launch pad sync is set up twice: remove
  one"), and keeping a second sync connection from being set up (the GitHub tile and the Microsoft
  service switch name the connection that syncs today; design section 6.10), and Reconnect wording
  for a refused GitHub token (new token, or the repository made private again).

  *Status:* built 2026-10-27 on the OneDrive sync branch, not merged; the checks with your accounts
  are open. Built: `GET`/`POST /api/sync/launchpad[/now]`; the status line, **Sync now** and
  Details on the Microsoft card and the GitHub row; the first-sync dialog (default *Use the synced
  launch pad*); the "set up twice" warning; one sync connection enforced by the account and GitHub
  routes (`409 conflict`, a sign-in leaves sync off) and the page (move offer between Microsoft
  connections, GitHub form and Microsoft switch blocked); the permission note before a sign-in that
  asks for the app folder; the Settings > Bookmarks line; the import warning and *Backup before
  sync*; the `sync` client event category. The GitHub dialog's "still being built" note is gone.
  Tests: web and static, with mocked answers and fakes. Waiting for you (steps in the 6.6 report):
  the `preview:static` check with your Microsoft account (consent screen, Diagnostics sync events,
  CSP), 6.1's consent-withdrawal check, and the same with your GitHub repository.

  *Real checks:* done 2026-10-29 by the owner on `npm run preview:static` (`localhost:5173`), in
  Chrome and Edge with one Outlook.com account and a new private repository, each result
  confirmed from the browser or GitHub's API:
  - **Microsoft:** a calendar-only connect asked for profile and calendars; turning on Launch pad
    sync asked for "Have full access to the application's folder" alone. Chrome's first upload
    met Graph's 404 for the missing file and created it; Edge, with no launch pad of its own,
    took the synced one without a question; an add in Edge and a rename in Chrome reached the
    other browser within about a minute. No CSP violation in either console.
  - **6.1:** consent withdrawn at account.live.com; Chrome kept its unexpired token until
    **Test** forced a refresh, then one failure, **Reconnect needed** and no loop; Reconnect
    restored sync. The installed Portly's Outlook.com account, which shares the registration,
    needed its own Reconnect afterwards.
  - **GitHub:** the GitHub form refused while OneDrive synced; the save refused the new repository
    while it was public and worked once it was private; Edge wrote the first file, Chrome joined
    through the first-sync question, and edits converged both ways (three commits).

  Findings: the first-sync question says the two launch pads "are different" without comparing
  them (it asks whenever both have rows, as after a reconnect); the Microsoft registration has no
  terms or privacy address, so its consent screen says so. Both are parked under *Revisit after
  phase 6*. Not seen here: the *Syncing…* state, **Backup before sync**, the `sync` events in
  Diagnostics, an icon synced, a forced race, a revoked GitHub token (checks table, 6.7).

  *Done when:* web and static tests; on `npm run preview:static` with your account, Microsoft's
  screen lists only `Files.ReadWrite.AppFolder` and Diagnostics shows sync events; then connect
  calendar-only, add sync, withdraw one consent at account.live.com/consent/Manage, reload, and
  see the right Reconnect prompt with no `invalid_grant` loop (6.1's real check).

- **6.7 Docs, republish and the two-browser test (design phase 5)** (M; go-ahead; after 6.6).
  static-build.md, microsoft.md, ARCHITECTURE sections 1, 4.1, 10.5, 16 and 17, a README line;
  `site/privacy.html` (it names neither the OneDrive app folder nor the GitHub repository yet) and
  its republish to davideAurum/portly-site (5.7's status);
  `portly --update` (with 1.8's dirty-tree refusal in place); then Chrome and Edge (and a second
  PC) on one account: add, rename, move, delete and reorder on each side, an offline edit, a
  forced conflict, a first sync on a fresh browser, consent withdrawal; record the download host
  seen from each browser and a Firefox smoke run of it.

  *Done when:* both browsers converge within the trigger cadence; `backups\` holds the pre-sync
  safety copy; no busy loop in Diagnostics; the hosts seen recorded; dated line.

  *Status:* the docs part written 2026-10-29: static-build.md's *Launch pad sync* (OneDrive and
  GitHub, the repository and fine-grained token steps, the first-sync choice, what is not
  synced), microsoft.md, ARCHITECTURE sections 1, 4.1 (D9's decision), 10.5, 16 and 17, a README
  line, the CHANGELOG's Unreleased entry, and `site/privacy.html` (the app folder, GitHub, what
  the synced files hold; effective October 29, 2026). Every sentence was checked against the
  code by a second pass. GitHub's own page labels for the token (**Read and write**, **No
  access**, Metadata added by itself) could not be checked in the code; G.3's real check settles
  them. Still open: the republish of the site and the privacy page, `portly --update`, and the
  two-browser test.

  *Changed 2026-10-29 (the owner's choice):* the Pages site and the privacy page are published
  together from the 0.2.0-alpha.2 tag in 6.8, not from main before it, so the public site gets
  sync with the release that ships it. The published-site test follows the release. This PC now
  runs a release install, so its `portly --update` installs 0.2.0-alpha.2 (the checkout's
  dirty-tree refusal stays a row in the checks table).

- **6.8 Release 0.2.0-alpha.2** (S; go-ahead; after 6.7).
  The CHANGELOG's "Unreleased" section becomes the 0.2.0-alpha.2 entry; the candidate installed on
  the clean account as in 5.2; publish as in 5.3 (the `v*` tag ruleset does not restrict creating
  a tag, so the release can still create its own); the Pages site republished as in 5.4; the
  memory note and the docs updated.

  *Done when:* `gh release view v0.2.0-alpha.2` lists the zip and `portly-release.json` with
  matching SHA-256; the tag points at the built commit; the live site's footer reads
  0.2.0-alpha.2; the phase 6 row reads Done with the date.

  *Status:* release-day commit on main 2026-10-29 (version 0.2.0-alpha.2, the CHANGELOG's entry
  dated, extension 0.5.3 unchanged); built from main, not a release branch, since main holds
  exactly what ships. The parked fixes found on 2026-10-29 (the calendar list by account, the
  first-sync wording, app registrations beside their accounts) wait for 0.2.0-alpha.3, the
  owner's choice.

  *Published 2026-10-29:* [v0.2.0-alpha.2](https://github.com/davideAurum/Portly/releases/tag/v0.2.0-alpha.2).
  - **Checks before publishing,** all at 94950f1: typecheck, `npm test` (4,421 vitest tests,
    344 extension, 79 native host, the audit gate), both builds, `check-scripts.ps1` (381),
    `build-release.ps1` with nodejs.org's 24.21.0, `check-release.ps1` (27, from Windows
    PowerShell 5.1 and PowerShell 7), the PowerShell 7 install into a scratch folder, the `iex`
    dry run ("Would update Portly 0.2.0-alpha.1 to 0.2.0-alpha.2"), and the CSP check of both
    builds in the built-in browser with no violation. CI on the pushed commit was green
    (40988187199). The audit noted one moderate advisory below its gate (`@hono/node-server`,
    GHSA-rmxm-3fg6-px4f); Portly's `serveStatic` serves only public files, so it is unaffected,
    and the upgrade waits for 0.2.0-alpha.3 (dependency changes ask first).
  - **The candidate on the clean account failed, and rolled back as designed.** On `testing`,
    the update from 0.2.0-alpha.1 unpacked and backed up the database, then Windows refused to
    register `\Portly Server` (0x80070005): scheduled task names are per PC, and the owner's
    account still had its task. The installer put 0.2.0-alpha.1 and its database back and kept
    the failed copy. Its advice ("Open PowerShell as administrator") is wrong in that case
    (checks table; *Revisit*). At the owner's choice the candidate was then installed as an
    update on the owner's own release install: 0.2.0-alpha.2 at 94950f1, the same instance id,
    vault ready, the Google, Outlook.com and Yahoo accounts passing Test, all 44 health subjects
    ok.
  - **Published** with `publish-release.ps1` (over HTTP/1.1): the zip and `portly-release.json`
    with GitHub's SHA-256 equal to the build's, immutable, marked latest, the tag created by the
    release at 94950f1 under the `v*` ruleset; `releases/latest/download/portly-release.json`
    names 0.2.0-alpha.2; `portly --update` reports it already installed.
  - **The site and the privacy page** published together from the tag (6.7's change): the Pages
    clone at 51565e6, portly-site at 592177d. The live footer reads "Version 0.2.0-alpha.2 ·
    Last updated Oct 29, 2026, 7:41 PM", the live `install.ps1` is byte-equal to the tag's, and
    the privacy page has the launch pad sync section, effective October 29, 2026.

  Left for 6.7: launch pad sync on the published site itself (two browsers there already ran
  the same build through `preview:static`).

## Launch pad sync through GitHub (beside phase 6)

On 2026-10-27 the owner asked for a GitHub backend for launch pad sync, built at the same time as
OneDrive's (D8 note). Design: [launchpad-sync-github.md](design/launchpad-sync-github.md). Phase
6's items are unchanged: the GitHub work reuses their engine.

- **G.1 Gist store, token setting, CSP** (M). Done on branch `claude/sync-gist-118208`, not on
  `main`: the `SyncStore` interface, a store on two secret gists with in-memory GitHub tests, the
  GitHub token in Settings → Accounts (browser backend only), the static CSP. Replaced by G.2.
- **G.2 Choose the GitHub backend** (S). Decided 2026-10-27: a private repository through the
  contents API, not secret gists (private data, GitHub's own `sha` refusal, a fine-grained token
  limited to one repository). Done on the same branch: the store (`kind: 'github'`, renamed from
  `'gist'` in `sync/store.ts`), the repository and token in Settings → Accounts, only
  `api.github.com` in the static CSP. Saving them syncs nothing yet.
- **G.3 Hook it into the engine** (M; after 6.5). Pick the store from the connection, the status
  line and **Sync now** on the GitHub row, the `sync` events.

  *Status:* the hookup is done on the OneDrive sync branch, 2026-10-27 (merged in from the GitHub
  branch, not on `main`): one sync connection per browser, a Microsoft connection with the
  service or the GitHub repository, and none while both are set up (`several_sources`, design
  6.10); one store per page load, dropped when the settings change; a refused token pauses
  scheduled checks until new settings. Tests with the in-memory GitHub: the first write to an empty
  repository, a `304`, a `409` race, switching source, removing and replacing the token, a refused
  token, one request at a time. The status line, **Sync now** and the first-sync dialog moved to
  6.6 for both sources.

  *2026-10-29:* two browsers converged through the owner's private repository (6.6's real
  checks); a forced race and the remaining G.2 rows (a revoked token, a read-only token, an
  icon, a read over 1 MB) are still open in the checks table.

  *Done when:* two browsers on one GitHub account converge, a forced race is refused, and the
  "Checks never run for real" rows of G.2 are run with the owner's repository and token.

## Track B: multi-PC

One Portly server for several PCs, built beside the phases on the go of 2026-10-21 (D10 asked
for an explicit one; F13 stands: Tailscale and a second tailnet device come when B.5 needs them).
Design: [design/multi-pc.md](design/multi-pc.md), with its decisions of 2026-10-21 (approval from
the main PC is the only login, with revoke and a 30-day idle expiry; any HTTPS reverse proxy, with
Tailscale Serve documented and Funnel ruled out; the proxy must keep the Host header). The rule
that binds every item: the listener stays loopback-only (ARCHITECTURE section 4) and with no
`PORTLY_REMOTE_ORIGIN` the server behaves exactly as before, which is what lets the track land on
main before 5.3 without changing the alpha. The track edits this file in this section and the
checks table only; each item is its own commit with the usual *Tested* note.

Items:

- **B.1 Server** (M).
  `PORTLY_REMOTE_ORIGIN` in `server/src/config.ts`; the gate classifies a request by its Host
  header (the remote origin's host is another PC) and lets it in with a device cookie; a devices
  module (`server/src/modules/devices`, store in `server/src/security/devices.ts`, tables
  `devices` and `device_requests`) with the request, poll, approve, deny, list, revoke and
  disconnect routes; the route tags `samePc()` (the vault reset, the browser bookmark import, the
  OAuth start: never from another PC) and `enrollment()` (the two routes that need no cookie);
  paths blanked for a device as for the Pages site; a second loopback listener on
  `PORTLY_REMOTE_PORT` (default main port plus one) that the proxy forwards other PCs to, so the
  classification never trusts the Host header; a request on the main port with a proxy's
  forwarding header refused. Tests with `testRequest()` on the remote port: no cookie, revoked and
  expired cookies, cross-site forgery attempts, local-only and same-PC routes, the Pages site and a
  device side by side, the feature off; every route in the `ROUTE_ACCESS` table.

  *Done when:* typecheck, `npm test` and both builds green; the server unchanged with the variable
  unset (the gate tests say so); on main. *Result:* built and merged on 2026-10-21 (2f3c647); the
  remote port replaced the Host-based classification the same day (B.1b commit), after the
  review found that a proxy rewriting the Host would have made every other PC count as this one.

- **B.2 Web** (M; after B.1).
  The connect screen a page on the remote origin shows instead of the app ("Connect this device":
  a label, the code to compare, polling until approved, denied or expired); Settings > Devices on
  the main PC (requests waiting with code and browser, Approve and Deny; connected devices with
  last use and Remove; the remote address or how to set it); the `remoteClient` capability flag
  that hides what only the main PC can do (connecting accounts, the vault reset, the browser
  bookmark import, approving devices and pairings) and says "on the main PC" instead;
  `pagesForward` never forwarding a remote client to the Pages site; `login_required` handled by
  the API client (reload into the connect screen); on an address that is not loopback the connect
  screen reads `GET /api/health` first and stops with a plain warning when `remote` is false (the
  proxy points at the main port instead of the remote one).

  *Done when:* web tests and typecheck; both builds; B.4 passes. *Result:* built on 2026-10-21
  (B.2 commit), B.4 passed the same day.

- **B.3 Docs and scripts** (S; after B.2).
  ARCHITECTURE: a new section for other PCs and the section 4.1 update (each approved device is
  fully trusted, like a paired browser); `docs/setup/other-pcs.md` brought up to the setup script
  (its first version, with the Tailscale Serve set-up pointed at the remote port, why never
  Funnel, approving and removing, landed with B.2 because the app names it, as did the two
  `docs/SETUP.md` rows and the installer carrying the variables); `setup.ps1 -RemoteOrigin` with
  `-DryRun`; a README line; the privacy page text (`site/privacy.html`) that a server reachable
  from your other PCs needs.

  *Done when:* `check-scripts.ps1` passes in both PowerShell versions; `check-release.ps1`
  passes; the docs name the real commands and the variable. *Result:* built on 2026-10-21 (B.3
  commit): ARCHITECTURE section 20 with the 3, 4.1, 4.2, 5, 6, 7, 7a, 10.5 and 17 updates;
  `setup.ps1 -RemoteOrigin` (`off` removes it) with its dry-run checks in `check-scripts.ps1`;
  the guide, README, SETUP and the privacy page.

- **B.4 The flow in a real browser on this PC** (S; after B.2).
  A throwaway local HTTPS proxy on another loopback port with a self-signed certificate (scratch
  only, never committed) in front of a scratch server (`PORTLY_REMOTE_ORIGIN=https://localhost:8443`,
  a scratch port and data folder, `PORTLY_PAGES_URL` cleared): connect from the proxied address,
  approve on the plain one, use the app, see the cookie renew, revoke, reconnect; a forged
  `X-Forwarded-For` on the plain port refused as `proxied_local_host`.

  *Done when:* dated here with what was seen, and the two B.1 rows in the checks table closed or
  narrowed. *Result:* 2026-10-21, in the desktop app's browser pane, through a throwaway plain-HTTP
  proxy on `http://localhost:8443` forwarding to a scratch server's remote port 5800 (the pane
  refuses a self-signed certificate, so `PORTLY_REMOTE_ORIGIN` now also accepts `http://` on a
  loopback host, with the start-up warning): the connect screen, a request with its code, the
  request listed on the server's own page with Approve and Deny, the approved tab reloading into
  the app by itself, Settings → Devices on the other side showing "This PC" without Approve, the
  Accounts page without the Google and Microsoft tiles, About with no paths, then Remove on the
  main page sending the other tab back to the connect screen once it was visible again; the
  server's log carried ids only. Found and fixed on the way: a reload loop (the page counted as
  another PC's before its own "am I connected?" check, whose 401 then reloaded it) and the
  loopback shortcut that took the proxied page as this PC's own without asking the server.

- **B.5 The real check with a second PC** (S; go-ahead; after B.3; needs Tailscale on this PC and
  a second tailnet device).
  Tailscale Serve in front of a scratch server first (the installed Portly only on your say-so),
  pointed at the remote port: which Host, `Tailscale-User-*` and `X-Forwarded-*` headers arrive
  and whether the `Origin` header passes through unchanged (the cross-site check needs it), the
  four-way header probe (a forged `Tailscale-User-Login` from this PC and from the second device,
  each against what Serve adds or strips), then the whole connect flow from the other PC and a
  revoke from this one.

  *Done when:* the four results and the headers seen are dated in design/multi-pc.md; the B.1
  Tailscale row closed; the identity-header check (B.6) decided on those results. *Result:*
  2026-10-21, on a scratch server with Tailscale Serve pointed at its remote port through a
  header-recording relay: Serve keeps the Host and passes `Origin` through, adds `X-Forwarded-*`
  and `Tailscale-User-*`, and replaced forged identity and `X-Forwarded-For` headers from this PC
  and from the second PC alike (four of four); the whole connect flow ran from the second PC and a
  revoke from this one sent it back to the connect screen (design/multi-pc.md, "The real check").
  Then `setup.ps1 -RemoteOrigin` ran for real on the installed Portly (after `update.ps1`): the
  variable saved, the task re-registered and restarted with both listeners, Serve pointed at 5758,
  `/api/health` through the Serve address answering `remote: true`; `status.ps1` gained an "Other
  PCs" line, since it showed nothing about the address.

- **B.6 Later** (parked): the extension's server address, so the other PC's New Tab opens the main
  PC's Portly; OAuth sign-in from other PCs (https redirect URIs for the remote origin); a passkey
  as a second factor; an optional `PORTLY_REMOTE_LOGIN` check of the `Tailscale-User-Login` header
  as defence in depth (B.5 showed Serve replaces a forged one from inside the tailnet; it would
  stay optional, since any other proxy may pass the header through). *Built 2026-10-21, on the
  owner's ask after the real install:* the connect screen fills the PC's name in, from
  `tailscale whois` on the main PC for the address Serve forwards (`lib/peer-names.ts`,
  `GET /api/devices/requests/suggestion`; design/multi-pc.md, "The name the connect screen fills
  in"); checked against the real Tailscale from a scratch server, the second PC's own connect is
  the row below.

## Checks never run for real

One row per *Not tested* note still open from the commit history, with the item that performs it.
A commit's *Not tested* note is copied here in the same commit (CLAUDE.md). *Result* takes the
date and the outcome once a row has been run for real.

| Check | From | Planned in | Result |
| --- | --- | --- | --- |
| `publish-release.ps1` handing the CHANGELOG notes to a real `gh release create --notes-file`, and how they render on github.com (links, the arrow character); the dry run printed the 0.2.0-alpha.1 section in both PowerShell versions but stops at the private-repository refusal before the `gh` command line | this commit, 2026-10-25 | 5.3 | 2026-10-28 (5.3): `gh release create --notes-file` carried the 0.2.0-alpha.1 section; on github.com the links point at 1189489 and the arrow renders. The zip upload stalled over HTTP/2 and went up with `GODEBUG=http2client=0` (5.3's status) |
| The package built with the nodejs.org runtime installed for real: the scheduled task, native host and extension on a real account; `check-release.ps1` only installs into a temporary folder without autostart or the CLI | this commit, 2026-10-25 | 4.3 | 2026-10-27 (4.3): installed on a fresh standard account with the real task, native host, CLI and Load unpacked; a new tab started it and About showed the account's data folder. Its update path is the failed-update row below |
| The Weather widget's place name from a real browser location (the browser pane blocks location, so the check faked the position; the server's real Nominatim lookup did answer with the expected city) | this commit, 2026-10-25 | owner's next use with *Use this device's location* | 2026-10-29 (2.4, reported by the owner): in Edge on the paired published site, *Use my location* with a real position showed the weather and its place |
| The place name on the browser-only build (Pages): the browser calling Nominatim directly under its CSP; only unit tests and the built CSP were checked | this commit, 2026-10-25 | 2.5 (CSP check before a release) | 2026-10-25 (2.5): on `preview:static`, *Use my location* with a faked position called nominatim.openstreetmap.org (200) with no CSP violation and named the place; a real browser location prompt is still the row above |
| A whole failed update (`install.ps1` putting the previous version and its database back); only the database restore step was tried on a temporary folder, because the whole path needs the real scheduled task | 1b8005b, 2026-10-20 | 4.3 | 2026-10-27 (4.3): failed before the rollback was reached. A Portly tab restarted the server mid-update and `Move-Item` split `app` in two (4.3's status). Fixed in b75af65. 2026-10-27 (4.3 rerun): passed. A package that exits at start-up was rolled back, the database copy was put back with `portly-failed-*` kept, and the old version served 0.2.0-alpha.1 again |
| The settings dialog's focus change (it keeps looking for the requested field for 10 s and stops once focus has moved inside the dialog), by hand in a browser; only the new tests cover it | 29347b8, 2026-10-19 | 2.4 | 2026-10-29 (2.4, built-in browser, scratch server): focus reached the location field 1.1 s after **Set location**; with focus already inside the dialog, the field was never focused within 12 s |
| The browser-only build's Outlook.com sign-in on the published Pages address itself: the same sign-in and sync check, the automatic 24-hour renewal and writing an event (the localhost copy passed) | 3b3edd7, 2026-10-19 | 2.1 | 2026-10-26 (2.1): passed on the published site with a real account, reported by the owner: connect, sync, an event created, edited and deleted and seen in Outlook, the renewal after more than 24 hours |
| The OneDrive spike (sign-in, app folder reads and writes, cross-origin download URLs) in Firefox and Safari; only the desktop app's Chromium-based browser pane was used | 3b3edd7, 2026-10-19 | 6.7 (Firefox smoke run); Safari stays unsupported | not yet |
| The browser-only build's own automatic token renewal (`planSilentReauth`) against a real Outlook.com account; the spike only sent the same `prompt=none` request by hand | 3b3edd7, 2026-10-19 | 2.1 | 2026-10-26 (2.1): reopening the site more than 24 hours after the connect renewed the sign-in with no "Reconnect needed", and after consent was withdrawn it fell back to Reconnect (reported by the owner) |
| The 6-hour retry guard after Reconnect on the published site (at most one further `prompt=none` attempt): 2.1 saw the fallback to Reconnect, but nobody counted the redirects or read Diagnostics > This browser | this commit, 2026-10-26 | 6.7 (the two-browser test signs in on Pages again) | not yet |
| The `*.files.1drv.com` download host kept in the sync CSP table: never seen in the spike and its CORS behaviour unverified (launchpad-sync.md section 4) | 3b3edd7, 2026-10-19 | 6.5 | 2026-10-29 (6.6, `preview:static` in Chrome and Edge): Edge's sign-in to the same account downloaded from `my.microsoftpersonalcontent.com`, as Chrome's did; `*.files.1drv.com` was never seen, so it stays out of the CSP |
| A real Google or Microsoft sign-in through the new Accounts flow (connect, choose services, Manage adding a service by incremental consent); the tests and the hand check used fakes | 9cce15e, 2026-10-19 | 2.2 | 2026-10-29 (2.2, installed Portly): Google and Microsoft each connected calendar-only, added mail through Manage (incremental consent), refused (Google: every box unticked, `oauth grant covers no capability`; Microsoft: Cancel, `denied`) with no account saved, reconnected and passed Test; Google Remove revoked the token |
| Whether Microsoft's consent screen shows only the requested services' scopes on a sign-in through Portly's own flow (the spike saw the incremental-consent screen list only the added permission, but from a scratch page) | 9cce15e, 2026-10-19 | 2.2 | 2026-10-29 (2.2): yes. After the consent was withdrawn at account.live.com, the calendar-only screen listed only the calendar permissions, and Manage > Mail asked for mail; the "only requested services start enabled" rule stays |
| The **Wikipedia suggestions instead** switch (Settings > Search in the browser-only build) and the search wording it changes, in a real browser; 8bb97b1's localhost check covered the earlier always-on fallback only | 65dae13, 2026-10-19 | 2.4 | 2026-10-28 (pre-release CSP check): on `preview:static` in the desktop app's Chromium pane, Google had no suggestions until the switch was on, then "mount rainier" listed six Wikipedia titles, with no CSP violation |
| The reordered Settings > Bookmarks page (Groups, Preferences, then Import & export) in a browser; only the earlier order (0b63e51) was looked at | 0f23788, 2026-10-19 | 2.4 | 2026-10-29 (2.4): Groups, Preferences, then Import & export, on the server's page and on the static build |
| The browser-only site on a PC where Portly is running but not paired (the footer label and the Diagnostics link in that case); unit tests only | 8bb97b1, 2026-10-19 | 2.3; the Diagnostics link 2.4 | 2026-10-26 (2.3): the footer read **Found, not paired** in Chrome on the published site; the Diagnostics link in that state was not looked at |
| The Calendar card's text in **Add widget** on a Pages site paired with Portly (it should read like the server's own page: Google, Outlook.com, Yahoo, CalDAV and ICS); only the unit test, the server build and the unpaired browser-only build were looked at | Calendar card commit, 2026-10-28 | the next hybrid pairing check in a browser | 2026-10-29 (2.4, a scratch static build paired with a scratch server): the Outlook.com-only text while browser only; Google, Outlook.com, Yahoo, CalDAV and ICS once paired, as on the server's own page |
| The retried copy of Homebase's IndexedDB database in a real browser (a copy that fails part-way, then the next load trying again and giving up after three loads); unit tests only | f0d5331, 2026-10-19 | 3.1 | 2026-10-29 (3.1, built-in browser, scratch static build): a copy failing part-way left `copy:homebase-pending` at 1, 2, then 3 attempts with a console warning on each load, then gave up (a repaired source was not copied on the fourth load); a copy that failed once succeeded on the next load. The give-up shows only in the console, not in Diagnostics |
| The vault key swap during a Homebase copy (Homebase's key moved in, Portly's kept beside its old database) with a real DPAPI-protected key; the tests use plain files | 1860efe, 2026-10-19 | 3.1 | 2026-10-29 (3.1, scratch folders, real DPAPI keys): the folder's own `portly.db` and `vault.key` moved to `.before-homebase-<time>` with one stamp and Homebase's key put in place, vault ready; the moved-aside pair still opened, and Homebase's key did not decrypt it |
| The 2026-10-19 switch-over fixes on a real Homebase PC: the extension and native host refusing a Homebase health answer (b5f5cc5), `HOMEBASE_DATA_DIR` read as the copy source (d14862a) and the one-time `HOMEBASE_*` variable copy (7eaee9c); fakes and temporary folders only | b5f5cc5, 2026-10-19 | 3.1 (scratch folders); the real-Homebase-PC parts: none planned, since the other PCs no longer install Portly (F11, 2026-10-29) | 2026-10-29 (3.1): `HOMEBASE_DATA_DIR` read as the copy source, Portly keeping its own folder (d14862a). Not run: b5f5cc5 and the one-time `HOMEBASE_*` variable copy (7eaee9c), which need a real Homebase PC and the installer |
| The retry when setting a fresh program copy's modification time hits a sharing violation during a real install or update (the holder never reproduced in 110 runs; Defender real-time protection is the likely one) | 8f5fe93, 2026-10-19 | 4.3 and 5.5 (watch for it) | 2026-10-27 (4.3, first run): not seen in the install, the switch to Logon mode or `portly --start`; the updates stopped before they refreshed the copies, so keep watching. 2026-10-27 (4.3 rerun): not seen in two updates and a rollback, but the copies were already up to date each time (same Node.js), so the refresh itself still has not run in an update. 2026-10-28 (5.2, 5.5): not seen in two installs, three updates and a rollback on a fresh account |
| Hidden-tab behaviour (stopped clock and upload timers, the once-a-minute local server probe, the throttled cache save) with a real hidden tab instead of simulated visibility events | 3407dfc, 2026-10-18 | 2.4 (2.3 checked only the reload) | 2026-10-29 (2.4, built-in browser, 231 s hidden): the local server probe about every 61 s instead of 30 s, the clock stopped and caught up on return, the diagnostics upload stopped and restarted 15 s after return, the query cache saved once on hide. Chrome's intensive throttling (over 5 minutes hidden) not reached |
| The hybrid pairing check in a real browser: a pairing change reloads each background tab only when you switch to it, after one more probe | 3407dfc, 2026-10-18 | 2.3 | 2026-10-26 (2.3): in Chrome, a background tab across a server stop and restart reloaded only when switched to, and its Diagnostics > This browser showed the switch deferred, then performed (reported by the owner; the server log has the restarts) |
| Pairing in Edge (Local network access prompt, approval, **Connected**); 2.3 ran in Chrome only, the Edge pairing deferred by the owner | 5d45cda, 2026-10-26 | the owner's next Edge use (4.3 used Chrome only) | 2026-10-29 (2.3, the owner): the published site in Edge, **Look for Portly on this PC**, Edge's local network prompt allowed, **Pair this browser**, **Approve**, then **Connected · v0.2.0-alpha.1**. Firefox paired with the installed Portly too |
| An update with a Portly tab open on a real account after the fix: the task disabled during the swap and enabled again, the rollback with the task disabled, and the Reload notice. `check-release.ps1` covers only the all-or-nothing rename, because it has no real task | b75af65, 2026-10-27 | 4.3 (the rerun) | 2026-10-27 (4.3 rerun): with a Portly tab open, both updates moved their folders the first time and the task was enabled again before `install-autostart.ps1` ran; the rollback and the Reload notice worked. Whether the disabled task actually turned away a launcher request was not observed, because nobody watched the tab during the swap |
| Background upload preparation in Edge or Firefox, with a real camera photo, and with EXIF-rotated files; only Chrome's built-in browser pane was tried | 501e85b, 2026-10-18 | 2.4 | 2026-10-29 (2.4, reported by the owner): in Edge and Firefox, a sideways phone photo showed upright, and a GIF and an SVG background with blur above 0 rendered. The SVG's softness was not written down |
| The frosted glass switch and the baked photo blur in a visible browser window and in browsers other than Chrome; only headless Chrome measurements and screenshots were made | 1169e15, 2026-10-18 | 2.4 | 2026-10-29 (2.4, reported by the owner), by eye in a visible Edge window: frosted glass off and on, with the blurred photo still behind the cards when off. The DevTools Layers count was not read |
| A real `install-autostart` run that registers the task to run `portly-supervisor.exe`; nothing in the repository records one (the installed task on the developer's PC does name it, dated 2026-10-18 in the memory note, but that is outside the repository) | 89e4325, 2026-10-18 | 4.3 (on a fresh account) | 2026-10-21 (after 1.3, on this PC): `install-autostart.ps1` replaced the running Browser-mode task, found the `node.exe` copies up to date, rewrote the native host files and registry keys, stopped the old processes and started the task; `/api/health` answered 0.2.0-alpha.1 and `portly --status` shows no warning. 2026-10-27 (4.3): on a fresh account the release install copied `runtime\node.exe` to `portly-supervisor.exe` and `portly-server.exe` and registered the task to run it, in Browser and then Logon mode |
| `update.ps1` and `portly --start` for real, refreshing out-of-date copies of `node.exe` before starting the task | 89e4325, 2026-10-18 | 1.3 (`update.ps1`), the next `portly --update` from a checkout (its task restart; 5.4 used `publish-static.ps1`), 4.3 (`portly --start` on a fresh install) | 2026-10-21 (1.3): `portly --update` ran `npm ci` (the lockfile had changed), the build and the publish; the server was stopped at the time, so the task-restart path did not run. `portly --start` then started the task and waited for health; the copies of `node.exe` were up to date, so the refresh path did not run. 2026-10-27 (4.3): `portly --start` on a fresh release install started the Logon-mode task after its processes were stopped; the copies were up to date there too |
| A PC whose policy blocks running programs from `%LOCALAPPDATA%` (the task should fall back to `node.exe` and the supervisor to its own program) | 89e4325, 2026-10-18 | none: parked, cannot be reproduced on Windows 11 Home | not yet |
| The Weather widget's location prompt flow in a real browser (permission already granted, *Use my location*, a one-time *Allow this time*); the browser APIs are faked in the tests | 82fb2f8, 2026-10-13 | 2.4 | 2026-10-29 (2.4, reported by the owner): in Edge, no location prompt on page load; only *Use my location* asked, and *Allow this time* worked |
| The animated lighthouse logo in Firefox and as the extension's New Tab page; frames were checked by eye in Chromium only | 7657e96, 2026-10-13 | 2.4 | 2026-10-29 (2.4, reported by the owner): it animates on Chrome's Portly New Tab page and in Firefox |
| A successful `portly --copy-from-homebase` run from the command line (the first PC's copy was requested by the installer instead) | c7549e5, 2026-10-13 | none scheduled: 3.1 avoids it on purpose because it acts on the real data folder; reopen if a PC in 3.3 or 3.4 needs it | not yet |
| A real run of `setup.ps1 -NoHomebaseCopy` or `install-autostart.ps1 -NoHomebaseCopy` (starting from scratch next to a Homebase install); only a dry run was made | 376e146, 2026-10-13 | none: the other PCs connect instead of installing (F11, 2026-10-29); 3.5 documents the browser side | not yet |
| The next real `portly --update`: the dirty-tree refusal and the fetch/fast-forward messages for real, and a publish that writes `.gitattributes` to the live Pages clone (which makes the live `install.ps1` byte-equal to the built one) | 1.8, 2026-10-21 | 5.4, or the next republish of the Pages site | 2026-10-28 (5.4, `publish-static.ps1`): `.gitattributes` written and the live `install.ps1` byte-equal to the built one; the clone was level with its origin, so no fast-forward message. The dirty-tree refusal and the fast-forward still wait for a real `portly --update` from a checkout |
| `setup.ps1` on a fresh PC without Node.js, now that the major is pinned: it must install Node 24 (today winget's `OpenJS.NodeJS.LTS`, later `OpenJS.NodeJS.24`) and stop on another major; checked only with `node.exe` hidden from PATH on this PC | 1.11, 2026-10-21 | none planned: the other PCs connect instead (F11, 2026-10-29); the next PC that installs Portly with `setup.ps1` | not yet |
| Both production builds free of CSP violations: the rule in ARCHITECTURE section 13 has no automated step behind it | design contract (ARCHITECTURE section 13) | 2.5, and again before every release | 2026-10-25 (2.5, at 749ec2f): zero violations in both builds in Chromium; 2026-10-28 (before 0.2.0-alpha.1, at 6ac3731): zero in both builds in Chromium and Edge; repeat before every release (releases.md step 3) |
| The CSP check with a search-suggestion request, a feed with a real URL, and in Edge and Firefox; the 2026-10-25 run had suggestions off, no feed, and only the desktop app's Chromium-based browser pane | 2.5, 2026-10-25 | the pre-release CSP check before 5.3 | 2026-10-28 (at 6ac3731): no violation with Google suggestions on the server build, Wikipedia suggestions on the browser-only build, and an RSS feed with a real URL (hnrss.org) in the Chromium pane; the owner's pass in Edge (settings, every widget, a search) showed none either. Firefox not run (not installed; Chromium is the supported browser for the alpha) |
| The "Other PCs: not set" lines of `status.ps1` on a PC without `PORTLY_REMOTE_ORIGIN`, in a checkout and in a release install: only their strings; the checks ran with the variable set on this PC | B.5 commit, 2026-10-21 | the next PC without the variable (3.3); 4.3 ran only `portly --status`, whose summary leaves the line out | 2026-10-28 (5.2): `portly --settings` on a release install without the variable showed "Other PCs : not set (PORTLY_REMOTE_ORIGIN: this PC only; ...)"; a checkout without the variable is still unchecked |
| Approving another PC from Portly's own page on a main PC that has a Pages site (`#/settings/devices` now stays there, and the Pages site links to it): only the forward's and the page's unit tests; the first real approve went through the local API | B.5 approve commit, 2026-10-21 | 3.3 (the owner's next approve from this PC) | not yet |
| The connect screen's name filled in on the second PC through Serve (its computer name): only `curl` with a forwarded address against a scratch server on this PC, which asked the real Tailscale, and the web tests with a mocked answer | B.6 name commit, 2026-10-21 | 3.3 (the owner's next connect from another PC) | not yet |
| The name suggestion on a main PC without Tailscale installed (every lookup null, nothing spawned, one log line at start): only the executable rule with a fake environment and the test stub; this PC has Tailscale | B.6 name commit, 2026-10-21 | none yet: Tailscale is installed for every account on this PC, so 4.3 could not try it; a PC without Tailscale | not yet |
| The name lookup's in-flight cap (four processes at most) against real `tailscale.exe` processes: six addresses at once finished too fast to hit it on this PC; the unit test pins it | B.6 name commit, 2026-10-21 | a later check with a slow or stalled Tailscale | not yet |
| Connecting an Android phone through Tailscale Serve (the connect screen, the code, the `__Host-` cookie in Chrome on Android, the stacked layout below 768 px, the name Tailscale suggests for a phone): documented from the code only; every real check used a second Windows PC | phone docs commit, 2026-10-25 | the owner's first connect from a phone | not yet |
| The Reload notice as the last lines of a real update in a visible PowerShell window (`install.ps1` now prints it after "Updated Portly"); only `check-release.ps1`'s temporary install, whose captured output the console wraps | 4.4 commit, 2026-10-27 | 5.2, or the first release that changes the extension version | 2026-10-28 (5.2): an update to a copy with extension 0.5.4, run in a visible window, ended with the yellow warning as its last line |
| [Adding a PC](setup/add-a-pc.md) followed verbatim on a real PC, from the install to green Diagnostics; written from the scripts and guides only | 4.4 commit, 2026-10-27 | none planned: the other PCs connect instead (F11, 2026-10-29); 3.3 follows other-pcs.md | not yet |
| A fresh browser profile on a PC that ran Homebase: the browser-side copy with `-NoHomebaseCopy`, and deleting the site's data after the first visit leaving it empty, as SETUP and Adding a PC now say | 4.4 commit, 2026-10-27 | 3.3, if that PC's browser opens the Pages site | not yet |
| Browser-only accounts remembering the scopes their last sign-in asked for, against a real Outlook.com account whose grant lists more (refresh, renewal and Reconnect with no `invalid_grant` loop); only static tests with a faked token endpoint | 6.1 commit, 2026-10-27 | 6.6 | 2026-10-29 (6.6, `preview:static` in Chrome and Edge): with sync on, Microsoft's grant also held the server's mail consent, and refreshes kept working; after the consent was withdrawn at account.live.com, **Test** forced a refresh: one failure in Diagnostics > This browser, then **Reconnect needed**, and a reload did not loop. Reconnect asked again for calendars and the app folder only |
| The Microsoft tile's **Launch pad sync** checkbox in a real browser on the browser backend, and its absence on a paired (server-backend) page; only the settings tests with mocked answers | 6.2 commit, 2026-10-27 | 6.6 | 2026-10-29 (6.6, `preview:static` in Chrome and Edge): offered on the Microsoft card and in Manage, unticked. Its absence on a paired page was not looked at directly (the paired published page showed no GitHub sync either) |
| The `bookmarks-sync-fields` upgrade on a real browser's existing launch pad (IndexedDB data from before 6.3) and the stamps after real edits across two tabs; only static tests over memory storage | 6.3 commit, 2026-10-27 | 6.7 | not yet |
| The merge and the file format against real use: two browsers' real launch pads, real clock skew and a file written by one build and read by another; only seeded simulations and fixtures | 6.4 commit, 2026-10-27 | 6.7 (a file from another build, clock skew) | 2026-10-29 (partial, `preview:static`): Chrome's and Edge's launch pads converged through OneDrive and then through GitHub after an add in one and a rename in the other; one build, no clock skew |
| Launch pad sync against real OneDrive: the path-addressed `DELETE` of an icon file, `If-Match` and `conflictBehavior=fail` from the store as built, a second sign-in's download host, the download's `ETag`/`cTag` against Graph's; only `createFakeFetch()` with a fake app folder modelled on the spike | 6.5 commit, 2026-10-27 | 6.7 (an icon delete, a refused `If-Match`, the ETag/cTag comparison) | 2026-10-29 (6.6, `preview:static` in Chrome and Edge), partial: the first upload (Graph's 404, then the create) and later writes from both browsers; the second sign-in's download host above. Not seen: an icon `DELETE`, a refused `If-Match`, the download's `ETag`/`cTag` against Graph's |
| The static CSP with launch pad sync running (`my.microsoftpersonalcontent.com` in `connect-src`) on `preview:static`, no violations; only the built `index.html` was read | 6.5 commit, 2026-10-27 | 6.6 | 2026-10-29 (6.6, `preview:static` in Chrome and Edge): no Content Security Policy line in either console with OneDrive sync running, then with GitHub sync (`api.github.com`) |
| The scheduler in a real browser: the Web Lock between two tabs, focus and visibility, the 5 s change delay, online, backoff after a real failure; only fake timers, events and locks | 6.5 commit, 2026-10-27 | 6.7 (two tabs, offline, backoff) | 2026-10-29 (partial): each browser picked up the other's edit within about a minute of being clicked into. The Web Lock between two tabs, the online event and backoff after a real failure were not seen |
| The sync UI in a real browser on `preview:static`: the Microsoft consent screen listing only `Files.ReadWrite.AppFolder` when the service is added, the status line moving through *Syncing…* to *Up to date*, the first-sync dialog both ways between two browsers, *Backup before sync* downloadable, `sync` events in Diagnostics, no CSP violations; only web and static tests with mocked answers | 6.6 commit, 2026-10-27 | 6.6 | 2026-10-29 (6.6, `preview:static` in Chrome and Edge): adding sync to a calendar-only connection showed Microsoft's screen with only "Have full access to the application's folder"; the status line read **Up to date** with the last change sent and received; the first-sync question came in Chrome after a reconnect and when switching to GitHub, not in Edge, whose launch pad was empty. Not read: **Backup before sync**, the *Syncing…* state, the `sync` events in Diagnostics |
| One sync connection per browser against real accounts: the 409 refusals, the move between two Microsoft connections, the GitHub form blocked while OneDrive syncs, a sign-in that grants sync while GitHub syncs leaving it off; only static and web tests | 6.6 commit, 2026-10-27 | 6.7 (the 409s by hand, a move between Microsoft connections) | 2026-10-29 (partial): with OneDrive syncing, the GitHub form said "Launch pad sync already uses <account>" and how to switch; after sync was turned off on the Microsoft card, GitHub saved. Not tried: the `409` refusals by hand, a move between two Microsoft connections, a sign-in granting sync while GitHub syncs |
| Launch pad sync through the owner's private repository end to end: two browsers converging, a forced race, the `304` check, the first file in the empty repository, a revoked token pausing sync and a new one resuming it, GitHub plus a Microsoft connection giving `several_sources`; only the engine and scheduler against the in-memory GitHub (`sync/github.test.ts`) | G.3 hookup commit, 2026-10-27 | 6.7 (a forced race, a revoked token, `several_sources`) | 2026-10-29 (G.3, partial, `preview:static`): Edge wrote the first file to the empty private repository; Chrome joined after the first-sync question; an edit in each converged (three commits, one `launchpad.json`). Not tried: a forced race, a revoked token, `several_sources`; the `304` not observed directly |
| The published site opened on an account that never ran Portly (the **Browser only** footer, every widget, Outlook.com with the newcomer's own registration, export and import) | 4.4 commit, 2026-10-27 | 5.5 (its new first step) | 2026-10-28 (5.5): the footer said **Not checked** until **Look for Portly on this PC** (the docs now say so); seven widgets; Outlook.com with the owner's registration showed events; export then import worked |
| A push to main starting CI in the new repository: neither the first push nor 59fff7c's push started a run; `workflow_dispatch` runs did | 5.1, 2026-10-28 | GitHub Support, if you want it fixed; meanwhile CI is started by hand after each push (CLAUDE.md) | 2026-10-28 (5.7): 3b0e9f9's push started none either. GitHub got all three pushes (the `cursor` and `claude` apps created check suites on each), but Actions created none and `actions/runs?event=push` counts 0. Ruled out: workflow state (all three active), Actions permissions, skip markers, push options, rulesets or webhooks (none then), settings against the old repository, a GitHub incident. Likely GitHub-side state from reusing the renamed repository's name. 084dee4's push started none. The CI workflow was disabled and enabled again, and f6a5152's push (2026-10-29 04:47Z) started none either: the fault is GitHub's. `workflow_dispatch` on f6a5152 was green (40820053201) |
| The live privacy page republished from `site/` (the copy at the homebase-site address, linked from every install and the consent screens, is the 2026-10-21 text without the Nominatim place lookup and the other-PC device records) | 5.3 review, 2026-10-28 | the owner's go-ahead (1.6's procedure) | 2026-10-28 (5.7): not republished; the owner asked why the pages still lived at the homebase-site address. 2026-10-29 (5.7, the owner's go-ahead): published to davideAurum/portly-site. `curl` got 200 and the same bytes as `site/` for all nine files at `https://davideaurum.github.io/portly-site/`; the privacy page says "Effective October 25, 2026" and has the Nominatim place lookup and the other-PC records. The homebase-site home, privacy and terms URLs answer 200 with a refresh to the same page there (the built-in browser landed on each); a missing page or an old asset answers 404 with a refresh to the new home page |
| The Google Cloud console's Branding links (home page, privacy policy, terms) changed to `https://davideaurum.github.io/portly-site/` and saved, and the consent screen linking there; until then they reach the new pages through the homebase-site redirects | portly-site commit, 2026-10-29 | the owner, in the console; the next real Google sign-in (6.6 or 6.7) | 2026-10-29 (5.6): done in a new Cloud project with the three portly-site links (and no logo); the Google account reconnected through it, and Portly's account test was ok for calendar and mail |
| The Microsoft consent screen naming Portly during a real sign-in; only the authorize page's display name was read, without signing in | 5.6 commit, 2026-10-29 | the next real Microsoft sign-in (6.6 or 6.7) | 2026-10-29 (6.6): "Portly needs your permission to", marked unverified, and "The publisher has not provided links to their terms": the registration has no terms or privacy address (parked under *Revisit after phase 6*) |
| The settings GitHub offers only public repositories: private vulnerability reporting, secret scanning and push protection, approval for outside contributors' pull request runs, rulesets for main and the `v*` tags | 5.1 review, 2026-10-28 | the owner's go-ahead | 2026-10-28 (5.7, the owner's go-ahead): vulnerability reporting, secret scanning and push protection on; rulesets "Protect main" (no force push or deletion) and "Protect release tags" (`v*`, no move or deletion) active with no bypass, all read back through the API. Outside contributors' runs: kept at first-time contributors, the owner's choice |
| The new rulesets and push protection in action: a force push to main, a moved or deleted `v*` tag and a push carrying a token all refused, and the next release still creating its tag; only the settings were read back through the API | 5.7 commit, 2026-10-28 | the refusals, only if one happens | 2026-10-29 (6.8): `gh release create --target` still created `v0.2.0-alpha.2` under the "Protect release tags" ruleset. No force push, tag move or token push was tried |
| The repository store against GitHub itself with the owner's private repository and a fine-grained token: creating `launchpad.json` in the empty repository, a `304` on the next check, a read over 1 MB through the blob API, an icon written, read and deleted, a 401 after revoking, a 403 with a Contents: Read only token; only an in-memory GitHub in the tests | G.2 commit, 2026-10-27 | G.3 (a read over 1 MB, an icon, a 401, a 403) | 2026-10-29 (partial): creating `launchpad.json` in the empty repository and later updates. Not tried: a read over 1 MB, an icon written and deleted, a 401 after revoking, a 403 with a read-only token; the `304` not observed directly |
| GitHub's answers to a refused contents write: `409` for a stale `sha`, `422` for a missing one, what a `sha` on a missing file gets (the store assumes `422`, handles `404`), and a `409` for two writes to the branch at once; only GitHub's docs and the in-memory GitHub | G.2 commit, 2026-10-27 | G.3 | not yet |
| Saving the repository and token in Settings → Accounts on the published site (the check with GitHub, the refusal of a public repository and of a classic token), and the CSP with `api.github.com` alone (the preflight with `If-None-Match`) in a real browser; only unit tests, the built CSP and an unauthenticated `curl` of the preflight | G.2 commit, 2026-10-27 | 6.7 (the published site), a classic token | 2026-10-29 (G.3, on `preview:static`): the save checked the repository with GitHub and refused it while it was public ("This repository is public. Portly syncs only to a private repository"); made private, it saved; no CSP violation. Not tried: a classic token, the published site |
| The guide's GitHub token steps against GitHub's own pages: the **Read and write** and **No access** choices and Metadata added by itself; only Portly's in-app steps and GitHub's docs were compared | 6.7 docs commit, 2026-10-29 | G.3 (the owner makes the repository and token) | 2026-10-29 (G.3): the owner made the token with the guide's steps; GitHub offered **Contents → Read and write** and added **Metadata: Read-only** by itself |
| [A PC that ran Homebase](setup/other-pcs.md#a-pc-that-ran-homebase) followed verbatim on a real PC: the task saved and removed, the `com.homebase.launcher` keys removed, the port free, the extension gone; only read-only runs in Windows PowerShell 5.1 | 3.2 commit, 2026-10-29 | 3.3 | not yet |
| Archiving and trashing a Yahoo message over IMAP for real (2.6 saw both offered, with only fakes behind them) | 2.6 commit, 2026-10-29 | the owner's next Yahoo archive or trash | not yet |
| A field-by-field comparison of each provider's live answer with the fields its mapper reads (drift that keeps health green); 2.7 checked health only | 2.7 commit, 2026-10-29 | the next provider sweep with the verbose Diagnostics log, if wanted | not yet |
| An install or update on a PC where another Windows account already has Portly: today Windows refuses the shared `\Portly Server` task name (0x80070005) and the installer advises running as administrator, which does not help; the clearer message is not built yet | 6.8 commit, 2026-10-29 | 0.2.0-alpha.3 (the message), with *Several Windows accounts on one PC* | not yet |
| Launch pad sync on the published site itself (an unpaired browser there taking the synced launch pad and sending a change); only `preview:static` of the same build ran it | 6.8 commit, 2026-10-29 | 6.7 | not yet |

### Closed

| Check | From | Closed by |
| --- | --- | --- |
| The device connect flow in a real browser through a proxy (the `__Host-` cookies with `SameSite=Strict`, the renewal, approving on the main PC while the other page polls); only `testRequest()` tests with a remote Host header | B.1 commit, 2026-10-21 | B.4 on 2026-10-21 (the B.2 commit's body): the whole flow in the desktop app's browser pane through a plain-HTTP loopback proxy; real https closed by B.5 below |
| Tailscale Serve pointed at Portly's remote port: which Host, `Tailscale-User-*` and `X-Forwarded-*` headers arrive, whether `Origin` passes through unchanged, and whether a forged `Tailscale-User-Login` is stripped | B.1 commit, 2026-10-21 | B.5 on 2026-10-21: Host kept, Origin unchanged, the forwarding and identity headers added and forged ones replaced from both PCs (design/multi-pc.md, "The real check") |
| The device cookies over real https on an address that is not loopback (a Tailscale Serve address) | B.2 commit, 2026-10-21 | B.5 on 2026-10-21: the second PC's every request carried the `__Host-` cookie over the Serve address, and the app loaded |
| `setup.ps1 -RemoteOrigin` for real (the variable saved and the task restarted with it); only `-DryRun` and the `check-scripts.ps1` dry runs | B.3 commit, 2026-10-21 | B.5 on 2026-10-21, on the installed Portly: the variable saved, the task re-registered and restarted with both listeners, health through the Serve address `remote: true` (design/multi-pc.md, "The real install") |
| The second PC connecting to the installed Portly (not the scratch server) through the Serve address: approve in Settings > Devices, the app loading with the owner's real data | B.5 commit, 2026-10-21 | 2026-10-21: the second PC asked through Serve and connected once its request was approved; the approve itself went through the local API, since the main PC's page (the Pages site) could not reach Portly's own Devices section (fixed in the same day's commit; design/multi-pc.md, "The first real approve") |
| The browser-only polish (*Browser only* footer label, Diagnostics intro and link, gap-free first-run layout, suggestion labels, probe throttles) in a real browser | 8bb97b1, 2026-10-19 | 8bb97b1's own body: checked on 2026-10-19 with `npm run preview:static` on localhost, built against an unused port so it acted like a PC without Portly |
| Preparing background uploads in a real browser (canvas decoding, WebP encoding and SVG drawing were only exercised through fakes) | a7859df, 2026-10-18 | 501e85b (2026-10-18): tried in Chrome's built-in browser pane on the Vite dev server and the browser-only build with scratch data (large JPEG and PNG to WebP, small JPEG unchanged, animated GIF first frame, sized and unsized SVGs, corrupt JPEG error, *Optimize image* keeping blur and dim) |
| Outlook.com calendars in the browser-only build against a real Outlook.com account | 23abdd5, 2026-10-13 | 3b3edd7 (2026-10-19): a real account on a localhost copy of the site (*Single-page application* redirect) connected the account and synced its calendars; the published address is the 2.1 row above |
| A real run of `install-cli.ps1` replacing the old `homebase` command with `portly` (only `-DryRun` and the `check-scripts.ps1` fakes were run) | 9fc160f, 2026-10-13 | The first PC's switch-over on 2026-10-13 with `setup.ps1`, which runs `install-cli.ps1` and replaces the old command by itself |
| A real switch-over from Homebase (stopping, exporting and removing Homebase's task and restarting it on failure were tested against fakes; the installer only as a dry run) | c7549e5, 2026-10-13 | The first PC was switched over on 2026-10-13 with its Homebase data carried over; 7967cbe (2026-10-19) closed the review items the commit left open |
| The OneDrive download hosts, their CORS headers and `If-Match` on a simple upload, marked for a spike with a real Outlook.com account | 5a9b5b6, 2026-10-19 | 3b3edd7 (2026-10-19): the spike ran with a real Outlook.com account; launchpad-sync.md section 13 records the download host, its CORS answers and the `If-Match` results (`*.files.1drv.com` stays open above) |

## Parked, with reasons

### Revisit after phase 6

- **Several Windows accounts on one PC, each with its own Portly server.** Today one account per
  PC runs Portly: the port, the task name `\Portly Server`, the static build's probe address and
  the installers' "already running" check are shared, and §4.1 trusts every local account. In
  order: identify a server by its `instanceId` in the scripts; a task name per user (by SID);
  ports per user, reported to the extension by the launcher; a sign-in on the local origin (a
  one-time code from the native host, then an HttpOnly cookie; a §4.1 change); the Pages pairing
  finding the port; a remote port and Tailscale Serve HTTPS port per user, with device cookies
  named per server (`__Host-portly_device` is shared by every port of one host); a two-account
  rehearsal like 4.3 with both installs running. Asked about on 2026-10-28; no need yet.
- **Name the account in the new-event calendar list** (*planned for 0.2.0-alpha.3*). The
  Calendar widget's event dialog (`web/src/widgets/calendar/EventDialog.tsx`) lists every
  writable calendar by name only, so Google's "Calendar" and Outlook's "Calendar" look the same
  and the owner took Google's for missing (2.2). Grouping the options by account (provider and
  account name) would fix it.
- **The first-sync question claims a difference it never checked** (*planned for
  0.2.0-alpha.3*). Its description says this browser and the synced file "both have a launch
  pad, and they are different", but the engine asks whenever both have rows on a first sync
  (`web/src/static/sync/engine.ts`, the `firstSync && hasRows` branch), as after a reconnect with
  identical bookmarks (6.6). Either compare them first and skip the question when they match, or
  drop "and they are different".
- **Terms and privacy addresses on the Microsoft registration.** Microsoft's consent screen says
  "The publisher has not provided links to their terms" (6.6): in the Azure portal, Portly's
  **Branding & properties** take the portly-site terms and privacy addresses, as Google's
  Branding did in 5.6. An owner's portal step; "unverified" stays without publisher
  verification.
- **The installer's advice when another Windows account has Portly** (*planned for
  0.2.0-alpha.3*). On a PC where another account owns `\Portly Server`, registering the task
  fails with access denied (0x80070005), the account cannot even see that task ("Existing task:
  none"), and `install-autostart.ps1` says to run it as administrator (6.8). It should say that
  another Windows account on this PC may already have Portly, one per PC today (see *Several
  Windows accounts on one PC*).
- **Save the current page from a toolbar menu** (requested 2026-10-29; needs a design decision).
  The owner asked for the extension's toolbar button to open a small menu that saves the page to
  the launch pad in a chosen group or a new one, without leaving the page. Today the button opens
  Portly's Add bookmark dialog in a new tab, because the extension cannot reach the launch pad:
  it lives in the server or in the Pages site's in-browser database. Two ways: the menu asks the
  server directly (needs the server to accept the extension's origin, a section 4 change), or it
  hands the page to an open Portly tab (browser-only site, only while one is open). Server first,
  with today's dialog as the fallback, is the suggestion.
- **Upgrade `@hono/node-server` to 2.1.5** (*planned for 0.2.0-alpha.3*; a dependency change, so
  it asks first). GHSA-rmxm-3fg6-px4f (moderate): `serveStatic` decodes a path twice, so
  middleware on a static prefix can be skipped. Portly serves only its public build there and
  is unaffected (6.8).
- **App registrations next to their accounts** (*planned for 0.2.0-alpha.3*). The owner's
  suggestion during 2.2: Settings > Accounts shows *App registrations* as a section of its own;
  each provider's registration (the Google client, the Microsoft client ID) would read better
  beside that provider's connected accounts and its *Add a connection* tile. On 2026-10-29 the
  owner first looked for the Microsoft client ID on the Microsoft card (6.6).
- **Tell the user when a browser's Homebase copy gives up.** After three failed loads
  `copyLegacyStaticDatabase` (`web/src/static/storage/idb.ts`) stops trying and says so only in
  the console; Diagnostics shows nothing (3.1). *Dropped 2026-10-29:* no PC runs Homebase any
  more (F11).
- **Multi-PC** moved to [Track B](#track-b-multi-pc) on 2026-10-21, on the explicit go D10 asked
  for; the loopback-only contract is kept (the listener never changes, other PCs arrive through an
  HTTPS proxy on the main PC), the two login questions are answered in design/multi-pc.md, and the
  `Tailscale-User-Login` probe is B.5. The later items (the extension's server address, OAuth from
  other PCs, a passkey second factor, the identity-header check) are B.6.
- **First-run checklist in the app.** Your PCs are set up and each widget's empty state already
  deep-links to the right setting; a dismissible card reusing those links is the likely shape,
  with feedback from the first release.
- **Default Google and Microsoft sign-in apps.** Needs an owner for shared registrations and
  Google's restricted-scope verification for `gmail.modify`, and contradicts `site/index.html` and
  both account guides until decided; the own-registration path gets its real check in 2.2. A
  calendar-only default app is the likely first step.
- **Extension in the Chrome Web Store (unlisted) and Edge Add-ons.** Store copies get new IDs the
  native host refuses and the pinned ID's private key is gone; listings need assets and developer
  accounts. The alpha stays Load unpacked ([Releases](setup/releases.md#the-new-tab-extension-load-unpacked-no-store-listings),
  4.6). Prerequisites before any listing:
  - a launcher that allows several origins (today `install-autostart.ps1` writes exactly one into
    `allowed_origins` and `config.json`);
  - `install-autostart.ps1`, `install.ps1` and `status.ps1` writing and checking those origins,
    and the extension's `PINNED_EXTENSION_ID` check accepting them;
  - an ID per browser, recorded once the Chrome Web Store and Edge Add-ons have assigned them;
  - listing assets (store icons, screenshots, description, privacy answers) and developer
    accounts. The privacy statement is the extension section of `site/privacy.html` at
    `https://davideaurum.github.io/portly-site/privacy.html`.
- **CalDAV writes** (ARCHITECTURE v1.1) and the "read-only in this version" wording: gated by
  section 1 on the Yahoo read test that 2.6 finally records; the `WriteProvider` split keeps the
  path open and the wording stays honest. Reopen if 2.6 passed and you edit Yahoo events from
  Portly.
- **Custom domain or separate account for the Pages site.** The shared-origin risk is accepted and
  documented for now: every project site on davideaurum.github.io shares the pairing today and
  would share the sync token. Decide again before 6.5 ships or when anyone else uses the site. A
  domain changes `PORTLY_PAGES_URL`, the Single-page application redirect, the CSP `pagesOrigin`
  and the docs, and repeats 2.1 and 2.3. Hybrid mode's trust of the whole Pages origin and
  `frame-ancestors` on GitHub Pages are the same question (ARCHITECTURE 4.1, static-build.md);
  the mitigations in place are write-only secrets and no probing while framed. *Decided again
  2026-10-29 (D9):* kept for 0.2.0-alpha.2; revisit when anyone else uses the site.
- **The published release on a secondary PC.** A release install can only update from
  GitHub releases, so a test package would freeze that PC until 5.3 or force a reinstall; the
  rollback and Reload-notice checks moved to 4.3, which has the real scheduled task. After 5.3,
  install the published release on a secondary PC and run `portly --update` there for real.
- **Portly on a PC joining the launch pad sync.** Outside the sync design until the browser-only
  sync has proven itself across two browsers; it would need a drive client behind `safe-fetch`
  and the merge code from `shared/`.

### Parked for a reason

- **Sharing-violation holder during updates (8f5fe93).** Unconfirmed after 110 reproduction
  attempts; Defender real-time protection is the likely holder. The retry is in place; watch for
  it during 4.3 and 5.5 and record the holder if it reproduces. No code change until it does.
- **Runtime warnings hidden by `--no-warnings`, and Node type stripping.** The supervisor starts
  the server with `--no-warnings`, so a new `node:sqlite` or type-stripping warning reaches only
  the `process.on('warning')` log line, and a non-erasable TypeScript construct fails at start-up
  rather than at typecheck. The engine pin in 1.7 is the guard; a visible-stderr option or a
  start-up smoke in CI waits for a real case.
- **Comparing live provider responses with the fields each mapper reads.** 2.7 takes "every health
  subject ok" as the bar and re-dates section 8 at every release; a field-by-field comparison
  through the verbose Diagnostics log is there, one provider at a time, when a widget looks wrong.
- **Browser-side `-NoHomebaseCopy` opt-out marker.** 3.5 documents the current copy, which is
  idempotent, marked and over when the last PC is switched. Build the opt-out only if a
  fresh-start PC ever needs it.
- **Fantasy sports widget, automatic profile switching, per-profile themes, sending mail.**
  Deferred by the design contract with no demand recorded in any session; the reserved
  `profiles.theme` column and the widget registry leave room, and sending mail would be new risk.
- **Proton Mail; Microsoft work or school accounts.** Not planned by the contract; the
  `/consumers` authority is hard-coded on both backends on purpose.
- **Vault key rotation.** `KEY_VERSION` sits in every secret's AAD so rotation stays possible; no
  trigger today, and a reset path exists.
- **Frosted glass as a synced theme field with a per-device override.** Deliberately per-browser
  so older site copies, servers and exports cannot break. Revisit only if setting it twice annoys
  you, possibly with sync.
- **Scrollbar space reservation.** Dropped in the performance session because it leaves a plain
  stripe beside short pages; could return with a gutter only when the page scrolls.
- **Brand: animated mark without its tile, animated lockup, brighter beam where it crosses the
  tower.** Cosmetic; the existing animated icon gets its Firefox and New Tab check in 2.4. Do the
  variants together the next time the brand files change, regenerating the PNGs with
  `extension/tools/generate-icons.mjs`.
- **An SVG background with blur above 0 looks a little softer than intended.** Rare and already
  left alone; 2.4 looks at it once and records whether it is worth more.
- **Firefox and Safari as supported browsers for the browser-only build.** Chromium (Chrome,
  Edge) only for the alpha. README names Chrome and Edge for the extension only and
  static-build.md only warns that Safari drops a site's storage after seven days, so the
  supported-browser line still has to be written into both (1.10 carries it); Firefox gets smoke
  runs in 2.4 and 6.7.
- **DPAPI fallback (pwsh 7 or a native binding) and a PC whose policy blocks programs in
  `%LOCALAPPDATA%`.** "No native modules" is deliberate; a policy-restricted PC locks the vault for
  the run but keeps the key, the safe failure. The `%LOCALAPPDATA%` case cannot be reproduced on
  Windows 11 Home and stays recorded as untested, not covered. Wait for a real case.
- **Automating the CSP-violation check with a browser driver.** jsdom cannot enforce CSP and a
  driver is a dependency the project avoids; the by-hand check is 2.5, repeated before every
  release and listed in CLAUDE.md and releases.md.
- **IMAP worker isolation against a real hostile or slow server; IMAP snippets; series edits; the
  fixed calendar sync window.** Fakes cover the limits and 2.6 exercises the real worker on the
  happy path; the rest are deliberate v1 limits that no session asked to widen.
- **Code-signed release packages.** Needs a certificate and a signing step; the alpha ships
  SHA-256 only, stated in releases.md and the CHANGELOG. Revisit after people other than you
  install.
- **`static-pages.yml` deploy-key route.** Publishing from this PC with `publish-static.ps1` is
  the working path and 1.8 hardens it; the workflow stays inert until a second publisher is
  needed.
- **Widget definition-of-done tests (minW x minH, stale indicator, Retry, keyboard) for Sports,
  Feeds, Search and Launch pad.** The code paths exist and the widgets are in daily use; add the
  tests the next time each of those widgets is touched.
- **App-level skip link and forced-colors / prefers-contrast rules.** Accessibility polish with no
  reported need; the primitives already cover focus-visible, reduced motion and ARIA. The
  Shift+F10 line lands in 1.10; batch the rest into a polish pass after the alpha.
- **vitest speed-up (pool vmThreads or isolate false); `check-release.ps1` downloading the
  runtime in every CI run; a manual live-smoke script for providers.** The suite runs in about
  three minutes and the CLAUDE.md rule keeps parallel sessions from running it at once; 4.2 proves
  the download path once per release instead of every CI run; 2.7 and the health subjects detect
  provider drift.
- **A *Combine both* first-sync option matching by group name and URL.** The first sync defaults
  to *Use the synced launch pad* with *Replace* as the alternative; combine is the only expensive
  option with no proven need.
- **How the installer looks in the terminal** (the owner's note, 2026-10-29, after installing
  0.2.0-alpha.1 on the main PC with `irm .../install.ps1 | iex`). The run prints
  `install-autostart.ps1`'s developer summary (repository, Node.js and supervisor paths, the
  native host's extension ID, "checked with server\src\config.ts"), the full text of the
  `portly.cmd` and `portly` shims, Task Manager notes and a stale "its ID is now fixed ... if you
  loaded it before this version" line. It names checkout paths that mean nothing in a release
  install (`scripts\status.ps1`, `scripts\uninstall-autostart.ps1`, `docs\setup\extension.md`
  rather than `portly --status` and the online docs), and says "open a new terminal" and
  "Portly is installed" twice each. Aim: a few numbered steps and one result line, the details
  behind `-Verbose` or in a log. `check-scripts.ps1` reads some of this output, so its checks
  change in the same commit.
- **ARCHITECTURE sections 14 and 15.** Correctly retired; nothing to do.

## Done before this plan

Phase 0 made the move from Homebase safe: Portly started as a snapshot of Homebase with fresh
history, the MIT license and a full rename. The old phase 1 finished Portly: an existing install
is carried over (data, vault key, settings, browser data and accounts, only when the installer or
`portly --copy-from-homebase` asks; a failed copy is retried, and Homebase is removed only once
Portly is up; see [SETUP: Coming from Homebase](SETUP.md#coming-from-homebase) and
[ARCHITECTURE section 19](ARCHITECTURE.md#19-moving-over-from-homebase-the-name-before-portly));
Outlook.com calendars in the browser-only build (proven with a real account on a localhost copy
on 2026-10-19, [design/launchpad-sync.md](design/launchpad-sync.md) section 13; the published
address is 2.1); the browser-only polish (the *Browser only* footer, the **Wikipedia suggestions
instead** switch, the gap-free first-run layout, the Diagnostics intro; see
[Browser-only build](setup/static-build.md)); and the smaller fixes (the database put back after
a failed update, busy-PC timeouts for the DPAPI and vault tests, `setup.ps1`'s wording, the
publish-static file check, the extension ID check). The first PC was switched over from Homebase
on 2026-10-13 and the Pages site has been published from Portly since. Version 0.2.0-alpha.1 with
a [CHANGELOG](../CHANGELOG.md) is prepared on main (cd547e3) and is published in 5.3.
