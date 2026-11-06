# Design: an Update button in Settings

**Status:** built, released in 0.2.0-alpha.8, and never run for real (section 14). ARCHITECTURE sections 4,
12, 18 and 20 are the binding text, and this document the design and its history. The assessment this grew beside, with its alternatives and
test evidence, is [remote-update.md](remote-update.md).

**Main idea:** Settings → About shows when a newer release exists, on every page. **Update** itself
is on Portly's own page, on the main PC or on an approved PC; the Pages site links there. The
server never installs anything itself. It asks Windows to run a second scheduled task, **Portly
Updater**, whose command is fixed when Portly is installed. That task runs the same `portly
--update` as the terminal, with its backup and rollback, so the update survives the server being
stopped. A request can only start it: it cannot choose what runs, where it comes from or which
version it installs.

## 1. What the user sees

A new **Updates** card in Settings → About. It asks the server when the page opens, and shows one
of these:

| State | Shown | Action |
| --- | --- | --- |
| Checking | "Checking for updates" | - |
| Up to date | "Portly 0.2.0-alpha.8 is the latest release" | **Check again** |
| Update available | "Portly 0.2.0-alpha.9 is available", with a link to its release notes | **Update** on Portly's own page; **Open Portly's own page** on the Pages site |
| Running | The step: downloading, installing, restarting | - |
| Finished | "Updated to 0.2.0-alpha.9", plus the extension note below when it applies | - |
| Failed | What happened in one line, and "Portly is still on 0.2.0-alpha.8" | **Try again** |
| Rolled back | "0.2.0-alpha.9 did not start, so Portly went back to 0.2.0-alpha.8. Your data was restored from the copy made before the update." | - |
| Could not check | "Could not reach GitHub" | **Check again** |
| Not available | A Git checkout: "This is a Git checkout. Use `portly --rebuild`." Not started by the task: "Portly was not started by its scheduled task. Use `portly --update` on the main PC." The updater task is missing: "The updater is not set up. Run `portly --update --force` on the main PC." | - |

**Update** opens a confirmation first: "Portly will stop for about a minute while it updates, on
every PC using it. Your data is copied first." Another PC's wording adds "If it does not come
back, you will need to fix it on the main PC."

The card is hidden on the browser-only site, which has no server, and when `GET /api/update`
answers 403 or 404, because a newer Pages site can talk to an older server: the gate refuses an
unknown route from the Pages site with 403 `local_only`.

**Where Update is.** Portly's own page is the one the server serves: `http://localhost:<port>` on
the main PC, the Tailscale address on another PC.

| Page | Shows | Starts an update |
| --- | --- | --- |
| Portly's own page, main PC | The card | Yes |
| Portly's own page, another PC | The card | Yes, with its device cookie |
| Pages site, main PC or another PC | The card's state, with a link to Portly's own page | No: the server refuses it |

The link goes to `<appUrl>#/settings/about` on the main PC and `<remoteOrigin>/#/settings/about` on
another PC. Section 7 says why. So `#/settings/about` joins the routes that never forward to the
Pages site (`web/src/app/pagesForward.ts`).

**One more connect.** A PC connected through the Pages site holds a device secret in that site's
storage, not the cookie Portly's own page needs. The first time it follows the link, it gets the
connect screen and is approved on the main PC once, as a second device entry.

**The extension.** When the new version carries another extension version, the Finished state adds:
"Click Reload on Portly New Tab in chrome://extensions on the main PC." Nothing here can do that
step, the same as today.

## 2. How the update starts, and why this way

An update stops the server and supervisor and renames the folder they run from, so whatever does
the work must not be one of their children.

