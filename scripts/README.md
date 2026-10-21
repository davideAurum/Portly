# Scripts

PowerShell helpers for running Portly on Windows. They work in Windows PowerShell 5.1 and
PowerShell 7. Windows blocks scripts by default, so run them like this (nothing is changed
system-wide):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\<script>.ps1 [options]
```

| Script | What it does |
| --- | --- |
| `setup.ps1` | Sets up a new PC in one go: installs Git (only when cloning) and Node.js LTS with winget when missing, upgrades npm below 11.10, clones `-RepoUrl` into `-InstallDir` (default `%USERPROFILE%\Coding\Portly`) when not run from a checkout and continues with that checkout's copy, then `npm ci`, `npm run build`, `install-autostart.ps1` (`-Trigger`), `install-cli.ps1`, and prints the extension steps (opens the browser's extensions page, path on the clipboard). `-PagesUrl` saves your Pages site as `PORTLY_PAGES_URL` before Portly starts (`off` removes it). Self-contained (no `lib\Common.ps1`), so it also runs as `irm <url> \| iex`. `-NoHomebaseCopy`, `-SkipAutostart`, `-SkipCli`, `-NoBrowser`, `-Branch`, `-DryRun`. Safe to run again. |
| `install.ps1` | Installs a **release package** (no Git, Node.js, npm or administrator rights: the package carries its own Node.js) into `-InstallDir` (default `%LOCALAPPDATA%\Programs\Portly`, program in `app\`), or updates an installed one: finds the latest release of `-ReleaseRepo` (or `-Version`, or a local `-ZipPath`), checks the package's SHA-256, unpacks and checks it, and on an update stops the copy in `app\`, copies the database to `backups\`, keeps the old version in `app.previous` and puts it and the database copy back if the new one doesn't start (the database the new one left stays in `backups\portly-failed-*.db`). Then `install-autostart.ps1` (with `app\runtime\node.exe`, the installed mode kept) and `install-cli.ps1`. Self-contained, so it also runs as `irm <url> \| iex`; `portly --update` runs a temporary copy. `-PagesUrl`, `-Trigger`, `-Force`, `-SkipAutostart`, `-SkipCli`, `-NoBrowser`, `-DryRun`. See [docs/setup/releases.md](../docs/setup/releases.md). |
| `build-release.ps1` | Builds the release package: `npm run build`, the server's production dependencies only, the Node.js runtime pinned in `release\node-runtime.json` (downloaded once, SHA-256 checked), the staged files, `release.json`; writes `dist-release\portly-<version>-win-x64.zip` and `portly-release.json`. Refuses uncommitted changes unless `-AllowDirty`; `-NodeExe` puts a local node.exe in (test builds), `-SkipBuild`, `-OutDir`, `-ReleaseRepo`. |
| `check-release.ps1` | Puts a database copy back as after a failed update (`install.ps1`'s `Restore-InstDatabase`, temporary folder). Builds a test package (or takes `-ZipPath`) and checks it end to end in a temporary folder: install, the installed `portly` command and autostart dry run, starting the server from the package, "already installed", an update with its database copy and `app.previous`, and the refusals (wrong SHA-256, missing package, bad `-PagesUrl`, foreign folder, dry run). Never touches the real task, PATH, data or install folder. |
| `publish-release.ps1` | Publishes the built package and `portly-release.json` as release `v<version>` (latest, tagging the commit it was built from) of the public repository (default `davideAurum/Portly`) with the GitHub CLI. Refuses test builds, a private repository and a version already published. `-DryRun`, `-ReleaseRepo`, `-Notes`. |
| `start.ps1` | Runs Portly in the foreground (Ctrl+C stops it). Builds `web\dist` if missing (`-Rebuild` forces a build, `-NoBuild` fails instead of building), refuses to start a second copy, `-Port` / `-DataDir` for one-off runs. |
| `install-autostart.ps1` | Registers the per-user scheduled task **Portly Server** and the native messaging host `com.portly.launcher` for Chrome and Edge. `-Trigger Browser` (default): the task has no trigger and the new-tab extension starts it through the host when the browser opens or a new tab needs it; `-Trigger Logon` (`-LogonDelaySeconds`): at sign-in. Builds `web\dist` if missing, makes Portly's copies of `node.exe` (`portly-supervisor.exe`, `portly-server.exe`, see below), starts the task and waits for `/api/health`. First validates the task's `PORTLY_*` environment with `server\src\config.ts` (the task has no visible console). On a PC that ran Homebase: copies its `HOMEBASE_*` user variables, asks Portly to copy its database at the first start, stops the **Homebase Server** task before starting Portly, and removes that task (saved as `homebase-task-backup.xml`) and `com.homebase.launcher` only once Portly answers; otherwise starts Homebase again. `-NoHomebaseCopy` (also on `setup.ps1`) starts from scratch instead: no data or variables copied. `-DryRun` prints the task definition, every host file with its content and every registry value, and changes nothing (exit 1 if something must be fixed first). `-NoStart`, `-NoNativeHost`, `-ExtensionId`, `-NodePath`, `-TimeoutSeconds`. |
| `uninstall-autostart.ps1` | Removes the host's registry keys (Chrome and Edge) and `%LOCALAPPDATA%\Portly\native-host` first (so no browser can restart Portly meanwhile), then stops Portly, removes the task and deletes `%LOCALAPPDATA%\Portly\node` (`-DryRun` supported). Never touches your data. |
| `status.ps1` | Two sections, health first. **Status** (`-View Status`, `portly --status`): `/api/health`, processes (with their program names), task state and last result, a missing task program or out-of-date copies of `node.exe`, last launcher request, native host OK or what is wrong. **Settings** (`-View Settings`, `portly --settings`): port, URL, checkout, data folder and logs, task mode and command, what it runs as, extension ID, host manifests, `PORTLY_PAGES_URL` / `PORTLY_PAGES_REPO`. Default `-View All` shows both. Covers: task state and mode, native host registration for both browsers (key, manifest, files, `allowed_origins` vs. the extension's pinned ID, `node.exe`, installed `launcher.mjs` vs. this checkout's), last launcher request, processes, health, data folder, `server.log` and `supervisor.log`; checks the configuration when Portly isn't answering. `-LogLines 30` shows the log tails. Exit code 0 = healthy. |
| `publish-static.ps1` | Builds the browser-only Portly (`npm run build:static` with `PORTLY_STATIC_BASE` = `-Base`) and publishes `web\dist-static` to a local clone of your **public** GitHub Pages repository (`-PublicRepoPath`): lists and removes its tracked files (keeps `CNAME`, `README.md`, never `.git`), copies the build plus `.nojekyll` in and stages only those, commits (skipped when unchanged) and pushes (`-NoPush` to skip, `-Message` for the text). **It deletes everything tracked in the repository it is given: use a new, empty public repository made for the site, never one that already serves other pages, such as a `<user>.github.io` with its own pages.** Refuses a folder that is not a git repository root, a Portly checkout, a dirty working tree, a repository holding anything but an earlier Portly publish (unless `-ReplaceEverything`), and a `-Base` that does not match the github.com repository (`/<repo>/`, or `/` for `<user>.github.io` or a `CNAME`). `-DryRun` prints the plan, builds nothing and refuses the same things. Undo a wrong publish with `git revert <publish commit>` + `git push` in that clone. See [docs/setup/static-build.md](../docs/setup/static-build.md). |
| `install-cli.ps1` | Installs the **`portly`** command for the current user: writes `portly.cmd` (PowerShell, Command Prompt) and `portly` (Git Bash) to `%LOCALAPPDATA%\Portly\bin`, both running this checkout's `portly.ps1`, and adds that folder to the user PATH (stored unexpanded). `-PublicRepoPath` also sets the `PORTLY_PAGES_REPO` user variable for `portly --rebuild`. Refuses a `.claude\worktrees` checkout; re-run after moving the checkout. Then removes the old `homebase` command (`%LOCALAPPDATA%\Homebase\bin` launchers and PATH entry). `-Uninstall` removes the launchers and the PATH entry, `-DryRun` prints everything and changes nothing. |
| `portly.ps1` | What the `portly` command runs: `--update` (a release install: a temporary copy of `install.ps1` against the install folder; `--version <x>`, `--dry-run`, `--force`; in a Git checkout the same as `--rebuild`), `--rebuild` (a Git checkout: `update.ps1`; `--dry-run`, `--skip-publish`, `--skip-server`), `--version`, `--status` (`status.ps1 -View Status`; `--logs`), `--settings` (`status.ps1 -View Settings`), `--start` (refreshes Portly's copies of `node.exe` when out of date, starts the task and waits for `/api/health`), `--copy-from-homebase` (asks Portly to copy Homebase's data at its next start and restarts the task; `--replace` over Portly's own database, which is moved aside; `--cancel` withdraws the request), `--help`. Unknown commands and options exit with 2. |
| `update.ps1` | Updates everything from this checkout in one go: `npm ci` when `package-lock.json` changed (stopping the server first), `npm run build` (`web\dist`, the local page), restarts the **Portly Server** task if it was running (so server changes take effect; Portly's copies of `node.exe` are refreshed first when the source `node.exe` was updated) and waits for `/api/health`, then runs `publish-static.ps1` for the GitHub Pages site (`-PublicRepoPath`, or the `PORTLY_PAGES_REPO` user environment variable; skipped without either). Refuses to run from a `.claude\worktrees` checkout and warns about uncommitted changes or a branch other than `main`. `-SkipPublish`, `-SkipServer`, `-DryRun`, `-TimeoutSeconds`. |
| `try-branch.ps1` | Tries this checkout's Portly live on a copy of your data before you commit it: builds the page and the Pages build, pauses your normal Portly (stops it and disables the **Portly Server** task), copies the data folder (without backups, logs and the `node` folder) to a temporary folder, starts this checkout's server on port 5757 with the copy and serves its Pages build at `http://localhost:<PagesPort>` (default 5175; nothing is published). Press Enter to stop: it deletes the copy (unless `-KeepData`), turns the task back on and starts your normal Portly again, also after Ctrl+C or an error. Your real data folder is only read. `-SkipBuild`, `-DryRun`. |
| `check-scripts.ps1` | Self-checks for these scripts and the native host: syntax (5.1 and 7), ASCII/CRLF, helper unit checks (task definitions, process selection, Portly's copies of `node.exe` in a temporary folder, the retry for a file another program holds for a moment, extension IDs (with Chromium's own vectors), the browser-only build's files against what `publish-static.ps1` recognises, host files with a fake registry, the generated `launcher.cmd` run like Chrome runs it), the node tests below, dry runs (including `try-branch.ps1 -DryRun`). Never registers, starts or writes the registry. |
| `check-native-host.mjs` | Runs the native host's `node:test` suite (`tests\native-host-launcher.test.mjs`): `node scripts/check-native-host.mjs` or `npm run test:native-host` (part of `npm test`). |
| `check-extension.mjs` | Runs the new-tab extension's tests: `node scripts/check-extension.mjs`. |

