<#
.SYNOPSIS
    Try this checkout's Portly live, on a copy of your data, before committing it.

.DESCRIPTION
    Run it from the checkout (main folder or a .claude\worktrees\<name> worktree) whose code you
    want to try. It:

    1. builds this checkout's page and its Pages (static) build;
    2. pauses your normal Portly: stops its server (node.exe, or portly-supervisor.exe and
       portly-server.exe) and disables the 'Portly Server' task, so the extension cannot start it
       again meanwhile, and stops any other Portly server on the port, such as a leftover
       `npm run dev` (port 5757 must be free: Google only accepts sign-ins that come back to
       localhost:5757);
    3. copies your data folder (without backups, logs and Portly's copies of node.exe) to a
       temporary folder;
    4. starts this checkout's server on port 5757 with the copy (as plain node.exe, so Task
       Manager tells it from your normal Portly), and serves this checkout's Pages build at
       http://localhost:<PagesPort> as a stand-in for the published site (nothing is published);
    5. waits until you press Enter, then stops both, deletes the copy (unless -KeepData), turns the
       task back on and starts your normal Portly again (refreshing its copies of node.exe when
       they are out of date) - also after Ctrl+C or an error.

    Your real data folder is only read. Anything you change during the test (accounts added,
    pairings, settings) happens in the copy and is gone afterwards.

.PARAMETER PagesPort
    Port of the stand-in Pages site (default 5175).

.PARAMETER KeepData
    Keep the temporary copy of the data folder (it holds your encrypted credentials) instead of
    deleting it at the end.

.PARAMETER SkipBuild
    Use the builds already in web\dist and web\dist-static.

.PARAMETER DryRun
    Print what would be built, paused, copied, started and restored, and change nothing.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\try-branch.ps1
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$PagesPort = 5175,
    [switch]$KeepData,
    [switch]$SkipBuild,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$ErrorActionPreference = 'Stop'

$checkout = Get-PtRepoRoot -ScriptRoot $PSScriptRoot
# The normal Portly runs from the main folder: for a worktree that is three levels up.
$mainRoot = $checkout
if (Test-PtWorktreePath $checkout) {
    $mainRoot = [System.IO.Path]::GetFullPath((Join-Path $checkout '..\..\..'))
}
# Where the normal Portly really runs from: the folder its task starts in. A release install lives
# in <install folder>pp, not in the main checkout, so both are searched for processes to stop.
function Get-PtNormalRoots {
    param($Task, [Parameter(Mandatory)][string]$MainRoot)
    $roots = New-Object System.Collections.Generic.List[string]
    $roots.Add($MainRoot)
    if ($null -ne $Task) {
        $action = @($Task.Actions)[0]
        $dir = "$(Get-PtProperty $action 'WorkingDirectory')".Trim().Trim('"')
        if ($dir -and (Test-Path -LiteralPath $dir -PathType Container)) {
            $full = [System.IO.Path]::GetFullPath($dir).TrimEnd('')
            if (-not ($roots | Where-Object { $_.TrimEnd('') -ieq $full })) { $roots.Add($full) }
        }
    }
    return $roots.ToArray()
}

