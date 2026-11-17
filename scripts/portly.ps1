<#
.SYNOPSIS
    The `portly` command (installed on PATH by scripts\install-cli.ps1).

.DESCRIPTION
    portly [status] [--full] [--logs]
        Is Portly running and healthy? (scripts\status.ps1 -View Status). The default command.
        --full adds how it is set up (port, folders, logs, autostart, extension, Pages, other
        PCs); --logs adds the log tails.
    portly start
        Start the Portly Server scheduled task (first refreshing Portly's named copies of
        node.exe, portly-supervisor.exe and portly-server.exe, when they are out of date, and
        stopping stale development servers that hold the port) and wait until it answers.
    portly stop [<port>] [--all] [--dry-run]
        Stop the Portly processes listening on Portly's port (or <port>; --all: on every port):
        the task's server (its supervisor first), development servers and Vite run from a
        Portly checkout. Any other program is left alone. The task stays installed, so the
        extension starts Portly again at the next new tab; portly start starts it now.
    portly update [--dry-run] [--version <x>] [--force] [--allow-dirty] [--no-publish]
                  [--yes] [--skip-dependencies]
        Release install: download and install the newest release (or <x>; --force reinstalls)
        with scripts\install.ps1, run from a temporary copy. Git checkout: update everything
        from the code checked out (scripts\update.ps1): dependencies, the local page, the
        server and the GitHub Pages site. Uncommitted changes are refused unless --allow-dirty;
        --no-publish leaves the Pages site alone. Missing or outdated dependencies: asks before
        npm ci (--yes installs without asking, --skip-dependencies skips them).
    portly release [--dry-run] [--skip-build] [--skip-pages] [--yes]
        Git checkout only: builds the release package (scripts\build-release.ps1), then publishes
        it as a GitHub release and publishes the Pages site (scripts\publish-release.ps1). Asks
        before publishing, which is public, unless --yes; --dry-run publishes nothing.
    portly dev [<folder>] [--pages-port <n>] [--keep-data] [--skip-build] [--dry-run]
        Build and run a local Git checkout (the shell's current one, a worktree included, or
        <folder>) with its own scripts\try-branch.ps1: on a copy of your data, with your normal
        Portly paused until you press Enter. Nothing is published.
    portly help, portly -v
        The usage; the installed version and whether it is a release install or a checkout.

    The older spellings keep working: --status, --start, --update, --dev, --help, --version,
    --settings (status of the settings only), --rebuild (update in a checkout), and the
    options --skip-publish and --skip-server. The Portly Updater task runs
    `portly.ps1 --update --unattended` (only a newer version; the progress in
    <data folder>\update-status.json and the output in logs\update.log).

    In a terminal the output uses the Harbor theme (colors, icons, spinners); redirected or
    with NO_COLOR set it is plain text (scripts\lib\Common.ps1, "Output"). Each command passes
    its script's exit code through.
#>
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# The help: commands, each with its options. Rendered plain or in the theme by Write-PtCliHelp.
$PortlyCliCommands = @(
    [pscustomobject]@{
        Name = 'status'; Args = ''; Text = @('Is Portly running and healthy? (what plain `portly` shows)')
        Options = @(
            @('--full', 'also how it is set up: port, folders, logs, autostart,'),
            @('', 'browser extension, GitHub Pages and other PCs'),
            @('--logs', 'also the end of the log files'))
    },
    [pscustomobject]@{
        Name = 'start'; Args = ''; Text = @('Start the Portly server and wait until it answers.')
        Options = @()
    },
    [pscustomobject]@{
        Name = 'stop'; Args = '[port]'; Text = @('Stop the Portly processes on Portly''s port (or <port>): the server,', 'development servers and Portly''s own Vite. Nothing else is touched.')
        Options = @(
            @('--all', 'on every port'),
            @('--dry-run', 'show what would be stopped, stop nothing'))
    },
    [pscustomobject]@{
        Name = 'update'; Args = ''; Text = @('Release install: install the newest release.', 'Git checkout: rebuild everything from the checked-out code.')
        Options = @(
            @('--dry-run', 'show what would happen, change nothing'),
            @('--version <x>', 'release: install release <x> instead'),
            @('--force', 'release: reinstall even the installed version'),
            @('--allow-dirty', 'checkout: build and publish uncommitted changes too'),
            @('--no-publish', 'checkout: leave the GitHub Pages site alone'),
            @('--yes', 'checkout: install outdated dependencies without asking'),
            @('--skip-dependencies', 'checkout: do not install them, do not ask'))
    },
    [pscustomobject]@{
        Name = 'dev'; Args = '[folder]'; Text = @('Build and run a checkout (this folder''s, or <folder>) on a', 'COPY of your data; your Portly is back when you press Enter.')
        Options = @(
            @('--pages-port <n>', 'port of the stand-in Pages site (5175)'),
            @('--keep-data', 'keep the temporary data copy'),
            @('--skip-build', 'use the builds already in web\dist'),
            @('--dry-run', 'show what would happen, change nothing'))
    },
    [pscustomobject]@{
        Name = 'release'; Args = ''; Text = @('Git checkout: build the release package, then publish it as a GitHub', 'release and publish the Pages site (build-release.ps1, publish-release.ps1).')
        Options = @(
            @('--dry-run', 'build, then show what would be published; publish nothing'),
            @('--skip-build', 'publish the package already in dist-release'),
            @('--skip-pages', 'leave the GitHub Pages site alone'),
            @('--yes', 'do not ask before publishing (it is public)'))
    },
    [pscustomobject]@{
        Name = 'help'; Args = ''; Text = @('This text.  portly -v shows the version.')
        Options = @()
    }
)

