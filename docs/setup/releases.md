# Releases: install packages and updates

A **release package** is one zip, `homebase-<version>-win-x64.zip`, that installs and runs Homebase
on Windows without Git, Node.js, npm or administrator rights. People install it with
`scripts\install.ps1` (served from the Pages site, so `irm <site>/install.ps1 | iex` works on a new
PC) and update it with `homebase --update`. A Git checkout ([SETUP.md](../SETUP.md#from-the-source-code))
keeps working as before; it is for developing Homebase.

## What the package holds

| Path | What |
| --- | --- |
| `release.json` | Name, version, platform, Node.js version, extension version, commit, build time, and the releases repository it updates from |
| `runtime\node.exe`, `runtime\LICENSE` | The Node.js runtime pinned in `scripts\release\node-runtime.json` (downloaded from nodejs.org and checked against its SHA-256) |
| `server\`, `shared\` | The server's TypeScript sources, without tests, fixtures and test helpers (Node runs them directly, as in a checkout) |
| `node_modules\` | The production dependencies of the server only (`npm ci --omit=dev` for the server and shared workspaces): no web, build or test packages |
| `web\dist\` | The built web app the server serves |
| `extension\` | The new-tab extension (without its tests and tools), loaded unpacked from the install folder |
| `native-host\` | The launcher the extension uses to start Homebase |
| `scripts\` | `install.ps1`, `install-autostart.ps1`, `uninstall-autostart.ps1`, `install-cli.ps1`, `homebase.ps1`, `start.ps1`, `status.ps1` and `lib\Common.ps1` |
| `docs\` | These guides (the app's help links point here) |

A zip cannot hold the junction npm makes for the `@homebase/shared` workspace, so the installer
creates `node_modules\@homebase\shared` → `shared\` once the package is in its final folder
(`install-autostart.ps1` and `start.ps1` recreate it if it goes missing).

## Install and update (what install.ps1 does)

Everything goes into `%LOCALAPPDATA%\Programs\Homebase` (`-InstallDir` to change it); your data stays
in `%LOCALAPPDATA%\Homebase` and is never moved or deleted.

- **Find the release:** `https://github.com/<releases repo>/releases/latest/download/homebase-release.json`
  (or `/releases/download/v<version>/…` with `-Version`), which names the package and its SHA-256.
  `-ZipPath` installs a package that is already on the PC.
- **Download and check:** the package is refused when its SHA-256 differs from the published one.
- **New install:** unpack to `app.new`, check it (release.json, platform, runtime and every part),
  move it to `app`, link `@homebase/shared`, run `app\scripts\install-autostart.ps1` with
  `app\runtime\node.exe` and `app\scripts\install-cli.ps1`, and open the browser's extensions page
  for **Load unpacked** → `app\extension`.
- **Update** (`homebase --update`, which runs a temporary copy of the installed `install.ps1`; or
  running `install.ps1` again): the same version is skipped unless `-Force`. Otherwise it stops the
  scheduled task (when it runs this install) and every process whose program lives in `app\`,
  copies `homebase.db` to `<data folder>\backups\homebase-before-<old version>-<time>.db` (the
  newest three are kept), moves `app` to `app.previous` (replacing the one before) and `app.new` to
  `app`, then runs the new `install-autostart.ps1`, which starts Homebase and waits for it. If it
  doesn't come up, the new version is moved to `app.failed`, the previous one back to `app`, and
  that one is started again. The autostart mode (Browser or Logon) is kept. When the extension's
  version changed, it says to click **Reload** on it.
- **Already a Git checkout on this PC?** One Homebase per Windows user: installing a release
  replaces the scheduled task and launcher of the checkout with the release's. Stop using the
  checkout's `homebase` command (the release installs its own).

## Cutting a release

1. **Version.** Every release needs a new version in the root `package.json` (the server reports it;
   the package and its tag are named after it). For alpha releases use a pre-release version, and
   keep the extension's `manifest.json` version at least the same `major.minor.patch`:

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
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-release.ps1 -ZipPath .\dist-release\homebase-0.2.0-alpha.1-win-x64.zip
   ```

4. **Publish** (public: anyone who can see the releases repository can download it):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1
   ```

   It refuses a test build (`-AllowDirty` or `-NodeExe`), a private repository and a version that
   is already published, and publishes the zip and `homebase-release.json` as release `v<version>`,
   marked **latest** (GitHub never marks a pre-release as latest, so alpha versions go out as normal
   releases with a pre-release version number).

5. **Publish the Pages site** as usual (`scripts\publish-static.ps1`) so its `install.ps1` is the
   current one.

Or let GitHub Actions do 2–4: **Actions → Release → Run workflow** builds, checks and keeps the
package as an artifact; tick **publish** to publish it too (needs the `RELEASES_TOKEN` secret below).
CI (`ci.yml`) also builds and checks a test package on every push to `main` and every pull request.

### One-time setup

- **The releases repository.** The Homebase repository is private, so releases go to a separate
  **public** repository that holds nothing else, `davideAurum/homebase-releases` by default (the
  `-ReleaseRepo` of `build-release.ps1` writes another one into each package). Create it on GitHub
  (public; a README is enough).
- **For `publish-release.ps1` on your PC:** the GitHub CLI (`winget install GitHub.cli`), signed in
  with `gh auth login`.
- **For the Release workflow:** a fine-grained personal access token with access to the releases
  repository only and **Contents: Read and write**, saved in this repository as the Actions secret
  `RELEASES_TOKEN` (`GITHUB_TOKEN` cannot write to another repository). Give it an expiry date and
  renew it when it runs out.

### Moving to another Node.js version

`scripts\release\node-runtime.json` pins the version and the SHA-256 of
`node-v<version>-win-x64.zip`. Take the hash from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`
and change both together; `build-release.ps1` refuses a download whose hash differs. Stay on an LTS
line that `npm test` runs on (CI uses Node 24).

## Limits of the alpha packages

- The packages are not code-signed, and the SHA-256 only proves the download matches what was
  published in the releases repository: whoever can publish there is trusted.
- The new-tab extension is still loaded unpacked (Developer mode on), and Reloaded by hand after an
  update that changes it.
- Google and Outlook.com accounts still need your own OAuth client registrations
  ([google.md](google.md), [microsoft.md](microsoft.md)).
- Windows x64 only.
