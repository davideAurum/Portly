# Shared helpers for the Portly PowerShell scripts (ARCHITECTURE section 12).
#
# Dot-source from a script in scripts\:   . (Join-Path $PSScriptRoot 'lib\Common.ps1')
#
# Works in Windows PowerShell 5.1 and PowerShell 7+. Keep this file ASCII-only: Windows
# PowerShell 5.1 reads BOM-less scripts in the ANSI code page.

Set-StrictMode -Version 3.0

# Value without PowerShell 7's module folders. A Windows PowerShell started from PowerShell 7
# through a .cmd file (the portly command) inherits them, and then loads PowerShell 7's
# Microsoft.PowerShell.Utility, which has no Get-FileHash for it. PowerShell 7 corrects the
# variable only for a powershell.exe it starts itself.
function Get-PtWindowsModulePath {
    param([string]$Value)
    $folders = @($Value -split ';' | Where-Object {
            $_ -and $_ -notmatch '\\PowerShell\\([0-9][^\\]*\\)?Modules\\?$' -and $_ -notmatch '\\Microsoft\.PowerShell_[^\\]+\\Modules\\?$'
        })
    return ($folders -join ';')
}
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = Get-PtWindowsModulePath -Value $env:PSModulePath }

$PortlyTaskName = 'Portly Server'
$PortlyTaskPath = '\'
$PortlyUpdaterTaskName = 'Portly Updater'
$PortlyUpdaterDescription = 'Installs the newest Portly release when asked to from Settings > About. Its command takes no input from Portly.'
# Below the 20 minutes after which the server counts a quiet run as dead (modules/update).
$PortlyUpdaterTimeLimitMinutes = 15
$PortlyDefaultPort = 5757
# The Node.js major Portly runs on: the one package.json pins in engines.node (">=26 <27"), which
# npm's engine-strict enforces, so Resolve-PtNode refuses any other major too (older or newer).
# check-scripts.ps1 keeps it equal to package.json, scripts\release\node-runtime.json, ci.yml and
# $SetupNodeMajor in setup.ps1 (which cannot dot-source this file). A new major changes them all.
$PortlyNodeMajor = 26
# winget's package for that major. winget keeps its current LTS under OpenJS.NodeJS.LTS and gives
# a major its own id (OpenJS.NodeJS.22, ...) once it is no longer the LTS, so setup.ps1 picks
# whichever of the two installs $PortlyNodeMajor at run time; messages name both.
$PortlyNodeWingetId = "OpenJS.NodeJS.$PortlyNodeMajor"
$PortlyNodeInstallHint = "install Node.js $PortlyNodeMajor from https://nodejs.org/ or with winget install $PortlyNodeWingetId (OpenJS.NodeJS.LTS while winget's LTS is still $PortlyNodeMajor)"
$PortlyTaskDescriptions = @{
    Browser = 'Starts the Portly server (server\src\supervisor.ts) when Chrome or Edge asks for it through the Portly extension (native host com.portly.launcher). No logon trigger. Installed by scripts\install-autostart.ps1.'
    Logon   = 'Starts the Portly server (server\src\supervisor.ts) at logon. Installed by scripts\install-autostart.ps1.'
}
# Native messaging host (ARCHITECTURE section 12): the extension asks it to run the task.
$PortlyNativeHostName = 'com.portly.launcher'
$PortlyNativeHostDescription = 'Portly launcher (starts the Portly Server scheduled task)'
$PortlyNativeHostRegistry = @(
    [pscustomobject]@{ Browser = 'Chrome'; SubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.portly.launcher' }
    [pscustomobject]@{ Browser = 'Edge'; SubKey = 'Software\Microsoft\Edge\NativeMessagingHosts\com.portly.launcher' }
)
$PortlyNodePlaceholder = '{{NODE_EXE}}'
# Portly's named copies of node.exe in %LOCALAPPDATA%\Portly\node (see "Portly's copies of Node.js").
$PortlySupervisorProgram = 'portly-supervisor.exe'
$PortlyServerProgram = 'portly-server.exe'
$PortlyRuntimeRecord = 'runtime.json'
# Every environment variable server/src/config.ts reads.
$PortlyEnvNames = @('PORTLY_PORT', 'PORTLY_BIND', 'PORTLY_ORIGIN', 'PORTLY_DATA_DIR', 'PORTLY_DEV', 'PORTLY_VITE_PORT', 'PORTLY_PAGES_URL', 'PORTLY_LOG_LEVEL', 'PORTLY_REMOTE_ORIGIN', 'PORTLY_REMOTE_PORT')

# --------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------
#
# Two looks (scripts\README.md, "The look"). In a terminal that understands ANSI escapes, the
# "Harbor" theme: 24-bit colors, icons, spinners and progress bars. Everywhere else (output
# redirected to a file or another program, the scheduled tasks' logs, NO_COLOR or PORTLY_PLAIN
# set, the ISE) plain text with the fixed prefixes (==>, OK, ERROR:) that logs and the
# self-checks read. PORTLY_FANCY=1 forces the theme on, for trying it out.
#
# This file is ASCII-only, so the icons are built from their code points.

$script:PtFancy = $null
$PtPalette = @{
    Teal  = '46;196;182'     # headings, steps, the bar
    Deep  = '27;127;121'     # rules, secondary accents
    Coral = '255;107;107'    # errors, the anchor
    Amber = '255;183;77'     # warnings
    Mint  = '123;224;173'    # success
    Mist  = '138;155;168'    # labels, hints, the bar's track
    Foam  = '232;246;244'    # emphasis
    Sand  = '214;222;226'    # body text
}
$PtIcons = @{
    Anchor  = [string][char]0x2693
    Dot     = [string][char]0x25CF
    Ring    = [string][char]0x25CB
    Diamond = [string][char]0x25C6
    Check   = [string][char]0x2714
    Warn    = [string][char]0x26A0
    Cross   = [string][char]0x2716
    Arrow   = [string][char]0x279C
    Middot  = [string][char]0x00B7
    Full    = [string][char]0x2588
    Light   = [string][char]0x2591
    Rule    = [string][char]0x2500
}
$PtSpinnerFrames = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F | ForEach-Object { [string][char]$_ })

# True when the Harbor theme is on (decided once per script).
function Test-PtFancyOutput {
    if ($null -ne $script:PtFancy) { return $script:PtFancy }
    $script:PtFancy = $false
    if ($env:PORTLY_FANCY -eq '1') {
        $script:PtFancy = $true
    } elseif (-not ($env:NO_COLOR -or $env:PORTLY_PLAIN -or $env:TERM -eq 'dumb') -and $Host.Name -eq 'ConsoleHost') {
        $redirected = $true
        try { $redirected = [System.Console]::IsOutputRedirected } catch { }
        $vt = $Host.UI.PSObject.Properties['SupportsVirtualTerminal']
        $script:PtFancy = (-not $redirected) -and ($null -ne $vt) -and [bool]$vt.Value
    }
    return $script:PtFancy
}

# $Text in a palette color (bold and dim optional); $Text unchanged in plain output.
function Format-PtStyle {
    param([Parameter(Mandatory)][string]$Color, [AllowEmptyString()][string]$Text, [switch]$Bold, [switch]$Dim)
    if (-not (Test-PtFancyOutput) -or $Text -eq '') { return $Text }
    $e = [char]27
    $attributes = ''
    if ($Bold) { $attributes += "$e[1m" }
    if ($Dim) { $attributes += "$e[2m" }
    return "$attributes$e[38;2;$($PtPalette[$Color])m$Text$e[0m"
}

# A bar of $Width cells, $Fraction (0-1) of them filled.
function Format-PtBar {
    param([Parameter(Mandatory)][double]$Fraction, [int]$Width = 24)
    $filled = [int][Math]::Round([Math]::Max(0, [Math]::Min(1, $Fraction)) * $Width)
    return (Format-PtStyle Teal ($PtIcons.Full * $filled)) + (Format-PtStyle Mist ($PtIcons.Light * ($Width - $filled)) -Dim)
}

# Redraws the current line with a spinner frame and $Text (fancy output only).
function Write-PtSpinnerLine {
    param([Parameter(Mandatory)][int]$Frame, [AllowEmptyString()][string]$Text)
    if (-not (Test-PtFancyOutput)) { return }
    $e = [char]27
    $glyph = Format-PtStyle Teal $PtSpinnerFrames[$Frame % $PtSpinnerFrames.Count] -Bold
    Write-Host -NoNewline "`r$e[2K$glyph $Text"
}

function Clear-PtSpinnerLine {
    if (-not (Test-PtFancyOutput)) { return }
    $e = [char]27
    Write-Host -NoNewline "`r$e[2K"
}

function Set-PtCursorVisible {
    param([Parameter(Mandatory)][bool]$Visible)
    if (-not (Test-PtFancyOutput)) { return }
    $e = [char]27
    Write-Host -NoNewline $(if ($Visible) { "$e[?25h" } else { "$e[?25l" })
}

# "1m 05s" / "12s".
function Format-PtElapsed {
    param([Parameter(Mandatory)][System.TimeSpan]$Span)
    if ($Span.TotalMinutes -ge 1) { return ('{0}m {1:00}s' -f [int][Math]::Floor($Span.TotalMinutes), $Span.Seconds) }
    return ('{0}s' -f [int][Math]::Floor($Span.TotalSeconds))
}

# The first line of a command's output: the anchor, "Portly", the version and a subtitle, then
# either a status light with its word (-State Ok, Warn or Bad and -StateText, then -Detail) or a
# line on what the command does (-Detail alone).
function Write-PtBanner {
    param(
        [Parameter(Mandatory)][string]$Version,
        [string]$Subtitle = '',
        [ValidateSet('', 'Ok', 'Warn', 'Bad')][string]$State = '',
        [string]$StateText = '',
        [string]$Detail = ''
    )
    if (-not (Test-PtFancyOutput)) { return }
    $line = (Format-PtStyle Coral $PtIcons.Anchor) + ' ' + (Format-PtStyle Foam 'Portly' -Bold) + ' ' + (Format-PtStyle Teal $Version)
    if ($Subtitle) { $line += '  ' + (Format-PtStyle Mist "$($PtIcons.Middot) $Subtitle") }
    if ($State) {
        $color = (@{ Ok = 'Mint'; Warn = 'Amber'; Bad = 'Coral' })[$State]
        $line += '  ' + (Format-PtStyle $color "$($PtIcons.Dot) $StateText" -Bold)
    }
    if ($Detail) { $line += '  ' + (Format-PtStyle Mist "$($PtIcons.Middot) $Detail") }
    Write-Host ''
    Write-Host $line
    Write-Host (Format-PtStyle Deep ($PtIcons.Rule * 60) -Dim)
}

function Write-PtSection {
    param([Parameter(Mandatory)][string]$Title)
    Write-Host ''
    if (Test-PtFancyOutput) {
        Write-Host ((Format-PtStyle Teal $PtIcons.Diamond) + ' ' + (Format-PtStyle Foam $Title -Bold))
    } else {
        Write-Host $Title -ForegroundColor White
    }
}

