"""
Sidera Dual-Hemisphere Mediator - Local Service Entry Point
Coordinates Native Messaging IPC, dynamic participant slot registry, state machine,
message ledger, memory, file sandbox, and tag processing.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from mediator.file_sandbox import FileSandbox
from mediator.ipc import NativeMessagingIPC
from mediator.logging_config import setup_logging
from mediator.memory_store import MemoryStore
from mediator.message_ledger import MessageLedger
from mediator.state_machine import MediatorState, StateMachine
from mediator.tag_parser import TagParser

logger = logging.getLogger("sidera.core")

class MediatorService:
    def __init__(self, root_dir: Optional[Path] = None, max_turns: int = 50):
        self.root_dir = (root_dir or Path(__file__).resolve().parent.parent / "data").resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)

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
            initial_side = packet.get("initial_hemisphere", "LEFT")
            self.state_machine.start(initial_side)

        elif msg_type == "PAUSE":
            self.state_machine.pause(packet.get("reason", "User requested pause"))

        elif msg_type == "RESUME":
            self.state_machine.resume()

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

            if self.ledger.is_duplicate(raw_content, source):
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
