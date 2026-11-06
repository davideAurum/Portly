# Design: updating the main PC from another PC

**Status:** history, kept for its evidence. The recommendation below, not to build this, was
overtaken on 2026-11-05: the owner chose an Update button, and [update-button.md](update-button.md)
is the design to follow. This assessment's main finding shaped it: starting an update stays off the
Pages site, which gives up nothing the owner needs and needs neither signing nor per-device
permissions. Sections 3 to 5 and 9 remain the evidence, and section 8 remains the way to repair a
server that stays down. [ARCHITECTURE](../ARCHITECTURE.md) stays the binding text. Line numbers are
as of f6c79ad (0.2.0-alpha.7).

**The question.** The main PC runs the real Portly server, and other PCs use it through the Pages
site and Tailscale Serve (ARCHITECTURE section 20). After 0.2.0-alpha.7 was released, the owner
wanted to run `portly --update` on the main PC from another PC. Can Portly itself do that, and
should it?

## 1. Summary

| Question | Answer |
| --- | --- |
| Can it be built? | Yes. A second scheduled task solves the hard part. About two weeks of work, spread over two releases. |
| Does it fit the security rules? | Not as they stand. A device would gain more power than the things it is refused today. |
| Does "latest release, SHA-256 checked" limit it enough? | Against a stolen PC, yes. Against someone in the owner's GitHub account, no. |
| Recommendation | **Don't build it now. Use OpenSSH over Tailscale, key only.** It needs no Portly code, and it can also repair a failed update. |

**Where the work stands** (2026-11-05, 16:10):

| Piece | State | Where |
| --- | --- | --- |
| This assessment | Written, for review | This document |
| Remote update inside Portly | Recommended against here; built later as the Update button | Sections 3 to 7, [update-button.md](update-button.md) |
| OpenSSH setup steps | Written and given to the owner as a private page; **not run** | Section 8 |
| "Main PC is behind" notice | Committed, not merged, not pushed, not seen in a real browser | c209875 on `claude/dreamy-kirch-c09d1e` |
| Flaky music widget test | Found by the notice session (1 run in 60 on a clean f6c79ad under heavy load); a separate session is working on it | Not checked here |
| The main PC's version | Answered 0.2.0-alpha.6 during the assessment, **0.2.0-alpha.7 by 16:10** | `GET /api/health` through Serve |

The main PC reached alpha.7 without these steps: the other PC has no `portly_home` key and no
`portly-home` entry, and port 22 still doesn't answer over Tailscale. How it got there isn't
recorded here (section 10).

## 2. What exists today

- **Getting in:** other PCs reach the server through the owner's Tailscale Serve, on a second
  loopback port, once each is approved on the main PC (ARCHITECTURE sections 4.2 and 20).
- **What a device may do:** every `paired()` route. `samePc()` and untagged routes stay on the main
  PC: approving and removing devices, the vault reset, the OAuth start, pairing, the diagnostics
  report.
- **Updating:** nothing in Portly can start one. No route or code in `server/src` mentions
  `install.ps1` or `--update`, and only the supervisor, DPAPI and the Tailscale name lookup start
  processes. `portly --update` runs only in a terminal on the main PC.

## 3. Is it feasible?

**What an update does, in order** (`scripts/install.ps1`):

1. Reads the small release description, and stops if that version is already installed (`:557`).
2. Downloads the zip (43 MB for alpha.7), checks its SHA-256 and unpacks it to `app.new`
   (`:570-591`). The server is still up.
3. Disables and stops the task, and force-stops every Portly process (`:627-631`). **The server
   goes down here.**
4. Copies the database and swaps `app` to `app.previous` and `app.new` to `app` (`:633-639`).
5. `install-autostart.ps1` re-registers the task, starts it and waits up to 90 s for health
   (`install-autostart.ps1:417-420`).
6. If that fails, it swaps back, restores the database and starts the old version
   (`install.ps1:496-533`).

So whatever runs this must outlive step 3.

