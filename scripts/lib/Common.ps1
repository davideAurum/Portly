# Shared helpers for the Homebase PowerShell scripts (ARCHITECTURE section 12).
#
# Dot-source from a script in scripts\:   . (Join-Path $PSScriptRoot 'lib\Common.ps1')
#
# Works in Windows PowerShell 5.1 and PowerShell 7+. Keep this file ASCII-only: Windows
# PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

Set-StrictMode -Version 3.0

$HomebaseTaskName = 'Homebase Server'
$HomebaseTaskPath = '\'
$HomebaseDefaultPort = 5757
$HomebaseMinNodeMajor = 24
$HomebaseTaskDescriptions = @{
    Browser = 'Starts the Homebase server (server\src\supervisor.ts) when Chrome or Edge asks for it through the Homebase extension (native host com.homebase.launcher). No logon trigger. Installed by scripts\install-autostart.ps1.'
    Logon   = 'Starts the Homebase server (server\src\supervisor.ts) at logon. Installed by scripts\install-autostart.ps1.'
}
# Native messaging host (ARCHITECTURE section 12): the extension asks it to run the task.
$HomebaseNativeHostName = 'com.homebase.launcher'
$HomebaseNativeHostDescription = 'Homebase launcher (starts the Homebase Server scheduled task)'
$HomebaseNativeHostRegistry = @(
    [pscustomobject]@{ Browser = 'Chrome'; SubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.homebase.launcher' }
    [pscustomobject]@{ Browser = 'Edge'; SubKey = 'Software\Microsoft\Edge\NativeMessagingHosts\com.homebase.launcher' }
)
$HomebaseNodePlaceholder = '{{NODE_EXE}}'
# Every environment variable server/src/config.ts reads.
$HomebaseEnvNames = @('HOMEBASE_PORT', 'HOMEBASE_BIND', 'HOMEBASE_ORIGIN', 'HOMEBASE_DATA_DIR', 'HOMEBASE_DEV', 'HOMEBASE_VITE_PORT', 'HOMEBASE_PAGES_URL', 'HOMEBASE_LOG_LEVEL')

# --------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------

function Write-HbStep {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-HbOk {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-HbInfo {
    param([string]$Message = '')
    Write-Host "    $Message"
}

function Write-HbField {
    param([Parameter(Mandatory)][string]$Name, [AllowEmptyString()][string]$Value)
    Write-Host ('  {0,-15}: {1}' -f $Name, $Value)
}

function Write-HbFailure {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
}

# --------------------------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------------------------

function Test-HbWindows {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Get-HbRepoRoot {
    param([Parameter(Mandatory)][string]$ScriptRoot)
    return [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..'))
}

# Session worktrees (.claude\worktrees\<name>) are deleted when their session ends, so nothing
# long-lived (builds, the homebase command) may point into one.
function Test-HbWorktreePath {
    param([Parameter(Mandatory)][string]$Path)
    return $Path -match '\\\.claude\\worktrees\\'
}

# Property value or $null (safe under Set-StrictMode for objects from ConvertFrom-Json).
function Get-HbProperty {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-HbExceptionChain {
    param($ErrorOrException)
    $exception = $ErrorOrException
    if ($exception -is [System.Management.Automation.ErrorRecord]) { $exception = $exception.Exception }
    $chain = New-Object System.Collections.Generic.List[System.Exception]
    while ($null -ne $exception -and $chain.Count -lt 16) {
        $chain.Add($exception)
        $exception = $exception.InnerException
    }
    return $chain.ToArray()
}

# True when an error is Windows' "Access is denied" (HRESULT 0x80070005).
function Test-HbAccessDenied {
    param($ErrorOrException)
    if ($null -eq $ErrorOrException) { return $false }
    if ($ErrorOrException -is [System.Management.Automation.ErrorRecord]) {
        if ("$($ErrorOrException.FullyQualifiedErrorId)" -match '0x80070005') { return $true }
    }
    foreach ($exception in @(Get-HbExceptionChain $ErrorOrException)) {
        if ($exception.HResult -eq -2147024891) { return $true }
        if ($exception -is [System.UnauthorizedAccessException]) { return $true }
        if ("$($exception.Message)" -match 'Access is denied|0x80070005') { return $true }
    }
    return $false
}

function Write-HbAccessDeniedHint {
    param([Parameter(Mandatory)][string]$ScriptPath, [string]$Arguments = '')
    Write-HbFailure 'Windows denied access (0x80070005) while managing the scheduled task.'
    Write-Host ''
    Write-Host 'Open PowerShell as administrator (Start > type "PowerShell" > Run as administrator) and run:' -ForegroundColor Yellow
    Write-Host ''
    $command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    if ($Arguments) { $command = "$command $Arguments" }
    Write-Host "    $command"
    Write-Host ''
    Write-Host 'The task still runs as your own user with normal (non-elevated) rights; administrator'
    Write-Host 'rights are only needed to change its registration.'
}

# --------------------------------------------------------------------------------------------
# Configuration (mirrors server/src/config.ts)
# --------------------------------------------------------------------------------------------

# Environment value as the current process sees it ('Process') or as the scheduled task will
# see it at logon ('Task': the user variable, else the machine variable).
function Get-HbEnvValue {
    param(
        [Parameter(Mandatory)][string]$Name,
        [ValidateSet('Process', 'Task')][string]$Scope = 'Process'
    )
    if ($Scope -eq 'Process') {
        $value = [System.Environment]::GetEnvironmentVariable($Name, 'Process')
    } else {
        $value = [System.Environment]::GetEnvironmentVariable($Name, 'User')
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = [System.Environment]::GetEnvironmentVariable($Name, 'Machine')
        }
    }
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value.Trim()
}

# Same rule as the server: an integer 1-65535, digits only.
function ConvertTo-HbPort {
    param([AllowNull()][AllowEmptyString()][string]$Value, [string]$Source = 'port')
    $trimmed = "$Value".Trim()
    if ($trimmed -notmatch '^[0-9]{1,5}$') {
        throw "$Source must be an integer from 1 to 65535 (got '$Value')."
    }
    $port = [int]$trimmed
    if ($port -lt 1 -or $port -gt 65535) {
        throw "$Source must be an integer from 1 to 65535 (got '$Value')."
    }
    return $port
}

function Get-HbPortSetting {
    param([ValidateSet('Process', 'Task')][string]$Scope = 'Process')
    $raw = Get-HbEnvValue -Name 'HOMEBASE_PORT' -Scope $Scope
    if ($null -eq $raw) {
        return [pscustomobject]@{ Port = $HomebaseDefaultPort; Source = 'default' }
    }
    $label = if ($Scope -eq 'Task') { 'HOMEBASE_PORT (user/machine environment variable)' } else { 'HOMEBASE_PORT' }
    return [pscustomobject]@{ Port = (ConvertTo-HbPort -Value $raw -Source $label); Source = $label }
}

# The server resolves a relative HOMEBASE_DATA_DIR against its working directory, which is the
# repository root for the task, start.ps1 and `npm start` - so the same is done here (never
# against this PowerShell process's .NET current directory).
function Get-HbDataDir {
    param(
        [ValidateSet('Process', 'Task')][string]$Scope = 'Process',
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $raw = Get-HbEnvValue -Name 'HOMEBASE_DATA_DIR' -Scope $Scope
    if ($null -ne $raw) {
        if (-not [System.IO.Path]::IsPathRooted($raw)) { $raw = Join-Path $RepoRoot $raw }
        return [System.IO.Path]::GetFullPath($raw)
    }
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    return (Join-Path $localAppData 'Homebase')
}

function Get-HbLogFile {
    param([Parameter(Mandatory)][string]$DataDir)
    return (Join-Path (Join-Path $DataDir 'logs') 'server.log')
}

# The supervisor (autostart) writes its own log next to server.log: restarts, "another Homebase
# is already running", and why it stopped.
function Get-HbSupervisorLogFile {
    param([Parameter(Mandatory)][string]$DataDir)
    return (Join-Path (Join-Path $DataDir 'logs') 'supervisor.log')
}

# HOMEBASE_* variables whose value in this PowerShell window differs from the user/machine
# environment the scheduled task gets at logon (e.g. `$env:HOMEBASE_PORT = ...` typed in this
# window only). Each item: Name, Process, Task (either may be $null).
function Get-HbEnvMismatches {
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($name in $HomebaseEnvNames) {
        $processValue = Get-HbEnvValue -Name $name -Scope Process
        $taskValue = Get-HbEnvValue -Name $name -Scope Task
        if ($processValue -cne $taskValue) {
            $result.Add([pscustomobject]@{ Name = $name; Process = $processValue; Task = $taskValue })
        }
    }
    return $result.ToArray()
}

# Loads server/src/config.ts with node exactly as the server does at startup (same HOMEBASE_*
# values for the scope, repository root as working directory), so a variable the server would
# reject is reported now instead of the autostarted server silently exiting at logon (its
# console output goes nowhere). $Override (name -> value, $null = unset) is for tests.
# Returns Ok, Error, Port, DataDir.
function Test-HbServerConfig {
    param(
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$RepoRoot,
        [ValidateSet('Process', 'Task')][string]$Scope = 'Process',
        [hashtable]$Override = @{}
    )
    $result = [pscustomobject]@{ Ok = $false; Error = $null; Port = $null; DataDir = $null }
    $configUrl = ([System.Uri](Join-Path $RepoRoot 'server\src\config.ts')).AbsoluteUri
    # The module is read from stdin: no quoting of script text on a command line.
    $script = @(
        "const { loadConfig } = await import($(ConvertTo-Json -InputObject $configUrl -Compress));",
        'let out;',
        'try { const c = loadConfig(); out = { ok: true, port: c.port, dataDir: c.dataDir }; }',
        'catch (err) { out = { ok: false, error: err instanceof Error ? err.message : String(err) }; }',
        'process.stdout.write(JSON.stringify(out) + "\n");'
    ) -join "`n"

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NodeExe
    $startInfo.Arguments = '--input-type=module -'
    $startInfo.WorkingDirectory = $RepoRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in $HomebaseEnvNames) {
        $value = if ($Override.ContainsKey($name)) { $Override[$name] } else { Get-HbEnvValue -Name $name -Scope $Scope }
        if ($null -eq $value) {
            $startInfo.EnvironmentVariables.Remove($name)
        } else {
            $startInfo.EnvironmentVariables[$name] = "$value"
        }
    }

    try {
        $process = [System.Diagnostics.Process]::Start($startInfo)
    } catch {
        $result.Error = "could not run '$NodeExe': $($_.Exception.Message)"
        return $result
    }
    try {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($script)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(20000)) {
            try { $process.Kill() } catch { }
            $result.Error = 'checking the configuration timed out'
            return $result
        }
        $lines = @("$($stdoutTask.GetAwaiter().GetResult())" -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
        $json = $null
        if ($lines.Count -gt 0) {
            try { $json = $lines[$lines.Count - 1] | ConvertFrom-Json } catch { $json = $null }
        }
        if ($null -eq $json) {
            $stderr = "$($stderrTask.GetAwaiter().GetResult())".Trim()
            $firstLine = if ($stderr) { ($stderr -split "`r?`n")[0] } else { "exit code $($process.ExitCode)" }
            $result.Error = "could not load server\src\config.ts ($firstLine)"
            return $result
        }
        if ((Get-HbProperty $json 'ok') -eq $true) {
            $result.Ok = $true
            $result.Port = [int](Get-HbProperty $json 'port')
            $result.DataDir = "$(Get-HbProperty $json 'dataDir')"
        } else {
            $result.Error = "$(Get-HbProperty $json 'error')"
        }
        return $result
    } finally {
        $process.Dispose()
    }
}

function Test-HbTruthy {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { return $false }
    return @('1', 'true', 'yes') -contains $Value.Trim().ToLowerInvariant()
}

# --------------------------------------------------------------------------------------------
# Health check (GET /api/health; exempt from the request gate)
# --------------------------------------------------------------------------------------------

# TCP listeners on a local port: @() when nothing listens, $null when this cannot be determined
# (no NetTCPIP module). Each item: Address, ProcessId.
function Get-HbPortListeners {
    param([Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port)
    if ($null -eq (Get-Command -Name 'Get-NetTCPConnection' -ErrorAction SilentlyContinue)) { return $null }
    $rows = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $listeners = @($rows | ForEach-Object { [pscustomobject]@{ Address = "$($_.LocalAddress)"; ProcessId = [int]$_.OwningProcess } })
    # The comma keeps an empty or one-item array intact (PowerShell would unroll it).
    return , $listeners
}

# "node (PID 1234), svchost (PID 99)" for the processes listening on a port.
function Format-HbPortOwners {
    param([AllowNull()][AllowEmptyCollection()][object[]]$Listeners)
    if ($null -eq $Listeners -or $Listeners.Count -eq 0) { return 'unknown' }
    $ids = @($Listeners | ForEach-Object { $_.ProcessId } | Sort-Object -Unique)
    $parts = foreach ($id in $ids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($null -ne $process) { "$($process.ProcessName) (PID $id)" } else { "PID $id" }
    }
    return ($parts -join ', ')
}

# GET /api/health. Windows takes about two seconds to report a refused loopback connection,
# so the listening socket is looked up first: nothing listening is reported immediately, and
# the request goes to 127.0.0.1 or [::1] depending on where the server listens.
function Test-HbHealth {
    param(
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [ValidateRange(0.1, 60)][double]$TimeoutSeconds = 2
    )
    $result = [pscustomobject]@{
        Ok        = $false
        Url       = "http://localhost:$Port/api/health"
        Version   = $null
        Vault     = $null
        Error     = $null
        Listeners = $null
    }
    $listeners = Get-HbPortListeners -Port $Port
    $result.Listeners = $listeners
    $address = '127.0.0.1'
    if ($null -ne $listeners) {
        if ($listeners.Count -eq 0) {
            $result.Error = "nothing is listening on port $Port"
            return $result
        }
        $ipv4 = @($listeners | Where-Object { $_.Address -eq '127.0.0.1' -or $_.Address -eq '0.0.0.0' })
        if ($ipv4.Count -eq 0) { $address = '[::1]' }
    }
    $requestUrl = "http://${address}:$Port/api/health"

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
    try {
        $client.Timeout = [System.TimeSpan]::FromSeconds($TimeoutSeconds)
        $response = $client.GetAsync($requestUrl).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $result.Error = "HTTP $([int]$response.StatusCode) (another program may be using port $Port)"
            return $result
        }
        try {
            $json = $body | ConvertFrom-Json
        } catch {
            $json = $null
        }
        $ok = Get-HbProperty $json 'ok'
        if (-not ($ok -is [bool] -and $ok)) {
            $result.Error = "the answer is not a Homebase health check (another program may be using port $Port)"
            return $result
        }
        $result.Ok = $true
        $result.Version = Get-HbProperty $json 'version'
        $result.Vault = Get-HbProperty $json 'vault'
        return $result
    } catch {
        $chain = @(Get-HbExceptionChain $_)
        $timedOut = @($chain | Where-Object { $_ -is [System.Threading.Tasks.TaskCanceledException] -or $_ -is [System.TimeoutException] }).Count -gt 0
        if ($timedOut) {
            $result.Error = "no answer within $TimeoutSeconds s"
        } elseif ($chain.Count -gt 0) {
            $result.Error = $chain[$chain.Count - 1].Message
        } else {
            $result.Error = "$_"
        }
        return $result
    } finally {
        $client.Dispose()
    }
}

# Polls /api/health once a second until it answers, the timeout passes, or $ContinueWhile
# returns false. Returns the last Test-HbHealth result.
function Wait-HbHealth {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [scriptblock]$ContinueWhile
    )
    $deadline = [System.DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $last = Test-HbHealth -Port $Port -TimeoutSeconds 2
        if ($last.Ok) { return $last }
        if ($null -ne $ContinueWhile -and -not (& $ContinueWhile)) { return $last }
        Start-Sleep -Milliseconds 1000
    } while ([System.DateTime]::UtcNow -lt $deadline)
    return $last
}

function Format-HbHealth {
    param([Parameter(Mandatory)]$Health)
    if ($Health.Ok) {
        $origin = $Health.Url -replace '/api/health$', ''
        $version = if ($Health.Version) { "version $($Health.Version)" } else { 'version unknown' }
        $vault = if ($Health.Vault) { "vault $($Health.Vault)" } else { 'vault unknown' }
        return "running at $origin ($version, $vault)"
    }
    return "not answering at $($Health.Url): $($Health.Error)"
}

# --------------------------------------------------------------------------------------------
# Node.js, npm and the web build
# --------------------------------------------------------------------------------------------

function Get-HbNodeVersion {
    param([Parameter(Mandatory)][string]$NodeExe)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $NodeExe -p 'process.versions.node'
        $exitCode = $LASTEXITCODE
    } catch {
        throw "Could not run '$NodeExe': $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $previous
    }
    $text = "$output".Trim()
    if ($exitCode -ne 0 -or $text -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') {
        throw "Could not read the Node.js version from '$NodeExe' (exit code $exitCode)."
    }
    return $text
}

# Resolves node.exe (explicit path, else the release's own runtime\node.exe under $RepoRoot, else
# PATH) and checks it is Node.js 24 or newer.
function Resolve-HbNode {
    param([string]$NodePath, [string]$RepoRoot)
    if ([string]::IsNullOrWhiteSpace($NodePath) -and -not [string]::IsNullOrWhiteSpace($RepoRoot)) {
        $bundled = Get-HbBundledNode -RepoRoot $RepoRoot
        if ($null -ne $bundled) { $NodePath = $bundled }
    }
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $command = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) {
            throw "node.exe was not found on PATH. Install Node.js $HomebaseMinNodeMajor or newer from https://nodejs.org/ (or pass -NodePath)."
        }
        $NodePath = $command.Source
    }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw "Node.js executable not found: $NodePath"
    }
    $full = (Resolve-Path -LiteralPath $NodePath).ProviderPath
    $version = Get-HbNodeVersion -NodeExe $full
    $major = [int]($version.Split('.')[0])
    if ($major -lt $HomebaseMinNodeMajor) {
        throw "Homebase needs Node.js $HomebaseMinNodeMajor or newer, but $full is v$version."
    }
    $temporary = $full -match '\\fnm_multishells\\' -or
        $full.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)
    return [pscustomobject]@{ Path = $full; Version = $version; LooksTemporary = $temporary }
}

