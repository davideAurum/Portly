# Portly new-tab extension

A Chromium Manifest V3 extension (Chrome and Edge) that makes Portly your New Tab page. It starts
Portly when it isn't running, follows Portly on this PC by default (its Pages site when the server
has one, otherwise Portly itself; the options can pin either), and its toolbar button adds the
current page to the launch pad. Plain JavaScript, no build step.
Installation: [docs/setup/extension.md](../docs/setup/extension.md).

## Extension ID (pinned)

```
nbaolbakegefnefgojdokagajincnfjj
```

`manifest.json` carries a `"key"` (the base64 DER SubjectPublicKeyInfo of an RSA-2048 public key),
so Chrome and Edge give the extension this ID wherever the folder lives. The native-messaging
launcher only answers this ID (`allowed_origins: ["chrome-extension://nbaolbakegefnefgojdokagajincnfjj/"]`).
The matching private key was never stored — loading an unpacked extension doesn't need it. Don't
add one to the repository.

`node extension/tools/extension-id.mjs` prints the ID computed from the manifest (`--origin`
prints `chrome-extension://<id>/`, `--json` both), so installers never hard-code it:
ID = the first 16 bytes of SHA-256(DER key) as hex, with the digits 0–f written as the letters a–p.

If the browser runs the extension under another ID, the launcher refuses it ("forbidden") and
running the installer again can't help. The extension spots this (`chrome.runtime.id` isn't
the pinned ID, `PINNED_EXTENSION_ID` in `lib/launcher.js`): the New Tab fallback and the options
page then show the Remove + Load unpacked steps, and the service worker's log says so.

## Stores: not for the alpha

The extension is only distributed as this folder, loaded unpacked; there is no Chrome Web Store
or Edge Add-ons listing. A store copy would run under another ID: keeping the pinned one needs
the private key, which is gone, and Edge Add-ons assigns its own ID anyway. The launcher allows
exactly one origin (`install-autostart.ps1` writes one), so it would refuse a store copy, and
`test/manifest.test.mjs` requires the `key` and forbids an `update_url`. Never change the `key`.

Before any store listing: a launcher that allows several origins, the installers and `status.ps1`
writing and checking them (and `PINNED_EXTENSION_ID` accepting them), an ID per browser, and the
listing assets and developer accounts. The details are in
[Releases](../docs/setup/releases.md#the-new-tab-extension-load-unpacked-no-store-listings).

The extension's privacy statement is the "The new-tab extension" section of
[`site/privacy.html`](../site/privacy.html), published at
`https://davideaurum.github.io/portly-site/privacy.html`.

## How it works

1. **Browser start.** The service worker (`background.js`) listens for `runtime.onStartup` (and
   `runtime.onInstalled`, so installing, updating or reloading the extension does the same). It
   reads the port, calls `http://localhost:<port>/api/health` once (1.5 s timeout) and, if
   Portly doesn't answer, sends one `{"action":"start","port":<port>}` message to the launcher.
   No polling, errors are only logged — the New Tab page does the waiting. A healthy answer's
   `pagesUrl` (the server's `PORTLY_PAGES_URL`, `null` when it has none) is stored as
   `serverSite` (`{port, pagesUrl}`, written only when it changed).
2. **New tab.** `newtab.html` loads `newtab.js` (an ES module — no inline scripts or handlers, so
   the strict extension CSP applies). It reads the settings from `chrome.storage.local` in one
   call: what a new tab opens (`target`: `auto`, the default, `pages` or `local`), the Pages site
   address (`pagesUrl`, none by default), the port (default **5757**) and `serverSite`. Then it
   picks where to go (`resolveNewTab` in `lib/portly.js`): `local` → Portly on this PC;
   `pages` → the stored address, else the one `serverSite` names for this port; `auto` → the
   address `serverSite` names for this port. With no address it goes to Portly on this PC, whose
   health answer can still send it on to the Pages site that answer names (unless the target is
   `local`).

   **Pages site**: the tab sends `{"type":"portly:warm-up"}` with
   `runtime.sendMessage`, waits at most 300 ms for the service worker's acknowledgement (a failed
   send is ignored) and then calls `location.replace(<pagesUrl>)`. It contacts nothing on this PC
   itself. The service worker's `runtime.onMessage` listener (registered at the top level) accepts
   the message only when `sender.id` is the extension's own ID, answers `{"ok":true}`
   synchronously, and then runs the same warm-up as at browser start — unless a warm-up started
   less than 60 s ago (any trigger; the time is kept in `chrome.storage.session` under
   `lastWarmUpAt`, and in memory when that area is unavailable) or one is still running.

   **Portly on this PC**: it checks `/api/health` (1.5 s timeout).
   - Portly answers (`{"ok": true, ...}`) → its `pagesUrl` is stored as `serverSite`, then
     `location.replace(<pagesUrl>)` when it names one and the target isn't `local`, else
     `location.replace('http://localhost:<port>/?src=newtab')`.
   - It doesn't → the page asks the launcher once (`{"action":"start","port":<port>}`), shows
     **Starting Portly…**, and polls `/api/health` every 400 ms for up to 30 s, then redirects.
     - Launcher not installed (`…host not found.`) or the task is missing (`task_missing`) → the
       fallback with instructions to run `scripts\install-autostart.ps1`
       (`docs\setup\autostart.md`).
     - ID mismatch (`…is forbidden.` or `bad_origin`) → the fallback with this extension's ID and
       instructions to run the installer again — or, when the extension itself still has its old
       ID, the Remove + Load unpacked steps (see above).
     - `schtasks_failed` / `bad_request` → the fallback with the launcher's detail.
     - `Native host has exited.`, `Failed to start native messaging host.` or no answer → keep
       polling; the task may well have started.
     - Still nothing after 30 s → the fallback with "Portly didn't answer within 30 seconds".
   - The fallback: why it couldn't connect, how to start Portly, **Try starting again** (asks
     the launcher again), **Retry** (health check only) and a plain Google search box (the query
     is `encodeURIComponent`-ed). It re-checks every 5 s for a minute, but never while you are
     typing in the search box. A health check that succeeds always redirects, even one that was
     still in flight when the attempt ended.

   Each page sends at most one launcher request per attempt; several tabs starting at once is
   fine (the scheduled task ignores a second start, and a second server exits when the port is
   taken).

