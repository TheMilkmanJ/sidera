import logging
import tempfile
import unittest
from pathlib import Path

from mediator.main import MediatorService
from mediator.state_machine import MediatorState


class FakeIPC:
    def __init__(self):
        self.sent = []

    def send_message(self, message):
        self.sent.append(message)

    def read_message(self):
        return None


class TestBurnInLogging(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.service = MediatorService(root_dir=self.root, max_turns=50)
        self.service.ipc = FakeIPC()

    def tearDown(self):
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            handler.close()
            root_logger.removeHandler(handler)
        self.temp_dir.cleanup()

    def _submitted(self):
        submits = [msg for msg in self.service.ipc.sent if msg.get("type") == "SUBMIT_MESSAGE"]
        self.assertTrue(submits)
        return submits[-1]

    def test_fifty_turn_transcript_and_log(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        for index in range(50):
            source = "LEFT" if index % 2 == 0 else "RIGHT"
            self.service.handle_message({
                "type": "RESPONSE_CAPTURED",
                "source": source,
                "content": f"Burn-in utterance {index} from {source}.",
            })
            submitted = self._submitted()
            self.service.handle_message({
                "type": "SUBMISSION_CONFIRMED",
                "destination": submitted["destination"],
                "message_id": submitted["message_id"],
            })

        self.assertEqual(self.service.state_machine.turn_count, 50)
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)
        self.assertEqual(self.service.ledger.get_turn_count(self.service.conversation_id), 50)

        log_text = (self.root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
        self.assertIn("Burn-in ceiling: 50 autonomous turns", log_text)
        self.assertIn("STATUS turn=1/50 state=SEND_RIGHT", log_text)
        self.assertIn("STATUS turn=50/50 state=WAIT_LEFT", log_text)
        self.assertIn("ACKNOWLEDGED message=SIDERA-0000050", log_text)
        self.assertNotIn("BURN_IN_LIMIT_REACHED", log_text)

        transcript = (self.root / "transcripts" / f"{self.service.conversation_id}.md").read_text(encoding="utf-8")
        self.assertEqual(transcript.count("## [SIDERA-"), 50)
        self.assertIn("**Status transition:** `WAIT_LEFT`", transcript)
        self.assertIn("**Status transition:** `WAIT_RIGHT`", transcript)
        self.assertIn("Burn-in utterance 0 from LEFT.", transcript)
        self.assertIn("Burn-in utterance 49 from RIGHT.", transcript)

        self.service.handle_message({
            "type": "RESPONSE_CAPTURED",
            "source": "LEFT",
            "content": "This fifty-first reply must pause the burn-in.",
        })
        self.assertEqual(self.service.state_machine.state, MediatorState.PAUSED)
        log_text = (self.root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
        self.assertIn("BURN_IN_LIMIT_REACHED turns=51/50", log_text)

    def test_injection_error_is_recorded(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({
            "type": "INJECTION_ERROR",
            "hemisphere": "RIGHT",
            "message_id": "SIDERA-0000001",
            "error": "Composer submit control was not available.",
        })
        self.assertEqual(self.service.state_machine.state, MediatorState.ERROR)
        log_text = (self.root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
        transcript = (self.root / "transcripts" / f"{self.service.conversation_id}.md").read_text(encoding="utf-8")
        self.assertIn("INJECTION_ERROR", log_text)
        self.assertIn("Composer submit control was not available.", transcript)
        self.assertIn("**Error signal:** `INJECTION_ERROR`", transcript)


if __name__ == "__main__":
    unittest.main()
