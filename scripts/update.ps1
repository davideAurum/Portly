<#
.SYNOPSIS
    Updates every copy of Homebase from this checkout in one go: the local server's page, the
    server itself and the GitHub Pages site.

.DESCRIPTION
    1. Refuses to run from a worktree under .claude\worktrees (those are deleted when their
       session ends) and shows the branch and commit being deployed, warning about uncommitted
       changes (they would be deployed too).
    2. Installs dependencies (npm ci) when package-lock.json is newer than node_modules. The
       server is stopped first, since it runs from node_modules.
    3. Builds web\dist (npm run build), the page served at http://localhost:<port>.
    4. Restarts the Homebase Server scheduled task when it was running, so server code changes
       take effect, and waits for /api/health. Skipped when the task runs another folder.
    5. Publishes the browser-only build to the GitHub Pages repository with
       scripts\publish-static.ps1 (which builds web\dist-static itself).

.PARAMETER PublicRepoPath
    Local clone of the public GitHub Pages repository, passed to publish-static.ps1. Defaults to
    the HOMEBASE_PAGES_REPO environment variable. Without either, the publish step is skipped.

.PARAMETER SkipPublish
    Do not publish the GitHub Pages site.

.PARAMETER SkipServer
    Do not restart the server (the new page is still served: web\dist is read from disk).

.PARAMETER DryRun
    Print what would run and change nothing (the publish step runs publish-static.ps1 -DryRun).

.PARAMETER TimeoutSeconds
    How long to wait for the restarted server to answer (default 60).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\update.ps1 -PublicRepoPath C:\Code\me.github.io
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PublicRepoPath,
    [switch]$SkipPublish,
    [switch]$SkipServer,
    [switch]$DryRun,
    [ValidateRange(5, 600)][int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

function Invoke-UpdateNpm {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string[]]$Arguments)
    $npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $npm) { throw 'npm.cmd was not found on PATH (it is installed with Node.js).' }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $RepoRoot
    try {
        & $npm.Source @Arguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "npm $($Arguments -join ' ') failed (exit code $exitCode)." }
}

function Invoke-UpdateGit {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string[]]$Arguments)
    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $git) { return $null }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $git.Source -C $RepoRoot @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return , @($output)
    } finally {
        $ErrorActionPreference = $previous
    }
}

# True when npm ci must run: no install yet, or package-lock.json changed since the last one.
function Test-UpdateDependenciesStale {
    param([Parameter(Mandatory)][string]$RepoRoot)
    if (-not (Test-HbDependenciesInstalled -RepoRoot $RepoRoot)) { return $true }
    $installed = Join-Path $RepoRoot 'node_modules\.package-lock.json'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { return $true }
    $lock = Get-Item -LiteralPath (Join-Path $RepoRoot 'package-lock.json')
    return $lock.LastWriteTimeUtc -gt (Get-Item -LiteralPath $installed).LastWriteTimeUtc
}