| What could start it | Verdict | Why |
| --- | --- | --- |
| Ordinary child of the server | No | Tested: it died when its parent's parent was force-stopped, which is what step 3 does. |
| Detached process from the server | Fragile | Tested: a detached Node helper survived. But detached PowerShell with the same options exited in 0.1 s with code 0 and ran nothing. Its default working folder is `app` (`server/src/supervisor.ts:82,304`), and tested: a process working in that folder blocks the swap. |
| **Second scheduled task, `\Portly Update`** | **Best** | Task Scheduler owns the process, so it outlives the server. It is the pattern the native host already uses (`native-host/launcher.mjs:292`) and fits ARCHITECTURE section 12. Its command is fixed, so nothing from the request reaches a command line. Its working folder must be outside `app`. |
| The supervisor | No gain | It is stopped too, so it still needs one of the above, plus a new message type. |
| The native host | No | Only the main PC's browser can start it, so another PC can't reach it. Section 12 promises the worst a caller can do is start Portly. |

**When nothing can run.** All of this needs a running server, and that needs a signed-in user: the
task is Interactive (`scripts/lib/Common.ps1:706`, ARCHITECTURE section 12).

| Main PC is | Server running? | Reachable from another PC? |
| --- | --- | --- |
| Asleep or off | No | No |
| Restarted, nobody signed in | No | No |
| Signed in, Browser mode, no browser opened yet | No | No |
| Signed in, Logon mode, or a browser has opened once | Yes | Yes |
| Locked, with the owner signed in | Yes (a guess, not tested) | Yes (same) |

An update keeps the mode it found (`install.ps1:622-623`) and starts the server itself in both
modes.

**Other things a build would have to handle:**

- **A Git checkout.** There, `portly --update` is a rebuild with no pull, and it publishes the Pages
  site when `PORTLY_PAGES_REPO` is set (`scripts/portly.ps1:160`, `scripts/update.ps1:207-219`). The
  roadmap says the main PC moved to a release install on 2026-10-29. A route must refuse on a
  checkout.
- **Reporting.** The script's output contains paths with the user name, so reports must be fixed
  states, not text (ARCHITECTURE section 17). It also exits 1 both for "rolled back" and for "the
  old version did not start either" (`install.ps1:528,661`). Those need separate results.
- **The extension.** When it changes, Reload stays a job at the main PC (`install.ps1:676-679`).
- **The API version.** If it ever changes, other PCs' site goes `incompatible` and stops using the
  server (ARCHITECTURE section 16), which is exactly when the button would be wanted. It has stayed
  1 so far.

## 4. Does it fit the security rules?

Today a device can read and change almost everything, but it can't run code, and secrets never
reach it. The rule so far: what is decided on the main PC stays there (ARCHITECTURE section 4.1). A
device can't approve a device, reset the vault or download the diagnostics report. Replacing the
program is stronger than any of those.

| Who | What they can do today | What an update route would add |
| --- | --- | --- |
| A stolen PC, or its device secret | Every `paired()` route: read mail and calendar, export, change settings. No secrets. Lasts until removed on the main PC. | Very little: a restart, once per release. It can't choose a version, and a repeat stops at step 1. |
| A script on the Pages site | The same, in any connected browser: the device secret sits in that site's localStorage (section 4.1). | Same as above, unless it also holds the GitHub account (next row). |
| **Someone in the owner's GitHub account** | Can publish a bad release and change the Pages site. The bad release then waits until the owner chooses to run `portly --update`. | **Publishes a bad release, then has the Pages site press the button in a connected browser. The code runs as the owner on the main PC, with no human step.** It can open the vault (DPAPI) and reach all the owner can reach there. |

The third row is the real issue. The Pages site and the releases sit under one GitHub account, and
new tabs open that site by default, so the two halves of the attack are held by the same login.

**Is "only the latest release, SHA-256 checked" enough?** It limits what the *request* can choose,
not what the *release* contains. ARCHITECTURE section 18 says it plainly: the hash comes from the
same release, so it detects corruption, not a compromised repository, and packages are not signed.

**What approval would it need?**

| Approval step | Does it help? |
| --- | --- |
| Confirm dialog on the other PC | Only against mistakes. A script can click it, or skip it and call the route. |
| Approve on the main PC each time | Defeats the purpose: the owner isn't there. |
| Permission granted once on the main PC, per device, off by default | Yes, and it keeps the decision on the main PC. It can't be an ordinary setting, because `PATCH /api/settings` is `paired()` (`server/src/modules/core/index.ts:129`) and a device could turn it on itself. It needs its own untagged route on Portly's own page, like approving a pairing. |
| Releases signed with a key kept off GitHub | Yes, and it is the only one that stops the third row. |

**Plain answer: refuse it under today's rules.** A build would need both of the last two.

