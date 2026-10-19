<#
.SYNOPSIS
    Sets up Portly to start by itself: when Chrome or Edge opens (default), or at sign-in.

.DESCRIPTION
    Registers the per-user scheduled task "Portly Server" (ARCHITECTURE section 12):

      Trigger    -Trigger Browser (default): none - the task runs only on demand
                 -Trigger Logon: at log on of the current user (-LogonDelaySeconds)
      Action     %SystemRoot%\System32\conhost.exe --headless
                 "%LOCALAPPDATA%\Portly\node\portly-supervisor.exe" "<repo>\server\src\supervisor.ts"
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

    So that Task Manager's Details tab and Resource Monitor show Portly by name instead of two
    node.exe, the task runs a copy of node.exe named portly-supervisor.exe, and the supervisor
    starts the server as portly-server.exe (a hard link of that copy, so one file on disk):

      Files      %LOCALAPPDATA%\Portly\node\ portly-supervisor.exe, portly-server.exe,
                 runtime.json (which node.exe they were copied from)

    The copies are refreshed when that node.exe changes (by this script, update.ps1 and
    portly --start). If they cannot be made or do not run, the task runs node.exe itself.

    Then it builds web\dist if it is missing (npm run build), (re)starts the task and waits until
    http://localhost:<port>/api/health answers - this checks the installation end to end (use
    -NoStart to skip it). Running it again updates everything (also to switch modes).

    Coming from Homebase (Portly's name before the rename): first its user variables are copied,
    once, to their PORTLY_ names (HOMEBASE_PAGES_URL -> PORTLY_PAGES_URL, ...; never over a value
    that is already set; homebase-variables-copied.json in the data folder records it, so later
    runs leave them alone). HOMEBASE_DATA_DIR is not copied: it names the folder Homebase's data is copied
    from, and Portly keeps its own data folder. When Portly has no database yet, a request
    (copy-from-homebase.json in the data folder) asks Portly to copy Homebase's database and vault
    key at its first start; Homebase's data folder is left alone. Once Portly's task is registered, Homebase's server is stopped (it
    holds the port). Only once Portly answers its health check are the "Homebase Server" task (its
    definition saved to homebase-task-backup.xml in the data folder) and the com.homebase.launcher
    registrations removed; if Portly does not come up, Homebase's task is started again. With
    -NoStart, Homebase stays installed. -DryRun lists these steps too.

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
    node.exe to run (Node.js 24 or newer), and to copy as portly-supervisor.exe. Defaults to the
    node.exe found on PATH (a release install: its own runtime\node.exe).

.PARAMETER TimeoutSeconds
    How long to wait for /api/health after starting the task (10-600, default 90).

.PARAMETER NoStart
    Register everything but do not start Portly now.

