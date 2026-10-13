<#
.SYNOPSIS
    Builds the Portly release package for Windows x64: one zip that installs and runs without
    Git, npm or a separate Node.js (scripts\install.ps1, docs\setup\releases.md).

.DESCRIPTION
    1. Refuses uncommitted changes: a release is built from a commit (-AllowDirty for a test build,
       which release.json then marks as dirty).
    2. Builds the web app (npm run build -> web\dist) unless -SkipBuild.
    3. Installs the production dependencies of the server and shared workspaces only (npm ci
       --omit=dev) in a scratch copy of the manifests: no web or development packages.
    4. Gets the Node.js runtime pinned in scripts\release\node-runtime.json: downloaded from
       nodejs.org once into <OutDir>\cache and checked against its SHA-256 (or -NodeExe).
    5. Stages the package: package.json and README.md; server\ and shared\ without tests, fixtures
       and test helpers; web\dist; extension\ without tests and tools; native-host\; the scripts an
       installed copy uses (install, autostart, status, start, the portly command) with
       scripts\lib; docs\; node_modules\; runtime\node.exe with Node's LICENSE; and release.json.
    6. Zips it to <OutDir>\portly-<version>-win-x64.zip and writes <OutDir>\portly-release.json
       (version, package name, SHA-256, size): the two files scripts\publish-release.ps1 publishes.

.PARAMETER OutDir
    Where the package goes (default dist-release in the repository; the stage and the runtime
    cache are kept there too).

.PARAMETER NodeExe
    Put this node.exe in the package instead of the pinned runtime: a local test build without a
    download. Never publish such a package.

.PARAMETER ReleaseRepo
    The public GitHub repository installed copies update from, as owner/name (default
    davideAurum/Portly). Written into release.json.

.PARAMETER SkipBuild
    Use the existing web\dist instead of building it.

.PARAMETER AllowDirty
    Build even with uncommitted changes.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$OutDir,
    [string]$NodeExe,
    [string]$ReleaseRepo = 'davideAurum/Portly',
    [switch]$SkipBuild,
    [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

$ReleasePlatform = 'win-x64'
$ReleaseManifestName = 'portly-release.json'
# The scripts an installed copy runs (the rest of scripts\ is for developing Portly).
$ReleaseScripts = @('install.ps1', 'install-autostart.ps1', 'uninstall-autostart.ps1', 'install-cli.ps1', 'portly.ps1',
    'start.ps1', 'status.ps1', 'README.md', 'lib\Common.ps1')

function Invoke-ReleaseProgram {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [Parameter(Mandatory)][string]$WorkingDirectory)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "$([System.IO.Path]::GetFileName($FilePath)) $($Arguments -join ' ') failed (exit code $exitCode)." }
}

function Write-ReleaseJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 5
    [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# Copies the files under $Source whose path relative to it passes $Include, keeping the layout.
function Copy-ReleaseTree {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [scriptblock]$Include = { $true })
    $sourceFull = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
    $count = 0
    foreach ($file in @(Get-ChildItem -LiteralPath $sourceFull -Recurse -File -Force)) {
        $relative = $file.FullName.Substring($sourceFull.Length + 1)
        if (-not (& $Include $relative)) { continue }
        $target = Join-Path $Destination $relative
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
        Copy-Item -LiteralPath $file.FullName -Destination $target
        $count++
    }
    if ($count -eq 0) { throw "Nothing was copied from $Source." }
    return $count
}

