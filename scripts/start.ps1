<#
.SYNOPSIS
    Runs Homebase in the foreground of this PowerShell window (Ctrl+C stops it).

.DESCRIPTION
    Checks Node.js (24 or newer) and the installed dependencies, builds web\dist if it is
    missing, refuses to start a second copy when Homebase already answers on the port, then
    runs `node server\src\index.ts` until you press Ctrl+C. Use install-autostart.ps1 instead
    to run it in the background at every sign-in.

.PARAMETER Port
    Port to listen on (1024-65535) for this run only. Defaults to HOMEBASE_PORT, else 5757.

.PARAMETER DataDir
    Data folder for this run only. Defaults to HOMEBASE_DATA_DIR, else %LOCALAPPDATA%\Homebase.

.PARAMETER Rebuild
    Run `npm run build` even if web\dist already exists (after pulling new code).

.PARAMETER NoBuild
    Never build; fail if web\dist is missing.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Port 5800 -Rebuild
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port,
    [ValidateNotNullOrEmpty()][string]$DataDir,
    [switch]$Rebuild,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# Checks and builds; returns the run plan, or an exit code when Homebase must not start.
function Get-StartPlan {
    param([int]$RequestedPort, [string]$RequestedDataDir)
    if ($Rebuild -and $NoBuild) { throw '-Rebuild and -NoBuild cannot be used together.' }

    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    $index = Join-Path $repoRoot 'server\src\index.ts'
    if (-not (Test-Path -LiteralPath $index -PathType Leaf)) {
        throw "This script must stay in the scripts folder of a Homebase checkout (no server\src\index.ts under $repoRoot)."
    }
    if (-not (Test-HbDependenciesInstalled -RepoRoot $repoRoot)) {
        throw "Dependencies are not installed. In $repoRoot run: npm ci"
    }
    # A release install's link to the shared package (install.ps1 makes it), in case it went missing.
    if ($null -ne (Get-HbReleaseInfo -RepoRoot $repoRoot)) { $null = Initialize-HbReleaseLinks -RepoRoot $repoRoot }
    $node = Resolve-HbNode -RepoRoot $repoRoot

    if ($RequestedPort -gt 0) {
        $port = $RequestedPort
    } else {
        $port = (Get-HbPortSetting -Scope Process).Port
    }
    if ($RequestedDataDir) {
        $dataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RequestedDataDir)
    } else {
        $dataDir = Get-HbDataDir -Scope Process -RepoRoot $repoRoot
    }

    $already = Test-HbHealth -Port $port -TimeoutSeconds 2
    if ($already.Ok) {
        Write-HbFailure "Homebase is already $(Format-HbHealth $already)."
        Write-HbInfo 'It may be the autostart task (see scripts\status.ps1). Open that URL, or stop the other copy first.'
        return 3
    }
    if ($null -ne $already.Listeners -and $already.Listeners.Count -gt 0) {
        Write-HbFailure "Port $port is already in use by $(Format-HbPortOwners $already.Listeners), which does not answer as Homebase."
        Write-HbInfo 'Stop that program, or use another port: -Port <n> here and the same port in the extension options.'
        return 3
    }

    if (Test-HbTruthy (Get-HbEnvValue -Name 'HOMEBASE_DEV' -Scope Process)) {
        Write-Warning 'HOMEBASE_DEV is set: the server runs in development mode and expects the Vite dev server (npm run dev).'
    }

    $built = Test-HbWebBuilt -RepoRoot $repoRoot
    if ($Rebuild -or (-not $built -and -not $NoBuild)) {
        $reason = if ($Rebuild) { '-Rebuild' } else { 'web\dist is missing' }
        Write-HbStep "Building the web app ($reason): npm run build"
        Invoke-HbWebBuild -RepoRoot $repoRoot
    } elseif (-not $built) {
        throw 'web\dist is missing and -NoBuild was given. Run: npm run build'
    }

    return [pscustomobject]@{
        RepoRoot = $repoRoot
        Index    = $index
        Node     = $node
        Port     = $port
        DataDir  = $dataDir
    }
}

try {
    $plan = Get-StartPlan -RequestedPort $Port -RequestedDataDir $DataDir | Select-Object -Last 1
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
if ($plan -is [int]) { exit $plan }

# Run node as a plain statement (output not captured) so it owns the console: Ctrl+C reaches it
# directly and it shuts down cleanly instead of being killed along with a pipeline.
$savedEnv = @{
    HOMEBASE_PORT     = [System.Environment]::GetEnvironmentVariable('HOMEBASE_PORT', 'Process')
    HOMEBASE_DATA_DIR = [System.Environment]::GetEnvironmentVariable('HOMEBASE_DATA_DIR', 'Process')
}
$exitCode = 1
Push-Location -LiteralPath $plan.RepoRoot
try {
    [System.Environment]::SetEnvironmentVariable('HOMEBASE_PORT', "$($plan.Port)", 'Process')
    [System.Environment]::SetEnvironmentVariable('HOMEBASE_DATA_DIR', $plan.DataDir, 'Process')
    Write-HbStep "Starting Homebase on http://localhost:$($plan.Port) (Node.js v$($plan.Node.Version)) - press Ctrl+C to stop"
    Write-HbInfo "Data folder: $($plan.DataDir)"
    Write-HbInfo "Log file:    $(Get-HbLogFile -DataDir $plan.DataDir)"
    $ErrorActionPreference = 'Continue'
    & $plan.Node.Path $plan.Index
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($name in $savedEnv.Keys) {
        [System.Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
    }
}

switch ($exitCode) {
    0 { Write-HbOk 'Homebase stopped' }
    3 { Write-HbFailure "Port $($plan.Port) is already in use by another program or another Homebase instance." }
    default { Write-HbFailure "Homebase exited with code $exitCode. See the output above and docs\setup\troubleshooting.md." }
}
exit $exitCode
