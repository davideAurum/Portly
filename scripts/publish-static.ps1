<#
.SYNOPSIS
    Builds the browser-only Portly site (web\dist-static) and publishes it to a local clone of
    your PUBLIC GitHub Pages repository.

.DESCRIPTION
    Runs `npm run build:static` with PORTLY_STATIC_BASE set to -Base, checks that
    web\dist-static\index.html exists and uses that base, then replaces the contents of the
    public repository's working tree with it: every tracked file is removed (CNAME and README.md
    are kept, .git is never touched), web\dist-static\*, an empty .nojekyll and a .gitattributes
    are copied in, the result is committed (skipped when nothing changed) and pushed (unless
    -NoPush).

    Before that, the clone is checked against its upstream branch (git fetch): a clone that is
    only behind it (no local commits) is fast-forwarded first; one that has diverged (local
    commits the upstream lacks, and upstream commits this clone lacks) is refused with the exact
    commands to merge it - the script never merges on its own. The .gitattributes (`*.ps1 -text`,
    `*.woff2 binary`; lines of its own that the clone already has are kept) makes git store
    install.ps1 and setup.ps1 byte for byte, CRLF endings included, whatever core.autocrlf the
    clone uses. After the push it reminds you that GitHub Pages can serve the previous page for up
    to 10 minutes (Cache-Control: max-age=600).

    It DELETES EVERY TRACKED FILE (except CNAME and README.md) of the repository it is given. Use a
    new, empty public repository created for this site; never point it at a repository that holds
    other pages (such as portly-site or <user>.github.io with its own files).

    Safety rails: the folder must be the root of a git repository with a branch checked out and a
    clean working tree (no uncommitted changes, no untracked files), and it must not be this
    Portly checkout or any other Portly checkout. The repository must be empty or hold only
    an earlier Portly publish (index.html with <meta name="portly-build" content="static">, or
    "homebase-build" from before the rename, assets/, install.ps1, setup.ps1, the files of
    web\public, .nojekyll, .gitattributes, CNAME, README.md); anything else is refused
    unless -ReplaceEverything. When origin is on github.com and there is no CNAME file, -Base must
    match the repository ('/' for <user>.github.io, '/<repo>/' otherwise). Only the build's own
    paths are staged. -DryRun only prints the plan: it fetches (to report the same as a real
    run), builds nothing and changes nothing, and it refuses what a real run would refuse - except
    a fetch that fails (offline, say), which stops a real run while a dry run says so and goes on
    with this clone's own files.

    A publish into the wrong repository can be undone there: `git revert <publish commit>`, then
    `git push` (the old files are still in its history).

    Every publish replaces the whole content of the repository it is given, so the site gets a
    public repository of its own, never the Portly repository. See docs\setup\static-build.md.

.PARAMETER PublicRepoPath
    Local clone of the public repository that serves the site. Its checked-out branch is the one
    GitHub Pages deploys from. Every tracked file in it except CNAME and README.md is deleted, so
    it must be a new, empty repository created for this site (or one this script published to).

