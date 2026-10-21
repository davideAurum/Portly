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
       kept in app.previous, app\ is complete and linked again.
    6. A wrong -Sha256 and a missing package are refused and change nothing.
    7. install.ps1 -DryRun changes nothing.
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
    Assert-That -Name 'the package holds release.json, the runtime, server, web build, extension and scripts' -Condition (
        ($entries -contains 'release.json') -and ($entries -contains 'runtime/node.exe') -and ($entries -contains 'server/src/index.ts') -and
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
