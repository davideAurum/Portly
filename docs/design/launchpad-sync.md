# Design: syncing the launch pad of the browser-only site through OneDrive

**Status:** proposal, not built. Today the browser-only (GitHub Pages) build keeps everything in
that browser's IndexedDB (`portly-static:<base>`), and the only way to move data between browsers
is export and import. Hybrid mode gives a paired browser the local server's data, but that needs
a server.

**Main idea:** the site writes the launch pad to one file in the user's own OneDrive, in the
folder Microsoft gives each app (`/me/drive/special/approot`). Every browser that turns sync on
reads that file, merges it with its own copy and writes the result back. There is still no
Portly cloud service: the data goes only to a provider the user connects (README, ARCHITECTURE
section 4), with the Outlook.com sign-in the site already has for calendars. Nothing in this
design needs a new dependency.

What it reuses from the Outlook.com calendar support:
- the PKCE sign-in as a single-page app with no secret
  (`web/src/static/providers/microsoftAuth.ts`);
- token refresh under a Web Lock (`getAccessToken` in `web/src/static/handlers/accounts.ts`);
- the Graph error mapping and diagnostics of `providers/graphClient.ts`;
- `https://graph.microsoft.com`, already in the static CSP (`staticCsp()` in `web/vite.config.ts`).

The Outlook.com browser flow has not been tested against a real account yet (ROADMAP phase 1
item 2). Sync depends on it, so the first phase below is a spike that does that test too.

## 1. What the user gets

- In **Settings → Sync** they pick one of the Outlook.com accounts connected in this browser and
  turn sync on. Microsoft asks once for the new permission (section 3).
- Groups, bookmarks and custom icons then follow them to every browser and PC where they open
  the site and turn sync on with the same Microsoft account.
- Changes arrive when a page loads or gets focus, and while it stays open. There is no
  background job: a browser with no Portly tab open does nothing.

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
  - the sync account's id and the clock (6.1);
  - the file's `epoch` and the `eTag`/`cTag` last merged;
  - when this browser last synced and last checked;
  - the "changes waiting" flag (section 7) and the backoff state.

## 3. Permission and consent

**Decision:** request `Files.ReadWrite.AppFolder`, only for the account the user picks for sync.
It reaches the app folder and nothing else in OneDrive. `Files.ReadWrite` (the whole drive) is
not needed and is not requested.

- **Scopes per account.** `MICROSOFT_STATIC_SCOPES` stays the calendar set. A new
  `scopesFor(account)` adds `Files.ReadWrite.AppFolder` when that account is the sync account.
  It is used by `authorizeUrl()`, by the refresh in `accounts.ts` and by the automatic
  `prompt=none` re-sign-in (`planSilentReauth`). Microsoft only accepts a refresh whose scopes
  are the ones of the original sign-in or fewer, so the refresh may not ask for the new scope
  until a sign-in has asked for it.
- **Existing accounts re-consent by reconnecting.** Turning sync on with an account whose
  `grantedScopes` lacks `files.readwrite.appfolder` explains the new permission, then starts the
  normal reconnect (`POST /api/oauth/microsoft/start {accountId, returnTo: '#/settings/sync'}`)
  with the larger scope set. Microsoft asks for the new permission only (incremental consent).
  The existing `different_account` rule applies: signing in as someone else doesn't change the
  account.
- **Accounts used only for calendars never see the prompt.** Their sign-in and refresh requests
  keep today's scopes. One limit: consent is stored per Microsoft account and app registration,
  not per browser. Once any browser has granted it, Microsoft may put the scope into tokens that
  other browsers request for the same account (spike item). This only matters for the account
  the user chose for sync, and the scope still reaches only the app folder.
- **Turning sync off** stops using the scope but doesn't withdraw the consent. The docs will
  explain how to do that at <https://account.live.com/consent/Manage>. Removing the account in
  Settings → Accounts turns sync off.