# Whether the scheduled task starts this checkout's supervisor (not some other folder's).
function Test-UpdateTaskRunsHere {
    param([Parameter(Mandatory)]$Task, [Parameter(Mandatory)][string]$RepoRoot)
    $supervisor = Join-Path $RepoRoot 'server\src\supervisor.ts'
    foreach ($action in @($Task.Actions)) {
        if ("$($action.Arguments)".IndexOf($supervisor, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Stop-UpdateServer {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $task = Get-HbTask
    if ($null -ne $task -and "$($task.State)" -eq 'Running') {
        Stop-ScheduledTask -TaskName $HomebaseTaskName -TaskPath $HomebaseTaskPath
    }
    $stopped = @(Stop-HbSupervisorProcesses -RepoRoot $RepoRoot)
    if ($stopped.Count -gt 0) {
        Write-HbInfo "Stopped PID $($stopped -join ', ')"
        Start-Sleep -Milliseconds 500
    }
}

function Start-UpdateServer {
    param([Parameter(Mandatory)][int]$Port)
    Start-ScheduledTask -TaskName $HomebaseTaskName -TaskPath $HomebaseTaskPath
    Write-HbInfo "Waiting up to $TimeoutSeconds s for http://localhost:$Port/api/health ..."
    $health = Wait-HbHealth -Port $Port -TimeoutSeconds $TimeoutSeconds
    if (-not $health.Ok) { throw "The server did not come back: $(Format-HbHealth $health). Run scripts\status.ps1 -LogLines 30." }
    Write-HbOk "Server $(Format-HbHealth $health)"
}

function Invoke-Update {
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    if (Test-HbWorktreePath -Path $repoRoot) {
        throw ("This is a temporary worktree ($repoRoot). Merge into main and run the script from the main checkout " +
            '(the folder that holds .claude\worktrees) instead.')
    }
    $prefix = if ($DryRun) { '[dry run] ' } else { '' }

    $branch = Invoke-UpdateGit -RepoRoot $repoRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
    $commit = Invoke-UpdateGit -RepoRoot $repoRoot -Arguments @('log', '-1', '--format=%h %s')
    if ($null -ne $commit) { Write-HbStep "${prefix}Updating Homebase from $($branch -join '') at $($commit -join '')" }
    if ($null -ne $branch -and ($branch -join '') -ne 'main') {
        Write-Warning "The checked-out branch is '$($branch -join '')', not main."
    }
    $dirty = Invoke-UpdateGit -RepoRoot $repoRoot -Arguments @('status', '--porcelain')
    if ($null -ne $dirty -and @($dirty | Where-Object { $_ }).Count -gt 0) {
        Write-Warning 'There are uncommitted changes in this checkout; they will be built and published too.'
    }

    $port = (Get-HbPortSetting -Scope Task).Port
    $task = $null
    if (Test-HbScheduledTasksAvailable) { $task = Get-HbTask }
    $restart = $false
    $taskElsewhere = $false
    if (-not $SkipServer -and $null -ne $task) {
        if (-not (Test-UpdateTaskRunsHere -Task $task -RepoRoot $repoRoot)) {
            $taskElsewhere = $true
            Write-Warning "The '$HomebaseTaskName' task runs another folder, so the server is not restarted. Re-run install-autostart.ps1 from $repoRoot to fix that."
        } else {
            $restart = "$($task.State)" -eq 'Running' -or @(Get-HbSupervisorProcesses -RepoRoot $repoRoot).Count -gt 0
        }
    }
    $stopped = $false

    if (Test-UpdateDependenciesStale -RepoRoot $repoRoot) {
        Write-HbStep "${prefix}Installing dependencies (package-lock.json changed): npm ci"
        if (-not $DryRun) {
            if ($restart) {
                Write-HbInfo 'Stopping the server first (it runs from node_modules)'
                Stop-UpdateServer -RepoRoot $repoRoot
                $stopped = $true
            }
            Invoke-UpdateNpm -RepoRoot $repoRoot -Arguments @('ci', '--no-audit', '--no-fund')
        }
    }

    Write-HbStep "${prefix}Building the local page (web\dist): npm run build"
    if (-not $DryRun) {
        Invoke-UpdateNpm -RepoRoot $repoRoot -Arguments @('run', 'build')
        Write-HbOk 'Built web\dist'
    }

    if ($restart) {
        Write-HbStep "${prefix}Restarting the server (task '$HomebaseTaskName', port $port)"
        if (-not $DryRun) {
            if (-not $stopped) { Stop-UpdateServer -RepoRoot $repoRoot }
            Start-UpdateServer -Port $port
        }
    } elseif (-not $SkipServer -and -not $taskElsewhere) {
        Write-HbInfo 'The server is not running; it uses the new code the next time it starts.'
    }

    if ($SkipPublish) { return 0 }
    if ([string]::IsNullOrWhiteSpace($PublicRepoPath)) {
        $PublicRepoPath = Get-HbEnvValue -Name 'HOMEBASE_PAGES_REPO' -Scope Task
    }
    if ([string]::IsNullOrWhiteSpace($PublicRepoPath)) {
        Write-Warning 'GitHub Pages not published: pass -PublicRepoPath or set the HOMEBASE_PAGES_REPO user environment variable.'
        return 0
    }
    Write-HbStep "${prefix}Publishing the GitHub Pages site from $PublicRepoPath"
    $publishArgs = @{ PublicRepoPath = $PublicRepoPath }
    if ($DryRun) { $publishArgs.DryRun = $true }
    & (Join-Path $PSScriptRoot 'publish-static.ps1') @publishArgs
    if ($LASTEXITCODE -ne 0) { throw "publish-static.ps1 failed (exit code $LASTEXITCODE)." }
    if (-not $DryRun) { Write-HbOk 'Everything is updated. Reload open Homebase tabs with Ctrl+F5.' }
    return 0
}

# npm and Vite write UTF-8; read it as UTF-8 so their output is not garbled (the console's
# default code page turns the box-drawing characters into mojibake).
$savedOutputEncoding = [Console]::OutputEncoding
$exitCode = 1
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $exitCode = Invoke-Update | Select-Object -Last 1
} catch {
    Write-HbFailure $_.Exception.Message
    $exitCode = 1
} finally {
    try { [Console]::OutputEncoding = $savedOutputEncoding } catch { }
}
exit ([int]$exitCode)
