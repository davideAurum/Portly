# Design: syncing the launch pad of the browser-only site through OneDrive

**Status:** accepted, being built (ROADMAP phase 6). The phase 0 spike with a real Outlook.com
account is done, and its answer is **go** (section 13). The decisions of 2026-10-20 are in
section 0 and settle most of the open questions at the end. Today the browser-only (GitHub
Pages) build keeps everything in that browser's IndexedDB (`portly-static:<base>`), and the only
way to move data between browsers is export and import. Hybrid mode gives a paired browser the
local server's data, but that needs a server.

**Main idea:** the site writes the launch pad to one file in the user's own OneDrive, in the
folder Microsoft gives each app (`/me/drive/special/approot`). Every browser that turns sync on
reads that file, merges it with its own copy and writes the result back. There is still no
Portly cloud service: the data goes only to a provider the user connects (README, ARCHITECTURE
section 4), with the Outlook.com sign-in the site already has for calendars. Sync is a service the
user ticks on a Microsoft connection, next to the calendar, not a setting of its own. Nothing in
this design needs a new dependency.

What it reuses from the Outlook.com calendar support:
- the PKCE sign-in as a single-page app with no secret
  (`web/src/static/providers/microsoftAuth.ts`);
- token refresh under a Web Lock (`getAccessToken` in `web/src/static/handlers/accounts.ts`);
- the Graph error mapping and diagnostics of `providers/graphClient.ts`;
- `https://graph.microsoft.com`, already in the static CSP (`staticCsp()` in `web/vite.config.ts`).

Sync depends on the Outlook.com browser flow. The phase 0 spike also tested that flow with a real
account on a localhost copy (ROADMAP item 2.1 repeats it on the published address).

## 0. Decisions (2026-10-20)

Taken with the owner on 2026-10-20 (ROADMAP decisions D7 to D9). The sections below are written to
match them.

- **D7: sync in the contract.** `launchpadSync` enters the API contract as a new value of the
  shared `Capability` enum (`shared/src/accounts.ts`), in one deliberate contract change. The
  server leaves it out of `OAUTH_PROVIDER_CAPABILITIES` for both providers, so its sign-in refuses
  it (`422`, "not available"), and the Accounts page shows it only where the page's data lives in
  the browser (the `launchpadSync` per-load capability, section 9).
- **D8: the defaults, all as proposed.** (Whether OneDrive stays the only sync is recorded in
  ROADMAP decision D8.)
  - OneDrive through an Outlook.com account is the sync this design describes;
  - no passphrase encryption of the file;
  - layouts, the launch pad's display settings and the theme stay per PC;
  - the first sync defaults to **Use the synced launch pad**, and there is no **Combine both**
    option (section 6.6);
  - tombstones are kept 90 days (section 6.3);
  - one Microsoft connection per browser has the service (section 3);
  - sync's safety backup has a slot of its own, apart from the import backups (section 6.7);
  - Chrome and Edge are in scope; Firefox gets a smoke run, Safari is not supported.
- **D9: the custom domain.** The shared `<user>.github.io` origin (ARCHITECTURE section 4.1) means
  any script on any Pages site of the account can read the access token and so the app folder.
  This is accepted and documented for now. It is decided again before the sync engine (ROADMAP
  6.5) ships: either a custom domain used only for the site, or the risk stays accepted with the
  docs saying so.

## 1. What the user gets

- In **Settings → Accounts**, a Microsoft connection offers **Launch pad sync** as one of its
  services, next to **Calendar**. The user ticks it when adding the connection, or later on a
  connection they already have. Microsoft asks once for the permission it needs (section 3).
- Groups, bookmarks and custom icons then follow them to every browser and PC where they open
  the site and tick the service on a connection to the same Microsoft account.
- Changes arrive when a page loads or gets focus, and while it stays open. There is no
  background job: a browser with no Portly tab open does nothing.

The Accounts page shipped in this shape on 2026-10-19 (commit 9cce15e): connected accounts at the
top, then "Add a connection" with a tile per provider, and a dialog per tile where the user picks
the services to use before signing in. Sections 3 and 10 say what sync adds to it.

## 2. Where the data lives in OneDrive

```
OneDrive / Apps / <app registration name> /      (approot, created by Microsoft on first use)
    launchpad.json                               groups, bookmarks, tombstones, icon list
    launchpad-icons/<uuid>                       one file per custom icon, never changed
```

- The app folder belongs to the **Application (client) ID**, not to the site. Every browser must
  use the same app registration, or it gets a different folder. Two Pages sites that share a
  registration share the file.
- Microsoft names the folder after the registration when it creates it. Renaming the
  registration later doesn't rename the folder. The user can see, move or delete the folder in
  OneDrive. `special/approot` still finds a moved folder, and a deleted one is created again,
  empty, on the next write (section 6.6 covers a missing file).
- The main file is small (a few hundred KB for a large launch pad), so it is written with a
  simple `PUT`, which Microsoft allows up to 250 MB. Icons are separate files so a check doesn't
  download them again.
- **In the browser,** a new slice, `launchpad-sync`, holds the sync state. Like the accounts, it
  is never exported. It contains:
  - the id of the connection that has the service on, and the clock (6.1);
  - the file's `epoch` and the `eTag`/`cTag` last merged;
  - when this browser last synced and last checked;
  - the "changes waiting" flag (section 7) and the backoff state.

