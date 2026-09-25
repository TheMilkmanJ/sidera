import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestInstallScripts(unittest.TestCase):
    def test_installer_detects_existing_python_before_install(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        bat = (ROOT / "INSTALL.bat").read_text(encoding="utf-8")
        self.assertIn("setup_prerequisites.ps1", bat)
        self.assertIn("3.10", ps1)
        self.assertIn("Skipping install", ps1)
        self.assertLess(ps1.index("Skipping install"), ps1.index("winget install"))

    def test_native_host_registry_points_at_manifest(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        manifest = (ROOT / "com.sidera.mediator.json").read_text(encoding="utf-8")
        self.assertIn("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.sidera.mediator", ps1)
        self.assertIn("com.sidera.mediator.json", ps1)
        self.assertIn("com.sidera.mediator", manifest)
        self.assertIn("chrome-extension://pekgjaanmdkkpclhlobpcggibbkgjbgd/", manifest)
        self.assertIn('"type": "stdio"', manifest)

    def test_shortcut_targets_windowless_launcher(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        vbs = (ROOT / "launch_silent.vbs").read_text(encoding="utf-8")
        host = (ROOT / "run_mediator.bat").read_text(encoding="utf-8")
        self.assertIn("wscript.exe", ps1)
        self.assertIn("launch_silent.vbs", ps1)
        self.assertIn("sidera.ico", ps1)
        self.assertIn("//B", ps1)
        self.assertIn("chatgpt.com", vbs)
        self.assertIn("gemini.google.com", vbs)
        self.assertIn("--load-extension=", vbs)
        # Trusted key presses go through chrome.debugger; this flag hides the infobar.
        self.assertIn("--silent-debugger-extension-api", vbs)
        import json
        manifest = json.loads((ROOT / "chrome-extension" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("debugger", manifest["permissions"])
        self.assertNotIn("cmd.exe", vbs.lower())
        self.assertIn("python -u -m mediator.main", host)
        self.assertIn("PYTHONUNBUFFERED=1", host)

    def test_uninstall_keeps_memory_and_config(self):
        ps1 = (ROOT / "uninstall.ps1").read_text(encoding="utf-8")
        bat = (ROOT / "UNINSTALL.bat").read_text(encoding="utf-8")
        self.assertIn("uninstall.ps1", bat)
        self.assertIn('$_.Name -ne "data"', ps1)
        self.assertIn('$_.Name -ne "config.toml"', ps1)
        self.assertIn("NativeMessagingHosts\\com.sidera.mediator", ps1)
        self.assertIn('"Sidera Mediator.lnk"', ps1)
        # The data folder must never be a removal target.
        self.assertNotIn("Remove-Item -Path $DataRoot", ps1)

    def test_installer_creates_config_without_overwriting(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        self.assertIn("config.example.toml", ps1)
        self.assertIn("if (-not (Test-Path $configPath))", ps1)
        self.assertTrue((ROOT / "config.example.toml").exists())
        for doc in ("tag_protocol.md", "data_schema.md", "maintenance_selectors.md", "uninstall_and_disable.md", "third_party.md"):
            self.assertTrue((ROOT / "docs" / doc).exists(), doc)

    def test_desktop_icon_is_offered(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        bat = (ROOT / "INSTALL.bat").read_text(encoding="utf-8")
        self.assertIn("icon on the desktop?", ps1)
        self.assertIn('[ValidateSet("Ask", "Yes", "No")]', ps1)
        self.assertIn('GetFolderPath("Programs")', ps1)
        self.assertIn("%*", bat)


if __name__ == "__main__":
    unittest.main()
