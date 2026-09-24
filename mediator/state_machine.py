"""
Sidera Dual-Hemisphere Mediator - State Machine
Authoritative turn-taking, loop prevention, and operational state engine.
Built on a generalized Participant Slot architecture supporting N-bots / dynamic tab hooks,
pre-configured with the default dual-hemisphere (LEFT <-> RIGHT) turn sequence for Phase 1.
"""

import enum
import logging
from typing import Dict, List, Optional, Callable, Any

logger = logging.getLogger("sidera.state_machine")

class MediatorState(enum.Enum):
    IDLE = "IDLE"
    WAIT_LEFT = "WAIT_LEFT"
    LEFT_COMPLETE = "LEFT_COMPLETE"
    PROCESS = "PROCESS"
    SEND_RIGHT = "SEND_RIGHT"
    WAIT_RIGHT = "WAIT_RIGHT"
    RIGHT_COMPLETE = "RIGHT_COMPLETE"
    SEND_LEFT = "SEND_LEFT"
    PAUSED = "PAUSED"
    ERROR = "ERROR"

class ParticipantSlot:
    def __init__(self, slot_id: str, adapter_type: str = "chatgpt", tab_id: Optional[int] = None):
        self.slot_id = slot_id.upper()
        self.adapter_type = adapter_type.lower()
        self.tab_id = tab_id
        self.is_active = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "slot_id": self.slot_id,
            "adapter_type": self.adapter_type,
            "tab_id": self.tab_id,
            "is_active": self.is_active,
        }

class StateMachine:
    def __init__(
        self,
        max_autonomous_turns: int = 50,
        slot_sequence: Optional[List[str]] = None,
        on_state_change: Optional[Callable[[MediatorState, Dict[str, Any]], None]] = None,
    ):
        self.state = MediatorState.IDLE
        self.max_autonomous_turns = max_autonomous_turns
        self.turn_count = 0
        self.current_message_id: Optional[str] = None
        self.paused_previous_state: Optional[MediatorState] = None
        self.last_error: Optional[str] = None
        self.on_state_change = on_state_change

        self.slots: Dict[str, ParticipantSlot] = {
            "LEFT": ParticipantSlot("LEFT", "chatgpt"),
            "RIGHT": ParticipantSlot("RIGHT", "grok"),
        }
        self.slot_sequence = [s.upper() for s in (slot_sequence or ["LEFT", "RIGHT"])]

    def register_slot(self, slot_id: str, adapter_type: str, tab_id: Optional[int] = None):
        sid = slot_id.upper()
        self.slots[sid] = ParticipantSlot(sid, adapter_type, tab_id)
        if sid not in self.slot_sequence:
            self.slot_sequence.append(sid)
        logger.info(f"Registered slot {sid} [adapter: {adapter_type}, tab: {tab_id}]")

    def get_next_slot(self, current_slot: str) -> str:
        current_slot = current_slot.upper()
        if current_slot in self.slot_sequence:
            idx = self.slot_sequence.index(current_slot)
            return self.slot_sequence[(idx + 1) % len(self.slot_sequence)]
        return self.slot_sequence[0]

    def _transition(self, new_state: MediatorState, context: Optional[Dict[str, Any]] = None):
        old_state = self.state
        self.state = new_state
        logger.info(f"State transition: {old_state.value} -> {new_state.value}")
        if self.on_state_change:
            self.on_state_change(new_state, context or {})

    def start(self, initial_hemisphere: str = "LEFT"):
        if self.state not in (MediatorState.IDLE, MediatorState.PAUSED):
            raise ValueError(f"Cannot start from state {self.state.value}")
        self.turn_count = 0
        self.last_error = None
        initial_slot = initial_hemisphere.upper()
        if initial_slot == "RIGHT":
            self._transition(MediatorState.WAIT_RIGHT, {"source": "USER", "target": "RIGHT"})
        else:
            self._transition(MediatorState.WAIT_LEFT, {"source": "USER", "target": "LEFT"})

    def handle_response_captured(self, source: str, message_id: str) -> MediatorState:
        source = source.upper()
        self.current_message_id = message_id
        if source == "LEFT" and self.state in (MediatorState.WAIT_LEFT, MediatorState.IDLE):
            self._transition(MediatorState.LEFT_COMPLETE, {"message_id": message_id, "source": "LEFT"})
            return self.state
        elif source == "RIGHT" and self.state in (MediatorState.WAIT_RIGHT, MediatorState.IDLE):
            self._transition(MediatorState.RIGHT_COMPLETE, {"message_id": message_id, "source": "RIGHT"})
            return self.state
        else:
            logger.warning(f"Ignored unexpected message from {source} while in state {self.state.value}")
            return self.state

    def start_processing(self) -> MediatorState:
        if self.state in (MediatorState.LEFT_COMPLETE, MediatorState.RIGHT_COMPLETE):
            self._transition(MediatorState.PROCESS, {"message_id": self.current_message_id})
        return self.state

    def prepare_send(self, destination: str) -> MediatorState:
        destination = destination.upper()
        if self.state != MediatorState.PROCESS:
            raise ValueError(f"Cannot send from state {self.state.value}, must be PROCESS")
        self.turn_count += 1
        if self.turn_count > self.max_autonomous_turns:
            self.pause(f"Max autonomous turns ({self.max_autonomous_turns}) reached.")
            return self.state
        if destination == "RIGHT":
            self._transition(MediatorState.SEND_RIGHT, {"turn": self.turn_count, "dest": "RIGHT"})
        else:
            self._transition(MediatorState.SEND_LEFT, {"turn": self.turn_count, "dest": "LEFT"})
        return self.state

    def confirm_submission(self, destination: str) -> MediatorState:
        destination = destination.upper()
        if destination == "RIGHT" and self.state == MediatorState.SEND_RIGHT:
            self._transition(MediatorState.WAIT_RIGHT, {"dest": "RIGHT"})
        elif destination == "LEFT" and self.state == MediatorState.SEND_LEFT:
            self._transition(MediatorState.WAIT_LEFT, {"dest": "LEFT"})
        return self.state

    def pause(self, reason: str = "Operator paused"):
        self.paused_previous_state = self.state
        self.last_error = reason
        self._transition(MediatorState.PAUSED, {"reason": reason})

    def resume(self):
        if self.state != MediatorState.PAUSED:
            return
        target_state = self.paused_previous_state or MediatorState.IDLE
        self.paused_previous_state = None
        self._transition(target_state, {"action": "RESUME"})

    def stop(self):
        self.paused_previous_state = None
        self._transition(MediatorState.IDLE, {"action": "STOP"})

    def error(self, err_msg: str):
        self.last_error = err_msg
        self._transition(MediatorState.ERROR, {"error": err_msg})