Shared code lives in `lib\Common.ps1`; `tests\health-fixture.mjs` is a loopback HTTP fixture used
by `check-scripts.ps1`. `tests\schtasks-stub.mjs` stands in for `schtasks.exe` whenever a check runs
the generated `launcher.cmd`: it is preloaded into the launcher through `NODE_OPTIONS` (`--import`),
replaces `child_process.execFile`, records each call and answers like `schtasks.exe`
(`PORTLY_TEST_SCHTASKS` = `success`, `missing` or `denied`). It fails closed, so no check can ever
run the real task.

## The autostart task

| Setting | Value |
| --- | --- |
| Name | `\Portly Server` |
| Trigger | `-Trigger Browser` (default): none - runs on demand only (`schtasks /run` from the native host, or `Start-ScheduledTask`). `-Trigger Logon`: at log on of the current user, optional delay |
| Action | `%SystemRoot%\System32\conhost.exe --headless "%LOCALAPPDATA%\Portly\node\portly-supervisor.exe" "<repo>\server\src\supervisor.ts"` (or `"<node.exe>"` when that copy cannot be made or does not run), working directory `<repo>` |
| Principal | Current user, `LogonType Interactive`, `RunLevel Limited` (never elevated) |
| Settings | No time limit; starts on battery and keeps running; `MultipleInstances IgnoreNew`; `StartWhenAvailable`; on-demand runs allowed; priority 4; 3 restarts, 1 minute apart |

