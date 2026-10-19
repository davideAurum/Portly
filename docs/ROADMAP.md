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
2. **Outlook.com calendars in the browser-only build** (done). Brought over from Homebase with the
   rename applied. Missing tests were added, a retry loop when browser storage is full was fixed,
   dead settings code was removed, and stale text, comments and privacy notes were brought up to
   date. Still to do: a test against a real Outlook.com account, which needs the Pages address
   registered as a *Single-page application* redirect ([Outlook.com](setup/microsoft.md)).
3. **Browser-only polish** (done). The footer says *Browser only* while Portly isn't found on this
   PC, and such a PC sees far fewer failed checks in the browser's console. Engines whose
   suggestions need Portly show Wikipedia's instead, labelled as such. The first-run layout has no
   gaps, and the Diagnostics page has its own intro and links to Portly on this PC only once it
   answers. See [Browser-only build](setup/static-build.md).
4. **Smaller fixes:**
   - an update rollback also restores the database backup;
   - longer timeouts for the credential vault tests;
   - a clearer message from `setup.ps1` about updating;
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
    older commits. Make it reliable.
- **Checks never run on main:** re-run the hybrid pairing check in a real browser, and check
  hidden-tab behaviour with a real hidden tab instead of a simulated one.
- **Dependencies:** two dev-only advisories (`shell-quote` through `concurrently`, and
  `source-map-js`) need a dependency upgrade to clear. This needs a go-ahead.
- **Versions:** the extension is at 0.5.3 while the app is at 0.1.0. Decide whether they should
  match when 0.2.0-alpha.1 goes out. After the first release, run `publish-static.ps1`.
- **Backgrounds:** an SVG background with blur above 0 can look a little softer than intended.
  It was left alone because it is rare.
- **Brand:** make animated versions of the logo without its tile and of the lockup with the name,
  to match `docs/brand/portly-icon-animated.svg`. Optionally make the beam brighter where it
  crosses the tower. Test the animated logo in Firefox and as the extension's New Tab page.
- **Several PCs:** the open questions in [design/multi-pc.md](design/multi-pc.md), for example
  whether Tailscale strips the `Tailscale-User-Login` header, still need checking.
