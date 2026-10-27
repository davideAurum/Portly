# Releases: install packages and updates

A **release package** is one zip, `portly-<version>-win-x64.zip`, that installs and runs Portly
on Windows without Git, Node.js, npm or administrator rights. People install it with
`scripts\install.ps1` (served from the Pages site, so `irm <site>/install.ps1 | iex` works on a new
PC) and update it with `portly --update`. A Git checkout
([SETUP.md](../SETUP.md#from-the-source-code)) is for developing Portly.

No release is published yet. The repository is still private, and `publish-release.ps1` refuses
to publish from a private repository.

## What the package holds

| Path | What |
| --- | --- |
| `release.json` | Name, version, platform, Node.js version, extension version, commit, build time, and the repository it updates from |
| `runtime\node.exe`, `runtime\LICENSE` | The Node.js runtime pinned in `scripts\release\node-runtime.json` (downloaded from nodejs.org and checked against its SHA-256) |
| `server\`, `shared\` | The server's TypeScript sources, without tests, fixtures and test helpers (Node runs them directly, as in a checkout) |
| `node_modules\` | The production dependencies of the server only (`npm ci --omit=dev` for the server and shared workspaces): no web, build or test packages |
| `web\dist\` | The built web app the server serves |
| `extension\` | The new-tab extension (without its tests and tools), loaded unpacked from the install folder |
| `native-host\` | The launcher the extension uses to start Portly |
| `scripts\` | `install.ps1`, `install-autostart.ps1`, `uninstall-autostart.ps1`, `install-cli.ps1`, `portly.ps1`, `start.ps1`, `status.ps1` and `lib\Common.ps1` |
| `docs\` | These guides (the app's help links point here) |

A zip cannot hold the junction npm makes for the `@portly/shared` workspace, so the installer
creates `node_modules\@portly\shared` → `shared\` once the package is in its final folder
(`install-autostart.ps1` and `start.ps1` recreate it if it goes missing).

## Install and update (what install.ps1 does)

Everything goes into `%LOCALAPPDATA%\Programs\Portly` (`-InstallDir` to change it); your data stays
in `%LOCALAPPDATA%\Portly` and is never moved or deleted.

- **Find the release:** `https://github.com/<releases repo>/releases/latest/download/portly-release.json`
  (or `/releases/download/v<version>/…` with `-Version`), which names the package and its SHA-256.
  `-ZipPath` installs a package that is already on the PC.
- **Download and check:** the package is refused when its SHA-256 differs from the published one.
- **New install:** unpack to `app.new`, check it (release.json, platform, runtime and every part),
  move it to `app`, link `@portly/shared`, run `app\scripts\install-autostart.ps1` with
  `app\runtime\node.exe` (copied as `portly-supervisor.exe` and `portly-server.exe` to
  `%LOCALAPPDATA%\Portly\node`, the names Task Manager then shows, see
  [In Task Manager](autostart.md#in-task-manager)) and `app\scripts\install-cli.ps1`, and open the
  browser's extensions page for **Load unpacked** → `app\extension`.
- **Update** (`portly --update`, which runs a temporary copy of the installed `install.ps1`; or
  running `install.ps1` again): the same version is skipped unless `-Force`. Otherwise it disables
  and stops the scheduled task (when it runs this install) until the folders are swapped, so a
  Portly tab that notices the server is gone can't start the old version again in the meantime.
  It also stops every process whose program lives in `app\` and
  every `portly-supervisor.exe` / `portly-server.exe` running a file in `app\`, copies
  `portly.db` to `<data folder>\backups\portly-before-<old version>-<time>.db` (the newest three
  are kept), moves `app` to `app.previous` (replacing the one before) and `app.new` to `app`. Each
  move renames the whole folder in one step: if a file in it is still in use after 10 seconds,
  nothing has moved, the old version starts again and the update stops with "Could not move".
  Otherwise it
  runs the new `install-autostart.ps1`, which refreshes those copies from the new
  `runtime\node.exe`, starts Portly and waits for it. If it doesn't come up, the new version is
  moved to `app.failed`, the previous one back to `app`, the database copy is put back as
  `portly.db` (the one the new version left is kept as
  `backups\portly-failed-<new version>-<time>.db`, the newest three), and the previous version is
  started again. The autostart mode (Browser or Logon) is kept, unless you run
  `install.ps1 -Trigger Browser` or `-Trigger Logon` to change it. When the extension's
  version changed, it says to click **Reload** on it.
- **More than one Windows account on the PC?** Only one account can run Portly at a time: all
  accounts share port 5757 and the scheduled task name `\Portly Server`. To use Portly on another
  account, first remove it from the one that has it with `scripts\uninstall-autostart.ps1` there
  (its data stays), and later put it back with `scripts\install-autostart.ps1`.
- **Already a Git checkout on this PC?** One Portly per Windows user: installing a release
  replaces the scheduled task and launcher of the checkout with the release's. Stop using the
  checkout's `portly` command (the release installs its own).

## Cutting a release

1. **Version and changelog.** Every release needs a new version in the root `package.json` (the
   server reports it, the web build shows it, the package and its tag are named after it). The
   `server`, `shared` and `web` packages are internal and keep their own version. For alpha
   releases use a pre-release version. Add the release's entry to
   [CHANGELOG.md](../../CHANGELOG.md), naming the new-tab extension version it ships with. Its
   heading is `## <version>` followed by anything (a date, or "(not released yet)" until release
   day): the text under it becomes the release notes in step 4.

   The extension keeps its own version in `extension/manifest.json`. Raise it only when the
   extension's code changes. Chrome accepts only plain numbers there (no `-alpha.1`), and the
   stores refuse a lower version than the last one uploaded. When the extension and the native
   host must change together, raise the protocol version instead (`LAUNCHER_PROTOCOL_VERSION` in
   `extension/lib/launcher.js` and `PROTOCOL_VERSION` in `native-host/launcher.mjs`).

   ```powershell
   npm version 0.2.0-alpha.1 --no-git-tag-version
   git commit -am "Release 0.2.0-alpha.1"
   ```

2. **Build** from that commit (it refuses uncommitted changes) — this downloads the pinned Node.js
   once into `dist-release\cache`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
   ```

3. **Check** the package end to end — install, start, update, refusals — in a temporary folder
   (never the real task, PATH, data or install folder):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-release.ps1 -ZipPath .\dist-release\portly-0.2.0-alpha.1-win-x64.zip
   ```

   Then check both production builds for CSP violations by hand, because no automated step does.
   Build them (`npm run build`, `npm run build:static`). Serve `web/dist` from a scratch server: set
   `PORTLY_PORT` and `PORTLY_DATA_DIR` to scratch values and clear `PORTLY_PAGES_URL`. Serve
   `web/dist-static` with `npm run preview:static`. With DevTools open, visit every widget and
   every settings section, download the diagnostic report (server build only), upload a
   background, and export then import. The console must show no "Content Security Policy"
   errors. Write the date in [ARCHITECTURE](../ARCHITECTURE.md) section 13.

4. **Publish** (public: anyone can download it). Push the release commit first — the release tags
   exactly the commit the package was built from:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1
   ```

   It refuses a test build (`-AllowDirty` or `-NodeExe`), a private repository and a version that
   is already published, and publishes the zip and `portly-release.json` as release `v<version>`
   of `davideAurum/Portly` (the `releaseRepo` in the package),
   marked **latest** (GitHub never marks a pre-release as latest, so alpha versions go out as normal
   releases with a pre-release version number).

   The release notes are the version's section of `CHANGELOG.md` as committed in the package's
   commit (not your working copy), with links to files of the repository pointed at that commit on
   github.com, and a last line naming the commit and the Node.js version. Both the dry run and the
   real run print them first. It refuses when the CHANGELOG has no section for the version, or an
   empty one, and warns while the heading still says "not released yet". `-Notes "<Markdown>"`
   replaces them.

5. **Publish the Pages site** as usual (`scripts\publish-static.ps1`) so its `install.ps1` is the
   current one.

Or let GitHub Actions do 2–4: **Actions → Release → Run workflow** builds, checks and keeps the
package as an artifact; tick **publish** and a second job publishes it with the workflow's own token
(the only step that can write to the repository), with the same notes from the CHANGELOG.
CI (`ci.yml`) also builds and checks a test package on every push to `main` and every pull request.

### One-time setup

- **Where releases live:** the releases of this repository, `davideAurum/Portly` (a fork
  builds with `build-release.ps1 -ReleaseRepo <owner>/<name>`, which goes into each package's
  `release.json` and so into its updates).
- **For `publish-release.ps1` on your PC:** the GitHub CLI (`winget install GitHub.cli`), signed in
  with `gh auth login`.
- **For the Release workflow:** nothing to set up.

### Moving to another Node.js version

`scripts\release\node-runtime.json` pins the version and the SHA-256 of
`node-v<version>-win-x64.zip`. Take the hash from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`
and change both together; `build-release.ps1` refuses a download whose hash differs. Stay on an LTS
line that `npm test` runs on (CI uses Node 24).

## The new-tab extension: Load unpacked, no store listings

The alpha releases ship the extension only as the `extension\` folder of the package, loaded with
**Load unpacked** (Developer mode on). There is no Chrome Web Store or Edge Add-ons listing, and
none is planned for the alpha (decided on 2026-10-20). Why a store copy would not work today:

- **It would get another ID.** The `key` in `extension/manifest.json` gives the unpacked
  extension the fixed ID `nbaolbakegefnefgojdokagajincnfjj`. A store could only keep that ID with
  the matching private key, and that key was discarded when the ID was made. Edge Add-ons assigns
  its own ID in any case. The `key` stays as it is: changing it would change the ID of every
  extension already loaded.
- **The launcher answers one ID.** `install-autostart.ps1` writes exactly one
  `chrome-extension://<id>/` origin into the launcher's `allowed_origins` and its `config.json`
  (the pinned ID, or the one given with `-ExtensionId`), and the launcher refuses any other caller.
  `status.ps1` checks the launcher against the pinned ID only.
- **Store updates are not expected.** The extension's tests (`extension/test/manifest.test.mjs`)
  require the `key` and forbid an `update_url`, because the extension is loaded unpacked and
  updated with the package.

What a store listing would need first (parked in [ROADMAP](../ROADMAP.md#parked-with-reasons)):

- a launcher that allows several origins: the unpacked ID and one per store;
- `install-autostart.ps1`, `install.ps1` and `status.ps1` writing and checking those origins, and
  the extension's own ID check (`PINNED_EXTENSION_ID` in `extension/lib/launcher.js`) accepting
  them;
- an ID per browser, once each store has assigned one (Chrome Web Store and Edge Add-ons each give
  their own);
- the listing itself: developer accounts, store icons and screenshots, a description and the
  privacy answers.

**The extension's privacy statement** is the "The new-tab extension" section of
`site/privacy.html`, published at the kept homebase-site address,
`https://davideaurum.github.io/homebase-site/privacy.html`. A store listing would link there.

## Limits of the alpha packages

- The packages are not code-signed, and the SHA-256 only proves the download matches what was
  published in the repository: whoever can publish releases there is trusted.
- The new-tab extension is still loaded unpacked (Developer mode on), and Reloaded by hand after an
  update that changes it ([why](#the-new-tab-extension-load-unpacked-no-store-listings)).
- Google and Outlook.com accounts still need your own OAuth client registrations
  ([google.md](google.md), [microsoft.md](microsoft.md)).
- Windows x64 only.