- **No new shared capability.** `Capability` is a shared contract the server uses too. The sync
  settings record which account is used, and Settings → Accounts reads them to label that card.
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
  (and the `Authorization` header forces one).
- Instead, the app reads the item's `@microsoft.graph.downloadUrl` (with `$select`) and fetches
  that URL itself with no `Authorization` header. The docs say it can be fetched "without a CORS
  preflight request" because it is pre-authenticated. They don't name the CORS headers it sends.
- The host in Microsoft's example is `<random>.files.1drv.com`. Personal accounts on OneDrive's
  newer storage are reported to get URLs on `my.microsoftpersonalcontent.com` instead. Microsoft's
  Graph docs don't mention that host.

The static CSP's `connect-src` would gain:

| Source | Why | Status |
| --- | --- | --- |
| `https://*.files.1drv.com` | Download URLs (Microsoft's documented example) | Docs: host only. CORS: verify in a spike with a real Outlook.com account |
| `https://my.microsoftpersonalcontent.com` (or `https://*.microsoftpersonalcontent.com`) | Download URLs for accounts on the newer storage | Not in the docs: verify in a spike with a real Outlook.com account |
| `https://*.up.1drv.com` | Only if uploads must use an upload session (If-Match, section 6.5) | Not planned: add only if the spike needs it |

- **Before fetching a download URL**, the client checks that it is `https:` with a host from that
  list. Otherwise it refuses, which gives a clearer error than a CSP violation. It fetches with
  `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, no custom headers (a simple request),
  a byte cap and a timeout. The URL carries a short-lived credential: it is never logged or
  stored.
- `img-src` doesn't change: icons are stored as blobs and shown through `blob:` URLs, as now.
- The server build's CSP doesn't change, because sync never runs there.

**Go/no-go:** if no content host answers cross-origin reads from the Pages origin, OneDrive sync
can't work from a page. That is the first thing the spike checks, before any other work.

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
per-PC overrides and is an open question.

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
- **A tombstone beats a row whose two timestamps are both older.** A bookmark edited on another
  PC *after* the delete survives. If its group was deleted, it moves to the "No group" group,
  which is created if needed.
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
- **Two "No group" groups** (two browsers each made one before they first synced): the one whose
  id sorts first stays, and the other's bookmarks move into it. The same applies to the default
  group.

### 6.5 Writing the file: eTag and If-Match

One sync round, under the sync lock (section 7):

1. Read the file's metadata:
   `GET /me/drive/special/approot:/launchpad.json?$select=id,eTag,cTag,size,@microsoft.graph.downloadUrl`.
   A `404` means there is no file yet.
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

**To verify in the spike:** Microsoft documents `if-match` → `412` for update, delete and upload
sessions, but the current page for the simple upload (`PUT .../content`) lists only
`Authorization` and `Content-Type`, so check that it works there. Also check
`conflictBehavior=fail` as a query parameter on a simple upload, and
`$select=@microsoft.graph.downloadUrl` on a path address. If `If-Match` is ignored on a simple
upload, the fallback is an upload session with `if-match`. That needs `*.up.1drv.com` (or the
newer host) in `connect-src`.

Old icon files: any browser may delete an icon file that the main file no longer references and
that is more than 30 days old.

### 6.6 First sync in a browser, and a missing file

- **Nothing to choose** when either side is empty. An empty browser takes the file, and a
  browser with no file uploads its own launch pad.
- **Both have data:** a dialog with three choices. This matters because two browsers filled by
  export/import hold the same bookmarks under different ids, so a plain merge would double
  everything.
  1. **Use the synced launch pad** (recommended): this browser's groups and bookmarks are
     replaced, after a backup.
  2. **Combine both:** groups with the same name become one, and bookmarks with the same URL in
     the same group become one (the synced ids win). Everything else is added.
  3. **Replace the synced launch pad with this browser's:** the file is rewritten with a new
     `epoch`. Other browsers see the new epoch, take a backup, and handle it like a browser past
     the horizon (6.3). Rows they changed since their last sync stay; everything else follows
     the new file.
- **The file disappeared** (the user deleted the folder) after this browser had synced: it is
  treated as empty, never as "everything was deleted". The browser uploads its launch pad again
  and Settings says so.

### 6.7 Import and safety backups

- **A config import with sync on replaces the launch pad in every synced browser.** It writes
  tombstones for every old row. The import preview says so.
- **A merge that removes 10 or more rows (or a quarter of them), adopts a new epoch, or replaces
  this browser's launch pad on first sync takes a backup first.** It uses the existing backup
  store: the `backups` slice and `backup:<id>` documents, listed in Settings → Import & export
  and imported like any export file. `BackupEntry` gains an optional `reason`
  (`import` | `sync`), so the list can say "Before sync". There are 3 backups in all
  (`MAX_BACKUPS`); whether sync gets its own slot is an open question.

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
- **A refused file** changes nothing locally and is not overwritten. Settings shows "The synced
  copy could not be read" with **Replace it with this browser's launch pad**. A Diagnostics event
  records the reason code.
- **Logs** (section 17) never contain titles, URLs, ids, eTags, download URLs or tokens.

## 9. Hybrid mode

- **A page load that uses the paired server never opens the browser's dataset** (ARCHITECTURE
  section 16), and the sync engine is part of that in-browser backend. So no sync runs on such a
  load, and the server's launch pad isn't synced: the two datasets stay separate, as section 16
  already says.
- A new per-load capability, `launchpadSync`, is true only when `backend === 'browser'`.
  **Settings → Sync** still shows on every backend (the rule in section 16). On the server
  backend it says: "This page uses Portly on this PC. Its launch pad isn't synced. Sync runs when
  the site uses this browser's own data."
- Changes waiting from an earlier browser-backend load stay flagged and go up at the next such
  load. A switch back to the browser backend (the server went away) syncs like any page load.
- **Later, not in this design:** the server could join the same file. When it signs in with the
  same app registration (`microsoft.md` shows one registration holding both redirect URIs), it
  sees the same app folder. It would need the scope, a drive client behind `safe-fetch.ts` with
  the content hosts in its provider policy, and the merge code from `shared/`.

## 10. Settings, Diagnostics and docs

**Settings → Sync** (`#/settings/sync`, a new section between Import & export and Diagnostics):
- Off: what sync does and where the data goes, an account picker (the Outlook.com accounts in
  this browser, or a link to **Accounts** when there are none) and **Turn on sync**. Then the
  permission step (section 3) and, if needed, the first-sync choice (6.6).
- On, it shows:
  - the account;
  - **Last synced**, with when a change last came in and went out;
  - a status: *Up to date*, *Syncing*, *Changes waiting to upload*, *Paused: reconnect the
    account*, *Stopped: written by a newer Portly*, or *Error* with **Open Diagnostics**;
  - **Sync now** and **Turn off sync in this browser** (which keeps the local data and the
    file);
  - where the folder is: OneDrive → Apps → `<app registration name>`.
- Elsewhere:
  - **Accounts:** the sync account's card says it is also used for sync, and removing it warns
    that sync turns off.
  - **Import & export:** the preview warns that an import replaces the launch pad everywhere.
    The backups list shows *Before sync*.
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
  - `Files.ReadWrite.AppFolder` as an optional permission in step 4;
  - in the browser-only section: use the same Application (client) ID in every browser, where
    the folder is and why its name follows the registration, and how to withdraw the permission.
- `docs/ARCHITECTURE.md`:
  - section 1: sync in scope for the browser-only build;
  - section 4.1: the sync file is hostile input, and the shared-origin risk now also covers the
    app folder;
  - section 16: the Pages CSP's `connect-src`, sync only on the browser backend, the
    `launchpadSync` capability, and the sync state in the storage table;
  - section 10.5: the new settings section;
  - section 17: the `sync` events.
- README: one line under the browser-only build.

## 11. Alternatives

| Option | How it works | Why it is not the first choice |
| --- | --- | --- |
| **OneDrive app folder through Graph** (this design) | The page reads and writes a file in the user's OneDrive with the Outlook.com sign-in | Needs an Outlook.com account and the extra permission. The download host and its CORS still need checking in a spike |
| A file in a OneDrive-synced folder, through the File System Access API | The user picks a file once, and the OneDrive client on each PC syncs it. No sign-in | Chrome and Edge on desktop only. Permission prompts after a restart. No change notice, so it must poll. Two PCs writing at once get OneDrive conflict copies (`launchpad-<PC>.json`) instead of a refused write. Needs the OneDrive client on every PC |
| The extension's `chrome.storage.sync` or `chrome.bookmarks` | The new-tab extension stores the data in the browser's own account sync | `storage.sync` holds 100 KB in all (8 KB per item): too small for 5,000 bookmarks, and no icons. Works only within one browser family and browser account (no Chrome ↔ Edge). The Pages site would need a bridge to the extension (`externally_connectable` for an origin every Pages site of the account shares). The `bookmarks` permission reads and changes all browser bookmarks, with a new install warning. Not every PC has the extension |
| A GitHub gist or private repository, with a fine-grained token | The page reads and writes a file through `api.github.com` | A long-lived secret in browser storage, unencrypted, readable by any script on the shared `<user>.github.io` origin (section 4.1). The user creates and rotates it by hand in every browser |
| Manual export and import | **Settings → Import & export** (works today) | Replaces everything with new ids each time, so it can't merge. Easy to forget |
| A Portly-hosted sync service | - | Ruled out: Portly has no cloud service (README, ARCHITECTURE section 4) |

## 12. Phases and effort

Rough working days for one developer, tests included.

0. **Spike with a real Outlook.com account, ½–1 day** (on a throwaway branch; it also does the
   real-account test of ROADMAP phase 1 item 2). Check:
   - the sign-in and the 24-hour automatic renewal with the larger scope set, and which scopes
     the token response reports for an account that only asked for calendars;
   - `special/approot` and `$select=@microsoft.graph.downloadUrl` on a path address;
   - the download hosts, their CORS headers, and whether a download URL redirects again;
   - `If-Match` on a simple `PUT` (and `412`), and `conflictBehavior=fail` (and `409`).

   The results fill in section 4. If downloads can't be read cross-origin, stop here.
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
4. **Accounts and UI, 2 days:** scopes per account, the consent step, Settings → Sync, the
   first-sync dialog, the import warning, the Accounts card, the `sync` event category and the
   CSP.
5. **Docs and a two-browser test, 1 day:** the docs in section 10, then a real test with two
   browsers (or two PCs) on one account.

About 9–11 days in all. Not included: syncing layouts, theme and other settings, and the server
joining the sync.

## Open questions

- **Is OneDrive through an Outlook.com account acceptable as the only sync for now?** Browsers
  without one keep export and import.
- **Should layouts and the launch pad's display settings sync later,** or stay per PC as
  proposed?
- **Encrypt the file with a passphrase?** As proposed, bookmark titles and URLs sit unencrypted
  in OneDrive, where Microsoft can read them. Encryption in the browser (Web Crypto) is possible,
  but every browser then needs the passphrase, and a lost passphrase means starting again.
- **Should Portly on a PC join the sync later** (section 9), or is the browser-only site enough?
- **The first-sync default:** "Use the synced launch pad", and is "Combine both" with matching
  by group name and URL worth having?
- **Tombstones kept 90 days:** long enough for a PC that is rarely used?
- **A sync-only connection without calendar permission?** As proposed, sync adds its scope to an
  account that also has the calendar permission.
- **Safety backups:** share the 3 backup slots with imports, or keep one slot for sync?
