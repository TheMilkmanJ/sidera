"""
Sidera Dual-Hemisphere Mediator - Local Service Entry Point
Coordinates Native Messaging IPC, dynamic participant slot registry, state machine,
message ledger, memory, file sandbox, and tag processing.
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from mediator.file_sandbox import FileSandbox
from mediator.ipc import NativeMessagingIPC
from mediator.logging_config import setup_logging
from mediator.memory_store import MemoryStore
from mediator.message_ledger import MessageLedger
from mediator.state_machine import MediatorState, StateMachine
from mediator.tag_parser import TagParser, is_ready_acknowledgement

logger = logging.getLogger("sidera.core")

GENESIS_PROMPT_PATH = Path(__file__).resolve().parent / "genesis_protocol.md"
GENESIS_MESSAGE_PREFIX = "GENESIS-"


def load_genesis_prompt(path: Path = GENESIS_PROMPT_PATH) -> str:
    return path.read_text(encoding="utf-8").strip()


class MediatorService:
    def __init__(
        self,
        root_dir: Optional[Path] = None,
        max_turns: int = 50,
        genesis_enabled: Optional[bool] = None,
    ):
        self.root_dir = (root_dir or Path(__file__).resolve().parent.parent / "data").resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)

        # The Genesis Protocol is taught to both sides before the first turn.
        # SIDERA_GENESIS=off skips it (used by the pure copy-paste checks).
        if genesis_enabled is None:
            genesis_enabled = os.environ.get("SIDERA_GENESIS", "on").lower() not in ("off", "0", "false", "no")
        self.genesis_enabled = genesis_enabled
        self.genesis_prompt = load_genesis_prompt() if genesis_enabled else ""
        self.genesis_pending: List[str] = []
        self.genesis_target: Optional[str] = None
        self.genesis_initial_side = "LEFT"

        setup_logging(self.root_dir / "logs")
        logger.info(f"Initializing Sidera Mediator Service at {self.root_dir}")

        self.ledger = MessageLedger(self.root_dir / "ledger.sqlite")
        self.memory = MemoryStore(self.root_dir / "memory")
        self.sandbox = FileSandbox(self.root_dir / "files")
        self.tag_parser = TagParser()
        self.ipc = NativeMessagingIPC()

        self.conversation_id = datetime.now(timezone.utc).strftime("%Y-%m-%d-main")
        self.transcript_file = self.root_dir / "transcripts" / f"{self.conversation_id}.md"
        self.transcript_file.parent.mkdir(parents=True, exist_ok=True)
        if not self.transcript_file.exists() or self.transcript_file.stat().st_size == 0:
            self._write_transcript_line(f"# Sidera Conversation Transcript: {self.conversation_id}\n\n")
        self._write_transcript_line(
            f"<!-- session {datetime.now(timezone.utc).isoformat()} max_turns={max_turns} -->\n\n"
        )
        logger.info(
            "Burn-in ceiling: %s autonomous turns. Transcript: %s",
            max_turns,
            self.transcript_file,
        )

        self.state_machine = StateMachine(
            max_autonomous_turns=max_turns,
            on_state_change=self._broadcast_state_change,
        )
        self._check_crash_recovery()

    def _write_transcript_line(self, text: str):
        with self.transcript_file.open("a", encoding="utf-8") as handle:
            handle.write(text)

    def _broadcast_state_change(self, state: MediatorState, context: Dict[str, Any]):
        logger.info(
            "STATUS turn=%s/%s state=%s message=%s error=%s context=%s",
            self.state_machine.turn_count,
            self.state_machine.max_autonomous_turns,
            state.value,
            self.state_machine.current_message_id,
            self.state_machine.last_error,
            context,
        )
        self._write_transcript_line(
            f"- **Status transition:** `{state.value}` turn `{self.state_machine.turn_count}`"
            f"/{self.state_machine.max_autonomous_turns}"
            + (f" error=`{self.state_machine.last_error}`" if self.state_machine.last_error else "")
            + "\n"
        )
        payload = {
            "type": "STATE_UPDATE",
            "state": state.value,
            "turn_count": self.state_machine.turn_count,
            "last_message_id": self.state_machine.current_message_id,
            "last_error": self.state_machine.last_error,
            "context": context,
        }
        self.ipc.send_message(payload)

    def _check_crash_recovery(self):
        unack = self.ledger.get_unacknowledged_message()
        if unack:
            logger.warning(
                f"Found unacknowledged message {unack['message_id']} with status {unack['status']}. Entering PAUSED state."
            )
            self.state_machine.pause(
                f"Recovered unacknowledged message {unack['message_id']} ({unack['status']}). Review before resuming."
            )

    def _append_transcript(self, message_record: Dict[str, Any], clean_text: str, tags: list):
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        with self.transcript_file.open("a", encoding="utf-8") as f:
            f.write(
                f"## [{message_record['message_id']}] {message_record['source']} -> {message_record['destination']} | {now_str}\n"
                f"- **Status:** `{message_record['status']}`\n"
                f"- **SHA-256:** `{message_record['content_sha256'][:16]}...`\n"
            )
            if tags:
                f.write(f"- **Executed Tags:** `{[t['type'] for t in tags]}`\n")
            f.write(
                f"- **Turn:** `{self.state_machine.turn_count}`/`{self.state_machine.max_autonomous_turns}`\n"
            )
            f.write(f"\n{clean_text.strip()}\n\n---\n\n")

    # --- Genesis Protocol handshake -------------------------------------------------

    def _begin_genesis(self, initial_side: str):
        other = "RIGHT" if initial_side == "LEFT" else "LEFT"
        self.genesis_initial_side = initial_side
        self.genesis_pending = [initial_side, other]
        self.ipc.send_message({"type": "GENESIS_TEXT", "text": self.genesis_prompt})
        self._write_transcript_line("- **Genesis:** protocol handshake started\n")
        self._send_genesis_to_next()

    def _send_genesis_to_next(self):
        if not self.genesis_pending:
            self.genesis_target = None
            logger.info("GENESIS complete; both hemispheres acknowledged. Waiting for the opening prompt in %s.", self.genesis_initial_side)
            self._write_transcript_line("- **Genesis:** complete\n")
            self.ipc.send_message({"type": "GENESIS_COMPLETE"})
            self.state_machine.start(self.genesis_initial_side)
            return
        self.genesis_target = self.genesis_pending.pop(0)
        logger.info("GENESIS sent to %s", self.genesis_target)
        self._write_transcript_line(f"- **Genesis:** sent to `{self.genesis_target}`\n")
        self.ipc.send_message({
            "type": "SUBMIT_MESSAGE",
            "destination": self.genesis_target,
            "message_id": f"{GENESIS_MESSAGE_PREFIX}{self.genesis_target}",
            "text": self.genesis_prompt,
        })

    def _handle_genesis_reply(self, source: str, raw_content: str) -> bool:
        """Consume a reply while the handshake runs. Returns True when it was consumed."""
        if self.genesis_target is None:
            return False
        if source != self.genesis_target:
            logger.warning("Ignored reply from %s while waiting for %s to acknowledge the Genesis Protocol", source, self.genesis_target)
            return True
        if is_ready_acknowledgement(raw_content):
            logger.info("GENESIS acknowledged by %s (READY)", source)
            self._write_transcript_line(f"- **Genesis:** `{source}` replied READY\n")
        else:
            preview = " ".join(raw_content.split())[:120]
            logger.warning("GENESIS reply from %s was not READY; continuing anyway: %s", source, preview)
            self._write_transcript_line(f"- **Genesis:** `{source}` replied without READY: `{preview}`\n")
        self._send_genesis_to_next()
        return True

    def _resend_pending_after_resume(self):
        """After a pause taken mid-send, paste the pending message again."""
        state = self.state_machine.state
        if state not in (MediatorState.SEND_LEFT, MediatorState.SEND_RIGHT):
            return
        message_id = self.state_machine.current_message_id
        record = self.ledger.get_message(message_id) if message_id else None
        if not record:
            return
        dest = "LEFT" if state == MediatorState.SEND_LEFT else "RIGHT"
        text = record.get("clean_content") or record.get("content") or ""
        logger.info("Resuming: pasting %s into %s again", message_id, dest)
        self.ipc.send_message({
            "type": "SUBMIT_MESSAGE",
            "destination": dest,
            "message_id": message_id,
            "text": text,
        })

    def handle_message(self, packet: Dict[str, Any]):
        msg_type = packet.get("type", "").upper()
        logger.info(f"Handling incoming packet: {msg_type}")

        if msg_type == "PING":
            self.ipc.send_message({"type": "PONG", "timestamp": datetime.now(timezone.utc).isoformat()})

        elif msg_type == "HOOK_SLOT":
            slot_id = packet.get("slot_id", "LEFT")
            adapter = packet.get("adapter_type", "chatgpt")
            tab_id = packet.get("tab_id")
            self.state_machine.register_slot(slot_id, adapter, tab_id)
            self.ipc.send_message({
                "type": "SLOT_HOOKED",
                "slot_id": slot_id,
                "adapter": adapter,
                "tab_id": tab_id,
            })

        elif msg_type == "START":
            initial_side = packet.get("initial_hemisphere", "LEFT").upper()
            if self.genesis_enabled and self.genesis_prompt:
                self._begin_genesis(initial_side)
            else:
                self.state_machine.start(initial_side)

        elif msg_type == "PAUSE":
            self.state_machine.pause(packet.get("reason", "User requested pause"))

        elif msg_type == "RESUME":
            self.state_machine.resume()
            self._resend_pending_after_resume()

        elif msg_type == "SUBMISSION_STALLED":
            # The site would not accept the paste (for example Gemini's
            # "Something went wrong" after a usage limit). Pause with the
            # site's own words so the operator knows what to wait for.
            detail = packet.get("detail") or "The site did not accept the message."
            message_id = packet.get("message_id")
            logger.warning("SUBMISSION_STALLED message=%s hemisphere=%s detail=%s", message_id, packet.get("hemisphere"), detail)
            self._write_transcript_line(
                f"- **Error signal:** `SUBMISSION_STALLED` message=`{message_id}` detail=`{detail}`\n"
            )
            if self.state_machine.state in (MediatorState.SEND_LEFT, MediatorState.SEND_RIGHT):
                self.state_machine.pause(f"{detail} Press Resume once the site accepts messages again.")

        elif msg_type == "STOP":
            self.state_machine.stop()

        elif msg_type == "GET_STATUS":
            last_msg = self.ledger.get_last_message(self.conversation_id)
            self.ipc.send_message({
                "type": "STATUS_RESPONSE",
                "state": self.state_machine.state.value,
                "turn_count": self.state_machine.turn_count,
                "max_turns": self.state_machine.max_autonomous_turns,
                "last_message_id": last_msg["message_id"] if last_msg else None,
                "last_error": self.state_machine.last_error,
                "slots": {k: v.to_dict() for k, v in self.state_machine.slots.items()},
            })

        elif msg_type == "RESPONSE_CAPTURED":
            source = packet.get("source", "").upper()
            raw_content = packet.get("content", "")
            # The extension marks a reply "fresh" when it appeared on the page
            # after the last paste; such a reply is new even if it repeats the
            # previous one word for word.
            fresh = bool(packet.get("fresh"))
            if self._handle_genesis_reply(source, raw_content):
                return
            if is_ready_acknowledgement(raw_content):
                # A bare READY outside the handshake (for example after a chat was
                # restarted and re-taught) is an acknowledgement, not a turn.
                logger.info("READY acknowledgement from %s noted; not forwarded", source)
                return
            awaiting_confirmation = (
                source == "LEFT" and self.state_machine.state == MediatorState.SEND_LEFT
            ) or (
                source == "RIGHT" and self.state_machine.state == MediatorState.SEND_RIGHT
            )
            if awaiting_confirmation and not fresh and self.ledger.is_duplicate(raw_content, source):
                # A re-capture of that side's previous reply proves nothing.
                logger.info("Stale reply from %s while its paste is unconfirmed; ignored", source)
                return
            if awaiting_confirmation and self.state_machine.current_message_id:
                # The side we pasted into has answered, so the paste was delivered
                # even though its confirmation never reached us.
                logger.warning(
                    "Reply from %s arrived before the paste of %s was confirmed; treating it as delivered",
                    source,
                    self.state_machine.current_message_id,
                )
                self.handle_message({
                    "type": "SUBMISSION_CONFIRMED",
                    "destination": source,
                    "message_id": self.state_machine.current_message_id,
                })
            waiting_for_source = (
                source == "LEFT" and self.state_machine.state in (MediatorState.WAIT_LEFT, MediatorState.IDLE)
            ) or (
                source == "RIGHT" and self.state_machine.state in (MediatorState.WAIT_RIGHT, MediatorState.IDLE)
            )
            if not waiting_for_source:
                logger.warning(
                    "Ignored unexpected message from %s while in state %s",
                    source,
                    self.state_machine.state.value,
                )
                return
            dest = self.state_machine.get_next_slot(source)

            if not fresh and self.ledger.is_duplicate(raw_content, source):
                logger.warning(f"Duplicate response received from {source}. Skipping.")
                self.ipc.send_message({"type": "DUPLICATE_IGNORED", "source": source})
                return

            last_msg = self.ledger.get_last_message(self.conversation_id)
            parent_id = last_msg["message_id"] if last_msg else None
            record = self.ledger.capture_message(
                conversation_id=self.conversation_id,
                source=source,
                destination=dest,
                content=raw_content,
                parent_message_id=parent_id,
            )

            self.state_machine.handle_response_captured(source, record["message_id"])
            self.state_machine.start_processing()

            clean_text, operations, errors = self.tag_parser.parse(raw_content)
            for tag_error in errors:
                logger.error("TAG_ERROR message=%s detail=%s", record["message_id"], tag_error)
                self._write_transcript_line(
                    f"- **Error signal:** `TAG_ERROR` message=`{record['message_id']}` detail=`{tag_error}`\n"
                )
            system_injections, controls = self.tag_parser.execute_operations(
                operations=operations,
                memory_store=self.memory,
                file_sandbox=self.sandbox,
                source=source,
                parent_message_id=record["message_id"],
            )

            outbound_text = clean_text
            if system_injections:
                outbound_text += "\n\n" + "\n\n".join(system_injections)

            self.ledger.update_status(record["message_id"], "PROCESSED", clean_content=clean_text)

            if controls.get("stop"):
                self._append_transcript(record, clean_text, operations)
                self.state_machine.stop()
                return
            elif controls.get("pause"):
                self._append_transcript(record, clean_text, operations)
                self.state_machine.pause(controls.get("reason", "Control tag requested pause"))
                return

            self.state_machine.prepare_send(dest)
            self._append_transcript(record, clean_text, operations)
            if self.state_machine.state == MediatorState.PAUSED:
                if self.state_machine.last_error and "Max autonomous turns" in self.state_machine.last_error:
                    logger.warning(
                        "BURN_IN_LIMIT_REACHED turns=%s/%s",
                        self.state_machine.turn_count,
                        self.state_machine.max_autonomous_turns,
                    )
                return

            self.ledger.update_status(record["message_id"], "SUBMITTING")
            self.ipc.send_message({
                "type": "SUBMIT_MESSAGE",
                "destination": dest,
                "message_id": record["message_id"],
                "text": outbound_text,
            })

        elif msg_type == "SUBMISSION_CONFIRMED":
            dest = packet.get("destination", "").upper()
            message_id = packet.get("message_id")
            if message_id and str(message_id).startswith(GENESIS_MESSAGE_PREFIX):
                logger.info("GENESIS delivered to %s", dest)
                return
            if message_id:
                self.ledger.update_status(message_id, "ACKNOWLEDGED")
                self.ledger.record_turn(
                    conversation_id=self.conversation_id,
                    message_id=message_id,
                    source=dest,
                    state="SUBMITTED",
                )
            self.state_machine.confirm_submission(dest)
            logger.info(
                "ACKNOWLEDGED message=%s destination=%s turn=%s",
                message_id,
                dest,
                self.state_machine.turn_count,
            )

        elif msg_type == "INJECTION_ERROR":
            detail = packet.get("error", "Composer injection failed")
            message_id = packet.get("message_id") or packet.get("messageId")
            logger.error("INJECTION_ERROR message=%s hemisphere=%s detail=%s", message_id, packet.get("hemisphere"), detail)
            self._write_transcript_line(
                f"- **Error signal:** `INJECTION_ERROR` message=`{message_id}` detail=`{detail}`\n"
            )
            if message_id and str(message_id).startswith(GENESIS_MESSAGE_PREFIX):
                # Do not strand the session in ERROR before it starts; move on and
                # let the operator see the warning in the log.
                logger.warning("GENESIS could not be pasted into %s; continuing without its acknowledgement", packet.get("hemisphere"))
                self._send_genesis_to_next()
                return
            self.state_machine.error(detail)

        elif msg_type == "MANUAL_FORWARD":
            source = packet.get("source", "").upper()
            content = packet.get("content", "")
            dest = self.state_machine.get_next_slot(source)
            record = self.ledger.capture_message(
                conversation_id=self.conversation_id,
                source=source,
                destination=dest,
                content=content,
            )
            self.ipc.send_message({
                "type": "SUBMIT_MESSAGE",
                "destination": dest,
                "message_id": record["message_id"],
                "text": content,
            })

    def run(self):
        logger.info("Sidera Native Messaging loop started.")
        while True:
            packet = self.ipc.read_message()
            if packet is None:
                logger.info("Chrome IPC disconnected or EOF reached. Terminating service.")
                break
            try:
                self.handle_message(packet)
            except Exception as e:
                logger.exception(f"Unhandled error in message processing: {e}")
                self.state_machine.error(str(e))

if __name__ == "__main__":
    service = MediatorService()
    service.run()
