<#
.SYNOPSIS
    Sets up Portly to start by itself: when Chrome or Edge opens (default), or at sign-in.

.DESCRIPTION
    Registers the per-user scheduled task "Portly Server" (ARCHITECTURE section 12):

      Trigger    -Trigger Browser (default): none - the task runs only on demand
                 -Trigger Logon: at log on of the current user (-LogonDelaySeconds)
      Action     %SystemRoot%\System32\conhost.exe --headless "<node.exe>" "<repo>\server\src\supervisor.ts"
      Principal  current user, LogonType Interactive, RunLevel Limited (not elevated)
      Settings   no time limit, runs on battery, one instance (IgnoreNew), starts when available,
                 priority 4, 3 restarts one minute apart (launch failures only - the
                 supervisor restarts the server itself if it crashes)

    and, in both modes, the native messaging host "com.portly.launcher" for Chrome and Edge:

      Files      %LOCALAPPDATA%\Portly\native-host\ launcher.cmd, launcher.mjs,
                 com.portly.launcher.json (host manifest), config.json
      Registry   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher and
                 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher
                 (default value = path of com.portly.launcher.json; no administrator rights)

    The new-tab extension asks that host to start Portly when the browser opens and when a new
    tab finds Portly not running; the host runs "schtasks /run /tn \Portly Server", so Task
    Scheduler - not the browser - starts the server. Only the Portly extension may use the host:
    its ID is computed from the "key" in extension\manifest.json.

    Then it builds web\dist if it is missing (npm run build), (re)starts the task and waits until
    http://localhost:<port>/api/health answers - this checks the installation end to end (use
    -NoStart to skip it). Running it again updates everything (also to switch modes).

    The port and data folder come from the PORTLY_PORT / PORTLY_DATA_DIR user (or machine)
    environment variables when set, exactly as the task will see them. Before changing anything,
    the PORTLY_* variables are checked with the server's own configuration loader
    (server\src\config.ts): the background server's console output is not visible, so a value it
    would reject is reported here instead.

.PARAMETER Trigger
    Browser (default): no sign-in trigger; Portly starts when Chrome/Edge opens or a new tab
    needs it, through the extension and the native host. Logon: start at every sign-in (the
    previous behaviour); the native host is registered too, as a fallback.

.PARAMETER LogonDelaySeconds
    With -Trigger Logon only: wait this long after sign-in before starting (0-3600, default 0).

.PARAMETER NoNativeHost
    Do not register the native messaging host (with -Trigger Browser, nothing then starts
    Portly by itself).

.PARAMETER ExtensionId
    Allow this extension ID (32 letters a-p) instead of the one computed from the "key" in
    extension\manifest.json.

.PARAMETER DryRun
    Print the complete task definition, every file and registry value and every step that would
    run, without registering, writing, building, stopping or starting anything. Exits with 1 if
    something must be fixed first.

.PARAMETER NodePath
    node.exe to run (Node.js 24 or newer). Defaults to the node.exe found on PATH.

.PARAMETER TimeoutSeconds
    How long to wait for /api/health after starting the task (10-600, default 90).

.PARAMETER NoStart
    Register everything but do not start Portly now.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Trigger Logon -LogonDelaySeconds 30

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Browser', 'Logon')][string]$Trigger = 'Browser',
    [ValidateRange(0, 3600)][int]$LogonDelaySeconds = 0,
    [switch]$NoNativeHost,
    [ValidatePattern('(?-i)^[a-p]{32}$')][string]$ExtensionId,
    [switch]$DryRun,
    [ValidateNotNullOrEmpty()][string]$NodePath,
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 90,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# The same options, for the "run it again as administrator" hint.
function Format-HbInstallArguments {
    param([System.Collections.IDictionary]$Bound = @{})
    $parts = foreach ($name in @('Trigger', 'LogonDelaySeconds', 'NoNativeHost', 'ExtensionId', 'NodePath', 'TimeoutSeconds', 'NoStart')) {
        if (-not $Bound.ContainsKey($name)) { continue }
        $value = $Bound[$name]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { "-$name" }
        } elseif ("$value" -match '\s') {
            "-$name ""$value"""
        } else {
            "-$name $value"
        }
    }
    return (@($parts) -join ' ')
}

