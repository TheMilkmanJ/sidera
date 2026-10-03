import unittest
from mediator.state_machine import MediatorState, StateMachine

class TestStateMachine(unittest.TestCase):
    def setUp(self):
        self.sm = StateMachine(max_autonomous_turns=3)

    def test_turn_taking_flow(self):
        self.assertEqual(self.sm.state, MediatorState.IDLE)
        self.sm.start("LEFT")
        self.assertEqual(self.sm.state, MediatorState.WAIT_LEFT)
        self.sm.handle_response_captured("LEFT", "SIDERA-0000001")
        self.assertEqual(self.sm.state, MediatorState.LEFT_COMPLETE)
        self.sm.start_processing()
        self.assertEqual(self.sm.state, MediatorState.PROCESS)
        self.sm.prepare_send("RIGHT")
        self.assertEqual(self.sm.state, MediatorState.SEND_RIGHT)
        self.assertEqual(self.sm.turn_count, 1)
        self.sm.confirm_submission("RIGHT")
        self.assertEqual(self.sm.state, MediatorState.WAIT_RIGHT)
        self.sm.handle_response_captured("RIGHT", "SIDERA-0000002")
        self.assertEqual(self.sm.state, MediatorState.RIGHT_COMPLETE)
        self.sm.start_processing()
        self.assertEqual(self.sm.state, MediatorState.PROCESS)
        self.sm.prepare_send("LEFT")
        self.assertEqual(self.sm.state, MediatorState.SEND_LEFT)
        self.assertEqual(self.sm.turn_count, 2)

    def test_turn_limit_enforcement(self):
        self.sm.start("LEFT")
        for i in range(3):
            self.sm.state = MediatorState.LEFT_COMPLETE
            self.sm.start_processing()
            self.sm.prepare_send("RIGHT")
            self.sm.confirm_submission("RIGHT")
        self.sm.state = MediatorState.LEFT_COMPLETE
        self.sm.start_processing()
        self.sm.prepare_send("RIGHT")
        self.assertEqual(self.sm.state, MediatorState.PAUSED)
        self.assertIn("Max autonomous turns", self.sm.last_error)

    def test_pause_and_resume(self):
        self.sm.start("LEFT")
        self.sm.pause("Reviewing")
        self.assertEqual(self.sm.state, MediatorState.PAUSED)
        self.sm.resume()
        self.assertEqual(self.sm.state, MediatorState.WAIT_LEFT)

    def test_emergency_stop(self):
        self.sm.start("LEFT")
        self.sm.stop()
        self.assertEqual(self.sm.state, MediatorState.IDLE)

    def test_same_adapter_on_both_slots_routes_by_slot(self):
        # ChatGPT vs ChatGPT in two separate tabs: each slot keeps its own
        # tab id and the turn sequence still alternates LEFT <-> RIGHT.
        self.sm.register_slot("LEFT", "chatgpt", tab_id=11)
        self.sm.register_slot("RIGHT", "chatgpt", tab_id=22)
        self.assertEqual(self.sm.slots["LEFT"].adapter_type, "chatgpt")
        self.assertEqual(self.sm.slots["RIGHT"].adapter_type, "chatgpt")
        self.assertEqual(self.sm.slots["LEFT"].tab_id, 11)
        self.assertEqual(self.sm.slots["RIGHT"].tab_id, 22)
        self.assertEqual(self.sm.slot_sequence, ["LEFT", "RIGHT"])
        self.assertEqual(self.sm.get_next_slot("LEFT"), "RIGHT")
        self.assertEqual(self.sm.get_next_slot("RIGHT"), "LEFT")
        self.sm.start("LEFT")
        self.sm.handle_response_captured("LEFT", "SIDERA-0000001")
        self.sm.start_processing()
        self.sm.prepare_send("RIGHT")
        self.sm.confirm_submission("RIGHT")
        self.assertEqual(self.sm.state, MediatorState.WAIT_RIGHT)

    def test_any_adapter_on_either_slot(self):
        # The sides are not tied to a site: Grok can be LEFT, Gemini RIGHT.
        self.sm.register_slot("LEFT", "grok", tab_id=5)
        self.sm.register_slot("RIGHT", "gemini", tab_id=6)
        self.assertEqual(self.sm.slots["LEFT"].adapter_type, "grok")
        self.assertEqual(self.sm.slots["RIGHT"].adapter_type, "gemini")
        self.assertEqual(self.sm.slot_sequence, ["LEFT", "RIGHT"])

    def test_dynamic_slot_registration_and_routing(self):
        self.sm.register_slot("BOT3", "claude")
        self.assertEqual(len(self.sm.slot_sequence), 3)
        self.assertEqual(self.sm.get_next_slot("LEFT"), "RIGHT")
        self.assertEqual(self.sm.get_next_slot("RIGHT"), "BOT3")
        self.assertEqual(self.sm.get_next_slot("BOT3"), "LEFT")

if __name__ == "__main__":
    unittest.main()
