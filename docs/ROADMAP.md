# Roadmap

Where Portly is heading, one phase at a time. Each phase is finished, checked and reviewed before
the next one starts. Anything that makes something public (pushing, releases, the Pages site)
waits for an explicit go-ahead.

Status as of October 2026.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Make the move from Homebase safe | Done |
| 1 | Finish Portly | In progress |
| 2 | Go public | Not started |
| 3 | Switch existing Homebase installs over | Not started |
| 4 | The rest of the alpha | Not started |

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
   date. Still to do: a test against a real Outlook.com account, which needs the Pages address
   registered as a *Single-page application* redirect ([Outlook.com](setup/microsoft.md)).
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

## Phase 2: go public

Each step needs a go-ahead:
- Create the public repository, push it and get the first CI run green.
- Publish the first release.
- Publish the GitHub Pages site from Portly.
- Test the one-line installer (`irm <site>/install.ps1 | iex`) on a clean Windows account.
- Optionally rename the app on the Google and Microsoft sign-in consent screens. The redirect
  addresses don't change.

## Phase 3: switch existing installs over

On each PC that runs Homebase:
1. Run `setup.ps1` from Portly. The first PC starts from scratch (`setup.ps1 -NoHomebaseCopy`);
   others can carry their Homebase data over.
2. Check that Portly is up (`portly --status`).
3. Swap the browser extension. (Setup replaces the old `homebase` command with `portly` by itself.)

Then publish the Pages site from Portly and test a real Outlook.com calendar in the browser-only
build. Finally, archive the old Homebase repository (it stays private) and its leftover branches.

## Phase 4: the rest of the alpha

- The new-tab extension published to the Chrome Web Store (unlisted) and Edge Add-ons, instead of
  loading it unpacked.
- Default Google and Microsoft sign-in apps, so connecting an account doesn't need your own app
  registration.
- A first-run checklist in the app.
- An "add another PC" kit.
- One server reachable from several PCs, with a login. Until that login exists, the server stays
  on loopback only (ARCHITECTURE section 4).

The plan for the alpha: each PC runs its own server for now, with a shared server later. The
Pages site works for anyone with a server on their own PC, and new tabs follow the local server.