3. **Toolbar button** ("Add this page to Portly", `lib/add-page.js`). `action.onClicked` gets the
   tab (its `url` and `title` are readable thanks to `activeTab`). For an `http:`/`https:` address
   without a user name or password (≤ 2048 characters) it opens
   `newtab.html#/add-bookmark?url=<address>&title=<title>` next to that tab (`tabs.create` with
   `index`, `openerTabId`, `windowId`; no "tabs" permission needed). The new tab page then does
   exactly what a new tab does and appends the hash to where it goes — the Pages site address or
   `http://localhost:<port>/?src=newtab` — after rebuilding it from its validated parameters
   (`forwardedHash`: any other hash is dropped). Portly shows its Add bookmark dialog filled in
   (`web/src/widgets/launchpad/addRequest.ts`, mounted by the shell). The title is whitespace-
   collapsed, capped at 300 characters, and left out when it is just the address. Any other page
   gets a per-tab `!` badge and tooltip (`action.setBadgeText` / `setTitle` with `tabId`), which
   the browser clears when the tab navigates. The extension never writes the bookmark itself: the
   launch pad lives where the Portly page keeps its data (the paired server, or the Pages site's
   in-browser copy, which no extension can reach), and the dialog lets you pick the group.

The options page (right-click the extension icon → **Options**, or the link on the fallback page)
stores three settings in `chrome.storage.local`, next to the `serverSite` record:

| Key | Setting | Valid values |
| --- | --- | --- |
| `target` | **New tab opens**, saved as soon as a choice is picked | `"auto"` (the default: whatever Portly on this PC is set up for), `"pages"` or `"local"` |
| `pagesUrl` | **Pages site address** (Save; **Use the address Portly reports** removes it) | an absolute `https://` URL, or `http://` on `localhost`, `127.0.0.1` or `[::1]`; no user name or password, `?` or `#`; stored normalised (lower-case scheme and host, default port dropped, path ending in `/`). None by default: the address Portly reports is used |
| `port` | **Portly port** (Save / Use default) | a whole number from 1024 to 65535; it must match the port the server uses (`PORTLY_PORT`, default 5757). The Pages site doesn't read it: it looks for Portly at the address it was built with (`PORTLY_STATIC_SERVER`, default `http://127.0.0.1:5757`) |
| `serverSite` | Not a setting: what Portly last said about its Pages site | `{port, pagesUrl}`, `pagesUrl` an address as above or `null`; it only counts for the port it was said on |

