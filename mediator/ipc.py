"""
Sidera Dual-Hemisphere Mediator - IPC Layer
Handles Chrome Native Messaging standard I/O framing with structured JSON packets.
"""

import json
import logging
import struct
import sys
from typing import Any, Dict, Optional

logger = logging.getLogger("sidera.ipc")
MAX_MESSAGE_BYTES = 1024 * 1024

class NativeMessagingIPC:
    def __init__(self, stdin=None, stdout=None):
        self.stdin = stdin or sys.stdin.buffer
        self.stdout = stdout or sys.stdout.buffer

    def read_message(self) -> Optional[Dict[str, Any]]:
        raw_length = self.stdin.read(4)
        if len(raw_length) < 4:
            return None
        message_length = struct.unpack("@I", raw_length)[0]
        if message_length > MAX_MESSAGE_BYTES:
            logger.error(f"Message length {message_length} exceeds max allowed ({MAX_MESSAGE_BYTES})")
            return None
        raw_data = self.stdin.read(message_length)
        if len(raw_data) < message_length:
            logger.error("Incomplete message payload received from Chrome")
            return None
        try:
            return json.loads(raw_data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            logger.error(f"Failed to decode Native Messaging JSON: {e}")
            return None

    def send_message(self, message: Dict[str, Any]):
        try:
            encoded_json = json.dumps(message).encode("utf-8")
            length = len(encoded_json)
            header = struct.pack("@I", length)
            self.stdout.write(header)
            self.stdout.write(encoded_json)
            self.stdout.flush()
        except Exception as e:
            logger.error(f"Failed to send Native Messaging message: {e}")
