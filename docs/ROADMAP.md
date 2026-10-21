# Roadmap

Where Portly is heading, one phase at a time. Each phase is finished, checked and reviewed before
the next one starts. Anything that makes something public (pushing, releases, the Pages site, the
consent pages) or touches another PC waits for an explicit go-ahead, asked at the moment it is
reached.

Status as of 2026-10-21.

This plan comes from a full review of the code, the docs, the git history and the work sessions on
2026-10-20, with everything CI runs green at cd547e3 (3,691 tests, 317 script checks, 27 release
checks).

| Phase | What | Status |
| --- | --- | --- |
| 0 | Make the move from Homebase safe | Done ([details](#done-before-this-plan)) |
| 1 | Baseline and a truthful public surface | In progress |
| 2 | Prove what is built, on this PC | Not started |
| 3 | Every PC on Portly, Homebase retired | Not started |
| 4 | Release rehearsal in private | Not started |
| 5 | Go public and publish 0.2.0-alpha.1 | Not started |
| 6 | Launch pad sync, shipped as 0.2.0-alpha.2 | Not started |

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
  effective date, at the existing homebase-site URLs (1.5, 1.6).
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
- **D9 Custom domain.** Accept and document the shared-origin risk of the Pages site now; decide
  again before the sync engine (6.5) ships.
- **D10 Multi-PC.** One server with an approve-from-the-main-PC login over Tailscale Serve is built
  only after the first public release and an explicit go; fact-finding only when Tailscale and a
  second tailnet device exist.
- **F11 Other PCs.** One or more still run Homebase, so phase 3 stays as written, for each other
  PC.
- **F12 Yahoo.** No Yahoo account is connected on this PC's installed Portly: 2.6 adds the Yahoo
  preset with an app password.
- **F13 Tailscale.** Not installed, and there is no second tailnet device: the multi-PC probes are
  parked until both exist.
- **F14 Extension privacy text.** A section on `site/privacy.html`, at the URL the consent screens
  already link to (part of 1.5).

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

  *Status:* partly done on 2026-10-21: the roadmap branch was fast-forwarded to main (cd547e3),
  the main checkout is already at origin/main, and the memory note already records 0.2.0-alpha.1
  as prepared but unreleased. Still to do, in the next git closeout: remove the leftover worktree
  and the two merged branches.

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

  *Status:* landed 2026-10-21; push pending.

- **1.3 Republish the Pages site (your new tab)** (S; go-ahead; after 1.1).
  In the main checkout: `git pull` to cd547e3 or later, `git status` clean,
  `git -C $env:PORTLY_PAGES_REPO fetch` and confirm the Pages repository has not diverged, then
  `portly --update` (`update.ps1` refuses worktrees and deploys the checkout as-is, warning about
  uncommitted changes rather than refusing them). This is the first real `update.ps1` run under
  `portly-supervisor.exe` and `portly-server.exe` (the update.ps1 row in the checks table).
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
  gained `*.woff2 binary` in its `.gitattributes`.

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

- **1.9 Attribute and fix the TimeoutOverflowWarning** (S; after 1.1).
  Every vitest run prints, part-way through, "TimeoutOverflowWarning: ~2.25e9 does not fit into a
  32-bit signed integer. Timeout duration was set to 1"; the value tracks wall-clock time, so
  something arms a real `setTimeout` for about 2026-11-16 and it fires at once instead.
  `node --trace-warnings node_modules/vitest/vitest.mjs run` finds the site; clamp like
  `scheduler.ts`'s `MAX_TIMER_MS` if it is app code, otherwise fix the fixture.

  *Done when:* `npx vitest run` prints no TimeoutOverflowWarning; a unit test pins the clamp if app
  code was at fault.

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

- **2.5 Production builds without CSP violations** (S; after 1.1).
  Serve `web/dist` from a scratch server (scratch `PORTLY_PORT` and `PORTLY_DATA_DIR`,
  `PORTLY_PAGES_URL` cleared) and `web/dist-static` with `npm run preview:static`; with DevTools
  open visit every widget, every settings section, the Diagnostics report download, a background
  upload and an export/import. Repeat after 1.7 lands and before every release; add the step to
  [Releases](setup/releases.md#cutting-a-release) as a pre-release check (next to the section 8
  re-date from 2.7) as well as `CLAUDE.md` (1.2).

  *Done when:* zero `securitypolicyviolation` entries in both builds; a dated line next to the rule
  in ARCHITECTURE section 13; releases.md carries the step.

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

## Phase 3: Every PC on Portly, Homebase retired

Prove the switch-over fixes with a real DPAPI key in scratch folders, then switch each other PC
from a checklist and archive the Homebase repository. One or more other PCs still run Homebase, so
the phase stays as written. This phase does not gate the release: another PC is touched only after
3.1 and 2.2, and nothing here holds phase 5 back. The release package and the failed-update
rehearsal live in 4.3, where a real scheduled task exists on a clean account.

Done when:
- The scratch rehearsal passed with a real DPAPI-protected key and the real data folder untouched.
- Each other PC: `portly --status` green, Settings > About shows the vault unlocked, every account
  green without reconnecting, the extension starts the server, the Pages site is paired.
- `docs/setup/add-a-pc.md` was followed verbatim at least once and corrected where a step was
  missing.
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

- **3.2 Per-PC checklist page** (S).
  `docs/setup/add-a-pc.md` (not `other-pcs.md`, which multi-pc.md reserves for the Tailscale
  guide): `setup.ps1` or the release installer, what `-NoHomebaseCopy` does and that browsers
  still copy their Homebase data on first visit (3.5), `portly --status`, remove the Homebase New
  Tab extension and Load unpacked Portly's (the one step setup cannot do), pair the Pages site,
  hard-refresh and expect the old page for 10 minutes, confirm Settings > Accounts shows no
  Reconnect and Diagnostics is green. Linked from SETUP; drafted first, then amended during 3.1
  and 3.3.

  *Done when:* followed verbatim on the first other PC and amended where a step was missing.

- **3.3 Switch the first other PC over** (M; go-ahead; after 3.1, 3.2).
  You run the checklist on the PC you use most after this one, with Claude in the session. Confirm
  the vault unlocked with the key copied from Homebase, accounts work without reconnecting, the
  extension starts the server through the native host (and, if Homebase's server is still running
  when Portly's extension first loads, that the extension refuses its health answer and starts
  Portly, b5f5cc5), and the new tab is the Pages site paired with that PC. This run confirms 3.1
  on a real Homebase PC; it is not the first test.

  *Done when:* `portly --status` green; Settings > About shows the vault unlocked and the paired
  browser; every account's health subject green; a diagnostics report saved; dated line.

- **3.4 Switch the remaining PCs** (S; go-ahead; after 3.3).
  The same checklist on each remaining PC; fix anything the first switch exposed before the next
  one. Use `-Trigger Logon` on any PC that should start Portly at sign-in rather than from the
  extension (only dry runs have covered it): sign out and in;
  `schtasks /query /tn "\Portly Server" /v` must show the logon trigger, and `/api/health` must
  answer without opening a tab.

  *Done when:* the same four checks per PC plus the named Logon-trigger check where used; the
  phase 3 row names the count and the date.

- **3.5 Browser-side -NoHomebaseCopy behaviour** (S; after 3.2).
  Document plainly in SETUP that browsers copy `homebase:` localStorage keys and the IndexedDB
  database on first visit regardless of `-NoHomebaseCopy` (the copy is idempotent and marked, and
  the case ends when the last PC is switched). The opt-out marker is parked; say if you want it
  instead.

  *Done when:* the SETUP line is in; a fresh browser profile on the test PC behaves as documented.

- **3.6 Archive the Homebase repository** (S; go-ahead; after 3.4).
  After every PC is switched: delete its leftover branches and archive davideAurum/Homebase (it
  stays private). homebase-site is not archived: the consent screens link to it and CLAUDE.md
  keeps its URLs.

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

- **4.2 Run release.yml's build job with publish off** (S; go-ahead; after 4.1).
  `workflow_dispatch` on the private repository: runtime download, `check-release.ps1`, artifact
  upload. The publish job stays off; `publish-release.ps1` would refuse the private repository
  anyway. This is the only way to see the Actions path before it matters.

  *Done when:* `gh run list --workflow release.yml` shows one green run with an artifact whose
  `release.json` matches 4.1's version; nothing published.

- **4.3 Install, fail an update, and uninstall on a fresh Windows account** (M; go-ahead; after
  4.1).
  On a second local account on this PC (sign the main account out first: its Portly holds
  127.0.0.1:5757) or a VM, run the whole shipping path with 4.1's package:
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

- **4.4 Newcomer read of README and SETUP** (S; after 4.3).
  Using only the docs on that account, write down every point where README or SETUP were
  insufficient (the Load unpacked path, Chrome 134+ Developer mode, the 15-25 minute app
  registrations, what export/import carries and never carries, the Pages cache) and fix each in a
  commit.

  *Done when:* a written list of insufficient points, each fixed in a commit, and a second
  run-through following the docs verbatim with an empty list.

- **4.5 Release notes from the CHANGELOG** (S).
  `publish-release.ps1` defaults `-Notes` to the CHANGELOG section for the version being published
  and `release.yml` passes it through; the `check-release` refusal paths keep passing.

  *Done when:* a dry run prints the 0.2.0-alpha.1 section as the notes; `check-release.ps1` and
  `check-scripts.ps1` green.

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

- **4.7 Scan the full history before anything is public** (S).
  Flipping visibility publishes every commit reachable from any branch or tag. Grep
  `git log -p --all` with plain regexes (no new dependency) such as `-----BEGIN`, `client_secret`,
  `AIza`, `ya29\.`, `eyJ[A-Za-z0-9_-]{20,}`, `C:\\Users\\(?!you\b)`, personal e-mail domains and
  the owner's name outside the allowed davideAurum/Portly and davideaurum.github.io mentions;
  check LICENSE, README, CHANGELOG headers and `site/` links.

  *Done when:* the scan is empty or every hit is reviewed and recorded as acceptable; the patterns
  used and the date go here so the scan is reproducible.

## Phase 5: Go public and publish 0.2.0-alpha.1

Make the repository public and publish the first release, installable by anyone with the one-line
installer, as a repeat of the phase 4 rehearsal on the actual release candidate. It runs straight
after phase 4, as decided on 2026-10-20; launch pad sync (phase 6) follows and ships as
0.2.0-alpha.2.

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

- **5.2 Install the release candidate on the clean account** (S; go-ahead; after 4.3).
  Build the candidate from the commit to be tagged (pinned download) and install it on the phase 4
  account; repeat the failed-update rollback only if `install.ps1` changed since 4.3. Needed
  because code lands between the rehearsal and the release.

  *Done when:* `portly --status` healthy; the installed version matches the candidate; dated line.

- **5.3 Release-day commit, build and publish** (S; go-ahead; after 5.1, 5.2, and the release
  gates 2.1, 2.3, 2.5 and 4.3).
  One commit on main: the CHANGELOG entry gets its date, README and SETUP lose "No release is
  published yet", and SETUP loses the `setup.ps1` owner-only note. Build from that clean commit,
  run `check-release.ps1` on it, then `publish-release.ps1` from this PC (notes from the CHANGELOG
  via 4.5, `--target` that commit, `--latest` so `install.ps1` resolves it); `release.yml`'s
  publish job stays the fallback. A version is published once.

  *Done when:* `gh release view v0.2.0-alpha.1` lists the zip and `portly-release.json` with
  matching SHA-256; the tag points at the built commit;
  `releases/latest/download/portly-release.json` resolves.

- **5.4 Republish the Pages site at the released commit** (S; go-ahead; after 5.3).
  `portly --update` from the main checkout, so the site's `install.ps1` and `setup.ps1` are the
  released ones and the footer shows the version. `update.ps1` deploys the checkout as-is, so
  main's tip must equal the tagged commit at that moment; if anything was merged after the tag,
  run `publish-static.ps1` from a checkout of the tag instead.

  *Done when:* the live `install.ps1` is byte-equal to the tagged file; the footer reads
  0.2.0-alpha.1; the Pages repository's publish commit names the tagged commit.

- **5.5 One-line installer from the internet on the clean account** (S; go-ahead; after 5.4).
  Remove the 5.2 install, then run `irm https://davideaurum.github.io/install.ps1 | iex` exactly
  as README says: the first install of Portly from a published release. Afterwards
  `portly --update` on that release install must report up to date, which closes the one
  `portly --update`-on-a-release-install check 4.3 could not run; watch again for the parked
  sharing violation.

  *Done when:* `portly --status` healthy; the new tab works; `portly --update` reports up to date;
  a dated line here as the date of the first install from a release.

- **5.6 Rename the app on the consent screens (optional)** (S; go-ahead; after 1.6).
  Google Cloud and Azure portals: app name Portly, privacy and terms links to the republished
  pages, redirect URIs unchanged; [google.md](setup/google.md) and
  [microsoft.md](setup/microsoft.md) updated. Any time after 1.6; if done before 2.2, that run
  confirms the new name and no separate sign-in is needed, otherwise one real sign-in per provider
  shows it.

  *Done when:* both consent screens show Portly during a real connect (2.2 or a later sign-in).

- **5.7 Close the loop** (S; after 5.5).
  Roadmap statuses, an "Unreleased" CHANGELOG section, the memory note, and Known limits still true
  (unsigned packages, unpacked extension, own app registrations, Windows 11 x64). The next slice is
  phase 6; the post-alpha candidates (multi-PC build, first-run checklist, default sign-in apps,
  store listings, CalDAV writes, custom domain, the published release on a secondary PC)
  are listed under [Revisit after phase 6](#revisit-after-phase-6) and get a go or no-go each once
  phase 6 ships. Announcing anywhere is your call and not part of this plan.

  *Done when:* docs on main; CI green; the phase 5 row reads Done and the phase 6 row In progress.

## Phase 6: Launch pad sync, shipped as 0.2.0-alpha.2

Fix the account-scope gap, build the sync design's phases 1-5 on the verified Outlook.com-on-Pages
flow, and ship the result as 0.2.0-alpha.2 by repeating the phase 5 release steps. 6.1 may be built
in a parallel worktree as soon as phase 2 closes and needs no decision, but it merges to main only
after 5.3 has tagged 0.2.0-alpha.1, so the first alpha ships without sync code; 6.2 writes the
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

- **6.3 Bookmarks slice groundwork (design phase 1)** (M; after 6.2).
  A hybrid logical clock in sync state, `placedAt` for sort and `groupId` so `renumber()` and
  moves stop bumping `updatedAt`, lasting tombstones `{kind, id, at}` written in the same commit by
  every removing path (group delete with cascade, bookmark delete, import and backup restore),
  `BackupEntry.reason`, the one-time upgrade setting `placedAt = updatedAt`, and a test that
  enumerates the removing paths.

  *Done when:* static tests including the removing-paths enumeration; the export/import round trip
  is unchanged; `staticParity` untouched.

- **6.4 File format and merge in shared/ (design phase 2)** (M; after 6.3).
  A strict versioned zod schema (`portly-sync` version 1) from the export schemas plus timestamps
  and tombstones with caps; validation through `parseImportFile`, `assertSafeJson` and
  `decodeImage` with the 25 MB and 10 MB limits; a pure merge function with fixtures under
  `web/src/static/sync/__fixtures__/`.

  *Done when:* tests prove the merge commutative, idempotent and convergent across three simulated
  PCs; hostile and oversized fixtures are rejected.

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

- **6.6 Accounts and UI for sync (design phase 4)** (M; after 6.5).
  The service checkbox and status line on the Microsoft connection card, the incremental-consent
  step (explain, reconnect with the larger set, back to `#/settings/accounts`), the first-sync
  dialog defaulting to *Use the synced launch pad*, the Settings > Bookmarks pointer, the import
  warning and a "sync" client event category. This is where 6.1 gets its real check.

  *Done when:* web and static tests; on `npm run preview:static` with your account, Microsoft's
  screen lists only `Files.ReadWrite.AppFolder` and Diagnostics shows sync events; then connect
  calendar-only, add sync, withdraw one consent at account.live.com/consent/Manage, reload, and
  see the right Reconnect prompt with no `invalid_grant` loop (6.1's real check).

- **6.7 Docs, republish and the two-browser test (design phase 5)** (M; go-ahead; after 6.6).
  static-build.md, microsoft.md, ARCHITECTURE sections 1, 4.1, 10.5, 16 and 17, a README line;
  `portly --update` (with 1.8's dirty-tree refusal in place); then Chrome and Edge (and a second
  PC) on one account: add, rename, move, delete and reorder on each side, an offline edit, a
  forced conflict, a first sync on a fresh browser, consent withdrawal; record the download host
  seen from each browser and a Firefox smoke run of it.

  *Done when:* both browsers converge within the trigger cadence; `backups\` holds the pre-sync
  safety copy; no busy loop in Diagnostics; the hosts seen recorded; dated line.

- **6.8 Release 0.2.0-alpha.2** (S; go-ahead; after 6.7).
  A CHANGELOG entry for sync; the candidate installed on the clean account as in 5.2; publish as in
  5.3; the Pages site republished as in 5.4; the memory note and the docs updated.

  *Done when:* `gh release view v0.2.0-alpha.2` lists the zip and `portly-release.json` with
  matching SHA-256; the tag points at the built commit; the live site's footer reads
  0.2.0-alpha.2; the phase 6 row reads Done with the date.

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

  *Done when:* web tests and typecheck; both builds; B.4 passes.

- **B.3 Docs and scripts** (S; after B.2).
  ARCHITECTURE: a new section for other PCs and the section 4.1 update (each approved device is
  fully trusted, like a paired browser); `docs/setup/other-pcs.md` (Tailscale Serve set-up, the
  Host-header check, why never Funnel, revoking); `setup.ps1 -RemoteOrigin` with `-DryRun`;
  README and `docs/SETUP.md` lines; the privacy page text (`site/privacy.html`) that a server
  reachable from your other PCs needs.

  *Done when:* `check-scripts.ps1` passes in both PowerShell versions; `check-release.ps1`
  passes; the docs name the real commands and the variable.

- **B.4 The flow in a real browser on this PC** (S; after B.2).
  A throwaway local HTTPS proxy on another loopback port with a self-signed certificate (scratch
  only, never committed) in front of a scratch server (`PORTLY_REMOTE_ORIGIN=https://localhost:8443`,
  a scratch port and data folder, `PORTLY_PAGES_URL` cleared): connect from the proxied address,
  approve on the plain one, use the app, see the cookie renew, revoke, reconnect; a forged
  `X-Forwarded-For` on the plain port refused as `proxied_local_host`.

  *Done when:* dated here with what was seen, and the two B.1 rows in the checks table closed or
  narrowed.

- **B.5 The real check with a second PC** (S; go-ahead; after B.3; needs Tailscale on this PC and
  a second tailnet device).
  Tailscale Serve in front of a scratch server first (the installed Portly only on your say-so),
  pointed at the remote port: which Host, `Tailscale-User-*` and `X-Forwarded-*` headers arrive
  and whether the `Origin` header passes through unchanged (the cross-site check needs it), the
  four-way header probe (a forged `Tailscale-User-Login` from this PC and from the second device,
  each against what Serve adds or strips), then the whole connect flow from the other PC and a
  revoke from this one.

  *Done when:* the four results and the headers seen are dated in design/multi-pc.md; the B.1
  Tailscale row closed; the identity-header check (B.6) decided on those results.

- **B.6 Later** (parked): the extension's server address, so the other PC's New Tab opens the main
  PC's Portly; OAuth sign-in from other PCs (https redirect URIs for the remote origin); a passkey
  as a second factor; the `Tailscale-User-Login` check once B.5 has shown what Serve does.

## Checks never run for real

One row per *Not tested* note still open from the commit history, with the item that performs it.
A commit's *Not tested* note is copied here in the same commit (CLAUDE.md). *Result* takes the
date and the outcome once a row has been run for real.

| Check | From | Planned in | Result |
| --- | --- | --- | --- |
| A whole failed update (`install.ps1` putting the previous version and its database back); only the database restore step was tried on a temporary folder, because the whole path needs the real scheduled task | 1b8005b, 2026-10-20 | 4.3 | not yet |
| The settings dialog's focus change (it keeps looking for the requested field for 10 s and stops once focus has moved inside the dialog), by hand in a browser; only the new tests cover it | 29347b8, 2026-10-19 | 2.4 | not yet |
| The browser-only build's Outlook.com sign-in on the published Pages address itself: the same sign-in and sync check, the automatic 24-hour renewal and writing an event (the localhost copy passed) | 3b3edd7, 2026-10-19 | 2.1 | not yet |
| The OneDrive spike (sign-in, app folder reads and writes, cross-origin download URLs) in Firefox and Safari; only the desktop app's Chromium-based browser pane was used | 3b3edd7, 2026-10-19 | 6.7 (Firefox smoke run); Safari stays unsupported | not yet |
| The browser-only build's own automatic token renewal (`planSilentReauth`) against a real Outlook.com account; the spike only sent the same `prompt=none` request by hand | 3b3edd7, 2026-10-19 | 2.1 | not yet |
| The `*.files.1drv.com` download host kept in the sync CSP table: never seen in the spike and its CORS behaviour unverified (launchpad-sync.md section 4) | 3b3edd7, 2026-10-19 | 6.5 | not yet |
| A real Google or Microsoft sign-in through the new Accounts flow (connect, choose services, Manage adding a service by incremental consent); the tests and the hand check used fakes | 9cce15e, 2026-10-19 | 2.2 | not yet |
| Whether Microsoft's consent screen shows only the requested services' scopes on a sign-in through Portly's own flow (the spike saw the incremental-consent screen list only the added permission, but from a scratch page) | 9cce15e, 2026-10-19 | 2.2 | not yet |
| The **Wikipedia suggestions instead** switch (Settings > Search in the browser-only build) and the search wording it changes, in a real browser; 8bb97b1's localhost check covered the earlier always-on fallback only | 65dae13, 2026-10-19 | 2.4 | not yet |
| The reordered Settings > Bookmarks page (Groups, Preferences, then Import & export) in a browser; only the earlier order (0b63e51) was looked at | 0f23788, 2026-10-19 | 2.4 | not yet |
| The browser-only site on a PC where Portly is running but not paired (the footer label and the Diagnostics link in that case); unit tests only | 8bb97b1, 2026-10-19 | 2.3 | not yet |
| The retried copy of Homebase's IndexedDB database in a real browser (a copy that fails part-way, then the next load trying again and giving up after three loads); unit tests only | f0d5331, 2026-10-19 | 3.1 | not yet |
| The vault key swap during a Homebase copy (Homebase's key moved in, Portly's kept beside its old database) with a real DPAPI-protected key; the tests use plain files | 1860efe, 2026-10-19 | 3.1 | not yet |
| The 2026-10-19 switch-over fixes on a real Homebase PC: the extension and native host refusing a Homebase health answer (b5f5cc5), `HOMEBASE_DATA_DIR` read as the copy source (d14862a) and the one-time `HOMEBASE_*` variable copy (7eaee9c); fakes and temporary folders only | b5f5cc5, 2026-10-19 | 3.1 (scratch folders), 3.3 (a real Homebase PC) | not yet |
| The retry when setting a fresh program copy's modification time hits a sharing violation during a real install or update (the holder never reproduced in 110 runs; Defender real-time protection is the likely one) | 8f5fe93, 2026-10-19 | 4.3 and 5.5 (watch for it) | not yet |
| Hidden-tab behaviour (stopped clock and upload timers, the once-a-minute local server probe, the throttled cache save) with a real hidden tab instead of simulated visibility events | 3407dfc, 2026-10-18 | 2.3 | not yet |
| The hybrid pairing check in a real browser: a pairing change reloads each background tab only when you switch to it, after one more probe | 3407dfc, 2026-10-18 | 2.3 | not yet |
| Background upload preparation in Edge or Firefox, with a real camera photo, and with EXIF-rotated files; only Chrome's built-in browser pane was tried | 501e85b, 2026-10-18 | 2.4 | not yet |
| The frosted glass switch and the baked photo blur in a visible browser window and in browsers other than Chrome; only headless Chrome measurements and screenshots were made | 1169e15, 2026-10-18 | 2.4 | not yet |
| A real `install-autostart` run that registers the task to run `portly-supervisor.exe`; nothing in the repository records one (the installed task on the developer's PC does name it, dated 2026-10-18 in the memory note, but that is outside the repository) | 89e4325, 2026-10-18 | 4.3 (on a fresh account) | 2026-10-21 (after 1.3, on this PC): `install-autostart.ps1` replaced the running Browser-mode task, found the `node.exe` copies up to date, rewrote the native host files and registry keys, stopped the old processes and started the task; `/api/health` answered 0.2.0-alpha.1 and `portly --status` shows no warning. The fresh-account run stays with 4.3 |
| `update.ps1` and `portly --start` for real, refreshing out-of-date copies of `node.exe` before starting the task | 89e4325, 2026-10-18 | 1.3 (`update.ps1`), 5.4 (its task restart), 4.3 (`portly --start` on a fresh install) | 2026-10-21 (1.3): `portly --update` ran `npm ci` (the lockfile had changed), the build and the publish; the server was stopped at the time, so the task-restart path did not run. `portly --start` then started the task and waited for health; the copies of `node.exe` were up to date, so the refresh path did not run |
| A PC whose policy blocks running programs from `%LOCALAPPDATA%` (the task should fall back to `node.exe` and the supervisor to its own program) | 89e4325, 2026-10-18 | none: parked, cannot be reproduced on Windows 11 Home | not yet |
| The Weather widget's location prompt flow in a real browser (permission already granted, *Use my location*, a one-time *Allow this time*); the browser APIs are faked in the tests | 82fb2f8, 2026-10-13 | 2.4 | not yet |
| The animated lighthouse logo in Firefox and as the extension's New Tab page; frames were checked by eye in Chromium only | 7657e96, 2026-10-13 | 2.4 | not yet |
| A successful `portly --copy-from-homebase` run from the command line (the first PC's copy was requested by the installer instead) | c7549e5, 2026-10-13 | none scheduled: 3.1 avoids it on purpose because it acts on the real data folder; reopen if a PC in 3.3 or 3.4 needs it | not yet |
| A real run of `setup.ps1 -NoHomebaseCopy` or `install-autostart.ps1 -NoHomebaseCopy` (starting from scratch next to a Homebase install); only a dry run was made | 376e146, 2026-10-13 | 3.5 documents the browser side; a real run only if a PC in 3.4 starts from scratch | not yet |
| Both production builds free of CSP violations: the rule in ARCHITECTURE section 13 has no automated step behind it | design contract (ARCHITECTURE section 13) | 2.5, and again before every release | not yet |
| The device connect flow in a real browser through an HTTPS proxy (the `__Host-` cookies with `SameSite=Strict`, the renewal, approving on the main PC while the other page polls); only `testRequest()` tests with a remote Host header | B.1 commit, 2026-10-21 | B.4 | not yet |
| Tailscale Serve pointed at Portly's remote port: which Host, `Tailscale-User-*` and `X-Forwarded-*` headers arrive, whether `Origin` passes through unchanged, and whether a forged `Tailscale-User-Login` is stripped; nothing has run against Tailscale | B.1 commit, 2026-10-21 | B.5 | not yet |

### Closed

| Check | From | Closed by |
| --- | --- | --- |
| The browser-only polish (*Browser only* footer label, Diagnostics intro and link, gap-free first-run layout, suggestion labels, probe throttles) in a real browser | 8bb97b1, 2026-10-19 | 8bb97b1's own body: checked on 2026-10-19 with `npm run preview:static` on localhost, built against an unused port so it acted like a PC without Portly |
| Preparing background uploads in a real browser (canvas decoding, WebP encoding and SVG drawing were only exercised through fakes) | a7859df, 2026-10-18 | 501e85b (2026-10-18): tried in Chrome's built-in browser pane on the Vite dev server and the browser-only build with scratch data (large JPEG and PNG to WebP, small JPEG unchanged, animated GIF first frame, sized and unsized SVGs, corrupt JPEG error, *Optimize image* keeping blur and dim) |
| Outlook.com calendars in the browser-only build against a real Outlook.com account | 23abdd5, 2026-10-13 | 3b3edd7 (2026-10-19): a real account on a localhost copy of the site (*Single-page application* redirect) connected the account and synced its calendars; the published address is the 2.1 row above |
| A real run of `install-cli.ps1` replacing the old `homebase` command with `portly` (only `-DryRun` and the `check-scripts.ps1` fakes were run) | 9fc160f, 2026-10-13 | The first PC's switch-over on 2026-10-13 with `setup.ps1`, which runs `install-cli.ps1` and replaces the old command by itself |
| A real switch-over from Homebase (stopping, exporting and removing Homebase's task and restarting it on failure were tested against fakes; the installer only as a dry run) | c7549e5, 2026-10-13 | The first PC was switched over on 2026-10-13 with its Homebase data carried over; 7967cbe (2026-10-19) closed the review items the commit left open |
| The OneDrive download hosts, their CORS headers and `If-Match` on a simple upload, marked for a spike with a real Outlook.com account | 5a9b5b6, 2026-10-19 | 3b3edd7 (2026-10-19): the spike ran with a real Outlook.com account; launchpad-sync.md section 13 records the download host, its CORS answers and the `If-Match` results (`*.files.1drv.com` stays open above) |

## Parked, with reasons

### Revisit after phase 6

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
  accounts. The alpha stays Load unpacked; 4.6 writes down the prerequisites and the
  privacy-statement location.
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
  the mitigations in place are write-only secrets and no probing while framed.
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
- **Confirming the mouse-stutter cause by quitting Rainmeter and Razer Synapse.** Measurement
  already cleared Portly; it is your PC's setup, not a Portly task.
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
