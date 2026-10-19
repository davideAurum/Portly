# Troubleshooting

Start with the status script — it answers most "is it running?" questions in one go:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1 -LogLines 40
```

When Portly runs but something doesn't connect, sync or update, open its **Diagnostics** page
(next section). Every problem it lists has a code; [Health codes](#health-codes) at the end says
what each one means and how to fix it.

## Diagnostics page and logs

### Open it

**Settings → Diagnostics**, on the Pages site while it uses Portly on this PC, or on Portly's
own page. One address always shows Portly's full diagnostics, because it never forwards to the
Pages site:

```text
http://127.0.0.1:5757/#/settings/diagnostics
```

(with your port if you changed `PORTLY_PORT`). Use it when the Pages site, or its connection to
Portly, is what's broken; on the Pages site, **Open diagnostics on this PC** links there. While
the Pages site uses this browser's copy, its Diagnostics page shows only **Overview** (the site, its
connection to Portly, the browser's local network permission) and **This browser**. *Update
Portly on this PC to see its diagnostics* means Portly is older than the page: update it.

### What each tab shows

| Tab | What it shows |
| --- | --- |
| **Overview** | Version (with a warning when the page runs a different one), uptime, process, the autostart supervisor's last restart and why, modules that failed to start, the credential vault, warnings and errors of the last hour (server and browser), the log level, requests and outbound calls in progress, the Pages site and paired browsers. Banners for a site that tried to use Portly although it isn't its `PORTLY_PAGES_URL`, and (on the Pages site) for Portly answering on this PC but not to this site. |
| **Connections & sync** | Every account, calendar list, calendar, mailbox, ICS link, feed, Todoist, weather, search suggestion provider, sports league and scheduled job, whatever needs attention first: **OK**, **Degraded** (works, but only partly), **Failing since …**, **Stale — last checked …** (an expected check is overdue) or **Not checked yet**. A problem shows its code (see [Health codes](#health-codes)), a one-line fix, the message and HTTP status, how many times in a row it failed and when Portly tries again; *because … needs attention* leads to the account it depends on. Details add the recent history, **Show related log lines** and, for jobs and calendars, **Run now**. |
| **Logging level** | Normal or Verbose (below). |
| **Server log** | Portly's recent log lines, kept in memory: filter by level (**Errors**, **Warnings**, **Info**, **All**), area, source (server or browsers) and text. Click a request, job, run, account or calendar chip to see only its lines. **Live** follows new lines, **Show older** reads the log files, **Timeline** mixes in this browser's events. |
| **This browser** | What this browser noticed: requests that failed or were slow, changes of the Pages site's connection to Portly, errors in widgets and in the page. Kept in this browser for 7 days, and sent to Portly every 15 s while the page uses it. **Clear** forgets them. |
| **Report** | **Download diagnostic report** and **Copy summary** (below). |

### Verbose logging

Normally the log is short: state changes, failures (with the host, the HTTP status and the
provider's reason code) and one line whenever something starts failing or recovers. To see
everything — every request, sync step and outbound call — while you reproduce a problem:

1. **Logging level** → turn on **Verbose logging**, choose how long (**30 min**, **2 h**, **24 h** or
   **Until turned off**) and, if you like, tick only the areas you are looking into.
2. Reproduce the problem, then look at **Server log** with level **All**, or download the report.
3. Turn it off again, or let it end by itself.

A timed Verbose period survives a restart of Portly; *Until turned off* ends at the next
restart. While Verbose is on, **Diagnostics** in the settings menu shows a **Verbose** badge.
*Normal* means the level Portly starts with: `info`, unless the `PORTLY_LOG_LEVEL` user
environment variable says `debug` or `warn`.

### Report and summary

- **Download diagnostic report** saves `portly-diagnostics-<date>-<time>.json`: the overview,
  every subject of Connections & sync with its recent history, the log lines in memory, the end of
  `server.log`, `supervisor.log` and the launcher's `launcher.log`, which `PORTLY_*` variables are
  set (never their values), and this browser's events.
- **Copy summary** copies a plain-text digest of at most 40 lines to paste into a message:
  versions, what isn't OK, and the latest distinct warnings and errors with how often they happened
  (repeats that the log collapsed included).
- **Hide hosts, emails and names (for sharing publicly)** — off by default, because the full detail
  is what helps — replaces account names, emails, calendar names, server and feed hosts, the Pages
  site, this PC's name and your Windows user name with placeholders such as `host#1` and `email#2`,
  in both. Well-known provider hosts (Google, Microsoft, Yahoo, Todoist, Open-Meteo …) stay, so the
  reader still sees which service failed.

The log, the report and the summary never contain passwords, tokens or other secrets; mail, event
or task contents, titles, search text or coordinates; or full web addresses (only host names). Your
Windows user name is masked in paths (`C:\Users\~\…`). Without the box ticked they do contain
account names and emails, calendar names and hosts — skim them before sharing.

### Reading the log files

When Portly doesn't start there is no Diagnostics page: read the files (`status.ps1 -LogLines 40`
prints their last lines, each record as `<time> <LEVEL> [<area>] <message> {other fields}`).
`server.log` and `supervisor.log` hold one JSON record per line: `t` (time, UTC), `lvl`, `msg`,
`area`, then fields such as `rid` (request id), `job`, `accountId`, `code`, `status` and `host`. In
PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\Portly\logs\server.log" -Tail 200 | ConvertFrom-Json | Where-Object lvl -in 'warn','error'
```

To dig further, read the last records once and filter them (`Where-Object { $_.StartsWith('{') }`
skips text lines an older Portly wrote; with `PORTLY_DATA_DIR`, the log is in that folder's
`logs`):

```powershell
$records = Get-Content "$env:LOCALAPPDATA\Portly\logs\server.log" -Tail 5000 |
  Where-Object { $_.StartsWith('{') } | ConvertFrom-Json
