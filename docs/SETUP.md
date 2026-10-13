# Homebase setup

Homebase runs on your own Windows PC: a small Node.js server on `localhost` serves the dashboard
and keeps your account credentials (encrypted), and a tiny browser extension makes it your New Tab
page. Nothing is hosted anywhere else and no account data leaves your PC except to the providers
you connect.

Setup takes three parts — the first is enough to try it out:

1. **Install it** — from a release package ([Install](#install)), or from the source code
   ([developers](#from-the-source-code)).
2. **Make it your browser's home** — the [new-tab extension](setup/extension.md) and
   [autostart](setup/autostart.md) (when the browser opens, or at sign-in).
3. **Connect accounts** — whichever you use (see [Connect your accounts](#connect-your-accounts)).

## Install

The release package carries everything Homebase needs, its own Node.js included: no Git, Node.js,
npm or administrator rights. In PowerShell:

```powershell
irm https://davideaurum.github.io/install.ps1 | iex
```

It downloads the latest release, checks its SHA-256, installs it into
`%LOCALAPPDATA%\Programs\Homebase\app`, turns on autostart, installs the `homebase` command and opens
the browser's extensions page for the one manual step (**Developer mode** → **Load unpacked** →
`%LOCALAPPDATA%\Programs\Homebase\app\extension`). Options, for example a Pages site:
`& ([scriptblock]::Create((irm https://davideaurum.github.io/install.ps1))) -PagesUrl https://<user>.github.io/`
(`-DryRun` shows what it would do; all options: `Get-Help` on `scripts\install.ps1`).

**Updating:** `homebase --update` installs the newest release: it copies your database to
`backups\` first, keeps the previous version in `app.previous`, and puts it back if the new one
doesn't start. Click **Reload** on the extension when it says the extension changed. Details,
and how releases are built and published: [Releases](setup/releases.md).

## Requirements

- Windows 11. The credential vault uses Windows DPAPI and autostart uses Task Scheduler.
- Google Chrome or Microsoft Edge for the new-tab extension (any modern browser can open Homebase
  directly).
- From the source code only: [Node.js](https://nodejs.org/) **24 or newer** (includes npm 11; check
  with `node -v`) and [Git](https://git-scm.com/) to get and update the code.

## From the source code

### One-command setup on a new PC

`scripts\setup.ps1` does everything below that a script can do: installs Git and Node.js with
winget when they are missing, clones Homebase into `%USERPROFILE%\Coding\Homebase`, installs and
builds, turns on autostart, installs the `homebase` command, and opens the browser's extensions page
for the one manual step (Load unpacked → the `extension` folder). On a PC without the code, in
PowerShell:

```powershell
irm https://davideaurum.github.io/setup.ps1 | iex
```

The Pages site carries a copy of the script (the static build adds it, so every publish updates
it); the repository itself is private, so the clone asks you to sign in to GitHub. With options:
`& ([scriptblock]::Create((irm https://davideaurum.github.io/setup.ps1))) -InstallDir D:\Homebase -DryRun`.
In a checkout you already have:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

If you use a Homebase Pages site ([hybrid mode](setup/pages-local-server.md)), add
`-PagesUrl https://<user>.github.io/`: setup saves it as `HOMEBASE_PAGES_URL` before it starts
Homebase, and new tabs then open that site (the extension follows Homebase on this PC). Without it,
new tabs open Homebase itself at `http://localhost:5757`. `-PagesUrl off` turns the Pages site off
again.

Accounts are not copied: the vault is encrypted for this PC's Windows user, so connect them again;
move layout and settings with **Settings → Export / Import**.

### Quick start

In PowerShell:

```powershell
git clone <your Homebase repository URL> Homebase
cd Homebase
npm ci             # install exactly the locked dependencies (install scripts are disabled)
npm run build      # build the web app into web\dist
npm start          # start the server; press Ctrl+C to stop
```

Open **<http://localhost:5757>**. The first start creates a *Home* layout with every widget; press
**E** (or use the edit button) to rearrange it, and open **Settings** to set your name, theme,
search engines, weather location and so on.

`scripts\start.ps1` does the same as `npm start` with a few checks (Node version, build if needed,
refuses to start twice):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

## Make it your New Tab page

A release install has done step 2 already; load the extension from
`%LOCALAPPDATA%\Programs\Homebase\app\extension`.

1. **[Install the extension](setup/extension.md)** in Chrome or Edge (Developer mode →
   Load unpacked → the `extension` folder). New tabs now follow Homebase on this PC: they open
   `http://localhost:5757` — with a fallback page and search box when it isn't running — or, when
   the server has a Pages site (`HOMEBASE_PAGES_URL`), that site, which uses Homebase on this PC
   once you have paired the browser with it
   ([Pages site with Homebase on this PC](setup/pages-local-server.md)). The extension's options
   can pin either page.
2. **[Turn on autostart](setup/autostart.md)** so the browser starts Homebase for you — when
   Chrome or Edge opens, and from a new tab if it still isn't running. This registers the
   **Homebase Server** scheduled task and the small launcher the extension uses to run it (add
   `-Trigger Logon` to start Homebase at every sign-in instead):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
   ```

   Then click **Test launcher** in the extension's options. If you had loaded the extension before
   this version, remove it and load it unpacked once more first — its ID is now fixed
   ([details](setup/extension.md#updating-from-an-older-version)).

3. Optional: set the browser's startup page and Home button — see
   [Homepage and startup page](setup/extension.md#homepage-and-startup-page-optional).

## Connect your accounts

All accounts are added in **Settings → Accounts** (`http://localhost:5757/#/settings/accounts`),
calendar subscriptions in **Settings → Calendars**.

| Service | Calendar | Mail | Guide |
| --- | --- | --- | --- |
| Google (Gmail, Google Calendar) | read + write | yes | [google.md](setup/google.md) — your own Google Cloud OAuth client, ~15 min |
| Outlook.com / Hotmail (personal Microsoft account) | read + write | yes | [microsoft.md](setup/microsoft.md) — your own Entra app registration, ~25 min; read-only ICS alternative included |
| Yahoo | read-only (CalDAV) | yes (IMAP) | [yahoo.md](setup/yahoo.md) — app password |
| iCloud, Fastmail, Nextcloud, other CalDAV / IMAP | read-only | yes | [caldav-imap.md](setup/caldav-imap.md) |
| Any ICS / webcal link (holidays, Proton Calendar share links, …) | read-only | — | [caldav-imap.md](setup/caldav-imap.md#ics--webcal-subscriptions) |
| Todoist | — | — | [todoist.md](setup/todoist.md) — personal API token |
| Weather | — | — | nothing to set up (Open-Meteo, no key); pick a location in the widget |

Google and Microsoft require a one-time registration in their developer consoles because Homebase
has no central server: the app is yours, used only by you. The guides walk through every screen.

## Configuration

Everything has sensible defaults. Override with environment variables (set them as *user*
environment variables so autostart sees them too):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOMEBASE_PORT` | `5757` | Port. Also change it in the extension options, and add the matching Google redirect URI. |
| `HOMEBASE_DATA_DIR` | `%LOCALAPPDATA%\Homebase` | Database, vault key, logs, backups. |
| `HOMEBASE_BIND` | `127.0.0.1,::1` | Listen addresses (loopback only). |
| `HOMEBASE_ORIGIN` | `http://localhost:<port>` | The URL you open Homebase at. |
| `HOMEBASE_PAGES_URL` | *(unset: off)* | Your Homebase Pages site's address, e.g. `https://<user>.github.io/`. Browsers paired with Homebase may then use it from that site ([Pages site with Homebase on this PC](setup/pages-local-server.md)). |
| `HOMEBASE_LOG_LEVEL` | `info` | How much the log keeps normally: `debug`, `info` or `warn`. For a while, **Settings → Diagnostics** can switch to Verbose instead ([Diagnostics page and logs](setup/troubleshooting.md#diagnostics-page-and-logs)). |

## Your data

Everything lives in `%LOCALAPPDATA%\Homebase`:

| Path | Contents |
| --- | --- |
| `homebase.db` | Settings, layouts, bookmarks, account list, cached calendar events, encrypted secrets |
| `vault.key` | The key that encrypts stored credentials, protected by Windows for your user |
| `logs\server.log` | Server log, one JSON record per line (no passwords, tokens, message contents or full addresses); **Settings → Diagnostics** shows it |
| `logs\supervisor.log` | Autostart supervisor log (server starts, restarts and stops, and why) |
| `native-host\` | The launcher Chrome and Edge use to start Homebase, and its `launcher.log` (written by `install-autostart.ps1`; always here, even with `HOMEBASE_DATA_DIR`) |
| `backups\` | Daily database backups (last 7) |

Mail is never stored on disk. **Settings → Import & export** exports your settings, layouts and
bookmarks (never accounts or credentials) to move them to another PC.

## Updating

A release install: `homebase --update` (see [Install](#install)).

From the source code:

```powershell
git pull
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1   # restarts it
```

The installer also refreshes the launcher; add `-Trigger Logon` if that is the mode you use.
Without autostart, stop Homebase (Ctrl+C) and start it again instead of the last line. Then click
**Reload** on the extension in `chrome://extensions` / `edge://extensions`. If you use the Pages
site, publish it again too (`scripts\publish-static.ps1`, see
[static-build.md](setup/static-build.md#publish-to-github-pages)) so the site and Homebase stay on
the same version.

## Uninstalling

1. `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1`
   (removes the task and the launcher's registry keys and folder; in a release install the script
   is in `%LOCALAPPDATA%\Programs\Homebase\app\scripts`), and the `homebase` command:
   the same folder's `install-cli.ps1 -Uninstall`.
2. Remove **Homebase New Tab** from `chrome://extensions` / `edge://extensions`.
3. Revoke access at the providers you connected (Google:
   <https://myaccount.google.com/connections>; Microsoft:
   <https://account.live.com/consent/Manage>; delete Yahoo/iCloud/Fastmail app passwords), and
   delete the Google Cloud project / Entra app registration if you no longer need them.
4. Delete `%LOCALAPPDATA%\Homebase` and the Homebase folder (a release install:
   `%LOCALAPPDATA%\Programs\Homebase`), and remove any `HOMEBASE_*` user
   environment variables you set (such as `HOMEBASE_PAGES_URL`).

## More

- [Troubleshooting](setup/troubleshooting.md) — the Diagnostics page and the logs, what each health
  code means, port in use, vault locked, reconnecting accounts, extension and autostart problems.
- [Browser-only build](setup/static-build.md) and [Pages site with Homebase on this
  PC](setup/pages-local-server.md) — the GitHub Pages site and pairing it with Homebase.
- [Architecture](ARCHITECTURE.md) — how Homebase is built and why.
