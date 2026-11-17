<#
.SYNOPSIS
    Shows whether Portly is running (health first) and how it is set up.

.DESCRIPTION
    Read-only. Two sections:

    Status - is it working right now. Health first: the overall state (as in the banner) with a
    line each for the /api/health check, the vault, the native host for Chrome and Edge and other
    Portly servers on any port that the task did not start (development servers, Portly's own
    Vite); then the task's last run, the last launcher request, the supervisor and server
    processes (with their program names), the "Portly Server" task state, the updater, a
    warning when the task's program is missing or Portly's copies of node.exe are out of date,
    and the server configuration check when Portly does not answer.

    Settings - how it is set up: port, URL, checkout, data folder and log files, the task's mode
    and command, what it runs as (portly-supervisor.exe and portly-server.exe, copies of which
    node.exe), the extension ID pinned by the "key" in extension\manifest.json, the native host
    manifests, the GitHub Pages settings (PORTLY_PAGES_URL, PORTLY_PAGES_REPO), and the address
    for other PCs (PORTLY_REMOTE_ORIGIN, with the remote port the proxy forwards to).

    Exits with 0 when http://localhost:<port>/api/health answers as Portly and 1 otherwise, so
    it can be used from other scripts (-View Settings always exits 0).

.PARAMETER View
    All (default): both sections (portly status --full). Status or Settings: just that one
    (portly status shows Status).

.PARAMETER Port
    Port to check (1024-65535). Defaults to PORTLY_PORT, else 5757.

.PARAMETER LogLines
    Also print the last N lines of the server log, (up to 20 lines) of the autostart
    supervisor's log and (up to 10 lines) of the native host's launcher.log (0-500, default 0).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1 -LogLines 30
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('All', 'Status', 'Settings')][string]$View = 'All',
    [ValidateRange(1024, 65535)][int]$Port,
    [ValidateRange(0, 500)][int]$LogLines = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

function Format-StatusFile {
    param([Parameter(Mandatory)][string]$File)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return "$File (not created yet)" }
    $item = Get-Item -LiteralPath $File
    return ("{0} ({1:N0} KB, updated {2:yyyy-MM-dd HH:mm:ss})" -f $File, ($item.Length / 1KB), $item.LastWriteTime)
}