.PARAMETER NoHomebaseCopy
    Start Portly from scratch on a PC that ran Homebase: copy neither its database and vault key
    nor its HOMEBASE_* user variables (a copy request already waiting is withdrawn; the variables
    are recorded as done, so later runs without this switch do not copy them either). Homebase's
    task and native host are still stopped and removed as usual, and its data folder stays.

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
    [switch]$NoStart,
    [switch]$NoHomebaseCopy
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# The same options, for the "run it again as administrator" hint.
function Format-HbInstallArguments {
    param([System.Collections.IDictionary]$Bound = @{})
    $parts = foreach ($name in @('Trigger', 'LogonDelaySeconds', 'NoNativeHost', 'ExtensionId', 'NodePath', 'TimeoutSeconds', 'NoStart', 'NoHomebaseCopy')) {
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

    # Coming from Homebase (ARCHITECTURE section 19). Only the variables are copied now (once:
    # the record of it is kept in the data folder), before anything reads the PORTLY_* settings;
    # Homebase's server is stopped once Portly's task is registered and removed only once Portly
    # answers (below). PORTLY_DATA_DIR is never among the variables copied, so the data folder is
    # already known; a value the configuration check rejects below just skips the record.
    $legacyDataDir = $null
    try { $legacyDataDir = Get-HbDataDir -Scope Task -RepoRoot $repoRoot } catch { $legacyDataDir = $null }
    $legacy = Get-HbLegacyPlan -DataDir $legacyDataDir
    if ($NoHomebaseCopy) {
        # From scratch: none of Homebase's settings either (still recorded, so it stays that way).
        $legacy.Copy = @()
        $legacy.Empty = (-not $legacy.RecordEnv -and $null -eq $legacy.Task -and @($legacy.RegistryKeys).Count -eq 0)
    }
    if (-not $legacy.Empty) {
        Write-HbStep "$(if ($DryRun) { '[dry run] ' } else { '' })Moving over from Homebase (Portly's name before the rename)"
        Write-HbLegacyPlan -Plan $legacy
        if (-not $DryRun) { Invoke-HbLegacyEnvCopy -Plan $legacy }
        Write-Host ''
    }
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
    # Portly's named copies of node.exe, for Task Manager (made or refreshed below).
    $runtimePlan = Get-HbRuntimePlan -NodeExe $node.Path
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

    # Homebase's database is copied by the server at its next start, only when requested here.
    $homebaseCopy = Get-HbHomebaseCopyPlan -DataDir $dataDir -CustomDataDir:($null -ne (Get-HbEnvValue -Name 'PORTLY_DATA_DIR' -Scope Task)) -HomebaseDataDir (Get-HbHomebaseDataDir -RepoRoot $repoRoot)
    if ($NoHomebaseCopy -and $homebaseCopy.State -in @('request', 'pending', 'portly-has-database')) { $homebaseCopy.State = 'skipped' }
    $homebaseCopyText = switch ($homebaseCopy.State) {
        'none' { 'no Homebase database found' }
        'skipped' { 'not copied (-NoHomebaseCopy): Portly starts from scratch' }
        'done' { "already copied ($($homebaseCopy.CopiedAt))" }
        'pending' { "requested; Portly copies $($homebaseCopy.Source) at its next start" }
        'portly-has-database' { "NOT copied: Portly already has a database in $dataDir" }
        default { "Portly will copy $($homebaseCopy.Source) at its first start" }
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
    Write-HbField 'Runs as' (Format-HbRuntimePlan -Plan $runtimePlan)
    Write-HbField 'User' $userId
    Write-HbField 'Starts' $startsText
    Write-HbField 'Native host' $nativeHostText
    Write-HbField 'Port' "$port ($($portSetting.Source))"
    Write-HbField 'Data folder' $dataDir
    Write-HbField 'Log files' "$logFile, $supervisorLog"
    Write-HbField 'Configuration' $configText
    if ($homebaseCopy.State -ne 'none') { Write-HbField 'Homebase data' $homebaseCopyText }
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
    if ($homebaseCopy.State -eq 'portly-has-database') {
        Write-Warning ("Portly already has a database in $dataDir, so Homebase's data ($($homebaseCopy.Source)) will not be copied. " +
            'To replace Portly''s database with Homebase''s (the current one is kept beside it), run: portly --copy-from-homebase --replace')
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

    $newDefinition = {
        param([string]$Program)
        New-HbTaskDefinition -RepoRoot $repoRoot -NodeExe $Program -UserId $userId -Trigger $Trigger -LogonDelaySeconds $LogonDelaySeconds
    }

    if ($DryRun) {
        Write-HbStep 'Scheduled task definition (dry run - not registered)'
        Write-HbTaskDefinition -Task (& $newDefinition $runtimePlan.SupervisorExe)
        Write-HbInfo "(If $PortlySupervisorProgram cannot be made or does not run, the task runs $($node.Path) instead.)"
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
        $copies = "$PortlySupervisorProgram (and $PortlyServerProgram, a hard link of it) in $($runtimePlan.Destination)"
        switch ($runtimePlan.State) {
            'current' { Write-HbInfo "- keep $copies`: up to date with $($node.Path)" }
            'stale' { Write-HbInfo "- refresh $copies from $($node.Path) (once Portly is stopped, if they are in use)" }
            default { Write-HbInfo "- copy $($node.Path) to $copies, so Task Manager shows Portly by name" }
        }
        Write-HbInfo "- check that $PortlySupervisorProgram runs and reports Node.js v$($node.Version), and record its source in $($runtimePlan.RecordPath)"
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
        if ($homebaseCopy.State -eq 'request') {
            Write-HbInfo "- ask Portly to copy Homebase's data at its first start: write $($homebaseCopy.RequestPath)"
        } elseif ($homebaseCopy.State -eq 'skipped') {
            Write-HbInfo "- copy nothing of Homebase (-NoHomebaseCopy); withdraw $($homebaseCopy.RequestPath) if it exists"
        }
        if ($running.Count -gt 0) {
            Write-HbInfo "- stop the Portly processes started from this folder: $(Format-HbProcessList -Trees $running)"
        }
        if ($NoStart) {
            Write-HbInfo '- leave Portly stopped (-NoStart)'
            if ($null -ne $legacy.Task) { Write-HbInfo "- leave Homebase installed and running (-NoStart: Portly cannot be checked)" }
        } else {
            if ($null -ne $legacy.Task) { Write-HbInfo "- stop the '$PortlyLegacyTaskName' task and its processes (it holds the port)" }
            Write-HbInfo "- start the task and wait up to $TimeoutSeconds s for http://localhost:$port/api/health"
            if (-not $legacy.Empty -and ($null -ne $legacy.Task -or @($legacy.RegistryKeys).Count -gt 0)) {
                Write-HbInfo "- when Portly answers: save the Homebase task to $(Join-Path $dataDir 'homebase-task-backup.xml') and remove it and com.homebase.launcher"
                if ($null -ne $legacy.Task) { Write-HbInfo "- when Portly does not come up: start the '$PortlyLegacyTaskName' task again" }
            }
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

    # Portly's named copies of node.exe. A copy the running Portly uses cannot be replaced yet: it
    # is kept (it works) and replaced once Portly is stopped, below.
    Write-HbStep "Preparing $PortlySupervisorProgram and $PortlyServerProgram (copies of node.exe that Task Manager shows by name)"
    $runtime = Update-HbRuntimeCopies -Plan $runtimePlan -NodeVersion $node.Version
    $taskProgram = $node.Path
    $retryRuntime = $false
    if ($runtime.Ok) {
        $taskProgram = $runtimePlan.SupervisorExe
        $how = if ($runtime.Linked) { 'a hard link of it' } else { 'a second copy' }
        if ($runtime.Changed) {
            Write-HbOk "Copied $($node.Path) to $($runtimePlan.SupervisorExe) ($PortlyServerProgram is $how)"
        } else {
            Write-HbOk "$($runtimePlan.SupervisorExe) and $PortlyServerProgram ($how) are up to date with $($node.Path)"
        }
    } elseif ($runtime.Usable) {
        $taskProgram = $runtimePlan.SupervisorExe
        $retryRuntime = $true
        Write-HbInfo "Not updated yet ($($runtime.Error)); trying again once Portly is stopped."
    } else {
        Write-Warning ("Could not make Portly's copies of node.exe ($($runtime.Error)). The task runs $($node.Path) " +
            'itself instead, so Task Manager shows node.exe. Portly works the same.')
    }
    $definition = & $newDefinition $taskProgram

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

    if ($homebaseCopy.State -eq 'request') {
        $requestPath = Write-HbHomebaseCopyRequest -DataDir $dataDir
        Write-HbOk "Asked Portly to copy Homebase's data at its first start ($requestPath)"
    } elseif ($homebaseCopy.State -eq 'skipped' -and (Remove-HbHomebaseCopyRequest -DataDir $dataDir)) {
        Write-HbOk 'Withdrew the waiting copy of Homebase''s data (-NoHomebaseCopy)'
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
    if ($retryRuntime) {
        $runtime = Update-HbRuntimeCopies -Plan (Get-HbRuntimePlan -NodeExe $node.Path) -NodeVersion $node.Version
        if ($runtime.Ok) {
            Write-HbOk "Updated $($runtimePlan.SupervisorExe) and $PortlyServerProgram from $($node.Path)"
        } elseif ($runtime.Usable) {
            Write-Warning "Could not update Portly's copies of node.exe ($($runtime.Error)). Portly runs the copies it has; run this script again later."
        } else {
            Write-Warning ("Could not update Portly's copies of node.exe ($($runtime.Error)). The task runs $($node.Path) " +
                'itself instead, so Task Manager shows node.exe.')
            $null = Register-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -InputObject (& $newDefinition $node.Path) -Force
            $taskProgram = $node.Path
        }
    }

    $nextStart = if ($Trigger -eq 'Logon') { 'at your next sign-in' } else { 'when Chrome or Edge next opens (or a new tab finds it not running)' }
    if ($NoStart) {
        Write-HbOk "Not started now (-NoStart). It starts $nextStart, or any time with: Start-ScheduledTask -TaskName '$PortlyTaskName'"
        if ($null -ne $legacy.Task -or @($legacy.RegistryKeys).Count -gt 0) {
            Write-HbInfo "Homebase is still installed: it is removed only once Portly answers. Run this script again without -NoStart to switch over."
        }
        Write-HbExtensionReminder -Plan $nativeHost
        return 0
    }

    # Homebase's server holds the port. Stop it now, but remove it only once Portly answers;
    # otherwise (a failed start, an error) start it again, so this PC is never left without a server.
    $legacyStopped = $false
    $keepLegacyStopped = $false
    try {
        if ($null -ne $legacy.Task) {
            Write-HbStep "Stopping Homebase's server (the '$PortlyLegacyTaskName' task; removed only once Portly answers)"
            $legacyStopped = Suspend-HbLegacyServer -Plan $legacy
            Start-Sleep -Milliseconds 500
        }

        $already = Test-HbHealth -Port $port -TimeoutSeconds 2
        if ($already.Ok -and $already.App -eq 'portly') {
            # Another Portly holds the port, so Homebase could not start there anyway.
            $keepLegacyStopped = $true
            Write-Warning ("Portly is already $(Format-HbHealth $already), started outside the task (npm start or scripts\start.ps1?). " +
                "The task will start Portly $nextStart. To switch now, stop the other instance (Ctrl+C in its window) and run: " +
                "Start-ScheduledTask -TaskName '$PortlyTaskName'")
            if ($null -ne $legacy.Task -or @($legacy.RegistryKeys).Count -gt 0) { Write-HbInfo 'Homebase is still installed. Run this script again once the task runs Portly to remove it.' }
            Write-HbExtensionReminder -Plan $nativeHost
            return 0
        }
        if ($null -ne $already.Listeners -and $already.Listeners.Count -gt 0) {
            $what = if ($already.Ok) { "a server that answers as '$($already.App)', not Portly" } else { 'does not answer as Portly' }
            Write-HbFailure "Port $port is in use by $(Format-HbPortOwners $already.Listeners), which $what, so Portly cannot start there."
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

        if ($health.Ok -and $health.App -eq 'portly') {
            $keepLegacyStopped = $true
            Write-HbOk "Portly is $(Format-HbHealth $health)"
            if ($health.Vault -eq 'locked') {
                Write-Warning 'The credential vault is locked: open Portly > Settings > Accounts and follow the banner.'
            }
            if ($null -ne $legacy.Task -or @($legacy.RegistryKeys).Count -gt 0) {
                $backup = Join-Path $dataDir 'homebase-task-backup.xml'
                Write-HbStep "Removing Homebase's task and native host registrations (its data folder stays)"
                try {
                    Remove-HbLegacyInstall -Plan $legacy -BackupPath $backup
                } catch {
                    Write-HbFailure "Portly works, but Homebase could not be removed: $($_.Exception.Message). Run this script again."
                    return 1
                }
                if ($null -ne $legacy.Task) { Write-HbOk "Removed. The old task's definition is saved in $backup" } else { Write-HbOk 'Removed' }
                Write-HbInfo 'In the browser, remove the Homebase New Tab extension and load Portly''s (docs\SETUP.md, Coming from Homebase).'
            }
            Write-Host ''
            Write-HbInfo "From now on it starts $nextStart."
            if ($taskProgram -ne $node.Path) {
                Write-HbInfo "Task Manager (Details tab) shows it as $PortlySupervisorProgram and $PortlyServerProgram."
            }
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
    } finally {
        if ($legacyStopped -and -not $keepLegacyStopped) {
            # Portly's own task must not keep the port either.
            try { Stop-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -ErrorAction Stop } catch { }
            $null = Stop-HbSupervisorProcesses -RepoRoot $repoRoot
            Write-HbStep "Starting Homebase's server again (nothing of it was removed)"
            try {
                Resume-HbLegacyServer -Plan $legacy
                Write-HbOk "Started the '$PortlyLegacyTaskName' task again"
            } catch {
                Write-HbFailure "Could not start the '$PortlyLegacyTaskName' task again: $($_.Exception.Message). Run: Start-ScheduledTask -TaskName '$PortlyLegacyTaskName'"
            }
        }
    }
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
