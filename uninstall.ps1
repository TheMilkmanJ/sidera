param(
    [switch]$Quiet
)

# Sidera Dual-Hemisphere Mediator - uninstall.
# Removes the program files, the native-messaging registrations and the
# shortcuts. It never touches C:\Sidera\data (ledger, transcripts, logs,
# memory, files) or config.toml, so Sidera's memory survives a reinstall.

$ErrorActionPreference = "Stop"
$InstallRoot = "C:\Sidera"
$DataRoot = Join-Path $InstallRoot "data"

Write-Host ""
Write-Host "Sidera Mediator - uninstall" -ForegroundColor Cyan
Write-Host "Program files under $InstallRoot will be removed."
Write-Host "Your data in $DataRoot and config.toml are kept." -ForegroundColor Yellow
Write-Host ""

if (-not $Quiet) {
    $answer = Read-Host "Continue? (Y/n)"
    if ($answer -and $answer.Trim().ToLower().StartsWith("n")) {
        Write-Host "Nothing was changed."
        exit 0
    }
}

# 1. Native-messaging registration for every browser the installer and launcher know.
# Keep this list in step with setup_prerequisites.ps1 and NativeHive in launch_silent.vbs.
$nativeHives = @(
    "Software\Google\Chrome",
    "Software\Google\Chrome Beta",
    "Software\Google\Chrome Dev",
    "Software\Google\Chrome SxS",
    "Software\Microsoft\Edge",
    "Software\Microsoft\Edge Beta",
    "Software\Microsoft\Edge Dev",
    "Software\Microsoft\Edge SxS",
    "Software\BraveSoftware\Brave-Browser",
    "Software\Vivaldi",
    "Software\Opera Software\Opera Stable",
    "Software\Opera Software\Opera GX Stable",
    "Software\Chromium"
)
foreach ($hive in $nativeHives) {
    $registryPath = "HKCU:\$hive\NativeMessagingHosts\com.sidera.mediator"
    if (Test-Path $registryPath) {
        Remove-Item -Path $registryPath -Recurse -Force
        Write-Host "Removed native-messaging registration: $hive"
    }
}

# 2. Shortcuts
foreach ($folder in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    $link = Join-Path $folder "Sidera Mediator.lnk"
    if (Test-Path $link) {
        Remove-Item -Path $link -Force
        Write-Host "Removed shortcut $link"
    }
}

# 3. Program files (everything under C:\Sidera except data\ and config.toml)
if (Test-Path $InstallRoot) {
    Get-ChildItem -Path $InstallRoot -Force | Where-Object {
        $_.Name -ne "data" -and $_.Name -ne "config.toml"
    } | ForEach-Object {
        Remove-Item -Path $_.FullName -Recurse -Force
    }
    Write-Host "Removed program files from $InstallRoot."
}

Write-Host ""
Write-Host "Done. Sidera's memory, transcripts, logs and ledger are still in $DataRoot." -ForegroundColor Green
Write-Host "In the browser Sidera opened, open its extensions page and remove 'Sidera Dual-Hemisphere Mediator' if it is still listed."
Write-Host "To disable Sidera without uninstalling, set autonomous_submissions = false in config.toml."
