import tempfile
import unittest
from pathlib import Path
from mediator.file_sandbox import FileSandbox, SandboxSecurityError

class TestFileSandbox(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.sandbox = FileSandbox(Path(self.temp_dir.name))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_write_and_read(self):
        self.sandbox.write_file("notes.md", "# Test Heading\nContent")
        content = self.sandbox.read_file("notes.md")
        self.assertEqual(content, "# Test Heading\nContent")

    def test_append_file(self):
        self.sandbox.write_file("log.txt", "line 1")
        self.sandbox.append_file("log.txt", "line 2")
        content = self.sandbox.read_file("log.txt")
        self.assertIn("line 1", content)
        self.assertIn("line 2", content)

    def test_path_traversal_prevention(self):
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.read_file("../outside.txt")
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.write_file("sub/../../escape.md", "data")

    def test_disallowed_extension(self):
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.write_file("script.py", "import os")

    def test_rejects_absolute_and_unc_paths(self):
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.write_file("C:/Windows/system.ini", "x")
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.write_file("\\\\server\\share\\notes.md", "x")
        with self.assertRaises(SandboxSecurityError):
            self.sandbox.read_file(str(Path(self.temp_dir.name).resolve().parent / "escape.md"))

    def test_list_files(self):
        self.sandbox.write_file("dir1/a.md", "a")
        self.sandbox.write_file("dir2/b.json", "{}")
        files = self.sandbox.list_files()
        self.assertEqual(files, ["dir1/a.md", "dir2/b.json"])

if __name__ == "__main__":
    unittest.main()
