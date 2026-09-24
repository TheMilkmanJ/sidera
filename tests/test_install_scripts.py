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
        self.assertIn("grok.com", vbs)
        self.assertNotIn("cmd.exe", vbs.lower())
        self.assertIn("python -u -m mediator.main", host)
        self.assertIn("PYTHONUNBUFFERED=1", host)


if __name__ == "__main__":
    unittest.main()