function Write-PtCliHelp {
    Write-Host ''
    Write-Host ((Format-PtStyle Mist 'Usage: ') + (Format-PtStyle Foam 'portly' -Bold) + ' ' + (Format-PtStyle Teal '[command]') + ' ' + (Format-PtStyle Mist '[options]'))
    Write-Host ''
    foreach ($command in $PortlyCliCommands) {
        $first = $true
        foreach ($line in $command.Text) {
            $label = if ($first) { (Format-PtStyle Teal ('{0,-7}' -f $command.Name) -Bold) + (Format-PtStyle Teal ('{0,-9}' -f $command.Args)) } else { ' ' * 16 }
            Write-Host ('  ' + $label + ' ' + (Format-PtStyle Sand $line))
            $first = $false
        }
        foreach ($option in $command.Options) {
            Write-Host ((' ' * 21) + (Format-PtStyle Coral ('{0,-17}' -f $option[0])) + (Format-PtStyle Mist $option[1]))
        }
    }
    Write-Host ''
}

# Translates the command's --options into the script's parameters (a hashtable to splat);
# $null for an unknown option.
function ConvertTo-PtCliParameters {
    param([AllowEmptyCollection()][string[]]$Options, [Parameter(Mandatory)][hashtable]$Map)
    $result = @{}
    foreach ($option in $Options) {
        $key = $option.ToLowerInvariant()
        if (-not $Map.ContainsKey($key)) {
            Write-PtFailure "Unknown option '$option'."
            return $null
        }
        $result[$Map[$key].Name] = $Map[$key].Value
    }
    return $result
}

# Runs scripts\<Script> here (its own `exit` ends only that script) and returns its exit code.
function Invoke-PtCliScript {
    param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][hashtable]$Parameters)
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot $Script) @Parameters | Out-Host
    return $global:LASTEXITCODE
}

# Runs scripts\<Script> in a child PowerShell with its output relayed in the theme and a spinner
# while it works (switch parameters only). Returns its exit code.
function Invoke-PtCliScriptStreamed {
    param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][hashtable]$Parameters, [string]$Activity = 'Working')
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $Script))
    foreach ($name in $Parameters.Keys) { $arguments += "-$name" }
    return Invoke-PtStreamedProcess -FilePath (Get-Process -Id $PID).Path -Arguments $arguments -Activity $Activity
}

# Runs the installer with its output in $LogFile, replaced on each run, with the home folder
# masked: the task has no window to show it in. Returns the installer's exit code.
function Invoke-PtLoggedInstall {
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
            $writer.WriteLine((ConvertTo-PtMaskedLine -Line "$_"))
            $writer.Flush()
        }
        return $global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
        $writer.Dispose()
    }
}