`conhost --headless` gives Node a console without a window (no VBScript, no hidden-window tricks).
The task's restart settings only cover launch failures; `server\src\supervisor.ts` restarts the
server if it crashes (backoff 1 s … 60 s) and gives up when the port is already taken (exit code 3).
`Stop-ScheduledTask` ends only `conhost.exe`, so the install and uninstall scripts also stop the
processes whose command line is this checkout's `supervisor.ts` (and their children), whatever
their program. The `conhost.exe` host itself (whose command line also names `supervisor.ts`) is
not treated as a supervisor; it exits on its own once the process under it is gone.

### Portly's copies of Node.js

Task Manager's Details tab and Resource Monitor name a process after its program file, so the
task does not run `node.exe` itself but copies named for Portly, in `%LOCALAPPDATA%\Portly\node`
(fixed per user; not `bin`, which is on PATH for the `portly` command):

| File | What |
| --- | --- |
| `portly-supervisor.exe` | A byte copy of the chosen `node.exe` (`-NodePath`, a release's `runtime\node.exe`, else PATH), modification time kept. The task runs it. |
| `portly-server.exe` | A hard link of `portly-supervisor.exe` (one file on disk), else a second copy. `server\src\supervisor.ts`, running as `portly-supervisor.exe`, starts the server with it (and makes it again when it is missing). |
| `runtime.json` | `{"version":1,"source":"<node.exe>","nodeVersion":"<x.y.z>"}`: what they were copied from. |

The copies are not modified, so the Processes tab still says "Node.js JavaScript Runtime" and the
signature stays valid. `Update-HbRuntimeCopies` (in `lib\Common.ps1`) makes them current (same
size and modification time as the source), checks that `portly-supervisor.exe` runs and reports
the source's version, and writes `runtime.json`. Windows PowerShell 5.1 opens a file for writing
to set its modification time, which fails while another program (a virus scanner reading the new
copy) has it open, so that step is tried again for up to 1.5 s (`Invoke-HbSharingRetry`); a copy
that stays in use is still reported. `install-autostart.ps1` runs it before registering
the task and again after stopping a Portly that runs from them; when they cannot be made or do not
run (for example a policy that blocks programs in `%LOCALAPPDATA%`), the task runs `node.exe`
itself. `Start-HbTask` (used by `update.ps1`, `portly --start`, `portly --copy-from-homebase` and
`try-branch.ps1`) refreshes them first when the source was updated (`Sync-HbTaskRuntime`).
`status.ps1` shows what the task runs as and warns about a missing or out-of-date copy;
`uninstall-autostart.ps1` deletes the folder after the task; `install.ps1` also stops copies whose
command line names its `app\` folder.

## The native messaging host

| What | Value |
| --- | --- |
| Name | `com.portly.launcher` |
| Files | `%LOCALAPPDATA%\Portly\native-host\`: `launcher.cmd` (generated from `native-host\launcher.cmd` with the absolute `node.exe`), `launcher.mjs` (copied from `native-host\`), `com.portly.launcher.json` (host manifest: name, description, absolute `path` to `launcher.cmd`, `type: stdio`, `allowed_origins: ["chrome-extension://<id>/"]`), `config.json` (the same allowed origin, checked again by the launcher); `launcher.log` is written by the launcher |
| Registry | Default value of `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher` = path of the host manifest |
| Extension ID | Computed from the `key` in `extension\manifest.json`: SHA-256 of the base64-decoded key, first 16 bytes as hex, digits 0-f mapped to a-p (`Get-HbExtensionIdFromKey`). The installer refuses to register the host when the manifest has no `key` (`-NoNativeHost` skips it, `-ExtensionId` overrides it). |

The host never starts the server itself: it only runs `%SystemRoot%\System32\schtasks.exe /run /tn
"\Portly Server"`, so the server is created by the Task Scheduler service and is not part of the
browser's (kill-on-close) job objects. See `native-host\README.md` for the message contract.

Style rules: ASCII only (Windows PowerShell 5.1 reads BOM-less files as ANSI), CRLF line endings,
`Set-StrictMode -Version 3.0`. A function that returns an array with `return , $array` must be
assigned (`$x = Get-Thing`), never wrapped in `@(...)` (that nests the array). Run
`check-scripts.ps1` after editing.

User guide: [docs/setup/autostart.md](../docs/setup/autostart.md).
