"""
Sidera Dual-Hemisphere Mediator - Local Service Entry Point
Coordinates Native Messaging IPC, dynamic participant slot registry, state machine,
message ledger, memory, file sandbox, and tag processing.
"""

import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from mediator.config import MediatorConfig, load_config
from mediator.credential_store import ChatGptLoginStore, CredentialStoreError
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
ACTIVE_STATES = (
    MediatorState.WAIT_LEFT,
    MediatorState.WAIT_RIGHT,
    MediatorState.LEFT_COMPLETE,
    MediatorState.RIGHT_COMPLETE,
    MediatorState.PROCESS,
    MediatorState.SEND_LEFT,
    MediatorState.SEND_RIGHT,
)


def load_genesis_prompt(path: Path = GENESIS_PROMPT_PATH) -> str:
    return path.read_text(encoding="utf-8").strip()


class MediatorService:
    def __init__(
        self,
        root_dir: Optional[Path] = None,
        max_turns: Optional[int] = None,
        genesis_enabled: Optional[bool] = None,
        config: Optional[MediatorConfig] = None,
        autonomous_submissions: Optional[bool] = None,
        idle_timeout_minutes: Optional[float] = None,
    ):
        self.config = config or load_config()
        self.root_dir = (root_dir or self.config.data_root).resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)
        if max_turns is None:
            max_turns = self.config.max_autonomous_turns
        # Pause with a plain explanation when nothing is detected for this
        # long while waiting on a side (spec 11.2: configurable timeouts; a
        # safe pause, never blind automation). 0 disables it.
        self.idle_timeout_minutes = (
            self.config.idle_timeout_minutes if idle_timeout_minutes is None else idle_timeout_minutes
        )
        self._last_activity = time.monotonic()
        self._service_lock = threading.RLock()
        self._stop_watchdog = threading.Event()
        # False = monitor and log only; nothing is pasted into either chat.
        self.autonomous_submissions = (
            self.config.autonomous_submissions if autonomous_submissions is None else autonomous_submissions
        )

        # The Genesis Protocol is taught to both sides before the first turn.
        # SIDERA_GENESIS=off skips it (used by the pure copy-paste checks).
        if genesis_enabled is None:
            env = os.environ.get("SIDERA_GENESIS")
            genesis_enabled = self.config.genesis_enabled if env is None else env.lower() not in ("off", "0", "false", "no")
        self.genesis_enabled = genesis_enabled
        prompt_path = self.config.genesis_prompt_file if self.config.genesis_prompt_file.exists() else GENESIS_PROMPT_PATH
        self.genesis_prompt = load_genesis_prompt(prompt_path) if genesis_enabled else ""
        self.genesis_pending: List[str] = []
        self.genesis_target: Optional[str] = None
        self.genesis_initial_side = "LEFT"
        # Results of read/recall tags wait here for the hemisphere that asked
        # and ride along with the next message pasted into it (spec 8.5).
        self.pending_system_blocks: Dict[str, List[str]] = {"LEFT": [], "RIGHT": []}
        # A reply that arrives while paused is kept and processed on Resume, so
        # "pause after the current turn" never loses that turn.
        self.held_reply: Optional[Dict[str, Any]] = None

        setup_logging(self.root_dir / "logs")
        logger.info(f"Initializing Sidera Mediator Service at {self.root_dir}")
        if self.config.source_path:
            logger.info("Configuration loaded from %s", self.config.source_path)
        if not self.autonomous_submissions:
            logger.warning("MONITOR_ONLY mode: autonomous submissions are disabled by configuration")

        self.ledger = MessageLedger(self.root_dir / "ledger.sqlite")
        self.memory = MemoryStore(self.root_dir / "memory")
        self.sandbox = FileSandbox(self.root_dir / "files")
        self.account_logins = {
            "chatgpt": ChatGptLoginStore(self.root_dir / "credentials" / "chatgpt.bin"),
            "grok": ChatGptLoginStore(self.root_dir / "credentials" / "grok.bin"),
        }
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
        self._restore_runtime_state()
        self._check_crash_recovery()

    # --- persistence across restarts ---------------------------------------------

    def _persist_runtime_state(self, state: MediatorState):
        self.ledger.set_runtime_state(
            state=state.value,
            turn_count=self.state_machine.turn_count,
            current_message_id=self.state_machine.current_message_id,
            last_error=self.state_machine.last_error,
            max_autonomous_turns=self.state_machine.max_autonomous_turns,
        )

    def _restore_runtime_state(self):
        """Fail closed: a restart never silently resumes an exchange (spec 11.1)."""
        saved = self.ledger.get_runtime_state()
        if not saved:
            return
        try:
            self.state_machine.turn_count = int(saved.get("turn_count") or 0)
        except ValueError:
            pass
        try:
            self.state_machine.max_autonomous_turns = int(saved.get("max_autonomous_turns") or self.state_machine.max_autonomous_turns)
        except ValueError:
            pass
        previous = saved.get("state")
        if previous == MediatorState.PAUSED.value:
            self.state_machine.pause(saved.get("last_error") or "Paused before the mediator was last closed.")
            logger.warning("Restored PAUSED state from the previous session")
        elif previous in [s.value for s in ACTIVE_STATES]:
            self.state_machine.pause(
                f"Mediator restarted while in {previous}. Review the transcript, then press Resume or STOP."
            )
            logger.warning("Previous session ended mid-exchange (%s); starting PAUSED", previous)

    def _write_transcript_line(self, text: str):
        with self.transcript_file.open("a", encoding="utf-8") as handle:
            handle.write(text)

    def _broadcast_state_change(self, state: MediatorState, context: Dict[str, Any]):
        # Every transition counts as progress for the idle watchdog.
        self._last_activity = time.monotonic()
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
            "max_turns": self.state_machine.max_autonomous_turns,
            "last_message_id": self.state_machine.current_message_id,
            "last_error": self.state_machine.last_error,
            "autonomous_submissions": self.autonomous_submissions,
            "context": context,
        }
        try:
            self._persist_runtime_state(state)
        except Exception as err:  # never let bookkeeping break routing
            logger.error("Could not persist runtime state: %s", err)
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
        self._last_activity = time.monotonic()
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

    def _attach_system_blocks(self, destination: str, text: str) -> str:
        """Prepend any Sidera system blocks waiting for this hemisphere."""
        blocks = self.pending_system_blocks.get(destination, [])
        if not blocks:
            return text
        self.pending_system_blocks[destination] = []
        return "\n\n".join(blocks) + ("\n\n" + text if text else "")

    def _submit(self, destination: str, message_id: str, text: str):
        """Hand a message to the extension for pasting, unless monitoring only."""
        if not self.autonomous_submissions:
            logger.warning("MONITOR_ONLY: not pasting %s into %s (autonomous submissions disabled)", message_id, destination)
            self._write_transcript_line(
                f"- **Monitor only:** `{message_id}` for `{destination}` was not pasted (autonomous submissions disabled)\n"
            )
            self.state_machine.pause("Monitor-only mode: autonomous submissions are disabled in config.toml.")
            return
        self.ledger.update_status(message_id, "SUBMITTING")
        self.ipc.send_message({
            "type": "SUBMIT_MESSAGE",
            "destination": destination,
            "message_id": message_id,
            "text": text,
        })

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
        self._submit(dest, message_id, self._attach_system_blocks(dest, text))

    # --- catch-up brief for a fresh chat --------------------------------------------

    BRIEF_MAX_MEMORIES = 15
    BRIEF_MAX_TURNS = 6
    BRIEF_TURN_CHARS = 400
    BRIEF_MAX_CHARS = 6000

    def build_context_brief(self, hemisphere: str) -> str:
        """What a side needs to continue after its chat window was replaced.

        Deterministic and bounded: the most recent saved memories and the last
        few routed turns, in a clearly marked Sidera system block.
        """
        other = "RIGHT" if hemisphere == "LEFT" else "LEFT"
        lines = [
            "[SIDERA SYSTEM: Context restored for a fresh chat]",
            f"You are {hemisphere}, continuing an ongoing conversation with another AI ({other}). "
            "Your previous chat window was replaced; the conversation itself continues unchanged.",
        ]
        memories = self.memory.read_memory(limit=self.BRIEF_MAX_MEMORIES)
        if memories:
            lines.append("")
            lines.append(f"Saved memories (newest first, {len(memories)} shown):")
            for record in memories:
                content = " ".join(str(record.get("content", "")).split())
                lines.append(f"- [{record.get('id')} {record.get('category')}/{record.get('project')}] {content}")
        recent = self.ledger.get_recent_messages(self.conversation_id, limit=self.BRIEF_MAX_TURNS)
        if recent:
            lines.append("")
            lines.append(f"Recent exchange (last {len(recent)} turns, oldest first):")
            for record in recent:
                text = " ".join(str(record.get("clean_content") or record.get("content") or "").split())
                if len(text) > self.BRIEF_TURN_CHARS:
                    text = text[: self.BRIEF_TURN_CHARS - 1].rstrip() + "…"
                who = "you" if record.get("source") == hemisphere else other
                lines.append(f"- {record.get('source')} ({who}): {text}")
        lines.append("")
        lines.append("Reply to the message that follows as your next turn.")
        brief = "\n".join(lines)
        if len(brief) > self.BRIEF_MAX_CHARS:
            brief = brief[: self.BRIEF_MAX_CHARS - 1].rstrip() + "…"
        return brief

    def _open_path(self, path: Path) -> bool:
        """Open a folder or file with the desktop's default handler (spec 10)."""
        try:
            if sys.platform.startswith("win"):
                os.startfile(str(path))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                import subprocess
                subprocess.Popen(["open", str(path)])
            else:
                import subprocess
                subprocess.Popen(["xdg-open", str(path)])
            return True
        except Exception as err:
            logger.error("Could not open %s: %s", path, err)
            return False

    def _latest_log_file(self) -> Optional[Path]:
        logs = sorted((self.root_dir / "logs").glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        return logs[0] if logs else None

    def _account_store(self, service: Any):
        key = str(service or "").strip().lower()
        store = self.account_logins.get(key)
        if store is None:
            raise CredentialStoreError("Choose ChatGPT or Grok.")
        return key, store

    def _save_account_login(self, service: Any, email: Any, password: Any) -> None:
        try:
            key, store = self._account_store(service)
            store.save(str(email or ""), str(password or ""))
        except CredentialStoreError as err:
            self.ipc.send_message({
                "type": "ACCOUNT_LOGIN_STATUS",
                "ok": False,
                "saved": False,
                "service": str(service or "").strip().lower(),
                "email": "",
                "error": str(err),
            })
            return
        self.ipc.send_message({
            "type": "ACCOUNT_LOGIN_STATUS",
            "ok": True,
            "saved": True,
            "service": key,
            "email": str(email or "").strip(),
        })

    def handle_message(self, packet: Dict[str, Any]):
        msg_type = packet.get("type", "").upper()
        logger.info(f"Handling incoming packet: {msg_type}")

        if msg_type == "SAVE_ACCOUNT_LOGIN":
            self._save_account_login(packet.get("service"), packet.get("email"), packet.get("password"))

        elif msg_type == "FORGET_ACCOUNT_LOGIN":
            try:
                key, store = self._account_store(packet.get("service"))
            except CredentialStoreError as err:
                self.ipc.send_message({
                    "type": "ACCOUNT_LOGIN_STATUS",
                    "ok": False,
                    "saved": False,
                    "service": str(packet.get("service") or "").strip().lower(),
                    "email": "",
                    "error": str(err),
                })
            else:
                store.clear()
                self.ipc.send_message({
                    "type": "ACCOUNT_LOGIN_STATUS",
                    "ok": True,
                    "saved": False,
                    "service": key,
                    "email": "",
                })

        elif msg_type == "GET_ACCOUNT_LOGIN_STATUS":
            try:
                key, store = self._account_store(packet.get("service"))
            except CredentialStoreError as err:
                self.ipc.send_message({
                    "type": "ACCOUNT_LOGIN_STATUS",
                    "ok": False,
                    "saved": False,
                    "service": str(packet.get("service") or "").strip().lower(),
                    "email": "",
                    "error": str(err),
                })
            else:
                self.ipc.send_message({
                    "type": "ACCOUNT_LOGIN_STATUS",
                    "ok": True,
                    "service": key,
                    **store.status(),
                })

        elif msg_type == "GET_ACCOUNT_LOGIN":
            try:
                key, store = self._account_store(packet.get("service"))
            except CredentialStoreError:
                self.ipc.send_message({"type": "ACCOUNT_LOGIN", "saved": False, "service": ""})
            else:
                record = store.load()
                if not record:
                    self.ipc.send_message({"type": "ACCOUNT_LOGIN", "saved": False, "service": key})
                else:
                    self.ipc.send_message({
                        "type": "ACCOUNT_LOGIN",
                        "saved": True,
                        "service": key,
                        "email": record["email"],
                        "password": record["password"],
                    })

        elif msg_type == "PING":
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
            self.ipc.send_message({
                "type": "SETTINGS",
                "rotate_after_pastes": self.config.rotate_after_pastes,
            })
            if self.genesis_enabled and self.genesis_prompt:
                self._begin_genesis(initial_side)
            else:
                self.state_machine.start(initial_side)

        elif msg_type == "PAUSE":
            self.state_machine.pause(packet.get("reason", "User requested pause"))

        elif msg_type == "RESUME":
            self.state_machine.resume()
            self._resend_pending_after_resume()
            if self.held_reply and self.state_machine.state in (MediatorState.WAIT_LEFT, MediatorState.WAIT_RIGHT):
                held, self.held_reply = self.held_reply, None
                logger.info("Processing the reply from %s that arrived while paused", held.get("source"))
                self.handle_message(held)

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
            self.genesis_pending = []
            self.genesis_target = None
            self.held_reply = None
            self.state_machine.stop()

        elif msg_type == "SET_MAX_TURNS":
            try:
                value = int(packet.get("max_turns"))
            except (TypeError, ValueError):
                logger.warning("SET_MAX_TURNS ignored: %r is not a number", packet.get("max_turns"))
                return
            if value < 1:
                logger.warning("SET_MAX_TURNS ignored: must be at least 1")
                return
            self.state_machine.max_autonomous_turns = value
            self.ledger.set_runtime_state(max_autonomous_turns=value)
            logger.info("Maximum autonomous turns set to %s", value)
            self._write_transcript_line(f"- **Setting:** maximum autonomous turns set to `{value}`\n")
            self._broadcast_state_change(self.state_machine.state, {"max_turns": value})

        elif msg_type == "CONTEXT_REQUEST":
            # A side opened a fresh chat and wants to be caught up before it
            # continues (memories + recent turns).
            hemisphere = (packet.get("hemisphere") or "").upper()
            if hemisphere not in ("LEFT", "RIGHT"):
                logger.warning("CONTEXT_REQUEST ignored: hemisphere=%r", packet.get("hemisphere"))
                return
            # A side rebuilding its chat is progress, not idleness.
            self._last_activity = time.monotonic()
            brief = self.build_context_brief(hemisphere)
            memories = self.memory.read_memory(limit=self.BRIEF_MAX_MEMORIES)
            recent = self.ledger.get_recent_messages(self.conversation_id, limit=self.BRIEF_MAX_TURNS)
            logger.info("CONTEXT_BRIEF for %s: %s memories, %s recent turns, %s chars", hemisphere, len(memories), len(recent), len(brief))
            self._write_transcript_line(
                f"- **Fresh chat:** `{hemisphere}` caught up with {len(memories)} memories and {len(recent)} recent turns\n"
            )
            self.ipc.send_message({"type": "CONTEXT_BRIEF", "hemisphere": hemisphere, "text": brief})

        elif msg_type == "OPEN_DATA_FOLDER":
            self._open_path(self.root_dir)

        elif msg_type == "OPEN_LATEST_LOG":
            latest = self._latest_log_file()
            if latest:
                self._open_path(latest)

        elif msg_type == "GET_STATUS":
            last_msg = self.ledger.get_last_message(self.conversation_id)
            self.ipc.send_message({
                "type": "STATUS_RESPONSE",
                "state": self.state_machine.state.value,
                "turn_count": self.state_machine.turn_count,
                "max_turns": self.state_machine.max_autonomous_turns,
                "last_message_id": last_msg["message_id"] if last_msg else None,
                "last_error": self.state_machine.last_error,
                "autonomous_submissions": self.autonomous_submissions,
                "data_root": str(self.root_dir),
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
            if is_ready_acknowledgement(raw_content) and not fresh:
                # A bare READY outside the handshake (for example after a chat was
                # restarted and re-taught) is an acknowledgement, not a turn. A READY
                # the extension marks as a fresh reply to a real message is forwarded
                # like any other reply, so the loop can never stall on it.
                logger.info("READY acknowledgement from %s noted; not forwarded", source)
                return
            if is_ready_acknowledgement(raw_content):
                logger.warning("%s answered READY to a real message; forwarding it rather than stalling", source)
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
            if self.state_machine.state == MediatorState.PAUSED:
                expected = self.state_machine.paused_previous_state
                if (expected == MediatorState.WAIT_LEFT and source == "LEFT") or (
                    expected == MediatorState.WAIT_RIGHT and source == "RIGHT"
                ):
                    if fresh or not self.ledger.is_duplicate(raw_content, source):
                        self.held_reply = packet
                        logger.info("Holding the reply from %s until Resume (paused)", source)
                        self._write_transcript_line(f"- **Paused:** reply from `{source}` held until Resume\n")
                    return
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
            system_injections: List[str] = []
            for tag_error in errors:
                # Fail closed: log it, execute nothing for it, tell the requester.
                logger.error("TAG_ERROR message=%s detail=%s", record["message_id"], tag_error)
                self._write_transcript_line(
                    f"- **Error signal:** `TAG_ERROR` message=`{record['message_id']}` detail=`{tag_error}`\n"
                )
                system_injections.append(f"[SIDERA SYSTEM ERROR: {tag_error}; the tag was not executed]")

            if self.ledger.operations_recorded(record["message_id"]):
                # Already executed before a crash/restart; never run writes twice.
                logger.warning("Tag operations for %s were already executed; not repeating them", record["message_id"])
                controls = {"pause": False, "stop": False, "reason": None}
            else:
                results, controls = self.tag_parser.execute_operations(
                    operations=operations,
                    memory_store=self.memory,
                    file_sandbox=self.sandbox,
                    source=source,
                    parent_message_id=record["message_id"],
                )
                system_injections.extend(results)
                for index, op in enumerate(operations):
                    attrs = op.get("attributes", {})
                    self.ledger.record_operation(
                        record["message_id"], index, op["type"], attrs.get("path") or attrs.get("category"), "EXECUTED"
                    )

            # Read/recall results (and tag errors) go back to the side that asked,
            # attached to the next message pasted into it (spec 8.5). The other
            # side receives only the conversational text.
            if system_injections:
                self.pending_system_blocks[source].extend(system_injections)
                logger.info("Queued %s Sidera system block(s) for %s", len(system_injections), source)
            outbound_text = self._attach_system_blocks(dest, clean_text)

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

            self._submit(dest, record["message_id"], outbound_text)

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
            # Operator-triggered LEFT -> RIGHT or RIGHT -> LEFT (spec 10). Tags are
            # processed like any captured reply; the ledger records it as manual.
            source = packet.get("source", "").upper()
            content = packet.get("content", "")
            if source not in ("LEFT", "RIGHT") or not content.strip():
                logger.warning("MANUAL_FORWARD ignored: source=%r, empty=%s", source, not content.strip())
                return
            dest = self.state_machine.get_next_slot(source)
            last_msg = self.ledger.get_last_message(self.conversation_id)
            record = self.ledger.capture_message(
                conversation_id=self.conversation_id,
                source=source,
                destination=dest,
                content=content,
                parent_message_id=last_msg["message_id"] if last_msg else None,
            )
            clean_text, operations, errors = self.tag_parser.parse(content)
            results, controls = self.tag_parser.execute_operations(
                operations=operations, memory_store=self.memory, file_sandbox=self.sandbox,
                source=source, parent_message_id=record["message_id"],
            )
            for index, op in enumerate(operations):
                attrs = op.get("attributes", {})
                self.ledger.record_operation(record["message_id"], index, op["type"], attrs.get("path") or attrs.get("category"), "EXECUTED")
            self.pending_system_blocks[source].extend(results)
            self.ledger.update_status(record["message_id"], "PROCESSED", clean_content=clean_text)
            self._write_transcript_line(f"- **Manual forward:** `{source}` -> `{dest}` as `{record['message_id']}`\n")
            self._append_transcript(record, clean_text, operations)
            self._submit(dest, record["message_id"], self._attach_system_blocks(dest, clean_text))

    # --- idle watchdog (spec 11.2, acceptance test 12) -------------------------------

    def check_idle(self, now: Optional[float] = None) -> bool:
        """Pause with a plain explanation when reply detection has gone quiet.

        Covers a broken assistant-message selector, a stuck tab, or a lost
        confirmation: situations where nothing arrives and, without this, the
        mediator would wait forever with no operator notice. Returns True when
        it paused.
        """
        timeout_minutes = self.idle_timeout_minutes
        if not timeout_minutes or timeout_minutes <= 0:
            return False
        now = time.monotonic() if now is None else now
        idle_seconds = now - self._last_activity
        if idle_seconds < timeout_minutes * 60:
            return False
        minutes = max(1, int(round(idle_seconds / 60)))

        # The operator (or an earlier timeout) already paused: nothing is
        # expected to move, so never time out on top of that pause, not even
        # during the opening handshake. Otherwise the operator's own reason is
        # overwritten and Resume has to be pressed twice.
        if self.state_machine.state == MediatorState.PAUSED:
            return False

        if self.genesis_target is not None:
            side = self.genesis_target
            self.genesis_pending = []
            self.genesis_target = None
            logger.warning("IDLE_TIMEOUT during GENESIS target=%s seconds=%s", side, int(idle_seconds))
            self._write_transcript_line(f"- **Idle timeout:** no READY from `{side}` after {minutes} minutes\n")
            self.state_machine.pause(
                f"The {side} tab has not answered the protocol message for about {minutes} minutes. "
                f"Check that tab is signed in and responding, then press Start again."
            )
            return True

        state = self.state_machine.state
        if state in (MediatorState.WAIT_LEFT, MediatorState.WAIT_RIGHT):
            side = "LEFT" if state == MediatorState.WAIT_LEFT else "RIGHT"
            reason = (
                f"No reply has been detected from {side} for about {minutes} minutes. "
                f"That tab may be stuck or signed out, or the site may have changed its page. "
                f"Check the {side} tab, then press Resume."
            )
        elif state in (MediatorState.SEND_LEFT, MediatorState.SEND_RIGHT):
            side = "LEFT" if state == MediatorState.SEND_LEFT else "RIGHT"
            reason = (
                f"The message pasted into {side} has not been confirmed for about {minutes} minutes. "
                f"Check the {side} tab, then press Resume; the message will be pasted again."
            )
        else:
            return False
        logger.warning("IDLE_TIMEOUT state=%s seconds=%s", state.value, int(idle_seconds))
        self._write_transcript_line(f"- **Idle timeout:** `{state.value}` quiet for {minutes} minutes\n")
        self.state_machine.pause(reason)
        return True

    def _watchdog_loop(self):
        while not self._stop_watchdog.wait(10):
            try:
                with self._service_lock:
                    self.check_idle()
            except Exception as err:  # the watchdog must never kill the service
                logger.error("Idle watchdog error: %s", err)

    def run(self):
        logger.info("Sidera Native Messaging loop started.")
        if self.idle_timeout_minutes and self.idle_timeout_minutes > 0:
            threading.Thread(target=self._watchdog_loop, name="sidera-idle-watchdog", daemon=True).start()
        try:
            while True:
                packet = self.ipc.read_message()
                if packet is None:
                    logger.info("Chrome IPC disconnected or EOF reached. Terminating service.")
                    break
                try:
                    with self._service_lock:
                        self.handle_message(packet)
                except Exception as e:
                    logger.exception(f"Unhandled error in message processing: {e}")
                    self.state_machine.error(str(e))
        finally:
            self._stop_watchdog.set()

if __name__ == "__main__":
    service = MediatorService()
    service.run()
