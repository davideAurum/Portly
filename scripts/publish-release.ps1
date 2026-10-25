<#
.SYNOPSIS
    Publishes a package built by scripts\build-release.ps1 as a GitHub release of the public
    Portly repository, where install.ps1 and portly --update find it (docs\setup\releases.md).

.DESCRIPTION
    1. Reads <OutDir>\portly-release.json and checks the package next to it: its SHA-256 and size
       match, and release.json inside it is not a test build (-NodeExe or uncommitted changes).
    2. Checks with the GitHub CLI (gh, signed in) that -ReleaseRepo exists and is public (testers
       download without signing in) and has no release v<version> yet.
    3. gh release create v<version> with the package and portly-release.json, tagging the commit
       the package was built from (it must be on GitHub), marked as the latest release
       (install.ps1 asks for releases/latest; a GitHub pre-release is never "latest", so alpha
       versions are published as normal releases).
       The release notes are the CHANGELOG.md section of the version, read from the commit the
       package was built from (not the working tree), with links to files of the repository made
       absolute. They are printed before anything is published, also in a dry run.

    Publishing is public: everyone who can see the repository can download the package.

.PARAMETER OutDir
    Where build-release.ps1 put the package (default dist-release in the repository).

.PARAMETER ReleaseRepo
    The public repository to publish in, as owner/name (default: the releaseRepo in the
    package's release.json).

.PARAMETER Notes
    Release notes in Markdown (default: the "## <version>" section of CHANGELOG.md at the
    package's commit, followed by a line naming the commit and Node.js version).

.PARAMETER DryRun
    Check everything and print the gh command, without publishing.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutDir,
    [string]$ReleaseRepo,
    [string]$Notes,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

# Runs gh and returns its output and exit code (never throws for a non-zero exit).
function Invoke-PublishGh {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $script:gh @Arguments 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
    } finally {
        $ErrorActionPreference = $previous
    }
}

# CHANGELOG.md as committed at $Commit, read as UTF-8 (git's output is not decoded by the console,
# whose code page would garble non-ASCII text in Windows PowerShell 5.1).
function Get-PublishChangelog {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Commit)
    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $git) { throw 'Git is not on PATH: it reads CHANGELOG.md at the commit the package was built from. Install Git, or pass -Notes.' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $git.Source
    $info.Arguments = "-C ""$RepoRoot"" cat-file blob $($Commit):CHANGELOG.md"
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $errors = $process.StandardError.ReadToEndAsync()
        $text = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "Cannot read CHANGELOG.md at commit $($Commit.Substring(0, 12)) in $RepoRoot ($($errors.Result.Trim())). Fetch that commit, or pass -Notes."
        }
        return $text
    } finally {
        $process.Dispose()
    }
}

# The section of $Changelog for $Version: the lines after its "## <version>" heading, up to the
# next "## " heading. Relative links point at files of the repository at $Commit, because release
# notes are read on github.com, where a relative link would lead to the releases page.
function Get-PublishChangelogNotes {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Changelog,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ReleaseRepo,
        [Parameter(Mandatory)][string]$Commit
    )
    $lines = @($Changelog -split "\r?\n")
    $heading = '^##\s+' + [regex]::Escape($Version) + '(\s|$)'
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $heading) { $start = $i; break } }
    if ($start -lt 0) { throw "CHANGELOG.md has no section for $Version (a ""## $Version"" heading). Add one (docs\setup\releases.md), or pass -Notes." }
    $body = New-Object System.Collections.Generic.List[string]
    for ($i = $start + 1; $i -lt $lines.Count -and $lines[$i] -notmatch '^##\s'; $i++) { $body.Add($lines[$i]) }
    $text = ($body -join "`n").Trim()
    if ($text.Length -eq 0) { throw "The CHANGELOG.md section for $Version is empty. Write it, or pass -Notes." }
    $base = "https://github.com/$ReleaseRepo/blob/$Commit/"
    $text = [regex]::Replace($text, '\]\((?![A-Za-z][A-Za-z0-9+.-]*:|#)(?:\./)?([^)\s]+)\)', '](' + $base + '$1)')
    return [pscustomobject]@{ Heading = $lines[$start].Trim(); Text = $text }
}

