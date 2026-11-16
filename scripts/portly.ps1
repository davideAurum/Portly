<#
.SYNOPSIS
    The `portly` command (installed on PATH by scripts\install-cli.ps1).

.DESCRIPTION
    portly --update [--version <x>] [--dry-run] [--force] [--unattended]
        In a release install: download and install the newest release (or <x>) with
        scripts\install.ps1, run from a temporary copy. In a Git checkout: the same as --rebuild
        (with its options). --unattended is the Portly Updater task's: only a newer version, the
        progress in <data folder>\update-status.json and the output in logs\update.log.
    portly --rebuild [--dry-run] [--skip-publish] [--skip-server] [--allow-dirty]
        Git checkout: update everything from the code checked out: dependencies, the local page,
        the server and the GitHub Pages site (scripts\update.ps1). Uncommitted changes are
        refused unless --allow-dirty. A release install says to use --update instead.
    portly --dev [<folder>] [--pages-port <n>] [--keep-data] [--skip-build] [--dry-run]
        Build and run a local Git checkout (the shell's current one, a worktree included, or
        <folder>) with its own scripts\try-branch.ps1: on a copy of your data, with your normal
        Portly paused until you press Enter. Nothing is published.
    portly --version
        The installed version, and whether it is a release install or a Git checkout.
    portly --status [--logs]
        Is Portly running and healthy? (scripts\status.ps1 -View Status; --logs adds the log
        tails)
    portly --settings
        How it is set up: port, folders, logs, autostart, extension, Pages, other PCs (status.ps1 -View Settings).
    portly --start
        Start the Portly Server scheduled task (first refreshing Portly's named copies of
        node.exe, portly-supervisor.exe and portly-server.exe, when they are out of date).
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
                checkout the same as --rebuild, with its options).
                  --version <x>   install release <x> instead
                  --dry-run       show what would happen, change nothing
                  --force         reinstall even the installed version
                  --unattended    how the Portly Updater task runs it
  --rebuild     Git checkout: rebuild everything from the checked-out code:
                dependencies, the local page, the server and the GitHub Pages site.
                  --dry-run       show what would happen, change nothing
                  --skip-publish  leave the GitHub Pages site alone
                  --skip-server   do not restart the server
                  --allow-dirty   build and publish uncommitted changes too
                                  (refused otherwise)
  --dev [folder] Build and run a local checkout (the current folder's, or
                <folder>) in dev mode on a COPY of your data, then put your
                normal Portly back when you press Enter. Nothing is published.
                  --pages-port <n> port of the stand-in Pages site (5175)
                  --keep-data      keep the temporary data copy
                  --skip-build     use the builds already in web\dist
                  --dry-run        show what would happen, change nothing
  --version     Show the installed version.
  --status     Is Portly running and healthy?  (--logs adds the log tails)
  --settings    How Portly is set up: port, folders, logs, autostart,
                browser extension, GitHub Pages and other PCs.
  --start      Start the Portly server.
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

# Runs the installer with its output in $LogFile, replaced on each run, with the home folder
# masked: the task has no window to show it in. Returns the installer's exit code.
function Invoke-HbLoggedInstall {
    param(
        [Parameter(Mandatory)][string]$Powershell,
        [Parameter(Mandatory)][string]$Installer,
        [AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogFile
    )
    $folder = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $folder)) { $null = New-Item -ItemType Directory -Path $folder -Force }
    $writer = New-Object System.IO.StreamWriter($LogFile, $false, (New-Object System.Text.UTF8Encoding($false)))
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        & $Powershell -NoProfile -ExecutionPolicy Bypass -File $Installer @Arguments 2>&1 | ForEach-Object {
            $writer.WriteLine((ConvertTo-HbMaskedLine -Line "$_"))
            $writer.Flush()
        }
        return $global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
        $writer.Dispose()
    }
}

