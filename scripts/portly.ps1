<#
.SYNOPSIS
    The `portly` command (installed on PATH by scripts\install-cli.ps1).

.DESCRIPTION
    portly --update [--version <x>] [--dry-run] [--force]
        In a release install: download and install the newest release (or <x>) with
        scripts\install.ps1, run from a temporary copy. In a Git checkout: the same as --rebuild.
    portly --rebuild [--dry-run] [--skip-publish] [--skip-server]
        Git checkout: update everything from the code checked out: dependencies, the local page,
        the server and the GitHub Pages site (scripts\update.ps1). A release install says to use
        --update instead.
    portly --version
        The installed version, and whether it is a release install or a Git checkout.
    portly --status [--logs]
        Is Portly running and healthy? (scripts\status.ps1 -View Status; --logs adds the log
        tails)
    portly --settings
        How it is set up: port, folders, logs, autostart, extension, Pages (status.ps1 -View Settings).
    portly --start
        Start the Portly Server scheduled task (first refreshing Portly's named copies of
        node.exe, portly-supervisor.exe and portly-server.exe, when they are out of date).
    portly --copy-from-homebase [--replace | --cancel]
        Ask Portly to copy the data of Homebase (its name before the rename) at its next start
        and restart the task to do it; --replace copies over Portly's own database (moved
        aside, not deleted), --cancel withdraws the request (ARCHITECTURE section 19).
    portly --help
        This text.

    Each command runs its script in this PowerShell with the matching parameters and passes its
    exit code through.
#>
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

$PortlyCliUsage = @'
Usage: portly <command> [options]

  --update      Install the newest release (release installs; in a Git
                checkout the same as --rebuild).
                  --version <x>   install release <x> instead
                  --dry-run       show what would happen, change nothing
                  --force         reinstall even the installed version
  --rebuild     Git checkout: rebuild everything from the checked-out code:
                dependencies, the local page, the server and the GitHub Pages site.
                  --dry-run       show what would happen, change nothing
                  --skip-publish  leave the GitHub Pages site alone
                  --skip-server   do not restart the server
  --version     Show the installed version.
  --status      Is Portly running and healthy?  (--logs adds the log tails)
  --settings    How Portly is set up: port, folders, logs, autostart,
                browser extension and GitHub Pages.
  --start      Start the Portly server.
  --copy-from-homebase
                Copy the data of Homebase (Portly's old name) into Portly,
                restarting Portly to do it.
                  --replace       over Portly's own data (kept beside it)
                  --cancel        withdraw a copy that waits or keeps failing
  --help        Show this text.
'@

# Translates the command's --options into the script's parameters (a hashtable to splat);
# $null for an unknown option.
function ConvertTo-HbCliParameters {
    param([AllowEmptyCollection()][string[]]$Options, [Parameter(Mandatory)][hashtable]$Map)
    $result = @{}
    foreach ($option in $Options) {
        $key = $option.ToLowerInvariant()
        if (-not $Map.ContainsKey($key)) {
            Write-HbFailure "Unknown option '$option'."
            return $null
        }
        $result[$Map[$key].Name] = $Map[$key].Value
    }
    return $result
}

# Runs scripts\<Script> here (its own `exit` ends only that script) and returns its exit code.
function Invoke-HbCliScript {
    param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][hashtable]$Parameters)
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot $Script) @Parameters | Out-Host
    return $global:LASTEXITCODE
}

