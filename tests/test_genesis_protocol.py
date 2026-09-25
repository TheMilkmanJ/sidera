import shutil
import tempfile
import unittest
from pathlib import Path

from mediator.main import GENESIS_PROMPT_PATH, MediatorService, load_genesis_prompt
from mediator.state_machine import MediatorState
from mediator.tag_parser import TagParser, is_ready_acknowledgement


class GenesisProtocolTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sidera-genesis-"))
        self.sent = []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make_service(self, **kwargs):
        service = MediatorService(root_dir=self.root, max_turns=10, **kwargs)
        service.ipc.send_message = lambda packet: self.sent.append(packet)
        return service

    def submits(self):
        return [p for p in self.sent if p["type"] == "SUBMIT_MESSAGE"]

    def test_prompt_teaches_the_client_tag_grammar(self):
        prompt = load_genesis_prompt()
        for needle in (
            '[[SIDERA: MEMORY_WRITE category="inventions" project="gyrocell"]]',
            '[[SIDERA: MEMORY_READ category="inventions" project="gyrocell" limit="5"]]',
            '[[SIDERA: FILE_APPEND path="notes/gyrocell.md"]]',
            '[[SIDERA: FILE_READ path="notes/gyrocell.md"]]',
            "[[/SIDERA]]",
            "[[SIDERA: STATUS]]",
            '[[SIDERA: PAUSE reason="why"]]',
            "[[SIDERA: STOP]]",
            "READY",
        ):
            self.assertIn(needle, prompt)
        # Every example in the prompt must parse cleanly with the real parser.
        clean, operations, errors = TagParser().parse(prompt)
        self.assertEqual(errors, [])
        self.assertEqual(
            [op["type"] for op in operations],
            ["MEMORY_WRITE", "MEMORY_READ", "FILE_APPEND", "FILE_READ", "STATUS", "PAUSE", "STOP"],
        )
        self.assertTrue(GENESIS_PROMPT_PATH.exists())

    def test_handshake_teaches_both_sides_before_the_first_turn(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})

        self.assertEqual(service.state_machine.state, MediatorState.IDLE)
        self.assertEqual([p["type"] for p in self.sent][:2], ["GENESIS_TEXT", "SUBMIT_MESSAGE"])
        first = self.submits()[0]
        self.assertEqual(first["destination"], "LEFT")
        self.assertEqual(first["message_id"], "GENESIS-LEFT")
        self.assertIn("[SIDERA GENESIS PROTOCOL]", first["text"])

        # A capture from the other side during the handshake is ignored.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Hello?"})
        self.assertEqual(len(self.submits()), 1)

        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "LEFT", "message_id": "GENESIS-LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "READY"})
        second = self.submits()[1]
        self.assertEqual((second["destination"], second["message_id"]), ("RIGHT", "GENESIS-RIGHT"))
        self.assertEqual(service.state_machine.state, MediatorState.IDLE)

        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "GENESIS-RIGHT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY."})
        self.assertIn({"type": "GENESIS_COMPLETE"}, self.sent)
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)
        self.assertEqual(service.state_machine.turn_count, 0)
        self.assertIsNone(service.ledger.get_last_message(service.conversation_id), "READY acks are not ledger messages")

        # Normal flow afterwards: the first real LEFT reply becomes SIDERA-0000001.
        service.handle_message({
            "type": "RESPONSE_CAPTURED",
            "source": "LEFT",
            "content": "Let's design the gyrocell.\n[[SIDERA: MEMORY_WRITE category=\"inventions\" project=\"gyrocell\"]]\nStart with magnetic bearings.\n[[/SIDERA]]",
        })
        third = self.submits()[2]
        self.assertEqual((third["destination"], third["message_id"]), ("RIGHT", "SIDERA-0000001"))
        self.assertEqual(third["text"], "Let's design the gyrocell.")
        self.assertTrue((self.root / "memory" / "inventions.jsonl").exists())

        transcript = (self.root / "transcripts").glob("*.md")
        body = "\n".join(p.read_text(encoding="utf-8") for p in transcript)
        self.assertIn("protocol handshake started", body)
        self.assertIn("`LEFT` replied READY", body)
        self.assertIn("**Genesis:** complete", body)

    def test_non_ready_answer_still_moves_the_handshake_along(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Understood, I will use the tags as described."})
        self.assertEqual(self.submits()[1]["destination"], "RIGHT")
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY"})
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)

    def test_genesis_paste_failure_does_not_strand_the_session(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "INJECTION_ERROR", "hemisphere": "LEFT", "message_id": "GENESIS-LEFT", "error": "composer missing"})
        self.assertEqual(self.submits()[1]["destination"], "RIGHT")
        self.assertNotEqual(service.state_machine.state, MediatorState.ERROR)
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY"})
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)

    def test_bare_ready_after_a_chat_restart_is_not_a_turn(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "[[SIDERA: READY]]"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "ready"})
        self.assertEqual(self.submits(), [])
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)

    def test_reply_from_destination_confirms_an_unconfirmed_paste(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Opening thought. Agree?"})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_RIGHT)
        # No SUBMISSION_CONFIRMED arrives, but RIGHT answers anyway.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "I agree, and here is why."})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_LEFT)
        ids = [p["message_id"] for p in self.submits()]
        self.assertEqual(ids, ["SIDERA-0000001", "SIDERA-0000002"])
        self.assertEqual(self.submits()[1]["destination"], "LEFT")
        self.assertEqual(service.ledger.get_message("SIDERA-0000001")["status"], "ACKNOWLEDGED")

    def test_genesis_can_be_switched_off(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)
        self.assertEqual(self.submits(), [])

    def test_right_can_go_first(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "RIGHT"})
        self.assertEqual(self.submits()[0]["destination"], "RIGHT")
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "READY"})
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_RIGHT)


class ReadyAndAliasTests(unittest.TestCase):
    def test_ready_detection(self):
        for text in ("READY", "ready", "Ready.", "**READY**", "[[SIDERA: READY]]", "\nREADY\n"):
            self.assertTrue(is_ready_acknowledgement(text), text)
        for text in ("READY to begin: the four-day week is a mistake.", "Not ready yet", ""):
            self.assertFalse(is_ready_acknowledgement(text), text)

    def test_short_aliases_map_to_canonical_operations(self):
        parser = TagParser()
        text = (
            "Body.\n"
            '[[SIDERA: SAVE category="ideas" project="p1"]]\nkeep this\n[[/SIDERA]]\n'
            '[[SIDERA: SAVE path="notes/p1.md"]]\nappend this\n[[/SIDERA]]\n'
            '[[SIDERA: RECALL category="ideas"]]\n[[/SIDERA]]\n'
            '[[SIDERA: READ path="notes/p1.md"]]\n'
            "[[SIDERA: READY]]"
        )
        clean, operations, errors = parser.parse(text)
        self.assertEqual(errors, [])
        self.assertEqual(clean, "Body.")
        self.assertEqual(
            [op["type"] for op in operations],
            ["MEMORY_WRITE", "FILE_APPEND", "MEMORY_READ", "FILE_READ", "READY"],
        )


if __name__ == "__main__":
    unittest.main()