# portly --update in a release install: runs a temporary copy of scripts\install.ps1 against
# the install folder (the parent of this copy's app folder), so nothing in app\ is in use while
# it is replaced.
function Invoke-HbReleaseUpdate {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)]$Info, [AllowEmptyCollection()][string[]]$Options)
    $arguments = New-Object System.Collections.Generic.List[string]
    $unattended = $false
    for ($i = 0; $i -lt $Options.Count; $i++) {
        switch ($Options[$i].ToLowerInvariant()) {
            '--dry-run' { $arguments.Add('-DryRun') }
            '--force' { $arguments.Add('-Force') }
            '--unattended' { $unattended = $true }
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
    $dataDir = Get-HbDataDir -Scope Task -RepoRoot $RepoRoot
    if ($unattended) {
        $arguments.Add('-OnlyNewer')
        $arguments.Add('-NoBrowser')
        $arguments.Add('-StatusFile')
        $arguments.Add((Join-Path $dataDir 'update-status.json'))
    }
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('portly-update-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $temp -Force
    try {
        $installer = Join-Path $temp 'install.ps1'
        Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\install.ps1') -Destination $installer
        $powershell = (Get-Process -Id $PID).Path
        Push-Location -LiteralPath $temp
        try {
            if ($unattended) {
                $installArguments = @('-InstallDir', (Split-Path -Parent $RepoRoot)) + $arguments.ToArray()
                return Invoke-HbLoggedInstall -Powershell $powershell -Installer $installer -Arguments $installArguments -LogFile (Join-Path $dataDir 'logs\update.log')
            }
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

# The Git checkout to try: the folder given, else the one the shell is in (a worktree counts),
# else the checkout this command lives in. Returns $null (after saying why) when there is none.
function Resolve-HbDevCheckout {
    param([Parameter(Mandatory)][string]$DefaultRoot, [string]$Path)
    $candidate = $Path
    if (-not $candidate) {
        $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $git) {
            $top = "$(& $git.Source rev-parse --show-toplevel 2>$null)".Trim()
            if ($top -and (Test-Path -LiteralPath (Join-Path $top 'scripts\try-branch.ps1'))) { $candidate = $top }
        }
    }
    if (-not $candidate) { $candidate = $DefaultRoot }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        Write-HbFailure "No folder at $candidate."
        return $null
    }
    $full = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath (Join-Path $full 'scripts\try-branch.ps1') -PathType Leaf)) {
        Write-HbFailure "$full is not a Portly checkout (no scripts\try-branch.ps1). Run portly --dev from a checkout or pass its folder."
        return $null
    }
    return $full
}

# portly --dev: builds and runs a local checkout (this folder's, or the one given) with its own
# try-branch.ps1, on a copy of the real data. The installed Portly is paused meanwhile.
function Invoke-HbDev {
    param([Parameter(Mandatory)][string]$DefaultRoot, [AllowEmptyCollection()][string[]]$Options)
    $parameters = @{}
    $folder = $null
    for ($i = 0; $i -lt $Options.Count; $i++) {
        switch -Regex ($Options[$i].ToLowerInvariant()) {
            '^--dry-run$' { $parameters.DryRun = $true; break }
            '^--keep-data$' { $parameters.KeepData = $true; break }
            '^--skip-build$' { $parameters.SkipBuild = $true; break }
            '^--pages-port$' {
                $port = 0
                if ($i + 1 -ge $Options.Count -or -not [int]::TryParse($Options[$i + 1], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                    Write-HbFailure '--pages-port needs a port number, for example --pages-port 5175.'
                    return 2
                }
                $i++
                $parameters.PagesPort = $port
                break
            }
            '^--' { Write-HbFailure "Unknown option '$($Options[$i])'."; return 2 }
            default {
                if ($null -ne $folder) { Write-HbFailure 'Only one checkout folder can be given.'; return 2 }
                $folder = $Options[$i]
            }
        }
    }
    $checkout = Resolve-HbDevCheckout -DefaultRoot $DefaultRoot -Path $folder
    if ($null -eq $checkout) { return 1 }
    Write-HbInfo "Building and running the checkout at $checkout (your data is copied, never changed)."
    $global:LASTEXITCODE = 0
    & (Join-Path $checkout 'scripts\try-branch.ps1') @parameters | Out-Host
    return $global:LASTEXITCODE
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
                '--allow-dirty'  = @{ Name = 'AllowDirty'; Value = $true }
            }
            if ($null -eq $mapped) { return 2 }
            return Invoke-HbCliScript -Script 'update.ps1' -Parameters $mapped
        }
        'dev' { return Invoke-HbDev -DefaultRoot $repoRoot -Options $rest }
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
