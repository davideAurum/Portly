# Using Portly from your other PCs

Portly runs on one PC, the **main PC**, and listens only on that PC (`localhost`). Your other PCs
can use it too, through an encrypted reverse proxy on the main PC, after you approve each of them
once. Nothing opens a port on your network, and nothing goes through a cloud.

## How it works

1. A reverse proxy on the main PC gives Portly an HTTPS address that only your own devices can
   reach. Tailscale Serve is the documented proxy: every device signed in to your tailnet can
   open the address, with a real certificate and no firewall change.
2. Portly listens on a second loopback port for that proxy (the main port plus one, so `5758` by
   default). Whatever arrives there is treated as another PC's request, whatever its headers say.
3. The other PC opens your Pages site (the same address as on the main PC, such as
   `https://<user>.github.io/`), chooses **Use Portly on another PC** and types the main PC's
   Tailscale address once. Or it opens that Tailscale address directly. Either way it sees
   **Connect this PC to Portly**: it gives itself a name and shows a short code. On the main PC,
   Settings → Devices lists the request with the same code. You compare the two and choose
   **Approve**. The other PC's page connects by itself.
4. From then on the other PC uses Portly like the main one. Its login lasts 30 days of inactivity
   and renews while in use (a cookie on the Tailscale address; on the Pages site, a secret this
   browser keeps for the site). **Remove** in Settings → Devices on the main PC cuts it off at once.

What stays on the main PC: signing in to Google and Microsoft accounts (their sign-in comes back
to the main PC), resetting the credential vault, importing the main PC's browser bookmarks,
approving other PCs and paired browsers, the OAuth client settings and the diagnostics report.
Accounts connected on the main PC work from every PC, because the server keeps the tokens.

## Setting it up on the main PC

1. Install Tailscale on the main PC and on each other PC, signed in to the same tailnet.
2. On the main PC, point Tailscale Serve at Portly's port for other PCs:

   ```powershell
   tailscale serve --bg 5758
   ```

   Tailscale prints the address, like `https://<pc>.<tailnet>.ts.net`. **Never use Tailscale
   Funnel**: it would put Portly on the public internet, where the approval screen would be the
   only thing between strangers and your mail and calendar.
3. Tell Portly that address. From your Portly folder:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -RemoteOrigin https://<pc>.<tailnet>.ts.net
   ```

   Setup saves it as the user environment variable `PORTLY_REMOTE_ORIGIN` (the address only, no
   path) and replaces Portly's scheduled task so it starts with it. Add `-Trigger Logon` if you use
   Logon mode; otherwise the task is registered in Browser mode. Setting the variable by hand and
   re-running `scripts\install-autostart.ps1` (same `-Trigger` note), or signing out of Windows and
   back in, does the same. `PORTLY_REMOTE_PORT` is only needed when `5758` is taken.

   In a release install (no checkout: Portly in `%LOCALAPPDATA%\Programs\Portly`) there is no
   `setup.ps1`: set the variable by hand and re-run `app\scripts\install-autostart.ps1` from that
   folder, or sign out of Windows and back in.
4. Open Portly on the main PC: Settings → Devices shows the address for other PCs. So does
   `portly --settings` ("Other PCs", with the remote port the proxy must forward to).

`setup.ps1 -RemoteOrigin off` turns it off again (it removes `PORTLY_REMOTE_ORIGIN` and
`PORTLY_REMOTE_PORT`): Portly listens on this PC only, and PCs connected before are refused.

Without `PORTLY_REMOTE_ORIGIN`, Portly behaves exactly as before: one PC, loopback only.

## Connecting another PC

There are two ways in, and both reach the same Portly on the main PC.

**Through your Pages site (one address on every PC).** Needs a Pages site set on the main PC
(`PORTLY_PAGES_URL`, see [Pages site with Portly on this PC](pages-local-server.md)), so that its
Portly accepts the site.

1. On the other PC, open your Pages site, the same address you use on the main PC (for example
   `https://<user>.github.io/`). With nothing of Portly on this PC, its footer says **Browser
   only**.
2. Click that status in the footer and choose **Use Portly on another PC** (or open
   `https://<user>.github.io/#/connect`). Type the main PC's Tailscale address, such as
   `https://<pc>.<tailnet>.ts.net` (Settings → Devices on the main PC shows it), and choose
   **Continue**. If the browser asks whether the site may reach devices on your network, choose
   **Allow**. The browser remembers the address for next time.
3. Give the PC a name and choose **Ask to connect**, then approve it on the main PC (steps 3 and 4
   below). The page then reloads and uses the main PC's Portly.

**Through the Tailscale address itself.**

1. On the other PC, open the address in the browser. The connect screen appears.
2. Give the PC a name and choose **Ask to connect**. The screen shows a code such as `K7Q-4MP`.
   With Tailscale Serve the name is filled in for you (the PC's computer name, which Tailscale on
   the main PC knows); change it if you like.
