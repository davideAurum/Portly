# Connect Outlook.com (Microsoft personal account)

Portly reads and writes your Outlook.com calendar and mail through Microsoft Graph, using an app
registration that **you** own. It works with personal Microsoft accounts (Outlook.com, Hotmail,
Live, MSN). Work or school accounts are not supported.

What you get: two-way calendar (create, edit, delete single events) and mail unread count, recent
inbox messages, mark read/unread, archive and delete (moves to *Deleted Items*).

**Time needed:** 20–30 minutes, once.

> Don't want to set up Azure? Skip to [Read-only alternative: publish your calendar as ICS](#read-only-alternative-publish-your-calendar-as-ics).
> You get your Outlook.com calendar (read-only) but no mail.

> Portal labels below are as of September 2026. Microsoft renames things from time to time; the
> values you enter (account type, platform, redirect URI, permissions) are what matter.

## 1. Get a directory (Azure free account)

Microsoft no longer lets a personal account register apps "outside a directory". Signing in to the
Entra admin center with only a personal account puts you in the read-only *Microsoft Services*
tenant, where **New registration** fails. You need your own directory, and the supported way to get
one is an Azure account:

1. Open a private/InPrivate browser window (avoids signing in with the wrong account).
2. Go to <https://azure.microsoft.com/free/> and choose **Try Azure for free** / **Start free**.
3. Sign in with your personal Microsoft account (the Outlook.com address is fine).
4. Complete the sign-up: profile, phone verification and card verification. The card is only for
   identity verification; this setup creates no billable resources.
5. When the portal opens, you are the Global Administrator of a new directory (tenant) called
   *Default Directory*.

App registrations live in the directory, not in the Azure subscription, so Portly keeps working
after the free credit period. Do not create any Azure resources.

## 2. Register the app

1. Go to the Microsoft Entra admin center: <https://entra.microsoft.com/>. If you have several
   directories, use the **Settings** (gear) icon in the top bar to switch to the new one.
2. Open **Entra ID → App registrations** and click **New registration**.
3. **Name:** `Portly`.
4. **Supported account types:** **Personal accounts only** (older portal versions call it
   *Personal Microsoft accounts only*). Portly signs in through the `/consumers` endpoint and
   refuses work/school accounts.
5. If the form also shows an optional **Redirect URI** section, you can leave it empty — the next
   step adds it.
6. Click **Register**.
7. On the **Overview** page, copy the **Application (client) ID**.

## 3. Add the redirect URI

1. In the app's menu open **Authentication**.
2. On the **Redirect URI configuration** tab click **Add Redirect URI** (older layouts:
   **Add a platform**).
3. Choose the **Mobile and desktop applications** tile.
4. Under **Custom redirect URIs** enter exactly:

   ```text
   http://localhost/api/oauth/microsoft/callback
   ```

   No port: Microsoft ignores the port for `localhost` redirect URIs, so this works for
   `http://localhost:5757` and any other port. (Portly shows the same value to copy in
   **Settings → Accounts**.)
5. Click **Configure**.
6. Make sure the same URL is **not** also registered under **Web** or **Single-page application** —
   Microsoft picks one platform per redirect URI and the others break the sign-in.

Leave **Allow public client flows** (on the **Settings** tab of the same page in newer layouts) at
**No** / off — Portly uses the authorization-code flow with PKCE, which does not need it.

## 4. Add the Graph permissions

1. Open **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
2. Tick:
   - **Calendars.ReadWrite**
   - **Mail.ReadWrite**
   - **offline_access** (under *OpenId permissions*; also tick **openid**, **profile** and **email**)
   - **User.Read** is already listed — keep it.
3. Click **Add permissions**.

No admin consent is needed; with a personal account you consent for yourself when you connect.
Portly uses `Mail.ReadWrite` for mark read/unread, archive and moving mail to Deleted Items —
it never sends mail and never permanently deletes it.

## 5. No client secret

Do **not** create anything under **Certificates & secrets**. Portly is a *public client*: it
proves itself with PKCE instead of a secret, which is how desktop apps are meant to work. Refresh
tokens for this kind of app last 90 days and renew every time Portly uses them.

