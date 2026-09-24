import tempfile
import unittest
from pathlib import Path
from mediator.message_ledger import MessageLedger

class TestMessageLedger(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "ledger.sqlite"
        self.ledger = MessageLedger(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_capture_and_deduplication(self):
        msg = "Hello from ChatGPT"
        record = self.ledger.capture_message(
            conversation_id="test-conv",
            source="LEFT",
            destination="RIGHT",
            content=msg,
        )
        self.assertEqual(record["message_id"], "SIDERA-0000001")
        self.assertEqual(record["status"], "CAPTURED")
        self.assertTrue(self.ledger.is_duplicate(msg, "LEFT"))
        self.assertFalse(self.ledger.is_duplicate("Different message", "LEFT"))
        self.assertFalse(self.ledger.is_duplicate(msg, "RIGHT"))

    def test_status_transitions(self):
        record = self.ledger.capture_message("conv1", "LEFT", "RIGHT", "Sample")
        msg_id = record["message_id"]
        self.ledger.update_status(msg_id, "PROCESSED", clean_content="Clean")
        updated = self.ledger.get_message(msg_id)
        self.assertEqual(updated["status"], "PROCESSED")
        self.assertEqual(updated["clean_content"], "Clean")
        self.ledger.update_status(msg_id, "SUBMITTING")
        unack = self.ledger.get_unacknowledged_message()
        self.assertIsNotNone(unack)
        self.assertEqual(unack["message_id"], msg_id)
        self.ledger.update_status(msg_id, "ACKNOWLEDGED")
        self.assertIsNone(self.ledger.get_unacknowledged_message())

    def test_turn_counting(self):
        self.assertEqual(self.ledger.get_turn_count("conv1"), 0)
        rec = self.ledger.capture_message("conv1", "LEFT", "RIGHT", "Turn 1")
        self.ledger.record_turn("conv1", rec["message_id"], "LEFT", "SUBMITTED")
        self.assertEqual(self.ledger.get_turn_count("conv1"), 1)

if __name__ == "__main__":
    unittest.main()
