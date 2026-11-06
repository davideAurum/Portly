<#
.SYNOPSIS
    Checks a release package end to end in a temporary folder: install, start, update, refusals.
    Never touches the real scheduled task, native host, PATH, data folder or install folder.

.DESCRIPTION
    1. Without -ZipPath, builds a test package first (build-release.ps1 -AllowDirty, with the
       node.exe on PATH unless -DownloadRuntime).
    2. scripts\install.ps1 -ZipPath into a temporary install folder (-SkipAutostart -SkipCli
       -NoBrowser, PORTLY_DATA_DIR pointing at a temporary data folder): the package lands in
       app\, app.new is gone, node_modules\@portly\shared is a junction to app\shared.
    3. Starts the installed server with its own runtime\node.exe on a free port and the temporary
       data folder, and checks /api/health (Portly, the package's version) and that the page is
       served.
    4. install.ps1 again: "already installed", nothing changes.
    5. install.ps1 -Force (the update path): the database is copied to backups\, the old version is
       kept in app.previous, app\ is complete and linked again. A package with another extension
       version ends the output with the Reload notice. With a file in app\ in use the update fails
       and app\ stays whole and linked.
    6. A wrong -Sha256 and a missing package are refused and change nothing.
    7. install.ps1 -DryRun changes nothing.
    8. Unattended updates (-OnlyNewer -StatusFile): a newer package, one that is not newer, a file
       in use, one install at a time, and a version that does not start (put back, and not even
       the old one starts), each leaving a status file the package's own schema accepts and that
       holds no path. The cases that would start Portly run install.ps1's functions here with
       stand-ins for the task, so the real task is never touched.
    Before all of this, install.ps1's Restore-InstDatabase is run on a temporary data folder: after
    a failed update the database copied before it is put back, and the one the failed version left
    is kept in backups\.

.PARAMETER ZipPath
    The package to check (default: build one).

.PARAMETER DownloadRuntime
    When building, use the pinned Node.js runtime (downloaded) instead of the node.exe on PATH.

.PARAMETER KeepTemp
    Keep the temporary folders (their path is printed).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-release.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ZipPath,
    [switch]$DownloadRuntime,
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

$script:passed = 0
$script:failures = New-Object System.Collections.Generic.List[string]

function Assert-That {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        $script:passed++
        Write-Host "  ok    $Name" -ForegroundColor Green
    } else {
        $script:failures.Add($Name)
        Write-Host "  FAIL  $Name" -ForegroundColor Red
        if ($Detail) { Write-Host "        $Detail" -ForegroundColor DarkYellow }
    }
}

function Get-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

# Runs a script in a child Windows PowerShell with PORTLY_DATA_DIR set to the temporary data
# folder; returns ExitCode and Text.
function Invoke-CheckScript {
    param([Parameter(Mandatory)][string]$Path, [string[]]$Arguments = @())
    $previousData = $env:PORTLY_DATA_DIR
    $previousPreference = $ErrorActionPreference
    $env:PORTLY_DATA_DIR = $dataDir
    $ErrorActionPreference = 'Continue'
    try {
        $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path @Arguments 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
    } finally {
        $env:PORTLY_DATA_DIR = $previousData
        $ErrorActionPreference = $previousPreference
    }
}

# A copy of the package with its release.json changed by $Change, in a folder of its own, so no
# portly-release.json describes it.
function New-CheckPackage {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)][scriptblock]$Change)
    $null = New-Item -ItemType Directory -Path $Folder -Force
    $copy = Join-Path $Folder (Split-Path -Leaf $Source)
    Copy-Item -LiteralPath $Source -Destination $copy
    $archive = [System.IO.Compression.ZipFile]::Open($copy, 'Update')
    try {
        $entry = $archive.GetEntry('release.json')
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $info = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        & $Change $info
        $entry.Delete()
        $writer = New-Object System.IO.StreamWriter(($archive.CreateEntry('release.json')).Open(), (New-Object System.Text.UTF8Encoding($false)))
        try { $writer.Write(($info | ConvertTo-Json -Depth 5)) } finally { $writer.Dispose() }
    } finally {
        $archive.Dispose()
    }
    return $copy
}

