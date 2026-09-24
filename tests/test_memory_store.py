import tempfile
import unittest
from pathlib import Path
from mediator.memory_store import MemoryStore

class TestMemoryStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = MemoryStore(Path(self.temp_dir.name))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_write_and_read(self):
        entry = self.store.write_memory(
            category="inventions",
            content="Working fluid selection: Galinstan.",
            project="gyrocell",
            source="LEFT",
            parent_message_id="SIDERA-000001",
        )
        self.assertEqual(entry["id"], "MEM-000001")
        self.assertEqual(entry["category"], "inventions")
        results = self.store.read_memory(category="inventions", project="gyrocell")
        self.assertEqual(len(results), 1)
        self.assertIn("Galinstan", results[0]["content"])

    def test_markdown_mirror(self):
        self.store.write_memory(
            category="business",
            content="Q3 Revenue target defined.",
            project="finance",
        )
        md_file = Path(self.temp_dir.name) / "business.md"
        self.assertTrue(md_file.is_file())
        md_text = md_file.read_text(encoding="utf-8")
        self.assertIn("Q3 Revenue target defined.", md_text)
        self.assertIn("finance", md_text)

    def test_query_filter(self):
        self.store.write_memory("core", "First alpha prototype test")
        self.store.write_memory("core", "Second beta prototype test")
        self.store.write_memory("core", "Unrelated meeting notes")
        matches = self.store.read_memory(category="core", query="prototype")
        self.assertEqual(len(matches), 2)

if __name__ == "__main__":
    unittest.main()