Invalid input is never stored, and anything missing or invalid in storage reads as the default. The
page also has **Test connection** (which also records and shows the Pages site Portly names),
shows the extension ID (with a warning if it isn't the pinned one) and has **Test launcher**, which
sends `{"action":"ping"}` and reports *installed*, *not installed*, *ID mismatch* or *broken*.

`serverSite` trusts whatever answers `/api/health` on the port, as the redirect to
`http://localhost:<port>` always has (port squatting is an accepted risk, ARCHITECTURE §4.1); the
address it names still has to pass the same checks as a typed one.

## The launcher contract

Native-messaging host `com.portly.launcher`, installed by `scripts\install-autostart.ps1` for
Chrome and Edge (HKCU registry entries pointing at its manifest). It never runs Portly itself: it
runs the **Portly Server** scheduled task, so the server isn't part of the browser's process tree.

| Request | Reply |
| --- | --- |
| `{"action":"start","port":5757}` | `{"ok":true,"state":"running"}` (already answering) · `{"ok":true,"state":"starting"}` (task started) · `{"ok":false,"state":"error","error":"task_missing"\|"schtasks_failed"\|"bad_request"\|"bad_origin","detail":"…"}` |
| `{"action":"ping"}` | `{"ok":true,"state":"pong","version":1}` |

## Permissions

| Manifest entry | Why |
| --- | --- |
| `chrome_url_overrides.newtab` | Replace the New Tab page. |
| `permissions: ["storage"]` | Remember the settings (`chrome.storage.local`) and when the last warm-up started (`chrome.storage.session`). |
| `permissions: ["nativeMessaging"]` | Ask the Portly launcher to start Portly (no prompt for an unpacked extension). |
| `permissions: ["activeTab"]` | Read the current tab's address and title when the toolbar button is clicked (no install warning, nothing in the background). |
| `action` | The toolbar button ("Add this page to Portly"), no popup. |
| `host_permissions: ["http://localhost/*"]` | Call `/api/health` on any localhost port (the server answers cross-origin requests only from the configured Pages site, never from the extension's origin). |
| `background.service_worker` (module) | Start Portly when the browser starts, and when a new tab with the Pages site asks; handle the toolbar button. |
| `key` | Pin the extension ID (see above). |

Messages between the extension's own pages and its service worker need no permission, and
opening the Pages site is a plain navigation of the tab (no host permission for it). No content
scripts, no `externally_connectable`, no web-accessible resources. The extension-page CSP
(which also covers the service worker) is tightened to
`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src http://localhost:*; img-src 'self'; style-src 'self'`.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Bump `version` with every change to the extension; it is never older than the root `package.json` version. |
| `background.js` | Service worker: registers the warm-up listeners (start-up, install, new-tab message) and the toolbar button's click listener at the top level. |
| `newtab.html`, `newtab.js` | New Tab page and its entry module. |
| `options.html`, `options.js` | Options page (what new tabs open, Pages site address, port, extension ID, launcher test). |
| `lib/portly.js` | Settings parsing/storage (target, Pages site address, port, `serverSite`), where a new tab goes (`resolveNewTab`), the health check, the warm-up message, URL builders. |
| `lib/launcher.js` | Native-messaging client: the contract above, error classification. |
| `lib/add-page.js` | The toolbar button: the add-bookmark hash, the filter the new tab page passes hashes through, the click handler. |
| `lib/warm-up.js` | The service worker's warm-up (one health check that also records `serverSite`, at most one start request; new-tab requests acknowledged at once and throttled to one a minute). |
| `lib/newtab-page.js`, `lib/options-page.js` | Page controllers (dependencies injected, so they are testable). |
| `styles.css` | Shared styles; light/dark via `prefers-color-scheme`. |
| `icons/icon-{16,32,48,128}.png` | Generated by `tools/generate-icons.mjs` from the Beacon lighthouse in `docs/brand/` (it also writes `site/icon-128.png`). |
| `tools/extension-id.mjs` | Prints the pinned ID / origin computed from the manifest key. |
| `test/*.test.mjs` | `node:test` suites (jsdom + fakes for fetch, `chrome.storage`, `chrome.runtime.sendNativeMessage`, events and timers). |

## Development

```powershell
node scripts/check-extension.mjs          # all extension tests (manifest, ID, pages, worker, logic)
node extension/tools/generate-icons.mjs   # regenerate the PNG icons after changing the design
node extension/tools/extension-id.mjs     # print the pinned extension ID
```

After editing files, click **Reload** on the extension's card in `chrome://extensions`
(or `edge://extensions`) and open a new tab. To see the service worker's log, click
**service worker** on the card (messages start with `[Portly]`).