function Write-PtStep {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    if (Test-PtFancyOutput) {
        Write-Host ((Format-PtStyle Teal $PtIcons.Arrow -Bold) + ' ' + (Format-PtStyle Foam $Message -Bold))
        return
    }
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-PtOk {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    if (Test-PtFancyOutput) {
        Write-Host ((Format-PtStyle Mint $PtIcons.Check -Bold) + ' ' + (Format-PtStyle Mint $Message))
        return
    }
    Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-PtInfo {
    param([string]$Message = '')
    if (Test-PtFancyOutput) {
        Write-Host ('  ' + (Format-PtStyle Sand $Message))
        return
    }
    Write-Host "    $Message"
}

function Write-PtField {
    param([Parameter(Mandatory)][string]$Name, [AllowEmptyString()][string]$Value)
    if (Test-PtFancyOutput) {
        Write-Host ('  ' + (Format-PtStyle Mist ('{0,-15}' -f $Name)) + ' ' + (Format-PtStyle Sand $Value))
        return
    }
    Write-Host ('  {0,-15}: {1}' -f $Name, $Value)
}

# A field whose value is good (Ok), worth a look (Warn) or wrong (Bad): a colored dot in the
# theme; in plain output "<PlainPrefix><Value>" in green, yellow or red, as before.
function Write-PtFieldState {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)][ValidateSet('Ok', 'Warn', 'Bad')][string]$State,
        [string]$PlainPrefix = ''
    )
    $color = (@{ Ok = 'Mint'; Warn = 'Amber'; Bad = 'Coral' })[$State]
    if (Test-PtFancyOutput) {
        $icon = if ($State -eq 'Ok') { $PtIcons.Dot } else { $PtIcons.Ring }
        Write-Host ('  ' + (Format-PtStyle Mist ('{0,-15}' -f $Name)) + ' ' + (Format-PtStyle $color "$icon $Value"))
        return
    }
    $consoleColor = (@{ Ok = 'Green'; Warn = 'Yellow'; Bad = 'Red' })[$State]
    Write-Host ('  {0,-15}: {1}' -f $Name, "$PlainPrefix$Value") -ForegroundColor $consoleColor
}

function Write-PtFailure {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    if (Test-PtFancyOutput) {
        Write-Host ((Format-PtStyle Coral $PtIcons.Cross -Bold) + ' ' + (Format-PtStyle Coral $Message))
        return
    }
    Write-Host "ERROR: $Message" -ForegroundColor Red
}

# A warning: Write-Warning in plain output (so it still reads "WARNING: ..."), amber in the theme.
function Write-PtWarn {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Message)
    if (Test-PtFancyOutput) {
        Write-Host ((Format-PtStyle Amber $PtIcons.Warn -Bold) + ' ' + (Format-PtStyle Amber $Message))
        return
    }
    Write-Warning $Message
}

# One line of another Portly script's plain output, shown in the theme: its ==>, OK, ERROR: and
# WARNING: prefixes become the matching icons. Returns the step text for a ==> line, else $null.
function Write-PtRelayedLine {
    param([AllowEmptyString()][string]$Line, [switch]$StdErr)
    if ($StdErr) { Write-Host (Format-PtStyle Coral $Line); return $null }
    if ($Line -match '^==> (.*)$') { Write-PtStep $Matches[1]; return $Matches[1] }
    if ($Line -match '^OK  (.*)$') { Write-PtOk $Matches[1]; return $null }
    if ($Line -match '^ERROR: (.*)$') { Write-PtFailure $Matches[1]; return $null }
    if ($Line -match '^WARNING: (.*)$') { Write-PtWarn $Matches[1]; return $null }
    if ($Line -match '^    (.*)$') { Write-PtInfo $Matches[1]; return $null }
    Write-Host (Format-PtStyle Mist $Line)
    return $null
}

# One command-line argument quoted for ProcessStartInfo.Arguments (the MSVC rules).
function ConvertTo-PtProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

# Runs a program with its output read here line by line: each line is shown in the theme (see
# Write-PtRelayedLine), and while the program is quiet a spinner shows the current step and how
# long it has taken. Returns the exit code. For fancy output; plain output runs programs directly.
function Invoke-PtStreamedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [string]$WorkingDirectory,
        [string]$Activity = 'Working'
    )
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-PtProcessArgument $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $step = $Activity
    $stepStarted = [System.DateTime]::UtcNow
    $frame = 0
    Set-PtCursorVisible $false
    try {
        $outTask = $process.StandardOutput.ReadLineAsync()
        $errTask = $process.StandardError.ReadLineAsync()
        while ($null -ne $outTask -or $null -ne $errTask) {
            $moved = $false
            if ($null -ne $outTask -and $outTask.IsCompleted) {
                $moved = $true
                $line = $outTask.Result
                if ($null -eq $line) {
                    $outTask = $null
                } else {
                    Clear-PtSpinnerLine
                    $newStep = Write-PtRelayedLine -Line $line
                    if ($null -ne $newStep) { $step = $newStep; $stepStarted = [System.DateTime]::UtcNow }
                    $outTask = $process.StandardOutput.ReadLineAsync()
                }
            }
            if ($null -ne $errTask -and $errTask.IsCompleted) {
                $moved = $true
                $line = $errTask.Result
                if ($null -eq $line) {
                    $errTask = $null
                } else {
                    Clear-PtSpinnerLine
                    $null = Write-PtRelayedLine -Line $line -StdErr
                    $errTask = $process.StandardError.ReadLineAsync()
                }
            }
            if (-not $moved) {
                $elapsed = Format-PtElapsed ([System.DateTime]::UtcNow - $stepStarted)
                Write-PtSpinnerLine -Frame $frame -Text ((Format-PtStyle Sand $step) + '  ' + (Format-PtStyle Mist $elapsed -Dim))
                $frame++
                Start-Sleep -Milliseconds 80
            }
        }
        $process.WaitForExit()
        return $process.ExitCode
    } finally {
        Clear-PtSpinnerLine
        Set-PtCursorVisible $true
        $process.Dispose()
    }
}

# --------------------------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------------------------

