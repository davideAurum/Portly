<#
.SYNOPSIS
    Try this checkout's Portly live, on a copy of your data, before committing it.

.DESCRIPTION
    Run it from the checkout (main folder or a .claude\worktrees\<name> worktree) whose code you
    want to try. It:

    1. builds this checkout's page and its Pages (static) build;
    2. pauses your normal Portly: stops its server and disables the 'Portly Server' task, so
       the extension cannot start it again meanwhile (port 5757 must be free: Google only accepts
       sign-ins that come back to localhost:5757);
    3. copies your data folder (without backups and logs) to a temporary folder;
    4. starts this checkout's server on port 5757 with the copy, and serves this checkout's Pages
       build at http://localhost:<PagesPort> as a stand-in for the published site (nothing is
       published);
    5. waits until you press Enter, then stops both, deletes the copy (unless -KeepData), turns the
       task back on and starts your normal Portly again - also after Ctrl+C or an error.

    Your real data folder is only read. Anything you change during the test (accounts added,
    pairings, settings) happens in the copy and is gone afterwards.

.PARAMETER PagesPort
    Port of the stand-in Pages site (default 5175).

.PARAMETER KeepData
    Keep the temporary copy of the data folder (it holds your encrypted credentials) instead of
    deleting it at the end.

.PARAMETER SkipBuild
    Use the builds already in web\dist and web\dist-static.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\try-branch.ps1
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$PagesPort = 5175,
    [switch]$KeepData,
    [switch]$SkipBuild
)

. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$ErrorActionPreference = 'Stop'

$checkout = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
# The normal Portly runs from the main folder: for a worktree that is three levels up.
$mainRoot = $checkout
if (Test-HbWorktreePath $checkout) {
    $mainRoot = [System.IO.Path]::GetFullPath((Join-Path $checkout '..\..\..'))
}
$port = (Get-HbPortSetting -Scope Task).Port
if ($port -ne $PortlyDefaultPort) {
    Write-HbInfo "Your Portly uses port $port; the test server takes it over the same way."
}
$realData = Get-HbDataDir -Scope Task -RepoRoot $mainRoot
$testData = Join-Path ([System.IO.Path]::GetTempPath()) ("portly-try-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$pagesUrl = "http://localhost:$PagesPort/"
$node = (Resolve-HbNode).Path
$vite = Join-Path $checkout 'node_modules\vite\bin\vite.js'

Write-HbStep "Trying $checkout"
Write-HbField 'Your data' "$realData (only read)"
Write-HbField 'Test copy' $testData
Write-HbField 'Test server' "http://localhost:$port"
Write-HbField 'Stand-in Pages site' $pagesUrl

if (-not (Test-Path -LiteralPath $realData -PathType Container)) {
    Write-HbFailure "No data folder at $realData."
    exit 1
}
$busy = Get-HbPortListeners -Port $PagesPort
if ($null -ne $busy -and $busy.Count -gt 0) {
    Write-HbFailure "Port $PagesPort is in use by $(Format-HbPortOwners $busy). Pick another with -PagesPort."
    exit 1
}

# --- 1. Build ------------------------------------------------------------------------------
Push-Location $checkout
try {
    if (-not (Test-Path -LiteralPath $vite -PathType Leaf)) {
        Write-HbStep 'Installing dependencies (npm ci)'
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    if (-not $SkipBuild) {
        Write-HbStep 'Building the page and the Pages build'
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

$task = Get-HbTask
$taskWasEnabled = $false
$server = $null
$pages = $null
$savedEnv = @{}
try {
    # --- 2. Pause the normal Portly ----------------------------------------------------------
    Write-HbStep 'Pausing your normal Portly'
    if ($null -ne $task -and $task.State -ne 'Disabled') {
        try {
            Disable-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath | Out-Null
            $taskWasEnabled = $true
            Write-HbOk "Task '$PortlyTaskName' disabled for the test."
        } catch {
            Write-HbInfo "Could not disable the '$PortlyTaskName' task ($($_.Exception.Message)). If the extension starts it during the test, it finds the port taken and stops."
        }
    }
    $stopped = @(Stop-HbSupervisorProcesses -RepoRoot $mainRoot)
    if ($stopped.Count -gt 0) { Write-HbOk "Stopped PID $($stopped -join ', ')." }
    $deadline = [System.DateTime]::UtcNow.AddSeconds(15)
    do {
        $listeners = Get-HbPortListeners -Port $port
        if ($null -eq $listeners -or $listeners.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([System.DateTime]::UtcNow -lt $deadline)
    if ($null -ne $listeners -and $listeners.Count -gt 0) {
        throw "Port $port is still in use by $(Format-HbPortOwners $listeners). Stop that program and try again."
    }

    # --- 3. Copy the data --------------------------------------------------------------------
    Write-HbStep 'Copying your data folder'
    & robocopy $realData $testData /E /XD (Join-Path $realData 'backups') (Join-Path $realData 'logs') /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying the data folder failed (robocopy exit code $LASTEXITCODE)." }
    Write-HbOk 'Copied.'

    # --- 4. Start the test server and the stand-in Pages site ----------------------------------
    Write-HbStep 'Starting the test server and the stand-in Pages site'
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

    $health = Wait-HbHealth -Port $port -TimeoutSeconds 30 -ContinueWhile { -not $server.HasExited }
    if (-not $health.Ok) {
        Write-HbLogTail -LogFile (Join-Path $testData 'try-server.err.log')
        throw "The test server did not start: $(Format-HbHealth $health)"
    }
    Write-HbOk "Test server $(Format-HbHealth $health)"
    $deadline = [System.DateTime]::UtcNow.AddSeconds(20)
    do {
        $listeners = Get-HbPortListeners -Port $PagesPort
        if ($null -ne $listeners -and $listeners.Count -gt 0) { break }
        Start-Sleep -Milliseconds 500
    } while (-not $pages.HasExited -and [System.DateTime]::UtcNow -lt $deadline)
    if ($pages.HasExited -or $null -eq $listeners -or $listeners.Count -eq 0) {
        Write-HbLogTail -LogFile (Join-Path $testData 'try-pages.err.log')
        throw "The stand-in Pages site did not start on port $PagesPort."
    }
    Write-HbOk "Stand-in Pages site at $pagesUrl"

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
    Write-HbStep 'Stopping the test and restoring your normal Portly'
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
            Write-HbInfo "Kept the test copy: $testData (delete it when you are done; it holds your encrypted credentials)."
        } else {
            Remove-Item -LiteralPath $testData -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $testData) { Write-HbInfo "Could not delete $testData completely; delete it by hand." }
            else { Write-HbOk 'Deleted the test copy.' }
        }
    }
    if ($taskWasEnabled) {
        Enable-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath | Out-Null
        Write-HbOk "Task '$PortlyTaskName' enabled again."
    }
    if ($null -ne $task) {
        Start-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
        $back = Wait-HbHealth -Port $port -TimeoutSeconds 60
        if ($back.Ok) { Write-HbOk "Your Portly is $(Format-HbHealth $back)" }
        else { Write-HbFailure "Your Portly did not come back: $(Format-HbHealth $back). Try: portly --start" }
    } else {
        Write-HbInfo "No '$PortlyTaskName' task is installed: start your Portly the way you usually do."
    }
}