function Remove-ReleaseFolder {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    # Never follow a junction out of the folder (npm links workspaces into node_modules).
    foreach ($dir in @(Get-ChildItem -LiteralPath $Path -Recurse -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })) {
        Remove-HbDirectoryLink -Path $dir.FullName
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

# node.exe and LICENSE of the pinned runtime, downloaded once into $CacheDir and checked.
function Get-ReleaseRuntime {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$CacheDir, [Parameter(Mandatory)][string]$Destination)
    $pin = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'scripts\release\node-runtime.json')) | ConvertFrom-Json
    $version = "$($pin.version)"
    $expected = "$($pin.sha256)".ToLowerInvariant()
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $expected -notmatch '^[0-9a-f]{64}$' -or "$($pin.platform)" -ne $ReleasePlatform) {
        throw 'scripts\release\node-runtime.json needs version, platform win-x64 and sha256.'
    }
    $name = "node-v$version-$ReleasePlatform"
    $zip = Join-Path $CacheDir "$name.zip"
    if (-not (Test-Path -LiteralPath $CacheDir)) { $null = New-Item -ItemType Directory -Path $CacheDir -Force }
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf) -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
        $url = "https://nodejs.org/dist/v$version/$name.zip"
        Write-HbStep "Downloading Node.js $version ($url)"
        $partial = "$zip.partial"
        try {
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        } catch { }
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try { Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing } finally { $ProgressPreference = $previousProgress }
        $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Remove-Item -LiteralPath $partial -Force
            throw "$name.zip has SHA-256 $actual, not $expected as pinned in scripts\release\node-runtime.json."
        }
        Move-Item -LiteralPath $partial -Destination $zip -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($file in @('node.exe', 'LICENSE')) {
            $entry = $archive.GetEntry("$name/$file")
            if ($null -eq $entry) { throw "$name.zip has no $name/$file." }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Destination $file), $true)
        }
    } finally {
        $archive.Dispose()
    }
    return $version
}