function Test-PtWindows {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Get-PtRepoRoot {
    param([Parameter(Mandatory)][string]$ScriptRoot)
    return [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..'))
}

# Session worktrees (.claude\worktrees\<name>) are deleted when their session ends, so nothing
# long-lived (builds, the portly command) may point into one.
function Test-PtWorktreePath {
    param([Parameter(Mandatory)][string]$Path)
    return $Path -match '\\\.claude\\worktrees\\'
}

# Property value or $null (safe under Set-StrictMode for objects from ConvertFrom-Json).
function Get-PtProperty {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-PtExceptionChain {
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
function Test-PtAccessDenied {
    param($ErrorOrException)
    if ($null -eq $ErrorOrException) { return $false }
    if ($ErrorOrException -is [System.Management.Automation.ErrorRecord]) {
        if ("$($ErrorOrException.FullyQualifiedErrorId)" -match '0x80070005') { return $true }
    }
    foreach ($exception in @(Get-PtExceptionChain $ErrorOrException)) {
        if ($exception.HResult -eq -2147024891) { return $true }
        if ($exception -is [System.UnauthorizedAccessException]) { return $true }
        if ("$($exception.Message)" -match 'Access is denied|0x80070005') { return $true }
    }
    return $false
}

function Write-PtAccessDeniedHint {
    param([Parameter(Mandatory)][string]$ScriptPath, [string]$Arguments = '')
    Write-PtFailure 'Windows denied access (0x80070005) while managing the scheduled task.'
    Write-Host ''
    Write-Host 'Another Windows account on this PC may already have Portly: scheduled task names are shared' -ForegroundColor Yellow
    Write-Host 'by the whole PC, so only one account can have the "Portly Server" task today. If so, use that' -ForegroundColor Yellow
    Write-Host 'account, or remove Portly from it first (scripts\uninstall-autostart.ps1 there); running as administrator' -ForegroundColor Yellow
    Write-Host 'will not help.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'If no other account has Portly, open PowerShell as administrator (Start > type "PowerShell" >' -ForegroundColor Yellow
    Write-Host 'Run as administrator) and run:' -ForegroundColor Yellow
    Write-Host ''
    $command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    if ($Arguments) { $command = "$command $Arguments" }
    Write-Host "    $command"
    Write-Host ''
    Write-Host 'The task still runs as your own user with normal (non-elevated) rights; administrator'
    Write-Host 'rights are only needed to change its registration.'
}

# True when an error is Windows' "being used by another process" (a sharing violation, HRESULT
# 0x80070020): another program has the file open and does not share the access asked for.
function Test-PtSharingViolation {
    param($ErrorOrException)
    if ($null -eq $ErrorOrException) { return $false }
    foreach ($exception in @(Get-PtExceptionChain $ErrorOrException)) {
        if ($exception.HResult -eq -2147024864) { return $true }
    }
    return $false
}

# Runs $Action and returns its output. A sharing violation is tried again after a pause:
# -Attempts tries in all, -DelayMilliseconds before the second and doubling after that (by default
# 5 tries, 100 + 200 + 400 + 800 ms = 1.5 s). Any other error, and the last try's, is thrown as it
# is, so a file that stays in use is still reported. For setting a file's modification time:
# Windows PowerShell 5.1 opens the file for writing to do that, which fails while any other program
# has it open without sharing write access, for example a virus scanner reading a program that was
# just copied. (PowerShell 7 asks only for attribute access, and setting attributes never conflicts.)
function Invoke-PtSharingRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [ValidateRange(1, 10)][int]$Attempts = 5,
        [ValidateRange(0, 5000)][int]$DelayMilliseconds = 100
    )
    $delay = $DelayMilliseconds
    for ($attempt = 1; $attempt -lt $Attempts; $attempt++) {
        try {
            return (& $Action)
        } catch {
            if (-not (Test-PtSharingViolation $_)) { throw }
        }
        Start-Sleep -Milliseconds $delay
        $delay *= 2
    }
    return (& $Action)
}

# --------------------------------------------------------------------------------------------
# Configuration (mirrors server/src/config.ts)
# --------------------------------------------------------------------------------------------

# Environment value as the current process sees it ('Process') or as the scheduled task will
# see it at logon ('Task': the user variable, else the machine variable).
function Get-PtEnvValue {
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
function ConvertTo-PtPort {
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

function Get-PtPortSetting {
    param([ValidateSet('Process', 'Task')][string]$Scope = 'Process')
    $raw = Get-PtEnvValue -Name 'PORTLY_PORT' -Scope $Scope
    if ($null -eq $raw) {
        return [pscustomobject]@{ Port = $PortlyDefaultPort; Source = 'default' }
    }
    $label = if ($Scope -eq 'Task') { 'PORTLY_PORT (user/machine environment variable)' } else { 'PORTLY_PORT' }
    return [pscustomobject]@{ Port = (ConvertTo-PtPort -Value $raw -Source $label); Source = $label }
}

# The server resolves a relative PORTLY_DATA_DIR against its working directory, which is the
# repository root for the task, start.ps1 and `npm start` - so the same is done here (never
# against this PowerShell process's .NET current directory).
function Get-PtDataDir {
    param(
        [ValidateSet('Process', 'Task')][string]$Scope = 'Process',
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $raw = Get-PtEnvValue -Name 'PORTLY_DATA_DIR' -Scope $Scope
    if ($null -ne $raw) {
        if (-not [System.IO.Path]::IsPathRooted($raw)) { $raw = Join-Path $RepoRoot $raw }
        return [System.IO.Path]::GetFullPath($raw)
    }
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    return (Join-Path $localAppData 'Portly')
}

function Get-PtLogFile {
    param([Parameter(Mandatory)][string]$DataDir)
    return (Join-Path (Join-Path $DataDir 'logs') 'server.log')
}

# The supervisor (autostart) writes its own log next to server.log: restarts, "another Portly
# is already running", and why it stopped.
function Get-PtSupervisorLogFile {
    param([Parameter(Mandatory)][string]$DataDir)
    return (Join-Path (Join-Path $DataDir 'logs') 'supervisor.log')
}

# PORTLY_* variables whose value in this PowerShell window differs from the user/machine
# environment the scheduled task gets at logon (e.g. `$env:PORTLY_PORT = ...` typed in this
# window only). Each item: Name, Process, Task (either may be $null).
function Get-PtEnvMismatches {
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($name in $PortlyEnvNames) {
        $processValue = Get-PtEnvValue -Name $name -Scope Process
        $taskValue = Get-PtEnvValue -Name $name -Scope Task
        if ($processValue -cne $taskValue) {
            $result.Add([pscustomobject]@{ Name = $name; Process = $processValue; Task = $taskValue })
        }
    }
    return $result.ToArray()
}

# Loads server/src/config.ts with node exactly as the server does at startup (same PORTLY_*
# values for the scope, repository root as working directory), so a variable the server would
# reject is reported now instead of the autostarted server silently exiting at logon (its
# console output goes nowhere). $Override (name -> value, $null = unset) is for tests.
# Returns Ok, Error, Port, DataDir.
function Test-PtServerConfig {
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
    foreach ($name in $PortlyEnvNames) {
        $value = if ($Override.ContainsKey($name)) { $Override[$name] } else { Get-PtEnvValue -Name $name -Scope $Scope }
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
        if ((Get-PtProperty $json 'ok') -eq $true) {
            $result.Ok = $true
            $result.Port = [int](Get-PtProperty $json 'port')
            $result.DataDir = "$(Get-PtProperty $json 'dataDir')"
        } else {
            $result.Error = "$(Get-PtProperty $json 'error')"
        }
        return $result
    } finally {
        $process.Dispose()
    }
}

function Test-PtTruthy {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { return $false }
    return @('1', 'true', 'yes') -contains $Value.Trim().ToLowerInvariant()
}

# --------------------------------------------------------------------------------------------
# Health check (GET /api/health; exempt from the request gate)
# --------------------------------------------------------------------------------------------

# TCP listeners on a local port: @() when nothing listens, $null when this cannot be determined
# (no NetTCPIP module). Each item: Address, ProcessId. A listener is the socket with no remote end.
# Not -State Listen: Windows build 26300 reports states wrongly, and never Listen for a socket
# that just opened, so a server that had started looked like nothing listening.
function Get-PtPortListeners {
    param([Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port)
    if ($null -eq (Get-Command -Name 'Get-NetTCPConnection' -ErrorAction SilentlyContinue)) { return $null }
    $rows = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -eq '0.0.0.0' -or $_.RemoteAddress -eq '::' })
    $listeners = @($rows | ForEach-Object { [pscustomobject]@{ Address = "$($_.LocalAddress)"; ProcessId = [int]$_.OwningProcess } })
    # The comma keeps an empty or one-item array intact (PowerShell would unroll it).
    return , $listeners
}

# "node (PID 1234), svchost (PID 99)" for the processes listening on a port.
function Format-PtPortOwners {
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
function Test-PtHealth {
    param(
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        [ValidateRange(0.1, 60)][double]$TimeoutSeconds = 2
    )
    $result = [pscustomobject]@{
        Ok        = $false
        Url       = "http://localhost:$Port/api/health"
        Version   = $null
        Vault     = $null
        App       = $null
        Error     = $null
        Listeners = $null
    }
    $listeners = Get-PtPortListeners -Port $Port
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
        $ok = Get-PtProperty $json 'ok'
        if (-not ($ok -is [bool] -and $ok)) {
            $result.Error = "the answer is not a Portly health check (another program may be using port $Port)"
            return $result
        }
        $result.Ok = $true
        $result.Version = Get-PtProperty $json 'version'
        $result.Vault = Get-PtProperty $json 'vault'
        # 'portly' for Portly: another server on the port answers with another name, or none.
        $result.App = Get-PtProperty $json 'app'
        return $result
    } catch {
        $chain = @(Get-PtExceptionChain $_)
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
# returns false. Returns the last Test-PtHealth result. In the fancy output a spinner and a bar
# of the time allowed run meanwhile.
function Wait-PtHealth {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [scriptblock]$ContinueWhile,
        [string]$Activity = 'Waiting for Portly to answer'
    )
    $started = [System.DateTime]::UtcNow
    $deadline = $started.AddSeconds($TimeoutSeconds)
    $fancy = Test-PtFancyOutput
    $frame = 0
    Set-PtCursorVisible $false
    try {
        do {
            $last = Test-PtHealth -Port $Port -TimeoutSeconds 2
            if ($last.Ok) { return $last }
            if ($null -ne $ContinueWhile -and -not (& $ContinueWhile)) { return $last }
            if (-not $fancy) {
                Start-Sleep -Milliseconds 1000
                continue
            }
            $next = [System.DateTime]::UtcNow.AddMilliseconds(1000)
            while ([System.DateTime]::UtcNow -lt $next) {
                $elapsed = [System.DateTime]::UtcNow - $started
                $bar = Format-PtBar -Fraction ($elapsed.TotalSeconds / $TimeoutSeconds) -Width 24
                Write-PtSpinnerLine -Frame $frame -Text ((Format-PtStyle Sand $Activity) + '  ' + $bar + '  ' +
                    (Format-PtStyle Mist "$(Format-PtElapsed ([System.TimeSpan]::FromSeconds([Math]::Min($elapsed.TotalSeconds, $TimeoutSeconds)))) / ${TimeoutSeconds}s" -Dim))
                $frame++
                Start-Sleep -Milliseconds 80
            }
        } while ([System.DateTime]::UtcNow -lt $deadline)
        return $last
    } finally {
        Clear-PtSpinnerLine
        Set-PtCursorVisible $true
    }
}

function Format-PtHealth {
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

function Get-PtNodeVersion {
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
# PATH) and checks it is Node.js $PortlyNodeMajor: any other major, older or newer, is refused
# with the same message setup.ps1 gives, because npm ci (engine-strict) refuses it as well.
function Resolve-PtNode {
    param([string]$NodePath, [string]$RepoRoot)
    if ([string]::IsNullOrWhiteSpace($NodePath) -and -not [string]::IsNullOrWhiteSpace($RepoRoot)) {
        $bundled = Get-PtBundledNode -RepoRoot $RepoRoot
        if ($null -ne $bundled) { $NodePath = $bundled }
    }
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $command = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) {
            throw "node.exe was not found on PATH; $PortlyNodeInstallHint, or pass -NodePath."
        }
        $NodePath = $command.Source
    }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw "Node.js executable not found: $NodePath"
    }
    $full = (Resolve-Path -LiteralPath $NodePath).ProviderPath
    $version = Get-PtNodeVersion -NodeExe $full
    $major = [int]($version.Split('.')[0])
    if ($major -ne $PortlyNodeMajor) {
        throw "Portly needs Node.js $PortlyNodeMajor, found v$version ($full); $PortlyNodeInstallHint."
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
function Get-PtReleaseInfo {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $path = Join-Path $RepoRoot 'release.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $info = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    } catch {
        throw "$path is not valid JSON: $($_.Exception.Message)"
    }
    if ((Get-PtProperty $info 'name') -ne 'portly' -or [string]::IsNullOrWhiteSpace("$(Get-PtProperty $info 'version')")) {
        throw "$path does not describe a Portly release."
    }
    return $info
}

function Get-PtBundledNode {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $path = Join-Path $RepoRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    return $null
}

# The attributes of the entry itself (a link is not followed, so a link whose target is gone still
# counts), or $null when there is nothing at $Path.
function Get-PtEntryAttributes {
    param([Parameter(Mandatory)][string]$Path)
    try { return [System.IO.File]::GetAttributes($Path) } catch { return $null }
}

# Removes a directory junction (or symbolic link) itself, never what it points to.
function Remove-PtDirectoryLink {
    param([Parameter(Mandatory)][string]$Path)
    $attributes = Get-PtEntryAttributes -Path $Path
    if ($null -eq $attributes) { return }
    if (-not ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "$Path is a real folder, not a link; not removing it."
    }
    # Non-recursive Directory.Delete removes the reparse point only.
    [System.IO.Directory]::Delete($Path)
}

# The server imports @portly/shared, which npm links into node_modules in a checkout. A release
# package cannot carry that link (zip files have no junctions), so the installer creates it once
# the package sits in its final folder: node_modules\@portly\shared -> <RepoRoot>\shared. A
# junction needs no administrator rights; Node resolves it to shared\src, outside node_modules, so
# it still strips the TypeScript types there. Idempotent.
function Initialize-PtReleaseLinks {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $target = Join-Path $RepoRoot 'shared'
    if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf)) {
        throw "$target\package.json is missing: not a complete Portly package."
    }
    $scope = Join-Path $RepoRoot 'node_modules\@portly'
    if (-not (Test-Path -LiteralPath $scope)) { $null = New-Item -ItemType Directory -Path $scope -Force }
    $link = Join-Path $scope 'shared'
    $attributes = Get-PtEntryAttributes -Path $link
    if ($null -ne $attributes) {
        if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            $current = @(Get-PtProperty (Get-Item -LiteralPath $link -Force) 'Target') | Select-Object -First 1
            if ($current -and [System.IO.Path]::GetFullPath("$current").TrimEnd('\') -ieq $target.TrimEnd('\') -and
                (Test-Path -LiteralPath (Join-Path $link 'package.json') -PathType Leaf)) {
                return $link
            }
        }
        Remove-PtDirectoryLink -Path $link
    }
    $null = New-Item -ItemType Junction -Path $link -Target $target
    return $link
}

function Test-PtWebBuilt {
    param([Parameter(Mandatory)][string]$RepoRoot)
    return Test-Path -LiteralPath (Join-Path $RepoRoot 'web\dist\index.html') -PathType Leaf
}

function Test-PtDependenciesInstalled {
    param([Parameter(Mandatory)][string]$RepoRoot)
    return Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\hono\package.json') -PathType Leaf
}

# True when npm ci must run: no install yet, or package-lock.json changed since the last one.
function Test-PtDependenciesStale {
    param([Parameter(Mandatory)][string]$RepoRoot)
    if (-not (Test-PtDependenciesInstalled -RepoRoot $RepoRoot)) { return $true }
    $installed = Join-Path $RepoRoot 'node_modules\.package-lock.json'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { return $true }
    $lock = Get-Item -LiteralPath (Join-Path $RepoRoot 'package-lock.json')
    return $lock.LastWriteTimeUtc -gt (Get-Item -LiteralPath $installed).LastWriteTimeUtc
}

# The folder Portly is published in inside a <user>.github.io repository, from the site's URL
# (https://<user>.github.io/portly/ -> 'portly'); '' for any other repository or URL.
function Get-PtPagesSubfolder {
    param([AllowNull()][string]$PagesUrl, [AllowNull()][string]$PublicRepoPath)
    if ([string]::IsNullOrWhiteSpace($PagesUrl) -or [string]::IsNullOrWhiteSpace($PublicRepoPath)) { return '' }
    if ((Split-Path -Leaf $PublicRepoPath.TrimEnd('\', '/')) -notlike '*.github.io') { return '' }
    $uri = $null
    if (-not [System.Uri]::TryCreate($PagesUrl, [System.UriKind]::Absolute, [ref]$uri)) { return '' }
    $segments = @($uri.AbsolutePath.Trim('/') -split '/' | Where-Object { $_ })
    if ($segments.Count -eq 1 -and $segments[0] -match '^[A-Za-z0-9][A-Za-z0-9._-]*$') { return $segments[0] }
    return ''
}

# True when a person can answer a prompt: neither input nor output is redirected.
function Test-PtCanPrompt {
    try {
        return (-not [System.Console]::IsInputRedirected) -and (-not [System.Console]::IsOutputRedirected)
    } catch {
        return $false
    }
}

# Asks a yes/no question (Enter = yes). Returns $true for yes.
function Read-PtYesNo {
    param([Parameter(Mandatory)][string]$Question)
    while ($true) {
        $answer = (Read-Host "$Question [Y/n]").Trim().ToLowerInvariant()
        if ($answer -in '', 'y', 'yes') { return $true }
        if ($answer -in 'n', 'no') { return $false }
    }
}

# Runs `npm run build` in the repository (builds web\dist).
function Invoke-PtWebBuild {
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
    if (-not (Test-PtWebBuilt -RepoRoot $RepoRoot)) { throw 'npm run build finished but web\dist\index.html is missing.' }
}

# --------------------------------------------------------------------------------------------
# Scheduled task
# --------------------------------------------------------------------------------------------

function Test-PtScheduledTasksAvailable {
    return $null -ne (Get-Command -Name 'Register-ScheduledTask' -ErrorAction SilentlyContinue)
}

function Get-PtTask {
    return Get-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Get-PtCurrentUserId {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Test-PtElevated {
    $principal = New-Object System.Security.Principal.WindowsPrincipal ([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The task object exactly as install-autostart.ps1 registers it (nothing is registered here).
# -Trigger Browser: no trigger at all - the task only runs on demand, when the browser
# extension asks the native host (schtasks /run) or you run Start-ScheduledTask.
# -Trigger Logon: at log on of $UserId, optionally delayed.
function New-PtTaskDefinition {
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
    $description = $PortlyTaskDescriptions[$Trigger]
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
function Get-PtTaskTriggerMode {
    param([Parameter(Mandatory)]$Task)
    $triggers = @(@($Task.Triggers) | Where-Object { $null -ne $_ })
    if ($triggers.Count -eq 0) { return 'Browser' }
    $logon = @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    if ($logon.Count -gt 0) { return 'Logon' }
    return 'Other'
}

# One line describing when the task starts Portly.
function Format-PtTaskTrigger {
    param([Parameter(Mandatory)]$Task)
    $triggers = @(@($Task.Triggers) | Where-Object { $null -ne $_ })
    if ($triggers.Count -eq 0) {
        return 'none - Browser mode: runs on demand only (the browser extension starts it through the native host com.portly.launcher; or Start-ScheduledTask)'
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

function Write-PtTaskDefinition {
    param([Parameter(Mandatory)]$Task)
    $action = @($Task.Actions)[0]
    $settings = $Task.Settings
    Write-PtField 'Task' ("$PortlyTaskPath$PortlyTaskName")
    Write-PtField 'Description' $Task.Description
    Write-PtField 'Trigger' (Format-PtTaskTrigger -Task $Task)
    Write-PtField 'Principal' ("$($Task.Principal.UserId), LogonType $($Task.Principal.LogonType), RunLevel $($Task.Principal.RunLevel)")
    Write-PtField 'Execute' $action.Execute
    Write-PtField 'Arguments' $action.Arguments
    Write-PtField 'WorkingDir' $action.WorkingDirectory
    Write-PtField 'Time limit' ("$($settings.ExecutionTimeLimit) (none)")
    Write-PtField 'Batteries' ("DisallowStartIfOnBatteries $($settings.DisallowStartIfOnBatteries), StopIfGoingOnBatteries $($settings.StopIfGoingOnBatteries)")
    Write-PtField 'Instances' $settings.MultipleInstances
    Write-PtField 'On demand' ("AllowDemandStart $($settings.AllowDemandStart)")
    Write-PtField 'Start missed' ("StartWhenAvailable $($settings.StartWhenAvailable)")
    Write-PtField 'Priority' $settings.Priority
    Write-PtField 'Restart' ("RestartCount $($settings.RestartCount), RestartInterval $($settings.RestartInterval) (launch failures only; the supervisor restarts crashes)")
}

function Get-PtUpdaterTask {
    return Get-ScheduledTask -TaskName $PortlyUpdaterTaskName -TaskPath $PortlyTaskPath -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

# The Portly Updater task exactly as install-autostart.ps1 registers it, in a release install only
# (ARCHITECTURE section 18). No trigger: it runs when the server asks with schtasks /run. Task
# Scheduler owns the process, so the update outlives the server it stops. Its command is fixed
# here, so nothing from a request reaches it. Its working folder is never the install, which could
# then not be renamed.
function New-PtUpdaterDefinition {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$UserId
    )
    $powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $script = Join-Path $RepoRoot 'scripts\portly.ps1'
    $argument = '--headless "{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" --update --unattended' -f $powershell, $script
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $argument `
        -WorkingDirectory ([System.Environment]::GetFolderPath('LocalApplicationData'))
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $PortlyUpdaterTimeLimitMinutes) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    return New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description $PortlyUpdaterDescription
}

# Whether a registered task already is this definition, so it can be left alone.
function Test-PtUpdaterCurrent {
    param($Task, [Parameter(Mandatory)]$Definition)
    if ($null -eq $Task) { return $false }
    $current = @($Task.Actions)[0]
    $wanted = @($Definition.Actions)[0]
    return "$($current.Execute)" -eq "$($wanted.Execute)" -and "$($current.Arguments)" -eq "$($wanted.Arguments)" -and
        "$($current.WorkingDirectory)" -eq "$($wanted.WorkingDirectory)" -and
        "$($Task.Settings.ExecutionTimeLimit)" -eq "$($Definition.Settings.ExecutionTimeLimit)"
}

function Write-PtUpdaterDefinition {
    param([Parameter(Mandatory)]$Task)
    $action = @($Task.Actions)[0]
    $settings = $Task.Settings
    Write-PtField 'Task' ("$PortlyTaskPath$PortlyUpdaterTaskName")
    Write-PtField 'Description' $Task.Description
    Write-PtField 'Trigger' 'none - runs when the server asks (schtasks /run)'
    Write-PtField 'Principal' ("$($Task.Principal.UserId), LogonType $($Task.Principal.LogonType), RunLevel $($Task.Principal.RunLevel)")
    Write-PtField 'Execute' $action.Execute
    Write-PtField 'Arguments' $action.Arguments
    Write-PtField 'WorkingDir' $action.WorkingDirectory
    Write-PtField 'Time limit' $settings.ExecutionTimeLimit
    Write-PtField 'Instances' $settings.MultipleInstances
}

# A line of a log file with the home folder masked (ARCHITECTURE section 17), wherever it is, as
# maskUserPaths does in the server for C:\Users.
function ConvertTo-PtMaskedLine {
    param([AllowEmptyString()][string]$Line, [string]$HomeDir = $env:USERPROFILE)
    if ($HomeDir) { $Line = [regex]::Replace($Line, [regex]::Escape($HomeDir), '~', 'IgnoreCase') }
    return [regex]::Replace($Line, '(?i)([a-z]:[\\/]users[\\/])[^\\/"'']+', '$1~')
}

# Human-readable meaning of a task's LastTaskResult (exit codes 1, 3 and 4 come from the server).
function Format-PtTaskResult {
    param([Parameter(Mandatory)][int64]$Code)
    if ($Code -lt 0) { $Code += 4294967296 }
    $hex = '0x{0:X}' -f $Code
    switch ($Code) {
        0 { return "$hex (success)" }
        1 { return "$hex (Portly failed to start - see the logs, or run scripts\start.ps1 to see the error)" }
        3 { return "$hex (port already in use - another Portly instance is running)" }
        4 { return "$hex (Portly cannot start until fixed, e.g. web\dist is missing - run npm run build; see logs\supervisor.log)" }
        267009 { return "$hex (running)" }
        267011 { return "$hex (has not run yet)" }
        267014 { return "$hex (stopped by the user)" }
        2147750687 { return "$hex (an instance is already running)" }
        2147942402 { return "$hex (file not found - the task's node.exe or $PortlySupervisorProgram is missing; run install-autostart.ps1 again)" }
        2147946720 { return "$hex (the operator or administrator refused the request)" }
        default { return $hex }
    }
}

# --------------------------------------------------------------------------------------------
# Portly's copies of Node.js (ARCHITECTURE section 12)
#
# Task Manager's Details tab and Resource Monitor name a process after its program file. So the
# task runs a copy of node.exe named portly-supervisor.exe, and the supervisor starts the server
# as portly-server.exe next to it (server/src/supervisor.ts), instead of two plain node.exe. They
# live in %LOCALAPPDATA%\Portly\node, fixed per user like native-host (the bin folder there is on
# PATH for the portly command, so not that one). portly-server.exe is a hard link of
# portly-supervisor.exe (one file on disk), else a second copy. runtime.json records the node.exe
# they were copied from, so the scripts can bring them up to date when it changes. The copies are
# byte for byte the signed node.exe: Task Manager's Processes tab still shows "Node.js JavaScript
# Runtime" (the version resource is not changed).
# --------------------------------------------------------------------------------------------

# Fixed per-user folder of the copies (not under PORTLY_DATA_DIR, like the native host's).
function Get-PtRuntimeDir {
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'Could not find your local application data folder (%LOCALAPPDATA%).'
    }
    return (Join-Path (Join-Path $localAppData 'Portly') 'node')
}

# $true when $Path is the same build as $Source: both files exist, with the same size and
# modification times at most 2 s apart (a copy keeps the time; a hard link is the same file).
function Test-PtSameProgram {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Source)
    $a = New-Object System.IO.FileInfo -ArgumentList $Path
    $b = New-Object System.IO.FileInfo -ArgumentList $Source
    if (-not $a.Exists -or -not $b.Exists) { return $false }
    return ($a.Length -eq $b.Length -and [Math]::Abs(($a.LastWriteTimeUtc - $b.LastWriteTimeUtc).TotalSeconds) -le 2)
}

# runtime.json in a copies folder: Source (absolute node.exe path) and NodeVersion, or $null.
function Read-PtRuntimeRecord {
    param([Parameter(Mandatory)][string]$Destination)
    $path = Join-Path $Destination $PortlyRuntimeRecord
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { $json = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { return $null }
    $source = Get-PtProperty $json 'source'
    if (-not ($source -is [string]) -or -not [System.IO.Path]::IsPathRooted($source)) { return $null }
    return [pscustomobject]@{ Source = $source; NodeVersion = "$(Get-PtProperty $json 'nodeVersion')" }
}

# The copies in -Destination (default Get-PtRuntimeDir) compared with -NodeExe. State:
#   current   both are the same build as -NodeExe
#   stale     both exist, but one or both are another build (that node.exe was updated)
#   missing   one or both do not exist
function Get-PtRuntimePlan {
    param([Parameter(Mandatory)][string]$NodeExe, [string]$Destination)
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-PtRuntimeDir }
    $Destination = [System.IO.Path]::GetFullPath($Destination)
    $supervisor = Join-Path $Destination $PortlySupervisorProgram
    $server = Join-Path $Destination $PortlyServerProgram
    $supervisorCurrent = Test-PtSameProgram -Path $supervisor -Source $NodeExe
    $serverCurrent = Test-PtSameProgram -Path $server -Source $NodeExe
    $exist = (Test-Path -LiteralPath $supervisor -PathType Leaf) -and (Test-Path -LiteralPath $server -PathType Leaf)
    $state = if ($supervisorCurrent -and $serverCurrent) { 'current' } elseif ($exist) { 'stale' } else { 'missing' }
    return [pscustomobject]@{
        Source            = $NodeExe
        Destination       = $Destination
        SupervisorExe     = $supervisor
        ServerExe         = $server
        RecordPath        = (Join-Path $Destination $PortlyRuntimeRecord)
        State             = $state
        SupervisorCurrent = $supervisorCurrent
        ServerCurrent     = $serverCurrent
    }
}

# One line about a plan for the installer's summary.
function Format-PtRuntimePlan {
    param([Parameter(Mandatory)]$Plan)
    $names = "$PortlySupervisorProgram and $PortlyServerProgram in $($Plan.Destination)"
    switch ($Plan.State) {
        'current' { return "$names (copies of $($Plan.Source), up to date)" }
        'stale' { return "$names (to be refreshed from $($Plan.Source))" }
        default { return "$names (to be copied from $($Plan.Source))" }
    }
}

# A copy of $Source at $Target with the same modification time. It is written next to $Target
# first and then swapped in, so a failed copy never leaves a broken program behind. Throws when
# $Target cannot be replaced (for example while it runs). Setting the new file's modification time
# is tried again for a moment while something else (a virus scanner) reads it.
function Copy-PtProgram {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Target)
    $temp = "$Target.new"
    try {
        [System.IO.File]::Copy($Source, $temp, $true)
        [System.IO.File]::SetAttributes($temp, [System.IO.FileAttributes]::Normal)
        $built = [System.IO.File]::GetLastWriteTimeUtc($Source)
        Invoke-PtSharingRetry -Action { [System.IO.File]::SetLastWriteTimeUtc($temp, $built) }
        if (Test-Path -LiteralPath $Target) {
            [System.IO.File]::SetAttributes($Target, [System.IO.FileAttributes]::Normal)
            [System.IO.File]::Delete($Target)
        }
        [System.IO.File]::Move($temp, $Target)
    } finally {
        if (Test-Path -LiteralPath $temp) { try { [System.IO.File]::Delete($temp) } catch { } }
    }
}

# portly-server.exe as a hard link of portly-supervisor.exe (one file on disk), else a copy.
# Returns $true for a link.
function Set-PtServerProgram {
    param([Parameter(Mandatory)][string]$SupervisorExe, [Parameter(Mandatory)][string]$ServerExe)
    if (Test-Path -LiteralPath $ServerExe) {
        [System.IO.File]::SetAttributes($ServerExe, [System.IO.FileAttributes]::Normal)
        [System.IO.File]::Delete($ServerExe)
    }
    try {
        $null = New-Item -ItemType HardLink -Path $ServerExe -Target $SupervisorExe -ErrorAction Stop
        return $true
    } catch {
        Copy-PtProgram -Source $SupervisorExe -Target $ServerExe
        return $false
    }
}

# Makes the copies of a Get-PtRuntimePlan current, checks that portly-supervisor.exe runs (and
# reports -NodeVersion when given) and writes runtime.json. Never throws. Returns:
#   Ok       the copies are current and portly-supervisor.exe runs
#   Usable   the task can run portly-supervisor.exe anyway: an older copy could not be replaced
#            (it is in use: try again once Portly is stopped), or only portly-server.exe or
#            runtime.json failed (the supervisor makes portly-server.exe itself, or runs the server
#            as portly-supervisor.exe)
#   Changed  a copy was written
#   Linked   portly-server.exe is a hard link of portly-supervisor.exe (else a copy)
#   Version  the Node.js version portly-supervisor.exe reported
#   Error    what went wrong
function Update-PtRuntimeCopies {
    param([Parameter(Mandatory)]$Plan, [string]$NodeVersion)
    $result = [pscustomobject]@{ Ok = $false; Usable = $false; Changed = $false; Linked = $false; Version = $null; Error = $null }
    $stage = 'folder'
    try {
        $dir = $Plan.Destination
        if (Test-Path -LiteralPath $dir) {
            $item = Get-Item -LiteralPath $dir -Force
            if (-not $item.PSIsContainer) { throw "$dir exists but is not a folder." }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$dir is a link." }
        } else {
            $null = [System.IO.Directory]::CreateDirectory($dir)
        }
        $stage = 'supervisor'
        if (-not (Test-PtSameProgram -Path $Plan.SupervisorExe -Source $Plan.Source)) {
            Copy-PtProgram -Source $Plan.Source -Target $Plan.SupervisorExe
            $result.Changed = $true
        }
        $stage = 'verify'
        $result.Version = Get-PtNodeVersion -NodeExe $Plan.SupervisorExe
        if ($NodeVersion -and $result.Version -ne $NodeVersion) {
            throw "$($Plan.SupervisorExe) reports Node.js v$($result.Version), not v$NodeVersion."
        }
        $stage = 'server'
        if (Test-PtSameProgram -Path $Plan.ServerExe -Source $Plan.SupervisorExe) {
            $result.Linked = "$(Get-PtProperty (Get-Item -LiteralPath $Plan.ServerExe -Force) 'LinkType')" -eq 'HardLink'
        } else {
            $result.Linked = Set-PtServerProgram -SupervisorExe $Plan.SupervisorExe -ServerExe $Plan.ServerExe
            $result.Changed = $true
        }
        $stage = 'record'
        $record = '{"version":1,"source":' + (ConvertTo-PtJsonString $Plan.Source) + ',"nodeVersion":' + (ConvertTo-PtJsonString "$($result.Version)") + "}`r`n"
        $current = Read-PtRuntimeRecord -Destination $dir
        if ($null -eq $current -or $current.Source -ne $Plan.Source -or $current.NodeVersion -ne $result.Version) {
            [System.IO.File]::WriteAllBytes($Plan.RecordPath, [System.Text.Encoding]::ASCII.GetBytes($record))
        }
        $result.Ok = $true
        $result.Usable = $true
    } catch {
        $result.Error = $_.Exception.Message
        $kept = $stage -eq 'supervisor' -and (Test-Path -LiteralPath $Plan.SupervisorExe -PathType Leaf)
        $result.Usable = $kept -or $stage -eq 'server' -or $stage -eq 'record'
    }
    return $result
}

# The program a task's action starts (the path after --headless), or $null.
function Get-PtTaskProgram {
    param([Parameter(Mandatory)]$Task)
    $actions = @(Get-PtProperty $Task 'Actions' | Where-Object { $null -ne $_ })
    if ($actions.Count -eq 0) { return $null }
    if ("$(Get-PtProperty $actions[0] 'Arguments')" -match '--headless "([^"]+)"') { return $Matches[1] }
    return $null
}

# $true when $Path is portly-supervisor.exe in -Destination (default Get-PtRuntimeDir).
function Test-PtRuntimeProgram {
    param([AllowNull()][AllowEmptyString()][string]$Path, [string]$Destination)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-PtRuntimeDir }
    $expected = Join-Path ([System.IO.Path]::GetFullPath($Destination)) $PortlySupervisorProgram
    try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return $false }
    return $full -ieq $expected
}

# Before the task starts Portly again (update.ps1, portly --start, ...): when its action runs
# portly-supervisor.exe, makes the copies current with the node.exe runtime.json names (a copy is
# missing, or that node.exe was updated). Quiet when there is nothing to do: returns a line to
# show, or $null. -DryRun only says what it would do. Never throws.
function Sync-PtTaskRuntime {
    param($Task, [string]$Destination, [switch]$DryRun)
    try {
        if ($null -eq $Task) { return $null }
        $program = Get-PtTaskProgram -Task $Task
        if (-not (Test-PtRuntimeProgram -Path $program -Destination $Destination)) { return $null }
        $dir = Split-Path -Parent $program
        $hint = 'run scripts\install-autostart.ps1 again'
        $present = Test-Path -LiteralPath $program -PathType Leaf
        $record = Read-PtRuntimeRecord -Destination $dir
        if ($null -eq $record) {
            if ($present) { return $null }
            return "The task's program $program is missing and $PortlyRuntimeRecord does not say what it was copied from: $hint."
        }
        if (-not (Test-Path -LiteralPath $record.Source -PathType Leaf)) {
            if ($present) {
                return "$($record.Source) no longer exists; Portly keeps running its copy (Node.js v$($record.NodeVersion)). To change Node.js, $hint."
            }
            return "The task's program $program is missing, and so is $($record.Source), which it was copied from: $hint."
        }
        $plan = Get-PtRuntimePlan -NodeExe $record.Source -Destination $dir
        if ($plan.State -eq 'current') { return $null }
        $names = "$PortlySupervisorProgram and $PortlyServerProgram"
        if ($DryRun) { return "Would bring $names up to date with $($record.Source) (copies $($plan.State))." }
        $version = $null
        try { $version = Get-PtNodeVersion -NodeExe $record.Source } catch { $version = $null }
        $result = Update-PtRuntimeCopies -Plan $plan -NodeVersion $version
        if ($result.Ok) { return "Brought $names up to date (Node.js v$($result.Version) from $($record.Source))." }
        if ($result.Usable) { return "Could not update $names ($($result.Error)); Portly starts with the copies it has." }
        return "Could not make $names ($($result.Error)): $hint (it then runs node.exe)."
    } catch {
        return "Could not check Portly's copies of Node.js: $($_.Exception.Message)"
    }
}

# Starts the task, after Sync-PtTaskRuntime (its line, if any, is shown) and after stopping stale
# Portly servers that hold the port (Stop-PtStaleServers).
function Start-PtTask {
    $note = Sync-PtTaskRuntime -Task (Get-PtTask)
    if ($note) { Write-PtInfo $note }
    try {
        $null = Stop-PtStaleServers -Port (Get-PtPortSetting -Scope Task).Port
    } catch {
        Write-Warning "Could not check for stale servers: $($_.Exception.Message)"
    }
    Start-ScheduledTask -TaskName $PortlyTaskName -TaskPath $PortlyTaskPath
}

# --------------------------------------------------------------------------------------------
# Processes started by the task: conhost -> supervisor.ts -> index.ts, run by node.exe or by
# Portly's copies portly-supervisor.exe -> portly-server.exe
# (Stop-ScheduledTask ends only conhost; the other two must be stopped explicitly.)
# --------------------------------------------------------------------------------------------

# Lower-case file name of the program a command line starts
# ('"C:\Windows\System32\conhost.exe" --headless ...' -> 'conhost.exe').
function Get-PtCommandLineProgram {
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
# The program does not matter (node.exe, or Portly's copies portly-supervisor.exe and
# portly-server.exe). The task's conhost.exe host also has supervisor.ts on its command line but
# is not a supervisor: it is skipped (it exits by itself once the supervisor under it is gone).
# Each item: SupervisorId, SupervisorName, ChildIds, ChildNames (names '' when not reported).
function Select-PtSupervisorProcesses {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $needle = (Join-Path $RepoRoot 'server\src\supervisor.ts').ToLowerInvariant()
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($process in $Processes) {
        $commandLine = "$(Get-PtProperty $process 'CommandLine')"
        if (-not $commandLine) { continue }
        $normalized = $commandLine.Replace('/', '\').ToLowerInvariant()
        if (-not $normalized.Contains($needle)) { continue }
        $name = "$(Get-PtProperty $process 'Name')".ToLowerInvariant()
        if ($name -eq 'conhost.exe' -or (Get-PtCommandLineProgram $commandLine) -eq 'conhost.exe') { continue }
        $children = @($Processes | Where-Object {
                (Get-PtProperty $_ 'ParentProcessId') -eq $process.ProcessId -and
                (Get-PtProperty $_ 'ProcessId') -ne $process.ProcessId -and
                ($null -eq (Get-PtProperty $_ 'CreationDate') -or $null -eq (Get-PtProperty $process 'CreationDate') -or
                $_.CreationDate -ge $process.CreationDate)
            })
        $result.Add([pscustomobject]@{
                SupervisorId   = [int]$process.ProcessId
                SupervisorName = "$(Get-PtProperty $process 'Name')"
                ChildIds       = @($children | ForEach-Object { [int]$_.ProcessId })
                ChildNames     = @($children | ForEach-Object { "$(Get-PtProperty $_ 'Name')" })
            })
    }
    return $result.ToArray()
}

function Get-PtSupervisorProcesses {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
    return Select-PtSupervisorProcesses -Processes $all -RepoRoot $RepoRoot
}

# Stops each supervisor first (so it cannot restart the server), then its children.
# Returns the ids that were stopped.
function Stop-PtSupervisorProcesses {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $stopped = New-Object System.Collections.Generic.List[int]
    foreach ($tree in @(Get-PtSupervisorProcesses -RepoRoot $RepoRoot)) {
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

# Pure selection over Win32_Process-like objects (ProcessId, ParentProcessId, Name, CommandLine)
# and port listeners (ProcessId): the listening processes that are Portly servers
# (server\src\index.ts on the command line) with no supervisor above them, such as a leftover
# `node server\src\index.ts` from a development run. The task's own server has a supervisor as its
# parent and is never selected; neither is any program that is not running Portly's index.ts.
function Select-PtStaleServers {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [AllowNull()][AllowEmptyCollection()][object[]]$Listeners
    )
    $result = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Listeners) { return $result.ToArray() }
    foreach ($id in @($Listeners | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)) {
        $process = $Processes | Where-Object { [int](Get-PtProperty $_ 'ProcessId') -eq $id } | Select-Object -First 1
        if ($null -eq $process) { continue }
        $commandLine = "$(Get-PtProperty $process 'CommandLine')".Replace('/', '\').ToLowerInvariant()
        if (-not $commandLine.Contains('server\src\index.ts')) { continue }
        $parent = $Processes | Where-Object { [int](Get-PtProperty $_ 'ProcessId') -eq [int](Get-PtProperty $process 'ParentProcessId') } | Select-Object -First 1
        if ($null -ne $parent -and "$(Get-PtProperty $parent 'CommandLine')".Replace('/', '\').ToLowerInvariant().Contains('supervisor.ts')) { continue }
        $result.Add($process)
    }
    return $result.ToArray()
}

# Pure selection like Select-PtStaleServers: the listening processes that are Vite run from a
# Portly checkout's node_modules (the stand-in Pages site of `portly dev`, `npm run dev`,
# `npm run preview:static`), such as one left over from an earlier run. Any other program, Vite
# from another project included, is never selected.
function Select-PtStaleViteServers {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [AllowNull()][AllowEmptyCollection()][object[]]$Listeners
    )
    $result = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Listeners) { return $result.ToArray() }
    foreach ($id in @($Listeners | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)) {
        $process = $Processes | Where-Object { [int](Get-PtProperty $_ 'ProcessId') -eq $id } | Select-Object -First 1
        if ($null -eq $process) { continue }
        $commandLine = "$(Get-PtProperty $process 'CommandLine')".Replace('/', '\').ToLowerInvariant()
        $at = $commandLine.IndexOf('node_modules\vite\bin\vite.js')
        if ($at -gt 0 -and $commandLine.Substring(0, $at).Contains('portly')) { $result.Add($process) }
    }
    return $result.ToArray()
}

# Pure selection over Win32_Process-like objects and listeners (ProcessId, optional Port): every
# listening Portly process. Kind 'task' is the task's server (its parent runs supervisor.ts;
# SupervisorId names it), 'server' a Portly server with no supervisor (Select-PtStaleServers),
# 'vite' Vite run from a Portly checkout (Select-PtStaleViteServers). Any other program is never
# selected. Each item: ProcessId, Name, Kind, SupervisorId, Ports (sorted; empty without Port).
function Select-PtPortlyListeners {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [AllowNull()][AllowEmptyCollection()][object[]]$Listeners
    )
    $result = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Listeners) { return , $result.ToArray() }
    $stale = @(@(Select-PtStaleServers -Processes $Processes -Listeners $Listeners) | ForEach-Object { [int](Get-PtProperty $_ 'ProcessId') })
    $vite = @(@(Select-PtStaleViteServers -Processes $Processes -Listeners $Listeners) | ForEach-Object { [int](Get-PtProperty $_ 'ProcessId') })
    foreach ($id in @($Listeners | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)) {
        $process = $Processes | Where-Object { [int](Get-PtProperty $_ 'ProcessId') -eq $id } | Select-Object -First 1
        if ($null -eq $process) { continue }
        $kind = $null
        $supervisorId = $null
        if ($vite -contains $id) { $kind = 'vite' }
        elseif ($stale -contains $id) { $kind = 'server' }
        elseif ("$(Get-PtProperty $process 'CommandLine')".Replace('/', '\').ToLowerInvariant().Contains('server\src\index.ts')) {
            $kind = 'task'
            $supervisorId = [int](Get-PtProperty $process 'ParentProcessId')
        }
        if ($null -eq $kind) { continue }
        $ports = @($Listeners | Where-Object { [int]$_.ProcessId -eq $id -and $null -ne (Get-PtProperty $_ 'Port') } |
                ForEach-Object { [int](Get-PtProperty $_ 'Port') } | Sort-Object -Unique)
        $result.Add([pscustomobject]@{ ProcessId = $id; Name = "$(Get-PtProperty $process 'Name')"; Kind = $kind; SupervisorId = $supervisorId; Ports = $ports })
    }
    return , $result.ToArray()
}

# The listening Portly processes (Select-PtPortlyListeners) on $Port, or on every port without it.
# $null when this cannot be determined (no NetTCPIP module).
function Get-PtPortlyListeners {
    param([ValidateRange(0, 65535)][int]$Port = 0)
    if ($null -eq (Get-Command -Name 'Get-NetTCPConnection' -ErrorAction SilentlyContinue)) { return $null }
    $rows = if ($Port -gt 0) { @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue) } else { @(Get-NetTCPConnection -ErrorAction SilentlyContinue) }
    $listeners = @($rows | Where-Object { $_.RemoteAddress -eq '0.0.0.0' -or $_.RemoteAddress -eq '::' } |
            ForEach-Object { [pscustomobject]@{ Address = "$($_.LocalAddress)"; ProcessId = [int]$_.OwningProcess; Port = [int]$_.LocalPort } })
    if ($listeners.Count -eq 0) { return , @() }
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    return , (Select-PtPortlyListeners -Processes $all -Listeners $listeners)
}

# Every listening Portly process the task did not start, on any port (kinds 'server' and 'vite').
function Get-PtStrayServers {
    $found = Get-PtPortlyListeners
    if ($null -eq $found) { return $null }
    return , @($found | Where-Object { $_.Kind -ne 'task' })
}

# "Portly server node.exe PID 50 on port 5790; Vite node.exe PID 60 on ports 5175, 5176"
function Format-PtStrayServers {
    param([AllowNull()][AllowEmptyCollection()][object[]]$Strays)
    if ($null -eq $Strays) { return 'unknown' }
    if ($Strays.Count -eq 0) { return 'none' }
    $parts = foreach ($stray in $Strays) {
        $kind = switch ($stray.Kind) { 'vite' { 'Vite' } 'task' { 'Portly (task)' } default { 'Portly server' } }
        $ports = @($stray.Ports)
        $portText = if ($ports.Count -eq 1) { "port $($ports[0])" } else { "ports $($ports -join ', ')" }
        "$kind $($stray.Name) PID $($stray.ProcessId) on $portText"
    }
    return ($parts -join '; ')
}

# Pure: the overall state for the status banner from a Test-PtHealth result and the stray servers.
# Healthy (answers, vault ready, nothing stray), Warnings (answers, but the vault is not ready or
# other Portly servers run), Not running (nothing listens), Errors (something listens but Portly
# does not answer).
function Get-PtOverallStatus {
    param([Parameter(Mandatory)]$Health, [AllowNull()][AllowEmptyCollection()][object[]]$Strays)
    $strayCount = if ($null -eq $Strays) { 0 } else { @($Strays).Count }
    $notes = @()
    if (-not $Health.Ok) {
        if ($null -ne $Health.Listeners -and @($Health.Listeners).Count -gt 0) {
            return [pscustomobject]@{ State = 'Bad'; Text = 'Errors'; Detail = 'the port is taken but Portly does not answer' }
        }
        return [pscustomobject]@{ State = 'Bad'; Text = 'Not running'; Detail = 'portly start starts it' }
    }
    if ($Health.Vault -and $Health.Vault -ne 'ready') { $notes += "vault $($Health.Vault)" }
    if ($strayCount -gt 0) { $notes += $(if ($strayCount -eq 1) { '1 other server' } else { "$strayCount other servers" }) }
    if ($notes.Count -gt 0) { return [pscustomobject]@{ State = 'Warn'; Text = 'Warnings'; Detail = ($notes -join ', ') } }
    return [pscustomobject]@{ State = 'Ok'; Text = 'Healthy'; Detail = '' }
}

# Stops stale Portly servers holding $Port (see Select-PtStaleServers) so the task can start.
# Returns the stopped ids; shows a warning for each (program name and PID only).
function Stop-PtStaleServers {
    param([Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port)
    $listeners = Get-PtPortListeners -Port $Port
    if ($null -eq $listeners -or $listeners.Count -eq 0) { return @() }
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    $stopped = New-Object System.Collections.Generic.List[int]
    foreach ($stale in @(Select-PtStaleServers -Processes $all -Listeners $listeners)) {
        $id = [int]$stale.ProcessId
        Stop-Process -Id $id -Force -ErrorAction Stop
        $stopped.Add($id)
        Write-PtWarn "Stopped a stale Portly server on port $Port ($($stale.Name), PID $id): it was not started by the Portly Server task."
    }
    if ($stopped.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    return $stopped.ToArray()
}

# "supervisor portly-supervisor.exe PID 10 (server portly-server.exe PID 11)"; processes without a
# name are listed as before: "supervisor PID 10 (server PID 11, 12)".
function Format-PtProcessList {
    param([AllowEmptyCollection()][object[]]$Trees)
    if ($null -eq $Trees -or $Trees.Count -eq 0) { return 'none' }
    $parts = foreach ($tree in $Trees) {
        $supervisorName = "$(Get-PtProperty $tree 'SupervisorName')"
        $supervisor = if ($supervisorName) { "supervisor $supervisorName PID $($tree.SupervisorId)" } else { "supervisor PID $($tree.SupervisorId)" }
        $children = @($tree.ChildIds)
        $names = Get-PtProperty $tree 'ChildNames'
        if ($null -eq $names) { $names = @() }
        $names = @($names)
        if ($children.Count -eq 0) {
            $supervisor
        } elseif ($names.Count -eq $children.Count -and @($names | Where-Object { $_ }).Count -eq $names.Count) {
            $childText = @(for ($i = 0; $i -lt $children.Count; $i++) { "$($names[$i]) PID $($children[$i])" }) -join ', '
            "$supervisor (server $childText)"
        } else {
            "$supervisor (server PID $($children -join ', '))"
        }
    }
    return ($parts -join '; ')
}

# One line of server.log or supervisor.log for a person: a JSON record (one per line) as
# `<time> <LEVEL> [<area>] <msg> {the other fields}`; any other line as it is.
function Format-PtLogLine {
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
    $message = Get-PtProperty -Object $record -Name 'msg'
    if ($null -eq $message -or $null -eq $record.PSObject) { return $Line }
    $time = if ($Line -match '^\{"t":"([^"]*)"') { $Matches[1] } else { [string](Get-PtProperty -Object $record -Name 't') }
    $level = ([string](Get-PtProperty -Object $record -Name 'lvl')).ToUpperInvariant().PadRight(5)
    $area = Get-PtProperty -Object $record -Name 'area'
    $areaText = if ($area) { " [$area]" } else { '' }
    $rest = [ordered]@{}
    foreach ($property in $record.PSObject.Properties) {
        if (@('t', 'lvl', 'msg', 'area', 'tags') -notcontains $property.Name) { $rest[$property.Name] = $property.Value }
    }
    $fields = if ($rest.Count -gt 0) { ' ' + (ConvertTo-Json -InputObject $rest -Compress -Depth 8) } else { '' }
    return "$time $level$areaText $message$fields"
}

function Write-PtLogTail {
    param([Parameter(Mandatory)][string]$LogFile, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $LogFile -PathType Leaf)) {
        Write-PtInfo "No log file yet at $LogFile"
        return
    }
    Write-Host "---- last $Lines lines of $LogFile ----" -ForegroundColor DarkGray
    Get-Content -LiteralPath $LogFile -Tail $Lines | ForEach-Object { Write-Host (Format-PtLogLine -Line $_) }
    Write-Host '---- end of log ----' -ForegroundColor DarkGray
}

# --------------------------------------------------------------------------------------------
# Native messaging host com.portly.launcher (Chrome and Edge)
#
# The extension calls chrome.runtime.sendNativeMessage('com.portly.launcher', ...). The browser
# finds the host through HKCU\Software\<browser>\NativeMessagingHosts\com.portly.launcher
# (default value = path of the host manifest JSON) and runs launcher.cmd from
# %LOCALAPPDATA%\Portly\native-host, which runs launcher.mjs with node.exe. The launcher only
# ever runs "schtasks /run /tn \Portly Server": Task Scheduler starts the server, so it is not
# a child of the browser (whose isolated mode kills a native host's children with it).
# --------------------------------------------------------------------------------------------

# Fixed per-user folder for the host files, so the registry never points into the repository.
function Get-PtNativeHostDir {
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'Could not find your local application data folder (%LOCALAPPDATA%).'
    }
    return (Join-Path (Join-Path $localAppData 'Portly') 'native-host')
}

# Chrome/Edge extension ID from a SHA-256 digest: the first 16 bytes as hex, with the hex digits
# 0-f written as the letters a-p.
function ConvertTo-PtExtensionId {
    param([Parameter(Mandatory)][byte[]]$Hash)
    if ($Hash.Length -lt 16) { throw 'An extension ID needs at least 16 bytes of hash.' }
    $chars = New-Object char[] 32
    for ($i = 0; $i -lt 16; $i++) {
        $chars[2 * $i] = [char](97 + ($Hash[$i] -shr 4))
        $chars[2 * $i + 1] = [char](97 + ($Hash[$i] -band 15))
    }
    return (-join $chars)
}

function Get-PtSha256 {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return , $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
}

# Extension ID pinned by a manifest "key" (base64 DER SubjectPublicKeyInfo): the ID is derived
# from SHA-256 of the DER bytes. Chrome and Edge use the same algorithm. Like the browsers (and
# extension\tools\extension-id.mjs), whitespace and PEM armour lines are ignored.
function Get-PtExtensionIdFromKey {
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
    return ConvertTo-PtExtensionId -Hash (Get-PtSha256 -Bytes $der)
}

# The fixed ID of the unpacked extension, from the "key" in extension\manifest.json.
function Get-PtExtensionIdFromManifest {
    param([Parameter(Mandatory)][string]$ManifestPath)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "The extension manifest is missing: $ManifestPath"
    }
    try {
        $manifest = [System.IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    } catch {
        throw "Could not read $ManifestPath as JSON: $($_.Exception.Message)"
    }
    $key = Get-PtProperty $manifest 'key'
    if (-not ($key -is [string]) -or [string]::IsNullOrWhiteSpace($key)) {
        throw ("$ManifestPath has no ""key"" entry, so the extension's ID is not fixed and the native host cannot " +
            'name it in allowed_origins. Update your Portly checkout (the new-tab extension pins its ID with a "key"), ' +
            'or run the installer with -NoNativeHost.')
    }
    return Get-PtExtensionIdFromKey -Key $key
}

# A JSON string literal using only ASCII (\uXXXX for everything else).
function ConvertTo-PtJsonString {
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
function Get-PtOemEncoding {
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
function ConvertTo-PtBatchBytes {
    param([Parameter(Mandatory)][string]$Text, $Encoding)
    if ($Text -notmatch '[^\x00-\x7F]') { return , ([System.Text.Encoding]::ASCII.GetBytes($Text)) }
    try {
        if ($null -eq $Encoding) { $Encoding = Get-PtOemEncoding }
        return , ($Encoding.GetBytes($Text))
    } catch {
        throw ('The node.exe path has characters that a batch file cannot hold in this Windows code page. Pass -NodePath ' +
            'with a node.exe whose path has only plain ASCII characters (for example C:\Program Files\nodejs\node.exe).')
    }
}

# Everything the installer writes for the native host, computed without writing anything.
# Files: Name, Path, Bytes, Text ($null for the copied launcher.mjs), Source.
# Registry: Browser, SubKey (under HKEY_CURRENT_USER), Display, Value (the host manifest's path).
function New-PtNativeHostPlan {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$ExtensionId,
        [string]$Destination
    )
    if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw "Not an extension ID (32 letters a-p): '$ExtensionId'" }
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-PtNativeHostDir }
    $Destination = [System.IO.Path]::GetFullPath($Destination)
    $sourceDir = Join-Path $RepoRoot 'native-host'
    $launcherSource = Join-Path $sourceDir 'launcher.mjs'
    $templateSource = Join-Path $sourceDir 'launcher.cmd'
    foreach ($required in @($launcherSource, $templateSource)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "The native host file $required is missing from this Portly checkout."
        }
    }

    $template = [System.IO.File]::ReadAllText($templateSource)
    $pieces = $template.Split([string[]]@($PortlyNodePlaceholder), [System.StringSplitOptions]::None)
    if ($pieces.Count -ne 2) { throw "$templateSource must contain $PortlyNodePlaceholder exactly once." }
    # A batch file expands %...%, so a literal percent sign in the path is written as %%.
    $cmdText = $pieces[0] + $NodeExe.Replace('%', '%%') + $pieces[1]
    $cmdText = [regex]::Replace($cmdText, '\r?\n', "`r`n")
    if (-not $cmdText.EndsWith("`r`n")) { $cmdText += "`r`n" }

    $origin = "chrome-extension://$ExtensionId/"
    $cmdPath = Join-Path $Destination 'launcher.cmd'
    $manifestPath = Join-Path $Destination "$PortlyNativeHostName.json"
    $newline = "`r`n"
    $manifestText = (@(
            '{'
            ('  "name": {0},' -f (ConvertTo-PtJsonString $PortlyNativeHostName))
            ('  "description": {0},' -f (ConvertTo-PtJsonString $PortlyNativeHostDescription))
            ('  "path": {0},' -f (ConvertTo-PtJsonString $cmdPath))
            '  "type": "stdio",'
            '  "allowed_origins": ['
            ('    {0}' -f (ConvertTo-PtJsonString $origin))
            '  ]'
            '}'
        ) -join $newline) + $newline
    $configText = (@(
            '{'
            '  "version": 1,'
            '  "allowedOrigins": ['
            ('    {0}' -f (ConvertTo-PtJsonString $origin))
            '  ],'
            ('  "installedFrom": {0}' -f (ConvertTo-PtJsonString $RepoRoot))
            '}'
        ) -join $newline) + $newline

    $files = @(
        [pscustomobject]@{
            Name = 'launcher.mjs'; Path = (Join-Path $Destination 'launcher.mjs'); Text = $null; Source = $launcherSource
            Bytes = [System.IO.File]::ReadAllBytes($launcherSource)
        }
        [pscustomobject]@{
            Name = 'launcher.cmd'; Path = $cmdPath; Text = $cmdText; Source = $templateSource
            Bytes = (ConvertTo-PtBatchBytes -Text $cmdText)
        }
        [pscustomobject]@{
            Name = "$PortlyNativeHostName.json"; Path = $manifestPath; Text = $manifestText; Source = $null
            Bytes = [System.Text.Encoding]::ASCII.GetBytes($manifestText)
        }
        [pscustomobject]@{
            Name = 'config.json'; Path = (Join-Path $Destination 'config.json'); Text = $configText; Source = $null
            Bytes = [System.Text.Encoding]::ASCII.GetBytes($configText)
        }
    )
    $registry = @(foreach ($entry in $PortlyNativeHostRegistry) {
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
function Write-PtNativeHostPlan {
    param([Parameter(Mandatory)]$Plan)
    Write-PtField 'Host name' $PortlyNativeHostName
    Write-PtField 'Extension ID' "$($Plan.ExtensionId) (allowed origin $($Plan.Origin))"
    Write-PtField 'Folder' $Plan.Destination
    foreach ($file in @($Plan.Files)) {
        $bytes = [byte[]]$file.Bytes
        if ($null -eq $file.Text) {
            # (Get-PtSha256 returns its array as one object: assign it, never wrap it in @().)
            $digest = Get-PtSha256 -Bytes $bytes
            $hash = -join ($digest | ForEach-Object { $_.ToString('x2') })
            Write-PtField 'File' ("{0} (copy of {1}, {2} bytes, SHA-256 {3})" -f $file.Path, $file.Source, $bytes.Length, $hash)
        } else {
            Write-PtField 'File' ("{0} ({1} bytes):" -f $file.Path, $bytes.Length)
            foreach ($line in ($file.Text.TrimEnd("`r", "`n") -split "`r?`n")) { Write-Host "                   | $line" }
        }
    }
    foreach ($entry in @($Plan.Registry)) {
        Write-PtField 'Registry' "$($entry.Display)"
        Write-Host "                   (default) REG_SZ = $($entry.Value)   [$($entry.Browser)]"
    }
}

# HKEY_CURRENT_USER helpers (the .NET registry API behaves the same in PowerShell 5.1 and 7).
function Set-PtRegistryDefaultValue {
    param([Parameter(Mandatory)][string]$SubKey, [Parameter(Mandatory)][string]$Value)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
    try { $key.SetValue('', $Value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Close() }
}

# Default value of HKCU\<SubKey>: $null when the key does not exist, '' when it has none.
function Get-PtRegistryDefaultValue {
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

function Remove-PtRegistryKey {
    param([Parameter(Mandatory)][string]$SubKey)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($SubKey, $false)
}

# Writes the planned files and registry values (Chrome and Edge). Idempotent: files are rewritten
# and values overwritten. -RegistryWriter { param($SubKey, $Value) ... } replaces the HKCU write.
function Install-PtNativeHost {
    param([Parameter(Mandatory)]$Plan, [scriptblock]$RegistryWriter)
    if ($null -eq $RegistryWriter) {
        $RegistryWriter = { param([string]$SubKey, [string]$Value) Set-PtRegistryDefaultValue -SubKey $SubKey -Value $Value }
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
function Remove-PtFolderTree {
    param([Parameter(Mandatory)][string]$Path)
    foreach ($entry in (New-Object System.IO.DirectoryInfo -ArgumentList $Path).GetFileSystemInfos()) {
        $isLink = ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        $isFolder = ($entry.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
        if ($isFolder -and $isLink) {
            [System.IO.Directory]::Delete($entry.FullName)
        } elseif ($isFolder) {
            Remove-PtFolderTree -Path $entry.FullName
        } else {
            $entry.Attributes = [System.IO.FileAttributes]::Normal
            [System.IO.File]::Delete($entry.FullName)
        }
    }
    [System.IO.Directory]::Delete($Path)
}

# Removes only the given native-host folder (never its parent, never the target of a link).
# Returns $true when something was removed.
function Remove-PtNativeHostFolder {
    param([Parameter(Mandatory)][string]$Path)
    return (Remove-PtNamedFolder -Path $Path -Name 'native-host')
}

# Removes only the given folder of Portly's copies of Node.js (Get-PtRuntimeDir), the same way.
function Remove-PtRuntimeFolder {
    param([Parameter(Mandatory)][string]$Path)
    return (Remove-PtNamedFolder -Path $Path -Name 'node')
}

# Removes the folder $Path, which must be named $Name. Returns $true when something was removed.
function Remove-PtNamedFolder {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
    if ([System.IO.Path]::GetFileName($Path.TrimEnd([char]92)) -ne $Name) { throw "Refusing to remove '$Path': not a $Name folder." }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [System.IO.Directory]::Delete($Path)
    } elseif ($item.PSIsContainer) {
        Remove-PtFolderTree -Path $Path
    } else {
        throw "'$Path' is not a folder."
    }
    return $true
}

# Removes the registry keys (Chrome and Edge) and the native-host folder.
# -RegistryRemover { param($SubKey) ... } replaces the HKCU delete.
function Uninstall-PtNativeHost {
    param([string]$Destination, [scriptblock]$RegistryRemover)
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Get-PtNativeHostDir }
    if ($null -eq $RegistryRemover) {
        $RegistryRemover = { param([string]$SubKey) Remove-PtRegistryKey -SubKey $SubKey }
    }
    foreach ($entry in $PortlyNativeHostRegistry) {
        & $RegistryRemover $entry.SubKey
    }
    return (Remove-PtNativeHostFolder -Path $Destination)
}

# node.exe named in a generated launcher.cmd, or $null.
function Get-PtLauncherNodePath {
    param([Parameter(Mandatory)][string]$LauncherCmd)
    try {
        $text = [System.IO.File]::ReadAllText($LauncherCmd, (Get-PtOemEncoding))
    } catch {
        return $null
    }
    $match = [regex]::Match($text, '(?m)^\s*"([^"]+)"\s+"%~dp0launcher\.mjs"')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value.Replace('%%', '%')
}

# Problems with a registered host manifest and the files next to it (empty when all is well).
# $ExpectedId: the extension ID the manifest must allow ($null = do not check).
function Test-PtNativeHostManifest {
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
    if ((Get-PtProperty $manifest 'name') -cne $PortlyNativeHostName) {
        $problems.Add("the manifest's name is not $PortlyNativeHostName")
    }
    if ((Get-PtProperty $manifest 'type') -cne 'stdio') { $problems.Add('the manifest''s type is not "stdio"') }
    $description = Get-PtProperty $manifest 'description'
    if (-not ($description -is [string]) -or [string]::IsNullOrWhiteSpace($description)) {
        $problems.Add('the manifest has no description (browsers refuse such a host)')
    }

    $origins = @(@(Get-PtProperty $manifest 'allowed_origins') | Where-Object { $_ -is [string] })
    if ($ExpectedId) {
        $expected = "chrome-extension://$ExpectedId/"
        if (-not ($origins -ccontains $expected)) {
            $listed = if ($origins.Count -gt 0) { $origins -join ', ' } else { 'nothing' }
            $problems.Add("allowed_origins lists $listed, not $expected (the extension's ID changed): re-run install-autostart.ps1")
        }
    }

    $hostPath = Get-PtProperty $manifest 'path'
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
    $nodeExe = Get-PtLauncherNodePath -LauncherCmd $hostPath
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
    $configOrigins = @(@(Get-PtProperty $config 'allowedOrigins') | Where-Object { $_ -is [string] })
    if ($null -eq $config) {
        $problems.Add("config.json is missing or invalid in $hostDir")
    } elseif ($ExpectedId -and -not ($configOrigins -ccontains "chrome-extension://$ExpectedId/")) {
        $problems.Add("config.json does not allow chrome-extension://$ExpectedId/: re-run install-autostart.ps1")
    }
    return , $problems.ToArray()
}

# $true when the installed launcher.mjs is byte for byte this checkout's native-host\launcher.mjs,
# $false when it differs (Portly was updated but install-autostart.ps1 was not run again), $null
# when either file is missing.
function Test-PtInstalledLauncherCurrent {
    param([Parameter(Mandatory)][string]$InstalledDir, [Parameter(Mandatory)][string]$RepoRoot)
    $installed = Join-Path $InstalledDir 'launcher.mjs'
    $source = Join-Path $RepoRoot 'native-host\launcher.mjs'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
        return $null
    }
    # (Get-PtSha256 returns its array as one object: assign it, never wrap it in @().)
    $installedHash = Get-PtSha256 -Bytes ([System.IO.File]::ReadAllBytes($installed))
    $sourceHash = Get-PtSha256 -Bytes ([System.IO.File]::ReadAllBytes($source))
    return ([System.Convert]::ToBase64String($installedHash) -ceq [System.Convert]::ToBase64String($sourceHash))
}

# Registration state for Chrome and Edge: Browser, Key, Registered, ManifestPath, Problems.
# -RegistryReader { param($SubKey) ... } replaces the HKCU read (returns $null for a missing key).
function Get-PtNativeHostStatus {
    param([AllowNull()][AllowEmptyString()][string]$ExpectedId, [scriptblock]$RegistryReader)
    if ($null -eq $RegistryReader) {
        $RegistryReader = { param([string]$SubKey) Get-PtRegistryDefaultValue -SubKey $SubKey }
    }
    $results = foreach ($entry in $PortlyNativeHostRegistry) {
        $value = & $RegistryReader $entry.SubKey
        $problems = @()
        if ($null -ne $value -and "$value" -eq '') {
            $problems = @('the registry key has no default value (the manifest path)')
        } elseif ($null -ne $value) {
            $problems = Test-PtNativeHostManifest -ManifestPath "$value" -ExpectedId $ExpectedId
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