## 3. The service, its permission and consent

**Decision:** launch pad sync is a service of a Microsoft connection, **Launch pad sync**, and it
maps to one scope, `Files.ReadWrite.AppFolder`. That scope reaches the app folder and nothing else
in OneDrive. `Files.ReadWrite` (the whole drive) is not needed and is not requested.

- **Services map to scopes.** On a Microsoft connection in the browser-only build:
  - **Calendar** → `Calendars.ReadWrite`;
  - **Launch pad sync** → `Files.ReadWrite.AppFolder`.

  A sign-in asks for the sign-in scopes (`openid profile email offline_access User.Read`) plus
  those of the ticked services, and nothing else. `MICROSOFT_STATIC_SCOPES` becomes this map. A
  new `scopesFor(account)` builds the set, and `authorizeUrl()`, the refresh in `accounts.ts` and
  the automatic `prompt=none` re-sign-in (`planSilentReauth`) all use it. Microsoft only accepts a
  refresh whose scopes are the ones of the original sign-in or fewer. So the refresh may not ask
  for a service's scope until a sign-in has asked for it.
- **Ticking the service on an existing connection is incremental consent.** The connection
  stores the scopes its last sign-in asked for. If they lack `Files.ReadWrite.AppFolder`, the
  dialog explains the new permission, then starts the normal reconnect
  (`POST /api/oauth/microsoft/start {accountId, returnTo}`, back to `#/settings/accounts`) with
  the larger scope set. Microsoft asks for the new permission only, and for nothing if the account
  already granted it in another browser. `grantedScopes` can't make this decision: the token
  response lists every permission the account has granted the registration, not what this
  sign-in asked for (section 13). The existing `different_account` rule applies: signing in as
  someone else doesn't change the connection.
- **Connections without the service never ask for it.** A calendar-only connection keeps today's
  scopes, and a connection can have sync without the calendar. One limit: consent is stored per
  Microsoft account and app registration, not per browser. Once any browser has granted it, every
  later sign-in of that account carries the scope, in any browser. That includes the automatic
  daily renewal of a calendar-only connection (seen in the spike). This only matters for an
  account the user has ticked sync on somewhere, and the scope still reaches only the app folder.
- **One connection per browser.** A browser has one launch pad, so at most one of its
  connections has the service on. Ticking it on a second Microsoft connection offers to move it.
  Moving counts as a first sync with that account's file (6.6).
- **Unticking the service** stops sync in this browser. It keeps the local data and the file,
  and it doesn't withdraw the consent: the docs will explain how to do that at
  <https://account.live.com/consent/Manage>. Removing the connection unticks it.
- **What sync needs from the Accounts page:**
  - a service id (`launchpadSync`) with its scope, in the service list of Microsoft connections;
  - a per-connection on/off, stored in this browser;
  - room on the connection's card for the service's status line (section 10).

  The shipped page lists a provider's services as capabilities (`OAUTH_PROVIDER_CAPABILITIES` in
  `shared/src/accounts.ts`, today `calendar` and `mail`) and keeps the ones in use in the
  account's `enabledCapabilities`, so the natural place for `launchpadSync` is a new shared
  `Capability` value, which D7 chose. Sync's own state stays in its slice (section 2).
- **Offered only where it can run.** The service is offered when this page's data lives in the
  browser (the `launchpadSync` capability, section 9). On a server-backend page and in the
  server build it shows as unavailable, with a one-line reason.
- **Work and school accounts stay out.** They are "not planned" (ARCHITECTURE section 1), the
  `/consumers` authority stays hard-coded, and the app folder permission is documented for
  personal accounts.
- **The app registration.** Dynamic consent works without listing the permission in the
  registration, but `docs/setup/microsoft.md` adds it to the list to tick, marked "only for
  launch pad sync".

## 4. Network and the content security policy

Uploads and metadata go to `graph.microsoft.com`, which the CSP already allows. Downloads don't:

- `GET .../content` answers `302` to a pre-authenticated download URL on another host. Microsoft's
  docs say a JavaScript app can't use it, because a redirect is refused after a CORS preflight
  (and the `Authorization` header forces one). In the spike, the desktop app's Chromium-based
  browser followed the redirect anyway. Firefox and Safari were not checked, so the design doesn't
  rely on it.
- Instead, the app reads the item's `@microsoft.graph.downloadUrl` and fetches that URL itself
  with no `Authorization` header: a simple request, with no preflight. The URL's `tempauth`
  parameter is a short-lived credential.
