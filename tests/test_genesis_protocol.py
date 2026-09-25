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
        # Canonical spelling from the build spec, section 8: no space after "SIDERA:".
        for needle in (
            '[[SIDERA:MEMORY_WRITE category="inventions" project="gyrocell"]]',
            '[[SIDERA:MEMORY_READ category="inventions" project="gyrocell" limit="20"]]',
            '[[SIDERA:FILE_APPEND path="notes/gyrocell.md"]]',
            '[[SIDERA:FILE_WRITE path="notes/summary.md"]]',
            '[[SIDERA:FILE_READ path="notes/gyrocell.md"]]',
            "[[SIDERA:FILE_LIST]]",
            "[[/SIDERA]]",
            "[[SIDERA:STATUS]]",
            '[[SIDERA:PAUSE reason="why"]]',
            "[[SIDERA:STOP]]",
            "[[MEMORY:inventions]] ... [[/MEMORY]]",
            "READY",
        ):
            self.assertIn(needle, prompt)
        self.assertNotIn("[[SIDERA: ", prompt)
        # Every example in the prompt must parse cleanly with the real parser.
        clean, operations, errors = TagParser().parse(prompt)
        self.assertEqual(errors, [])
        self.assertEqual(
            sorted(op["type"] for op in operations),
            # The legacy [[MEMORY:...]] example in the prompt parses as a second MEMORY_WRITE.
            sorted(["MEMORY_WRITE", "MEMORY_WRITE", "MEMORY_READ", "FILE_APPEND", "FILE_WRITE", "FILE_READ", "FILE_LIST", "STATUS", "PAUSE", "STOP"]),
        )
        self.assertTrue(GENESIS_PROMPT_PATH.exists())

    def test_handshake_teaches_both_sides_before_the_first_turn(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})

        self.assertEqual(service.state_machine.state, MediatorState.IDLE)
        self.assertEqual([p["type"] for p in self.sent][:3], ["SETTINGS", "GENESIS_TEXT", "SUBMIT_MESSAGE"])
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

    def test_ready_given_as_a_fresh_reply_to_a_real_message_is_forwarded(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Acknowledged. Standing by."})
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "SIDERA-0000001"})
        # Stale re-capture of a protocol READY: ignored. Fresh READY as the answer: forwarded.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY", "fresh": False})
        self.assertEqual(len(self.submits()), 1)
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "READY", "fresh": True})
        self.assertEqual(len(self.submits()), 2)
        self.assertEqual(self.submits()[1]["text"], "READY")
        self.assertEqual(service.state_machine.state, MediatorState.SEND_LEFT)

    def test_reply_from_destination_confirms_an_unconfirmed_paste(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Opening thought. Agree?"})
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "SIDERA-0000001"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "First answer from RIGHT."})
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "LEFT", "message_id": "SIDERA-0000002"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Second thought from LEFT."})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_RIGHT)

        # A stale re-capture of RIGHT's previous reply proves nothing.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "First answer from RIGHT."})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_RIGHT)
        self.assertEqual(len(self.submits()), 3)

        # No SUBMISSION_CONFIRMED for SIDERA-0000003 arrives, but RIGHT answers it.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Second answer from RIGHT."})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_LEFT)
        self.assertEqual([p["message_id"] for p in self.submits()], ["SIDERA-0000001", "SIDERA-0000002", "SIDERA-0000003", "SIDERA-0000004"])
        self.assertEqual(self.submits()[3]["destination"], "LEFT")
        self.assertEqual(service.ledger.get_message("SIDERA-0000003")["status"], "ACKNOWLEDGED")

    def test_identical_reply_is_forwarded_when_marked_fresh(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Confirmed."})
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "SIDERA-0000001"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Confirmed. State remains SPECIFIED."})
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "LEFT", "message_id": "SIDERA-0000002"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Confirmed.", "fresh": True})
        self.assertEqual(len(self.submits()), 3, "LEFT's repeated reply is forwarded because it is fresh")
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "SIDERA-0000003"})
        # Same words again from RIGHT: a re-capture is dropped, a fresh reply goes through.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Confirmed. State remains SPECIFIED.", "fresh": False})
        self.assertEqual(len(self.submits()), 3)
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Confirmed. State remains SPECIFIED.", "fresh": True})
        self.assertEqual(len(self.submits()), 4)
        self.assertEqual(self.submits()[3]["message_id"], "SIDERA-0000004")
        self.assertEqual(self.submits()[3]["text"], "Confirmed. State remains SPECIFIED.")

    def test_refused_paste_pauses_with_the_sites_reason_and_resume_resends(self):
        service = self.make_service(genesis_enabled=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Shall we begin?"})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_RIGHT)
        service.handle_message({
            "type": "SUBMISSION_STALLED",
            "hemisphere": "RIGHT",
            "message_id": "SIDERA-0000001",
            "detail": "Gemini refused the message: Something went wrong (1095)",
        })
        self.assertEqual(service.state_machine.state, MediatorState.PAUSED)
        self.assertIn("Something went wrong (1095)", service.state_machine.last_error)
        self.assertIn("Press Resume", service.state_machine.last_error)
        self.assertEqual(len(self.submits()), 1)

        service.handle_message({"type": "RESUME"})
        self.assertEqual(service.state_machine.state, MediatorState.SEND_RIGHT)
        self.assertEqual(len(self.submits()), 2, "the pending message is pasted again on resume")
        self.assertEqual(self.submits()[1]["message_id"], "SIDERA-0000001")
        self.assertEqual(self.submits()[1]["destination"], "RIGHT")
        self.assertEqual(self.submits()[1]["text"], "Shall we begin?")

        # Delivered this time: the loop carries on.
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "RIGHT", "message_id": "SIDERA-0000001"})
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_RIGHT)

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

    def test_file_write_and_list_operate_inside_the_sandbox(self):
        import shutil, tempfile
        from pathlib import Path
        from mediator.file_sandbox import FileSandbox
        from mediator.memory_store import MemoryStore
        root = Path(tempfile.mkdtemp(prefix="sidera-files-"))
        try:
            sandbox = FileSandbox(root / "files")
            memory = MemoryStore(root / "memory")
            parser = TagParser()
            text = (
                '[[SIDERA: FILE_WRITE path="notes/summary.md"]]\n# Summary\nfirst version\n[[/SIDERA]]\n'
                '[[SIDERA: FILE_WRITE path="notes/summary.md"]]\n# Summary\nsecond version\n[[/SIDERA]]\n'
                '[[SIDERA: FILE_APPEND path="notes/log.txt"]]\nline\n[[/SIDERA]]\n'
                "[[SIDERA: FILE_LIST]]"
            )
            clean, operations, errors = parser.parse(text)
            self.assertEqual(errors, [])
            injections, controls = parser.execute_operations(operations, memory, sandbox, "LEFT", "SIDERA-0000001")
            self.assertEqual((root / "files" / "notes" / "summary.md").read_text(encoding="utf-8"), "# Summary\nsecond version")
            self.assertEqual((root / "files" / "notes" / "log.txt").read_text(encoding="utf-8"), "line")
            self.assertIn("- notes/log.txt", injections[-1])
            self.assertIn("- notes/summary.md", injections[-1])
            # Escaping the folder is refused and reported, not executed.
            _, ops2, _ = parser.parse('[[SIDERA: FILE_WRITE path="../outside.md"]]\nnope\n[[/SIDERA]]')
            injections2, _ = parser.execute_operations(ops2, memory, sandbox, "LEFT", "SIDERA-0000002")
            self.assertTrue(injections2 and "ERROR" in injections2[0])
            self.assertFalse((root / "outside.md").exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)

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