3. On the main PC, open Settings → Devices on Portly's own page
   (`http://localhost:5757/#/settings/devices`; it stays there even when Portly forwards to a
   Pages site, which may not approve other PCs and links to it instead), check that the request
   shows the same name and code, and choose **Approve**. Choose **Deny** for a request you did
   not make.
4. The other PC's page loads Portly by itself. A request not answered within 10 minutes expires;
   ask again.

Each browser (and browser profile) is approved on its own, and a browser that comes in both ways
is two devices in Settings → Devices.

If the other PC's page shows **This address reaches Portly the wrong way** (or the Pages site says
Portly took the request as the main PC's own), the proxy forwards to Portly's main port instead
of its port for other PCs: run the `tailscale serve` command above with the right port.

If the Pages site says **Nothing at that address answered this site**, check that Tailscale runs
on this PC, that Portly runs on the main PC with your Pages site as its `PORTLY_PAGES_URL`, and
that the browser may reach devices on your network (the site's settings, next to the address
bar: **Local network access**, **Allow**). Only Tailscale addresses (`*.ts.net`) work from the
Pages site; another reverse proxy works through its own address only.

## A PC that ran Homebase

Homebase is Portly's old name. A PC that runs Homebase today can use the main PC's Portly
instead, with nothing of Portly installed on it: keep Homebase's data, remove Homebase, then
connect the browser. Set up the main PC first (above), and work down these steps in order on the
PC that ran Homebase.

### 1. Keep Homebase's data

1. Open a new tab, so that Homebase New Tab starts Homebase, then open Homebase's own page at
   `http://localhost:5757/#/settings/diagnostics` (or the port you gave Homebase). Homebase may
   forward its other pages to a Pages site, but never that one. Choose **Import & export**, then
   **Download export**, and keep the `homebase-export-<date>.json` file somewhere this clean-up
   does not reach, such as the main PC.
2. If that PC's launch pad has bookmarks the main PC lacks, also choose **Bookmarks** →
   **Export bookmarks** there, and keep that HTML file too.

The main PC's Portly already holds your accounts, and they work from every PC. Neither file
carries accounts, passwords or calendar subscriptions. Bring over only what is missing, on the
main PC, and only after a backup:

- **The backup first:** Settings → Import & export → **Download export** on the main PC.
  Importing that file puts the main PC's set-up back.
- **Bookmarks:** Settings → Bookmarks, *Put imported bookmarks into* **One group per folder**,
  **Choose file…** with the HTML file, then **Import file**. This only adds: a group with the same
  name is reused, and an address already in it is skipped. Icons and group colors are not in that
  file.
- **The export file does not merge.** Importing it (Settings → Import & export → **Choose export
  file…**) replaces the main PC's settings, profiles and widgets, its whole launch pad (every
  bookmark group and bookmark), background images and custom icons with that PC's, on every PC
  that uses the main PC's Portly. Accounts are not affected, and Portly copies its database to
  `backups\` first. Import it only if that PC's set-up should replace the main PC's.
- **An account or calendar that only that PC's Homebase had:** set it up again on the main PC.

### 2. Stop Homebase and remove what it registered

These are the steps Portly's installer takes on a PC that ran Homebase, as commands that need no
Portly. Open PowerShell, signed in as the Windows user that ran Homebase, and type them one at a
time:

1. Show the Homebase checkout that Homebase's task runs, and note the folder it prints (like
   `C:\Users\you\Coding\Homebase`; part 6 deletes it):

   ```powershell
   (Get-ScheduledTask -TaskName 'Homebase Server' -TaskPath '\').Actions[0].WorkingDirectory
   ```

   If it says no such task was found, the task is already gone: skip to the `Remove-Item`
   commands below.
2. Save the task's definition to a file, so it can be restored:

   ```powershell
   Export-ScheduledTask -TaskName 'Homebase Server' -TaskPath '\' | Out-File -Encoding Unicode "$env:USERPROFILE\homebase-task-backup.xml"
   ```

3. Remove the task, so that nothing starts Homebase again:

   ```powershell
   Unregister-ScheduledTask -TaskName 'Homebase Server' -TaskPath '\' -Confirm:$false
   ```

   To bring it back while the checkout still exists:

   ```powershell
   Register-ScheduledTask -TaskName 'Homebase Server' -Xml (Get-Content -Raw "$env:USERPROFILE\homebase-task-backup.xml")
   ```

4. Remove Homebase's launcher (`com.homebase.launcher`, which Homebase New Tab asked to start the
   task) from Chrome, then from Edge. An error that the path does not exist means that browser
   had none:

   ```powershell
   Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.homebase.launcher' -Recurse
   ```

   ```powershell
   Remove-Item 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.homebase.launcher' -Recurse
   ```

5. Stop Homebase's supervisor, the `node.exe` that runs the checkout's
   `server\src\supervisor.ts`. The server it started stops with it:

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*\server\src\supervisor.ts*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```

6. Check that nothing listens on Homebase's port any more (`5757`; if you set `HOMEBASE_PORT`,
   put that port in the command instead). No output means it is free:

   ```powershell
   Get-NetTCPConnection -LocalPort 5757 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess
   ```

   If it lists a line, stop that process with `Stop-Process -Id <id> -Force`, where `<id>` is the
   number under `OwningProcess`, and check again.