# --------------------------------------------------------------------------------------------
# Release installs (scripts\install.ps1, docs\setup\releases.md)
# --------------------------------------------------------------------------------------------

# A release package carries release.json at its root and its own Node.js in runtime\node.exe; a
# Git checkout has neither.
function Get-HbReleaseInfo {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $path = Join-Path $RepoRoot 'release.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $info = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    } catch {
        throw "$path is not valid JSON: $($_.Exception.Message)"
    }
    if ((Get-HbProperty $info 'name') -ne 'homebase' -or [string]::IsNullOrWhiteSpace("$(Get-HbProperty $info 'version')")) {
        throw "$path does not describe a Homebase release."
    }
    return $info
}

function Get-HbBundledNode {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $path = Join-Path $RepoRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    return $null
}

# The attributes of the entry itself (a link is not followed, so a link whose target is gone still
# counts), or $null when there is nothing at $Path.
function Get-HbEntryAttributes {
    param([Parameter(Mandatory)][string]$Path)
    try { return [System.IO.File]::GetAttributes($Path) } catch { return $null }
}

# Removes a directory junction (or symbolic link) itself, never what it points to.
function Remove-HbDirectoryLink {
    param([Parameter(Mandatory)][string]$Path)
    $attributes = Get-HbEntryAttributes -Path $Path
    if ($null -eq $attributes) { return }
    if (-not ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "$Path is a real folder, not a link; not removing it."
    }
    # Non-recursive Directory.Delete removes the reparse point only.
    [System.IO.Directory]::Delete($Path)
}