- The host in Microsoft's example is `<random>.files.1drv.com`. For a personal account, the spike
  only ever got URLs on `my.microsoftpersonalcontent.com` (the response headers are SharePoint's).
  Microsoft's Graph docs don't mention that host.

The static CSP's `connect-src` gains (settled by the spike, section 13):

| Source | Why | Status |
| --- | --- | --- |
| `https://my.microsoftpersonalcontent.com` | Download URLs | Verified. A cross-origin `GET` with no headers works and needs no preflight. It sends the content with no further redirect. The URL can be fetched more than once while valid. It answers any origin, the Pages origin included (see below) |
| `https://*.files.1drv.com` | Microsoft's documented example host | Not seen in the spike. Kept so that an account still on the older storage isn't refused. Its CORS is unverified |
| `https://*.up.1drv.com` | Upload sessions | Not needed: `If-Match` works on a simple `PUT` (section 6.5) |

The spike ran on a `localhost` origin, not on Pages. The download host answered there, and also
after a cross-origin redirect, where the browser sends `Origin: null`. A fetch with credentials
failed, which is how browsers treat `Access-Control-Allow-Origin: *`. So it allows any origin.
It also lets the page read the `ETag` and `cTag` response headers. Whether their values equal
Graph's `eTag` and `cTag` wasn't checked.

- **Before fetching a download URL**, the client checks that it is `https:` with a host from that
  list. Otherwise it refuses, which gives a clearer error than a CSP violation. It fetches with
  `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, no custom headers (a simple request),
  a byte cap and a timeout. The URL carries a short-lived credential: it is never logged or
  stored.
- `img-src` doesn't change: icons are stored as blobs and shown through `blob:` URLs, as now.
- The server build's CSP doesn't change, because sync never runs there.

**Go/no-go:** if no content host answered cross-origin reads, OneDrive sync couldn't work from a
page. The spike checked this first. It answers them, so the answer is go.

## 5. What syncs

| Data | Syncs? | Why |
| --- | --- | --- |
| Bookmark groups (name, color, collapsed, order) | Yes | The launch pad itself |
| Bookmarks (title, URL, group, order, icon mode, letter color) | Yes | The launch pad itself |
| Custom icon images (`icons` slice + blobs of kind `icon`) | Yes, as separate files | A bookmark's custom icon would be missing otherwise |
| Automatic icons (`fav:<host>`) | No, derived | Each browser derives the id from the URL, and only when its own `autoFetchIcons` is on |
| `settings.bookmarks.ungroupedGroupId`, `defaultGroupId` | Yes, each as one value | They point at groups. Without them, "No group" bookmarks would show under a named header on other PCs |
| `settings.bookmarks.autoFetchIcons` | No | A per-browser privacy choice (it sends host names to DuckDuckGo) |
| The launch pad widget's display config (`launchpadConfigSchema`, stored inside profiles) | No, in v1 | See below |
| Profiles, layouts, theme, background images, other settings | No, in v1 | A later phase, if wanted |
| Accounts, tokens, OAuth client, Todoist token, calendars, backups | Never | Secrets or per-browser caches |

**The widget's display config stays per browser in v1.** It lives in the profile layout with
every other widget, and screens differ from PC to PC (columns, icon size, list or tiles). Its
`groupIds` and `groupSpans` refer to groups by id. Sync keeps ids stable, unlike import, which
gives every row a new id. So a launch pad set to show chosen groups keeps working on every PC.
A group deleted elsewhere just disappears from it (`visibleGroups()` skips unknown ids), and a
new group shows on a launch pad set to "all", which is the default. Syncing layouts would need
per-PC overrides; D8 keeps layouts per PC.

## 6. Merging

The file holds the whole launch pad, and every browser merges with the same function, so all
browsers end up with the same result whatever order they sync in. Rows already have stable ids
and `createdAt`/`updatedAt`. Three things are missing today: a second timestamp for order, a
clock that copes with skew, and tombstones.

### 6.1 Timestamps and clock skew

- **A hybrid logical clock.** Each bookmark write is stamped with
  `max(Date.now(), lastStamp + 1)`. `lastStamp` is kept in the sync state and raised to the
  file's highest stamp after every merge. A change made after seeing another PC's change
  therefore always wins over it, however wrong either clock is. Wall-clock time only decides
  between edits made without seeing each other.
- **Skew** then only affects those rare simultaneous edits: the PC whose clock runs ahead wins
  them. Diagnostics warns when the file's clock is more than 5 minutes ahead of this PC. A stamp
  before 2020 or more than a year ahead fails validation (section 8).
- **Equal stamps** are settled by comparing the two versions' canonical JSON, so every browser
  picks the same one without storing a device id per row.

### 6.2 Rows

Each row has two parts, each with its own timestamp:

- **Content:** name, color and collapsed for a group; title, URL, icon and letter color for a
  bookmark. Stamped `updatedAt` (today's field, now stamped by the clock above).
- **Placement:** `sort`, plus `groupId` for a bookmark. Stamped by a new field, `placedAt`.
  Today `renumber()` and a move bump `updatedAt`. They set `placedAt` instead, so reordering on
  one PC no longer undoes a rename made on another. A one-time upgrade (the `upgrades` slice)
  sets `placedAt = updatedAt` on existing rows.

Merging a row present on both sides takes the content with the newer `updatedAt` and the
placement with the newer `placedAt`. Per-field timestamps would also keep a rename on one PC and
a color change on another. They are not worth the extra size and code for one user.

### 6.3 Deletes and tombstones

The bookmarks slice has no tombstones today: a deleted row is simply gone, and a merge would
bring it back from the file. `calendar.ts` has the pattern in a smaller form: an in-memory
`tombstones` map that stops a listing fetched before a delete from restoring the event for 10
minutes. Sync needs the lasting version:

- `BookmarksSlice` gains `deleted: {kind: 'group' | 'bookmark', id, at}[]`, written in the same
  commit as the delete. Every path that removes rows writes them:
  - deleting a group (and its bookmarks, which go with it);
  - deleting a bookmark;
  - a config import or a backup restore, which replace every group and bookmark.

  A test lists these paths, so a new one can't be added without tombstones.
- **A tombstone beats a row whose two timestamps are both older** (or equal). A bookmark edited on
  another PC *after* the delete survives. If its group was deleted, the browser that applies the
  file shows it under the "No group" group, creating that group if needed (section 6.8).
- **The file keeps a removed row's last content next to its tombstone** until the tombstone
  expires. Without it, a removed row's newer placement could be lost in one merge order and kept
  in another; with it, the merge is a join of last-writer-wins parts and every order of syncing
  gives the same file (built in 6.4: `shared/src/launchpadSync.ts`). A browser's own data keeps
  only the tombstone.
- **Tombstones are kept for 90 days**, then dropped. The file records the time of the newest
  dropped one as its `horizon`.
- **A browser that hasn't synced since before the horizon** can't rely on tombstones. It keeps
  local rows that the file doesn't have only if they changed after its last sync (made offline).
  Rows not changed since then were deleted elsewhere, so it drops them.

### 6.4 Order

- After a merge, each group's bookmarks (and the list of groups) are shown in `(sort, id)` order,
  as `compareOrder()` does today. The merge never renumbers: renumbering would stamp rows and
  send changes back and forth between PCs. The next local edit in that group renumbers it, as
  now.
- **Limit:** reordering the same group on two PCs between syncs gives a mix of both orders, the
  same on every PC. One more drag fixes it. Fractional sort keys would avoid the mix, but they
  change `sort` from an integer in the shared and export schemas. Not for v1.
- **The two settings that name a group** (`defaultGroupId`, `ungroupedGroupId`) each sync as one
  last-writer-wins value with its own stamp.
- **Limit: two "No group" groups.** Since the first sync replaces one side (D8), two only happen
  when two browsers each create one between syncs. The later pointer wins and the other stays as
  an ordinary group named "No group"; deleting it or moving its bookmarks fixes it. The proposal
  here was to fold the two together automatically, but a fold the merge makes on its own (moving
  rows without a stamp) can come out differently depending on the order browsers sync in, so the
  merge does not do it (6.4).

### 6.5 Writing the file: eTag and If-Match

One sync round, under the sync lock (section 7):

1. Read the file's metadata:
   `GET /me/drive/special/approot:/launchpad.json?select=id,eTag,cTag,size,@microsoft.graph.downloadUrl`.
   Write `select` without the `$`, as in Microsoft's example: with `$select`, Graph leaves the
   download URL out. `$select=id,eTag,cTag,size,content.downloadUrl` also returns it. A `404`
   (`itemNotFound`) means there is no file yet.
2. If the `cTag` (it changes only with the content) equals the last one merged and nothing local
   is waiting, stop. Most checks end here, after one small request.
3. Otherwise download through the download URL, validate (section 8), and download any icon
   files this browser doesn't have. Merge.
4. If the merge changes this browser's data, commit it in **one** storage transaction:
   - the bookmarks, icons and settings slices;
   - the new icon blobs;
   - a safety backup first, if needed (section 6.7).

   `commitWith` already does this. The BroadcastChannel then tells the other tabs.
5. If the merged result differs from the file, upload new icons first, create-only
   (`@microsoft.graph.conflictBehavior=fail`; a `409` means it already exists, which is fine,
   since icons never change). Then write the main file:
   - with `If-Match: <eTag from step 1>`;
   - or, if there is no file yet, with `conflictBehavior=fail`.
6. `412 Precondition Failed` or `409` means another browser wrote in between: start again from 1.
   After 3 rounds, back off and show "busy". On success, keep the returned `eTag`/`cTag` as the
   last merged.

**Checked in the spike (section 13).** Microsoft's page for the simple upload (`PUT .../content`)
lists only `Authorization` and `Content-Type`, but `If-Match` works there:
- the current `eTag` gives `200`;
- a stale one gives `412` (code `notAllowed`) and leaves the file unchanged.

So no upload session is needed. A `cTag` works as the `If-Match` value too.
`@microsoft.graph.conflictBehavior=fail` works as a query parameter: `409` (`nameAlreadyExists`)
when the file exists. It also creates a missing `launchpad-icons` folder on the way. The `PUT`
response carries the new `eTag`, `cTag` and a download URL.

One surprise: `If-Match` on a file that no longer exists creates it (`201`) instead of
answering `412`. The engine treats that like a missing file (6.6), which uploads anyway.

Old icon files: any browser may delete an icon file that the main file no longer references and
that is more than 30 days old.

### 6.6 First sync in a browser, and a missing file

- **Nothing to choose** when either side is empty. An empty browser takes the file, and a
  browser with no file uploads its own launch pad.
- **Both have data:** a dialog with two choices. This matters because two browsers filled by
  export/import hold the same bookmarks under different ids, so a plain merge would double
  everything.
  1. **Use the synced launch pad** (the default, D8): this browser's groups and bookmarks are
     replaced, after a backup.
  2. **Replace the synced launch pad with this browser's:** the file is rewritten with a new
     `epoch`. Other browsers see the new epoch, take a backup, and handle it like a browser past
     the horizon (6.3). Rows they changed since their last sync stay; everything else follows
     the new file.

  A **Combine both** choice (groups matched by name, bookmarks by URL) was considered and left
  out (D8).
- **The file disappeared** (the user deleted the folder) after this browser had synced: it is
  treated as empty, never as "everything was deleted". The browser uploads its launch pad again
  and the service's status line says so.

### 6.7 Import and safety backups

- **A config import with sync on replaces the launch pad in every synced browser.** It writes
  tombstones for every old row. The import preview says so.
- **A merge that removes 10 or more rows (or a quarter of them), adopts a new epoch, or replaces
  this browser's launch pad on first sync takes a backup first.** It uses the existing backup
  store: the `backups` slice and `backup:<id>` documents, listed in Settings → Import & export
  and imported like any export file. `BackupEntry` gains an optional `reason`
  (`import` | `sync`), so the list can say "Before sync". Sync keeps one backup slot of its own
  (D8): a new sync backup replaces the previous sync backup, never an import's, and the import
  backups keep their 3 slots (`MAX_BACKUPS`).

### 6.8 The file format and applying it

`launchpad.json` (built in 6.4, `shared/src/launchpadSync.ts`):

```
{ "format": "portly-sync", "version": 1, "epoch": "<id>", "horizon": <stamp or 0>,
  "groups":    [{id, name, sort, color, collapsed, updatedAt, placedAt}],
  "bookmarks": [{id, groupId, title, url, sort, iconMode, iconId, letterColor, updatedAt, placedAt}],
  "deleted":   [{kind: "group" | "bookmark", id, at}],
  "icons":     [{id: <UUIDv4>, contentType, sha256, width}],
  "pointers":  {"defaultGroupId": {value, at}, "ungroupedGroupId": {value, at}} }
```

- Rows, tombstones and icons are sorted by id and keys by name (canonical JSON), so the same
  launch pad always gives the same text, and "the merged result differs from the file" (6.5) is
  a text comparison.
- `iconId` is set only for a `custom` icon. Automatic icons are not synced (section 5).
- Caps: groups `MAX_BOOKMARK_GROUPS × 4` and bookmarks `MAX_BOOKMARKS × 4` (removed rows
  included), tombstones the two together, icons `MAX_BOOKMARKS`. Before writing, the writer drops
  tombstones older than 90 days with the rows they removed (raising the horizon), and more of
  the oldest when the file would pass a cap.
- **The merge is pure** (no clock, storage or network): per row the later content and the later
  placement, the newest tombstone, every icon, the later pointer, the higher horizon. It never
  renumbers, creates rows or repairs references.
- **Applying the merged file** to a browser repairs references for that browser only, without
  stamping, so a repair never goes back up: a bookmark whose group is gone shows under "No
  group"; a custom icon that is not listed or failed its checks shows as automatic; a pointer to
  a missing group reads as none (6.5 builds it).

### 6.9 As built (6.5)

- **The store interface.** The engine talks to storage only through `SyncStore`
  (`web/src/static/sync/store.ts`: read and write the main file with a version, read, write and
  delete icons). OneDrive (`providers/graphDrive.ts`) is one implementation, where the version is
  the item's `eTag`; a GitHub gist store is being built alongside (ROADMAP D8). The merge, the
  format and the engine know nothing of OneDrive.
- **The quick check uses the `eTag`, not the `cTag`.** The store keeps the text it last read or
  wrote per page and account, and when the metadata shows the same `eTag` it does not download
  again. An `eTag` also changes when only metadata changes (a rename in OneDrive), which costs one
  download and a merge that changes nothing.
- **Download hosts.** Only `my.microsoftpersonalcontent.com`, the host the spike saw, is allowed
  (store and CSP). `*.files.1drv.com` stays out until a real second sign-in shows it (ROADMAP
  6.5). Whether the download's own `ETag`/`cTag` headers equal Graph's is still unchecked; the
  engine does not rely on them.
- **The "changes waiting" flag** is set by a commit hook in `StaticState`, which also stamps the
  two synced settings when they change. A local change that comes in during a round makes the
  round start again before it applies anything, so the change is never overwritten.
- **Old icon files** are deleted 30 days after the file stopped naming them, by the browser that
  noticed (the store has no listing, so a file nobody noticed stays).

## 7. When it runs

- **Page load:** once the browser backend is up, the account is usable, and any automatic
  re-sign-in has happened.
- **Focus and becoming visible:** a check, skipped when any tab of this site checked in the last
  60 seconds. That time is shared through the sync state.
- **While visible:** a check every 5 minutes. Hidden tabs don't check.
- **After local changes:** a commit that touches the bookmarks or icons slices, or
  `settings.bookmarks`, sets a lasting "changes waiting" flag in the same transaction. A sync
  then starts 5 s after the last such commit, and at most 30 s after the first. `StaticState`
  only reports changes made by other tabs today (`onExternalChange`). It gains a hook that adds
  the flag to any commit touching those slices and tells the sync engine.
- **Coming back online,** when changes are waiting.
- **Closing the page:** nothing is attempted. A write needs a preflight, and a page can't count
  on a request finishing while it closes. Waiting changes go up the next time a Portly tab opens
  in that browser.
- **Tabs take turns** with a Web Lock, `portly-static:<base>:launchpad-sync`, built like
  `withAccountLock`. Scheduled checks ask with `ifAvailable` and skip if another tab is syncing.
  **Sync now** waits for the lock. After a merge, `state.ts` already broadcasts the commit, so the
  other tabs reload the slices and refresh their query cache.
- **Failures back off** like the calendar sync: 15 minutes, doubling up to 6 hours, with
  `Retry-After` honoured. A needed reconnect pauses sync until the account works again. The
  Microsoft sign-in from a web page lasts 24 hours, so sync relies on the automatic renewal at
  page load.

## 8. The file is hostile input

Anyone or anything that can write to the user's OneDrive can change the file: the user by hand,
another app with the same registration, or a script on the shared `<user>.github.io` origin that
reads the token (ARCHITECTURE section 4.1). So the file is checked exactly like an import file
(`parseImportFile()` and `decodeImage()` in `web/src/static/handlers/transfer.ts`):

- **Size first:** the item's `size` from step 1 and a byte cap on the download. The main file is
  capped at `MAX_IMPORT_BYTES` (25 MB), and each icon at `MAX_EMBEDDED_IMAGE_BYTES` (10 MB).
- **Parsing:** UTF-8 decode, BOM stripped, `JSON.parse`, then `assertSafeJson()`, which refuses
  `__proto__`/`constructor`/`prototype` keys and nesting deeper than 64.
- **A strict, versioned zod schema** in `shared/` (`format: 'portly-sync'`, `version: 1`), built
  from the export schemas (`ExportBookmarkGroupSchema`, `ExportBookmarkSchema`) plus the
  timestamps. That brings `SafeHttpUrl`, title and name limits, `HexColor` and integer `sort`,
  plus limits on counts: `MAX_BOOKMARK_GROUPS`, `MAX_BOOKMARKS` and a tombstone cap.
- **A newer version** stops sync in this browser and is never overwritten: "The synced copy was
  written by a newer Portly. Reload the page." An older version is converted after reading.
- **Ids are kept, not regenerated** (unlike import), so they must pass `EntityId`. Icon ids must
  be UUIDv4 before they are used in a Graph path (`launchpad-icons/<uuid>`). No other string
  from the file ever goes into a URL.
- **Icon bytes** are sniffed with `sniffImageType()`. The stored type comes from the bytes,
  never from the file or the headers, and the SHA-256 listed in the file must match.
- **References are repaired, not trusted.** A bookmark in a missing group goes to "No group". A
  custom icon that can't be found shows as automatic in this browser only: the fix isn't stamped,
  so it never goes back up. An icon that fails validation is treated the same way. An icon that
  failed to download for a network reason stops the round instead, to try again later.
- **Graph's answers** (`id`, `eTag`, `cTag`, `size`, download URL) are parsed with zod too. The
  download URL must pass the host check in section 4.
- **A refused file** changes nothing locally and is not overwritten. The service's status line
  shows "The synced copy could not be read" with **Replace it with this browser's launch pad**. A
  Diagnostics event records the reason code.
- **Logs** (section 17) never contain titles, URLs, ids, eTags, download URLs or tokens.

## 9. Hybrid mode

- **A page load that uses the paired server never opens the browser's dataset** (ARCHITECTURE
  section 16), and the sync engine is part of that in-browser backend. So no sync runs on such a
  load, and the server's launch pad isn't synced: the two datasets stay separate, as section 16
  already says.
- A new per-load capability, `launchpadSync`, is true only when `backend === 'browser'`. On a
  server-backend page, the Accounts page shows the service on Microsoft connections as
  unavailable: "This page uses Portly on this PC. Its launch pad isn't synced. Sync runs when the
  site uses this browser's own data." (The connections listed there are the server's, so a
  browser connection with sync on isn't shown on such a load anyway.)
- Changes waiting from an earlier browser-backend load stay flagged and go up at the next such
  load. A switch back to the browser backend (the server went away) syncs like any page load.
- **Later, not in this design:** the server could join the same file. When it signs in with the
  same app registration (`microsoft.md` shows one registration holding both redirect URIs), it
  sees the same app folder. It would need the scope, a drive client behind `safe-fetch.ts` with
  the content hosts in its provider policy, and the merge code from `shared/`.

## 10. The Accounts page, Diagnostics and docs

The Accounts page is in place (pick the services, then sign in; Manage switches them later); sync
adds these pieces to it:
- **In the connection dialog** (the Microsoft tile, or adding a service to a connection): a
  **Launch pad sync** checkbox next to **Calendar**, with one line on what it does and where the
  data goes: "Keeps your launch pad the same in every browser where you turn this on. Stored in
  your OneDrive, in Apps → <app registration name>." Then the permission step (section 3) and,
  after the sign-in, the first-sync choice when needed (6.6).
- **On the connected account's card,** a status line for the service, with details on click:
  - **Last synced**, with when a change last came in and went out;
  - a status: *Up to date*, *Syncing*, *Changes waiting to upload*, *Paused: reconnect the
    account*, *Stopped: written by a newer Portly*, or *Error* with **Open Diagnostics**;
  - **Sync now**;
  - where the folder is: OneDrive → Apps → `<app registration name>`.

  Unticking the service turns sync off in this browser and keeps the local data and the file.
  Removing the connection warns that sync stops.
- **Settings → Bookmarks:** one line, "Synced through <account>" with a link to it, or "Not
  synced" with a link to Accounts, so the feature can be found from the launch pad's side too.
- **Import & export:** the preview warns that an import replaces the launch pad everywhere. The
  backups list shows *Before sync*.
- **Diagnostics:** a new browser event category, `sync` (`CLIENT_EVENT_CATEGORIES` in
  `shared/src/diagnostics.ts`). Allowlisted fields:
  - `trigger`, `outcome`, `phase`, `ms`;
  - `httpStatus` and Graph's error `code`;
  - counts of groups, bookmarks and icons added, changed and removed;
  - bytes down and up.

  Like other browser events, they stay in the browser on a browser-backend page.

**Docs, in the same change as the code:**
- `docs/setup/static-build.md`:
  - *What works*: optional sync on the Launch pad row.
  - *Where your data lives*: a new item. With sync on, groups, bookmark titles and addresses,
    and custom icons are stored as files in the user's OneDrive, which Microsoft can read. Portly
    doesn't encrypt them.
  - *Who sees what*: a new row, "Microsoft OneDrive (`graph.microsoft.com` and the download
    hosts) | Launch pad sync, when turned on | the launch pad file and icons, read on each check
    and written after changes, with the account's access token".
- `docs/setup/microsoft.md`:
  - `Files.ReadWrite.AppFolder` as an optional permission in step 4, used only when the
    **Launch pad sync** service is ticked;
  - in the browser-only section: use the same Application (client) ID in every browser, where
    the folder is and why its name follows the registration, and how to withdraw the permission.
- `docs/ARCHITECTURE.md`:
  - section 1: sync in scope for the browser-only build;
  - section 4.1: the sync file is hostile input, and the shared-origin risk now also covers the
    app folder;
  - section 16: the Pages CSP's `connect-src`, sync only on the browser backend, the
    `launchpadSync` capability, and the sync state in the storage table;
  - section 10.5: the Launch pad sync service on Microsoft connections;
  - section 17: the `sync` events.
- README: one line under the browser-only build.

## 11. Alternatives

| Option | How it works | Why it is not the first choice |
| --- | --- | --- |
| **OneDrive app folder through Graph** (this design) | The page reads and writes a file in the user's OneDrive with the Outlook.com sign-in | Needs an Outlook.com account and the extra permission. The download host and its CORS were checked in the spike (section 13) |
| A file in a OneDrive-synced folder, through the File System Access API | The user picks a file once, and the OneDrive client on each PC syncs it. No sign-in | Chrome and Edge on desktop only. Permission prompts after a restart. No change notice, so it must poll. Two PCs writing at once get OneDrive conflict copies (`launchpad-<PC>.json`) instead of a refused write. Needs the OneDrive client on every PC |
| The extension's `chrome.storage.sync` or `chrome.bookmarks` | The new-tab extension stores the data in the browser's own account sync | `storage.sync` holds 100 KB in all (8 KB per item): too small for 5,000 bookmarks, and no icons. Works only within one browser family and browser account (no Chrome ↔ Edge). The Pages site would need a bridge to the extension (`externally_connectable` for an origin every Pages site of the account shares). The `bookmarks` permission reads and changes all browser bookmarks, with a new install warning. Not every PC has the extension |
| A GitHub gist or private repository, with a fine-grained token | The page reads and writes a file through `api.github.com` | A long-lived secret in browser storage, unencrypted, readable by any script on the shared `<user>.github.io` origin (section 4.1). The user creates and rotates it by hand in every browser |
| Manual export and import | **Settings → Import & export** (works today) | Replaces everything with new ids each time, so it can't merge. Easy to forget |
| A Portly-hosted sync service | - | Ruled out: Portly has no cloud service (README, ARCHITECTURE section 4) |

## 12. Phases and effort

Rough working days for one developer, tests included.

0. **Spike with a real Outlook.com account, ½–1 day. Done: go, see section 13.** It also did the
   localhost half of the real-account test (ROADMAP item 2.1 finishes it on the published
   address). It checked:
   - the sign-in and the 24-hour automatic renewal with the larger scope set, and which scopes
     the token response reports for an account that only asked for calendars;
   - `special/approot` and `$select=@microsoft.graph.downloadUrl` on a path address;
   - the download hosts, their CORS headers, and whether a download URL redirects again;
   - `If-Match` on a simple `PUT` (and `412`), and `conflictBehavior=fail` (and `409`).

   The results filled in section 4. Downloads can be read cross-origin, so the work goes on.
1. **Groundwork in the bookmarks slice, 1–1½ days:** the clock, `placedAt`, lasting tombstones
   written by every removing path, the one-time upgrade, tests.
2. **File format and merge, 2 days:** the schema in `shared/` (so the server could use it later),
   validation reusing the transfer helpers, a pure merge function, and tests that it is
   commutative, idempotent and converges across three simulated PCs. Fixtures in
   `web/src/static/sync/__fixtures__/`.
3. **Drive client and engine, 2–3 days:** `providers/graphDrive.ts`, icons, the eTag loop,
   triggers, the lock, the "changes waiting" flag, backoff and safety backups. Tests with
   `createFakeFetch()`: a `412` race, the first upload's `404`, a hostile file, a newer version,
   an oversized file, a missing file.
4. **Accounts and UI, 2 days:** scopes per service, the consent step, the service's checkbox
   and status line, the first-sync dialog, the Bookmarks pointer, the import warning, the `sync`
   event category and the CSP. This plugs into the Accounts page as it shipped on 2026-10-19: the
   Microsoft tile's connect dialog and the account's row under "Connected accounts".
5. **Docs and a two-browser test, 1 day:** the docs in section 10, then a real test with two
   browsers (or two PCs) on one account.

About 9–11 days in all. Not included: syncing layouts, theme and other settings, and the server
joining the sync.

## 13. Spike results (phase 0)

**Answer: go.** From a page, the spike could:
- sign in with the larger scope set;
- read and write the app folder;
- read the download URLs cross-origin.

**How it was run.** The spike ran on 2026-10-19 with a real Outlook.com account:
- the page was a scratch one, not committed, served on `http://localhost:<port>/`;
- it used the static build's CSP plus the two candidate download hosts, and no CSP violation was
  reported;
- its address was registered as a *Single-page application* redirect URI;
- the browser was the desktop app's Chromium-based browser pane.

The same origin also served a local static build, which connected the account and synced its
calendars (ROADMAP item 2.1 repeats this on the published address).

**Sign-in and scopes.** Only the token response's `scope` field and error codes were read.

| Request | Result |
| --- | --- |
| Interactive sign-in, calendar scopes only | Works. `scope` lists the sign-in scopes, `Calendars.ReadWrite` *and* `Mail.ReadWrite`. The account had granted mail to the same registration through Portly on the PC. `offline_access` isn't listed, although a refresh token comes back. There is no `refresh_token_expires_in`, so the 24-hour default applies. Access tokens are opaque and last an hour |
| `prompt=none` asking for `Files.ReadWrite.AppFolder`, before consent | `consent_required` |
| Refresh of the calendar-only grant, asking for the Files scope | `400 invalid_grant` (`AADSTS70000`), both before and after the consent |
| Interactive sign-in with the Files scope added | Microsoft's screen lists only the new permission ("Have full access to the application's folder"), under the registration's name. `scope` then includes it |
| `prompt=none` with the larger scope set, after consent | Works with no screen, so the automatic renewal can carry the sync scope |
| Refresh of that grant asking for calendar scopes only | Works. `scope` still lists the Files scope |
| A new `prompt=none` sign-in with calendar scopes only, after consent | `scope` lists the Files scope, and the token can read the app folder |
| Refresh of a calendar-only grant made *before* the consent | Still no Files scope. The app folder answers `401` (`unauthenticated`) |

What this means for the design:
- **`scope` reports the account's grants.** The token response lists what the account has granted
  the registration, not what this sign-in asked for. Whether a refresh may ask for the sync scope
  must come from the scopes of the connection's last sign-in (section 3).
- **A grant keeps the scopes it was made with.** A connection signed in before the consent needs
  a new sign-in to get the scope. `graphClient.ts` already turns a second `401` into "reconnect
  needed", and reconnecting with the larger scope set fixes it.
- **A missing scope is a `401`.** Graph answers `401`, not `403`, when a token lacks the scope.

**OneDrive.** All files went in the app folder, and the test files were deleted afterwards.

| Check | Result |
| --- | --- |
| `GET /me/drive/special/approot` | `200`. Creates `Apps/<registration name>` on first use, named after the registration at that moment |
| Metadata of a missing file | `404` (`itemNotFound`) |
| `PUT ...:/content?@microsoft.graph.conflictBehavior=fail` | `201`. The same name again gives `409` (`nameAlreadyExists`). A missing sub-folder is created on the way |
| `?$select=id,eTag,cTag,size,@microsoft.graph.downloadUrl` on a path address | `200`, but with no download URL |
| The same list as `?select=` (no `$`), `$select=...,content.downloadUrl`, no select, and the `PUT` response | All include the download URL. `eTag` and `cTag` match the `PUT`'s |
| Download URL host | `my.microsoftpersonalcontent.com` every time, for the main file and the icon |
| Simple `GET` of the download URL | `200`, CORS allowed, no redirect, and the content matches. It also works with a custom header (which forces a preflight) and a second time. It fails with `credentials: 'include'` |
| `GET .../content` with `Authorization` | The redirect was followed to `my.microsoftpersonalcontent.com`, and the content matches (Chromium) |
| `PUT` with `If-Match`: current `eTag` | `200`. `eTag` and `cTag` change |
| `PUT` with `If-Match`: stale `eTag` | `412` (`notAllowed`). The content is unchanged |
| `PUT` with `If-Match`: current or stale `cTag` | `200` or `412` |
| `PUT` with `If-Match` on a missing file | `201`: the file is created |

**Not covered:**
- **The Pages origin itself.** Its address isn't registered as a redirect URI yet. The CORS
  answers above imply it works.
- **Firefox and Safari.**
- **The static build's own automatic renewal** (`planSilentReauth`). The spike tested the same
  `prompt=none` request.
- **Work or school accounts**, which are out of scope.
- **The download's `ETag` and `cTag` header values.** Whether they equal Graph's wasn't checked.

## Open questions

Answered on 2026-10-20 (section 0): OneDrive through an Outlook.com account, layouts per PC, no
passphrase encryption, *Use the synced launch pad* with no *Combine both*, tombstones kept 90 days,
one connection per browser, and a backup slot of its own. Still open:

- **Should Portly on a PC join the sync later** (section 9), or is the browser-only site enough?
- **The custom domain** (D9): decided again before the sync engine ships.