# portly update in a release install: runs a temporary copy of scripts\install.ps1 against the
# install folder (the parent of this copy's app folder), so nothing in app\ is in use while it
# is replaced.
function Invoke-PtReleaseUpdate {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)]$Info, [AllowEmptyCollection()][string[]]$Options)
    $arguments = New-Object System.Collections.Generic.List[string]
    $unattended = $false
    for ($i = 0; $i -lt $Options.Count; $i++) {
        switch ($Options[$i].ToLowerInvariant()) {
            '--dry-run' { $arguments.Add('-DryRun') }
            '--force' { $arguments.Add('-Force') }
            '--unattended' { $unattended = $true }
            '--version' {
                if ($i + 1 -ge $Options.Count) { Write-PtFailure '--version needs a version, for example --version 0.2.0-alpha.1.'; return 2 }
                $i++
                $arguments.Add('-Version')
                $arguments.Add($Options[$i])
            }
            { $_ -in '--allow-dirty', '--no-publish', '--skip-publish', '--skip-server', '--yes', '--skip-dependencies' } {
                Write-PtFailure "$($Options[$i]) is for a Git checkout; this is a release install."
                return 2
            }
            default { Write-PtFailure "Unknown option '$($Options[$i])'."; return 2 }
        }
    }
    if ((Split-Path -Leaf $RepoRoot) -ne 'app') {
        Write-PtFailure "This copy ($RepoRoot) was not installed by install.ps1 (its folder is not <install folder>\app), so it cannot update itself."
        return 1
    }
    $releaseRepo = "$(Get-PtProperty $Info 'releaseRepo')"
    if ($releaseRepo) { $arguments.Add('-ReleaseRepo'); $arguments.Add($releaseRepo) }
    $dataDir = Get-PtDataDir -Scope Task -RepoRoot $RepoRoot
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
        $installArguments = @('-InstallDir', (Split-Path -Parent $RepoRoot)) + $arguments.ToArray()
        Push-Location -LiteralPath $temp
        try {
            if ($unattended) {
                return Invoke-PtLoggedInstall -Powershell $powershell -Installer $installer -Arguments $installArguments -LogFile (Join-Path $dataDir 'logs\update.log')
            }
            if (Test-PtFancyOutput) {
                return Invoke-PtStreamedProcess -FilePath $powershell -WorkingDirectory $temp -Activity 'Updating Portly' -Arguments (
                    @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer) + $installArguments)
            }
            $global:LASTEXITCODE = 0
            & $powershell -NoProfile -ExecutionPolicy Bypass -File $installer @installArguments | Out-Host
            return $global:LASTEXITCODE
        } finally {
            Pop-Location
        }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# portly update in a Git checkout: scripts\update.ps1 with the matching switches.
function Invoke-PtCheckoutUpdate {
    param([AllowEmptyCollection()][string[]]$Options)
    foreach ($option in $Options) {
        if ($option.ToLowerInvariant() -in '--version', '--force') {
            Write-PtFailure "$option is for a release install; a Git checkout updates from the code checked out (git pull first)."
            return 2
        }
    }
    $mapped = ConvertTo-PtCliParameters -Options $Options -Map @{
        '--dry-run'      = @{ Name = 'DryRun'; Value = $true }
        '--no-publish'   = @{ Name = 'SkipPublish'; Value = $true }
        '--skip-publish' = @{ Name = 'SkipPublish'; Value = $true }
        '--skip-server'  = @{ Name = 'SkipServer'; Value = $true }
        '--allow-dirty'  = @{ Name = 'AllowDirty'; Value = $true }
        '--yes'          = @{ Name = 'InstallDependencies'; Value = $true }
        '--skip-dependencies' = @{ Name = 'SkipDependencies'; Value = $true }
    }
    if ($null -eq $mapped) { return 2 }
    # The streamed child has no usable console, so the dependency question is asked here.
    if (-not $mapped.ContainsKey('InstallDependencies') -and -not $mapped.ContainsKey('SkipDependencies') -and
        -not $mapped.ContainsKey('DryRun') -and (Test-PtFancyOutput) -and (Test-PtCanPrompt) -and
        (Test-PtDependenciesStale -RepoRoot (Get-PtRepoRoot -ScriptRoot $PSScriptRoot))) {
        Write-PtWarn 'Dependencies are missing or out of date (package-lock.json changed since the last npm ci).'
        if (Read-PtYesNo -Question 'Install them now (npm ci)?') { $mapped['InstallDependencies'] = $true } else { $mapped['SkipDependencies'] = $true }
    }
    if (Test-PtFancyOutput) { return Invoke-PtCliScriptStreamed -Script 'update.ps1' -Parameters $mapped -Activity 'Updating from the checkout' }
    return Invoke-PtCliScript -Script 'update.ps1' -Parameters $mapped
}