| Option | Verdict |
| --- | --- |
| **A second scheduled task, started with `schtasks /run`** | **Chosen.** The Task Scheduler service creates the process, so it belongs to neither the server nor the supervisor. The native host already starts the server this way (ARCHITECTURE section 12), for the same reason. The command is stored in the task, outside anything a request can reach. |
| Server spawns `install.ps1` as a detached process | Rejected. The server runs inside the job object libuv gives the supervisor (`supervisor.ts`), and `install.ps1` stops the supervisor, which closes that job. Whether a detached child escapes depends on libuv's job flags, not on anything Portly controls. It also means the server builds a command line. |
| Supervisor runs it over IPC | Rejected. `install.ps1` stops the supervisor, so the same problem applies. |
| The native host | Rejected. It only exists through a browser on the main PC, so it cannot serve another PC. |
| A flag file read at the next start | Rejected. The running version would have to replace itself, and nothing would report back. |

## 3. The Portly Updater task

`install-autostart.ps1` registers it in a release install only (`Get-HbReleaseInfo`), next to
**Portly Server**:

| Setting | Value |
| --- | --- |
| Name | `\Portly Updater` |
| Trigger | None: on demand only |
| Action | `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install folder>\app\scripts\portly.ps1" --update --unattended` |
| Working directory | `%LOCALAPPDATA%`, never `app`, or the folder could not be renamed. Not `%TEMP%`, which can differ between sessions and so make the definition look changed |
| Principal | Current user, `LogonType Interactive`, `RunLevel Limited` |
| Settings | Starts on battery and keeps running, `MultipleInstances IgnoreNew`, on-demand runs allowed, no restarts, 15 minute limit |

- **The time limit** only matters for a stuck download: `Invoke-InstDownload` has no timeout today,
  and the swap itself takes seconds. It must stay below the server's 20-minute limit for a run that
  went quiet, or a run reported as dead could still hold the task, and `schtasks /run` would then
  report success while `IgnoreNew` drops the new run. The download should get its own timeout too.
- **Running from `app`** is safe, because that is what `portly --update` in a terminal already
  does: `portly.ps1` copies `install.ps1` to a temporary folder and runs it from there.
- **Re-registering.** `install.ps1` calls `install-autostart.ps1` while this task is running. It
  compares the definition and leaves the task alone when nothing changed, and it never replaces a
  running task, because what that does is unknown. A changed definition therefore arrives with the
  next update.
- `uninstall-autostart.ps1` removes it, and `status.ps1` shows it. In a Git checkout it does not
  exist, so nothing there changes.

The first button-driven update therefore uses the **old** version's `install.ps1`, as `portly
--update` does. The version that adds the button must itself be installed with `portly --update`.

## 4. API

New module `server/src/modules/update`, schemas in `shared/src/update.ts`. `GET` is `paired()`, so
every page can show the state. `POST` is `ownPage()`, a new access level: Portly's own page on this
PC, and a device with its cookie on the remote origin, never the Pages site on any PC. Section 7
explains why.

**`GET /api/update`** →

```ts
{
  availability: 'ready' | 'checkout' | 'unsupervised' | 'no-task',
  installed: string,
  latest: string | null,       // null until a check has worked
  updateAvailable: boolean,
  notesUrl: string | null,     // the latest release's page, built by the server
  checkedAt: string | null,
  checkFailed: boolean,
  run: UpdateRun | null,       // section 5
}
```

The server makes the outbound check only when its cached answer is more than an hour old. `?refresh=1`
(**Check again**) ignores that, at most once a minute. There is no background job: nothing leaves
the PC unless someone opens the card.

**`POST /api/update {version}`** [`ownPage()`] → 202 with the `run`. `version` is what the user was
shown:

1. `availability` must be `ready`, else 409 `conflict`.
2. A run already in progress answers 202 with that run, so a second click or another PC changes
   nothing.
3. The server checks GitHub again, past the hourly cache but not past the once-a-minute limit, so
   repeated POSTs cannot use up GitHub's limit for this address: 502 `provider_error` when that
   fails. `version` must equal the latest release and be newer than the installed one, else 409
   `conflict` (the card refreshes). This is a guard on the click only. The task does not receive
   the version.
4. It writes the `requested` status (section 5), then runs `schtasks.exe /run /tn "\Portly Updater"`
   by its absolute path, with an argument array and no shell, as `native-host/launcher.mjs` does.
   When Windows refuses, the run becomes `failed` / `unknown` and the answer is 409 `conflict`.

**The outbound check.** `GET https://api.github.com/repos/<releaseRepo>/releases/latest` through
`safeFetch` with `policy: 'provider'`. This answers directly, where the `github.com/.../latest/download`
address goes through two redirects to another host. The answer is hostile: only `tag_name` is
read, and it must match `install.ps1`'s version pattern after its `v`. The release notes link is
built from `releaseRepo` and the version, never taken from the answer. `releaseRepo` comes from
`release.json`, read once at start-up by a new `lib/install-info.ts`, and is checked against
`install.ps1`'s `owner/name` pattern.

