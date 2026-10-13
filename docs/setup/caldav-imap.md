# Other calendars and mailboxes: CalDAV, IMAP and ICS

Use these for providers without a dedicated guide — iCloud, Fastmail, Nextcloud, a mailbox at your
own domain, and so on. Google, Outlook.com and Yahoo have their own guides:
[Google](google.md) · [Microsoft](microsoft.md) · [Yahoo](yahoo.md).

| Account type | Protocol | In v1 |
| --- | --- | --- |
| CalDAV | calendars over HTTPS | **Read-only** |
| IMAP | mail | Unread count, recent messages (no preview text), mark read/unread, trash, archive (when the server has an Archive folder) |
| ICS / webcal subscription | a calendar feed URL | **Read-only**, refreshed every 30 minutes |

All three are added in Homebase under **Settings → Accounts** (CalDAV, IMAP) or
**Settings → Calendars** (ICS). Passwords and feed URLs are stored encrypted in Homebase's vault
and are never shown again.

## Always use an app password

Most providers refuse your normal password over CalDAV/IMAP once two-factor authentication is on,
and an app password limits the damage if it leaks. Create one per app and delete it to revoke
access.

## iCloud (Apple)

**App-specific password** (your Apple Account must use two-factor authentication):

1. Sign in at <https://account.apple.com/>.
2. Open **Sign-In and Security → App-Specific Passwords**.
3. Choose **Generate an app-specific password**, name it `Homebase`, and copy the password.

**CalDAV account** (Settings → Accounts → *Other accounts* → **CalDAV calendar** tab):

| Field | Value |
| --- | --- |
| Name | `iCloud` |
| Server URL | `https://caldav.icloud.com` |
| User name | your **primary** Apple Account email (aliases don't work) |
| Password | the app-specific password |

**IMAP account** (Settings → Accounts → *Other accounts* → **IMAP mail** tab):

| Field | Value |
| --- | --- |
| Name | `iCloud Mail` |
| IMAP server | `imap.mail.me.com` |
| Encryption / Port | **TLS (993)** / `993` |
| User name | the name part of your iCloud Mail address (`johnappleseed`, not `johnappleseed@icloud.com`); if that fails, try the full address |
| Password | the app-specific password (the same one or a second one) |
| Webmail address (optional) | `https://www.icloud.com/mail` |

## Fastmail

App passwords (and IMAP/CalDAV access) need a Standard or Professional plan.

1. In Fastmail open **Settings → Privacy & Security** and find the app-password section
   (**Integrations → New app password**; the wording varies slightly between versions).
2. Name it `Homebase`, choose access to **Mail, Contacts & Calendars** (or a narrower option that
   covers IMAP and CalDAV), and copy the password.

| CalDAV field | Value |
| --- | --- |
| Server URL | `https://caldav.fastmail.com/` |
| User name | your full Fastmail address |
| Password | the app password |

| IMAP field | Value |
| --- | --- |
| IMAP server | `imap.fastmail.com` |
| Encryption / Port | **TLS (993)** / `993` |
| User name | your full Fastmail address |
| Password | the app password |
| Webmail address (optional) | `https://app.fastmail.com/` |

## Any other CalDAV server

Examples: Nextcloud `https://cloud.example.com/remote.php/dav`, Radicale, Baïkal, a hosting
provider's groupware.

- **HTTPS is required** and the certificate must be valid — there is deliberately no "ignore
  certificate errors" switch. For a self-hosted server, use a publicly trusted certificate
  (for example Let's Encrypt).
- **Plain `http` is allowed only on your home network:** the host must be (or resolve to) a
  private address such as `192.168.x.x`, and you must tick
  **Allow http for a server on my local network** when adding the account. Anyone on that network
  could read the traffic, including the password.
- Enter the server's base URL or the CalDAV root. Homebase follows the standard
  `/.well-known/caldav` discovery, but only to addresses on the **same site** (same registrable
  domain) — your password is never sent anywhere else, even if the server redirects there.
- Calendars are read-only in v1; you can still hide them, recolor them or pick which ones a
  Calendar widget shows (**Settings → Calendars**).

## Any other IMAP server

| Field | Notes |
| --- | --- |
| IMAP server | e.g. `imap.example.com` |
| Encryption | **TLS** (usually port 993) or **STARTTLS** (usually port 143). Unencrypted IMAP is not supported. TLS 1.2 or newer with a valid certificate is required. |
| Port | 993 for TLS, 143 for STARTTLS, unless your provider says otherwise |
| User name / Password | usually the full email address and an app password |
| Webmail address (optional) | where "open in webmail" links go, e.g. `https://mail.example.com/` |

Homebase moves trashed messages to the server's Trash folder (the special-use `\Trash` folder, or
one named *Trash*, *Deleted Items*, *Deleted Messages* or *Bin*). **Archive** only appears when the
server advertises an Archive folder. Messages are never permanently deleted.

Not for Gmail or Outlook.com: use the [Google](google.md) and [Microsoft](microsoft.md) guides
(Outlook.com no longer accepts passwords over IMAP).

## ICS / webcal subscriptions

Any calendar you can subscribe to by URL works read-only: public holiday calendars, sports
schedules, Proton Calendar share links, Outlook.com and Yahoo published calendars, iCloud public
calendars, and so on.

1. Copy the calendar's subscription link (`https://...` or `webcal://...`; Homebase converts
   `webcal://` to `https://`).
2. In Homebase open **Settings → Calendars**, add an ICS calendar, paste the link and give it a
   name and color.

Many share links contain a secret token — treat them like passwords. Homebase keeps the full URL
encrypted and only shows the host name. Feeds are refreshed every 30 minutes (**Sync now** forces a
refresh), and very large or endlessly repeating feeds are cut off at safe limits instead of slowing
Homebase down.

Problems? See [troubleshooting](troubleshooting.md#yahoo-caldav-and-imap).