function Invoke-Status {
    param([int]$RequestedPort)
    $showStatus = $View -ne 'Settings'
    $showSettings = $View -ne 'Status'
    $repoRoot = Get-PtRepoRoot -ScriptRoot $PSScriptRoot
    if ($RequestedPort -gt 0) {
        $checkPort = $RequestedPort
        $portText = "$checkPort (-Port)"
    } else {
        $setting = Get-PtPortSetting -Scope Process
        $checkPort = $setting.Port
        $portText = "$checkPort ($($setting.Source))"
    }
    $dataDir = Get-PtDataDir -Scope Process -RepoRoot $repoRoot
    $logFile = Get-PtLogFile -DataDir $dataDir
    $supervisorLog = Get-PtSupervisorLogFile -DataDir $dataDir
    $windowsTasks = (Test-PtWindows) -and (Test-PtScheduledTasksAvailable)
    $task = $null
    $info = $null
    $mode = $null
    $hostLog = $null
    $hostStatus = @()
    if ($windowsTasks) {
        $task = Get-PtTask
        if ($null -ne $task) {
            $info = Get-ScheduledTaskInfo -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
            $mode = Get-PtTaskTriggerMode -Task $task
        }
        $hostLog = Join-Path (Get-PtNativeHostDir) 'launcher.log'
    }
    $expectedId = $null
    $expectedIdError = $null
    try {
        $expectedId = Get-PtExtensionIdFromManifest -ManifestPath (Join-Path $repoRoot 'extension\manifest.json')
    } catch {
        $expectedIdError = $_.Exception.Message
    }
    if ($windowsTasks) { $hostStatus = Get-PtNativeHostStatus -ExpectedId $expectedId }

    $health = $null
    if ($showStatus) {
        # The same facts as the banner's light, so the two always agree.
        $snapshot = Get-PtStatusSnapshot -RepoRoot $repoRoot -Port $checkPort
        $health = $snapshot.Health
        $overall = $snapshot.Overall
        Write-PtSection 'Portly status'

        # Health: the overall state, then what it is made of.
        $headline = if ($overall.Detail) { "$($overall.Text) ($($overall.Detail))" } else { $overall.Text }
        Write-PtFieldState 'Health' $headline -State $overall.State
        $origin = $health.Url -replace '/api/health$', ''
        if ($health.Ok) {
            $version = if ($health.Version) { "version $($health.Version)" } else { 'version unknown' }
            Write-PtFieldNote "Portly answers at $origin ($version)."
            if ($health.Vault -eq 'ready') {
                Write-PtFieldNote 'Saved credentials are unlocked (vault ready).'
            } elseif ($health.Vault -eq 'locked') {
                Write-PtFieldNote 'Saved credentials are locked: open Portly > Settings > Accounts and follow the banner.' -State Warn
            } else {
                $vaultText = if ($health.Vault) { $health.Vault } else { 'unknown' }
                Write-PtFieldNote "Saved credentials: vault $vaultText." -State Warn
            }
        } else {
            Write-PtFieldNote "Nothing answers at $origin ($($health.Error))." -State Bad
            if ($null -ne $health.Listeners -and $health.Listeners.Count -gt 0) {
                Write-PtFieldNote "Port $checkPort is used by $(Format-PtPortOwners $health.Listeners), which is not answering as Portly." -State Bad
            } else {
                Write-PtFieldNote 'Nothing listens on the port: portly start starts Portly.'
            }
        }
        $hostOk = @()
        if ($windowsTasks) {
            # Native messaging host: registered for both browsers, files present, and allowing the
            # extension ID pinned by extension\manifest.json. Details are under Settings.
            $hostOk = @($snapshot.HostStatus | Where-Object { $_.Registered -and @($_.Problems).Count -eq 0 })
            $hostBad = @($snapshot.HostStatus | Where-Object { -not ($_.Registered -and @($_.Problems).Count -eq 0) })
            if ($hostOk.Count -gt 0) {
                Write-PtFieldNote "$(@($hostOk | ForEach-Object { $_.Browser }) -join ' and ') can start Portly from a new tab (native host OK)."
            }
            foreach ($entry in $hostBad) {
                if (-not $entry.Registered) {
                    Write-PtFieldNote "$($entry.Browser) cannot start Portly: the native host is not registered ($($entry.Key))." -State Warn
                } else {
                    Write-PtFieldNote "$($entry.Browser) cannot start Portly: the native host at $($entry.ManifestPath) has problems:" -State Warn
                    foreach ($problem in @($entry.Problems)) { Write-PtFieldNote "  $problem" -State Warn }
                }
            }
            if ($null -eq $snapshot.Strays) {
                Write-PtFieldNote 'Other Portly servers: cannot tell (no Get-NetTCPConnection).'
            } elseif ($snapshot.Strays.Count -eq 0) {
                Write-PtFieldNote 'No other Portly servers are running.'
            } else {
                Write-PtFieldNote "Also running, not started by the task: $(Format-PtStrayServers -Strays $snapshot.Strays)." -State Warn
                Write-PtFieldNote 'portly stop <port> or portly stop --all stops them (portly dev, npm run dev and leftovers).'
            }
        }

        if ($windowsTasks) {
            if ($null -ne $task) {
                $lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { 'never' }
                Write-PtField 'Last run' "$lastRun, result $(Format-PtTaskResult -Code $info.LastTaskResult)"
            }
            if (Test-Path -LiteralPath $hostLog -PathType Leaf) {
                $last = @(Get-Content -LiteralPath $hostLog -Tail 1)
                if ($last.Count -gt 0) { Write-PtField 'Last launch' "$($last[0])" }
            }
            Write-PtField 'Processes' (Format-PtProcessNames -Trees @(Get-PtSupervisorProcesses -RepoRoot $repoRoot))
            if ($null -eq $task) {
                Write-PtField 'Autostart' 'not installed (scripts\install-autostart.ps1 sets it up)'
            } else {
                Write-PtField 'Autostart' "$($task.State) ($mode mode)"
                $releaseInfo = $null
                try { $releaseInfo = Get-PtReleaseInfo -RepoRoot $repoRoot } catch { }
                if ($null -ne $releaseInfo) {
                    $updater = Get-PtUpdaterTask
                    Write-PtField 'Updater' $(if ($null -ne $updater) { "$($updater.State)" } else { 'not set up (portly update --force sets it up)' })
                }
                $taskProgram = Get-PtTaskProgram -Task $task
                if ($taskProgram -and -not (Test-Path -LiteralPath $taskProgram -PathType Leaf)) {
                    Write-PtWarn "The task's program no longer exists: $taskProgram. Re-run scripts\install-autostart.ps1."
                } elseif (Test-PtRuntimeProgram -Path $taskProgram) {
                    # Portly's copies of node.exe: still the build of the node.exe they came from?
                    $runtimeDir = Split-Path -Parent $taskProgram
                    $record = Read-PtRuntimeRecord -Destination $runtimeDir
                    if ($null -ne $record -and (Test-Path -LiteralPath $record.Source -PathType Leaf)) {
                        $runtimePlan = Get-PtRuntimePlan -NodeExe $record.Source -Destination $runtimeDir
                        if ($runtimePlan.State -ne 'current') {
                            Write-PtWarn ("$PortlySupervisorProgram and $PortlyServerProgram are not the same build as $($record.Source) any more " +
                                '(Node.js was updated?). Run scripts\install-autostart.ps1 again to refresh them (it restarts Portly).')
                        }
                    }
                } elseif ($taskProgram) {
                    Write-PtInfo ("The task runs $taskProgram, so Task Manager shows Portly as node.exe. Run scripts\install-autostart.ps1 " +
                        "again to run it as $PortlySupervisorProgram and $PortlyServerProgram.")
                }
            }
            if ($mode -eq 'Browser' -and $hostOk.Count -eq 0) {
                Write-PtWarn ('The task is in Browser mode but no browser can start it (the native host is missing or broken). ' +
                    'Run scripts\install-autostart.ps1 again.')
            } elseif ($hostOk.Count -lt 2 -and $null -ne $task) {
                Write-PtInfo 'Run scripts\install-autostart.ps1 again to (re)register the native host for both browsers.'
            }
            $launcherCurrent = Test-PtInstalledLauncherCurrent -InstalledDir (Get-PtNativeHostDir) -RepoRoot $repoRoot
            if ($launcherCurrent -is [bool] -and -not $launcherCurrent) {
                Write-PtWarn ("The installed launcher ($(Join-Path (Get-PtNativeHostDir) 'launcher.mjs')) differs from this checkout's " +
                    'native-host\launcher.mjs (Portly was updated?). Run scripts\install-autostart.ps1 again to update it.')
            }
        }
        if (-not $health.Ok) {
            # A PORTLY_* value the server rejects is printed only to its console, which the
            # autostart task does not show - so check it here with the server's own loader.
            $scope = if ($null -ne $task) { 'Task' } else { 'Process' }
            try {
                $node = Resolve-PtNode -RepoRoot $repoRoot
                $config = Test-PtServerConfig -NodeExe $node.Path -RepoRoot $repoRoot -Scope $scope
                if ($config.Ok) {
                    Write-PtFieldState 'Configuration' 'valid' -State Ok
                } else {
                    Write-PtFieldState 'Configuration' "INVALID - $($config.Error)" -State Bad
                }
            } catch {
                Write-PtField 'Configuration' "not checked ($($_.Exception.Message))"
            }
        }
    }

    if ($showSettings) {
        Write-PtSection 'Portly settings'
        Write-PtField 'Port' $portText
        Write-PtField 'URL' "http://localhost:$checkPort"
        $release = $null
        try { $release = Get-PtReleaseInfo -RepoRoot $repoRoot } catch { }
        if ($null -ne $release) {
            Write-PtField 'Installed' "release $($release.version), Node.js $(Get-PtProperty $release 'node') (portly update)"
            Write-PtField 'Program' $repoRoot
        } else {
            Write-PtField 'Checkout' $repoRoot
        }
        Write-PtField 'Data folder' $dataDir
        Write-PtField 'Server log' (Format-StatusFile -File $logFile)
        Write-PtField 'Supervisor log' (Format-StatusFile -File $supervisorLog)
        if ($null -ne $hostLog) { Write-PtField 'Launcher log' (Format-StatusFile -File $hostLog) }
        if ($windowsTasks) {
            if ($null -eq $task) {
                Write-PtField 'Autostart' 'not installed (scripts\install-autostart.ps1 sets it up)'
            } else {
                Write-PtField 'Starts' (Format-PtTaskTrigger -Task $task)
                $action = @($task.Actions)[0]
                Write-PtField 'Command' "$($action.Execute) $($action.Arguments)"
                $taskProgram = Get-PtTaskProgram -Task $task
                if (Test-PtRuntimeProgram -Path $taskProgram) {
                    $record = Read-PtRuntimeRecord -Destination (Split-Path -Parent $taskProgram)
                    $source = if ($null -ne $record) { "copies of $($record.Source), Node.js v$($record.NodeVersion)" } else { "$PortlyRuntimeRecord missing" }
                    Write-PtField 'Runs as' "$PortlySupervisorProgram and $PortlyServerProgram in $(Split-Path -Parent $taskProgram) ($source)"
                } elseif ($taskProgram) {
                    Write-PtField 'Runs as' "$([System.IO.Path]::GetFileName($taskProgram)) (no Portly-named copies; install-autostart.ps1 makes them)"
                }
                if ($null -ne $release) {
                    $updater = Get-PtUpdaterTask
                    if ($null -ne $updater) {
                        $updaterAction = @($updater.Actions)[0]
                        Write-PtField 'Updater' "$($updaterAction.Execute) $($updaterAction.Arguments)"
                    } else {
                        Write-PtField 'Updater' 'not set up (portly update --force sets it up)'
                    }
                }
            }
        }
        if ($null -ne $expectedId) {
            Write-PtField 'Extension ID' "$expectedId (from the ""key"" in extension\manifest.json)"
        } else {
            Write-PtField 'Extension ID' "unknown - $expectedIdError"
        }
        foreach ($entry in $hostStatus) {
            $where = if ($entry.Registered) { $entry.ManifestPath } else { "not registered ($($entry.Key))" }
            Write-PtField "Host ($($entry.Browser))" $where
        }
        $pagesUrl = Get-PtEnvValue -Name 'PORTLY_PAGES_URL' -Scope Task
        $pagesRepo = Get-PtEnvValue -Name 'PORTLY_PAGES_REPO' -Scope Task
        $pagesUrlText = if ($pagesUrl) { "$pagesUrl (PORTLY_PAGES_URL)" } else { 'not set (PORTLY_PAGES_URL: the Pages site cannot use this server)' }
        $pagesRepoText = if ($pagesRepo) { "$pagesRepo (PORTLY_PAGES_REPO)" } else { 'not set (PORTLY_PAGES_REPO: portly update skips publishing)' }
        Write-PtField 'Pages site' $pagesUrlText
        if ($null -eq $release) { Write-PtField 'Pages repo' $pagesRepoText }
        # The variables the task sees (user/machine scope), like the Pages settings above. The default
        # remote port follows the server's rule (config.ts: the port after Portly's own, or the one
        # before it at 65535) from the task's port, not from -Port or this window's PORTLY_PORT.
        $remoteOrigin = Get-PtEnvValue -Name 'PORTLY_REMOTE_ORIGIN' -Scope Task
        $remotePort = Get-PtEnvValue -Name 'PORTLY_REMOTE_PORT' -Scope Task
        $remoteText = if ($remoteOrigin) {
            $remotePortText = if ($remotePort) {
                "$remotePort (PORTLY_REMOTE_PORT)"
            } else {
                $taskPort = $checkPort
                try { $taskPort = (Get-PtPortSetting -Scope Task).Port } catch { }
                $defaultRemotePort = if ($taskPort -lt 65535) { $taskPort + 1 } else { $taskPort - 1 }
                "$defaultRemotePort (default: the port after Portly's own)"
            }
            "$remoteOrigin (PORTLY_REMOTE_ORIGIN); the proxy forwards to remote port $remotePortText"
        } elseif ($null -ne $release) {
            'not set (PORTLY_REMOTE_ORIGIN: this PC only; to let your other PCs in, set it and re-run app\scripts\install-autostart.ps1, docs\setup\other-pcs.md)'
        } else {
            'not set (PORTLY_REMOTE_ORIGIN: this PC only; setup.ps1 -RemoteOrigin lets your other PCs in, docs\setup\other-pcs.md)'
        }
        Write-PtField 'Other PCs' $remoteText
    }

    if ($LogLines -gt 0) {
        Write-Host ''
        if ($null -ne $hostLog -and (Test-Path -LiteralPath $hostLog -PathType Leaf)) {
            Write-PtLogTail -LogFile $hostLog -Lines ([Math]::Min($LogLines, 10))
        }
        Write-PtLogTail -LogFile $supervisorLog -Lines ([Math]::Min($LogLines, 20))
        Write-PtLogTail -LogFile $logFile -Lines $LogLines
    }
    Write-Host ''
    if ($null -eq $health -or $health.Ok) { return 0 }
    return 1
}

try {
    $exitCode = Invoke-Status -RequestedPort $Port | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    Write-PtFailure $_.Exception.Message
    exit 1
}
