"""Resume after an unexpected error must move the exchange forward (audit N5).

An exception while a captured reply is being processed puts the mediator in
ERROR with the pre-error state remembered. Before this fix, Resume restored
PROCESS (or LEFT/RIGHT_COMPLETE), which nothing ever advances, so the
exchange stalled silently.
"""

import logging
import tempfile
import unittest
from pathlib import Path

from mediator.main import MediatorService
from mediator.state_machine import MediatorState


class QueueIPC:
    def __init__(self, packets):
        self.packets = list(packets)
        self.sent = []

    def send_message(self, message):
        self.sent.append(message)

    def read_message(self):
        return self.packets.pop(0) if self.packets else None


class TestResumeAfterError(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.service = MediatorService(
            root_dir=self.root, max_turns=50, genesis_enabled=False, idle_timeout_minutes=0
        )

    def tearDown(self):
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            handler.close()
            root_logger.removeHandler(handler)
        self.temp_dir.cleanup()

    def _run(self, packets):
        # The real run loop: an exception in handle_message becomes ERROR.
        self.service.ipc = QueueIPC(packets)
        self.service.run()
        return self.service.ipc.sent

    def _submits(self):
        return [m for m in self.service.ipc.sent if m.get("type") == "SUBMIT_MESSAGE"]

    def test_error_while_parsing_is_finished_on_resume(self):
        real_parse = self.service.tag_parser.parse
        calls = {"n": 0}

        def flaky_parse(text):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("parser hiccup")
            return real_parse(text)

        self.service.tag_parser.parse = flaky_parse
        self._run([
            {"type": "START", "initial_hemisphere": "LEFT"},
            {"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "An opening thought.", "fresh": True},
        ])
        self.assertEqual(self.service.state_machine.state, MediatorState.ERROR)
        self.assertEqual(self._submits(), [])

        self._run([{"type": "RESUME"}])
        self.assertEqual(self.service.state_machine.state, MediatorState.SEND_RIGHT, "Resume moves the exchange on")
        submits = self._submits()
        self.assertEqual(len(submits), 1)
        self.assertEqual(submits[0]["destination"], "RIGHT")
        self.assertIn("An opening thought.", submits[0]["text"])
        self.assertEqual(self.service.state_machine.turn_count, 1)

    def test_error_after_processing_only_hands_off(self):
        real_prepare = self.service.state_machine.prepare_send
        calls = {"n": 0}

        def flaky_prepare(dest):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("hand-off hiccup")
            return real_prepare(dest)

        self.service.state_machine.prepare_send = flaky_prepare
        self._run([
            {"type": "START", "initial_hemisphere": "LEFT"},
            {"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Processed already.", "fresh": True},
        ])
        self.assertEqual(self.service.state_machine.state, MediatorState.ERROR)
        self._run([{"type": "RESUME"}])
        self.assertEqual(self.service.state_machine.state, MediatorState.SEND_RIGHT)
        submits = self._submits()
        self.assertEqual(len(submits), 1)
        self.assertIn("Processed already.", submits[0]["text"])

    def test_error_during_tag_execution_never_repeats_writes(self):
        real_execute = self.service.tag_parser.execute_operations

        def failing_execute(**kwargs):
            # Simulate a failure after a write may already have happened.
            real_execute(**kwargs)
            raise RuntimeError("disk hiccup")

        self.service.tag_parser.execute_operations = failing_execute
        content = (
            '[[SIDERA: MEMORY_WRITE category="inventions" project="gyrocell"]]\n'
            "note text\n[[/SIDERA]]\nVisible text."
        )
        self._run([
            {"type": "START", "initial_hemisphere": "LEFT"},
            {"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": content, "fresh": True},
        ])
        self.assertEqual(self.service.state_machine.state, MediatorState.ERROR)
        self.service.tag_parser.execute_operations = real_execute
        self._run([{"type": "RESUME"}])
        self.assertEqual(self.service.state_machine.state, MediatorState.PAUSED, "a plain pause, not a silent stall")
        self.assertIn("Manual forward", self.service.state_machine.last_error)
        self.assertEqual(len(self.service.memory.read_memory(limit=50)), 1, "the memory is saved exactly once")
        self.assertEqual(self._submits(), [])

    def test_resume_from_error_in_wait_state_still_waits(self):
        self._run([{"type": "START", "initial_hemisphere": "LEFT"}])
        self.service.state_machine.error("Something odd")
        self._run([{"type": "RESUME"}])
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)


if __name__ == "__main__":
    unittest.main()
