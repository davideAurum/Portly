<#
.SYNOPSIS
    Installs the `portly` command (portly --rebuild, --status, --start, --help) for the
    current user.

.DESCRIPTION
    Writes two small launchers to %LOCALAPPDATA%\Portly\bin that run this checkout's
    scripts\portly.ps1: portly.cmd (PowerShell, Command Prompt) and portly (Git Bash).
    Adds that folder to your user PATH when it is missing, and with -PublicRepoPath stores the
    GitHub Pages clone in the PORTLY_PAGES_REPO user environment variable (used by
    portly --rebuild). Open a new terminal afterwards. Run it again after moving the checkout.

    On a PC that ran Homebase (Portly's name before the rename) it then removes the old
    `homebase` command: homebase.cmd and homebase in %LOCALAPPDATA%\Homebase\bin, that folder's
    user PATH entry, and the folder when it is empty. The rest of %LOCALAPPDATA%\Homebase stays.

    Refuses to run from a session worktree under .claude\worktrees (those are deleted when their
    session ends). Needs no administrator rights.

.PARAMETER PublicRepoPath
    Local clone of the public GitHub Pages repository (stored in PORTLY_PAGES_REPO).

.PARAMETER Uninstall
    Remove the launchers and the PATH entry (PORTLY_PAGES_REPO is kept).

.PARAMETER DryRun
    Print what would be written and changed, and change nothing.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cli.ps1 -PublicRepoPath C:\Code\me.github.io
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PublicRepoPath,
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')

function Get-CliBinDir {
    $localAppData = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'Could not find your local application data folder (%LOCALAPPDATA%).'
    }
    return (Join-Path (Join-Path $localAppData 'Portly') 'bin')
}