**Availability** needs all of: `release.json` beside the running server, in a folder named `app`
(else `checkout`); `PORTLY_SUPERVISED=1` (else `unsupervised`); and the task found by `schtasks
/query` (else `no-task`). That lookup starts a process, so concurrent callers share one, at most
one a minute, until the task is found. The supervised check matters: a test package started from
a temporary folder by `check-release.ps1` is unsupervised, so it can never reach the real task.

**Comparing versions** follows semver precedence, numbers as numbers, so `alpha.10` is newer than
`alpha.9`. It lives in `shared/src/version.ts` and again in `install.ps1`, which is self-contained, with one set
of test vectors for both. A version that cannot be parsed never counts as newer.

## 5. Reporting progress

The server is gone for the part of the update people care about, so the installer writes
`<data folder>\update-status.json`, replaced in one step (write, then rename):

```ts
{
  id: string,
  state: 'requested' | 'downloading' | 'installing' | 'restarting' | 'done' | 'failed' | 'rolled-back',
  from: string,
  to: string | null,
  startedAt: string,
  finishedAt: string | null,
  code: 'download_failed' | 'checksum_mismatch' | 'file_in_use' | 'not_newer' | 'did_not_start' | 'unknown' | null,
  extensionChanged: boolean,
}
```

- **Closed values only, no free text:** installer messages hold paths with the user's name in them,
  and this file reaches other PCs. `code` maps to wording in the web app.
- The server parses the file with zod, and treats anything invalid as no run.
- A `requested` file with no progress after 2 minutes is reported as `failed` / `unknown` (the task
  never started). Any other unfinished state is reported the same way 20 minutes after it started.
  This is worked out when the file is read, and the file is never rewritten.
- A run that went quiet counts as `done` instead when this server already runs its `to` version:
  the installer got there and died before saying so, or a terminal update finished the job.
- A finished run is reported for 24 hours, and a run that went quiet counts as finished at its
  limit, so a dead run doesn't stay on the card for ever.
- **The full output** goes to `<data folder>\logs\update.log`, replaced on each run, with the home
  folder masked so it follows the logging rules. It is not added to the server's log views.

## 6. While the server is away

Only Portly's own page starts an update, so only it follows one. That page never changes backend:
the 45-second switch to the browser's own copy (`GRACE_MS`, ARCHITECTURE section 16) belongs to the
Pages site. Once a run is active, the card polls `GET /api/update` every 2 seconds, and on another
PC Tailscale answers with an error while the server is down:

1. **Answering, run still active:** show the step.
2. **Not answering:** show "Restarting Portly". The existing "isn't reachable" banner is expected
   here, so the card says this is normal.
3. **Answering, run finished:** show the result, then reload the page after 3 seconds on `done`,
   so the page matches the server. Only on a change from active to `done` seen by this page, never
   when the page opens on an old `done`.