$port = (Get-PtPortSetting -Scope Task).Port
if ($port -ne $PortlyDefaultPort) {
    Write-PtInfo "Your Portly uses port $port; the test server takes it over the same way."
}
$realData = Get-PtDataDir -Scope Task -RepoRoot $mainRoot
$testData = Join-Path ([System.IO.Path]::GetTempPath()) ("portly-try-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$pagesUrl = "http://localhost:$PagesPort/"
$node = (Resolve-PtNode).Path
$vite = Join-Path $checkout 'node_modules\vite\bin\vite.js'

Write-PtStep "Trying $checkout"
Write-PtField 'Your data' "$realData (only read)"
Write-PtField 'Test copy' $testData
Write-PtField 'Test server' "http://localhost:$port"
Write-PtField 'Stand-in Pages site' $pagesUrl

if (-not (Test-Path -LiteralPath $realData -PathType Container)) {
    Write-PtFailure "No data folder at $realData."
    exit 1
}
$busy = Get-PtPortListeners -Port $PagesPort
if ($null -ne $busy -and $busy.Count -gt 0) {
    # Portly's own Vite left over from an earlier run (portly dev, npm run dev) is stopped; a dry run
    # only reports it.
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    $stalePreviews = @(Select-PtStaleViteServers -Processes $all -Listeners $busy)
    $staleIds = @($stalePreviews | ForEach-Object { [int]$_.ProcessId })
    foreach ($stale in $stalePreviews) {
        if ($DryRun) {
            Write-PtInfo "A dry run leaves the leftover Portly Vite server on port $PagesPort ($($stale.Name), PID $($stale.ProcessId)); a real run stops it."
        } else {
            Stop-Process -Id ([int]$stale.ProcessId) -Force -ErrorAction Stop
            Write-PtWarn "Stopped a leftover Portly Vite server on port $PagesPort ($($stale.Name), PID $($stale.ProcessId))."
        }
    }
    if (-not $DryRun) {
        $deadline = [System.DateTime]::UtcNow.AddSeconds(5)
        do {
            $busy = Get-PtPortListeners -Port $PagesPort
            if ($null -eq $busy -or $busy.Count -eq 0) { break }
            Start-Sleep -Milliseconds 300
        } while ([System.DateTime]::UtcNow -lt $deadline)
    } else {
        $busy = @($busy | Where-Object { $staleIds -notcontains [int]$_.ProcessId })
    }
}
if ($null -ne $busy -and $busy.Count -gt 0) {
    Write-PtFailure "Port $PagesPort is in use by $(Format-PtPortOwners $busy). Pick another with -PagesPort."
    exit 1
}

if ($DryRun) {
    $dryTask = Get-PtTask
    Write-PtStep 'Steps a real run would take'
    if ($SkipBuild) {
        Write-PtInfo '- use the builds already in web\dist and web\dist-static (-SkipBuild)'
    } else {
        if (-not (Test-Path -LiteralPath $vite -PathType Leaf)) { Write-PtInfo '- install the dependencies: npm ci' }
        Write-PtInfo "- build: npm run build, then npm run build:static (PORTLY_STATIC_SERVER=http://127.0.0.1:$port)"
    }
    if ($null -ne $dryTask -and $dryTask.State -ne 'Disabled') { Write-PtInfo "- disable the task '$PortlyTaskName' for the test" }
    $dryRoots = @(Get-PtNormalRoots -Task $dryTask -MainRoot $mainRoot)
    foreach ($root in $dryRoots) {
        Write-PtInfo "- stop the Portly processes started from $root`: $(Format-PtProcessList -Trees @(Get-PtSupervisorProcesses -RepoRoot $root))"
    }
    $dryListeners = Get-PtPortListeners -Port $port
    if ($null -ne $dryListeners -and $dryListeners.Count -gt 0) {
        $dryAll = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
        foreach ($stale in @(Select-PtStaleServers -Processes $dryAll -Listeners $dryListeners)) {
            Write-PtInfo "- stop the other Portly server on port $port ($($stale.Name), PID $($stale.ProcessId))"
        }
    }
    Write-PtInfo "- copy $realData to $testData, without backups, logs and $(Get-PtRuntimeDir)"
    Write-PtInfo "- start $node server\src\index.ts in $checkout on port $port with the copy, and the stand-in Pages site on port $PagesPort"
    $deleteCopy = if ($KeepData) { 'keep the copy (-KeepData)' } else { 'delete the copy' }
    Write-PtInfo "- wait for Enter, then stop both and $deleteCopy"
    if ($null -ne $dryTask) {
        if ($dryTask.State -ne 'Disabled') { Write-PtInfo "- enable the task '$PortlyTaskName' again" }
        $note = Sync-PtTaskRuntime -Task $dryTask -DryRun
        if ($note) { Write-PtInfo "- $note" }
        Write-PtInfo "- start the task '$PortlyTaskName' and wait for your normal Portly"
    }
    Write-Host ''
    Write-PtOk 'Dry run complete: nothing was built, stopped, copied or started.'
    exit 0
}

# --- 1. Build ------------------------------------------------------------------------------
Push-Location $checkout
try {
    if (-not (Test-Path -LiteralPath $vite -PathType Leaf)) {
        Write-PtStep 'Installing dependencies (npm ci)'
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    if (-not $SkipBuild) {
        Write-PtStep 'Building the page and the Pages build'
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
        $previousStatic = $env:PORTLY_STATIC_SERVER
        $env:PORTLY_STATIC_SERVER = "http://127.0.0.1:$port"
        try {
            & npm run build:static
            if ($LASTEXITCODE -ne 0) { throw 'npm run build:static failed.' }
        } finally {
            $env:PORTLY_STATIC_SERVER = $previousStatic
        }
    }
} finally {
    Pop-Location
}

$task = Get-PtTask
$taskWasEnabled = $false
$server = $null
$pages = $null
$savedEnv = @{}
try {
    # --- 2. Pause the normal Portly ----------------------------------------------------------
    Write-PtStep 'Pausing your normal Portly'
    if ($null -ne $task -and $task.State -ne 'Disabled') {
        try {
            Disable-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath | Out-Null
            $taskWasEnabled = $true
            Write-PtOk "Task '$PortlyTaskName' disabled for the test."
        } catch {
            Write-PtInfo "Could not disable the '$PortlyTaskName' task ($($_.Exception.Message)). If the extension starts it during the test, it finds the port taken and stops."
        }
    }
    $stopped = @()
    foreach ($root in @(Get-PtNormalRoots -Task $task -MainRoot $mainRoot)) {
        $stopped += @(Stop-PtSupervisorProcesses -RepoRoot $root)
    }
    if ($stopped.Count -gt 0) { Write-PtOk "Stopped PID $($stopped -join ', ')." }
    # Other Portly servers on the port, such as a leftover `npm run dev` or another checkout's
    # server (Portly's index.ts with no supervisor above it); each one gets a warning line.
    $null = Stop-PtStaleServers -Port $port
    $deadline = [System.DateTime]::UtcNow.AddSeconds(15)
    do {
        $listeners = Get-PtPortListeners -Port $port
        if ($null -eq $listeners -or $listeners.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([System.DateTime]::UtcNow -lt $deadline)
    if ($null -ne $listeners -and $listeners.Count -gt 0) {
        throw "Port $port is still in use by $(Format-PtPortOwners $listeners). Stop that program and try again."
    }

    # --- 3. Copy the data --------------------------------------------------------------------
    Write-PtStep 'Copying your data folder'
    # Not Portly's copies of node.exe either (%LOCALAPPDATA%\Portly\node, about 90 MB).
    & robocopy $realData $testData /E /XD (Join-Path $realData 'backups') (Join-Path $realData 'logs') (Get-PtRuntimeDir) /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying the data folder failed (robocopy exit code $LASTEXITCODE)." }
    Write-PtOk 'Copied.'

    # --- 4. Start the test server and the stand-in Pages site ----------------------------------
    Write-PtStep 'Starting the test server and the stand-in Pages site'
    $testEnv = @{
        PORTLY_PORT      = "$port"
        PORTLY_DATA_DIR  = $testData
        PORTLY_PAGES_URL = $pagesUrl
        PORTLY_DEV       = $null
        PORTLY_ORIGIN    = $null
        PORTLY_BIND      = $null
        PORTLY_VITE_PORT = "$PagesPort"
    }
    foreach ($name in $testEnv.Keys) {
        $savedEnv[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
        [System.Environment]::SetEnvironmentVariable($name, $testEnv[$name], 'Process')
    }
    $server = Start-Process -FilePath $node -ArgumentList 'server\src\index.ts' -WorkingDirectory $checkout -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $testData 'try-server.out.log') -RedirectStandardError (Join-Path $testData 'try-server.err.log')
    $pages = Start-Process -FilePath $node -ArgumentList "`"$vite`"", 'preview', '--mode', 'static' -WorkingDirectory (Join-Path $checkout 'web') -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $testData 'try-pages.out.log') -RedirectStandardError (Join-Path $testData 'try-pages.err.log')

    $health = Wait-PtHealth -Port $port -TimeoutSeconds 30 -ContinueWhile { -not $server.HasExited }
    if (-not $health.Ok) {
        Write-PtLogTail -LogFile (Join-Path $testData 'try-server.err.log')
        throw "The test server did not start: $(Format-PtHealth $health)"
    }
    Write-PtOk "Test server $(Format-PtHealth $health)"
    $deadline = [System.DateTime]::UtcNow.AddSeconds(20)
    do {
        $listeners = Get-PtPortListeners -Port $PagesPort
        if ($null -ne $listeners -and $listeners.Count -gt 0) { break }
        Start-Sleep -Milliseconds 500
    } while (-not $pages.HasExited -and [System.DateTime]::UtcNow -lt $deadline)
    if ($pages.HasExited -or $null -eq $listeners -or $listeners.Count -eq 0) {
        Write-PtLogTail -LogFile (Join-Path $testData 'try-pages.err.log')
        throw "The stand-in Pages site did not start on port $PagesPort."
    }
    Write-PtOk "Stand-in Pages site at $pagesUrl"

    Write-Host ''
    Write-Host 'Ready. Try it in your browser:' -ForegroundColor Green
    Write-Host "  1. Open $pagesUrl and choose 'Pair this browser' in the Portly status at the bottom"
    Write-Host '     (approve on the page that opens; it brings you back).'
    Write-Host '  2. Settings -> Accounts: add or reconnect an account right there.'
    Write-Host "  3. Open http://localhost:$port - it should forward to $pagesUrl."
    Write-Host '  Changes go to the test copy only.'
    Write-Host ''
    [void](Read-Host 'Press Enter to stop the test and restart your normal Portly')
} finally {
    # --- 5. Clean up and restore ---------------------------------------------------------------
    Write-PtStep 'Stopping the test and restoring your normal Portly'
    foreach ($process in @($server, $pages)) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $process.WaitForExit(5000) | Out-Null
        }
    }
    foreach ($name in $savedEnv.Keys) {
        [System.Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
    }
    if (Test-Path -LiteralPath $testData) {
        if ($KeepData) {
            Write-PtInfo "Kept the test copy: $testData (delete it when you are done; it holds your encrypted credentials)."
        } else {
            Remove-Item -LiteralPath $testData -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $testData) { Write-PtInfo "Could not delete $testData completely; delete it by hand." }
            else { Write-PtOk 'Deleted the test copy.' }
        }
    }
    if ($taskWasEnabled) {
        Enable-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath | Out-Null
        Write-PtOk "Task '$PortlyTaskName' enabled again."
    }
    if ($null -ne $task) {
        Start-PtTask
        $back = Wait-PtHealth -Port $port -TimeoutSeconds 60
        if ($back.Ok) { Write-PtOk "Your Portly is $(Format-PtHealth $back)" }
        else { Write-PtFailure "Your Portly did not come back: $(Format-PtHealth $back). Try: portly start" }
    } else {
        Write-PtInfo "No '$PortlyTaskName' task is installed: start your Portly the way you usually do."
    }
}