### 3. Remove the Homebase New Tab extension

In each browser on that PC (and each browser profile you use), open `chrome://extensions` or
`edge://extensions` and choose **Remove** on *Homebase New Tab*. New tabs then show the
browser's own page.

### 4. Connect the browser to the main PC's Portly

Install Tailscale on that PC, signed in to the same tailnet as the main PC
([Setting it up on the main PC](#setting-it-up-on-the-main-pc), step 1). Then follow
[Connecting another PC](#connecting-another-pc) in each browser (and browser profile) you use
there: the login cookie belongs to one of them, so each one asks and is approved on its own.

### 5. What a new tab shows now

Portly's New Tab extension is not made for this yet: it checks and starts Portly on its own PC
(`http://localhost`), and that PC runs none. So new tabs keep the browser's own page. To reach
Portly in one click instead, use your Pages site once it is connected (or the Tailscale address,
`https://<pc>.<tailnet>.ts.net`):

- as the page the browser opens when it starts: in Chrome, Settings → **On startup** → **Open a
  specific page or set of pages**; in Edge, Settings → **Start, home, and new tabs** → **When Edge
  starts** → **Open these pages**;
- as the Home button's page: in Chrome, Settings → **Appearance** → **Show home button**; in
  Edge, Settings → **Start, home, and new tabs** → **Home button**;
- in a pinned tab (right-click the tab and pin it), or as a bookmark.

### 6. When it all works

- Delete `%LOCALAPPDATA%\Homebase`: Homebase's database and credential vault (gone for good; the
  export file is what you keep), its launcher's files and its `homebase` command. If you had set
  `HOMEBASE_DATA_DIR`, delete the folder it names too.
- Delete the Homebase checkout (the folder that part 2, step 1 showed) and
  `homebase-task-backup.xml` in your user folder: the saved task only starts that checkout, so it
  is of no use once the checkout is gone.
- Remove Homebase's settings from your user environment: run
  `rundll32 sysdm.cpl,EditEnvironmentVariables`, and under *User variables* delete the variables
  whose names start with `HOMEBASE_` and, in **Path**, the entry that ends in `\Homebase\bin`.

A browser on that PC that opens your Pages site uses it on its own there until you connect it to
the main PC (**Use Portly on another PC**, above). On its first visit it copies the Homebase data
it kept for that site to Portly's names once
([Browsers keep their Homebase data](add-a-pc.md#browsers-keep-their-homebase-data)); that copy
stays in the browser, apart from the main PC's data.

## Using Portly on a phone or tablet

An Android phone or tablet (or any other device with a current browser) connects the same way as
another PC: nothing in the connect screen, the code or the login cookie is specific to Windows.
This has not been tried on a phone yet; the real check used a second Windows PC.

1. Set up the main PC as above.
2. Install the Tailscale app on the phone and sign in to the same tailnet.
3. In Chrome on the phone, open `https://<pc>.<tailnet>.ts.net` (or your Pages site, then **Use
   Portly on another PC** with that address), give the phone a name and tap **Ask to connect**.
   The name Tailscale fills in may be the phone's model or something generic; change it to one
   you will recognise.
4. Approve it on the main PC in Settings → Devices, as for a PC.

What is different on a phone:

- **Layout.** On a screen narrower than 768 px the widgets stack in one full-width column and
  layout editing is off. Arrange the board on a PC; the phone shows the same board, stacked.
- **No New Tab page.** Chrome on Android has no extensions, so Portly cannot be the New Tab page
  there. Bookmark the address, or use Chrome's **Add to Home screen**.
- **The same main-PC-only actions** as for any other PC (listed under "How it works"). Accounts
  connected on the main PC work on the phone too.
- **The screens say "PC".** "Connect this PC to Portly" and "This PC" mean the phone.
- **The Pages site needs connecting.** A phone runs no Portly, so the Pages site works on its own
  there (data kept in that phone's browser) until you connect it to the main PC with **Use
  Portly on another PC**. Not tried on a phone yet.

Never use Tailscale Funnel to reach Portly from a phone away from home: Tailscale on the phone
already reaches the main PC from anywhere, through your tailnet.

## Removing a PC

- On the main PC: Settings → Devices → **Remove** next to the PC. Its next request is refused and
  its page goes back to the connect screen.
- On the other PC itself: Settings → Devices → **Disconnect** next to the PC marked **This PC**
  (on the Pages site: the Portly status in the footer, then **Disconnect this browser**).

A PC not used for 30 days is disconnected by itself. At most 20 PCs can be connected at once.

## What the main PC's logs record

Device and request ids only: never the name you typed, the code, or the login (cookie or secret).
