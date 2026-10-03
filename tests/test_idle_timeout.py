"""The idle watchdog: when reply detection goes quiet (broken selectors, a
stuck tab), the mediator pauses with a plain explanation instead of waiting
forever (spec 11.2; acceptance test 12 must never hang silently)."""

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


class TestIdleTimeout(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.service = MediatorService(
            root_dir=self.root, max_turns=50, genesis_enabled=False, idle_timeout_minutes=20
        )
        self.service.ipc = FakeIPC()

    def tearDown(self):
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            handler.close()
            root_logger.removeHandler(handler)
        self.temp_dir.cleanup()

    def _idle_after(self, minutes):
        return self.service._last_activity + minutes * 60

    def test_waiting_side_times_out_with_plain_reason(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)
        # One full exchange first, so this is a wait on a real reply.
        self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "Opening."})
        self.service.handle_message({
            "type": "SUBMISSION_CONFIRMED", "destination": "RIGHT",
            "message_id": self.service.state_machine.current_message_id,
        })
        self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": "RIGHT", "content": "Answer."})
        self.service.handle_message({
            "type": "SUBMISSION_CONFIRMED", "destination": "LEFT",
            "message_id": self.service.state_machine.current_message_id,
        })
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)

        self.assertFalse(self.service.check_idle(now=self._idle_after(19)), "not idle before the timeout")
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)

        self.assertTrue(self.service.check_idle(now=self._idle_after(21)))
        self.assertEqual(self.service.state_machine.state, MediatorState.PAUSED)
        reason = self.service.state_machine.last_error
        self.assertIn("No reply has been detected from LEFT", reason)
        self.assertIn("press Resume", reason)
        self.assertNotIn("WAIT_LEFT", reason, "no machine state names in the operator message")

    def test_unconfirmed_send_times_out(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({
            "type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "A finished reply.",
        })
        self.assertEqual(self.service.state_machine.state, MediatorState.SEND_RIGHT)
        self.assertTrue(self.service.check_idle(now=self._idle_after(25)))
        self.assertEqual(self.service.state_machine.state, MediatorState.PAUSED)
        self.assertIn("pasted into RIGHT has not been confirmed", self.service.state_machine.last_error)

    def test_progress_resets_the_clock(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        started = self.service._last_activity
        self.service.handle_message({
            "type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "A finished reply.",
        })
        self.assertGreaterEqual(self.service._last_activity, started)
        self.assertFalse(self.service.check_idle(now=self.service._last_activity + 60), "fresh progress is not idleness")

    def test_idle_and_paused_states_never_time_out(self):
        self.assertFalse(self.service.check_idle(now=self._idle_after(999)), "IDLE never times out")
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({"type": "PAUSE", "reason": "Operator"})
        self.assertFalse(self.service.check_idle(now=self._idle_after(999)), "PAUSED never times out")
        self.assertEqual(self.service.state_machine.last_error, "Operator")

    def test_zero_disables_the_watchdog(self):
        service = MediatorService(
            root_dir=self.root, max_turns=50, genesis_enabled=False, idle_timeout_minutes=0
        )
        service.ipc = FakeIPC()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertFalse(service.check_idle(now=service._last_activity + 10_000_000))
        self.assertEqual(service.state_machine.state, MediatorState.WAIT_LEFT)

    def test_genesis_handshake_stall_pauses_and_asks_for_start(self):
        service = MediatorService(
            root_dir=self.root, max_turns=50, genesis_enabled=True, idle_timeout_minutes=20
        )
        service.ipc = FakeIPC()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertEqual(service.genesis_target, "LEFT")

        self.assertTrue(service.check_idle(now=service._last_activity + 21 * 60))
        self.assertEqual(service.state_machine.state, MediatorState.PAUSED)
        self.assertIsNone(service.genesis_target, "the stalled handshake is abandoned")
        self.assertEqual(service.genesis_pending, [])
        self.assertIn("press Start again", service.state_machine.last_error)

    def test_waiting_for_the_opening_message_is_worded_for_the_operator(self):
        # Audit N2: before any message, the wait is for the operator's opening
        # prompt; "the site may have changed" would be misleading.
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertTrue(self.service.check_idle(now=self._idle_after(21)))
        reason = self.service.state_machine.last_error
        self.assertIn("opening message in the LEFT tab", reason)
        self.assertNotIn("site may have changed", reason)
        self.assertIn("press Resume", reason)

    def test_streaming_text_resets_the_clock(self):
        # Audit N2: a long reply that keeps producing text is not idleness.
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({"type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "A finished reply."})
        self.service.handle_message({
            "type": "SUBMISSION_CONFIRMED", "destination": "RIGHT",
            "message_id": self.service.state_machine.current_message_id,
        })
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_RIGHT)
        start = self.service._last_activity
        import mediator.main as main_module
        real_monotonic = main_module.time.monotonic
        try:
            main_module.time.monotonic = lambda: start + 15 * 60
            self.service.handle_message({"type": "REPLY_PROGRESS", "hemisphere": "RIGHT", "chars": 9000})
        finally:
            main_module.time.monotonic = real_monotonic
        self.assertEqual(self.service._last_activity, start + 15 * 60)
        self.assertFalse(self.service.check_idle(now=start + 30 * 60), "a reply still streaming is not stuck")
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_RIGHT)
        self.assertTrue(self.service.check_idle(now=start + 36 * 60), "the watchdog still fires once text stops")

    def test_progress_from_the_other_side_does_not_hold_the_clock(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        before = self.service._last_activity
        self.service.handle_message({"type": "REPLY_PROGRESS", "hemisphere": "RIGHT", "chars": 10})
        self.assertEqual(self.service._last_activity, before)

    def test_pause_during_genesis_is_not_overridden_by_the_watchdog(self):
        # Audit N1: Pause pressed during the opening handshake must not be
        # followed by an idle timeout, and one Resume must be enough.
        service = MediatorService(
            root_dir=self.root, max_turns=50, genesis_enabled=True, idle_timeout_minutes=20
        )
        service.ipc = FakeIPC()
        service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.assertEqual(service.genesis_target, "LEFT")
        service.handle_message({"type": "PAUSE", "reason": "Operator break"})
        self.assertEqual(service.state_machine.state, MediatorState.PAUSED)

        self.assertFalse(service.check_idle(now=service._last_activity + 21 * 60))
        self.assertEqual(service.state_machine.state, MediatorState.PAUSED)
        self.assertEqual(service.state_machine.last_error, "Operator break", "the operator's reason is kept")
        self.assertEqual(service.genesis_target, "LEFT", "the handshake is not abandoned while paused")

        service.handle_message({"type": "RESUME"})
        self.assertNotEqual(service.state_machine.state, MediatorState.PAUSED, "one Resume is enough")
        self.assertEqual(service.state_machine.state, MediatorState.IDLE)

    def test_double_pause_needs_only_one_resume(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({"type": "PAUSE", "reason": "first"})
        self.service.handle_message({"type": "PAUSE", "reason": "second"})
        self.assertEqual(self.service.state_machine.last_error, "second")
        self.service.handle_message({"type": "RESUME"})
        self.assertEqual(self.service.state_machine.state, MediatorState.WAIT_LEFT)

    def test_resume_after_idle_pause_repastes_the_pending_message(self):
        self.service.handle_message({"type": "START", "initial_hemisphere": "LEFT"})
        self.service.handle_message({
            "type": "RESPONSE_CAPTURED", "source": "LEFT", "content": "A finished reply.",
        })
        self.assertTrue(self.service.check_idle(now=self._idle_after(25)))
        submits_before = [m for m in self.service.ipc.sent if m.get("type") == "SUBMIT_MESSAGE"]
        self.service.handle_message({"type": "RESUME"})
        self.assertEqual(self.service.state_machine.state, MediatorState.SEND_RIGHT)
        submits_after = [m for m in self.service.ipc.sent if m.get("type") == "SUBMIT_MESSAGE"]
        self.assertEqual(len(submits_after), len(submits_before) + 1, "the pending message is pasted again")


if __name__ == "__main__":
    unittest.main()
