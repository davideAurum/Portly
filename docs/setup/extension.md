# New-tab extension (Chrome and Edge)

The small Homebase extension (in the `extension` folder) makes every new tab open Homebase, and
starts Homebase on this PC when it isn't running. A new tab opens one of two pages:

- **Homebase on this PC**: the page the Homebase server serves itself, `http://localhost:5757`.
- **The Pages site**: your Homebase Pages site (for example `https://<user>.github.io/`). When
  Homebase runs on this PC and this browser is paired with it, the site shows Homebase's own data
  (settings, bookmarks, calendar, mail…); otherwise it uses the copy it keeps in this browser. See
  [Pages site with Homebase on this PC](pages-local-server.md).

By default (since version 0.5.0) the extension **follows Homebase on this PC**: new tabs open its
Pages site when the server has one (`HOMEBASE_PAGES_URL`, which `scripts\setup.ps1 -PagesUrl`
sets), and Homebase itself otherwise — so a new install needs no extension settings at all. You
can pin either page in the extension options ([What new tabs open](#what-new-tabs-open)).

Either way the extension makes sure Homebase on this PC is starting:

- **When the browser opens**, it checks whether Homebase answers and, if not, asks the Homebase
  launcher to start it — so Homebase is usually ready by the time you open the first tab.
- **When you open a new tab with the Pages site**, the tab asks the extension's background worker
  to do the same check (at most once a minute) and opens the site straight away — it never waits
  for Homebase. In a browser paired with Homebase, the site finds it by itself and uses it once it
  answers.
- **When you open a new tab with Homebase on this PC** and Homebase still isn't running, the tab
  shows **Starting Homebase…**, asks the launcher again, and switches to Homebase as soon as it
  answers. If Homebase can't be started, the tab shows a simple fallback page instead: why it
  couldn't connect, how to start Homebase, **Retry** / **Try starting again** and a Google search
  box.

The launcher is a small helper that `scripts\install-autostart.ps1` registers for Chrome and Edge
(a *native messaging host*); it only ever asks Windows Task Scheduler to start the
**Homebase Server** task. See [Start Homebase automatically](autostart.md). Without it the
extension still works — you just start Homebase yourself.

It is loaded "unpacked" from your Homebase folder — it is not in the Chrome Web Store or Edge
Add-ons. It asks for three permissions: *storage* (to remember its settings: what new tabs open,
the Pages site address and the port), *native messaging* (to talk to the Homebase launcher — and
only to it) and access to `http://localhost` (to check whether Homebase is running). It has no
access to the pages you visit, the Pages site included: a new tab simply navigates there. Unpacked
extensions get these permissions without a prompt.

**Fixed extension ID.** The extension's `manifest.json` contains a public `key`, so its ID is
always `nbaolbakegefnefgojdokagajincnfjj` in Chrome and in Edge, wherever your Homebase folder is.
The launcher only answers that ID.

## Install in Google Chrome

1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension` folder inside your Homebase folder
   (for example `C:\Users\you\Coding\Homebase\extension` — the folder that contains
   `manifest.json`).
4. **Homebase New Tab** appears in the list. Open a new tab (Ctrl+T).
5. Chrome asks whether you want to keep the new tab page the extension set: choose **Keep it**.
   If you choose to change it back, Chrome turns the extension's new tab override off; re-enable
   the extension on `chrome://extensions` to get it back.

**Keep Developer mode on.** Since Chrome 134, unpacked extensions only run while Developer mode is
on — switching it off disables Homebase New Tab (turning it back on restores it). Chrome may also
remind you from time to time that developer-mode extensions are active; that is expected for an
extension loaded from a folder.

## Install in Microsoft Edge

1. Type `edge://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (in the left pane, or at the bottom of the page on narrow windows).
3. Click **Load unpacked** and select the `extension` folder inside your Homebase folder.
4. Open a new tab (Ctrl+T). If Edge asks whether to keep the change to your new tab page, keep it
   (for example **Keep changes**).

Edge may show a **Turn off extensions in developer mode** prompt when it starts. Close the prompt
instead of turning them off; if you did turn it off, re-enable Homebase New Tab on
`edge://extensions`.

## Let the browser start Homebase

Install the launcher once (it serves Chrome and Edge alike), from PowerShell in your Homebase
folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

Then check it: open the extension's options (**Details** → **Extension options** on
`chrome://extensions` / `edge://extensions`) and click **Test launcher**:

| Result | Meaning |
| --- | --- |
| *The launcher is installed and answering* | All set: new tabs and browser starts can start Homebase. |
| *The launcher isn't installed* | Run `scripts\install-autostart.ps1` (for this browser, the registry key is missing). |
| *…doesn't accept this extension's ID* | The launcher was installed for another ID (for example an extension copy loaded before the ID was fixed). Run `scripts\install-autostart.ps1` again, and make sure the extension shows the ID `nbaolbakegefnefgojdokagajincnfjj`. |
| *…didn't answer properly* | Run the installer again; `scripts\status.ps1` shows what is wrong. |

Details, modes and removal: [Start Homebase automatically](autostart.md).

## Updating from an older version

Older versions of the extension had no fixed ID (Chrome derived it from the folder path), and the
launcher only answers the fixed ID. After updating Homebase to a version with the launcher, do this
**once** in each browser you use:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Click **Remove** on Homebase New Tab and confirm. (Don't use **Reload** for this step: the
   browser only reliably picks up the new ID when the extension is loaded afresh.)
3. Click **Load unpacked** and select the `extension` folder again.
4. Check that the card shows **ID nbaolbakegefnefgojdokagajincnfjj**.
5. If you changed any option (a port other than 5757, what new tabs open, the Pages site address),
   set it again — removing the extension clears its saved settings.
6. Choose **Keep it** / **Keep changes** again if the browser asks about the new tab page.

Later updates only need **Reload** (see [Updating the extension](#updating-the-extension)).

## What new tabs open

Open the extension's options: on `chrome://extensions` / `edge://extensions` click **Details** on
Homebase New Tab → **Extension options**.

- **New tab opens** — the choice is saved as soon as you pick it and applies to the next new tab:
  - *Whatever Homebase on this PC is set up for* (the default): its Pages site when the server
    reports one, otherwise Homebase itself. The extension learns this from Homebase's health check
    (`pagesUrl` in `/api/health`) whenever the browser starts, a new tab checks Homebase, or you
    click **Test connection**, and remembers it; until Homebase has answered once, new tabs open
    Homebase on this PC (starting it if needed). The options page shows what it currently follows.
  - *The Pages site*: always the Pages site, at the address below.
  - *Homebase on this PC*: always `http://localhost:5757` (the port below), with the
    **Starting Homebase…** and fallback pages.
- **Pages site address** — only for *The Pages site*. Leave it empty to use the address Homebase
  on this PC reports (**Use the address Homebase reports** empties it); otherwise enter the address
  of the site's home, for example `https://<user>.github.io/homebase-pages/` for a project site,
  and click **Save**. Only the site the server trusts as `HOMEBASE_PAGES_URL`
  ([Pages site with Homebase on this PC](pages-local-server.md)) can use Homebase on this PC. The
  address must start with `https://`; `http://` is accepted only for a build served on this PC
  (`localhost`, `127.0.0.1` or `[::1]`, for example `http://localhost:5173/` from
  `npm run preview:static`). It can't contain `?` or `#`, and a missing `/` at the end is added.

The first time the Pages site runs in this browser it uses its own copy of your data. To let it use
Homebase on this PC, pair this browser once (the site offers **Pair this browser**; you approve it on
Homebase's own page) and allow the browser's *Local network access* / *Apps on device* prompt for the
site. The steps are in [Pages site with Homebase on this PC](pages-local-server.md).

### Switching back to Homebase on this PC

In the options, choose **New tab opens → Homebase on this PC**. New tabs then open
`http://localhost:5757` again (the port below it), with the **Starting Homebase…** and fallback
pages described above, whatever the server's Pages site. Choose another option to switch again;
the Pages site address is kept either way. To make the default follow Homebase itself on every
browser instead, turn the server's Pages site off: `scripts\setup.ps1 -PagesUrl off` (or remove
the `HOMEBASE_PAGES_URL` user environment variable and run `scripts\install-autostart.ps1` again).

**Updating from 0.3.0 or 0.4.0:** if you never changed **New tab opens**, it now follows Homebase
on this PC. With `HOMEBASE_PAGES_URL` set nothing changes; without it, new tabs open
`http://localhost:5757` instead of the Pages site address that used to be built in.
A choice you saved in the options is kept; a saved *The Pages site* without a saved address now
uses the address Homebase reports.

## Add the page you're on to the launch pad

Since version 0.4.0 the extension's toolbar button adds the page you're looking at to your launch
pad. Chrome and Edge hide new extension buttons at first: click the puzzle-piece (Extensions) button
next to the address bar and pin **Homebase New Tab**.

1. On any web page, click the Homebase button.
2. A new tab opens next to it with Homebase (the page new tabs open, starting Homebase on this PC
   first if needed) and its **Add bookmark** dialog, already filled in with the page's address and
   title. The group starts at your launch pad's default group.
3. Change the title, group or icon if you like, then click **Add bookmark** — or **Cancel**.

The bookmark lands wherever that Homebase page keeps its bookmarks: Homebase on this PC when the
browser is paired with it, otherwise the Pages site's copy in this browser. It works even when the
active dashboard has no launch pad.

Only `http` and `https` pages can be added. On anything else (the browser's own pages such as
`chrome://extensions`, PDFs opened from disk, the new tab page) the button shows a **!** badge on
that tab and its tooltip says why; the badge goes away when the tab moves to another page.

## Using a port other than 5757

If you run Homebase on another port (`HOMEBASE_PORT`), tell the extension — whichever page new tabs
open, it uses the port to check whether Homebase is running and to start it:

1. Open the extension's options: on `chrome://extensions` / `edge://extensions` click **Details**
   on Homebase New Tab → **Extension options** (or use the *Change it in the extension options*
   link on the fallback page).
2. Enter the port (a whole number from 1024 to 65535), click **Save**, then **Test connection**.
3. If new tabs open the Pages site, publish the site again with `HOMEBASE_STATIC_SERVER` set to
   the new port (for example `http://127.0.0.1:5800`): the site doesn't use the extension's port —
   it looks for Homebase at the address it was built with, `http://127.0.0.1:5757` unless
   `HOMEBASE_STATIC_SERVER` was set
   ([Pages site with Homebase on this PC, step 4](pages-local-server.md#4-build-and-publish-the-pages-site)).

## Homepage and startup page (optional)

The extension only replaces the *new tab* page. To make Homebase what opens when the browser starts
or when you click the Home button:

**Chrome** (Settings, `chrome://settings`)

1. **On startup** → **Open the New Tab page**. This goes through the extension, so you get the
   page you chose in its options — and, for Homebase on this PC, the fallback page instead of a
   connection error if Homebase isn't running yet. Alternatively choose **Open a specific page or
   set of pages** → **Add a new page** → your Pages site address or `http://localhost:5757`.
2. **Appearance** → turn on **Show home button** → choose **New Tab page** (or enter the URL).

**Edge** (Settings, `edge://settings`)

1. **Start, home, and new tab page** → **When Edge starts** → **Open the new tab page**
   (or **Open these pages** → **Add a new page** → the URL).
2. Same section → **Home button** → turn on **Show home button on the toolbar** → **New tab page**
   (or enter the URL).

With the launcher (Browser mode), prefer **the New Tab page** for startup: it also asks for
Homebase on this PC to be started. When the browser has just opened, Homebase is usually still
starting. In a browser paired with Homebase, the Pages site shows Homebase's last saved data and
uses Homebase as soon as it answers (if Homebase doesn't answer within about 45 seconds, the page
reloads with this browser's copy and switches back by itself once Homebase answers); in an
unpaired browser it shows this browser's copy. *Homebase on this PC* waits for it ("Starting
Homebase…"), while a plain `http://localhost:5757` page would show a connection error.

## Updating the extension

After pulling a new version of Homebase, open `chrome://extensions` / `edge://extensions` and click
the **Reload** button on Homebase New Tab's card. The settings (what new tabs open, the Pages site
address and the port) are kept. Also run `scripts\install-autostart.ps1` again so the launcher is
updated too (see [After updating Homebase](autostart.md#after-updating-homebase-or-nodejs)).
Coming from a version without the launcher? See
[Updating from an older version](#updating-from-an-older-version). Coming from 0.2.0? New tabs now
open the Pages site; see [Switching back to Homebase on this PC](#switching-back-to-homebase-on-this-pc).
Coming from 0.3.0? Pin the new toolbar button (see
[Add the page you're on to the launch pad](#add-the-page-youre-on-to-the-launch-pad)); the Pages site
must be published again for the button to open its dialog there.

## Behaviour notes

- **Address-bar focus.** Browsers give a new tab's keyboard focus to the address bar, and no
  extension API can hand it back after the page changes. The extension redirects with
  `location.replace(…)` — to the Pages site address, or to `http://localhost:<port>/?src=newtab`
  — so after the redirect the address bar shows that URL and keyboard focus is in the page.
  Homebase's search widget (with *autofocus* on) takes the focus, so you can start typing a search
  immediately; press **Ctrl+L** (or **Alt+D** / **F6**) when you want the address bar.
- **The alternative** — `chrome.tabs.getCurrent()` followed by
  `chrome.tabs.update(tab.id, {url})` — navigates the same tab from the browser side instead of the
  page. It needs no extra permission but gives the same focus result and adds an asynchronous round
  trip, so the extension uses the simpler `location.replace`. Keeping the address bar focused would
  require embedding Homebase in the extension page instead of navigating to it, which breaks
  bookmarks, history and the back button.
- **Incognito / InPrivate windows** always show the browser's own new tab page — browsers don't let
  extensions replace it there.
- **Only one new-tab extension wins.** If another installed extension also replaces the new tab
  page, disable it.
- The extension only ever contacts `http://localhost:<port>/api/health` and the Homebase launcher
  (`com.homebase.launcher`, with a "start on this port" or "ping" request). With the Pages site, a
  new tab also sends the extension's own background worker a `homebase:warm-up` message (the
  worker answers only the extension's own pages) and then navigates to the Pages site address; it
  sends the site nothing. Everything else Homebase does happens in the Homebase page itself, the
  Pages site included.
- **The toolbar button** reads the current tab's address and title only when you click it (the
  `activeTab` permission, which shows no install warning), and hands them to Homebase in the new
  tab's address (`#/add-bookmark?url=…&title=…`). The extension stores nothing and sends the page
  nowhere else; Homebase on this PC looks the page up only to find its icon, as when you paste an
  address into the dialog yourself.
- **Browser start** means a browser profile starting (not an Incognito/InPrivate window): the
  extension's background worker asks the launcher once per browser start, and again when the
  extension is installed, updated or reloaded.
- **New tabs with the Pages site** don't wait for Homebase: the background worker checks
  `/api/health` and, if needed, asks the launcher — at most once a minute however many tabs you
  open (it remembers the time in the browser's session storage, cleared when the browser closes),
  and not again within a minute of a browser start. A new tab waits at most 0.3 seconds for the
  worker to confirm the request before it opens the site.

Problems? See [troubleshooting](troubleshooting.md#new-tab-extension).