## 6. Enter the client in Portly

1. Open Portly → **Settings → Accounts** (`http://localhost:5757/#/settings/accounts`).
2. Under **Add a connection**, click the **Microsoft** tile. The first step is
   **App registration**: paste the **Application (client) ID** and click **Save and continue**.
   There is no secret to enter.

To change it later, use **Edit** next to Microsoft under **App registrations** (below the tiles).

## 7. Connect your account

1. **Services:** tick what Portly should use the account for, **Calendar** and/or **Mail**, and
   click **Continue**. Portly asks Microsoft only for those permissions (plus the sign-in ones).
2. **Sign in:** click **Sign in with Microsoft** and sign in with your Outlook.com account.
3. Microsoft shows **Let this app access your info?** with the permissions you picked and your
   app's name marked as unverified. That is expected for your own app. Click **Accept**.
4. You land back in Portly with a "connected" message. The account appears under
   **Connected accounts**; your calendars appear under **Settings → Calendars** and the Mail
   widget shows your inbox.

To add a service later, open **Manage** on the account and click **Add** next to it: you sign in
again and Microsoft asks for the new permission on top of the ones you already gave. Switching a
service off under **Manage** only stops Portly using it; nothing is revoked at Microsoft.

You can connect several personal Microsoft accounts with the same registration.

## Good to know

- **Staying connected.** A refresh token unused for 90 days expires, and changing your password
  or removing the app at <https://account.live.com/consent/Manage> revokes it. Portly then shows
  **Reconnect needed** for the account; click **Reconnect** and sign in again.
- **Mail archive** uses your mailbox's *Archive* folder; **delete** moves messages to
  *Deleted Items*.

## Browser-only build (GitHub Pages)

The [browser-only site](static-build.md) connects Outlook.com without the Portly server: the
page itself signs in to Microsoft and reads and writes your calendar through Graph. Mail is not
part of it. The steps above apply, with these differences:

- **Redirect URI.** Add it under the **Single-page application** platform (not *Mobile and desktop
  applications*), and enter the site's own address exactly as **Settings → Accounts** on the site
  shows it, for example `https://<user>.github.io/portly-pages/`. A registration can hold both:
  the localhost callback under *Mobile and desktop applications* for the server, the site's
  address under *Single-page application* for the site.
- **Permissions.** The site offers the calendar, and launch pad sync only when you tick it: the
  **Microsoft** tile has no Mail service. The site asks for **Calendars.ReadWrite** (plus the
  sign-in ones), never **Mail.ReadWrite**, and **Files.ReadWrite.AppFolder** (your OneDrive's
  folder for this app, nothing else) only for **Launch pad sync**. Launch pad sync is still being
  built: ticking it does not sync anything yet.
- **The sign-in lasts 24 hours.** Microsoft limits sign-ins made from a web page to a day. The
  site renews it by itself when you open it while you are still signed in to Microsoft in that
  browser; otherwise the account shows **Reconnect**. Checked with a real Outlook.com account on
  the published site on 2026-10-26: the sign-in renewed by itself more than 24 hours after
  connecting, and showed **Reconnect** once consent was withdrawn.
- **Calendars sync while the site is open**, every sync interval (**Settings → Calendars**), and
  are kept in this browser (not encrypted) so the page shows them right away next time. Add the
  **Calendar** widget from **Add widget**.

## Read-only alternative: publish your calendar as ICS

No Azure account needed; you get the calendar read-only and no mail. (Portly server only: the
browser-only site cannot fetch ICS feeds.)

1. Open <https://outlook.live.com/calendar/> and click **Settings** (gear) → **Calendar** →
   **Shared calendars**.
2. Under **Publish a calendar**, pick the calendar and **Can view all details**, then **Publish**.
3. Copy the **ICS** link (not the HTML one).
4. In Portly open **Settings → Calendars**, add an ICS calendar and paste the link.

Treat the ICS link like a password: anyone who has it can read that calendar. Portly stores it
encrypted and only ever shows its host name. To revoke it, choose **Unpublish** (or **Reset links**)
in the same Outlook settings page.

Problems? See [troubleshooting](troubleshooting.md#microsoft).
