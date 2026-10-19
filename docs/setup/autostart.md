# Start Portly automatically

`scripts\install-autostart.ps1` sets things up so you never have to start Portly by hand. It has
two modes:

| Mode | Portly starts… | When to use it |
| --- | --- | --- |
| **Browser** (default, recommended) | when Chrome or Edge opens, and from a new tab if it still isn't running | You use Portly as your browser's home page. Nothing runs after you sign in until you first open a browser. |
| **Logon** | every time you sign in to Windows | You want Portly up even before a browser opens, or your PC is managed and does not allow the browser to start it (see [troubleshooting](troubleshooting.md#autostart)). |

Both modes use the same Windows scheduled task, **Portly Server**, which runs Portly in the
background with no window and without administrator rights.

## How Browser mode works

1. When Chrome or Edge starts, the Portly extension checks `http://localhost:5757/api/health`.
   If Portly doesn't answer, it asks the **Portly launcher** to start it.
2. The launcher is a tiny *native messaging host* named `com.portly.launcher`, registered for
   your Windows user. The browser runs it, hands it one request, and it runs
   `schtasks /run /tn "\Portly Server"` — nothing else.
3. Task Scheduler starts the **Portly Server** task, which starts the server.
4. A new tab asks again if Portly still isn't running (at most once a minute when new tabs open
   the Pages site). With the extension set to open **Portly on this PC**, the tab shows
   **Starting Portly…** and switches to Portly as soon as it answers (usually a few seconds);
   the **Pages site** (where new tabs go when Portly has one) opens at once, shows the last saved data
   and uses Portly as soon as it answers, if this browser is paired with it
   ([Pages site with Portly on this PC](pages-local-server.md)).

Once started, Portly keeps running in the background after you close the browser, until you
sign out or shut down (or stop it, see [Stop or remove](#stop-or-remove)). After you sign in again,
the first browser start brings it back.

Why the detour through Task Scheduler: browsers can end every program a native host starts when
the host exits (Chrome's isolated-browser mode does exactly that), so the server must be started by
Windows itself, not by the launcher. Starting it twice is harmless — the task runs one copy at a
time and a second server exits when the port is taken.

"When the browser opens" means a browser profile starting. Two browser settings move that moment:
Microsoft Edge's **Startup boost** (`edge://settings/system`) starts Edge in the background when
you sign in to Windows, so Portly then starts at sign-in too — turn Startup boost off if you
don't want that. Chrome's and Edge's **Continue running background apps when … is closed** keeps
the browser running after its last window closes; reopening a window is then not a new start, and
the first new tab starts Portly instead if it isn't running.

Only the Portly extension can use the launcher: it accepts exactly one extension ID, the one
fixed by the `key` in `extension\manifest.json` (`nbaolbakegefnefgojdokagajincnfjj`).

## Before you start

- Portly works when started by hand (`npm ci` has been run; `npm start` serves
  `http://localhost:5757`). See [SETUP](../SETUP.md).
- The [new-tab extension](extension.md) is installed from this copy of Portly.
- Stop any copy you started yourself (Ctrl+C in its window) — the script tells you if one is still
  running.
- PowerShell blocks scripts by default. The commands below use `-ExecutionPolicy Bypass`, which
  applies to that one command only and changes no settings.

## Install

Open PowerShell (no need for "Run as administrator") in your Portly folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

That installs **Browser** mode. For **Logon** mode instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Trigger Logon
```

The script:

1. checks Node.js 24+, the installed dependencies and the repository layout, reads the extension
   ID from `extension\manifest.json`, and checks your `PORTLY_*` environment variables (if any)
   with the server's own configuration loader — the background server has no console to show such
   errors, so they are reported here instead;
2. builds the web app (`npm run build`) if `web\dist` is missing;
3. registers the task (replacing an older registration, if any);
4. registers the launcher for Chrome and Edge (files and registry keys, see below);
5. starts Portly through the task and waits until `http://localhost:5757/api/health` answers,
   then prints the version and vault state. This proves the task works; in Browser mode the
   browser takes over from the next time it opens.

Preview everything first, without changing anything (it prints the task, every file with its
content and every registry value; it exits with code 1 if something must be fixed first):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -DryRun
```

| Option | Meaning |
| --- | --- |
| `-Trigger Browser` / `-Trigger Logon` | The mode (default `Browser`). |
| `-LogonDelaySeconds <0-3600>` | Logon mode only: wait this long after sign-in (default 0). |
| `-NoStart` | Register everything but don't start Portly now. |
| `-NoNativeHost` | Don't register the launcher. In Browser mode nothing then starts Portly by itself — only useful with `-Trigger Logon`. |
| `-ExtensionId <id>` | Allow this extension ID instead of the one from `extension\manifest.json` (32 letters a–p). Rarely needed. |
| `-NodePath <path to node.exe>` | Default: the `node.exe` on your PATH. Use a permanent path (not an fnm/nvm per-shell shim). This is also the `node.exe` that is copied as `portly-supervisor.exe` (see [In Task Manager](#in-task-manager)). |
| `-TimeoutSeconds <10-600>` | How long to wait for the health check (default 90). |
| `-DryRun` | Show everything, change nothing. |

Then check the launcher from the browser: open the extension's options (`chrome://extensions` →
**Portly New Tab** → **Details** → **Extension options**) and click **Test launcher**. It should
say the launcher is installed and answering. To see Browser mode in action, sign out of Windows
and back in (in Browser mode nothing starts Portly at sign-in) and open Chrome or Edge: Portly
is started in the background (a new tab set to open Portly on this PC shows **Starting
Portly…** for a few seconds at most before switching to it).

### If you see "Access is denied" (0x80070005)

Some Windows setups only let administrators create scheduled tasks. Open PowerShell with
**Run as administrator** and run the same command (the script prints it, with your options). The
task is still registered for *your* user and still runs without administrator rights, and the
launcher is still registered for your user.

## What gets registered where

| What | Where |
| --- | --- |
| Scheduled task | `\Portly Server` in the Task Scheduler Library (root folder) |
| Launcher files | `%LOCALAPPDATA%\Portly\native-host\`: `launcher.cmd` (runs `node.exe launcher.mjs`), `launcher.mjs` (a copy from the repository's `native-host` folder), `com.portly.launcher.json` (the host manifest browsers read), `config.json` (the allowed extension ID) |
| Launcher log | `%LOCALAPPDATA%\Portly\native-host\launcher.log` — one line per request (time, extension, request, result) |
| Portly's copies of Node.js | `%LOCALAPPDATA%\Portly\node\`: `portly-supervisor.exe` (a copy of your `node.exe`), `portly-server.exe` (a second name for the same file, so it takes no extra space) and `runtime.json` (which `node.exe` they were copied from) — see [In Task Manager](#in-task-manager) |
| Chrome registration | `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher`, default value = path of `com.portly.launcher.json` |
| Edge registration | `HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher`, same value |

The launcher folder is fixed per user, so the registry never points into your repository; that is
also why you re-run the installer after updating Portly (it refreshes the copy of
`launcher.mjs`). Everything is per-user — no administrator rights, nothing machine-wide.

## What the task does

| Setting | Value |
| --- | --- |
| Name | `Portly Server` (Task Scheduler Library, root folder) |
| When | Browser mode: no trigger — only when the launcher (or you) runs it. Logon mode: at log on of your user, optionally delayed |
| Runs | `C:\Windows\System32\conhost.exe --headless "%LOCALAPPDATA%\Portly\node\portly-supervisor.exe" "<Portly>\server\src\supervisor.ts"` in the Portly folder (with `"<node.exe>"` instead if the copy could not be made) |
| As | Your user, only when you are signed in, normal (not elevated) rights |
| Limits | No time limit; runs on battery; one instance at a time (a second start request is ignored); starts late if a logon was missed; can be started on demand |
| On failure to launch | Retried 3 times, 1 minute apart |

`conhost --headless` gives Node a console without showing a window. The **supervisor** starts the
actual server and restarts it if it ever crashes (after 1 s, 2 s, 5 s, 10 s, 30 s, then every
60 s). If the port is already taken it gives up instead of retrying, and it stops after three
start-ups in a row that can't succeed (`web\dist` missing). It records what it did in
`logs\supervisor.log` next to the server's own `logs\server.log` — see
[When the server stops or won't start](#when-the-server-stops-or-wont-start).

The task reads the same settings as a manual start: set `PORTLY_PORT` or `PORTLY_DATA_DIR` as
**user** environment variables if you need them, then run the install script again (it shows which
port and data folder the task will use, and warns if a `PORTLY_*` value set only in the current
PowerShell window differs from what the task will see). If you change the port, update the
extension options (the extension tells the launcher which port to check) and, for Google, add the
new redirect URI.

## In Task Manager

Task Manager names a background process after its program file, and Portly is a Node.js
program, so it would show up as two anonymous `node.exe`. To make it easy to spot, the installer
copies your `node.exe` to `%LOCALAPPDATA%\Portly\node\portly-supervisor.exe`, and the task runs
that copy. The supervisor then starts the server as `portly-server.exe` from the same folder
(a second name for the same file, so the copy takes about 90 MB once, not twice). In Task
Manager's **Details** tab, and in Resource Monitor, you see:

| Name | What it is |
| --- | --- |
| `portly-supervisor.exe` | The supervisor: it starts the server and restarts it if it crashes. Small. |
| `portly-server.exe` | Portly itself: the page, your data, the background syncs. |
| `conhost.exe` | The hidden console the task gives them (its command line names `supervisor.ts`). |

The **Processes** tab still lists them as **Node.js JavaScript Runtime**: the copies are
byte for byte the signed `node.exe`, and their description is not changed. Right-click a
column header in the Details tab and add **Command line** to see which Portly folder they run.
Chrome's own task manager (**Shift+Esc** in Chrome) lists the Portly tabs; those belong to the
browser, not to these processes.

The copies are refreshed when the `node.exe` they came from changes (after a Node.js update):
by `install-autostart.ps1`, by `portly --start` (while Portly is stopped) and when
`portly --rebuild` (`update.ps1`) restarts Portly. A browser start doesn't refresh them (the launcher only asks Task Scheduler to run the
task), so until then Portly keeps running the older Node.js; `status.ps1` warns about it. If the
copy can't be made or isn't allowed to run (some managed PCs only allow programs from Program
Files), the installer says so and the task runs `node.exe` itself — Portly works the same, it
just shows as `node.exe`.

## Switch modes

Run the installer again with the other mode; it replaces the task's trigger and keeps everything
else:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Trigger Logon
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Trigger Browser
```

In Logon mode the launcher stays registered as a fallback: if Portly was stopped, the next
browser start or new tab still brings it back.

## Check on it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1 -LogLines 40
```

`status.ps1` (or `portly --status` / `portly --settings` once `scripts\install-cli.ps1` has installed the command) starts with the health check, then shows the task state, its mode and last result, the extension ID from the manifest,
whether the launcher is registered for Chrome and Edge (registry key present, manifest and files
in place, `allowed_origins` naming the current extension ID, `node.exe` still there; it warns when
the installed `launcher.mjs` differs from this checkout's, i.e. the installer wasn't re-run after an
update), the last launcher request, the Portly processes with their program names, what the task
runs as (and a warning when `portly-supervisor.exe` is missing or an older Node.js than the
`node.exe` it was copied from), whether `/api/health` answers (and the vault state), and
where the data and log files are; when Portly isn't answering it also checks the `PORTLY_*`
settings. `-LogLines` prints the end of `launcher.log`, `supervisor.log` and `server.log`. It exits
with code 0 when Portly is healthy.

Handy one-liners:

```powershell
Start-ScheduledTask -TaskName 'Portly Server'     # start it now
Get-ScheduledTask -TaskName 'Portly Server'       # state: Ready / Running
taskschd.msc                                        # Task Scheduler (History tab for details)
```

Once Portly runs, **Settings → Diagnostics → Overview** shows whether the supervisor started it
and, after a restart, how the previous run ended.

## When the server stops or won't start

The server started by the task has no console: it writes everything to `logs\server.log`, and to
its error output only when it is about to stop (a start-up failure or a crash). The supervisor
keeps the last 40 lines of that output (secrets removed, your user name masked in paths) and, when
the server fails to start, the reason it reports (the start-up phase, the error's name and code and
a short message). Node's own warnings stay out of that output (`--no-warnings`); the server logs
them as `node warning`. When it starts the server again, it tells the new run which attempt it is
and how the last one ended, which **Settings → Diagnostics → Overview** shows under **Supervisor**.

What the supervisor does when the server exits on its own (when the supervisor itself is asked to
stop, it stops the server and exits with it):

| Exit code | Meaning | Supervisor |
| --- | --- | --- |
| 1 (or any other) | Start-up failed, or the server crashed or stopped | Restarts it after 1 s, 2 s, 5 s, 10 s, 30 s, then every 60 s (back to 1 s after a run of 10 minutes). |
| 3 | The port is taken: another Portly already runs | Exits without restarting. |
| 4 | It can't start until you fix something — `web\dist` is missing | Restarts it twice more; after the third in a row it stops and exits with code 4 (the task's last result shows `0x4`). |

`supervisor.log` holds one JSON record per line (as `server.log`); `status.ps1 -LogLines 40` prints
its end. The lines to look for:

| `msg` | Meaning |
| --- | --- |
| `supervisor starting` / `server started` | The task ran; `attempt` counts restarts in a row. |
| `server exited; restarting` | The server stopped. `code` is its exit code, `uptimeMs` how long it ran, `delayMs` the wait before the next start, `lastFailure` why start-up failed (`phase`, `errName`, `errCode`, `message`) and `stderrTail` the last lines it wrote before stopping. |
| `server keeps crashing at start-up` | Five runs in a row ended within a minute. Logged once per loop; the supervisor keeps trying. `lastFailure` and `stderrTail` say why. |
| `server cannot start; not restarting` | Three exits with code 4 in a row: build the web app (`npm run build`), then `Start-ScheduledTask -TaskName 'Portly Server'`. |
| `another Portly is already running; supervisor exiting` | Exit code 3: something else (for example `npm start`) holds the port. |
| `startup failed` with `"phase":"config"` | A `PORTLY_*` variable is invalid: the supervisor checked it before starting the server, and exited (task result `0x1`). See [invalid configuration](troubleshooting.md#starting-portly). |
| `stopping server` / `server stopped` | The supervisor was asked to stop and shut the server down cleanly (`server did not stop in time; killing it` after 10 s). |

To read the last restarts and their causes in PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\Portly\logs\supervisor.log" -Tail 50 | Where-Object { $_.StartsWith('{') } | ConvertFrom-Json |
  Format-Table t, lvl, msg, code, attempt, uptimeMs -AutoSize
# Everything about the last problem, including what the server wrote before it stopped:
Get-Content "$env:LOCALAPPDATA\Portly\logs\supervisor.log" -Tail 50 | Where-Object { $_.StartsWith('{') } | ConvertFrom-Json |
  Where-Object lvl -in 'warn','error' | Select-Object -Last 1 | ConvertTo-Json -Depth 5
```

Then look at `server.log` around the same time for the server's own `startup failed` line
([Reading the log files](troubleshooting.md#reading-the-log-files)).

## After updating Portly or Node.js

```powershell
git pull
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

Running the installer again stops the running server, updates the task and the launcher (a new
`launcher.mjs`, a new `node.exe` location after upgrading Node.js), refreshes
`portly-supervisor.exe` and `portly-server.exe` from the new `node.exe` and starts Portly again. Add
`-Trigger Logon` if that is the mode you use — the default is Browser mode. Then click **Reload**
on the extension in `chrome://extensions` / `edge://extensions`.

## Stop or remove

To remove autostart (stops Portly, unregisters the task and removes the launcher):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
```

It deletes the two registry keys above and the `%LOCALAPPDATA%\Portly\native-host` folder — only
that folder — first, so no browser can start Portly again while the task is being removed. Once
the task is gone it deletes `%LOCALAPPDATA%\Portly\node` (Portly's copies of `node.exe`, only that
folder). Add `-DryRun` to see what it would do. Your data (the rest of
`%LOCALAPPDATA%\Portly`) is left untouched; delete that folder yourself if you want to remove
your settings and stored credentials too. The extension keeps working and shows its
"Portly isn't running" page.

`Stop-ScheduledTask` on its own only ends the hidden console host, not Node: use the uninstall
script (or run the install script again) to really stop the server. In Browser mode, the next
browser start or new tab would start it again anyway.

## Running in the foreground instead

For a one-off run in the current window — handy for watching the log — use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

It builds `web\dist` if needed (`-Rebuild` forces a fresh build after pulling changes), refuses to
start while another Portly already answers on the port, and stops cleanly on Ctrl+C.
`-Port` and `-DataDir` apply to that run only.

Problems? See [troubleshooting](troubleshooting.md#autostart).