# The server imports @homebase/shared, which npm links into node_modules in a checkout. A release
# package cannot carry that link (zip files have no junctions), so the installer creates it once
# the package sits in its final folder: node_modules\@homebase\shared -> <RepoRoot>\shared. A
# junction needs no administrator rights; Node resolves it to shared\src, outside node_modules, so
# it still strips the TypeScript types there. Idempotent.
function Initialize-HbReleaseLinks {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $target = Join-Path $RepoRoot 'shared'
    if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf)) {
        throw "$target\package.json is missing: not a complete Homebase package."
    }
    $scope = Join-Path $RepoRoot 'node_modules\@homebase'
    if (-not (Test-Path -LiteralPath $scope)) { $null = New-Item -ItemType Directory -Path $scope -Force }
    $link = Join-Path $scope 'shared'
    $attributes = Get-HbEntryAttributes -Path $link
    if ($null -ne $attributes) {
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $current = @(Get-HbProperty (Get-Item -LiteralPath $link -Force) 'Target') | Select-Object -First 1
            if ($current -and [System.IO.Path]::GetFullPath("$current").TrimEnd('\') -ieq $target.TrimEnd('\') -and
                (Test-Path -LiteralPath (Join-Path $link 'package.json') -PathType Leaf)) {
                return $link
            }
        }
        Remove-HbDirectoryLink -Path $link
    }
    $null = New-Item -ItemType Junction -Path $link -Target $target
    return $link
}

