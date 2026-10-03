import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestInstallScripts(unittest.TestCase):
    def test_installer_detects_existing_python_before_install(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        bat = (ROOT / "INSTALL.bat").read_text(encoding="utf-8")
        self.assertIn("setup_prerequisites.ps1", bat)
        self.assertIn("3.11", ps1)
        self.assertIn("Skipping install", ps1)
        self.assertLess(ps1.index("Skipping install"), ps1.index("winget install"))

    def test_native_host_registry_points_at_manifest(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        manifest = (ROOT / "com.sidera.mediator.json").read_text(encoding="utf-8")
        # The installer loops over $nativeHives; Chrome must be in the list and
        # every hive must gain the com.sidera.mediator key under HKCU.
        self.assertIn('"Software\\Google\\Chrome"', ps1)
        self.assertIn("HKCU:\\$hive\\NativeMessagingHosts\\com.sidera.mediator", ps1)
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

    def test_python_path_refresh_avoids_reboot(self):
        # winget updates the registry PATH, not the running session; the
        # installer must refresh it so the install finishes in one go.
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        self.assertIn("function Update-SessionPath", ps1)
        self.assertIn('GetEnvironmentVariable("Path", "Machine")', ps1)
        self.assertIn('GetEnvironmentVariable("Path", "User")', ps1)
        winget = ps1.index("winget install")
        refresh = ps1.index("Update-SessionPath", winget)
        retry = ps1.index("Find-SideraPython", winget)
        self.assertLess(refresh, retry, "PATH is refreshed before Python is looked up again")

    def test_chrome_setup_is_documented_honestly(self):
        # Branded Chrome 137+ ignores --load-extension, so the docs must not
        # claim automatic loading, and the Load-unpacked walkthrough must
        # exist with every screenshot it references.
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertNotIn("nothing needs to be loaded by hand", readme)
        self.assertIn("Load unpacked", readme)
        self.assertIn("docs/INSTALL.md", readme)

        vbs = (ROOT / "launch_silent.vbs").read_text(encoding="utf-8")
        self.assertIn("Chrome 137", vbs, "the launcher says why the flag is only a fallback")
        self.assertIn("docs/INSTALL.md", vbs)
        self.assertEqual(vbs.count("--new-window"), 2, "each side opens in its own window")

        install_doc = ROOT / "docs" / "INSTALL.md"
        self.assertTrue(install_doc.exists())
        text = install_doc.read_text(encoding="utf-8")
        self.assertIn("chrome://extensions", text)
        self.assertIn("C:\\Sidera\\chrome-extension", text)
        self.assertIn("pekgjaanmdkkpclhlobpcggibbkgjbgd", text)
        self.assertIn("If it doesn't show up", text)
        import re
        images = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text)
        self.assertGreaterEqual(len(images), 3, "the real Chrome captures are kept")
        for image in images:
            self.assertTrue((install_doc.parent / image).exists(), f"missing screenshot {image}")
            self.assertNotIn("pending", image.lower())

        # Every step either shows a real screenshot or says plainly that its
        # screenshot is still pending; no step silently has no picture.
        sections = re.split(r"^(?=## Stage 1|### )", text, flags=re.M)[1:]
        self.assertGreaterEqual(len(sections), 8, "Stage 1 plus steps 1-7")
        for section in sections:
            heading = section.splitlines()[0]
            has_image = re.search(r"!\[[^\]]*\]\(", section) is not None
            has_marker = "[screenshot pending" in section
            self.assertTrue(has_image or has_marker, f"no screenshot and no pending marker: {heading}")

        # Steps 3 and 4 are Windows steps: they must not show the Linux test
        # machine's picker or its /workspace path, and must name the folder.
        self.assertNotIn("/workspace", text)
        for name in ("install-3-choose-folder.png", "install-4-folder-path.png", "install-6-popup.png"):
            self.assertNotIn(name, text, f"{name} is not a real Windows/toolbar capture")
        step3 = text.split("### 3.")[1].split("### 4.")[0]
        step4 = text.split("### 4.")[1].split("### 5.")[0]
        self.assertIn("[screenshot pending (Windows)]", step3)
        self.assertIn("[screenshot pending (Windows)]", step4)
        self.assertIn("C:\\Sidera\\chrome-extension", step4)
        self.assertIn("[screenshot pending]", text.split("### 7.")[1].split("## If it")[0], "the popup shot is pending")

        # The manifest key pins the ID; it does not change with the folder.
        self.assertNotIn("different ID and will", text)
        self.assertNotIn("produces a different ID", text)
        self.assertNotIn("different ID", text, "no troubleshooting tip about a changed ID either")
        self.assertIn("same whichever folder", text)

    def test_installer_opens_the_html_guide(self):
        # A .md file opens as raw text on Windows; the installer opens the
        # HTML build of the same guide in the default browser.
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        self.assertIn('docs\\INSTALL.html', ps1)
        self.assertIn("Start-Process -FilePath $installGuide", ps1)
        self.assertNotIn("docs\\INSTALL.md", ps1)

        import re
        page = (ROOT / "docs" / "INSTALL.html").read_text(encoding="utf-8")
        source = (ROOT / "docs" / "INSTALL.md").read_text(encoding="utf-8")
        self.assertIn("<style>", page, "styles are inline; no external files needed")
        self.assertNotIn("<link", page)
        self.assertNotIn("/workspace", page)
        sources = re.findall(r'<img[^>]+src="([^"]+)"', page)
        self.assertEqual(sorted(sources), sorted(re.findall(r"!\[[^\]]*\]\(([^)]+)\)", source)))
        for src in sources:
            self.assertFalse(re.match(r"^[a-z]+:|^/", src), f"image path must be relative: {src}")
            self.assertTrue((ROOT / "docs" / src).exists(), src)
        self.assertEqual(page.count("[screenshot pending"), source.count("[screenshot pending"))
        self.assertIn("C:\\Sidera\\chrome-extension", page)
        self.assertTrue((ROOT / "scripts" / "build_install_html.py").exists())

    def test_tech_rundown_is_current(self):
        rundown = (ROOT / "docs" / "TECH-RUNDOWN-for-Taylor.md").read_text(encoding="utf-8")
        import json
        import re
        version = json.loads((ROOT / "chrome-extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
        title = rundown.splitlines()[0]
        match = re.search(r"v(\d+(?:\.\d+)*)", title)
        self.assertIsNotNone(match, title)
        self.assertTrue(version.startswith(match.group(1)), f"title {title!r} vs manifest {version}")
        flat = re.sub(r"\s+", " ", rundown)
        self.assertNotIn("screenshot for every step", flat)
        self.assertIn("ChatGPT vs Gemini", flat, "the long burn-ins are named honestly")
        self.assertIn("ChatGPT vs ChatGPT", flat)
        self.assertIn("passed only in code and simulation", flat, "section 12 is not claimed as passed live")
        self.assertIn("not been run live yet on your Windows PC with Google Chrome", flat)
        self.assertIn("native messaging", rundown)
        self.assertNotIn("8765", rundown, "the WebSocket port claim is stale")
        self.assertNotIn("WebSocket on 127", rundown)
        self.assertIn("opt-in", rundown.lower(), "saved logins are disclosed as opt-in (spec 11.3)")
        self.assertIn("no terminal", rundown)
        self.assertIn("idle", rundown.lower())

    def test_idle_timeout_is_configurable(self):
        example = (ROOT / "config.example.toml").read_text(encoding="utf-8")
        self.assertIn("idle_timeout_minutes", example)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("idle_timeout_minutes", readme)

    def test_desktop_icon_is_offered(self):
        ps1 = (ROOT / "setup_prerequisites.ps1").read_text(encoding="utf-8")
        bat = (ROOT / "INSTALL.bat").read_text(encoding="utf-8")
        self.assertIn("icon on the desktop?", ps1)
        self.assertIn('[ValidateSet("Ask", "Yes", "No")]', ps1)
        self.assertIn('GetFolderPath("Programs")', ps1)
        self.assertIn("%*", bat)


if __name__ == "__main__":
    unittest.main()
