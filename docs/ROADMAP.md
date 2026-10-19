# Roadmap

Where Portly is heading, one phase at a time. Each phase is finished, checked and reviewed before
the next one starts. Anything that makes something public (pushing, releases, the Pages site)
waits for an explicit go-ahead.

Status as of October 2026.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Make the move from Homebase safe | Done |
| 1 | Finish Portly | In progress |
| 2 | Switch existing Homebase installs over | In progress |
| 3 | The rest of the alpha | Not started |
| 4 | Go public | Not started |

## Phase 0: make the move safe (done)

Portly started as a snapshot of Homebase, with fresh history, the MIT license and a full rename.
The one Homebase feature that came later (Outlook.com calendars in the browser-only build) was
saved so it can be brought over in phase 1.

## Phase 1: finish Portly

1. **Moving over from Homebase** (done). An existing Homebase install is carried over: data,
   vault key, settings, browser data and accounts. The copy happens only when the installer or
   `portly --copy-from-homebase` asks for it. A failed copy is retried instead of starting empty.
   Homebase is removed only once Portly is up. See
   [SETUP: Coming from Homebase](SETUP.md#coming-from-homebase) and
   [ARCHITECTURE section 19](ARCHITECTURE.md#19-moving-over-from-homebase-the-name-before-portly).
   - Still open from its review:
     - the extension's health check still accepts Homebase;
     - the vault key is chosen wrongly when both exist;
     - `HOMEBASE_DATA_DIR` should be read as the source, not carried over;
     - the variable copy should happen only once;
     - a failed in-browser database copy is never retried.
2. **Outlook.com calendars in the browser-only build** (done). Brought over from Homebase with the
   rename applied. Missing tests were added, a retry loop when browser storage is full was fixed,
   dead settings code was removed, and stale text, comments and privacy notes were brought up to
   date. Tested with a real Outlook.com account on 2026-10-19: a local copy of the site, on a
   `localhost` *Single-page application* redirect, connected the account and synced its
   calendars ([design/launchpad-sync.md](design/launchpad-sync.md) section 13). Still to do on
   the published Pages address, which needs to be registered as a *Single-page application*
   redirect ([Outlook.com](setup/microsoft.md)): the same check, the automatic 24-hour renewal,
   and writing an event.
3. **Browser-only polish:**
   - hide "Open diagnostics on this PC" when no server answers, and give the browser-only
     Diagnostics page its own intro;
   - when a search engine's suggestions need the server, fall back to labelled Wikipedia
     suggestions;
   - close the gaps in the default layout;
   - show "Browser only" in the footer instead of "Not detected", with fewer failing health checks
     in the console.
4. **Smaller fixes:**
   - an update rollback also restores the database backup;
   - longer timeouts for the credential vault tests;
   - a clearer message from `setup.ps1` about updating;
   - two doc fixes (a broken paragraph in SETUP, the publish file list in the static build guide);
   - a test that ties the web build's files to what `publish-static.ps1` allows;
   - an observed value for the extension ID test.
5. **Version 0.2.0-alpha.1** with a CHANGELOG.

## Phase 2: switch existing installs over

The first PC was switched over in October 2026, with its Homebase data carried over, and the
Pages site is now published from Portly (`portly --update` keeps it current).

On each other PC that runs Homebase:
1. Run `setup.ps1` from Portly. It carries the Homebase data over (`-NoHomebaseCopy` starts from
   scratch instead).
2. Check that Portly is up (`portly --status`).
3. Swap the browser extension. (Setup replaces the old `homebase` command with `portly` by itself.)

Then test a real Outlook.com calendar in the browser-only build. Finally, archive the old Homebase
repository (it stays private) and its leftover branches.

## Phase 3: the rest of the alpha

- Default Google and Microsoft sign-in apps, so connecting an account doesn't need your own app
  registration.
- A first-run checklist in the app.
- An "add another PC" kit.
- One server reachable from several PCs, with a login. Until that login exists, the server stays
  on loopback only (ARCHITECTURE section 4). Proposed design:
  [design/multi-pc.md](design/multi-pc.md).

The plan for the alpha: each PC runs its own server for now, with a shared server later. The
Pages site works for anyone with a server on their own PC, and new tabs follow the local server.

## Phase 4: go public

Each step needs a go-ahead:
- Create the public repository, push it and get the first CI run green.
- Publish the first release.
- Test the one-line installer (`irm <site>/install.ps1 | iex`) on a clean Windows account.
- Publish the new-tab extension to the Chrome Web Store (unlisted) and Edge Add-ons, instead of
  loading it unpacked.
- Optionally rename the app on the Google and Microsoft sign-in consent screens. The redirect
  addresses don't change.

## Parked follow-ups

Loose ends from earlier work sessions that no phase above covers yet. Pick them up when they fit,
or fold them into a phase.

- **Tidy-ups:**
  - remove `@tanstack/query-sync-storage-persister` from `web/package.json`. Nothing uses it
    since the background-tab work, but it was kept to avoid a lockfile change;
  - the Shell test for the "Add bookmark" dialog (`#/add-bookmark`) sometimes fails, also on
    older commits. Make it reliable;
  - note in CLAUDE.md that manual runs should clear `PORTLY_PAGES_URL`, or the dev page forwards
    to the real Pages site.
- **Checks never run on main:** re-run the hybrid pairing check in a real browser, and check
  hidden-tab behaviour with a real hidden tab instead of a simulated one.
- **Dependencies:** two dev-only advisories (`shell-quote` through `concurrently`, and
  `source-map-js`) need a dependency upgrade to clear. This needs a go-ahead.
- **Versions:** the extension is at 0.5.2 while the app is at 0.1.0. Decide whether they should
  match when 0.2.0-alpha.1 goes out. After the first release, run `publish-static.ps1`.
- **Backgrounds:** an SVG background with blur above 0 can look a little softer than intended.
  It was left alone because it is rare.
- **Brand:** make animated versions of the logo without its tile and of the lockup with the name,
  to match `docs/brand/portly-icon-animated.svg`. Optionally make the beam brighter where it
  crosses the tower. Test the animated logo in Firefox and as the extension's New Tab page.
- **Several PCs:** the open questions in [design/multi-pc.md](design/multi-pc.md), for example
  whether Tailscale strips the `Tailscale-User-Login` header, still need checking.
- **Launch pad sync for the browser-only site:** a proposal to sync groups, bookmarks and icons
  between browsers through a file in your own OneDrive, as a service you tick on a Microsoft
  connection. A spike on a real Outlook.com account says go: a page can read and write the
  OneDrive app folder. Next is phase 1 of
  [design/launchpad-sync.md](design/launchpad-sync.md).
