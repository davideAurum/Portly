<#
.SYNOPSIS
    Runs Portly in the foreground of this PowerShell window (Ctrl+C stops it).

.DESCRIPTION
    Checks Node.js (26, the pinned major; any other is refused) and the installed
    dependencies, builds web\dist if it is missing, refuses to start a second copy when Portly
    already answers on the port, then runs `node server\src\index.ts` until you press Ctrl+C.
    Use install-autostart.ps1 instead to run it in the background at every sign-in.

.PARAMETER Port
    Port to listen on (1024-65535) for this run only. Defaults to PORTLY_PORT, else 5757.

.PARAMETER DataDir
    Data folder for this run only. Defaults to PORTLY_DATA_DIR, else %LOCALAPPDATA%\Portly.

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

# Checks and builds; returns the run plan, or an exit code when Portly must not start.
function Get-StartPlan {
    param([int]$RequestedPort, [string]$RequestedDataDir)
    if ($Rebuild -and $NoBuild) { throw '-Rebuild and -NoBuild cannot be used together.' }

    $repoRoot = Get-PtRepoRoot -ScriptRoot $PSScriptRoot
    $index = Join-Path $repoRoot 'server\src\index.ts'
    if (-not (Test-Path -LiteralPath $index -PathType Leaf)) {
        throw "This script must stay in the scripts folder of a Portly checkout (no server\src\index.ts under $repoRoot)."
    }
    if (-not (Test-PtDependenciesInstalled -RepoRoot $repoRoot)) {
        throw "Dependencies are not installed. In $repoRoot run: npm ci"
    }
    # A release install's link to the shared package (install.ps1 makes it), in case it went missing.
    if ($null -ne (Get-PtReleaseInfo -RepoRoot $repoRoot)) { $null = Initialize-PtReleaseLinks -RepoRoot $repoRoot }
    $node = Resolve-PtNode -RepoRoot $repoRoot

    if ($RequestedPort -gt 0) {
        $port = $RequestedPort
    } else {
        $port = (Get-PtPortSetting -Scope Process).Port
    }
    if ($RequestedDataDir) {
        $dataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RequestedDataDir)
    } else {
        $dataDir = Get-PtDataDir -Scope Process -RepoRoot $repoRoot
    }

    $already = Test-PtHealth -Port $port -TimeoutSeconds 2
    if ($already.Ok) {
        Write-PtFailure "Portly is already $(Format-PtHealth $already)."
        Write-PtInfo 'It may be the autostart task (see scripts\status.ps1). Open that URL, or stop the other copy first.'
        return 3
    }
    if ($null -ne $already.Listeners -and $already.Listeners.Count -gt 0) {
        Write-PtFailure "Port $port is already in use by $(Format-PtPortOwners $already.Listeners), which does not answer as Portly."
        Write-PtInfo 'Stop that program, or use another port: -Port <n> here and the same port in the extension options.'
        return 3
    }

    if (Test-PtTruthy (Get-PtEnvValue -Name 'PORTLY_DEV' -Scope Process)) {
        Write-Warning 'PORTLY_DEV is set: the server runs in development mode and expects the Vite dev server (npm run dev).'
    }

    $built = Test-PtWebBuilt -RepoRoot $repoRoot
    if ($Rebuild -or (-not $built -and -not $NoBuild)) {
        $reason = if ($Rebuild) { '-Rebuild' } else { 'web\dist is missing' }
        Write-PtStep "Building the web app ($reason): npm run build"
        Invoke-PtWebBuild -RepoRoot $repoRoot
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
    Write-PtFailure $_.Exception.Message
    exit 1
}
if ($plan -is [int]) { exit $plan }

# Run node as a plain statement (output not captured) so it owns the console: Ctrl+C reaches it
# directly and it shuts down cleanly instead of being killed along with a pipeline.
$savedEnv = @{
    PORTLY_PORT     = [System.Environment]::GetEnvironmentVariable('PORTLY_PORT', 'Process')
    PORTLY_DATA_DIR = [System.Environment]::GetEnvironmentVariable('PORTLY_DATA_DIR', 'Process')
}
$exitCode = 1
Push-Location -LiteralPath $plan.RepoRoot
try {
    [System.Environment]::SetEnvironmentVariable('PORTLY_PORT', "$($plan.Port)", 'Process')
    [System.Environment]::SetEnvironmentVariable('PORTLY_DATA_DIR', $plan.DataDir, 'Process')
    Write-PtStep "Starting Portly on http://localhost:$($plan.Port) (Node.js v$($plan.Node.Version)) - press Ctrl+C to stop"
    Write-PtInfo "Data folder: $($plan.DataDir)"
    Write-PtInfo "Log file:    $(Get-PtLogFile -DataDir $plan.DataDir)"
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
    0 { Write-PtOk 'Portly stopped' }
    3 { Write-PtFailure "Port $($plan.Port) is already in use by another program or another Portly instance." }
    default { Write-PtFailure "Portly exited with code $exitCode. See the output above and docs\setup\troubleshooting.md." }
}
exit $exitCode