.PARAMETER Base
    URL path the site is served from: '/<repo>/' for a project site
    (https://<user>.github.io/<repo>/), '/' (the default) for a user site or a custom domain.
    Must start and end with '/'.

.PARAMETER Message
    Commit message. Default: "Publish Portly <version> (<date>)".

.PARAMETER DryRun
    Print what would be built, removed, copied, committed and pushed. Fetches the clone's upstream
    to report it (when that fails, the plan says so and goes on with this clone's own files);
    otherwise changes nothing.

.PARAMETER NoPush
    Commit, but do not push.

.PARAMETER ReplaceEverything
    Publish even though the repository holds files that are not an earlier Portly publish: they
    are deleted (CNAME and README.md excepted). Skips only that check; every other one still
    applies. The plan lists each file before anything is removed.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-static.ps1 -PublicRepoPath ..\portly-pages -Base /portly-pages/

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-static.ps1 -PublicRepoPath ..\portly-pages -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$PublicRepoPath,
    [ValidateNotNullOrEmpty()][string]$Base = '/',
    [ValidateNotNullOrEmpty()][string]$Message,
    [switch]$DryRun,
    [switch]$NoPush,
    [switch]$ReplaceEverything
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# Files of the public repository that are not part of the build and survive a publish.
$HbPublishKeep = @('CNAME', 'README.md')
$HbNoJekyll = '.nojekyll'
$HbGitAttributes = '.gitattributes'
# What the publish puts into the public repository's .gitattributes. With core.autocrlf=true (the
# Git for Windows default) and no attributes, git would commit install.ps1 and setup.ps1 with LF
# endings, and the site would serve files that differ from the build (web\vite.config.ts copies
# them byte for byte). Lines of the file that are not these (the repository's own) are kept.
$HbGitAttributesLines = @(
    '# Portly (scripts\publish-static.ps1): install.ps1 and setup.ps1 are published byte for byte (CRLF endings).',
    '*.ps1 -text',
    '*.woff2 binary'
)
# web\vite.config.ts (staticHtml) puts this tag into every static build's index.html (homebase-build
# before the rename to Portly).
$HbBuildMarker = '<meta\s[^>]*name\s*=\s*["'']?(portly|homebase)-build["'']?[^>]*content\s*=\s*["'']?static\b'

# Runs git in a folder. Output is captured (stderr included) unless -ShowOutput, which streams it
# to the console (commit, push). Throws on a non-zero exit code unless -AllowFailure. Windows
# PowerShell 5.1 wraps each stderr line in an ErrorRecord, and a blank one prints as its exception
# type name ("System.Management.Automation.RemoteException"), so the message is taken instead.
function Invoke-HbGit {
    param(
        [Parameter(Mandatory)][string]$Git,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$ShowOutput
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($ShowOutput) {
            & $Git -C $Directory @Arguments | Out-Host
            $lines = @()
        } else {
            $lines = @(& $Git -C $Directory @Arguments 2>&1 | ForEach-Object {
                    if ($_ -is [System.Management.Automation.ErrorRecord]) { "$($_.Exception.Message)" } else { "$_" } })
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $detail = ''
        if ($lines.Count -gt 0) { $detail = ': ' + (($lines | Where-Object { $_.Trim() }) -join ' ') }
        throw "git $($Arguments -join ' ') failed (exit code $exitCode)$detail"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines }
}

# Full path with '\' separators and no trailing separator (git prints '/' paths).
function Get-HbNormalizedPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path.Replace('/', '\'))
    return $full.TrimEnd('\')
}

# Runs `npm run build:static` with PORTLY_STATIC_BASE for this process only.
function Invoke-HbStaticBuild {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$BasePath)
    $npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $npm) {
        throw 'npm.cmd was not found on PATH (it is installed with Node.js).'
    }
    $saved = [System.Environment]::GetEnvironmentVariable('PORTLY_STATIC_BASE', 'Process')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $RepoRoot
    try {
        [System.Environment]::SetEnvironmentVariable('PORTLY_STATIC_BASE', $BasePath, 'Process')
        & $npm.Source run build:static | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        [System.Environment]::SetEnvironmentVariable('PORTLY_STATIC_BASE', $saved, 'Process')
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "npm run build:static failed (exit code $exitCode)." }
}

# Owner and name of a github.com remote ({User, Repo}); $null for any other remote.
function Get-HbGitHubRepo {
    param([AllowNull()][string]$RemoteUrl)
    if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { return $null }
    $match = [regex]::Match($RemoteUrl.Trim(), '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)(?<user>[^/]+)/(?<repo>[^/]+?)(?:\.git)?/?$', 'IgnoreCase')
    if (-not $match.Success) { return $null }
    return [pscustomobject]@{ User = $match.Groups['user'].Value; Repo = $match.Groups['repo'].Value }
}

# The site URL GitHub Pages will serve, when the remote is on github.com; else $null.
function Get-HbPagesUrl {
    param([AllowNull()][string]$RemoteUrl, [Parameter(Mandatory)][string]$BasePath)
    $gitHub = Get-HbGitHubRepo -RemoteUrl $RemoteUrl
    if ($null -eq $gitHub) { return $null }
    return "https://$($gitHub.User.ToLowerInvariant()).github.io$BasePath"
}

# Top-level names an earlier publish leaves in the public repository: the build's own entries
# (index.html, assets, install.ps1, setup.ps1, whatever web\public holds), .nojekyll, .gitattributes
# and the kept files.
function Get-HbPublishedNames {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($name in (@('index.html', 'assets', 'install.ps1', 'setup.ps1', $HbNoJekyll, $HbGitAttributes) + $HbPublishKeep)) { $names.Add($name) }
    $publicDir = Join-Path $RepoRoot 'web\public'
    if (Test-Path -LiteralPath $publicDir -PathType Container) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $publicDir -Force)) { $names.Add($entry.Name) }
    }
    return , $names.ToArray()
}

