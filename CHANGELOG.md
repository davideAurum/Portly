# Changelog

What changed in each version of Portly, newest first. The app's version is the one in
`package.json`. The new-tab extension has its own version (in `extension/manifest.json`) and only
gets a new one when its own code changes. Each entry names the extension version it ships with.

## 0.2.0-alpha.3 (2026-10-30)

The third alpha: small fixes found while using alpha.2. Ships with new-tab extension 0.5.3
(unchanged, so no reload of the extension is needed).

### What's new
- **The new-event calendar list names the account.** Calendars are grouped under their account
  (for example "Google: Personal" and "Outlook.com: Work"), so two calendars both called
  "Calendar" can be told apart.
- **App registration beside the account.** **Manage** on a Google or Outlook.com account shows
  that provider's app registration (Ready, Setup needed or Credentials locked) with **Edit**.
  The list under the tiles stays.
- **Clearer first-sync question.** It no longer says the two launch pads "are different" (Portly
  asks whenever both have content, for example after a reconnect with identical bookmarks).
- **Clearer installer message when another Windows account has Portly.** An access-denied error
  while registering the `\Portly Server` task now says another account on the PC may already have
  Portly (one per PC today) before suggesting administrator rights.
- **Dependency update:** `@hono/node-server` 2.1.5 (fixes a moderate advisory, GHSA-rmxm-3fg6-px4f,
  that did not affect Portly).

### Known limits
- The same as 0.2.0-alpha.2's. One Windows account per PC can have Portly installed.

## 0.2.0-alpha.2 (2026-10-29)

The second alpha: launch pad sync for the browser-only site. Ships with new-tab extension 0.5.3
(unchanged, so no reload of the extension is needed). Before the release, sync ran between two
browsers through a real OneDrive and a private GitHub repository.

### What's new
- **Launch pad sync on the browser-only site (optional):** the launch pad (groups, bookmarks, their
  order, custom icons and the default group) stays the same in every browser where you turn it on.
  It syncs through one connection per browser:
  - an Outlook.com connection with **Launch pad sync** ticked, which keeps the files in that
    account's OneDrive app folder; or
  - a private GitHub repository you create, with a fine-grained token limited to it
    (**Settings → Accounts → GitHub**; public repositories and classic tokens are refused).

  The connection's card shows the sync status and **Sync now**. The first sync asks which launch
  pad to keep when two differ, and a sync that would remove much of it keeps a backup first.
  Layouts, widgets, the theme and other settings stay per browser. Portly's own page and a page
  paired with it don't offer sync. How to set it up, the GitHub repository and token included:
  [Launch pad sync](docs/setup/static-build.md#launch-pad-sync). The
  [privacy policy](site/privacy.html) says what sync sends where.
- **Outlook.com on the browser-only site** remembers which permissions its last sign-in asked for,
  so turning on a second service later doesn't break the automatic renewal.
- **New address for the public pages:** the footer's **Privacy** and **Terms** links go to
  `https://davideaurum.github.io/portly-site/`. The old homebase-site addresses, which
  0.2.0-alpha.1 links to, redirect there.

### Known limits
- The same as 0.2.0-alpha.1's: alpha, packages not code-signed, the new-tab extension loaded
  unpacked, your own app registrations, Windows 11 (x64) only.
- Launch pad sync is for the browser-only site only. Layouts, the theme and other settings are not
  synced, and Portly on your PC keeps its own launch pad.

## 0.2.0-alpha.1 (2026-10-28)

The first alpha of Portly, the new name of Homebase. Ships with new-tab extension 0.5.3.

### What's in it
- **Widgets:** search with several engines and suggestions, a launch pad of bookmark groups,
  calendars (Google, Outlook.com, Yahoo, CalDAV, ICS), mail (Gmail, Outlook.com, IMAP), Todoist,
  RSS feeds, sports scores, weather and a clock.
- **Customization:** a 12-column widget grid, themes, named profiles, and export and import of your
  settings.
- **Diagnostics:** **Settings → Diagnostics** shows the health of every account, feed and
  background job, with the server log and a downloadable report.
- **Two ways to run it:** Portly on your PC (a local server started by the new-tab extension or at
  sign-in), or the browser-only site on GitHub Pages, which can pair with Portly on your PC.
- **Other PCs:** one Portly can serve your other PCs and phones through Tailscale Serve, inside
  your own tailnet. You approve each device once on the main PC
  ([Other PCs](docs/setup/other-pcs.md)).
- **Install from a release package** with `install.ps1`, which needs no Git, Node.js or npm.
  `portly --update` installs newer releases. When an update fails, the previous version and your
  database are put back.

### Coming from Homebase
- Setup copies an existing Homebase install over: data, vault key, settings, browser data and
  accounts. `-NoHomebaseCopy` starts from scratch instead. Homebase is removed only once Portly is
  running. See [SETUP: Coming from Homebase](docs/SETUP.md#coming-from-homebase).

### Known limits
- Alpha: expect rough edges. Packages are not code-signed.
- The new-tab extension is loaded unpacked. It is not in the Chrome Web Store or Edge Add-ons yet.
- Connecting a Google or Microsoft account needs your own app registration
  ([Google](docs/setup/google.md), [Outlook.com](docs/setup/microsoft.md)).
- Windows 11 (x64) only. One Portly server per PC, listening on that PC only; other devices reach
  it only through Tailscale Serve on the main PC, once you approve them.