function Invoke-Install {
    param([System.Collections.IDictionary]$Bound = @{})
    if (-not (Test-HbWindows)) { throw 'Autostart uses Windows Task Scheduler and only works on Windows.' }
    if (-not (Test-HbScheduledTasksAvailable)) {
        throw 'The ScheduledTasks PowerShell module is not available (it ships with Windows 8 and later).'
    }
    if ($Trigger -ne 'Logon' -and $Bound.ContainsKey('LogonDelaySeconds')) {
        throw '-LogonDelaySeconds only applies with -Trigger Logon.'
    }

    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    $scriptPath = Join-Path $PSScriptRoot 'install-autostart.ps1'
    $hintArguments = Format-HbInstallArguments -Bound $Bound
    $problems = New-Object System.Collections.Generic.List[string]

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'server\src\index.ts') -PathType Leaf)) {
        throw "This script must stay in the scripts folder of a Portly checkout (no server\src\index.ts under $repoRoot)."
    }
    $supervisor = Join-Path $repoRoot 'server\src\supervisor.ts'
    if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
        $problems.Add("The supervisor is missing: $supervisor")
    }
    if (-not (Test-HbDependenciesInstalled -RepoRoot $repoRoot)) {
        $problems.Add("Dependencies are not installed. In $repoRoot run: npm ci")
    }
    # A release install links node_modules\@portly\shared itself (install.ps1); put it back if
    # it went missing, before the configuration check below loads the server's code.
    if (-not $DryRun -and $null -ne (Get-HbReleaseInfo -RepoRoot $repoRoot)) { $null = Initialize-HbReleaseLinks -RepoRoot $repoRoot }
    $conhost = "$env:SystemRoot\System32\conhost.exe"
    if (-not (Test-Path -LiteralPath $conhost -PathType Leaf)) {
        $problems.Add("conhost.exe was not found at $conhost")
    }

    $node = Resolve-HbNode -NodePath $NodePath -RepoRoot $repoRoot
    $portSetting = Get-HbPortSetting -Scope Task
    $port = $portSetting.Port
    $dataDir = Get-HbDataDir -Scope Task -RepoRoot $repoRoot
    # The server's own config loader, with the environment the task gets: its output would be
    # lost there, so a value it rejects must be caught now.
    $serverConfig = Test-HbServerConfig -NodeExe $node.Path -RepoRoot $repoRoot -Scope Task
    if ($serverConfig.Ok) {
        $port = $serverConfig.Port
        $dataDir = $serverConfig.DataDir
        $configText = 'valid (checked with server\src\config.ts)'
    } else {
        $problems.Add("The server would refuse to start from the task: $($serverConfig.Error). Fix or remove that user/machine environment variable, then run this script again.")
        $configText = "INVALID: $($serverConfig.Error)"
    }

    # Native messaging host: allowed only for the extension ID pinned by extension\manifest.json.
    $nativeHost = $null
    $nativeHostText = 'not registered (-NoNativeHost)'
    if (-not $NoNativeHost) {
        try {
            if ($ExtensionId) {
                $allowedId = $ExtensionId
                $idSource = '-ExtensionId'
            } else {
                $allowedId = Get-HbExtensionIdFromManifest -ManifestPath (Join-Path $repoRoot 'extension\manifest.json')
                $idSource = 'from the "key" in extension\manifest.json'
            }
            $nativeHost = New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $node.Path -ExtensionId $allowedId
            $nativeHostText = "$PortlyNativeHostName for extension $allowedId ($idSource)"
        } catch {
            $problems.Add($_.Exception.Message)
            $nativeHostText = "CANNOT REGISTER: $($_.Exception.Message)"
        }
    }

    $logFile = Get-HbLogFile -DataDir $dataDir
    $supervisorLog = Get-HbSupervisorLogFile -DataDir $dataDir
    $userId = Get-HbCurrentUserId
    $webBuilt = Test-HbWebBuilt -RepoRoot $repoRoot
    $existing = Get-HbTask
    $running = @(Get-HbSupervisorProcesses -RepoRoot $repoRoot)
    $startsText = if ($Trigger -eq 'Logon') {
        if ($LogonDelaySeconds -gt 0) { "at sign-in of $userId, after $LogonDelaySeconds s (-Trigger Logon)" } else { "at sign-in of $userId (-Trigger Logon)" }
    } else {
        'when Chrome or Edge opens, or a new tab finds it not running (-Trigger Browser; no sign-in trigger)'
    }

    Write-Host ''
    Write-Host 'Portly autostart' -ForegroundColor White
    Write-HbField 'Repository' $repoRoot
    Write-HbField 'Node.js' "$($node.Path) (v$($node.Version))"
    Write-HbField 'User' $userId
    Write-HbField 'Starts' $startsText
    Write-HbField 'Native host' $nativeHostText
    Write-HbField 'Port' "$port ($($portSetting.Source))"
    Write-HbField 'Data folder' $dataDir
    Write-HbField 'Log files' "$logFile, $supervisorLog"
    Write-HbField 'Configuration' $configText
    if ($null -ne $existing) {
        Write-HbField 'Existing task' "$($existing.State), $(Get-HbTaskTriggerMode -Task $existing) mode - it will be replaced"
    } else {
        Write-HbField 'Existing task' 'none'
    }
    Write-HbField 'Running now' (Format-HbProcessList -Trees $running)
    Write-Host ''

    if ($node.LooksTemporary) {
        Write-Warning "$($node.Path) looks like a temporary, per-shell path (fnm/nvm shims). Pass -NodePath with a permanent node.exe so the task and the native host still work after a reboot."
    }
    if (Test-HbTruthy (Get-HbEnvValue -Name 'PORTLY_DEV' -Scope Task)) {
        Write-Warning 'PORTLY_DEV is set for your user, so the autostarted server would run in development mode (it expects the Vite dev server). Remove that environment variable unless you mean it.'
    }
    if ($port -lt 1024) {
        Write-Warning "Port $port is below 1024; the new-tab extension only accepts ports 1024-65535."
    }
    if ($Trigger -eq 'Browser' -and $NoNativeHost) {
        Write-Warning ('-Trigger Browser with -NoNativeHost: the task has no trigger and the browser cannot start it, so nothing starts Portly by itself. ' +
            "Start it with Start-ScheduledTask -TaskName '$PortlyTaskName', or drop -NoNativeHost.")
    }
    foreach ($mismatch in @(Get-HbEnvMismatches)) {
        $inWindow = if ($null -ne $mismatch.Process) { "'$($mismatch.Process)'" } else { 'not set' }
        $forTask = if ($null -ne $mismatch.Task) { "'$($mismatch.Task)'" } else { 'not set' }
        Write-Warning ("$($mismatch.Name) is $inWindow in this PowerShell window but $forTask in your user/machine environment, " +
            'which is what the task sees. To make the task use it, set it as a user environment variable: ' +
            "[Environment]::SetEnvironmentVariable('$($mismatch.Name)', '<value>', 'User'), then run this script again.")
    }

    $definition = New-HbTaskDefinition -RepoRoot $repoRoot -NodeExe $node.Path -UserId $userId -Trigger $Trigger -LogonDelaySeconds $LogonDelaySeconds

    if ($DryRun) {
        Write-HbStep 'Scheduled task definition (dry run - not registered)'
        Write-HbTaskDefinition -Task $definition
        Write-Host ''
        if ($null -ne $nativeHost) {
            Write-HbStep 'Native messaging host (dry run - nothing written)'
            Write-HbNativeHostPlan -Plan $nativeHost
            Write-Host ''
        }
        Write-HbStep 'Steps a real run would take'
        foreach ($problem in $problems) { Write-Warning "Must be fixed first: $problem" }
        if ($webBuilt) {
            Write-HbInfo '- web\dist is present; no build needed'
        } else {
            Write-HbInfo '- build the web app: npm run build (web\dist is missing)'
        }
        if ($null -ne $existing) {
            Write-HbInfo "- replace the existing task '$PortlyTaskName' (state: $($existing.State), $(Get-HbTaskTriggerMode -Task $existing) mode) with the $Trigger mode task"
        } else {
            Write-HbInfo "- register the task '$PortlyTaskName' for $userId ($Trigger mode)"
        }
        if ($null -ne $nativeHost) {
            Write-HbInfo "- write the $(@($nativeHost.Files).Count) native host files to $($nativeHost.Destination)"
            foreach ($entry in @($nativeHost.Registry)) {
                Write-HbInfo "- set the default value of $($entry.Display) ($($entry.Browser))"
            }
        } elseif ($NoNativeHost) {
            Write-HbInfo '- leave the native messaging host alone (-NoNativeHost)'
        }
        if ($running.Count -gt 0) {
            Write-HbInfo "- stop the Portly processes started from this folder: $(Format-HbProcessList -Trees $running)"
        }
        if ($NoStart) {
            Write-HbInfo '- leave Portly stopped (-NoStart)'
        } else {
            Write-HbInfo "- start the task and wait up to $TimeoutSeconds s for http://localhost:$port/api/health"
        }
        Write-Host ''
        Write-HbOk 'Dry run complete: nothing was registered, written, built, stopped or started.'
        if ($problems.Count -gt 0) {
            Write-HbFailure "$($problems.Count) problem(s) above must be fixed before a real run."
            return 1
        }
        return 0
    }

    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-HbFailure $problem }
        return 1
    }
    if (Test-HbElevated) {
        Write-HbInfo "Running as administrator; the task is still registered for $userId with RunLevel Limited."
    }

    if (-not $webBuilt) {
        Write-HbStep 'Building the web app (web\dist is missing): npm run build'
        Invoke-HbWebBuild -RepoRoot $repoRoot
        Write-HbOk 'Web app built'
    }

    Write-HbStep "Registering scheduled task '$PortlyTaskName' ($Trigger mode)"
    try {
        $null = Register-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -InputObject $definition -Force
    } catch {
        if (Test-HbAccessDenied $_) {
            Write-HbAccessDeniedHint -ScriptPath $scriptPath -Arguments $hintArguments
            return 5
        }
        throw
    }
    if ($Trigger -eq 'Logon') {
        Write-HbOk "Registered: it starts Portly whenever $userId signs in"
    } else {
        Write-HbOk 'Registered: no sign-in trigger; it runs when the browser extension asks for it'
    }

    if ($null -ne $nativeHost) {
        Write-HbStep "Registering the native messaging host $PortlyNativeHostName (Chrome and Edge)"
        Install-HbNativeHost -Plan $nativeHost
        Write-HbOk "Wrote $($nativeHost.Destination) and the registry keys for Chrome and Edge (allowed extension: $($nativeHost.ExtensionId))"
    }

    # Replace whatever the previous registration started. Stop-ScheduledTask ends only conhost,
    # so the node supervisor/server started from this folder are stopped explicitly.
    $current = Get-HbTask
    if ($null -ne $current -and "$($current.State)" -eq 'Running') {
        Write-HbStep 'Stopping the running task'
        Stop-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
    }
    $stopped = @(Stop-HbSupervisorProcesses -RepoRoot $repoRoot)
    if ($stopped.Count -gt 0) {
        Write-HbInfo "Stopped the previous Portly processes (PID $($stopped -join ', '))"
        Start-Sleep -Milliseconds 500
    }

    $nextStart = if ($Trigger -eq 'Logon') { 'at your next sign-in' } else { 'when Chrome or Edge next opens (or a new tab finds it not running)' }
    if ($NoStart) {
        Write-HbOk "Not started now (-NoStart). It starts $nextStart, or any time with: Start-ScheduledTask -TaskName '$PortlyTaskName'"
        Write-HbExtensionReminder -Plan $nativeHost
        return 0
    }

    $already = Test-HbHealth -Port $port -TimeoutSeconds 2
    if ($already.Ok) {
        Write-Warning ("Portly is already $(Format-HbHealth $already), started outside the task (npm start or scripts\start.ps1?). " +
            "The task will start Portly $nextStart. To switch now, stop the other instance (Ctrl+C in its window) and run: " +
            "Start-ScheduledTask -TaskName '$PortlyTaskName'")
        Write-HbExtensionReminder -Plan $nativeHost
        return 0
    }
    if ($null -ne $already.Listeners -and $already.Listeners.Count -gt 0) {
        Write-HbFailure "Port $port is in use by $(Format-HbPortOwners $already.Listeners), which does not answer as Portly, so Portly cannot start there."
        Write-HbInfo "The task is registered. Stop that program (or set the PORTLY_PORT user environment variable to a free port and run this script again), then run: Start-ScheduledTask -TaskName '$PortlyTaskName'"
        return 1
    }

    Write-HbStep 'Starting the task (checks the installation end to end)'
    Start-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
    $startedAt = [System.DateTime]::UtcNow
    Write-HbInfo "Waiting up to $TimeoutSeconds s for http://localhost:$port/api/health ..."
    $health = Wait-HbHealth -Port $port -TimeoutSeconds $TimeoutSeconds -ContinueWhile {
        # Give the task a few seconds to show as Running; after that, stop waiting if it exited.
        $task = Get-HbTask
        (([System.DateTime]::UtcNow - $startedAt).TotalSeconds -lt 5) -or ($null -ne $task -and "$($task.State)" -eq 'Running')
    }

    if ($health.Ok) {
        Write-HbOk "Portly is $(Format-HbHealth $health)"
        if ($health.Vault -eq 'locked') {
            Write-Warning 'The credential vault is locked: open Portly > Settings > Accounts and follow the banner.'
        }
        Write-Host ''
        Write-HbInfo "From now on it starts $nextStart."
        Write-HbExtensionReminder -Plan $nativeHost
        Write-HbInfo "Open http://localhost:$port - or install the new-tab extension (docs\setup\extension.md)."
        Write-HbInfo 'Check on it later with: scripts\status.ps1   Remove it with: scripts\uninstall-autostart.ps1'
        return 0
    }

    Write-HbFailure "Portly did not come up: $(Format-HbHealth $health)"
    $task = Get-HbTask
    if ($null -ne $task) {
        $info = Get-ScheduledTaskInfo -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
        Write-HbField 'Task state' "$($task.State)"
        Write-HbField 'Last result' (Format-HbTaskResult -Code $info.LastTaskResult)
    }
    Write-HbInfo 'Everything stays registered. Troubleshooting: docs\setup\troubleshooting.md'
    Write-HbLogTail -LogFile $supervisorLog -Lines 10
    Write-HbLogTail -LogFile $logFile -Lines 20
    return 1
}

# The one-time extension step after the ID was pinned with a manifest "key".
function Write-HbExtensionReminder {
    param($Plan)
    if ($null -eq $Plan) { return }
    Write-HbInfo ("New-tab extension: its ID is now fixed ($($Plan.ExtensionId)). If you loaded it before this version, " +
        'remove it once on chrome://extensions (or edge://extensions) and Load unpacked again - see docs\setup\extension.md.')
}

try {
    $exitCode = Invoke-Install -Bound $PSBoundParameters | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    if (Test-HbAccessDenied $_) {
        Write-HbAccessDeniedHint -ScriptPath (Join-Path $PSScriptRoot 'install-autostart.ps1') -Arguments (Format-HbInstallArguments -Bound $PSBoundParameters)
        exit 5
    }
    Write-HbFailure $_.Exception.Message
    exit 1
}