function Test-Junction {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Target)
    $attributes = Get-HbEntryAttributes -Path $Path
    if ($null -eq $attributes -or -not ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $false }
    $current = @(Get-HbProperty (Get-Item -LiteralPath $Path -Force) 'Target') | Select-Object -First 1
    return $current -and [System.IO.Path]::GetFullPath("$current").TrimEnd('\') -ieq $Target.TrimEnd('\')
}

$repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ('portly-release-check-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $workDir 'install'
$dataDir = Join-Path $workDir 'data'
$null = New-Item -ItemType Directory -Path $installDir, $dataDir -Force
$installScript = Join-Path $PSScriptRoot 'install.ps1'
$server = $null
$builtOut = $null
$exitCode = 1

try {
    Write-Host ''
    Write-Host 'Database after a failed update (install.ps1 functions, temporary folder)' -ForegroundColor White
    # install.ps1 runs as soon as it is loaded, so only its functions are loaded here.
    $installTokens = $null
    $installErrors = $null
    $installAst = [System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$installTokens, [ref]$installErrors)
    foreach ($definition in $installAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $InstKeepBackups = 3
    $rollbackData = Join-Path $workDir 'rollback-data'
    $rollbackBackups = Join-Path $rollbackData 'backups'
    $null = New-Item -ItemType Directory -Path $rollbackBackups -Force
    $beforeCopy = Join-Path $rollbackBackups 'portly-before-1.0.0-20260101-000000.db'
    Set-Content -LiteralPath $beforeCopy -Value 'old db' -NoNewline
    Set-Content -LiteralPath "$beforeCopy-wal" -Value 'old wal' -NoNewline
    $liveDb = Join-Path $rollbackData 'portly.db'
    Set-Content -LiteralPath $liveDb -Value 'new db' -NoNewline
    Set-Content -LiteralPath "$liveDb-wal" -Value 'new wal' -NoNewline
    Set-Content -LiteralPath "$liveDb-shm" -Value 'new shm' -NoNewline
    $kept = Restore-InstDatabase -Backup $beforeCopy -Label '2.0.0'
    Assert-That -Name 'Restore-InstDatabase puts the copy made before the update back as portly.db (with its -wal, without the new -shm)' -Condition (
        (Get-Content -LiteralPath $liveDb -Raw) -eq 'old db' -and (Get-Content -LiteralPath "$liveDb-wal" -Raw) -eq 'old wal' -and
        -not (Test-Path -LiteralPath "$liveDb-shm") -and (Test-Path -LiteralPath $beforeCopy -PathType Leaf))
    Assert-That -Name 'Restore-InstDatabase keeps the failed version''s database as backups\portly-failed-<version>-<time>.db' -Condition (
        $null -ne $kept -and (Split-Path -Leaf $kept) -like 'portly-failed-2.0.0-*.db' -and
        (Get-Content -LiteralPath $kept -Raw) -eq 'new db' -and (Get-Content -LiteralPath "$kept-wal" -Raw) -eq 'new wal' -and
        (Get-Content -LiteralPath "$kept-shm" -Raw) -eq 'new shm') -Detail "$kept"

    if ([string]::IsNullOrWhiteSpace($ZipPath)) {
        Write-Host ''
        Write-Host 'Building a test package (build-release.ps1 -AllowDirty)' -ForegroundColor White
        $builtOut = Join-Path $workDir 'out'
        $buildArgs = @('-OutDir', $builtOut, '-AllowDirty')
        if (-not $DownloadRuntime) { $buildArgs += @('-NodeExe', (Resolve-HbNode).Path) }
        if (Test-HbWebBuilt -RepoRoot $repoRoot) { $buildArgs += '-SkipBuild' }
        $build = Invoke-CheckScript -Path (Join-Path $PSScriptRoot 'build-release.ps1') -Arguments $buildArgs
        Assert-That -Name 'build-release.ps1 builds a package' -Condition ($build.ExitCode -eq 0) -Detail $build.Text
        if ($build.ExitCode -ne 0) { throw 'No package to check.' }
        $ZipPath = @(Get-ChildItem -LiteralPath (Join-Path $workDir 'out') -Filter 'portly-*-win-x64.zip' -File)[0].FullName
    }
    $zip = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
    Write-Host "Package: $zip" -ForegroundColor White
    Write-Host "Work folder: $workDir" -ForegroundColor White

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try { $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }) } finally { $archive.Dispose() }
    Assert-That -Name 'the package holds release.json, the licenses, the runtime, server, web build, extension and scripts' -Condition (
        ($entries -contains 'release.json') -and ($entries -contains 'LICENSE') -and ($entries -contains 'THIRD_PARTY_NOTICES.md') -and
        ($entries -contains 'runtime/node.exe') -and ($entries -contains 'server/src/index.ts') -and
        ($entries -contains 'web/dist/index.html') -and ($entries -contains 'extension/manifest.json') -and ($entries -contains 'scripts/install.ps1') -and
        ($entries -contains 'node_modules/hono/package.json'))
    # Our own sources only: third-party packages may ship their tests, as npm installs them.
    $leaks = @($entries | Where-Object {
            $_ -match '^(server|shared)/.*\.test\.tsx?$' -or $_ -match '^(server|shared)/.*/__fixtures__/' -or
            $_ -like 'server/src/testing/*' -or $_ -like 'extension/test/*' -or $_ -like 'extension/tools/*' -or
            $_ -like 'web/src/*' -or $_ -like 'node_modules/@portly/*' -or $_ -like 'node_modules/vite/*' -or $_ -like 'node_modules/react/*' -or
            $_ -like 'scripts/check-*' -or $_ -like 'scripts/setup.ps1' -or $_ -like 'docs/reviews/*'
        })
    Assert-That -Name 'the package leaves out tests, fixtures, sources of the web build, dev packages and dev scripts' -Condition (
        $leaks.Count -eq 0) -Detail ($leaks | Select-Object -First 10 | Out-String)

    Write-Host ''
    Write-Host 'Install' -ForegroundColor White
    $app = Join-Path $installDir 'app'
    $common = @('-InstallDir', $installDir, '-SkipAutostart', '-SkipCli', '-NoBrowser')
    $install = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip) + $common)
    $info = Get-HbReleaseInfo -RepoRoot $app
    $version = "$(Get-HbProperty $info 'version')"
    Assert-That -Name 'install.ps1 -ZipPath installs the package into app\' -Condition (
        $install.ExitCode -eq 0 -and $null -ne $info -and -not (Test-Path -LiteralPath (Join-Path $installDir 'app.new')) -and
        $install.Text.Contains("Portly $version is in $app")) -Detail $install.Text
    Assert-That -Name 'node_modules\@portly\shared is a junction to app\shared' -Condition (
        Test-Junction -Path (Join-Path $app 'node_modules\@portly\shared') -Target (Join-Path $app 'shared'))
    Assert-That -Name 'Resolve-HbNode prefers the package''s runtime\node.exe' -Condition (
        (Resolve-HbNode -RepoRoot $app).Path -ieq (Join-Path $app 'runtime\node.exe'))
    Assert-That -Name 'Initialize-HbReleaseLinks keeps a correct link' -Condition (
        (Initialize-HbReleaseLinks -RepoRoot $app) -ieq (Join-Path $app 'node_modules\@portly\shared') -and
        (Test-Junction -Path (Join-Path $app 'node_modules\@portly\shared') -Target (Join-Path $app 'shared')))

    $cli = Join-Path $app 'scripts\portly.ps1'
    $cliVersion = Invoke-CheckScript -Path $cli -Arguments @('--version')
    Assert-That -Name 'the installed portly --version says it is a release install' -Condition (
        $cliVersion.ExitCode -eq 0 -and $cliVersion.Text.Contains("Portly $version (release install")) -Detail $cliVersion.Text
    $cliRebuild = Invoke-CheckScript -Path $cli -Arguments @('--rebuild')
    Assert-That -Name 'the installed portly --rebuild points to --update' -Condition (
        $cliRebuild.ExitCode -eq 1 -and $cliRebuild.Text.Contains('use portly --update')) -Detail $cliRebuild.Text
    $cliBadOption = Invoke-CheckScript -Path $cli -Arguments @('--update', '--version')
    Assert-That -Name 'the installed portly --update --version without a version is refused' -Condition (
        $cliBadOption.ExitCode -eq 2) -Detail $cliBadOption.Text
    # A dry run registers and writes nothing; it shows the task and launcher the install would get.
    $autostart = Invoke-CheckScript -Path (Join-Path $app 'scripts\install-autostart.ps1') -Arguments @('-DryRun')
    $bundledNode = Join-Path $app 'runtime\node.exe'
    $supervisorCopy = Join-Path (Get-HbRuntimeDir) $PortlySupervisorProgram
    Assert-That -Name 'the installed install-autostart.ps1 -DryRun runs app\server as a copy of runtime\node.exe (the launcher: runtime\node.exe itself)' -Condition (
        $autostart.ExitCode -eq 0 -and $autostart.Text.Contains("--headless ""$supervisorCopy"" ""$(Join-Path $app 'server\src\supervisor.ts')""") -and
        $autostart.Text.Contains("the task runs $bundledNode instead") -and
        $autostart.Text.Contains("""$bundledNode"" ""%~dp0launcher.mjs"" %*") -and
        $autostart.Text.Contains('valid (checked with server\src\config.ts)')) -Detail $autostart.Text
    Assert-That -Name 'the installed install-autostart.ps1 -DryRun shows the updater task with its fixed command' -Condition (
        $autostart.Text.Contains("$PortlyUpdaterTaskName") -and $autostart.Text.Contains("-File ""$(Join-Path $app 'scripts\portly.ps1')"" --update --unattended")) -Detail $autostart.Text
    if ($null -ne $builtOut) {
        $publish = Invoke-CheckScript -Path (Join-Path $PSScriptRoot 'publish-release.ps1') -Arguments @('-OutDir', $builtOut, '-DryRun')
        Assert-That -Name 'publish-release.ps1 refuses a test build (uncommitted changes or a local node.exe)' -Condition (
            $publish.ExitCode -eq 1 -and $publish.Text -match 'uncommitted changes|local node\.exe') -Detail $publish.Text
    }

    Write-Host ''
    Write-Host 'Start the installed server' -ForegroundColor White
    $port = Get-FreePort
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $app 'runtime\node.exe'
    $startInfo.Arguments = '"' + (Join-Path $app 'server\src\index.ts') + '"'
    $startInfo.WorkingDirectory = $app
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in $PortlyEnvNames) { $startInfo.EnvironmentVariables.Remove($name) }
    $startInfo.EnvironmentVariables['PORTLY_PORT'] = "$port"
    $startInfo.EnvironmentVariables['PORTLY_DATA_DIR'] = $dataDir
    $server = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $server.StandardOutput.ReadToEndAsync()
    $stderr = $server.StandardError.ReadToEndAsync()
    $health = Wait-HbHealth -Port $port -TimeoutSeconds 60
    $healthVersion = "$($health.Version)"
    Assert-That -Name "the installed server answers /api/health as Portly $version" -Condition (
        $health.Ok -and $healthVersion -eq $version) -Detail "$(Format-HbHealth $health)"
    $page = $null
    try { $page = Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 10 } catch { }
    Assert-That -Name 'the installed server serves the web app' -Condition ($null -ne $page -and $page.StatusCode -eq 200 -and "$($page.Content)" -match '<div id="root">')
    try { $server.Kill() } catch { }
    $null = $server.WaitForExit(10000)
    if (-not $health.Ok) { Write-Host ($stdout.Result + $stderr.Result) -ForegroundColor DarkYellow }
    Assert-That -Name 'the server created its database in the temporary data folder' -Condition (
        Test-Path -LiteralPath (Join-Path $dataDir 'portly.db') -PathType Leaf)

    Write-Host ''
    Write-Host 'Update' -ForegroundColor White
    $again = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip) + $common)
    Assert-That -Name 'install.ps1 again: already installed, nothing changes' -Condition (
        $again.ExitCode -eq 0 -and $again.Text.Contains("Portly $version is already installed") -and
        -not (Test-Path -LiteralPath (Join-Path $installDir 'app.previous'))) -Detail $again.Text

    $update = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force') + $common)
    $previous = Join-Path $installDir 'app.previous'
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'backups') -Filter 'portly-before-*.db' -File -ErrorAction SilentlyContinue)
    Assert-That -Name 'install.ps1 -Force updates: old version kept in app.previous, new one in app\' -Condition (
        $update.ExitCode -eq 0 -and $update.Text.Contains("Updated Portly $version -> $version") -and
        $null -ne (Get-HbReleaseInfo -RepoRoot $previous) -and $null -ne (Get-HbReleaseInfo -RepoRoot $app) -and
        -not (Test-Path -LiteralPath (Join-Path $installDir 'app.new'))) -Detail $update.Text
    Assert-That -Name 'the update copied the database to backups\ first' -Condition ($backups.Count -eq 1) -Detail ($backups | Out-String)
    Assert-That -Name 'after the update app\ is linked to its own shared folder, app.previous to nothing' -Condition (
        (Test-Junction -Path (Join-Path $app 'node_modules\@portly\shared') -Target (Join-Path $app 'shared')) -and
        $null -eq (Get-HbEntryAttributes -Path (Join-Path $previous 'node_modules\@portly\shared')))

    $second = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force') + $common)
    Assert-That -Name 'a second update replaces app.previous and leaves app\shared intact' -Condition (
        $second.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $app 'shared\package.json') -PathType Leaf) -and
        $null -ne (Get-HbReleaseInfo -RepoRoot $previous)) -Detail $second.Text

    # The same package with another extension version: the Reload notice must come last.
    $extensionZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'extension-changed') -Change {
        param($changedInfo)
        $changedInfo.extensionVersion = "$($changedInfo.extensionVersion)-check"
    }
    $changed = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $extensionZip, '-Force') + $common)
    # The console wraps a long warning, so the output is compared with its line breaks folded.
    $folded = ($changed.Text -replace '\s+', ' ').Trim()
    Assert-That -Name 'an update that changes the extension ends with the Reload notice' -Condition (
        $changed.ExitCode -eq 0 -and $changed.Text.Contains("Updated Portly $version -> $version") -and
        $folded -match 'new-tab extension changed \([^)]*-check\): click Reload on Portly New Tab in chrome://extensions \(or edge://extensions\)\.$') -Detail $changed.Text

    # A file in app\ is in use (in real use: a Portly server a browser tab started again). The
    # rename must fail as a whole: Move-Item in Windows PowerShell 5.1 moved part of the folder.
    $appFiles = @(Get-ChildItem -LiteralPath $app -Recurse -File -Force).Count
    $held = [System.IO.File]::Open((Join-Path $app 'release.json'), 'Open', 'Read', 'Read')
    try {
        $blocked = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force') + $common)
    } finally {
        $held.Dispose()
    }
    Assert-That -Name 'an update that cannot move app\ (a file in use) fails and leaves app\ whole and linked' -Condition (
        $blocked.ExitCode -eq 1 -and $blocked.Text.Contains("Could not move $app to $previous") -and
        $null -ne (Get-HbReleaseInfo -RepoRoot $app) -and -not (Test-Path -LiteralPath $previous) -and
        @(Get-ChildItem -LiteralPath $app -Recurse -File -Force).Count -eq $appFiles -and
        (Test-Junction -Path (Join-Path $app 'node_modules\@portly\shared') -Target (Join-Path $app 'shared'))) -Detail $blocked.Text

    Write-Host ''
    Write-Host 'Refusals' -ForegroundColor White
    $stamp = (Get-Item -LiteralPath (Join-Path $app 'release.json')).LastWriteTimeUtc
    $badHash = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force', '-Sha256', ('0' * 64)) + $common)
    Assert-That -Name 'a package whose SHA-256 differs is refused and nothing changes' -Condition (
        $badHash.ExitCode -eq 1 -and $badHash.Text.Contains("SHA-256 is") -and
        (Get-Item -LiteralPath (Join-Path $app 'release.json')).LastWriteTimeUtc -eq $stamp) -Detail $badHash.Text
    $missing = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', (Join-Path $workDir 'nope.zip')) + $common)
    Assert-That -Name 'a missing package is refused' -Condition ($missing.ExitCode -eq 1 -and $missing.Text.Contains('does not exist')) -Detail $missing.Text
    $badPages = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force', '-PagesUrl', 'http://me.github.io/') + $common)
    Assert-That -Name 'a bad -PagesUrl is refused before anything happens' -Condition (
        $badPages.ExitCode -eq 1 -and $badPages.Text.Contains('-PagesUrl must be') -and -not $badPages.Text.Contains('Unpacking')) -Detail $badPages.Text
    $other = Join-Path $workDir 'other'
    $null = New-Item -ItemType Directory -Path (Join-Path $other 'app') -Force
    $notOurs = Invoke-CheckScript -Path $installScript -Arguments @('-ZipPath', $zip, '-InstallDir', $other, '-SkipAutostart', '-SkipCli', '-NoBrowser')
    Assert-That -Name 'an app folder that is not a Portly release is left alone' -Condition (
        $notOurs.ExitCode -eq 1 -and $notOurs.Text.Contains('is not a Portly release install')) -Detail $notOurs.Text
    $dry = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force', '-DryRun') + $common)
    Assert-That -Name 'install.ps1 -DryRun changes nothing' -Condition (
        $dry.ExitCode -eq 0 -and $dry.Text.Contains('Dry run finished') -and
        (Get-Item -LiteralPath (Join-Path $app 'release.json')).LastWriteTimeUtc -eq $stamp) -Detail $dry.Text

    Write-Host ''
    Write-Host 'Unattended update (-OnlyNewer -StatusFile)' -ForegroundColor White
    $statusFile = Join-Path $dataDir 'update-status.json'
    $statusCheck = Join-Path $workDir 'check-status.mjs'
    [System.IO.File]::WriteAllLines($statusCheck, [string[]]@(
            "import { readFileSync } from 'node:fs';",
            'const { UpdateRunSchema } = await import(process.env.CHECK_SHARED);',
            "const text = readFileSync(process.env.CHECK_STATUS, 'utf8').replace(/^\uFEFF/, '');",
            'const parsed = UpdateRunSchema.safeParse(JSON.parse(text));',
            'if (!parsed.success) console.log(JSON.stringify(parsed.error.issues));',
            'process.exit(parsed.success ? 0 : 1);'))

    # What the server leaves before it starts the task.
    function Write-RequestedRun {
        param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)
        $requested = [ordered]@{
            id = $Id; state = 'requested'; from = $From; to = $To; startedAt = '2026-01-02T03:04:05.678Z'
            finishedAt = $null; code = $null; extensionChanged = $false
        }
        [System.IO.File]::WriteAllText($statusFile, ($requested | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    }

    function Read-Run { return [System.IO.File]::ReadAllText($statusFile) | ConvertFrom-Json }

    # The run in the status file, read by the installed package's own schema, holds no path.
    function Assert-Run {
        param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$State, [string]$Code, [string]$To, [string]$Id)
        $text = [System.IO.File]::ReadAllText($statusFile)
        $run = $text | ConvertFrom-Json
        $previousShared = $env:CHECK_SHARED
        $env:CHECK_SHARED = ([System.Uri](Join-Path $app 'shared\src\index.ts')).AbsoluteUri
        $env:CHECK_STATUS = $statusFile
        try {
            $schema = (& (Join-Path $app 'runtime\node.exe') --no-warnings $statusCheck 2>&1 | Out-String)
            $schemaOk = $LASTEXITCODE -eq 0
        } finally {
            $env:CHECK_SHARED = $previousShared
            $env:CHECK_STATUS = $null
        }
        Assert-That -Name $Name -Condition (
            $run.state -ceq $State -and "$($run.code)" -ceq $Code -and (-not $To -or $run.to -ceq $To) -and (-not $Id -or $run.id -ceq $Id) -and
            $null -ne $run.finishedAt -and $schemaOk -and $text -notmatch '[A-Za-z]:\\|\\\\|/Users/') -Detail "$text $schema"
    }

    $unattended = @('-OnlyNewer', '-StatusFile', $statusFile) + $common
    $installed = "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')"
    Write-RequestedRun -Id 'check-not-newer' -From $installed -To $installed
    $stamp = (Get-Item -LiteralPath (Join-Path $app 'release.json')).LastWriteTimeUtc
    $notNewer = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $zip, '-Force') + $unattended)
    Assert-That -Name 'the same version is refused, -Force or not, and nothing changes' -Condition (
        $notNewer.ExitCode -eq 1 -and $notNewer.Text.Contains('is not newer') -and
        (Get-Item -LiteralPath (Join-Path $app 'release.json')).LastWriteTimeUtc -eq $stamp) -Detail $notNewer.Text
    Assert-Run -Name 'the status file says failed / not_newer, on the run the server asked for' -State 'failed' -Code 'not_newer' -Id 'check-not-newer'

    Write-RequestedRun -Id 'check-done' -From $installed -To '99.0.0'
    $newerZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'newer') -Change { param($info) $info.version = '99.0.0' }
    $newer = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $newerZip) + $unattended)
    Assert-That -Name 'a newer package installs' -Condition (
        $newer.ExitCode -eq 0 -and "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')" -eq '99.0.0') -Detail $newer.Text
    Assert-Run -Name 'the status file says done, on the run the server asked for' -State 'done' -To '99.0.0' -Id 'check-done'
    Assert-That -Name 'the run keeps the server''s start time and first version' -Condition (
        ([System.IO.File]::ReadAllText($statusFile)).Contains('"startedAt":"2026-01-02T03:04:05.678Z"') -and (Read-Run).from -ceq $installed)

    $olderZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'older') -Change { param($info) $info.version = '98.0.0' }
    $older = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $olderZip) + $unattended)
    Assert-That -Name 'an older package is refused once it is unpacked, and leaves no app.new' -Condition (
        $older.ExitCode -eq 1 -and $older.Text.Contains('is not newer') -and -not (Test-Path -LiteralPath (Join-Path $installDir 'app.new')) -and
        "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')" -eq '99.0.0') -Detail $older.Text
    Assert-Run -Name 'with nothing requested a run of its own is reported: failed / not_newer' -State 'failed' -Code 'not_newer'
    Assert-That -Name 'that run has a new id and starts from the installed version' -Condition (
        (Read-Run).id -cne 'check-done' -and (Read-Run).from -ceq '99.0.0')

    $inUseZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'in-use') -Change { param($info) $info.version = '99.0.1' }
    $held = [System.IO.File]::Open((Join-Path $app 'release.json'), 'Open', 'Read', 'Read')
    try {
        $inUse = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $inUseZip) + $unattended)
    } finally {
        $held.Dispose()
    }
    Assert-That -Name 'a file in use stops the update, and the installed version stays' -Condition (
        $inUse.ExitCode -eq 1 -and "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')" -eq '99.0.0') -Detail $inUse.Text
    Assert-Run -Name 'the status file says failed / file_in_use' -State 'failed' -Code 'file_in_use' -To '99.0.1'

    Write-RequestedRun -Id 'check-locked' -From '99.0.0' -To '99.0.2'
    $lockedZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'locked') -Change { param($info) $info.version = '99.0.2' }
    $otherInstall = New-Object System.Threading.Mutex($true, "Global\PortlyInstall-$([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)")
    try {
        $locked = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $lockedZip) + $unattended)
        $lockedDry = Invoke-CheckScript -Path $installScript -Arguments (@('-ZipPath', $lockedZip, '-DryRun') + $common)
    } finally {
        $otherInstall.ReleaseMutex()
        $otherInstall.Dispose()
    }
    Assert-That -Name 'a second install stops at once, while a dry run still works' -Condition (
        $locked.ExitCode -eq 1 -and $locked.Text.Contains('Another Portly install or update is running') -and -not $locked.Text.Contains('Unpacking') -and
        $lockedDry.ExitCode -eq 0) -Detail "$($locked.Text) $($lockedDry.Text)"
    Assert-Run -Name 'the status file says failed / unknown, on the run the server asked for' -State 'failed' -Code 'unknown' -Id 'check-locked'

    # install.ps1 again, here and with stand-ins for the task, so that "the new version does not
    # start" happens without Portly ever being started or the real task being touched.
    function Invoke-FakedUpdate {
        param([Parameter(Mandatory)][string]$Package, [Parameter(Mandatory)][int[]]$AutostartResults)
        $InstallDir = $installDir
        $ReleaseRepo = 'example/portly'
        $Version = ''
        $ZipPath = $Package
        $Sha256 = ''
        $PagesUrl = ''
        $Trigger = 'Browser'
        $Force = $false
        $SkipAutostart = $false
        $SkipCli = $true
        $NoBrowser = $true
        $DryRun = $false
        $OnlyNewer = $true
        $StatusFile = $statusFile
        $InstTriggerGiven = $false
        $InstManifestName = 'portly-release.json'
        $InstPlatform = 'win-x64'
        $InstTaskName = 'Portly Server'
        $InstMoveAttempts = 20
        $InstUnattendedTimeoutSeconds = 600
        $script:InstRun = $null
        $script:InstFailCode = 'unknown'
        $script:autostartResults = New-Object System.Collections.Generic.Queue[int]
        foreach ($result in $AutostartResults) { $script:autostartResults.Enqueue($result) }
        function Get-InstTask { param($AppDir) return [pscustomobject]@{ Exists = $true; Ours = $true; Mode = 'Browser'; Runs = '' } }
        function Set-InstTaskEnabled { param([bool]$Enabled) return $true }
        function Stop-ScheduledTask { }
        function Start-ScheduledTask { }
        function Invoke-InstAutostart { param($AppDir, $Mode) return $script:autostartResults.Dequeue() }
        $previousData = $env:PORTLY_DATA_DIR
        $env:PORTLY_DATA_DIR = $dataDir
        try {
            return Invoke-InstMain 6> $null | Select-Object -Last 1
        } finally {
            $env:PORTLY_DATA_DIR = $previousData
            $script:InstRun = $null
        }
    }

    Write-RequestedRun -Id 'check-rolled-back' -From '99.0.0' -To '99.1.0'
    $badZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'bad') -Change { param($info) $info.version = '99.1.0' }
    $rollback = Invoke-FakedUpdate -Package $badZip -AutostartResults @(1, 0)
    Assert-That -Name 'a version that does not start is put back, with the database copied before the update' -Condition (
        $rollback -eq 1 -and "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')" -eq '99.0.0' -and
        "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot (Join-Path $installDir 'app.failed')) 'version')" -eq '99.1.0' -and
        @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'backups') -Filter 'portly-failed-99.1.0-*.db' -File).Count -eq 1) -Detail "exit $rollback"
    Assert-Run -Name 'the status file says rolled-back / did_not_start' -State 'rolled-back' -Code 'did_not_start' -To '99.1.0' -Id 'check-rolled-back'

    Write-RequestedRun -Id 'check-neither' -From '99.0.0' -To '99.1.1'
    $worseZip = New-CheckPackage -Source $zip -Folder (Join-Path $workDir 'worse') -Change { param($info) $info.version = '99.1.1' }
    $neither = Invoke-FakedUpdate -Package $worseZip -AutostartResults @(1, 1)
    Assert-That -Name 'when the old version does not start either, its files are still put back' -Condition (
        $neither -eq 1 -and "$(Get-HbProperty (Get-HbReleaseInfo -RepoRoot $app) 'version')" -eq '99.0.0') -Detail "exit $neither"
    Assert-Run -Name 'the status file says failed / did_not_start, not rolled-back' -State 'failed' -Code 'did_not_start' -To '99.1.1' -Id 'check-neither'

    $exitCode = if ($script:failures.Count -eq 0) { 0 } else { 1 }
} catch {
    Write-HbFailure $_.Exception.Message
    $exitCode = 1
} finally {
    if ($null -ne $server -and -not $server.HasExited) { try { $server.Kill() } catch { } }
    if ($KeepTemp) {
        Write-Host "Kept $workDir"
    } else {
        foreach ($dir in @(Get-ChildItem -LiteralPath $workDir -Recurse -Directory -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })) {
            try { Remove-HbDirectoryLink -Path $dir.FullName } catch { }
        }
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
if ($script:failures.Count -gt 0) {
    Write-Host "$($script:failures.Count) check(s) failed, $script:passed passed." -ForegroundColor Red
} elseif ($exitCode -eq 0) {
    Write-Host "All $script:passed release checks passed." -ForegroundColor Green
}
exit $exitCode