# Version (from release.json or package.json), Kind and Detail (branch and commit, or Node.js).
function Get-PtCliVersion {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $info = Get-PtReleaseInfo -RepoRoot $RepoRoot
    if ($null -ne $info) {
        return [pscustomobject]@{ Version = "$($info.version)"; Kind = 'release install'; Detail = "Node.js $(Get-PtProperty $info 'node')" }
    }
    $package = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'package.json')) | ConvertFrom-Json
    $detail = ''
    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $git) {
        $branch = "$(& $git.Source -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)".Trim()
        $commit = "$(& $git.Source -C $RepoRoot rev-parse --short HEAD 2>$null)".Trim()
        if ($commit) { $detail = "$branch $commit" }
    }
    return [pscustomobject]@{ Version = "$($package.version)"; Kind = 'Git checkout'; Detail = $detail }
}

function Write-PtVersion {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $version = Get-PtCliVersion -RepoRoot $RepoRoot
    if (Test-PtFancyOutput) {
        $subtitle = (@($version.Kind, $version.Detail) | Where-Object { $_ }) -join " $($PtIcons.Middot) "
        Write-PtBanner -Version $version.Version -Subtitle $subtitle
        Write-Host ('  ' + (Format-PtStyle Mist $RepoRoot))
        Write-Host ''
        return 0
    }
    $parts = @($version.Kind, $version.Detail, $RepoRoot) | Where-Object { $_ }
    Write-Host "Portly $($version.Version) ($($parts -join ', '))"
    return 0
}

# The banner of a command: its name and what it does (-Detail), or for status the overall state
# as a light (-State, -StateText). portly -v shows the kind of install.
function Write-PtCliBanner {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Subtitle,
        [string]$Detail = '',
        [ValidateSet('', 'Ok', 'Warn', 'Bad')][string]$State = '',
        [string]$StateText = ''
    )
    if (-not (Test-PtFancyOutput)) { return }
    $version = Get-PtCliVersion -RepoRoot $RepoRoot
    Write-PtBanner -Version $version.Version -Subtitle $Subtitle -State $State -StateText $StateText -Detail $Detail
}

# The Git checkout to try: the folder given, else the one the shell is in (a worktree counts),
# else the checkout this command lives in. Returns $null (after saying why) when there is none.
function Resolve-PtDevCheckout {
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
        Write-PtFailure "No folder at $candidate."
        return $null
    }
    $full = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath (Join-Path $full 'scripts\try-branch.ps1') -PathType Leaf)) {
        Write-PtFailure "$full is not a Portly checkout (no scripts\try-branch.ps1). Run portly dev from a checkout or pass its folder."
        return $null
    }
    return $full
}

# portly release in a Git checkout: scripts\build-release.ps1, then scripts\publish-release.ps1
# (the release on GitHub and the Pages site). Publishing is public: asked first unless --yes.
function Invoke-PtRelease {
    param([Parameter(Mandatory)][string]$RepoRoot, [AllowEmptyCollection()][string[]]$Options)
    $dryRun = $false; $skipBuild = $false; $skipPages = $false; $yes = $false
    foreach ($option in $Options) {
        switch ($option.ToLowerInvariant()) {
            '--dry-run' { $dryRun = $true }
            '--skip-build' { $skipBuild = $true }
            '--skip-pages' { $skipPages = $true }
            '--yes' { $yes = $true }
            default { Write-PtFailure "Unknown option '$option'."; return 2 }
        }
    }
    if (Test-PtWorktreePath -Path $RepoRoot) {
        Write-PtFailure "This is a temporary worktree ($RepoRoot). Merge into main and run portly release from the main checkout."
        return 1
    }
    $version = "$(([System.IO.File]::ReadAllText((Join-Path $RepoRoot 'package.json')) | ConvertFrom-Json).version)"
    if (-not $skipBuild) {
        Write-PtStep "Building the release package for $version (scripts\build-release.ps1)"
        $code = Invoke-PtCliScript -Script 'build-release.ps1' -Parameters @{}
        if ($code -ne 0) { return $code }
    }
    if (-not $dryRun -and -not $yes) {
        if (-not (Test-PtCanPrompt)) {
            Write-PtFailure 'Publishing is public: run portly release in a terminal to confirm it, or pass --yes.'
            return 1
        }
        if (-not (Read-PtYesNo -Question "Publish Portly $version to GitHub (public)$(if (-not $skipPages) { ' and the Pages site' })?")) {
            Write-PtInfo 'Nothing published. The package stays in dist-release.'
            return 0
        }
    }
    $parameters = @{}
    if ($dryRun) { $parameters.DryRun = $true }
    if ($skipPages) { $parameters.SkipPages = $true }
    return Invoke-PtCliScript -Script 'publish-release.ps1' -Parameters $parameters
}

