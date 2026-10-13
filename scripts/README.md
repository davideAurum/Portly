# Scripts

PowerShell helpers for running Portly on Windows. They work in Windows PowerShell 5.1 and
PowerShell 7. Windows blocks scripts by default, so run them like this (nothing is changed
system-wide):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\<script>.ps1 [options]
```

| Script | What it does |
| --- | --- |
| `setup.ps1` | Sets up a new PC in one go: installs Git (only when cloning) and Node.js LTS with winget when missing, upgrades npm below 11.10, clones `-RepoUrl` into `-InstallDir` (default `%USERPROFILE%\Coding\Portly`) when not run from a checkout and continues with that checkout's copy, then `npm ci`, `npm run build`, `install-autostart.ps1` (`-Trigger`), `install-cli.ps1`, and prints the extension steps (opens the browser's extensions page, path on the clipboard). Self-contained (no `lib\Common.ps1`), so it also runs as `irm <url> \| iex`. `-SkipAutostart`, `-SkipCli`, `-NoBrowser`, `-Branch`, `-DryRun`. Safe to run again. |
| `install.ps1` | Installs a **release package** (no Git, Node.js, npm or administrator rights: the package carries its own Node.js) into `-InstallDir` (default `%LOCALAPPDATA%\Programs\Portly`, program in `app\`), or updates an installed one: finds the latest release of `-ReleaseRepo` (or `-Version`, or a local `-ZipPath`), checks the package's SHA-256, unpacks and checks it, and on an update stops the copy in `app\`, copies the database to `backups\`, keeps the old version in `app.previous` and puts it back if the new one doesn't start. Then `install-autostart.ps1` (with `app\runtime\node.exe`, the installed mode kept) and `install-cli.ps1`. Self-contained, so it also runs as `irm <url> \| iex`; `portly --update` runs a temporary copy. `-PagesUrl`, `-Trigger`, `-Force`, `-SkipAutostart`, `-SkipCli`, `-NoBrowser`, `-DryRun`. See [docs/setup/releases.md](../docs/setup/releases.md). |
| `build-release.ps1` | Builds the release package: `npm run build`, the server's production dependencies only, the Node.js runtime pinned in `release\node-runtime.json` (downloaded once, SHA-256 checked), the staged files, `release.json`; writes `dist-release\portly-<version>-win-x64.zip` and `portly-release.json`. Refuses uncommitted changes unless `-AllowDirty`; `-NodeExe` puts a local node.exe in (test builds), `-SkipBuild`, `-OutDir`, `-ReleaseRepo`. |
| `check-release.ps1` | Builds a test package (or takes `-ZipPath`) and checks it end to end in a temporary folder: install, the installed `portly` command and autostart dry run, starting the server from the package, "already installed", an update with its database copy and `app.previous`, and the refusals (wrong SHA-256, missing package, bad `-PagesUrl`, foreign folder, dry run). Never touches the real task, PATH, data or install folder. |
| `publish-release.ps1` | Publishes the built package and `portly-release.json` as release `v<version>` (latest, tagging the commit it was built from) of the public repository (default `davideAurum/Portly`) with the GitHub CLI. Refuses test builds, a private repository and a version already published. `-DryRun`, `-ReleaseRepo`, `-Notes`. |
| `start.ps1` | Runs Portly in the foreground (Ctrl+C stops it). Builds `web\dist` if missing (`-Rebuild` forces a build), refuses to start a second copy, `-Port` / `-DataDir` for one-off runs. |
| `install-autostart.ps1` | Registers the per-user scheduled task **Portly Server** and the native messaging host `com.portly.launcher` for Chrome and Edge. `-Trigger Browser` (default): the task has no trigger and the new-tab extension starts it through the host when the browser opens or a new tab needs it; `-Trigger Logon` (`-LogonDelaySeconds`): at sign-in. Builds `web\dist` if missing, starts the task and waits for `/api/health`. First validates the task's `PORTLY_*` environment with `server\src\config.ts` (the task has no visible console). `-DryRun` prints the task definition, every host file with its content and every registry value, and changes nothing (exit 1 if something must be fixed first). `-NoStart`, `-NoNativeHost`, `-ExtensionId`, `-NodePath`, `-TimeoutSeconds`. |
| `uninstall-autostart.ps1` | Removes the host's registry keys (Chrome and Edge) and `%LOCALAPPDATA%\Portly\native-host` first (so no browser can restart Portly meanwhile), then stops Portly and removes the task (`-DryRun` supported). Never touches your data. |
| `status.ps1` | Two sections, health first. **Status** (`-View Status`, `portly --status`): `/api/health`, processes, task state and last result, last launcher request, native host OK or what is wrong. **Settings** (`-View Settings`, `portly --settings`): port, URL, checkout, data folder and logs, task mode and command, extension ID, host manifests, `PORTLY_PAGES_URL` / `PORTLY_PAGES_REPO`. Default `-View All` shows both. Covers: task state and mode, native host registration for both browsers (key, manifest, files, `allowed_origins` vs. the extension's pinned ID, `node.exe`, installed `launcher.mjs` vs. this checkout's), last launcher request, processes, health, data folder, `server.log` and `supervisor.log`; checks the configuration when Portly isn't answering. `-LogLines 30` shows the log tails. Exit code 0 = healthy. |
| `publish-static.ps1` | Builds the browser-only Portly (`npm run build:static` with `PORTLY_STATIC_BASE` = `-Base`) and publishes `web\dist-static` to a local clone of your **public** GitHub Pages repository (`-PublicRepoPath`): lists and removes its tracked files (keeps `CNAME`, `README.md`, never `.git`), copies the build plus `.nojekyll` in and stages only those, commits (skipped when unchanged) and pushes (`-NoPush` to skip, `-Message` for the text). **It deletes everything tracked in the repository it is given: use a new, empty public repository made for the site, never `homebase-site` or `<user>.github.io` with its own pages.** Refuses a folder that is not a git repository root, a Portly checkout, a dirty working tree, a repository holding anything but an earlier Portly publish (unless `-ReplaceEverything`), and a `-Base` that does not match the github.com repository (`/<repo>/`, or `/` for `<user>.github.io` or a `CNAME`). `-DryRun` prints the plan, builds nothing and refuses the same things. Undo a wrong publish with `git revert <publish commit>` + `git push` in that clone. See [docs/setup/static-build.md](../docs/setup/static-build.md). |
| `install-cli.ps1` | Installs the **`portly`** command for the current user: writes `portly.cmd` (PowerShell, Command Prompt) and `portly` (Git Bash) to `%LOCALAPPDATA%\Portly\bin`, both running this checkout's `portly.ps1`, and adds that folder to the user PATH (stored unexpanded). `-PublicRepoPath` also sets the `PORTLY_PAGES_REPO` user variable for `portly --rebuild`. Refuses a `.claude\worktrees` checkout; re-run after moving the checkout. `-Uninstall` removes the launchers and the PATH entry, `-DryRun` prints everything and changes nothing. |
| `portly.ps1` | What the `portly` command runs: `--update` (a release install: a temporary copy of `install.ps1` against the install folder; `--version <x>`, `--dry-run`, `--force`; in a Git checkout the same as `--rebuild`), `--rebuild` (a Git checkout: `update.ps1`; `--dry-run`, `--skip-publish`, `--skip-server`), `--version`, `--status` (`status.ps1 -View Status`; `--logs`), `--settings` (`status.ps1 -View Settings`), `--start` (starts the task and waits for `/api/health`), `--help`. Unknown commands and options exit with 2. |
| `update.ps1` | Updates everything from this checkout in one go: `npm ci` when `package-lock.json` changed (stopping the server first), `npm run build` (`web\dist`, the local page), restarts the **Portly Server** task if it was running (so server changes take effect) and waits for `/api/health`, then runs `publish-static.ps1` for the GitHub Pages site (`-PublicRepoPath`, or the `PORTLY_PAGES_REPO` user environment variable; skipped without either). Refuses to run from a `.claude\worktrees` checkout and warns about uncommitted changes or a branch other than `main`. `-SkipPublish`, `-SkipServer`, `-DryRun`, `-TimeoutSeconds`. |
| `check-scripts.ps1` | Self-checks for these scripts and the native host: syntax (5.1 and 7), ASCII/CRLF, helper unit checks (task definitions, extension IDs, host files with a fake registry, the generated `launcher.cmd` run like Chrome runs it), the node tests below, dry runs. Never registers, starts or writes the registry. |
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
| Action | `%SystemRoot%\System32\conhost.exe --headless "<node.exe>" "<repo>\server\src\supervisor.ts"`, working directory `<repo>` |
| Principal | Current user, `LogonType Interactive`, `RunLevel Limited` (never elevated) |
| Settings | No time limit; starts on battery and keeps running; `MultipleInstances IgnoreNew`; `StartWhenAvailable`; on-demand runs allowed; priority 4; 3 restarts, 1 minute apart |

`conhost --headless` gives Node a console without a window (no VBScript, no hidden-window tricks).
The task's restart settings only cover launch failures; `server\src\supervisor.ts` restarts the
server if it crashes (backoff 1 s … 60 s) and gives up when the port is already taken (exit code 3).
`Stop-ScheduledTask` ends only `conhost.exe`, so the install and uninstall scripts also stop the
node processes whose command line is this checkout's `supervisor.ts` (and their children). The
`conhost.exe` host itself (whose command line also names `supervisor.ts`) is not treated as a
supervisor; it exits on its own once the node process under it is gone.

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