## 5. What the owner would see

```
Settings > About, on the other PC
  Main PC: 0.2.0-alpha.6    Latest: 0.2.0-alpha.7    [Update main PC]

Confirm
  Update the main PC to 0.2.0-alpha.7? Portly stops for about a minute.
  If the new version does not start, the old one comes back.

While it runs
  Downloading > Stopping > Installing > Starting
  The main PC is restarting. This is expected.

When the server is back
  Done:        Main PC is on 0.2.0-alpha.7.
  Rolled back: 0.2.0-alpha.7 did not start. Main PC is back on 0.2.0-alpha.6, data as it was.
  Silence:     The main PC has not come back after 5 minutes. That needs the main PC or SSH.
```

- **The 45-second grace.** Today a page whose server is gone for 45 s
  (`web/src/localServer/controller.ts:119`) switches to the browser's own copy, a separate dataset,
  and comes back by itself later. An update could outlast that, so the page would need an "update
  running" pause, as permission waits have.
- **The result has to be kept in a file**, because the server is down when it happens. Rollback can
  only be reported by a version that already has this feature.
- **Silence is the weak spot.** If the update fails and the old version doesn't start either,
  Portly has no one left to answer. SSH does.

## 6. The alternatives

| Option | Effort | Works when | Risk | Repairs a failed update? |
| --- | --- | --- | --- | --- |
| **A. OpenSSH over Tailscale, key only** | About 30 min at the main PC, admin once. No Portly code. | Awake, owner signed in | A new listener, limited to the tailnet. The key is a shell on the main PC unless narrowed. Doesn't depend on GitHub or the Pages site, and a person still presses Enter. | **Yes** |
| B. The main PC updates itself on a schedule | Hours by hand; a day or two as an installer option | Awake, owner signed in | No listener, but no human step: a bad release installs itself. Fails silently unless a log is added. | No |
| C. Remote desktop | About 15 min | Awake | Full desktop. Chrome Remote Desktop trusts a Google login. RDP needs Windows Pro on the main PC (not checked). | Yes, and it can Reload the extension |
| D. Built into Portly | About two weeks, two releases | Server running | Section 4 | No, not once the server is down |

Tailscale's own SSH is not an option: its server side lists only Linux and macOS.

## 7. If it is built anyway

Effort uses the roadmap's scale: S hours, M a day or two, L a week.

| Phase | What | Size |
| --- | --- | --- |
| 1 | "Main PC is behind" notice (built, section 1) | S |
| 2 | Signed releases: key kept off GitHub, signing step, check in `install.ps1` | M to L |
| 3 | `\Portly Update` task, separate results, state file, status, uninstall, script checks | M to L |
| 4 | Route, per-device grant on Portly's own page, audit line, route access test | M |
| 5 | Update screen, grace pause, handling `incompatible` | M |
| 6 | Real run on both PCs, including a deliberately failed update | M |

The first real remote update needs two releases: one to deliver the feature, one for it to install.

**Can't be tested on a PC without an install:** the real task, the real swap under it, the real
outage length, Tailscale's answer while the server is down, and the page's behaviour during a real
outage. The checks may not register a task. A failed-update test also needs a public throwaway
repository or package, which is the owner's call.

## 8. OpenSSH setup steps (option A)

**None of this has run on a real main PC.** These are the commands on the private page the owner
was given, with the PC's name replaced by `<main-pc>` and the user by `<home-user>`. Keep both PCs
together while doing it: if the key fails, it can't be fixed from elsewhere.

**1. Other PC: make a key for this job.** Choose a passphrase when asked.

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\portly_home" -C "surface-to-home"
```

**2. Other PC: send the public key to the main PC.** Copy the one line this prints, by any route.
It is the public half. Never send the file without `.pub`.

```powershell
Get-Content "$env:USERPROFILE\.ssh\portly_home.pub"
```

**3. Main PC, PowerShell as administrator: see what is there.**

```powershell
whoami
portly --version
Get-Service sshd -ErrorAction SilentlyContinue
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
Get-NetFirewallRule -DisplayName '*ssh*' -ErrorAction SilentlyContinue | Select-Object Name, DisplayName, Enabled, Profile
Get-Content "$env:ProgramData\ssh\administrators_authorized_keys" -ErrorAction SilentlyContinue
```

The part of `whoami` after the backslash is `<home-user>`. Stop if `whoami` isn't the everyday
account (the key then goes in a different file), if the version line says Git checkout, or if
anything on the home network still uses SSH to this PC (steps 5 and 8 would cut it off).

**4. Main PC, as administrator: install and start the SSH server.**

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Get-Service sshd | Set-Service -StartupType Automatic
Start-Service sshd
```

