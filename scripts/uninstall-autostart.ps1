<#
.SYNOPSIS
    Stops Portly and removes the "Portly Server" and "Portly Updater" tasks and the native host.

.DESCRIPTION
    Removes the native messaging host com.portly.launcher first (so no browser can start the
    task again meanwhile): the registry keys
    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher and
    HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher, and the folder
    %LOCALAPPDATA%\Portly\native-host (only that folder). Then stops the scheduled task, stops
    the Portly processes it started from this folder (node.exe, or portly-supervisor.exe and
    portly-server.exe; Stop-ScheduledTask alone ends only conhost.exe), unregisters both tasks and
    deletes %LOCALAPPDATA%\Portly\node (only that folder: Portly's copies of node.exe)
    (ARCHITECTURE section 12). The rest of your data folder (%LOCALAPPDATA%\Portly or
    PORTLY_DATA_DIR) is never touched. Safe to run when nothing is installed.

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
    if (-not (Test-PtWindows)) { throw 'Autostart uses Windows Task Scheduler and only works on Windows.' }
    if (-not (Test-PtScheduledTasksAvailable)) {
        throw 'The ScheduledTasks PowerShell module is not available (it ships with Windows 8 and later).'
    }

    $repoRoot = Get-PtRepoRoot -ScriptRoot $PSScriptRoot
    $scriptPath = Join-Path $PSScriptRoot 'uninstall-autostart.ps1'
    $task = Get-PtTask
    $updater = Get-PtUpdaterTask
    $running = @(Get-PtSupervisorProcesses -RepoRoot $repoRoot)
    $port = (Get-PtPortSetting -Scope Task).Port
    $dataDir = Get-PtDataDir -Scope Task -RepoRoot $repoRoot
    $hostDir = Get-PtNativeHostDir
    $hostDirExists = Test-Path -LiteralPath $hostDir
    $runtimeDir = Get-PtRuntimeDir
    $runtimeDirExists = Test-Path -LiteralPath $runtimeDir
    $hostKeys = @(foreach ($entry in $PortlyNativeHostRegistry) {
            [pscustomobject]@{
                Browser = $entry.Browser
                SubKey  = $entry.SubKey
                Display = "HKEY_CURRENT_USER\$($entry.SubKey)"
                Value   = Get-PtRegistryDefaultValue -SubKey $entry.SubKey
            }
        })
    $presentKeys = @($hostKeys | Where-Object { $null -ne $_.Value })

    Write-Host ''
    Write-Host 'Portly autostart removal' -ForegroundColor White
    if ($null -ne $task) {
        Write-PtField 'Task' "$PortlyTaskPath$PortlyTaskName ($($task.State), $(Get-PtTaskTriggerMode -Task $task) mode)"
    } else {
        Write-PtField 'Task' 'not installed'
    }
    Write-PtField 'Updater task' $(if ($null -ne $updater) { "$PortlyTaskPath$PortlyUpdaterTaskName ($($updater.State))" } else { 'not installed' })
    Write-PtField 'Running now' (Format-PtProcessList -Trees $running)
    foreach ($key in $hostKeys) {
        $state = if ($null -eq $key.Value) { 'not registered' } elseif ($key.Value) { "registered -> $($key.Value)" } else { 'registered (no value)' }
        Write-PtField "Host ($($key.Browser))" $state
    }
    Write-PtField 'Host folder' $(if ($hostDirExists) { $hostDir } else { "$hostDir (not present)" })
    Write-PtField 'Node.js copies' $(if ($runtimeDirExists) { $runtimeDir } else { "$runtimeDir (not present)" })
    Write-Host ''

    if ($DryRun) {
        Write-PtStep 'Steps a real run would take'
        foreach ($key in $hostKeys) {
            if ($null -ne $key.Value) {
                Write-PtInfo "- delete the registry key $($key.Display) ($($key.Browser))"
            } else {
                Write-PtInfo "- no $($key.Browser) registry key to delete ($($key.Display))"
            }
        }
        if ($hostDirExists) {
            Write-PtInfo "- delete the folder $hostDir (only that folder)"
        } else {
            Write-PtInfo "- no native host folder to delete ($hostDir)"
        }
        if ($null -ne $task -and "$($task.State)" -eq 'Running') { Write-PtInfo "- stop the task '$PortlyTaskName'" }
        if ($running.Count -gt 0) { Write-PtInfo "- stop $(Format-PtProcessList -Trees $running)" }
        if ($null -ne $task) {
            Write-PtInfo "- unregister the task '$PortlyTaskName'"
        } else {
            Write-PtInfo '- no task to unregister'
        }
        if ($null -ne $updater) {
            Write-PtInfo "- stop and unregister the task '$PortlyUpdaterTaskName'"
        } else {
            Write-PtInfo '- no updater task to unregister'
        }
        if ($runtimeDirExists) {
            Write-PtInfo "- delete the folder $runtimeDir ($PortlySupervisorProgram, $PortlyServerProgram; only that folder)"
        } else {
            Write-PtInfo "- no folder of Portly's copies of node.exe to delete ($runtimeDir)"
        }
        Write-PtInfo "- leave the data folder untouched: $dataDir"
        Write-Host ''
        Write-PtOk 'Dry run complete: nothing was stopped or removed.'
        return 0
    }

    # The native host goes first: once it is gone, no browser start or new tab can start the task
    # again while it is being stopped and removed.
    if ($presentKeys.Count -gt 0 -or $hostDirExists) {
        Write-PtStep "Removing the native messaging host $PortlyNativeHostName"
        $null = Uninstall-PtNativeHost -Destination $hostDir
        Write-PtOk "Removed the registry keys for Chrome and Edge and $hostDir"
    } else {
        Write-PtOk 'The native messaging host is not installed; nothing to remove'
    }

    try {
        if ($null -ne $task -and "$($task.State)" -eq 'Running') {
            Write-PtStep "Stopping the task '$PortlyTaskName'"
            Stop-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
        }
        $stopped = @(Stop-PtSupervisorProcesses -RepoRoot $repoRoot)
        if ($stopped.Count -gt 0) {
            Write-PtOk "Stopped Portly (PID $($stopped -join ', '))"
        }
        if ($null -ne $task) {
            Write-PtStep "Removing the task '$PortlyTaskName'"
            Unregister-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -Confirm:$false
            Write-PtOk 'Autostart task removed'
        } else {
            Write-PtOk "The task '$PortlyTaskName' is not installed; nothing to remove"
        }
        if ($null -ne $updater) {
            Write-PtStep "Removing the task '$PortlyUpdaterTaskName'"
            if ("$($updater.State)" -eq 'Running') { Stop-ScheduledTask -TaskName $PortlyUpdaterTaskName -TaskPath $PortlyTaskPath }
            Unregister-ScheduledTask -TaskName $PortlyUpdaterTaskName -TaskPath $PortlyTaskPath -Confirm:$false
            Write-PtOk 'Updater task removed'
        }
    } catch {
        if (Test-PtAccessDenied $_) {
            Write-PtAccessDeniedHint -ScriptPath $scriptPath
            return 5
        }
        throw
    }

    if ($runtimeDirExists) {
        # Nothing runs from it any more: the processes were stopped above.
        try {
            $null = Remove-PtRuntimeFolder -Path $runtimeDir
            Write-PtOk "Removed $runtimeDir (Portly's copies of node.exe)"
        } catch {
            Write-Warning "Could not remove $runtimeDir ($($_.Exception.Message)). Delete it yourself once nothing runs from it."
        }
    }

    Start-Sleep -Milliseconds 500
    $health = Test-PtHealth -Port $port -TimeoutSeconds 2
    if ($health.Ok) {
        Write-Warning ("Portly is still $(Format-PtHealth $health) - probably started with npm start or scripts\start.ps1. " +
            'Stop it with Ctrl+C in that window.')
    }
    Write-PtInfo "Your data was left untouched in $dataDir"
    Write-PtInfo '(delete that folder yourself to remove settings, cached data and encrypted credentials).'
    Write-PtInfo 'The new-tab extension keeps working; it shows its "Portly isn''t running" page until you start Portly yourself.'
    return 0
}

try {
    $exitCode = Invoke-Uninstall | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    if (Test-PtAccessDenied $_) {
        Write-PtAccessDeniedHint -ScriptPath (Join-Path $PSScriptRoot 'uninstall-autostart.ps1')
        exit 5
    }
    Write-PtFailure $_.Exception.Message
    exit 1
}