$records | Where-Object lvl -in 'warn','error' | Format-Table t, lvl, area, msg -AutoSize   # warnings and errors
$records | Where-Object rid -eq 'k3j9x0a1bc' | Format-Table t, lvl, msg, status, code      # one request
$records | Where-Object accountId -eq '<account id>' | Format-Table t, lvl, msg, code     # one account
$records | Where-Object job -eq 'calendar:sync' | Format-Table t, lvl, msg, run, ms         # one job
$records | Where-Object lvl -eq 'error' | Select-Object -Last 1 | Format-List *              # every field of the last error
```

A request's id is the `rid` on each of its lines; the browser sees it as the `X-Request-Id` answer
header, and This browser keeps it as `rid` on the event of a failed request. To find a request in
every log file, including the rotated ones:

```powershell
Select-String -Path "$env:LOCALAPPDATA\Portly\logs\server.log*" -SimpleMatch '"rid":"k3j9x0a1bc"'
```

`supervisor.log` has the same format; [Autostart](autostart.md#when-the-server-stops-or-wont-start)
explains its lines.

## Where things are

| What | Where |
| --- | --- |
| Data folder | `%LOCALAPPDATA%\Portly` (or `PORTLY_DATA_DIR`) |
| Database | `<data>\portly.db` (also the health of everything Portly syncs and its recent history, kept on this PC only: never exported) |
| Vault key | `<data>\vault.key` (protected with Windows DPAPI for your user) |
| Server log | `<data>\logs\server.log`, JSON Lines, rotated at 10 MB to `server.log.1` … `server.log.5` |
| Autostart supervisor log | `<data>\logs\supervisor.log`, JSON Lines — when autostart started, restarted or stopped the server, and why ([details](autostart.md#when-the-server-stops-or-wont-start)) |
| Launcher (native host) | `%LOCALAPPDATA%\Portly\native-host\` (always there, even with `PORTLY_DATA_DIR`); `launcher.log` in it has one line per request from the browser |
| Backups | `<data>\backups\portly-YYYY-MM-DD.db` (daily, last 7 kept) and `pre-import-*.db` |
| Health check | `http://localhost:5757/api/health` → `{"ok":true,"version":"…","vault":"ready","app":"portly",…}` |
| In the app | **Settings → Diagnostics** (above); **Settings → About** shows the version, data folder, log path and vault state |

A timed Verbose period is remembered in the database (`server_meta` row `diagnostics.verbose`)
until it ends, so it survives a restart.

To open the log folder: `explorer "$env:LOCALAPPDATA\Portly\logs"`.

## Starting Portly

**"Port already in use — is Portly already running?"** (the server exits with code 3)
Something already listens on the port. `scripts\status.ps1` names the program; or:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5757 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

