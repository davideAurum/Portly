# Connect Yahoo (Mail + Calendar)

Yahoo has no public API for personal accounts, so Homebase uses the standard protocols with a Yahoo
**app password**:

| What | How | In v1 |
| --- | --- | --- |
| Mail | IMAP, `imap.mail.yahoo.com`, port 993, TLS | Unread count, recent messages, mark read/unread, archive (if your mailbox has an Archive folder), trash |
| Calendar | CalDAV, `https://caldav.calendar.yahoo.com` | **Read-only** (editing Yahoo events is planned for a later version) |

Your normal Yahoo password never goes into Homebase.

## 1. Generate an app password

1. Sign in at <https://login.yahoo.com/account/security> (**Account Security**).
2. Under **External connections**, click **Create app password** (older layouts:
   **Generate app password** / **Manage app passwords**).
3. Enter an app name, e.g. `Homebase`, and click **Generate password**.
4. Copy the 16-character password it shows, then click **Done**. Yahoo shows it only once.

**If Yahoo doesn't offer app passwords:** Yahoo decides per account whether you may create one,
and it often refuses for new accounts or accounts with little sign-in history. Its advice: use a
browser you have used to sign in to Yahoo for several days in a row, and don't use a private /
Incognito window. Yahoo support cannot override this. If you still can't create one, use the
[calendar ICS fallback](#calendar-fallback-ics-link) below; Yahoo mail is then not available in
Homebase.

App passwords keep working when you change your main Yahoo password. To revoke one, delete it on
the same Account Security page.

## 2. Add the account in Homebase

1. Open Homebase → **Settings → Accounts** (`http://localhost:5757/#/settings/accounts`).
2. Under **Other accounts**, on the **Yahoo** tab, enter your full Yahoo address as
   **Yahoo email** and the **App password**, then click **Add Yahoo account**.
3. Homebase tests IMAP and CalDAV separately and tells you which one worked. If only mail works,
   the account is saved as mail-only — you can still add your calendar with the ICS fallback.

The app password is stored encrypted in Homebase's vault and is never shown again.

## Calendar fallback: ICS link

If CalDAV doesn't work for your account, or you have no app password, a Yahoo calendar can be added
as a read-only ICS subscription — **if** Yahoo offers a link for it:

1. Open <https://calendar.yahoo.com/>.
2. In the calendar list on the left, open the menu next to the calendar (drop-down / **⋮**) and
   choose **Edit calendar** (or **Share**).
3. Turn on the public / shareable link option and copy the **ICS** link (the one meant for
   importing into a calendar app, not the HTML one).
4. In Homebase open **Settings → Calendars**, add an ICS calendar and paste the link.

Yahoo has changed and at times suspended these links; if your calendar shows no ICS option, this
fallback isn't available for it. Treat the link like a password: anyone who has it can read the
calendar. Homebase stores it encrypted and only shows its host name.

Problems? See [troubleshooting](troubleshooting.md#yahoo-caldav-and-imap).