# portly --update in a release install: runs a temporary copy of scripts\install.ps1 against
# the install folder (the parent of this copy's app folder), so nothing in app\ is in use while
# it is replaced.
function Invoke-HbReleaseUpdate {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)]$Info, [AllowEmptyCollection()][string[]]$Options)
    $arguments = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $Options.Count; $i++) {
        switch ($Options[$i].ToLowerInvariant()) {
            '--dry-run' { $arguments.Add('-DryRun') }
            '--force' { $arguments.Add('-Force') }
            '--version' {
                if ($i + 1 -ge $Options.Count) { Write-HbFailure '--version needs a version, for example --version 0.2.0-alpha.1.'; return 2 }
                $i++
                $arguments.Add('-Version')
                $arguments.Add($Options[$i])
            }
            default { Write-HbFailure "Unknown option '$($Options[$i])'."; return 2 }
        }
    }
    if ((Split-Path -Leaf $RepoRoot) -ne 'app') {
        Write-HbFailure "This copy ($RepoRoot) was not installed by install.ps1 (its folder is not <install folder>\app), so it cannot update itself."
        return 1
    }
    $releaseRepo = "$(Get-HbProperty $Info 'releaseRepo')"
    if ($releaseRepo) { $arguments.Add('-ReleaseRepo'); $arguments.Add($releaseRepo) }
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('portly-update-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $temp -Force
    try {
        $installer = Join-Path $temp 'install.ps1'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $installer
        $powershell = (Get-Process -Id $PID).Path
        Push-Location -LiteralPath $temp
        try {
            $global:LASTEXITCODE = 0
            & $powershell -NoProfile -ExecutionPolicy Bypass -File $installer -InstallDir (Split-Path -Parent $RepoRoot) @arguments | Out-Host
            return $global:LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# portly --copy-from-homebase: asks Portly to copy Homebase's data at its next start (--replace:
# over Portly's own database, which is kept beside it), or withdraws that request (--cancel); then
# restarts the Portly Server task when it is installed, so the copy is made now.
function Invoke-HbCopyFromHomebase {
    param([Parameter(Mandatory)][string]$RepoRoot, [switch]$Replace, [switch]$Cancel)
    $dataDir = Get-HbDataDir -Scope Task -RepoRoot $RepoRoot
    if ($Cancel) {
        if (Remove-HbHomebaseCopyRequest -DataDir $dataDir) {
            Write-HbOk 'Withdrew the request: Portly starts with its own data, without copying Homebase''s.'
        } else {
            Write-HbInfo 'No copy from Homebase was waiting.'
        }
        return 0
    }
    $plan = Get-HbHomebaseCopyPlan -DataDir $dataDir -CustomDataDir:($null -ne (Get-HbEnvValue -Name 'PORTLY_DATA_DIR' -Scope Task)) -HomebaseDataDir (Get-HbHomebaseDataDir -RepoRoot $RepoRoot)
    if ($plan.State -eq 'none') {
        Write-HbFailure "No Homebase database (homebase.db) was found for the data folder $dataDir."
        return 1
    }
    if ($plan.State -eq 'done' -and -not $Replace) {
        Write-HbOk "Homebase's data was already copied ($($plan.CopiedAt)). To copy it again over Portly's current data, add --replace."
        return 0
    }
    if ($plan.State -eq 'portly-has-database' -and -not $Replace) {
        Write-HbFailure "Portly already has a database in $dataDir. To replace it with Homebase's (the current one and its vault key are kept beside it as portly.db.before-homebase-<time> and vault.key.before-homebase-<time>), add --replace."
        return 1
    }
    $requestPath = Write-HbHomebaseCopyRequest -DataDir $dataDir -Replace:$Replace
    Write-HbOk "Asked Portly to copy $($plan.Source) at its next start ($requestPath)"

    if ($null -eq (Get-HbTask)) {
        Write-HbInfo 'Start Portly to make the copy (or withdraw the request with: portly --copy-from-homebase --cancel).'
        return 0
    }
    Write-HbStep 'Restarting Portly to make the copy'
    try { Stop-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -ErrorAction Stop } catch { }
    $null = Stop-HbSupervisorProcesses -RepoRoot $RepoRoot
    Start-Sleep -Milliseconds 500
    Start-HbTask
    $port = (Get-HbPortSetting -Scope Task).Port
    $health = Wait-HbHealth -Port $port -TimeoutSeconds 60
    $after = Get-HbHomebaseCopyPlan -DataDir $dataDir -CustomDataDir:($null -ne (Get-HbEnvValue -Name 'PORTLY_DATA_DIR' -Scope Task)) -HomebaseDataDir (Get-HbHomebaseDataDir -RepoRoot $RepoRoot)
    if ($health.Ok -and $after.State -eq 'done') {
        Write-HbOk "Copied. Portly is $(Format-HbHealth $health)"
        return 0
    }
    Write-HbFailure "The copy was not made (Portly: $(Format-HbHealth $health); copy: $($after.MarkerStatus)). See: portly --status --logs"
    return 1
}

function Write-HbVersion {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $info = Get-HbReleaseInfo -RepoRoot $RepoRoot
    if ($null -ne $info) {
        Write-Host "Portly $($info.version) (release install, Node.js $(Get-HbProperty $info 'node'), $RepoRoot)"
        return 0
    }
    $package = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'package.json')) | ConvertFrom-Json
    $where = "Git checkout, $RepoRoot"
    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $git) {
        $branch = "$(& $git.Source -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)".Trim()
        $commit = "$(& $git.Source -C $RepoRoot rev-parse --short HEAD 2>$null)".Trim()
        if ($commit) { $where = "Git checkout, $branch $commit, $RepoRoot" }
    }
    Write-Host "Portly $($package.version) ($where)"
    return 0
}

