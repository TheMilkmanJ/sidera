import shutil
import tempfile
import unittest
from pathlib import Path

from mediator.main import GENESIS_LEFT_PATH, GENESIS_RIGHT_PATH, MediatorService, load_genesis_prompt
from mediator.state_machine import MediatorState
from mediator.tag_parser import TagParser, is_ready_acknowledgement, ready_role


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
        prompt = load_genesis_prompt(Path(__file__).resolve().parent.parent / "mediator" / "genesis_protocol.md")
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
        self.assertTrue((Path(__file__).resolve().parent.parent / "mediator" / "genesis_protocol.md").exists())

    def test_role_files_stay_different_and_name_no_product(self):
        left = load_genesis_prompt(GENESIS_LEFT_PATH)
        right = load_genesis_prompt(GENESIS_RIGHT_PATH)
        self.assertNotEqual(left, right)
        self.assertIn("HEMISPHERE: LEFT", left)
        self.assertIn("CONVERGENT REASONING", left)
        self.assertIn("[[READY:LEFT]]", left)
        self.assertNotIn("DIVERGENT REASONING", left)
        self.assertIn("HEMISPHERE: RIGHT", right)
        self.assertIn("DIVERGENT REASONING", right)
        self.assertIn("[[READY:RIGHT]]", right)
        self.assertNotIn("CONVERGENT REASONING", right)
        for banned in ("ChatGPT", "Grok", "Gemini", "Claude"):
            self.assertNotIn(banned, left)
            self.assertNotIn(banned, right)

    def test_handshake_teaches_both_sides_before_the_first_turn(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})

        self.assertEqual(service.state_machine.state, MediatorState.IDLE)
        self.assertEqual([p["type"] for p in self.sent][:3], ["SETTINGS", "GENESIS_TEXTS", "SUBMIT_MESSAGE"])
        texts = [p for p in self.sent if p["type"] == "GENESIS_TEXTS"][0]
        self.assertEqual(texts["left"], service.genesis_roles["LEFT"])
        self.assertEqual(texts["right"], service.genesis_roles["RIGHT"])
        self.assertNotEqual(texts["left"], texts["right"])
        first = self.submits()[0]
        self.assertEqual(first["destination"], "LEFT")
        self.assertEqual(first["message_id"], "GENESIS-LEFT")
        self.assertEqual(first["text"], service.genesis_roles["LEFT"])
        self.assertIn("CONVERGENT REASONING", first["text"])
        self.assertNotIn("DIVERGENT REASONING", first["text"])

        # A capture from the other side during the handshake is ignored.
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Hello?"})
        self.assertEqual(len(self.submits()), 1)

        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": "LEFT", "message_id": "GENESIS-LEFT"})
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "READY"})
        second = self.submits()[1]
        self.assertEqual((second["destination"], second["message_id"]), ("RIGHT", "GENESIS-RIGHT"))
        self.assertEqual(second["text"], service.genesis_roles["RIGHT"])
        self.assertIn("DIVERGENT REASONING", second["text"])
        self.assertNotIn("CONVERGENT REASONING", second["text"])
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

    def test_two_sessions_of_one_site_keep_their_own_roles(self):
        service = self.make_service(genesis_enabled=True)
        service.handle_message({"type": "HOOK_SLOT", "slot_id": "LEFT", "adapter_type": "browser", "tab_id": 11})
        service.handle_message({"type": "HOOK_SLOT", "slot_id": "RIGHT", "adapter_type": "browser", "tab_id": 22})
        self.assertEqual(service.state_machine.slots["LEFT"].adapter_type, "browser")
        self.assertEqual(service.state_machine.slots["RIGHT"].adapter_type, "browser")
        self.assertEqual(service.state_machine.slots["LEFT"].tab_id, 11)
        self.assertEqual(service.state_machine.slots["RIGHT"].tab_id, 22)
        self.assertNotEqual(service.state_machine.slots["LEFT"].tab_id, service.state_machine.slots["RIGHT"].tab_id)

        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        left_paste = self.submits()[0]["text"]
        self.assertEqual(left_paste, load_genesis_prompt(GENESIS_LEFT_PATH))
        self.assertNotEqual(left_paste, load_genesis_prompt(GENESIS_RIGHT_PATH))

        wrong = "[[READY:RIGHT]]\nSIDERA RIGHT HEMISPHERE ONLINE\n[[/READY]]"
        self.assertEqual(ready_role(wrong), "RIGHT")
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": wrong})
        self.assertEqual(len(self.submits()), 1, "the other role does not advance the handshake")
        self.assertEqual(service.genesis_target, "LEFT")
        self.assertIsNone(service.ledger.get_last_message(service.conversation_id))

        service.handle_message({
            "type": "RESPONSE_CAPTURED",
            "source": "LEFT",
            "content": "[[READY:LEFT]]\nSIDERA LEFT HEMISPHERE ONLINE\n[[/READY]]",
        })
        right_paste = self.submits()[1]["text"]
        self.assertEqual(self.submits()[1]["destination"], "RIGHT")
        self.assertEqual(right_paste, load_genesis_prompt(GENESIS_RIGHT_PATH))
        self.assertNotIn(left_paste, right_paste)
        service.handle_message({
            "type": "RESPONSE_CAPTURED",
            "source": "RIGHT",
            "content": "[[READY:RIGHT]]\nSIDERA RIGHT HEMISPHERE ONLINE\n[[/READY]]",
        })
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)

        service.handle_message({
            "type": "RESPONSE_CAPTURED",
            "source": "LEFT",
            "content": "Opening note from the left session.\n[[MEMORY:notes]]\nbearings\n[[/MEMORY]]",
        })
        forwarded = self.submits()[2]
        self.assertEqual((forwarded["destination"], forwarded["message_id"]), ("RIGHT", "SIDERA-0000001"))
        self.assertEqual(forwarded["text"], "Opening note from the left session.")
        self.assertNotIn("CONVERGENT REASONING", forwarded["text"])
        self.assertNotIn("DIVERGENT REASONING", forwarded["text"])
        self.assertNotIn("[[READY:", forwarded["text"])
        self.assertTrue((self.root / "memory" / "notes.jsonl").exists())
        transcript = "\n".join(p.read_text(encoding="utf-8") for p in (self.root / "transcripts").glob("*.md"))
        self.assertIn("SIDERA-0000001", transcript)
        self.assertIn("Opening note from the left session.", transcript)
        self.assertIn("answered with the RIGHT role", transcript)
        log = (self.root / "logs" / "sidera_mediator.log").read_text(encoding="utf-8")
        self.assertIn("RESPONSE_CAPTURED", log)
        self.assertIn("GENESIS reply from LEFT claimed the RIGHT role", log)

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

    def test_role_file_tags_parse_and_a_swapped_ready_block_is_visible(self):
        parser = TagParser()
        text = (
            "Note.\n"
            "[[MEMORY:notes]]\nbearings\n[[/MEMORY]]\n"
            "[[RECALL:notes]]\nbearings\n[[/RECALL]]\n"
            "[[READ:notes/a.txt]][[/READ]]\n"
            "[[SAVE:notes/a.txt]]\nwhole file\n[[/SAVE]]\n"
        )
        clean, operations, errors = parser.parse(text)
        self.assertEqual(errors, [])
        self.assertEqual(clean, "Note.")
        self.assertEqual(
            [op["type"] for op in operations],
            ["MEMORY_WRITE", "MEMORY_READ", "FILE_READ", "FILE_WRITE"],
        )
        ready = "[[READY:LEFT]]\nSIDERA LEFT HEMISPHERE ONLINE\n[[/READY]]"
        self.assertEqual(ready_role(ready), "LEFT")
        self.assertTrue(is_ready_acknowledgement(ready))
        self.assertEqual(ready_role("hello\n" + ready), "")


if __name__ == "__main__":
    unittest.main()