4. **Nothing after 5 minutes:** "Portly has not come back. Check the main PC, or run `portly
   --status` there."

A Pages site page open at the same time treats the outage like any other: it may switch to the
browser's copy after 45 s and comes back by itself. It shows the result on its next look at
`GET /api/update`.

The extension may ask to start the server during this, as it does today: `install.ps1` disables
the **Portly Server** task for the swap, so that request fails harmlessly.

The Pages site is published separately from a release, as today. The button does not change the
release order in `docs/setup/releases.md`.

## 7. Security

**The exception.** ARCHITECTURE section 20's rule is that what is decided on this PC stays here. The
owner chose on 2026-11-05 that approved PCs may start an update anyway: working from another PC is
the reason for the button. Replacing the program is a stronger power than anything else a device
has, so the route is narrowed in the one way that matters.

**Why not the Pages site.** The SHA-256 comes from the same release as the package (ARCHITECTURE
18), so it detects corruption, not a compromised repository. And the Pages site and the releases
are published from one GitHub account. If the Pages site could start an update, whoever took that
account could publish a bad release, then have the site's script press Update in a connected
browser. New tabs open that site by default. The code would run as the owner on the main PC and
could open the vault, with nobody choosing to update. That is a new reach, not the same risk one
click closer: today it waits for someone to run `portly --update`.

**What `ownPage()` changes.** Portly's own page is code this server served from the installed
version, which a change to the Pages site cannot touch. So a bad release still needs a person to
click Update, which is where things stand today with the terminal.

- The Pages site's script can read the device secret and the pairing token, but its requests carry
  the Pages `Origin`, and the gate refuses them on both ports.
- It cannot use the device cookie: the cookie is `HttpOnly` and `SameSite=Strict`, on another
  site.
- A stolen device secret works as a cookie only from inside the tailnet, because the remote port is
  reached through the owner's Tailscale Serve. Someone with only the GitHub account is not there.
- The page cannot be framed: the server's pages send `frame-ancestors 'none'`.

**What a caller on Portly's own page can do:** move Portly forward to the newest published release,
and cause about a minute of downtime. What a caller cannot do:

- choose a version, repository, URL, path or option: the task takes no input;
- go backwards: `-OnlyNewer` is enforced in the installer, not only in the route;
- repeat it: with nothing newer the route refuses, and the installer stops at `not_newer`.

**Accepted risks,** in ARCHITECTURE 4.1:

- A stolen approved PC, signed in, can start an update when one is available. The result is what
  the owner would have installed anyway, with the same backup. Removing the device stops it.
- A release that starts but breaks the remote port leaves other PCs unable to reach Portly until
  someone is at the main PC. Rollback only covers a version that fails to start.
- A bad release installed by a person who clicks Update, as with `portly --update` today. Signing
  releases with a key kept off GitHub is what would stop that, before leaving alpha.

**Unchanged:** the listener stays loopback-only, with no new port. The gate applies as usual,
`ROUTE_ACCESS` pins both routes, and all outbound traffic goes through `safe-fetch.ts`. Logs record
the versions and the outcome, never paths. `site/privacy.html` already lists GitHub for installing
and updating, and gets a line for the check.

## 8. Failures

| What happens | Result | State |
| --- | --- | --- |
| The check cannot reach GitHub | The card says so, and Update is not offered | - |
| Download fails or sticks | Nothing has stopped: the old version keeps running | `failed` / `download_failed` |
| SHA-256 differs | Nothing has stopped | `failed` / `checksum_mismatch` |
| A file in `app` is in use | Nothing moves, and the old version starts again (`install.ps1`) | `failed` / `file_in_use` |
| The new version does not start | Automatic rollback to the old version and the database copy | `rolled-back` / `did_not_start` |
| The latest release is not newer | The installer stops before changing anything | `failed` / `not_newer` |
| The task never starts | The server stays up | `failed` / `unknown`, after 2 minutes |
| Terminal `portly --update` at the same time | The second one stops at once (a new named mutex in `install.ps1`) | `failed` / `unknown` if it was the button's |
| The PC sleeps or loses power mid-update | The same as a terminal update today | Stale, then `failed` / `unknown` |
| Nobody is signed in to Windows | No server, so no button: nothing new | - |

## 9. Changes

**Scripts**

- `install.ps1`: `-OnlyNewer`, `-StatusFile`, and a mutex for one install at a time.
- `portly.ps1`: `--unattended`, which passes those, adds the status file's path and writes
  `update.log`. Terminal use is unchanged.
- `install-autostart.ps1`, `uninstall-autostart.ps1`, `status.ps1`: the new task, with `-DryRun`
  printing its definition.

**Server:** `modules/update`, `lib/install-info.ts`, a task runner with an injected `execFile`, and
the `ownPage()` access level in `lib/routes.ts` and the gate.

**Shared:** `shared/src/update.ts`. The version comparison is `shared/src/version.ts`, shared with
the notice that the main PC is behind the site.

**Web:** `api/update.ts`, an `UpdatesCard` in About, the card's polling, the link on the Pages site,
and `#/settings/about` staying on Portly's own page (`pagesForward.ts`).