# portly dev: builds and runs a local checkout (this folder's, or the one given) with its own
# try-branch.ps1, on a copy of the real data. The installed Portly is paused meanwhile. It runs
# here (not streamed): try-branch.ps1 waits for Enter.
function Invoke-PtDev {
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
                    Write-PtFailure '--pages-port needs a port number, for example --pages-port 5175.'
                    return 2
                }
                $i++
                $parameters.PagesPort = $port
                break
            }
            '^--' { Write-PtFailure "Unknown option '$($Options[$i])'."; return 2 }
            default {
                if ($null -ne $folder) { Write-PtFailure 'Only one checkout folder can be given.'; return 2 }
                $folder = $Options[$i]
            }
        }
    }
    $checkout = Resolve-PtDevCheckout -DefaultRoot $DefaultRoot -Path $folder
    if ($null -eq $checkout) { return 1 }
    Write-PtInfo "Building and running the checkout at $checkout (your data is copied, never changed)."
    $global:LASTEXITCODE = 0
    & (Join-Path $checkout 'scripts\try-branch.ps1') @parameters | Out-Host
    return $global:LASTEXITCODE
}

function Invoke-PtStart {
    param([AllowEmptyCollection()][string[]]$Options)
    if ($Options.Count -gt 0) { Write-PtFailure 'start takes no options.'; return 2 }
    if ($null -eq (Get-PtTask)) {
        Write-PtFailure "The '$PortlyTaskName' task is not installed. Run scripts\install-autostart.ps1 first."
        return 1
    }
    # Refreshes Portly's copies of node.exe first when they are missing or out of date.
    Start-PtTask
    $port = (Get-PtPortSetting -Scope Task).Port
    $health = Wait-PtHealth -Port $port -TimeoutSeconds 60 -Activity 'Starting Portly'
    if ($health.Ok) { Write-PtOk "Portly is $(Format-PtHealth $health)"; return 0 }
    Write-PtFailure "Portly did not start: $(Format-PtHealth $health). Try: portly status --logs"
    return 1
}

function Invoke-PtStop {
    param([AllowEmptyCollection()][string[]]$Options)
    $all = $false
    $dryRun = $false
    $port = 0
    foreach ($option in $Options) {
        $number = 0
        switch -Regex ($option.ToLowerInvariant()) {
            '^--?all$' { $all = $true; break }
            '^--dry-?run$' { $dryRun = $true; break }
            '^\d+$' {
                if ($port -gt 0 -or -not [int]::TryParse($option, [ref]$number) -or $number -lt 1 -or $number -gt 65535) {
                    Write-PtFailure 'Give one port number (1-65535), for example portly stop 5757.'
                    return 2
                }
                $port = $number
                break
            }
            default { Write-PtFailure "Unknown option '$option'."; return 2 }
        }
    }
    if ($all -and $port -gt 0) { Write-PtFailure 'Give a port or --all, not both.'; return 2 }
    if (-not $all -and $port -eq 0) { $port = (Get-PtPortSetting -Scope Task).Port }
    $where = if ($all) { 'on any port' } else { "on port $port" }
    $found = if ($all) { Get-PtPortlyListeners } else { Get-PtPortlyListeners -Port $port }
    if ($null -eq $found) { Write-PtFailure 'Cannot list listening ports here (no Get-NetTCPConnection).'; return 1 }
    if ($found.Count -eq 0) { Write-PtOk "No Portly process is listening $where."; return 0 }
    Write-PtInfo "Portly processes listening $where`: $(Format-PtStrayServers -Strays $found)"
    if ($dryRun) { Write-PtOk 'Dry run: nothing was stopped.'; return 0 }
    $stopped = New-Object System.Collections.Generic.List[int]
    foreach ($item in $found) {
        # The task's server: its supervisor first, or it would start the server again.
        $ids = @()
        if ($item.Kind -eq 'task' -and $null -ne $item.SupervisorId) { $ids += [int]$item.SupervisorId }
        $ids += [int]$item.ProcessId
        foreach ($id in $ids) {
            if ($stopped -contains $id) { continue }
            try {
                Stop-Process -Id $id -Force -ErrorAction Stop
                $stopped.Add($id)
            } catch {
                if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
                    Write-PtFailure "Could not stop PID $id`: $($_.Exception.Message)"
                    return 1
                }
            }
        }
    }
    Write-PtOk "Stopped PID $($stopped -join ', ')."
    if (@($found | Where-Object { $_.Kind -eq 'task' }).Count -gt 0) {
        Write-PtInfo "The '$PortlyTaskName' task is still installed: the extension starts Portly again at the next new tab, portly start starts it now."
    }
    return 0
}

