param(
    [switch]$Quiet
)

# Sidera Dual-Hemisphere Mediator - uninstall.
# Removes the program files, the Chrome native-messaging registration and the
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

# 1. Chrome native-messaging registration
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sidera.mediator"
if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse -Force
    Write-Host "Removed the Chrome native-messaging registration."
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
Write-Host "In Chrome, open chrome://extensions and remove 'Sidera Dual-Hemisphere Mediator' if it is still listed."
Write-Host "To disable Sidera without uninstalling, set autonomous_submissions = false in config.toml."
