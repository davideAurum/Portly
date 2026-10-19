# Pages site with Portly on this PC

Your Portly Pages site (the [browser-only build](static-build.md) published on GitHub Pages) can
use the Portly server running on this PC instead of its own copy of your data. Once this browser
is **paired** with the server, the site shows exactly what `http://localhost:5757` shows — the same
settings, layouts, bookmarks, icons and uploads, Todoist, weather, calendars, mail, feeds and
accounts — and every change goes to the server. When Portly isn't running, the site falls back to
the copy it keeps in this browser. This is called *hybrid mode*.

- **Two separate sets of data, no syncing.** What you change while the site uses Portly on this
  PC is saved on the server; what you change while it uses this browser's copy stays in this
  browser. Neither is copied into the other. (Export / import moves data between them when you want
  to.)
- **One page load, one source.** A page never mixes the two: it decides when it loads, and when
  the right source changes (Portly started or stopped for good, the pairing was removed) it
  reloads itself. If you are busy — a dialog is open, you are editing the layout or typing — it
  waits and shows a banner with **Switch now** instead. A tab in the background waits until you
  switch to it, checks Portly once more and then reloads, so pairing or disconnecting in one tab
  doesn't reload all your other tabs at the same moment.
- **Pairing is once per browser.** The server only answers the Pages site for browsers you have
  paired on Portly's own page, and the site never sends anything to a server it hasn't paired
  with.