function Invoke-BuildRelease {
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $repoRoot 'dist-release' }
    $out = [System.IO.Path]::GetFullPath($OutDir)
    if ($ReleaseRepo -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') { throw "-ReleaseRepo must be owner/name (got '$ReleaseRepo')." }

    $package = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'package.json')) | ConvertFrom-Json
    $version = "$($package.version)"
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { throw "package.json version '$version' is not a release version." }
    $extensionVersion = "$(([System.IO.File]::ReadAllText((Join-Path $repoRoot 'extension\manifest.json')) | ConvertFrom-Json).version)"

    $commit = ''
    $dirty = $false
    $git = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $git) {
        $commit = "$(& $git.Source -C $repoRoot rev-parse HEAD 2>$null)".Trim()
        $dirty = "$(& $git.Source -C $repoRoot status --porcelain 2>$null)".Trim() -ne ''
    }
    if ($dirty -and -not $AllowDirty) {
        throw 'There are uncommitted changes. Commit them first (a release is built from a commit), or pass -AllowDirty for a test build.'
    }
    if ($dirty) { Write-Warning 'Building from uncommitted changes (-AllowDirty): release.json says so. Do not publish this package.' }

    $npm = (Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($null -eq $npm) { throw 'npm.cmd was not found on PATH (it is installed with Node.js).' }

    Write-HbStep "Building Portly $version for $ReleasePlatform into $out"
    if (-not $SkipBuild) {
        Write-HbStep 'Building the web app: npm run build'
        Invoke-ReleaseProgram -FilePath $npm.Source -Arguments @('run', 'build') -WorkingDirectory $repoRoot
    }
    if (-not (Test-HbWebBuilt -RepoRoot $repoRoot)) { throw 'web\dist\index.html is missing: run npm run build (or drop -SkipBuild).' }

    $stage = Join-Path $out 'stage'
    $deps = Join-Path $out 'deps'
    Remove-ReleaseFolder -Path $stage
    Remove-ReleaseFolder -Path $deps
    $null = New-Item -ItemType Directory -Path $stage -Force

    Write-HbStep 'Production dependencies of the server: npm ci --omit=dev'
    foreach ($manifest in @('package.json', 'package-lock.json', '.npmrc', 'shared\package.json', 'server\package.json', 'web\package.json')) {
        $target = Join-Path $deps $manifest
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
        Copy-Item -LiteralPath (Join-Path $repoRoot $manifest) -Destination $target
    }
    Invoke-ReleaseProgram -FilePath $npm.Source -WorkingDirectory $deps -Arguments @('ci', '--omit=dev', '--workspace=@portly/server',
        '--workspace=@portly/shared', '--include-workspace-root=false', '--no-audit', '--no-fund')
    # The workspace links point into the scratch folder; the installer creates the one it needs.
    $links = Join-Path $deps 'node_modules\@portly'
    if (Test-Path -LiteralPath $links) {
        foreach ($entry in @([System.IO.Directory]::GetFileSystemEntries($links))) { Remove-HbDirectoryLink -Path $entry }
        Remove-Item -LiteralPath $links -Recurse -Force
    }
    Move-Item -LiteralPath (Join-Path $deps 'node_modules') -Destination (Join-Path $stage 'node_modules')
    Remove-ReleaseFolder -Path $deps

    Write-HbStep 'Staging the package'
    foreach ($file in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $stage $file) }
    $sourceOnly = {
        param($relative)
        $relative -notmatch '\.test\.tsx?$' -and $relative -notmatch '(^|\\)__fixtures__\\' -and $relative -notmatch '^src\\testing\\'
    }
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'server') -Destination (Join-Path $stage 'server') -Include {
        param($relative) ($relative -eq 'package.json' -or $relative -like 'src\*') -and (& $sourceOnly $relative)
    }
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'shared') -Destination (Join-Path $stage 'shared') -Include {
        param($relative) ($relative -eq 'package.json' -or $relative -like 'src\*') -and (& $sourceOnly $relative)
    }
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'web\dist') -Destination (Join-Path $stage 'web\dist')
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'extension') -Destination (Join-Path $stage 'extension') -Include {
        param($relative) $relative -notlike 'test\*' -and $relative -notlike 'tools\*'
    }
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'native-host') -Destination (Join-Path $stage 'native-host')
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'scripts') -Destination (Join-Path $stage 'scripts') -Include {
        param($relative) $ReleaseScripts -contains $relative
    }
    $null = Copy-ReleaseTree -Source (Join-Path $repoRoot 'docs') -Destination (Join-Path $stage 'docs') -Include {
        param($relative) $relative -notlike 'reviews\*'
    }

    $runtime = Join-Path $stage 'runtime'
    $null = New-Item -ItemType Directory -Path $runtime -Force
    if ([string]::IsNullOrWhiteSpace($NodeExe)) {
        $nodeVersion = Get-ReleaseRuntime -RepoRoot $repoRoot -CacheDir (Join-Path $out 'cache') -Destination $runtime
        $nodeSource = 'nodejs.org'
    } else {
        $node = Resolve-HbNode -NodePath $NodeExe
        Write-Warning "Using $($node.Path) (Node.js $($node.Version)) instead of the pinned runtime: a test build, not for publishing."
        Copy-Item -LiteralPath $node.Path -Destination (Join-Path $runtime 'node.exe')
        $license = Join-Path (Split-Path -Parent $node.Path) 'LICENSE'
        if (Test-Path -LiteralPath $license -PathType Leaf) { Copy-Item -LiteralPath $license -Destination (Join-Path $runtime 'LICENSE') }
        $nodeVersion = $node.Version
        $nodeSource = 'local'
    }

    $builtAt = [System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Write-ReleaseJson -Path (Join-Path $stage 'release.json') -Value ([ordered]@{
            name             = 'portly'
            version          = $version
            platform         = $ReleasePlatform
            node             = $nodeVersion
            nodeSource       = $nodeSource
            extensionVersion = $extensionVersion
            commit           = $commit
            dirty            = $dirty
            builtAt          = $builtAt
            releaseRepo      = $ReleaseRepo
        })

    $packageName = "portly-$version-$ReleasePlatform.zip"
    $zip = Join-Path $out $packageName
    Write-HbStep "Zipping $packageName"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $zip).Length
    Write-ReleaseJson -Path (Join-Path $out $ReleaseManifestName) -Value ([ordered]@{
            name     = 'portly'
            version  = $version
            platform = $ReleasePlatform
            package  = $packageName
            sha256   = $sha256
            size     = $size
            node     = $nodeVersion
            commit   = $commit
            builtAt  = $builtAt
        })

    Write-HbOk ("{0} ({1:N1} MB)" -f $zip, ($size / 1MB))
    Write-HbField 'SHA-256' $sha256
    Write-HbField 'Manifest' (Join-Path $out $ReleaseManifestName)
    Write-HbField 'Node.js' "$nodeVersion ($nodeSource)"
    Write-HbField 'Commit' $(if ($commit) { "$($commit.Substring(0, [Math]::Min(12, $commit.Length)))$(if ($dirty) { ' + uncommitted changes' } else { '' })" } else { 'unknown (no git)' })
    Write-HbInfo 'Try it: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-release.ps1 -ZipPath <the zip>'
    return 0
}

try {
    $code = Invoke-BuildRelease | Select-Object -Last 1
    exit ([int]$code)
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
