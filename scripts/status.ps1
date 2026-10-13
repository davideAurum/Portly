<#
.SYNOPSIS
    Shows whether Homebase is running (health first) and how it is set up.

.DESCRIPTION
    Read-only. Two sections:

    Status - is it working right now: the /api/health check, the supervisor and server
    processes, the "Homebase Server" task state and last result, the last launcher request, the
    native host for Chrome and Edge (OK, or what is wrong), and the server configuration check
    when Homebase does not answer.

    Settings - how it is set up: port, URL, checkout, data folder and log files, the task's mode
    and command, the extension ID pinned by the "key" in extension\manifest.json, the native host
    manifests, and the GitHub Pages settings (HOMEBASE_PAGES_URL, HOMEBASE_PAGES_REPO).

    Exits with 0 when http://localhost:<port>/api/health answers as Homebase and 1 otherwise, so
    it can be used from other scripts (-View Settings always exits 0).

.PARAMETER View
    All (default): both sections. Status or Settings: just that one (homebase --status and
    homebase --settings).

.PARAMETER Port
    Port to check (1024-65535). Defaults to HOMEBASE_PORT, else 5757.

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

function Write-StatusSection {
    param([Parameter(Mandatory)][string]$Title)
    Write-Host ''
    Write-Host $Title -ForegroundColor White
}

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
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    if ($RequestedPort -gt 0) {
        $checkPort = $RequestedPort
        $portText = "$checkPort (-Port)"
    } else {
        $setting = Get-HbPortSetting -Scope Process
        $checkPort = $setting.Port
        $portText = "$checkPort ($($setting.Source))"
    }
    $dataDir = Get-HbDataDir -Scope Process -RepoRoot $repoRoot
    $logFile = Get-HbLogFile -DataDir $dataDir
    $supervisorLog = Get-HbSupervisorLogFile -DataDir $dataDir
    $windowsTasks = (Test-HbWindows) -and (Test-HbScheduledTasksAvailable)
    $task = $null
    $info = $null
    $mode = $null
    $hostLog = $null
    $hostStatus = @()
    if ($windowsTasks) {
        $task = Get-HbTask
        if ($null -ne $task) {
            $info = Get-ScheduledTaskInfo -TaskName $HomebaseTaskName -TaskPath $HomebaseTaskPath
            $mode = Get-HbTaskTriggerMode -Task $task
        }
        $hostLog = Join-Path (Get-HbNativeHostDir) 'launcher.log'
    }
    $expectedId = $null
    $expectedIdError = $null
    try {
        $expectedId = Get-HbExtensionIdFromManifest -ManifestPath (Join-Path $repoRoot 'extension\manifest.json')
    } catch {
        $expectedIdError = $_.Exception.Message
    }
    if ($windowsTasks) { $hostStatus = Get-HbNativeHostStatus -ExpectedId $expectedId }

    $health = $null
    if ($showStatus) {
        $health = Test-HbHealth -Port $checkPort -TimeoutSeconds 2
        Write-StatusSection 'Homebase status'
        if ($health.Ok) {
            Write-Host ('  {0,-15}: {1}' -f 'Health', "OK - $(Format-HbHealth $health)") -ForegroundColor Green
        } else {
            Write-Host ('  {0,-15}: {1}' -f 'Health', (Format-HbHealth $health)) -ForegroundColor Yellow
            if ($null -ne $health.Listeners -and $health.Listeners.Count -gt 0) {
                Write-HbField 'Port used by' (Format-HbPortOwners $health.Listeners)
            }
        }
        if ($windowsTasks) {
            Write-HbField 'Processes' (Format-HbProcessList -Trees @(Get-HbSupervisorProcesses -RepoRoot $repoRoot))
            if ($null -eq $task) {
                Write-HbField 'Autostart' 'not installed (scripts\install-autostart.ps1 sets it up)'
            } else {
                Write-HbField 'Autostart' "$($task.State) ($mode mode)"
                $lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { 'never' }
                Write-HbField 'Last run' "$lastRun, result $(Format-HbTaskResult -Code $info.LastTaskResult)"
                $action = @($task.Actions)[0]
                if ("$($action.Arguments)" -match '--headless "([^"]+)"') {
                    $taskNode = $Matches[1]
                    if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
                        Write-Warning "The task's node.exe no longer exists: $taskNode. Re-run scripts\install-autostart.ps1."
                    }
                }
            }
            if (Test-Path -LiteralPath $hostLog -PathType Leaf) {
                $last = @(Get-Content -LiteralPath $hostLog -Tail 1)
                if ($last.Count -gt 0) { Write-HbField 'Last launch' "$($last[0])" }
            }

            # Native messaging host: registered for both browsers, files present, and allowing the
            # extension ID pinned by extension\manifest.json. Details are under Settings.
            $hostOk = @($hostStatus | Where-Object { $_.Registered -and @($_.Problems).Count -eq 0 })
            $hostBad = @($hostStatus | Where-Object { -not ($_.Registered -and @($_.Problems).Count -eq 0) })
            if ($hostBad.Count -eq 0) {
                Write-HbField 'Native host' "OK ($(@($hostOk | ForEach-Object { $_.Browser }) -join ', '))"
            } else {
                foreach ($entry in $hostBad) {
                    $label = "Host ($($entry.Browser))"
                    if (-not $entry.Registered) {
                        Write-HbField $label "not registered ($($entry.Key))"
                    } else {
                        Write-Host ('  {0,-15}: {1}' -f $label, "PROBLEM - $($entry.ManifestPath)") -ForegroundColor Yellow
                        foreach ($problem in @($entry.Problems)) { Write-Host "                   - $problem" -ForegroundColor Yellow }
                    }
                }
            }
            if ($mode -eq 'Browser' -and $hostOk.Count -eq 0) {
                Write-Warning ('The task is in Browser mode but no browser can start it (the native host is missing or broken). ' +
                    'Run scripts\install-autostart.ps1 again.')
            } elseif ($hostOk.Count -lt 2 -and $null -ne $task) {
                Write-HbInfo 'Run scripts\install-autostart.ps1 again to (re)register the native host for both browsers.'
            }
            $launcherCurrent = Test-HbInstalledLauncherCurrent -InstalledDir (Get-HbNativeHostDir) -RepoRoot $repoRoot
            if ($launcherCurrent -is [bool] -and -not $launcherCurrent) {
                Write-Warning ("The installed launcher ($(Join-Path (Get-HbNativeHostDir) 'launcher.mjs')) differs from this checkout's " +
                    'native-host\launcher.mjs (Homebase was updated?). Run scripts\install-autostart.ps1 again to update it.')
            }
        }
        if (-not $health.Ok) {
            # A HOMEBASE_* value the server rejects is printed only to its console, which the
            # autostart task does not show - so check it here with the server's own loader.
            $scope = if ($null -ne $task) { 'Task' } else { 'Process' }
            try {
                $node = Resolve-HbNode -RepoRoot $repoRoot
                $config = Test-HbServerConfig -NodeExe $node.Path -RepoRoot $repoRoot -Scope $scope
                if ($config.Ok) {
                    Write-HbField 'Configuration' 'valid'
                } else {
                    Write-Host ('  {0,-15}: {1}' -f 'Configuration', "INVALID - $($config.Error)") -ForegroundColor Red
                }
            } catch {
                Write-HbField 'Configuration' "not checked ($($_.Exception.Message))"
            }
        }
        if ($health.Ok -and $health.Vault -eq 'locked') {
            Write-Warning 'The credential vault is locked: open Homebase > Settings > Accounts and follow the banner.'
        }
    }

    if ($showSettings) {
        Write-StatusSection 'Homebase settings'
        Write-HbField 'Port' $portText
        Write-HbField 'URL' "http://localhost:$checkPort"
        $release = $null
        try { $release = Get-HbReleaseInfo -RepoRoot $repoRoot } catch { }
        if ($null -ne $release) {
            Write-HbField 'Installed' "release $($release.version), Node.js $(Get-HbProperty $release 'node') (homebase --update)"
            Write-HbField 'Program' $repoRoot
        } else {
            Write-HbField 'Checkout' $repoRoot
        }
        Write-HbField 'Data folder' $dataDir
        Write-HbField 'Server log' (Format-StatusFile -File $logFile)
        Write-HbField 'Supervisor log' (Format-StatusFile -File $supervisorLog)
        if ($null -ne $hostLog) { Write-HbField 'Launcher log' (Format-StatusFile -File $hostLog) }
        if ($windowsTasks) {
            if ($null -eq $task) {
                Write-HbField 'Autostart' 'not installed (scripts\install-autostart.ps1 sets it up)'
            } else {
                Write-HbField 'Starts' (Format-HbTaskTrigger -Task $task)
                $action = @($task.Actions)[0]
                Write-HbField 'Command' "$($action.Execute) $($action.Arguments)"
            }
        }
        if ($null -ne $expectedId) {
            Write-HbField 'Extension ID' "$expectedId (from the ""key"" in extension\manifest.json)"
        } else {
            Write-HbField 'Extension ID' "unknown - $expectedIdError"
        }
        foreach ($entry in $hostStatus) {
            $where = if ($entry.Registered) { $entry.ManifestPath } else { "not registered ($($entry.Key))" }
            Write-HbField "Host ($($entry.Browser))" $where
        }
        $pagesUrl = Get-HbEnvValue -Name 'HOMEBASE_PAGES_URL' -Scope Task
        $pagesRepo = Get-HbEnvValue -Name 'HOMEBASE_PAGES_REPO' -Scope Task
        $pagesUrlText = if ($pagesUrl) { "$pagesUrl (HOMEBASE_PAGES_URL)" } else { 'not set (HOMEBASE_PAGES_URL: the Pages site cannot use this server)' }
        $pagesRepoText = if ($pagesRepo) { "$pagesRepo (HOMEBASE_PAGES_REPO)" } else { 'not set (HOMEBASE_PAGES_REPO: homebase --rebuild skips publishing)' }
        Write-HbField 'Pages site' $pagesUrlText
        if ($null -eq $release) { Write-HbField 'Pages repo' $pagesRepoText }
    }

    if ($LogLines -gt 0) {
        Write-Host ''
        if ($null -ne $hostLog -and (Test-Path -LiteralPath $hostLog -PathType Leaf)) {
            Write-HbLogTail -LogFile $hostLog -Lines ([Math]::Min($LogLines, 10))
        }
        Write-HbLogTail -LogFile $supervisorLog -Lines ([Math]::Min($LogLines, 20))
        Write-HbLogTail -LogFile $logFile -Lines $LogLines
    }
    Write-Host ''
    if ($null -eq $health -or $health.Ok) { return 0 }
    return 1
}

try {
    $exitCode = Invoke-Status -RequestedPort $Port | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
