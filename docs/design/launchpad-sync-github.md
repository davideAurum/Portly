# Design: syncing the launch pad of the browser-only site through a private GitHub repository

**Status:** the storage backend, its setting and the CSP are built (2026-10-27), and the sync
engine of [launchpad-sync.md](launchpad-sync.md) (ROADMAP 6.1 to 6.5) uses it (G.3): a browser whose
only sync connection is the GitHub repository syncs with it, and the GitHub row shows the status
line, **Sync now** and the first-sync question (ROADMAP 6.6). Nothing sync-related reaches `main`
before 0.2.0-alpha.1 is tagged.

**The decision.** [launchpad-sync.md](launchpad-sync.md) section 11 set GitHub aside: it needs a
long-lived token, unencrypted in browser storage on the shared `<user>.github.io` origin. On
2026-10-27 the owner asked for a GitHub backend beside OneDrive anyway, so that a browser without
an Outlook.com account can sync too. It was first built on secret gists; the same day the owner
chose a private repository instead (section 10 says why). The token risk is the same as the
Todoist token's, and section 9 says how this design keeps it small.

The merge, the file format, the triggers and the status line are the engine's and are the same for
both backends. This document covers only what is different: where the files live, how a write is
refused, the token, and the limits. The engine reaches both backends through one interface,
`SyncStore` in `web/src/static/sync/store.ts`; this one is `kind: 'github'`
(`web/src/static/providers/githubRepo.ts`).

## 1. What the user sets up

On GitHub, by hand (Portly never creates, renames or deletes repositories):

1. **An empty private repository**, for example `portly-sync`.
2. **A fine-grained personal access token** with **Repository access → Only select repositories**
   set to that one repository, and **Repository permissions → Contents → Read and write**
   (Metadata: Read is added by GitHub). Everything else stays at No access. No Administration
   permission is needed. An expiry date is recommended.

Then in **Settings → Accounts**, on the browser-only site when its data lives in the browser, the
**GitHub** tile asks for the repository as `owner/name` and the token. Both are write-only: the
page only learns `{configured}`, never the token or the repository name. Neither is exported.
**Remove** deletes both from the browser and stops sync; the repository stays on GitHub with its
history. The row shows the launch pad sync status line once they are saved.

**One sync connection per browser** ([launchpad-sync.md](launchpad-sync.md) section 6.10): GitHub
syncs only while no Microsoft connection has the Launch pad sync service on. The GitHub form says
which connection syncs and does not save (the route refuses with `409 conflict` too), and the
Microsoft service switch is disabled while GitHub syncs. If both are set up anyway, nothing syncs
until one is removed.

**Checks before saving:**

- `owner/name` must be a valid GitHub login (letters, digits, single inner hyphens, at most 39) and
  repository name (letters, digits, `.`, `_`, `-`, at most 100, not `.`, `..` or ending in `.git`).
  Nothing else is accepted, not even a pasted URL.
- **Classic tokens are refused.** The only classic scope that reaches a private repository, `repo`,
  reaches every repository of the account.
- `GET /repos/{owner}/{name}` must find the repository and say `private: true`.
- `GET …/contents/launchpad.json` must answer `200` or `404`. A `403` means the token lacks
  Contents.

A fine-grained token's permissions can't be read back, and write access can't be checked without
writing. A token with Contents: Read only fails at its first write, and sync then asks for a new one.

## 2. Where the data lives

On the repository's default branch:

| Path | What |
| --- | --- |
| `launchpad.json` | The main file (the engine's text, UTF-8) |
| `launchpad-icons/<uuid>` | One file per custom icon, its raw bytes |

- **Private.** Only the account (and anyone it invites) can read it. GitHub can read it too.
  Portly doesn't encrypt it (the passphrase question of launchpad-sync.md stays open).
- **Every write is a commit.** Commit messages are fixed (`Portly: update the launch pad`,
  `Portly: add a launch pad icon`, `Portly: remove a launch pad icon`) and say nothing about the
  content. **The repository's history keeps every old launch pad, removed bookmarks included, until
  the user deletes the repository.** Deleting and recreating it (then saving it again in Settings)
  starts with a clean history; the next sync writes the current launch pad back.
- **The repository is checked once per store** (each page load): it must exist for the token and be
  private. A repository made public later stops sync with an error asking to make it private again.

## 3. Versions and refused writes

A file's version is its **blob `sha`**, a hash of its content. The contents API checks it:

| Request | GitHub answers |
| --- | --- |
| `PUT …/contents/launchpad.json` with `sha` = the current one | `200`, the new file `sha` |
| `PUT` with no `sha` while the file is missing | `201`, the new `sha` |
| `PUT` with a stale `sha` | `409` |
| `PUT` with no `sha` while the file exists, or a `sha` while it is missing | `422` |
| `PUT` while another write to the branch is in flight | `409` ("the concurrent requests will conflict", GitHub's docs) |

`writeMain(text, ifVersion)` sends `ifVersion` as `sha` (none to create) and maps:

- `200`/`201` → `ok` with the new `sha`;
- `409` → *conflict*. When the cause was another write in flight, the engine re-reads, finds the
  same version and writes again: harmless;
- `422` or `404` → the store reads the file's current `sha`. If it differs from `ifVersion` (or the
  file appeared or vanished), *conflict*; otherwise the refusal was something else and is an error.

Because the version is a content hash, a file changed and changed back has its old `sha` again, and
a write based on it is accepted. That is right for a state-based merge: the content is the one the
engine merged from.

Unlike the first gist design, nothing is emulated: GitHub refuses the write itself, so no race
window is left.

## 4. Reads and the "nothing changed" path

`GET …/contents/{path}` returns the file's `sha`, `size` and, up to **1 MB**, its content as base64
(with a line break every 60 characters). Bigger files come back with `content: ""` and
`encoding: "none"`; the store then reads `GET …/git/blobs/{sha}` (base64 JSON, up to 100 MB). Both
are on `api.github.com`, so the page never follows `download_url` (on `raw.githubusercontent.com`,
whose links for private files carry a token) and needs no other origin. A blob must carry the
`sha` asked for and decode to the `size` listed.

The contents `ETag` is the blob `sha` (`"<sha>"`, checked on 2026-10-27). The store keeps the main
file's text and `ETag` from its last read or write (per page load, like the OneDrive store) and
sends `If-None-Match`. An unchanged file answers **`304`**, which costs no rate limit, and the kept
text is returned. After its own write the store knows the text and new `sha` but no `ETag`; the
next read is a `200` whose `sha` matches, so the content isn't decoded or fetched again.

Requests use `cache: 'no-store'` because GitHub sends `max-age=60`; with a caller's
`If-None-Match` the browser passes the `304` through.

## 5. Sizes and limits

- The engine's caps apply unchanged: 25 MB for the main file, 10 MB for an icon. The blob API serves
  up to 100 MB, so GitHub doesn't lower them.
- Every answer is read with a byte cap: 4 MB for a contents answer (1 MB inline as base64), the
  base64 size of the cap plus line breaks for a blob, 256 KB for a write answer.
- Uploads of the largest files get 120 s instead of 30 s.
- **Rate limits:** 5,000 requests an hour for a token, and GitHub's secondary limit on writes
  (about 80 a minute, 500 an hour). An unchanged check is one `304`; the engine's 5-minute cadence
  stays far below both.
- **History size:** each changed launch pad adds one compressed copy. GitHub recommends keeping
  repositories under 1 GB, far beyond years of launch pad edits; recreating the repository resets it.

## 6. Icons

`writeIcon` puts `launchpad-icons/<uuid>` with no `sha`: create-only. A `422` means the file
exists (the store confirms with a read), and an icon id is never written twice, so it is left
alone. A `409` (another write in flight) is tried again after a pause (750 ms, then 1.5 s),
three attempts in all. The engine should still send one write at a time per store.

`readIcon` returns the bytes with no type: the engine sniffs them, never trusting GitHub or the
name. A path that is a folder, base64 that doesn't decode, or bytes of the wrong size read as
missing, which the engine treats like an icon that failed validation (automatic in this browser
only). `deleteIcon` reads the `sha` and deletes with it; a `409` or `422` reads the `sha` again
and retries, three attempts in all; a file already gone is done.

## 7. Errors

| GitHub answers | Store error | The engine |
| --- | --- | --- |
| `401` | `reauth_required` | Pauses sync and asks for a new token |
| `403` with `X-RateLimit-Remaining: 0`, `Retry-After`, or "rate limit" in the message; any `429` | `rate_limited`, with the wait from `Retry-After` or `X-RateLimit-Reset` (60 s by default, at most an hour) | Backs off |
| Any other `403` | `reauth_required` (the token may not change the repository) | As `401` |
| `404` on the repository | `reauth_required` (gone, or the token can't see it) | As `401` |
| The repository is public | `reauth_required` | As `401` |
| `404` on a file | none: a missing file (`readMain` → null) | Creates it |
| `409`, or `422` with the file moved | `conflict` result | Reads and merges again |
| `413`, or a file or answer over its cap | `too_large` | Shows the error |
| `5xx`, other statuses, an answer of the wrong shape | `unavailable` | Backs off |
| Network, CORS or timeout | `network_error` | Backs off |

GitHub exposes `ETag`, `Retry-After` and the `X-RateLimit-*` headers to pages
(`Access-Control-Expose-Headers`). Error messages never carry the token, the repository name or
URLs. The page's own abort is passed on as is.

## 8. Network and the content security policy

`connect-src` of the browser-only build gains one origin (`staticCsp()` in `web/vite.config.ts`):
`https://api.github.com`. Checked on 2026-10-27: `Access-Control-Allow-Origin: *`; the preflight
allows `Authorization`, `Content-Type`, `If-None-Match`, `X-GitHub-Api-Version` and
`PUT`/`DELETE`. Every call sends `cache: 'no-store'`, `credentials: 'omit'`, `redirect: 'error'`,
`referrerPolicy: 'no-referrer'` and `X-GitHub-Api-Version: 2022-11-28`. `img-src` doesn't change:
icons are shown through `blob:` URLs. The server build's CSP doesn't change.

## 9. The files are hostile input

Anyone with the token, and anyone with write access to the repository, can change the files. So:

- every API answer is parsed with zod, and anything else is *unavailable*;
- the repository's owner and name are checked when saved and again when the store is made, icon
  ids must be UUIDv4 and versions 40 or 64 hex characters, before any of them goes into a path;
- sizes are checked from GitHub's `size` before a download and again while reading;
- the main file must be valid UTF-8; its text goes to the engine unchanged, which checks it like an
  import file (launchpad-sync.md section 8).

## 10. Why not secret gists

The first version (built and reviewed on this branch before the switch) kept the data in two
secret gists. The owner chose the repository on 2026-10-27:

| | Secret gist (dropped) | Private repository (built) |
| --- | --- | --- |
| Who can read the data | Anyone with the address (unlisted, not private) | Only the account (and those it invites) |
| Refused writes | Emulated: check, write, repair; a three-browser race could replace a write until the next check | Real: `409`/`422` from GitHub |
| What a stolen token reaches | Every gist of the account | One repository |
| Files over 1 MB | A second host, `gist.githubusercontent.com` | The same API (blob API) |
| Setup | One token | A private repository, then a token for it |
| Limits | 300 files, 10 MB per file | The engine's caps |
| Old versions | Gist revisions | Commits (section 2) |

## 11. Security trade-offs

- **The token is the risk.** It sits unencrypted in IndexedDB on `<user>.github.io`, which every
  Pages site of the account shares (ARCHITECTURE section 4.1). Any script published on that origin,
  and any browser extension with site access, can read it. With the setup of section 1 it reaches
  one repository's contents, and nothing else of the account.
- **What keeps it small:** fine-grained tokens only, limited to the sync repository, with an expiry
  date; the token never in an export, a log or an answer of the backend; **Remove** in Settings →
  Accounts; revoking it on GitHub ends it everywhere. Portly can't check that the token is limited
  to one repository, so the setup steps say so plainly. A custom domain used only for the site
  removes the shared-origin part (pages-local-server.md).
- **The history keeps old data.** Removing a bookmark doesn't remove it from earlier commits.
- **Compared with OneDrive:** the Microsoft token reaches only the app folder and lasts 24 hours.
  The GitHub token reaches one repository, lasts until it expires or is revoked, and is pasted by
  hand into every browser.

## 12. Not built, not tested

- **Engine and UI tests only:** the engine against the in-memory GitHub
  (`web/src/static/sync/github.test.ts`), the GitHub row's status line and first-sync question with
  mocked answers (`LaunchpadSync.test.tsx`).
- **Not tested against GitHub:** every test uses an in-memory GitHub. A real check needs the owner's
  repository and token. It should cover:
  - saving the settings (private repository accepted, a public one and a classic token refused);
  - creating `launchpad.json` in the empty repository, then a `304` on the next check;
  - a stale `sha` (`409`), a missing `sha` on an existing file (`422`), and a `sha` on a missing
    file (assumed `422`; `404` is handled too);
  - two writes to the branch at once (`409`);
  - a read over 1 MB through the blob API;
  - an icon write, read and delete;
  - a 401 after revoking, a 403 with a Contents: Read only token.
- **Not done:** diagnostics events for GitHub requests (the engine's `sync` events will carry the
  status).