**5. Main PC, as administrator: allow SSH from the tailnet only.** The last line should show
`100.64.0.0/10` or `100.64.0.0/255.192.0.0`. Turn off any other enabled SSH rule from step 3 with
`Disable-NetFirewallRule -Name '<its name>'`.

```powershell
if (-not (Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow
}
Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Any -RemoteAddress 100.64.0.0/10
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP | Get-NetFirewallAddressFilter | Select-Object RemoteAddress
```

**6. Main PC, as administrator: add the key.** Older lines in this file are keys that can sign in;
remove any no longer used.

```powershell
$key = 'PASTE THE LINE FROM STEP 2 HERE'
$file = "$env:ProgramData\ssh\administrators_authorized_keys"
Add-Content -Force -Path $file -Value $key -Encoding ascii
icacls.exe $file /inheritance:r /grant '*S-1-5-32-544:F' /grant 'SYSTEM:F'
```

**7. Other PC: connect.** The first connection asks to trust the host.

```powershell
@'

Host portly-home
  HostName <main-pc>
  User <home-user>
  IdentityFile ~/.ssh/portly_home
  IdentitiesOnly yes
'@ | Add-Content -Path "$env:USERPROFILE\.ssh\config" -Encoding ascii
```

```powershell
ssh portly-home whoami
```

```powershell
ssh portly-home portly --version
```

**8. Main PC, as administrator: turn off password sign-in**, only after step 7 worked. It should
print one line ending in `PasswordAuthentication no`, and nothing from the `sshd.exe -t` check.

```powershell
$config = "$env:ProgramData\ssh\sshd_config"
Copy-Item $config "$config.before-portly"
(Get-Content $config) -replace '^\s*#?\s*PasswordAuthentication\s.*', 'PasswordAuthentication no' | Set-Content $config -Encoding ascii
Select-String -Path $config -Pattern '^PasswordAuthentication'
& "$env:SystemRoot\System32\OpenSSH\sshd.exe" -t
Restart-Service sshd
```

Then on the other PC this must end in `Permission denied`:

```powershell
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password portly-home
```

**9. Other PC: update.** One at a time. The main PC is already on alpha.7, so the update may report
nothing to do until the next release.

```powershell
ssh portly-home portly --status
```

```powershell
ssh portly-home portly --update --dry-run
```

```powershell
ssh portly-home portly --update
```

```powershell
ssh portly-home portly --status
```

**10. Main PC, normal PowerShell: check a new tab can still start Portly.** This is the command a
new tab uses. It should print SUCCESS and does no harm while Portly runs.

```powershell
schtasks /run /tn "\Portly Server"
```

**11. Main PC, as administrator: limit the key to Portly commands** (recommended).

```powershell
@'
# Runs only these Portly commands, for the SSH key that is limited to them.
$allowed = @(
    '--version'
    '--status'
    '--status --logs'
    '--start'
    '--update --dry-run'
    '--update'
    '--update --force'
)
$command = "$env:SSH_ORIGINAL_COMMAND".Trim()
if ($command -notmatch '^portly (.+)$' -or $allowed -cnotcontains $Matches[1]) {
    [Console]::Error.WriteLine('This key may only run: portly ' + ($allowed -join ' | '))
    exit 2
}
& (Join-Path $env:LOCALAPPDATA 'Portly\bin\portly.cmd') @($Matches[1] -split ' ')
exit $LASTEXITCODE
'@ | Set-Content -Path "$env:ProgramData\ssh\portly-only.ps1" -Encoding ascii
```

```powershell
$file = "$env:ProgramData\ssh\administrators_authorized_keys"
$prefix = 'command="powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/ProgramData/ssh/portly-only.ps1",restrict '
(Get-Content $file) -replace '^(ssh-ed25519 .* surface-to-home)$', ($prefix + '$1') | Set-Content $file -Encoding ascii
Get-Content $file
```

Then on the other PC the first must work, and the other two must print `This key may only run`. If
either gets through, the limit isn't enforced on that PC: treat the key as a full login.

```powershell
ssh portly-home portly --version
```

