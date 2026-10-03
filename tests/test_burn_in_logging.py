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
        self.service = MediatorService(root_dir=self.root, max_turns=50, genesis_enabled=False)
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

    def test_fifty_turn_same_site_loop_without_duplicate_forwarding(self):
        # ChatGPT on BOTH slots (the headline same-AI case): 50 alternating
        # turns complete, each reply is forwarded exactly once, and a DOM
        # re-render of a previous reply is never resent (spec 12, tests 4+5).
        self.service.handle_message({"type": "HOOK_SLOT", "slot_id": "LEFT", "adapter_type": "chatgpt", "tab_id": 11})
        self.service.handle_message({"type": "HOOK_SLOT", "slot_id": "RIGHT", "adapter_type": "chatgpt", "tab_id": 22})
        self.assertEqual(self.service.state_machine.slots["LEFT"].adapter_type, "chatgpt")
        self.assertEqual(self.service.state_machine.slots["RIGHT"].adapter_type, "chatgpt")

        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        last_text = {"LEFT": None, "RIGHT": None}

        def submit_count():
            return len([m for m in self.service.ipc.sent if m.get("type") == "SUBMIT_MESSAGE"])

        for index in range(50):
            source = "LEFT" if index % 2 == 0 else "RIGHT"

            # While waiting for this side, its tab re-renders its PREVIOUS
            # answer (a DOM re-render / observer duplicate). It must be
            # ignored, never forwarded again.
            if last_text[source] is not None:
                before = submit_count()
                self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": source, "content": last_text[source]})
                self.assertEqual(submit_count(), before, f"re-render before turn {index} must not be forwarded")

            text = f"Same-site reply {index} from {source}."
            self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": source, "content": text})
            last_text[source] = text
            submitted = self._submitted()
            self.assertEqual(submitted["destination"], "RIGHT" if source == "LEFT" else "LEFT")

            # A second copy of the same reply arriving mid-send is dropped by
            # the turn guard as well.
            before = submit_count()
            self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": source, "content": text})
            self.assertEqual(submit_count(), before, f"duplicate at turn {index} must not be forwarded again")

            self.service.handle_message({
                "type": "SUBMISSION_CONFIRMED",
                "destination": submitted["destination"],
                "message_id": submitted["message_id"],
            })

        self.assertEqual(self.service.state_machine.turn_count, 50)
        self.assertEqual(self.service.ledger.get_turn_count(self.service.conversation_id), 50)
        submits = [m for m in self.service.ipc.sent if m.get("type") == "SUBMIT_MESSAGE"]
        self.assertEqual(len(submits), 50, "each reply is forwarded exactly once")
        self.assertEqual(len({m["message_id"] for m in submits}), 50, "no message id is ever resent")
        duplicates = [m for m in self.service.ipc.sent if m.get("type") == "DUPLICATE_IGNORED"]
        self.assertEqual(len(duplicates), 48, "every waiting-side re-render is flagged as a duplicate")

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

    def test_two_thousand_turn_burn_in(self):
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            handler.close()
            root_logger.removeHandler(handler)

        big_dir = tempfile.TemporaryDirectory()
        big_root = Path(big_dir.name)
        service = MediatorService(root_dir=big_root, max_turns=2000, genesis_enabled=False)
        service.ipc = FakeIPC()
        for handler in logging.getLogger().handlers:
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                handler.setLevel(logging.ERROR)
        try:
            service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
            for index in range(2000):
                source = "LEFT" if index % 2 == 0 else "RIGHT"
                service.handle_message({
                    "type": "RESPONSE_CAPTURED",
                    "source": source,
                    "content": f"Set {index:04d} from {source}.",
                })
                submitted = service.ipc.sent[-1]
                self.assertEqual(submitted["type"], "SUBMIT_MESSAGE")
                self.assertEqual(submitted["destination"], "RIGHT" if source == "LEFT" else "LEFT")
                self.assertEqual(submitted["message_id"], f"SIDERA-{index + 1:07d}")
                service.handle_message({
                    "type": "SUBMISSION_CONFIRMED",
                    "destination": submitted["destination"],
                    "message_id": submitted["message_id"],
                })

            self.assertEqual(service.state_machine.turn_count, 2000)
            self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)
            self.assertEqual(service.ledger.get_turn_count(service.conversation_id), 2000)
            self.assertEqual(service.ledger.get_message("SIDERA-0000001")["status"], "ACKNOWLEDGED")
            self.assertEqual(service.ledger.get_message("SIDERA-0002000")["status"], "ACKNOWLEDGED")
            self.assertIsNone(service.ledger.get_unacknowledged_message())

            log_text = (big_root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
            self.assertIn("Burn-in ceiling: 2000 autonomous turns", log_text)
            self.assertIn("STATUS turn=1/2000 state=SEND_RIGHT", log_text)
            self.assertIn("STATUS turn=2000/2000 state=WAIT_LEFT", log_text)
            self.assertIn("ACKNOWLEDGED message=SIDERA-0002000", log_text)
            self.assertNotIn("BURN_IN_LIMIT_REACHED", log_text)
            self.assertNotIn("[ERROR]", log_text)

            transcript = (big_root / "transcripts" / f"{service.conversation_id}.md").read_text(encoding="utf-8")
            self.assertEqual(transcript.count("## [SIDERA-"), 2000)
            self.assertIn("Set 0000 from LEFT.", transcript)
            self.assertIn("Set 1999 from RIGHT.", transcript)

            service.handle_message({
                "type": "RESPONSE_CAPTURED",
                "source": "LEFT",
                "content": "Turn 2001 must pause at the ceiling.",
            })
            self.assertEqual(service.state_machine.state, MediatorState.PAUSED)
            log_text = (big_root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
            self.assertIn("BURN_IN_LIMIT_REACHED turns=2001/2000", log_text)
        finally:
            for handler in list(logging.getLogger().handlers):
                handler.close()
                logging.getLogger().removeHandler(handler)
            big_dir.cleanup()


if __name__ == "__main__":
    unittest.main()