**Docs:** ARCHITECTURE 4.1, 4.2, 12, 18 and 20, `docs/setup/releases.md`, `docs/setup/other-pcs.md`,
`scripts/README.md`, `README.md`, `site/privacy.html`.

**No new dependencies.**

## 10. Checks

**Automated, with no real task and no network:**

- `ROUTE_ACCESS`, and the gate on both routes for each kind of caller, including the Pages site on
  both ports being refused `POST`.
- Each availability state, the one-minute limit, and a version that is no longer the newest.
- Hostile GitHub answers: a bad tag, an oversized body, a redirect.
- Hostile or stale status files.
- The version vectors, in both languages.
- The task runner's arguments, with a fake `execFile`.
- The card in every state of section 1, including the wait for the server.
- `check-scripts.ps1`: the task definition (dry run), ASCII/CRLF, and no real registration.
- `check-release.ps1`: an unattended update in the temporary folder for each of `done`,
  `rolled-back`, `file_in_use` and `not_newer`, checking the status file holds no paths.

**Never run for real until a release exists** (for the checks table in `docs/ROADMAP.md`). One
release adds the task and the next is the first real update through it, so these wait for two
releases:

- The task registers on a real account and starts with `schtasks /run`, with no visible window.
- `install.ps1` stopping **Portly Server** from inside **Portly Updater** works, and so does the
  unchanged-definition skip while the task runs.
- A real update from the main PC's page and from another PC's page over Tailscale, and the Pages
  site's link to each.
- The page waits, shows the result and reloads, with the extension note when it applies.
- `update.log` masks the home folder.

## 11. Not in this design

- Updating by itself on a schedule.
- A footer notice that an update is available. It would need a background check. The banner that
  says the main PC is behind the site compares versions the page already has, and is its own change.
- Choosing a version, or a button to go back. `portly --update --version <x>` stays for that, and
  it needs a terminal on purpose.
- The extension reloading itself.
- Updating a Git checkout from the button.
- Signing packages.

## 12. Decisions

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Other PCs may start an update (section 7) | Yes, the owner, 2026-11-05 |
| 2 | Start it only from a page the server served, not the Pages site | Yes, the owner, 2026-11-05, with one more connect per PC |
| 3 | The check runs only when the card opens (section 4): no background traffic, no footer notice | Accepted with the design, not commented on separately |
| 4 | A second scheduled task, not a spawned process (section 2) | Yes |
| 5 | Sign releases | Not now. Needed before any update with no human step |

## 13. What the installer must write

`update-status.json` is parsed by a strict schema, and anything else makes the server report no
run. So these are hard requirements:

- Exactly these 8 fields: `id`, `state`, `from`, `to`, `startedAt`, `finishedAt`, `code`,
  `extensionChanged`.
- `id`, `from` and `startedAt` carry over from the `requested` file the server wrote. If there is no
  valid file, make a new id.
- `from` and `to` match the version pattern, `to` may be null, each at most 64 characters.
- Dates are ISO with an offset or `Z`.
  `(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')` fits; check it with the
  server's reader.
