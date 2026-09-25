"""Checks that follow the Sidera build specification's acceptance criteria."""

import shutil
import tempfile
import unittest
from pathlib import Path

from mediator.config import MediatorConfig, load_config
from mediator.main import MediatorService
from mediator.state_machine import MediatorState


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sidera-spec-"))
        self.sent = []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make_service(self, **kwargs):
        kwargs.setdefault("genesis_enabled", False)
        kwargs.setdefault("max_turns", 20)
        service = MediatorService(root_dir=self.root, **kwargs)
        service.ipc.send_message = lambda packet: self.sent.append(packet)
        return service

    def submits(self):
        return [p for p in self.sent if p["type"] == "SUBMIT_MESSAGE"]

    def run_turn(self, service, source, content, message_id):
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": source, "content": content})
        dest = "RIGHT" if source == "LEFT" else "LEFT"
        service.handle_message({"type": "SUBMISSION_CONFIRMED", "destination": dest, "message_id": message_id})


class ReadResultsGoToRequester(ServiceTestCase):
    def test_memory_read_result_returns_to_the_side_that_asked(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.run_turn(service, "LEFT",
                      'Noted.\n[[SIDERA:MEMORY_WRITE category="inventions" project="gyrocell"]]\nUse Galinstan rather than NaK.\n[[/SIDERA]]',
                      "SIDERA-0000001")
        # RIGHT asks for a recall; the result must come back to RIGHT, not go to LEFT.
        self.run_turn(service, "RIGHT",
                      'Let me check.\n[[SIDERA:MEMORY_READ category="inventions" project="gyrocell" limit="20"]]\nGalinstan\n[[/SIDERA]]',
                      "SIDERA-0000002")
        to_left = self.submits()[1]
        self.assertEqual(to_left["destination"], "LEFT")
        self.assertEqual(to_left["text"], "Let me check.", "the other side sees only the conversational text")
        self.run_turn(service, "LEFT", "Here is my next thought.", "SIDERA-0000003")
        to_right = self.submits()[2]
        self.assertEqual(to_right["destination"], "RIGHT")
        self.assertTrue(to_right["text"].startswith("[SIDERA SYSTEM: Memory Query Results (1 items)]"), to_right["text"])
        self.assertIn("Use Galinstan rather than NaK.", to_right["text"])
        self.assertTrue(to_right["text"].endswith("Here is my next thought."))

    def test_file_read_and_list_results_return_to_requester(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.run_turn(service, "LEFT",
                      'Saving.\n[[SIDERA:FILE_APPEND path="projects/gyrocell/engineering_notes.md"]]\nTest Hartmann-flow losses first.\n[[/SIDERA]]',
                      "SIDERA-0000001")
        self.run_turn(service, "RIGHT", "Reading.\n[[SIDERA:FILE_READ path=\"projects/gyrocell/engineering_notes.md\"]]\n[[/SIDERA]]\n[[SIDERA:FILE_LIST]]", "SIDERA-0000002")
        self.assertEqual(self.submits()[1]["text"], "Reading.")
        self.run_turn(service, "LEFT", "Next.", "SIDERA-0000003")
        text = self.submits()[2]["text"]
        self.assertIn("[SIDERA SYSTEM: File Content (projects/gyrocell/engineering_notes.md)]", text)
        self.assertIn("Test Hartmann-flow losses first.", text)
        self.assertIn("- projects/gyrocell/engineering_notes.md", text)

    def test_malformed_tag_fails_closed_and_reports_to_requester(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.run_turn(service, "LEFT", "Try this.\n[[SIDERA:DELETE_EVERYTHING path=\"..\"]]\nboom\n[[/SIDERA]]", "SIDERA-0000001")
        self.assertEqual(self.submits()[0]["text"], "Try this.")
        self.run_turn(service, "RIGHT", "Okay.", "SIDERA-0000002")
        self.assertIn("[SIDERA SYSTEM ERROR: Unknown block tag operation: DELETE_EVERYTHING; the tag was not executed]", self.submits()[1]["text"])
        transcript = "\n".join(p.read_text(encoding="utf-8") for p in (self.root / "transcripts").glob("*.md"))
        self.assertIn("TAG_ERROR", transcript)


class IdempotentOperations(ServiceTestCase):
    def test_operations_are_recorded_and_not_repeated(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        content = 'Decision.\n[[SIDERA:MEMORY_WRITE category="inventions" project="gyrocell"]]\nGalinstan.\n[[/SIDERA]]'
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": content})
        ops = service.ledger.get_operations("SIDERA-0000001")
        self.assertEqual([(o["op_type"], o["target"], o["result"]) for o in ops], [("MEMORY_WRITE", "inventions", "EXECUTED")])
        lines = (self.root / "memory" / "inventions.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 1)

        # Simulate a replay of the same captured message after a crash: the
        # duplicate guard drops it, and even if it got through, the recorded
        # operations stop a second write.
        service.state_machine.state = MediatorState.WAIT_LEFT
        service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": content})
        lines = (self.root / "memory" / "inventions.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 1, "memory written exactly once")


class RestartPersistence(ServiceTestCase):
    def test_pause_survives_restart(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "PAUSE", "reason": "Operator paused for review"})
        restarted = self.make_service()
        self.assertEqual(restarted.state_machine.state, MediatorState.PAUSED)
        self.assertIn("Operator paused for review", restarted.state_machine.last_error)

    def test_restart_mid_exchange_pauses_instead_of_resuming(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.run_turn(service, "LEFT", "First.", "SIDERA-0000001")
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_RIGHT)
        restarted = self.make_service()
        self.assertEqual(restarted.state_machine.state, MediatorState.PAUSED)
        self.assertIn("restarted while in WAIT_RIGHT", restarted.state_machine.last_error)
        self.assertEqual(restarted.state_machine.turn_count, 1)
        # Nothing is replayed on restart, and the ledger is intact.
        self.assertEqual(len([p for p in self.sent if p["type"] == "SUBMIT_MESSAGE" and p["message_id"] == "SIDERA-0000001"]), 1)
        self.assertEqual(restarted.ledger.get_message("SIDERA-0000001")["status"], "ACKNOWLEDGED")

    def test_stop_then_restart_starts_idle(self):
        service = self.make_service()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({"type": "STOP"})
        restarted = self.make_service()
        self.assertEqual(restarted.state_machine.state, MediatorState.IDLE)

    def test_max_turns_setting_persists(self):
        service = self.make_service()
        service.handle_message({"type": "SET_MAX_TURNS", "max_turns": 7})
        self.assertEqual(service.state_machine.max_autonomous_turns, 7)
        restarted = self.make_service()
        self.assertEqual(restarted.state_machine.max_autonomous_turns, 7)
        service.handle_message({"type": "SET_MAX_TURNS", "max_turns": "nonsense"})
        self.assertEqual(service.state_machine.max_autonomous_turns, 7)


class MonitorOnly(ServiceTestCase):
    def test_disabled_submissions_never_paste(self):
        service = self.make_service(autonomous_submissions=False)
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        service.handle_message({
            "type": "RESPONSE_CAPTURED", "source": "LEFT",
            "content": 'Hello.\n[[SIDERA:MEMORY_WRITE category="notes"]]\nkept\n[[/SIDERA]]',
        })
        self.assertEqual(self.submits(), [], "nothing pasted")
        self.assertEqual(service.state_machine.state, MediatorState.PAUSED)
        self.assertIn("Monitor-only", service.state_machine.last_error)
        self.assertTrue((self.root / "memory" / "notes.jsonl").exists(), "tags still executed and logged")
        self.assertEqual(service.ledger.get_message("SIDERA-0000001")["status"], "PROCESSED")


class ConfigLoading(unittest.TestCase):
    def test_defaults_without_a_file(self):
        config = load_config(Path("/nonexistent/config.toml"))
        self.assertEqual(config.max_autonomous_turns, 50)
        self.assertTrue(config.autonomous_submissions)
        self.assertTrue(config.genesis_enabled)
        self.assertTrue(str(config.data_root).endswith("data"))

    def test_example_file_parses_and_relative_paths_resolve(self):
        root = Path(__file__).resolve().parent.parent
        config = load_config(root / "config.example.toml")
        self.assertEqual(config.data_root, (root / "data").resolve())
        self.assertEqual(config.max_autonomous_turns, 50)
        self.assertTrue(config.genesis_enabled)
        self.assertEqual(config.genesis_prompt_file, (root / "mediator" / "genesis_protocol.md").resolve())
        self.assertEqual(config.log_level, "INFO")

    def test_custom_values(self):
        tmp = Path(tempfile.mkdtemp(prefix="sidera-config-"))
        try:
            elsewhere = (tmp / "elsewhere").resolve()
            (tmp / "config.toml").write_text(
                f'[mediator]\ndata_root = "{elsewhere.as_posix()}"\nmax_autonomous_turns = 12\nautonomous_submissions = false\n[genesis]\nenabled = false\n',
                encoding="utf-8",
            )
            config = load_config(tmp / "config.toml")
            self.assertEqual(config.max_autonomous_turns, 12)
            self.assertFalse(config.autonomous_submissions)
            self.assertFalse(config.genesis_enabled)
            self.assertEqual(config.data_root, elsewhere, "absolute data_root is used as given")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_service_uses_config_object(self):
        tmp = Path(tempfile.mkdtemp(prefix="sidera-config-svc-"))
        try:
            config = MediatorConfig(data_root=tmp / "data", max_autonomous_turns=3, autonomous_submissions=True, genesis_enabled=False)
            service = MediatorService(config=config)
            service.ipc.send_message = lambda packet: None
            self.assertEqual(service.root_dir, (tmp / "data").resolve())
            self.assertEqual(service.state_machine.max_autonomous_turns, 3)
            self.assertFalse(service.genesis_enabled)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
