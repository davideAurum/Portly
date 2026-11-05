# Changelog

What changed in each version of Portly, newest first. The app's version is the one in
`package.json`. The new-tab extension has its own version (in `extension/manifest.json`) and only
gets a new one when its own code changes. Each entry names the extension version it ships with.

## Unreleased

### What's new
- **GitHub status board.** A new **GitHub** widget lists your repositories with their latest CI
  result, open pull requests and issues, latest release and last push, with whatever needs attention
  first. The small **⋯** menu on each row opens the repository in GitHub Desktop, opens its pages on
  GitHub, or copies its clone address. It uses a read-only token you create
  ([how](docs/setup/github.md)), and Portly changes nothing on GitHub or on your disk. It works on
  Portly's own page, the Pages site, other PCs and the browser-only site.

## 0.2.0-alpha.7 (2026-11-05)

The seventh alpha: a Music widget that controls Spotify from your home page. Ships with new-tab
extension 0.5.3 (unchanged, so no reload of the extension is needed). Spotify has not yet been tried
with a real account, so treat the widget as a first test.

### What's new
- **Music widget.** See what is playing on Spotify and control it from your home page: play, pause,
  skip, seek, volume, shuffle, repeat and which device it plays on. It is a remote control, so the
  music plays in Spotify on your own devices and keeps going while the tab goes elsewhere. It needs
  Spotify Premium and Portly on your PC ([how](docs/setup/spotify.md)). More services can be added
  later without changing the widget.

### Changed
- **One database update on start.** The accounts table is rebuilt once so that new kinds of account
  fit. Your accounts, calendars and events are carried over unchanged, and if anything looks wrong
  the update undoes itself and Portly stops with a message.

## 0.2.0-alpha.6 (2026-11-04)

The sixth alpha: the new-tab extension can be downloaded without the code, updates work from
PowerShell 7, and the Homebase copy is gone. Ships with new-tab extension 0.5.3 (unchanged, so no
reload of the extension is needed).

### What's new
- **Get the new-tab extension without the code.** On a PC that only wants the new tab page, one
  PowerShell command downloads the extension from the Pages site, checks it and unpacks it ready for
  **Load unpacked**; running it again updates the folder
  ([how](docs/setup/extension.md#get-the-extension-on-a-pc-without-the-code)). It needs the Pages
  site published from this version on.

### Fixed
- **`portly --update` from PowerShell 7.** It stopped with "The term 'Get-FileHash' is not
  recognized", before changing anything, because the Windows PowerShell behind the `portly` command
  picked up PowerShell 7's modules. The fix is in the installed copy that runs an update, so the
  update *to* this version from PowerShell 7 still needs
  [the way round it](docs/setup/troubleshooting.md#updating).
- **A working update is no longer rolled back.** Windows build 26300 reports the state of network
  connections wrongly, so the start check after an update found nothing listening, waited 90 seconds
  and put the old version back although the new one was running. `portly --status`, `portly --start`
  and `scripts\start.ps1` could say "nothing is listening" for the same reason. They now look for the
  connection with no remote end, which Windows reports correctly.

### Removed
- **Copying a Homebase install.** No PC runs Homebase any more, so the installer, `portly
  --copy-from-homebase`, `-NoHomebaseCopy` and the browser's copy of Homebase's data are gone.
  0.2.0-alpha.5 is the last version that can carry a Homebase install over. Export files from
  Homebase can still be imported. Nothing changes for a PC already on Portly.

## 0.2.0-alpha.5 (2026-11-04)

The fifth alpha: the main PC approves your other PCs on the same address. Ships with new-tab
extension 0.5.3 (unchanged, so no reload of the extension is needed).

### What's new
- **Approve your other PCs on the Pages site.** On the main PC, Settings → Devices on the Pages
  site now has **Approve** and **Deny** itself, so the main PC also uses one address. Before, it
  sent you to Portly's own page (`http://localhost:5757/#/settings/devices`). Another PC still
  cannot approve anything. The site must be paired with Portly on the main PC, and it needs this
  version of Portly there too.

## 0.2.0-alpha.4 (2026-10-30)

The fourth alpha: one address for every PC, and a Notes widget. Ships with new-tab extension 0.5.3
(unchanged, so no reload of the extension is needed).

### What's new
- **One address for every PC.** Your other PCs can open the same Pages site as the main PC and
  use the main PC's Portly through it: click the Portly status in the footer, choose **Use Portly
  on another PC**, type the main PC's Tailscale address once, and approve the PC in **Settings →
  Devices** on the main PC ([how](docs/setup/other-pcs.md#connecting-another-pc)). It needs a
  Pages site set on the main PC (`PORTLY_PAGES_URL`) and Tailscale on both. The published site
  names no PC and no tailnet: each browser is told the address once. The Tailscale address itself
  keeps working as before.
- **Notes widget.** A plain-text note, saved as you type (**Edit layout → Add widget → Notes**; add
  one per topic). It goes wherever your layout goes: export and import, copied profiles, the
  browser-only site and your other PCs. Its settings pick the text size, a monospace font and spell
  checking.
  - When the same note is open in two tabs or on two PCs, a save never overwrites the other copy
    blindly: if it changed since you started typing, the note asks whether to **Keep mine** or
    **Use saved**.
  - Text that could not be saved yet (Portly stopped, the tab closed mid-save) is kept in the
    browser and comes back on the next page load. The header says **Not saved** until it is;
    click it to try again.
- **Widget settings no longer undo a widget's own changes.** Saving a widget's settings applies
  only the fields changed in the dialog to the widget's latest settings, so a note typed just before
  opening the dialog is kept.

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