function Test-HbWebBuilt {
    param([Parameter(Mandatory)][string]$RepoRoot)
    return Test-Path -LiteralPath (Join-Path $RepoRoot 'web\dist\index.html') -PathType Leaf
}

function Test-HbDependenciesInstalled {
    param([Parameter(Mandatory)][string]$RepoRoot)
    return Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\hono\package.json') -PathType Leaf
}

# Runs `npm run build` in the repository (builds web\dist).
function Invoke-HbWebBuild {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $npm) {
        throw 'npm.cmd was not found on PATH (it is installed with Node.js).'
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $RepoRoot
    try {
        & $npm.Source run build | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "npm run build failed (exit code $exitCode)." }
    if (-not (Test-HbWebBuilt -RepoRoot $RepoRoot)) { throw 'npm run build finished but web\dist\index.html is missing.' }
}

# --------------------------------------------------------------------------------------------
# Scheduled task
# --------------------------------------------------------------------------------------------

function Test-HbScheduledTasksAvailable {
    return $null -ne (Get-Command -Name 'Register-ScheduledTask' -ErrorAction SilentlyContinue)
}

function Get-HbTask {
    return Get-ScheduledTask -TaskName $HomebaseTaskName -TaskPath $HomebaseTaskPath -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Get-HbCurrentUserId {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Test-HbElevated {
    $principal = New-Object System.Security.Principal.WindowsPrincipal ([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The task object exactly as install-autostart.ps1 registers it (nothing is registered here).
# -Trigger Browser: no trigger at all - the task only runs on demand, when the browser
# extension asks the native host (schtasks /run) or you run Start-ScheduledTask.
# -Trigger Logon: at log on of $UserId, optionally delayed.
function New-HbTaskDefinition {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$UserId,
        [ValidateSet('Browser', 'Logon')][string]$Trigger = 'Browser',
        [ValidateRange(0, 3600)][int]$LogonDelaySeconds = 0
    )
    $execute = "$env:SystemRoot\System32\conhost.exe"
    $supervisor = Join-Path $RepoRoot 'server\src\supervisor.ts'
    $argument = '--headless "{0}" "{1}"' -f $NodeExe, $supervisor
    $action = New-ScheduledTaskAction -Execute $execute -Argument $argument -WorkingDirectory $RepoRoot
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([System.TimeSpan]::Zero) -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -Priority 4 -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    $description = $HomebaseTaskDescriptions[$Trigger]
    if ($Trigger -eq 'Logon') {
        $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
        if ($LogonDelaySeconds -gt 0) {
            $logonTrigger.Delay = [System.Xml.XmlConvert]::ToString([System.TimeSpan]::FromSeconds($LogonDelaySeconds))
        }
        return New-ScheduledTask -Action $action -Trigger $logonTrigger -Principal $principal -Settings $settings `
            -Description $description
    }
    return New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $description
}

# 'Browser' (no triggers), 'Logon' (a logon trigger) or 'Other' for a task object.
function Get-HbTaskTriggerMode {
    param([Parameter(Mandatory)]$Task)
    $triggers = @(@($Task.Triggers) | Where-Object { $null -ne $_ })
    if ($triggers.Count -eq 0) { return 'Browser' }
    $logon = @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    if ($logon.Count -gt 0) { return 'Logon' }
    return 'Other'
}

# One line describing when the task starts Homebase.
function Format-HbTaskTrigger {
    param([Parameter(Mandatory)]$Task)
    $triggers = @(@($Task.Triggers) | Where-Object { $null -ne $_ })
    if ($triggers.Count -eq 0) {
        return 'none - Browser mode: runs on demand only (the browser extension starts it through the native host com.homebase.launcher; or Start-ScheduledTask)'
    }
    $parts = foreach ($trigger in $triggers) {
        $kind = $trigger.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', ''
        if ($kind -eq 'Logon') {
            $delay = if ($trigger.Delay) { ", delay $($trigger.Delay)" } else { '' }
            "Logon mode: at log on of $($trigger.UserId)$delay, enabled: $($trigger.Enabled)"
        } else {
            "$kind, enabled: $($trigger.Enabled)"
        }
    }
    return ($parts -join '; ')
}

function Write-HbTaskDefinition {
    param([Parameter(Mandatory)]$Task)
    $action = @($Task.Actions)[0]
    $settings = $Task.Settings
    Write-HbField 'Task' ("$HomebaseTaskPath$HomebaseTaskName")
    Write-HbField 'Description' $Task.Description
    Write-HbField 'Trigger' (Format-HbTaskTrigger -Task $Task)
    Write-HbField 'Principal' ("$($Task.Principal.UserId), LogonType $($Task.Principal.LogonType), RunLevel $($Task.Principal.RunLevel)")
    Write-HbField 'Execute' $action.Execute
    Write-HbField 'Arguments' $action.Arguments
    Write-HbField 'WorkingDir' $action.WorkingDirectory
    Write-HbField 'Time limit' ("$($settings.ExecutionTimeLimit) (none)")
    Write-HbField 'Batteries' ("DisallowStartIfOnBatteries $($settings.DisallowStartIfOnBatteries), StopIfGoingOnBatteries $($settings.StopIfGoingOnBatteries)")
    Write-HbField 'Instances' $settings.MultipleInstances
    Write-HbField 'On demand' ("AllowDemandStart $($settings.AllowDemandStart)")
    Write-HbField 'Start missed' ("StartWhenAvailable $($settings.StartWhenAvailable)")
    Write-HbField 'Priority' $settings.Priority
    Write-HbField 'Restart' ("RestartCount $($settings.RestartCount), RestartInterval $($settings.RestartInterval) (launch failures only; the supervisor restarts crashes)")
}

# Human-readable meaning of a task's LastTaskResult (exit codes 1, 3 and 4 come from the server).
function Format-HbTaskResult {
    param([Parameter(Mandatory)][int64]$Code)
    if ($Code -lt 0) { $Code += 4294967296 }
    $hex = '0x{0:X}' -f $Code
    switch ($Code) {
        0 { return "$hex (success)" }
        1 { return "$hex (Homebase failed to start - see the logs, or run scripts\start.ps1 to see the error)" }
        3 { return "$hex (port already in use - another Homebase instance is running)" }
        4 { return "$hex (Homebase cannot start until fixed, e.g. web\dist is missing - run npm run build; see logs\supervisor.log)" }
        267009 { return "$hex (running)" }
        267011 { return "$hex (has not run yet)" }
        267014 { return "$hex (stopped by the user)" }
        2147750687 { return "$hex (an instance is already running)" }
        2147942402 { return "$hex (file not found - check the node.exe path)" }
        2147946720 { return "$hex (the operator or administrator refused the request)" }
        default { return $hex }
    }
}

# --------------------------------------------------------------------------------------------
# Processes started by the task: conhost -> node supervisor.ts -> node index.ts
# (Stop-ScheduledTask ends only conhost; the node processes must be stopped explicitly.)
# --------------------------------------------------------------------------------------------

# Lower-case file name of the program a command line starts
# ('"C:\Windows\System32\conhost.exe" --headless ...' -> 'conhost.exe').
function Get-HbCommandLineProgram {
    param([AllowNull()][AllowEmptyString()][string]$CommandLine)
    $text = "$CommandLine".Trim()
    if (-not $text) { return '' }
    if ($text.StartsWith('"')) {
        $end = $text.IndexOf('"', 1)
        $program = if ($end -gt 0) { $text.Substring(1, $end - 1) } else { $text.Substring(1) }
    } else {
        $program = ($text -split '\s+', 2)[0]
    }
    $parts = $program.Replace('/', '\').Split('\')
    return $parts[$parts.Count - 1].ToLowerInvariant()
}

# Pure selection over Win32_Process-like objects (ProcessId, ParentProcessId, CommandLine,
# CreationDate, optional Name): supervisors whose command line names this repo's supervisor.ts,
# plus their children (created after the supervisor, so a recycled parent PID never matches).
# The task's conhost.exe host also has supervisor.ts on its command line but is not a
# supervisor: it is skipped (it exits by itself once the node supervisor under it is gone).
function Select-HbSupervisorProcesses {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $needle = (Join-Path $RepoRoot 'server\src\supervisor.ts').ToLowerInvariant()
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($process in $Processes) {
        $commandLine = "$(Get-HbProperty $process 'CommandLine')"
        if (-not $commandLine) { continue }
        $normalized = $commandLine.Replace('/', '\').ToLowerInvariant()
        if (-not $normalized.Contains($needle)) { continue }
        $name = "$(Get-HbProperty $process 'Name')".ToLowerInvariant()
        if ($name -eq 'conhost.exe' -or (Get-HbCommandLineProgram $commandLine) -eq 'conhost.exe') { continue }
        $children = @($Processes | Where-Object {
                (Get-HbProperty $_ 'ParentProcessId') -eq $process.ProcessId -and
                (Get-HbProperty $_ 'ProcessId') -ne $process.ProcessId -and
                ($null -eq (Get-HbProperty $_ 'CreationDate') -or $null -eq (Get-HbProperty $process 'CreationDate') -or
                $_.CreationDate -ge $process.CreationDate)
            })
        $result.Add([pscustomobject]@{
                SupervisorId = [int]$process.ProcessId
                ChildIds     = @($children | ForEach-Object { [int]$_.ProcessId })
            })
    }
    return $result.ToArray()
}

function Get-HbSupervisorProcesses {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
    return Select-HbSupervisorProcesses -Processes $all -RepoRoot $RepoRoot
}

# Stops each supervisor first (so it cannot restart the server), then its children.
# Returns the ids that were stopped.
function Stop-HbSupervisorProcesses {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $stopped = New-Object System.Collections.Generic.List[int]
    foreach ($tree in @(Get-HbSupervisorProcesses -RepoRoot $RepoRoot)) {
        foreach ($id in @($tree.SupervisorId) + @($tree.ChildIds)) {
            try {
                Stop-Process -Id $id -Force -ErrorAction Stop
                $stopped.Add($id)
            } catch {
                # Fine if it already exited (e.g. the child ended with its supervisor).
                if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw }
            }
        }
    }
    return $stopped.ToArray()
}

function Format-HbProcessList {
    param([AllowEmptyCollection()][object[]]$Trees)
    if ($null -eq $Trees -or $Trees.Count -eq 0) { return 'none' }
    $parts = foreach ($tree in $Trees) {
        $children = @($tree.ChildIds)
        if ($children.Count -gt 0) {
            "supervisor PID $($tree.SupervisorId) (server PID $($children -join ', '))"
        } else {
            "supervisor PID $($tree.SupervisorId)"
        }
    }
    return ($parts -join '; ')
}

# One line of server.log or supervisor.log for a person: a JSON record (one per line) as
# `<time> <LEVEL> [<area>] <msg> {the other fields}`; any other line as it is.
function Format-HbLogLine {
    param([AllowEmptyString()][AllowNull()][string]$Line)
    if ([string]::IsNullOrEmpty($Line) -or -not $Line.StartsWith('{')) { return $Line }
    $parameters = @{ ErrorAction = 'Stop' }
    # Keep times as written (PowerShell 7 would turn them into local DateTime values).
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $parameters.DateKind = 'String' }
    try {
        $record = $Line | ConvertFrom-Json @parameters
    } catch {
        return $Line
    }
    $message = Get-HbProperty -Object $record -Name 'msg'
    if ($null -eq $message -or $null -eq $record.PSObject) { return $Line }
    $time = if ($Line -match '^\{"t":"([^"]*)"') { $Matches[1] } else { [string](Get-HbProperty -Object $record -Name 't') }
    $level = ([string](Get-HbProperty -Object $record -Name 'lvl')).ToUpperInvariant().PadRight(5)
    $area = Get-HbProperty -Object $record -Name 'area'
    $areaText = if ($area) { " [$area]" } else { '' }
    $rest = [ordered]@{}
    foreach ($property in $record.PSObject.Properties) {
        if (@('t', 'lvl', 'msg', 'area', 'tags') -notcontains $property.Name) { $rest[$property.Name] = $property.Value }
    }
    $fields = if ($rest.Count -gt 0) { ' ' + (ConvertTo-Json -InputObject $rest -Compress -Depth 8) } else { '' }
    return "$time $level$areaText $message$fields"
}

function Write-HbLogTail {
    param([Parameter(Mandatory)][string]$LogFile, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $LogFile -PathType Leaf)) {
        Write-HbInfo "No log file yet at $LogFile"
        return
    }
    Write-Host "---- last $Lines lines of $LogFile ----" -ForegroundColor DarkGray
    Get-Content -LiteralPath $LogFile -Tail $Lines | ForEach-Object { Write-Host (Format-HbLogLine -Line $_) }
    Write-Host '---- end of log ----' -ForegroundColor DarkGray
}

# --------------------------------------------------------------------------------------------
# Native messaging host com.homebase.launcher (Chrome and Edge)
#
# The extension calls chrome.runtime.sendNativeMessage('com.homebase.launcher', ...). The browser
# finds the host through HKCU\Software\<browser>\NativeMessagingHosts\com.homebase.launcher
# (default value = path of the host manifest JSON) and runs launcher.cmd from
# %LOCALAPPDATA%\Homebase\native-host, which runs launcher.mjs with node.exe. The launcher only
# ever runs "schtasks /run /tn \Homebase Server": Task Scheduler starts the server, so it is not
# a child of the browser (whose isolated mode kills a native host's children with it).
# --------------------------------------------------------------------------------------------

# Fixed per-user folder for the host files, so the registry never points into the repository.
function Get-HbNativeHostDir {
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'Could not find your local application data folder (%LOCALAPPDATA%).'
    }
    return (Join-Path (Join-Path $localAppData 'Homebase') 'native-host')
}

# Chrome/Edge extension ID from a SHA-256 digest: the first 16 bytes as hex, with the hex digits
# 0-f written as the letters a-p.
function ConvertTo-HbExtensionId {
    param([Parameter(Mandatory)][byte[]]$Hash)
    if ($Hash.Length -lt 16) { throw 'An extension ID needs at least 16 bytes of hash.' }
    $chars = New-Object char[] 32
    for ($i = 0; $i -lt 16; $i++) {
        $chars[2 * $i] = [char](97 + ($Hash[$i] -shr 4))
        $chars[2 * $i + 1] = [char](97 + ($Hash[$i] -band 15))
    }
    return (-join $chars)
}

function Get-HbSha256 {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return , $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
}

# Extension ID pinned by a manifest "key" (base64 DER SubjectPublicKeyInfo): the ID is derived
# from SHA-256 of the DER bytes. Chrome and Edge use the same algorithm. Like the browsers (and
# extension\tools\extension-id.mjs), whitespace and PEM armour lines are ignored.
function Get-HbExtensionIdFromKey {
    param([Parameter(Mandatory)][string]$Key)
    $body = ($Key -replace '-----(BEGIN|END) [A-Z ]+-----', '') -replace '\s', ''
    try {
        if ($body -eq '') { throw 'empty' }
        $der = [System.Convert]::FromBase64String($body)
    } catch {
        throw 'The "key" in the extension manifest is not valid base64.'
    }
    # A DER SubjectPublicKeyInfo is a SEQUENCE (tag 0x30); an RSA-2048 one is 294 bytes long.
    if ($der.Length -lt 64 -or $der[0] -ne 0x30) {
        throw 'The "key" in the extension manifest is not a public key (base64 DER SubjectPublicKeyInfo).'
    }
    return ConvertTo-HbExtensionId -Hash (Get-HbSha256 -Bytes $der)
}

# The fixed ID of the unpacked extension, from the "key" in extension\manifest.json.
function Get-HbExtensionIdFromManifest {
    param([Parameter(Mandatory)][string]$ManifestPath)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "The extension manifest is missing: $ManifestPath"
    }
    try {
        $manifest = [System.IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    } catch {
        throw "Could not read $ManifestPath as JSON: $($_.Exception.Message)"
    }
    $key = Get-HbProperty $manifest 'key'
    if (-not ($key -is [string]) -or [string]::IsNullOrWhiteSpace($key)) {
        throw ("$ManifestPath has no ""key"" entry, so the extension's ID is not fixed and the native host cannot " +
            'name it in allowed_origins. Update your Homebase checkout (the new-tab extension pins its ID with a "key"), ' +
            'or run the installer with -NoNativeHost.')
    }
    return Get-HbExtensionIdFromKey -Key $key
}

# A JSON string literal using only ASCII (\uXXXX for everything else).
function ConvertTo-HbJsonString {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($ch -ceq '"') {
            [void]$builder.Append('\"')
        } elseif ($ch -ceq '\') {
            [void]$builder.Append('\\')
        } elseif ($code -lt 32 -or $code -gt 126) {
            [void]$builder.Append(('\u{0:x4}' -f $code))
        } else {
            [void]$builder.Append($ch)
        }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

# The code page cmd.exe reads batch files in: the OEM code page (65001 when Windows' "Use Unicode
# UTF-8 for worldwide language support" option is on).
function Get-HbOemEncoding {
    $codePage = 0
    try {
        $codePage = [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name 'OEMCP' -ErrorAction Stop).OEMCP
    } catch {
        $codePage = 0
    }
    if ($codePage -le 0) { $codePage = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage }
    if ($codePage -eq 65001) { return New-Object System.Text.UTF8Encoding -ArgumentList $false, $true }
    return [System.Text.Encoding]::GetEncoding($codePage, [System.Text.EncoderFallback]::ExceptionFallback,
        [System.Text.DecoderFallback]::ExceptionFallback)
}

# Bytes of a batch file: ASCII when possible, else the OEM code page (fails clearly when a
# character cannot be represented there).
function ConvertTo-HbBatchBytes {
    param([Parameter(Mandatory)][string]$Text, $Encoding)
    if ($Text -notmatch '[^\x00-\x7F]') { return , ([System.Text.Encoding]::ASCII.GetBytes($Text)) }
    try {
        if ($null -eq $Encoding) { $Encoding = Get-HbOemEncoding }
        return , ($Encoding.GetBytes($Text))
    } catch {
        throw ('The node.exe path has characters that a batch file cannot hold in this Windows code page. Pass -NodePath ' +
            'with a node.exe whose path has only plain ASCII characters (for example C:\Program Files\nodejs\node.exe).')
    }
}

# Everything the installer writes for the native host, computed without writing anything.
# Files: Name, Path, Bytes, Text ($null for the copied launcher.mjs), Source.
# Registry: Browser, SubKey (under HKEY_CURRENT_USER), Display, Value (the host manifest's path).
function New-HbNativeHostPlan {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$ExtensionId,
        [string]$Destination
    )
    if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw "Not an extension ID (32 letters a-p): '$ExtensionId'" }
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-HbNativeHostDir }
    $Destination = [System.IO.Path]::GetFullPath($Destination)
    $sourceDir = Join-Path $RepoRoot 'native-host'
    $launcherSource = Join-Path $sourceDir 'launcher.mjs'
    $templateSource = Join-Path $sourceDir 'launcher.cmd'
    foreach ($required in @($launcherSource, $templateSource)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "The native host file $required is missing from this Homebase checkout."
        }
    }

    $template = [System.IO.File]::ReadAllText($templateSource)
    $pieces = $template.Split([string[]]@($HomebaseNodePlaceholder), [System.StringSplitOptions]::None)
    if ($pieces.Count -ne 2) { throw "$templateSource must contain $HomebaseNodePlaceholder exactly once." }
    # A batch file expands %...%, so a literal percent sign in the path is written as %%.
    $cmdText = $pieces[0] + $NodeExe.Replace('%', '%%') + $pieces[1]
    $cmdText = [regex]::Replace($cmdText, '\r?\n', "`r`n")
    if (-not $cmdText.EndsWith("`r`n")) { $cmdText += "`r`n" }

    $origin = "chrome-extension://$ExtensionId/"
    $cmdPath = Join-Path $Destination 'launcher.cmd'
    $manifestPath = Join-Path $Destination "$HomebaseNativeHostName.json"
    $newline = "`r`n"
    $manifestText = (@(
            '{'
            ('  "name": {0},' -f (ConvertTo-HbJsonString $HomebaseNativeHostName))
            ('  "description": {0},' -f (ConvertTo-HbJsonString $HomebaseNativeHostDescription))
            ('  "path": {0},' -f (ConvertTo-HbJsonString $cmdPath))
            '  "type": "stdio",'
            '  "allowed_origins": ['
            ('    {0}' -f (ConvertTo-HbJsonString $origin))
            '  ]'
            '}'
        ) -join $newline) + $newline
    $configText = (@(
            '{'
            '  "version": 1,'
            '  "allowedOrigins": ['
            ('    {0}' -f (ConvertTo-HbJsonString $origin))
            '  ],'
            ('  "installedFrom": {0}' -f (ConvertTo-HbJsonString $RepoRoot))
            '}'
        ) -join $newline) + $newline

    $files = @(
        [pscustomobject]@{
            Name = 'launcher.mjs'; Path = (Join-Path $Destination 'launcher.mjs'); Text = $null; Source = $launcherSource
            Bytes = [System.IO.File]::ReadAllBytes($launcherSource)
        }
        [pscustomobject]@{
            Name = 'launcher.cmd'; Path = $cmdPath; Text = $cmdText; Source = $templateSource
            Bytes = (ConvertTo-HbBatchBytes -Text $cmdText)
        }
        [pscustomobject]@{
            Name = "$HomebaseNativeHostName.json"; Path = $manifestPath; Text = $manifestText; Source = $null
            Bytes = [System.Text.Encoding]::ASCII.GetBytes($manifestText)
        }
        [pscustomobject]@{
            Name = 'config.json'; Path = (Join-Path $Destination 'config.json'); Text = $configText; Source = $null
            Bytes = [System.Text.Encoding]::ASCII.GetBytes($configText)
        }
    )
    $registry = @(foreach ($entry in $HomebaseNativeHostRegistry) {
            [pscustomobject]@{
                Browser = $entry.Browser
                SubKey  = $entry.SubKey
                Display = "HKEY_CURRENT_USER\$($entry.SubKey)"
                Value   = $manifestPath
            }
        })
    return [pscustomobject]@{
        Destination  = $Destination
        ExtensionId  = $ExtensionId
        Origin       = $origin
        ManifestPath = $manifestPath
        LauncherPath = $cmdPath
        NodeExe      = $NodeExe
        Files        = $files
        Registry     = $registry
    }
}

# Dry-run listing of a plan: every file with its full content (launcher.mjs: size and hash) and
# every registry value.
function Write-HbNativeHostPlan {
    param([Parameter(Mandatory)]$Plan)
    Write-HbField 'Host name' $HomebaseNativeHostName
    Write-HbField 'Extension ID' "$($Plan.ExtensionId) (allowed origin $($Plan.Origin))"
    Write-HbField 'Folder' $Plan.Destination
    foreach ($file in @($Plan.Files)) {
        $bytes = [byte[]]$file.Bytes
        if ($null -eq $file.Text) {
            # (Get-HbSha256 returns its array as one object: assign it, never wrap it in @().)
            $digest = Get-HbSha256 -Bytes $bytes
            $hash = -join ($digest | ForEach-Object { $_.ToString('x2') })
            Write-HbField 'File' ("{0} (copy of {1}, {2} bytes, SHA-256 {3})" -f $file.Path, $file.Source, $bytes.Length, $hash)
        } else {
            Write-HbField 'File' ("{0} ({1} bytes):" -f $file.Path, $bytes.Length)
            foreach ($line in ($file.Text.TrimEnd("`r", "`n") -split "`r?`n")) { Write-Host "                   | $line" }
        }
    }
    foreach ($entry in @($Plan.Registry)) {
        Write-HbField 'Registry' "$($entry.Display)"
        Write-Host "                   (default) REG_SZ = $($entry.Value)   [$($entry.Browser)]"
    }
}

# HKEY_CURRENT_USER helpers (the .NET registry API behaves the same in PowerShell 5.1 and 7).
function Set-HbRegistryDefaultValue {
    param([Parameter(Mandatory)][string]$SubKey, [Parameter(Mandatory)][string]$Value)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
    try { $key.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Close() }
}

# Default value of HKCU\<SubKey>: $null when the key does not exist, '' when it has none.
function Get-HbRegistryDefaultValue {
    param([Parameter(Mandatory)][string]$SubKey)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    if ($null -eq $key) { return $null }
    try {
        $value = $key.GetValue('')
        if ($null -eq $value) { return '' }
        return "$value"
    } finally {
        $key.Close()
    }
}

function Remove-HbRegistryKey {
    param([Parameter(Mandatory)][string]$SubKey)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKey, $false)
}

# Writes the planned files and registry values (Chrome and Edge). Idempotent: files are rewritten
# and values overwritten. -RegistryWriter { param($SubKey, $Value) ... } replaces the HKCU write.
function Install-HbNativeHost {
    param([Parameter(Mandatory)]$Plan, [scriptblock]$RegistryWriter)
    if ($null -eq $RegistryWriter) {
        $RegistryWriter = { param([string]$SubKey, [string]$Value) Set-HbRegistryDefaultValue -SubKey $SubKey -Value $Value }
    }
    $dir = $Plan.Destination
    if (Test-Path -LiteralPath $dir) {
        $item = Get-Item -LiteralPath $dir -Force
        if (-not $item.PSIsContainer) { throw "$dir exists but is not a folder. Remove it and run the installer again." }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$dir is a link. Remove it and run the installer again."
        }
    } else {
        $null = [System.IO.Directory]::CreateDirectory($dir)
    }
    foreach ($file in @($Plan.Files)) {
        [System.IO.File]::WriteAllBytes($file.Path, [byte[]]$file.Bytes)
    }
    foreach ($entry in @($Plan.Registry)) {
        & $RegistryWriter $entry.SubKey $entry.Value
    }
}

# Deletes a folder tree; a link (junction/symlink) inside is removed itself, never followed.
function Remove-HbFolderTree {
    param([Parameter(Mandatory)][string]$Path)
    foreach ($entry in (New-Object System.IO.DirectoryInfo -ArgumentList $Path).GetFileSystemInfos()) {
        $isLink = ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        $isFolder = ($entry.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        if ($isFolder -and $isLink) {
            [System.IO.Directory]::Delete($entry.FullName)
        } elseif ($isFolder) {
            Remove-HbFolderTree -Path $entry.FullName
        } else {
            $entry.Attributes = [System.IO.FileAttributes]::Normal
            [System.IO.File]::Delete($entry.FullName)
        }
    }
    [System.IO.Directory]::Delete($Path)
}

# Removes only the given native-host folder (never its parent, never the target of a link).
# Returns $true when something was removed.
function Remove-HbNativeHostFolder {
    param([Parameter(Mandatory)][string]$Path)
    if ([System.IO.Path]::GetFileName($Path.TrimEnd([char]92)) -ne 'native-host') { throw "Refusing to remove '$Path': not a native-host folder." }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [System.IO.Directory]::Delete($Path)
    } elseif ($item.PSIsContainer) {
        Remove-HbFolderTree -Path $Path
    } else {
        throw "'$Path' is not a folder."
    }
    return $true
}

# Removes the registry keys (Chrome and Edge) and the native-host folder.
# -RegistryRemover { param($SubKey) ... } replaces the HKCU delete.
function Uninstall-HbNativeHost {
    param([string]$Destination, [scriptblock]$RegistryRemover)
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-HbNativeHostDir }
    if ($null -eq $RegistryRemover) {
        $RegistryRemover = { param([string]$SubKey) Remove-HbRegistryKey -SubKey $SubKey }
    }
    foreach ($entry in $HomebaseNativeHostRegistry) {
        & $RegistryRemover $entry.SubKey
    }
    return (Remove-HbNativeHostFolder -Path $Destination)
}

# node.exe named in a generated launcher.cmd, or $null.
function Get-HbLauncherNodePath {
    param([Parameter(Mandatory)][string]$LauncherCmd)
    try {
        $text = [System.IO.File]::ReadAllText($LauncherCmd, (Get-HbOemEncoding))
    } catch {
        return $null
    }
    $match = [regex]::Match($text, '(?m)^\s*"([^"]+)"\s+"%~dp0launcher\.mjs"')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value.Replace('%%', '%')
}

# Problems with a registered host manifest and the files next to it (empty when all is well).
# $ExpectedId: the extension ID the manifest must allow ($null = do not check).
function Test-HbNativeHostManifest {
    param([Parameter(Mandatory)][string]$ManifestPath, [AllowNull()][AllowEmptyString()][string]$ExpectedId)
    $problems = New-Object System.Collections.Generic.List[string]
    if (-not [System.IO.Path]::IsPathRooted($ManifestPath)) {
        $problems.Add("the registered manifest path is not absolute: $ManifestPath")
        return , $problems.ToArray()
    }
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        $problems.Add("the manifest file does not exist: $ManifestPath")
        return , $problems.ToArray()
    }
    try {
        $manifest = [System.IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    } catch {
        $problems.Add("the manifest is not valid JSON: $ManifestPath")
        return , $problems.ToArray()
    }
    if ((Get-HbProperty $manifest 'name') -cne $HomebaseNativeHostName) {
        $problems.Add("the manifest's name is not $HomebaseNativeHostName")
    }
    if ((Get-HbProperty $manifest 'type') -cne 'stdio') { $problems.Add('the manifest''s type is not "stdio"') }
    $description = Get-HbProperty $manifest 'description'
    if (-not ($description -is [string]) -or [string]::IsNullOrWhiteSpace($description)) {
        $problems.Add('the manifest has no description (browsers refuse such a host)')
    }

    $origins = @(@(Get-HbProperty $manifest 'allowed_origins') | Where-Object { $_ -is [string] })
    if ($ExpectedId) {
        $expected = "chrome-extension://$ExpectedId/"
        if (-not ($origins -ccontains $expected)) {
            $listed = if ($origins.Count -gt 0) { $origins -join ', ' } else { 'nothing' }
            $problems.Add("allowed_origins lists $listed, not $expected (the extension's ID changed): re-run install-autostart.ps1")
        }
    }

    $hostPath = Get-HbProperty $manifest 'path'
    if (-not ($hostPath -is [string]) -or [string]::IsNullOrWhiteSpace($hostPath)) {
        $problems.Add('the manifest has no path')
        return , $problems.ToArray()
    }
    if (-not [System.IO.Path]::IsPathRooted($hostPath)) { $hostPath = Join-Path ([System.IO.Path]::GetDirectoryName($ManifestPath)) $hostPath }
    if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
        $problems.Add("the host program does not exist: $hostPath")
        return , $problems.ToArray()
    }
    $hostDir = [System.IO.Path]::GetDirectoryName($hostPath)
    if (-not (Test-Path -LiteralPath (Join-Path $hostDir 'launcher.mjs') -PathType Leaf)) {
        $problems.Add("launcher.mjs is missing in $hostDir")
    }
    $nodeExe = Get-HbLauncherNodePath -LauncherCmd $hostPath
    if ($null -eq $nodeExe) {
        $problems.Add("could not find the node.exe path in $hostPath")
    } elseif (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
        $problems.Add("the launcher's node.exe no longer exists: $nodeExe (re-run install-autostart.ps1)")
    }
    $configPath = Join-Path $hostDir 'config.json'
    $config = $null
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try { $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json } catch { $config = $null }
    }
    $configOrigins = @(@(Get-HbProperty $config 'allowedOrigins') | Where-Object { $_ -is [string] })
    if ($null -eq $config) {
        $problems.Add("config.json is missing or invalid in $hostDir")
    } elseif ($ExpectedId -and -not ($configOrigins -ccontains "chrome-extension://$ExpectedId/")) {
        $problems.Add("config.json does not allow chrome-extension://$ExpectedId/: re-run install-autostart.ps1")
    }
    return , $problems.ToArray()
}

# $true when the installed launcher.mjs is byte for byte this checkout's native-host\launcher.mjs,
# $false when it differs (Homebase was updated but install-autostart.ps1 was not run again), $null
# when either file is missing.
function Test-HbInstalledLauncherCurrent {
    param([Parameter(Mandatory)][string]$InstalledDir, [Parameter(Mandatory)][string]$RepoRoot)
    $installed = Join-Path $InstalledDir 'launcher.mjs'
    $source = Join-Path $RepoRoot 'native-host\launcher.mjs'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
        return $null
    }
    # (Get-HbSha256 returns its array as one object: assign it, never wrap it in @().)
    $installedHash = Get-HbSha256 -Bytes ([System.IO.File]::ReadAllBytes($installed))
    $sourceHash = Get-HbSha256 -Bytes ([System.IO.File]::ReadAllBytes($source))
    return ([System.Convert]::ToBase64String($installedHash) -ceq [System.Convert]::ToBase64String($sourceHash))
}

# Registration state for Chrome and Edge: Browser, Key, Registered, ManifestPath, Problems.
# -RegistryReader { param($SubKey) ... } replaces the HKCU read (returns $null for a missing key).
function Get-HbNativeHostStatus {
    param([AllowNull()][AllowEmptyString()][string]$ExpectedId, [scriptblock]$RegistryReader)
    if ($null -eq $RegistryReader) {
        $RegistryReader = { param([string]$SubKey) Get-HbRegistryDefaultValue -SubKey $SubKey }
    }
    $results = foreach ($entry in $HomebaseNativeHostRegistry) {
        $value = & $RegistryReader $entry.SubKey
        $problems = @()
        if ($null -ne $value -and "$value" -eq '') {
            $problems = @('the registry key has no default value (the manifest path)')
        } elseif ($null -ne $value) {
            $problems = Test-HbNativeHostManifest -ManifestPath "$value" -ExpectedId $ExpectedId
        }
        [pscustomobject]@{
            Browser      = $entry.Browser
            Key          = "HKEY_CURRENT_USER\$($entry.SubKey)"
            Registered   = ($null -ne $value)
            ManifestPath = $value
            Problems     = $problems
        }
    }
    return , @($results)
}
