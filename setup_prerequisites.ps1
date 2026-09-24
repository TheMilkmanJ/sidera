# Sidera installer for Windows 10/11.
# Detects an existing Python 3.10+ and does not reinstall it.
# Registers the Chrome native messaging host and offers a windowless desktop shortcut.

param(
    [ValidateSet("Ask", "Yes", "No")]
    [string]$DesktopIcon = "Ask"
)

$ErrorActionPreference = "Stop"
$InstallRoot = "C:\Sidera"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-YesNo([string]$Question, [bool]$Default = $true) {
    $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host "$Question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim().ToLowerInvariant().StartsWith("y")
}

function Find-SideraPython {
    $checks = @(
        @{ Exe = "py"; Args = @("-3", "-c", "import sys; print('%d.%d' % sys.version_info[:2])" },
        @{ Exe = "python"; Args = @("-c", "import sys; print('%d.%d' % sys.version_info[:2])" },
        @{ Exe = "python3"; Args = @("-c", "import sys; print('%d.%d' % sys.version_info[:2])" }
    )
    foreach ($check in $checks) {
        $cmd = Get-Command $check.Exe -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try {
            $versionText = (& $check.Exe @($check.Args) 2>$null | Select-Object -Last 1).Trim()
        } catch {
            continue
        }
        if ($versionText -notmatch '^(\d+)\.(\d+)$') { continue }
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $minimum = [version]"3.10"
        if (([version]"$major.$minor") -ge $minimum) {
            return @{ Executable = $cmd.Source; Version = $versionText }
        }
    }
    return $null
}

$python = Find-SideraPython
if ($python) {
    Write-Host "Found Python $($python.Version) at $($python.Executable). Skipping install."
} else {
    Write-Host "Python 3.10+ was not found. Installing Python 3.12 silently."
    winget install --id Python.Python.3.12 -e --silent --accept-package-agreements --accept-source-agreements
    $python = Find-SideraPython
    if (-not $python) {
        throw "Python 3.10+ is still not available after installation."
    }
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "data\logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "data\transcripts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "data\memory") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "data\files") | Out-Null

& robocopy $SourceRoot $InstallRoot /E /NFL /NDL /NJH /NJS /nc /ns /np /XD ".git" "uploads" "data" "__pycache__" /XF "*.pyc" | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy Sidera files to $InstallRoot (robocopy exit $LASTEXITCODE)."
}

$hostManifestPath = Join-Path $InstallRoot "com.sidera.mediator.json"
$hostBat = Join-Path $InstallRoot "run_mediator.bat"
$manifest = Get-Content -Raw -Path $hostManifestPath | ConvertFrom-Json
$manifest.path = $hostBat
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $hostManifestPath -Encoding ASCII

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sidera.mediator"
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name "(default)" -Value $hostManifestPath -PropertyType String -Force | Out-Null
Write-Host "Native messaging host registered: $hostManifestPath"

$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcher = Join-Path $InstallRoot "launch_silent.vbs"
$icon = Join-Path $InstallRoot "sidera.ico"
$shell = New-Object -ComObject WScript.Shell

function New-SideraShortcut([string]$Path) {
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = "//B `"$launcher`""
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.IconLocation = "$icon,0"
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Sidera Dual-Hemisphere Mediator"
    $shortcut.Save()
}

$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Sidera Mediator.lnk"
New-SideraShortcut $startMenu
Write-Host "Start menu entry created: $startMenu"

$wantDesktopIcon = switch ($DesktopIcon) {
    "Yes" { $true }
    "No" { $false }
    default { Read-YesNo "Put a Sidera Mediator icon on the desktop?" $true }
}
if ($wantDesktopIcon) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "Sidera Mediator.lnk"
    New-SideraShortcut $shortcutPath
    Write-Host "Desktop shortcut targets windowless launcher: $launcher"
} else {
    Write-Host "No desktop icon. Use the Start menu entry or run $launcher"
}

Write-Host ""
Write-Host "Done. Double-click Sidera Mediator. Chrome opens ChatGPT and Gemini with the extension loaded."
Write-Host "Extension ID pekgjaanmdkkpclhlobpcggibbkgjbgd"
