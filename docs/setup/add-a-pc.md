# Adding a PC

A checklist for putting Portly on another of your Windows PCs. Each PC gets its own Portly: its
own server, data and vault. To use one Portly from several PCs instead, see
[Using Portly from your other PCs](other-pcs.md).

Work down the list in order and tick each step; a step that doesn't go as described is worth a
note, so this page can be corrected.

## Before you start

- **Coming from another Portly PC?** Export your set-up there first: **Settings → Import &
  export** → **Export**, and bring the `.json` file over. Accounts never travel in it; you
  connect them again on this PC ([what the file carries](../SETUP.md#your-data)).

## 1. Install Portly

Pick one:

- **From a release**: in PowerShell,
  `irm https://davideaurum.github.io/install.ps1 | iex`. Add a Pages site with
  `& ([scriptblock]::Create((irm https://davideaurum.github.io/install.ps1))) -PagesUrl https://<user>.github.io/`.
  [Install](../SETUP.md#install).
- **From the source code**: `irm https://davideaurum.github.io/setup.ps1 | iex` installs Git and
  Node.js 24 when missing, clones into `%USERPROFILE%\Coding\Portly`, builds, and turns on
  autostart and the `portly` command. Options go in the same way as above, for example
  `-PagesUrl https://<user>.github.io/`; add `-DryRun` first to see the plan.
  [One-command setup](../SETUP.md#one-command-setup-on-a-new-pc).

The script ends by opening the browser's extensions page.

## 2. Check the server

Open a **new** terminal (so it finds the `portly` command) and run:

```powershell
portly --status
```

Expect Portly healthy, the **Portly Server** task present and the launcher registered.

## 3. Load the new-tab extension

In `chrome://extensions` (or `edge://extensions`), with **Developer mode** on:

1. **Load unpacked** Portly's `extension` folder: `%LOCALAPPDATA%\Programs\Portly\app\extension`
   after a release install, `%USERPROFILE%\Coding\Portly\extension` after `setup.ps1` (the
   installer puts the path on the clipboard).
2. Open the extension's options and click **Test launcher**: *The launcher is installed and
   answering*.

This is the one step no script can do. Repeat it in every browser on the PC you use. Details:
[New-tab extension](extension.md).

## 4. Open a new tab

Chrome asks whether to keep the new tab page: **Keep it** (Edge: **Keep changes**). The tab opens
Portly, or your Pages site when you gave `-PagesUrl`.

With a Pages site, pair the browser once: click the **Portly on this PC** status in the footer,
**Look for Portly on this PC**, **Allow**, **Pair this browser**, then **Approve** on Portly's
own page ([step 6 of the Pages guide](pages-local-server.md#6-look-for-portly-and-pair-this-browser)).
GitHub Pages can serve an older copy of the site for up to 10 minutes after a publish: if the
footer shows an older version than `portly --status`, hard-refresh (Ctrl+F5) and wait.

## 5. Check the accounts and the data

- **Settings → About**: the vault reads *Unlocked and ready*, and with a Pages site the browser is
  listed under the paired browsers.
- **Settings → Accounts**: connect your accounts ([Connect your accounts](../SETUP.md#connect-your-accounts)).
  The Google and Microsoft app registrations you made for your first PC work here too: when a tile
  asks for one, enter the same client ID (and Google's client secret) instead of registering again,
  since the redirect address `http://localhost:5757/...` is the same on every PC.
- If you brought an export file: **Settings → Import & export** → **Import**, check the summary,
  then confirm.
- **Settings → Diagnostics**: every subject green after the first sync (a few minutes).

## 6. When it all works

- Keep the PC up to date with `portly --update`.
