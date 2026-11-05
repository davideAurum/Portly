# Portly setup

Portly runs on your own Windows PC: a small Node.js server on `localhost` serves the dashboard
and keeps your account credentials (encrypted), and a tiny browser extension makes it your New Tab
page. Nothing is hosted anywhere else and no account data leaves your PC except to the providers
you connect.

Setup takes three parts — the first is enough to try it out:

1. **Install it** — from a release package ([Install](#install)), or from the source code
   ([developers](#from-the-source-code)).
2. **Make it your browser's home** — the [new-tab extension](setup/extension.md) and
   [autostart](setup/autostart.md) (when the browser opens, or at sign-in).
3. **Connect accounts** — whichever you use (see [Connect your accounts](#connect-your-accounts)).
   Google and Microsoft each need a one-time app registration of your own first (about 15 and
   25 minutes); Yahoo, CalDAV, IMAP and Todoist need only a password or token.

## Install

The release package carries everything Portly needs, its own Node.js included: no Git, Node.js,
npm or administrator rights. In PowerShell:

```powershell
irm https://davideaurum.github.io/install.ps1 | iex
```

It downloads the latest release, checks its SHA-256, installs it into
`%LOCALAPPDATA%\Programs\Portly\app`, turns on autostart, installs the `portly` command and opens
the browser's extensions page for the one manual step (**Developer mode** → **Load unpacked** →
`%LOCALAPPDATA%\Programs\Portly\app\extension`, which it puts on the clipboard). Options, for
example a Pages site:
`& ([scriptblock]::Create((irm https://davideaurum.github.io/install.ps1))) -PagesUrl https://<user>.github.io/`
(`-DryRun` shows what it would do; all options: `Get-Help` on `scripts\install.ps1`).

After the extension is loaded:

- **Keep Developer mode on.** Since Chrome 134, an extension loaded with **Load unpacked** runs
  only while Developer mode is on; Edge may offer to turn such extensions off when it starts
  (close that prompt). Details: [New-tab extension](setup/extension.md).
- **Open a new tab.** Chrome asks whether to keep the new tab page the extension set: choose
  **Keep it** (Edge: **Keep changes**). The tab starts Portly if it isn't running and opens it.
  The first start creates a *Home* layout with every widget; press **E** (or use the edit
  button) to rearrange it, and open **Settings** to set your name, theme, search engines,
  weather location and so on.
- **The `portly` command** works in terminals opened after the install (`portly --status`
  checks everything).

**Updating:** `portly --update` installs the newest release: it copies your database to
`backups\` first, keeps the previous version in `app.previous`, and puts both back if the new one
doesn't start. Click **Reload** on the extension when it says the extension changed. Details,
and how releases are built and published: [Releases](setup/releases.md).

## Coming from Homebase

Portly is Homebase's new name. This version doesn't read a Homebase install, and doesn't stop or
remove one: if Homebase's server holds the port, Portly reports the port as in use.

Version 0.2.0-alpha.5 is the last one that copies a Homebase install over. To carry one over,
install [that release](https://github.com/davideAurum/Portly/releases/tag/v0.2.0-alpha.5) first,
then update. Export files from Homebase can still be imported, in **Settings → Import & export**.

## Requirements

- Windows 11. The credential vault uses Windows DPAPI and autostart uses Task Scheduler.
- Google Chrome or Microsoft Edge for the new-tab extension (any modern browser can open Portly
  directly).
- From the source code only: [Node.js](https://nodejs.org/) **24** (any 24.x release, which includes
  npm 11; check with `node -v`) and [Git](https://git-scm.com/) to get and update the code.

## From the source code

### One-command setup on a new PC

`scripts\setup.ps1` does everything below that a script can do: installs Git and Node.js 24 with
winget when they are missing (and stops if another Node.js major is installed, since Portly runs
on 24 only), clones Portly into `%USERPROFILE%\Coding\Portly`, installs and
builds, turns on autostart, installs the `portly` command, and opens the browser's extensions page
for the one manual step (Load unpacked → the `extension` folder). On a PC without the code, in
PowerShell:

```powershell
irm https://davideaurum.github.io/setup.ps1 | iex
```

The script comes from the Pages site: the static build adds a copy, so every publish updates it.
To pass options:

```powershell
& ([scriptblock]::Create((irm https://davideaurum.github.io/setup.ps1))) -InstallDir D:\Portly -DryRun
```

If you already have a checkout, run it from there:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

If you use a Portly Pages site ([hybrid mode](setup/pages-local-server.md)), add
`-PagesUrl https://<user>.github.io/`: setup saves it as `PORTLY_PAGES_URL` before it starts
Portly, and new tabs then open that site (the extension follows Portly on this PC). Without it,
new tabs open Portly itself at `http://localhost:5757`. `-PagesUrl off` turns the Pages site off
again. Use a site you publish yourself: `https://davideaurum.github.io/` is the developer's own,
and a Portly paired with a site trusts whatever that site publishes, so never point `-PagesUrl` at
a site you don't control.

To use this Portly from your other PCs ([Using Portly from your other PCs](setup/other-pcs.md)),
first run `tailscale serve --bg 5758` on this PC (it prints the address, like
`https://<pc>.<tailnet>.ts.net`), then add `-RemoteOrigin <that address>`: setup saves it as
`PORTLY_REMOTE_ORIGIN` before it starts Portly, which then also listens for the proxy on the port
after its own (`5758`). Approve each PC once in **Settings → Devices**. `-RemoteOrigin off` turns
it off again (and removes `PORTLY_REMOTE_PORT`). With a Pages site set too (`-PagesUrl`), the
other PCs can open that same site and connect it to this Portly (**Use Portly on another PC**).

For another of your PCs, [Adding a PC](setup/add-a-pc.md) is the whole checklist, from the
install to green Diagnostics.

Accounts are not copied: the vault is encrypted for this PC's Windows user, so connect them again;
move layout and settings with **Settings → Import & export** (what it carries:
[Your data](#your-data)).

### Quick start

In PowerShell:

```powershell
git clone <your Portly repository URL> Portly
cd Portly
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
`%LOCALAPPDATA%\Programs\Portly\app\extension`.

1. **[Install the extension](setup/extension.md)** in Chrome or Edge (Developer mode →
   Load unpacked → the `extension` folder). New tabs now follow Portly on this PC: they open
   `http://localhost:5757` — with a fallback page and search box when it isn't running — or, when
   the server has a Pages site (`PORTLY_PAGES_URL`), that site, which uses Portly on this PC
   once you have paired the browser with it
   ([Pages site with Portly on this PC](setup/pages-local-server.md)). The extension's options
   can pin either page.
2. **[Turn on autostart](setup/autostart.md)** so the browser starts Portly for you — when
   Chrome or Edge opens, and from a new tab if it still isn't running. This registers the
   **Portly Server** scheduled task and the small launcher the extension uses to run it (add
   `-Trigger Logon` to start Portly at every sign-in instead):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
   ```

   Then click **Test launcher** in the extension's options.

3. Optional: set the browser's startup page and Home button — see
   [Homepage and startup page](setup/extension.md#homepage-and-startup-page-optional).

## Connect your accounts

All accounts are added in **Settings → Accounts** (`http://localhost:5757/#/settings/accounts`),
calendar subscriptions in **Settings → Calendars**.

The page has two parts:

- **Connected accounts** lists what is connected: each account's name, email and status, and the
  services Portly uses it for (Calendar, Mail, Tasks). **Manage** renames an account, changes its
  color and switches services on or off; **Reconnect** signs in again (Google, Outlook.com),
  **Test** checks it, **Remove** disconnects it.
- **Add a connection** has a tile per provider: **Google**, **Microsoft** (Outlook.com),
  **Yahoo**, **Todoist** and **Other** (a CalDAV calendar or an IMAP mailbox). A tile walks you
  through connecting: the one-time app registration (Google and Microsoft, only the first time),
  then ticking what Portly should use the account for, then signing in (or entering the app
  password or token). Portly asks the provider only for access to what you ticked. To add a
  service later, open **Manage** on the account and click **Add**: you sign in once more and the
  provider asks only for the new part. Switching a service off only stops Portly using it; nothing
  is changed or revoked at the provider. **App registrations**, under the tiles, shows whether
  Google and Microsoft are set up and lets you edit a registration; **Manage** on a Google or
  Outlook.com account has the same **App registration** with **Edit**.

| Service | Calendar | Mail | Guide |
| --- | --- | --- | --- |
| Google (Gmail, Google Calendar) | read + write | yes | [google.md](setup/google.md) — your own Google Cloud OAuth client, ~15 min |
| Outlook.com / Hotmail (personal Microsoft account) | read + write | yes | [microsoft.md](setup/microsoft.md) — your own Entra app registration, ~25 min; read-only ICS alternative included |
| Yahoo | read-only (CalDAV) | yes (IMAP) | [yahoo.md](setup/yahoo.md) — app password |
| iCloud, Fastmail, Nextcloud, other CalDAV / IMAP | read-only | yes | [caldav-imap.md](setup/caldav-imap.md) |
| Any ICS / webcal link (holidays, Proton Calendar share links, …) | read-only | — | [caldav-imap.md](setup/caldav-imap.md#ics--webcal-subscriptions) |
| Todoist | — | — | [todoist.md](setup/todoist.md) — personal API token |
| Weather | — | — | nothing to set up (Open-Meteo, no key); pick a location in the widget |

Google and Microsoft require a one-time registration in their developer consoles because Portly
has no central server: the app is yours, used only by you. The guides walk through every screen.

## Configuration

Everything has sensible defaults. Override with environment variables (set them as *user*
environment variables so autostart sees them too):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTLY_PORT` | `5757` | Port. Also change it in the extension options, and add the matching Google redirect URI. |
| `PORTLY_DATA_DIR` | `%LOCALAPPDATA%\Portly` | Database, vault key, logs, backups. |
| `PORTLY_BIND` | `127.0.0.1,::1` | Listen addresses (loopback only). |
| `PORTLY_ORIGIN` | `http://localhost:<port>` | The URL you open Portly at. |
| `PORTLY_PAGES_URL` | *(unset: off)* | Your Portly Pages site's address, e.g. `https://<user>.github.io/`. Browsers paired with Portly may then use it from that site ([Pages site with Portly on this PC](setup/pages-local-server.md)). |
| `PORTLY_REMOTE_ORIGIN` | *(unset: off)* | The HTTPS address your other PCs use, given by a reverse proxy on this PC such as Tailscale Serve, e.g. `https://<pc>.<tailnet>.ts.net`. Each PC is approved once in **Settings → Devices** ([Using Portly from your other PCs](setup/other-pcs.md)). Portly still listens only on this PC. |
| `PORTLY_REMOTE_PORT` | `<port> + 1` | The loopback port that proxy forwards to (only with `PORTLY_REMOTE_ORIGIN`). |
| `PORTLY_LOG_LEVEL` | `info` | How much the log keeps normally: `debug`, `info` or `warn`. For a while, **Settings → Diagnostics** can switch to Verbose instead ([Diagnostics page and logs](setup/troubleshooting.md#diagnostics-page-and-logs)). |
| `PORTLY_PAGES_REPO` | *(unset)* | Your local clone of the public Pages repository. In a checkout, `portly --rebuild` (and `portly --update`) publishes the Pages site there. `install-cli.ps1 -PublicRepoPath` sets it. |

For development only: `PORTLY_DEV=1` (set by `npm run dev`) lets the Vite dev server's origin in,
and `PORTLY_VITE_PORT` (default `5173`) is that dev server's port. The server reads its variables
in `server/src/config.ts`.

Build-time, for `npm run build:static` only: `PORTLY_STATIC_BASE` (URL prefix, default `/`) and
`PORTLY_STATIC_SERVER` (where the site looks for Portly on this PC, default
`http://127.0.0.1:5757`; `off` disables hybrid mode; loopback addresses only). See
[static-build.md](setup/static-build.md).

## Your data

Everything lives in `%LOCALAPPDATA%\Portly`:

| Path | Contents |
| --- | --- |
| `portly.db` | Settings, layouts, bookmarks, account list, cached calendar events, encrypted secrets |
| `vault.key` | The key that encrypts stored credentials, protected by Windows for your user |
| `logs\server.log` | Server log, one JSON record per line (no passwords, tokens, message contents or full addresses); **Settings → Diagnostics** shows it |
| `logs\supervisor.log` | Autostart supervisor log (server starts, restarts and stops, and why) |
| `native-host\` | The launcher Chrome and Edge use to start Portly, and its `launcher.log` (written by `install-autostart.ps1`; always here, even with `PORTLY_DATA_DIR`) |
| `node\` | `portly-supervisor.exe` and `portly-server.exe`: copies of your `node.exe` that autostart runs, so Task Manager shows Portly by name ([details](setup/autostart.md#in-task-manager); written by `install-autostart.ps1`, always here) |
| `backups\` | Daily database backups (last 7) |

Mail is never stored on disk.

**Settings → Import & export** moves your set-up to another PC or browser. The `.json` file
carries your settings, profiles and layouts (with each widget's settings, feed addresses
included), bookmark groups and bookmarks, background images and custom icons. It never carries
accounts, passwords, tokens or sign-ins (the Todoist token included), calendar subscriptions and
ICS links, cached events or fetched bookmark icons: set those up again on the other side. Import
shows a summary before it changes anything, and the server copies its database to `backups\`
first.

## Updating

A release install: `portly --update` (see [Install](#install)).

From the source code, in one go: after `git pull`, `portly --rebuild` (`portly --update` does the
same in a checkout) runs `scripts\update.ps1`: `npm ci` when the lockfile changed, the build, a
restart of the server if it was running, and the Pages publish when `PORTLY_PAGES_REPO` is set.
It refuses a checkout with uncommitted changes, so what it builds and publishes is always a
commit; `--allow-dirty` builds and publishes them as they are, and `--dry-run` shows the plan.

Or by hand:

```powershell
git pull
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1   # restarts it
```

The installer also refreshes the launcher and Portly's copies of `node.exe`, which matters after a
Node.js update too. Add `-Trigger Logon` if that is the mode you use. Without autostart, stop
Portly (Ctrl+C) and start it again instead of running the last line.

Then click **Reload** on the extension in `chrome://extensions` / `edge://extensions`. If you use
the Pages site, publish it again too (`scripts\publish-static.ps1`, see
[static-build.md](setup/static-build.md#publish-to-github-pages)) so the site and Portly stay on
the same version. The script fetches your Pages clone first and fast-forwards it when another PC
published meanwhile; a clone that has diverged (commits of its own and commits on the origin it
lacks) is refused with the exact commands to merge it. GitHub Pages can serve the previous page
for up to 10 minutes after a publish, so hard-refresh (Ctrl+F5) before judging it.

## Uninstalling

1. Remove autostart and the `portly` command. In a release install the scripts are in
   `%LOCALAPPDATA%\Programs\Portly\app\scripts`; in a checkout, in `scripts`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cli.ps1 -Uninstall
   ```

   The first removes the task, the launcher's registry keys and folder, and Portly's copies of
   `node.exe` in `%LOCALAPPDATA%\Portly\node`. The second removes the `portly` command and its
   PATH entry.
2. Remove **Portly New Tab** from `chrome://extensions` / `edge://extensions`.
3. Revoke access at the providers you connected (Google:
   <https://myaccount.google.com/connections>; Microsoft:
   <https://account.live.com/consent/Manage>; delete Yahoo/iCloud/Fastmail app passwords), and
   delete the Google Cloud project / Entra app registration if you no longer need them.
4. Delete `%LOCALAPPDATA%\Portly` and the Portly folder (in a release install,
   `%LOCALAPPDATA%\Programs\Portly`). Remove any `PORTLY_*` user environment variables you set,
   such as `PORTLY_PAGES_URL` or `PORTLY_REMOTE_ORIGIN` (and stop the reverse proxy you ran for
   your other PCs).

## More

- [Troubleshooting](setup/troubleshooting.md) — the Diagnostics page and the logs, what each health
  code means, port in use, vault locked, reconnecting accounts, extension and autostart problems.
- [Browser-only build](setup/static-build.md) and [Pages site with Portly on this
  PC](setup/pages-local-server.md) — the GitHub Pages site and pairing it with Portly.
- [Adding a PC](setup/add-a-pc.md) — the checklist for putting Portly on another of your PCs.
- [Architecture](ARCHITECTURE.md) — how Portly is built and why.