- If it is Portly itself (for example the autostart task), just open `http://localhost:5757`.
- If it is another program, stop it or move Portly to a free port: set the `PORTLY_PORT` user
  environment variable (System Properties → Environment Variables, or
  `[Environment]::SetEnvironmentVariable('PORTLY_PORT', '5800', 'User')`), open a new PowerShell
  window, re-run `install-autostart.ps1` if you use autostart, set the same port in the
  [extension options](extension.md#using-a-port-other-than-5757), and add
  `http://localhost:5800/api/oauth/google/callback` to your Google OAuth client
  (Microsoft ignores the port). If new tabs open the Pages site, also publish it again with
  `$env:PORTLY_STATIC_SERVER = 'http://127.0.0.1:5800'` set
  ([step 4](pages-local-server.md#4-build-and-publish-the-pages-site)): the site looks for
  Portly at the address it was built with, not at the extension's port.

**"web/dist is missing — run `npm run build`"** (exit code 4) — the web app hasn't been built (or
was deleted). Run `npm run build`, or use `scripts\start.ps1`, which builds it when needed. Under
autostart the supervisor tries three times, then stops (`supervisor.log`: *server cannot start;
not restarting*): after building, start the task again (`Start-ScheduledTask -TaskName 'Portly
Server'`).

**"running scripts is disabled on this system"** — PowerShell's execution policy. Run scripts as
`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\<name>.ps1`; that affects only that
command.

**`npm ci` fails with EBADENGINE / "Unsupported engine"** — Portly needs Node.js 24 or newer and
npm 11.10 or newer (`node -v`, `npm -v`). Install the current Node.js LTS from
<https://nodejs.org/>, open a new terminal and try again.

**Nothing listens and the log ends with an error** — read the last records of `server.log` and
`supervisor.log` (`status.ps1 -LogLines 40` shows both; [Reading the log files](#reading-the-log-files)
filters them). A start-up failure is one `startup failed` line whose `phase` says how far it got
(`config`, `db`, `migrate`, `vault`, `listen` …), with the error's name, code and message.

**"invalid configuration"** — a `PORTLY_*` environment variable has a value the server rejects
(the message names it; for an address it shows only its origin). The server writes it to the
console and as one `startup failed` line (`"phase":"config"`) to `server.log`; under autostart the
supervisor checks the configuration first and writes that line to `supervisor.log` instead.
`status.ps1` shows **Configuration: INVALID - …** when Portly isn't answering, and
`install-autostart.ps1` refuses to install until it is fixed. Fix or remove the variable (System
Properties → Environment Variables), open a new PowerShell window and try again.

## Vault locked

Portly encrypts stored credentials (OAuth client secrets, refresh tokens, app passwords, the
Todoist token, private ICS links) with a key in `vault.key`, which Windows protects for your user
account. If that key can't be read, Portly starts in **locked** mode: everything that needs no
credentials still works, accounts show **Reconnect**, Settings shows a banner,
`/api/health` reports `"vault":"locked"`, and Diagnostics shows the code
[`vault_locked`](#vault_locked).

Typical causes:

- `vault.key` was deleted or damaged while the database still has secrets;
- the data folder was copied to another PC or Windows user (DPAPI keys don't travel);
- an administrator *reset* your Windows password (changing it yourself is fine), or Windows was
  reinstalled.

Portly never replaces the key automatically. It renames the unreadable file to
`vault.key.unreadable-<timestamp>` so nothing is lost.

**Fix it:**

- If you have the original `vault.key` for this same Windows user (for example from a file backup),
  stop Portly, put it back as `vault.key`, and start Portly again.
- Otherwise open **Settings → Accounts** and use **Reset credentials** in the banner. This deletes
  all stored secrets and creates a new key. Then re-enter the Google client secret, reconnect your
  accounts, re-enter app passwords and the Todoist token, and re-add private ICS links. Your
  layout, bookmarks and settings are not affected.

## Accounts that need "Reconnect"

An account shows **Reconnect** when its provider rejects the saved sign-in. Click **Reconnect** in
**Settings → Accounts** (or on the widget) and sign in again; a Yahoo, CalDAV or IMAP account is
added again with its current app password. Common reasons:

- **Google:** the app was still in *Testing* (tokens expire after 7 days — publish it, see
  [Google setup](google.md#audience--publish-the-app-important)); the token was unused for 6 months;
  you changed your Google password; or you removed Portly at
  <https://myaccount.google.com/connections>.
- **Microsoft:** 90 days without use; password change; or you removed the app at
  <https://account.live.com/consent/Manage>.
- **Yahoo / CalDAV / IMAP:** the app password was deleted or changed — create a new one and update
  the account.
- **Vault locked** (see above).

**Settings → Diagnostics → Connections & sync** names the reason on the account:
[`invalid_grant`](#invalid_grant), [`interaction_required`](#interaction_required),
[`consent_required`](#consent_required), [`token_rejected`](#token_rejected),
[`no_credentials`](#no_credentials), [`caldav_password_rejected`](#caldav_password_rejected),
[`imap_password_rejected`](#imap_password_rejected), [`credentials_reset`](#credentials_reset) or
[`vault_locked`](#vault_locked); the account's calendars and mail then show
[`account_unavailable`](#account_unavailable).

If you reconnect while signed in to a *different* Google or Microsoft account, Portly adds it as a
new account instead of overwriting the old one ("different account" message).

## Google

| Symptom | Fix |
| --- | --- |
| `Error 400: redirect_uri_mismatch` | The client's **Authorized redirect URIs** must contain exactly `http://localhost:5757/api/oauth/google/callback` (http, localhost, your port, no trailing slash). Copy it from **Settings → Accounts**. Changes can take a few minutes to apply. |
| "Google hasn't verified this app" | Expected for your own app: **Advanced → Go to Portly (unsafe)**. |
| `Error 403: access_denied` / "has not completed the Google verification process" | The app is still in **Testing** and your account isn't a test user — publish it (**Audience → Publish app**). |
| "This app is blocked" | Google blocks unverified apps for some accounts: Google Workspace accounts whose admin restricts third-party apps, and accounts in the Advanced Protection Program. Use a regular personal account, or ask the Workspace admin to trust your client ID. |
| Connected, but no mail or no calendars | You didn't tick every checkbox on the consent screen. Connect again and grant everything. Also check that both APIs are **enabled** in the project. Diagnostics: [`insufficient_scope`](#insufficient_scope) or [`api_disabled`](#api_disabled). |
| Mail widget: "The Gmail API is not enabled in your Google Cloud project" | Calendar works but mail doesn't: the Gmail API was never enabled. In the same project as your OAuth client, open **APIs & Services → Library → Gmail API → Enable**, wait a minute, then click **Retry**. No reconnect needed. Diagnostics: [`api_disabled`](#api_disabled). |
| Calendar: "The Google Calendar API is not enabled for the Google Cloud project of your OAuth client" (on the calendar in **Settings → Calendars**, or on the account as "Calendars could not be loaded: …") | Mail works but the Google calendar never syncs: the Google Calendar API was never enabled. In the same project as your OAuth client, open **APIs & Services → Library → Google Calendar API → Enable**, wait a minute, then click **Sync now** in **Settings → Calendars**. No reconnect needed. Don't wait for the next automatic sync: Portly retries a refused calendar less and less often (up to every 6 hours). Diagnostics: [`api_disabled`](#api_disabled) (on the account: [`calendar_list_failed`](#calendar_list_failed)). |
| Mail widget: "Gmail access was not granted" | The Gmail checkbox was unticked on the consent screen. **Reconnect** the account and allow Gmail access. Diagnostics: [`insufficient_scope`](#insufficient_scope). |
| `invalid_client` | The client secret in Portly doesn't match. Add a new secret to the client and paste it into Portly. Diagnostics: [`client_rejected`](#client_rejected). |
| "deleted_client" / client disappeared | Google deletes OAuth clients unused for 6 months. Create a new client and update Portly. Diagnostics: [`client_rejected`](#client_rejected). |

## Microsoft

| Symptom | Fix |
| --- | --- |
| **New registration** fails / "The ability to create applications outside of a directory has been deprecated" | You are in the *Microsoft Services* tenant. Create your own directory with an Azure free account ([step 1](microsoft.md#1-get-a-directory-azure-free-account)) and switch to it. |
| `AADSTS50011` (redirect URI mismatch) | Register `http://localhost/api/oauth/microsoft/callback` under **Mobile and desktop applications**. |
| `AADSTS9002327` ("…Single-Page Application client-type…") or `AADSTS7000218` (client_secret required) | The redirect URI is registered under **Single-page application** or **Web**. Remove it there and register it under **Mobile and desktop applications** only. Diagnostics: [`client_rejected`](#client_rejected). |
| `AADSTS700016` / "application not found in the directory" or "not configured as a multi-tenant application" | Supported account types must be **Personal accounts only** (Portly signs in via `/consumers`). Check the client ID you pasted. |
| "You can't sign in here with a work or school account" | Portly supports personal Microsoft accounts only. |
| Consent screen missing Mail or Calendar | Add **Calendars.ReadWrite**, **Mail.ReadWrite** and **offline_access** under **API permissions**, then reconnect. Diagnostics: [`insufficient_scope`](#insufficient_scope). |

## Yahoo, CalDAV and IMAP

| Symptom | Fix |
| --- | --- |
| Authentication failed | Use an **app password**, not your normal password, and your full email address as the username (iCloud IMAP: the name part, see [CalDAV & IMAP](caldav-imap.md#icloud-apple)). Diagnostics: [`caldav_password_rejected`](#caldav_password_rejected), [`imap_password_rejected`](#imap_password_rejected) or [`auth_failed`](#auth_failed). |
| Yahoo: no option to create an app password | Yahoo decides eligibility per account (often not for new accounts); see [Yahoo setup](yahoo.md#1-generate-an-app-password). Use the ICS fallback for the calendar. |
| Yahoo account saved as mail-only | CalDAV failed while IMAP worked. Try adding the account again later, or subscribe to the calendar's ICS link. |
| CalDAV: certificate error | Portly always verifies certificates. Use a server with a publicly trusted certificate; `http` works only for private LAN addresses with **Allow http for a server on my local network** ticked. Diagnostics: [`tls`](#tls), [`not_lan`](#not_lan). |
| CalDAV: calendars missing | Try the server's CalDAV root URL instead of the web address (e.g. Nextcloud `https://host/remote.php/dav`). Discovery only follows redirects within the same site. |
| IMAP: no **Archive** action | The server doesn't advertise an Archive folder; archive isn't offered rather than guessed. |
| A mail action says the message changed | The mailbox changed on the server (for example the folder was rebuilt); the list refreshes — try again. |
| ICS calendar shows an error | Open the link in a browser to check it still works (share links can be revoked or reset). Very large or endlessly repeating feeds are cut off at safe limits; the calendar keeps its last good data and shows the error under **Settings → Calendars**. Diagnostics: [`not_found`](#not_found), [`parse_error`](#parse_error), [`too_large`](#too_large), [`blocked`](#blocked) or [`truncated`](#truncated). |

## New-tab extension

| Symptom | Fix |
| --- | --- |
| New tab shows "Portly isn't running", but Portly is running | Check the port in the extension options (**Test connection**), and open `http://localhost:5757/api/health` in a tab. If the browser asks to allow access to devices on your local network, allow it; update Chrome if it is older than version 144. |
| New tab is the normal browser page again | The extension was turned off: **Developer mode** was switched off (Chrome 134+ disables unpacked extensions then), you chose to change the new tab page back, or another extension replaced it. Re-enable it on `chrome://extensions` / `edge://extensions`. |
| Incognito / InPrivate shows the browser's new tab | Browsers never let extensions replace it there. |
| Changes to the extension don't show | Click **Reload** on its card in `chrome://extensions`. |
| The extension vanishes from `chrome://extensions` every time the browser restarts (Load unpacked works until then) | An extension loaded before the ID was fixed is still registered for the same folder, but the browser no longer shows it. At startup the browser loads that folder, gets a different ID than the old entry expects, marks the **folder** as invalid and skips every entry for it, including the good one. Clear the hidden entry: remove the `"key"` line from `extension\manifest.json`, **Load unpacked** (the card now shows the old path-derived ID), **Remove** it, put the `"key"` line back (`git checkout -- extension/manifest.json`), then **Load unpacked** again and restart the browser to check. |
| The extension's ID is not `nbaolbakegefnefgojdokagajincnfjj` | It was loaded before the ID was fixed. **Remove** it and **Load unpacked** again ([Updating from an older version](extension.md#updating-from-an-older-version)); don't rely on Reload for this. |
| Port setting went back to 5757, or new tabs no longer open the page you chose | Removing the extension clears all its settings — what new tabs open, the Pages site address and the port — and new tabs follow Portly on this PC again. Set them again in the options. |
| New tabs open the Pages site instead of `http://localhost:5757` (or the other way round) | By default new tabs follow Portly on this PC: its Pages site when `PORTLY_PAGES_URL` is set, otherwise Portly itself. The options show what they follow; **Test connection** refreshes it. To pin a page, choose it under **New tab opens** ([Switching back](extension.md#switching-back-to-portly-on-this-pc)); to change what Portly reports, run `scripts\setup.ps1 -PagesUrl <address>` (or `-PagesUrl off`). |
| The options refuse the Pages site address | It must start with `https://` (`http://` only for `localhost`, `127.0.0.1` or `[::1]`) and can't contain `?` or `#`. Use the site's home address, for example `https://<user>.github.io/` or `https://<user>.github.io/<repo>/`. |
| New tabs open the Pages site, but it shows this browser's copy instead of Portly's data | The site uses Portly on this PC only once this browser is paired with it and Portly runs. Check the **Portly on this PC** status at the bottom of the dashboard; see [Pages site with Portly on this PC](#pages-site-with-portly-on-this-pc). |

### "Starting Portly…" and the launcher

A new tab shows **Starting Portly…** while it waits for Portly after asking the launcher to
start it. It normally switches to Portly within a few seconds, mentions that it is taking longer
after 10 seconds, and gives up after 30 seconds with the "Portly isn't running" page (and a
**Try starting again** button). The page and the options page's **Test launcher** button say which
case you are in:

| What you see | Cause and fix |
| --- | --- |
| *Let new tabs start Portly* / Test launcher: *isn't installed* | The browser found no registration for `com.portly.launcher` ("Specified native messaging host not found"). Run `scripts\install-autostart.ps1`. If you did, run `status.ps1`: it shows whether the registry key exists for this browser and whether the file it points to (`%LOCALAPPDATA%\Portly\native-host\com.portly.launcher.json`) is still there — deleting `%LOCALAPPDATA%\Portly` also deletes the launcher; re-run the installer. |
| *Install the launcher for this extension* / *doesn't accept this extension's ID* | The launcher allows a different extension ID ("Access to the specified native messaging host is forbidden"). Make sure the extension's ID is `nbaolbakegefnefgojdokagajincnfjj` (see above), then run the installer again — it reads the ID from `extension\manifest.json`. `status.ps1` reports an `allowed_origins` mismatch. |
| The task is missing | The launcher ran but there is no **Portly Server** task (for example it was deleted in Task Scheduler). Run the installer again. |
| Times out after 30 s although the launcher answers | The task started but the server didn't come up. Run `status.ps1 -LogLines 40`: the task's last result, `supervisor.log` and `server.log` say why (port in use, invalid `PORTLY_*` setting, `node.exe` moved by a Node.js upgrade — re-run the installer, missing `web\dist` — `npm run build`). The last line of `launcher.log` shows what the launcher did (`starting`, `running`, or the error). |
| `schtasks_failed` with *Access is denied* | The task was registered so that your user can't run it (for example from a different administrator account). Run `uninstall-autostart.ps1` from an administrator PowerShell, then the installer from a normal PowerShell as yourself. |
| "Native host has exited" / "Failed to start native messaging host" | The launcher could not run — usually `node.exe` is no longer where the installer found it (Node.js upgraded or moved). The extension still keeps checking, in case the task was started anyway. Re-run the installer; `status.ps1` flags a missing `node.exe`. |
| Nothing at all happens on a work PC | Your organization may block per-user native messaging hosts (browser policy `NativeMessagingUserLevelHosts` or `NativeMessagingBlocklist`; see `chrome://policy` or `edge://policy`). Use Logon mode instead: `install-autostart.ps1 -Trigger Logon`. |

## Pages site with Portly on this PC

The Pages site's footer shows the **Portly on this PC** status, with an explanation and the next
step when you click it (also in **Settings → About** on the site). The statuses and their fixes —
*Blocked by browser*, *Not detected*, *Found, not paired*, *Pairing removed*, *Paired with another
Portly*, *Needs update* — are listed in
[Pages site with Portly on this PC](pages-local-server.md#troubleshooting), and
[Finding out why](pages-local-server.md#finding-out-why) shows how to trace a connection problem
with the Diagnostics page and the logs. A few more:

| Symptom | Fix |
| --- | --- |
| Portly's own page says *Pairing is turned off* | The server doesn't know the Pages site's address: set the `PORTLY_PAGES_URL` user environment variable and restart Portly ([steps 1–3](pages-local-server.md#1-tell-portly-your-pages-sites-address)). |
| *invalid configuration* naming `PORTLY_PAGES_URL` | It must be an `https://` address (or `http://` on `localhost`, `127.0.0.1` or `[::1]`) without user name, password, `?` or `#`, and not Portly's own address. Fix or remove the variable, then restart Portly. |
| Settings on the Pages site differ from Portly's own page | The page is using this browser's copy (the status says so). The two copies are kept apart on purpose; export / import moves settings between them. |
| The site's Diagnostics says *Portly runs on this PC but does not accept this site* | Portly answers on the port, but its `PORTLY_PAGES_URL` is not this site's address. Set it to the address the banner shows and restart Portly. |

## Autostart

| Symptom | Fix |
| --- | --- |
| "Access is denied" (0x80070005) while installing/removing | Run the same command from PowerShell opened with **Run as administrator**. The task still runs as you, unelevated, and the launcher is registered for you. |
| "…has no "key" entry" while installing | Your `extension\manifest.json` is from an older Portly. Update the checkout (`git pull`), or install without the launcher: `-Trigger Logon -NoNativeHost`. |
| Portly no longer starts at sign-in | Expected in **Browser** mode (the default since the launcher was added): it starts when Chrome or Edge opens. `status.ps1` shows the mode; to start at sign-in again, run the installer with `-Trigger Logon`. |
| Portly still starts at sign-in in Browser mode | Microsoft Edge's **Startup boost** (`edge://settings/system`) starts Edge in the background at sign-in, which counts as a browser start. Turn it off if you don't want that. `status.ps1` should say *Browser* mode (no trigger); if it says *Logon*, run the installer without `-Trigger Logon`. |
| Portly doesn't start when the browser opens | Check `status.ps1`: the task must be installed and the launcher registered for that browser (**Host (Chrome)** / **Host (Edge)**: OK). Then use **Test launcher** in the extension options and see [Starting Portly… and the launcher](#starting-portly-and-the-launcher). The browser only asks when a profile starts, not for each new window; Chrome's "Continue running background apps" setting can keep the browser (and its profile) running after you close the last window, in which case a new tab does the asking. |
| Task is registered but Portly isn't up (after sign-in in Logon mode, or after the launcher started it) | Run `status.ps1 -LogLines 40`. It shows the task's last result with a short explanation, warns when the task's `node.exe` no longer exists (for example after a Node.js upgrade moved it — re-run the installer), reports an invalid `PORTLY_*` setting (**Configuration: INVALID**, see [invalid configuration](#starting-portly)), and shows the end of `launcher.log`, `supervisor.log` and `server.log`, which say why the server stopped (for example "port already in use"). |
| `supervisor.log`: *server keeps crashing at start-up* | The server stopped five times in a row within a minute of starting. The line's `lastFailure` (the start-up phase and error) and `stderrTail` (the server's last fatal output) say why; see [When the server stops or won't start](autostart.md#when-the-server-stops-or-wont-start). |
| `supervisor.log`: *server cannot start; not restarting* (task result 0x4) | Three start-ups in a row failed for a reason a retry can't fix. Either `web\dist` is missing: run `npm run build`, then `Start-ScheduledTask -TaskName 'Portly Server'`. Or the copy of Homebase's data (`server.log`: `homebase_not_found` or `homebase_copy_failed`) can't be made: run `portly --copy-from-homebase --cancel` to start without it, then `portly --start`. |
| `server.log`: *startup failed* with `homebase_copy_busy` | Homebase's database stayed locked while Portly copied it. Nothing was lost and the copy is tried again at every start; make sure Homebase's server is stopped, then `portly --start`. |
| Portly is up but the task says *Ready* | Something else started Portly (e.g. `npm start`); the task's copy exited because the port was taken (`supervisor.log`: "another Portly is already running; supervisor exiting"). Stop the other copy and run `Start-ScheduledTask -TaskName 'Portly Server'`. |
| The installer warns about a temporary `node.exe` path | You use a Node version manager whose shims live in a per-shell temp folder (e.g. fnm). Pass a permanent path: `-NodePath 'C:\path\to\node.exe'`. |
| `Stop-ScheduledTask` didn't stop Portly | It only ends the hidden console host. Use `uninstall-autostart.ps1`, or re-run the installer to restart it. |

## Weather and your location

The Weather widget asks the browser for your location only when you click **Use my location**
(or switch on *Use this device's location*). After that it shows the place it remembered, for up
to 6 hours, and keeps it current only if the browser lets this site use your location for good.
If the widget says *Show weather for your location*, either click **Use my location**, or allow
location for good: click the icon at the left of the address bar, then **Site settings** →
**Location** → **Allow**. A fixed city, chosen in the widget's settings (for that widget, or as the
default for every Weather widget), never asks at all. Each address counts as its own site, so `localhost:5757` and your Pages site are
allowed separately.

## The background image

When you choose a photo in **Settings → Appearance**, the browser prepares it before it is
saved, because every new tab has to load and draw it:

- A photo bigger than your screen is scaled down so its long side matches your screen (between
  2,560 and 3,840 pixels; a 4K screen gets 3,840) and saved as WebP. A photo that already fits
  is saved unchanged.
- An animated GIF, PNG, WebP or AVIF keeps only its first frame: an animation makes the page
  redraw the whole window many times a second.
- An SVG drawing becomes a picture sized for your screen.

You can choose a file of up to 25 MB; what is saved is much smaller. If you move to a bigger
screen and the background looks soft, choose the photo again on that screen.

A background saved before this shows **Optimize image** under the picture when a lighter copy
would help: an animation, a drawing, or a photo with a long side over 3,840 pixels. The copy
suits every screen up to 4K; it replaces the background and keeps the blur and dim. If the
browser can't open a file at all, Portly says so: save it as a JPEG or PNG and try again.

## Restoring a backup or starting over

- **Restore a backup:** stop Portly (`uninstall-autostart.ps1` or Ctrl+C), copy a file from
  `<data>\backups` over `<data>\portly.db` (keep a copy of the current one), and start Portly
  again. Keep the same `vault.key`, otherwise stored credentials can't be decrypted.
- **Start over completely:** stop Portly and delete the data folder. The next start creates a
  fresh database and vault; you will need to reconnect every account.

## Health codes

**Settings → Diagnostics → Connections & sync** shows a code for every subject that fails or works
only partly, with a one-line fix; each code has a section here. The subject says where it happened:
`account:` (the account itself: its sign-in, credentials and status), `calendar-list:`, `calendar:`,
`ics:`, `mail:`, `todoist`, `feed:`, `weather`, `suggest:`, `sports:` or `job:` (a scheduled job).
**Show related log lines** opens the Server log around the last failure. A code not listed here
comes from a newer Portly or straight from a provider; the message next to it says more.

| Kind | Codes |
| --- | --- |
| Sign-in and accounts | [`reauth_required`](#reauth_required) · [`invalid_grant`](#invalid_grant) · [`interaction_required`](#interaction_required) · [`consent_required`](#consent_required) · [`token_rejected`](#token_rejected) · [`client_rejected`](#client_rejected) · [`refresh_unreachable`](#refresh_unreachable) · [`no_credentials`](#no_credentials) · [`credentials_reset`](#credentials_reset) · [`vault_locked`](#vault_locked) · [`not_configured`](#not_configured) · [`auth_failed`](#auth_failed) · [`caldav_password_rejected`](#caldav_password_rejected) · [`imap_password_rejected`](#imap_password_rejected) · [`account_unavailable`](#account_unavailable) · [`calendar_list_failed`](#calendar_list_failed) |
| The provider refused | [`api_disabled`](#api_disabled) · [`insufficient_scope`](#insufficient_scope) · [`denied`](#denied) · [`not_found`](#not_found) · [`rate_limited`](#rate_limited) · [`http_4xx`](#http_4xx) · [`http_5xx`](#http_5xx) |
| Connection | [`timeout`](#timeout) · [`dns`](#dns) · [`refused`](#refused) · [`reset`](#reset) · [`tls`](#tls) · [`network`](#network) · [`redirect`](#redirect) · [`bad_url`](#bad_url) · [`blocked`](#blocked) · [`not_lan`](#not_lan) |
| The data | [`parse_error`](#parse_error) · [`not_a_feed`](#not_a_feed) · [`too_large`](#too_large) · [`storage_limit`](#storage_limit) · [`truncated`](#truncated) |
| Inside Portly | [`worker_failed`](#worker_failed) · [`internal`](#internal) |

### reauth_required

Portly lost access to the account: it is marked **Reconnect needed** without a more specific
reason, or a check was told the account must be signed in again.

**Fix:** **Reconnect** the account in **Settings → Accounts** (Yahoo, CalDAV and IMAP: add the
account again with its current app password). See [Accounts that need "Reconnect"](#accounts-that-need-reconnect).

### invalid_grant

The sign-in expired or was revoked at the provider: Google's or Microsoft's token endpoint answered
`invalid_grant` when Portly renewed access (`account:`). Google: the app was still in *Testing*
(7 days), the token went unused for 6 months, you changed your password, or you removed Portly's
access. Microsoft: 90 days without use, a password change, or the app's consent was removed.

**Fix:** **Reconnect** the account in **Settings → Accounts**; for Google in *Testing*, publish the
app first ([Google setup](google.md#audience--publish-the-app-important)).

### interaction_required

The provider wants you to sign in again yourself (`interaction_required` or `login_required` from
its token endpoint) — typically Microsoft after a security check, new terms or a change to your
sign-in methods.

**Fix:** **Reconnect** the account in **Settings → Accounts** and finish every step of the sign-in.

### consent_required

The provider needs your consent again (`consent_required`): the permissions Portly asks for
changed, or the consent was withdrawn.

**Fix:** **Reconnect** the account and accept every permission.

### token_rejected

A provider rejected a saved token:

- `todoist` — Todoist answered 401/403 to the saved API token (it was reset or revoked in Todoist).
  Copy the current token in Todoist (**Settings → Integrations → Developer**) and use **Replace
  token** in **Settings → Todoist** ([Todoist](todoist.md#troubleshooting)).
- `account:` — Google or Microsoft rejected an access token Portly had just renewed (the log says
  *provider rejected a freshly refreshed token*). The account is marked **Reconnect needed**:
  **Reconnect** it in **Settings → Accounts**.

### client_rejected

The provider rejected Portly's app registration when renewing access (`invalid_client` or
`unauthorized_client`): the Google client secret is wrong, was replaced or the client was deleted
(Google deletes clients unused for 6 months), or the Microsoft redirect URI is registered under the
wrong platform.

**Fix:** check the client ID (and for Google the secret) in **Settings → Accounts** against the
provider's console ([Google](#google), [Microsoft](#microsoft)), then reconnect the account if it
asks.

### refresh_unreachable

Portly couldn't reach the provider's sign-in server (`oauth2.googleapis.com`,
`login.microsoftonline.com`) to renew access: no internet, a DNS problem, a proxy or firewall. The
account shows an error, not **Reconnect**: the sign-in itself is still valid. The entry's detail
names the network error (`causeCode`, e.g. `ENOTFOUND`).

**Fix:** usually temporary — Portly tries again at the next use. If it lasts, check this PC's
internet connection, VPN and proxy.

### no_credentials

The account has no saved sign-in: its refresh token or app password is missing from the vault.

**Fix:** **Reconnect** the account in **Settings → Accounts** (Yahoo, CalDAV and IMAP: add it again
with its app password).

### credentials_reset

The saved credentials were reset (**Reset credentials** in **Settings → Accounts**, after a
[locked vault](#vault-locked)): every account is marked **Reconnect needed** with this reason.

**Fix:** reconnect each account, re-enter app passwords, the Google client secret and the Todoist
token, and re-add private ICS links.

### vault_locked

Saved credentials can't be unlocked: `vault.key` is missing or unreadable for this Windows user.
Everything that needs a secret is skipped (*saved credentials are locked*) until it is fixed.

**Fix:** see [Vault locked](#vault-locked): put the original `vault.key` back, or **Reset
credentials** in **Settings → Accounts** and reconnect your accounts.

### not_configured

Something Portly needs isn't set up: usually the Google or Microsoft OAuth client (client ID, and
for Google the secret) in **Settings → Accounts**, or an account's CalDAV or IMAP settings. The
account's mail then shows [`account_unavailable`](#account_unavailable); its calendars show this
code themselves.

**Fix:** finish the setup in **Settings → Accounts** ([Google](google.md), [Outlook.com](microsoft.md),
[CalDAV & IMAP](caldav-imap.md)).

### auth_failed

A server refused the user name or password (HTTP 401, or an IMAP login refused).

**Fix:** check the user name and the (app) password — an app password, not your normal password —
then add the account again in **Settings → Accounts**. See [Yahoo, CalDAV and IMAP](#yahoo-caldav-and-imap).

### caldav_password_rejected

The CalDAV server answered 401 to the saved password (Yahoo calendar, iCloud, Fastmail, Nextcloud …).
Portly marks the account **Reconnect needed**.

**Fix:** create a new app password if the old one was deleted, and add the account again in
**Settings → Accounts** with it.

### imap_password_rejected

The mail server refused the saved password at login. The account is marked **Reconnect needed** and
Portly doesn't try that password again (repeated failed logins can lock the mailbox) until you add
the account again or test it.

**Fix:** create a new app password if needed and add the account again in **Settings → Accounts**
with it.

### account_unavailable

A calendar list, calendar or mailbox can't be checked because its account needs attention
(reconnect, locked vault, missing settings). The entry says *because … needs attention* and links
to the account, whose own entry has the real reason; it is logged quietly so the account's line is
the one warning.

**Fix:** fix the account first; its calendars and mail recover at the next sync or refresh.

### calendar_list_failed

The account's list of calendars couldn't be read and the account has no calendars in Portly yet,
so the account itself shows the error (*Calendars could not be loaded: …*).

**Fix:** open the account's `calendar-list:` entry in **Connections & sync**: its code (for example
[`api_disabled`](#api_disabled)) says what failed. Fix that, then **Sync now** in **Settings →
Calendars** (or **Run now**).

### api_disabled

The provider's API is turned off for your app registration — in practice the Gmail API or the
Google Calendar API is not enabled in the Google Cloud project of your OAuth client (Google answers
`accessNotConfigured` / `SERVICE_DISABLED`).

**Fix:** in that project open **APIs & Services → Library**, enable the API, wait a minute, then
**Retry** (mail) or **Sync now** (calendars). No reconnect needed. See [Google](#google).

### insufficient_scope

Portly is missing a permission: a checkbox was unticked on Google's consent screen, or the
Microsoft app registration lacks **Calendars.ReadWrite**, **Mail.ReadWrite** or **offline_access**.

**Fix:** **Reconnect** the account and allow everything it asks for (Microsoft: add the permissions
under **API permissions** first).

### denied

The provider refused access (HTTP 403) for another reason: the calendar or mailbox is no longer
shared with you, a Google Workspace admin restricts third-party apps, or the account is blocked.

**Fix:** check the account and what it may access at the provider, then reconnect it; remove
calendars you no longer have access to.

### not_found

The provider no longer has it (HTTP 404 or 410): the calendar was deleted or unshared, the ICS link
was revoked or reset, the feed moved. Portly retries a refused calendar less and less often (up to
every 6 hours).

**Fix:** remove it from Portly, or add it again with its current address (a new ICS share link,
the feed's new address).

### rate_limited

The provider is limiting requests (HTTP 429, or a mail server refusing more connections). Portly
waits as long as the provider asks — **Next attempt** — and tries again by itself; a calendar
account's other calendars wait too, and Todoist requests pause.

**Fix:** nothing, unless it lasts for hours. Then something else uses the same quota: another app
with the same Google Cloud project or Todoist token.

### http_4xx

The server rejected the request with another 4xx status (400, 405, 409 …), or the provider's
sign-in server refused to renew access for a reason it didn't name.

**Fix:** check the address and the account's settings; reconnect the account if it is a sign-in.

### http_5xx

The provider's server had a problem (HTTP 5xx). Usually temporary: Portly tries again at the next
sync or refresh.

**Fix:** nothing, unless it lasts for hours — then check the provider's status page.

### timeout

The server took too long to answer: no complete answer within Portly's limit (10 s for most
requests, 15 s per step of a mail session), or reading a very large calendar took longer than its
5 s limit.

**Fix:** usually temporary. If it keeps happening, check this PC's internet connection — and for one
calendar or feed, whether it is unusually large or slow.

### dns

The server's name couldn't be found (`ENOTFOUND`, `EAI_AGAIN`): a typo in the address, no internet,
or a DNS, VPN or proxy problem.

**Fix:** check the address (ICS link, feed, CalDAV or IMAP server), then this PC's internet
connection and DNS.

### refused

The server refused the connection (`ECONNREFUSED`): nothing listens at that address and port.

**Fix:** check the address and port (IMAP: 993 for TLS, 143 for STARTTLS), and that the service —
for a server you run yourself — is running and not blocked by a firewall.

### reset

The connection was dropped mid-way (`ECONNRESET`, a closed socket or mail session). Usually
temporary; a VPN, proxy, firewall or antivirus that inspects connections can cause it.

**Fix:** nothing if it passes; otherwise try without the VPN or proxy.

### tls

The secure connection failed: the server's certificate is expired, self-signed or for another name,
this PC's date and time are wrong, or a proxy or antivirus that inspects HTTPS replaced it. Portly
always verifies certificates.

**Fix:** check the address and this PC's date and time; use a server with a publicly trusted
certificate (a CalDAV server on your LAN: plain `http` with **Allow http for a server on my local
network**).

### network

Another network error (`ENETUNREACH`, `EHOSTUNREACH`, offline).

**Fix:** check this PC's internet connection.

### redirect

The server answered with a redirect Portly doesn't follow: more than 5 in a row, one to an address
that isn't `http(s)`, or any redirect from a provider's API (Google, Microsoft, Todoist), which
shouldn't send one.

**Fix:** open the address in a browser and use the address it ends up at. For a provider's API,
try again later; if it persists, a proxy or captive portal on this network may be answering instead.

### bad_url

Portly won't fetch the address: it isn't `http` or `https`, has no host name, or carries a user
name or password (`https://user:pass@…`).

**Fix:** check the address; for a calendar that needs a password, add it as a CalDAV account instead
of putting the password in the link.

### blocked

Portly doesn't fetch ICS links, feeds, icons or page titles from private or reserved addresses
(your router, a NAS, `localhost` …), also when a redirect leads there — so a page can't use Portly
to reach devices on your network. For an ICS link the message names the hop: *<feed host> redirected
to <other host>, a private or reserved address*.

**Fix:** use a public address. A calendar server on your network can be added as a CalDAV account.

### not_lan

A CalDAV account set up with **Allow http for a server on my local network** may only use servers
on your local network: its server name now resolves to a public address, and Portly won't send
the password there in plain text.

**Fix:** check the server address and your local DNS; or switch the server to `https`.

### parse_error

The answer couldn't be read: invalid JSON from a provider, a web page instead of a calendar, an ICS
file or CalDAV answer that isn't valid, a mail server answer Portly doesn't understand.

**Fix:** check that the address points to the right kind of data — an ICS link opened in a browser
downloads text starting with `BEGIN:VCALENDAR`.

### not_a_feed

The address is neither an RSS or Atom feed nor a page that advertises one.

**Fix:** use the feed's own address (often linked as *RSS* on the site).

### too_large

The answer was larger than Portly accepts: an ICS file over 10 MB, a feed over 5 MB, a calendar
with more than 5,000 events or 20,000 occurrences in the sync window, a CalDAV answer over its limit.

**Fix:** use a smaller feed or calendar (for example a calendar of fewer years, or a feed with fewer
items).

### storage_limit

**Degraded:** Portly already stores as many calendar events as it keeps (100,000 events or 64
million characters of text across all calendars), so this calendar's latest listing wasn't stored —
it keeps showing what it had. Nothing is lost at the provider.

**Fix:** remove a very large calendar or ICS subscription you don't need, to make room.

### truncated

**Degraded:** Portly stored only part of a calendar to stay within its limits — repeating events
shortened (at most 1,000 occurrences of one event in the sync window; events repeating every second
or minute show their first occurrence only), malformed events or long descriptions left out.
**Settings → Calendars** shows the warning. Nothing is lost at the provider.

**Fix:** nothing, unless events you need are missing — then simplify them at the source.

### worker_failed

A background worker inside Portly failed: the one that reads ICS and CalDAV calendars (it ran out
of memory or crashed), or the one that runs a mail session (*The mail session with … stopped
unexpectedly*).

**Fix:** try again (**Run now**, **Retry**); look for *calendar worker failed* in the Server log. If
it keeps happening with one calendar, its data trips the worker: download the report and restart
Portly.

### internal

An unexpected error inside Portly, or a failure it couldn't classify (for example a mail server
answering `UNAVAILABLE`).

**Fix:** check the Server log (or `server.log`) for *request failed* or *job failed* around that
time; restart Portly if it keeps happening, and keep the diagnostic report if it doesn't go away.
