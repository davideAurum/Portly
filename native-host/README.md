# Homebase launcher (native messaging host)

`com.homebase.launcher` lets the new-tab extension start Homebase when Chrome or Edge opens and
when a new tab finds it not running. It is installed per user by `scripts\install-autostart.ps1`
(user guide: [docs/setup/autostart.md](../docs/setup/autostart.md)).

| File | Purpose |
| --- | --- |
| `launcher.mjs` | The host (Node.js, no dependencies). Copied to `%LOCALAPPDATA%\Homebase\native-host\` by the installer. |
| `launcher.cmd` | Template: the installer replaces `{{NODE_EXE}}` with the absolute `node.exe` path and writes the result next to the copy of `launcher.mjs`. |

The installer also writes `com.homebase.launcher.json` (the host manifest) and `config.json` (the
allowed extension origin) to that folder and points
`HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\com.homebase.launcher` at the
manifest. Tests: `npm run test:native-host` / `node scripts/check-native-host.mjs` (part of
`npm test`, also run by `scripts\check-scripts.ps1`). The end-to-end tests run the generated
`launcher.cmd` exactly as Chrome does, with `scripts\tests\schtasks-stub.mjs` standing in for
`schtasks.exe`.

## How the browser runs it

Chrome and Edge start `launcher.cmd` through `cmd.exe /d /s /c` with a hidden console, passing the
caller's origin (`chrome-extension://<id>/`) as the first argument (Windows also adds
`--parent-window=<hwnd>`). stdin/stdout carry the messages, so `launcher.cmd` starts with
`@echo off`, prints nothing itself and never uses `start`.

## Messages

Each message is a 4-byte little-endian length followed by that many bytes of UTF-8 JSON. The host
reads one request (at most 64 KB; bigger ones are refused unread), writes one response and exits
with code 0.

| Request | Response |
| --- | --- |
| `{"action":"ping"}` | `{"ok":true,"state":"pong","version":1}` |
| `{"action":"start","port":5757}` (integer 1024-65535) | `{"ok":true,"state":"running"}` when `http://127.0.0.1:<port>/api/health` or `http://localhost:<port>/api/health` already answers 200 with `{"ok":true,...}` (checked in parallel, 700 ms); otherwise runs the task and answers `{"ok":true,"state":"starting"}` (also when `schtasks` says the task is already running) |
| anything else / failures | `{"ok":false,"state":"error","error":"<code>","detail":"<one line, at most 200 characters>"}` |

| Error code | When |
| --- | --- |
| `bad_origin` | The caller's origin is not in `config.json` (or `config.json` is missing or invalid). Checked before the request is read. |
| `bad_request` | Not a valid request: empty, oversized, truncated or late (5 s) frame, invalid UTF-8/JSON, unknown action, bad port. |
| `task_missing` | `schtasks` reports that the `\Homebase Server` task does not exist. |
| `schtasks_failed` | Any other `schtasks` failure (detail: its first output line), `schtasks.exe` not found, or a 10 s timeout. |

## What it runs

Only `%SystemRoot%\System32\schtasks.exe /run /tn "\Homebase Server"`: absolute path, fixed
arguments, `execFile` without a shell, hidden window. Nothing from the request reaches a command
line (the port is only used for the health check). The server is never started as a child of the
host — browsers can kill a native host's whole process tree (Chrome's isolated-browser mode puts
hosts in a kill-on-close job object, and Node puts its own children in one too) — so Task
Scheduler creates it instead. The task's `MultipleInstances IgnoreNew` and the server's exit code
3 (port taken) make repeated or concurrent start requests harmless.

Each request is logged as one line in `launcher.log` next to the host (time, caller origin,
action, outcome; renamed to `launcher.log.1` past 64 KB).