function Invoke-PtCli {
    param([AllowEmptyCollection()][string[]]$CliArgs)
    $command = 'status'
    $rest = @()
    if ($CliArgs.Count -gt 0) {
        $first = $CliArgs[0]
        # `portly --full` / `portly --logs`: options of the default command.
        if ($first.ToLowerInvariant() -in '--full', '--logs') {
            $rest = $CliArgs
        } else {
            $command = $first.ToLowerInvariant().TrimStart('-')
            if ($CliArgs.Count -gt 1) { $rest = $CliArgs[1..($CliArgs.Count - 1)] }
        }
    }

    $repoRoot = Get-PtRepoRoot -ScriptRoot $PSScriptRoot
    $release = Get-PtReleaseInfo -RepoRoot $repoRoot
    switch ($command) {
        'status' {
            $mapped = ConvertTo-PtCliParameters -Options $rest -Map @{
                '--logs' = @{ Name = 'LogLines'; Value = 30 }
                '--full' = @{ Name = 'View'; Value = 'All' }
            }
            if ($null -eq $mapped) { return 2 }
            if (-not $mapped.ContainsKey('View')) { $mapped.View = 'Status' }
            if (Test-PtFancyOutput) {
                $overall = (Get-PtStatusSnapshot -RepoRoot $repoRoot -Port (Get-PtPortSetting -Scope Process).Port).Overall
                Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'status' -State $overall.State -StateText $overall.Text -Detail $overall.Detail
            }
            return Invoke-PtCliScript -Script 'status.ps1' -Parameters $mapped
        }
        { $_ -in 'settings', 'config' } {
            $mapped = ConvertTo-PtCliParameters -Options $rest -Map @{}
            if ($null -eq $mapped) { return 2 }
            $mapped.View = 'Settings'
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'settings' -Detail 'how Portly is set up'
            return Invoke-PtCliScript -Script 'status.ps1' -Parameters $mapped
        }
        'start' {
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'start' -Detail 'start the server and wait until it answers'
            return Invoke-PtStart -Options $rest
        }
        'stop' {
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'stop' -Detail 'stop the Portly processes on a port'
            return Invoke-PtStop -Options $rest
        }
        'update' {
            $updateDetail = if ($null -ne $release) { 'install the newest release' } else { 'rebuild everything from this checkout' }
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'update' -Detail $updateDetail
            if ($null -ne $release) { return Invoke-PtReleaseUpdate -RepoRoot $repoRoot -Info $release -Options $rest }
            return Invoke-PtCheckoutUpdate -Options $rest
        }
        'rebuild' {
            if ($null -ne $release) {
                Write-PtFailure "This is a release install (Portly $($release.version)), not a Git checkout: use portly update."
                return 1
            }
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'update' -Detail 'rebuild everything from this checkout'
            return Invoke-PtCheckoutUpdate -Options $rest
        }
        'release' {
            if ($null -ne $release) {
                Write-PtFailure "This is a release install (Portly $($release.version)), not a Git checkout: portly release builds and publishes from a checkout."
                return 1
            }
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'release' -Detail 'build and publish a release'
            return Invoke-PtRelease -RepoRoot $repoRoot -Options $rest
        }
        'dev' {
            Write-PtCliBanner -RepoRoot $repoRoot -Subtitle 'dev' -Detail 'try a checkout on a copy of your data'
            return Invoke-PtDev -DefaultRoot $repoRoot -Options $rest
        }
        { $_ -in 'version', 'v' } {
            if ($rest.Count -gt 0) { Write-PtFailure 'version takes no options.'; return 2 }
            return Write-PtVersion -RepoRoot $repoRoot
        }
        { $_ -in 'help', 'h', '?' } {
            Write-PtCliHelp
            return 0
        }
        default {
            Write-PtFailure "Unknown command '$($CliArgs[0])'."
            Write-PtCliHelp
            return 2
        }
    }
}

try {
    $exitCode = Invoke-PtCli -CliArgs @($args) | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    Set-PtCursorVisible $true
    Write-PtFailure $_.Exception.Message
    exit 1
}
