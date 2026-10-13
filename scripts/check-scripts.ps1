<#
.SYNOPSIS
    Self-checks for the Portly PowerShell scripts and the native host. Registers, starts and
    stops nothing, and never writes the registry.

.DESCRIPTION
    1. Every .ps1 under scripts\ parses without errors, is ASCII-only and uses CRLF endings.
    2. Unit checks of scripts\lib\Common.ps1 (port parsing, access-denied detection, task-result
       text, process selection, the task definition objects for -Trigger Browser and Logon,
       extension IDs (the manifest key against Node's crypto, the extension's PINNED_EXTENSION_ID
       and every ID quoted in the docs), the native host files and their registration - written to a temporary
       folder with a fake registry - the health check against a loopback fixture server).
    3. Runs the generated launcher.cmd exactly as Chrome starts a native host
       (cmd.exe /d /s /c) and checks the answers, with schtasks.exe replaced by
       scripts\tests\schtasks-stub.mjs (so the real task is never run).
    4. Runs the native host's node tests (node scripts\check-native-host.mjs).
    5. Runs install-autostart.ps1 -DryRun (both modes), uninstall-autostart.ps1 -DryRun,
       status.ps1, a start.ps1 argument error, setup.ps1 -DryRun -PagesUrl, update.ps1 -DryRun, the portly command, install-cli.ps1 -DryRun and publish-static.ps1 -DryRun (against throwaway
       repositories in a temporary folder) in child processes of Windows PowerShell 5.1 and
       PowerShell 7 (when installed), and verifies that the scheduled task, the native host
       registry keys and the native host folder did not change.

.PARAMETER SkipChildRuns
    Skip step 5.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-scripts.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipChildRuns
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

function Assert-Throws {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Action, [string]$Pattern = '')
    $threw = $false
    $message = ''
    try { & $Action | Out-Null } catch { $threw = $true; $message = $_.Exception.Message }
    $matched = $threw -and (-not $Pattern -or $message -match $Pattern)
    Assert-That -Name $Name -Condition $matched -Detail $(if ($threw) { "message: $message" } else { 'did not throw' })
}

function Get-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

$repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("portly-check-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $workDir -Force

# ---------------------------------------------------------------------------------------------
Write-Host ''
Write-Host 'Syntax and encoding' -ForegroundColor White
$scriptFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -Recurse -File | Sort-Object FullName)
Assert-That -Name 'found the scripts' -Condition ($scriptFiles.Count -ge 6)
foreach ($file in $scriptFiles) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart('\')
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    $detail = (@($parseErrors) | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }) -join '; '
    Assert-That -Name "$relative parses" -Condition (@($parseErrors).Count -eq 0) -Detail $detail

    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
    Assert-That -Name "$relative is ASCII-only" -Condition ($nonAscii -eq 0) -Detail "$nonAscii non-ASCII bytes"
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    $bareLf = ([regex]::Matches($text, '(?<!\r)\n')).Count
    Assert-That -Name "$relative uses CRLF line endings" -Condition ($bareLf -eq 0 -and $text.EndsWith("`r`n")) -Detail "$bareLf bare LF"
}
$templatePath = Join-Path $repoRoot 'native-host\launcher.cmd'
$templateText = [System.IO.File]::ReadAllText($templatePath)
Assert-That -Name 'native-host\launcher.cmd template: @echo off first, one {{NODE_EXE}}, no "start" command' -Condition (
    $templateText.StartsWith('@echo off') -and
    $templateText.Split([string[]]@('{{NODE_EXE}}'), [System.StringSplitOptions]::None).Count -eq 2 -and
    $templateText -match '(?m)^"\{\{NODE_EXE\}\}" "%~dp0launcher\.mjs" %\*\r?$' -and
    $templateText -notmatch '(?im)^\s*start\b' -and
    @([System.IO.File]::ReadAllBytes($templatePath) | Where-Object { $_ -gt 127 }).Count -eq 0)

# GitHub Actions: every action pinned to a full commit SHA with its version as a comment
# (`uses: owner/repo@<40 hex> # vX.Y.Z`); a tag such as @v4 can be moved to other code.
$workflowDir = Join-Path $repoRoot '.github\workflows'
if (Test-Path -LiteralPath $workflowDir -PathType Container) {
    foreach ($workflow in @(Get-ChildItem -LiteralPath $workflowDir -File | Where-Object { $_.Extension -in @('.yml', '.yaml') })) {
        $usesLines = @([regex]::Matches([System.IO.File]::ReadAllText($workflow.FullName), '(?m)^\s*(?:-\s+)?uses:\s*(\S+)(.*)$'))
        $unpinned = @($usesLines | Where-Object {
                $_.Groups[1].Value -notmatch '^\./' -and
                -not ($_.Groups[1].Value -cmatch '^[^@\s]+@[0-9a-f]{40}$' -and $_.Groups[2].Value -match '#\s*v\d')
            } | ForEach-Object { $_.Groups[1].Value })
        Assert-That -Name ".github\workflows\$($workflow.Name) pins every action to a commit SHA (with a version comment)" -Condition (
            $usesLines.Count -gt 0 -and $unpinned.Count -eq 0) -Detail "not pinned: $($unpinned -join ', ')"
    }
}

# ---------------------------------------------------------------------------------------------
Write-Host ''
Write-Host 'Common.ps1 helpers' -ForegroundColor White

# Coming from Homebase: planned and carried out against fakes and temporary folders only (never
# the real user environment, task, registry or data folder).
$legacyEnv = @{ HOMEBASE_PAGES_URL = 'https://me.github.io/'; HOMEBASE_PORT = '5800'; PORTLY_PORT = '6000'; HOMEBASE_DATA_DIR = '  ' }
$legacyChrome = 'Software\Google\Chrome\NativeMessagingHosts\com.homebase.launcher'
$legacyPlan = Get-HbLegacyPlan -EnvReader { param($Name) $legacyEnv[$Name] } -RegistryReader { param($SubKey) if ($SubKey -eq $legacyChrome) { 'C:\x.json' } else { $null } } -TaskReader { $null }
Assert-That -Name 'Get-HbLegacyPlan copies only HOMEBASE_ variables whose PORTLY_ name is unset, and finds the old host keys' -Condition (
    @($legacyPlan.Copy).Count -eq 1 -and $legacyPlan.Copy[0].From -eq 'HOMEBASE_PAGES_URL' -and $legacyPlan.Copy[0].To -eq 'PORTLY_PAGES_URL' -and
    $legacyPlan.Copy[0].Value -eq 'https://me.github.io/' -and @($legacyPlan.RegistryKeys).Count -eq 1 -and $null -eq $legacyPlan.Task -and -not $legacyPlan.Empty)
Assert-That -Name 'Get-HbLegacyPlan is empty without anything of Homebase' -Condition (
    (Get-HbLegacyPlan -EnvReader { param($Name) $null } -RegistryReader { param($SubKey) $null } -TaskReader { $null }).Empty)
$legacyCalls = New-Object System.Collections.Generic.List[string]
Invoke-HbLegacyEnvCopy -Plan $legacyPlan -EnvWriter { param($Name, $Value) $legacyCalls.Add("env $Name=$Value") }
Assert-That -Name 'Invoke-HbLegacyEnvCopy copies only the variables' -Condition (
    ($legacyCalls -join '|') -ceq 'env PORTLY_PAGES_URL=https://me.github.io/') -Detail ($legacyCalls -join '|')