- Replace the file in one step: write a temporary file, then rename.
- The server strips a byte order mark, so Windows PowerShell 5.1's UTF-8 BOM is safe.
- Never a path or free text. It reaches other PCs.
- Nothing under `-DryRun`.

| Stage in `Invoke-InstMain` | State | Failure code |
| --- | --- | --- |
| `Resolve-InstRelease` and the download | `downloading` | `download_failed` |
| SHA-256 check | `installing` | `checksum_mismatch` |
| Stop processes and swap folders | `installing` | `file_in_use` |
| Before `Invoke-InstAutostart` | `restarting` | - |
| `Restore-InstPrevious` path | `rolled-back` | `did_not_start` |
| After "Updated Portly" | `done` | - |
| Anything else | `failed` | `unknown` |

`install.ps1` exits 1 both for "rolled back" and for "the old version did not start either", as it
always has. The status file tells them apart: `rolled-back` / `did_not_start`, or `failed` /
`did_not_start`, which the card reports as Portly not having come back.

## 14. Remaining work

The code is done and released in 0.2.0-alpha.8, with the privacy policy's new effective date on both
copies. What is left is the real test:

1. Install 0.2.0-alpha.8 with `portly --update` on the main PC. That registers **Portly Updater**,
   and `portly --status` shows it.
2. Connect the other PC once at the Tailscale address.
3. Release one more version and update through the button, from the main PC's page and from the
   other PC's. Section 10 lists what to watch.

## 15. Facts checked

Read from the code at f6c79ad, or observed:

- **The installer will not kill the updater.** `Stop-InstAppProcesses` selects by `ExecutablePath`
  under `app`, or Portly's node copies naming `app`. `powershell.exe` from System32 is neither.
  `Stop-HbSupervisorProcesses` looks for `supervisor.ts`.
- **`check-release.ps1` runs its test server unsupervised,** so `availability` is `unsupervised`.
- **The GitHub API's `releases/latest` answers the alphas:** they are not marked pre-release.
  `github.com/.../latest/download/` goes through two redirects to another host, which is why the
  server uses the API with `redirect: 'error'`.
- **`install.ps1` opens a browser only on a new install,** not an update.
- **A process working inside `app` blocks the swap,** and **a detached PowerShell exits at once**:
  [remote-update.md](remote-update.md) section 9 has the tests.
- **Output reaches `update.log` under `conhost --headless`,** a child's and a grandchild's, with
  `conhost` started directly. Not under Task Scheduler itself.
- **The status writer and `Compare-InstVersion` work the same in PowerShell 5.1 and 7,** including
  PowerShell 7 reading dates as dates.

## 16. Open risks

- **The time limit may not stop the run:** `install-autostart.ps1` notes that stopping a task ends
  only `conhost`. If PowerShell outlives the limit, the mutex is what stops a second run. It is
  named per user in the `Global\` namespace, because an SSH login is another session and `Local\`
  would not reach it.
- **The card has seen a real browser, but not a real update:** the whole flow ran in the desktop
  app's Chromium pane on a scratch server, with `/api/update` faked in the page, because a checkout
  can only answer `checkout`. The dialog, the version sent, each step, the restart line, the result
  and the reload were all seen. Its look was seen in dark on the checkout state only.
- **Inside a real task:** everything the updater does has run in checks and in `conhost --headless`,
  but never under Task Scheduler. In particular `install.ps1` stopping **Portly Server** from inside
  **Portly Updater**.
- **`--force` as the remedy for `no-task`:** it relies on the update path re-running
  `install-autostart.ps1`. It reads that way, but has not been run.
- **The first real test needs two releases:** one adds the task, the next is the first real update
  through it. The version adding the button must be installed with `portly --update`.
- **Nothing here repairs a server that stays down.** That needs the main PC, or the OpenSSH steps in
  [remote-update.md](remote-update.md) section 8.