function Invoke-PublishRelease {
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $repoRoot 'dist-release' }
    $out = [System.IO.Path]::GetFullPath($OutDir)
    $manifestPath = Join-Path $out 'portly-release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "$manifestPath is missing: run scripts\build-release.ps1 first." }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $version = "$($manifest.version)"
    $packageName = "$($manifest.package)"
    $zip = Join-Path $out $packageName
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "$zip is missing." }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne "$($manifest.sha256)" -or
        (Get-Item -LiteralPath $zip).Length -ne [long]$manifest.size) {
        throw "$packageName does not match portly-release.json (rebuilt since?). Run scripts\build-release.ps1 again."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entry = $archive.GetEntry('release.json')
        if ($null -eq $entry) { throw "$packageName has no release.json." }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $inside = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally {
        $archive.Dispose()
    }
    if ("$($inside.version)" -ne $version) { throw "release.json in the package says $($inside.version), the manifest $version." }
    if ($inside.dirty -eq $true) { throw 'The package was built from uncommitted changes (-AllowDirty). Commit, then build again.' }
    if ("$($inside.nodeSource)" -ne 'nodejs.org') { throw 'The package carries a local node.exe (-NodeExe): build again without -NodeExe.' }
    if ([string]::IsNullOrWhiteSpace($ReleaseRepo)) { $ReleaseRepo = "$($inside.releaseRepo)" }
    if ($ReleaseRepo -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') { throw "-ReleaseRepo must be owner/name (got '$ReleaseRepo')." }
    if ("$($inside.releaseRepo)" -ne $ReleaseRepo) {
        Write-Warning "The package updates from $($inside.releaseRepo), but is published to $ReleaseRepo."
    }

    $commit = "$($inside.commit)"
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'release.json in the package names no full commit: build it again from a Git checkout.' }
    if ([string]::IsNullOrWhiteSpace($Notes)) {
        $section = Get-PublishChangelogNotes -Changelog (Get-PublishChangelog -RepoRoot $repoRoot -Commit $commit) -Version $version -ReleaseRepo $ReleaseRepo -Commit $commit
        if ($section.Heading -match 'not released yet') {
            Write-Warning "CHANGELOG.md at that commit still says $version is not released yet: give its entry the release date first (docs\setup\releases.md)."
        }
        $Notes = $section.Text + "`n`n" + "Package: Windows x64, commit $($commit.Substring(0, 12)), Node.js $($inside.node)."
    }
    Write-HbStep "Release notes of Portly $version"
    foreach ($line in ($Notes -split "\r?\n")) { Write-HbInfo $line }

    $command = Get-Command -Name 'gh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { throw 'The GitHub CLI (gh) is not installed: https://cli.github.com/ (winget install GitHub.cli), then gh auth login.' }
    $script:gh = $command.Source
    $repo = Invoke-PublishGh -Arguments @('api', "repos/$ReleaseRepo", '--jq', '.private')
    if ($repo.ExitCode -ne 0) {
        throw "Cannot see $ReleaseRepo with gh ($($repo.Text.Trim())). Create it as a public repository, and sign in with gh auth login."
    }
    if ($repo.Text.Trim() -ne 'false') { throw "$ReleaseRepo is private: testers could not download from it. Make it public, or use another repository." }
    $existing = Invoke-PublishGh -Arguments @('release', 'view', "v$version", '--repo', $ReleaseRepo, '--json', 'tagName')
    if ($existing.ExitCode -eq 0) { throw "$ReleaseRepo already has a release v$version. Bump the version in package.json first." }

    # The notes go to gh in a file: Windows PowerShell 5.1 does not quote a multi-line argument
    # with double quotes in it correctly for a native program.
    $notesFile = Join-Path ([System.IO.Path]::GetTempPath()) ("portly-release-notes-" + [guid]::NewGuid().ToString('N') + '.md')
    [System.IO.File]::WriteAllText($notesFile, $Notes, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $arguments = @('release', 'create', "v$version", $zip, $manifestPath, '--repo', $ReleaseRepo, '--target', $commit,
            '--title', "Portly $version", '--notes-file', $notesFile, '--latest')
        Write-HbStep "$(if ($DryRun) { '[dry run] ' } else { '' })Publishing Portly $version to https://github.com/$ReleaseRepo/releases"
        Write-HbInfo "gh $(($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')"
        if ($DryRun) { Write-HbOk 'Dry run finished; nothing was published.'; return 0 }
        $created = Invoke-PublishGh -Arguments $arguments
    } finally {
        Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
    }
    if ($created.ExitCode -ne 0) {
        throw "gh release create failed (is commit $($commit.Substring(0, 12)) pushed to $ReleaseRepo?): $($created.Text.Trim())"
    }
    Write-HbOk "Published: $($created.Text.Trim())"
    Write-HbInfo "Install: irm https://<your Pages site>/install.ps1 | iex   (or portly --update on installed PCs)"
    return 0
}

try {
    $code = Invoke-PublishRelease | Select-Object -Last 1
    exit ([int]$code)
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