function Invoke-HbCli {
    param([AllowEmptyCollection()][string[]]$CliArgs)
    if ($CliArgs.Count -eq 0) {
        Write-Host $PortlyCliUsage
        return 2
    }
    $command = $CliArgs[0].ToLowerInvariant().TrimStart('-')
    $rest = @()
    if ($CliArgs.Count -gt 1) { $rest = $CliArgs[1..($CliArgs.Count - 1)] }

    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    $release = Get-HbReleaseInfo -RepoRoot $repoRoot
    switch ($command) {
        'update' {
            if ($null -ne $release) { return Invoke-HbReleaseUpdate -RepoRoot $repoRoot -Info $release -Options $rest }
            return Invoke-HbCli -CliArgs (@('--rebuild') + $rest)
        }
        'rebuild' {
            if ($null -ne $release) {
                Write-HbFailure "This is a release install (Portly $($release.version)), not a Git checkout: use portly --update."
                return 1
            }
            $mapped = ConvertTo-HbCliParameters -Options $rest -Map @{
                '--dry-run'      = @{ Name = 'DryRun'; Value = $true }
                '--skip-publish' = @{ Name = 'SkipPublish'; Value = $true }
                '--skip-server'  = @{ Name = 'SkipServer'; Value = $true }
            }
            if ($null -eq $mapped) { return 2 }
            return Invoke-HbCliScript -Script 'update.ps1' -Parameters $mapped
        }
        'status' {
            $mapped = ConvertTo-HbCliParameters -Options $rest -Map @{ '--logs' = @{ Name = 'LogLines'; Value = 30 } }
            if ($null -eq $mapped) { return 2 }
            $mapped.View = 'Status'
            return Invoke-HbCliScript -Script 'status.ps1' -Parameters $mapped
        }
        { $_ -in 'settings', 'config' } {
            $mapped = ConvertTo-HbCliParameters -Options $rest -Map @{}
            if ($null -eq $mapped) { return 2 }
            $mapped.View = 'Settings'
            return Invoke-HbCliScript -Script 'status.ps1' -Parameters $mapped
        }
        'start' {
            if ($rest.Count -gt 0) { Write-HbFailure '--start takes no options.'; return 2 }
            if ($null -eq (Get-HbTask)) {
                Write-HbFailure "The '$PortlyTaskName' task is not installed. Run scripts\install-autostart.ps1 first."
                return 1
            }
            # Refreshes Portly's copies of node.exe first when they are missing or out of date.
            Start-HbTask
            $port = (Get-HbPortSetting -Scope Task).Port
            $health = Wait-HbHealth -Port $port -TimeoutSeconds 60
            if ($health.Ok) { Write-HbOk "Portly is $(Format-HbHealth $health)"; return 0 }
            Write-HbFailure "Portly did not start: $(Format-HbHealth $health). Try: portly --status --logs"
            return 1
        }
        'copy-from-homebase' {
            $mapped = ConvertTo-HbCliParameters -Options $rest -Map @{
                '--replace' = @{ Name = 'Replace'; Value = $true }
                '--cancel'  = @{ Name = 'Cancel'; Value = $true }
            }
            if ($null -eq $mapped) { return 2 }
            if ($mapped.ContainsKey('Replace') -and $mapped.ContainsKey('Cancel')) { Write-HbFailure 'Use --replace or --cancel, not both.'; return 2 }
            return Invoke-HbCopyFromHomebase -RepoRoot $repoRoot @mapped
        }
        'version' {
            if ($rest.Count -gt 0) { Write-HbFailure '--version takes no options.'; return 2 }
            return Write-HbVersion -RepoRoot $repoRoot
        }
        { $_ -in 'help', 'h', '?' } {
            Write-Host $PortlyCliUsage
            return 0
        }
        default {
            Write-HbFailure "Unknown command '$($CliArgs[0])'."
            Write-Host $PortlyCliUsage
            return 2
        }
    }
}

try {
    $exitCode = Invoke-HbCli -CliArgs @($args) | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