# Prints each tracked file a publish deletes (before anything is deleted).
function Write-HbRemovalList {
    param([Parameter(Mandatory)][object]$Plan)
    $keptText = ''
    if ($Plan.Kept.Count -gt 0) { $keptText = "; kept: $($Plan.Kept -join ', ')" }
    Write-HbField -Name 'Remove' -Value "$($Plan.ToRemove.Count) tracked file(s)$keptText"
    foreach ($file in $Plan.ToRemove) { Write-HbInfo "- $file" }
}

# Fetches the checked-out branch's upstream and counts the commits on each side: {Upstream, Ahead
# (local commits the upstream lacks), Behind (upstream commits this clone lacks), FetchError}.
# Without an upstream nothing is fetched, Upstream is $null and both counts are 0. A fetch that
# fails throws (a real run stops there); with -AllowFetchFailure (the dry run) it is reported in
# FetchError instead, with both counts 0.
function Get-HbPublishSyncState {
    param(
        [Parameter(Mandatory)][string]$Git,
        [Parameter(Mandatory)][string]$Directory,
        [AllowNull()][AllowEmptyString()][string]$Upstream,
        [switch]$AllowFetchFailure
    )
    $state = [pscustomobject]@{ Upstream = $null; Ahead = 0; Behind = 0; FetchError = $null }
    if ([string]::IsNullOrWhiteSpace($Upstream)) { return $state }
    $state.Upstream = $Upstream
    $fetch = Invoke-HbGit -Git $Git -Directory $Directory -Arguments @('fetch', '--quiet') -AllowFailure
    if ($fetch.ExitCode -ne 0) {
        $detail = (@($fetch.Lines | Where-Object { $_.Trim() }) -join ' ')
        if ($AllowFetchFailure) {
            $state.FetchError = "git fetch failed (exit code $($fetch.ExitCode)): $detail"
            return $state
        }
        throw ("git fetch failed in $Directory (exit code $($fetch.ExitCode)): $detail - so the clone could not be checked against $Upstream. " +
            'Check the connection and the remote, then run the publish again.')
    }
    $counts = Invoke-HbGit -Git $Git -Directory $Directory -Arguments @('rev-list', '--left-right', '--count', "HEAD...$Upstream")
    $parts = @()
    if ($counts.Lines.Count -gt 0) { $parts = @("$($counts.Lines[0])".Trim() -split '\s+') }
    if ($parts.Count -ne 2) { throw "Could not compare HEAD with $Upstream (git rev-list printed '$($counts.Lines -join ' ')')." }
    $state.Ahead = [int]$parts[0]
    $state.Behind = [int]$parts[1]
    return $state
}

