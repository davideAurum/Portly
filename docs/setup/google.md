# Connect Google (Calendar + Gmail)

Homebase talks to Google Calendar and Gmail with **your own** OAuth client in **your own** Google
Cloud project. Nothing goes through a third-party server, and the app is only ever used by you, so
it stays unverified — that is expected and fine for personal use.

What you get: two-way calendar (create, edit, delete single events) and Gmail unread count, recent
inbox messages, mark read/unread, archive and trash.

**Time needed:** about 15 minutes, once. You need a Google account and Homebase running at
`http://localhost:5757`.

> Console labels below are as of September 2026. Google moves things around occasionally; the
> section names (**Branding**, **Audience**, **Clients**, **Data access**) have been stable since
> the Google Auth Platform replaced the old "OAuth consent screen" pages in 2025.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account you want to use.
   Accept the terms of service if this is your first visit.
2. Open the project picker at the top of the page and choose **New project**
   (or go straight to <https://console.cloud.google.com/projectcreate>).
3. **Project name:** `Homebase`. Leave **Location** as it is (*No organization* is fine).
4. Click **Create**, wait for the notification, then make sure the new project is selected in
   the project picker.

No billing account is needed: the Calendar and Gmail APIs are free at personal-use volumes.

## 2. Enable the Google Calendar API and the Gmail API

1. Open **APIs & Services → Library** (<https://console.cloud.google.com/apis/library>).
2. Search for **Google Calendar API**, open it and click **Enable**.
3. Go back to the Library, search for **Gmail API**, open it and click **Enable**.

Direct links (check that the Homebase project is selected):
<https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> ·
<https://console.cloud.google.com/apis/library/gmail.googleapis.com>

## 3. Configure the Google Auth Platform

Open **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>). If the project
has never been configured you see **Get started**.

### Branding (the "Get started" wizard)

1. Click **Get started**.
2. **App information:** App name `Homebase`; **User support email:** your address. **Next**.
3. **Audience:** choose **External**. **Next**.
   (*Internal* only exists for Google Workspace organizations.)
4. **Contact information:** your email address. **Next**.
5. **Finish:** tick the box to agree to the Google API Services User Data Policy, click
   **Continue**, then **Create**.

Leave the logo empty — a logo would require brand verification, which a personal app does not need.

### Branding → app domain (required before publishing)

Google will not let an *External* app go **In production** until the **App domain** links on the
**Branding** page are filled in. They must be public `https` pages on a domain you list under
**Authorized domains** — `localhost` is not accepted. Homebase ships ready-made pages in
[`site/`](../../site/) (home page, privacy policy, terms of service); host them anywhere static.
The simplest is GitHub Pages from a **public** repository that contains only those files (free
GitHub Pages does not serve private repositories), which gives URLs like these:

| Field | Value |
| --- | --- |
| Application home page | `https://<user>.github.io/homebase-site/` |
| Application privacy policy link | `https://<user>.github.io/homebase-site/privacy.html` |
| Application terms of service link | `https://<user>.github.io/homebase-site/terms.html` |
| Authorized domains | `<user>.github.io` |

1. Open **Branding** (<https://console.cloud.google.com/auth/branding>).
2. Under **Authorized domains**, click **Add domain** and enter the domain *first* (Google checks
   the links against it).
3. Under **App domain**, fill in the three links, then click **Save**.

Google then checks that the home page is *registered to you*, or branding verification fails with
"The website of your home page URL … is not registered to you". The domain must be verified in
[Google Search Console](https://search.google.com/search-console) as a **Domain** property — a
DNS TXT record — by a Google account that is a **Project Owner** of the Cloud project. Google does
not accept a *URL prefix* property ([Domain Verification](https://support.google.com/cloud/answer/13804266)).
That rules out `github.io` and other shared hosts where you cannot add DNS records.

**For a personal Homebase, ignore that failure.** It does not keep the app out of production —
the publishing status still becomes **In production** — and its only effect is that Google keeps
showing the "Google hasn't verified this app" screen from step 6, which you would see anyway.
Only if you want branding verified do you need a domain you own, pointed at the pages (GitHub
Pages supports custom domains) and verified by DNS.

### Audience → publish the app (important)

1. Open **Audience** (<https://console.cloud.google.com/auth/audience>).
2. **Publishing status** shows **Testing**. Click **Publish app** and confirm.
3. The status now reads **In production**.

Why: while an app is in *Testing*, Google expires every authorization — including the refresh
token Homebase stores — **7 days** after you consent, so you would have to reconnect every week.
*In production* has no such limit. An unverified app in production can still be authorized by up
to 100 accounts, which is plenty for one person. You do **not** need to submit the app for
verification; ignore any "needs verification" notices in the console.

You don't need to add test users once the app is in production.

### Data access (scopes)

Declaring the scopes makes the console and the consent screen consistent:

1. Open **Data access** (<https://console.cloud.google.com/auth/scopes>) and click
   **Add or remove scopes**.
2. Under **Manually add scopes**, paste this list and click **Add to table**:

   ```text
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/gmail.modify
   ```

3. Make sure all six are ticked, click **Update**, then **Save**.

`calendar.events` and `calendar.calendarlist.readonly` are *sensitive*, and `gmail.modify` is
*restricted*. That is why Google shows the "unverified app" screen described in step 6.
Homebase uses `gmail.modify` for mark read/unread, archive and trash — it never permanently deletes
mail and never sends mail.

## 4. Create the OAuth client

1. Open **Clients** (<https://console.cloud.google.com/auth/clients>) and click **Create client**.
2. **Application type:** **Web application**.
3. **Name:** `Homebase`.
4. **Authorized JavaScript origins:** leave empty.
5. **Authorized redirect URIs:** click **Add URI** and enter exactly:

   ```text
   http://localhost:5757/api/oauth/google/callback
   ```

   Plain `http`, `localhost` (not `127.0.0.1`), the port, no trailing slash. Homebase shows the
   exact value to copy in **Settings → Accounts**; if you run Homebase on another port, use that
   port here instead of 5757.
6. Click **Create**.
7. The **OAuth client created** dialog shows the **Client ID** and **Client secret**. Copy both
   now (or click **Download JSON**): Google shows the full secret **only once**. If you lose it,
   open the client and use **Add secret** to make a new one.

## 5. Enter the client in Homebase

1. Open Homebase → **Settings → Accounts** (`http://localhost:5757/#/settings/accounts`).
2. In the **Google** card (under *Google and Outlook.com*), paste the **Client ID** and
   **Client secret** and click **Save**.

The secret is stored encrypted in Homebase's vault (DPAPI-protected key) and is never sent back to
the browser.

## 6. Connect your Google account

1. In the same card, click **Connect Google**. The tab goes to Google's sign-in page.
2. Choose your account.
3. **"Google hasn't verified this app"** appears. This is expected: it is your own app, requesting
   Gmail and Calendar access, and you are its only user. Click **Advanced**, then
   **Go to Homebase (unsafe)**.
4. On the consent screen, tick **every** checkbox (or **Select all**) and click **Continue**.
   If you leave Gmail or Calendar unticked, Homebase connects with only what you granted; connect
   again later to add the rest.
5. You land back in Homebase with a "connected" message. Calendars appear under
   **Settings → Calendars** and the Mail widget shows your inbox.

Connect more Google accounts the same way; they all use the same OAuth client.

## Good to know

- **Staying connected.** Google revokes a refresh token that has not been used for 6 months, when
  you change your Google password (because Gmail scopes are granted), or when you remove access at
  <https://myaccount.google.com/connections>. Homebase then marks the account **Reconnect**; click
  it and repeat step 6.
- **Unused OAuth clients are deleted.** Google deletes OAuth clients that have not been used for
  six months (with an email 30 days before). A Homebase that runs daily keeps the client active.
- **Removing an account** in Homebase deletes its tokens and cached events and revokes the token
  at Google.
- **Different port or host.** The redirect URI must match exactly, including the port. Add a
  second redirect URI to the same client if you run Homebase on two ports.

Problems? See [troubleshooting](troubleshooting.md#google).
