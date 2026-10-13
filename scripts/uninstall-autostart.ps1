<#
.SYNOPSIS
    Stops Portly and removes the "Portly Server" autostart task and the native host.

.DESCRIPTION
    Removes the native messaging host com.portly.launcher first (so no browser can start the
    task again meanwhile): the registry keys
    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher and
    HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher, and the folder
    %LOCALAPPDATA%\Portly\native-host (only that folder). Then stops the scheduled task, stops
    the Portly node processes it started from this folder (Stop-ScheduledTask alone ends only
    conhost.exe) and unregisters the task (ARCHITECTURE section 12). The rest of your data folder
    (%LOCALAPPDATA%\Portly or PORTLY_DATA_DIR) is never touched. Safe to run when nothing
    is installed.

.PARAMETER DryRun
    Show what would be stopped and removed without changing anything.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

function Invoke-Uninstall {
    if (-not (Test-HbWindows)) { throw 'Autostart uses Windows Task Scheduler and only works on Windows.' }
    if (-not (Test-HbScheduledTasksAvailable)) {
        throw 'The ScheduledTasks PowerShell module is not available (it ships with Windows 8 and later).'
    }

    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    $scriptPath = Join-Path $PSScriptRoot 'uninstall-autostart.ps1'
    $task = Get-HbTask
    $running = @(Get-HbSupervisorProcesses -RepoRoot $repoRoot)
    $port = (Get-HbPortSetting -Scope Task).Port
    $dataDir = Get-HbDataDir -Scope Task -RepoRoot $repoRoot
    $hostDir = Get-HbNativeHostDir
    $hostDirExists = Test-Path -LiteralPath $hostDir
    $hostKeys = @(foreach ($entry in $PortlyNativeHostRegistry) {
            [pscustomobject]@{
                Browser = $entry.Browser
                SubKey  = $entry.SubKey
                Display = "HKEY_CURRENT_USER\$($entry.SubKey)"
                Value   = Get-HbRegistryDefaultValue -SubKey $entry.SubKey
            }
        })
    $presentKeys = @($hostKeys | Where-Object { $null -ne $_.Value })

    Write-Host ''
    Write-Host 'Portly autostart removal' -ForegroundColor White
    if ($null -ne $task) {
        Write-HbField 'Task' "$PortlyTaskPath$PortlyTaskName ($($task.State), $(Get-HbTaskTriggerMode -Task $task) mode)"
    } else {
        Write-HbField 'Task' 'not installed'
    }
    Write-HbField 'Running now' (Format-HbProcessList -Trees $running)
    foreach ($key in $hostKeys) {
        $state = if ($null -eq $key.Value) { 'not registered' } elseif ($key.Value) { "registered -> $($key.Value)" } else { 'registered (no value)' }
        Write-HbField "Host ($($key.Browser))" $state
    }
    Write-HbField 'Host folder' $(if ($hostDirExists) { $hostDir } else { "$hostDir (not present)" })
    Write-Host ''

    if ($DryRun) {
        Write-HbStep 'Steps a real run would take'
        foreach ($key in $hostKeys) {
            if ($null -ne $key.Value) {
                Write-HbInfo "- delete the registry key $($key.Display) ($($key.Browser))"
            } else {
                Write-HbInfo "- no $($key.Browser) registry key to delete ($($key.Display))"
            }
        }
        if ($hostDirExists) {
            Write-HbInfo "- delete the folder $hostDir (only that folder)"
        } else {
            Write-HbInfo "- no native host folder to delete ($hostDir)"
        }
        if ($null -ne $task -and "$($task.State)" -eq 'Running') { Write-HbInfo "- stop the task '$PortlyTaskName'" }
        if ($running.Count -gt 0) { Write-HbInfo "- stop $(Format-HbProcessList -Trees $running)" }
        if ($null -ne $task) {
            Write-HbInfo "- unregister the task '$PortlyTaskName'"
        } else {
            Write-HbInfo '- no task to unregister'
        }
        Write-HbInfo "- leave the data folder untouched: $dataDir"
        Write-Host ''
        Write-HbOk 'Dry run complete: nothing was stopped or removed.'
        return 0
    }

    # The native host goes first: once it is gone, no browser start or new tab can start the task
    # again while it is being stopped and removed.
    if ($presentKeys.Count -gt 0 -or $hostDirExists) {
        Write-HbStep "Removing the native messaging host $PortlyNativeHostName"
        $null = Uninstall-HbNativeHost -Destination $hostDir
        Write-HbOk "Removed the registry keys for Chrome and Edge and $hostDir"
    } else {
        Write-HbOk 'The native messaging host is not installed; nothing to remove'
    }

    try {
        if ($null -ne $task -and "$($task.State)" -eq 'Running') {
            Write-HbStep "Stopping the task '$PortlyTaskName'"
            Stop-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
        }
        $stopped = @(Stop-HbSupervisorProcesses -RepoRoot $repoRoot)
        if ($stopped.Count -gt 0) {
            Write-HbOk "Stopped Portly (PID $($stopped -join ', '))"
        }
        if ($null -ne $task) {
            Write-HbStep "Removing the task '$PortlyTaskName'"
            Unregister-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -Confirm:$false
            Write-HbOk 'Autostart task removed'
        } else {
            Write-HbOk "The task '$PortlyTaskName' is not installed; nothing to remove"
        }
    } catch {
        if (Test-HbAccessDenied $_) {
            Write-HbAccessDeniedHint -ScriptPath $scriptPath
            return 5
        }
        throw
    }

    Start-Sleep -Milliseconds 500
    $health = Test-HbHealth -Port $port -TimeoutSeconds 2
    if ($health.Ok) {
        Write-Warning ("Portly is still $(Format-HbHealth $health) - probably started with npm start or scripts\start.ps1. " +
            'Stop it with Ctrl+C in that window.')
    }
    Write-HbInfo "Your data was left untouched in $dataDir"
    Write-HbInfo '(delete that folder yourself to remove settings, cached data and encrypted credentials).'
    Write-HbInfo 'The new-tab extension keeps working; it shows its "Portly isn''t running" page until you start Portly yourself.'
    return 0
}

try {
    $exitCode = Invoke-Uninstall | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    if (Test-HbAccessDenied $_) {
        Write-HbAccessDeniedHint -ScriptPath (Join-Path $PSScriptRoot 'uninstall-autostart.ps1')
        exit 5
    }
    Write-HbFailure $_.Exception.Message
    exit 1
}