# Fast-forwards the checked-out branch to its upstream (git refuses when that would need a merge);
# returns the new short HEAD.
function Invoke-HbPublishFastForward {
    param([Parameter(Mandatory)][string]$Git, [Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Upstream)
    $null = Invoke-HbGit -Git $Git -Directory $Directory -Arguments @('merge', '--ff-only', '--quiet', $Upstream)
    return (Invoke-HbGit -Git $Git -Directory $Directory -Arguments @('rev-parse', '--short', 'HEAD')).Lines[0]
}

# The .gitattributes text to publish: the lines the clone's file holds that are not Portly's (in
# their order), a blank line, then Portly's lines ($HbGitAttributesLines). Running it on its own
# output gives the same text, so a publish that changes nothing else stays "nothing changed".
function Get-HbGitAttributesText {
    param([AllowNull()][AllowEmptyString()][string]$Existing)
    $own = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrEmpty($Existing)) {
        foreach ($line in ($Existing -split "`r?`n")) {
            $trimmed = $line.Trim()
            if ($trimmed.StartsWith('# Portly', [System.StringComparison]::Ordinal) -or $HbGitAttributesLines -ccontains $trimmed) { continue }
            $own.Add($line.TrimEnd())
        }
        while ($own.Count -gt 0 -and $own[$own.Count - 1] -eq '') { $own.RemoveAt($own.Count - 1) }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    if ($own.Count -gt 0) {
        foreach ($line in $own) { $lines.Add($line) }
        $lines.Add('')
    }
    foreach ($line in $HbGitAttributesLines) { $lines.Add($line) }
    return (($lines -join "`n") + "`n")
}

# Replaces the clone's content with the build: git rm removes the tracked files to remove (from
# the index and the working tree; untracked files, .git and the kept files are not touched),
# web\dist-static\* is copied in, .nojekyll is added when the build has none, the .gitattributes
# is written (before the add, so that it governs how the scripts are stored), and exactly those
# paths are staged: a file that a removed .gitignore used to hide (a log, a Thumbs.db) must not
# slip into the public commit. Returns the staged top-level paths.
function Update-HbPublishTree {
    param(
        [Parameter(Mandatory)][string]$Git,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][string]$DistStatic,
        [AllowEmptyCollection()][string[]]$ToRemove = @()
    )
    $attributesPath = Join-Path $TargetRoot $HbGitAttributes
    $existingAttributes = $null
    if (Test-Path -LiteralPath $attributesPath -PathType Leaf) { $existingAttributes = [System.IO.File]::ReadAllText($attributesPath) }
    if ($ToRemove.Count -gt 0) {
        $null = Invoke-HbGit -Git $Git -Directory $TargetRoot -Arguments (@('rm', '-r', '-q', '--') + $ToRemove)
    }
    $buildEntries = @(Get-ChildItem -LiteralPath $DistStatic -Force)
    $buildEntries | Copy-Item -Destination $TargetRoot -Recurse -Force
    $noJekyll = Join-Path $TargetRoot $HbNoJekyll
    if (-not (Test-Path -LiteralPath $noJekyll -PathType Leaf)) {
        [System.IO.File]::WriteAllText($noJekyll, '')
    }
    [System.IO.File]::WriteAllText($attributesPath, (Get-HbGitAttributesText -Existing $existingAttributes))
    $stagePaths = @(@($buildEntries | ForEach-Object { $_.Name }) + @($HbNoJekyll, $HbGitAttributes) | Select-Object -Unique)
    $null = Invoke-HbGit -Git $Git -Directory $TargetRoot -Arguments (@('add', '-A', '--') + $stagePaths)
    return , $stagePaths
}

