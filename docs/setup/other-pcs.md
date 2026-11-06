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
3. On the main PC, open Settings → Devices, on the Pages site or on Portly's own page
   (`http://localhost:5757/#/settings/devices`, which forwards to the Pages site when you have
   one). Check that the request shows the same name and code, and choose **Approve**. Choose
   **Deny** for a request you did not make.
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

## When the main PC is older than the site

Your Pages site and the main PC's Portly update separately, so the site can be a newer version
than Portly. When it is, a page connected to the main PC says so under its header, for example:

> **Portly on your main PC is older than this site**
> Your main PC runs 0.2.0-alpha.6; this site is 0.2.0-alpha.7. Run `portly --update` on your main PC.

The page keeps using the main PC, but anything new in the site that needs the newer Portly may not
work until you update, from Settings → About or with this on the main PC:

```powershell
portly --update
```

The notice goes away by itself once the main PC is back on the newer version. A page opened at the
Tailscale address itself never shows it, because Portly serves that page and the two are always the
same version.

## Updating the main PC from another PC

Open Settings → About. The **Updates** card says when a newer release exists. Press **Update**, and
the main PC installs it with the same backup and rollback as `portly --update`.

**Update is only on Portly's own page, the Tailscale address, not on the Pages site.** The site shows
the same card with a link there, **Open Portly's own page**. The Pages site and the releases are
published from one GitHub account, so if the site could start an update, someone who took that
account could publish a bad release and start it with nobody choosing to. On Portly's own page, a
person still has to press the button.

The first time you follow that link, this PC connects there and the main PC approves it, as in
[Connecting another PC](#connecting-another-pc). It shows as a second entry in Settings → Devices,
because the Tailscale address and the Pages site keep separate logins. That happens once.

- Portly stops for about a minute, on every PC using it. The page says what it is doing, and tells
  you when it is finished.
- The main PC must be on, and you must be signed in to Windows there. Otherwise Portly isn't running,
  so there is nothing to ask. A locked screen should be fine, though that hasn't been tried.
- If the new version doesn't start, the old one and your data are put back, and the page says so.
- If Portly doesn't come back at all, it needs the main PC.
- When the extension changes, **Reload** on `chrome://extensions` still has to be done on the main PC.

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