- **One page.** Everything is done on the Pages site, account sign-in and OAuth client setup
  included. `http://localhost:5757` forwards to the Pages site; it only stays put to approve a
  pairing, to show its diagnostics (`#/settings/diagnostics`, see
  [Finding out why](#finding-out-why)), or when the Pages site can't be reached (offline), when it
  serves the copy on this PC and says so.

You need: Portly installed and running on this PC ([setup](../SETUP.md), ideally with
[autostart](autostart.md)), a published Pages site ([static-build.md](static-build.md)) and Chrome
or Edge (current versions ask once whether the site may reach apps on this PC; step 6). The
[new-tab extension](extension.md) follows Portly on this PC by default, so once steps 1 and 2
are done new tabs open the Pages site.

## 1. Tell Portly your Pages site's address

The server only trusts the one site you name in the user environment variable
`PORTLY_PAGES_URL`. Set it to the address of your Pages site's home page. The simplest way is
setup, which also restarts Portly, so step 2 is done too (from PowerShell in your Portly
folder):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -PagesUrl https://<user>.github.io/
```

Or set the variable yourself, then do step 2:

```powershell
[Environment]::SetEnvironmentVariable('PORTLY_PAGES_URL', 'https://<user>.github.io/', 'User')
```

For a project site use its folder, for example `https://<user>.github.io/portly-pages/`. The
rules:

- `https://` is required. `http://` is accepted only for a site served on this PC (`localhost`,
  `127.0.0.1` or `[::1]`, for example `http://localhost:5173/` from `npm run preview:static`), and
  the server then logs a warning naming that origin.
- No user name or password, `?` or `#`; a missing `/` at the end is added.
- It can't be Portly's own address (`http://localhost:5757` and friends).

An invalid value stops the server with *invalid configuration* — see
[Troubleshooting](troubleshooting.md#starting-portly). Leaving the variable unset (or empty) turns
hybrid mode off: the server then behaves exactly as before and refuses every request from the Pages
site.

## 2. Restart Portly so it reads the variable

Environment variables are read when Portly starts. With [autostart](autostart.md), run the
installer again from PowerShell in your Portly folder (it restarts the task with your current
user environment):

```powershell
cd $env:USERPROFILE\Coding\Portly   # your Portly folder
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

Add `-Trigger Logon` if that is the mode you use: the installer replaces the task, and its default
is Browser mode. Run it from the Portly folder you use every day — the task runs Portly from
the folder the script is in. (In a window opened before step 1 the installer warns that
`PORTLY_PAGES_URL` is not set in that window; the task gets it anyway.)

Instead of the installer you can sign out of Windows and back in. If you start Portly yourself
(`scripts\start.ps1`, `npm start`), stop it, open a **new** PowerShell window (old windows don't
see the new variable) and start it again.

## 3. Check it on Portly's own page

Open `http://localhost:5757`, then **Settings → About**. The **Paired browsers** card shows
*Pages site* with your address. If it says pairing is turned off instead, the server didn't get
the variable: check the spelling, and that you restarted it as above. To check by hand:

```powershell
cd $env:USERPROFILE\Coding\Portly   # your Portly folder
[Environment]::GetEnvironmentVariable('PORTLY_PAGES_URL', 'User')   # the value the autostart task gets
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -DryRun
```

The dry run changes nothing. It checks the task's `PORTLY_*` values the way the server does
(**Configuration**) and warns when one differs from the value in your PowerShell window.

## 4. Build and publish the Pages site

Hybrid mode is built into the Pages site by default; publish it as usual
([static-build.md](static-build.md#publish-to-github-pages)), from PowerShell in your Portly
folder. For a user site such as `https://<user>.github.io/` (step 1), published from the
clone of the `<user>.github.io` repository next to the Portly folder:

```powershell
cd $env:USERPROFILE\Coding\Portly   # your Portly folder
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-static.ps1 -PublicRepoPath ..\<user>.github.io -Base /
```

For a project site such as `https://<user>.github.io/portly-pages/`, use
`-PublicRepoPath ..\portly-pages -Base /portly-pages/`. `-Base` is the path part of
`PORTLY_PAGES_URL`: `/` only for a `<user>.github.io` repository or a custom domain, `/<repo>/`
for any other repository. The script refuses a `-Base` that doesn't match the GitHub repository it
publishes to.

The site looks for Portly at `http://127.0.0.1:5757`. If your Portly uses another port, set
`PORTLY_STATIC_SERVER` in the same window before publishing (for example
`$env:PORTLY_STATIC_SERVER = 'http://127.0.0.1:5800'`); `off` builds a site without hybrid mode.
Only addresses on this PC are accepted — see
[static-build.md](static-build.md#hybrid-mode-portly-on-this-pc).

## 5. Point the extension at the site

After updating Portly, click **Reload** on Portly New Tab in `chrome://extensions` /
`edge://extensions`. In its options, **New tab opens** should be *Whatever Portly on this PC is
set up for* (the default since 0.5.0: it opens the address from step 1 and shows it), or *The
Pages site* with **Pages site address** empty or the same address as `PORTLY_PAGES_URL`
([What new tabs open](extension.md#what-new-tabs-open)).

## 6. Look for Portly and pair this browser

On the Pages site, the footer at the bottom of the dashboard ends with the **Portly on this PC**
status (also in **Settings → About** as a card). Click it:

1. **Look for Portly on this PC.** The browser asks whether the site may access apps or devices on
   this PC (*Local network access*; *Apps on device* in some versions). Choose **Allow**. The status
   becomes **Found, not paired**.
2. **Pair this browser.** The tab goes to Portly's own page, which asks *Allow this site to use
   Portly on this PC?* and names the site's origin (for example `https://<user>.github.io`).
   Check that it is your site, wait a moment until **Approve** is enabled (it arms after the page
   has had your attention for a second) and click it.
3. The tab returns to the Pages site, says *This browser is now paired with Portly on this PC*,
   and the status reads **Connected · v0.1.0**. The dashboard now shows Portly's data.

Do this once in each browser (and browser profile) you use. Approve only requests you started
yourself: a pairing request you didn't ask for may come from someone else's page — click
**Cancel**.

## Everyday use

The status in the footer says where the page's data comes from:

| Status | Meaning |
| --- | --- |
| **Connected · v…** | The page uses Portly on this PC. |
| **Reconnecting…** | Portly stopped answering. The page keeps showing the last saved data and keeps trying; after about 45 seconds without an answer it reloads with this browser's copy (*Portly on this PC isn't reachable — using this browser's copy*). |
| **Browser only** | Portly isn't running (or not on the port the site was built for); the panel it opens says *Not detected*. The page uses this browser's copy; in a paired browser it switches by itself once Portly answers (*Connected to Portly on this PC*). An unpaired browser looks again when you come back to the tab, at most every 5 minutes, or at once with **Check again**. |
| **Not checked** | The site hasn't looked yet (not paired, and the browser hasn't granted the permission). Use **Look for Portly on this PC**. |
| **Waiting for permission** | The browser's permission prompt is open: answer it. A background tab can't show it — switch to the tab. |
| **Blocked by browser** | You (or a policy) denied the permission. See [Troubleshooting](#troubleshooting). |
| **Found, not paired** | Portly runs, but this browser isn't paired: **Pair this browser**. |
| **Pairing removed** | The pairing was revoked on Portly's own page (or the server forgot it). Pair again. |
| **Paired with another Portly** | A different Portly answers than the one this browser paired with — for example after deleting the data folder. Pair again. |
| **Needs update** | The site and Portly are versions that can't work together. Update Portly (`git pull`, restart it) and publish the site again, so both are current. |

While the page uses Portly on this PC:

- **Settings → Accounts** works as on Portly's own page: connect Google and Outlook.com (the
  sign-in returns through `http://localhost:5757`, which forwards back to the site), add Yahoo,
  CalDAV and IMAP accounts, set up the OAuth clients and reset the credential vault.
- **Settings → About** shows the site's version and Portly's and the paired browsers, but not the
  data folder or log path — Portly doesn't tell the site where its files are.
- **Settings → Diagnostics** shows everything Portly's own page shows (again without the data
  folder and log path): see [Finding out why](#finding-out-why).
- The site's in-browser backups of imports don't exist there; Portly keeps its own
  (`<data>\backups`).

## Disconnect or revoke

- **From the site:** **Settings → About → Portly on this PC → Disconnect this browser** (or the
  same button in the footer status). The browser forgets the pairing, tells Portly to forget it
  too, removes the copy of Portly's data it kept for quick start-up, and reloads with this
  browser's copy.
- **Paired browsers:** **Settings → About → Paired browsers** (on the site while it uses Portly,
  or on Portly's own page when offline) lists every paired browser
  (named after the browser and system, for example *Chrome on Windows*) with when it was paired and
  last used. **Revoke** removes one; that browser's site notices at its next request and falls back
  to its own copy. A pairing marked **Old address** was made for a Pages address you no longer use
  (after changing `PORTLY_PAGES_URL`): it no longer works — revoke it.

Pairings that were never used are removed after a day, and Portly keeps at most 20 (pairing
another browser then removes the least recently used one).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Blocked by browser** | Open the site's settings (the icon to the left of the address) and set **Local network access** (**Apps on device** in some versions) to **Allow**, then **Check again**. On a managed PC a policy may block it (`chrome://policy`, `edge://policy`). |
| **Browser only**, but Portly runs | Without `PORTLY_PAGES_URL` (or with another site's address) Portly doesn't answer the site at all: check steps 1–3 — the site's **Settings → Diagnostics** then says *Portly runs on this PC but does not accept this site* ([Finding out why](#finding-out-why)). Check `http://localhost:5757/api/health` in a tab. If Portly uses another port, rebuild and publish the site with `PORTLY_STATIC_SERVER` set to it (step 4). Inside a frame the site never looks for Portly. |
| **Found, not paired** right after approving | The return trip didn't complete in this tab (the pairing answer works once, in the tab that asked). Choose **Pair this browser** again. If Portly's own page shows *Pairing is turned off*, do steps 1–3. |
| Portly's page says *This pairing link doesn't work* | The link was incomplete or changed. Start again from the site with **Pair this browser**. |
| Approving shows *Portly answered with an unexpected address* | `PORTLY_PAGES_URL` doesn't match the address the server reports; check steps 1–3. |
| **Paired with another Portly** / **Pairing removed** | Pair again. For **Pairing removed**, Portly's log says how the pairing went (`token_revoked` with `removedBy`; see [Finding out why](#finding-out-why)). |
| Something else is wrong and the site can't tell | Open `http://127.0.0.1:5757/#/settings/diagnostics` (or **Open diagnostics on this PC** in the site's Diagnostics, shown once Portly answers): Portly's own diagnostics, which work whatever state the site is in. |
| **Needs update** | Update Portly and publish the site again. |
| The site switches between its two copies again and again | Portly starts and stops repeatedly; see `scripts\status.ps1 -LogLines 40`. |
| A banner says the page *switches … when you're done* | A switch waits because a dialog is open, you are editing the layout or typing. Finish, or click **Switch now**. |

## Finding out why

**Settings → Diagnostics** on the site shows what is going on (all of it is explained in
[Diagnostics page and logs](troubleshooting.md#diagnostics-page-and-logs)):

- While the site uses Portly on this PC, it shows everything Portly's own page shows.
- While it uses this browser's copy, it shows the **Overview** — the site's version, the **Portly
  on this PC** status, the browser's local network permission, this browser's warnings — and **This
  browser**. Once Portly answers on this PC, **Open diagnostics on this PC** opens
  `http://127.0.0.1:5757/#/settings/diagnostics`: Portly's own page never forwards that address to
  the site, so it works even when the site can't use Portly or isn't paired. While nothing answers,
  the link isn't shown (it would only open an error page).

**What the site noticed.** **This browser** lists the connection's events: each status change
(*hybrid status changed*, from → to, with the reason), probe results (time taken, HTTP status,
timeout, permission), a failed pairing check, *pairing revoked by Portly on this PC*, the
45-second reconnect grace starting and ending, and every switch between Portly's data and this
browser's copy (requested, deferred while the tab was in the background or you were busy,
performed). They stay in this browser for 7 days, survive the reload a switch causes, and are sent
to Portly while a tab that uses it is in front: its **Server log** shows them (source *Browsers*,
or **Timeline**) next to its own lines.

**Portly runs on this PC but does not accept this site.** When the site can't reach Portly
although the browser allows it, it asks once more without CORS. If something answers, Portly runs
but doesn't answer this site: its `PORTLY_PAGES_URL` is unset or another address (rarely, another
program uses the port). The footer keeps saying **Browser only**; the site's Diagnostics shows a
banner with the exact value to set (`PORTLY_PAGES_URL=<this site's address>`, with the path of a
project site). Set it (step 1) and restart Portly (step 2). Portly notices too: its log has
`health check from another site (no CORS answer)` (other requests: `request from a site that is not
the configured Pages site`) with the site's `origin` and the configured `pagesOrigin`, and its own
Diagnostics overview says *A page at <origin> tried to use this server, but PORTLY_PAGES_URL is not
set* (or *is set to …*). It names only GitHub Pages sites, sites on this PC and sites under your Pages
site's domain; any other site is only counted, never recorded.

**What Portly refused.** Each refusal is one `request refused by gate` line with a `reason` (never
the token itself; the same refusal again within half an hour is only counted):

| `reason` | Meaning |
| --- | --- |
| `token_missing` | The request carried no pairing token. |
| `token_malformed` | The token isn't in the form Portly issues (damaged storage). Pair again. |
| `token_unknown` | This Portly never issued that token, or forgot it long ago. Pair again. |
| `token_revoked` | The pairing was removed on this PC; `removedBy` says how: `revoked` (**Revoke** under **Paired browsers**), `unpaired-itself` (**Disconnect this browser**), `evicted` (pairing a 21st browser made room), `unused` (not used within a day of pairing). Pair again. |
| `token_origin_mismatch` | The pairing was made for another Pages address (**Old address**): `PORTLY_PAGES_URL` changed since. Pair again and revoke the old one. |
| `local_only` | Only Portly's own page may do that (approve a pairing), or Portly is older than the site and doesn't know the request. |
| `x_portly_missing`, `cross_site`, `content_type`, `preflight_refused` | The request doesn't look like the site's own requests — some other page may be trying Portly. |

The site's own requests are logged with `from: pages` and their `pairingId`; with Verbose logging
every one of them, otherwise refusals, changes and failures. To list the refusals and the foreign
sites in `server.log`:

```powershell
Get-Content "$env:LOCALAPPDATA\Portly\logs\server.log" -Tail 5000 | Where-Object { $_.StartsWith('{') } | ConvertFrom-Json |
  Where-Object { $_.msg -eq 'request refused by gate' -or $_.msg -like '*from another site*' -or $_.msg -like '*not the configured Pages site' } |
  Format-Table t, msg, reason, origin, pairingId, removedBy -AutoSize
```

**One request, both sides.** Every answer from Portly carries an `X-Request-Id` header, which the
site can read: a failed request's event in **This browser** keeps it as `rid`, and every line
Portly logged for that request has the same `rid` — click its chip in **Server log**, or search
the files ([Reading the log files](troubleshooting.md#reading-the-log-files)). Events of requests
Portly answered aren't uploaded (Portly logged those itself); requests that got no answer, and
the connection events above, are.

## Security: one site, every page on it

Browsers trust per **origin** (scheme + host), not per page. `https://<user>.github.io` is one
origin for **every** GitHub Pages site of that account — the Portly site, `/homebase-site/` and
any other project you publish there. In a paired browser, any script running on any page of that
origin can read the pairing and use Portly on this PC just like the Portly site can:

- read and change your dashboards, settings, bookmarks and uploads, your Todoist tasks, calendars
  and mail; connect and remove accounts, set the OAuth clients, reset the vault, and list or revoke
  paired browsers (everything is done on the site: there is one page);
- read Portly's diagnostics — the health of every account and calendar, its log and the
  diagnostic report: never secrets, contents or full addresses, but account names, calendar names
  and hosts;
- but not approve a new pairing (only on Portly's own page), read back a stored secret, or learn
  the data folder's path.

It also gets the browser's local-network permission for that origin. So:

- Keep third-party scripts (analytics, embeds, widgets from other sites) off every page of that
  origin, and don't publish other projects there that you don't fully trust.
- The real fix is a **custom domain** (or a separate GitHub account) used for the Portly site
  only. After moving the site, set `PORTLY_PAGES_URL` and the extension's Pages site address to
  the new address, restart Portly, pair again, and revoke the old pairings (they show **Old
  address**).
- While paired, the site keeps a copy of Portly's data in the browser's storage for that origin
  so a new tab paints instantly (for up to 7 days; account lists and OAuth client settings are never
  stored, mail never). **Disconnect** removes it.

Portly itself also treats everything the Pages site sends like any other request: the token is
checked on every request, it is only valid for the configured origin, and the server answers only
that origin with CORS headers. The server's instance id that the site checks is a guard against
talking to the wrong Portly, not a password.

## For developers

To try hybrid mode without publishing: build and preview the site locally, and point a second,
normal (not `PORTLY_DEV`) server at it — on another port and with its own data folder, so the
autostarted Portly and its data are left alone (a second `npm start` on port 5757 just exits
with *port already in use*). The preview keeps running, so use two PowerShell windows.

Window 1, the site, built to look for Portly on port 5800:

```powershell
cd $env:USERPROFILE\Coding\Portly   # your Portly folder
$env:PORTLY_STATIC_SERVER = 'http://127.0.0.1:5800'
npm run build:static
npm run preview:static                     # http://localhost:5173 — leave it running
```

Window 2, the test server (the `$env:` values apply to this window only):

```powershell
cd $env:USERPROFILE\Coding\Portly   # your Portly folder
$env:PORTLY_PORT = '5800'
$env:PORTLY_DATA_DIR = "$env:TEMP\portly-hybrid-test"
$env:PORTLY_PAGES_URL = 'http://localhost:5173/'
npm start                                  # logs a warning: plain http is trusted for that origin
```

Open `http://localhost:5173` and pair as in step 6 (a page served from `localhost` gets no
permission prompt). `npm start` serves `web\dist`: run `npm run build` first if it is missing.
When you are done, stop both with Ctrl+C and delete the test data folder. Don't publish from
window 1: the site would be built for port 5800.

How it works — the boot decision, the controller's states, the reload policy and what is stored
where — is in [ARCHITECTURE §16](../ARCHITECTURE.md#16-hybrid-mode-pages-site--portly-on-this-pc).
