# Design: syncing the launch pad of the browser-only site through a GitHub gist

**Status:** the storage backend, its token setting and the CSP are built (2026-10-27); nothing
syncs yet. The sync engine of [launchpad-sync.md](launchpad-sync.md) (ROADMAP 6.1 to 6.5) is being
built at the same time for OneDrive. Hooking the gist backend into it comes after both land.
Nothing sync-related reaches `main` before 0.2.0-alpha.1 is tagged.

**The decision.** [launchpad-sync.md](launchpad-sync.md) section 11 set a gist aside: it needs a
long-lived token, unencrypted in browser storage on the shared `<user>.github.io` origin. On
2026-10-27 the owner asked for gist sync to be built alongside OneDrive anyway, so that a browser
without an Outlook.com account can sync too. The risk is the same as the Todoist token's, and
section 9 says how this design keeps it small. Section 10 compares a private repository, which
would be the better GitHub backend.

The merge, the file format, the triggers and the status line are the engine's and are the same for
both backends. This document covers only what is different: where the files live, how a write is
refused, the token, and the limits. The engine reaches both backends through one interface,
`SyncStore` in `web/src/static/sync/store.ts`.

## 1. What the user sets up

In **Settings → Accounts**, on the browser-only site when its data lives in the browser, a
**GitHub** tile asks for a personal access token. Either kind works:

- **A fine-grained token** (recommended), with one permission: **Account permissions → Gists →
  Read and write**. Repository access can stay at public repositories, and everything else at No
  access. GitHub lists `POST`, `PATCH` and `DELETE /gists` under this permission
  ("Permissions required for fine-grained personal access tokens").
- **A classic token with only the `gist` scope.** Portly reads the token's scopes (the
  `X-OAuth-Scopes` header, which GitHub lets a page read) and refuses a classic token with any
  other scope, such as `repo`. The token sits unencrypted on a shared origin, so it should be able
  to do nothing but gists.

Before saving, Portly checks the token with `GET /gists?per_page=1`. A fine-grained token's
permissions can't be read back, so it is only checked to work; a token without the Gists
permission fails at its first write, and sync then asks for a new one. The token is write-only in
the UI: the page only learns `{configured}`. It is never exported, and **Remove** deletes it from
the browser (the gists stay on GitHub). The tile and the row say that sync isn't switched on yet.

## 2. Where the data lives

Two **secret** gists in the token's account:

| Gist | Files | Description |
| --- | --- | --- |
| Main | `portly-launchpad.json` | `Portly launch pad sync (kept by Portly: do not rename its file)` |
| Icons | `portly-launchpad-icons.txt` (a short note), then `icon-<uuid>.b64` per custom icon | `Portly launch pad icons (kept by Portly: do not rename its files)` |

- **Secret gists are unlisted, not private.** They don't show on the profile or in search, but
  anyone who has a gist's address can read it, with no sign-in. GitHub staff can read them too.
  Portly doesn't encrypt them (the passphrase question of launchpad-sync.md stays open).
- **Found again by file name.** A browser looks through the account's gists
  (`GET /gists`, 100 per page, at most 10 pages) for a secret gist holding the file, and takes the
  oldest if there are several, so every browser picks the same one. Public gists are skipped, and
  a remembered gist that was made public stops sync with an error.
- **Remembered in this browser.** The ids go in the `gist-sync` slice with the token. A deleted
  gist is forgotten and looked for again; saving a different token forgets both ids.
- **Icons live apart** so that uploading an icon doesn't change the main file's version, and a
  check of the main file never downloads icons.
- **Two browsers creating the main gist at once:** each one lists the gists again after creating
  its own. The browser whose gist is newer deletes it again and answers *conflict*, so the engine
  reads the older one and merges. Its own copy is still local, so nothing is lost. If GitHub's list
  lags behind and neither browser sees the other's gist, both keep their own until one is deleted
  by hand. That needs two first syncs in the same second or two.

## 3. Versions and refused writes

GitHub has no conditional write for gists. `PATCH /gists/{id}` documents no `If-Match`, and the
API's ETags are weak (`W/"…"`), which `If-Match` can never match. So the store builds the check
itself:

1. **The version** is the main gist's newest revision, `history[0].version` (a commit SHA). Only a
   write to that gist moves it.
2. **Before writing**, the store reads the gist again (`cache: 'no-store'`, because GitHub sends
   `max-age=60`) and refuses with *conflict* when the revision moved, when the file is missing but
   the engine expected it, or when it exists but the engine expected none.
3. **After writing**, the answer lists the new revision and its parent, `history[1]`. If the
   parent isn't the revision checked in step 2, another browser wrote during that one round trip
   and this write replaced it. The store then reads that browser's revision
   (`GET /gists/{id}/{sha}`), writes its text back and answers *conflict*. The engine reads, merges
   both and writes again, exactly as after a refused write.
4. A `409` from GitHub, or the gist vanishing in between, is also *conflict*. Writing the same text
   again makes no revision and is simply `ok`.

**What is left.** Three browsers writing within the same second can still replace one write. That
write isn't lost for good. Every browser keeps the whole launch pad and the merge is state-based,
so that browser's next check sees a new version, merges its own rows back in and writes them
again. A browser closed right after such a write holds its change until it next opens the site.
If an answer lists no parent at all, the store trusts the write for the same reason.

## 4. Sizes and limits

- The API sends at most **1 MB** of each file (`truncated: true`). The rest comes from the file's
  `raw_url` on `gist.githubusercontent.com`, which serves files up to **10 MB**; bigger ones would
  need a git clone. So the main file is capped at 10 MB (below the engine's 25 MB), and an icon at
  7.5 MB (its base64 text stays under 10 MB).
- `raw_url` names the file's content hash (`/<owner>/<gist id>/raw/<sha>/<file>`), so it never
  serves another version of the file.
- The API lists at most **300 files** of a gist: the icons gist takes 299 icons, and 48 MB of
  icons in all, so one read of it stays bounded. Past that, uploading an icon fails with
  *too large* and the status line asks to remove some custom icons.
- Every answer is read with a byte cap: 16 MB for the main gist, 64 MB for the icons gist, 8 MB
  for a page of the list, the file cap for a raw file.
- **Rate limits:** 5,000 requests an hour for a token, and GitHub's secondary limit on writes
  (about 80 a minute). A check costs one or two requests, so the engine's 5-minute cadence stays far
  below both.

## 5. Icons

Each icon is the base64 text of its bytes in `icon-<uuid>.b64`. Writing is create-only: an icon
already there is left alone. Reading returns the bytes with no type: the engine sniffs them, never
trusting GitHub or the file name. A file that isn't valid base64 reads as missing, which the engine
treats like an icon that failed validation (automatic in this browser only). Deleting removes the
file (`"icon-<uuid>.b64": null`). The icons gist read once is reused for the next reads, because
icons never change, and read again on a miss.

## 6. Errors

| GitHub answers | Store error | The engine |
| --- | --- | --- |
| `401` | `reauth_required` | Pauses sync and asks for a new token |
| `403` with `X-RateLimit-Remaining: 0`, `Retry-After`, or "rate limit" in the message; any `429` | `rate_limited`, with the wait from `Retry-After` or `X-RateLimit-Reset` (60 s by default, at most an hour) | Backs off |
| Any other `403` | `reauth_required` (the token may not change gists) | As `401` |
| `404` on the remembered gist | none: forgotten, then looked for again | Sees a missing file |
| `409` on a write | `conflict` result | Reads and merges again |
| `413`, or a file or answer over its cap | `too_large` | Shows the error |
| `5xx`, other statuses, an answer of the wrong shape | `unavailable` | Backs off |
| Network, CORS or timeout | `network_error` | Backs off |

GitHub exposes `Retry-After` and the `X-RateLimit-*` headers to pages (`Access-Control-Expose-Headers`).
Error messages never carry the token, gist ids or URLs. The page's own abort is passed on as is.

## 7. Network and the content security policy

`connect-src` of the browser-only build gains two origins (`staticCsp()` in `web/vite.config.ts`):

| Source | Why | Checked on 2026-10-27 |
| --- | --- | --- |
| `https://api.github.com` | Every API call | `Access-Control-Allow-Origin: *`; the preflight allows `Authorization`, `Content-Type`, `X-GitHub-Api-Version` and `PATCH`/`DELETE` |
| `https://gist.githubusercontent.com` | `raw_url` of files over 1 MB | `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin` on a public gist's raw file |

Raw files are fetched as simple requests: no `Authorization` or other header, `credentials: 'omit'`,
`referrerPolicy: 'no-referrer'`. Secret gists' raw files need no sign-in. Every API call sends
`cache: 'no-store'`, `credentials: 'omit'`, `redirect: 'error'`, and `X-GitHub-Api-Version:
2022-11-28`. `img-src` doesn't change: icons are shown through `blob:` URLs. The server build's CSP
doesn't change.

## 8. The files are hostile input

Anyone with the token, and anyone who can edit the gists, can change them. So:

- every API answer is parsed with zod, and anything else is *unavailable*;
- gist ids must be letters and digits, revisions 40 or 64 hex characters, and icon ids UUIDv4,
  before any of them goes into a path. A remembered id of another shape is dropped;
- a `raw_url` must be `https://gist.githubusercontent.com/<owner>/<this gist>/raw/<sha>/<this
  file>`, with no port, user, query or fragment, or it is never fetched;
- sizes are checked from GitHub's `size` before a download and again while reading;
- the main file's text goes to the engine unchanged, which checks it like an import file
  (launchpad-sync.md section 8).

## 9. Security trade-offs

- **The token is the risk.** It sits unencrypted in IndexedDB on `<user>.github.io`, which every
  Pages site of the account shares (ARCHITECTURE section 4.1). Any script published on that origin,
  and any browser extension with site access, can read it. A gist token can read, change and delete
  **every** gist of the account, secret ones included. Neither token kind can be limited to one
  gist.
- **What keeps it small:** only the gist permission (broader classic tokens are refused); a
  fine-grained token with an expiry date; the token never in an export, a log or an answer of the
  backend; **Remove** in Settings → Accounts; revoking it on GitHub ends it everywhere. A custom
  domain used only for the site removes the shared-origin part (pages-local-server.md).
- **The data is unlisted, not private.** Anyone who learns a gist's address can read the bookmark
  titles and addresses in it. GitHub can read it too.
- **Compared with OneDrive:** the Microsoft token reaches only the app folder and lasts 24 hours.
  The gist token reaches all gists, lasts until it expires or is revoked, and is pasted by hand into
  every browser.

## 10. A private repository instead

A private repository through the contents API (`GET`/`PUT /repos/{owner}/{repo}/contents/{path}`)
would be the better GitHub backend:

| | Secret gist (built) | Private repository |
| --- | --- | --- |
| Who can read the data | Anyone with the address | Only the account (and those it invites) |
| Refused writes | Emulated (section 3): a three-browser race can replace a write until the next check | Real: `PUT` with the file's `sha` answers `409` when it moved |
| What a stolen token reaches | Every gist of the account | One repository, with a fine-grained token limited to it (Contents: Read and write) |
| Files over 1 MB | A second host, `gist.githubusercontent.com` | The same API, with the raw media type (up to 100 MB) |
| Setup | One token | A private repository, then a token for it |
| Limits | 300 files, 10 MB per file | Comfortable for a launch pad |

**Recommendation:** use a private repository for GitHub sync. The setup costs one more step, but
the data stays private, a write is truly refused, and a leaked token reaches one repository
instead of every gist. The `SyncStore` interface fits it as is, with the file's blob `sha` as the
version. The gist backend is built and can stay as the zero-setup option, or be replaced before
the engine hookup.

## 11. Not built, not tested

- **Not wired up:** no engine calls the store yet. Saving a token syncs nothing, and the UI says so.
- **Not tested against GitHub:** every test uses an in-memory GitHub. A real check needs the owner's
  token. It should cover:
  - creating and finding both gists;
  - a raw read over 1 MB;
  - a forced interleaved write;
  - a 401 after revoking;
  - whether `GET /gists` lists secret gists for a fine-grained token;
  - whether GitHub ever answers `409` on concurrent writes;
  - whether `history` is always in the `PATCH` answer.
- **Not done:** diagnostics events for gist requests (the engine's `sync` events will carry the
  status), and a conditional `GET` (`If-None-Match`, which would not count against the rate limit).