# Validates everything and returns the plan; throws with a message for the user when something is off.
function Get-PublishPlan {
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'web\vite.config.ts') -PathType Leaf)) {
        throw "This script must stay in the scripts folder of a Portly checkout (no web\vite.config.ts under $repoRoot)."
    }

    # -Base follows web\vite.config.ts (staticBase): absolute, trailing slash, no spaces.
    if (-not ($Base.StartsWith('/') -and $Base.EndsWith('/')) -or $Base -match '\s') {
        throw "-Base must start and end with '/' and contain no spaces (got '$Base'). Use '/<repo>/' for a project site or '/' for a user site."
    }

    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $git) {
        throw 'git.exe was not found on PATH. Install Git from https://git-scm.com/.'
    }
    $gitExe = $git.Source

    $target = Get-HbNormalizedPath -Path ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PublicRepoPath))
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "-PublicRepoPath does not exist or is not a folder: $target"
    }
    $top = Invoke-HbGit -Git $gitExe -Directory $target -Arguments @('rev-parse', '--show-toplevel') -AllowFailure
    if ($top.ExitCode -ne 0 -or $top.Lines.Count -eq 0 -or [string]::IsNullOrWhiteSpace($top.Lines[0])) {
        throw "$target is not a git repository. Clone the public GitHub Pages repository first (git clone https://github.com/<user>/<repo>.git) and pass that folder."
    }
    $targetRoot = Get-HbNormalizedPath -Path $top.Lines[0]
    if (-not [string]::Equals($targetRoot, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$target is inside the repository $targetRoot. Pass the repository root itself."
    }

    # Never publish into Portly: this checkout (or a worktree of the same repository), or another one.
    $thisRoot = Get-HbNormalizedPath -Path $repoRoot
    if ([string]::Equals($targetRoot, $thisRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The target is this Portly repository itself. Publish into a separate, public repository that holds only the built site (see docs\setup\static-build.md).'
    }
    $thisCommon = Invoke-HbGit -Git $gitExe -Directory $thisRoot -Arguments @('rev-parse', '--path-format=absolute', '--git-common-dir') -AllowFailure
    $targetCommon = Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('rev-parse', '--path-format=absolute', '--git-common-dir') -AllowFailure
    if ($thisCommon.ExitCode -eq 0 -and $targetCommon.ExitCode -eq 0 -and $thisCommon.Lines.Count -gt 0 -and $targetCommon.Lines.Count -gt 0 -and
        [string]::Equals((Get-HbNormalizedPath -Path $thisCommon.Lines[0]), (Get-HbNormalizedPath -Path $targetCommon.Lines[0]), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The target is a worktree of this Portly repository itself. Publish into a separate, public repository that holds only the built site.'
    }
    foreach ($marker in @('server\src\index.ts', 'web\vite.config.ts', 'shared\package.json')) {
        if (Test-Path -LiteralPath (Join-Path $targetRoot $marker) -PathType Leaf) {
            throw "The target looks like a Portly checkout ($marker exists). Publish into a separate, public repository that holds only the built site."
        }
    }

    # The working tree is about to be emptied: refuse to lose anything.
    $status = Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('status', '--porcelain', '--untracked-files=all')
    $dirty = @($status.Lines | Where-Object { $_.Trim() })
    if ($dirty.Count -gt 0) {
        throw "The public repository has uncommitted changes or untracked files; commit, stash or remove them first:`n  $($dirty -join "`n  ")"
    }
    $branch = (Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD') -AllowFailure)
    $branchName = ''
    if ($branch.ExitCode -eq 0 -and $branch.Lines.Count -gt 0) { $branchName = $branch.Lines[0].Trim() }
    if ($branchName -eq '' -or $branchName -eq 'HEAD') {
        $unborn = Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('symbolic-ref', '--short', '-q', 'HEAD') -AllowFailure
        if ($unborn.ExitCode -eq 0 -and $unborn.Lines.Count -gt 0 -and $unborn.Lines[0].Trim()) {
            # A freshly initialized repository: the branch exists in name only (no commits yet).
            $branchName = $unborn.Lines[0].Trim()
        } else {
            throw 'The public repository has no branch checked out (detached HEAD). Check out the branch GitHub Pages deploys from.'
        }
    }
    $upstream = Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') -AllowFailure
    $upstreamName = $null
    if ($upstream.ExitCode -eq 0 -and $upstream.Lines.Count -gt 0 -and $upstream.Lines[0].Trim()) { $upstreamName = $upstream.Lines[0].Trim() }
    $remotes = @((Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('remote')).Lines | Where-Object { $_.Trim() })
    $remoteUrl = $null
    if ($remotes -contains 'origin') {
        $originUrl = Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('remote', 'get-url', 'origin') -AllowFailure
        if ($originUrl.ExitCode -eq 0 -and $originUrl.Lines.Count -gt 0) { $remoteUrl = $originUrl.Lines[0].Trim() }
    }
    $pushCommand = $null
    if ($null -ne $upstreamName) {
        $pushCommand = @('push')
    } elseif ($remotes -contains 'origin') {
        $pushCommand = @('push', '-u', 'origin', $branchName)
    }
    if ($null -eq $pushCommand -and -not $NoPush) {
        throw 'The public repository has no upstream branch and no remote named origin, so there is nothing to push to. Add the remote (git remote add origin <url>) or use -NoPush.'
    }

    # The clone against its upstream (fetched). Only behind (another PC or the workflow published
    # meanwhile): a real run fast-forwards it before anything else, so the plan describes the
    # upstream's files. Diverged: refused with the commands to resolve it - never merged here. A
    # fetch that fails stops a real run; a dry run reports it and plans with this clone's files.
    $sync = Get-HbPublishSyncState -Git $gitExe -Directory $targetRoot -Upstream $upstreamName -AllowFetchFailure:$DryRun
    if ($sync.Ahead -gt 0 -and $sync.Behind -gt 0) {
        throw ("The public repository $targetRoot has diverged from $upstreamName (fetched): $($sync.Ahead) local commit(s) are not on $upstreamName, " +
            "and $($sync.Behind) commit(s) of $upstreamName are not here. This script never merges on its own. Merge first, keeping this clone's " +
            "version of any file both sides changed (the publish replaces Portly's files anyway; look at CNAME and README.md afterwards), " +
            "then run the publish again:`n" +
            "  git -C `"$targetRoot`" merge -X ours --no-edit $upstreamName`n" +
            "If the local commits are only earlier publishes you do not need, discard them instead:`n" +
            "  git -C `"$targetRoot`" reset --hard $upstreamName")
    }
    $syncText = 'none'
    if ($null -ne $sync.Upstream) {
        if ($null -ne $sync.FetchError) {
            $syncText = "$upstreamName, not fetched: $($sync.FetchError)"
        } elseif ($sync.Behind -gt 0) {
            $syncText = "$upstreamName, fetched: this clone is $($sync.Behind) commit(s) behind it and has no local commits, so it is fast-forwarded first (the files below are those of $upstreamName)"
        } elseif ($sync.Ahead -gt 0) {
            $syncText = "$upstreamName, fetched: $($sync.Ahead) local commit(s) not on it yet go out with the next push"
        } else {
            $syncText = "$upstreamName, fetched: level with this clone"
        }
    }

    if ($sync.Behind -gt 0) {
        $tracked = @((Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('ls-tree', '-r', '--name-only', $upstreamName)).Lines | Where-Object { $_.Trim() })
    } else {
        $tracked = @((Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('ls-files')).Lines | Where-Object { $_.Trim() })
    }
    $toRemove = @($tracked | Where-Object { $HbPublishKeep -notcontains $_ })
    $kept = @($tracked | Where-Object { $HbPublishKeep -contains $_ })

    # Publishing deletes every tracked file but CNAME and README.md. Allow that only for an empty
    # repository or an earlier Portly publish - never for another site's pages (a privacy page,
    # a verification file, a user site) unless -ReplaceEverything says so.
    if ($toRemove.Count -gt 0 -and -not $ReplaceEverything) {
        $publishedNames = Get-HbPublishedNames -RepoRoot $repoRoot
        $foreign = @($tracked | Where-Object { $publishedNames -cnotcontains ($_ -split '/', 2)[0] })
        $reason = $null
        if ($foreign.Count -gt 0) {
            $shown = @($foreign | Select-Object -First 5) -join ', '
            if ($foreign.Count -gt 5) { $shown += ", ... ($($foreign.Count) in all)" }
            $reason = "it holds files that are not part of a Portly build: $shown"
        } else {
            $indexPath = Join-Path $targetRoot 'index.html'
            $indexText = ''
            if ($tracked -ccontains 'index.html') {
                if ($sync.Behind -gt 0) {
                    # The upstream's index.html: the working tree still has this clone's.
                    $indexText = (Invoke-HbGit -Git $gitExe -Directory $targetRoot -Arguments @('show', "$upstreamName`:index.html")).Lines -join "`n"
                } elseif (Test-Path -LiteralPath $indexPath -PathType Leaf) {
                    $indexText = [System.IO.File]::ReadAllText($indexPath)
                }
            }
            if ($indexText -notmatch $HbBuildMarker) {
                $reason = 'its index.html is missing or is not a Portly build (no <meta name="portly-build" content="static">)'
            }
        }
        if ($null -ne $reason) {
            throw ("The public repository $targetRoot is neither empty nor an earlier Portly publish - $reason. " +
                "Publishing deletes every tracked file except $($HbPublishKeep -join ' and '), so all of that would vanish from the site. " +
                'Create a new, empty public repository for Portly and pass its clone, or re-run with -ReplaceEverything to replace this content anyway ' +
                '(it stays in the repository history: git revert the publish commit and push to get it back).')
        }
    }

    # GitHub Pages serves <user>/<user>.github.io at '/' and any other repository at '/<repo>/'
    # (a custom domain, i.e. a CNAME file, at '/'): any other -Base builds a page that stays blank.
    $gitHub = Get-HbGitHubRepo -RemoteUrl $remoteUrl
    if ($null -ne $gitHub -and $tracked -cnotcontains 'CNAME') {
        $expectedBase = "/$($gitHub.Repo)/"
        if ([string]::Equals($gitHub.Repo, "$($gitHub.User).github.io", [System.StringComparison]::OrdinalIgnoreCase)) { $expectedBase = '/' }
        if (-not [string]::Equals($Base, $expectedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw ("origin is github.com/$($gitHub.User)/$($gitHub.Repo), which GitHub Pages serves at https://$($gitHub.User.ToLowerInvariant()).github.io$expectedBase, " +
                "so -Base must be $expectedBase (got $Base); with another base the site stays blank. " +
                'For a custom domain, set it up first (its CNAME file must be in the public repository); -Base is then /.')
        }
    }

    $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    $version = "$(Get-HbProperty $packageJson 'version')"
    $commitMessage = $Message
    if ([string]::IsNullOrWhiteSpace($commitMessage)) {
        $commitMessage = "Publish Portly $version ($(Get-Date -Format 'yyyy-MM-dd'))"
    }

    return [pscustomobject]@{
        RepoRoot      = $repoRoot
        Git           = $gitExe
        DistStatic    = Join-Path $repoRoot 'web\dist-static'
        TargetRoot    = $targetRoot
        Branch        = $branchName
        Upstream      = $upstreamName
        Sync          = $sync
        SyncText      = $syncText
        RemoteUrl     = $remoteUrl
        PushCommand   = $pushCommand
        Tracked       = $tracked
        ToRemove      = $toRemove
        Kept          = $kept
        CommitMessage = $commitMessage
        Version       = $version
        PagesUrl      = Get-HbPagesUrl -RemoteUrl $remoteUrl -BasePath $Base
    }
}

function Get-HbBuildFiles {
    param([Parameter(Mandatory)][string]$DistStatic)
    # (`return , @()`: a bare `return @()` would hand the caller $null, which has no Count under strict mode.)
    if (-not (Test-Path -LiteralPath $DistStatic -PathType Container)) { return , @() }
    $files = @(Get-ChildItem -LiteralPath $DistStatic -Recurse -File -Force | Sort-Object FullName |
            ForEach-Object { $_.FullName.Substring($DistStatic.Length).TrimStart('\') })
    return , $files
}

try {
    $plan = Get-PublishPlan | Select-Object -Last 1
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}

$buildFiles = Get-HbBuildFiles -DistStatic $plan.DistStatic
if ($DryRun) {
    Write-HbStep 'Publish plan (dry run - nothing is built or changed)'
    Write-HbField -Name 'Portly' -Value $plan.RepoRoot
    Write-HbField -Name 'Build' -Value "npm run build:static  (PORTLY_STATIC_BASE=$Base)"
    $outputState = 'not built yet; the build creates it'
    if ($buildFiles.Count -gt 0) { $outputState = "$($buildFiles.Count) file(s) from an earlier build; the build replaces them" }
    Write-HbField -Name 'Output' -Value "$($plan.DistStatic)  ($outputState)"
    $remoteText = 'no remote'
    if ($plan.RemoteUrl) { $remoteText = "origin $($plan.RemoteUrl)" }
    Write-HbField -Name 'Target' -Value "$($plan.TargetRoot)  (branch $($plan.Branch), $remoteText)"
    Write-HbField -Name 'Upstream' -Value $plan.SyncText
    if ($null -ne $plan.Sync.FetchError) {
        Write-Warning ("$($plan.Upstream) could not be fetched, so this plan lists this clone's own files and cannot tell whether " +
            "the clone is behind $($plan.Upstream) or has diverged from it; a real run stops at the fetch. Check the connection and the remote.")
    }
    Write-HbRemovalList -Plan $plan
    Write-HbField -Name 'Copy' -Value "web\dist-static\* + $HbNoJekyll + $HbGitAttributes"
    foreach ($file in $buildFiles) { Write-HbInfo "+ $file" }
    Write-HbInfo "+ $HbGitAttributes  ($(@($HbGitAttributesLines | Select-Object -Skip 1) -join ', '); lines of its own that the clone has are kept)"
    Write-HbField -Name 'Commit' -Value "`"$($plan.CommitMessage)`"  (skipped when nothing changed)"
    if ($NoPush) {
        Write-HbField -Name 'Push' -Value 'skipped (-NoPush)'
    } else {
        Write-HbField -Name 'Push' -Value "git $($plan.PushCommand -join ' ')"
    }
    if ($plan.PagesUrl) { Write-HbField -Name 'Site' -Value $plan.PagesUrl }
    Write-HbOk 'Dry run complete: nothing was built, copied, committed or pushed.'
    exit 0
}

try {
    if ($null -ne $plan.Sync.Upstream) {
        if ($plan.Sync.Behind -gt 0) {
            Write-HbStep "Fast-forwarding $($plan.TargetRoot) to $($plan.Upstream): $($plan.Sync.Behind) commit(s) behind it, no local commits"
            $head = Invoke-HbPublishFastForward -Git $plan.Git -Directory $plan.TargetRoot -Upstream $plan.Upstream
            Write-HbOk "Fast-forwarded to $head"
        } elseif ($plan.Sync.Ahead -gt 0) {
            Write-HbInfo "Fetched $($plan.Upstream): $($plan.Sync.Ahead) local commit(s) not on it yet go out with the next push"
        } else {
            Write-HbInfo "Fetched $($plan.Upstream): level with this clone"
        }
    }

    Write-HbStep "Building the browser-only site: npm run build:static (PORTLY_STATIC_BASE=$Base)"
    Invoke-HbStaticBuild -RepoRoot $plan.RepoRoot -BasePath $Base
    $indexHtml = Join-Path $plan.DistStatic 'index.html'
    if (-not (Test-Path -LiteralPath $indexHtml -PathType Leaf)) {
        throw 'npm run build:static finished but web\dist-static\index.html is missing.'
    }
    $indexText = [System.IO.File]::ReadAllText($indexHtml)
    if (-not $indexText.Contains("$($Base)assets/")) {
        throw "web\dist-static\index.html does not reference $($Base)assets/ - the build did not pick up PORTLY_STATIC_BASE=$Base."
    }
    $buildFiles = Get-HbBuildFiles -DistStatic $plan.DistStatic
    Write-HbOk "web\dist-static built ($($buildFiles.Count) files)"

    Write-HbStep "Replacing the contents of $($plan.TargetRoot) (branch $($plan.Branch))"
    Write-HbRemovalList -Plan $plan
    $null = Update-HbPublishTree -Git $plan.Git -TargetRoot $plan.TargetRoot -DistStatic $plan.DistStatic -ToRemove $plan.ToRemove
    Write-HbInfo "removed $($plan.ToRemove.Count) tracked file(s), copied $($buildFiles.Count) file(s) + $HbNoJekyll + $HbGitAttributes"

    # Exit code 0: the index matches HEAD (nothing to commit); 1: something is staged.
    $staged = Invoke-HbGit -Git $plan.Git -Directory $plan.TargetRoot -Arguments @('diff', '--cached', '--quiet') -AllowFailure
    if ($staged.ExitCode -gt 1) { throw "git diff --cached failed (exit code $($staged.ExitCode)): $($staged.Lines -join ' ')" }
    if ($staged.ExitCode -eq 0) {
        Write-HbOk 'Nothing changed since the last publish; no commit made.'
    } else {
        Write-HbStep 'Committing'
        $null = Invoke-HbGit -Git $plan.Git -Directory $plan.TargetRoot -Arguments @('commit', '-q', '-m', $plan.CommitMessage)
        $head = (Invoke-HbGit -Git $plan.Git -Directory $plan.TargetRoot -Arguments @('rev-parse', '--short', 'HEAD')).Lines[0]
        Write-HbOk "Committed $head`: $($plan.CommitMessage)"
    }

    if ($NoPush) {
        Write-HbInfo 'Not pushed (-NoPush). Push it yourself when ready: git push'
    } else {
        Write-HbStep "Pushing: git $($plan.PushCommand -join ' ')"
        $null = Invoke-HbGit -Git $plan.Git -Directory $plan.TargetRoot -Arguments $plan.PushCommand -ShowOutput
        if ($plan.PagesUrl) {
            Write-HbOk "Published: $($plan.PagesUrl)"
        } else {
            Write-HbOk 'Published.'
        }
        Write-HbInfo 'GitHub Pages picks the push up within a minute or two, but can serve the previous page for up to'
        Write-HbInfo '10 minutes (Cache-Control: max-age=600): hard-refresh (Ctrl+F5) before judging the result.'
    }
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
exit 0
