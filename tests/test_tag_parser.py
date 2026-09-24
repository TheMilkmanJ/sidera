import tempfile
import unittest
from pathlib import Path
from mediator.file_sandbox import FileSandbox
from mediator.memory_store import MemoryStore
from mediator.tag_parser import TagParser

class TestTagParser(unittest.TestCase):
    def setUp(self):
        self.parser = TagParser()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.memory = MemoryStore(Path(self.temp_dir.name) / "memory")
        self.sandbox = FileSandbox(Path(self.temp_dir.name) / "files")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parse_memory_write(self):
        raw = """
Here is my evaluation.
[[SIDERA: MEMORY_WRITE category="inventions" project="gyrocell"]]
Baseline working-fluid decision: use Galinstan rather than Nak.
[[/SIDERA]]
Let's continue to the next step.
"""
        clean_text, ops, errors = self.parser.parse(raw)
        self.assertEqual(len(errors), 0)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["type"], "MEMORY_WRITE")
        self.assertEqual(ops[0]["attributes"]["category"], "inventions")
        self.assertEqual(ops[0]["attributes"]["project"], "gyrocell")
        self.assertIn("Baseline working-fluid decision", ops[0]["body"])
        self.assertNotIn("[[SIDERA", clean_text)
        self.assertIn("Here is my evaluation.", clean_text)
        self.assertIn("Let's continue to the next step.", clean_text)

    def test_execute_memory_and_file_ops(self):
        raw_write = '[[SIDERA: MEMORY_WRITE category="tech" project="p1"]]Key architectural insight[[/SIDERA]]'
        _, ops, _ = self.parser.parse(raw_write)
        self.parser.execute_operations(ops, self.memory, self.sandbox, "LEFT", "MSG-1")
        raw_read = '[[SIDERA: MEMORY_READ category="tech" project="p1"]]insight[[/SIDERA]]'
        _, read_ops, _ = self.parser.parse(raw_read)
        injections, controls = self.parser.execute_operations(
            read_ops, self.memory, self.sandbox, "RIGHT", "MSG-2"
        )
        self.assertTrue(any("Key architectural insight" in inj for inj in injections))
        self.assertFalse(controls["pause"])

    def test_control_tags(self):
        raw_pause = 'Please stop here. [[SIDERA: PAUSE reason="Awaiting verification"]] Done.'
        clean, ops, _ = self.parser.parse(raw_pause)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["type"], "PAUSE")
        _, controls = self.parser.execute_operations(ops, self.memory, self.sandbox, "LEFT", "MSG-3")
        self.assertTrue(controls["pause"])
        self.assertEqual(controls["reason"], "Awaiting verification")

if __name__ == "__main__":
    unittest.main()