# The user PATH exactly as stored (unexpanded, so entries like %USERPROFILE%\bin survive).
function Get-CliUserPath {
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Test-CliPathHas {
    param([AllowEmptyString()][string]$PathValue, [Parameter(Mandatory)][string]$Dir)
    foreach ($entry in $PathValue.Split(';')) {
        $expanded = [System.Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd('\')
        if ($expanded -and $expanded -ieq $Dir.TrimEnd('\')) { return $true }
    }
    return $false
}

function Set-CliUserPath {
    param([AllowEmptyString()][string]$Value)
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $Value -Type ExpandString
    # Tell Explorer (and so new terminals) that the environment changed.
    if (-not ('PortlyCli.Native' -as [type])) {
        Add-Type -Namespace PortlyCli -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
    }
    $result = [System.UIntPtr]::Zero
    $null = [PortlyCli.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

function Invoke-InstallCli {
    $repoRoot = Get-HbRepoRoot -ScriptRoot $PSScriptRoot
    $binDir = Get-CliBinDir
    $prefix = if ($DryRun) { '[dry run] ' } else { '' }
    $userPath = Get-CliUserPath
    $onPath = Test-CliPathHas -PathValue $userPath -Dir $binDir

    if ($Uninstall) {
        foreach ($name in @('portly.cmd', 'portly')) {
            $file = Join-Path $binDir $name
            if (Test-Path -LiteralPath $file) {
                Write-HbStep "${prefix}Removing $file"
                if (-not $DryRun) { Remove-Item -LiteralPath $file -Force }
            }
        }
        if ($onPath) {
            Write-HbStep "${prefix}Removing $binDir from your user PATH"
            $kept = @($userPath.Split(';') | Where-Object {
                    $_.Trim() -and [System.Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd('\') -ine $binDir.TrimEnd('\')
                })
            if (-not $DryRun) { Set-CliUserPath -Value ($kept -join ';') }
        }
        Write-HbOk "${prefix}The portly command is removed."
        return 0
    }

    if (Test-HbWorktreePath -Path $repoRoot) {
        throw ("This is a temporary worktree ($repoRoot). Run install-cli.ps1 from the main checkout " +
            '(the folder that holds .claude\worktrees) so the command keeps working.')
    }
    if ($repoRoot.IndexOfAny([char[]]'%"') -ge 0) {
        throw "The checkout path contains % or a double quote, which the launcher cannot pass safely: $repoRoot"
    }
    $entry = Join-Path $repoRoot 'scripts\portly.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $cmdText = "@echo off`r`n`"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$entry`" %*`r`n"
    $shText = "#!/bin/sh`nexec powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$entry' `"`$@`"`n"
    $files = [ordered]@{ 'portly.cmd' = $cmdText; 'portly' = $shText }

    foreach ($name in $files.Keys) {
        $file = Join-Path $binDir $name
        Write-HbStep "${prefix}Writing $file"
        foreach ($line in $files[$name].TrimEnd().Split("`n")) { Write-HbInfo $line.TrimEnd("`r") }
        if (-not $DryRun) {
            $null = New-Item -ItemType Directory -Path $binDir -Force
            [System.IO.File]::WriteAllText($file, $files[$name], (New-Object System.Text.ASCIIEncoding))
        }
    }

    # The old `homebase` command (ARCHITECTURE section 19) goes once portly is in place: one PATH
    # write for both, then its launchers.
    $legacyCli = Get-HbLegacyCliPlan -UserPath $userPath
    $basePath = $userPath
    if (@($legacyCli.PathEntries).Count -gt 0) {
        Write-HbStep "${prefix}Removing the old homebase command's folder $($legacyCli.BinDir) from your user PATH"
        $basePath = $legacyCli.PathWithout
    }
    if ($onPath) {
        Write-HbOk "$binDir is already on your user PATH"
        $newPath = $basePath
    } else {
        Write-HbStep "${prefix}Adding $binDir to your user PATH"
        $newPath = if ($basePath.Trim()) { $basePath.TrimEnd(';') + ';' + $binDir } else { $binDir }
    }
    if ($newPath -cne $userPath -and -not $DryRun) { Set-CliUserPath -Value $newPath }
    foreach ($file in @($legacyCli.Files)) {
        Write-HbStep "${prefix}Removing the old homebase command: $file"
        if (-not $DryRun) { Remove-Item -LiteralPath $file -Force }
    }
    if (-not $DryRun -and @($legacyCli.Files).Count -gt 0 -and @(Get-ChildItem -LiteralPath $legacyCli.BinDir -Force).Count -eq 0) {
        # Only the empty bin folder: the rest of %LOCALAPPDATA%\Homebase (its data) stays.
        Remove-Item -LiteralPath $legacyCli.BinDir -Force
    }

    if (-not [string]::IsNullOrWhiteSpace($PublicRepoPath)) {
        $full = [System.IO.Path]::GetFullPath($PublicRepoPath)
        if (-not (Test-Path -LiteralPath (Join-Path $full '.git'))) {
            throw "Not a git repository: $full (it should be your local clone of the GitHub Pages repository)."
        }
        Write-HbStep "${prefix}Setting PORTLY_PAGES_REPO = $full (user environment variable)"
        if (-not $DryRun) { [System.Environment]::SetEnvironmentVariable('PORTLY_PAGES_REPO', $full, 'User') }
    } elseif ($null -eq (Get-HbReleaseInfo -RepoRoot $repoRoot) -and $null -eq (Get-HbEnvValue -Name 'PORTLY_PAGES_REPO' -Scope Task)) {
        # Only a Git checkout publishes the Pages site (portly --rebuild); a release install does not.
        Write-Warning 'PORTLY_PAGES_REPO is not set, so portly --rebuild will skip GitHub Pages. Run again with -PublicRepoPath to set it.'
    }

    if (-not $DryRun) {
        Write-HbOk 'Installed. Open a NEW terminal window, then try: portly --help'
    }
    return 0
}

try {
    $exitCode = Invoke-InstallCli | Select-Object -Last 1
    exit ([int]$exitCode)
} catch {
    Write-HbFailure $_.Exception.Message
    exit 1
}