$legacyTask = [pscustomobject]@{ TaskName = 'Homebase Server'; TaskPath = '\' }
$legacyTaskPlan = Get-HbLegacyPlan -EnvReader { param($Name) $null } -RegistryReader { param($SubKey) if ($SubKey -eq $legacyChrome) { 'C:\x.json' } else { $null } } -TaskReader { $legacyTask }
$legacyCalls.Clear()
$suspended = Suspend-HbLegacyServer -Plan $legacyTaskPlan -TaskStopper { param($Task) $legacyCalls.Add("stop $($Task.TaskName)") }
Resume-HbLegacyServer -Plan $legacyTaskPlan -TaskStarter { param($Task) $legacyCalls.Add("start $($Task.TaskName)") }
Assert-That -Name 'Suspend-HbLegacyServer only stops the Homebase Server task, and Resume-HbLegacyServer starts it again' -Condition (
    $suspended -and ($legacyCalls -join '|') -ceq 'stop Homebase Server|start Homebase Server') -Detail ($legacyCalls -join '|')
Assert-That -Name 'Suspend-HbLegacyServer does nothing without a Homebase task' -Condition (
    -not (Suspend-HbLegacyServer -Plan $legacyPlan -TaskStopper { param($Task) throw 'called' }))

$legacyBackup = Join-Path $workDir 'legacy\data\homebase-task-backup.xml'
$legacyCalls.Clear()
Remove-HbLegacyInstall -Plan $legacyTaskPlan -BackupPath $legacyBackup -TaskExporter { param($Task, $Path) $legacyCalls.Add("export $($Task.TaskName) $Path") } -TaskRemover { param($Task) $legacyCalls.Add("remove $($Task.TaskName)") } -RegistryRemover { param($SubKey) $legacyCalls.Add("reg $SubKey") }
Assert-That -Name 'Remove-HbLegacyInstall saves the task definition first, then removes the task and the host keys' -Condition (
    ($legacyCalls -join '|') -ceq "export Homebase Server $legacyBackup|remove Homebase Server|reg $legacyChrome" -and
    (Test-Path -LiteralPath (Split-Path -Parent $legacyBackup) -PathType Container)) -Detail ($legacyCalls -join '|')
$legacyCalls.Clear()
Assert-Throws -Name 'Remove-HbLegacyInstall removes nothing when the task definition cannot be saved' -Pattern 'disk full' -Action {
    Remove-HbLegacyInstall -Plan $legacyTaskPlan -BackupPath $legacyBackup -TaskExporter { param($Task, $Path) throw 'disk full' } -TaskRemover { param($Task) $legacyCalls.Add('remove') } -RegistryRemover { param($SubKey) $legacyCalls.Add('reg') }
}
Assert-That -Name 'Remove-HbLegacyInstall left the task and keys after a failed save' -Condition ($legacyCalls.Count -eq 0) -Detail ($legacyCalls -join '|')

# The copy request (server/src/lib/legacy-homebase.ts reads it).
$copyLocal = Join-Path $workDir 'copy\Local'
$copyData = Join-Path $copyLocal 'Portly'
$copyHomebase = Join-Path $copyLocal 'Homebase'
Assert-That -Name 'Get-HbHomebaseCopyPlan: none without a Homebase database' -Condition (
    (Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal).State -eq 'none')
$null = New-Item -ItemType Directory -Path $copyHomebase -Force
Set-Content -LiteralPath (Join-Path $copyHomebase 'homebase.db') -Value 'db'
$copyPlan = Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal
Assert-That -Name "Get-HbHomebaseCopyPlan: request, from Homebase's default folder" -Condition (
    $copyPlan.State -eq 'request' -and $copyPlan.Source -eq (Join-Path $copyHomebase 'homebase.db')) -Detail "$($copyPlan.State) $($copyPlan.Source)"
Assert-That -Name "Get-HbHomebaseCopyPlan: a custom data folder ignores Homebase's default folder" -Condition (
    (Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal -CustomDataDir).State -eq 'none')
$requestPath = Write-HbHomebaseCopyRequest -DataDir $copyData
$requestBytes = [System.IO.File]::ReadAllBytes($requestPath)
$request = [System.Text.Encoding]::UTF8.GetString($requestBytes) | ConvertFrom-Json
Assert-That -Name 'Write-HbHomebaseCopyRequest writes JSON without a BOM (replace false)' -Condition (
    $requestBytes[0] -eq [byte][char]'{' -and $request.replace -eq $false -and "$($request.requestedAt)" -ne '') -Detail ([System.Text.Encoding]::UTF8.GetString($requestBytes))
Assert-That -Name 'Get-HbHomebaseCopyPlan: pending once requested' -Condition ((Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal).State -eq 'pending')
$null = Write-HbHomebaseCopyRequest -DataDir $copyData -Replace
Assert-That -Name 'Write-HbHomebaseCopyRequest -Replace' -Condition (((Get-Content -LiteralPath $requestPath -Raw) | ConvertFrom-Json).replace -eq $true)
Assert-That -Name 'Remove-HbHomebaseCopyRequest withdraws it, once' -Condition (
    (Remove-HbHomebaseCopyRequest -DataDir $copyData) -and -not (Test-Path -LiteralPath $requestPath) -and -not (Remove-HbHomebaseCopyRequest -DataDir $copyData))
Set-Content -LiteralPath (Join-Path $copyData 'portly.db') -Value 'db'
Assert-That -Name 'Get-HbHomebaseCopyPlan: portly-has-database' -Condition ((Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal).State -eq 'portly-has-database')
Set-Content -LiteralPath (Join-Path $copyData 'migrated-from-homebase.json') -Value '{"status":"copied","at":"2026-10-12T12:00:00.000Z"}'
$copyDone = Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal
Assert-That -Name 'Get-HbHomebaseCopyPlan: done, from the marker' -Condition ($copyDone.State -eq 'done' -and "$($copyDone.CopiedAt)" -match '^2026-10-12') -Detail "$($copyDone.State) $($copyDone.CopiedAt)"
Set-Content -LiteralPath (Join-Path $copyData 'migrated-from-homebase.json') -Value '{"status":"failed"}'
Assert-That -Name 'Get-HbHomebaseCopyPlan: a failed copy is not done' -Condition ((Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal).State -eq 'portly-has-database')
Set-Content -LiteralPath (Join-Path $copyData 'homebase.db') -Value 'db'
Assert-That -Name 'Get-HbHomebaseCopyPlan prefers homebase.db in the data folder itself' -Condition (
    (Get-HbHomebaseCopyPlan -DataDir $copyData -LocalAppData $copyLocal -CustomDataDir).Source -eq (Join-Path $copyData 'homebase.db'))

Assert-That -Name 'ConvertTo-HbPort accepts 5757' -Condition ((ConvertTo-HbPort '5757') -eq 5757)
Assert-That -Name 'ConvertTo-HbPort trims whitespace' -Condition ((ConvertTo-HbPort ' 8080 ') -eq 8080)
foreach ($bad in @('', 'abc', '0', '65536', '-1', '+80', '1e3', '5757.0', '0x10', '123456')) {
    Assert-Throws -Name "ConvertTo-HbPort rejects '$bad'" -Action { ConvertTo-HbPort $bad }
}
Assert-That -Name 'Test-HbTruthy' -Condition ((Test-HbTruthy '1') -and (Test-HbTruthy ' TRUE ') -and -not (Test-HbTruthy '0') -and -not (Test-HbTruthy $null))

$json = '{"ok":true,"version":"1.2.3"}' | ConvertFrom-Json
Assert-That -Name 'Get-HbProperty reads existing properties' -Condition ((Get-HbProperty $json 'version') -eq '1.2.3')
Assert-That -Name 'Get-HbProperty returns null for missing properties' -Condition ($null -eq (Get-HbProperty $json 'vault') -and $null -eq (Get-HbProperty $null 'x'))

$comDenied = New-Object System.Runtime.InteropServices.COMException ('Operation failed', -2147024891)
$wrapped = New-Object System.Exception ('outer', (New-Object System.Exception ('Access is denied.')))
Assert-That -Name 'Test-HbAccessDenied: HRESULT 0x80070005' -Condition (Test-HbAccessDenied $comDenied)
Assert-That -Name 'Test-HbAccessDenied: UnauthorizedAccessException' -Condition (Test-HbAccessDenied (New-Object System.UnauthorizedAccessException))
Assert-That -Name 'Test-HbAccessDenied: inner "Access is denied."' -Condition (Test-HbAccessDenied $wrapped)
Assert-That -Name 'Test-HbAccessDenied: other errors are not access denied' -Condition (-not (Test-HbAccessDenied (New-Object System.Exception ('The system cannot find the file specified.'))))
try { throw $comDenied } catch { $record = $_ }
Assert-That -Name 'Test-HbAccessDenied: ErrorRecord' -Condition (Test-HbAccessDenied $record)

Assert-That -Name 'Format-HbTaskResult 0' -Condition ((Format-HbTaskResult 0) -eq '0x0 (success)')
Assert-That -Name 'Format-HbTaskResult running' -Condition ((Format-HbTaskResult 267009) -eq '0x41301 (running)')
Assert-That -Name 'Format-HbTaskResult exit code 3' -Condition ((Format-HbTaskResult 3) -match 'port already in use')
Assert-That -Name 'Format-HbTaskResult exit code 1 points to start.ps1' -Condition ((Format-HbTaskResult 1) -match 'start\.ps1')
Assert-That -Name 'Format-HbTaskResult negative HRESULT' -Condition ((Format-HbTaskResult -2147216609) -match '^0x8004131F ')

Assert-That -Name 'Get-HbCommandLineProgram (quoted, unquoted, forward slashes, empty)' -Condition (
    (Get-HbCommandLineProgram '"C:\WINDOWS\System32\conhost.exe" --headless "C:\n\node.exe"') -eq 'conhost.exe' -and
    (Get-HbCommandLineProgram 'C:/Program/Node.EXE C:\x\supervisor.ts') -eq 'node.exe' -and
    (Get-HbCommandLineProgram 'node') -eq 'node' -and (Get-HbCommandLineProgram $null) -eq '')

$t0 = Get-Date '2026-01-01T08:00:00'
$fakeRoot = 'C:\Repo\Portly'
$processes = @(
    # The scheduled task's host: its command line names supervisor.ts too, but it is not a supervisor.
    [pscustomobject]@{ ProcessId = 5; ParentProcessId = 2; Name = 'conhost.exe'; CreationDate = $t0.AddSeconds(-1); CommandLine = '"C:\WINDOWS\System32\conhost.exe" --headless "C:\Program Files\nodejs\node.exe" "C:\Repo\Portly\server\src\supervisor.ts"' }
    [pscustomobject]@{ ProcessId = 6; ParentProcessId = 2; CreationDate = $t0.AddSeconds(-1); CommandLine = 'C:\WINDOWS\System32\conhost.exe --headless node C:\Repo\Portly\server\src\supervisor.ts' }
    [pscustomobject]@{ ProcessId = 10; ParentProcessId = 5; Name = 'node.exe'; CreationDate = $t0; CommandLine = '"C:\Program Files\nodejs\node.exe" "C:\Repo\Portly\server\src\supervisor.ts"' }
    [pscustomobject]@{ ProcessId = 11; ParentProcessId = 10; CreationDate = $t0.AddSeconds(1); CommandLine = '"C:\Program Files\nodejs\node.exe" C:\Repo\Portly\server\src\index.ts' }
    [pscustomobject]@{ ProcessId = 12; ParentProcessId = 10; CreationDate = $t0.AddHours(-1); CommandLine = 'node unrelated.js' }
    [pscustomobject]@{ ProcessId = 20; ParentProcessId = 1; CreationDate = $t0; CommandLine = 'node C:/repo/portly/server/src/supervisor.ts' }
    [pscustomobject]@{ ProcessId = 30; ParentProcessId = 1; CreationDate = $t0; CommandLine = 'node C:\Other\Portly\server\src\supervisor.ts' }
    [pscustomobject]@{ ProcessId = 31; ParentProcessId = 1; CreationDate = $t0; CommandLine = $null }
)
$trees = @(Select-HbSupervisorProcesses -Processes $processes -RepoRoot $fakeRoot)
$supervisorIds = (@($trees | ForEach-Object { $_.SupervisorId }) -join ',')
Assert-That -Name 'Select-HbSupervisorProcesses finds this repo''s supervisors only (not their conhost hosts)' -Condition ($supervisorIds -eq '10,20') -Detail $supervisorIds
Assert-That -Name 'Select-HbSupervisorProcesses keeps real children, skips recycled PIDs' -Condition ((@($trees[0].ChildIds) -join ',') -eq '11' -and @($trees[1].ChildIds).Count -eq 0)
Assert-That -Name 'Select-HbSupervisorProcesses handles no processes' -Condition (@(Select-HbSupervisorProcesses -Processes @() -RepoRoot $fakeRoot).Count -eq 0)
Assert-That -Name 'Format-HbProcessList' -Condition ((Format-HbProcessList -Trees $trees) -eq 'supervisor PID 10 (server PID 11); supervisor PID 20' -and (Format-HbProcessList -Trees @()) -eq 'none')
$logLine = '{"t":"2026-10-11T09:00:00.000Z","lvl":"warn","msg":"feeds failing","area":"feeds","tags":["feeds"],"key":"feed:0123456789","code":"timeout","count":2}'
Assert-That -Name 'Format-HbLogLine shows a JSON record as time, level, area, message and its other fields' -Condition ((Format-HbLogLine -Line $logLine) -eq '2026-10-11T09:00:00.000Z WARN  [feeds] feeds failing {"key":"feed:0123456789","code":"timeout","count":2}') -Detail (Format-HbLogLine -Line $logLine)
Assert-That -Name 'Format-HbLogLine keeps text lines and broken JSON as they are' -Condition ((Format-HbLogLine -Line '2026-10-11 starting') -eq '2026-10-11 starting' -and (Format-HbLogLine -Line '{not json') -eq '{not json' -and (Format-HbLogLine -Line '') -eq '')

# Process-scope environment changes below are restored right away (nothing user- or
# machine-wide is ever written).
function Invoke-WithProcessEnv {
    param([Parameter(Mandatory)][hashtable]$Values, [Parameter(Mandatory)][scriptblock]$Action)
    $saved = @{}
    foreach ($name in $Values.Keys) { $saved[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        foreach ($name in $Values.Keys) { [System.Environment]::SetEnvironmentVariable($name, $Values[$name], 'Process') }
        return & $Action
    } finally {
        foreach ($name in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

$relativeDataDir = Invoke-WithProcessEnv @{ PORTLY_DATA_DIR = 'scratch\hb-data' } { Get-HbDataDir -Scope Process -RepoRoot $fakeRoot }
Assert-That -Name 'Get-HbDataDir resolves a relative PORTLY_DATA_DIR against the repository (like the server)' -Condition (
    $relativeDataDir -eq 'C:\Repo\Portly\scratch\hb-data') -Detail $relativeDataDir
$absoluteDataDir = Invoke-WithProcessEnv @{ PORTLY_DATA_DIR = 'D:\HB Data' } { Get-HbDataDir -Scope Process -RepoRoot $fakeRoot }
Assert-That -Name 'Get-HbDataDir keeps an absolute PORTLY_DATA_DIR' -Condition ($absoluteDataDir -eq 'D:\HB Data') -Detail $absoluteDataDir

$marker = "check-$([guid]::NewGuid().ToString('N'))"
$mismatches = @(Invoke-WithProcessEnv @{ PORTLY_VITE_PORT = $marker } { Get-HbEnvMismatches })
Assert-That -Name 'Get-HbEnvMismatches reports a variable set only in this window' -Condition (
    @($mismatches | Where-Object { $_.Name -eq 'PORTLY_VITE_PORT' -and $_.Process -eq $marker }).Count -eq 1)

$checkNode = (Resolve-HbNode).Path
$badConfig = Test-HbServerConfig -NodeExe $checkNode -RepoRoot $repoRoot -Override @{ PORTLY_BIND = 'not-an-ip' }
Assert-That -Name 'Test-HbServerConfig reports a value the server rejects' -Condition (
    -not $badConfig.Ok -and $badConfig.Error -match 'PORTLY_BIND') -Detail "$($badConfig.Error)"
$badDev = Test-HbServerConfig -NodeExe $checkNode -RepoRoot $repoRoot -Override @{ PORTLY_DEV = 'on' }
Assert-That -Name 'Test-HbServerConfig reports PORTLY_DEV=on' -Condition (-not $badDev.Ok -and $badDev.Error -match 'PORTLY_DEV') -Detail "$($badDev.Error)"
$badPages = Test-HbServerConfig -NodeExe $checkNode -RepoRoot $repoRoot -Override @{ PORTLY_PAGES_URL = 'http://pages.example/' }
Assert-That -Name 'Test-HbServerConfig passes PORTLY_PAGES_URL on (plain http off loopback is refused)' -Condition (
    -not $badPages.Ok -and $badPages.Error -match 'PORTLY_PAGES_URL') -Detail "$($badPages.Error)"
$goodConfig = Test-HbServerConfig -NodeExe $checkNode -RepoRoot $repoRoot -Override @{
    PORTLY_PORT = '5999'; PORTLY_DATA_DIR = 'scratch\hb-data'; PORTLY_BIND = $null; PORTLY_ORIGIN = $null; PORTLY_DEV = $null
    PORTLY_PAGES_URL = 'https://pages.example/portly/'
}
$expectedDataDir = Invoke-WithProcessEnv @{ PORTLY_DATA_DIR = 'scratch\hb-data' } { Get-HbDataDir -Scope Process -RepoRoot $repoRoot }
Assert-That -Name 'Test-HbServerConfig returns the port and data folder the server would use' -Condition (
    $goodConfig.Ok -and $goodConfig.Port -eq 5999 -and $goodConfig.DataDir -eq $expectedDataDir) -Detail "$($goodConfig.Error) $($goodConfig.Port) $($goodConfig.DataDir) (expected $expectedDataDir)"
$missingNode = Test-HbServerConfig -NodeExe (Join-Path $repoRoot 'no-such-node.exe') -RepoRoot $repoRoot
Assert-That -Name 'Test-HbServerConfig reports a node.exe that cannot run' -Condition (-not $missingNode.Ok -and $missingNode.Error -match 'could not run') -Detail "$($missingNode.Error)"

if ((Test-HbWindows) -and (Test-HbScheduledTasksAvailable)) {
    $userId = Get-HbCurrentUserId
    $expectedSettings = {
        param($Settings)
        $Settings.ExecutionTimeLimit -eq 'PT0S' -and $Settings.DisallowStartIfOnBatteries -eq $false -and
        $Settings.StopIfGoingOnBatteries -eq $false -and "$($Settings.MultipleInstances)" -eq 'IgnoreNew' -and
        $Settings.StartWhenAvailable -eq $true -and $Settings.Priority -eq 4 -and $Settings.RestartCount -eq 3 -and
        $Settings.RestartInterval -eq 'PT1M' -and $Settings.AllowDemandStart -eq $true
    }

    $browserTask = New-HbTaskDefinition -RepoRoot $fakeRoot -NodeExe 'C:\Program Files\nodejs\node.exe' -UserId $userId
    $action = @($browserTask.Actions)[0]
    Assert-That -Name 'task action runs conhost --headless node supervisor.ts' -Condition (
        $action.Execute -eq "$env:SystemRoot\System32\conhost.exe" -and
        $action.Arguments -eq '--headless "C:\Program Files\nodejs\node.exe" "C:\Repo\Portly\server\src\supervisor.ts"' -and
        $action.WorkingDirectory -eq $fakeRoot) -Detail "$($action.Execute) $($action.Arguments) [$($action.WorkingDirectory)]"
    Assert-That -Name 'Browser mode (the default): the task has no trigger at all' -Condition (
        @(@($browserTask.Triggers) | Where-Object { $null -ne $_ }).Count -eq 0 -and (Get-HbTaskTriggerMode -Task $browserTask) -eq 'Browser')
    Assert-That -Name 'Browser mode: description and trigger text name the native host' -Condition (
        $browserTask.Description -match 'com\.portly\.launcher' -and (Format-HbTaskTrigger -Task $browserTask) -match '^none - Browser mode')
    Assert-That -Name 'task principal is the current user, Interactive, Limited' -Condition (
        $browserTask.Principal.UserId -eq $userId -and "$($browserTask.Principal.LogonType)" -eq 'Interactive' -and
        "$($browserTask.Principal.RunLevel)" -eq 'Limited')
    Assert-That -Name 'Browser mode: settings match ARCHITECTURE section 12 and allow on-demand runs' -Condition (
        [bool](& $expectedSettings $browserTask.Settings)) -Detail ($browserTask.Settings | Select-Object ExecutionTimeLimit, DisallowStartIfOnBatteries, StopIfGoingOnBatteries, MultipleInstances, StartWhenAvailable, Priority, RestartCount, RestartInterval, AllowDemandStart | Out-String)

    $logonTask = New-HbTaskDefinition -RepoRoot $fakeRoot -NodeExe 'C:\Program Files\nodejs\node.exe' -UserId $userId -Trigger Logon
    $logonTriggers = @(@($logonTask.Triggers) | Where-Object { $null -ne $_ })
    Assert-That -Name 'Logon mode: one trigger, at logon of the current user, no delay' -Condition (
        $logonTriggers.Count -eq 1 -and $logonTriggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and
        $logonTriggers[0].UserId -eq $userId -and -not $logonTriggers[0].Delay -and (Get-HbTaskTriggerMode -Task $logonTask) -eq 'Logon')
    Assert-That -Name 'Logon mode: same action, principal and settings' -Condition (
        @($logonTask.Actions)[0].Arguments -eq $action.Arguments -and $logonTask.Principal.UserId -eq $userId -and
        [bool](& $expectedSettings $logonTask.Settings) -and $logonTask.Description -match 'at logon')
    $delayed = New-HbTaskDefinition -RepoRoot $fakeRoot -NodeExe 'C:\Program Files\nodejs\node.exe' -UserId $userId -Trigger Logon -LogonDelaySeconds 90
    $delayedTrigger = @(@($delayed.Triggers) | Where-Object { $null -ne $_ })[0]
    Assert-That -Name 'Logon mode: -LogonDelaySeconds 90 becomes the trigger delay PT1M30S' -Condition (
        $delayedTrigger.Delay -eq 'PT1M30S' -and (Format-HbTaskTrigger -Task $delayed) -match 'delay PT1M30S') -Detail "$($delayedTrigger.Delay)"
}

# ---------------------------------------------------------------------------------------------
Write-Host ''
Write-Host 'Extension ID and native host' -ForegroundColor White

# The ID Chrome gives an extension folder loaded unpacked without a
# "key" (SHA-256 of the UTF-16LE path): a real-world vector for the hash -> a-p mapping.
$pathHash = Get-HbSha256 -Bytes ([System.Text.Encoding]::Unicode.GetBytes('C:\Users\you\Coding\Homebase\extension'))
Assert-That -Name 'ConvertTo-HbExtensionId matches a path-derived Chrome ID' -Condition (
    (ConvertTo-HbExtensionId -Hash $pathHash) -ceq 'daklamdnkmbdeegnkhmpeccgggbgiole') -Detail (ConvertTo-HbExtensionId -Hash $pathHash)
# A fixed RSA-2048 public key and its ID, computed independently with Node's crypto.
$vectorKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwSv/UP1vJ8MyvwqBWm4lcTFePyJYPWixf8yHB9liQC7X0XyYLooDgSv2xh0VeWPLaoGwwg5AR4n4ngv0MAi5YtQzStMwY64ClckW+d490mOiQzZkz9dFPFELVhxqqcXg+AlYwmO2y1NnI0FGoCxdyyoZ/5LcBzeFWyArHOUI+hl6leGBcCJSgeF4qFpk2jliql05TCoEDvk54DgVzrE5UPIQtu+ZxPNj/ynpliG0kFGgB5RWp6c8S3OjOuYmMG95le14WLoDN8o5K43IkjBhucwyHoJ/uCjInoJtKEY9Co2V6ZwJGjO1EovHqYW7JO9YIa1dXd19GHeLSwPScWtknQIDAQAB'
$vectorId = 'fndafcppdecimanmjfaoopdcbomgldng'
Assert-That -Name 'Get-HbExtensionIdFromKey matches the fixed key vector' -Condition ((Get-HbExtensionIdFromKey -Key $vectorKey) -ceq $vectorId)
Assert-That -Name 'Get-HbExtensionIdFromKey ignores whitespace in the key' -Condition (
    (Get-HbExtensionIdFromKey -Key ($vectorKey.Substring(0, 100) + "`r`n  " + $vectorKey.Substring(100))) -ceq $vectorId)
Assert-That -Name 'Get-HbExtensionIdFromKey ignores PEM armour lines (as Chrome and extension-id.mjs do)' -Condition (
    (Get-HbExtensionIdFromKey -Key ("-----BEGIN PUBLIC KEY-----`n" + $vectorKey.Substring(0, 64) + "`n" + $vectorKey.Substring(64) + "`n-----END PUBLIC KEY-----`n")) -ceq $vectorId)
Assert-Throws -Name 'Get-HbExtensionIdFromKey rejects invalid base64' -Action { Get-HbExtensionIdFromKey -Key 'not base64!' } -Pattern 'base64'
Assert-Throws -Name 'Get-HbExtensionIdFromKey rejects an empty key' -Action { Get-HbExtensionIdFromKey -Key "-----BEGIN PUBLIC KEY-----`n-----END PUBLIC KEY-----" } -Pattern 'base64'
Assert-Throws -Name 'Get-HbExtensionIdFromKey rejects data that is not a public key' -Action { Get-HbExtensionIdFromKey -Key ([System.Convert]::ToBase64String((New-Object byte[] 300))) } -Pattern 'public key'

$manifestWithKey = Join-Path $workDir 'manifest-key.json'
[System.IO.File]::WriteAllText($manifestWithKey, ('{"manifest_version":3,"name":"x","key":"' + $vectorKey + '"}'))
$manifestNoKey = Join-Path $workDir 'manifest-nokey.json'
[System.IO.File]::WriteAllText($manifestNoKey, '{"manifest_version":3,"name":"x"}')
Assert-That -Name 'Get-HbExtensionIdFromManifest reads the "key"' -Condition ((Get-HbExtensionIdFromManifest -ManifestPath $manifestWithKey) -ceq $vectorId)
Assert-Throws -Name 'Get-HbExtensionIdFromManifest fails clearly without a "key"' -Action { Get-HbExtensionIdFromManifest -ManifestPath $manifestNoKey } -Pattern 'has no "key" entry.*-NoNativeHost'
Assert-Throws -Name 'Get-HbExtensionIdFromManifest fails clearly for a missing manifest' -Action { Get-HbExtensionIdFromManifest -ManifestPath (Join-Path $workDir 'none.json') } -Pattern 'missing'

# Cross-check the repository's own manifest against Node's crypto (same algorithm, other code).
$realManifest = Join-Path $repoRoot 'extension\manifest.json'
$realManifestKey = Get-HbProperty ([System.IO.File]::ReadAllText($realManifest) | ConvertFrom-Json) 'key'
$repoExtensionId = $null
if ($realManifestKey -is [string] -and $realManifestKey) {
    $repoExtensionId = Get-HbExtensionIdFromManifest -ManifestPath $realManifest
    $nodeScript = "const fs=require('fs'),c=require('crypto');const k=JSON.parse(fs.readFileSync(process.argv[1],'utf8')).key;" +
        "process.stdout.write([...c.createHash('sha256').update(Buffer.from(k,'base64')).digest('hex').slice(0,32)].map(x=>String.fromCharCode(97+parseInt(x,16))).join(''));"
    $nodeScript = $nodeScript.Replace('process.argv[1]', 'process.argv[2]')
    $scriptFile = Join-Path $workDir 'extension-id.cjs'
    [System.IO.File]::WriteAllText($scriptFile, $nodeScript)
    $nodeId = "$(& $checkNode $scriptFile $realManifest)".Trim()
    Assert-That -Name "extension\manifest.json: the PowerShell and Node IDs agree ($repoExtensionId)" -Condition ($repoExtensionId -ceq $nodeId) -Detail "PowerShell $repoExtensionId, Node $nodeId"

    # The extension's own constant and every ID quoted in the docs must be this one (the docs tell
    # users to check the ID shown on chrome://extensions). The extension's old, folder-derived ID
    # may be quoted as such.
    $launcherJs = Join-Path $repoRoot 'extension\lib\launcher.js'
    if (Test-Path -LiteralPath $launcherJs -PathType Leaf) {
        $pinned = [regex]::Match([System.IO.File]::ReadAllText($launcherJs), "PINNED_EXTENSION_ID\s*=\s*['""]([a-p]{32})['""]")
        Assert-That -Name 'extension\lib\launcher.js PINNED_EXTENSION_ID is the ID the installer allows' -Condition (
            $pinned.Success -and $pinned.Groups[1].Value -ceq $repoExtensionId) -Detail $(if ($pinned.Success) { $pinned.Groups[1].Value } else { 'PINNED_EXTENSION_ID not found' })
    }
    $oldPathId = 'daklamdnkmbdeegnkhmpeccgggbgiole'
    $docFiles = @(
        @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs') -Filter '*.md' -Recurse -File) +
        @(foreach ($name in @('README.md', 'native-host\README.md', 'scripts\README.md', 'extension\README.md')) {
                $candidate = Join-Path $repoRoot $name
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
            }))
    $staleIds = New-Object System.Collections.Generic.List[string]
    foreach ($doc in $docFiles) {
        foreach ($match in [regex]::Matches([System.IO.File]::ReadAllText($doc.FullName), '(?<![A-Za-z0-9+])[a-p]{32}(?![A-Za-z0-9+])')) {
            if ($match.Value -cne $repoExtensionId -and $match.Value -cne $oldPathId) {
                $staleIds.Add("$($doc.FullName.Substring($repoRoot.Length).TrimStart('\')): $($match.Value)")
            }
        }
    }
    Assert-That -Name "the docs quote no extension ID other than $repoExtensionId" -Condition ($staleIds.Count -eq 0) -Detail ($staleIds -join '; ')
} else {
    Write-Host '  note  extension\manifest.json has no "key" yet; the installer will refuse to register the native host' -ForegroundColor DarkYellow
}

Assert-That -Name 'ConvertTo-HbJsonString escapes quotes, backslashes, controls and non-ASCII' -Condition (
    (ConvertTo-HbJsonString ('a"b\c' + [char]0xE9 + "`t")) -ceq '"a\"b\\c\u00e9\u0009"' -and
    ((ConvertTo-HbJsonString ('C:\Users\Jos' + [char]0xE9)) | ConvertFrom-Json) -ceq ('C:\Users\Jos' + [char]0xE9))
$ibm437 = [System.Text.Encoding]::GetEncoding(437, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
# (Functions that return an array with "return , $array" are assigned, never wrapped in @().)
$asciiBytes = ConvertTo-HbBatchBytes -Text 'abc'
$oemBytes = ConvertTo-HbBatchBytes -Text ('Jos' + [char]0xE9) -Encoding $ibm437
Assert-That -Name 'ConvertTo-HbBatchBytes: ASCII stays ASCII, other text uses the OEM code page' -Condition (
    ($asciiBytes -join ',') -eq '97,98,99' -and ($oemBytes -join ',') -eq '74,111,115,130') -Detail "$($asciiBytes -join ',') / $($oemBytes -join ',')"
Assert-Throws -Name 'ConvertTo-HbBatchBytes fails clearly for characters the code page lacks' -Action {
    ConvertTo-HbBatchBytes -Text ('C:\' + [char]0x4E2D + '\node.exe') -Encoding $ibm437 } -Pattern '-NodePath'

$hostId = 'abcdefghijklmnopabcdefghijklmnop'
$hostOrigin = "chrome-extension://$hostId/"
$hostDir = Join-Path $workDir 'profile with spaces\Portly\native-host'
$percentNode = 'C:\Tools 100%\node.exe'
$plan = New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $percentNode -ExtensionId $hostId -Destination $hostDir
$planFiles = @{}
foreach ($file in @($plan.Files)) { $planFiles[$file.Name] = $file }
Assert-That -Name 'New-HbNativeHostPlan: launcher.cmd, launcher.mjs, host manifest and config.json in the folder' -Condition (
    @($plan.Files).Count -eq 4 -and $planFiles.ContainsKey('launcher.cmd') -and $planFiles.ContainsKey('launcher.mjs') -and
    $planFiles.ContainsKey('com.portly.launcher.json') -and $planFiles.ContainsKey('config.json') -and
    @(@($plan.Files) | Where-Object { (Split-Path -Parent $_.Path) -ne $hostDir }).Count -eq 0)
$cmdText = $planFiles['launcher.cmd'].Text
Assert-That -Name 'launcher.cmd: @echo off, absolute node.exe (percent doubled), %~dp0launcher.mjs %*, CRLF, no "start"' -Condition (
    $cmdText.StartsWith("@echo off`r`n") -and $cmdText.Contains('"C:\Tools 100%%\node.exe" "%~dp0launcher.mjs" %*' + "`r`n") -and
    ([regex]::Matches($cmdText, '(?<!\r)\n')).Count -eq 0 -and $cmdText -notmatch '(?im)^\s*start\b' -and -not $cmdText.Contains('{{')) -Detail $cmdText
Assert-That -Name 'launcher.mjs is copied byte for byte' -Condition (
    [System.Convert]::ToBase64String([byte[]]$planFiles['launcher.mjs'].Bytes) -ceq
    [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $repoRoot 'native-host\launcher.mjs'))))
$hostManifest = $planFiles['com.portly.launcher.json'].Text | ConvertFrom-Json
Assert-That -Name 'host manifest: name, non-empty description, absolute path to launcher.cmd, stdio, exact allowed origin' -Condition (
    $hostManifest.name -ceq 'com.portly.launcher' -and
    $hostManifest.description -ceq 'Portly launcher (starts the Portly Server scheduled task)' -and
    $hostManifest.path -ceq (Join-Path $hostDir 'launcher.cmd') -and $hostManifest.type -ceq 'stdio' -and
    (@($hostManifest.allowed_origins) -join '|') -ceq $hostOrigin -and $plan.ManifestPath -ceq (Join-Path $hostDir 'com.portly.launcher.json')) -Detail $planFiles['com.portly.launcher.json'].Text
$hostConfig = $planFiles['config.json'].Text | ConvertFrom-Json
Assert-That -Name 'config.json allows exactly the extension origin' -Condition ((@($hostConfig.allowedOrigins) -join '|') -ceq $hostOrigin -and $hostConfig.version -eq 1)
Assert-That -Name 'registry: HKCU Chrome and Edge NativeMessagingHosts keys -> the host manifest' -Condition (
    (@($plan.Registry | ForEach-Object { $_.SubKey }) -join '|') -ceq
    'Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher|Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher' -and
    @($plan.Registry | Where-Object { $_.Value -cne $plan.ManifestPath }).Count -eq 0)
Assert-That -Name 'the default folder is %LOCALAPPDATA%\Portly\native-host' -Condition (
    (Get-HbNativeHostDir) -eq (Join-Path ([System.Environment]::GetFolderPath('LocalApplicationData')) 'Portly\native-host'))
Assert-Throws -Name 'New-HbNativeHostPlan rejects an upper-case extension ID' -Action { New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $percentNode -ExtensionId $hostId.ToUpperInvariant() -Destination $hostDir } -Pattern 'Not an extension ID'
Assert-Throws -Name 'New-HbNativeHostPlan rejects a short extension ID' -Action { New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $percentNode -ExtensionId 'abc' -Destination $hostDir } -Pattern 'Not an extension ID'

# Install into the temporary folder with the real node.exe and a fake registry.
$livePlan = New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $checkNode -ExtensionId $hostId -Destination $hostDir
$fakeRegistry = @{}
$writer = { param([string]$SubKey, [string]$Value) $fakeRegistry[$SubKey] = $Value }
Install-HbNativeHost -Plan $livePlan -RegistryWriter $writer
Install-HbNativeHost -Plan $livePlan -RegistryWriter $writer
$writtenOk = @(@($livePlan.Files) | Where-Object {
        -not (Test-Path -LiteralPath $_.Path -PathType Leaf) -or
        [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($_.Path)) -cne [System.Convert]::ToBase64String([byte[]]$_.Bytes)
    }).Count -eq 0
Assert-That -Name 'Install-HbNativeHost writes every file (twice: idempotent) and both registry values' -Condition (
    $writtenOk -and $fakeRegistry.Count -eq 2 -and $fakeRegistry['Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher'] -ceq $livePlan.ManifestPath -and
    $fakeRegistry['Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher'] -ceq $livePlan.ManifestPath)
Assert-That -Name 'Get-HbLauncherNodePath reads node.exe back from launcher.cmd' -Condition ((Get-HbLauncherNodePath -LauncherCmd $livePlan.LauncherPath) -ceq $checkNode)
$freshCopy = Test-HbInstalledLauncherCurrent -InstalledDir $hostDir -RepoRoot $repoRoot
$staleCopyDir = Join-Path $workDir 'old-copy\native-host'
$null = New-Item -ItemType Directory -Path $staleCopyDir -Force
[System.IO.File]::WriteAllText((Join-Path $staleCopyDir 'launcher.mjs'), '// an older launcher')
$staleCopy = Test-HbInstalledLauncherCurrent -InstalledDir $staleCopyDir -RepoRoot $repoRoot
$noCopy = Test-HbInstalledLauncherCurrent -InstalledDir (Join-Path $workDir 'no-copy') -RepoRoot $repoRoot
Assert-That -Name 'Test-HbInstalledLauncherCurrent: true for a fresh copy, false for an older one, null without one' -Condition (
    $freshCopy -is [bool] -and $freshCopy -and $staleCopy -is [bool] -and -not $staleCopy -and $null -eq $noCopy) -Detail "$freshCopy / $staleCopy / $noCopy"

$reader = { param([string]$SubKey) if ($fakeRegistry.ContainsKey($SubKey)) { $fakeRegistry[$SubKey] } else { $null } }
$hostStatus = Get-HbNativeHostStatus -ExpectedId $hostId -RegistryReader $reader
Assert-That -Name 'Get-HbNativeHostStatus: both browsers registered, no problems' -Condition (
    @($hostStatus).Count -eq 2 -and @($hostStatus | Where-Object { $_.Registered -and @($_.Problems).Count -eq 0 }).Count -eq 2) -Detail (($hostStatus | ForEach-Object { "$($_.Browser): $(@($_.Problems) -join '; ')" }) -join ' / ')
$otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba'
$wrongId = Get-HbNativeHostStatus -ExpectedId $otherId -RegistryReader $reader
Assert-That -Name 'Get-HbNativeHostStatus: reports allowed_origins and config.json not naming the current extension ID' -Condition (
    @($wrongId | Where-Object { (@($_.Problems) -join ' ') -match 'allowed_origins lists chrome-extension://abcdefghijklmnopabcdefghijklmnop/, not chrome-extension://ponm' -and (@($_.Problems) -join ' ') -match 'config\.json does not allow' }).Count -eq 2)
$partial = Get-HbNativeHostStatus -ExpectedId $hostId -RegistryReader {
    param([string]$SubKey)
    if ($SubKey -like '*Google*') { return $null }
    return ''
}
Assert-That -Name 'Get-HbNativeHostStatus: a missing key is "not registered", an empty one is a problem' -Condition (
    -not $partial[0].Registered -and @($partial[0].Problems).Count -eq 0 -and $partial[1].Registered -and (@($partial[1].Problems) -join ' ') -match 'no default value')
$missingManifest = Get-HbNativeHostStatus -ExpectedId $hostId -RegistryReader { param([string]$SubKey) Join-Path $workDir 'gone\com.portly.launcher.json' }
Assert-That -Name 'Get-HbNativeHostStatus: reports a registered manifest that does not exist' -Condition (
    @($missingManifest | Where-Object { (@($_.Problems) -join ' ') -match 'does not exist' }).Count -eq 2)
$staleDir = Join-Path $workDir 'stale\native-host'
$stalePlan = New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe (Join-Path $workDir 'old-node\node.exe') -ExtensionId $hostId -Destination $staleDir
Install-HbNativeHost -Plan $stalePlan -RegistryWriter { param($SubKey, $Value) }
$stale = Get-HbNativeHostStatus -ExpectedId $hostId -RegistryReader { param([string]$SubKey) $stalePlan.ManifestPath }
Assert-That -Name 'Get-HbNativeHostStatus: reports a launcher whose node.exe no longer exists' -Condition (
    @($stale | Where-Object { (@($_.Problems) -join ' ') -match 'node\.exe no longer exists' }).Count -eq 2)

# The generated launcher.cmd, run exactly as Chrome runs a native host. schtasks.exe is always
# replaced by scripts\tests\schtasks-stub.mjs (preloaded through NODE_OPTIONS, which reaches node
# through launcher.cmd like the browser's environment; it fails closed), so these checks can never
# run the real "Portly Server" task. The stub appends each call to $StubLog.
function Invoke-HbHostLikeChrome {
    param(
        [Parameter(Mandatory)][string]$LauncherCmd,
        [Parameter(Mandatory)][string]$Origin,
        [Parameter(Mandatory)][string]$RequestJson,
        [ValidateSet('success', 'missing', 'denied')][string]$Schtasks = 'success',
        [string]$StubLog = (Join-Path $workDir 'schtasks-stub.jsonl')
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $(if ($env:ComSpec) { $env:ComSpec } else { "$env:SystemRoot\System32\cmd.exe" })
    $startInfo.Arguments = '/d /s /c ""{0}" {1} --parent-window=0"' -f $LauncherCmd, $Origin
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $stubUrl = ([System.Uri](Join-Path $PSScriptRoot 'tests\schtasks-stub.mjs')).AbsoluteUri
    $startInfo.EnvironmentVariables['NODE_OPTIONS'] = "--import=$stubUrl"
    $startInfo.EnvironmentVariables['PORTLY_TEST_SCHTASKS'] = $Schtasks
    $startInfo.EnvironmentVariables['PORTLY_TEST_SCHTASKS_LOG'] = $StubLog
    if (Test-Path -LiteralPath $StubLog) { Remove-Item -LiteralPath $StubLog -Force }
    # Windows PowerShell 5.1 (.NET Framework) writes the console input encoding's preamble into a
    # redirected stdin when the process starts: with the UTF-8 code page (chcp 65001) that is a
    # byte-order mark in front of the length prefix, which no browser ever sends. Start the host
    # with a preamble-free encoding, then restore the console's.
    $savedInputEncoding = $null
    try {
        if ([Console]::InputEncoding.CodePage -eq 65001 -and [Console]::InputEncoding.GetPreamble().Length -gt 0) {
            $savedInputEncoding = [Console]::InputEncoding
            [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
        }
    } catch {
        $savedInputEncoding = $null
    }
    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
    } finally {
        if ($null -ne $savedInputEncoding) {
            try { [Console]::InputEncoding = $savedInputEncoding } catch { }
        }
    }
    try {
        $stdout = New-Object System.IO.MemoryStream
        $copy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $body = [System.Text.Encoding]::UTF8.GetBytes($RequestJson)
        $frame = New-Object byte[] (4 + $body.Length)
        [System.BitConverter]::GetBytes([uint32]$body.Length).CopyTo($frame, 0)
        $body.CopyTo($frame, 4)
        # Like the browser, keep stdin open: the host must answer and exit on its own.
        $process.StandardInput.BaseStream.Write($frame, 0, $frame.Length)
        $process.StandardInput.BaseStream.Flush()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch { }
            return [pscustomobject]@{ ExitCode = $null; Frames = @(); Raw = 0; Error = 'the host did not exit within 15 s' }
        }
        $null = $copy.Wait(5000)
        $bytes = $stdout.ToArray()
        $frames = New-Object System.Collections.Generic.List[object]
        $offset = 0
        $errorText = $null
        while ($offset -lt $bytes.Length) {
            if ($bytes.Length - $offset -lt 4) { $errorText = 'truncated length prefix'; break }
            $length = [System.BitConverter]::ToUInt32($bytes, $offset)
            if ($bytes.Length - $offset - 4 -lt $length) { $errorText = 'truncated frame'; break }
            $frames.Add(([System.Text.Encoding]::UTF8.GetString($bytes, $offset + 4, [int]$length) | ConvertFrom-Json))
            $offset += 4 + [int]$length
        }
        $calls = @()
        if (Test-Path -LiteralPath $StubLog -PathType Leaf) {
            $calls = @(Get-Content -LiteralPath $StubLog | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
        }
        return [pscustomobject]@{
            ExitCode      = $process.ExitCode
            Frames        = $frames.ToArray()
            Raw           = $bytes.Length
            Error         = $(if ($errorText) { $errorText } else { "$($stderrTask.GetAwaiter().GetResult())".Trim() })
            SchtasksCalls = $calls
        }
    } finally {
        $process.Dispose()
    }
}

$ping = Invoke-HbHostLikeChrome -LauncherCmd $livePlan.LauncherPath -Origin $hostOrigin -RequestJson '{"action":"ping"}'
Assert-That -Name 'launcher.cmd run like Chrome: ping -> exactly one pong frame, exit code 0' -Condition (
    $ping.ExitCode -eq 0 -and @($ping.Frames).Count -eq 1 -and $ping.Frames[0].ok -eq $true -and $ping.Frames[0].state -ceq 'pong' -and
    $ping.Frames[0].version -eq 1) -Detail "exit $($ping.ExitCode), $($ping.Raw) bytes, $($ping.Error)"
$foreign = Invoke-HbHostLikeChrome -LauncherCmd $livePlan.LauncherPath -Origin "chrome-extension://$otherId/" -RequestJson '{"action":"ping"}'
Assert-That -Name 'launcher.cmd run like Chrome: another extension gets bad_origin' -Condition (
    @($foreign.Frames).Count -eq 1 -and $foreign.Frames[0].ok -eq $false -and $foreign.Frames[0].error -ceq 'bad_origin') -Detail "$($foreign.Error)"
$launcherLog = Join-Path $hostDir 'launcher.log'
Assert-That -Name 'the launcher logs each request to launcher.log next to it' -Condition (
    (Test-Path -LiteralPath $launcherLog -PathType Leaf) -and ((Get-Content -LiteralPath $launcherLog -Raw) -match ' ping -> pong'))

# Nothing answers on a free port: the launcher asks Task Scheduler (here: the stub) to run the task.
$closedPort = Get-FreePort
$starting = Invoke-HbHostLikeChrome -LauncherCmd $livePlan.LauncherPath -Origin $hostOrigin -RequestJson ('{"action":"start","port":' + $closedPort + '}')
$startCall = @($starting.SchtasksCalls)
Assert-That -Name 'launcher.cmd run like Chrome: start with nothing answering -> starting, via schtasks.exe /run /tn "\Portly Server" (stubbed)' -Condition (
    @($starting.Frames).Count -eq 1 -and $starting.Frames[0].ok -eq $true -and $starting.Frames[0].state -ceq 'starting' -and
    $startCall.Count -eq 1 -and $startCall[0].file -eq "$env:SystemRoot\System32\schtasks.exe" -and
    (@($startCall[0].args) -join '|') -ceq '/run|/tn|\Portly Server') -Detail "$($starting.Error) calls: $(@($startCall | ForEach-Object { "$($_.file) $(@($_.args) -join ' ')" }) -join '; ')"
$missingTask = Invoke-HbHostLikeChrome -LauncherCmd $livePlan.LauncherPath -Origin $hostOrigin -RequestJson ('{"action":"start","port":' + $closedPort + '}') -Schtasks missing
Assert-That -Name 'launcher.cmd run like Chrome: start without the task -> task_missing' -Condition (
    @($missingTask.Frames).Count -eq 1 -and $missingTask.Frames[0].ok -eq $false -and $missingTask.Frames[0].error -ceq 'task_missing') -Detail "$($missingTask.Error)"

# A UTF-8 console (chcp 65001) must not make Windows PowerShell put a byte-order mark into the
# host's stdin (the helper above guards against it; this proves the guard works).
$utf8Console = $false
$consoleEncoding = $null
try {
    $consoleEncoding = [Console]::InputEncoding
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $true
    $utf8Console = $true
} catch {
    $utf8Console = $false
}
if ($utf8Console) {
    try {
        $utf8Ping = Invoke-HbHostLikeChrome -LauncherCmd $livePlan.LauncherPath -Origin $hostOrigin -RequestJson '{"action":"ping"}'
    } finally {
        try { [Console]::InputEncoding = $consoleEncoding } catch { }
    }
    Assert-That -Name 'launcher.cmd run like Chrome from a UTF-8 console (code page 65001): still pong' -Condition (
        @($utf8Ping.Frames).Count -eq 1 -and $utf8Ping.Frames[0].state -ceq 'pong') -Detail "$($utf8Ping.Error) $(@($utf8Ping.Frames | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ' ')"
} else {
    Write-Host '  note  no console to switch to code page 65001; the UTF-8 console check is skipped' -ForegroundColor DarkYellow
}

# Removal: fake registry, temporary folder - and never through a link.
$removedKeys = New-Object System.Collections.Generic.List[string]
$linkTarget = Join-Path $workDir 'link-target'
$null = New-Item -ItemType Directory -Path $linkTarget -Force
[System.IO.File]::WriteAllText((Join-Path $linkTarget 'keep.txt'), 'keep')
$null = New-Item -ItemType Junction -Path (Join-Path $hostDir 'junction') -Target $linkTarget
$removed = $false
$removeError = ''
try {
    $removed = Uninstall-HbNativeHost -Destination $hostDir -RegistryRemover { param([string]$SubKey) $removedKeys.Add($SubKey) }
} catch {
    $removeError = $_.Exception.Message
}
Assert-That -Name 'Uninstall-HbNativeHost removes both registry keys and the folder, not what a link inside points to' -Detail $removeError -Condition (
    $removed -and -not (Test-Path -LiteralPath $hostDir) -and (Test-Path -LiteralPath (Join-Path $linkTarget 'keep.txt')) -and
    ($removedKeys -join '|') -ceq 'Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher|Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher' -and
    (Test-Path -LiteralPath (Split-Path -Parent $hostDir)))
Assert-That -Name 'Uninstall-HbNativeHost is fine when nothing is installed' -Condition (-not (Uninstall-HbNativeHost -Destination $hostDir -RegistryRemover { param($SubKey) }))
Assert-Throws -Name 'Remove-HbNativeHostFolder refuses any folder not named native-host' -Action { Remove-HbNativeHostFolder -Path (Split-Path -Parent $hostDir) } -Pattern 'Refusing'

# ---------------------------------------------------------------------------------------------
Write-Host ''
Write-Host 'Native host launcher tests (node scripts\check-native-host.mjs)' -ForegroundColor White
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $nodeTestOutput = & $checkNode (Join-Path $PSScriptRoot 'check-native-host.mjs') 2>&1 | ForEach-Object { "$_" }
    $nodeTestExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}
$summary = @($nodeTestOutput | Where-Object { $_ -match '^\S*\s*(tests|pass|fail) \d+' }) -join ', '
Assert-That -Name "node --test scripts\tests\*.test.mjs passes ($summary)" -Condition ($nodeTestExit -eq 0) -Detail (($nodeTestOutput | Select-Object -Last 40) -join "`n")

# ---------------------------------------------------------------------------------------------
# The loopback fixture (node scripts\tests\health-fixture.mjs) serves the health checks below
# and occupies ports for the child runs; it exits when its stdin closes.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $checkNode
$startInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'tests\health-fixture.mjs') + '"'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardInput = $true
$startInfo.CreateNoWindow = $true
$fixture = [System.Diagnostics.Process]::Start($startInfo)
try {
    $ports = $fixture.StandardOutput.ReadLine() | ConvertFrom-Json

    Write-Host ''
    Write-Host 'Health checks' -ForegroundColor White
    $okHealth = Test-HbHealth -Port $ports.ok
    Assert-That -Name 'Test-HbHealth reads a Portly health answer' -Condition (
        $okHealth.Ok -and $okHealth.Version -eq '9.9.9-fixture' -and $okHealth.Vault -eq 'locked') -Detail "$($okHealth.Error)"
    Assert-That -Name 'Format-HbHealth (ok)' -Condition (
        (Format-HbHealth $okHealth) -eq "running at http://localhost:$($ports.ok) (version 9.9.9-fixture, vault locked)")
    $notJson = Test-HbHealth -Port $ports.notJson
    Assert-That -Name 'Test-HbHealth rejects a non-Portly answer' -Condition (
        -not $notJson.Ok -and $notJson.Error -match 'not a Portly health check') -Detail "$($notJson.Error)"
    $error503 = Test-HbHealth -Port $ports.error
    Assert-That -Name 'Test-HbHealth reports HTTP errors' -Condition (
        -not $error503.Ok -and $error503.Error -match '^HTTP 503') -Detail "$($error503.Error)"
    $hang = Test-HbHealth -Port $ports.hang -TimeoutSeconds 1
    Assert-That -Name 'Test-HbHealth times out' -Condition (
        -not $hang.Ok -and $hang.Error -eq 'no answer within 1 s') -Detail "$($hang.Error)"
    $freePort = Get-FreePort
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $closed = Test-HbHealth -Port $freePort
    Assert-That -Name 'Test-HbHealth reports a closed port at once' -Condition (
        -not $closed.Ok -and $closed.Error -eq "nothing is listening on port $freePort" -and $watch.ElapsedMilliseconds -lt 1500) -Detail "$($closed.Error) ($($watch.ElapsedMilliseconds) ms)"
    Assert-That -Name 'Format-HbPortOwners names the listening process' -Condition (
        (Format-HbPortOwners $notJson.Listeners) -eq "node (PID $($fixture.Id))") -Detail (Format-HbPortOwners $notJson.Listeners)

    # The installed-like launcher answers "running" for a port where Portly answers.
    $runningDir = Join-Path $workDir 'running\native-host'
    $runningPlan = New-HbNativeHostPlan -RepoRoot $repoRoot -NodeExe $checkNode -ExtensionId $hostId -Destination $runningDir
    Install-HbNativeHost -Plan $runningPlan -RegistryWriter { param($SubKey, $Value) }
    $alreadyUp = Invoke-HbHostLikeChrome -LauncherCmd $runningPlan.LauncherPath -Origin $hostOrigin -RequestJson ('{"action":"start","port":' + $ports.ok + '}')
    Assert-That -Name 'launcher.cmd run like Chrome: start on a port where Portly answers -> running (task not touched)' -Condition (
        @($alreadyUp.Frames).Count -eq 1 -and $alreadyUp.Frames[0].ok -eq $true -and $alreadyUp.Frames[0].state -ceq 'running' -and
        @($alreadyUp.SchtasksCalls).Count -eq 0) -Detail "$($alreadyUp.Error)"

    # -----------------------------------------------------------------------------------------
    if (-not $SkipChildRuns) {
        $engines = @()
        $windowsPowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        if (Test-Path -LiteralPath $windowsPowerShell) { $engines += $windowsPowerShell }
        $pwsh = Get-Command -Name 'pwsh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $pwsh) { $engines += $pwsh.Source }

        # Snapshot of everything a real install/uninstall would change.
        $snapshot = {
            $task = Get-HbTask
            $taskState = if ($null -ne $task) { "$($task.State)/$(Get-HbTaskTriggerMode -Task $task)" } else { 'absent' }
            $keys = foreach ($entry in $PortlyNativeHostRegistry) {
                $value = Get-HbRegistryDefaultValue -SubKey $entry.SubKey
                "$($entry.Browser)=$(if ($null -eq $value) { '<absent>' } else { $value })"
            }
            $folder = Get-HbNativeHostDir
            # (launcher.log* is left out: a real browser may use an installed launcher meanwhile.)
            $files = if (Test-Path -LiteralPath $folder) {
                (@(Get-ChildItem -LiteralPath $folder -Force | Where-Object { $_.Name -notlike 'launcher.log*' } |
                        ForEach-Object { "$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join ',')
            } else { '<absent>' }
            "task=$taskState; $($keys -join '; '); folder=$files"
        }
        $before = & $snapshot

        $fixedId = 'abcdefghijklmnopabcdefghijklmnop'
        foreach ($engine in $engines) {
            $label = [System.IO.Path]::GetFileNameWithoutExtension($engine)
            Write-Host ''
            Write-Host "Child runs with $label" -ForegroundColor White

            $run = {
                # $Script: a name under scripts\, or a full path (a copy of a script elsewhere).
                param([string]$Script, [string[]]$Arguments)
                $previous = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                $scriptPath = $Script
                if (-not [System.IO.Path]::IsPathRooted($Script)) { $scriptPath = Join-Path $PSScriptRoot $Script }
                try {
                    $output = & $engine -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath @Arguments 2>&1 |
                        ForEach-Object { "$_" }
                    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
                } finally {
                    $ErrorActionPreference = $previous
                }
            }

            $common = @(
                'Scheduled task definition (dry run - not registered)',
                "$env:SystemRoot\System32\conhost.exe",
                '--headless "',
                (Join-Path $repoRoot 'server\src\supervisor.ts'),
                'LogonType Interactive, RunLevel Limited',
                'IgnoreNew',
                'PT0S',
                'AllowDemandStart True',
                'RestartCount 3, RestartInterval PT1M',
                'supervisor.log',
                'valid (checked with server\src\config.ts)',
                'Dry run complete: nothing was registered, written, built, stopped or started.'
            )
            $hostLines = @(
                'Native messaging host (dry run - nothing written)',
                (Join-Path (Get-HbNativeHostDir) 'launcher.cmd'),
                (Join-Path (Get-HbNativeHostDir) 'launcher.mjs'),
                (Join-Path (Get-HbNativeHostDir) 'com.portly.launcher.json'),
                (Join-Path (Get-HbNativeHostDir) 'config.json'),
                '| @echo off',
                '"%~dp0launcher.mjs" %*',
                '|   "description": "Portly launcher (starts the Portly Server scheduled task)",',
                '|   "type": "stdio",',
                'HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher',
                'HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher',
                ('(default) REG_SZ = ' + (Join-Path (Get-HbNativeHostDir) 'com.portly.launcher.json'))
            )

            # Browser mode (the default), with the ID from extension\manifest.json. The dry run says
            # "register the task" on a PC without it and "replace the existing task" where it is
            # installed: expect the wording that fits this PC.
            if ($null -ne $repoExtensionId) {
                $install = & $run 'install-autostart.ps1' @('-DryRun')
                $installTaskStep = "- register the task '$PortlyTaskName' for $(Get-HbCurrentUserId) (Browser mode)"
                if ($null -ne (Get-HbTask)) { $installTaskStep = "- replace the existing task '$PortlyTaskName' (state: " }
                $expected = $common + $hostLines + @(
                    'none - Browser mode: runs on demand only',
                    "chrome-extension://$repoExtensionId/",
                    'from the "key" in extension\manifest.json',
                    $installTaskStep,
                    'Browser mode'
                )
                $missing = @($expected | Where-Object { -not $install.Text.Contains($_) })
                Assert-That -Name 'install-autostart.ps1 -DryRun (Browser mode, the default) exits 0' -Condition ($install.ExitCode -eq 0) -Detail $install.Text
                Assert-That -Name 'install-autostart.ps1 -DryRun prints the task (no trigger), every host file and both registry values' -Condition ($missing.Count -eq 0) -Detail (
                    'missing: ' + ($missing -join ' | ') + "`n" + $install.Text)
                Assert-That -Name 'install-autostart.ps1 -DryRun (Browser mode) has no logon trigger' -Condition (-not $install.Text.Contains('Logon mode: at log on'))
            } else {
                $noKey = & $run 'install-autostart.ps1' @('-DryRun')
                Assert-That -Name 'install-autostart.ps1 -DryRun refuses the native host while the manifest has no "key"' -Condition (
                    $noKey.ExitCode -eq 1 -and $noKey.Text.Contains('has no "key" entry')) -Detail $noKey.Text
            }

            $logon = & $run 'install-autostart.ps1' @('-DryRun', '-Trigger', 'Logon', '-LogonDelaySeconds', '30', '-ExtensionId', $fixedId, '-NoHomebaseCopy')
            $expected = $common + $hostLines + @("Logon mode: at log on of $(Get-HbCurrentUserId), delay PT30S", "chrome-extension://$fixedId/", '(-ExtensionId)', 'after 30 s (-Trigger Logon)')
            $missing = @($expected | Where-Object { -not $logon.Text.Contains($_) })
            Assert-That -Name 'install-autostart.ps1 -DryRun -Trigger Logon -LogonDelaySeconds 30 -ExtensionId -NoHomebaseCopy exits 0 and prints it all' -Condition (
                $logon.ExitCode -eq 0 -and $missing.Count -eq 0) -Detail ('missing: ' + ($missing -join ' | ') + "`n" + $logon.Text)

            $noHost = & $run 'install-autostart.ps1' @('-DryRun', '-NoNativeHost')
            Assert-That -Name 'install-autostart.ps1 -DryRun -NoNativeHost skips the host and warns that nothing starts Portly' -Condition (
                $noHost.ExitCode -eq 0 -and -not $noHost.Text.Contains('Native messaging host (dry run') -and
                $noHost.Text.Contains('not registered (-NoNativeHost)') -and
                # Windows PowerShell wraps warnings at the console width.
                ($noHost.Text -replace '\s+', ' ').Contains('nothing starts Portly by itself')) -Detail $noHost.Text

            $delayWithoutLogon = & $run 'install-autostart.ps1' @('-DryRun', '-LogonDelaySeconds', '5')
            Assert-That -Name 'install-autostart.ps1 rejects -LogonDelaySeconds without -Trigger Logon' -Condition (
                $delayWithoutLogon.ExitCode -eq 1 -and $delayWithoutLogon.Text.Contains('only applies with -Trigger Logon')) -Detail $delayWithoutLogon.Text
            $badId = & $run 'install-autostart.ps1' @('-DryRun', '-ExtensionId', $fixedId.ToUpperInvariant())
            Assert-That -Name 'install-autostart.ps1 validates -ExtensionId (32 letters a-p)' -Condition ($badId.ExitCode -ne 0) -Detail $badId.Text
            $badTrigger = & $run 'install-autostart.ps1' @('-DryRun', '-Trigger', 'Boot')
            Assert-That -Name 'install-autostart.ps1 validates -Trigger' -Condition ($badTrigger.ExitCode -ne 0) -Detail $badTrigger.Text

            $uninstall = & $run 'uninstall-autostart.ps1' @('-DryRun')
            $hostStep = $uninstall.Text.IndexOf('registry key to delete')
            if ($hostStep -lt 0) { $hostStep = $uninstall.Text.IndexOf('- delete the registry key') }
            $taskStep = $uninstall.Text.IndexOf('task to unregister')
            if ($taskStep -lt 0) { $taskStep = $uninstall.Text.IndexOf('- unregister the task') }
            Assert-That -Name 'uninstall-autostart.ps1 -DryRun exits 0, lists the host keys and folder, changes nothing' -Condition (
                $uninstall.ExitCode -eq 0 -and $uninstall.Text.Contains('Dry run complete: nothing was stopped or removed.') -and
                $uninstall.Text.Contains('Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher') -and
                $uninstall.Text.Contains('Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher') -and
                $uninstall.Text.Contains((Get-HbNativeHostDir))) -Detail $uninstall.Text
            Assert-That -Name 'uninstall-autostart.ps1 removes the native host before it stops and unregisters the task' -Condition (
                $hostStep -ge 0 -and $taskStep -gt $hostStep) -Detail $uninstall.Text

            $status = & $run 'status.ps1' @('-Port', "$(Get-FreePort)")
            Assert-That -Name 'status.ps1 exits 1 when nothing answers and reports both native host registrations' -Condition (
                $status.ExitCode -eq 1 -and $status.Text.Contains('nothing is listening') -and $status.Text.Contains('Supervisor log') -and
                $status.Text.Contains('Host (Chrome)') -and $status.Text.Contains('Host (Edge)') -and $status.Text.Contains('Extension ID')) -Detail $status.Text

            if ($null -eq (Get-HbTask)) {
                # Without the task, status checks the configuration this window would start with.
                $statusBadConfig = Invoke-WithProcessEnv @{ PORTLY_BIND = 'not-an-ip' } { & $run 'status.ps1' @('-Port', "$(Get-FreePort)") }
                Assert-That -Name 'status.ps1 reports an invalid PORTLY_* configuration' -Condition (
                    $statusBadConfig.ExitCode -eq 1 -and $statusBadConfig.Text -match 'INVALID - PORTLY_BIND') -Detail $statusBadConfig.Text
            }

            $statusOk = & $run 'status.ps1' @('-Port', "$($ports.ok)")
            Assert-That -Name 'status.ps1 exits 0 when Portly answers' -Condition (
                $statusOk.ExitCode -eq 0 -and $statusOk.Text.Contains('OK - running at') -and $statusOk.Text.Contains('vault is locked')) -Detail $statusOk.Text

            $statusView = & $run 'status.ps1' @('-Port', "$($ports.ok)", '-View', 'Status')
            $healthAt = $statusView.Text.IndexOf('Health')
            Assert-That -Name 'status.ps1 -View Status starts with Health and leaves out the settings' -Condition (
                $statusView.ExitCode -eq 0 -and $healthAt -ge 0 -and $healthAt -lt $statusView.Text.IndexOf('Processes') -and
                -not $statusView.Text.Contains('Data folder') -and -not $statusView.Text.Contains('Portly settings')) -Detail $statusView.Text

            $statusOther = & $run 'status.ps1' @('-Port', "$($ports.notJson)")
            Assert-That -Name 'status.ps1 names another program on the port' -Condition (
                $statusOther.ExitCode -eq 1 -and $statusOther.Text.Contains("node (PID $($fixture.Id))")) -Detail $statusOther.Text

            $badPort = & $run 'status.ps1' @('-Port', '80')
            Assert-That -Name 'status.ps1 validates -Port' -Condition ($badPort.ExitCode -ne 0) -Detail $badPort.Text

            $startConflict = & $run 'start.ps1' @('-Rebuild', '-NoBuild')
            Assert-That -Name 'start.ps1 rejects -Rebuild with -NoBuild' -Condition (
                $startConflict.ExitCode -eq 1 -and $startConflict.Text.Contains('cannot be used together')) -Detail $startConflict.Text

            # These two expect start.ps1 to refuse a port the fixture holds. Were the fixture gone,
            # start.ps1 would start a real Portly on that port (with the real data folder), so
            # they only run while it is alive.
            if ($fixture.HasExited) {
                Assert-That -Name 'start.ps1 port checks: the health fixture is still running' -Condition $false -Detail (
                    "the fixture exited (code $($fixture.ExitCode)); start.ps1 was not run, so no real Portly was started")
            } else {
                $startRunning = & $run 'start.ps1' @('-Port', "$($ports.ok)", '-NoBuild')
                Assert-That -Name 'start.ps1 refuses to start a second Portly' -Condition (
                    $startRunning.ExitCode -eq 3 -and $startRunning.Text.Contains('Portly is already running')) -Detail $startRunning.Text

                $startBusy = & $run 'start.ps1' @('-Port', "$($ports.notJson)", '-NoBuild')
                Assert-That -Name 'start.ps1 refuses a port used by another program' -Condition (
                    $startBusy.ExitCode -eq 3 -and $startBusy.Text.Contains("already in use by node (PID $($fixture.Id))")) -Detail $startBusy.Text
            }

            # setup.ps1 -DryRun from this checkout: -PagesUrl is checked and only printed (the user
            # environment variable is compared before and after).
            $setupDryArgs = @('-DryRun', '-NoBrowser', '-SkipAutostart', '-SkipCli', '-PagesUrl')
            $pagesBefore = [System.Environment]::GetEnvironmentVariable('PORTLY_PAGES_URL', 'User')
            $setupDry = & $run 'setup.ps1' ($setupDryArgs + @('https://Me.GitHub.io/portly'))
            Assert-That -Name 'setup.ps1 -DryRun -PagesUrl prints the normalised address and changes nothing' -Condition (
                $setupDry.ExitCode -eq 0 -and $setupDry.Text.Contains('PORTLY_PAGES_URL = https://me.github.io/portly/') -and
                $setupDry.Text.Contains('Dry run finished; nothing was changed.')) -Detail $setupDry.Text
            $setupOff = & $run 'setup.ps1' ($setupDryArgs + @('off'))
            Assert-That -Name 'setup.ps1 -DryRun -PagesUrl off says it removes the variable' -Condition (
                $setupOff.ExitCode -eq 0 -and $setupOff.Text.Contains('removing the user environment variable PORTLY_PAGES_URL')) -Detail $setupOff.Text
            foreach ($badPages in @('http://me.github.io/', 'me.github.io', 'https://me.github.io/?x=1', 'https://user:pw@me.github.io/')) {
                $setupBad = & $run 'setup.ps1' ($setupDryArgs + @($badPages))
                Assert-That -Name "setup.ps1 refuses -PagesUrl '$badPages' before installing anything" -Condition (
                    $setupBad.ExitCode -eq 1 -and $setupBad.Text.Contains('-PagesUrl must be') -and
                    -not $setupBad.Text.Contains('Installing dependencies')) -Detail $setupBad.Text
            }
            Assert-That -Name 'setup.ps1 -DryRun left the user environment variable PORTLY_PAGES_URL alone' -Condition (
                [System.Environment]::GetEnvironmentVariable('PORTLY_PAGES_URL', 'User') -ceq $pagesBefore)

            # publish-static.ps1: argument checks and the dry run, against folders under $workDir only
            # (-DryRun never builds, commits or pushes).
            $notRepo = Join-Path $workDir "publish-not-a-repo-$label"
            $null = New-Item -ItemType Directory -Path $notRepo -Force
            $publishNotRepo = & $run 'publish-static.ps1' @('-PublicRepoPath', $notRepo, '-DryRun')
            Assert-That -Name 'publish-static.ps1 refuses a target that is not a git repository' -Condition (
                $publishNotRepo.ExitCode -eq 1 -and $publishNotRepo.Text.Contains('is not a git repository')) -Detail $publishNotRepo.Text
            $publishSelf = & $run 'publish-static.ps1' @('-PublicRepoPath', $repoRoot, '-DryRun')
            Assert-That -Name 'publish-static.ps1 refuses the Portly repository itself' -Condition (
                $publishSelf.ExitCode -eq 1 -and $publishSelf.Text.Contains('Portly repository itself')) -Detail $publishSelf.Text
            $publishBadBase = & $run 'publish-static.ps1' @('-PublicRepoPath', $notRepo, '-Base', 'pages', '-DryRun')
            Assert-That -Name 'publish-static.ps1 validates -Base (must start and end with /)' -Condition (
                $publishBadBase.ExitCode -eq 1 -and $publishBadBase.Text.Contains('must start and end with')) -Detail $publishBadBase.Text
            $checkGit = Get-Command -Name 'git.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($null -ne $checkGit) {
                $gitIn = {
                    param([string]$Repo, [string[]]$Arguments)
                    $previous = $ErrorActionPreference
                    $ErrorActionPreference = 'Continue'
                    try { return (@(& $checkGit.Source -C $Repo @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n") } finally { $ErrorActionPreference = $previous }
                }
                $gitStatus = { param([string]$Repo) & $gitIn $Repo @('status', '--porcelain', '--untracked-files=all') }
                # A throwaway repository under $workDir with these files committed (none: just `git init`)
                # stands in for the public Pages clone.
                $newPagesRepo = {
                    param([string]$Name, [hashtable]$Files)
                    $repo = Join-Path $workDir "$Name-$label"
                    $null = New-Item -ItemType Directory -Path $repo -Force
                    $null = & $gitIn $repo @('init', '-q', '-b', 'main')
                    $null = & $gitIn $repo @('config', 'user.email', 'check@example.invalid')
                    $null = & $gitIn $repo @('config', 'user.name', 'check-scripts')
                    if ($Files.Count -gt 0) {
                        foreach ($path in $Files.Keys) {
                            $full = Join-Path $repo $path
                            $null = New-Item -ItemType Directory -Path (Split-Path -Parent $full) -Force
                            [System.IO.File]::WriteAllText($full, $Files[$path])
                        }
                        $null = & $gitIn $repo @('add', '-A')
                        $null = & $gitIn $repo @('commit', '-q', '-m', 'existing content')
                    }
                    return $repo
                }
                # (Windows PowerShell may wrap long lines; compare with whitespace collapsed.)
                $flat = { param([string]$Text) $Text -replace '\s+', ' ' }

                # An earlier publish from before the rename to Portly (Homebase's marker) that also
                # carries install.ps1 and setup.ps1: still a publish of this app.
                $legacyIndex = '<!doctype html><html><head><meta name="homebase-build" content="static"><script type="module" src="/pages/assets/app.js"></script></head></html>'
                $legacyRepo = & $newPagesRepo 'publish-legacy' @{ 'index.html' = $legacyIndex; 'assets/app.js' = 'app'; 'install.ps1' = 'x'; 'setup.ps1' = 'x' }
                $publishLegacy = & $run 'publish-static.ps1' @('-PublicRepoPath', $legacyRepo, '-Base', '/pages/', '-DryRun', '-NoPush')
                Assert-That -Name 'publish-static.ps1 -DryRun accepts an earlier publish from before the rename (homebase-build, install.ps1, setup.ps1)' -Condition (
                    $publishLegacy.ExitCode -eq 0 -and $publishLegacy.Text.Contains('- install.ps1') -and $publishLegacy.Text.Contains('- setup.ps1')) -Detail $publishLegacy.Text

                # An earlier Portly publish (index.html with the build marker, assets\, .nojekyll) plus a CNAME.
                $markerIndex = '<!doctype html><html><head><meta name="portly-build" content="static"><script type="module" src="/pages/assets/app.js"></script></head></html>'
                $pagesRepo = & $newPagesRepo 'publish-pages' @{ 'index.html' = $markerIndex; 'assets/app.js' = 'app'; '.nojekyll' = ''; 'CNAME' = 'portly.example.invalid' }
                $pagesStatusBefore = & $gitStatus $pagesRepo
                $publishDry = & $run 'publish-static.ps1' @('-PublicRepoPath', $pagesRepo, '-Base', '/pages/', '-DryRun', '-NoPush')
                $pagesStatusAfter = & $gitStatus $pagesRepo
                Assert-That -Name 'publish-static.ps1 -DryRun on an earlier Portly publish exits 0, prints the plan (base, files to remove, kept CNAME, commit, no push) and changes nothing' -Condition (
                    $publishDry.ExitCode -eq 0 -and $publishDry.Text.Contains('PORTLY_STATIC_BASE=/pages/') -and
                    $publishDry.Text.Contains('- index.html') -and $publishDry.Text.Contains('- assets/app.js') -and $publishDry.Text.Contains('- .nojekyll') -and
                    $publishDry.Text.Contains('3 tracked file(s); kept: CNAME') -and
                    $publishDry.Text.Contains('Publish Portly ') -and $publishDry.Text.Contains('skipped (-NoPush)') -and
                    $publishDry.Text.Contains('Dry run complete: nothing was built, copied, committed or pushed.') -and
                    $pagesStatusBefore -eq '' -and $pagesStatusAfter -eq '' -and (Test-Path -LiteralPath (Join-Path $pagesRepo 'index.html') -PathType Leaf)) -Detail $publishDry.Text
                $publishNoRemote = & $run 'publish-static.ps1' @('-PublicRepoPath', $pagesRepo, '-DryRun')
                Assert-That -Name 'publish-static.ps1 refuses to plan a push when the target has no remote' -Condition (
                    $publishNoRemote.ExitCode -eq 1 -and $publishNoRemote.Text.Contains('nothing to push to')) -Detail $publishNoRemote.Text

                # Another site's repository (homebase-site, <user>.github.io): never emptied without -ReplaceEverything.
                $foreignRepo = & $newPagesRepo 'publish-foreign' @{ 'index.html' = '<html>my site</html>'; 'privacy.html' = 'privacy'; 'README.md' = 'readme' }
                $publishForeign = & $run 'publish-static.ps1' @('-PublicRepoPath', $foreignRepo, '-DryRun', '-NoPush')
                $foreignText = & $flat $publishForeign.Text
                Assert-That -Name 'publish-static.ps1 refuses a repository holding files that are not a Portly publish (privacy.html), also in -DryRun' -Condition (
                    $publishForeign.ExitCode -eq 1 -and $foreignText.Contains('neither empty nor an earlier Portly publish') -and
                    $foreignText.Contains('privacy.html') -and $foreignText.Contains('-ReplaceEverything') -and -not $foreignText.Contains('Dry run complete')) -Detail $publishForeign.Text
                $publishReplace = & $run 'publish-static.ps1' @('-PublicRepoPath', $foreignRepo, '-DryRun', '-NoPush', '-ReplaceEverything')
                Assert-That -Name 'publish-static.ps1 -ReplaceEverything accepts it and lists every file it would delete (README.md kept)' -Condition (
                    $publishReplace.ExitCode -eq 0 -and $publishReplace.Text.Contains('- privacy.html') -and $publishReplace.Text.Contains('- index.html') -and
                    $publishReplace.Text.Contains('2 tracked file(s); kept: README.md') -and (& $gitStatus $foreignRepo) -eq '' -and
                    (Test-Path -LiteralPath (Join-Path $foreignRepo 'privacy.html') -PathType Leaf)) -Detail $publishReplace.Text
                $otherBuild = & $newPagesRepo 'publish-other-build' @{ 'index.html' = '<html><script src="/assets/app.js"></script></html>'; 'assets/app.js' = 'app' }
                $publishOther = & $run 'publish-static.ps1' @('-PublicRepoPath', $otherBuild, '-DryRun', '-NoPush')
                Assert-That -Name 'publish-static.ps1 refuses index.html + assets\ without the portly-build marker' -Condition (
                    $publishOther.ExitCode -eq 1 -and (& $flat $publishOther.Text).Contains('is not a Portly build')) -Detail $publishOther.Text

                # A new, empty repository (no commit yet) is fine.
                $emptyRepo = & $newPagesRepo 'publish-empty' @{}
                $publishEmpty = & $run 'publish-static.ps1' @('-PublicRepoPath', $emptyRepo, '-DryRun', '-NoPush')
                Assert-That -Name 'publish-static.ps1 -DryRun accepts a new, empty repository (unborn branch)' -Condition (
                    $publishEmpty.ExitCode -eq 0 -and $publishEmpty.Text.Contains('branch main') -and $publishEmpty.Text.Contains('0 tracked file(s)')) -Detail $publishEmpty.Text

                # -Base must match the github.com repository: /<repo>/ for a project site, / for <user>.github.io.
                $null = & $gitIn $emptyRepo @('remote', 'add', 'origin', 'https://github.com/example/portly-pages.git')
                $publishRootBase = & $run 'publish-static.ps1' @('-PublicRepoPath', $emptyRepo, '-Base', '/', '-DryRun')
                Assert-That -Name 'publish-static.ps1 refuses -Base / for the project repository example/portly-pages' -Condition (
                    $publishRootBase.ExitCode -eq 1 -and (& $flat $publishRootBase.Text).Contains('-Base must be /portly-pages/ (got /)')) -Detail $publishRootBase.Text
                $publishProjectBase = & $run 'publish-static.ps1' @('-PublicRepoPath', $emptyRepo, '-Base', '/portly-pages/', '-DryRun')
                Assert-That -Name 'publish-static.ps1 accepts -Base /portly-pages/ there and plans the push and the site URL' -Condition (
                    $publishProjectBase.ExitCode -eq 0 -and $publishProjectBase.Text.Contains('git push -u origin main') -and
                    $publishProjectBase.Text.Contains('https://example.github.io/portly-pages/')) -Detail $publishProjectBase.Text
                $null = & $gitIn $emptyRepo @('remote', 'set-url', 'origin', 'git@github.com:Example/Example.github.io.git')
                $publishUserSite = & $run 'publish-static.ps1' @('-PublicRepoPath', $emptyRepo, '-Base', '/pages/', '-DryRun')
                $publishUserRoot = & $run 'publish-static.ps1' @('-PublicRepoPath', $emptyRepo, '-Base', '/', '-DryRun')
                Assert-That -Name 'publish-static.ps1 wants -Base / for a <user>.github.io repository' -Condition (
                    $publishUserSite.ExitCode -eq 1 -and (& $flat $publishUserSite.Text).Contains('-Base must be / (got /pages/)') -and
                    $publishUserRoot.ExitCode -eq 0) -Detail "$($publishUserSite.Text)`n$($publishUserRoot.Text)"
                $null = & $gitIn $pagesRepo @('remote', 'add', 'origin', 'https://github.com/example/portly-pages.git')
                $publishCustomDomain = & $run 'publish-static.ps1' @('-PublicRepoPath', $pagesRepo, '-Base', '/', '-DryRun')
                Assert-That -Name 'publish-static.ps1 accepts -Base / for a repository with a CNAME file (custom domain)' -Condition (
                    $publishCustomDomain.ExitCode -eq 0) -Detail $publishCustomDomain.Text

                # -DryRun before the first build: a copy of the script in a scratch checkout without web\dist-static.
                $unbuilt = Join-Path $workDir "publish-unbuilt-$label"
                $null = New-Item -ItemType Directory -Path (Join-Path $unbuilt 'scripts\lib') -Force
                $null = New-Item -ItemType Directory -Path (Join-Path $unbuilt 'web') -Force
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'publish-static.ps1') -Destination (Join-Path $unbuilt 'scripts')
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lib\Common.ps1') -Destination (Join-Path $unbuilt 'scripts\lib')
                [System.IO.File]::WriteAllText((Join-Path $unbuilt 'web\vite.config.ts'), '// stub')
                [System.IO.File]::WriteAllText((Join-Path $unbuilt 'package.json'), '{"version":"0.0.0-check"}')
                $publishUnbuilt = & $run (Join-Path $unbuilt 'scripts\publish-static.ps1') @('-PublicRepoPath', $pagesRepo, '-Base', '/pages/', '-DryRun', '-NoPush')
                Assert-That -Name 'publish-static.ps1 -DryRun works before the first build (no web\dist-static yet)' -Condition (
                    $publishUnbuilt.ExitCode -eq 0 -and $publishUnbuilt.Text.Contains('not built yet; the build creates it') -and
                    $publishUnbuilt.Text.Contains('Publish Portly 0.0.0-check')) -Detail $publishUnbuilt.Text

                [System.IO.File]::WriteAllText((Join-Path $pagesRepo 'untracked.txt'), 'x')
                $publishDirty = & $run 'publish-static.ps1' @('-PublicRepoPath', $pagesRepo, '-DryRun', '-NoPush')
                Assert-That -Name 'publish-static.ps1 refuses a target with untracked or uncommitted files' -Condition (
                    $publishDirty.ExitCode -eq 1 -and $publishDirty.Text.Contains('uncommitted changes or untracked files')) -Detail $publishDirty.Text
            }

            # update.ps1: copies in scratch checkouts, -DryRun only.
            $updateCopies = @{ plain = (Join-Path $workDir "update-$label"); worktree = (Join-Path $workDir "update-$label\.claude\worktrees\wt") }
            foreach ($copy in $updateCopies.Values) {
                $null = New-Item -ItemType Directory -Path (Join-Path $copy 'scripts\lib') -Force
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update.ps1') -Destination (Join-Path $copy 'scripts')
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lib\Common.ps1') -Destination (Join-Path $copy 'scripts\lib')
                [System.IO.File]::WriteAllText((Join-Path $copy 'package-lock.json'), '{}')
            }
            $updateWorktree = & $run (Join-Path $updateCopies.worktree 'scripts\update.ps1') @('-DryRun', '-SkipPublish')
            Assert-That -Name 'update.ps1 refuses to run from a .claude\worktrees checkout' -Condition (
                $updateWorktree.ExitCode -eq 1 -and $updateWorktree.Text.Contains('temporary worktree')) -Detail $updateWorktree.Text
            $updateDry = & $run (Join-Path $updateCopies.plain 'scripts\update.ps1') @('-DryRun', '-SkipPublish', '-SkipServer')
            Assert-That -Name 'update.ps1 -DryRun plans npm ci and the web build and runs nothing' -Condition (
                $updateDry.ExitCode -eq 0 -and $updateDry.Text.Contains('[dry run] Installing dependencies') -and
                $updateDry.Text.Contains('[dry run] Building the local page') -and
                -not (Test-Path -LiteralPath (Join-Path $updateCopies.plain 'node_modules'))) -Detail $updateDry.Text

            # The portly command and its installer (-DryRun only; the PATH is never written here).
            foreach ($copy in $updateCopies.Values) {
                foreach ($name in @('portly.ps1', 'install-cli.ps1', 'status.ps1')) {
                    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $copy 'scripts')
                }
            }
            $cliHelp = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--help')
            Assert-That -Name 'portly --help prints the usage and exits 0' -Condition (
                $cliHelp.ExitCode -eq 0 -and $cliHelp.Text.Contains('Usage: portly') -and $cliHelp.Text.Contains('--rebuild')) -Detail $cliHelp.Text
            $cliUnknown = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--bogus')
            $cliBadOption = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--rebuild', '--nope')
            Assert-That -Name 'portly rejects an unknown command or option with exit code 2' -Condition (
                $cliUnknown.ExitCode -eq 2 -and $cliBadOption.ExitCode -eq 2 -and $cliBadOption.Text.Contains("Unknown option '--nope'")) -Detail "$($cliUnknown.Text)`n$($cliBadOption.Text)"
            # Only refusals: a real --copy-from-homebase would act on the user's own data folder.
            $cliCopyBad = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--copy-from-homebase', '--nope')
            $cliCopyBoth = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--copy-from-homebase', '--replace', '--cancel')
            Assert-That -Name 'portly --copy-from-homebase refuses an unknown option, and --replace with --cancel (exit 2)' -Condition (
                $cliCopyBad.ExitCode -eq 2 -and $cliCopyBoth.ExitCode -eq 2 -and $cliCopyBoth.Text.Contains('not both') -and
                $cliHelp.Text.Contains('--copy-from-homebase')) -Detail "$($cliCopyBad.Text)`n$($cliCopyBoth.Text)"
            $cliSettings = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--settings')
            Assert-That -Name 'portly --settings shows only the settings section and exits 0' -Condition (
                $cliSettings.ExitCode -eq 0 -and $cliSettings.Text.Contains('Portly settings') -and $cliSettings.Text.Contains('Data folder') -and
                $cliSettings.Text.Contains('Pages repo') -and -not $cliSettings.Text.Contains('Health')) -Detail $cliSettings.Text
            $cliRebuild = & $run (Join-Path $updateCopies.plain 'scripts\portly.ps1') @('--rebuild', '--dry-run', '--skip-publish', '--skip-server')
            Assert-That -Name 'portly --rebuild --dry-run passes its options to update.ps1' -Condition (
                $cliRebuild.ExitCode -eq 0 -and $cliRebuild.Text.Contains('[dry run] Building the local page')) -Detail $cliRebuild.Text
            $cliRebuildWorktree = & $run (Join-Path $updateCopies.worktree 'scripts\portly.ps1') @('--rebuild', '--dry-run')
            Assert-That -Name 'portly --rebuild passes update.ps1 exit code through (worktree refused: 1)' -Condition (
                $cliRebuildWorktree.ExitCode -eq 1 -and $cliRebuildWorktree.Text.Contains('temporary worktree')) -Detail $cliRebuildWorktree.Text
            $cliInstallWorktree = & $run (Join-Path $updateCopies.worktree 'scripts\install-cli.ps1') @('-DryRun')
            Assert-That -Name 'install-cli.ps1 refuses to point the command into a .claude\worktrees checkout' -Condition (
                $cliInstallWorktree.ExitCode -eq 1 -and $cliInstallWorktree.Text.Contains('temporary worktree')) -Detail $cliInstallWorktree.Text
            $cliInstallDry = & $run (Join-Path $updateCopies.plain 'scripts\install-cli.ps1') @('-DryRun')
            $cliLauncher = Join-Path $updateCopies.plain 'scripts\portly.ps1'
            Assert-That -Name 'install-cli.ps1 -DryRun shows both launchers pointing at this checkout and writes nothing' -Condition (
                $cliInstallDry.ExitCode -eq 0 -and $cliInstallDry.Text.Contains("-File `"$cliLauncher`" %*") -and
                $cliInstallDry.Text.Contains("-File '$cliLauncher' `"`$@`"") -and $cliInstallDry.Text.Contains('[dry run] Writing')) -Detail $cliInstallDry.Text
            $cliUninstallDry = & $run (Join-Path $updateCopies.plain 'scripts\install-cli.ps1') @('-Uninstall', '-DryRun')
            Assert-That -Name 'install-cli.ps1 -Uninstall -DryRun exits 0' -Condition ($cliUninstallDry.ExitCode -eq 0) -Detail $cliUninstallDry.Text
        }

        $after = & $snapshot
        Assert-That -Name 'the scheduled task, the native host registry keys and the native host folder are unchanged' -Condition ($before -ceq $after) -Detail "$before`n-> $after"
    }
} finally {
    $fixture.StandardInput.Close()
    if (-not $fixture.WaitForExit(5000)) { $fixture.Kill() }
    try { Remove-HbFolderTree -Path $workDir } catch { Write-Warning "Could not remove $workDir : $($_.Exception.Message)" }
}

Write-Host ''
if ($script:failures.Count -gt 0) {
    Write-Host "$($script:failures.Count) check(s) failed, $script:passed passed." -ForegroundColor Red
    exit 1
}
Write-Host "All $script:passed checks passed." -ForegroundColor Green
exit 0