```powershell
ssh portly-home whoami
```

```powershell
ssh portly-home
```

**To undo it,** on the main PC as administrator, then delete the two `portly_home` files and the
`portly-home` entry on the other PC. Portly itself isn't affected. Skip this if something else uses
SSH there.

```powershell
Stop-Service sshd
Set-Service sshd -StartupType Disabled
Remove-NetFirewallRule -Name OpenSSH-Server-In-TCP
Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

## 9. Evidence

**Verified:**

- Checked against `origin/main` at f6c79ad. `install.ps1 -DryRun` against a scratch folder found
  0.2.0-alpha.7 with SHA-256 `7a9003b7...3764`; GitHub marks it Latest, not a prerelease; the zip is
  43,008,629 bytes; the scratch folder stayed empty.
- The main PC answers on its Serve address with no sign-in for health: `0.2.0-alpha.6` during the
  assessment, then `0.2.0-alpha.7`, vault ready, `remote: true`.
- Tailscale shows the main PC online through a relay, with no direct connection, and no SSH host
  key for it. But the other PC's `known_hosts` holds one ED25519 host key for the main PC's LAN
  address, and it has a key from 2026-08-28 for that entry. So an SSH server answered there in
  August. Whether it is still installed is unknown; port 22 doesn't answer over Tailscale.

| Scratch test (Windows 11 Home build 26300, Node 24.21) | Result |
| --- | --- |
| A starts B as the supervisor starts the server; B starts detached C and ordinary D; force-stop A | B and D died; C lived |
| PowerShell 5.1 started from Node with `detached: true`, ignored output, hidden | Exited in about 0.1 s with code 0; the script never ran |
| The same PowerShell, a hidden ordinary child | Ran the script |
| `conhost --headless powershell`, started directly | Ran the script, with a working console |
| The same `conhost`, started from Node with ignored output | Exited at once, so it is no stand-in for the task |
| A process working inside a folder, then `Directory.Move` on that folder | Refused; moved once the process ended |
| The step 11 limiter against a fake `portly` in PowerShell 5.1 | Four allowed commands ran and passed their exit code. Refused: `hostname`, empty, bare `portly`, `PORTLY --UPDATE`, `portly --update & calc`, `portly --update --version 0.1.0`, a newline injection, `cmd /c whoami` |
| The limiter through `cmd /c` with its forward-slash path | Allowed `--update --force`, refused empty |
| The text edits of steps 8 and 11 on sample files, PowerShell 5.1 and 7 | One config line changed; only the matching key line changed |

**Not verified:**

- That the main PC is a release install now. The roadmap says so (2026-10-29), and `portly
  --version` there settles it.
- `\Portly Update` as a real task. No task was registered.
- Anything in section 8 on a real PC: key sign-in with a Microsoft account (Microsoft's page covers
  local and domain accounts and doesn't mention those), whether `portly` is on PATH in an SSH
  session, whether the task commands work in that kind of login, whether port 22 reaches the main
  PC, and whether a dropped connection stops an update.
- Whether `command=` is enforced. It is standard OpenSSH, but an open Win32-OpenSSH issue reports
  one case where it wasn't.
- The notice in a real browser (its session's report; see its commit).

**Guesses:**

- The outage is 30 to 60 s, not measured. Download and unpack happen before the server stops, so
  they don't count. It could pass the 45 s grace.
- A locked PC behaves like a signed-in one.
- The effort figures.

## 10. How the decisions ended

| # | Decision | Recommendation here | Outcome |
| --- | --- | --- | --- |
| 1 | Build remote update into Portly? | No, not now | Yes, as an Update button started only from Portly's own page |
| 2 | How to update the main PC from another PC? | A, OpenSSH over Tailscale | The button; OpenSSH stays optional, for repairs |
| 3 | How to get alpha.7 onto the main PC? | At the main PC | Done; how isn't recorded here |
| 4 | Add a "main PC is behind" notice? | Yes | Built on its own branch |
| 5 | Sign releases? | Park it | Parked, needed before any update with no human step |

**Still open:** how the main PC reached alpha.7. That run is the first real data on the outage
length, and it would answer "release install" in section 9.

## Sources

- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)
- [Get started with OpenSSH for Windows](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)
- [Key-based authentication in OpenSSH for Windows](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)
- [Win32-OpenSSH issue 473](https://github.com/PowerShell/Win32-OpenSSH/issues/473)
