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
3. The other PC opens the address and sees **Connect this PC to Portly**: it gives itself a name
   and shows a short code. On the main PC, Settings → Devices lists the request with the same
   code. You compare the two and choose **Approve**. The other PC's page connects by itself.
4. From then on the other PC uses Portly like the main one, with a login cookie that lasts 30 days
   of inactivity and renews while in use. **Remove** in Settings → Devices on the main PC cuts it
   off at once.

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

If the other PC's page shows **This address reaches Portly the wrong way**, the proxy forwards to
Portly's main port instead of its port for other PCs: run the `tailscale serve` command above
with the right port.

## Removing a PC

- On the main PC: Settings → Devices → **Remove** next to the PC. Its next request is refused and
  its page goes back to the connect screen.
- On the other PC itself: Settings → Devices → **Disconnect** next to the PC marked **This PC**.

A PC not used for 30 days is disconnected by itself. At most 20 PCs can be connected at once.

## What the main PC's logs record

Device and request ids only: never the name you typed, the code, or the login cookie.
