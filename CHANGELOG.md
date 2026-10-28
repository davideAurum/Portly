# Changelog

What changed in each version of Portly, newest first. The app's version is the one in
`package.json`. The new-tab extension has its own version (in `extension/manifest.json`) and only
gets a new one when its own code changes. Each entry names the extension version it ships with.

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
